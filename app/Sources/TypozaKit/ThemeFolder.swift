import Foundation

/// 主题(PRD 3.11、对照表 T-01 ~ T-05):内置 6 款 + 主题文件夹里的自定义主题。主题菜单每次打开时重新列出,放进去的 css 无需重启即出现。
public enum ThemeFolder {
    /// ~/Library/Application Support/<应用名>/themes
    public static var directory: URL { AppPaths.support.appendingPathComponent("themes", isDirectory: true) }

    /// 内置主题(ID 与网页 settings.ts 的 BUILTIN_THEMES 一致)
    public static let builtin: [(id: String, label: String)] = [
        ("github", "Github"),
        ("gothic", "Gothic"),
        ("newsprint", "Newsprint"),
        ("night", "Night"),
        ("pixyll", "Pixyll"),
        ("whitey", "Whitey"),
    ]

    /// 文件夹里的自定义主题名(去掉 .css),不含 base.user.css、主题名.user.css 这类追加样式,也不含与内置主题同名的;文件夹不存在时为空
    public static func customThemes(in dir: URL) -> [String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return [] }
        let builtinIDs = Set(builtin.map(\.id))
        return names
            .filter { $0.lowercased().hasSuffix(".css") && !$0.lowercased().hasSuffix(".user.css") && !$0.hasPrefix(".") }
            .map { String($0.dropLast(4)) }
            .filter { !builtinIDs.contains($0) }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }
}
