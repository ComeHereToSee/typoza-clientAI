import Foundation

/// 检查更新(对照表 A-04):更新源是一个 JSON 文件,地址写在 Info.plist 的 TypozaUpdateFeedURL。
/// 格式【假设:更新服务未定,先按最小字段定】:{"version": "1.2.0", "url": "https://…/Typoza.dmg", "notes": "更新说明"}。
public enum UpdateCheck {
    public struct Release: Equatable {
        public let version: String
        public let url: URL
        public let notes: String
    }

    /// 版本号逐段按数字比较(1.10.0 比 1.9.3 新);开头的 v 忽略,缺的段按 0。
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        let a = parts(candidate)
        let b = parts(current)
        for i in 0 ..< max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    static func parts(_ version: String) -> [Int] {
        let trimmed = version.trimmingCharacters(in: .whitespaces)
        let body = trimmed.hasPrefix("v") || trimmed.hasPrefix("V") ? String(trimmed.dropFirst()) : trimmed
        return body.split(separator: ".").map { part in Int(String(part.prefix(while: { $0.isASCII && $0.isNumber }))) ?? 0 }
    }

    /// 一次检查的结果与要给用户看的提示;界面只管弹窗,判断都在这里(便于测试,对照表 A-04)
    public enum Outcome: Equatable {
        /// Info.plist 里没配更新源
        case unconfigured(current: String)
        case failed(String)
        case upToDate(current: String)
        case newer(Release, current: String)

        public var title: String {
            switch self {
            case .unconfigured: return "无法检查更新"
            case .failed: return "检查更新失败"
            case .upToDate: return "当前已是最新!"
            case let .newer(release, _): return "发现新版本 \(release.version)"
            }
        }

        public var message: String {
            switch self {
            case let .unconfigured(current): return "这个版本还没有接入更新服务,暂时不能在线检查。当前版本 \(current)。"
            case let .failed(reason): return reason
            case let .upToDate(current): return "当前版本 \(current)。"
            case let .newer(release, current): return release.notes.isEmpty ? "当前版本 \(current)。" : release.notes
            }
        }

        /// 第一个按钮是默认按钮;有新版本时点【下载】打开下载地址
        public var buttons: [String] {
            if case .newer = self { return ["下载", "以后再说"] }
            return ["好"]
        }
    }

    /// 取更新源:回调给数据、HTTP 状态码与错误
    public typealias Fetch = (URL, @escaping (Data?, Int, Error?) -> Void) -> Void

    public static func check(current: String, feed: URL?, fetch: Fetch, completion: @escaping (Outcome) -> Void) {
        guard let feed else { return completion(.unconfigured(current: current)) }
        fetch(feed) { data, status, error in
            if let error { return completion(.failed(error.localizedDescription)) }
            guard let data, status == 200 else { return completion(.failed("更新服务返回异常(HTTP \(status))")) }
            do {
                let release = try parse(data)
                completion(isNewer(release.version, than: current) ? .newer(release, current: current) : .upToDate(current: current))
            } catch {
                completion(.failed(error.localizedDescription))
            }
        }
    }

    public static func parse(_ data: Data) throws -> Release {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw BridgeError("更新信息不是有效的 JSON")
        }
        guard let version = obj["version"] as? String, !version.isEmpty else { throw BridgeError("更新信息缺少版本号") }
        guard let link = obj["url"] as? String, let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            throw BridgeError("更新信息里的下载地址无效")
        }
        return Release(version: version, url: url, notes: obj["notes"] as? String ?? "")
    }
}
