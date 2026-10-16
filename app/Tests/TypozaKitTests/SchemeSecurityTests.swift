import XCTest
@testable import TypozaKit

/// typoza://local 的安全响应头:本地网页类文件进沙箱(不透明源),所有本机文件禁止按内容猜类型。
final class SchemeSecurityTests: XCTestCase {
    func testHtmlLikeTypesAreSandboxedWithoutSameOrigin() {
        for mime in ["text/html; charset=utf-8", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml"] {
            let csp = TypozaSchemeHandler.localHeaders(mime: mime)["Content-Security-Policy"]
            XCTAssertNotNil(csp, mime)
            XCTAssertTrue(csp?.hasPrefix("sandbox") ?? false, mime)
            XCTAssertFalse(csp?.contains("allow-same-origin") ?? true, mime)
        }
    }

    func testMediaTypesAreNotSandboxedButNoSniff() {
        for mime in ["image/png", "video/mp4", "application/pdf", "audio/mpeg"] {
            let headers = TypozaSchemeHandler.localHeaders(mime: mime)
            XCTAssertNil(headers["Content-Security-Policy"], mime)
            XCTAssertEqual(headers["X-Content-Type-Options"], "nosniff", mime)
        }
    }

    func testLocalReadAddsHeadersAppReadDoesNot() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let page = dir.appendingPathComponent("x.html")
        try Data("<script>1</script>".utf8).write(to: page)

        guard case .success(let (status, local, _)) = TypozaSchemeHandler.read(fileURL: page, rangeHeader: nil, isLocal: true) else {
            return XCTFail("读本机文件失败")
        }
        XCTAssertEqual(status, 200)
        XCTAssertNotNil(local["Content-Security-Policy"])
        XCTAssertEqual(local["X-Content-Type-Options"], "nosniff")

        // 应用自己的页面(typoza://app)不加沙箱,否则编辑器本身跑不起来
        guard case .success(let (_, app, _)) = TypozaSchemeHandler.read(fileURL: page, rangeHeader: nil) else {
            return XCTFail("读应用文件失败")
        }
        XCTAssertNil(app["Content-Security-Policy"])
    }
}
