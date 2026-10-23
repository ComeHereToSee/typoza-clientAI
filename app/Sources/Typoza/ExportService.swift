import AppKit
import PDFKit
import TypozaKit
import WebKit

/// 导出:HTML 直接写文件;PDF 与图像用离屏 WKWebView 渲染导出 HTML;Word 等格式调用用户安装的 Pandoc。
/// 各格式参数来自偏好「导出」页(对照表 PX-04 ~ PX-08),由网页放在 options 里传来。
enum ExportService {
    static let pandocFormats: Set<String> = ["docx", "odt", "rtf", "epub", "latex", "mediawiki", "rst", "textile", "opml", "pandoc"]

    /// 没装 Pandoc 时的提示(PRD 3.12、对照表 F-21);网页按「需要安装 Pandoc」开头识别并给出【安装说明】
    static let pandocMissingForExport = "需要安装 Pandoc 以继续…"
    static let pandocMissingForImport = "需要安装 Pandoc 以导入这些文件"

    static func run(params: Params, pandocPath: String?, completion: @escaping (Error?) -> Void) {
        do {
            let format = try params.string("format")
            let target = URL(fileURLWithPath: try params.string("target"))
            let html = try params.string("html")
            let options = params.dictionary("options")
            let number = { (key: String, fallback: Double) in (options[key] as? NSNumber)?.doubleValue ?? fallback }
            let string = { (key: String) in (options[key] as? String) ?? "" }
            switch format {
            case "html", "html-plain":
                try Data(html.utf8).write(to: target, options: .atomic)
                completion(nil)
            case "pdf":
                let paper = try PaperSize.size(named: options["paper"] as? String ?? "A4", customWidthMM: number("width", 210), customHeightMM: number("height", 297))
                let page = PDFPageSetup(
                    width: paper.width,
                    height: paper.height,
                    margin: PaperSize.points(fromMillimeters: number("margin", 12.7)),
                    header: string("header"),
                    footer: string("footer"),
                    title: string("title"),
                    author: string("author")
                )
                OffscreenRenderer.render(html: html, width: 900, nextTo: target) { renderer in
                    guard let renderer else {
                        completion(BridgeError("导出渲染失败"))
                        return
                    }
                    renderer.exportPDF(to: target, page: page, completion: completion)
                }
            case "image":
                let width = max(200, Int(number("width", 900)))
                let scale = number("scale", 0)
                OffscreenRenderer.render(html: html, width: CGFloat(width), nextTo: target) { renderer in
                    guard let renderer else {
                        completion(BridgeError("导出渲染失败"))
                        return
                    }
                    renderer.exportPNG(to: target, scale: scale, completion: completion)
                }
            default:
                guard pandocFormats.contains(format) else { throw BridgeError("不支持的导出格式:\(format)") }
                let markdown = try params.string("markdown")
                let source = params.optionalString("sourcePath").map { URL(fileURLWithPath: $0).deletingLastPathComponent() }
                let args = try PandocArguments.export(format: format, target: target.path, sourceFolder: source?.path, options: options)
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let pandoc = try locatePandoc(configured: pandocPath)
                        try runPandoc(pandoc, arguments: args, input: markdown, workingDirectory: source)
                        DispatchQueue.main.async { completion(nil) }
                    } catch {
                        DispatchQueue.main.async { completion(error) }
                    }
                }
            }
        } catch {
            completion(error)
        }
    }

    static func locatePandoc(configured: String?, missingMessage: String = pandocMissingForExport) throws -> String {
        let candidates = [configured, "/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/usr/bin/pandoc"].compactMap { $0 }.filter { !$0.isEmpty }
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return found }
        // 用户 shell 的 PATH 里找
        let result = try ShellCommand.run("command -v pandoc", cwd: nil)
        let path = result.output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard result.status == 0, !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else {
            throw BridgeError(missingMessage)
        }
        return path
    }

    static func runPandoc(_ pandoc: String, arguments: [String], input: String?, workingDirectory: URL?) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: pandoc)
        p.arguments = arguments
        if let workingDirectory { p.currentDirectoryURL = workingDirectory }
        let stdin = Pipe()
        let stderr = Pipe()
        p.standardInput = stdin
        p.standardError = stderr
        p.standardOutput = FileHandle.nullDevice
        try p.run()
        // 输入在后台写、同时这里读错误输出:两边都可能写满管道缓冲互相等。
        // Pandoc 参数错时会提前退出,写入遇到断开的管道:用会抛错的写法(旧的 write(_:) 抛 ObjC 异常,整个应用闪退)
        let writing = DispatchGroup()
        var writeError: Error?
        let handle = stdin.fileHandleForWriting
        writing.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            defer { writing.leave() }
            do {
                if let input { try handle.write(contentsOf: Data(input.utf8)) }
                try handle.close()
            } catch {
                writeError = error
                try? handle.close()
            }
        }
        let errData = stderr.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        writing.wait()
        guard p.terminationStatus == 0 else {
            throw BridgeError("Pandoc 转换失败:\(String(data: errData, encoding: .utf8) ?? "退出码 \(p.terminationStatus)")")
        }
        if let writeError { throw BridgeError("Pandoc 没能读完输入:\(writeError.localizedDescription)") }
    }

    /// 经 Pandoc 把 docx 等转成 Markdown,存在原文件旁边(同名 .md,已存在则加序号),图片抽到旁边的 assets;返回生成的文件。
    static func importWithPandoc(_ source: URL, pandocPath: String?) throws -> URL {
        let pandoc = try locatePandoc(configured: pandocPath, missingMessage: pandocMissingForImport)
        let folder = source.deletingLastPathComponent()
        let stem = source.deletingPathExtension().lastPathComponent
        var target = folder.appendingPathComponent("\(stem).md")
        var i = 1
        while FileManager.default.fileExists(atPath: target.path) {
            target = folder.appendingPathComponent("\(stem)-\(i).md")
            i += 1
        }
        try runPandoc(pandoc, arguments: [source.path, "-t", "gfm", "--wrap=none", "--extract-media=\(folder.appendingPathComponent("assets").path)", "-o", target.path], input: nil, workingDirectory: folder)
        return target
    }
}

/// PDF 的纸张、页边距(点)与页首页尾、文档信息。
struct PDFPageSetup {
    let width: Double
    let height: Double
    let margin: Double
    let header: String
    let footer: String
    let title: String
    let author: String
}

/// 离屏渲染导出 HTML。HTML 先写到目标旁的临时文件,用 file:// 加载,才能读到相对路径的图片。
final class OffscreenRenderer: NSObject, WKNavigationDelegate {
    private static var active: Set<OffscreenRenderer> = []
    private let window: NSWindow
    let webView: WKWebView
    private let tempFile: URL
    private let width: CGFloat
    private var onLoad: ((OffscreenRenderer?) -> Void)?

    private init(tempFile: URL, width: CGFloat) {
        self.tempFile = tempFile
        self.width = width
        let frame = NSRect(x: 0, y: 0, width: width, height: 1200)
        webView = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
        window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.setFrameOrigin(NSPoint(x: -20000, y: -20000))
        window.contentView = webView
        super.init()
        webView.navigationDelegate = self
    }

    static func render(html: String, width: CGFloat, nextTo target: URL, completion: @escaping (OffscreenRenderer?) -> Void) {
        let temp = target.deletingLastPathComponent().appendingPathComponent(".typoza-export-\(UUID().uuidString).html")
        do {
            try Data(html.utf8).write(to: temp)
        } catch {
            completion(nil)
            return
        }
        let r = OffscreenRenderer(tempFile: temp, width: width)
        active.insert(r)
        r.onLoad = completion
        r.window.orderBack(nil)
        r.webView.loadFileURL(temp, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 等字体与图片就绪
        // 网络图片最多等 10 秒:连不上时不能让导出一直卡着
        webView.callAsyncJavaScript(
            "await document.fonts.ready; await Promise.race([Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r }))), new Promise(r => setTimeout(r, 10000))]);",
            arguments: [:], in: nil, in: .page
        ) { [weak self] _ in
            guard let self else { return }
            self.onLoad?(self)
            self.onLoad = nil
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failLoad()
    }

    // 临时文件打不开、渲染进程崩溃:同样报失败,否则网页一直等导出结果
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failLoad()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        failLoad()
    }

    private func failLoad() {
        guard let onLoad else { return }
        self.onLoad = nil
        onLoad(nil)
        finish()
    }

    func exportPDF(to target: URL, page: PDFPageSetup, completion: @escaping (Error?) -> Void) {
        let info = NSPrintInfo()
        info.paperSize = NSSize(width: page.width, height: page.height)
        info.topMargin = page.margin
        info.bottomMargin = page.margin
        info.leftMargin = page.margin
        info.rightMargin = page.margin
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = target
        let op = webView.printOperation(with: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        // WKWebView 的打印视图需要显式给尺寸,否则可能导出空白页
        op.view?.frame = webView.bounds
        op.runModal(for: window, delegate: self, didRun: #selector(printDone(_:success:contextInfo:)), contextInfo: Unmanaged.passRetained(CompletionBox(target: target, page: page, completion: completion)).toOpaque())
    }

    @objc private func printDone(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        guard let contextInfo else { return }
        let box = Unmanaged<CompletionBox>.fromOpaque(contextInfo).takeRetainedValue()
        // WKWebView 的打印在单独线程里跑,结束回调也在那个线程:回网页、收窗口都得回主线程,否则 WebKit 断言崩溃
        DispatchQueue.main.async {
            defer { self.finish() }
            guard success, let doc = PDFDocument(url: box.target), doc.pageCount > 0 else {
                box.completion(BridgeError("PDF 导出失败"))
                return
            }
            do {
                try PDFDecorator.decorate(doc, page: box.page, writeTo: box.target)
                box.completion(nil)
            } catch {
                box.completion(error)
            }
        }
    }

    /// 一张图像的最大高度(CSS 像素)
    static let maxImageHeight: Double = 30000

    /// scale:0 = 跟随屏幕;1 / 2 / 3 = 中等 / 高 / 极高(每个 CSS 像素对应的图片像素数)
    func exportPNG(to target: URL, scale: Double, completion: @escaping (Error?) -> Void) {
        webView.evaluateJavaScript("Math.ceil(document.documentElement.scrollHeight)") { [weak self] value, error in
            guard let self else { return }
            let width = self.width
            // 量不到高度、或超出一张图的上限时报错:截一部分却提示成功,用户会以为导出了全文
            guard let measured = (value as? NSNumber)?.doubleValue else {
                self.finish()
                return completion(BridgeError("导出图像失败:量不出文档高度(\(error?.localizedDescription ?? "未知错误"))"))
            }
            guard measured <= Self.maxImageHeight else {
                self.finish()
                return completion(BridgeError("文档太长(约 \(Int(measured)) 像素高,一张图最多 \(Int(Self.maxImageHeight)) 像素),无法导出为一张图像;请改用 PDF 或拆分文档"))
            }
            let height = CGFloat(measured)
            self.window.setContentSize(NSSize(width: width, height: height))
            self.webView.frame = NSRect(x: 0, y: 0, width: width, height: height)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                let config = WKSnapshotConfiguration()
                config.rect = NSRect(x: 0, y: 0, width: width, height: height)
                self.webView.takeSnapshot(with: config) { image, error in
                    defer { self.finish() }
                    guard let image else {
                        completion(BridgeError("导出图像失败:\(error?.localizedDescription ?? "未知错误")"))
                        return
                    }
                    do {
                        if scale > 0 {
                            try Self.writePNG(image, to: target, scale: scale)
                        } else {
                            try SmokeReport.writePNG(image, to: target)
                        }
                        completion(nil)
                    } catch {
                        completion(error)
                    }
                }
            }
        }
    }

    /// 按指定倍率重绘成位图再写 PNG;长图的像素高度超过 32000 时按比例降低倍率(位图尺寸上限)。
    static func writePNG(_ image: NSImage, to url: URL, scale: Double) throws {
        let size = image.size
        let factor = min(scale, 32000 / max(1, Double(size.height)))
        let pixelsWide = max(1, Int((Double(size.width) * factor).rounded()))
        let pixelsHigh = max(1, Int((Double(size.height) * factor).rounded()))
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixelsWide, pixelsHigh: pixelsHigh, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            throw BridgeError("无法创建 \(pixelsWide)×\(pixelsHigh) 的位图")
        }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { throw BridgeError("无法把图像编码为 PNG") }
        try png.write(to: url)
    }

    private func finish() {
        try? FileManager.default.removeItem(at: tempFile)
        window.orderOut(nil)
        Self.active.remove(self)
    }
}

private final class CompletionBox {
    let target: URL
    let page: PDFPageSetup
    let completion: (Error?) -> Void

    init(target: URL, page: PDFPageSetup, completion: @escaping (Error?) -> Void) {
        self.target = target
        self.page = page
        self.completion = completion
    }
}

/// PDF 生成后补上页首、页尾(变量 ${pageNo} ${pageCount} 逐页替换)与标题、作者信息(对照表 PX-04、X-23)。
/// WKWebView 打印不支持自定义页首页尾,所以生成后用 PDFKit 在每页页边距里加文字注释(会随 PDF 显示与打印)。
enum PDFDecorator {
    static func decorate(_ doc: PDFDocument, page setup: PDFPageSetup, writeTo url: URL) throws {
        var attributes = doc.documentAttributes ?? [:]
        if !setup.title.isEmpty { attributes[PDFDocumentAttribute.titleAttribute] = setup.title }
        if !setup.author.isEmpty { attributes[PDFDocumentAttribute.authorAttribute] = setup.author }
        doc.documentAttributes = attributes
        let count = doc.pageCount
        if !setup.header.isEmpty || !setup.footer.isEmpty {
            for i in 0 ..< count {
                guard let page = doc.page(at: i) else { continue }
                let vars = ["pageNo": String(i + 1), "pageCount": String(count)]
                let box = page.bounds(for: .mediaBox)
                let lineHeight: CGFloat = 14
                let inset = CGFloat(setup.margin)
                if !setup.header.isEmpty {
                    let rect = NSRect(x: box.minX + inset, y: box.maxY - inset / 2 - lineHeight / 2, width: box.width - inset * 2, height: lineHeight)
                    page.addAnnotation(label(ExportVariables.expand(setup.header, vars), in: rect))
                }
                if !setup.footer.isEmpty {
                    let rect = NSRect(x: box.minX + inset, y: box.minY + inset / 2 - lineHeight / 2, width: box.width - inset * 2, height: lineHeight)
                    page.addAnnotation(label(ExportVariables.expand(setup.footer, vars), in: rect))
                }
            }
        }
        guard doc.write(to: url) else { throw BridgeError("写入 PDF 失败:\(url.path)") }
    }

    private static func label(_ text: String, in rect: NSRect) -> PDFAnnotation {
        let annotation = PDFAnnotation(bounds: rect, forType: .freeText, withProperties: nil)
        annotation.contents = text
        annotation.font = NSFont.systemFont(ofSize: 9)
        annotation.fontColor = NSColor(white: 0.45, alpha: 1)
        annotation.color = .clear
        annotation.alignment = .center
        let border = PDFBorder()
        border.lineWidth = 0
        annotation.border = border
        annotation.shouldPrint = true
        return annotation
    }
}
