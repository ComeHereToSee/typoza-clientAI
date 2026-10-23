import XCTest
@testable import TypozaKit

/// 对照表 PX-07(Pandoc 类导出参数)与 PX-08(「Markdown(其他规范)」导出项):外壳拿到网页传来的 options 后拼出的 Pandoc 命令行。
/// 网页侧怎样把偏好与导出项填进 options 见 editor/tests/unit/parity-p3b.test.ts。
final class ParityPandocTests: XCTestCase {
    /// 分开写的参数(-t、-o)后面紧跟的值
    private func value(after flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    /// 全部 -M 元数据,按出现顺序
    private func metadata(_ args: [String]) -> [String] {
        args.indices.filter { args[$0] == "-M" && $0 + 1 < args.count }.map { args[$0 + 1] }
    }

    /// PX-07 Word:样式参考文件写成 --reference-doc;额外参数按 shell 规则拆开,追加在最后
    func testPX07WordReferenceDocAndExtraArgs() throws {
        let args = try PandocArguments.export(format: "docx", target: "/out/周报.docx", sourceFolder: "/文档", options: [
            "args": #"--number-sections --metadata "subtitle=第 3 周""#,
            "referenceDoc": "/样式/公司模板.docx",
            "css": "",
            "tocDepth": 0,
            "title": "周报",
            "author": "",
        ])
        XCTAssertEqual(value(after: "-t", in: args), "docx")
        XCTAssertEqual(value(after: "-o", in: args), "/out/周报.docx")
        XCTAssertTrue(args.contains("--standalone"))
        XCTAssertTrue(args.contains("--reference-doc=/样式/公司模板.docx"))
        XCTAssertTrue(args.contains("--resource-path=/文档"))
        XCTAssertEqual(Array(args.suffix(3)), ["--number-sections", "--metadata", "subtitle=第 3 周"])
        // 没填 CSS、目录层级为 0、作者为空:不加对应参数;标题元数据只给 Epub
        XCTAssertFalse(args.contains(where: { $0.hasPrefix("--css") }))
        XCTAssertFalse(args.contains("--toc"))
        XCTAssertEqual(metadata(args), [])
    }

    /// PX-07 Epub:自定义 CSS 与目录层级;Epub 必须有标题,作者与标题都写进元数据
    func testPX07EpubCssTocDepthAndTitle() throws {
        let args = try PandocArguments.export(format: "epub", target: "/out/周报.epub", sourceFolder: nil, options: [
            "args": "",
            "referenceDoc": "",
            "css": "/样式/epub.css",
            "tocDepth": 2,
            "title": "周报",
            "author": "小明",
        ])
        XCTAssertEqual(value(after: "-t", in: args), "epub")
        XCTAssertTrue(args.contains("--css=/样式/epub.css"))
        let toc = try XCTUnwrap(args.firstIndex(of: "--toc"))
        XCTAssertEqual(args[toc + 1], "--toc-depth=2")
        XCTAssertEqual(metadata(args), ["author=小明", "title=周报"])
        XCTAssertFalse(args.contains(where: { $0.hasPrefix("--reference-doc") }))
        // 未保存的文档没有所在文件夹,不加资源路径
        XCTAssertFalse(args.contains(where: { $0.hasPrefix("--resource-path") }))
    }

    /// PX-07 LaTeX PDF:引擎按导出项的设置;目标格式写 latex,由 -o 的 .pdf 让 Pandoc 出 PDF
    func testPX07LatexPdfEngine() throws {
        let args = try PandocArguments.export(format: "pandoc", target: "/out/周报.pdf", sourceFolder: nil, options: [
            "to": "pdf",
            "pdfEngine": "lualatex",
            "args": "",
            "title": "周报",
            "author": "",
        ])
        XCTAssertEqual(value(after: "-t", in: args), "latex")
        XCTAssertTrue(args.contains("--pdf-engine=lualatex"))
        XCTAssertFalse(args.contains("--pdf-engine=xelatex"))
        XCTAssertEqual(value(after: "-o", in: args), "/out/周报.pdf")
    }

    /// PX-07 模板:没有单独的模板选项,经「额外参数」传 --template;路径带空格时用引号括起
    func testPX07TemplateThroughExtraArgs() throws {
        let args = try PandocArguments.export(format: "latex", target: "/out/周报.tex", sourceFolder: nil, options: [
            "args": #"--template "/我的 模板/报告.latex""#,
        ])
        XCTAssertEqual(value(after: "-t", in: args), "latex")
        XCTAssertEqual(Array(args.suffix(2)), ["--template", "/我的 模板/报告.latex"])
    }

    /// PX-08 七种变体都按 Markdown 方言处理:-t 为所选变体,并带上折行与换行符参数
    func testPX08AllVariantsGetDialectOptions() throws {
        let variants = ["markdown", "markdown_phpextra", "markdown_mmd", "markdown_strict", "commonmark", "gfm", "commonmark_x"]
        for variant in variants {
            let args = try PandocArguments.export(format: "pandoc", target: "/out/周报.md", sourceFolder: nil, options: [
                "to": variant,
                "columns": 0,
                "eol": "lf",
                "referenceLinks": false,
                "ascii": false,
                "args": "",
            ])
            XCTAssertEqual(value(after: "-t", in: args), variant, variant)
            XCTAssertTrue(args.contains("--wrap=none"), variant)
            XCTAssertTrue(args.contains("--eol=lf"), variant)
        }
    }

    /// PX-08 限制每行字符数:0 表示不折行;大于 0 时按该列宽自动折行
    func testPX08ColumnsLimit() throws {
        let unlimited = try PandocArguments.export(format: "pandoc", target: "/out/a.md", sourceFolder: nil, options: ["to": "commonmark", "columns": 0])
        XCTAssertTrue(unlimited.contains("--wrap=none"))
        XCTAssertFalse(unlimited.contains(where: { $0.hasPrefix("--columns") }))

        let limited = try PandocArguments.export(format: "pandoc", target: "/out/a.md", sourceFolder: nil, options: ["to": "commonmark", "columns": 72])
        XCTAssertTrue(limited.contains("--wrap=auto"))
        XCTAssertTrue(limited.contains("--columns=72"))
        XCTAssertFalse(limited.contains("--wrap=none"))
    }

    /// PX-08 换行符 LF / CRLF / 跟随系统;只用 ASCII;引用式链接。不勾选时不加
    func testPX08LineEndingAsciiAndReferenceLinks() throws {
        for eol in ["lf", "crlf", "native"] {
            let args = try PandocArguments.export(format: "pandoc", target: "/out/a.md", sourceFolder: nil, options: ["to": "gfm", "eol": eol])
            XCTAssertTrue(args.contains("--eol=\(eol)"), eol)
        }

        let on = try PandocArguments.export(format: "pandoc", target: "/out/a.md", sourceFolder: nil, options: ["to": "markdown_strict", "ascii": true, "referenceLinks": true])
        XCTAssertTrue(on.contains("--ascii"))
        XCTAssertTrue(on.contains("--reference-links"))

        let off = try PandocArguments.export(format: "pandoc", target: "/out/a.md", sourceFolder: nil, options: ["to": "markdown_strict", "ascii": false, "referenceLinks": false])
        XCTAssertFalse(off.contains("--ascii"))
        XCTAssertFalse(off.contains("--reference-links"))
    }

    /// PX-08 方言参数只给 Markdown 类目标:同样的选项导出成别的格式时不加
    func testPX08DialectOptionsOnlyForMarkdownTargets() throws {
        let args = try PandocArguments.export(format: "pandoc", target: "/out/a.html", sourceFolder: nil, options: [
            "to": "html5",
            "columns": 72,
            "eol": "crlf",
            "referenceLinks": true,
            "ascii": true,
        ])
        XCTAssertEqual(value(after: "-t", in: args), "html5")
        XCTAssertFalse(args.contains(where: { $0.hasPrefix("--wrap") || $0.hasPrefix("--columns") || $0.hasPrefix("--eol") }))
        XCTAssertFalse(args.contains("--ascii"))
        XCTAssertFalse(args.contains("--reference-links"))
    }
}
