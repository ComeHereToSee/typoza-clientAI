# 性能基线(启动 / 大文档 / 输入 / 包体)

> 分类:质量基线。数字全部来自 CI 实测,改动后对照这里看有没有退化。PRD 质量要求:冷启动 ≤1 秒、5MB 文档首屏 ≤1.5 秒、输入 p95 ≤16 毫秒、安装包 ≤30MB。

## 从哪里取数
- 真应用:macOS CI 的冒烟(`ci/smoke-macos.sh` → `ci/macos` 分支 `smoke/smoke.json`),在 WKWebView 里打开 5MB 文档、连续输入、保存。
- 规模曲线:`perf` 工作流(推到 `perf` 分支触发,`editor/scripts/perf-profile.mjs`),Chromium 与 Playwright WebKit 各跑 64KB~5MB 档位,报告在 `ci/perf` 分支 `perf/perf.md`。

## 基线(2026-10-16,dev 07f508b)

| 指标 | 实测 | 目标 | 说明 |
|---|---|---|---|
| 5MB 首屏(真应用) | 297 毫秒 | ≤1.5 秒 | 先显示第一段,其余后台续上 |
| 5MB 全文载完(真应用) | 6.3 秒 | — | 改前 19 秒;载完前只读 |
| 5MB 输入 p95(真应用) | 17 毫秒 | ≤16 毫秒 | 略超;CI 虚拟机抖动大,最大 29 毫秒 |
| 1MB 输入 p95(Chromium) | 4.3 毫秒 | — | 派发 4.1 毫秒 |
| 全文载完 1 / 2 / 5MB(Chromium) | 1.7 / 4.7 / 7.3 秒 | — | 近似线性 |
| 启动到可编辑(CI 首次启动) | 1.93 秒 | ≤1 秒 | 未达标;WebView 建好到开始导航占 1.1 秒(冷虚拟机首次拉起网页进程) |
| 安装包 DMG | 12.6MB | ≤30MB | |

## 已知的大头
- 解析:5MB 里 micromark 占 3.8 秒(真应用),已靠分段变成线性,再快只能换解析器(见 `decisions/large-document.md`)。
- 启动:`webViewCreated` → `navigationStarted` 之间是网页进程启动,外壳侧能做的只有尽早建 WebView、尽早发起导航。
