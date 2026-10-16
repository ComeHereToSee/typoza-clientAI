import AppKit
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
        if smokeOut == nil, !UserDefaults.standard.bool(forKey: Self.welcomeShownKey) {
            UserDefaults.standard.set(true, forKey: Self.welcomeShownKey)
            openWelcome(reuseBlank: true)
        }
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
