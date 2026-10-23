import XCTest
@testable import TypozaKit

/// 文件与窗口、历史版本、搜索、草稿、检查更新(gaps 第 2、6、10、32、33、47、55 项)
final class FilesTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("typoza-files-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func path(_ name: String) -> String {
        dir.appendingPathComponent(name).path
    }

    private func write(_ name: String, _ text: String) throws {
        _ = try FileService.writeText(path(name), text: text, encoding: nil)
    }

    // ---------- 草稿 ----------

    func testDraftsSaveListReadRemove() throws {
        let store = DraftStore(directory: dir.appendingPathComponent("drafts"))
        try store.save(id: "m1a-b2", text: "第二个")
        try store.save(id: "m0z-a1", text: "第一个")
        XCTAssertEqual(store.list(), ["m0z-a1", "m1a-b2"])
        XCTAssertEqual(try store.read(id: "m1a-b2"), "第二个")
        try store.remove(id: "m1a-b2")
        XCTAssertEqual(store.list(), ["m0z-a1"])
        XCTAssertThrowsError(try store.read(id: "m1a-b2"))
    }

    func testDraftIdCannotEscapeDirectory() {
        let store = DraftStore(directory: dir.appendingPathComponent("drafts"))
        XCTAssertThrowsError(try store.save(id: "../evil", text: "x"))
        XCTAssertThrowsError(try store.save(id: "", text: "x"))
        XCTAssertThrowsError(try store.remove(id: "a/b"))
    }

    // ---------- 检查更新 ----------

    func testVersionComparison() {
        XCTAssertTrue(UpdateCheck.isNewer("1.10.0", than: "1.9.3"))
        XCTAssertTrue(UpdateCheck.isNewer("v2.0", than: "1.9"))
        XCTAssertFalse(UpdateCheck.isNewer("1.2", than: "1.2.0"))
        XCTAssertFalse(UpdateCheck.isNewer("1.0.0", than: "1.0.1"))
    }

    func testParseUpdateFeed() throws {
        let release = try UpdateCheck.parse(Data(#"{"version":"1.2.0","url":"https://example.com/Typoza.dmg","notes":"修复若干问题"}"#.utf8))
        XCTAssertEqual(release, UpdateCheck.Release(version: "1.2.0", url: URL(string: "https://example.com/Typoza.dmg")!, notes: "修复若干问题"))
        XCTAssertThrowsError(try UpdateCheck.parse(Data(#"{"version":"1.2.0"}"#.utf8)))
        XCTAssertThrowsError(try UpdateCheck.parse(Data(#"{"version":"1.2.0","url":"ftp://example.com/a"}"#.utf8)))
        XCTAssertThrowsError(try UpdateCheck.parse(Data("不是 JSON".utf8)))
    }

    /// 对照表 A-04 的四种结果:没配更新源、已是最新、有新版本、更新服务出错;用假的更新源代替网络
    func testUpdateCheckOutcomes() {
        func run(feed: URL?, data: String?, status: Int = 200) -> UpdateCheck.Outcome? {
            var result: UpdateCheck.Outcome?
            UpdateCheck.check(current: "1.2.0", feed: feed, fetch: { _, reply in reply(data.map { Data($0.utf8) }, status, nil) }) { result = $0 }
            return result
        }
        let feed = URL(string: "https://updates.example.com/typoza.json")!

        let none = run(feed: nil, data: nil)
        XCTAssertEqual(none, .unconfigured(current: "1.2.0"))
        XCTAssertEqual(none?.title, "无法检查更新")
        XCTAssertEqual(none?.buttons, ["好"])

        let same = run(feed: feed, data: #"{"version":"1.2.0","url":"https://example.com/Typoza.dmg"}"#)
        XCTAssertEqual(same?.title, "当前已是最新!")
        XCTAssertEqual(same?.message, "当前版本 1.2.0。")

        let newer = run(feed: feed, data: #"{"version":"1.3.0","url":"https://example.com/Typoza.dmg","notes":"新增功能"}"#)
        XCTAssertEqual(newer?.title, "发现新版本 1.3.0")
        XCTAssertEqual(newer?.message, "新增功能")
        XCTAssertEqual(newer?.buttons, ["下载", "以后再说"])

        let broken = run(feed: feed, data: nil, status: 500)
        XCTAssertEqual(broken, .failed("更新服务返回异常(HTTP 500)"))
        XCTAssertEqual(broken?.title, "检查更新失败")
    }

    // ---------- 历史版本 ----------

    func testPinnedSnapshotSurvivesCoalescing() throws {
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let store = HistoryStore(root: dir.appendingPathComponent("history"), now: { clock })
        let file = path("doc.md")
        try store.snapshotAfterWrite(path: file, data: Data("v1".utf8))
        clock += 60
        try store.snapshotAfterWrite(path: file, data: Data("v2".utf8))
        clock += 60
        // 恢复旧版本前把当前内容(v2)钉住,随后的自动保存不能把它合并掉
        try store.pin(path: file, data: Data("v2".utf8))
        clock += 60
        try store.snapshotAfterWrite(path: file, data: Data("v1".utf8))
        let list = store.list(path: file)
        XCTAssertEqual(try list.map { try store.read(path: file, id: $0["id"] as! String) }, ["v1", "v2", "v1"])
    }

    func testHistoryFollowsRenameAndListsDeletedFiles() throws {
        let store = HistoryStore(root: dir.appendingPathComponent("history"))
        let a = path("a.md")
        let inFolder = path("notes/x.md")
        try write("a.md", "a")
        try store.snapshotAfterWrite(path: a, data: Data("a".utf8))
        try store.snapshotAfterWrite(path: inFolder, data: Data("x".utf8))

        try FileManager.default.moveItem(atPath: a, toPath: path("b.md"))
        try store.move(from: a, to: path("b.md"))
        XCTAssertEqual(store.list(path: path("b.md")).count, 1)
        XCTAssertEqual(store.list(path: a).count, 0)

        try store.move(from: path("notes"), to: path("归档"))
        XCTAssertEqual(store.list(path: path("归档/x.md")).count, 1)

        // b.md 还在;归档/x.md 从来没在磁盘上 → 算已删除
        let deleted = store.deletedFiles().compactMap { $0["path"] as? String }
        XCTAssertEqual(deleted, [path("归档/x.md")])
    }

    // ---------- 文件服务 ----------

    func testStatReportsWritableAndCreationTime() throws {
        try write("ro.md", "只读")
        var st = try XCTUnwrap(FileService.stat(path("ro.md")))
        XCTAssertEqual(st["writable"] as? Bool, true)
        XCTAssertNotNil(st["ctime"] as? Int64)
        try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: path("ro.md"))
        st = try XCTUnwrap(FileService.stat(path("ro.md")))
        XCTAssertEqual(st["writable"] as? Bool, false)
    }

    func testListOpenableFilesUsesUnifiedExtensionsAndTextBundles() throws {
        for name in ["x.md", "y.txt", "z.rmd", "w.text", "m.mmd", "n.mkdn", "b.textbundle/text.md", "b.textbundle/assets/i.md", "pic.png"] {
            try write(name, "")
        }
        XCTAssertEqual(FileService.listMarkdown(dir.path).map { ($0 as NSString).lastPathComponent }, ["b.textbundle", "m.mmd", "w.text", "x.md", "y.txt", "z.rmd"])
        XCTAssertEqual(FileService.textBundleText(path("b.textbundle")), path("b.textbundle/text.md"))
    }

    func testFirstHeading() {
        XCTAssertEqual(FileService.firstHeading(in: "---\ntitle: x\n---\n\n# 标题 #\n"), "标题")
        XCTAssertEqual(FileService.firstHeading(in: "```\n# 不是标题\n```\n季度总结\n====\n"), "季度总结")
        XCTAssertNil(FileService.firstHeading(in: "#标签 不是标题\n正文\n"))
        XCTAssertEqual(FileService.firstHeading(in: "\u{FEFF}## 带 BOM\r\n"), "带 BOM")
    }

    // ---------- 全局搜索 ----------

    func testSearchMatchesFileNamesLimitsMatchesAndBatches() throws {
        try write("a.md", "第一行\nHello World\n")
        try write("hello-notes.md", "没有\n")
        try write("c.md", "y\ny\ny\n")
        try write("b.textbundle/text.md", "包里的 hello\n")

        let hits = try SearchService.search(root: dir.path, query: "hello", options: .init(regex: false, caseSensitive: false, wholeWord: false, limit: 10))
        let summary = hits.map { (($0["path"] as! NSString).lastPathComponent, $0["nameMatch"] as! Bool, ($0["matches"] as! [[String: Any]]).count) }
        XCTAssertEqual(summary.map { $0.0 }, ["a.md", "b.textbundle", "hello-notes.md"])
        XCTAssertEqual(summary.map { $0.1 }, [false, false, true])
        XCTAssertEqual(summary.map { $0.2 }, [1, 1, 0])

        let capped = try SearchService.search(root: dir.path, query: "y", options: .init(regex: false, caseSensitive: false, wholeWord: false, limit: 10, maxMatches: 2))
        XCTAssertEqual(capped.count, 1)
        XCTAssertEqual((capped[0]["matches"] as! [[String: Any]]).count, 2)

        let batch = try SearchService.search(root: dir.path, query: "hello", options: .init(regex: false, caseSensitive: false, wholeWord: false, limit: 10, paths: [path("a.md")]))
        XCTAssertEqual(batch.compactMap { $0["path"] as? String }, [path("a.md")])
    }
}
