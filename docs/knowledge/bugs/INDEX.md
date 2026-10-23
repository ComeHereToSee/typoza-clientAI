# bugs · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- micromark-quadratic-parse.md —— 大文档解析平方级变慢:micromark EditMap 每次复制未改动前缀,postinstall 打补丁(`scripts/patch-deps.mjs`,单测守护)
- prosemirror-tables-gotchas.md —— prosemirror-tables 1.8:`addColumn` 在多步事务里位置映射越界、`moveTableRow` 按选区找表,各自的修法
- macos-shell-gotchas.md —— macOS 外壳:打印 / 导出 PDF 回调在打印线程上回网页触发 WebKit 主线程断言崩溃;系统自动插入「表情与符号」、改名「设置…」、加备用项;冒烟里窗口命令前先调到前台;合成按键测 ⌘↑ ⌃A
- editor-ui-fixes.md —— 补对照表用例撞出的界面缺陷:单图居中被段尾 br 挡住、块手柄盖住待办复选框、子菜单盖住父菜单、替换下一个跳过、偏好不当场生效、保存后误报被其他程序修改、行内 kbd / ruby 不渲染
- review-and-device-fixes.md —— 第二期审查与真机:询问期间自动保存覆盖外部版本、写盘途中的字被标已保存、保存乱序、历史快照被合并、符号链接收不到外部修改、同名桥接分支、命令导出注入、Pandoc 闪退、导出代码块为空、恢复码面板可关、后台时代码块不同步、[hidden] 被盖、正文压标题、AI 版欢迎文档应用名、选区跟上再执行命令、导出时图表空白
