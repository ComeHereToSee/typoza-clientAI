import Foundation
import WebKit

/// 自定义协议 `typoza://`:
/// - `typoza://app/<相对路径>` 读应用包内的编辑器产物(ES module 需要同源,file:// 下不可靠);
/// - `typoza://local/<绝对路径>` 读本机文件(文档里的图片、视频、音频、PDF),支持 Range 分段。
public final class TypozaSchemeHandler: NSObject, WKURLSchemeHandler {
    public static let scheme = "typoza"
    /// 单次分段响应上限。视频按段拉取,避免一次把大文件读进内存。
    static let maxChunk: Int64 = 4 * 1024 * 1024

    private let appRoot: URL
    private var stopped = Set<ObjectIdentifier>()
    private let queue = DispatchQueue(label: "typoza.scheme", qos: .userInitiated, attributes: .concurrent)

    /// 每个请求开始时回调(主线程),冒烟自检用它记启动时间点
    public var onRequest: ((URL) -> Void)?

    public init(appRoot: URL) {
        self.appRoot = appRoot.standardizedFileURL
    }

    public static func appURL(_ relativePath: String) -> URL {
        URL(string: "\(scheme)://app/\(relativePath)")!
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        onRequest?(url)
        let fileURL: URL
        switch url.host {
        case "app":
            let relative = String(url.path.drop(while: { $0 == "/" }))
            let candidate = appRoot.appendingPathComponent(relative.isEmpty ? "index.html" : relative).standardizedFileURL
            guard candidate.path.hasPrefix(appRoot.path + "/") else {
                respondStatus(urlSchemeTask, url: url, status: 403)
                return
            }
            fileURL = candidate
        case "local":
            fileURL = URL(fileURLWithPath: url.path)
        default:
            respondStatus(urlSchemeTask, url: url, status: 404)
            return
        }
        let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range")
        let taskID = ObjectIdentifier(urlSchemeTask)
        let isLocal = url.host == "local"
        queue.async { [weak self] in
            guard let self else { return }
            let result = Self.read(fileURL: fileURL, rangeHeader: rangeHeader, isLocal: isLocal)
            DispatchQueue.main.async {
                guard !self.stopped.contains(taskID) else {
                    self.stopped.remove(taskID)
                    return
                }
                switch result {
                case .success(let (status, headers, data)):
                    let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
                    urlSchemeTask.didReceive(response)
                    urlSchemeTask.didReceive(data)
                    urlSchemeTask.didFinish()
                case .failure(let error):
                    urlSchemeTask.didFailWithError(error)
                }
            }
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func respondStatus(_ task: WKURLSchemeTask, url: URL, status: Int) {
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!
        task.didReceive(response)
        task.didReceive(Data())
        task.didFinish()
    }

    /// 本机文件的安全响应头。typoza://local 下所有文件同源:文档里嵌入的本地网页(或伪装成别的类型的网页)
    /// 若带着这个源运行脚本,就能读走本机任意文件(PRD 3.5「嵌入内容隔离运行、读不到本地文件」)。
    /// 所以网页类文件一律放进沙箱(无 allow-same-origin,脚本跑在不透明源里),并禁止按内容猜类型。
    public static func localHeaders(mime: String) -> [String: String] {
        var headers = ["X-Content-Type-Options": "nosniff"]
        let type = mime.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
        if type.contains("html") || type.contains("xml") {
            headers["Content-Security-Policy"] = "sandbox allow-scripts allow-popups allow-forms allow-presentation"
        }
        return headers
    }

    static func read(fileURL: URL, rangeHeader: String?, isLocal: Bool = false) -> Result<(Int, [String: String], Data), Error> {
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: fileURL.path)
            let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
            let mime = MimeType.forExtension(fileURL.pathExtension)
            var headers = [
                "Content-Type": mime,
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            ]
            if isLocal { headers.merge(localHeaders(mime: mime)) { _, new in new } }
            switch ByteRange.parse(rangeHeader, size: size, maxChunk: maxChunk) {
            case .full:
                let data = try Data(contentsOf: fileURL, options: .mappedIfSafe)
                headers["Content-Length"] = String(data.count)
                return .success((200, headers, data))
            case .partial(let start, let end):
                let handle = try FileHandle(forReadingFrom: fileURL)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(start))
                let data = try handle.read(upToCount: Int(end - start + 1)) ?? Data()
                headers["Content-Length"] = String(data.count)
                headers["Content-Range"] = "bytes \(start)-\(start + Int64(data.count) - 1)/\(size)"
                return .success((206, headers, data))
            case .unsatisfiable:
                headers["Content-Range"] = "bytes */\(size)"
                headers["Content-Length"] = "0"
                return .success((416, headers, Data()))
            }
        } catch {
            return .failure(error)
        }
    }
}
