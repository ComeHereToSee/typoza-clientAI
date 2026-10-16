# 知识库速查入口(INDEX)· Typoza 基础版(typoza-client)

> 本项目 = Typoza:Typora 复刻 + Notion 输入习惯 + 端到端加密云同步的 macOS 编辑器(Swift 外壳 + WKWebView 里的 ProseMirror 编辑器 + Go 辅助进程)。本页 = 纯路由页,逐条摘要在各分区子索引。AI 版(typoza-AI)由本仓库派生,共用这些知识。

## 检索方法

- 检索三跳:本路由页 → 分区子索引 → 具体文件。
- 关键词检索(本机维护脚本,不入库):`python3 localClaude/kb-tool.py find <关键词>...`;`subindex <目录>` 增量刷新子索引;`audit` 体检(每轮收尾跑一次)。

## 分区路由

- 踩坑(WebKit 编辑与渲染、Playwright E2E 写法)→ `pitfalls/INDEX.md`
- 缺陷与修复(micromark 平方级解析、prosemirror-tables 用法)→ `bugs/INDEX.md`
- 决策(大文档首屏与输入延迟方案)→ `decisions/INDEX.md`
- 质量与性能基线(启动 / 大文档 / 输入 / 包体实测)→ `quality/INDEX.md`
- 产品需求与技术方案不在本库:`docs/prd/`、`docs/tech/architecture.md`

## 页内纪律

- 本页只指路、不写摘要,保持 4096 字节以内;新知识 = 文件落子目录 + 子索引登记一行;本页仅在新增分区时改。
