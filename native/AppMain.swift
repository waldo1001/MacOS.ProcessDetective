import Cocoa
import WebKit

// Resolve the app's Resources directory from the executable location.
func resourcesDir() -> String {
    let exe = Bundle.main.executablePath ?? CommandLine.arguments[0]
    let macos = (exe as NSString).deletingLastPathComponent      // …/Contents/MacOS
    let contents = (macos as NSString).deletingLastPathComponent // …/Contents
    return contents + "/Resources"
}

// Prefer the Node runtime bundled next to this executable (Contents/MacOS/node).
// Fallbacks (build-time node-path file, common install locations) only matter
// for hand-assembled bundles without one.
func nodePath(_ res: String) -> String {
    let bundled = (res as NSString).deletingLastPathComponent + "/MacOS/node"
    if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
    if let s = try? String(contentsOfFile: res + "/node-path", encoding: .utf8) {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
    }
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if FileManager.default.isExecutableFile(atPath: c) { return c }
    }
    return "node"
}

// Ask the kernel for a free localhost port.
func freePort() -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return 7878 }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    addr.sin_port = 0
    let bound = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    if bound != 0 { close(fd); return 7878 }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
    }
    let port = Int(UInt16(bigEndian: addr.sin_port))
    close(fd)
    return port == 0 ? 7878 : port
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    let res = resourcesDir()

    func applicationDidFinishLaunching(_ note: Notification) {
        let port = freePort()
        startServer(port)

        let rect = NSRect(x: 0, y: 0, width: 1220, height: 820)
        window = NSWindow(contentRect: rect,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Process Detective"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()

        web = WKWebView(frame: rect, configuration: WKWebViewConfiguration())
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        if let url = URL(string: "http://127.0.0.1:\(port)/") {
            waitAndLoad(url, tries: 80)
        }
    }

    func startServer(_ port: Int) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodePath(res))
        p.arguments = [res + "/app/dist/index.js", "serve", "--no-open", "--port", "\(port)"]
        p.currentDirectoryURL = URL(fileURLWithPath: res + "/app")
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = (env["PATH"] ?? "") + ":/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
        p.environment = env
        do { try p.run(); server = p } catch { NSLog("Process Detective: server failed to start — \(error)") }
    }

    // Poll until the server answers, then load it (avoids a flash of connection error).
    func waitAndLoad(_ url: URL, tries: Int) {
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            DispatchQueue.main.async {
                if (resp as? HTTPURLResponse)?.statusCode == 200 {
                    self.web.load(URLRequest(url: url))
                } else if tries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { self.waitAndLoad(url, tries: tries - 1) }
                } else {
                    self.web.load(URLRequest(url: url))
                }
            }
        }.resume()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ note: Notification) { server?.terminate() }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
