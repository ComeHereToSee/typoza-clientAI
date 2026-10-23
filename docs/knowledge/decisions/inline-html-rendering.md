# 段落里的行内 HTML 怎么渲染、怎么防仿冒

> 分类:决策(ADR)。2026-10-23 定案;实现 `editor/src/core/schema.ts`(`html_tag`、`HTML_TAG_MARKS`、`HTML_TAG_ATTRS`、`withoutPositioning`)、`editor/src/core/markdown/transform.ts`(`htmlTagWrapper`)、`editor/src/styles/editor.css`(`.tz-html-preview`)。

## 背景
Typora 在段落里直接渲染 `<kbd>`、`<ruby>`、`<font color>`、带样式的 `<span>`;Typoza 原来只把少数成对标签转成格式标记,其余显示为淡色源码。文档里的 HTML 又可能被用来盖住界面仿冒(对照表 X-44)。

## 结论
- 成对的行内标签在白名单里(kbd、ruby、rb、rt、rp、small、big、abbr、cite、q、var、samp、dfn、bdi、bdo、time、span、font)时转成标记 `html_tag`:属性 `tag` + `open`(开标签原文)。渲染成同名元素,写回时 `open` + 内容 + `</tag>`,不改原文。同一种标记可叠多层(`excludes: ''`,ruby 里套 rt),`inclusive: false`。
- 渲染时属性只留 style、title、lang、dir、color、face、size、datetime;不带事件属性、class、id(与 HTML 块预览同一口径)。
- style 先交给浏览器解析再删 `position`、`z-index`,用 `cssText` 写出:注释、大写、转义(`posi\74ion`)等写法都按浏览器自己的理解,文本匹配挡不全。
- HTML 块预览整体 `contain: paint`:里面的 `position:fixed` 也以预览框为准,盖不住编辑器界面。

## 取舍
- 不用 DOMPurify 渲染行内标签:行内标签是格式标记,要能跟 Markdown 格式嵌套、跟着编辑;白名单 + DOM 接口写属性已不能注入脚本(页面 CSP 也只许自带脚本)。
- 已知局限(写进 `docs/tech/architecture.md` 第 7 节):transform、负外边距、大阴影等仍能在编辑区里画出大块遮盖,但被滚动容器裁在正文区域内,盖不到侧栏与状态栏;这类写法挡不完,不逐个封堵。
- 导出 HTML / PDF 时行内样式文本按浏览器规整(`font-size:20px` → `font-size: 20px;`),浏览器不认识的属性会丢;.md 原文不受影响。
