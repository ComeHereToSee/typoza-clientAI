import XCTest
@testable import TypozaKit

final class TextEncodingTests: XCTestCase {
    func testUTF8WithBOMKeepsMarker() throws {
        let data = Data([0xEF, 0xBB, 0xBF]) + Data("# 标题".utf8)
        let r = try TextEncoding.decode(data)
        XCTAssertEqual(r.encoding, "utf-8")
        XCTAssertEqual(r.text, "\u{FEFF}# 标题")
        // 写回时 BOM 原样恢复
        XCTAssertEqual(try TextEncoding.encode(r.text, as: "utf-8"), data)
    }

    func testFallsBackToGB18030ForLegacyChinese() throws {
        let gb = try TextEncoding.encode("中文旧文件", as: "gb18030")
        let r = try TextEncoding.decode(gb)
        XCTAssertEqual(r.encoding, "gb18030")
        XCTAssertEqual(r.text, "中文旧文件")
    }

    func testUTF16LittleEndianBOM() throws {
        let data = Data([0xFF, 0xFE]) + "ok".data(using: .utf16LittleEndian)!
        let r = try TextEncoding.decode(data)
        XCTAssertEqual(r.encoding, "utf-16le")
        XCTAssertEqual(r.text, "\u{FEFF}ok")
    }

    func testUnknownEncodingNameFails() {
        XCTAssertThrowsError(try TextEncoding.encoding(named: "klingon"))
    }
}

final class FileServiceTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("typoza-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testWriteReadRoundTripAndMtime() throws {
        let path = dir.appendingPathComponent("子目录/文档.md").path
        let w = try FileService.writeText(path, text: "内容\n", encoding: nil)
        let r = try FileService.readText(path, encoding: nil)
        XCTAssertEqual(r["text"] as? String, "内容\n")
        XCTAssertEqual(r["mtime"] as? Int64, w["mtime"] as? Int64)
    }

    /// 对照表 X-54:自动识别出 GB18030 的旧文件,按原编码写回(盘上字节仍是 GB18030,不是 UTF-8)
    func testLegacyEncodingIsDetectedAndWrittenBack() throws {
        let path = dir.appendingPathComponent("旧文件.md").path
        try TextEncoding.encode("中文旧文件\n", as: "gb18030").write(to: URL(fileURLWithPath: path))
        let r = try FileService.readText(path, encoding: nil)
        XCTAssertEqual(r["encoding"] as? String, "gb18030")
        XCTAssertEqual(r["text"] as? String, "中文旧文件\n")
        _ = try FileService.writeText(path, text: "中文旧文件,改过\n", encoding: r["encoding"] as? String)
        let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertEqual(bytes, try TextEncoding.encode("中文旧文件,改过\n", as: "gb18030"))
        XCTAssertNil(String(data: bytes, encoding: .utf8))
    }

    func testListDirPutsFoldersFirstWithNaturalOrder() throws {
        for name in ["b10.md", "b2.md", "a.md"] { _ = try FileService.writeText(dir.appendingPathComponent(name).path, text: "", encoding: nil) }
        try FileService.mkdir(dir.appendingPathComponent("zz").path)
        let names = try FileService.listDir(dir.path).compactMap { $0["name"] as? String }
        XCTAssertEqual(names, ["zz", "a.md", "b2.md", "b10.md"])
    }

    func testRenameRefusesToOverwrite() throws {
        let a = dir.appendingPathComponent("a.md").path
        let b = dir.appendingPathComponent("b.md").path
        _ = try FileService.writeText(a, text: "a", encoding: nil)
        _ = try FileService.writeText(b, text: "b", encoding: nil)
        XCTAssertThrowsError(try FileService.rename(from: a, to: b))
    }

    func testListMarkdownSkipsHiddenAndNodeModules() throws {
        _ = try FileService.writeText(dir.appendingPathComponent("x.md").path, text: "", encoding: nil)
        _ = try FileService.writeText(dir.appendingPathComponent("node_modules/y.md").path, text: "", encoding: nil)
        _ = try FileService.writeText(dir.appendingPathComponent(".hidden/z.md").path, text: "", encoding: nil)
        XCTAssertEqual(FileService.listMarkdown(dir.path).map { ($0 as NSString).lastPathComponent }, ["x.md"])
    }

    func testSearchFindsLinesCaseInsensitive() throws {
        _ = try FileService.writeText(dir.appendingPathComponent("a.md").path, text: "第一行\nHello World\n", encoding: nil)
        let hits = try SearchService.search(root: dir.path, query: "hello", options: .init(regex: false, caseSensitive: false, wholeWord: false, limit: 10))
        XCTAssertEqual(hits.count, 1)
        let matches = hits[0]["matches"] as? [[String: Any]]
        XCTAssertEqual(matches?.first?["line"] as? Int, 2)
    }
}

final class HistoryStoreTests: XCTestCase {
    func testSnapshotsCoalesceAndKeepOriginal() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("typoza-history-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        var clock = Date(timeIntervalSince1970: 1_000_000)
        let store = HistoryStore(root: root, now: { clock })
        let file = root.appendingPathComponent("doc.md").path
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("原文".utf8).write(to: URL(fileURLWithPath: file))

        // 第一次保存前先保留原文
        try store.snapshotBeforeWrite(path: file)
        try store.snapshotAfterWrite(path: file, data: Data("改1".utf8))
        clock += 60
        try store.snapshotAfterWrite(path: file, data: Data("改2".utf8)) // 5 分钟内合并
        var list = store.list(path: file)
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(try store.read(path: file, id: list.last!["id"] as! String), "原文")
        XCTAssertEqual(try store.read(path: file, id: list.first!["id"] as! String), "改2")

        clock += 600
        try store.snapshotAfterWrite(path: file, data: Data("改3".utf8))
        list = store.list(path: file)
        XCTAssertEqual(list.count, 3)
    }
}

final class LinkPreviewTests: XCTestCase {
    func testParsesOpenGraphAndResolvesRelativeURLs() {
        let html = """
        <html><head><title>备用标题</title>
        <meta property="og:title" content="网页标题 &amp; 副标题">
        <meta name="description" content="一段描述">
        <meta property="og:image" content="/img/cover.png">
        <link rel="icon" href="favicon.png">
        </head></html>
        """
        let info = LinkPreview.parse(html: html, baseURL: URL(string: "https://example.com/a/b")!)
        XCTAssertEqual(info.title, "网页标题 & 副标题")
        XCTAssertEqual(info.description, "一段描述")
        XCTAssertEqual(info.image, "https://example.com/img/cover.png")
        XCTAssertEqual(info.icon, "https://example.com/a/favicon.png")
    }

    func testFallsBackToTitleTag() {
        let info = LinkPreview.parse(html: "<title> 只有标题 </title>", baseURL: URL(string: "https://x.org")!)
        XCTAssertEqual(info.title, "只有标题")
        XCTAssertEqual(info.icon, "https://x.org/favicon.ico")
    }
}

final class ImageUploadTests: XCTestCase {
    func testTakesLastURLs() {
        let out = "[PicGo INFO]: Before transform\n[PicGo SUCCESS]:\nhttps://img.example.com/1.png\nhttps://img.example.com/2.png\n"
        XCTAssertEqual(ImageUpload.parseURLs(out, count: 1), ["https://img.example.com/2.png"])
        XCTAssertEqual(ImageUpload.parseURLs(out, count: 2).count, 2)
    }

    func testShellQuote() {
        XCTAssertEqual(ImageUpload.shellQuote("a b'c"), "'a b'\\''c'")
    }
}

final class ParamsTests: XCTestCase {
    func testMissingStringThrowsWithFieldName() {
        XCTAssertThrowsError(try Params([:]).string("path")) { error in
            XCTAssertEqual((error as? BridgeError)?.message, "参数 path 缺失或不是字符串")
        }
    }
}

final class BridgeOriginTests: XCTestCase {
    func testOnlyEditorMainFrameIsTrusted() {
        XCTAssertTrue(BridgeOrigin.isTrusted(isMainFrame: true, scheme: "typoza", host: "app"))
        XCTAssertFalse(BridgeOrigin.isTrusted(isMainFrame: false, scheme: "typoza", host: "app"), "同源 iframe 也不行")
        XCTAssertFalse(BridgeOrigin.isTrusted(isMainFrame: true, scheme: "typoza", host: "local"), "本机文件(如 HTML 附件)不可信")
        XCTAssertFalse(BridgeOrigin.isTrusted(isMainFrame: false, scheme: "https", host: "www.youtube.com"))
        XCTAssertFalse(BridgeOrigin.isTrusted(isMainFrame: true, scheme: "https", host: "evil.example"))
    }
}
