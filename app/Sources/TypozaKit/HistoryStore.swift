import CryptoKit
import Foundation

/// 本地历史版本(Typora「浏览所有版本」,PRD 3.14):每次保存留快照,同一文件 5 分钟内的保存合并成一个版本;
/// 每个文件最多 50 个、最长 90 天(与云端历史口径一致)。覆盖写之前若磁盘内容还没有快照,先给它留一份。
/// 「恢复此版本」前记下的当前内容是钉住的快照(旁边一个 .pin 标记),不参与 5 分钟合并。
/// 在 Typoza 里改名或移动后历史跟着走(move);文件不在原位置了,历史保留到期满,可在「已删除的文件」里找回(deletedFiles)。
public final class HistoryStore {
    public static let coalesceSeconds: TimeInterval = 5 * 60
    public static let maxEntries = 50
    public static let maxAge: TimeInterval = 90 * 24 * 3600

    private let root: URL
    private let now: () -> Date

    public init(root: URL = AppPaths.historyDir, now: @escaping () -> Date = Date.init) {
        self.root = root
        self.now = now
    }

    private func folder(for path: String) -> URL {
        let digest = SHA256.hash(data: Data(path.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(String(digest.prefix(32)), isDirectory: true)
    }

    private func entries(in dir: URL) -> [URL] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        // 文件名是毫秒时间戳,按数字排序即时间顺序
        return names.filter { $0.hasSuffix(".md") }.sorted { (Int64($0.dropLast(3)) ?? 0) < (Int64($1.dropLast(3)) ?? 0) }.map { dir.appendingPathComponent($0) }
    }

    private func pinMark(_ entry: URL) -> URL {
        entry.deletingPathExtension().appendingPathExtension("pin")
    }

    private func isPinned(_ entry: URL) -> Bool {
        FileManager.default.fileExists(atPath: pinMark(entry).path)
    }

    /// 保存前调用:磁盘上的旧内容若与最新快照不同,先存一份(防止「打开 → 改坏 → 自动保存」后找不回原文)。
    /// 这份是别处改过的内容(或第一次保存前的原文),钉住:紧接着的写后快照合并时不能把它删掉。
    public func snapshotBeforeWrite(path: String) throws {
        guard let old = FileManager.default.contents(atPath: path) else { return }
        let dir = folder(for: path)
        if let last = entries(in: dir).last, FileManager.default.contents(atPath: last.path) == old { return }
        let entry = try write(old, dir: dir, path: path, coalesce: false)
        try Data().write(to: pinMark(entry), options: .atomic)
    }

    /// 保存后调用:记录新内容。
    public func snapshotAfterWrite(path: String, data: Data) throws {
        _ = try write(data, dir: folder(for: path), path: path, coalesce: true)
    }

    /// 钉住一份快照(恢复旧版本前先把当前内容记下来,PRD 3.14):不会被之后的自动保存合并掉。
    public func pin(path: String, data: Data) throws {
        let dir = folder(for: path)
        let entry: URL
        if let last = entries(in: dir).last, FileManager.default.contents(atPath: last.path) == data {
            entry = last
        } else {
            entry = try write(data, dir: dir, path: path, coalesce: false)
        }
        try Data().write(to: pinMark(entry), options: .atomic)
    }

    private func write(_ data: Data, dir: URL, path: String, coalesce: Bool) throws -> URL {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(path.utf8).write(to: dir.appendingPathComponent("path.txt"), options: .atomic)
        let list = entries(in: dir)
        if let last = list.last, FileManager.default.contents(atPath: last.path) == data { return last }
        let stamp = Int64(now().timeIntervalSince1970 * 1000)
        if coalesce, let last = list.last, let t = Int64(last.deletingPathExtension().lastPathComponent),
           now().timeIntervalSince1970 - Double(t) / 1000 < Self.coalesceSeconds, list.count > 1, !isPinned(last)
        {
            try FileManager.default.removeItem(at: last)
        }
        // 同一毫秒内的两次快照(保存前留原文 + 保存后)不能同名覆盖
        var unique = stamp
        while FileManager.default.fileExists(atPath: dir.appendingPathComponent("\(unique).md").path) { unique += 1 }
        let entry = dir.appendingPathComponent("\(unique).md")
        try data.write(to: entry, options: .atomic)
        prune(dir)
        return entry
    }

    private func remove(_ entry: URL) {
        try? FileManager.default.removeItem(at: entry)
        try? FileManager.default.removeItem(at: pinMark(entry))
    }

    private func prune(_ dir: URL) {
        var list = entries(in: dir)
        let cutoff = now().timeIntervalSince1970 - Self.maxAge
        while list.count > 1, let first = list.first, let t = Int64(first.deletingPathExtension().lastPathComponent), Double(t) / 1000 < cutoff {
            remove(first)
            list.removeFirst()
        }
        while list.count > Self.maxEntries {
            remove(list.removeFirst())
        }
    }

    public func list(path: String) -> [[String: Any]] {
        entries(in: folder(for: path)).reversed().map { url in
            let id = url.deletingPathExtension().lastPathComponent
            let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.int64Value ?? 0
            return ["id": id, "time": Int64(id) ?? 0, "size": size, "source": "local"]
        }
    }

    public func read(path: String, id: String) throws -> String {
        guard id.allSatisfy(\.isNumber) else { throw BridgeError("版本号无效") }
        let url = folder(for: path).appendingPathComponent("\(id).md")
        guard let data = FileManager.default.contents(atPath: url.path) else { throw BridgeError("找不到这个版本") }
        return try TextEncoding.decode(data).text
    }

    /// 各文件历史所在的文件夹与它记录的原路径
    private func folders() -> [(dir: URL, path: String)] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        return names.compactMap { name -> (dir: URL, path: String)? in
            let dir = root.appendingPathComponent(name, isDirectory: true)
            guard let data = FileManager.default.contents(atPath: dir.appendingPathComponent("path.txt").path) else { return nil }
            return (dir, String(decoding: data, as: UTF8.self))
        }
    }

    /// 文件或文件夹在 Typoza 里改名 / 移动后调用:历史跟到新路径(文件夹则其下所有文件的历史都跟着走)。
    public func move(from: String, to: String) throws {
        for (dir, path) in folders() where path == from || path.hasPrefix(from + "/") {
            let newPath = to + String(path.dropFirst(from.count))
            let target = folder(for: newPath)
            if FileManager.default.fileExists(atPath: target.path) {
                // 新路径已有历史(比如之前在那里存在过同名文件):把版本并过去
                for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name != "path.txt" {
                    let dst = target.appendingPathComponent(name)
                    if !FileManager.default.fileExists(atPath: dst.path) { try FileManager.default.moveItem(at: dir.appendingPathComponent(name), to: dst) }
                }
                try FileManager.default.removeItem(at: dir)
            } else {
                try FileManager.default.moveItem(at: dir, to: target)
            }
            try Data(newPath.utf8).write(to: target.appendingPathComponent("path.txt"), options: .atomic)
            prune(target)
        }
    }

    /// 已删除的文件:有历史、原路径上已经没有文件。按最近版本时间倒序。
    public func deletedFiles() -> [[String: Any]] {
        var out: [(path: String, time: Int64, count: Int)] = []
        for (dir, path) in folders() where !FileManager.default.fileExists(atPath: path) {
            let list = entries(in: dir)
            guard let last = list.last else { continue }
            out.append((path, Int64(last.deletingPathExtension().lastPathComponent) ?? 0, list.count))
        }
        return out.sorted { $0.time > $1.time }.map { ["path": $0.path, "time": $0.time, "count": $0.count] }
    }
}
