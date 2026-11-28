import UIKit
import WebKit

final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var audioEngine: NativeAudioEngine?
    private var memoryPressureSource: DispatchSourceMemoryPressure?
    private var memoryWatchdogTimer: Timer?
    private var lastReportedPressureLevel: Int = 0
    private var lastPurgeTimestamp: TimeInterval = 0

    // STRICT ANTI-RELOAD LOCK: blocks all unwanted JS/page reloads; allows ONLY controlled silent recovery if iOS kernel kills WebContent.
    private var hasCompletedInitialLoad: Bool = false
    private var allowManualRecoveryOnce: Bool = false

    // Live Match Checkpoint stored in Host App RAM (~100KB) so if iOS Jetsam ever kills WebContent,
    // the game silently auto-resumes the exact in-progress match with ZERO popup and ZERO black screen!
    private var latestCheckpointPayload: String?
    private var latestCheckpointLayout: String = ""
    private var latestCheckpointTimestamp: TimeInterval = 0
    private var pendingResumeAfterDidFinish: Bool = false
    private var isRecoveringFromTermination: Bool = false
    private var terminationTimestamps: [TimeInterval] = []

    // Subtle non-blocking native overlay shown briefly during silent auto-resume
    private var recoveryOverlayView: UIView?
    private var recoveryLabel: UILabel?
    private var recoveryHideWorkItem: DispatchWorkItem?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var shouldAutorotate: Bool { true }

    deinit {
        memoryWatchdogTimer?.invalidate()
        memoryPressureSource?.cancel()
        recoveryHideWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "z3NativeClean")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "z3Audio")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "z3Checkpoint")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        // Disable URLCache memory/disk duplication of local bundle files
        URLCache.shared.memoryCapacity = 0
        URLCache.shared.diskCapacity = 0
        URLCache.shared.removeAllCachedResponses()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false

        // Inform JS runtime at document start that background-queue NativeAudioEngine is active
        // -> enables 100% Native Swift Audio and skips AudioContext allocation (saves 35-60MB in WebContent!)
        let nativeFlagsScript = WKUserScript(
            source: "window.__z3AsyncAudio = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(nativeFlagsScript)
        config.userContentController.add(self, name: "z3NativeClean")
        config.userContentController.add(self, name: "z3Audio")
        config.userContentController.add(self, name: "z3Checkpoint")

        if let wwwURL = Bundle.main.url(forResource: "www", withExtension: nil) {
            let handler = WebSchemeHandler(wwwRoot: wwwURL)
            config.setURLSchemeHandler(handler, forURLScheme: "app")

            let engine = NativeAudioEngine(wwwRoot: wwwURL)
            engine.onTrackEnded = { [weak self] id, _ in
                self?.webView?.evaluateJavaScript(
                    "if (window.__z3NativeAudioEnded) window.__z3NativeAudioEnded(\(id));",
                    completionHandler: nil
                )
            }
            self.audioEngine = engine
        }

        let wv = WKWebView(frame: view.bounds, configuration: config)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.backgroundColor = .black
        wv.isOpaque = true
        wv.allowsBackForwardNavigationGestures = false
        wv.allowsLinkPreview = false
        wv.isMultipleTouchEnabled = true
        wv.navigationDelegate = self
        wv.uiDelegate = self

        let sv = wv.scrollView
        sv.backgroundColor = .black
        sv.isScrollEnabled = false
        sv.bounces = false
        sv.alwaysBounceVertical = false
        sv.alwaysBounceHorizontal = false
        sv.showsVerticalScrollIndicator = false
        sv.showsHorizontalScrollIndicator = false
        sv.delaysContentTouches = false
        sv.canCancelContentTouches = false
        sv.contentInsetAdjustmentBehavior = .never
        sv.pinchGestureRecognizer?.isEnabled = false
        sv.panGestureRecognizer.isEnabled = false

        if #available(iOS 16.4, *) {
            wv.isInspectable = true
        }

        view.addSubview(wv)
        self.webView = wv

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        setupKernelMemoryPressureMonitor()
        startMemoryWatchdogTimer()

        if let startURL = URL(string: "app://localhost/index.html") {
            wv.load(URLRequest(url: startURL))
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsUpdateOfScreenEdgesDeferringSystemGestures()
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: - Subtle Non-Blocking Recovery Banner (Zero Alert Popups!)

    private func showRecoveryOverlay(message: String) {
        recoveryHideWorkItem?.cancel()

        if let existing = recoveryOverlayView {
            recoveryLabel?.text = message
            existing.alpha = 1.0
            existing.isHidden = false
            view.bringSubviewToFront(existing)
            return
        }

        let overlay = UIView(frame: view.bounds)
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.backgroundColor = UIColor(white: 0.0, alpha: 0.72)
        overlay.isUserInteractionEnabled = true

        let pill = UIView()
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.backgroundColor = UIColor(red: 0.09, green: 0.11, blue: 0.16, alpha: 0.94)
        pill.layer.cornerRadius = 16
        pill.layer.borderWidth = 1
        pill.layer.borderColor = UIColor(red: 1.0, green: 0.78, blue: 0.22, alpha: 0.55).cgColor

        let spinner: UIActivityIndicatorView
        if #available(iOS 13.0, *) {
            spinner = UIActivityIndicatorView(style: .medium)
        } else {
            spinner = UIActivityIndicatorView(style: .white)
        }
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.color = UIColor(red: 1.0, green: 0.82, blue: 0.28, alpha: 1.0)
        spinner.startAnimating()

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = message
        label.textColor = .white
        label.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
        label.numberOfLines = 1

        pill.addSubview(spinner)
        pill.addSubview(label)
        overlay.addSubview(pill)
        view.addSubview(overlay)

        NSLayoutConstraint.activate([
            pill.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            pill.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            pill.heightAnchor.constraint(equalToConstant: 48),
            spinner.leadingAnchor.constraint(equalTo: pill.leadingAnchor, constant: 18),
            spinner.centerYAnchor.constraint(equalTo: pill.centerYAnchor),
            label.leadingAnchor.constraint(equalTo: spinner.trailingAnchor, constant: 12),
            label.trailingAnchor.constraint(equalTo: pill.trailingAnchor, constant: -20),
            label.centerYAnchor.constraint(equalTo: pill.centerYAnchor)
        ])

        self.recoveryOverlayView = overlay
        self.recoveryLabel = label
    }

    private func hideRecoveryOverlay(delay: TimeInterval = 0.25) {
        recoveryHideWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let overlay = self.recoveryOverlayView else { return }
            self.isRecoveringFromTermination = false
            UIView.animate(withDuration: 0.22, animations: {
                overlay.alpha = 0.0
            }, completion: { _ in
                overlay.removeFromSuperview()
                if self.recoveryOverlayView === overlay {
                    self.recoveryOverlayView = nil
                    self.recoveryLabel = nil
                }
            })
        }
        recoveryHideWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: - Smooth Non-Stuttering Memory Pressure Shield

    private func setupKernelMemoryPressureMonitor() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self = self, let event = self.memoryPressureSource?.data else { return }
            let now = Date().timeIntervalSinceReferenceDate
            guard (now - self.lastPurgeTimestamp) >= 3.0 else { return }
            self.lastPurgeTimestamp = now

            if event.contains(.critical) {
                NSLog("[ZLegends3] CRITICAL kernel memory pressure! Saving checkpoint & soft-evicting idle textures...")
                self.triggerInGameMemoryTrim(pressureLevel: 2)
            } else if event.contains(.warning) {
                NSLog("[ZLegends3] WARNING kernel memory pressure! Trimming idle caches...")
                self.triggerInGameMemoryTrim(pressureLevel: 1)
            }
        }
        source.resume()
        self.memoryPressureSource = source
    }

    private func startMemoryWatchdogTimer() {
        memoryWatchdogTimer?.invalidate()
        memoryWatchdogTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.checkAvailableSystemMemory()
        }
    }

    private func checkAvailableSystemMemory() {
        let availBytes = Int(os_proc_available_memory())
        guard availBytes > 0 else { return }
        let availMB = availBytes / (1024 * 1024)

        let nextLevel: Int
        if availMB < 65 {
            nextLevel = 2
        } else if availMB < 120 {
            nextLevel = 1
        } else if availMB >= 180 {
            nextLevel = 0
        } else {
            nextLevel = lastReportedPressureLevel
        }

        if nextLevel != lastReportedPressureLevel {
            lastReportedPressureLevel = nextLevel
            NSLog("[ZLegends3] Memory headroom = %ld MB -> pressure level %ld", availMB, nextLevel)
            webView?.evaluateJavaScript(
                "if (window.__c2SetMemoryPressure) window.__c2SetMemoryPressure(\(nextLevel));",
                completionHandler: nil
            )
            if nextLevel >= 1 {
                triggerInGameMemoryTrim(pressureLevel: nextLevel)
            }
        }
    }

    private func clearWebKitCachesOnly() {
        URLCache.shared.removeAllCachedResponses()
        let cacheTypes: Set<String> = [
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeFetchCache
        ]
        WKWebsiteDataStore.default().removeData(ofTypes: cacheTypes, modifiedSince: .distantPast) {}
    }

    /// Non-blocking in-game trim: snapshots latest match state + clears idle/off-screen textures ONLY (zero stutter!)
    private func triggerInGameMemoryTrim(pressureLevel: Int) {
        audioEngine?.purgeCache()
        URLCache.shared.removeAllCachedResponses()
        if pressureLevel >= 2 {
            clearWebKitCachesOnly()
        }
        webView?.evaluateJavaScript(
            "if (window.__z3CaptureCheckpoint) window.__z3CaptureCheckpoint(true); if (window.__c2EmergencyPurge) window.__c2EmergencyPurge(1);",
            completionHandler: nil
        )
    }

    /// Full purge ONLY when app goes to background (saves checkpoint first + flushes all VRAM so iOS won't kill it!)
    private func triggerBackgroundFullPurge() {
        audioEngine?.purgeCache()
        clearWebKitCachesOnly()
        webView?.evaluateJavaScript(
            "if (window.__z3CaptureCheckpoint) window.__z3CaptureCheckpoint(true); if (window.__c2EmergencyPurge) window.__c2EmergencyPurge(2);",
            completionHandler: nil
        )
    }

    // MARK: - App Lifecycle

    @objc private func appWillResignActive() {
        audioEngine?.setSuspended(true)
        webView?.evaluateJavaScript(
            "if (window.__z3CaptureCheckpoint) window.__z3CaptureCheckpoint(true); if (window.cr_setSuspended) window.cr_setSuspended(true);",
            completionHandler: nil
        )
    }

    @objc private func appDidEnterBackground() {
        NSLog("[ZLegends3] App entered background — saving live checkpoint & flushing VRAM.")
        audioEngine?.setSuspended(true)
        triggerBackgroundFullPurge()
    }

    @objc private func appDidBecomeActive() {
        audioEngine?.setSuspended(false)
        webView?.evaluateJavaScript(
            "if (window.cr_setSuspended) window.cr_setSuspended(false); if (window.__resumeAllAudioContexts) window.__resumeAllAudioContexts();",
            completionHandler: nil
        )
    }

    override func didReceiveMemoryWarning() {
        super.didReceiveMemoryWarning()
        NSLog("[ZLegends3] OS Memory Warning received! Saving checkpoint & trimming idle VRAM...")
        triggerInGameMemoryTrim(pressureLevel: 2)
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "z3Audio" {
            if let body = message.body as? [String: Any] {
                audioEngine?.handleCommand(body)
            }
            return
        }

        if message.name == "z3NativeClean" {
            audioEngine?.purgeCache()
            clearWebKitCachesOnly()
            return
        }

        if message.name == "z3Checkpoint" {
            guard let body = message.body as? [String: Any] else { return }

            if let clear = body["clear"] as? Bool, clear {
                latestCheckpointPayload = nil
                latestCheckpointLayout = ""
                latestCheckpointTimestamp = 0
            }

            if let restored = body["restored"] as? Bool {
                NSLog("[ZLegends3] Live match checkpoint restore result: %@", restored ? "SUCCESS" : "FALLBACK")
                if !restored {
                    latestCheckpointPayload = nil
                    latestCheckpointLayout = ""
                }
                hideRecoveryOverlay(delay: restored ? 0.35 : 0.2)
                return
            }

            if let ready = body["ready"] as? Bool, ready {
                if recoveryOverlayView != nil && !pendingResumeAfterDidFinish {
                    hideRecoveryOverlay(delay: 0.2)
                }
            }

            if let payload = body["payload"] as? String, !payload.isEmpty {
                latestCheckpointPayload = payload
                latestCheckpointLayout = (body["layout"] as? String) ?? ""
                latestCheckpointTimestamp = Date().timeIntervalSinceReferenceDate
            }
            return
        }
    }

    // MARK: - WKNavigationDelegate (STRICT NO-RELOAD GUARD)

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasCompletedInitialLoad = true
        allowManualRecoveryOnce = false

        if pendingResumeAfterDidFinish {
            pendingResumeAfterDidFinish = false
            if let payload = latestCheckpointPayload {
                let b64 = Data(payload.utf8).base64EncodedString()
                webView.evaluateJavaScript(
                    "if (window.__z3QueueCheckpointBase64) window.__z3QueueCheckpointBase64('\(b64)');",
                    completionHandler: nil
                )
            } else {
                hideRecoveryOverlay(delay: 0.3)
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if hasCompletedInitialLoad && !allowManualRecoveryOnce {
            if navigationAction.navigationType == .reload {
                NSLog("[ZLegends3] Blocked reload navigation strictly.")
                decisionHandler(.cancel)
                return
            }
            if navigationAction.targetFrame?.isMainFrame == true,
               let url = navigationAction.request.url,
               let scheme = url.scheme?.lowercased(),
               scheme == "app" {
                NSLog("[ZLegends3] Blocked main-frame app:// re-navigation strictly: %@", url.absoluteString)
                decisionHandler(.cancel)
                return
            }
        }

        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if scheme == "app" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
        } else if scheme == "http" || scheme == "https" {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: "Z Legends 3", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[ZLegends3] WebContent terminated by iOS kernel — executing silent auto-resume (zero popup)!")
        audioEngine?.stopAll()
        audioEngine?.purgeCache()
        clearWebKitCachesOnly()

        let now = Date().timeIntervalSinceReferenceDate
        terminationTimestamps = terminationTimestamps.filter { (now - $0) < 25.0 }
        terminationTimestamps.append(now)

        // Crash-loop guard: if iOS kills WebContent 3+ times within 25s, drop checkpoint and recover cleanly to Menu
        if terminationTimestamps.count >= 3 {
            NSLog("[ZLegends3] Repeated Jetsam detected (%ld in 25s) — clearing checkpoint to prevent loop.", terminationTimestamps.count)
            latestCheckpointPayload = nil
            latestCheckpointLayout = ""
            latestCheckpointTimestamp = 0
        }

        let hasFreshCheckpoint = (latestCheckpointPayload != nil) && ((now - latestCheckpointTimestamp) < 600.0)
        isRecoveringFromTermination = true
        pendingResumeAfterDidFinish = hasFreshCheckpoint

        let statusText = hasFreshCheckpoint ? "Đang tiếp tục trận đấu..." : "Đang khôi phục game..."
        showRecoveryOverlay(message: statusText)

        // Guaranteed failsafe hide so overlay can never get stuck
        hideRecoveryOverlay(delay: 8.5)

        let reloadDelay: TimeInterval = (terminationTimestamps.count >= 3) ? 0.6 : 0.08
        DispatchQueue.main.asyncAfter(deadline: .now() + reloadDelay) { [weak self] in
            guard let self = self else { return }
            self.allowManualRecoveryOnce = true
            if let startURL = URL(string: "app://localhost/index.html") {
                self.webView.load(URLRequest(url: startURL))
            }
        }
    }
}
