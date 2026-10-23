# bugs · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- micromark-quadratic-parse.md —— 大文档解析平方级变慢:micromark EditMap 每次复制未改动前缀,postinstall 打补丁(`scripts/patch-deps.mjs`,单测守护)
- prosemirror-tables-gotchas.md —— prosemirror-tables 1.8:`addColumn` 在多步事务里位置映射越界、`moveTableRow` 按选区找表,各自的修法
- macos-shell-gotchas.md —— macOS 外壳:打印 / 导出 PDF 回调在打印线程上回网页触发 WebKit 主线程断言崩溃;系统自动插入「表情与符号」、改名「设置…」、加备用项;冒烟里窗口命令前先调到前台;合成按键测 ⌘↑ ⌃A
- editor-ui-fixes.md —— 补对照表用例撞出的界面缺陷:单图居中被段尾 br 挡住、块手柄盖住待办复选框、子菜单盖住父菜单、替换下一个跳过、偏好不当场生效、保存后误报被其他程序修改、行内 kbd / ruby 不渲染
