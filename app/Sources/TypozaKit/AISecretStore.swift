import Foundation
import Security

/// AI 密钥:服务商密钥、MCP 环境变量与请求头、MCP OAuth 令牌,按引用名各存一条钥匙串条目(服务 app.typoza.mac.ai)。
/// 网页只能写不能读;外壳读出全部后经管道交给辅助进程(docs/tech/ai-architecture.md 2、3.5 节)。
public struct AISecretStore {
    public static let service = "app.typoza.mac.ai"

    public init() {}

    /// 引用名只允许契约里的三种前缀,防止网页借此改写别的钥匙串条目。
    public static func isValidRef(_ ref: String) -> Bool {
        guard ref.count <= 200, ref.allSatisfy({ !$0.isNewline && $0 != "\0" }) else { return false }
        for prefix in ["provider:", "mcp:", "mcp-oauth:"] where ref.hasPrefix(prefix) {
            return ref.count > prefix.count
        }
        return false
    }

    /// 写入;value 为空串表示删除。
    public func set(_ ref: String, value: String) throws {
        guard Self.isValidRef(ref) else { throw BridgeError("密钥引用名不合法:\(ref)") }
        let item = KeychainItem(service: Self.service, account: ref, label: "Typoza AI")
        if value.isEmpty {
            try item.delete()
        } else {
            try item.write(Data(value.utf8))
        }
    }

    /// 全部引用名与密钥。先列出条目再逐条读值:老式钥匙串不支持一次取回多条的值。
    public func all() throws -> [String: String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [:] }
        guard status == errSecSuccess else { throw KeychainError(status) }
        var secrets: [String: String] = [:]
        for attrs in (out as? [[String: Any]]) ?? [] {
            guard let ref = attrs[kSecAttrAccount as String] as? String, Self.isValidRef(ref) else { continue }
            if let data = try KeychainItem(service: Self.service, account: ref).read(), let value = String(data: data, encoding: .utf8) {
                secrets[ref] = value
            }
        }
        return secrets
    }
}
