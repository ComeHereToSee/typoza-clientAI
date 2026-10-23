import CoreServices
import Foundation

/// 用 FSEvents 监听若干路径(文件或文件夹),变化以去重后的路径列表回调到主线程。
/// 用路径级监听而不是 inode 级:原子保存会替换文件,inode 监听在替换后就失效了。
public final class FileWatcher {
    private var stream: FSEventStreamRef?
    private var paths: Set<String> = []
    /// 真实路径(解析符号链接,含 /var → /private/var)→ 监听时给的路径:FSEvents 报的是真实路径,网页按打开时的路径认
    private var aliases: [String: String] = [:]
    private let callback: ([String]) -> Void

    public init(callback: @escaping ([String]) -> Void) {
        self.callback = callback
    }

    deinit {
        stop()
    }

    public func watch(_ newPaths: [String]) {
        let merged = paths.union(newPaths)
        guard merged != paths else { return }
        paths = merged
        aliases = Self.aliases(for: merged)
        restart()
    }

    static func aliases(for paths: Set<String>) -> [String: String] {
        var map: [String: String] = [:]
        for path in paths {
            if let real = realPath(path), real != path { map[real] = path }
        }
        return map
    }

    /// 事件路径里补上对应的、监听时给的路径
    static func reported(_ events: [String], aliases: [String: String]) -> [String] {
        Array(Set(events + events.compactMap { aliases[$0] }))
    }

    static func realPath(_ path: String) -> String? {
        guard let resolved = realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private func stop() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
    }

    private func restart() {
        stop()
        // 监听文件所在的文件夹:文件本身被原子替换时也能收到事件;按真实路径找文件夹(文件本身是符号链接时,改动发生在目标所在的文件夹)
        let roots = Array(Set(paths.map { original -> String in
            let path = Self.realPath(original) ?? original
            var isDir: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue ? path : (path as NSString).deletingLastPathComponent
        }))
        var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let flags = UInt32(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagNoDefer)
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            { _, info, count, eventPaths, _, _ in
                guard let info else { return }
                let watcher = Unmanaged<FileWatcher>.fromOpaque(info).takeUnretainedValue()
                let array = Unmanaged<CFArray>.fromOpaque(eventPaths).takeUnretainedValue() as? [String] ?? []
                watcher.callback(FileWatcher.reported(Array(array.prefix(count)), aliases: watcher.aliases))
            },
            &context,
            roots as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.3,
            flags
        ) else { return }
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
        FSEventStreamStart(stream)
        self.stream = stream
    }
}
