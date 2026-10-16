import AppKit
import TypozaKit
import UniformTypeIdentifiers
import WebKit

/// WKScriptMessageHandler 会强引用处理器,中间放一个弱引用代理,避免窗口控制器与网页互相持有导致无法释放。
private final class WeakBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: DocumentWindowController?

    init(_ target: DocumentWindowController) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else {
            replyHandler(nil, "窗口已关闭")
            return
        }
        let origin = message.frameInfo.securityOrigin
        guard BridgeOrigin.isTrusted(isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host) else {
            NSLog("Typoza:拒绝来自 %@://%@ 的桥接调用", origin.protocol, origin.host)
            replyHandler(nil, "不允许嵌入内容调用 Typoza")
            return
        }
        target.handle(message, reply: replyHandler)
    }
}

/// 一个窗口:一个 WKWebView 跑编辑器,经桥接调用原生能力。
final class DocumentWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private unowned let app: AppDelegate
    let webView: WKWebView
    private var openRequest: (String, Bool)?
    private let smokeOut: URL?
    private var ready = false
    private var queuedCommands: [String] = []
    private var allowClose = false
    private(set) var currentPath: String?
    /// 本窗口未命名文档的草稿编号(网页备份过才有);网页进程崩溃后据此恢复
    private(set) var draftId: String?
    /// 要求网页恢复的草稿(启动时恢复上次的未命名文档、崩溃后重载、「恢复未保存的草稿」)
    var pendingDraft: String?
    /// 当前文档有可重复的导出(网页经 window.setState 告知;决定「使用上一次设置导出」等菜单项是否可用)
    private var hasLastExport = false
    /// 打印面板关闭后回复网页(网页据此恢复打印前临时换掉的主题)
    private var printCompletion: (() -> Void)?
    /// 进程里第一个窗口:偏好「启动时」选项只对它生效
    private let isLaunchWindow: Bool
    private static var windowsCreated = 0
    private lazy var watcher = FileWatcher { [weak self] paths in
        self?.emit("fs.changed", ["paths": paths])
    }

    /// 空白新文档(没打开文件、没修改、没有待恢复的草稿),可以直接拿来打开别的文件
    var isBlank: Bool { currentPath == nil && window?.isDocumentEdited != true && draftId == nil && pendingDraft == nil }

    /// 这个窗口正在编辑 path(TextBundle 包:正在编辑包里的正文也算)
    func isShowing(_ path: String) -> Bool {
        guard let current = currentPath else { return false }
        return current == path || (FileService.isTextBundle(path) && (current as NSString).deletingLastPathComponent == path)
    }

    init(app: AppDelegate, open: (String, Bool)?, smokeOut: URL?) {
        self.app = app
        self.openRequest = open
        self.smokeOut = smokeOut
        guard let editorRoot = Bundle.main.resourceURL?.appendingPathComponent("editor", isDirectory: true) else {
            fatalError("应用包缺少 Resources/editor 目录")
        }
        app.mark("windowInit")
        let config = WKWebViewConfiguration()
        let schemeHandler = TypozaSchemeHandler(appRoot: editorRoot)
        // 启动时间点:网页进程起来后第一次取 index.html、第一个脚本(mark 只记第一次)
        schemeHandler.onRequest = { [weak app] url in
            if url.lastPathComponent == "index.html" { app?.mark("indexRequested") }
            if url.pathExtension == "js" { app?.mark("scriptRequested") }
        }
        config.setURLSchemeHandler(schemeHandler, forURLScheme: TypozaSchemeHandler.scheme)
        config.preferences.isElementFullscreenEnabled = true
        config.mediaTypesRequiringUserActionForPlayback = []
        webView = DropWebView(frame: .zero, configuration: config)
        isLaunchWindow = Self.windowsCreated == 0
        Self.windowsCreated += 1
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.allowsMagnification = false
        webView.setValue(false, forKey: "drawsBackground")

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.tabbingMode = .automatic
        window.tabbingIdentifier = "TypozaDocument"
        window.minSize = NSSize(width: 520, height: 360)
        window.contentView = webView
        window.setFrameAutosaveName("TypozaDocumentWindow")
        super.init(window: window)
        window.delegate = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        config.userContentController.addScriptMessageHandler(WeakBridge(self), contentWorld: .page, name: "typoza")
        (webView as? DropWebView)?.onFileDrop = { [weak self] paths, point in
            self?.emit("app.dropFiles", ["paths": paths, "x": Double(point.x), "y": Double(point.y)])
        }
        if window.frameAutosaveName.isEmpty || !window.setFrameUsingName("TypozaDocumentWindow") { window.center() }
        if let open { window.title = (open.0 as NSString).lastPathComponent }
        app.mark("webViewCreated")
        webView.load(URLRequest(url: TypozaSchemeHandler.appURL("index.html")))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) 未实现")
    }

    // ---------- 与网页通信 ----------

    /// 向网页推事件(HostEvents)。
    func emit(_ event: String, _ payload: [String: Any]) {
        guard ready, let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        let name = (try? String(data: JSONSerialization.data(withJSONObject: [event]), encoding: .utf8)) ?? "[]"
        webView.evaluateJavaScript("window.__typozaEmit && window.__typozaEmit(\(name)[0], \(json))")
    }

    func sendCommand(_ id: String) {
        if ready { emit("menu.command", ["id": id]) } else { queuedCommands.append(id) }
    }

    func sendCommandWhenReady(_ id: String) {
        queuedCommands.append(id)
    }

    func load(path: String, isDir: Bool) {
        if ready {
            emit("app.open", ["path": path, "isDir": isDir])
        } else {
            openRequest = (path, isDir)
        }
    }

    /// 关窗口或退出前:让网页保存或询问。reason 为 quit 时,未命名文档留草稿、下次启动恢复,不询问(自动保存开着时)。
    func prepareClose(reason: String, _ completion: @escaping (Bool) -> Void) {
        guard ready else {
            completion(true)
            return
        }
        webView.callAsyncJavaScript("return await window.typoza.prepareClose(reason)", arguments: ["reason": reason], in: nil, in: .page) { result in
            switch result {
            case .success(let value): completion((value as? Bool) ?? true)
            case .failure: completion(true)
            }
        }
    }

    func handle(_ message: WKScriptMessage, reply: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            reply(nil, "桥接消息格式错误:缺少 method")
            return
        }
        let params = Params((body["params"] as? [String: Any]) ?? [:])
        // 耗时操作放到后台线程,回复切回主线程
        func background(_ work: @escaping () throws -> Any?) {
            DispatchQueue.global(qos: .userInitiated).async {
                let result = Result { try work() }
                DispatchQueue.main.async {
                    switch result {
                    case .success(let value): reply(value, nil)
                    case .failure(let error): reply(nil, error.localizedDescription)
                    }
                }
            }
        }
        func sync(_ work: () throws -> Any?) {
            do { reply(try work(), nil) } catch { reply(nil, error.localizedDescription) }
        }

        switch method {
        case "app.info":
            app.mark("bridgeAppInfo")
            let open = openRequest
            openRequest = nil
            sync { ["home": NSHomeDirectory(), "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev", "openPath": open?.0 as Any, "openIsDir": open?.1 ?? false, "dark": app.isDark, "launch": isLaunchWindow] }
        case "app.ready":
            app.mark("appReady")
            ready = true
            reply(nil, nil)
            // app.info 之后、就绪之前才到的打开请求(启动时 Finder 传来的文件)
            if let (path, isDir) = openRequest {
                openRequest = nil
                emit("app.open", ["path": path, "isDir": isDir])
            }
            for id in queuedCommands { emit("menu.command", ["id": id]) }
            queuedCommands.removeAll()
            if smokeOut != nil { runSmoke() }
        case "app.fatal":
            reply(nil, nil)
            let msg = params.optionalString("message") ?? "未知错误"
            NSLog("Typoza 网页启动失败:%@", msg)
            if let out = smokeOut { writeSmokeAndExit(["error": "网页启动失败:\(msg)"], to: out, code: 3) }
        case "app.openDocument":
            // tab:开成本窗口组里的新标签;newWindow:开新窗口(PRD 3.1、notion 5.1 第 10、11 行)
            let path = params.optionalString("path") ?? ""
            let tab = params.bool("tab")
            sync {
                if path.isEmpty { app.newWindow(open: nil, asTabOf: params.bool("newWindow") ? nil : window) } else { app.open(path: path, isDir: false, newWindow: params.bool("newWindow") || tab, tabOf: tab ? window : nil) }
                return nil
            }
        case "app.focusDocument":
            sync { app.focus(path: try params.string("path"), except: self) }
        case "app.nativeCommand":
            // 网页里的按钮执行原生菜单命令(如偏好「文件」页的「恢复未保存的草稿」),与点菜单同一条路
            sync {
                let id = try params.string("id")
                guard id.hasPrefix("native.") else { throw BridgeError("只能执行原生命令:\(id)") }
                let item = NSMenuItem()
                item.representedObject = id
                app.menuCommand(item)
                return nil
            }

        case "fs.readText":
            let encoding = params.optionalString("encoding")
            background { try FileService.readText(try params.string("path"), encoding: encoding) }
        case "fs.writeText":
            let history = app.history
            background {
                let path = try params.string("path")
                let text = try params.string("text")
                let isMarkdown = FileService.isTextDocument(path)
                if isMarkdown { try? history.snapshotBeforeWrite(path: path) }
                let result = try FileService.writeText(path, text: text, encoding: params.optionalString("encoding"))
                if isMarkdown, let data = FileManager.default.contents(atPath: path) { try? history.snapshotAfterWrite(path: path, data: data) }
                return result
            }
        case "fs.writeBase64":
            background {
                try FileService.writeBase64(try params.string("path"), base64: try params.string("base64"))
                return nil
            }
        case "fs.copyFile":
            background {
                try FileService.copy(from: try params.string("from"), to: try params.string("to"))
                return nil
            }
        case "fs.stat":
            sync { FileService.stat(try params.string("path")) }
        case "fs.listDir":
            background { try FileService.listDir(try params.string("path")) }
        case "fs.mkdir":
            sync {
                try FileService.mkdir(try params.string("path"))
                return nil
            }
        case "fs.rename":
            sync {
                let from = try params.string("from")
                let to = try params.string("to")
                try FileService.rename(from: from, to: to)
                // 在 Typoza 里改名或移动后历史跟着走(PRD 3.14);历史搬不动不影响改名本身,记日志
                do { try app.history.move(from: from, to: to) } catch { NSLog("Typoza:历史版本没能跟随改名 %@ → %@:%@", from, to, error.localizedDescription) }
                return nil
            }
        case "fs.trash":
            sync { try FileService.trash(try params.string("path")) }
        case "fs.watch":
            watcher.watch(params.strings("paths"))
            reply(nil, nil)
        case "fs.search":
            background {
                let options = SearchService.Options(
                    regex: params.bool("regex"),
                    caseSensitive: params.bool("caseSensitive"),
                    wholeWord: params.bool("wholeWord"),
                    limit: params.int("limit", default: 200),
                    paths: params.raw["paths"] == nil ? nil : params.strings("paths"),
                    maxMatches: params.int("maxMatches", default: Int.max)
                )
                return try SearchService.search(root: try params.string("root"), query: try params.string("query"), options: options)
            }
        case "fs.listMarkdown":
            background { FileService.listMarkdown(try params.string("root")) }
        case "fs.firstHeadings":
            let paths = params.strings("paths")
            background { paths.map { path -> Any in (FileService.firstHeading(atPath: path) as Any?) ?? NSNull() } }

        case "window.setState":
            let path = params.optionalString("path")
            currentPath = path
            window?.title = params.optionalString("title") ?? "Typoza"
            window?.representedURL = path.map { URL(fileURLWithPath: $0) }
            window?.isDocumentEdited = params.bool("edited")
            hasLastExport = params.bool("hasLastExport")
            reply(nil, nil)
        case "window.close":
            reply(nil, nil)
            allowClose = true
            window?.close()

        case "dialog.open":
            showOpenDialog(params, reply: reply)
        case "dialog.save":
            showSaveDialog(params, reply: reply)
        case "dialog.confirm":
            showConfirm(params, reply: reply)

        case "system.reveal":
            sync {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: try params.string("path"))])
                return nil
            }
        case "system.openURL":
            sync {
                guard let url = URL(string: try params.string("url")), ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") else {
                    throw BridgeError("只能打开网页、邮件与电话链接")
                }
                NSWorkspace.shared.open(url)
                return nil
            }
        case "system.openWithDefaultApp":
            sync {
                let path = try params.string("path")
                guard FileManager.default.fileExists(atPath: path) else { throw BridgeError("文件不存在:\(path)") }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                return nil
            }
        case "system.copyImage":
            // 网络图片(「拷贝图片」、灯箱复制):先下载再放进剪贴板
            if let remote = URL(string: params.optionalString("path") ?? ""), ["http", "https"].contains(remote.scheme?.lowercased() ?? "") {
                copyRemoteImage(remote, reply: reply)
                return
            }
            sync {
                let path = try params.string("path")
                guard let image = NSImage(contentsOfFile: path) else { throw BridgeError("无法读取图片:\(path)") }
                let pb = NSPasteboard.general
                pb.clearContents()
                pb.writeObjects([image, URL(fileURLWithPath: path) as NSURL])
                return nil
            }
        case "system.quickLook":
            sync {
                try QuickLookPreview.show(try params.string("path"))
                return nil
            }
        case "system.openWith":
            let path = params.optionalString("path") ?? ""
            reply(nil, nil)
            chooseAppAndOpen(path)
        case "net.linkPreview":
            guard let url = URL(string: (try? params.string("url")) ?? ""), url.scheme?.hasPrefix("http") == true else {
                reply(nil, "网址无效")
                return
            }
            LinkPreview.fetch(url) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let info): reply(["url": url.absoluteString, "title": info.title, "description": info.description, "image": info.image as Any, "icon": info.icon as Any], nil)
                    case .failure(let error): reply(nil, error.localizedDescription)
                    }
                }
            }

        case "sync.call", "ai.call":
            // 云同步与 AI:转发给辅助进程(外壳按白名单放行、AI 密钥由外壳写钥匙串);结果里带 ok 与错误码,不走 reply 的错误通道
            app.helper.callFromWeb(params.optionalString("method") ?? "", params: params.dictionary("params")) { reply($0, nil) }

        case "settings.get":
            sync { try app.settings.load() }
        case "settings.set":
            sync {
                try app.settings.merge(params.dictionary("patch"))
                return nil
            }

        case "history.list":
            sync { app.history.list(path: try params.string("path")) }
        case "history.read":
            sync { try app.history.read(path: try params.string("path"), id: try params.string("id")) }
        case "history.snapshot":
            let history = app.history
            background {
                try history.pin(path: try params.string("path"), data: Data(try params.string("text").utf8))
                return nil
            }
        case "history.deleted":
            let history = app.history
            background { history.deletedFiles() }

        case "draft.save":
            let id = params.optionalString("id") ?? ""
            draftId = id
            let drafts = app.drafts
            background {
                try drafts.save(id: id, text: try params.string("text"))
                return nil
            }
        case "draft.remove":
            let id = params.optionalString("id") ?? ""
            if draftId == id { draftId = nil }
            let drafts = app.drafts
            background {
                try drafts.remove(id: id)
                return nil
            }
        case "draft.pending":
            sync {
                guard let id = pendingDraft else { return nil }
                pendingDraft = nil
                let text = try app.drafts.read(id: id)
                draftId = id
                return ["id": id, "text": text]
            }

        case "export.run":
            let pandocPath = (try? app.settings.load())?["pandocPath"] as? String
            ExportService.run(params: params, pandocPath: pandocPath) { error in
                reply(nil, error?.localizedDescription)
            }
        case "export.print":
            printDocument { reply(nil, nil) }
        case "image.upload":
            background { try ImageUpload.upload(service: params.optionalString("service") ?? "custom", command: params.optionalString("command") ?? "", paths: params.strings("paths")) }
        case "net.download":
            background {
                guard let url = URL(string: try params.string("url")), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { throw BridgeError("只能下载 http / https 网址") }
                try FileDownload.fetch(url, to: try params.string("target"))
                return nil
            }
        case "app.importDocument":
            let pandocPath = (try? app.settings.load())?["pandocPath"] as? String
            background { try ExportService.importWithPandoc(URL(fileURLWithPath: try params.string("path")), pandocPath: pandocPath).path }
        case "system.runCommand":
            background {
                let result = try ShellCommand.run(try params.string("command"), cwd: params.optionalString("cwd"))
                return ["status": Int(result.status), "output": result.output]
            }
        case "system.clearRecent":
            NSDocumentController.shared.clearRecentDocuments(nil)
            reply(nil, nil)
        case "system.setSpellingLanguage":
            sync {
                let language = try params.string("language")
                let checker = NSSpellChecker.shared
                checker.automaticallyIdentifiesLanguages = language == "auto"
                if language != "auto", !checker.setLanguage(language) { throw BridgeError("系统没有「\(language)」的拼写词典") }
                return nil
            }
        case "menu.setKeys":
            sync {
                var overrides: [String: String] = [:]
                for entry in (params.raw["overrides"] as? [[String: Any]]) ?? [] {
                    guard let id = entry["id"] as? String, let key = entry["key"] as? String else { throw BridgeError("菜单键位参数格式错误") }
                    overrides[id] = key
                }
                try MenuCustomizer.shared.applyKeys(overrides)
                return nil
            }
        case "menu.setExportItems":
            sync {
                let items = ((params.raw["items"] as? [[String: Any]]) ?? []).compactMap { entry -> (id: String, name: String)? in
                    guard let id = entry["id"] as? String else { return nil }
                    return (id, entry["name"] as? String ?? "")
                }
                MenuCustomizer.shared.setExportItems(items)
                return nil
            }

        // 剪贴板、复制为图片、右键粘贴、嵌入检测、下载、用「预览」打开(实现见 DocumentWindowController+Media.swift)
        case "clipboard.write":
            sync {
                try writeClipboard(text: try params.string("text"), html: params.optionalString("html"), rtf: params.bool("rtf"))
                return nil
            }
        case "clipboard.readText":
            sync { NSPasteboard.general.string(forType: .string) ?? "" }
        case "clipboard.snapshot":
            snapshotToClipboard(params, reply: reply)
        case "edit.paste":
            reply(nil, nil)
            _ = NSApp.sendAction(#selector(NSText.paste(_:)), to: webView, from: nil)
        case "net.checkEmbed":
            guard let url = URL(string: params.optionalString("url") ?? ""), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
                reply(nil, "网址无效")
                return
            }
            EmbedPolicy.check(url) { result in
                DispatchQueue.main.async { reply(result.rawValue, nil) }
            }
        case "net.download":
            download(params, reply: reply)
        case "system.openInPreview":
            openInPreview(params, reply: reply)

        default:
            reply(nil, "未知桥接方法:\(method)")
        }
    }

    // ---------- 对话框 ----------

    private func contentTypes(_ exts: [String]) -> [UTType] {
        exts.compactMap { UTType(filenameExtension: $0) }
    }

    private func showOpenDialog(_ params: Params, reply: @escaping (Any?, String?) -> Void) {
        let panel = NSOpenPanel()
        let directory = params.bool("directory")
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        panel.allowsMultipleSelection = params.bool("multiple")
        let exts = params.strings("extensions")
        if !exts.isEmpty { panel.allowedContentTypes = contentTypes(exts) }
        guard let window else {
            reply(nil, "窗口不可用")
            return
        }
        panel.beginSheetModal(for: window) { response in
            reply(response == .OK ? panel.urls.map(\.path) : nil, nil)
        }
    }

    private func showSaveDialog(_ params: Params, reply: @escaping (Any?, String?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = params.optionalString("defaultName") ?? "未命名.md"
        let exts = params.strings("extensions")
        if !exts.isEmpty { panel.allowedContentTypes = contentTypes(exts) }
        panel.canCreateDirectories = true
        if let path = currentPath { panel.directoryURL = URL(fileURLWithPath: (path as NSString).deletingLastPathComponent) }
        guard let window else {
            reply(nil, "窗口不可用")
            return
        }
        panel.beginSheetModal(for: window) { response in
            reply(response == .OK ? panel.url?.path : nil, nil)
        }
    }

    private func showConfirm(_ params: Params, reply: @escaping (Any?, String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = params.optionalString("title") ?? ""
        alert.informativeText = params.optionalString("message") ?? ""
        switch params.optionalString("style") {
        case "warning": alert.alertStyle = .warning
        case "critical": alert.alertStyle = .critical
        default: alert.alertStyle = .informational
        }
        for title in params.strings("buttons") { alert.addButton(withTitle: title) }
        guard let window else {
            reply(alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue, nil)
            return
        }
        alert.beginSheetModal(for: window) { response in
            reply(response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue, nil)
        }
    }

    /// 打开方式…(对照表 S-14):选一个应用打开文件
    private func chooseAppAndOpen(_ path: String) {
        guard let window else { return }
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.allowedContentTypes = [.application]
        panel.canChooseDirectories = false
        panel.message = "选择用来打开「\((path as NSString).lastPathComponent)」的应用"
        panel.prompt = "打开"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let app = panel.url else { return }
            NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                guard let error else { return }
                DispatchQueue.main.async { NSAlert(error: error).runModal() }
            }
        }
    }

    /// 系统打印;纸张沿用「页面设置…」的选择。打印面板关闭后才回调(网页要等它恢复主题)。
    private func printDocument(_ completion: @escaping () -> Void) {
        guard let window else {
            completion()
            return
        }
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.topMargin = 40
        info.bottomMargin = 40
        info.leftMargin = 40
        info.rightMargin = 40
        let op = webView.printOperation(with: info)
        op.view?.frame = webView.bounds
        printCompletion = completion
        op.runModal(for: window, delegate: self, didRun: #selector(printOperationDidRun(_:success:contextInfo:)), contextInfo: nil)
    }

    @objc private func printOperationDidRun(_ op: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        printCompletion?()
        printCompletion = nil
    }

    // ---------- 按窗口状态启用的菜单项 ----------

    @objc func windowMenuCommand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        sendCommand(id)
    }

    // ---------- 窗口 ----------

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose || !sender.isDocumentEdited { return true }
        prepareClose(reason: "close") { [weak self] ok in
            guard ok, let self else { return }
            self.allowClose = true
            self.window?.close()
        }
        return false
    }

    func windowWillClose(_ notification: Notification) {
        app.windowClosed(self)
    }

    // ---------- 导航与网页弹窗 ----------

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else {
            decisionHandler(.cancel)
            return
        }
        let isMainFrame = action.targetFrame?.isMainFrame ?? true
        if url.scheme == TypozaSchemeHandler.scheme || !isMainFrame || url.scheme == "about" || url.scheme == "blob" {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        // 主框架要跳到别处:本机 Markdown 在 Typoza 里打开(本窗口组的新标签),其它交给系统
        if url.isFileURL {
            if FileService.isTextDocument(url.path) || FileService.isTextBundle(url.path) {
                app.open(path: url.path, isDir: false, newWindow: true, tabOf: window)
            } else {
                NSWorkspace.shared.open(url)
            }
        } else if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        alert.window.initialFirstResponder = field
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        app.mark("navigationStarted")
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        app.mark("navigationCommitted")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        app.mark("navigationFinished")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // 网页进程崩溃:重新载入。有路径的文档自动保存已落盘;未命名文档从草稿恢复(停止输入 1 秒后备份过)
        NSLog("Typoza 网页进程意外退出,重新载入:%@", currentPath ?? "未命名")
        ready = false
        if let path = currentPath { openRequest = (path, false) } else if let id = draftId { pendingDraft = id }
        webView.load(URLRequest(url: TypozaSchemeHandler.appURL("index.html")))
    }

    // ---------- 冒烟自检(CI) ----------

    private func runSmoke() {
        guard let out = smokeOut else { return }
        let readySeconds = ProcessInfo.processInfo.systemUptime - app.launchUptime
        webView.callAsyncJavaScript("return await window.typoza.smoke()", arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            var report: [String: Any] = ["readySeconds": readySeconds, "launchMarks": self.app.launchMarks, "launchEpochMs": self.app.launchEpochMs]
            if let preMain = self.app.preMainSeconds { report["preMainSeconds"] = preMain }
            switch result {
            case .success(let value): report["result"] = value
            case .failure(let error): report["error"] = "页面自检失败:\(error)"
            }
            // 等灯箱动画结束再截图
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                self.webView.takeSnapshot(with: nil) { image, error in
                    do {
                        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
                        if let image {
                            try SmokeReport.writePNG(image, to: out.appendingPathComponent("smoke.png"))
                        } else {
                            report["snapshotError"] = "截图失败:\(String(describing: error))"
                        }
                    } catch {
                        report["snapshotError"] = "截图写入失败:\(error)"
                    }
                    self.writeSmokeAndExit(report, to: out, code: 0)
                }
            }
        }
    }

    private func writeSmokeAndExit(_ report: [String: Any], to out: URL, code: Int32) {
        do {
            try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
            try SmokeReport.writeJSON(report, to: out.appendingPathComponent("smoke.json"))
        } catch {
            FileHandle.standardError.write("写冒烟报告失败:\(error)\n".data(using: .utf8)!)
            exit(2)
        }
        exit(code)
    }
}

extension DocumentWindowController: NSMenuItemValidation {
    /// 「使用上一次设置导出」「导出并覆盖上一次导出的文件」:这篇文档没导出过时置灰(对照表 F-37)
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(windowMenuCommand(_:)) { return hasLastExport }
        return true
    }
}
