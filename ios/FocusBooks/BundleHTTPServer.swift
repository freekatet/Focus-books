import Foundation
import Network

/// Embedded localhost HTTP server that serves the bundled FocusBooks `public/` directory
/// directly from inside the native iOS app bundle on `http://127.0.0.1:18456`.
/// This allows YouTube's IFrame Player API (`youtube.com/embed`) to see a valid HTTP origin
/// and allows 100% offline/standalone operation on iPhone without needing a Mac.
final class BundleHTTPServer {
    static let shared = BundleHTTPServer()

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.focusbooks.localserver", qos: .userInitiated)
    private(set) var port: UInt16 = 18456
    private let webRootURL: URL
    private let documentsLibraryURL: URL

    private init() {
        if let bundlePublic = Bundle.main.resourceURL?.appendingPathComponent("public"),
           FileManager.default.fileExists(atPath: bundlePublic.path) {
            self.webRootURL = bundlePublic
        } else {
            self.webRootURL = Bundle.main.resourceURL ?? URL(fileURLWithPath: "/")
        }

        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.documentsLibraryURL = docs.appendingPathComponent("library.json")

        // Seed writable Documents/library.json from bundled public/books/library.json on first launch
        if !FileManager.default.fileExists(atPath: documentsLibraryURL.path) {
            let bundledLib = webRootURL.appendingPathComponent("books/library.json")
            if FileManager.default.fileExists(atPath: bundledLib.path) {
                try? FileManager.default.copyItem(at: bundledLib, to: documentsLibraryURL)
            }
        }
    }

    func start() {
        guard listener == nil else { return }
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let nwPort = NWEndpoint.Port(rawValue: port) ?? .any
            let nwListener = try NWListener(using: params, on: nwPort)

            nwListener.stateUpdateHandler = { [weak self] state in
                if case .ready = state, let actualPort = nwListener.port?.rawValue {
                    self?.port = actualPort
                }
            }

            nwListener.newConnectionHandler = { [weak self] connection in
                self?.handleConnection(connection)
            }

            nwListener.start(queue: queue)
            self.listener = nwListener
        } catch {
            print("Failed to start BundleHTTPServer: \(error)")
        }
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveRequest(on: connection, accumulated: Data())
    }

    private func receiveRequest(on connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }
            var buffer = accumulated
            if let data = data {
                buffer.append(data)
            }
            if let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headerData = buffer.subdata(in: 0..<headerEnd.lowerBound)
                let headerString = String(data: headerData, encoding: .utf8) ?? ""
                let contentLength = self.parseContentLength(from: headerString)
                let bodyStart = headerEnd.upperBound
                let currentBodyLength = buffer.count - bodyStart

                if currentBodyLength < contentLength && !isComplete && error == nil {
                    self.receiveRequest(on: connection, accumulated: buffer)
                    return
                }
                let bodyData = buffer.subdata(in: bodyStart..<min(buffer.count, bodyStart + contentLength))
                self.respond(to: headerString, body: bodyData, on: connection)
            } else if !isComplete && error == nil {
                self.receiveRequest(on: connection, accumulated: buffer)
            } else {
                connection.cancel()
            }
        }
    }

    private func parseContentLength(from headers: String) -> Int {
        for line in headers.components(separatedBy: "\r\n") {
            let lower = line.lowercased()
            if lower.hasPrefix("content-length:") {
                let val = line.dropFirst("content-length:".count).trimmingCharacters(in: .whitespaces)
                return Int(val) ?? 0
            }
        }
        return 0
    }

    private func respond(to headerString: String, body: Data, on connection: NWConnection) {
        let lines = headerString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else {
            connection.cancel()
            return
        }
        let parts = requestLine.components(separatedBy: " ")
        guard parts.count >= 2 else {
            connection.cancel()
            return
        }
        let method = parts[0].uppercased()
        let rawTarget = parts[1]
        let pathOnly = rawTarget.components(separatedBy: "?").first ?? "/"
        let decodedPath = pathOnly.removingPercentEncoding ?? pathOnly

        if method == "OPTIONS" {
            sendResponse(status: "204 No Content", contentType: "text/plain", body: Data(), on: connection)
            return
        }

        // Native iPhone persistent Library API
        if decodedPath == "/api/library" && method == "GET" {
            if let data = try? Data(contentsOf: documentsLibraryURL) {
                sendResponse(status: "200 OK", contentType: "application/json; charset=utf-8", body: data, on: connection)
                return
            }
            let fallbackURL = webRootURL.appendingPathComponent("books/library.json")
            let data = (try? Data(contentsOf: fallbackURL)) ?? Data("{\"books\":[]}".utf8)
            sendResponse(status: "200 OK", contentType: "application/json; charset=utf-8", body: data, on: connection)
            return
        }

        if decodedPath == "/api/library/progress" && method == "POST" {
            updateLibraryProgress(with: body)
            let ok = Data("{\"ok\":true}".utf8)
            sendResponse(status: "200 OK", contentType: "application/json; charset=utf-8", body: ok, on: connection)
            return
        }

        var relPath = decodedPath == "/" ? "/index.html" : decodedPath
        while relPath.hasPrefix("/") {
            relPath.removeFirst()
        }

        let fileURL = webRootURL.appendingPathComponent(relPath)
        guard FileManager.default.fileExists(atPath: fileURL.path),
              let fileData = try? Data(contentsOf: fileURL) else {
            let notFound = Data("Not Found".utf8)
            sendResponse(status: "404 Not Found", contentType: "text/plain; charset=utf-8", body: notFound, on: connection)
            return
        }

        let mime = mimeType(for: fileURL.pathExtension.lowercased())
        sendResponse(status: "200 OK", contentType: mime, body: fileData, on: connection)
    }

    private func updateLibraryProgress(with body: Data) {
        guard let payload = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let libData = try? Data(contentsOf: documentsLibraryURL),
              var lib = try? JSONSerialization.jsonObject(with: libData) as? [String: Any] else {
            return
        }
        if let bookId = payload["bookId"] as? String {
            lib["lastActiveBookId"] = bookId
            if let progress = payload["progress"] as? [String: Any],
               var books = lib["books"] as? [[String: Any]] {
                for i in 0..<books.count {
                    if (books[i]["id"] as? String) == bookId {
                        var existing = (books[i]["progress"] as? [String: Any]) ?? [:]
                        for (k, v) in progress {
                            existing[k] = v
                        }
                        books[i]["progress"] = existing
                    }
                }
                lib["books"] = books
            }
        }
        if let updated = try? JSONSerialization.data(withJSONObject: lib, options: [.prettyPrinted]) {
            try? updated.write(to: documentsLibraryURL)
        }
    }

    private func sendResponse(status: String, contentType: String, body: Data, on connection: NWConnection) {
        var header = "HTTP/1.1 \(status)\r\n"
        header += "Content-Type: \(contentType)\r\n"
        header += "Content-Length: \(body.count)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
        header += "Cache-Control: no-cache\r\n"
        header += "Connection: close\r\n\r\n"

        var payload = Data(header.utf8)
        payload.append(body)

        connection.send(content: payload, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func mimeType(for ext: String) -> String {
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "application/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        case "m4a", "mp4": return "audio/mp4"
        default: return "application/octet-stream"
        }
    }
}
