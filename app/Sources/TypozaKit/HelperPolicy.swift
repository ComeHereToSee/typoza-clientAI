/// 网页经外壳能调用的辅助进程方法(白名单)。session.* 与 ai.secrets 带密钥,只在外壳与辅助进程之间流转。
public enum HelperPolicy {
    public static func webCallable(_ method: String) -> Bool {
        if method.hasPrefix("sync.") { return true }
        return method.hasPrefix("ai.") && method != "ai.secrets"
    }
}
