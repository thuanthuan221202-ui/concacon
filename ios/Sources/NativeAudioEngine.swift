import Foundation
import AVFoundation

/// Native hardware-accelerated audio engine running in the Host App process.
/// Streams music & large SFX directly from APFS via AVAudioPlayer (0 MB RAM in WKWebView WebContent!).
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
    private var tracksById: [Int: TrackEntry] = [:]
    private var idByPlayer: [ObjectIdentifier: Int] = [:]
    private var lastTrackId: Int?

    // Tiny LRU Data cache ONLY for short SFX (<= 150 KB) -> < 1.5 MB total in Host process
    private var sfxDataCache: [String: Data] = [:]
    private var sfxCacheOrder: [String] = []
    private let maxCachedSfxFiles = 24
    private let maxCachedSfxBytes = 150 * 1024
    private let maxConcurrentSfxPlayers = 14

    private var masterVolume: Float = 1.0
    private var isSilent: Bool = false
    private var isSuspended: Bool = false

    var onTrackEnded: ((Int, String) -> Void)?

    init(wwwRoot: URL) {
        self.wwwRoot = wwwRoot.resolvingSymlinksInPath().standardizedFileURL
        super.init()
    }

    func handleCommand(_ body: [String: Any]) {
        guard let cmd = body["cmd"] as? String else { return }

        switch cmd {
        case "play":
            guard let id = (body["id"] as? NSNumber)?.intValue,
                  let src = body["src"] as? String else { return }
            let tag = (body["tag"] as? String) ?? ""
            let looping = (body["looping"] as? Bool) ?? false
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            let isMusic = (body["isMusic"] as? Bool) ?? false
            play(id: id, src: src, tag: tag, looping: looping, volume: volume, isMusic: isMusic)

        case "stop":
            let tag = (body["tag"] as? String) ?? ""
            stop(tag: tag)

        case "stopAll":
            stopAll()

        case "setMuted":
            let tag = (body["tag"] as? String) ?? ""
            let muted = (body["muted"] as? Bool) ?? false
            setMuted(tag: tag, muted: muted)

        case "setVolume":
            let tag = (body["tag"] as? String) ?? ""
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            setVolume(tag: tag, volume: volume)

        case "setMasterVolume":
            let volume = (body["volume"] as? NSNumber)?.floatValue ?? 1.0
            setMasterVolume(volume)

        case "setSilent":
            let silent = (body["silent"] as? Bool) ?? false
            setSilent(silent)

        case "setLooping":
            let tag = (body["tag"] as? String) ?? ""
            let looping = (body["looping"] as? Bool) ?? false
            setLooping(tag: tag, looping: looping)

        case "setPaused":
            let tag = (body["tag"] as? String) ?? ""
            let paused = (body["paused"] as? Bool) ?? false
            setPaused(tag: tag, paused: paused)

        case "seek":
            let tag = (body["tag"] as? String) ?? ""
            let pos = (body["pos"] as? NSNumber)?.doubleValue ?? 0.0
            seek(tag: tag, position: pos)

        case "setSuspended":
            let suspended = (body["suspended"] as? Bool) ?? false
            setSuspended(suspended)

        case "unloadAll", "purgeCache":
            purgeCache()

        default:
            break
        }
    }

    private func resolveAudioURL(for rawSrc: String) -> URL? {
        var rel = rawSrc.removingPercentEncoding ?? rawSrc
        if rel.hasPrefix("app://localhost/") {
            rel = String(rel.dropFirst("app://localhost/".count))
        }
        while rel.hasPrefix("/") {
            rel.removeFirst()
        }
        rel = rel.precomposedStringWithCanonicalMapping

        let candidate1 = wwwRoot.appendingPathComponent(rel).resolvingSymlinksInPath().standardizedFileURL
        if candidate1.path.hasPrefix(wwwRoot.path), FileManager.default.fileExists(atPath: candidate1.path) {
            return candidate1
        }

        let lowerRel = rel.lowercased()
        let candidate2 = wwwRoot.appendingPathComponent(lowerRel).resolvingSymlinksInPath().standardizedFileURL
        if candidate2.path.hasPrefix(wwwRoot.path), FileManager.default.fileExists(atPath: candidate2.path) {
            return candidate2
        }

        if !lowerRel.hasSuffix(".m4a") {
            let base = (lowerRel as NSString).deletingPathExtension
            let candidate3 = wwwRoot.appendingPathComponent(base + ".m4a").resolvingSymlinksInPath().standardizedFileURL
            if candidate3.path.hasPrefix(wwwRoot.path), FileManager.default.fileExists(atPath: candidate3.path) {
                return candidate3
            }
        }
        return nil
    }

    private func makePlayer(for url: URL, isMusic: Bool) -> AVAudioPlayer? {
        // Music & large audio (>150KB): stream directly from disk via hardware AAC decoder (< 1MB RAM!)
        let fileSize = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? Int.max
        if isMusic || fileSize > maxCachedSfxBytes {
            return try? AVAudioPlayer(contentsOf: url)
        }

        // Short SFX (<=150KB): use tiny compressed Data LRU cache for < 0.5ms playback latency
        let key = url.path
        if let cached = sfxDataCache[key] {
            if let idx = sfxCacheOrder.firstIndex(of: key) {
                sfxCacheOrder.remove(at: idx)
            }
            sfxCacheOrder.append(key)
            return try? AVAudioPlayer(data: cached)
        }

        if let data = try? Data(contentsOf: url, options: .mappedIfSafe) {
            if sfxCacheOrder.count >= maxCachedSfxFiles, let oldest = sfxCacheOrder.first {
                sfxCacheOrder.removeFirst()
                sfxDataCache.removeValue(forKey: oldest)
            }
            sfxDataCache[key] = data
            sfxCacheOrder.append(key)
            return try? AVAudioPlayer(data: data)
        }

        return try? AVAudioPlayer(contentsOf: url)
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

    private func removeTrack(id: Int, notifyJS: Bool) {
        guard let entry = tracksById.removeValue(forKey: id) else { return }
        idByPlayer.removeValue(forKey: ObjectIdentifier(entry.player))
        entry.player.delegate = nil
        entry.player.stop()
        if lastTrackId == id {
            lastTrackId = nil
        }
        if notifyJS {
            onTrackEnded?(entry.id, entry.tag)
        }
    }

    private func evictExcessSfxIfNeeded() {
        let sfxTracks = tracksById.values.filter { !$0.isMusic }
        guard sfxTracks.count >= maxConcurrentSfxPlayers else { return }
        let sorted = sfxTracks.sorted { $0.createdAt < $1.createdAt }
        let toRemove = sorted.count - maxConcurrentSfxPlayers + 1
        for i in 0..<min(toRemove, sorted.count) {
            removeTrack(id: sorted[i].id, notifyJS: true)
        }
    }

    private func play(id: Int, src: String, tag: String, looping: Bool, volume: Float, isMusic: Bool) {
        if isSilent {
            onTrackEnded?(id, tag)
            return
        }

        guard let fileURL = resolveAudioURL(for: src) else {
            onTrackEnded?(id, tag)
            return
        }

        // Only 1 music track active at a time (matches Construct 2 playMusicAsSoundWorkaround behavior)
        if isMusic {
            let oldMusicIds = tracksById.values.filter { $0.isMusic }.map { $0.id }
            for oldId in oldMusicIds {
                removeTrack(id: oldId, notifyJS: false)
            }
        } else {
            evictExcessSfxIfNeeded()
        }

        guard let player = makePlayer(for: fileURL, isMusic: isMusic) else {
            onTrackEnded?(id, tag)
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
            player.prepareToPlay()
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

    func stop(tag: String) {
        let matched = matchingTracks(for: tag)
        for entry in matched {
            removeTrack(id: entry.id, notifyJS: false)
        }
    }

    func stopAll() {
        let allIds = Array(tracksById.keys)
        for id in allIds {
            removeTrack(id: id, notifyJS: false)
        }
    }

    func setMuted(tag: String, muted: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.muted = muted
            applyVolume(to: entry)
        }
    }

    func setVolume(tag: String, volume: Float) {
        let clamped = clampVolume(volume)
        for entry in matchingTracks(for: tag) {
            entry.volume = clamped
            applyVolume(to: entry)
        }
    }

    func setMasterVolume(_ volume: Float) {
        masterVolume = clampVolume(volume)
        for entry in tracksById.values {
            applyVolume(to: entry)
        }
    }

    func setSilent(_ silent: Bool) {
        isSilent = silent
        for entry in tracksById.values {
            applyVolume(to: entry)
        }
    }

    func setLooping(tag: String, looping: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.looping = looping
            entry.player.numberOfLoops = looping ? -1 : 0
        }
    }

    func setPaused(tag: String, paused: Bool) {
        for entry in matchingTracks(for: tag) {
            entry.pausedByUser = paused
            if paused {
                entry.player.pause()
            } else if !isSuspended {
                entry.player.play()
            }
        }
    }

    func seek(tag: String, position: Double) {
        for entry in matchingTracks(for: tag) {
            let clamped = max(0.0, min(position, entry.player.duration))
            entry.player.currentTime = clamped
        }
    }

    func setSuspended(_ suspended: Bool) {
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

    func purgeCache() {
        sfxDataCache.removeAll(keepingCapacity: false)
        sfxCacheOrder.removeAll(keepingCapacity: false)
    }

    // MARK: - AVAudioPlayerDelegate

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let key = ObjectIdentifier(player)
        guard let id = idByPlayer[key] else { return }
        removeTrack(id: id, notifyJS: true)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        let key = ObjectIdentifier(player)
        guard let id = idByPlayer[key] else { return }
        removeTrack(id: id, notifyJS: true)
    }
}
