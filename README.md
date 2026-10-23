# Typoza

macOS 原生 Markdown 编辑器:完整覆盖 Typora 的功能,输入方式与快捷键采用 Notion 风格,
加强图片(双击放大)、动图、视频与在线嵌入,可选端到端加密的云端保存。纯本地即可完整使用。

## 目录

| 目录 | 内容 |
|---|---|
| `editor/` | 编辑内核(TypeScript · ProseMirror + remark),在 WKWebView 中运行 |
| `app/` | macOS 原生外壳(Swift · AppKit + WKWebView) |
| `helper/` | 辅助进程(Go):云同步引擎,开启同步时才启动 |
| `scripts/` | 打包脚本(组装 .app、制作 DMG) |
| `ci/` | CI 辅助脚本 |
| `docs/` | 需求、技术方案、测试计划、知识库 |

## 构建

全部在 GitHub Actions 上完成(见 `.github/workflows/ci.yml`):编辑器在 Linux 上构建与测试(WebKit E2E),
辅助进程在 Linux 上交叉编译,macOS runner 上编译 Swift 外壳、组装 `Typoza AI.app`(应用标识 app.typoza.ai,数据目录 ~/Library/Application Support/Typoza AI,可与基础版同机并装)、冒烟自检并产出 `Typoza-AI.dmg`。
每个 job 的日志与产物推送到 `ci/<job>` 分支。
