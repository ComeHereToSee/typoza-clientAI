import Foundation
import Security

/// 钥匙串错误:附带系统给出的说明。
public struct KeychainError: Error, LocalizedError, Equatable {
    public let status: OSStatus

    public init(_ status: OSStatus) {
        self.status = status
    }

    public var errorDescription: String? {
        let detail = (SecCopyErrorMessageString(status, nil) as String?) ?? "未知错误"
        return "钥匙串操作失败(\(status)):\(detail)"
    }
}

/// 登录钥匙串里的一条通用密码。云同步的会话密钥(刷新令牌、账户密钥)与 AI 密钥只存这里,不写任何文件。
public struct KeychainItem {
    public let service: String
    public let account: String
    /// 钥匙串访问里显示的名称
    public let label: String

    public init(service: String, account: String, label: String = "Typoza 云同步") {
        self.service = service
        self.account = account
        self.label = label
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    /// 读取;条目不存在返回 nil。
    public func read() throws -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        switch status {
        case errSecSuccess: return out as? Data
        case errSecItemNotFound: return nil
        default: throw KeychainError(status)
        }
    }

    /// 写入(已存在则覆盖)。
    public func write(_ data: Data) throws {
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrLabel as String] = label
            // 只在本机、开机解锁后可读;不随 iCloud 钥匙串同步到其它设备
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(add as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status) }
    }

    /// 删除;条目不存在不算错。
    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status) }
    }
}
