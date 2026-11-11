import SwiftUI
import WebKit
import AVFoundation
import MediaPlayer
import UIKit

/// Native iOS WebView wrapper with continuous background & Lock Screen audio support.
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
        // 1. Replaces document.createElement('video') inside youtube.com/embed with a native <audio>
        //    element (HTMLAudioElement) with video property shims so iOS WebKit C++ treats YouTube's
        //    stream as pure <audio> (which iOS WebKit NEVER suspends in background or Lock Screen!)
        // 2. Spoofs visibilityState/hidden & focus so YouTube JS never pauses on background/lock
        // 3. Guards HTMLMediaElement.prototype.pause unless user explicitly clicked Pause
        let backgroundAudioUnlockJS = """
        (function() {
          try {
            Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
            Object.defineProperty(document, 'webkitHidden', { get: function() { return false; }, configurable: true });
            Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
            Object.defineProperty(document, 'webkitVisibilityState', { get: function() { return 'visible'; }, configurable: true });
            document.hasFocus = function() { return true; };

            const blockedEvents = {
              visibilitychange: true,
              webkitvisibilitychange: true,
              pagehide: true,
              freeze: true,
              blur: true
            };

            const origDocAdd = document.addEventListener.bind(document);
            document.addEventListener = function(type, listener, options) {
              if (blockedEvents[type]) return;
              return origDocAdd(type, listener, options);
            };

            const origWinAdd = window.addEventListener.bind(window);
            window.addEventListener = function(type, listener, options) {
              if (blockedEvents[type]) return;
              return origWinAdd(type, listener, options);
            };

            const isYT = (window.location.hostname.indexOf('youtube.com') !== -1 || window.location.hostname.indexOf('youtube-nocookie.com') !== -1);
            if (isYT) {
              // Convert YouTube's <video> element into a native WebKit <audio> element so iOS WebKit's
              // C++ HTMLMediaElement::isVideo() returns false and NEVER suspends playback on Lock Screen!
              const origCreateElement = document.createElement.bind(document);
              document.createElement = function(tagName, options) {
                if (typeof tagName === 'string' && tagName.toLowerCase() === 'video') {
                  const audioEl = origCreateElement('audio', options);
                  try {
                    Object.defineProperty(audioEl, 'videoWidth', { get: function() { return 640; }, configurable: true });
                    Object.defineProperty(audioEl, 'videoHeight', { get: function() { return 360; }, configurable: true });
                    audioEl.width = 640;
                    audioEl.height = 360;
                    audioEl.playsInline = true;
                    audioEl.webkitPlaysInline = true;
                    audioEl.getVideoPlaybackQuality = function() {
                      return {
                        creationTime: performance.now(),
                        totalVideoFrames: Math.floor(performance.now() / 33),
                        droppedVideoFrames: 0,
                        corruptedVideoFrames: 0
                      };
                    };
                    audioEl.webkitEnterFullscreen = function() {};
                    audioEl.webkitExitFullscreen = function() {};
                  } catch (_) {}
                  return audioEl;
                }
                return origCreateElement(tagName, options);
              };

              window.__fbUserPlaying = false;

              origWinAdd('message', function(ev) {
                try {
                  if (typeof ev.data === 'string') {
                    if (ev.data.indexOf('playVideo') !== -1) {
                      window.__fbUserPlaying = true;
                    } else if (ev.data.indexOf('pauseVideo') !== -1 || ev.data.indexOf('stopVideo') !== -1) {
                      window.__fbUserPlaying = false;
                    }
                  }
                } catch (_) {}
              }, true);

              const origPause = HTMLMediaElement.prototype.pause;
              HTMLMediaElement.prototype.pause = function() {
                if (!window.__fbUserPlaying || this.ended) {
                  return origPause.apply(this, arguments);
                }
                return;
              };

              origDocAdd('pause', function(e) {
                const media = e.target;
                if (media && media instanceof HTMLMediaElement && !media.ended) {
                  if (window.__fbUserPlaying) {
                    setTimeout(function() {
                      try { media.play(); } catch (_) {}
                    }, 20);
                  }
                }
              }, true);
            }
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

        NotificationCenter.default.removeObserver(webView, name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.removeObserver(webView, name: UIApplication.willResignActiveNotification, object: nil)

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
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .allowAirPlay, .allowBluetooth, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            print("AVAudioSession error: \(error)")
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var webView: WKWebView?
        private var bgTask: UIBackgroundTaskIdentifier = .invalid
        private var keepAlivePlayer: AVAudioPlayer?

        func registerLifecycleObservers() {
            setupSilentKeepAliveAudio()

            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleWillResignActive),
                name: UIApplication.willResignActiveNotification,
                object: nil
            )
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

        private func setupSilentKeepAliveAudio() {
            let sampleRate: Int = 8000
            let numSamples = sampleRate
            var wav = Data()

            let dataSize = numSamples * 2
            let fileSize = 36 + dataSize

            wav.append("RIFF".data(using: .ascii)!)
            wav.append(withUnsafeBytes(of: UInt32(fileSize).littleEndian) { Data($0) })
            wav.append("WAVEfmt ".data(using: .ascii)!)
            wav.append(withUnsafeBytes(of: UInt32(16).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt16(1).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt32(sampleRate * 2).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt16(2).littleEndian) { Data($0) })
            wav.append(withUnsafeBytes(of: UInt16(16).littleEndian) { Data($0) })
            wav.append("data".data(using: .ascii)!)
            wav.append(withUnsafeBytes(of: UInt32(dataSize).littleEndian) { Data($0) })
            wav.append(Data(count: dataSize))

            do {
                let player = try AVAudioPlayer(data: wav, fileTypeHint: AVFileType.wav.rawValue)
                player.numberOfLoops = -1
                player.volume = 0.01
                player.prepareToPlay()
                self.keepAlivePlayer = player
            } catch {
                print("Silent keep-alive audio init error: \(error)")
            }
        }

        @objc private func handleWillResignActive() {
            guard let webView = webView else { return }
            NotificationCenter.default.removeObserver(webView, name: UIApplication.didEnterBackgroundNotification, object: nil)
            NotificationCenter.default.removeObserver(webView, name: UIApplication.willResignActiveNotification, object: nil)
            try? AVAudioSession.sharedInstance().setActive(true)
            keepAlivePlayer?.play()
        }

        @objc private func handleDidEnterBackground() {
            guard let webView = webView else { return }
            NotificationCenter.default.removeObserver(webView, name: UIApplication.didEnterBackgroundNotification, object: nil)
            NotificationCenter.default.removeObserver(webView, name: UIApplication.willResignActiveNotification, object: nil)

            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .allowAirPlay, .allowBluetooth, .allowBluetoothA2DP])
                try session.setActive(true)
            } catch {}

            keepAlivePlayer?.play()

            if bgTask == .invalid {
                bgTask = UIApplication.shared.beginBackgroundTask(withName: "FocusBooksAudioKeepAlive") { [weak self] in
                    if let task = self?.bgTask, task != .invalid {
                        UIApplication.shared.endBackgroundTask(task)
                        self?.bgTask = .invalid
                    }
                }
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
