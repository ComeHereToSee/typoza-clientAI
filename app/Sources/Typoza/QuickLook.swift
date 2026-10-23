import Foundation
import TypozaKit

/// 快速查看(对照表 S-14):调用系统自带的 qlmanage 弹出 Quick Look 预览窗口。
/// 不接 QLPreviewPanel:那要把窗口控制器挂进响应链并实现数据源,文件树里点一下预览用不着。预览窗口在 Typoza 窗口前面(冒烟 quickLookFront 核对)。
enum QuickLookPreview {
    /// 返回 qlmanage 进程(冒烟核对预览窗口前置后关掉它)
    @discardableResult
    static func show(_ path: String) throws -> Process {
        guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("目标文件或文件夹不存在。") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
        process.arguments = ["-p", path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw BridgeError("无法快速查看:\(error.localizedDescription)")
        }
        return process
    }
}
