# 大文档解析平方级变慢(micromark EditMap)

> 分类:bug。2026-10-16 定位并修复;数据来自 CI 性能工作流(`.github/workflows/perf.yml`)与 macOS 冒烟。

- **现象**:5MB 混排 Markdown 解析在 WebKit 真应用里约 52 秒,Chromium 里 1MB→2MB→5MB 为 2.5s→9s→37s(超线性)。
- **根因**:`micromark/lib/initialize/document.js` 每关一次容器(列表、引用)都对**整篇到目前为止的事件数组**调用 `micromark-util-edit-map` 的 `EditMap.consume`,而 `consume` 会把第一处修改之前的前缀整段复制再塞回去 → 每次 O(全文),整篇 O(n²)。`micromark-extension-gfm-table` 自带一份同样写法的 EditMap(另一个副本)。
- **修复**:`editor/scripts/patch-deps.mjs`(npm postinstall)删掉前缀复制,四个文件(两个包各自的生产版与开发版);片段对不上时安装直接失败;`tests/unit/deps-patch.test.ts` 校验补丁落盘。另外大文档按可安全切分的块边界分段解析(`core/markdown/chunks.ts`),总耗时与文档大小近似线性。
- **结果**:5MB 解析 52s → 3.4s(macOS 真应用)。
- **防复发**:依赖补丁要按剖析出的热点**源码位置**定位文件(perf 报告里的「热点源码」一节会打印所属包),同名类可能有多个副本;构建期插件对 node_modules 不可靠(Vite 8 不经插件转换依赖),补丁放安装阶段。
