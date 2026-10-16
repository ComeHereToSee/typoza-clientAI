import Foundation

/// 菜单项键位的显示文字(⌃⌥⇧⌘ + 键名)。冒烟时导出整张菜单的键位,CI 与 docs/prd/notion-input.md 第五节核对。
public enum MenuKeyLabel {
    public static func text(key: String, control: Bool, option: Bool, shift: Bool, command: Bool) -> String {
        var s = ""
        if control { s += "⌃" }
        if option { s += "⌥" }
        if shift { s += "⇧" }
        if command { s += "⌘" }
        return s + keyName(key)
    }

    static func keyName(_ key: String) -> String {
        guard key.unicodeScalars.count == 1, let scalar = key.unicodeScalars.first else { return key }
        switch scalar.value {
        case 0xF700: return "↑"
        case 0xF701: return "↓"
        case 0xF702: return "←"
        case 0xF703: return "→"
        case 0xF704 ... 0xF717: return "F\(scalar.value - 0xF704 + 1)"
        case 0xF728: return "⌦"
        case 0x0D, 0x03: return "↩"
        case 0x08, 0x7F: return "⌫"
        case 0x1B: return "Esc"
        case 0x20: return "空格"
        default: return key.uppercased()
        }
    }
}
