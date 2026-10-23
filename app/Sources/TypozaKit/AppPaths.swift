import Foundation

/// 应用数据目录:~/Library/Application Support/<应用名>/
/// 应用名、标识取自应用包的 Info.plist:派生版本(如 AI 版「Typoza AI」/ app.typoza.ai)与基础版同机并装时数据、日志、钥匙串各用各的。
/// 没有应用包时(单元测试、swift run)按基础版。
public enum AppPaths {
    public static var name: String { bundleValue("CFBundleName") ?? "Typoza" }
    public static var bundleID: String { bundleValue("CFBundleIdentifier") ?? "app.typoza.mac" }

    public static var support: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent(name, isDirectory: true)
    }

    public static var settingsFile: URL { support.appendingPathComponent("settings.json") }
    public static var historyDir: URL { support.appendingPathComponent("history", isDirectory: true) }
    /// 同步辅助进程的配置与各库状态(不含密钥,密钥在钥匙串)
    public static var syncDir: URL { support.appendingPathComponent("sync", isDirectory: true) }
    /// ~/Library/Logs/<应用名>/
    public static var logsDir: URL {
        let base = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library")
        return base.appendingPathComponent("Logs", isDirectory: true).appendingPathComponent(name, isDirectory: true)
    }

    /// 同步会话密钥的钥匙串服务名
    public static var syncKeychainService: String { "\(bundleID).sync" }

    static func bundleValue(_ key: String, bundle: Bundle = .main) -> String? {
        guard bundle.bundleURL.pathExtension == "app", let value = bundle.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else { return nil }
        return value
    }
}
