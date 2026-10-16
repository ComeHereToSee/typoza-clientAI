import AppKit

/// MCP 征询(elicitation)的原生表单:服务器请用户补充信息时弹出。
/// 规范里要求的结构是一层对象,属性只有字符串(可带枚举)、数字、布尔;按属性逐行生成输入控件。
/// 返回 {action: accept | decline | cancel, content?}(docs/tech/ai-architecture.md 3.5 节)。
enum ElicitationForm {
    static func run(_ params: [String: Any]) -> [String: Any] {
        let schema = params["schema"] as? [String: Any] ?? [:]
        let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
        let required = Set(schema["required"] as? [String] ?? [])
        let server = params["serverName"] as? String ?? params["serverId"] as? String ?? "MCP 服务器"

        let alert = NSAlert()
        alert.messageText = "「\(server)」需要你补充信息"
        alert.informativeText = params["message"] as? String ?? ""
        alert.addButton(withTitle: "提交")
        alert.addButton(withTitle: "拒绝")
        alert.addButton(withTitle: "取消")

        var readers: [(String, () -> Any?)] = []
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        for name in properties.keys.sorted() {
            let prop = properties[name] ?? [:]
            let title = (prop["title"] as? String ?? name) + (required.contains(name) ? " *" : "")
            stack.addArrangedSubview(NSTextField(labelWithString: title))
            if let options = prop["enum"] as? [String] {
                let popup = NSPopUpButton()
                popup.addItems(withTitles: options)
                stack.addArrangedSubview(popup)
                readers.append((name, { popup.titleOfSelectedItem }))
            } else if prop["type"] as? String == "boolean" {
                let box = NSButton(checkboxWithTitle: prop["description"] as? String ?? "", target: nil, action: nil)
                box.state = (prop["default"] as? Bool ?? false) ? .on : .off
                stack.addArrangedSubview(box)
                readers.append((name, { box.state == .on }))
            } else {
                let field = NSTextField(string: (prop["default"]).map { "\($0)" } ?? "")
                field.placeholderString = prop["description"] as? String
                field.frame.size.width = 320
                stack.addArrangedSubview(field)
                let type = prop["type"] as? String
                readers.append((name, {
                    let text = field.stringValue
                    if text.isEmpty { return nil }
                    if type == "number" { return Double(text) }
                    if type == "integer" { return Int(text) }
                    return text
                }))
            }
        }
        stack.frame = NSRect(x: 0, y: 0, width: 340, height: stack.fittingSize.height)
        if !readers.isEmpty { alert.accessoryView = stack }

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            var content: [String: Any] = [:]
            for (name, read) in readers {
                if let value = read() { content[name] = value }
            }
            return ["action": "accept", "content": content]
        case .alertSecondButtonReturn:
            return ["action": "decline"]
        default:
            return ["action": "cancel"]
        }
    }
}
