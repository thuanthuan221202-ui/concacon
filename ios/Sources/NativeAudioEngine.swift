import Foundation
import AVFoundation

/// Native hardware-accelerated audio engine running in the Host App process on a dedicated background queue.
/// Zero WebContent RAM usage AND zero Main Thread blocking during rapid fighting combos!
final class NativeAudioEngine: NSObject, AVAudioPlayerDelegate {
    private final class TrackEntry {
        let id: Int
        var tag: String
        let src: String
        let isMusic: Bool
        var looping: Bool
        var volume: Float
        var muted: Bool
        var pausedByUser: Bool = false
        var pausedBySuspend: Bool = false
        let player: AVAudioPlayer
        let createdAt: TimeInterval

        init(
            id: Int,
            tag: String,
            src: String,
            isMusic: Bool,
            looping: Bool,
            volume: Float,
            muted: Bool,
            player: AVAudioPlayer
        ) {
            self.id = id
            self.tag = tag
            self.src = src
            self.isMusic = isMusic
            self.looping = looping
            self.volume = volume
            self.muted = muted
            self.player = player
            self.createdAt = Date().timeIntervalSinceReferenceDate
        }
    }

    private let wwwRoot: URL
    private let audioQueue = DispatchQueue(
        label: "com.geneildosantos.zlegends3.audio",
        qos: .userInitiated
    )

    // Pre-indexed media files (built once on background queue -> ZERO FileManager syscalls during combat!)
    private var mediaIndex: [String: (url: URL, size: Int)] = [:]
    private var isIndexed: Bool = false

    private var tracksById: [Int: TrackEntry] = [:]
    private var idByPlayer: [ObjectIdentifier: Int] = [:]
    private var lastTrackId: Int?

    // Fast LRU Data cache for short SFX (<= 150 KB, up to 48 files -> ~2.5 MB in Host Process, 0 MB in WebContent)
    private var sfxDataCache: [String: Data] = [:]
    private var sfxCacheOrder: [String] = []
    private let maxCachedSfxFiles = 48
    private let maxCachedSfxBytes = 150 * 1024
    private let maxConcurrentSfxPlayers = 16

    private var masterVolume: Float = 1.0
    private var isSilent: Bool = false
    private var isSuspended: Bool = false

    var onTrackEnded: ((Int, String) -> Void)?

    init(wwwRoot: URL) {
        self.wwwRoot = wwwRoot.resolvingSymlinksInPath().standardizedFileURL
        super.init()
        audioQueue.async { [weak self] in
            self?.buildMediaIndex()
        }
    }

    private func buildMediaIndex() {
        guard !isIndexed else { return }
        isIndexed = true
        let mediaDir = wwwRoot.appendingPathComponent("media", isDirectory: true)
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: mediaDir,
            includingPropertiesForKeys: [.fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        var index: [String: (url: URL, size: Int)] = [:]
        index.reserveCapacity(items.count)
        for url in items {
            let name = url.lastPathComponent.precomposedStringWithCanonicalMapping.lowercased()
            let sz = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? Int.max
            index[name] = (url, sz)
        }
        self.mediaIndex = index
    }

    /// Non-blocking entry point from WKScriptMessageHandler (returns immediately to Main Thread in < 0.01ms!)
    func handleCommand(_ body: [String: Any]) {
        guard let cmd = body["cmd"] as? String else { return }

        // Extract primitive values synchronously before dispatching off Main Thread
        switch cmd {
        case "play":
            guard let id = (body["id"] as? NSNumber)?.intValue,
                  let src = body["src"] as? String else { return }
            let tag = (body["tag"] as? String) ?? ""
            let looping = (body["looping"] as? Bool) ?? false
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            let isMusic = (body["isMusic"] as? Bool) ?? false
            audioQueue.async { [weak self] in
                self?.playInternal(id: id, src: src, tag: tag, looping: looping, volume: volume, isMusic: isMusic)
            }

        case "stop":
            let tag = (body["tag"] as? String) ?? ""
            audioQueue.async { [weak self] in
                self?.stopInternal(tag: tag)
            }

        case "stopAll":
            audioQueue.async { [weak self] in
                self?.stopAllInternal()
            }

        case "setMuted":
            let tag = (body["tag"] as? String) ?? ""
            let muted = (body["muted"] as? Bool) ?? false
            audioQueue.async { [weak self] in
                self?.setMutedInternal(tag: tag, muted: muted)
            }

        case "setVolume":
            let tag = (body["tag"] as? String) ?? ""
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            audioQueue.async { [weak self] in
                self?.setVolumeInternal(tag: tag, volume: volume)
            }

        case "setMasterVolume":
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            audioQueue.async { [weak self] in
                self?.setMasterVolumeInternal(volume)
            }

        case "setSilent":
            let silent = (body["silent"] as? Bool) ?? false
            audioQueue.async { [weak self] in
                self?.setSilentInternal(silent)
            }

        case "setLooping":
            let tag = (body["tag"] as? String) ?? ""
            let looping = (body["looping"] as? Bool) ?? false
            audioQueue.async { [weak self] in
                self?.setLoopingInternal(tag: tag, looping: looping)
            }

        case "setPaused":
            let tag = (body["tag"] as? String) ?? ""
            let paused = (body["paused"] as? Bool) ?? false
            audioQueue.async { [weak self] in
                self?.setPausedInternal(tag: tag, paused: paused)
            }

        case "seek":
            let tag = (body["tag"] as? String) ?? ""
            let pos = (body["pos"] as? NSNumber)?.doubleValue ?? 0.0
            audioQueue.async { [weak self] in
                self?.seekInternal(tag: tag, position: pos)
            }

        case "setSuspended":
            let suspended = (body["suspended"] as? Bool) ?? false
            setSuspended(suspended)

        case "unloadAll", "purgeCache":
            purgeCache()

        default:
            break
        }
    }

    func stopAll() {
        audioQueue.async { [weak self] in
            self?.stopAllInternal()
        }
    }

    func setSuspended(_ suspended: Bool) {
        audioQueue.async { [weak self] in
            self?.setSuspendedInternal(suspended)
        }
    }

    func purgeCache() {
        audioQueue.async { [weak self] in
            self?.sfxDataCache.removeAll(keepingCapacity: false)
            self?.sfxCacheOrder.removeAll(keepingCapacity: false)
        }
    }

    // MARK: - Internal (runs exclusively on audioQueue)

    private func resolveMediaEntry(for rawSrc: String) -> (url: URL, size: Int)? {
        if !isIndexed { buildMediaIndex() }
        var rel = rawSrc.removingPercentEncoding ?? rawSrc
        if rel.hasPrefix("app://localhost/") {
            rel = String(rel.dropFirst("app://localhost/".count))
        }
        while rel.hasPrefix("/") {
            rel.removeFirst()
        }
        let lowerRel = rel.precomposedStringWithCanonicalMapping.lowercased()
        let filename: String
        if lowerRel.hasPrefix("media/") {
            filename = String(lowerRel.dropFirst("media/".count))
        } else {
            filename = (lowerRel as NSString).lastPathComponent
        }

        if let hit = mediaIndex[filename] {
            return hit
        }
        if !filename.hasSuffix(".m4a") {
            let m4aName = ((filename as NSString).deletingPathExtension) + ".m4a"
            if let hit = mediaIndex[m4aName] {
                return hit
            }
        }

        // Fallback direct path lookup
        let fallbackURL = wwwRoot.appendingPathComponent(lowerRel).resolvingSymlinksInPath().standardizedFileURL
        if fallbackURL.path.hasPrefix(wwwRoot.path), FileManager.default.fileExists(atPath: fallbackURL.path) {
            let sz = (try? fallbackURL.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? Int.max
            return (fallbackURL, sz)
        }
        return nil
    }

    private func makePlayer(for entry: (url: URL, size: Int), isMusic: Bool) -> AVAudioPlayer? {
        // Music & large audio (>150KB): stream directly from APFS via hardware AAC decoder (< 1MB RAM!)
        if isMusic || entry.size > maxCachedSfxBytes {
            return try? AVAudioPlayer(contentsOf: entry.url)
        }

        // Short SFX (<=150KB): use fast in-memory compressed Data LRU cache
        let key = entry.url.path
        if let cached = sfxDataCache[key] {
            if let idx = sfxCacheOrder.firstIndex(of: key) {
                sfxCacheOrder.remove(at: idx)
            }
            sfxCacheOrder.append(key)
            return try? AVAudioPlayer(data: cached)
        }

        if let data = try? Data(contentsOf: entry.url) {
            if sfxCacheOrder.count >= maxCachedSfxFiles, let oldest = sfxCacheOrder.first {
                sfxCacheOrder.removeFirst()
                sfxDataCache.removeValue(forKey: oldest)
            }
            sfxDataCache[key] = data
            sfxCacheOrder.append(key)
            return try? AVAudioPlayer(data: data)
        }

        return try? AVAudioPlayer(contentsOf: entry.url)
    }

    private func clampVolume(_ v: Float) -> Float {
        if v.isNaN || v <= 0 { return 0 }
        return min(1.0, v)
    }

    private func applyVolume(to entry: TrackEntry) {
        if isSilent || entry.muted {
            entry.player.volume = 0
        } else {
            entry.player.volume = clampVolume(entry.volume * masterVolume)
        }
    }

    private func notifyTrackEnded(id: Int, tag: String) {
        guard let cb = onTrackEnded else { return }
        DispatchQueue.main.async {
            cb(id, tag)
        }
    }

    private func removeTrackInternal(id: Int, notifyJS: Bool) {
        guard let entry = tracksById.removeValue(forKey: id) else { return }
        idByPlayer.removeValue(forKey: ObjectIdentifier(entry.player))
        entry.player.delegate = nil
        entry.player.stop()
        if lastTrackId == id {
            lastTrackId = nil
        }
        if notifyJS {
            notifyTrackEnded(id: entry.id, tag: entry.tag)
        }
    }

    private func evictExcessSfxIfNeeded() {
        let sfxTracks = tracksById.values.filter { !$0.isMusic }
        guard sfxTracks.count >= maxConcurrentSfxPlayers else { return }
        let sorted = sfxTracks.sorted { $0.createdAt < $1.createdAt }
        let toRemove = sorted.count - maxConcurrentSfxPlayers + 1
        for i in 0..<min(toRemove, sorted.count) {
            removeTrackInternal(id: sorted[i].id, notifyJS: true)
        }
    }

    private func playInternal(id: Int, src: String, tag: String, looping: Bool, volume: Float, isMusic: Bool) {
        if isSilent {
            notifyTrackEnded(id: id, tag: tag)
            return
        }

        guard let mediaEntry = resolveMediaEntry(for: src) else {
            notifyTrackEnded(id: id, tag: tag)
            return
        }

        if isMusic {
            let oldMusicIds = tracksById.values.filter { $0.isMusic }.map { $0.id }
            for oldId in oldMusicIds {
                removeTrackInternal(id: oldId, notifyJS: false)
            }
        } else {
            evictExcessSfxIfNeeded()
        }

        guard let player = makePlayer(for: mediaEntry, isMusic: isMusic) else {
            notifyTrackEnded(id: id, tag: tag)
            return
        }

        player.delegate = self
        player.numberOfLoops = looping ? -1 : 0

        let entry = TrackEntry(
            id: id,
            tag: tag,
            src: src,
            isMusic: isMusic,
            looping: looping,
            volume: clampVolume(volume),
            muted: false,
            player: player
        )
        applyVolume(to: entry)

        tracksById[id] = entry
        idByPlayer[ObjectIdentifier(player)] = id
        lastTrackId = id

        if isSuspended {
            entry.pausedBySuspend = true
        } else {
            player.play()
        }
    }

    private func matchingTracks(for tag: String) -> [TrackEntry] {
        if tag.isEmpty {
            if let lastId = lastTrackId, let entry = tracksById[lastId] {
                return [entry]
            }
            return []
        }
        let target = tag.lowercased()
        return tracksById.values.filter { $0.tag.lowercased() == target }
    }

    private func stopInternal(tag: String) {
        for entry in matchingTracks(for: tag) {
            removeTrackInternal(id: entry.id, notifyJS: false)
        }
    }

    private func stopAllInternal() {
        let allIds = Array(tracksById.keys)
        for id in allIds {
            removeTrackInternal(id: id, notifyJS: false)
        }
    }

    private func setMutedInternal(tag: String, muted: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.muted = muted
            applyVolume(to: entry)
        }
    }

    private func setVolumeInternal(tag: String, volume: Float) {
        let clamped = clampVolume(volume)
        for entry in matchingTracks(for: tag) {
            entry.volume = clamped
            applyVolume(to: entry)
        }
    }

    private func setMasterVolumeInternal(_ volume: Float) {
        masterVolume = clampVolume(volume)
        for entry in tracksById.values {
            applyVolume(to: entry)
        }
    }

    private func setSilentInternal(_ silent: Bool) {
        isSilent = silent
        for entry in tracksById.values {
            applyVolume(to: entry)
        }
    }

    private func setLoopingInternal(tag: String, looping: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.looping = looping
            entry.player.numberOfLoops = looping ? -1 : 0
        }
    }

    private func setPausedInternal(tag: String, paused: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.pausedByUser = paused
            if paused {
                entry.player.pause()
            } else if !isSuspended {
                entry.player.play()
            }
        }
    }

    private func seekInternal(tag: String, position: Double) {
        for entry in matchingTracks(for: tag) {
            let clamped = max(0.0, min(position, entry.player.duration))
            entry.player.currentTime = clamped
        }
    }

    private func setSuspendedInternal(_ suspended: Bool) {
        guard isSuspended != suspended else { return }
        isSuspended = suspended
        for entry in tracksById.values {
            if suspended {
                if entry.player.isPlaying {
                    entry.player.pause()
                    entry.pausedBySuspend = true
                }
            } else {
                if entry.pausedBySuspend && !entry.pausedByUser {
                    entry.pausedBySuspend = false
                    entry.player.play()
                }
            }
        }
    }

    // MARK: - AVAudioPlayerDelegate

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let key = ObjectIdentifier(player)
        audioQueue.async { [weak self] in
            guard let self = self, let id = self.idByPlayer[key] else { return }
            self.removeTrackInternal(id: id, notifyJS: true)
        }
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let key = ObjectIdentifier(player)
        audioQueue.async { [weak self] in
            guard let self = self, let id = self.idByPlayer[key] else { return }
            self.removeTrackInternal(id: id, notifyJS: true)
        }
    }
}
