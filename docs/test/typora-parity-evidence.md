# Typora 对照表 · 「实现」项证据表

> 2026-10-23 · 对照 `docs/prd/typora-parity.md` 当前版本,逐行列出「Typoza 处理 = 实现」的自动化证据与判定

## 一、怎么读

- **范围**:对照表里「Typoza 处理」为「实现」的行(A 至 X 各节与 Z 节,共 314 行)。「替代实现」「不做」的行不在本表;M-15、PM-24、PX-07、PX-08 已改为「替代实现」,不再列出。
- **证据写法**:`文件 › 用例标题`,多条用「;」分开;用例标题超过 40 个字只写前 40 个字并以「…」结尾,在文件里按这段文字搜索即可找到。
  - 网页端 E2E:`editor/tests/e2e/*.spec.ts`;网页端单测:`editor/tests/unit/*.test.ts`;外壳单测:`app/Tests/TypozaKitTests/*.swift`;辅助进程单测:`helper/…_test.go`;后端仓库的测试写成 `typoza-backend/…_test.go`;Swift 与 Go 的测试写函数名,不截短。
  - 少数用例在分组里,标题写成 `分组 › 用例`。
  - `冒烟 › checks.<名字>`:macOS CI 启动真应用后,网页一侧的自检项(`editor/src/smoke.ts`)。
  - `冒烟 › nativeChecks.<名字>`:同一次启动里外壳一侧的自检项(`app/Sources/Typoza/AppDelegate.swift`)。
  - `冒烟 › 菜单键位「<菜单项>」`:CI 逐项核对菜单键位(`ci/menu-keys.json`,94 项),只证明键位对。
- **判定**(四选一):
  - 「有」:用例断言了这一行的主要行为。说明列里个别次要细节(某条提示文案、某个边界)没断言时,在判定后括注,不降级。
  - 「部分」:主要行为只覆盖了一部分,或剩下的部分要在真机上确认(写「真机待确认:…」);判定格写明缺什么。
  - 「无」:找不到用例。
  - 「系统」:macOS 自带的能力,应用只放了标准菜单项;证据格写明依据。
- **运行情况**(2026-10-23 CI):网页端 E2E 470 条(只在 macOS 上有意义的 ⌘E 用例在 Linux 上跳过 1 条);macOS 真应用冒烟:网页侧自检全过(含 13 种导出格式、docx 导入、Big5 重开保存、拷贝图片),外壳侧自检 35 项全过,菜单键位 94 项全对。
- **统计**:「实现」314 行:有 286、部分 14、无 2、系统 12。

## 二、逐行证据

### A 应用菜单

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| A-01 | 关于 Typoza | 无用例。依据:`app/Sources/Typoza/MainMenu.swift` 应用菜单「关于 Typoza」用 macOS 标准关于面板(显示应用版本号);说明列的鸣谢入口在帮助菜单,见 H-07 | 系统 |
| A-03 | 偏好设置 ⌘, | `editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示` | 有(⌘, 不在菜单键位清单里,键位没核对) |
| A-04 | 检查更新 | `app/Tests/TypozaKitTests/FilesTests.swift › testVersionComparison`;`app/Tests/TypozaKitTests/FilesTests.swift › testParseUpdateFeed` | 部分:只测了版本比较与更新源解析;菜单「检查更新」的三种结果(当前已是最新、有新版本时【下载】【以后再说】、更新服务未配置时「无法检查更新」)没测 |
| A-05 | 服务 | 无用例。依据:应用菜单「服务」子菜单交给系统填充(`MainMenu.swift` 放菜单项,`AppDelegate.swift` 设为系统服务菜单) | 系统 |
| A-06 | 隐藏 Typoza / 隐藏其他 / 全部显示 | 无用例。依据:`MainMenu.swift` 应用菜单三项用 macOS 标准动作,键位 ⌘H、⌥⌘H | 系统 |
| A-07 | 退出 ⌘Q | `editor/tests/e2e/parity-p1.spec.ts › A-07 自动保存开:已命名文档退出时直接写盘,不询问`;`editor/tests/e2e/parity-p1.spec.ts › A-07 自动保存关:已命名文档退出时询问「是否保存更改?」,取消则不退出,选「…`;`editor/tests/e2e/parity-p1.spec.ts › A-07 自动保存开:未命名文档退出时不询问,内容留在草稿里,重启后恢复`;`editor/tests/e2e/parity-p1.spec.ts › A-07 自动保存关:未命名文档退出时也询问,选「不保存」删掉草稿`;`editor/tests/e2e/files.spec.ts › 关闭自动保存后关窗:询问「是否保存更改?」,选「不保存」不写盘` | 部分:单个窗口的四种组合(自动保存开 / 关 × 已命名 / 未命名)已测;真机待确认:多个窗口都有未保存修改时逐个询问 |

### F 文件

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| F-01 | 新建 ⌘N | `editor/tests/e2e/notion-keys.spec.ts › #8 ⌘N 与 #9 ⇧⌘N 新建窗口`;`冒烟 › nativeChecks.newWindow`;`冒烟 › 菜单键位「新建」` | 有 |
| F-02 | 新建标签页 ⌘T | `冒烟 › nativeChecks.newTab`;`冒烟 › 菜单键位「新建标签页」` | 有 |
| F-03 | 新建窗口 ⇧⌘N | `editor/tests/e2e/notion-keys.spec.ts › #8 ⌘N 与 #9 ⇧⌘N 新建窗口`;`冒烟 › nativeChecks.newWindow`;`冒烟 › 菜单键位「新建窗口」` | 有 |
| F-04 | 打开… ⌘O | `editor/tests/e2e/parity-p1.spec.ts › F-04 打开:侧栏没有文件夹时选文件打开,所在文件夹载入侧栏;选文件夹打开则载…`;`editor/tests/unit/files.test.ts › 扩展名清单与 PRD 一致`;`editor/tests/unit/files.test.ts › TextBundle 是一个文档,标题取包名`;`app/Tests/TypozaKitTests/FilesTests.swift › testListOpenableFilesUsesUnifiedExtensionsAndTextBundles`;`冒烟 › 菜单键位「打开…」` | 部分:选中之后打开文件、把所在文件夹载入侧栏、可打开的扩展名已测;真机待确认:真应用里 ⌘O 走外壳的打开面板(可同时选文件和文件夹),这一段没有自动检查 |
| F-05 | 打开最近文件(含清除) | `冒烟 › nativeChecks.recentFile`;`冒烟 › nativeChecks.clearRecent` | 有 |
| F-06 | 最近使用的目录 | `冒烟 › nativeChecks.recentFolder`;`冒烟 › nativeChecks.pinnedFolders` | 有 |
| F-07 | 重新打开关闭的文件 ⇧⌘T | `冒烟 › nativeChecks.reopenClosed`;`冒烟 › 菜单键位「重新打开关闭的文件」` | 有 |
| F-09 | 显示简介… | `editor/tests/e2e/parity-p1.spec.ts › F-09 显示简介…:列出位置、种类、大小、创建与修改时间、字数、编码、换行符;…`;`editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性`;`app/Tests/TypozaKitTests/FilesTests.swift › testStatReportsWritableAndCreationTime` | 有 |
| F-10 | 在文档列表中显示 | `editor/tests/e2e/parity-p1.spec.ts › F-10 在文档列表中显示:展开侧栏、切到文档列表,滚到当前文档并标为当前` | 有 |
| F-11 | 在文件树中显示 | `editor/tests/e2e/parity-p1.spec.ts › F-11 在文件树中显示:展开侧栏、切到文件树,逐级展开上级文件夹并标出当前文件` | 有 |
| F-12 | 打开文件位置 | `editor/tests/e2e/parity-p1.spec.ts › F-12 打开文件位置:请外壳在 Finder 中显示当前文件;未保存文档不调用` | 有 |
| F-13 | 删除… | `editor/tests/e2e/links-history.spec.ts › 删除后在「已删除的文件」里找回;改名后历史跟着走`;`editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性` | 有(失败提示「无法将文件移至回收站」没测) |
| F-14 | 关闭 ⌘W | `editor/tests/e2e/files.spec.ts › 关闭自动保存后关窗:询问「是否保存更改?」,选「不保存」不写盘`;`冒烟 › 菜单键位「关闭」` | 有 |
| F-15 | 保存 ⌘S | `editor/tests/e2e/files.spec.ts › 自动保存:停止输入约 1 秒后写盘`;`editor/tests/e2e/files.spec.ts › 备份到数据目录,刷新(相当于重启)后恢复;首次保存后删除备份`;`editor/tests/unit/markdown.test.ts › 原文保真:未编辑的文档原样写回 › CRLF`;`editor/tests/unit/markdown.test.ts › 原文保真:未编辑的文档原样写回 › BOM`;`app/Tests/TypozaKitTests/KitTests.swift › testUTF8WithBOMKeepsMarker`;`app/Tests/TypozaKitTests/KitTests.swift › testLegacyEncodingIsDetectedAndWrittenBack`;`冒烟 › 菜单键位「保存」` | 有 |
| F-17 | 保存全部打开的文件 ⌥⌘S | `冒烟 › nativeChecks.saveAll`;`冒烟 › 菜单键位「全部保存」` | 有 |
| F-18 | 复原到已保存 | `editor/tests/e2e/parity-extra.spec.ts › F-18 复原到已保存:先确认「放弃更改」,取消则保留修改` | 有 |
| F-20 | 重命名 / 移动到… | `editor/tests/e2e/files.spec.ts › 重命名正在编辑的文档:当前文档跟着改名,保存写到新路径`;`editor/tests/e2e/files.spec.ts › 拖到文件夹上移动`;`app/Tests/TypozaKitTests/KitTests.swift › testRenameRefusesToOverwrite` | 有(失败提示「重命名文件失败」没测) |
| F-21 | 导入… | `冒烟 › checks.importDocx`;`editor/tests/e2e/parity-p3a.spec.ts › PF-10 拖入可导入文件(.docx)默认「导入」:经 Pandoc 导入后在…` | 有(只测了 .docx;其余格式与未装 Pandoc 时的提示没单独测) |
| F-23 | 导出 ▸ HTML | `冒烟 › checks.export_html`;`editor/tests/e2e/preferences.spec.ts › 导出 HTML → 导出成功 → 导出后在访达中显示;导出并覆盖上一次导出的文件…`;`editor/tests/unit/exporter.test.ts › 有样式:带主题与深色标记,公式保留 KaTeX 渲染结果`;`editor/tests/unit/exporter.test.ts › 去掉编辑器界面元素、注释、占位与编辑标记;本机图片改成相对导出文件的路径` | 有 |
| F-24 | 导出 ▸ HTML(无样式) | `冒烟 › checks.export_html-plain`;`editor/tests/unit/exporter.test.ts › 无样式 HTML 的公式:MathML(块级带 display="block")`;`editor/tests/unit/exporter.test.ts › 无样式 HTML 的公式:LaTeX 源码(块级取编辑区原文)` | 有 |
| F-25 | 导出 ▸ 图片 | `冒烟 › checks.export_image`;`冒烟 › nativeChecks.exportPng` | 有 |
| F-26 | 导出 ▸ Word(.docx) | `冒烟 › checks.export_docx`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testPandocArgumentsForBuiltinAndItems`;`app/Tests/TypozaKitTests/ParityPandocTests.swift › testPX07WordReferenceDocAndExtraArgs`;`editor/tests/unit/export-flow.test.ts › 没装 Pandoc:提示「需要安装 Pandoc 以继续…」并给【安装说明】` | 有 |
| F-27 | 导出 ▸ OpenOffice(.odt) | `冒烟 › checks.export_odt` | 有 |
| F-28 | 导出 ▸ RTF | `冒烟 › checks.export_rtf` | 有 |
| F-29 | 导出 ▸ Epub | `冒烟 › checks.export_epub`;`app/Tests/TypozaKitTests/ParityPandocTests.swift › testPX07EpubCssTocDepthAndTitle`;`editor/tests/unit/parity-p3b.test.ts › PX-07 Word 样式参考文件只给 docx,Epub 样式表与目录层级只给…` | 有 |
| F-30 | 导出 ▸ LaTeX | `冒烟 › checks.export_latex` | 有 |
| F-31 | 导出 ▸ Media Wiki | `冒烟 › checks.export_mediawiki` | 有 |
| F-32 | 导出 ▸ reStructuredText | `冒烟 › checks.export_rst` | 有 |
| F-33 | 导出 ▸ Textile | `冒烟 › checks.export_textile` | 有 |
| F-34 | 导出 ▸ OPML | `冒烟 › checks.export_opml` | 有 |
| F-35 | 导出模板(从模板添加) | `editor/tests/e2e/parity-p1.spec.ts › F-35 偏好「导出」页从模板添加五种导出项:默认值正确,并同步到 文件 ▸ 导…`;`editor/tests/unit/export-flow.test.ts › 从模板新建导出项`;`editor/tests/unit/export-flow.test.ts › 自定义命令导出项:在文档所在文件夹执行,变量替换` | 有 |
| F-36 | 导出设置… | `editor/tests/e2e/parity-p1.spec.ts › F-36 导出设置…:打开偏好设置并直接停在「导出」页` | 有 |
| F-37 | 使用上一次设置导出 | `editor/tests/unit/export-flow.test.ts › 第一次导出默认放在文档所在文件夹;成功后记下,「使用上一次设置导出」沿用格式与位…` | 有(没导出过时菜单置灰没测) |
| F-38 | 导出并覆盖上一次导出的文件 | `editor/tests/unit/export-flow.test.ts › 导出并覆盖:先确认,取消就不导出;没导出过时提示`;`editor/tests/e2e/preferences.spec.ts › 导出 HTML → 导出成功 → 导出后在访达中显示;导出并覆盖上一次导出的文件…` | 有 |
| F-41 | 选择编码重新打开 | `冒烟 › checks.encodingReopen`;`冒烟 › checks.encodingSaved`;`app/Tests/TypozaKitTests/KitTests.swift › testFallsBackToGB18030ForLegacyChinese`;`app/Tests/TypozaKitTests/KitTests.swift › testUnknownEncodingNameFails` | 有 |
| F-42 | 打开失败提示 | `editor/tests/e2e/files.spec.ts › 文件不存在` | 有(外壳的打开面板、最近文件、Finder 打开三处同一文案没单独测) |

### E 编辑

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| E-01 | 撤消 ⌘Z / 重做 ⇧⌘Z | `editor/tests/e2e/parity-p1.spec.ts › E-01 输入后 ⌘Z 撤消,「重做」恢复`;`editor/tests/e2e/parity-p1.spec.ts › E-01 拖动块移动位置后可撤消`;`editor/tests/e2e/parity-p1.spec.ts › E-01 ⌘/ 转换块类型后可撤消`;`editor/tests/e2e/parity-p1.spec.ts › E-01 删除块后 ⌘Z 撤消`;`editor/tests/e2e/code-math.spec.ts › 自动转换后立即 ⌘Z 撤回为输入的原字符,且不再二次转换`;`editor/tests/e2e/links-history.spec.ts › 全部替换后一次 ⌘Z 撤回`;`冒烟 › 菜单键位「撤销」`;`冒烟 › 菜单键位「重做」` | 有 |
| E-02 | 剪切 / 拷贝 / 粘贴 | `editor/tests/e2e/parity-p1.spec.ts › E-02 剪切:选中内容移出正文,剪贴板写入 HTML 与 Markdown 文…`;`editor/tests/e2e/parity-p1.spec.ts › E-02 粘贴 HTML:优先取 HTML 并转成 Markdown,不用同时给…`;`editor/tests/e2e/context-edit.spec.ts › 拷贝时由外壳重写剪贴板并带上 RTF`;`editor/tests/e2e/context-edit.spec.ts › ⌘V 纯文本按 Markdown 解析;⇧⌘V 按字面粘贴`;`editor/tests/e2e/notion-keys.spec.ts › #15 选中文字后粘贴网址:文字变链接,不弹粘贴菜单`;`editor/tests/e2e/media.spec.ts › 粘贴视频网站网址:菜单可选保持链接 / 书签卡片 / 嵌入,嵌入存播放器地址`;`app/Tests/TypozaKitTests/MediaKitTests.swift › testHTMLToRTFKeepsTextAndBold`;`冒烟 › 菜单键位「剪切」`;`冒烟 › 菜单键位「拷贝」`;`冒烟 › 菜单键位「粘贴」` | 有 |
| E-03 | 拷贝图片 | `editor/tests/e2e/parity-p2.spec.ts › M-16 拷贝图片:菜单命令与右键都把选中的图片交给外壳放进剪贴板;网络图片交网…`;`editor/tests/e2e/lightbox.spec.ts › 旋转每次 90°,复制图片交给外壳`;`冒烟 › checks.copyImageCommand`;`冒烟 › nativeChecks.copyImage` | 有(网络图片在外壳里先下载再放进剪贴板没测,网页侧只断言交出网址) |
| E-04 | 复制为纯文本 | `editor/tests/e2e/parity-p1.spec.ts › E-04 复制为纯文本:只写文字,不带格式与 Markdown 符号`;`editor/tests/e2e/parity-p3a.spec.ts › C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复…` | 有 |
| E-05 | 复制为 Markdown ⇧⌘C | `editor/tests/e2e/parity-p1.spec.ts › E-05 复制为 Markdown:写入 Markdown 源码`;`editor/tests/e2e/parity-p3a.spec.ts › C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复…`;`冒烟 › 菜单键位「复制为 Markdown」` | 有 |
| E-06 | 复制为 HTML 代码 | `editor/tests/e2e/parity-p1.spec.ts › E-06 复制为 HTML 代码:把选区的 HTML 源码当纯文本写入`;`editor/tests/e2e/parity-p3a.spec.ts › C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复…` | 有 |
| E-07 | 复制内容并简化格式 | `editor/tests/e2e/context-edit.spec.ts › 复制内容并简化格式:去掉颜色等样式`;`editor/tests/unit/media-tools.test.ts › 复制内容并简化格式:去掉颜色等内联样式,保留语义标签` | 有 |
| E-09 | 粘贴并匹配样式 ⌥⇧⌘V | `冒烟 › nativeChecks.pasteMatchStyle`;`冒烟 › 菜单键位「粘贴并匹配样式」`;`editor/tests/e2e/parity-p3a.spec.ts › C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复…`;`editor/tests/e2e/context-edit.spec.ts › 右键粘贴为纯文本:Markdown 符号按字面保留` | 有 |
| E-11 | 选择段落或块 Esc;⌥⌘P | `editor/tests/unit/selection-commands.test.ts › Esc 选中当前块,再按 Esc 回到块末尾编辑`;`editor/tests/e2e/blocks.spec.ts › 块选中态直接输入文字:不改内容,退出选中态`;`冒烟 › 菜单键位「选中当前块」` | 有 |
| E-15 | 跳转到文首 ⌘↑ | `冒烟 › nativeChecks.keyDocStart` | 有 |
| E-16 | 跳转到所选内容 ⌘J | `editor/tests/e2e/parity-extra.spec.ts › E-16 ⌘J 跳转到所选内容:滚回光标所在处`;`冒烟 › 菜单键位「跳转到所选内容」` | 有 |
| E-17 | 跳转到文末 ⌘↓ | `冒烟 › nativeChecks.keyDocEnd` | 有 |
| E-18 | 跳转到行首 ⌃A / 行尾 ⌃E | `冒烟 › nativeChecks.keyLineStart`;`冒烟 › nativeChecks.keyLineEnd` | 有 |
| E-19 | 删除 / 删除所选范围 | `editor/tests/e2e/notion-keys.spec.ts › #42 ⌘A:第 1 次选中当前块文字,第 2 次全选`;`editor/tests/e2e/notion-keys.spec.ts › #48 Delete 删除所选块`;`editor/tests/e2e/blocks.spec.ts › ⇧↑ 扩选多块后 ⌘D 复制、⌫ 删除` | 有 |
| E-20 | 删除块 ⌥⇧⌘P | `editor/tests/e2e/notion-slash-items.spec.ts › /delete 删除当前块`;`editor/tests/unit/block-selection.test.ts › 删除、复制、移动多块`;`冒烟 › 菜单键位「删除当前块」` | 有 |
| E-21 | 删除当前行或句 ⌥⇧⌘L | `editor/tests/unit/selection-commands.test.ts › 删除当前行或句`;`冒烟 › 菜单键位「删除当前行或句」` | 有 |
| E-22 | 删除当前格式文本 ⌥⇧⌘E | `editor/tests/unit/selection-commands.test.ts › 删除当前格式文本`;`冒烟 › 菜单键位「删除当前格式文本」` | 有 |
| E-23 | 删除当前词 ⇧⌘D | `editor/tests/unit/selection-commands.test.ts › 删除当前词`;`冒烟 › 菜单键位「删除当前词」` | 有 |
| E-24 | 刷新所有数学公式 | `editor/tests/e2e/parity-p1.spec.ts › E-24 刷新所有数学公式:改了 \def 宏定义后,其他公式要刷新才按新定义重…`;`editor/tests/e2e/code-math.spec.ts › \tag 与 \label / \eqref:引用显示编号;刷新所有数学公式` | 有 |
| E-25 | 换行符 ▸ CRLF | `editor/tests/e2e/context-edit.spec.ts › 换行符改为 CRLF 后写回`;`editor/tests/unit/markdown.test.ts › 原文保真:未编辑的文档原样写回 › CRLF` | 有 |
| E-26 | 换行符 ▸ LF | `editor/tests/e2e/parity-p1.spec.ts › E-26 换行符改为 LF:CRLF 文档提示已改,写回内容全为 LF;再选一次…` | 有 |
| E-27 | 保存时在文末添加空行 | `editor/tests/e2e/parity-p1.spec.ts › E-27 保存时在文末添加空行:菜单开关切换;关掉后写回不补换行,打开后补且只补…` | 有 |
| E-28 | 首行缩进 | `editor/tests/e2e/context-edit.spec.ts › 空格与换行:显示 <br/>、忽略单换行、首行缩进`;`editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示` | 有(导出样式里的首行缩进没测) |
| E-29 | 显示 `<br/>` | `editor/tests/e2e/context-edit.spec.ts › 空格与换行:显示 <br/>、忽略单换行、首行缩进` | 有 |
| E-30 | 保留单换行符 | `editor/tests/e2e/context-edit.spec.ts › 空格与换行:显示 <br/>、忽略单换行、首行缩进` | 有 |
| E-32 | 输入时转换 / 渲染时转换 | `editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号`;`editor/tests/e2e/preferences.spec.ts › 渲染时转换:只改显示,文件里保留直引号与连字符`;`editor/tests/e2e/context-edit.spec.ts › 替换 ▸ 智能标点、智能引号、智能破折号与偏好同一组设置;更多选项打开偏好 Ma…`;`editor/tests/unit/smart-punctuation.test.ts › 渲染时转换:找出要替换的位置` | 有 |
| E-33 | 智能引号 | `editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号`;`editor/tests/e2e/context-edit.spec.ts › 替换 ▸ 智能标点、智能引号、智能破折号与偏好同一组设置;更多选项打开偏好 Ma…`;`editor/tests/unit/smart-punctuation.test.ts › 按前一个字符决定左右引号;单引号在字母后是撇号`;`editor/tests/unit/smart-punctuation.test.ts › 行内代码里不转换;关掉引号或破折号时只转另一种` | 有(公式里不转换没单独断言) |
| E-34 | 智能破折号 | `editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号`;`editor/tests/unit/smart-punctuation.test.ts › 破折号规则`;`editor/tests/e2e/notion-keys.spec.ts › #13 --- 成分割线:全文第一个块存 ***,其余位置存 ---` | 有 |
| E-36 | 解析时允许并转化 Unicode 标点 | `editor/tests/e2e/context-edit.spec.ts › 解析时转化 Unicode 标点:》 按引用识别,原文不变`;`editor/tests/unit/media-tools.test.ts › 行首全角标记等长换成半角,围栏代码里不动`;`editor/tests/unit/media-tools.test.ts › 关闭时照常按文字解析;开启后识别为引用、标题,未编辑时原文不变` | 有 |
| E-37 | 替换 ▸ 更多选项… | `editor/tests/e2e/context-edit.spec.ts › 替换 ▸ 智能标点、智能引号、智能破折号与偏好同一组设置;更多选项打开偏好 Ma…` | 有 |
| E-38 | 拼写和语法 | 依据:`MainMenu.swift` 编辑 ▸「拼写和语法」5 项都是 macOS 标准动作;`冒烟 › 菜单键位「显示拼写和语法」`;`冒烟 › 菜单键位「立即检查文稿」`;`editor/tests/e2e/parity-p3b.spec.ts › PE-08 拼写检查语言:选语言后交给系统词典并打开拼写检查;选「不使用」关闭`(断言编辑区打开 / 关闭拼写检查);`editor/tests/e2e/parity-gaps.spec.ts › E-38 行内代码、代码块、公式、自动识别的网址不做拼写检查;普通正文与…` | 部分:系统菜单与键位已核;行内代码、代码块、公式、自动识别的网址不做拼写检查已测;真机待确认:网页视图对「检查拼写和语法」「自动纠正拼写」的响应 |
| E-39 | 添加到字典 / 忘记拼写 | `editor/tests/e2e/context-edit.spec.ts › 按住 ⌥ 右键不弹自定义菜单(保留系统菜单)` | 部分:只断言按住 ⌥ 右键时让出系统菜单;真机待确认:系统菜单里「学习拼写 / 忘记拼写」出现并生效 |
| E-40 | 转换 ▸ 大写 / 小写 / 首字母大写 | `editor/tests/e2e/context-edit.spec.ts › 转换大小写`;`editor/tests/unit/media-tools.test.ts › 转换大小写` | 有(跨行内样式的同一个词不从中间改大写没断言) |
| E-41 | 查找… ⌘F | `editor/tests/e2e/notion-keys.spec.ts › #1 ⌘F 打开文内查找,焦点进查找框`;`editor/tests/e2e/context-edit.spec.ts › 无结果提示「未找到所查内容」`;`editor/tests/unit/media-tools.test.ts › 默认不区分大小写;区分时只命中小写`;`editor/tests/unit/media-tools.test.ts › 正则写错时报错而不是抛异常`;`editor/tests/unit/sourcemap.test.ts › buildPattern:空查询为 null;普通文字按字面匹配;大小写与全词`;`冒烟 › 菜单键位「查找…」` | 有 |
| E-42 | 查找下一个 ⌘G / 查找上一个 ⇧⌘G | `editor/tests/e2e/parity-p1.spec.ts › E-42 查找下一个 / 上一个:在匹配项间循环跳转、选中匹配;查找框内 ↩ /…`;`冒烟 › 菜单键位「查找下一个」`;`冒烟 › 菜单键位「查找上一个」` | 有 |
| E-43 | 查找和替换… ⌥⌘F | `editor/tests/e2e/context-edit.spec.ts › 限「选中部分」全部替换`;`editor/tests/e2e/links-history.spec.ts › 全部替换后一次 ⌘Z 撤回`;`editor/tests/unit/media-tools.test.ts › 限「选中部分」:只保留完全落在范围内的匹配`;`冒烟 › 菜单键位「查找和替换…」` | 有(没选中时的提示「先在正文里选中范围」没测) |
| E-44 | 替换下一个 ⌥⌘E | `editor/tests/e2e/parity-p1.spec.ts › E-44 替换下一个:只替换当前一处并选中剩下的下一处(两处匹配);全部换完提示…`;`editor/tests/e2e/parity-gaps.spec.ts › E-44 替换下一个(三处匹配):替换第一处后选中第二处,不跳过`;`冒烟 › 菜单键位「替换下一个」` | 有 |
| E-45 | 语音 ▸ 开始 / 停止朗读 | 无用例。依据:`MainMenu.swift` 编辑 ▸「语音」两项用 macOS 标准朗读动作 | 系统 |
| E-46 | 表情与符号 ⌃⌘空格 | 无用例。依据:`MainMenu.swift` 编辑 ▸「表情与符号」用 macOS 标准字符面板,键位 ⌃⌘空格(不在菜单键位清单里) | 系统 |

### P 段落

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| P-01 | 一级标题 ⌘1 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+1`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+1`;`冒烟 › 菜单键位「一级标题」` | 有 |
| P-02 | 二级标题 ⌘2 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+2`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+2`;`冒烟 › 菜单键位「二级标题」` | 有 |
| P-03 | 三级标题 ⌘3 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+3`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+3`;`冒烟 › 菜单键位「三级标题」` | 有 |
| P-04 | 四级标题 ⌘4 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+4`;`冒烟 › 菜单键位「四级标题」` | 有 |
| P-05 | 五级标题 ⌘5 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+5`;`冒烟 › 菜单键位「五级标题」` | 有 |
| P-06 | 六级标题 ⌘6 | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+6`;`冒烟 › 菜单键位「六级标题」` | 有 |
| P-07 | 段落 ⌘0 | `editor/tests/e2e/shortcuts.spec.ts › ⌘0 与 ⌥⌘0 转回正文`;`冒烟 › 菜单键位「正文」` | 有 |
| P-11 | 表格 ▸ 上方插入行 | `editor/tests/e2e/parity-gaps.spec.ts › P-11 / P-13 / P-17 右键 ▸ 表格 › 上方插入行、左侧 / 右侧插入列、删除列`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列` | 有 |
| P-12 | 表格 ▸ 下方插入行 ⌘↩ | `editor/tests/e2e/table.spec.ts › ⌘↩ 下方插入行,⇧⌘⌫ 删除行`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列` | 有 |
| P-13 | 表格 ▸ 左侧 / 右侧插入列 | `editor/tests/e2e/parity-gaps.spec.ts › P-11 / P-13 / P-17 右键 ▸ 表格 › 上方插入行、左侧 / 右侧插入列、删除列`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列` | 有 |
| P-14 | 表格 ▸ 上移该行 ⌃⌘↑ / 下移该行 ⌃⌘↓ | `editor/tests/e2e/parity-p2.spec.ts › P-14 表格 ⌃⌘↑ 上移该行:与上一行换位,第一行数据不越过表头`;`editor/tests/e2e/table.spec.ts › ⌃⌘↓ 下移该行`;`editor/tests/e2e/table.spec.ts › 拖行左边框调整行的位置` | 有 |
| P-15 | 表格 ▸ 左移该列 ⌃⌘← / 右移该列 ⌃⌘→ | `editor/tests/e2e/parity-extra.spec.ts › P-15 表格 ⌃⌘→ 右移该列、⌃⌘← 左移该列`;`editor/tests/e2e/parity-p4.spec.ts › X-37 拖列上边框的手柄换列` | 有 |
| P-16 | 表格 ▸ 删除行 ⇧⌘⌫ | `editor/tests/e2e/table.spec.ts › ⌘↩ 下方插入行,⇧⌘⌫ 删除行` | 有 |
| P-17 | 表格 ▸ 删除列 | `editor/tests/e2e/parity-gaps.spec.ts › P-11 / P-13 / P-17 右键 ▸ 表格 › 上方插入行、左侧 / 右侧插入列、删除列`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列` | 有 |
| P-18 | 表格 ▸ 复制表格 | `editor/tests/e2e/parity-p2.spec.ts › P-18 复制表格:剪贴板同时有表格的 Markdown 与 HTML,文档不变`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 复制表格:剪贴板同时有 Markdown 与 HTML` | 部分:从表格工具条点击复制已测(剪贴板同时有 Markdown 与 HTML);真机待确认:从菜单栏「段落 ▸ 表格 ▸ 复制表格」执行时(命令由外壳转发,不算网页里的一次点击),系统拷贝能否用 |
| P-19 | 表格 ▸ 格式化表格源码 | `editor/tests/e2e/table.spec.ts › 工具条:调整行列数、更多 ▸ 格式化源码` | 有 |
| P-20 | 表格 ▸ 删除表格 | `editor/tests/e2e/parity-p2.spec.ts › P-20 删除表格:工具条【删表】与菜单命令都只删整张表,前后段落不动` | 有 |
| P-21 | 公式块 ⌥⌘B | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+b`;`editor/tests/e2e/notion-slash-items.spec.ts › /math → slash.math`;`editor/tests/e2e/notion-keys.spec.ts › #15 $$ 后回车成公式块`;`冒烟 › 菜单键位「公式块」` | 有 |
| P-22 | 代码块 ⌥⌘C | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+c`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+8`;`冒烟 › 菜单键位「代码块」` | 有 |
| P-23 | 代码工具 ▸ 复制代码块内容 | `editor/tests/e2e/parity-gaps.spec.ts › P-23 代码工具 ▸ 复制代码块内容;右上角【复制代码】按钮同样写进剪贴板` | 有 |
| P-24 | 代码工具 ▸ 为选中内容 / 整个代码块调整缩进 | `editor/tests/e2e/parity-p2.spec.ts › P-24 代码工具 ▸ 为选中内容调整缩进:只重排选中的行`;`editor/tests/e2e/code-math.spec.ts › 代码工具:为整个代码块调整缩进(缩进宽度默认 2)` | 有 |
| P-25 | 警告框 ▸ 提醒 / 建议 / 重要 / 警告 / 注意 | `editor/tests/e2e/slash.spec.ts › /blue background 命中蓝色背景,/callout 默认提醒类`;`editor/tests/e2e/slash.spec.ts › /warning 插入警告提示框,/toggleh2 插入折叠标题 2`;`editor/tests/e2e/notion-slash-items.spec.ts › /note → slash.callout.note`;`editor/tests/e2e/notion-slash-items.spec.ts › /tip → slash.callout.tip`;`editor/tests/e2e/notion-slash-items.spec.ts › /important → slash.callout.important`;`editor/tests/e2e/notion-slash-items.spec.ts › /caution → slash.callout.caution` | 有(菜单「段落 ▸ 警告框」入口没单独测) |
| P-26 | 引用 ⌥⌘Q | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+q`;`editor/tests/e2e/notion-input.spec.ts › 块级输入:"`;`editor/tests/e2e/notion-input.spec.ts › 块级输入:>`;`冒烟 › 菜单键位「引用」` | 有 |
| P-27 | 有序列表 ⌥⌘O | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+o`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+6`;`冒烟 › 菜单键位「有序列表」` | 有 |
| P-28 | 无序列表 ⌥⌘U | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+u`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+5`;`冒烟 › 菜单键位「无序列表」` | 有 |
| P-29 | 任务列表 ⌥⌘X | `editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+x`;`editor/tests/e2e/shortcuts.spec.ts › 段落快捷键 Mod+Alt+4`;`冒烟 › 菜单键位「任务列表」` | 有 |
| P-30 | 任务状态 ▸ 切换 ⌃X / 标记为已完成 / 标记为未完成 | `editor/tests/e2e/parity-p2.spec.ts › P-30 ⌃X 切换任务状态:已完成与未完成来回切换`;`editor/tests/e2e/parity-p2.spec.ts › P-30 点击复选框与菜单「切换任务状态」同效`;`editor/tests/e2e/parity-gaps.spec.ts › P-30 任务状态 ▸ 标记为已完成 / 标记为未完成`;`editor/tests/e2e/notion-input.spec.ts › 快捷键:加粗、标题、复制块、待办切换` | 有 |
| P-32 | 在上方 / 下方插入段落 | `editor/tests/e2e/parity-p2.spec.ts › P-32 在上方 / 下方插入段落:空段落出现在当前块前 / 后,光标进新段落`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 段落(上方)/ 段落(下方):新段落在当前块上 /…`;`editor/tests/e2e/notion-slash-items.spec.ts › 点块左侧「+」:在下方新建空块并打开斜杠菜单(7.1)` | 有 |
| P-33 | 链接引用 ⌥⌘L | `editor/tests/e2e/notion-slash-items.spec.ts › /linkref 插入引用式链接定义`;`冒烟 › 菜单键位「链接引用」` | 有 |
| P-34 | 脚注 ⌥⌘R | `editor/tests/e2e/shortcuts.spec.ts › ⌥⌘- 分割线、⌥⌘R 脚注`;`editor/tests/e2e/notion-slash-items.spec.ts › /footnote 在光标处插脚注号,文末插定义`;`冒烟 › 菜单键位「脚注」` | 有 |
| P-35 | 水平分割线 ⌥⌘- | `editor/tests/e2e/shortcuts.spec.ts › ⌥⌘- 分割线、⌥⌘R 脚注`;`editor/tests/e2e/notion-keys.spec.ts › #13 --- 成分割线:全文第一个块存 ***,其余位置存 ---`;`冒烟 › 菜单键位「水平分割线」` | 有 |
| P-36 | 内容目录 | `editor/tests/e2e/notion-slash-items.spec.ts › /toc 插入目录`;`editor/tests/e2e/notion-keys.spec.ts › #17 [toc] 后回车成目录,存 [TOC],目录随标题更新` | 有 |
| P-37 | YAML Front Matter | `editor/tests/e2e/notion-slash-items.spec.ts › /yaml 在文首插入 YAML 元数据块`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ HTML 内容 / 脚注 / YAML Front…` | 有 |
| P-38 | HTML 内容 | `editor/tests/e2e/context-edit.spec.ts › 插入 HTML 块`;`editor/tests/e2e/notion-slash-items.spec.ts › /html 插入 HTML 块`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ HTML 内容 / 脚注 / YAML Front…` | 有 |

### M 格式

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| M-01 | 加粗 ⌘B | `editor/tests/e2e/parity-p2.spec.ts › M-01 ⌘B 无选区时:之后输入的文字加粗,再按一次结束加粗`;`editor/tests/e2e/notion-input.spec.ts › 快捷键:加粗、标题、复制块、待办切换`;`editor/tests/e2e/context-edit.spec.ts › 选中文字右键:用搜索引擎搜索、内联样式`;`冒烟 › 菜单键位「加粗」` | 有 |
| M-02 | 斜体 ⌘I | `editor/tests/e2e/notion-keys.spec.ts › #18 ⌘I 斜体`;`editor/tests/e2e/notion-input.spec.ts › 选中文字出现格式条`;`冒烟 › 菜单键位「斜体」` | 有 |
| M-03 | 下划线 ⌘U | `editor/tests/e2e/notion-keys.spec.ts › #19 ⌘U 下划线`;`冒烟 › 菜单键位「下划线」` | 有 |
| M-08 | 上标 | `editor/tests/e2e/parity-p2.spec.ts › M-08 上标:选中文字发「上标」存成 <sup>,再发一次取消`;`editor/tests/unit/markdown.test.ts › 上下标默认不识别,按普通文字显示`;`editor/tests/unit/markdown.test.ts › 打开上下标识别后,^2^ 是上标、~2~ 是下标` | 有 |
| M-09 | 下标 | `editor/tests/e2e/parity-p2.spec.ts › M-09 下标:选中文字发「下标」存成 <sub>,再发一次取消`;`editor/tests/unit/markdown.test.ts › 上下标默认不识别,按普通文字显示`;`editor/tests/unit/markdown.test.ts › 打开上下标识别后,^2^ 是上标、~2~ 是下标` | 有 |
| M-10 | 注释 ⌃- | `editor/tests/e2e/parity-p2.spec.ts › M-10 注释 ⌃-:选中文字变成 HTML 注释;无选区时插入「注释」占位`;`editor/tests/unit/exporter.test.ts › 去掉编辑器界面元素、注释、占位与编辑标记;本机图片改成相对导出文件的路径`;`冒烟 › 菜单键位「注释」` | 有 |
| M-11 | 超链接 ⌘K | `editor/tests/e2e/notion-keys.spec.ts › #21 正文里 ⌘K 给选中文字加链接,剪贴板里的网址自动填入`;`editor/tests/e2e/notion-keys.spec.ts › #15 选中文字后粘贴网址:文字变链接,不弹粘贴菜单`;`editor/tests/e2e/links-history.spec.ts › 编辑与移除链接;⌘K 新建时自动填入剪贴板里的网址`;`冒烟 › 菜单键位「超链接」` | 有 |
| M-12 | 链接操作 ▸ 打开链接 / 复制链接地址 | `editor/tests/e2e/parity-gaps.spec.ts › C-13 / M-12 右键链接:复制链接地址、复制链接文字、打开链接`;`editor/tests/e2e/links-history.spec.ts › ⌘+点击本地文档在新标签打开,⌥⇧+点击在新窗口打开`;`editor/tests/e2e/links-history.spec.ts › 单击显示浮层:复制、打开后 ⌘[ 返回原位置、⌘] 前进` | 有 |
| M-13 | 图像 ▸ 插入图片 ⌃⌘I | `editor/tests/e2e/image-tools.spec.ts › 插入图片:剪贴板里是图片网址时直接插入`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 图片:输入地址后插入`;`editor/tests/e2e/notion-slash-items.spec.ts › /image ▸ 图片网址…:插入网络图片`;`冒烟 › 菜单键位「插入图片…」` | 有 |
| M-14 | 图像 ▸ 插入本地图片… | `editor/tests/e2e/parity-p2.spec.ts › M-14 插入本地图片…:文件面板可多选,按插图规则复制进 assets 后插入` | 有 |
| M-16 | 图像 ▸ 拷贝图片 | `editor/tests/e2e/parity-p2.spec.ts › M-16 拷贝图片:菜单命令与右键都把选中的图片交给外壳放进剪贴板;网络图片交网…`;`冒烟 › checks.copyImageCommand`;`冒烟 › nativeChecks.copyImage` | 有 |
| M-17 | 图像 ▸ 缩放图片 ▸ 25% 至 200% | `editor/tests/e2e/image-tools.spec.ts › 工具条选比例写 zoom,选 100% 回到 Markdown 写法`;`editor/tests/e2e/image-tools.spec.ts › 「缩放图片」菜单命令作用于选中的图片`;`editor/tests/e2e/image-tools.spec.ts › 拖右下角手柄写宽度像素`;`editor/tests/e2e/image-tools.spec.ts › 左上角手柄向右拖是缩小`;`editor/tests/e2e/context-edit.spec.ts › 右键图片:缩放图片至 50%`;`editor/tests/unit/media-tools.test.ts › 选比例写 zoom,100% 回到 ![]()`;`editor/tests/unit/media-tools.test.ts › 拖手柄写 width 像素` | 有(拖动手柄时不超过段落宽度没测) |
| M-18 | 图像 ▸ 转换图片语法 | `editor/tests/e2e/image-tools.spec.ts › 工具条转换语法、删除`;`editor/tests/e2e/image-tools.spec.ts › 有缩放的图片不能转回 Markdown,给出提示`;`editor/tests/unit/media-tools.test.ts › 原文是 <img> 的图片转 Markdown 前后写法` | 有 |
| M-19 | 图像 ▸ 删除图片文件 | `editor/tests/e2e/image-tools.spec.ts › 删除图片文件:移到废纸篓并删掉引用` | 有(删除前确认、网络图片只删引用没断言) |
| M-20 | 图像 ▸ 复制图片到… | `editor/tests/e2e/parity-p2.spec.ts › M-20 复制图片到…:图片文件复制到选定文件夹,src 改成新位置,原文件保留`;`editor/tests/e2e/parity-gaps.spec.ts › M-20 / M-21 复制图片后的地址与插入图片同一规则:「为相对路径添加 .…` | 有(关掉「优先使用相对路径」时写绝对路径没测) |
| M-21 | 图像 ▸ 重命名 / 移动图片到… | `editor/tests/e2e/parity-p2.spec.ts › M-21 重命名 / 移动图片到…:文件改名移到新位置,src 跟着改;网络图片…`;`editor/tests/e2e/parity-gaps.spec.ts › M-20 / M-21 复制图片后的地址与插入图片同一规则:「为相对路径添加 .…` | 有 |
| M-22 | 图像 ▸ 上传图片 | `editor/tests/e2e/parity-p2.spec.ts › M-22 上传图片:首次上传先确认,确认后用偏好的上传服务上传并把 src 换成…`;`editor/tests/unit/assets.test.ts › 上传:首次上传先确认会调用第三方服务,确认后记下不再问` | 有 |
| M-23 | 图像 ▸ 复制所有图片到… / 移动所有图片到… | `editor/tests/e2e/image-tools.spec.ts › 复制所有图片到文件夹:本机图片复制、网络图片下载,路径改为新位置`;`editor/tests/e2e/parity-p2.spec.ts › M-23 移动所有图片到…:本机图片移走、网络图片下载到目标文件夹,路径全部更新` | 有 |
| M-24 | 图像 ▸ 上传所有本地图片 | `editor/tests/e2e/image-tools.spec.ts › 上传所有本地图片:按 Typora 原文提示结果`;`editor/tests/e2e/image-tools.spec.ts › 上传所有本地图片:没有本地图片时提示` | 有 |
| M-25 | 图像 ▸ 重新加载所有图片 | `editor/tests/e2e/image-tools.spec.ts › 重新加载所有图片:图片文件改动后重新显示` | 有 |
| M-26 | 图像 ▸ 当插入本地图片时 ▸ 复制图片到文件夹 / 上传图片 | `editor/tests/e2e/parity-p2.spec.ts › M-26 当插入本地图片时 ▸ 复制图片到文件夹…:选的文件夹写进 YAML,之…`;`editor/tests/e2e/image-tools.spec.ts › 设置图片根目录与插入规则写进 YAML`;`editor/tests/unit/assets.test.ts › YAML 的 typora-copy-images-to 优先;值为 uploa…` | 有 |
| M-27 | 图像 ▸ 设置图片根目录 | `editor/tests/e2e/parity-p2.spec.ts › M-27 设置图片根目录…:以 / 开头的图片路径立即按新根目录显示`;`editor/tests/e2e/image-tools.spec.ts › 设置图片根目录与插入规则写进 YAML` | 有 |
| M-28 | 图像 ▸ 全局图像设置… | `editor/tests/e2e/parity-p2.spec.ts › M-28 全局图像设置…:打开偏好设置并停在「图像」页` | 有 |
| M-30 | 拍照(从 iPhone 拍照或扫描) | 无用例;代码里也没有专门入口,靠按住 ⌥ 右键让出的系统菜单 | 无 |
| M-31 | 清除样式 `⌘\` | `editor/tests/e2e/parity-p2.spec.ts › M-31 清除样式:去掉加粗、斜体、下划线与文字颜色 / 背景色,只剩文字`;`冒烟 › 菜单键位「清除样式」` | 有 |

### V 显示

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| V-02 | 专注模式 F8 | `editor/tests/e2e/parity-p2.spec.ts › V-02 专注模式:光标所在块不透明,其余块变淡;光标换块后跟着换`;`editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示`;`冒烟 › 菜单键位「专注模式」` | 有 |
| V-03 | 打字机模式 F9 | `editor/tests/e2e/parity-p2.spec.ts › V-03 打字机模式:点到靠下的行后,光标所在行滚到窗口中部;关闭时不滚`;`冒烟 › 菜单键位「打字机模式」` | 有 |
| V-05 | 大纲 ⌃⌘1 | `editor/tests/e2e/files.spec.ts › 大纲:折叠、全部折叠 / 展开、空态、大纲窗口`;`冒烟 › 菜单键位「大纲」` | 有 |
| V-06 | 文档列表 ⌃⌘2 | `editor/tests/e2e/files.spec.ts › 文档列表:首段摘要、排序重启后保留、按文件夹分组`;`冒烟 › 菜单键位「文档列表」` | 有 |
| V-07 | 文件树 ⌃⌘3 | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性`;`冒烟 › 菜单键位「文件树」` | 有 |
| V-08 | 搜索 ⇧⌘F | `editor/tests/e2e/files.spec.ts › 全局搜索:文件名与正文、点击定位到命中处、选项、#标签、结果过多`;`app/Tests/TypozaKitTests/KitTests.swift › testSearchFindsLinesCaseInsensitive`;`app/Tests/TypozaKitTests/FilesTests.swift › testSearchMatchesFileNamesLimitsMatchesAndBatches`;`冒烟 › 菜单键位「在文件夹中搜索…」` | 有 |
| V-09 | 字数统计窗口 | `editor/tests/e2e/parity-p2.spec.ts › V-09 字数统计窗口:列出全文与选中部分的字数、段落、行数、阅读时间;状态栏字…`;`editor/tests/unit/wordcount.test.ts › 段落与行数`;`editor/tests/unit/wordcount.test.ts › 阅读时间按阅读速度(默认 382 字每分钟,不足 1 分钟按 1 分钟)` | 有 |
| V-10 | 大纲窗口 | `editor/tests/e2e/files.spec.ts › 大纲:折叠、全部折叠 / 展开、空态、大纲窗口`;`editor/tests/e2e/parity-p4.spec.ts › X-48 大纲:点侧栏大纲里的标题,光标落到该标题;大纲窗口里点击同样定位` | 有 |
| V-11 | 双指缩放 | `editor/tests/e2e/preferences.spec.ts › ⌘ + 滚轮与双指缩放;偏好里关掉后不再缩放` | 部分:用带 ⌃ 的滚轮事件模拟捏合,开关开 / 关都已测;真机待确认:网页视图能否收到触控板捏合 |
| V-12 | 实际大小 ⇧⌘0 | `editor/tests/e2e/preferences.spec.ts › 放大、缩小、实际大小命令`;`冒烟 › 菜单键位「实际大小」` | 有 |
| V-15 | 保持窗口在最前端 | `冒烟 › nativeChecks.alwaysOnTop`;`冒烟 › nativeChecks.alwaysOnTopOff` | 有 |
| V-16 | 全屏 ⌃⌘F | 依据:`MainMenu.swift`「显示」菜单「切换全屏」用 macOS 标准全屏动作;`冒烟 › 菜单键位「切换全屏」` | 系统 |
| V-17 | 显示状态栏 | `editor/tests/e2e/parity-p2.spec.ts › V-17 显示状态栏:默认显示字数与源码模式开关;菜单开关与偏好外观页是同一个设…`;`editor/tests/e2e/blocks.spec.ts › ⇧+点击选连续多块,⇧⌘+点击增减单块`;`editor/tests/e2e/files.spec.ts › 只读文件可以浏览,输入时提示不能保存并给【另存为】` | 有 |
| V-19 | 应用内窗口切换 ⌘` | 无用例。依据:⌘` 是 macOS 的「将焦点移到下一个窗口」,应用把「窗口」菜单设为系统窗口菜单(`AppDelegate.swift`),菜单里不另设此项 | 系统 |
| V-20 | 高亮当前标题 | `editor/tests/e2e/parity-p2.spec.ts › V-20 高亮当前标题:大纲里高亮光标所在的章节,光标移动后跟着换` | 有 |

### T 主题

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| T-02 | 自定义主题 | `editor/tests/e2e/preferences.spec.ts › 主题文件夹里的自定义主题与 base.user.css;找不到主题文件时提示`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testListsCustomThemesOnly` | 有 |
| T-03 | base.user.css / 主题名.user.css | `editor/tests/e2e/parity-p2.spec.ts › T-03 主题名.user.css 只追加到该主题,base.user.css…`;`editor/tests/e2e/preferences.spec.ts › 主题文件夹里的自定义主题与 base.user.css;找不到主题文件时提示` | 有 |
| T-06 | 深色模式使用独立主题 | `editor/tests/e2e/parity-p2.spec.ts › T-06 外观跟随系统:系统切深色时自动换成深色模式主题,切回浅色还原;外观选「…`;`editor/tests/e2e/preferences.spec.ts › 主题菜单切换内置主题;深色模式单独选主题`;`editor/tests/e2e/notion-keys.spec.ts › #7 ⇧⌘L 切换浅色 / 深色外观` | 有 |

### W 窗口

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| W-01 | 最小化 ⌘M | 依据:`MainMenu.swift`「窗口」菜单「最小化」用 macOS 标准动作;`冒烟 › 菜单键位「最小化」` | 系统 |
| W-02 | 缩放 | 无用例。依据:`MainMenu.swift`「窗口」菜单「缩放」用 macOS 标准动作 | 系统 |
| W-03 | 前置全部窗口 | 无用例。依据:`MainMenu.swift`「窗口」菜单「前置全部窗口」用 macOS 标准动作 | 系统 |
| W-04 | 标签页系统项(显示标签页栏、合并所有窗口等) | 无用例。依据:由 macOS 原生标签页自动附加到「窗口」菜单(`AppDelegate.swift` 打开自动标签页,`DocumentWindowController.swift` 设自动标签模式) | 系统 |

### H 帮助

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| H-01 | 新功能介绍 / 更新日志 | `冒烟 › nativeChecks.help_changelog` | 有 |
| H-02 | 快速上手 ⌘? | `冒烟 › nativeChecks.welcome`;`冒烟 › 菜单键位「快速上手」` | 有(文档里的 Notion 输入速查内容没核对) |
| H-03 | Markdown 参考 | `冒烟 › nativeChecks.help_markdown`(同时核对文档里有 Typoza 新块的存储写法) | 有 |
| H-04 | 安装与使用 Pandoc | `冒烟 › nativeChecks.help_pandoc` | 有 |
| H-06 | 欢迎向导 | `冒烟 › nativeChecks.firstLaunchWelcome`;`冒烟 › nativeChecks.welcome` | 有 |
| H-07 | 鸣谢 / 隐私条款 / 官方网站 / 反馈 | `冒烟 › nativeChecks.help_acknowledgements`;`冒烟 › nativeChecks.help_privacy`;`冒烟 › nativeChecks.linksGreyed` | 有(隐私条款正文内容没核对) |
| H-08 | 帮助菜单搜索 | 无用例。依据:应用把「帮助」菜单设为系统帮助菜单(`AppDelegate.swift`),搜索栏由 macOS 附加 | 系统 |

### C 右键菜单与上下文工具

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| C-01 | 右键 ▸ 插入(段落、图片、表格、代码块、公式块、HTML、标注块、折叠块、分割线、目录、脚注、链接引用、YAML) | `editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 段落(上方)/ 段落(下方):新段落在当前块上 /…`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 图片:输入地址后插入`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 表格:弹窗点选 3 列 × 2 行`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 代码块:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 公式块:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 标注块:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 折叠块:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 目录:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ 链接引用:插在当前段落之后`;`editor/tests/e2e/parity-p3a.spec.ts › C-01 右键 ▸ 插入 ▸ HTML 内容 / 脚注 / YAML Front…`;`editor/tests/e2e/context-edit.spec.ts › 右键插入分割线` | 有 |
| C-03 | 右键 ▸ 内联样式 | `editor/tests/e2e/context-edit.spec.ts › 选中文字右键:用搜索引擎搜索、内联样式`;`editor/tests/e2e/notion-input.spec.ts › 选中文字出现格式条` | 有 |
| C-04 | 右键 ▸ 复制 / 粘贴为 | `editor/tests/e2e/parity-p3a.spec.ts › C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复…`;`editor/tests/e2e/context-edit.spec.ts › 右键粘贴为纯文本:Markdown 符号按字面保留` | 有 |
| C-05 | 复制为图片(公式、图表) | `editor/tests/e2e/parity-p3a.spec.ts › C-05 / C-08 右键公式块:复制为图片截取公式渲染区域;删除公式`;`editor/tests/e2e/parity-p3a.spec.ts › C-05 / C-08 右键图表(mermaid):复制为图片截取图表区域;删除…`;`冒烟 › nativeChecks.copyRegionAsImage` | 有 |
| C-07 | 复制公式 ▸ 复制为 TeX 代码 / 复制为 MathML | `editor/tests/e2e/parity-p3a.spec.ts › C-07 右键公式 ▸ 复制公式:复制为 TeX 代码、复制为 MathML` | 有 |
| C-08 | 删除公式 / 删除代码块 / 删除图表 | `editor/tests/e2e/context-edit.spec.ts › 右键代码块:删除代码块`;`editor/tests/e2e/parity-p3a.spec.ts › C-05 / C-08 右键公式块:复制为图片截取公式渲染区域;删除公式`;`editor/tests/e2e/parity-p3a.spec.ts › C-05 / C-08 右键图表(mermaid):复制为图片截取图表区域;删除…` | 有 |
| C-09 | 右键 ▸ 图像工具 / 缩放图片至 %@ | `editor/tests/e2e/context-edit.spec.ts › 右键图片:图像工具、删除图片`;`editor/tests/e2e/context-edit.spec.ts › 右键图片:缩放图片至 50%` | 有 |
| C-10 | 在浏览器中打开图片 / 删除图片(本机图片另有「用默认应用打开」) | `editor/tests/e2e/parity-gaps.spec.ts › C-10 右键图片:在浏览器 / 默认应用中打开 › 网络图片:在浏览器中打开图片`;`editor/tests/e2e/parity-gaps.spec.ts › C-10 右键图片:在浏览器 / 默认应用中打开 › 本机图片:用默认应用打开(传绝对路径)`;`editor/tests/e2e/context-edit.spec.ts › 右键图片:图像工具、删除图片` | 有 |
| C-11 | 右键 ▸ 播放 / 暂停(视频) | `editor/tests/e2e/parity-p3a.spec.ts › C-11 右键视频 ▸ 播放 / 暂停:条目随播放状态切换,不改文档`;`editor/tests/e2e/media.spec.ts › 选中视频按空格播放 / 暂停,不改文档` | 有 |
| C-12 | 搜索 ▸ Google / Bing / 百度 | `editor/tests/e2e/context-edit.spec.ts › 选中文字右键:用搜索引擎搜索、内联样式` | 有(用例点的是 Google,Bing、百度没逐个点) |
| C-13 | 查询 / 复制 '%@' / 打开链接 | `editor/tests/e2e/parity-gaps.spec.ts › C-13 / M-12 右键链接:复制链接地址、复制链接文字、打开链接`;`editor/tests/e2e/context-edit.spec.ts › 按住 ⌥ 右键不弹自定义菜单(保留系统菜单)` | 有 |
| C-14 | 右键 ▸ 跳转到(文首、文末、所选内容;脚注引用与定义互跳) | `editor/tests/e2e/parity-gaps.spec.ts › C-14 右键 ▸ 跳转到 › 文首、文末`;`editor/tests/e2e/parity-gaps.spec.ts › C-14 右键 ▸ 跳转到 › 脚注引用上右键跳到脚注定义,定义上右键跳回引用`;`editor/tests/e2e/parity-p3a.spec.ts › C-14 右键 ▸ 跳转到 ▸ 所选内容:滚回选区末端,选区不变` | 有 |
| C-15 | 表格工具条「…」更多操作 | `editor/tests/e2e/parity-p3a.spec.ts › C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列`;`editor/tests/e2e/parity-p3a.spec.ts › C-15 复制表格:剪贴板同时有 Markdown 与 HTML`;`editor/tests/e2e/table.spec.ts › 工具条:调整行列数、更多 ▸ 格式化源码` | 有 |

### S 侧边栏

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| S-01 | 大纲视图(可折叠 / 无折叠),空时「大纲内容为空」 | `editor/tests/e2e/files.spec.ts › 大纲:折叠、全部折叠 / 展开、空态、大纲窗口`;`editor/tests/unit/files.test.ts › 折叠的标题下级都隐藏,同级与上级不受影响`;`editor/tests/unit/parity-p3a.test.ts › 默认可折叠:有下级的标题带折叠箭头,有「全部折叠 / 全部展开」;点箭头收起下级`;`editor/tests/unit/parity-p3a.test.ts › 关掉「允许折叠和展开侧边栏的大纲视图」:没有箭头和折叠按钮,标题全部显示,点击照…`;`editor/tests/e2e/parity-gaps.spec.ts › S-01 / PF-02 关掉「允许折叠和展开侧边栏的大纲视图」当场生效:箭头与…` | 有 |
| S-02 | 大纲全部折叠 / 全部展开 | `editor/tests/e2e/files.spec.ts › 大纲:折叠、全部折叠 / 展开、空态、大纲窗口` | 有 |
| S-03 | 文档树 / 文档列表切换;文件过多提示 | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性`;`editor/tests/e2e/files.spec.ts › 文档列表:首段摘要、排序重启后保留、按文件夹分组`;`editor/tests/e2e/parity-p3a.spec.ts › S-03 文档列表:文件超过 500 个时提示切到文件树,只列前 500 个`;`冒烟 › 菜单键位「文档列表」`;`冒烟 › 菜单键位「文件树」` | 有 |
| S-04 | 排序(四种 × 升 / 降序),重启后保留 | `editor/tests/unit/files.test.ts › 四种排序各分升降序`;`editor/tests/e2e/files.spec.ts › 文档列表:首段摘要、排序重启后保留、按文件夹分组` | 有 |
| S-05 | 文档列表按文件夹分组 | `editor/tests/e2e/files.spec.ts › 文档列表:首段摘要、排序重启后保留、按文件夹分组` | 有 |
| S-06 | 侧栏搜索 | `editor/tests/e2e/files.spec.ts › 全局搜索:文件名与正文、点击定位到命中处、选项、#标签、结果过多`;`app/Tests/TypozaKitTests/FilesTests.swift › testSearchMatchesFileNamesLimitsMatchesAndBatches`;`app/Tests/TypozaKitTests/KitTests.swift › testSearchFindsLinesCaseInsensitive` | 有 |
| S-07 | 新建文件 / 新建文件夹;同名提示 | `editor/tests/e2e/parity-p3a.spec.ts › S-07 新建文件 / 新建文件夹:直接输入名称;同名时提示「目标路径已存在同名…` | 有 |
| S-09 | 创建副本(「名称 副本.md」) | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性` | 有 |
| S-10 | 移动到…(覆盖前确认,被替换文件进废纸篓) | `editor/tests/e2e/parity-p3a.spec.ts › S-10 移动到…:目标已有同名文件先确认,取消不动;替换后被替换的文件进废纸篓`;`editor/tests/e2e/files.spec.ts › 拖到文件夹上移动` | 有 |
| S-11 | 删除(移到废纸篓) | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性` | 有 |
| S-12 | 属性 | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性`;`app/Tests/TypozaKitTests/FilesTests.swift › testStatReportsWritableAndCreationTime` | 有 |
| S-13 | 在 Finder 中显示 / 在侧边栏中显示 | `editor/tests/e2e/parity-p3a.spec.ts › S-13 在 Finder 中显示;文档列表里「在侧边栏中显示」切到文件树并展开…` | 有 |
| S-14 | 在新窗口中打开 / 打开方式… / 快速查看(另有在新标签页打开) | `editor/tests/e2e/parity-p3a.spec.ts › S-14 在新标签页 / 新窗口中打开、打开方式…、快速查看` | 部分:四项都断言了交给外壳的调用;真机待确认:快速查看用系统 Quick Look,预览窗口是否前置 |
| S-15 | 复制文件路径 | `editor/tests/e2e/parity-p3a.spec.ts › S-15 拷贝文件路径:剪贴板里是绝对路径` | 有 |
| S-16 | 打开文件夹…;未打开时「没有打开的文件夹」 | `editor/tests/e2e/parity-p3a.spec.ts › S-16 打开文件夹…:空态按钮与文件菜单都切换侧栏根文件夹`;`editor/tests/e2e/files.spec.ts › 没有打开文件夹时的空态` | 有 |
| S-17 | 刷新;自动跟随磁盘变化 | `editor/tests/e2e/parity-p3a.spec.ts › S-17 磁盘变化后文件树自动刷新;右键「刷新」重读` | 有 |
| S-18 | 固定 / 取消固定 / 从列表中删除 | `editor/tests/e2e/parity-p3a.spec.ts › S-18 固定 / 取消固定根文件夹;最近列表里固定项排前,可从列表中删除`;`冒烟 › nativeChecks.pinnedFolders` | 有 |
| S-20 | 撤销上一次文件操作 | `editor/tests/e2e/files.spec.ts › 文件树:创建副本并撤销;移到废纸篓并撤销;属性` | 部分:点提示里的【撤销】还原副本与废纸篓已测;真机待确认:焦点在侧栏时 ⌘Z 先撤销文件操作 |

### PF 偏好设置 · 文件

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PF-01 | 启动选项(打开新文件 / 上次目录 / 上次文件和目录 / 指定目录) | `editor/tests/e2e/parity-p3a.spec.ts › PF-01 启动选项:打开新文件 / 上次目录 / 上次文件和目录 / 指定目录` | 部分:四种选项下的启动恢复逻辑已测(用例直接调用应用的启动恢复);真机待确认:真实冷启动时接上这段逻辑,「打开新文件」时出现空白新文档 |
| PF-02 | 允许折叠和展开侧边栏的大纲视图 | `editor/tests/unit/parity-p3a.test.ts › 默认可折叠:有下级的标题带折叠箭头,有「全部折叠 / 全部展开」;点箭头收起下级`;`editor/tests/unit/parity-p3a.test.ts › 关掉「允许折叠和展开侧边栏的大纲视图」:没有箭头和折叠按钮,标题全部显示,点击照…`;`editor/tests/e2e/parity-gaps.spec.ts › S-01 / PF-02 关掉「允许折叠和展开侧边栏的大纲视图」当场生效:箭头与…` | 有 |
| PF-03 | 默认文件扩展名 .md / .markdown / .text / 自定义 | `editor/tests/e2e/parity-p3a.spec.ts › PF-03 默认扩展名选 .markdown:新文件保存框默认「未命名.mark…`;`editor/tests/e2e/parity-p3a.spec.ts › PF-03 默认扩展名选自定义 .mdx:新文件保存框默认「未命名.mdx」` | 有 |
| PF-04 | 自动保存 | `editor/tests/e2e/files.spec.ts › 自动保存:停止输入约 1 秒后写盘`;`editor/tests/e2e/files.spec.ts › 关闭自动保存后关窗:询问「是否保存更改?」,选「不保存」不写盘` | 有 |
| PF-05 | 切换文件时自动保存上一个文件 | `editor/tests/e2e/parity-p3a.spec.ts › PF-05 侧栏切换文件时自动保存上一个文件、不询问;关掉自动保存后切换会询问` | 有 |
| PF-06 | 恢复未保存的草稿 | `冒烟 › nativeChecks.recoverDrafts`;`editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示`;`editor/tests/e2e/files.spec.ts › 备份到数据目录,刷新(相当于重启)后恢复;首次保存后删除备份`;`app/Tests/TypozaKitTests/FilesTests.swift › testDraftsSaveListReadRemove` | 有(没有游离草稿时打开草稿文件夹没测) |
| PF-08 | 拖入文件夹:打开 / 插入文件夹链接 | `editor/tests/e2e/preferences.spec.ts › Markdown 文件按偏好插入链接;文件夹在侧栏打开`;`editor/tests/e2e/parity-p3a.spec.ts › PF-08 拖入文件夹选「插入文件夹链接」:插入 [文件夹名](相对路径/),侧…` | 有 |
| PF-09 | 拖入 Markdown 文件:打开 / 插入文件链接 | `editor/tests/e2e/preferences.spec.ts › Markdown 文件按偏好插入链接;文件夹在侧栏打开`;`editor/tests/e2e/parity-p3a.spec.ts › PF-09 拖入 Markdown 文件默认「打开」:在新窗口打开,当前文档不变` | 有 |
| PF-10 | 拖入可导入文件:导入 / 插入文件链接 | `editor/tests/e2e/parity-p3a.spec.ts › PF-10 拖入可导入文件(.docx)默认「导入」:经 Pandoc 导入后在…`;`editor/tests/e2e/parity-p4.spec.ts › X-17 拖入文件(偏好选「插入链接」):文件夹插入以 / 结尾的链接,可导入文…` | 有(其它不可导入的文件拖入成附件卡片没测) |

### PE 偏好设置 · 编辑器

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PE-01 | 默认缩进 + 对齐缩进 | `editor/tests/unit/markdown-options.test.ts › 默认缩进:与列表标记对齐 / 4 个空格`;`editor/tests/unit/markdown-options.test.ts › 偏好设置映射到序列化选项` | 有 |
| PE-02 | 匹配括号和引号 | `editor/tests/e2e/parity-p3b.spec.ts › PE-02 匹配括号和引号:敲 ( 补出 ),敲 ) 越过,成对符号之间退格一起…`;`editor/tests/e2e/parity-p4.spec.ts › X-04 自动配对括号与引号:敲 ( 补出 ),敲 ) 越过;引号同理;关掉「匹…` | 有 |
| PE-03 | 匹配 Markdown 字符 | `editor/tests/e2e/parity-p3b.spec.ts › PE-03 匹配 Markdown 字符:默认关;打开后敲 * _ ~ 补出另一…` | 有 |
| PE-04 | 即时渲染:显示当前块的 Markdown 源码 | `editor/tests/e2e/parity-p3b.spec.ts › PE-04 编辑时显示 Markdown 标记:默认不显示;打开后光标进标题显示…` | 有 |
| PE-05 | 复制纯文本时复制 Markdown 源码 | `editor/tests/e2e/parity-p3b.spec.ts › PE-05 复制纯文本时复制 Markdown 源码:默认带标记;关掉后纯文本只…`;`editor/tests/e2e/context-edit.spec.ts › 拷贝时由外壳重写剪贴板并带上 RTF` | 有 |
| PE-06 | 无选区时复制或剪切整行 | `editor/tests/e2e/parity-p3b.spec.ts › PE-06 无选区时复制或剪切整行:默认不复制;打开后复制光标所在整段,剪切去掉…` | 有 |
| PE-07 | 默认换行符 LF / CRLF | `editor/tests/e2e/parity-p3b.spec.ts › PE-07 默认换行符选 CRLF:新建的文档按 \r\n 写盘;已有的 LF…`;`editor/tests/unit/parity-p3b.test.ts › PE-07 选 CRLF 时新建的文档按 \r\n 写盘;默认 LF`;`editor/tests/unit/parity-p3b.test.ts › PE-07 打开的已有文件保持原换行符,不跟偏好走` | 有 |
| PE-08 | 拼写检查语言 | `editor/tests/e2e/parity-p3b.spec.ts › PE-08 拼写检查语言:选语言后交给系统词典并打开拼写检查;选「不使用」关闭` | 部分:选语言后交给外壳并打开拼写检查、选「不使用」关闭已测;真机待确认:系统词典按所选语言检查 |
| PE-09 | 打字机模式下始终保证光标在屏幕中间 | `editor/tests/e2e/parity-p3b.spec.ts › PE-09 打字机模式始终居中:默认鼠标点选也滚到屏幕中间;关掉后点选不滚动,输…` | 有 |
| PE-10 | 关闭打字机模式 / 专注模式 | `editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示` | 有 |

### PI 偏好设置 · 图像

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PI-01 | 插入图片时的去向(默认复制到 ./assets) | `editor/tests/unit/assets.test.ts › 按「插入图片时」选项`;`editor/tests/unit/assets.test.ts › 复制到 ./assets:目录不存在先询问「该目录不存在,是否立即创建?」,同名…` | 有 |
| PI-02 | 规则作用于本地 / 网络位置的图片 | `editor/tests/unit/assets.test.ts › 关掉「对本地位置的图片应用上述规则」:本机图片直接引用原路径;剪贴板图片照规则落…`;`editor/tests/unit/assets.test.ts › 默认保持网址;开了「对网络位置的图片应用上述规则」时下载到资源文件夹` | 有 |
| PI-03 | 允许根据 YAML 设置自动上传图片 | `editor/tests/unit/assets.test.ts › YAML 的 typora-copy-images-to 优先;值为 uploa…`;`editor/tests/unit/assets.test.ts › 上传:首次上传先确认会调用第三方服务,确认后记下不再问` | 有 |
| PI-04 | 优先使用相对路径 | `editor/tests/unit/assets.test.ts › 相对路径加 ./ 与转义网址`;`editor/tests/unit/assets.test.ts › 复制到 ./assets:目录不存在先询问「该目录不存在,是否立即创建?」,同名…` | 有 |
| PI-05 | 为相对路径添加 ./ | `editor/tests/unit/assets.test.ts › 相对路径加 ./ 与转义网址`;`editor/tests/e2e/parity-gaps.spec.ts › M-20 / M-21 复制图片后的地址与插入图片同一规则:「为相对路径添加 .…` | 有 |
| PI-06 | 插入时自动转义图片 URL | `editor/tests/unit/assets.test.ts › 相对路径加 ./ 与转义网址` | 有 |

### PM 偏好设置 · Markdown

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PM-01 | 严格模式 | `editor/tests/unit/markdown-options.test.ts › 严格模式默认开;关掉后 #标题(# 后没有空格)也是标题`;`editor/tests/unit/markdown-options.test.ts › 偏好设置映射到解析选项` | 有 |
| PM-02 | 标题样式 atx / atx 带后缀 / setext / 可变宽 setext | `editor/tests/unit/markdown-options.test.ts › 标题样式:atx / atx 带后缀 / setext / 可变宽 setext`;`editor/tests/unit/markdown-options.test.ts › 偏好设置映射到序列化选项` | 有 |
| PM-03 | 无序列表符号 | `editor/tests/unit/markdown-options.test.ts › 无序列表符号:原文没有无序列表时按偏好,有则沿用原文` | 有 |
| PM-04 | 有序列表 1. 2. 3. / 1. 1. 1. | `editor/tests/unit/markdown-options.test.ts › 有序列表编号:1. 2. 3. 或 1. 1. 1.` | 有 |
| PM-05 | 自动识别链接 | `editor/tests/unit/markdown-options.test.ts › 自动识别链接可以关掉:裸网址是普通文字,写回时不加转义`;`editor/tests/unit/markdown-options.test.ts › 尖括号链接不受「自动识别链接」影响`;`editor/tests/e2e/notion-keys.spec.ts › #10 正文里的网址敲空格后自动成链接,保存仍是裸网址` | 有 |
| PM-06 | 内联公式 `$…$` | `editor/tests/e2e/parity-p3b.spec.ts › PM-06 内联公式 $…$:默认渲染为公式;关掉后按普通文字显示,文件不变`;`editor/tests/unit/parity-p3b.test.ts › PM-06 关掉内联公式:$…$ 按普通文字解析并原样写回;所在段落被编辑过也不…`;`editor/tests/unit/markdown.test.ts › 任务列表、wikilink、脚注、公式、引用定义`;`editor/tests/e2e/notion-slash-items.spec.ts › /equation 打开行内公式输入框,回车存 $公式$` | 有 |
| PM-07 | 代码块公式(math 代码块) | `` editor/tests/e2e/parity-p3b.spec.ts › PM-07 代码块公式 ```math:默认显示为公式;关掉后按普通代码块显示,… ``;`` editor/tests/e2e/code-math.spec.ts › ```math 显示为公式,源码原样保存 `` | 有 |
| PM-08 | 下标 `~…~` | `editor/tests/unit/markdown.test.ts › 上下标默认不识别,按普通文字显示`;`editor/tests/unit/markdown.test.ts › 打开上下标识别后,^2^ 是上标、~2~ 是下标`;`editor/tests/unit/markdown-options.test.ts › 偏好设置映射到解析选项` | 有 |
| PM-09 | 上标 `^…^` | `editor/tests/unit/markdown.test.ts › 上下标默认不识别,按普通文字显示`;`editor/tests/unit/markdown.test.ts › 打开上下标识别后,^2^ 是上标、~2~ 是下标`;`editor/tests/unit/markdown-options.test.ts › 偏好设置映射到解析选项` | 有 |
| PM-10 | 高亮 `==…==` | `editor/tests/unit/markdown-options.test.ts › 高亮可以关掉:==文字== 按普通文字显示,原文不变`;`editor/tests/unit/markdown.test.ts › 高亮、下划线、颜色、删除线` | 有 |
| PM-11 | GitHub 风格警报框 | `editor/tests/unit/markdown-options.test.ts › 警报框可以关掉:> [!NOTE] 显示为普通引用,内部照常识别`;`editor/tests/unit/markdown.test.ts › front matter、目录、提示框、折叠块` | 有 |
| PM-12 | 图表(序列图、流程图、Mermaid) | `editor/tests/e2e/parity-p3b.spec.ts › PM-12 图表:默认 mermaid 渲染成图;关掉后显示源码、不出图,源码不…`;`editor/tests/e2e/code-math.spec.ts › mermaid、sequence、flow 渲染为图;语法错误保留源码`;`editor/tests/unit/diagram-math.test.ts › mermaid 原样渲染,sequence / flow 先转换` | 有 |
| PM-13 | 智能引号 + 双引号 / 单引号样式 | `editor/tests/unit/smart-punctuation.test.ts › 引号样式`;`editor/tests/unit/smart-punctuation.test.ts › 按前一个字符决定左右引号;单引号在字母后是撇号`;`editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号`;`editor/tests/e2e/preferences.spec.ts › 渲染时转换:只改显示,文件里保留直引号与连字符` | 有 |
| PM-14 | 智能破折号 | `editor/tests/unit/smart-punctuation.test.ts › 破折号规则`;`editor/tests/unit/smart-punctuation.test.ts › 行内代码里不转换;关掉引号或破折号时只转另一种`;`editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号` | 有 |
| PM-15 | 代码块显示行号 | `editor/tests/e2e/parity-p3b.spec.ts › PM-15 代码块显示行号:默认没有行号栏;打开后代码块带行号,关掉后不带`;`editor/tests/e2e/parity-gaps.spec.ts › PM-15 / PM-16 改代码块行号、自动换行:已显示的代码块当场生效,不用…` | 有 |
| PM-16 | 代码块自动换行 | `editor/tests/e2e/parity-p3b.spec.ts › PM-16 代码块自动换行:默认长行折行;关掉后长行不折、出现横向滚动`;`editor/tests/e2e/parity-gaps.spec.ts › PM-15 / PM-16 改代码块行号、自动换行:已显示的代码块当场生效,不用…`;`editor/tests/e2e/parity-gaps.spec.ts › PM-16 打印与导出 PDF 时代码块始终折行(关掉自动换行也一样)` | 有(「导出 PDF 始终折行」用例断言的是编辑区的打印样式,导出文件本身没单独断言) |
| PM-18 | 代码缩进 2 / 3 / 4 / 5 | `editor/tests/unit/block-commands.test.ts › Tab 按偏好的空格数缩进,⇧Tab 按同样宽度反缩进`;`editor/tests/e2e/code-math.spec.ts › 代码工具:为整个代码块调整缩进(缩进宽度默认 2)` | 有 |
| PM-20 | 支持使用 `\\` 和 `\newline` 换行 | `editor/tests/e2e/parity-p3b.spec.ts › PM-20 公式内 \\ 换行:默认换行;关掉后不换行,公式照常渲染`;`editor/tests/unit/parity-p3b.test.ts › PM-20 块公式里的 \\ 与 \newline:开着时换行;关掉后不换行,也…` | 有 |
| PM-22 | 公式自动编号 | `editor/tests/unit/diagram-math.test.ts › 不编号:只认手写 \tag`;`editor/tests/unit/diagram-math.test.ts › AMS:编号环境按行编号,\notag 与带星号的不编号`;`editor/tests/unit/diagram-math.test.ts › 全部编号:每个块公式各编一个号,并包进 equation 环境`;`editor/tests/unit/diagram-math.test.ts › \ref 与 \eqref 换成编号,找不到显示 ??;\label 去掉`;`editor/tests/e2e/code-math.spec.ts › \tag 与 \label / \eqref:引用显示编号;刷新所有数学公式` | 有 |

### PX 偏好设置 · 导出

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PX-01 | 默认导出文件夹:自动 / 与原文件同一目录 / 自定义 | `editor/tests/unit/export-flow.test.ts › 第一次导出默认放在文档所在文件夹;成功后记下,「使用上一次设置导出」沿用格式与位…`;`editor/tests/unit/parity-p3b.test.ts › PX-01「自动」:导出过之后沿用这篇文档上一次导出的位置`;`editor/tests/unit/parity-p3b.test.ts › PX-01「与原文件同一目录」:不管上次导出到哪,都用文档所在文件夹`;`editor/tests/unit/parity-p3b.test.ts › PX-01「自定义」:用指定的文件夹` | 有 |
| PX-02 | Pandoc 路径:自动检测 / 指定可执行文件 | `editor/tests/unit/export-flow.test.ts › 没装 Pandoc:提示「需要安装 Pandoc 以继续…」并给【安装说明】`;`冒烟 › checks.export_docx`(路径留空,自动检测);`冒烟 › checks.importDocx`(填上 Pandoc 的实际路径) | 有 |
| PX-03 | 导出后动作 | `editor/tests/e2e/preferences.spec.ts › 导出 HTML → 导出成功 → 导出后在访达中显示;导出并覆盖上一次导出的文件…`;`editor/tests/unit/export-flow.test.ts › 其它失败提示「导出失败:」+ 原因;导出后运行命令失败单独提示`;`editor/tests/unit/parity-p3b.test.ts › PX-03「打开导出文件」:导出后用默认应用打开导出的文件`;`editor/tests/unit/parity-p3b.test.ts › PX-03 运行自定义命令并「显示命令行输出」:弹出命令输出,没输出时写明;不勾…` | 有 |
| PX-04 | PDF 导出参数 | `冒烟 › nativeChecks.exportPdf`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testPaperSizesInPoints`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testExpandsVariablesAndKeepsUnknown`;`editor/tests/unit/exporter.test.ts › 大纲侧边栏、按一级标题分页、保留空白、字号、追加的 HTML 与作者`;`editor/tests/unit/parity-p3b.test.ts › PX-10 默认允许覆盖:title / author 进导出参数,header…`;`editor/tests/e2e/parity-gaps.spec.ts › PX-04 / PX-06 导出参数:PDF 的页边距与主题、图片的字号与主题都交给导出` | 有 |
| PX-05 | HTML 导出参数 | `editor/tests/unit/exporter.test.ts › 大纲侧边栏、按一级标题分页、保留空白、字号、追加的 HTML 与作者`;`editor/tests/unit/exporter.test.ts › 有样式:带主题与深色标记,公式保留 KaTeX 渲染结果` | 有 |
| PX-06 | 图片导出参数 | `冒烟 › nativeChecks.exportPng`;`冒烟 › checks.export_image`;`editor/tests/unit/exporter.test.ts › 大纲侧边栏、按一级标题分页、保留空白、字号、追加的 HTML 与作者`;`editor/tests/e2e/parity-gaps.spec.ts › PX-04 / PX-06 导出参数:PDF 的页边距与主题、图片的字号与主题都交给导出` | 有 |
| PX-09 | 导出项管理 | `editor/tests/e2e/parity-p3b.spec.ts › PX-09 导出项管理:从模板添加、重命名、上移 / 下移、删除前确认「删除该导…`;`editor/tests/unit/export-flow.test.ts › 从模板新建导出项` | 有 |
| PX-10 | 允许 YAML front matter 覆盖当前设置 | `editor/tests/unit/parity-p3b.test.ts › PX-10 默认允许覆盖:title / author 进导出参数,header…`;`editor/tests/unit/parity-p3b.test.ts › PX-10 关掉「允许 YAML front matter 覆盖当前设置」:文档…`;`editor/tests/unit/export-flow.test.ts › 读文档 YAML 里的导出键;YAML 写错按没有处理` | 有 |
| PX-11 | 自定义命令导出 | `editor/tests/unit/parity-p3b.test.ts › PX-11 执行前弹出「选择文件」:保存框按目标扩展名给默认文件名,${outp…`;`editor/tests/unit/parity-p3b.test.ts › PX-11 执行前弹出「选择文件夹」:${outputPath} 为所选文件夹;…`;`editor/tests/unit/parity-p3b.test.ts › PX-11 不弹选择框:直接执行,${outputPath} 为空`;`editor/tests/unit/parity-p3b.test.ts › PX-11 勾选「显示命令行输出」:执行后弹出命令输出;不勾选不弹`;`editor/tests/unit/export-flow.test.ts › 自定义命令导出项:在文档所在文件夹执行,变量替换`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testShellCommandReportsStatusAndOutput` | 有 |

### PA 偏好设置 · 外观

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PA-02 | 字体大小:使用主题的字体大小 / 自定义 | `editor/tests/e2e/parity-p3b.spec.ts › PA-02 字体大小:自定义 20 像素后正文变 20px;切回「使用主题的字体…` | 有 |
| PA-03 | 缩放比例 + 按住 ⌘ 时用滚轮缩放 | `editor/tests/e2e/preferences.spec.ts › 放大、缩小、实际大小命令`;`editor/tests/e2e/preferences.spec.ts › ⌘ + 滚轮与双指缩放;偏好里关掉后不再缩放`;`editor/tests/e2e/notion-keys.spec.ts › #35 ⌘+ 页面放大,#36 ⌘- 页面缩小`;`冒烟 › 菜单键位「放大」`;`冒烟 › 菜单键位「缩小」` | 有 |
| PA-04 | 总是显示字数统计 | `editor/tests/e2e/parity-p3b.spec.ts › PA-04 总是显示字数统计:默认常驻;关掉后状态栏字数隐藏,鼠标移到状态栏才显…` | 有 |
| PA-05 | 阅读速度 | `editor/tests/unit/wordcount.test.ts › 阅读时间按阅读速度(默认 382 字每分钟,不足 1 分钟按 1 分钟)`;`editor/tests/unit/wordcount.test.ts › 中日韩字符每字算一个词,西文按词` | 有 |
| PA-06 | 默认显示大纲视图 | `editor/tests/e2e/parity-gaps.spec.ts › PA-06 默认显示大纲视图:打开开关后启动时侧栏显示大纲` | 有 |

### PG 偏好设置 · 通用

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| PG-01 | 所有窗口被关闭后自动退出 | `冒烟 › nativeChecks.quitAfterLastWindow`;`editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示` | 部分:开关开 / 关时外壳的退出判断已测;真机待确认:开关关闭时关掉最后一个窗口后,点程序坞图标新开窗口 |
| PG-06 | 重置全部警告提示对话框 | `editor/tests/e2e/parity-p3b.spec.ts › PG-06 重置全部警告提示对话框:确认过的「上传图片」提示不再出现,重置后再次…`;`editor/tests/e2e/preferences.spec.ts › 页签齐全;编辑器页关闭打字机 / 专注模式;通用页重置警告提示` | 有 |

### X 菜单外的隐性能力

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| X-04 | 自动配对括号与引号 | `editor/tests/e2e/parity-p4.spec.ts › X-04 自动配对括号与引号:敲 ( 补出 ),敲 ) 越过;引号同理;关掉「匹…`;`editor/tests/e2e/parity-p3b.spec.ts › PE-02 匹配括号和引号:敲 ( 补出 ),敲 ) 越过,成对符号之间退格一起…`;`editor/tests/e2e/notion-keys.spec.ts › #8 敲完 [文字](网址) 成链接` | 有 |
| X-05 | 智能标点 | `editor/tests/e2e/preferences.spec.ts › 输入时转换:-- 变 –,--- 变 —;开启智能引号后直引号变弯引号`;`editor/tests/e2e/preferences.spec.ts › 渲染时转换:只改显示,文件里保留直引号与连字符`;`editor/tests/unit/smart-punctuation.test.ts › 按前一个字符决定左右引号;单引号在字母后是撇号`;`editor/tests/unit/smart-punctuation.test.ts › 破折号规则`;`editor/tests/unit/smart-punctuation.test.ts › 行内代码里不转换;关掉引号或破折号时只转另一种` | 有 |
| X-06 | 悬停预览 | `editor/tests/e2e/parity-p4.spec.ts › X-06 / X-46 悬停预览:悬停脚注号显示脚注内容,悬停网址链接显示地址;…`;`editor/tests/e2e/links-history.spec.ts › 悬停本地文档链接显示目标的标题与首段` | 有 |
| X-07 | ⌘+点击打开链接 | `editor/tests/e2e/parity-p4.spec.ts › X-07 ⌘+点击:网址交给浏览器,#标题 文内跳转,非 Markdown 的本…`;`editor/tests/e2e/links-history.spec.ts › ⌘+点击本地文档在新标签打开,⌥⇧+点击在新窗口打开`;`editor/tests/e2e/links-history.spec.ts › 文内锚点跳转可以 ⌘[ 返回;省略 .md 也能打开;网址交给浏览器`;`editor/tests/unit/navigation.test.ts › 修饰键:⌘ 新标签,⌥⇧ 新窗口` | 有 |
| X-09 | 标题锚点链接 | `editor/tests/unit/files.test.ts › 先找标题,重名加序号;再找 <a id> 命名锚点`;`editor/tests/unit/parity-p4.test.ts › X-09 <a name> 命名锚点能找到:段落里的、HTML 块里的;双引号、…`;`editor/tests/e2e/links-history.spec.ts › 文内锚点跳转可以 ⌘[ 返回;省略 .md 也能打开;网址交给浏览器`;`editor/tests/unit/exporter.test.ts › 标题锚点与 Typora 一致` | 有 |
| X-10 | 链接到本地文件 | `editor/tests/unit/navigation.test.ts › 相对路径、省略 .md、锚点、TextBundle、其它文件`;`editor/tests/unit/navigation.test.ts › 不存在:Markdown 与省略扩展名的写法可以新建,其它文件不能`;`editor/tests/unit/parity-p4.test.ts › X-10 绝对路径、file:// 地址、~/ 开头都按本机文档打开,可省 .m…`;`editor/tests/e2e/links-history.spec.ts › 目标不存在时询问并新建` | 有 |
| X-11 | 自动识别网址 | `editor/tests/e2e/notion-keys.spec.ts › #10 正文里的网址敲空格后自动成链接,保存仍是裸网址`;`editor/tests/unit/markdown-options.test.ts › 自动识别链接可以关掉:裸网址是普通文字,写回时不加转义` | 有 |
| X-12 | 尖括号链接与邮箱 | `editor/tests/e2e/code-math.spec.ts › <网址> 敲完即成链接,保存仍写 <网址>`;`editor/tests/unit/markdown-options.test.ts › 尖括号链接不受「自动识别链接」影响`;`editor/tests/unit/parity-p4.test.ts › X-12 <a@b.com> 解析成 mailto: 链接,文字是邮箱;这一段改…`;`editor/tests/e2e/parity-p4.spec.ts › X-12 尖括号邮箱 <a@b.com> 显示为邮箱链接,⌘+点击交给系统打开;…` | 有 |
| X-13 | 引用式链接与图片 | `editor/tests/e2e/notion-links.spec.ts › 未定义的引用式链接 ⌘+点击提示定义语法`;`editor/tests/unit/parity-p4.test.ts › X-13 [文字][id]、[文字][]、[文字] 与 ![图][id] 的地址…`;`editor/tests/e2e/parity-p4.spec.ts › X-13 引用式链接与图片:地址取自定义行;单击浮层【打开】打开定义里的文档;引…` | 有 |
| X-15 | 从 Finder 拷贝图片文件后粘贴 | `editor/tests/e2e/parity-gaps.spec.ts › X-15 剪贴板里是图片文件(Finder 里拷贝)时粘贴:存进 assets…`;`editor/tests/unit/assets.test.ts › 复制到 ./assets:目录不存在先询问「该目录不存在,是否立即创建?」,同名…` | 有 |
| X-16 | 拖入图片 | `editor/tests/e2e/parity-p4.spec.ts › X-16 拖入图片:Finder 一次拖入两张本机图片,都复制进 assets…`;`editor/tests/e2e/parity-p4.spec.ts › X-16 拖入浏览器里的图片:带 <img> 的网页拖放插入网络图片;拖来的是图…` | 有 |
| X-17 | 拖入文件或文件夹 | `editor/tests/e2e/preferences.spec.ts › Markdown 文件按偏好插入链接;文件夹在侧栏打开`;`editor/tests/e2e/parity-p4.spec.ts › X-17 拖入文件(默认偏好):Markdown 文件在新窗口打开;docx 等…`;`editor/tests/e2e/parity-p4.spec.ts › X-17 拖入文件(偏好选「插入链接」):文件夹插入以 / 结尾的链接,可导入文…`;`editor/tests/e2e/parity-p3a.spec.ts › PF-08 拖入文件夹选「插入文件夹链接」:插入 [文件夹名](相对路径/),侧…` | 有 |
| X-18 | 图片目标文件夹不存在 | `editor/tests/unit/assets.test.ts › 复制到 ./assets:目录不存在先询问「该目录不存在,是否立即创建?」,同名…`;`editor/tests/unit/assets.test.ts › 在询问里取消:不复制,返回 null` | 有(按钮文字【创建目录并继续】没断言) |
| X-20 | typora-root-url | `editor/tests/unit/parity-p4.test.ts › X-20 从文档 YAML 读出图片根路径:相对路径按文档所在文件夹解析;/ 开…`;`editor/tests/e2e/parity-p4.spec.ts › X-20 YAML 写了 typora-root-url:/ 开头的图片按这个根…`;`editor/tests/e2e/image-tools.spec.ts › 设置图片根目录与插入规则写进 YAML` | 有 |
| X-21 | typora-copy-images-to | `editor/tests/unit/parity-p4.test.ts › X-21 从文档 YAML 读出插图目录并决定落盘位置:相对、${filenam…`;`editor/tests/e2e/parity-p4.spec.ts › X-21 YAML 写了 typora-copy-images-to:粘贴的图片…`;`editor/tests/unit/assets.test.ts › YAML 的 typora-copy-images-to 优先;值为 uploa…` | 有 |
| X-23 | 导出变量 | `editor/tests/unit/parity-p4.test.ts › X-23 ${today} 为年-月-日;${outputFolder}、${c…`;`editor/tests/unit/parity-p4.test.ts › X-23 未保存的文档:标题取首个标题,文档位置相关的变量为空;YAML 的 t…`;`editor/tests/e2e/parity-p4.spec.ts › X-23 导出 PDF:页眉页脚里的 ${title}、${currentFil…`;`editor/tests/unit/export-flow.test.ts › 替换 ${变量},不认识的原样保留`;`app/Tests/TypozaKitTests/PreferencesKitTests.swift › testExpandsVariablesAndKeepsUnknown`;`冒烟 › nativeChecks.exportPdf`(读回 PDF 第 1 页页首为「页首 1」) | 有 |
| X-25 | 智能粘贴 | `editor/tests/e2e/parity-p4.spec.ts › X-25 智能粘贴:粘贴网页 HTML 保留标题、无序 / 有序列表、加粗与链接…`;`editor/tests/e2e/parity-p1.spec.ts › E-02 粘贴 HTML:优先取 HTML 并转成 Markdown,不用同时给…` | 有 |
| X-26 | 粘贴 Apple 备忘录列表 | 无用例 | 无 |
| X-27 | 代码语言补全 | `` editor/tests/e2e/parity-p4.spec.ts › X-27 代码语言补全:``` 与 ~~~ 建出的代码块,语言框都接上语言清单;… `` | 部分:三个反引号与 `~~~` 两种围栏的语言框都接上语言清单、选定语言写进围栏已测;真机待确认:输入语言名时下拉提示在 macOS 上弹出(下拉框由网页视图自己绘制,用例断言不到) |
| X-28 | 输入三个反引号后回车建代码块 | `` editor/tests/e2e/code-math.spec.ts › ``` 后回车建代码块,~~~ 同效 ``;`` editor/tests/e2e/notion-input.spec.ts › 分割线 --- 与代码块 ``` `` | 有 |
| X-29 | 输入 `$$` 后回车建公式块 | `editor/tests/e2e/notion-keys.spec.ts › #15 $$ 后回车成公式块` | 有 |
| X-30 | 输入 `\| 列1 \| 列2 \|` 后回车建表格 | `editor/tests/e2e/table.spec.ts › \|a\|b\| 回车建表,Tab 跳格,末格 Tab 新增一行` | 有 |
| X-31 | 输入 `[toc]` 后回车建目录 | `editor/tests/e2e/notion-keys.spec.ts › #17 [toc] 后回车成目录,存 [TOC],目录随标题更新` | 有 |
| X-35 | 输入列表标记成列表 | `editor/tests/e2e/notion-input.spec.ts › 块级输入:-`;`editor/tests/e2e/notion-input.spec.ts › 块级输入:*`;`editor/tests/e2e/notion-input.spec.ts › 块级输入:1.`;`editor/tests/e2e/notion-input.spec.ts › 块级输入:[]`;`editor/tests/e2e/notion-keys.spec.ts › #1 + 空格成无序列表,存偏好符号 -`;`editor/tests/e2e/notion-keys.spec.ts › #3 - [ ] 成未完成待办`;`editor/tests/e2e/notion-keys.spec.ts › #4 a. 成有序列表,存数字`;`editor/tests/e2e/notion-keys.spec.ts › #4 i. 成有序列表,存数字` | 有 |
| X-36 | 表格工具条 | `editor/tests/e2e/parity-p4.spec.ts › X-36 表格工具条:左 / 中 / 右对齐写出 :-、:-:、-:,只改当前列…`;`editor/tests/e2e/table.spec.ts › 工具条:调整行列数、更多 ▸ 格式化源码`;`editor/tests/unit/markdown.test.ts › 表格对齐与单元格换行` | 有 |
| X-37 | 表格行列拖拽 | `editor/tests/e2e/table.spec.ts › 拖行左边框调整行的位置`;`editor/tests/e2e/parity-p4.spec.ts › X-37 拖列上边框的手柄换列`;`editor/tests/e2e/parity-p4.spec.ts › X-37 表头行不参与拖动:悬停表头不出行手柄;把第一行拖到表头上不换位` | 有 |
| X-38 | 表格内 Tab | `editor/tests/e2e/table.spec.ts › \|a\|b\| 回车建表,Tab 跳格,末格 Tab 新增一行`;`editor/tests/unit/block-commands.test.ts › 末格 Tab 新增一行,光标进新行第一格`;`editor/tests/e2e/parity-p4.spec.ts › X-38 表格内 ⇧Tab:回到上一格,行首回到上一行末格;首格按 ⇧Tab 不…` | 有 |
| X-39 | 表格单元格换行 | `editor/tests/e2e/parity-p4.spec.ts › X-39 单元格里 ⇧↩ 换行,保存为 <br>`;`editor/tests/unit/markdown.test.ts › 表格对齐与单元格换行` | 有 |
| X-40 | 代码块语法高亮 | `editor/tests/e2e/parity-p4.spec.ts › X-40 代码块高亮:语言名不区分大小写(PYTHON、Python、py 都高…`;`editor/tests/e2e/code-math.spec.ts › 代码工具:为整个代码块调整缩进(缩进宽度默认 2)` | 有(语言清单实为 143 种,用例按「不少于 140 种」断言,对照表写的是「约 150 种」) |
| X-41 | 数学公式渲染 | `editor/tests/e2e/parity-p4.spec.ts › X-41 公式:mhchem \ce{} 能渲染;\newcommand 与 \…`;`` editor/tests/e2e/code-math.spec.ts › ```math 显示为公式,源码原样保存 ``;`editor/tests/e2e/code-math.spec.ts › 公式语法错误显示错误提示,源码不清空`;`editor/tests/e2e/code-math.spec.ts › \tag 与 \label / \eqref:引用显示编号;刷新所有数学公式`;`editor/tests/unit/diagram-math.test.ts › \ref 与 \eqref 换成编号,找不到显示 ??;\label 去掉` | 有 |
| X-43 | HTML 渲染 | `editor/tests/e2e/parity-p4.spec.ts › X-43 HTML 渲染:sup、kbd、ruby、带 style 的 span…`;`editor/tests/e2e/parity-gaps.spec.ts › X-43 段落里成对的 kbd、ruby、font 照样渲染,保存不改原文`;`editor/tests/unit/inline-html-tags.test.ts › kbd:渲染成 <kbd>,编辑后原样写回`;`editor/tests/unit/inline-html-tags.test.ts › ruby 里套 rt:两层都渲染,写回不变`;`editor/tests/unit/inline-html-tags.test.ts › font color 与带字号的 span:保留属性渲染,开标签原文写回`;`editor/tests/unit/inline-html-tags.test.ts › 只认白名单属性:事件处理、class、id 不进渲染结果,但写回原文不变`;`editor/tests/e2e/security.spec.ts › 本地网页嵌入不给同源;远程网页照常给;x.html#.pdf 不当 PDF`;`editor/tests/e2e/media.spec.ts › 视频文件丢失:显示「找不到媒体文件」与原路径`;`editor/tests/unit/markdown.test.ts › front matter、目录、提示框、折叠块`;`editor/tests/unit/exporter.test.ts › 去掉编辑器界面元素、注释、占位与编辑标记;本机图片改成相对导出文件的路径` | 有 |
| X-44 | HTML 安全 | `editor/tests/e2e/parity-p4.spec.ts › X-44 HTML 安全:文档里的 <script> 不执行,onload 属性…`;`editor/tests/e2e/security.spec.ts › 折叠块标题里的 <img onerror> 不在编辑器页面执行`;`editor/tests/e2e/security.spec.ts › 嵌入框不认 javascript: 地址(未保存的文档也一样)`;`editor/tests/e2e/security.spec.ts › HTML 预览去掉 class、id(防借应用样式仿冒界面),源码保留`;`editor/tests/e2e/context-edit.spec.ts › style 只显示源码`;`editor/tests/unit/media-tools.test.ts › 换成 <code> 显示原文,其余 HTML 不动`;`editor/tests/unit/exporter.test.ts › 预览里去掉,导出时还原` | 有 |
| X-45 | HTML 块编辑 | `editor/tests/e2e/parity-p4.spec.ts › X-45 HTML 块:点预览的空白处展开源码;⌘+点击块内链接只展开源码,不跳…`;`editor/tests/e2e/context-edit.spec.ts › 点内容不展开源码,⌘+点击展开`;`editor/tests/e2e/security.spec.ts › HTML 块里的相对链接按文档链接打开,不把编辑器页面换掉` | 有 |
| X-46 | 脚注交互 | `editor/tests/e2e/notion-links.spec.ts › 脚注:单击不跳转,⌘+点击跳到定义;未定义时提示语法`;`editor/tests/e2e/parity-p4.spec.ts › X-06 / X-46 悬停预览:悬停脚注号显示脚注内容,悬停网址链接显示地址;…` | 有 |
| X-47 | 字数统计 | `editor/tests/e2e/parity-p4.spec.ts › X-47 字数统计:状态栏显示全文字数,选中文字时显示选区;字数弹窗列出词、字符…`;`editor/tests/e2e/parity-p2.spec.ts › V-09 字数统计窗口:列出全文与选中部分的字数、段落、行数、阅读时间;状态栏字…`;`editor/tests/unit/wordcount.test.ts › 中日韩字符每字算一个词,西文按词`;`editor/tests/e2e/blocks.spec.ts › ⇧+点击选连续多块,⇧⌘+点击增减单块` | 有 |
| X-48 | 大纲交互 | `editor/tests/e2e/files.spec.ts › 大纲:折叠、全部折叠 / 展开、空态、大纲窗口`;`editor/tests/e2e/parity-p4.spec.ts › X-48 大纲:点侧栏大纲里的标题,光标落到该标题;大纲窗口里点击同样定位` | 有 |
| X-52 | 保存失败 | `editor/tests/e2e/files.spec.ts › 写盘失败:提示保存失败,全文放进剪贴板`;`editor/tests/e2e/parity-p4.spec.ts › X-52 保存失败:自动保存连续失败只在第一次写剪贴板;手动保存失败照常写` | 有 |
| X-53 | TextBundle | `editor/tests/e2e/parity-p4.spec.ts › X-53 TextBundle:打开包,标题栏显示包名;插图存进包里的 asse…`;`editor/tests/e2e/parity-p4.spec.ts › X-53 另存为选 .textbundle:建包(assets 文件夹与 inf…`;`editor/tests/unit/files.test.ts › TextBundle 是一个文档,标题取包名`;`editor/tests/unit/navigation.test.ts › 相对路径、省略 .md、锚点、TextBundle、其它文件`;`app/Tests/TypozaKitTests/FilesTests.swift › testListOpenableFilesUsesUnifiedExtensionsAndTextBundles` | 有 |
| X-54 | 文件编码识别 | `app/Tests/TypozaKitTests/KitTests.swift › testLegacyEncodingIsDetectedAndWrittenBack`;`app/Tests/TypozaKitTests/KitTests.swift › testUTF8WithBOMKeepsMarker`;`app/Tests/TypozaKitTests/KitTests.swift › testFallsBackToGB18030ForLegacyChinese`;`app/Tests/TypozaKitTests/KitTests.swift › testUTF16LittleEndianBOM`;`editor/tests/e2e/parity-p4.spec.ts › X-54 文件编码:外壳识别出的编码(GB18030)记在文档上,编辑后保存按原…` | 有 |
| X-55 | 命令行与默认应用 | `冒烟 › nativeChecks.openCommandLine` | 部分:`open -a` 命令行打开已测;真机待确认:在 Finder 里设为 .md 默认应用后双击打开 |
| X-58 | 新文件名建议 | `editor/tests/e2e/parity-p4.spec.ts › X-58 新文件名建议:未命名文档首次保存,保存框的默认文件名取首个标题`;`editor/tests/e2e/parity-p4.spec.ts › X-58 新文件名建议:首个标题不在第一行也取它;文件名里不能用的 / 和 :…` | 有 |
| X-60 | 单图段落居中 | `editor/tests/e2e/parity-gaps.spec.ts › X-60 段落只有一张图时居中,和文字同段时不居中;补上文字后不再居中` | 有 |

### Z Typoza 增强项

| 编号 | 功能 | 证据 | 判定 |
|---|---|---|---|
| Z-01 | 图片单击选中 | `editor/tests/e2e/parity-p4.spec.ts › Z-01 选中图片后点工具条「查看大图」打开灯箱`;`editor/tests/e2e/image-tools.spec.ts › 工具条选比例写 zoom,选 100% 回到 Markdown 写法`;`editor/tests/e2e/image-tools.spec.ts › 拖右下角手柄写宽度像素`;`editor/tests/e2e/image-tools.spec.ts › 工具条转换语法、删除`;`editor/tests/e2e/image-tools.spec.ts › 动图工具条可暂停与播放` | 有 |
| Z-02 | 图片灯箱 | `editor/tests/e2e/lightbox.spec.ts › 双击表格里的图片打开灯箱,可切换、缩放、关闭`;`editor/tests/e2e/lightbox.spec.ts › 双击正文大图打开,点空白处关闭`;`editor/tests/e2e/lightbox.spec.ts › 选中图片按空格也能打开(Notion)`;`editor/tests/e2e/lightbox.spec.ts › 首尾不循环:第一张按 ← 停住,最后一张按 → 停住`;`editor/tests/e2e/lightbox.spec.ts › 图片加载失败:灯箱内提示「图片无法加载」`;`editor/tests/e2e/lightbox.spec.ts › 放大后按住拖动平移图片,松手后灯箱仍开着`;`editor/tests/e2e/lightbox.spec.ts › ⌘ / ⌃ + 滚轮缩放图片,页面本身的缩放不变`;`editor/tests/e2e/parity-gaps.spec.ts › HTML 块里的图片双击打开灯箱`;`editor/tests/e2e/parity-p4.spec.ts › Z-02 选中图片按 ⌘↩ 打开灯箱;带链接的图片双击放大,不跳转`;`冒烟 › checks.tableImageLoaded`;`冒烟 › checks.lightboxOpened`;`冒烟 › checks.lightboxImageLoaded`;`冒烟 › checks.lightboxCounter` | 有 |
| Z-03 | 动图播放控制 | `editor/tests/e2e/image-tools.spec.ts › 动图工具条可暂停与播放`;`editor/tests/e2e/image-tools.spec.ts › 普通图片不显示暂停按钮`;`editor/tests/e2e/lightbox.spec.ts › 动图在表格里正常显示并可放大`;`editor/tests/e2e/parity-p4.spec.ts › Z-03 扩展名为 .apng 与 .webp 的图片按动图处理:工具条显示暂停…`;对照表说明列已写明按扩展名识别(.gif、.apng、.webp) | 有 |
| Z-04 | 视频块 | `editor/tests/e2e/media.spec.ts › /video 填在线视频网址存成嵌入;留空回车选本机文件`;`editor/tests/unit/media-tools.test.ts › 在线视频网站存 <iframe> 嵌入地址,直链存 <video>`;`editor/tests/e2e/media.spec.ts › 粘贴图片 / 视频直链:菜单首项换成图片 / 视频`;`editor/tests/e2e/media.spec.ts › 选中视频按空格播放 / 暂停,不改文档` | 有 |
| Z-05 | 音频块 | `editor/tests/e2e/notion-slash-items.spec.ts › /audio 填音频直链存 <audio>`;`editor/tests/e2e/notion-keys.spec.ts › 三 粘贴音频直链:菜单首项是【音频】,选中存 <audio>` | 有 |
| Z-06 | 在线嵌入 | `editor/tests/e2e/notion-slash-items.spec.ts › /embed 输入视频网站网址存播放器嵌入`;`editor/tests/e2e/media.spec.ts › 站点拒绝嵌入:提示并可在浏览器打开或改为书签`;`editor/tests/e2e/media.spec.ts › 嵌入连不上:显示无法加载嵌入内容`;`editor/tests/e2e/security.spec.ts › 本地网页嵌入不给同源;远程网页照常给;x.html#.pdf 不当 PDF`;`editor/tests/unit/embed-security.test.ts › 只有远程网页给同源`;`app/Tests/TypozaKitTests/MediaKitTests.swift › testXFrameOptionsRefuses`;`app/Tests/TypozaKitTests/MediaKitTests.swift › testFrameAncestorsWithoutWildcardRefuses`;`app/Tests/TypozaKitTests/MediaKitTests.swift › testServerErrorIsUnreachable` | 有 |
| Z-09 | PDF 内嵌 | `editor/tests/e2e/media.spec.ts › /pdf 填网址插入 PDF`;`editor/tests/e2e/media.spec.ts › 选中 PDF 按 ⌘↩ 用系统「预览」打开`;`editor/tests/e2e/parity-p4.spec.ts › Z-09 选中网络 PDF 按 ⌘↩ 交给浏览器打开(本机 PDF 才用「预览」…`;`editor/tests/unit/media-tools.test.ts › PDF 网址存成 <iframe src="….pdf">`;`editor/tests/unit/embed-security.test.ts › PDF 只看路径:x.html#.pdf 不算 PDF(否则绕开沙箱)` | 有 |
| Z-10 | Notion 输入体系(斜杠菜单、块手柄、`[[`、`@`、颜色) | `editor/tests/e2e/slash.spec.ts › 条目名按 PRD,中文名不计空格也能命中`;`editor/tests/e2e/notion-input.spec.ts › 斜杠菜单:过滤并插入表格`;`editor/tests/e2e/notion-keys.spec.ts › 拖「⋮⋮」到其他块之后:移动块`;`editor/tests/e2e/notion-slash-items.spec.ts › 点块左侧「+」:在下方新建空块并打开斜杠菜单(7.1)`;`editor/tests/e2e/slash.spec.ts › [[ 就地模糊匹配文档,链接标题取目标文档首个一级标题`;`editor/tests/e2e/emoji-mention.spec.ts › @ 提及文档:插入相对链接;邮箱里的 @ 不触发`;`editor/tests/e2e/emoji-mention.spec.ts › @ 提及日期:插入日期文字`;`editor/tests/e2e/notion-slash-items.spec.ts › /red 给当前块设文字颜色`;`editor/tests/e2e/notion-keys.spec.ts › #54 ⇧⌘H 应用上次使用的颜色;从未用过时为黄色背景` | 有(按本行点名的五项判定;`notion-input.md` 的逐条规则不在本行范围) |
| Z-11 | 页面图标与封面 | `editor/tests/e2e/notion-slash-items.spec.ts › /icon 输入表情作页面图标,写进 YAML`;`editor/tests/e2e/notion-slash-items.spec.ts › /cover 选图片作页面封面:拷进资源目录,写进 YAML`;`editor/tests/e2e/context-edit.spec.ts › 添加、移除页面图标`;`editor/tests/e2e/context-edit.spec.ts › 添加封面:选图片拷进资源目录;移除封面`;`editor/tests/unit/media-tools.test.ts › 新增、修改、删除键,保留其它键` | 有 |
| Z-12 | 云同步(可选,端到端加密) | `editor/tests/e2e/sync.spec.ts › 注册 → 保存恢复码 → 添加同步文件夹 → 状态栏已同步 → 恢复云端旧版本`;`editor/tests/e2e/sync.spec.ts › 两步验证:开启后登录要验证码;登录失效时状态栏提示`;`editor/tests/e2e/sync.spec.ts › 文件树同步标记;冲突副本并排对比后保留我的版本`;`editor/tests/unit/sync.test.ts › 关联文件夹:重叠报错、历史版本只对库内文件`;`helper/internal/syncsvc/service_test.go › TestTwoDevicesThroughRPC`;`typoza-backend/e2e/sync_test.go › TestE2E_RegisterTwoDevicesSync`;`typoza-backend/e2e/sync_test.go › TestE2E_ConcurrentEdits`;`typoza-backend/e2e/sync_test.go › TestE2E_DeleteTrashRestore`;`typoza-backend/e2e/sync_test.go › TestE2E_HistoryRestore`;`typoza-backend/e2e/sync_test.go › TestE2E_ChangePassword`;`typoza-backend/e2e/sync_test.go › TestE2E_RecoveryReset`;`typoza-backend/e2e/sync_test.go › TestE2E_LargeFileAndDedup`;`typoza-backend/e2e/sync_test.go › TestE2E_LiveSync`;`typoza-backend/e2e/sync_test.go › TestE2E_TamperedServerData`;`冒烟 › checks.syncHelper` | 有(端到端加密:后端每条 TestE2E 用例收尾时扫描数据库与对象存储,断言找不到明文标记,见 `typoza-backend/e2e/harness_test.go`) |
| Z-13 | 本地历史版本面板 | `editor/tests/e2e/links-history.spec.ts › 预览标出差异;复制内容;恢复此版本前先记快照并提示恢复到的时间`;`editor/tests/e2e/links-history.spec.ts › 删除后在「已删除的文件」里找回;改名后历史跟着走`;`editor/tests/unit/files.test.ts › 标出这个版本多出、少了的行`;`app/Tests/TypozaKitTests/KitTests.swift › testSnapshotsCoalesceAndKeepOriginal`;`app/Tests/TypozaKitTests/FilesTests.swift › testPinnedSnapshotSurvivesCoalescing`;`app/Tests/TypozaKitTests/FilesTests.swift › testHistoryFollowsRenameAndListsDeletedFiles` | 有 |
| Z-14 | 文档后退 / 前进 | `editor/tests/e2e/notion-keys.spec.ts › #4 ⌘[ 回到上一个查看位置,#5 ⌘] 前进`;`editor/tests/e2e/links-history.spec.ts › 单击显示浮层:复制、打开后 ⌘[ 返回原位置、⌘] 前进`;`editor/tests/unit/navigation.test.ts › 后退回到跳转前的文档与位置,前进再回来;新的跳转清空前进`;`冒烟 › 菜单键位「后退」`;`冒烟 › 菜单键位「前进」` | 有 |

## 三、仍未完全覆盖

共 16 行:部分 14 行、无 2 行。按原因分:

- 要在真机上确认:15 行(A-07、F-04、E-38、E-39、P-18、M-30、V-11、S-14、S-20、PF-01、PE-08、PG-01、X-26、X-27、X-55)。
- 依赖的外部服务还没接入:1 行(A-04)。

| 编号 | 功能 | 判定 | 缺什么 | 原因 |
|---|---|---|---|---|
| A-04 | 检查更新 | 部分 | 菜单「检查更新」的三种结果:当前已是最新;有新版本时弹【下载】【以后再说】;更新服务未配置时提示「无法检查更新」 | 更新服务地址还没配置(待人工提供);接入后可在冒烟里用本地假更新源测 |
| A-07 | 退出 ⌘Q | 部分 | 多个窗口都有未保存修改时逐个询问 | 需真机:逐个窗口询问由外壳调度,浏览器里的用例只有一个窗口 |
| F-04 | 打开… ⌘O | 部分 | 真应用里 ⌘O 弹出外壳的打开面板(可同时选文件和文件夹)这一段 | 需真机:系统打开面板没有自动检查;选中之后的打开逻辑已测 |
| E-38 | 拼写和语法 | 部分 | 网页视图对「检查拼写和语法」「自动纠正拼写」的响应 | 需真机(对照表本身标了待真机确认) |
| E-39 | 添加到字典 / 忘记拼写 | 部分 | 按住 ⌥ 右键后,系统菜单里「学习拼写 / 忘记拼写」出现并生效 | 需真机:系统菜单与用户词典在浏览器里测不到 |
| P-18 | 表格 ▸ 复制表格 | 部分 | 从菜单栏「段落 ▸ 表格 ▸ 复制表格」执行时,系统拷贝能否用 | 需真机:复制走网页的系统拷贝,要求来自一次用户操作;工具条点击已测,菜单栏命令由外壳转发,是否算用户操作要在真机上点一次确认 |
| M-30 | 拍照(从 iPhone 拍照或扫描) | 无 | 全部:从 iPhone 拍照后图片按插图规则存盘并插入 | 需真机:要配对 iPhone;代码里没有专门入口,靠按住 ⌥ 右键让出的系统菜单 |
| V-11 | 双指缩放 | 部分 | 触控板捏合能否传到网页视图 | 需真机(对照表本身标了待真机确认);用例用带 ⌃ 的滚轮事件模拟 |
| S-14 | 在新窗口中打开 / 打开方式… / 快速查看 | 部分 | 快速查看的预览窗口是否前置 | 需真机(对照表本身标了待真机确认) |
| S-20 | 撤销上一次文件操作 | 部分 | 焦点在侧栏时按 ⌘Z 先撤销文件操作 | 需真机(对照表本身标了待真机确认):⌘Z 在真应用里先经菜单栏的标准「撤销」 |
| PF-01 | 启动选项 | 部分 | 真实冷启动时按四种选项恢复;「打开新文件」时出现空白新文档 | 需真机:测试用的浏览器环境不会走启动恢复,用例直接调用了恢复逻辑;也可在冒烟里按四种选项各冷启动一次 |
| PE-08 | 拼写检查语言 | 部分 | 系统词典按所选语言检查 | 需真机:用例只断言设置交给了外壳 |
| PG-01 | 所有窗口被关闭后自动退出 | 部分 | 开关关闭时关掉最后一个窗口后,点程序坞图标新开窗口 | 需真机:冒烟只核对了外壳的退出判断 |
| X-26 | 粘贴 Apple 备忘录列表 | 无 | 全部:从备忘录拷出的列表粘贴后保持列表结构 | 需真机:先在真机上从备忘录拷一次,采集剪贴板样本,再据此写网页端用例 |
| X-27 | 代码语言补全 | 部分 | 输入语言名时下拉提示在 macOS 上弹出 | 需真机:下拉框由网页视图自己绘制,用例只能断言语言框接上了清单 |
| X-55 | 命令行与默认应用 | 部分 | 在 Finder 里把 Typoza 设为 .md 默认应用后双击打开 | 需真机 |
