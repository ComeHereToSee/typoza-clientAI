import { expect, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { hostCalls, putFile, runMenuCommand } from './media-helpers'

// Typora 对照表(docs/prd/typora-parity.md)P / M / V / T 区里证据只有「无」或「部分」、网页侧能测的行
// (清单见 localClaude/evidence/part-2.md 末尾)。H-01 / H-03 / H-04 / H-06 / H-07 是外壳的 native.* 命令,
// 只在 app/Sources/Typoza/AppDelegate.swift 里处理,浏览器里测不到,这里不测。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const menuItem = (id: string) => `.tz-context-menu [data-id="${id}"]`
const cell = (page: Page, text: string) => page.locator('.tz-editor td, .tz-editor th').filter({ hasText: new RegExp(`^${text}$`) })
const fileExists = (page: Page, path: string) => page.evaluate((p) => window.typozaTest!.host.files.has(p), path)
const savedSetting = (page: Page, key: string) => page.evaluate((k) => window.typozaTest!.host.settings[k], key)
const imageWidth = (page: Page, nth = 0) =>
  page
    .locator('.tz-editor .tz-image img')
    .nth(nth)
    .evaluate((el: HTMLImageElement) => el.naturalWidth)
const svg = (w: number, h: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#337EA9"/></svg>`
// 点击文字、⇧方向键改的是 DOM 选区,ProseMirror 经 selectionchange 异步同步过来;发菜单命令前先等它到位
const caretBlockText = (page: Page) => page.evaluate(() => window.typozaTest!.app.view.state.selection.$head.parent.textContent)
const selectedText = (page: Page) =>
  page.evaluate(() => {
    const { state } = window.typozaTest!.app.view
    return state.doc.textBetween(state.selection.from, state.selection.to)
  })

/** 直接在元素上派发右键菜单事件:网络图片在 CI 里加载失败、尺寸不定,不用真实右键点它。右键图片会先选中这张图。 */
async function contextMenuOn(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`找不到元素:${sel}`)
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }))
  }, selector)
  await expect(page.locator('.tz-context-menu')).toBeVisible()
}

// ---------- 段落 ▸ 表格 ----------

test('P-14 表格 ⌃⌘↑ 上移该行:与上一行换位,第一行数据不越过表头', async ({ page }) => {
  const mod = await modKey(page)
  // 非 macOS 上 Mod 就是 Ctrl,⌃⌘↑ 即 Ctrl+↑(与 table.spec.ts 的 ⌃⌘↓ 同理)
  const up = mod === 'Meta' ? 'Control+Meta+ArrowUp' : 'Control+ArrowUp'
  await loadDoc(page, '| a |\n| - |\n| 1 |\n| 2 |\n| 3 |\n')
  await cell(page, '3').click()
  await page.keyboard.press(up)
  expect((await markdown(page)).trim()).toBe('| a |\n| - |\n| 1 |\n| 3 |\n| 2 |')
  // 表头行固定(plugins/table.ts moveCurrent):第一行数据再上移不动
  await cell(page, '1').click()
  await expect.poll(() => caretBlockText(page)).toBe('1')
  await page.keyboard.press(up)
  expect((await markdown(page)).trim()).toBe('| a |\n| - |\n| 1 |\n| 3 |\n| 2 |')
})

test('P-18 复制表格:剪贴板同时有表格的 Markdown 与 HTML,文档不变', async ({ page }) => {
  await loadDoc(page, '| a | b |\n| - | - |\n| 1 | 2 |\n')
  await cell(page, '1').click()
  const toolbar = page.locator('.tz-table-toolbar')
  await expect(toolbar).toBeVisible()
  // 走工具条「更多 ▸ 复制表格」(与菜单同一命令 table.copy):系统拷贝要在用户点击里触发
  await toolbar.locator('button[title="更多"]').click()
  await page.locator('.tz-table-more .tz-menu-item', { hasText: '复制表格' }).click()
  // 拷贝后由外壳整体重写剪贴板(plugins/paste.ts copyWithRichText):纯文本是 Markdown 源码,另带 HTML 与 RTF
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
  const clip = await page.evaluate(() => window.typozaTest!.host.clipboard)
  expect(clip.html).toContain('<table')
  expect(clip.rtf).toBe(true)
  expect(await markdown(page)).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n')
})

test('P-20 删除表格:工具条【删表】与菜单命令都只删整张表,前后段落不动', async ({ page }) => {
  const md = '前文\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n后文\n'
  await loadDoc(page, md)
  await cell(page, '1').click()
  await page.locator('.tz-table-toolbar button[title="删除表格"]').click()
  await expect(page.locator('.tz-editor table')).toHaveCount(0)
  expect((await markdown(page)).trim()).toBe('前文\n\n后文')

  await loadDoc(page, md)
  await cell(page, '2').click()
  await expect.poll(() => caretBlockText(page)).toBe('2')
  await runMenuCommand(page, 'table.delete')
  await expect(page.locator('.tz-editor table')).toHaveCount(0)
  expect((await markdown(page)).trim()).toBe('前文\n\n后文')
})

// ---------- 段落 ▸ 代码工具、任务、插入段落 ----------

test('P-24 代码工具 ▸ 为选中内容调整缩进:只重排选中的行', async ({ page }) => {
  await loadDoc(page, '```js\nfunction f() {\nreturn 1\nreturn 2\nreturn 3\n}\n```\n')
  // 语言包按需加载,出现语法高亮后按语言的缩进规则才可用
  await expect(page.locator('.tz-code-block .tok-keyword').first()).toBeVisible({ timeout: 15_000 })
  // 点第 2 行(光标落在行尾),⇧↓ 选到第 3 行:选区只覆盖 return 1、return 2 两行
  await page.locator('.tz-code-block .cm-line').nth(1).click()
  await page.keyboard.press('Shift+ArrowDown')
  await runMenuCommand(page, 'code.indentSelection')
  // 缩进宽度默认 2(PM-18);return 3 不在选区里,保持原样
  await expect.poll(async () => (await markdown(page)).trim()).toBe('```js\nfunction f() {\n  return 1\n  return 2\nreturn 3\n}\n```')
})

test('P-30 ⌃X 切换任务状态:已完成与未完成来回切换', async ({ page }) => {
  await loadDoc(page, '- [x] 任务\n')
  await page.keyboard.press('Control+x')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('- [ ] 任务')
  await page.keyboard.press('Control+x')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('- [x] 任务')
})

test('P-30 点击复选框与菜单「切换任务状态」同效', async ({ page }) => {
  await loadDoc(page, '- [ ] 任务\n')
  const box = page.locator('.tz-editor .tz-task-box')
  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'true')
  expect((await markdown(page)).trim()).toBe('- [x] 任务')
  await box.click()
  await expect(box).toHaveAttribute('aria-checked', 'false')
  expect((await markdown(page)).trim()).toBe('- [ ] 任务')
  // 点复选框不动光标(views/blocks.ts 按下时 preventDefault),光标仍在这一项里
  await runMenuCommand(page, 'block.toggleCheck')
  await expect(box).toHaveAttribute('aria-checked', 'true')
  expect((await markdown(page)).trim()).toBe('- [x] 任务')
})

test('P-32 在上方 / 下方插入段落:空段落出现在当前块前 / 后,光标进新段落', async ({ page }) => {
  await loadDoc(page, '甲\n\n乙\n\n丙\n')
  const paragraphs = page.locator('.tz-editor > p')
  await page.locator('.tz-editor p', { hasText: '乙' }).click()
  await expect.poll(() => caretBlockText(page)).toBe('乙')
  await runMenuCommand(page, 'block.paragraphBefore')
  await expect(paragraphs).toHaveCount(4)
  await expect(paragraphs.nth(1)).toHaveText('')
  // 光标所在的空段落才显示「输入 / 唤出命令」占位(plugins/basics.ts placeholderPlugin)
  await expect(paragraphs.nth(1)).toHaveClass(/tz-placeholder/)
  await page.keyboard.type('上')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('甲\n\n上\n\n乙\n\n丙')

  await page.locator('.tz-editor p', { hasText: '乙' }).click()
  await expect.poll(() => caretBlockText(page)).toBe('乙')
  await runMenuCommand(page, 'block.paragraphAfter')
  await expect(paragraphs).toHaveCount(5)
  await expect(paragraphs.nth(3)).toHaveText('')
  await expect(paragraphs.nth(3)).toHaveClass(/tz-placeholder/)
  await page.keyboard.type('下')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('甲\n\n上\n\n乙\n\n下\n\n丙')
})

// ---------- 格式 ----------

test('M-01 ⌘B 无选区时:之后输入的文字加粗,再按一次结束加粗', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '前\n')
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.type('粗')
  await page.keyboard.press(`${mod}+b`)
  await page.keyboard.type('后')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('前**粗**后')
  await expect(page.locator('.tz-editor strong')).toHaveText('粗')
})

test('M-08 上标:选中文字发「上标」存成 <sup>,再发一次取消', async ({ page }) => {
  await loadDoc(page, 'x2\n')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => selectedText(page)).toBe('2')
  await runMenuCommand(page, 'format.superscript')
  await expect(page.locator('.tz-editor sup')).toHaveText('2')
  // 新建的上标用通用 HTML 写法(schema 里 sup 的 syntax 默认 html),不写 ^2^
  expect((await markdown(page)).trim()).toBe('x<sup>2</sup>')
  await runMenuCommand(page, 'format.superscript')
  await expect(page.locator('.tz-editor sup')).toHaveCount(0)
  expect((await markdown(page)).trim()).toBe('x2')
})

test('M-09 下标:选中文字发「下标」存成 <sub>,再发一次取消', async ({ page }) => {
  await loadDoc(page, 'H2O\n')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect.poll(() => selectedText(page)).toBe('2')
  await runMenuCommand(page, 'format.subscript')
  await expect(page.locator('.tz-editor sub')).toHaveText('2')
  // 不写 ~2~:GFM 里 ~…~ 是删除线
  expect((await markdown(page)).trim()).toBe('H<sub>2</sub>O')
  await runMenuCommand(page, 'format.subscript')
  await expect(page.locator('.tz-editor sub')).toHaveCount(0)
  expect((await markdown(page)).trim()).toBe('H2O')
})

test('M-10 注释 ⌃-:选中文字变成 HTML 注释;无选区时插入「注释」占位', async ({ page }) => {
  const mod = await modKey(page)
  // 非 macOS 上 Mod 就是 Ctrl:⌃⌘-(降低标题级别)与 ⌃- 成了同一个键,core/keymap.ts 里后写的降低标题级别生效;
  // 只在 macOS 上按键,其它平台发菜单命令(同一个 insert.comment)
  const comment = async () => (mod === 'Meta' ? page.keyboard.press('Control+Minus') : runMenuCommand(page, 'insert.comment'))
  await loadDoc(page, '备注\n')
  await page.keyboard.press(`${mod}+a`)
  await comment()
  await expect.poll(async () => (await markdown(page)).trim()).toBe('<!-- 备注 -->')

  await loadDoc(page, '正文\n')
  await comment()
  await expect.poll(async () => (await markdown(page)).trim()).toBe('正文<!-- 注释 -->')
})

test('M-31 清除样式:去掉加粗、斜体、下划线与文字颜色 / 背景色,只剩文字', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '**粗**<span style="color: #D44C47; background-color: #FBF3DB">彩</span>*斜*<u>线</u>\n')
  await expect(page.locator('.tz-editor span[data-tz-color]')).toHaveText('彩')
  await page.keyboard.press(`${mod}+a`)
  await runMenuCommand(page, 'format.clear')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('粗彩斜线')
  await expect(page.locator('.tz-editor strong, .tz-editor em, .tz-editor u, .tz-editor span[data-tz-color]')).toHaveCount(0)
})

// ---------- 格式 ▸ 图像 ----------

test('M-14 插入本地图片…:文件面板可多选,按插图规则复制进 assets 后插入', async ({ page }) => {
  await putFile(page, '/Users/test/Pictures/shot-a.svg', svg(120, 80))
  await putFile(page, '/Users/test/Pictures/shot-b.svg', svg(60, 40))
  await loadDoc(page, '正文\n')
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/Users/test/Pictures/shot-a.svg', '/Users/test/Pictures/shot-b.svg']))
  await runMenuCommand(page, 'image.insertLocal')
  // 偏好默认「复制到 ./assets」、写相对路径;替代文字取文件名
  await expect.poll(() => markdown(page)).toBe('正文![shot-a](assets/shot-a.svg)![shot-b](assets/shot-b.svg)\n')
  const [options] = (await hostCalls(page, 'openDialog'))[0] as [{ multiple?: boolean; extensions?: string[] }]
  expect(options.multiple).toBe(true)
  expect(options.extensions).toContain('svg')
  expect(await hostCalls(page, 'copyFile')).toEqual([
    ['/Users/test/Pictures/shot-a.svg', '/demo/assets/shot-a.svg'],
    ['/Users/test/Pictures/shot-b.svg', '/demo/assets/shot-b.svg'],
  ])
  await expect(page.locator('.tz-editor .tz-image img')).toHaveCount(2)
  await expect.poll(() => imageWidth(page, 0)).toBe(120)
})

test('M-15 打开图片位置:本机图片在 Finder 中显示;网络图片右键里没有这一项,菜单命令只提示', async ({ page }) => {
  await loadDoc(page, '![标识](assets/id.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await runMenuCommand(page, 'image.reveal')
  await expect.poll(() => hostCalls(page, 'revealInFinder')).toEqual([['/demo/assets/id.svg']])
  // 右键 ▸ 图像工具 ▸ 打开图片位置 同一命令
  await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
  await page.locator(menuItem('ctx.image.tools')).hover()
  await page.locator(menuItem('ctx.image.reveal')).click()
  await expect.poll(() => hostCalls(page, 'revealInFinder')).toEqual([['/demo/assets/id.svg'], ['/demo/assets/id.svg']])

  await loadDoc(page, '![远程](https://img.example.com/remote.png)\n')
  await contextMenuOn(page, '.tz-editor .tz-image')
  await page.locator(menuItem('ctx.image.tools')).hover()
  await expect(page.locator(menuItem('ctx.image.copy'))).toBeVisible()
  await expect(page.locator(menuItem('ctx.image.reveal'))).toHaveCount(0)
  // 右键已选中这张网络图片;菜单栏命令照样能发,只提示不调外壳
  await runMenuCommand(page, 'image.reveal')
  await expect(page.locator('.tz-toast')).toHaveText('网络图片没有本机位置')
  expect(await hostCalls(page, 'revealInFinder')).toHaveLength(2)
})

test('M-16 拷贝图片:菜单命令与右键都把选中的图片交给外壳放进剪贴板;网络图片交网址', async ({ page }) => {
  await loadDoc(page, '![标识](assets/id.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await runMenuCommand(page, 'image.copy')
  await expect.poll(() => hostCalls(page, 'copyImageToClipboard')).toEqual([['/demo/assets/id.svg']])
  await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
  await page.locator(menuItem('ctx.image.tools')).hover()
  await page.locator(menuItem('ctx.image.copy')).click()
  await expect.poll(() => hostCalls(page, 'copyImageToClipboard')).toEqual([['/demo/assets/id.svg'], ['/demo/assets/id.svg']])

  // 网络图片由外壳下载后放进剪贴板(app/images.ts image.copy)
  await loadDoc(page, '![远程](https://img.example.com/remote.png)\n')
  await contextMenuOn(page, '.tz-editor .tz-image')
  await page.locator(menuItem('ctx.image.tools')).hover()
  await page.locator(menuItem('ctx.image.copy')).click()
  await expect
    .poll(() => hostCalls(page, 'copyImageToClipboard'))
    .toEqual([['/demo/assets/id.svg'], ['/demo/assets/id.svg'], ['https://img.example.com/remote.png']])
})

test('M-20 复制图片到…:图片文件复制到选定文件夹,src 改成新位置,原文件保留', async ({ page }) => {
  await loadDoc(page, '![标识](assets/id.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/out']))
  await runMenuCommand(page, 'image.copyTo')
  await expect(page.locator('.tz-toast')).toContainText('已将图片复制到了 /demo/out。')
  // 目标在文档文件夹内:写相对文档的路径(偏好「优先使用相对路径」默认开)。
  // 对照表说明写的是 ./相对路径【假设】,app/images.ts srcFor 现在不加 ./,这里两种都认,只断言指向新位置
  expect(await markdown(page)).toMatch(/^!\[标识\]\((\.\/)?out\/id\.svg\)\n$/)
  expect(await hostCalls(page, 'openDialog')).toEqual([[{ directory: true }]])
  expect(await fileExists(page, '/demo/out/id.svg')).toBe(true)
  expect(await fileExists(page, '/demo/assets/id.svg')).toBe(true)
  await expect.poll(() => imageWidth(page)).toBe(400)
})

test('M-21 重命名 / 移动图片到…:文件改名移到新位置,src 跟着改;网络图片不能移动', async ({ page }) => {
  await loadDoc(page, '![标识](assets/id.svg)\n')
  // 内存宿主的保存面板固定返回默认文件名;这里换成用户在面板里改了名、换了文件夹
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    host.saveDialog = async (options) => {
      host.calls.push({ method: 'saveDialog', args: [options] })
      return '/demo/pics/logo.svg'
    }
  })
  await page.locator('.tz-editor .tz-image img').click()
  await runMenuCommand(page, 'image.moveTo')
  // 路径写法同 M-20:./ 前缀两种都认
  await expect.poll(() => markdown(page)).toMatch(/^!\[标识\]\((\.\/)?pics\/logo\.svg\)\n$/)
  expect(await hostCalls(page, 'saveDialog')).toEqual([[{ defaultName: 'id.svg', extensions: ['svg'] }]])
  expect(await hostCalls(page, 'rename')).toEqual([['/demo/assets/id.svg', '/demo/pics/logo.svg']])
  expect(await fileExists(page, '/demo/assets/id.svg')).toBe(false)
  expect(await fileExists(page, '/demo/pics/logo.svg')).toBe(true)
  await expect.poll(() => imageWidth(page)).toBe(400)

  await loadDoc(page, '![远程](https://img.example.com/remote.png)\n')
  await contextMenuOn(page, '.tz-editor .tz-image')
  await runMenuCommand(page, 'image.moveTo')
  await expect(page.locator('.tz-toast')).toContainText('网络图片不能移动')
  expect(await hostCalls(page, 'rename')).toHaveLength(1)
})

test('M-22 上传图片:首次上传先确认,确认后用偏好的上传服务上传并把 src 换成网址', async ({ page }) => {
  await loadDoc(page, '![标识](assets/id.svg)\n')
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ imageUploadCommand: 'picgo upload' }))
  await page.locator('.tz-editor .tz-image img').click()
  // 第一次在「将调用第三方上传服务」确认里选「取消」(第 2 个按钮):不上传
  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(1))
  await runMenuCommand(page, 'image.upload')
  await expect.poll(async () => (await hostCalls(page, 'confirm')).length).toBe(1)
  const [ask] = (await hostCalls(page, 'confirm'))[0] as [{ title: string; buttons: string[] }]
  expect(ask.title).toBe('上传图片')
  expect(ask.buttons).toEqual(['继续上传', '取消'])
  expect(await hostCalls(page, 'uploadImages')).toEqual([])
  expect(await markdown(page)).toBe('![标识](assets/id.svg)\n')

  // 再来一次选「继续上传」(确认队列为空时宿主返回 0)
  await runMenuCommand(page, 'image.upload')
  await expect.poll(() => markdown(page)).toBe('![标识](https://img.example.com/demo/assets/id.svg)\n')
  expect(await hostCalls(page, 'uploadImages')).toEqual([[{ service: 'custom', command: 'picgo upload' }, ['/demo/assets/id.svg']]])

  // 换成网址后已是网络图片:再上传只提示
  await runMenuCommand(page, 'image.upload')
  await expect(page.locator('.tz-toast')).toHaveText('这张图片已经是网络图片')
  expect(await hostCalls(page, 'uploadImages')).toHaveLength(1)
})

test('M-23 移动所有图片到…:本机图片移走、网络图片下载到目标文件夹,路径全部更新', async ({ page }) => {
  await loadDoc(page, '![a](assets/id.svg)\n\n![b](assets/name.svg)\n\n![c](https://img.example.com/remote.png)\n')
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/out']))
  await runMenuCommand(page, 'image.moveAllTo')
  await expect(page.locator('.tz-toast')).toContainText('已将图片移动到了 /demo/out。')
  expect(await markdown(page)).toBe('![a](out/id.svg)\n\n![b](out/name.svg)\n\n![c](out/remote.png)\n')
  expect(await hostCalls(page, 'rename')).toEqual([
    ['/demo/assets/id.svg', '/demo/out/id.svg'],
    ['/demo/assets/name.svg', '/demo/out/name.svg'],
  ])
  expect(await hostCalls(page, 'download')).toEqual([['https://img.example.com/remote.png', '/demo/out/remote.png']])
  const outFiles = await page.evaluate(() => [...window.typozaTest!.host.files.keys()].filter((p) => p.startsWith('/demo/out/')).sort())
  expect(outFiles).toEqual(['/demo/out/id.svg', '/demo/out/name.svg', '/demo/out/remote.png'])
  // 移动不是复制:原位置不再有文件
  expect(await fileExists(page, '/demo/assets/id.svg')).toBe(false)
  expect(await fileExists(page, '/demo/assets/name.svg')).toBe(false)
  await expect.poll(() => imageWidth(page, 0)).toBe(400)
})

test('M-26 当插入本地图片时 ▸ 复制图片到文件夹…:选的文件夹写进 YAML,之后插入的图片复制到那里', async ({ page }) => {
  await putFile(page, '/Users/test/Pictures/shot.svg', svg(120, 80))
  await loadDoc(page, '正文\n')
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/pics']))
  await runMenuCommand(page, 'image.whenInsert.copyTo')
  // 文件夹在文档文件夹内:写 ./相对路径(app/images.ts folderValue)
  await expect.poll(() => markdown(page)).toBe('---\ntypora-copy-images-to: ./pics\n---\n\n正文\n')
  await expect(page.locator('.tz-toast')).toContainText('本文插入的本地图片将复制到 ./pics')

  // YAML 优先于偏好的「复制到 ./assets」;文件夹还不存在时先问,确认队列为空时选「创建目录并继续」
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/Users/test/Pictures/shot.svg']))
  await runMenuCommand(page, 'image.insertLocal')
  await expect.poll(() => markdown(page)).toBe('---\ntypora-copy-images-to: ./pics\n---\n\n正文![shot](pics/shot.svg)\n')
  const asks = (await hostCalls(page, 'confirm')).map((a) => (a[0] as { title: string }).title)
  expect(asks).toEqual(['该目录不存在,是否立即创建?'])
  expect(await hostCalls(page, 'copyFile')).toEqual([['/Users/test/Pictures/shot.svg', '/demo/pics/shot.svg']])
})

test('M-27 设置图片根目录…:以 / 开头的图片路径立即按新根目录显示', async ({ page }) => {
  await loadDoc(page, '![标识](/id.svg)\n')
  // 没设根目录时 /id.svg 按磁盘根路径找,内存宿主里没有这个文件
  expect(await imageWidth(page)).toBe(0)
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/assets']))
  await runMenuCommand(page, 'image.setRootUrl')
  await expect.poll(() => markdown(page)).toContain('typora-root-url: ./assets')
  // 图片地址不改,只是按 /demo/assets 解析后加载出 id.svg(400×240)
  expect(await markdown(page)).toContain('![标识](/id.svg)')
  await expect.poll(() => imageWidth(page)).toBe(400)
})

test('M-28 全局图像设置…:打开偏好设置并停在「图像」页', async ({ page }) => {
  await runMenuCommand(page, 'image.globalSettings')
  await expect(page.locator('.tz-settings-tab[data-page="图像"]')).toHaveClass(/is-active/)
  await expect(page.locator('.tz-settings-tab.is-active')).toHaveCount(1)
  await expect(page.locator('select[data-key=imageInsertAction]')).toBeVisible()
})

// ---------- 显示 ----------

test('V-02 专注模式:光标所在块不透明,其余块变淡;光标换块后跟着换', async ({ page }) => {
  await loadDoc(page, '第一段\n\n第二段\n\n第三段\n')
  /** 各顶层段落的不透明度(保留两位小数;淡出有 0.15 秒过渡,轮询等它停下) */
  const opacities = () =>
    page.evaluate(() => [...document.querySelectorAll('.tz-editor > p')].map((p) => Math.round(Number(getComputedStyle(p).opacity) * 100) / 100))
  expect(await opacities()).toEqual([1, 1, 1])
  // 光标在第三段(loadDoc 把光标放在文末);其余块按 styles/editor.css 变成 0.32
  await runMenuCommand(page, 'view.focusMode')
  await expect.poll(opacities).toEqual([0.32, 0.32, 1])
  await page.locator('.tz-editor > p').first().click()
  await expect.poll(opacities).toEqual([1, 0.32, 0.32])
})

test('V-03 打字机模式:点到靠下的行后,光标所在行滚到窗口中部;关闭时不滚', async ({ page }) => {
  await loadDoc(page, `${Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段`).join('\n\n')}\n`)
  /** 光标顶边在滚动区里的相对高度:0 是顶,1 是底 */
  const caretRatio = () =>
    page.evaluate(() => {
      const view = window.typozaTest!.app.view
      const caret = view.coordsAtPos(view.state.selection.head)
      const box = document.querySelector('.tz-scroll')!.getBoundingClientRect()
      return (caret.top - box.top) / box.height
    })
  /** 滚回顶部,返回这时整段落在滚动区下部(75% ~ 95%)的最后一段的序号 */
  const lowParagraph = () =>
    page.evaluate(() => {
      const scroller = document.querySelector('.tz-scroll')!
      scroller.scrollTop = 0
      const box = scroller.getBoundingClientRect()
      let found = -1
      ;[...document.querySelectorAll('.tz-editor > p')].forEach((p, i) => {
        const r = p.getBoundingClientRect()
        if (r.top >= box.top + box.height * 0.75 && r.bottom <= box.top + box.height * 0.95) found = i
      })
      if (found < 1) throw new Error('滚动区下部没有整段可点的段落')
      return found
    })
  const paragraphs = page.locator('.tz-editor > p')
  const index = await lowParagraph()
  // 对照:没开打字机模式时点下部的段落,页面不滚,光标留在下部
  await paragraphs.nth(index).click()
  await expect.poll(() => caretBlockText(page)).toBe(`第 ${index + 1} 段`)
  expect(await caretRatio()).toBeGreaterThan(0.7)

  await runMenuCommand(page, 'view.typewriterMode')
  await expect(page.locator('.tz-editor')).toHaveClass(/tz-typewriter-mode/)
  await lowParagraph()
  // 偏好「始终保证光标在屏幕中间」默认开,鼠标点选也居中(plugins/basics.ts 滚到 45% 高度处)
  await paragraphs.nth(index - 1).click()
  await expect.poll(() => caretBlockText(page)).toBe(`第 ${index} 段`)
  await expect.poll(async () => Math.abs((await caretRatio()) - 0.45)).toBeLessThan(0.06)
})

test('V-09 字数统计窗口:列出全文与选中部分的字数、段落、行数、阅读时间;状态栏字数也能打开', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '你好世界\n\nhello world\n')
  // ⌘A 第一次选中当前块文字:选区是 hello world
  await page.keyboard.press(`${mod}+a`)
  await runMenuCommand(page, 'view.wordCount')
  const dialog = page.locator('.tz-modal')
  await expect(dialog.locator('.tz-modal-head h2')).toHaveText('字数统计')
  await expect(dialog.locator('.tz-wordcount thead th')).toHaveText(['', '全文', '选中'])
  await expect(dialog.locator('.tz-wordcount tbody th')).toHaveText(['字数', '字符数', '字符数(不含空白)', '中日韩字符', '段落', '行数', '阅读时间(分钟)'])
  // 全文按块间两个换行拼成「你好世界\n\nhello world」:4 个汉字各算一词 + 2 个英文词;17 个字符,去掉空白 14 个;3 行 2 段
  await expect(dialog.locator('.tz-wordcount tbody td:nth-child(2)')).toHaveText(['6', '17', '14', '4', '2', '3', '1'])
  await expect(dialog.locator('.tz-wordcount tbody td:nth-child(3)')).toHaveText(['2', '11', '10', '0', '1', '1', '1'])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await page.locator('.tz-statusbar .tz-status-words').click()
  await expect(dialog.locator('.tz-modal-head h2')).toHaveText('字数统计')
})

test('V-17 显示状态栏:默认显示字数与源码模式开关;菜单开关与偏好外观页是同一个设置', async ({ page }) => {
  await loadDoc(page, '一二三\n')
  const bar = page.locator('.tz-statusbar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.tz-status-words')).toHaveText('3 字')
  await expect(bar.locator('button[title="源代码模式(⌃⌘/)"]')).toBeVisible()

  await runMenuCommand(page, 'view.statusBar')
  await expect(bar).toBeHidden()
  await expect.poll(() => savedSetting(page, 'showStatusBar')).toBe(false)

  await runMenuCommand(page, 'app.preferences')
  await page.locator('.tz-settings-tab[data-page="外观"]').click()
  const toggle = page.locator('input[data-key=showStatusBar]')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(bar).toBeVisible()
  await expect.poll(() => savedSetting(page, 'showStatusBar')).toBe(true)
})

test('V-20 高亮当前标题:大纲里高亮光标所在的章节,光标移动后跟着换', async ({ page }) => {
  await loadDoc(page, '# 甲\n\n甲的正文\n\n## 乙\n\n乙的正文\n\n# 丙\n\n丙的正文\n')
  await runMenuCommand(page, 'view.outline')
  const active = page.locator('.tz-outline .tz-outline-item.is-active')
  const activeLabel = page.locator('.tz-outline .tz-outline-item.is-active > span:nth-child(2)')
  // 光标在文末「丙的正文」
  await expect(activeLabel).toHaveText('丙')
  await page.locator('.tz-editor p', { hasText: '乙的正文' }).click()
  await expect(activeLabel).toHaveText('乙')
  await expect(active).toHaveCount(1)
  await page.locator('.tz-editor p', { hasText: '甲的正文' }).click()
  await expect(activeLabel).toHaveText('甲')
  await expect(active).toHaveCount(1)
})

// ---------- 主题 ----------

test('T-03 主题名.user.css 只追加到该主题,base.user.css 追加到所有主题;其中相对 url() 的图片能加载', async ({ page }) => {
  await page.evaluate(() => {
    const dir = '/Users/test/Library/Application Support/Typoza/themes'
    const files = window.typozaTest!.host.files
    files.set(dir, { kind: 'dir', mtime: 1 })
    files.set(`${dir}/base.user.css`, { kind: 'file', data: '#write { --base-user: 1; }', mtime: 1 })
    files.set(`${dir}/github.user.css`, { kind: 'file', data: '#write { --github-user: 1; background-image: url(img/dot.svg); }', mtime: 1 })
    files.set(`${dir}/img/dot.svg`, {
      kind: 'file',
      data: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><rect width="12" height="8" fill="#D44C47"/></svg>',
      mtime: 1,
    })
  })
  // Playwright 的文本断言不读 <style> 的内容,直接取 textContent
  const css = () => page.evaluate(() => document.getElementById('tz-user-theme')?.textContent ?? '')
  const editorVar = (name: string) => page.evaluate((n) => getComputedStyle(document.querySelector('.tz-editor')!).getPropertyValue(n).trim(), name)

  // 当前就是 Github:在主题菜单里再点一次会重读主题文件夹(app/appearance.ts loadThemeCss force)
  await runMenuCommand(page, 'theme.github')
  await expect.poll(css).toContain('--github-user: 1')
  expect(await css()).toContain('--base-user: 1')
  await expect.poll(() => editorVar('--github-user')).toBe('1')
  // 相对主题文件夹写的 url() 改写成本机资源地址后,真的能加载出那张图
  const loadedWidth = await page.evaluate(async () => {
    const bg = getComputedStyle(document.querySelector('.tz-editor')!).backgroundImage
    const url = /url\("?([^")]+)"?\)/.exec(bg)?.[1]
    if (!url) throw new Error(`编辑区没有背景图:${bg}`)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`背景图加载失败:${url}`))
      img.src = url
    })
    return img.naturalWidth
  })
  expect(loadedWidth).toBe(12)

  // 换到 Pixyll:github.user.css 不再生效,base.user.css 仍在
  await runMenuCommand(page, 'theme.pixyll')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pixyll')
  await expect.poll(css).not.toContain('--github-user')
  expect(await css()).toContain('--base-user: 1')
  await expect.poll(() => editorVar('--github-user')).toBe('')
  expect(await editorVar('--base-user')).toBe('1')
})

test('T-06 外观跟随系统:系统切深色时自动换成深色模式主题,切回浅色还原;外观选「浅色」后不跟随', async ({ page }) => {
  const html = page.locator('html')
  const systemDark = (dark: boolean) => page.evaluate((d) => window.typozaTest!.host.emit('app.appearance', { dark: d }), dark)
  // 默认外观「跟随系统」、主题 Github、深色模式主题 Night(app/settings.ts)
  await expect(html).toHaveAttribute('data-theme', 'github')
  await systemDark(true)
  await expect(html).toHaveAttribute('data-theme', 'night')
  await expect(html).toHaveClass(/tz-dark/)
  await systemDark(false)
  await expect(html).toHaveAttribute('data-theme', 'github')
  await expect(html).not.toHaveClass(/tz-dark/)

  // 深色模式主题可以单独换成别的
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ darkTheme: 'gothic' }))
  await systemDark(true)
  await expect(html).toHaveAttribute('data-theme', 'gothic')

  // 手动选了浅色:系统仍是深色也用浅色主题
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ appearance: 'light' }))
  await expect(html).toHaveAttribute('data-theme', 'github')
  await systemDark(false)
  await systemDark(true)
  await expect(html).toHaveAttribute('data-theme', 'github')
})
