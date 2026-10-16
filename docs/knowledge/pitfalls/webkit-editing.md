# WebKit 编辑与渲染的坑(Typoza 编辑器跑在 WKWebView 里)

> 分类:踩坑。来源:2026-10-16 大文档性能改造与 E2E 排查,均经 CI(Playwright WebKit / macOS 真应用)验证。

## 1. 选区放进 `display:none` 的元素会被丢掉
- 现象:视口裁剪后跳到文末(⌘↓)再输入,字没出现。
- 根因:WebKit 不能把选区放进不排版的元素,会直接清空选区;之后 ProseMirror 发现 DOM 里没有选区(`editorOwnsSelection` 为假),不再同步。
- 做法:要在 ProseMirror 写 DOM 选区**之前**让目标块显示——视口窗口放在插件状态里随事务计算(`editor/src/plugins/viewport.ts`);原生的文首 / 文末跳转键由插件按文档位置处理。

## 2. 视口裁剪:隐藏远处的块用样式表,不用节点装饰
- 节点装饰的坑:给几万个顶层块各挂一个节点装饰(`.tz-vp-off`)时,ProseMirror 的 `DecorationSet` 建 / 加是「子节点数 × 装饰数」,分段载入 2 万块的 E2E 直接卡死(efe88fc,已退回)。
- 位置选择器的坑:`:nth-child(-n+K)` / `:nth-child(n+K)` 规则下,父元素插入子元素要给后面所有兄弟重算序号;每次改样式表都触发整页样式重算。
- 现行做法(`editor/src/plugins/viewport.ts`):一条 `@media screen` 的 `:nth-child` 规则挂在外层容器类 `tz-vp` 上,只在可见窗口变化时重写(规则文本相同就不写);分段追加时窗口不变、只改下内边距;只在文末追加时沿用已有高度、只给新块估高。实测 5MB 真应用全文载完 6.3 秒、输入 p95 17 毫秒(CI macOS,07f508b)。

## 3. 大文档换文档时别在旧视图上 `updateState`
- 现象:从 5MB 文档切到小文档要 20 秒以上。
- 根因:新旧文档差异大时,`updateState` 在已挂载的 DOM 上逐个拆旧节点。
- 做法:换文档销毁旧 EditorView、新建一个(`App.replaceView`),整块摘下旧 DOM;实测 0.3~1 秒。

## 4. 上千个 CodeMirror 实例拖慢打开与关闭
- 做法:代码块先放静态 `<pre>`,接近视口或获得光标时才建 CodeMirror(`views/codeblock.ts` 的 `ensureEditor`);图表 / 公式预览也等到那时再画(隐藏块里 Mermaid 量不到尺寸会画错)。

## 5. 程序化聚焦后原生光标移动键不生效
- 现象:E2E 里 `view.focus()` 后按 Home / ⇧方向键没反应。
- 做法:测试里用真实点击聚焦(`tests/e2e/helpers.ts` 的 `loadDoc` 点编辑区右下角留白)。
