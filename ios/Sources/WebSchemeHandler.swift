import Foundation
import WebKit

final class WebSchemeHandler: NSObject, WKURLSchemeHandler {
    private let wwwRoot: URL
    private let lock = NSLock()
    private var activeTasks = Set<ObjectIdentifier>()
    private let ioQueue = DispatchQueue(
        label: "com.geneildosantos.zlegends3.scheme",
        qos: .userInitiated,
        attributes: .concurrent
    )

    init(wwwRoot: URL) {
        self.wwwRoot = wwwRoot.resolvingSymlinksInPath().standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        lock.lock()
        activeTasks.insert(taskID)
        lock.unlock()

        let req = urlSchemeTask.request
        guard let requestURL = req.url else {
            failTask(urlSchemeTask, taskID: taskID, code: NSURLErrorBadURL)
            return
        }
        let rangeHeader = req.value(forHTTPHeaderField: "Range")

        ioQueue.async { [weak self] in
            self?.serve(url: requestURL, rangeHeader: rangeHeader, task: urlSchemeTask, taskID: taskID)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask)
        lock.lock()
        activeTasks.remove(taskID)
        lock.unlock()
    }

    private func serve(url: URL, rangeHeader: String?, task: WKURLSchemeTask, taskID: ObjectIdentifier) {
        var relPath = url.path
        while relPath.hasPrefix("/") {
            relPath.removeFirst()
        }
        if relPath.isEmpty {
            relPath = "index.html"
        }

        let fileURL = wwwRoot.appendingPathComponent(relPath).resolvingSymlinksInPath().standardizedFileURL
        guard fileURL.path.hasPrefix(wwwRoot.path) else {
            failTask(task, taskID: taskID, code: NSURLErrorNoPermissionsToReadFile)
            return
        }

        guard FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
            sendNotFound(url: url, task: task, taskID: taskID)
            return
        }

        let mime = Self.mimeType(for: fileURL.pathExtension)
        let totalLen = data.count

        if let rangeHeader = rangeHeader,
           let (start, end) = Self.parseRange(header: rangeHeader, totalLength: totalLen) {
            let slice = data.subdata(in: start..<(end + 1))
            let headers: [String: String] = [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Content-Length": "\(slice.count)",
                "Content-Range": "bytes \(start)-\(end)/\(totalLen)",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache"
            ]
            if let resp = HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: headers) {
                finishWithData(task: task, taskID: taskID, response: resp, data: slice)
                return
            }
        }

        let headers: [String: String] = [
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Length": "\(totalLen)",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache"
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            failTask(task, taskID: taskID, code: NSURLErrorCannotParseResponse)
            return
        }
        finishWithData(task: task, taskID: taskID, response: response, data: data)
    }

    private func finishWithData(task: WKURLSchemeTask, taskID: ObjectIdentifier, response: URLResponse, data: Data) {
        lock.lock()
        defer { lock.unlock() }
        guard activeTasks.remove(taskID) != nil else { return }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func sendNotFound(url: URL, task: WKURLSchemeTask, taskID: ObjectIdentifier) {
        lock.lock()
        defer { lock.unlock() }
        guard activeTasks.remove(taskID) != nil else { return }
        let headers = ["Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"]
        if let resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: headers) {
            task.didReceive(resp)
            task.didReceive(Data("Not Found".utf8))
            task.didFinish()
        } else {
            task.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
        }
    }

    private func failTask(_ task: WKURLSchemeTask, taskID: ObjectIdentifier, code: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard activeTasks.remove(taskID) != nil else { return }
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: code))
    }

    private static func parseRange(header: String, totalLength: Int) -> (Int, Int)? {
        guard totalLength > 0, header.hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: ",").first ?? ""
        let parts = spec.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return nil }
        let start = Int(parts[0]) ?? 0
        let end = parts[1].isEmpty ? (totalLength - 1) : min(Int(parts[1]) ?? (totalLength - 1), totalLength - 1)
        guard start >= 0, start <= end, start < totalLength else { return nil }
        return (start, end)
    }

    private static func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs":   return "application/javascript; charset=utf-8"
        case "json":        return "application/json; charset=utf-8"
        case "css":         return "text/css; charset=utf-8"
        case "png":         return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif":         return "image/gif"
        case "webp":        return "image/webp"
        case "svg":         return "image/svg+xml"
        case "m4a", "mp4a": return "audio/mp4"
        case "mp3":         return "audio/mpeg"
        case "ogg":         return "audio/ogg"
        case "wav":         return "audio/wav"
        case "mp4":         return "video/mp4"
        case "webm":        return "video/webm"
        case "woff":        return "font/woff"
        case "woff2":       return "font/woff2"
        case "ttf":         return "font/ttf"
        case "xml":         return "application/xml"
        default:            return "application/octet-stream"
        }
    }
}
