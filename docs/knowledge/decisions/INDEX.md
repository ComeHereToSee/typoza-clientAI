# decisions · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- large-document.md —— 大文档(MB 级)方案:分段解析 + 渐进打开(载完前只读)+ 视口裁剪;选型理由、代价与 CI 实测
- inline-html-rendering.md —— 段落里成对行内 HTML 标签渲染成 `html_tag` 标记(白名单、原文写回),style 交浏览器解析后去定位,HTML 块预览 `contain: paint`;已知局限
