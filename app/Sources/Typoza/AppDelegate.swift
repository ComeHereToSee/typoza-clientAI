import AppKit
import PDFKit
import TypozaKit
import WebKit

/// 应用主控:窗口(一个窗口一个文档)、菜单、最近文件、退出确认。
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let launchUptime: TimeInterval
    let smokeOut: URL?
    let settings = SettingsStore()
    let history = HistoryStore()
    let drafts = DraftStore()
    let helper = HelperManager()
    private(set) var windows: [DocumentWindowController] = []
    private var closedPaths: [String] = []
    private let recentMenu = NSMenu(title: "打开最近文件")
    private let recentFoldersMenu = NSMenu(title: "最近使用的目录")
    private let servicesMenu = NSMenu(title: "服务")
    private var appearanceObservation: NSKeyValueObservation?
    private var keyMonitor: Any?
    /// 首次启动打开欢迎文档(对照表 H-06)
    private static let welcomeShownKey = "TypozaWelcomeShown"

    /// 启动各阶段相对进程起点的秒数(冒烟报告里分析冷启动用)
    private(set) var launchMarks: [String: Double] = [:]

    /// 进程创建到 main 开始执行的秒数(动态库加载等);取不到时为 nil
    var preMainSeconds: Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        let startMs = Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
        return ((launchEpochMs - startMs) / 1000 * 1000).rounded() / 1000
    }

    func mark(_ name: String) {
        guard launchMarks[name] == nil else { return }
        launchMarks[name] = ((ProcessInfo.processInfo.systemUptime - launchUptime) * 1000).rounded() / 1000
    }

    let launchEpochMs: Double

    init(launchUptime: TimeInterval, launchEpochMs: Double) {
        self.launchUptime = launchUptime
        self.launchEpochMs = launchEpochMs
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--smoke-out"), i + 1 < args.count {
            smokeOut = URL(fileURLWithPath: args[i + 1], isDirectory: true)
        } else {
            smokeOut = nil
        }
        super.init()
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        mark("willFinishLaunching")
        recentMenu.delegate = self
        recentFoldersMenu.delegate = self
        NSApp.mainMenu = MainMenu.build(recentMenu: recentMenu, recentFoldersMenu: recentFoldersMenu, servicesMenu: servicesMenu, windowMenu: NSMenu(title: "窗口"), helpMenu: NSMenu(title: "帮助"))
        NSApp.windowsMenu = NSApp.mainMenu?.item(withTitle: "窗口")?.submenu
        NSApp.helpMenu = NSApp.mainMenu?.item(withTitle: "帮助")?.submenu
        // 应用菜单「服务」子菜单由系统填充(对照表 A-05)
        NSApp.servicesMenu = servicesMenu
        NSWindow.allowsAutomaticWindowTabbing = true
        // 首个窗口在这里就建,不等 didFinishLaunching:网页进程的启动与 AppKit 余下的启动并行,冷启动约快 0.15 秒。
        // 随后 Finder 传来的文件(application(_:open:))会直接用这个空白窗口打开。
        let paths = commandLinePaths()
        if paths.isEmpty {
            let first = newWindow(open: nil)
            if smokeOut == nil { restoreDrafts(into: first) }
        } else {
            for (path, isDir) in paths { open(path: path, isDir: isDir, newWindow: true) }
            if smokeOut == nil { restoreDrafts(into: nil) }
        }
    }

    /// 上次没保存的新文档(退出、崩溃或强退时留下的草稿)恢复到标签里(PRD 3.1 未命名草稿)
    private func restoreDrafts(into first: DocumentWindowController?) {
        var ids = drafts.list()[...]
        guard !ids.isEmpty else { return }
        if let first, first.isBlank { first.pendingDraft = ids.removeFirst() }
        let parent = first?.window ?? windows.first?.window
        for id in ids { newWindow(open: nil, asTabOf: parent).pendingDraft = id }
    }

    /// 文件菜单「恢复未保存的草稿」(对照表 PF-06):没在任何标签里的草稿都开出来;没有就打开草稿文件夹
    private func recoverDrafts() {
        let inUse = Set(windows.compactMap { $0.draftId ?? $0.pendingDraft })
        let orphans = drafts.list().filter { !inUse.contains($0) }
        guard orphans.isEmpty else {
            let parent = NSApp.keyWindow
            for id in orphans { newWindow(open: nil, asTabOf: parent).pendingDraft = id }
            return
        }
        do {
            try FileManager.default.createDirectory(at: drafts.directory, withIntermediateDirectories: true)
            NSWorkspace.shared.open(drafts.directory)
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// 命令行直接传入的文件(开发调试用):typoza <路径>;--smoke-out 后面的输出目录不算
    private func commandLinePaths() -> [(String, Bool)] {
        var args = Array(CommandLine.arguments.dropFirst())
        if let i = args.firstIndex(of: "--smoke-out") { args.removeSubrange(i ..< min(i + 2, args.count)) }
        return args.compactMap { arg in
            var isDir: ObjCBool = false
            guard !arg.hasPrefix("-"), FileManager.default.fileExists(atPath: arg, isDirectory: &isDir) else { return nil }
            return (arg, isDir.boolValue)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        mark("didFinishLaunching")
        helper.broadcast = { [weak self] event, payload in
            self?.windows.forEach { $0.emit(event, payload) }
        }
        if smokeOut == nil { helper.startIfConfigured() }
        appearanceObservation = NSApp.observe(\.effectiveAppearance) { [weak self] app, _ in
            let dark = app.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            self?.windows.forEach { $0.emit("app.appearance", ["dark": dark]) }
        }
        // ⇧⌘O 是快速打开的 Typora 别名(notion 5.2「快速打开 ⌘P(另 ⇧⌘O)」):一个菜单项只能挂一个键,别名在这里接
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard mods == [.command, .shift], event.charactersIgnoringModifiers?.lowercased() == "o", let self else { return event }
            if let key = self.keyController { key.sendCommand("file.quickOpen") } else { self.newWindow(open: nil).sendCommandWhenReady("file.quickOpen") }
            return nil
        }
        if smokeOut == nil { showWelcomeOnFirstLaunch() }
        NSApp.activate(ignoringOtherApps: true)
        mark("didFinishLaunchingEnd")
    }

    var isDark: Bool {
        NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    // Finder 双击、拖到 Dock 图标:有空白窗口就用它,否则开新窗口
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            open(path: url.path, isDir: isDir.boolValue, newWindow: false)
        }
    }

    /// 偏好「所有窗口被关闭后自动退出」(PG-01,默认关);冒烟自检由自检流程自己退出
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        guard smokeOut == nil else { return false }
        return quitsAfterLastWindowClosed()
    }

    private func quitsAfterLastWindowClosed() -> Bool {
        do {
            return (try settings.load()["quitOnLastWindowClosed"] as? Bool) ?? false
        } catch {
            NSLog("Typoza:读取偏好设置失败,关闭最后一个窗口后不退出:%@", "\(error)")
            return false
        }
    }

    /// 不自动退出时可能一个窗口都没有:点程序坞图标开一个新窗口
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag && windows.isEmpty { newWindow(open: nil) }
        return true
    }

    // ---------- 窗口 ----------

    @discardableResult
    func newWindow(open: (String, Bool)?, asTabOf parent: NSWindow? = nil) -> DocumentWindowController {
        let controller = DocumentWindowController(app: self, open: open, smokeOut: windows.isEmpty ? smokeOut : nil)
        windows.append(controller)
        if let parent, let window = controller.window {
            parent.addTabbedWindow(window, ordered: .above)
        }
        controller.showWindow(nil)
        if let path = open?.0 { noteRecent(path) }
        return controller
    }

    func windowClosed(_ controller: DocumentWindowController) {
        if let path = controller.currentPath { closedPaths.append(path) }
        windows.removeAll { $0 === controller }
    }

    /// 打开文件:已在某个窗口里打开就切过去;当前窗口是空白新文档就直接用它;否则开新窗口(给了 tabOf 就开成它的标签)。
    /// TextBundle 是文件夹包,按文档打开(对照表 X-53)。
    func open(path: String, isDir: Bool, newWindow forceNew: Bool, tabOf parent: NSWindow? = nil) {
        guard FileManager.default.fileExists(atPath: path) else {
            showAlert("目标文件或文件夹不存在。", path)
            return
        }
        let asDocument = !isDir || FileService.isTextBundle(path)
        if asDocument, let existing = windows.first(where: { $0.isShowing(path) }) {
            existing.window?.makeKeyAndOrderFront(nil)
            return
        }
        if !forceNew, let key = keyController, key.isBlank {
            key.load(path: path, isDir: !asDocument)
            if asDocument { noteRecent(path) }
            return
        }
        newWindow(open: (path, !asDocument), asTabOf: parent)
    }

    /// 同一文件只开一处:别的窗口或标签已在编辑 path 时切过去并返回 true(PRD 3.1)
    func focus(path: String, except controller: DocumentWindowController) -> Bool {
        guard let other = windows.first(where: { $0 !== controller && $0.isShowing(path) }) else { return false }
        other.window?.makeKeyAndOrderFront(nil)
        return true
    }

    private func showAlert(_ title: String, _ message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.runModal()
    }

    var keyController: DocumentWindowController? {
        windows.first { $0.window === NSApp.keyWindow } ?? windows.last
    }

    func noteRecent(_ path: String) {
        // 偏好「通用 ▸ 记录打开过的文件」关掉时不进最近使用列表(PF-07)
        if (try? settings.load())?["recordRecent"] as? Bool == false { return }
        NSDocumentController.shared.noteNewRecentDocumentURL(URL(fileURLWithPath: path))
    }

    // ---------- 菜单 ----------

    @objc func menuCommand(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        switch id {
        case "native.newWindow":
            newWindow(open: nil)
        case "native.newTab":
            newWindow(open: nil, asTabOf: NSApp.keyWindow)
        case "native.open":
            showOpenPanel()
        case "native.reopenClosed":
            if let path = closedPaths.popLast() { open(path: path, isDir: false, newWindow: true) }
        case "native.saveAll":
            windows.forEach { $0.sendCommand("file.save") }
        case "native.alwaysOnTop":
            if let window = NSApp.keyWindow {
                window.level = window.level == .floating ? .normal : .floating
                sender.state = window.level == .floating ? .on : .off
            }
        case "native.import":
            showImportPanel()
        case "native.welcome":
            openWelcome(reuseBlank: false)
        case "native.recoverDrafts":
            recoverDrafts()
        case "native.checkUpdates":
            checkForUpdates()
        case "native.website", "native.feedback":
            if let url = Self.configuredURL(id == "native.website" ? "TypozaWebsiteURL" : "TypozaFeedbackURL") { NSWorkspace.shared.open(url) }
        case let help where help.hasPrefix("native.help."):
            openHelpDoc(String(help.dropFirst("native.help.".count)))
        default:
            if let key = keyController {
                key.sendCommand(id)
            } else {
                newWindow(open: nil).sendCommandWhenReady(id)
            }
        }
    }

    private func showOpenPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.message = "选择 Markdown 文件或文件夹"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            open(path: url.path, isDir: isDir.boolValue, newWindow: false)
        }
    }

    /// 导入(Typora):用 Pandoc 把 Word / HTML / EPUB 等转成 Markdown,存在原文件旁边后打开。
    private func showImportPanel() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.message = "选择要导入的文件(需要已安装 Pandoc)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let target = try ExportService.importWithPandoc(url, pandocPath: (try? settings.load())?["pandocPath"] as? String)
            open(path: target.path, isDir: false, newWindow: true)
        } catch let error as BridgeError where error.message == ExportService.pandocMissingForImport {
            // 没装 Pandoc:与网页端导出一致,给【安装说明】(PRD 3.12)
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = error.message
            alert.addButton(withTitle: "安装说明")
            alert.addButton(withTitle: "好")
            if alert.runModal() == .alertFirstButtonReturn, let install = URL(string: "https://pandoc.org/installing.html") {
                NSWorkspace.shared.open(install)
            }
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// 欢迎向导(对照表 H-06):首次启动自动打开「快速上手」,之后不再自动打开
    private func showWelcomeOnFirstLaunch() {
        guard !UserDefaults.standard.bool(forKey: Self.welcomeShownKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.welcomeShownKey)
        openWelcome(reuseBlank: true)
    }

    private func openWelcome(reuseBlank: Bool) {
        guard let url = Bundle.main.resourceURL?.appendingPathComponent("editor/welcome.md"), FileManager.default.fileExists(atPath: url.path) else { return }
        let dir = AppPaths.support.appendingPathComponent("welcome", isDirectory: true)
        let target = dir.appendingPathComponent("快速上手.md")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: target.path) { try FileManager.default.copyItem(at: url, to: target) }
            open(path: target.path, isDir: false, newWindow: !reuseBlank)
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// 帮助菜单的文档(对照表 H-01、H-03~H-05、H-07):随应用打包在 editor/ 下。
    /// 每次打开都换成应用自带的最新版并设为只读,改了也存不回去,输入时会提示只读。
    static let helpDocs: [String: (file: String, title: String)] = [
        "changelog": ("changelog.md", "更新日志"),
        "markdown": ("markdown-reference.md", "Markdown 参考"),
        "pandoc": ("pandoc.md", "安装与使用 Pandoc"),
        "images": ("images.md", "使用图片"),
        "acknowledgements": ("acknowledgements.md", "鸣谢"),
        "privacy": ("privacy.md", "隐私条款"),
    ]

    private func openHelpDoc(_ key: String) {
        guard let doc = Self.helpDocs[key] else {
            showAlert("找不到帮助文档", key)
            return
        }
        guard let source = Bundle.main.resourceURL?.appendingPathComponent("editor/\(doc.file)"), FileManager.default.fileExists(atPath: source.path) else {
            showAlert("找不到帮助文档", doc.file)
            return
        }
        let dir = AppPaths.support.appendingPathComponent("help", isDirectory: true)
        let target = dir.appendingPathComponent("\(doc.title).md")
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            if windows.contains(where: { $0.isShowing(target.path) }) {
                open(path: target.path, isDir: false, newWindow: true)
                return
            }
            if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
            try FileManager.default.copyItem(at: source, to: target)
            try FileManager.default.setAttributes([.posixPermissions: 0o444], ofItemAtPath: target.path)
            open(path: target.path, isDir: false, newWindow: true)
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    /// Info.plist 里配置的网址(官网、反馈);没有真实地址时不配置,对应菜单项置灰【待确认:官网与反馈地址】
    static func configuredURL(_ key: String) -> URL? {
        guard let text = Bundle.main.object(forInfoDictionaryKey: key) as? String, let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }

    /// 检查更新(对照表 A-04):更新源地址写在 Info.plist 的 TypozaUpdateFeedURL;没配置时如实说明无法在线检查。
    private func checkForUpdates() {
        let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        guard let feed = Self.configuredURL("TypozaUpdateFeedURL") else {
            showAlert("无法检查更新", "这个版本还没有接入更新服务,暂时不能在线检查。当前版本 \(current)。")
            return
        }
        let request = URLRequest(url: feed, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                if let error {
                    self.showAlert("检查更新失败", error.localizedDescription)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard let data, status == 200 else {
                    self.showAlert("检查更新失败", "更新服务返回异常(HTTP \(status))")
                    return
                }
                do {
                    let release = try UpdateCheck.parse(data)
                    guard UpdateCheck.isNewer(release.version, than: current) else {
                        self.showAlert("当前已是最新!", "当前版本 \(current)。")
                        return
                    }
                    let alert = NSAlert()
                    alert.messageText = "发现新版本 \(release.version)"
                    alert.informativeText = release.notes.isEmpty ? "当前版本 \(current)。" : release.notes
                    alert.addButton(withTitle: "下载")
                    alert.addButton(withTitle: "以后再说")
                    if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(release.url) }
                } catch {
                    self.showAlert("检查更新失败", error.localizedDescription)
                }
            }
        }.resume()
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        if menu === recentFoldersMenu {
            buildRecentFoldersMenu(menu)
            return
        }
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        for url in NSDocumentController.shared.recentDocumentURLs {
            let item = NSMenuItem(title: url.lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "")
            item.representedObject = url.path
            item.toolTip = url.path
            item.target = self
            menu.addItem(item)
        }
        if menu.items.isEmpty {
            menu.addItem(NSMenuItem(title: "空", action: nil, keyEquivalent: ""))
        }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "清除最近文件", action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    /// 最近使用的目录(对照表 F-06、S-18):固定的在前。列表由网页写进偏好设置(recentFolders、pinnedFolders)。
    private func buildRecentFoldersMenu(_ menu: NSMenu) {
        menu.removeAllItems()
        let stored: [String: Any]
        do {
            stored = try settings.load()
        } catch {
            menu.addItem(NSMenuItem(title: "读取失败:\(error.localizedDescription)", action: nil, keyEquivalent: ""))
            return
        }
        let pinned = stored["pinnedFolders"] as? [String] ?? []
        let recent = (stored["recentFolders"] as? [String] ?? []).filter { !pinned.contains($0) }
        let add = { (path: String, isPinned: Bool) in
            let item = NSMenuItem(title: (path as NSString).lastPathComponent, action: #selector(self.openRecentFolder(_:)), keyEquivalent: "")
            item.representedObject = path
            item.toolTip = path
            item.target = self
            if isPinned { item.state = .on }
            menu.addItem(item)
        }
        pinned.forEach { add($0, true) }
        if !pinned.isEmpty && !recent.isEmpty { menu.addItem(.separator()) }
        recent.forEach { add($0, false) }
        if menu.items.isEmpty { menu.addItem(NSMenuItem(title: "空", action: nil, keyEquivalent: "")) }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "清除最近使用的目录", action: #selector(clearRecentFolders(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    @objc private func openRecentFolder(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        guard FileManager.default.fileExists(atPath: path) else {
            showAlert("目标文件或文件夹不存在。", path)
            return
        }
        if let key = keyController {
            key.load(path: path, isDir: true)
            key.window?.makeKeyAndOrderFront(nil)
        } else {
            newWindow(open: (path, true))
        }
    }

    @objc private func clearRecentFolders(_ sender: NSMenuItem) {
        do {
            try settings.merge(["recentFolders": [String]()])
        } catch {
            NSAlert(error: error).runModal()
        }
    }

    @objc private func openRecent(_ sender: NSMenuItem) {
        guard let path = sender.representedObject as? String else { return }
        open(path: path, isDir: false, newWindow: false)
    }

    @objc private func clearRecent(_ sender: NSMenuItem) {
        NSDocumentController.shared.clearRecentDocuments(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        helper.stop()
    }

    // ---------- 退出:逐个窗口确认未保存的修改 ----------

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let edited = windows.filter { $0.window?.isDocumentEdited == true }
        if edited.isEmpty || smokeOut != nil { return .terminateNow }
        confirmSequentially(edited) { ok in
            NSApp.reply(toApplicationShouldTerminate: ok)
        }
        return .terminateLater
    }

    private func confirmSequentially(_ list: [DocumentWindowController], completion: @escaping (Bool) -> Void) {
        guard let first = list.first else {
            completion(true)
            return
        }
        first.window?.makeKeyAndOrderFront(nil)
        first.prepareClose(reason: "quit") { ok in
            if !ok {
                completion(false)
                return
            }
            self.confirmSequentially(Array(list.dropFirst()), completion: completion)
        }
    }
}

// 官网、反馈没有配置地址时菜单项置灰,不放假链接
extension AppDelegate: NSMenuItemValidation {
    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.representedObject as? String {
        case "native.website": return Self.configuredURL("TypozaWebsiteURL") != nil
        case "native.feedback": return Self.configuredURL("TypozaFeedbackURL") != nil
        default: return true
        }
    }
}

// ---------- 冒烟:外壳行为自检(对照表 F-05、F-06、F-07、F-17、V-15、H-06) ----------

extension AppDelegate {
    /// 页面自检之后在真应用里走一遍只有外壳才有的行为,每项给 true / false;任何一步超时记为 false 并继续
    func runNativeSmoke(main: DocumentWindowController, completion: @escaping ([String: Any]) -> Void) {
        var checks: [String: Any] = [:]
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("typoza-native-\(UUID().uuidString)", isDirectory: true)
        let file = dir.appendingPathComponent("外壳自检.md").path
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try "# 外壳自检\n\n正文。\n".write(toFile: file, atomically: true, encoding: .utf8)
        } catch {
            completion(["error": "准备临时文件失败:\(error)"])
            return
        }
        let real = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
        let command = { (id: String) in
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.representedObject = id
            self.menuCommand(item)
        }

        // F-05 最近文件:记一笔后「打开最近文件」菜单里有它
        noteRecent(file)
        menuNeedsUpdate(recentMenu)
        checks["recentFile"] = recentMenu.items.contains { ($0.representedObject as? String).map(real) == real(file) }

        // F-06 最近使用的目录:列表在偏好里,菜单按它生成;测完恢复原值
        let savedFolders = (try? settings.load())?["recentFolders"] ?? [String]()
        try? settings.merge(["recentFolders": [dir.path]])
        buildRecentFoldersMenu(recentFoldersMenu)
        checks["recentFolder"] = recentFoldersMenu.items.contains { ($0.representedObject as? String) == dir.path }
        try? settings.merge(["recentFolders": savedFolders])

        // V-15 保持窗口在最前端:菜单命令切换当前窗口的层级,再切回
        // 菜单命令作用于当前窗口:先把应用调到前台、等主窗口真成为当前窗口(导出等步骤之后系统可能把焦点给了别处)
        bringToFront(main.window) { _ in
            command("native.alwaysOnTop")
            checks["alwaysOnTop"] = main.window?.level == .floating
            command("native.alwaysOnTop")
            checks["alwaysOnTopOff"] = main.window?.level == .normal

            // F-07 重新打开关闭的文件:开一个窗口、关掉、再用菜单命令打开
            self.open(path: file, isDir: false, newWindow: true)
            self.waitUntil(15, { self.windows.contains { $0.isShowing(file) } }) { opened in
                guard opened, let first = self.windows.first(where: { $0.isShowing(file) }) else {
                    checks["reopenClosed"] = false
                    checks["saveAll"] = false
                    return self.welcomeSmoke(main, checks, completion)
                }
                first.window?.performClose(nil)
                self.waitUntil(5, { !self.windows.contains { $0.isShowing(file) } }) { _ in
                    command("native.reopenClosed")
                    self.waitUntil(15, { self.windows.contains { $0.isShowing(file) } }) { reopened in
                        checks["reopenClosed"] = reopened
                        guard reopened, let again = self.windows.first(where: { $0.isShowing(file) }) else {
                            checks["saveAll"] = false
                            return self.welcomeSmoke(main, checks, completion)
                        }
                        // F-17 全部保存:在这个窗口里打字(未保存),用菜单命令保存全部,文件里出现新字
                        let typing = "(() => { const pm = document.querySelector('.ProseMirror'); pm.focus(); const s = getSelection(); s.selectAllChildren(pm); s.collapseToEnd(); return document.execCommand('insertText', false, '全部保存自检') })()"
                        again.webView.evaluateJavaScript(typing) { _, _ in
                            self.waitUntil(5, { again.window?.isDocumentEdited == true }) { _ in
                                command("native.saveAll")
                                self.waitUntil(10, { ((try? String(contentsOfFile: file, encoding: .utf8)) ?? "").contains("全部保存自检") }) { saved in
                                    checks["saveAll"] = saved
                                    self.welcomeSmoke(main, checks, completion)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// H-06 欢迎向导:首次启动打开的「快速上手」(冒烟时跳过首次启动流程,这里直接走一遍打开)
    private func welcomeSmoke(_ main: DocumentWindowController, _ checks: [String: Any], _ completion: @escaping ([String: Any]) -> Void) {
        var checks = checks
        let target = AppPaths.support.appendingPathComponent("welcome/快速上手.md").path
        openWelcome(reuseBlank: false)
        waitUntil(15, { self.windows.contains { $0.isShowing(target) } }) { shown in
            checks["welcome"] = shown
            self.moreNativeSmoke(main, checks, completion)
        }
    }

    /// 外壳自检第二段(对照表 C-05、E-03、E-09、E-15、E-17、E-18、F-01 ~ F-03、F-05、F-06、H-01、H-03、H-04、H-06、H-07、PF-06、PG-01、PX-04、PX-06、X-55),逐项按顺序跑。
    /// 网页侧冒烟(smoke.ts)已导出好 PDF / PNG、把动图拷进剪贴板,这里读回核对。
    private func moreNativeSmoke(_ main: DocumentWindowController, _ checks: [String: Any], _ completion: @escaping ([String: Any]) -> Void) {
        var checks = checks
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("typoza-native2-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let exports = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches/app.typoza.mac/smoke/out")
        let real = { (path: String) in URL(fileURLWithPath: path).resolvingSymlinksInPath().path }
        let command = { (id: String) in
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.representedObject = id
            self.menuCommand(item)
        }
        var steps: [(@escaping ([String: Bool]) -> Void) -> Void] = []

        // E-03 拷贝图片:网页冒烟对动图执行了「拷贝图片」,系统剪贴板里应有图像数据与文件地址
        steps.append { done in
            let pb = NSPasteboard.general
            let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] ?? []
            done(["copyImage": NSImage(pasteboard: pb) != nil && urls.contains { $0.lastPathComponent == "anim.gif" }])
        }

        // C-05 复制为图片:按网页给的区域截图放进系统剪贴板(公式、图表右键「复制为图片」走这条路)
        steps.append { done in
            NSPasteboard.general.clearContents()
            main.snapshotToClipboard(Params(["x": 0, "y": 0, "width": 200, "height": 120])) { _, error in
                let image = NSImage(pasteboard: .general)
                done(["copyRegionAsImage": error == nil && (image?.size.width ?? 0) >= 199])
            }
        }

        // PX-04 PDF:A5(148 × 210 毫米 = 419.5 × 595.3 点),每页页首「页首 <页码>」
        steps.append { done in
            guard let doc = PDFDocument(url: exports.appendingPathComponent("smoke-pdf.pdf")), let page = doc.page(at: 0) else { return done(["exportPdf": false]) }
            let box = page.bounds(for: .mediaBox)
            let a5 = abs(box.width - 419.53) < 1.5 && abs(box.height - 595.28) < 1.5
            done(["exportPdf": a5 && page.annotations.contains { $0.contents == "页首 1" }])
        }

        // PX-06 图片:宽 600、质量「高」(每个 CSS 像素 2 个图片像素)→ 1200 像素宽
        steps.append { done in
            let rep = (try? Data(contentsOf: exports.appendingPathComponent("smoke-image.png"))).flatMap { NSBitmapImageRep(data: $0) }
            done(["exportPng": rep?.pixelsWide == 1200])
        }

        // F-01 / F-03 新建(⌘N、⇧⌘N 同一命令):多一个独立的空白窗口;测完关掉
        steps.append { done in
            let before = self.windows.count
            command("native.newWindow")
            guard self.windows.count == before + 1, let created = self.windows.last else { return done(["newWindow": false]) }
            self.waitUntil(15, { created.isLoaded }) { loaded in
                let ok = loaded && created.isBlank && created.window?.isVisible == true && (created.window?.tabbedWindows?.count ?? 1) == 1
                created.window?.performClose(nil)
                self.waitUntil(10, { !self.windows.contains { $0 === created } }) { closed in done(["newWindow": ok && closed]) }
            }
        }

        // F-02 新建标签页:当前窗口的标签多一个空白文档;测完关掉
        steps.append { done in
            guard let parent = main.window else { return done(["newTab": false]) }
            self.bringToFront(parent) { _ in
                let before = parent.tabbedWindows?.count ?? 1
                command("native.newTab")
                guard let created = self.windows.last, created !== main else { return done(["newTab": false]) }
                self.waitUntil(15, { created.isLoaded }) { loaded in
                    let ok = loaded && created.isBlank && (parent.tabbedWindows?.count ?? 1) == before + 1
                    created.window?.performClose(nil)
                    self.waitUntil(10, { !self.windows.contains { $0 === created } }) { closed in done(["newTab": ok && closed]) }
                }
            }
        }

        // F-05 清除最近文件:菜单只剩「空」与「清除最近文件」
        steps.append { done in
            self.clearRecent(NSMenuItem())
            self.menuNeedsUpdate(self.recentMenu)
            done(["clearRecent": self.recentMenu.items.filter { !$0.isSeparatorItem }.map(\.title) == ["空", "清除最近文件"]])
        }

        // F-06 / S-18 固定的目录排在前面并打勾;「清除最近使用的目录」只清最近、不动固定;测完恢复原值
        steps.append { done in
            let saved = (try? self.settings.load()) ?? [:]
            let pinned = dir.appendingPathComponent("固定").path
            let recent = dir.appendingPathComponent("最近").path
            try? self.settings.merge(["pinnedFolders": [pinned], "recentFolders": [recent, pinned]])
            self.buildRecentFoldersMenu(self.recentFoldersMenu)
            let rows = self.recentFoldersMenu.items.compactMap { item in (item.representedObject as? String).map { ($0, item.state) } }
            let ordered = rows.map { $0.0 } == [pinned, recent] && rows.first?.1 == .on && rows.last?.1 == .off
            self.clearRecentFolders(NSMenuItem())
            let after = (try? self.settings.load()) ?? [:]
            let cleared = (after["recentFolders"] as? [String])?.isEmpty == true && (after["pinnedFolders"] as? [String]) == [pinned]
            try? self.settings.merge(["pinnedFolders": saved["pinnedFolders"] ?? [String](), "recentFolders": saved["recentFolders"] ?? [String]()])
            done(["pinnedFolders": ordered && cleared])
        }

        // PG-01 所有窗口被关闭后自动退出:按偏好返回(冒烟时委托方法固定不退出,自检要自己写完报告再退出)
        steps.append { done in
            let saved = (try? self.settings.load())?["quitOnLastWindowClosed"] as? Bool ?? false
            try? self.settings.merge(["quitOnLastWindowClosed": true])
            let on = self.quitsAfterLastWindowClosed()
            try? self.settings.merge(["quitOnLastWindowClosed": false])
            let off = self.quitsAfterLastWindowClosed()
            try? self.settings.merge(["quitOnLastWindowClosed": saved])
            done(["quitAfterLastWindow": on && !off])
        }

        // E-15 / E-17 ⌘↑ ⌘↓、E-18 ⌃A ⌃E、E-09 ⌥⇧⌘V:真按键事件,经菜单与网页的完整链路(CI 的网页用例在 Linux 上按不出这些键)
        steps.append { done in
            let names = ["keyLineStart", "keyLineEnd", "keyDocStart", "keyDocEnd", "pasteMatchStyle"]
            let fail = { done(Dictionary(uniqueKeysWithValues: names.map { ($0, false) })) }
            let file = dir.appendingPathComponent("键位自检.md").path
            do { try "# 键位自检\n\n第二段文字内容\n\n末段\n".write(toFile: file, atomically: true, encoding: .utf8) } catch { return fail() }
            self.open(path: file, isDir: false, newWindow: true)
            self.waitUntil(15, { self.windows.contains { $0.isShowing(file) && $0.isLoaded } }) { opened in
                guard opened, let w = self.windows.first(where: { $0.isShowing(file) }), let window = w.window else { return fail() }
                NSApp.activate(ignoringOtherApps: true)
                window.makeKeyAndOrderFront(nil)
                _ = window.makeFirstResponder(w.webView)
                // 只聚焦,光标全用真按键移动(程序里直接设 DOM 选区时编辑器未必跟上)
                let focus = "(() => { const pm = document.querySelector('.ProseMirror'); if (!pm || !pm.querySelector('p')) return false; pm.focus(); return true })()"
                self.waitForScript(w, focus, 15) { focused in
                    guard focused else { return fail() }
                    let key = { (scalar: Int) in String(Character(UnicodeScalar(UInt32(scalar))!)) }
                    let up = key(NSUpArrowFunctionKey)
                    let down = key(NSDownArrowFunctionKey)
                    let right = key(NSRightArrowFunctionKey)
                    let arrow: NSEvent.ModifierFlags = [.numericPad, .function]
                    let cmdArrow: NSEvent.ModifierFlags = [.command, .numericPad, .function]
                    // ⌘↑ 到文首 → ↓ 到第二段段首 → → 三下 → ⌃E 行尾 → ⌃A 行首 → ⌘↓ 文末
                    let presses: [(String, UInt16, String, String, NSEvent.ModifierFlags, String)] = [
                        ("keyDocStart", 126, up, up, cmdArrow, "键位自检|0"),
                        ("keyMoveDown", 125, down, down, arrow, "第二段文字内容|0"),
                        ("keyMoveRight1", 124, right, right, arrow, "第二段文字内容|1"),
                        ("keyMoveRight2", 124, right, right, arrow, "第二段文字内容|2"),
                        ("keyMoveRight3", 124, right, right, arrow, "第二段文字内容|3"),
                        ("keyLineEnd", 14, "\u{05}", "e", [.control], "第二段文字内容|7"),
                        ("keyLineStart", 0, "\u{01}", "a", [.control], "第二段文字内容|0"),
                        ("keyDocEnd", 125, down, down, cmdArrow, "末段|2"),
                    ]
                    var results: [String: Bool] = [:]
                    func pasteCheck() {
                        // 光标在「末段」末尾:⌥⇧⌘V 按纯文字粘贴,Markdown 符号原样留下
                        let pb = NSPasteboard.general
                        pb.clearContents()
                        pb.setString("**粗**", forType: .string)
                        self.sendKey(window, code: 9, chars: "◊", ignoring: "V", mods: [.command, .option, .shift])
                        self.waitForScript(w, "document.querySelector('.tz-editor')?.textContent.includes('末段**粗**') === true", 5) { ok in
                            results["pasteMatchStyle"] = ok
                            done(results)
                        }
                    }
                    func press(_ i: Int) {
                        guard i < presses.count else { return pasteCheck() }
                        let (name, code, chars, ignoring, mods, expected) = presses[i]
                        self.sendKey(window, code: code, chars: chars, ignoring: ignoring, mods: mods)
                        self.waitForScript(w, "\(Self.caretScript) === '\(expected)'", 3) { ok in
                            results[name] = ok
                            press(i + 1)
                        }
                    }
                    press(0)
                }
            }
        }

        // X-55 命令行打开:open -a <应用> <文件> 交给正在运行的本应用打开
        steps.append { done in
            let file = dir.appendingPathComponent("命令行打开.md").path
            do { try "# 命令行打开\n".write(toFile: file, atomically: true, encoding: .utf8) } catch { return done(["openCommandLine": false]) }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            p.arguments = ["-a", Bundle.main.bundlePath, file]
            do { try p.run() } catch { return done(["openCommandLine": false]) }
            self.waitUntil(20, { self.windows.contains { $0.currentPath.map(real) == real(file) } }) { done(["openCommandLine": $0]) }
        }

        // H-01 / H-03 / H-04 / H-07 帮助文档:换成应用自带的最新版并设为只读,开在新窗口;Markdown 参考含 Typoza 新块的存储写法
        steps.append { done in
            let keys = ["changelog", "markdown", "images", "pandoc", "acknowledgements", "privacy"]
            var results: [String: Bool] = [:]
            func openNext(_ i: Int) {
                guard i < keys.count else { return done(results) }
                let key = keys[i]
                guard let doc = Self.helpDocs[key] else {
                    results["help_\(key)"] = false
                    return openNext(i + 1)
                }
                let target = AppPaths.support.appendingPathComponent("help/\(doc.title).md").path
                command("native.help.\(key)")
                self.waitUntil(15, { self.windows.contains { $0.isShowing(target) } }) { shown in
                    var ok = shown && !FileManager.default.isWritableFile(atPath: target)
                    if key == "markdown" { ok = ok && ((try? String(contentsOfFile: target, encoding: .utf8)) ?? "").contains("data-tz-type=\"bookmark\"") }
                    results["help_\(key)"] = ok
                    openNext(i + 1)
                }
            }
            openNext(0)
        }

        // H-07 官方网站、反馈:Info.plist 没配地址时菜单项置灰,配了才可点
        steps.append { done in
            let item = { (id: String) -> NSMenuItem in
                let m = NSMenuItem(title: "", action: #selector(self.menuCommand(_:)), keyEquivalent: "")
                m.representedObject = id
                return m
            }
            let website = self.validateMenuItem(item("native.website")) == (Self.configuredURL("TypozaWebsiteURL") != nil)
            let feedback = self.validateMenuItem(item("native.feedback")) == (Self.configuredURL("TypozaFeedbackURL") != nil)
            done(["linksGreyed": website && feedback])
        }

        // H-06 欢迎向导:没有「已显示」标记时(首次启动)自动打开「快速上手」并记下标记;再走一次不再打开
        steps.append { done in
            let target = AppPaths.support.appendingPathComponent("welcome/快速上手.md").path
            let showing = { self.windows.contains { $0.isShowing(target) } }
            let closeAll = { self.windows.filter { $0.isShowing(target) }.forEach { $0.window?.performClose(nil) } }
            closeAll()
            self.waitUntil(10, { !showing() }) { closed in
                guard closed else { return done(["firstLaunchWelcome": false]) }
                UserDefaults.standard.removeObject(forKey: Self.welcomeShownKey)
                self.showWelcomeOnFirstLaunch()
                self.waitUntil(15, showing) { shown in
                    let marked = UserDefaults.standard.bool(forKey: Self.welcomeShownKey)
                    closeAll()
                    self.waitUntil(10, { !showing() }) { _ in
                        self.showWelcomeOnFirstLaunch()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { done(["firstLaunchWelcome": shown && marked && !showing()]) }
                    }
                }
            }
        }

        // PF-06 恢复未保存的草稿:没在任何标签里的草稿开出来,内容进编辑器(窗口留着:关掉会询问是否保存)
        steps.append { done in
            let id = "smoke-\(UUID().uuidString)"
            do { try self.drafts.save(id: id, text: "草稿自检内容\n") } catch { return done(["recoverDrafts": false]) }
            command("native.recoverDrafts")
            self.waitUntil(15, { self.windows.contains { $0.pendingDraft == id || $0.draftId == id } }) { opened in
                guard opened, let w = self.windows.first(where: { $0.pendingDraft == id || $0.draftId == id }) else {
                    try? self.drafts.remove(id: id)
                    return done(["recoverDrafts": false])
                }
                self.waitForScript(w, "document.querySelector('.tz-editor')?.textContent.includes('草稿自检内容') === true", 15) { shown in
                    try? self.drafts.remove(id: id)
                    done(["recoverDrafts": shown])
                }
            }
        }

        func next(_ i: Int) {
            guard i < steps.count else { return completion(checks) }
            FileHandle.standardError.write(Data("冒烟 外壳第 \(i + 1) / \(steps.count) 项\n".utf8))
            let step = steps[i]
            step { results in
                results.forEach { checks[$0.key] = $0.value }
                DispatchQueue.main.async { next(i + 1) }
            }
        }
        next(0)
    }

    /// 把应用与窗口调到前台,直到它成为当前窗口(最多试 3 次,每次等 2 秒);没成功时把当时的状态记到标准错误
    private func bringToFront(_ window: NSWindow?, attempt: Int = 1, then: @escaping (Bool) -> Void) {
        guard let window else { return then(false) }
        _ = NSRunningApplication.current.activate(options: [.activateAllWindows])
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        waitUntil(2, { NSApp.keyWindow === window }) { ok in
            if ok { return then(true) }
            let key = NSApp.keyWindow.map { "\($0.title)(\(type(of: $0)))" } ?? "无"
            FileHandle.standardError.write(Data("冒烟 调到前台第 \(attempt) 次没成功:应用在前台 \(NSApp.isActive),当前窗口 \(key),窗口数 \(NSApp.windows.count)\n".utf8))
            if attempt >= 3 { return then(false) }
            self.bringToFront(window, attempt: attempt + 1, then: then)
        }
    }

    /// 光标所在块的文字与光标在块内的字符偏移,如「末段|2」
    private static let caretScript = "(() => { const s = getSelection(); if (!s.rangeCount) return ''; const n = s.anchorNode; const el = n.nodeType === 3 ? n.parentElement : n; const block = el && el.closest('h1, p'); if (!block) return ''; const r = document.createRange(); r.setStart(block, 0); r.setEnd(n, s.anchorOffset); return block.textContent + '|' + r.toString().length })()"

    /// 合成一次按键(按下 + 抬起)交给应用分发:先过菜单键位,再到网页
    private func sendKey(_ window: NSWindow, code: UInt16, chars: String, ignoring: String, mods: NSEvent.ModifierFlags) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: ignoring, isARepeat: false, keyCode: code) else { continue }
            NSApp.sendEvent(event)
        }
    }

    /// 每 0.2 秒在网页里求值一次,结果为 true 或超时(秒)后回调
    private func waitForScript(_ controller: DocumentWindowController, _ script: String, _ timeout: TimeInterval, then: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            controller.webView.evaluateJavaScript(script) { value, _ in
                if (value as? Bool) == true { return then(true) }
                if Date() >= deadline { return then(false) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: poll)
            }
        }
        poll()
    }

    /// 每 0.1 秒看一次条件,成立或超时(秒)后回调
    private func waitUntil(_ timeout: TimeInterval, _ condition: @escaping () -> Bool, then: @escaping (Bool) -> Void) {
        let deadline = Date().addingTimeInterval(timeout)
        func poll() {
            if condition() { return then(true) }
            if Date() >= deadline { return then(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: poll)
        }
        poll()
    }
}
