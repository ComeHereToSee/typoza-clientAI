# E2E(Playwright WebKit)写法的坑

> 分类:踩坑。来源:2026-10-16 四路补丁合并后的 E2E 修复。

- `toContainText` 不读 `<style>` / `<script>` 的内容:要断言样式表文字,用 `page.evaluate` 取 `textContent`。
- ProseMirror 自己按时间(500ms)与位置(10px)判双击:紧接在点编辑区中心之后点居中的图片,会被当成双击而不选中。辅助函数点编辑区右下角留白聚焦。
- 悬停才出现的浮层(图片工具条)若盖住目标,Playwright 会一直重试「intercepts pointer events」直到超时;工具条放在图片外侧上方,过渡区高度不能伸进图片。
- 失败时 CI 会把 `test-results/**/trace.zip` 推到 `ci/editor` 分支:解压后 `*.trace` 是 JSON 行,`type=log` 有每次动作的重试原因,`pageError` 有页面异常。
- CI 跑在 Linux WebKit 上,`prosemirror-keymap` 把 Mod 归成 Ctrl:⌘X 与 ⌃⌘X 在这里是同一个键,同一张键表里后写的覆盖先写的。已知撞键:⌘E 被 ⌃⌘E「选中格式文本」覆盖、焦点在正文时 ⌘L 被 ⌃⌘L 吃掉、⌘= / ⌘- 被提升 / 降低标题级别吃掉、⌃- 注释被 ⌃⌘- 覆盖。macOS 上不受影响;这类用例先把焦点移出正文,或在 Linux 上跳过、改测别名键。原生菜单的键位另由 macOS 冒烟导出、与 `ci/menu-keys.json` 核对。⇧⌘L(Ctrl+Shift+L)焦点在正文时同样到不了应用级键位。
- Playwright 在 Linux WebKit 上模拟原生拖放(`dragTo`)时,落在 ProseMirror 编辑区里的 drop 到不了(trace 里按下、移动、松开都做了,文档不变);自己监听 drop 的元素(侧栏)能收到。测编辑区内的块拖放改在页面里派发 `DragEvent` + `new DataTransfer()`(dragstart → dragenter / dragover → drop → dragend),⌥ 复制用事件的 `altKey`(见 `tests/e2e/notion-keys.spec.ts` 的 `dragBlock`)。
- CI 的 Linux WebKit 排版比 macOS 真应用慢一个数量级:两万段的分段载入要 70~85 秒(真应用 5MB / 5.4 万块约 6 秒),贴着 90 秒超时偶发失败。大文档 E2E 用八千段左右即可覆盖分段载入;要断言「载入中」的状态,在打开文件的同一次 `page.evaluate` 里取,别跟后台续载赛跑。
- 2026-10-16~22 CI 大面积「失败 6~10 秒」:私有仓库 Actions 分钟数用尽(作业注解 `spending limit needs to be increased`,作业根本没启动、不会推 ci/* 分支)。看不到网页时查 `api.github.com/repos/<owner>/<repo>/actions/runs`(公开仓库免令牌,每小时 60 次)。仓库改公开后不计分钟。
