# 编辑器界面与交互的 bug(2026-10-23 补对照表用例时发现)

> 分类:bug。来源:给 Typora 对照表的「实现」行逐条补自动化证据时,用例直接撞出的真实缺陷;每条都有用例守住(`editor/tests/e2e/parity-gaps.spec.ts`,标题以对照表编号开头)。

1. **单图段落从未居中(X-60)**:样式表 `p > .tz-image:only-child` 永远不中——ProseMirror 给以非文字结尾的段落补 `<br class="ProseMirror-trailingBreak">`(Safari / Chrome 还补 `img.ProseMirror-separator`),图片不是唯一子元素;文字节点样式表也看不见。改为插件给「只有一张图」的段落加类 `tz-image-only`,只重算改动所在顶层块(`plugins/basics.ts` `imageOnlyPlugin`)。
2. **块手柄盖住待办复选框(P-30)**:`blockAt` 对列表项里的段落返回段落本身(列表项是容器),手柄按段落左缘 −52 放,正好压在复选框上,点复选框点到手柄。改为列表项首块按整项对齐(`plugins/handle.ts` `firstBlockOfListItem`)。
3. **子菜单靠窗口右缘时盖住父菜单**:子菜单按视口夹位置,右侧放不下就被推到父菜单上。改为放不下时翻到父菜单左边(`ui/menu.ts` `openSub`)。
4. **「替换下一个」跳过一处(E-44)**:替换后重算的当前项已是光标后的第一处,原代码又前进一格。改为直接选中重算后的当前项(`plugins/find.ts` `replaceCurrent`)。
5. **偏好改了不当场生效**:大纲折叠开关只在建侧栏时读一次(补 `Sidebar.setOutlineCollapsible`);代码块行号 / 折行在「重建状态」键里,但节点视图被复用不重配(移进重画节点视图的键,`app/prefs-apply.ts`)。
6. **保存自己的文件偶发误报「文件已被其他程序修改」**:文件监视的通知可能比写盘回执先到,此时已保存的时间与内容还是旧的、文档仍是「已修改」,于是弹询问。`DocumentSession.saving` 记下进行中的写盘,`onExternalChange` 先等它写完再比(`app/document.ts`、`app/app.ts`)。真应用冒烟里由询问框抢走当前窗口暴露出来。
7. **段落里的 kbd、ruby、font、带样式的 span 显示成淡色源码(X-43)**:成对标签原来只认 u / sup / sub / mark / s / b / i 与纯颜色 span。新增通用标记 `html_tag`(开标签原文存属性、原样写回;标签与属性走白名单),见 `decisions/inline-html-rendering.md`。
8. **其它**:复制 / 移动图片后的地址与插入图片不同口径(统一用 `assets.ts` `documentSrc`);TextBundle「在 Finder 中显示」给的是包里的 text.md(改为包本身)。
