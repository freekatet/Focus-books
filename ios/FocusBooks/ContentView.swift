import SwiftUI
import WebKit
import AVFoundation
import UIKit

/// Native iOS WebView wrapper with:
/// 1. Native `AVAudioSession` (.playback) for Lock Screen & background audio
/// 2. Cross-frame `WKUserScript` (`forMainFrameOnly: false`) injected inside `youtube.com/embed`
///    that blocks YouTube's visibilitychange pause-on-lock script
/// 3. Embedded `BundleHTTPServer` serving all 16 books offline directly from the iPhone app bundle
struct FocusBooksWebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        configureAudioSession()
        UIApplication.shared.isIdleTimerDisabled = true
        BundleHTTPServer.shared.start()

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true

        // Inject into ALL frames (including cross-origin youtube.com/embed iframes!)
        // so YouTube's embed player never detects backgrounding or Lock Screen transitions.
        let backgroundAudioUnlockJS = """
        (function() {
          try {
            Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
            Object.defineProperty(document, 'webkitHidden', { get: function() { return false; }, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
            Object.defineProperty(document, 'webkitVisibilityState', { get: function() { return 'visible'; }, configurable: true });

            const origDocAdd = document.addEventListener.bind(document);
            document.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange' || type === 'webkitvisibilitychange' || type === 'pagehide' || type === 'blur') {
                return;
              }
              return origDocAdd(type, listener, options);
            };

            const origWinAdd = window.addEventListener.bind(window);
            window.addEventListener = function(type, listener, options) {
              if (type === 'visibilitychange' || type === 'webkitvisibilitychange' || type === 'pagehide' || type === 'blur') {
                return;
              }
              return origWinAdd(type, listener, options);
            };
          } catch (e) {}
        })();
        """

        let script = WKUserScript(
            source: backgroundAudioUnlockJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        config.userContentController.addUserScript(script)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator

        context.coordinator.webView = webView
        context.coordinator.registerLifecycleObservers()

        let port = BundleHTTPServer.shared.port
        if let url = URL(string: "http://127.0.0.1:\(port)/index.html") {
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            webView.load(request)
        }

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            print("AVAudioSession error: \(error)")
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        private var bgTask: UIBackgroundTaskIdentifier = .invalid

        func registerLifecycleObservers() {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleDidEnterBackground),
                name: UIApplication.didEnterBackgroundNotification,
                object: nil
            )
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleWillEnterForeground),
                name: UIApplication.willEnterForegroundNotification,
                object: nil
            )
        }

        @objc private func handleDidEnterBackground() {
            do {
                try AVAudioSession.sharedInstance().setActive(true)
            } catch {}

            if bgTask == .invalid {
                bgTask = UIApplication.shared.beginBackgroundTask(withName: "FocusBooksAudioKeepAlive") { [weak self] in
                    if let task = self?.bgTask, task != .invalid {
                        UIApplication.shared.endBackgroundTask(task)
                        self?.bgTask = .invalid
                    }
                }
            }

            // Ensure any paused YouTube iframe resumes immediately after iOS background transition
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.webView?.evaluateJavaScript("""
                (function() {
                  try {
                    const btn = document.getElementById('icon-pause');
                    const isPlaying = btn && !btn.classList.contains('hidden');
                    if (isPlaying && window.YT) {
                      const iframes = document.querySelectorAll('iframe');
                      iframes.forEach(function(f) {
                        if (f.contentWindow) {
                          f.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
                        }
                      });
                    }
                  } catch (e) {}
                })();
                """, completionHandler: nil)
            }
        }

        @objc private func handleWillEnterForeground() {
            if bgTask != .invalid {
                UIApplication.shared.endBackgroundTask(bgTask)
                bgTask = .invalid
            }
            UIApplication.shared.isIdleTimerDisabled = true
            try? AVAudioSession.sharedInstance().setActive(true)
        }
    }
}

struct ContentView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            FocusBooksWebView()
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .preferredColorScheme(.dark)
    }
}
