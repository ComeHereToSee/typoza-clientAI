# bugs · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- micromark-quadratic-parse.md —— 大文档解析平方级变慢:micromark EditMap 每次复制未改动前缀,postinstall 打补丁(`scripts/patch-deps.mjs`,单测守护)
- prosemirror-tables-gotchas.md —— prosemirror-tables 1.8:`addColumn` 在多步事务里位置映射越界、`moveTableRow` 按选区找表,各自的修法
