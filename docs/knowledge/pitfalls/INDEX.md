# pitfalls · 子索引

> 检索三跳:主 INDEX 路由页 → 本索引 → 具体文件。

- e2e-playwright.md —— E2E(Playwright WebKit)写法的坑:`toContainText` 不读 `<style>`、ProseMirror 按时间与位置判双击、悬停浮层挡点击、失败时从 `ci/editor` 取 trace.zip 读重试原因
- webkit-editing.md —— WebKit 编辑与渲染的坑:选区进 `display:none` 被丢、视口裁剪用样式表不用节点装饰(DecorationSet 平方级)、换文档重建视图、CodeMirror 懒加载、程序化聚焦后原生键失效
- ci-and-tooling.md —— 读 CI 用 raw.githubusercontent 免 fetch 大分支、仓库真名、zsh `$b:` 修饰符、Swift 下标尾随闭包与 `Self.嵌套类型`、本机只能 `swiftc -parse`、依赖补丁重复插入、真机后台操作的焦点 / 节流 / 保存面板限制、并行子代理先写后补防中断
