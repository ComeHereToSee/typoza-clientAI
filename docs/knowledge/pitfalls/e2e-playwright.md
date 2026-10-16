# E2E(Playwright WebKit)写法的坑

> 分类:踩坑。来源:2026-10-16 四路补丁合并后的 E2E 修复。

- `toContainText` 不读 `<style>` / `<script>` 的内容:要断言样式表文字,用 `page.evaluate` 取 `textContent`。
- ProseMirror 自己按时间(500ms)与位置(10px)判双击:紧接在点编辑区中心之后点居中的图片,会被当成双击而不选中。辅助函数点编辑区右下角留白聚焦。
- 悬停才出现的浮层(图片工具条)若盖住目标,Playwright 会一直重试「intercepts pointer events」直到超时;工具条放在图片外侧上方,过渡区高度不能伸进图片。
- 失败时 CI 会把 `test-results/**/trace.zip` 推到 `ci/editor` 分支:解压后 `*.trace` 是 JSON 行,`type=log` 有每次动作的重试原因,`pageError` 有页面异常。
