# macOS 外壳的 bug 与系统行为(AppKit / WKWebView)

> 分类:bug。来源:2026-10-23 扩展 macOS 冒烟自检时在 CI 真应用里撞到,均已修复并由冒烟守住(`app/Sources/Typoza/AppDelegate.swift` 的 `runNativeSmoke` / `moreNativeSmoke`)。

## 1. 导出 PDF / 打印结束后崩溃(Trace/BPT trap)
- 现象:冒烟跑到导出 PDF 后应用直接退出,日志只有 `Trace/BPT trap: 5`;崩溃报告 `asi` 为 `Must only be used from the main thread`,异常 `EXC_BREAKPOINT`。
- 根因:`WKWebView.printOperation` 在单独线程上跑,`runModal(for:delegate:didRun:)` 的结束回调也在那个线程;回调里直接回网页(`reply`)、收离屏窗口,触发 WebKit 的主线程断言。⌘P 打印的 `printOperationDidRun` 有同一隐患。
- 修复:两处回调里 `DispatchQueue.main.async` 再做事(`ExportService.swift` `printDone`、`DocumentWindowController.swift` `printOperationDidRun`)。
- 防复发:WebKit / AppKit 回调先确认在哪个线程;Release 构建里 Swift 运行时陷阱不打印消息,要看崩溃报告(冒烟脚本失败时会拷回 `~/Library/Logs/DiagnosticReports/Typoza*`,并逐个记下桥接调用)。

## 2. 系统往菜单里自动插项、改名
- 「表情与符号」出现两次:AppKit 发现编辑菜单会自动插入「表情与符号」(以及 fn E 备用项)。应用自己已有一项 ⌃⌘空格,就在建菜单前 `UserDefaults.standard.register(defaults: ["NSDisabledCharacterPaletteMenuItem": true])`(`AppDelegate.applicationWillFinishLaunching`)。
- 「偏好设置…」被系统改名为「设置…」(macOS 13 起);菜单键位期望表按「设置… ⌘,」写。
- 系统还会给「关闭」「切换全屏」加备用项(⌥⌘W、fn F)。导出菜单键位时 `menuKeys` 带备用项(应用自己的别名键位如放大 ⇧⌘= 也是备用项);查重复项只看平时显示的项(`menuKeysPrimary`)。

## 3. 冒烟里窗口类命令偶发失败(置顶、新标签)
- `native.alwaysOnTop`、`native.newTab` 作用于 `NSApp.keyWindow`。导出等步骤之后焦点可能不在主窗口:一次是系统还没把应用调回前台,一次是网页弹出了询问框(`_NSAlertPanel` 成了当前窗口)。
- 做法:冒烟里先 `bringToFront`(激活应用、`makeKeyAndOrderFront`,等到 `NSApp.keyWindow === window`,最多 3 次),没成功时把当时的前台状态与当前窗口类名记到标准错误——询问框就是这样查出来的(见 `editor-ui-fixes.md` 第 6 条)。

## 4. 合成按键测 ⌘↑ ⌃A 等键
- `NSEvent.keyEvent` 合成按下 / 抬起交给 `NSApp.sendEvent`,先过菜单键位再到 WKWebView,与真按键同一条链路;方向键要带 `.numericPad, .function`。
- 程序里直接设 DOM 选区后立刻按键,编辑器的选区未必跟上:光标一律用真按键移动(⌘↑ → ↓ → →)。
