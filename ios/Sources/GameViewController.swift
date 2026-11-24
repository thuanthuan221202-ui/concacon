import UIKit
import WebKit

final class GameViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var audioEngine: NativeAudioEngine?
    private var memoryPressureSource: DispatchSourceMemoryPressure?
    private var memoryWatchdogTimer: Timer?
    private var lastReportedPressureLevel: Int = 0
    private var lastCriticalPurgeTime: TimeInterval = 0

    // STRICT ANTI-RELOAD LOCK: once initial game page loads, ALL automatic/JS reloads are strictly forbidden.
    private var hasCompletedInitialLoad: Bool = false
    private var allowManualRecoveryOnce: Bool = false
    private var isShowingTerminationOverlay: Bool = false

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { false }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }
    override var shouldAutorotate: Bool { true }

    deinit {
        memoryWatchdogTimer?.invalidate()
        memoryPressureSource?.cancel()
        NotificationCenter.default.removeObserver(self)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "z3NativeClean")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "z3Audio")
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
        config.userContentController.add(self, name: "z3NativeClean")
        config.userContentController.add(self, name: "z3Audio")

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
        wv.isOpaque = false
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

    // MARK: - Proactive Kernel Memory Pressure Shield (Prevents Jetsam BEFORE OS kills WebContent)

    private func setupKernelMemoryPressureMonitor() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self = self, let event = self.memoryPressureSource?.data else { return }
            if event.contains(.critical) {
                NSLog("[ZLegends3] CRITICAL kernel memory pressure! Executing emergency zero-reload purge (Level 2)...")
                self.triggerZeroReloadMemoryPurge(level: 2)
            } else if event.contains(.warning) {
                NSLog("[ZLegends3] WARNING kernel memory pressure! Executing zero-reload purge (Level 1)...")
                self.triggerZeroReloadMemoryPurge(level: 1)
            }
        }
        source.resume()
        self.memoryPressureSource = source
    }

    private func startMemoryWatchdogTimer() {
        memoryWatchdogTimer?.invalidate()
        memoryWatchdogTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.checkAvailableSystemMemory()
        }
    }

    private func checkAvailableSystemMemory() {
        let availBytes = Int(os_proc_available_memory())
        guard availBytes > 0 else { return }
        let availMB = availBytes / (1024 * 1024)

        let nextLevel: Int
        if availMB < 180 {
            nextLevel = 2
        } else if availMB < 320 {
            nextLevel = 1
        } else if availMB >= 420 {
            nextLevel = 0
        } else {
            nextLevel = lastReportedPressureLevel
        }

        let now = Date().timeIntervalSinceReferenceDate
        if nextLevel != lastReportedPressureLevel {
            lastReportedPressureLevel = nextLevel
            NSLog("[ZLegends3] Memory headroom = %ld MB -> pressure level %ld", availMB, nextLevel)
            webView?.evaluateJavaScript(
                "if (window.__c2SetMemoryPressure) window.__c2SetMemoryPressure(\(nextLevel));",
                completionHandler: nil
            )
            if nextLevel >= 1 {
                triggerZeroReloadMemoryPurge(level: nextLevel)
                lastCriticalPurgeTime = now
            }
        } else if nextLevel == 2 && (now - lastCriticalPurgeTime) >= 6.0 {
            lastCriticalPurgeTime = now
            triggerZeroReloadMemoryPurge(level: 2)
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

    private func triggerZeroReloadMemoryPurge(level: Int) {
        audioEngine?.purgeCache()
        URLCache.shared.removeAllCachedResponses()
        if level >= 2 {
            clearWebKitCachesOnly()
        }
        webView?.evaluateJavaScript(
            "if (window.__c2EmergencyPurge) window.__c2EmergencyPurge(\(level)); else if (window.__c2PurgeMemory) window.__c2PurgeMemory();",
            completionHandler: nil
        )
    }

    // MARK: - App Lifecycle

    @objc private func appWillResignActive() {
        audioEngine?.setSuspended(true)
        webView?.evaluateJavaScript(
            "if (window.cr_setSuspended) window.cr_setSuspended(true);",
            completionHandler: nil
        )
    }

    @objc private func appDidEnterBackground() {
        // Dramatically cut VRAM/cache RAM while backgrounded so iOS will NOT Jetsam-kill WebContent when switching apps!
        NSLog("[ZLegends3] App entered background — flushing VRAM & caches to prevent background Jetsam kill.")
        audioEngine?.setSuspended(true)
        triggerZeroReloadMemoryPurge(level: 2)
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
        NSLog("[ZLegends3] OS Memory Warning received! Executing emergency zero-reload purge...")
        triggerZeroReloadMemoryPurge(level: 2)
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
            NSLog("[ZLegends3] Native cache cleanup triggered from JS.")
            audioEngine?.purgeCache()
            clearWebKitCachesOnly()
            return
        }
    }

    // MARK: - WKNavigationDelegate (STRICT NO-RELOAD GUARD)

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasCompletedInitialLoad = true
        allowManualRecoveryOnce = false
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        // STRICT RELOAD LOCK: once the game has booted, NEVER allow any reload or main-frame re-navigation!
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
        // STRICTLY FORBIDDEN TO AUTO-RELOAD!
        // Note: When iOS kernel forcibly SIGKILLs WebKit WebContent due to extreme system RAM exhaustion,
        // we NEVER auto-reload. Instead we flush all caches and let the user decide explicitly.
        NSLog("[ZLegends3] WebContent terminated by iOS kernel — AUTO-RELOAD IS STRICTLY BLOCKED!")
        audioEngine?.stopAll()
        audioEngine?.purgeCache()
        clearWebKitCachesOnly()

        guard !isShowingTerminationOverlay else { return }
        isShowingTerminationOverlay = true

        let alert = UIAlertController(
            title: "Đã chặn tự động Reload",
            message: "Hệ điều hành iOS vừa thu hồi tiến trình đồ họa do thiếu RAM hệ thống. App đã CẤM tuyệt đối tự động tải lại theo cài đặt của bạn.\n\n(Lưu ý: Tiến trình WebKit đã bị iOS tắt nên màn hình sẽ đứng yên cho đến khi bạn chọn mở lại.)",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Giữ nguyên (Không reload)", style: .cancel) { [weak self] _ in
            self?.isShowingTerminationOverlay = false
        })
        alert.addAction(UIAlertAction(title: "Khởi động lại thủ công", style: .default) { [weak self] _ in
            guard let self = self else { return }
            self.isShowingTerminationOverlay = false
            self.allowManualRecoveryOnce = true
            if let startURL = URL(string: "app://localhost/index.html") {
                self.webView.load(URLRequest(url: startURL))
            }
        })
        present(alert, animated: true)
    }
}
