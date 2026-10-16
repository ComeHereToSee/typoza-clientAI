# decisions · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- large-document.md —— 大文档(MB 级)方案:分段解析 + 渐进打开(载完前只读)+ 视口裁剪;选型理由、代价与 CI 实测
