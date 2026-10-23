import { expect, type Locator, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { hostCalls, runMenuCommand } from './media-helpers'

// 对照表第 1 部分(A 应用菜单、F 文件、E 编辑)里判为「部分 / 无」、能在网页侧补证据的行:
// A-07、F-04、F-09 ~ F-12、F-35、F-36、E-01、E-02、E-04 ~ E-06、E-24、E-26、E-27、E-42、E-44。
// 菜单命令一律经 runMenuCommand 发(与原生菜单栏同一通道):CI 跑在 Linux WebKit 上,Mod 是 Ctrl,部分 Ctrl 组合键会被吞,
// 只在其他用例已验证可用的键(⌘Z、⌘/、⇧Home、⇧←、Esc、⌫)上真按键。

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

const currentPath = (page: Page) => page.evaluate(() => window.typozaTest!.app.session.path)

const confirmTitles = (page: Page) =>
  page.evaluate(() => window.typozaTest!.host.calls.filter((c) => c.method === 'confirm').map((c) => (c.args[0] as { title: string }).title))

/** 正文当前选区:起点与选中的文字。 */
const selection = (page: Page) =>
  page.evaluate(() => {
    const { state } = window.typozaTest!.app.view
    return { from: state.selection.from, text: state.doc.textBetween(state.selection.from, state.selection.to) }
  })

// ---------- A-07 退出 ----------

test.describe('退出时的询问规则', () => {
  // 外壳退出前对每个窗口调 window.typoza.prepareClose('quit')(main.ts → App.confirmLeave('quit')),返回 false 即取消退出
  const quit = (page: Page) => page.evaluate(() => window.typoza.prepareClose('quit'))

  test('A-07 自动保存开:已命名文档退出时直接写盘,不询问', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '# 退出\n\n内容\n', '/demo/退出.md')
    await page.keyboard.type('改')
    await expect.poll(() => markdown(page)).toBe('# 退出\n\n内容改\n')
    expect(await quit(page)).toBe(true)
    expect(await confirmTitles(page)).toEqual([])
    expect(await fileText(page, '/demo/退出.md')).toBe('# 退出\n\n内容改\n')
  })

  test('A-07 自动保存关:已命名文档退出时询问「是否保存更改?」,取消则不退出,选「保存」写盘后退出', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '# 退出\n\n内容\n', '/demo/退出.md')
    await page.evaluate(() => window.typozaTest!.app.updateSettings({ autoSave: false }))
    await page.keyboard.type('改')
    await expect.poll(() => markdown(page)).toBe('# 退出\n\n内容改\n')
    // 按钮顺序 保存 / 不保存 / 取消,确认框按序号取结果
    await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(2))
    expect(await quit(page)).toBe(false)
    expect(await confirmTitles(page)).toEqual(['是否保存更改?'])
    expect(await fileText(page, '/demo/退出.md')).toBe('# 退出\n\n内容\n')
    await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(0))
    expect(await quit(page)).toBe(true)
    expect(await confirmTitles(page)).toEqual(['是否保存更改?', '是否保存更改?'])
    expect(await fileText(page, '/demo/退出.md')).toBe('# 退出\n\n内容改\n')
  })

  test('A-07 自动保存开:未命名文档退出时不询问,内容留在草稿里,重启后恢复', async ({ page }) => {
    await openApp(page, '?empty')
    await page.locator('.tz-editor').click()
    await page.keyboard.type('未命名草稿')
    await expect.poll(() => markdown(page)).toBe('未命名草稿\n')
    // 不等 1 秒的草稿定时备份:退出时立即写草稿
    expect(await quit(page)).toBe(true)
    expect(await confirmTitles(page)).toEqual([])
    expect(await page.evaluate(() => [...window.typozaTest!.host.drafts.values()])).toEqual(['未命名草稿\n'])
    // 草稿存在 sessionStorage 里,刷新页面相当于重启应用
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true')
    await expect(page.locator('.tz-editor')).toContainText('未命名草稿')
    expect(await currentPath(page)).toBeNull()
  })

  test('A-07 自动保存关:未命名文档退出时也询问,选「不保存」删掉草稿', async ({ page }) => {
    await openApp(page, '?empty')
    await page.evaluate(() => window.typozaTest!.app.updateSettings({ autoSave: false }))
    await page.locator('.tz-editor').click()
    await page.keyboard.type('草稿')
    await expect.poll(() => markdown(page)).toBe('草稿\n')
    await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(1))
    expect(await quit(page)).toBe(true)
    expect(await confirmTitles(page)).toEqual(['是否保存更改?'])
    expect(await page.evaluate(() => window.typozaTest!.host.drafts.size)).toBe(0)
  })
})

// ---------- F 文件 ----------

test('F-04 打开:侧栏没有文件夹时选文件打开,所在文件夹载入侧栏;选文件夹打开则载入该文件夹', async ({ page }) => {
  await openApp(page)
  await page.evaluate(async () => {
    const t = window.typozaTest!
    await t.host.mkdir('/其他/子')
    t.host.files.set('/其他/a.md', { kind: 'file', data: '# 其他\n', mtime: Date.now() })
    t.host.files.set('/其他/子/b.md', { kind: 'file', data: '# 子\n', mtime: Date.now() })
    t.app['sidebar'].setRoot(null)
  })
  await runMenuCommand(page, 'view.fileTree')
  await expect(page.locator('.tz-side-empty p')).toHaveText('没有打开的文件夹')

  // 浏览器里「打开…」走 file.open(macOS 上的 native.open 由外壳弹面板后同样调 openFile)
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/其他/a.md']))
  await runMenuCommand(page, 'file.open')
  await expect.poll(() => currentPath(page)).toBe('/其他/a.md')
  await expect(page.locator('.tz-editor h1')).toHaveText('其他')
  await expect(page.locator('.tz-tree-root')).toHaveAttribute('data-path', '/其他')
  await expect(page.locator('.tz-tree-item[data-path="/其他/a.md"]')).toHaveClass(/is-current/)
  const dialogs = await hostCalls(page, 'openDialog')
  expect(dialogs[0][0]).toEqual(expect.objectContaining({ extensions: expect.arrayContaining(['md', 'markdown', 'txt', 'textbundle']) }))

  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/其他/子']))
  await runMenuCommand(page, 'file.openFolder')
  await expect(page.locator('.tz-tree-root')).toHaveAttribute('data-path', '/其他/子')
  await expect(page.locator('.tz-tree-item[data-path="/其他/子/b.md"]')).toBeVisible()
})

test('F-09 显示简介…:列出位置、种类、大小、创建与修改时间、字数、编码、换行符;未保存文档给提示', async ({ page }) => {
  await openApp(page)
  // 自定创建与修改时间(两者不同);期望的时间文字在页面里用同一个格式化函数算,不受 Node 与 WebKit 的 ICU 差异影响
  const times = await page.evaluate(async () => {
    const t = window.typozaTest!
    const ctime = new Date(2025, 0, 2, 3, 4, 5).getTime()
    const mtime = new Date(2026, 5, 7, 8, 9, 10).getTime()
    t.host.files.set('/demo/简介.md', { kind: 'file', data: '# 简介\r\n\r\n中文 abc\r\n', mtime, ctime })
    await t.app.openFile('/demo/简介.md', { replace: true })
    const fmt = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
    return { created: fmt(ctime), modified: fmt(mtime) }
  })
  await runMenuCommand(page, 'file.info')
  await expect(page.locator('.tz-modal-head h2')).toHaveText('简介')
  const rows = page.locator('.tz-modal .tz-file-info tr')
  await expect(rows).toHaveCount(8)
  const table = await rows.evaluateAll((trs) => trs.map((tr) => [tr.querySelector('th')?.textContent ?? '', tr.querySelector('td')?.textContent ?? '']))
  // 内存宿主的大小按字符数算:16 个字符;字数 = 中日韩 4 字 + abc 1 词
  expect(table).toEqual([
    ['位置', '/demo/简介.md'],
    ['种类', '文件'],
    ['大小', '16 字节'],
    ['创建时间', times.created],
    ['修改时间', times.modified],
    ['字数', '5'],
    ['编码', 'utf-8'],
    ['换行符', 'CRLF(Windows)'],
  ])

  await page.keyboard.press('Escape')
  await expect(page.locator('.tz-modal')).toHaveCount(0)
  await page.evaluate(() => window.typozaTest!.app.openFile('/demo/另一篇.md', { replace: true }))
  await runMenuCommand(page, 'file.info')
  await expect(page.locator('.tz-modal .tz-file-info tr', { hasText: '换行符' }).locator('td')).toHaveText('LF(macOS / Linux)')

  await openApp(page, '?empty')
  await runMenuCommand(page, 'file.info')
  await expect(page.locator('.tz-toast')).toHaveText('文档还没有保存')
  await expect(page.locator('.tz-modal')).toHaveCount(0)
})

test('F-10 在文档列表中显示:展开侧栏、切到文档列表,滚到当前文档并标为当前', async ({ page }) => {
  await openApp(page)
  // 40 篇更新的文档排在前面(默认按修改时间降序),当前文档落在要滚动才看得见的位置;只有标题、没有摘要,行高不会变
  await page.evaluate(() => {
    const files = window.typozaTest!.host.files
    const later = Date.now() + 60_000
    for (let i = 0; i < 40; i++) files.set(`/demo/填充-${String(i).padStart(2, '0')}.md`, { kind: 'file', data: `# 填充 ${i}\n`, mtime: later + i })
  })
  await loadDoc(page, '# 定位\n\n当前文档\n', '/demo/定位.md')
  const row = page.locator('.tz-doc-item[data-path="/demo/定位.md"]')
  await runMenuCommand(page, 'view.docList')
  await expect(row).toHaveClass(/is-current/)
  await expect(row).not.toBeInViewport()

  // 切到大纲并收起侧栏,再从菜单定位
  await runMenuCommand(page, 'view.outline')
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ sidebarVisible: false }))
  await expect(page.locator('.tz-sidebar')).toBeHidden()
  await runMenuCommand(page, 'file.revealInList')
  await expect(page.locator('.tz-sidebar')).toBeVisible()
  await expect(page.locator('.tz-side-tab[data-tab="list"]')).toHaveClass(/is-active/)
  await expect(row).toHaveClass(/is-current/)
  await expect(row).toBeInViewport()
})

test('F-11 在文件树中显示:展开侧栏、切到文件树,逐级展开上级文件夹并标出当前文件', async ({ page }) => {
  await openApp(page)
  await page.evaluate(() => window.typozaTest!.host.mkdir('/demo/深/层'))
  await loadDoc(page, '# 深处\n', '/demo/深/层/文.md')
  const row = page.locator('.tz-tree-item[data-path="/demo/深/层/文.md"]')
  // 文件夹默认收起:文件树里看不到这篇
  await runMenuCommand(page, 'view.fileTree')
  await expect(page.locator('.tz-tree-item[data-path="/demo/深"] .tz-tree-twisty')).toHaveText('▸')
  await expect(row).toHaveCount(0)

  await runMenuCommand(page, 'view.outline')
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ sidebarVisible: false }))
  await expect(page.locator('.tz-sidebar')).toBeHidden()
  await runMenuCommand(page, 'file.revealInTree')
  await expect(page.locator('.tz-sidebar')).toBeVisible()
  await expect(page.locator('.tz-side-tab[data-tab="files"]')).toHaveClass(/is-active/)
  await expect(page.locator('.tz-tree-item[data-path="/demo/深"] .tz-tree-twisty')).toHaveText('▾')
  await expect(page.locator('.tz-tree-item[data-path="/demo/深/层"] .tz-tree-twisty')).toHaveText('▾')
  await expect(row).toBeVisible()
  await expect(row).toHaveClass(/is-current/)
})

test('F-12 打开文件位置:请外壳在 Finder 中显示当前文件;未保存文档不调用', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '# 位置\n', '/demo/位置.md')
  await runMenuCommand(page, 'file.revealInFinder')
  await expect.poll(() => hostCalls(page, 'revealInFinder')).toEqual([['/demo/位置.md']])

  await openApp(page, '?empty')
  await runMenuCommand(page, 'file.revealInFinder')
  // 命令是同步的:有路径时 revealInFinder 在派发命令的同一轮里就记下调用
  expect(await hostCalls(page, 'revealInFinder')).toEqual([])
})

test('F-35 偏好「导出」页从模板添加五种导出项:默认值正确,并同步到 文件 ▸ 导出 菜单', async ({ page }) => {
  await openApp(page)
  await runMenuCommand(page, 'app.exportSettings')
  const items = page.locator('.tz-export-item')
  const emptyHint = page.locator('.tz-export-items .tz-field-hint', { hasText: '还没有导出项' })
  await expect(emptyHint).toBeVisible()
  // 每选一项,页面重画出一个新的「从模板添加…」下拉框
  const templates = ['pandoc-pdf', 'markdown', 'native', 'pandoc', 'command']
  for (const [i, template] of templates.entries()) {
    await page.locator('select[data-key="exportTemplate"]').selectOption(template)
    await expect(items).toHaveCount(i + 1)
  }
  const names = ['PDF(LaTeX)', 'Markdown(GFM)', 'Pandoc Native', 'Pandoc 自定义格式', '自定义命令']
  await expect(page.locator('.tz-export-item-head strong')).toHaveText(names)
  await expect(page.locator('.tz-export-item-head .tz-field-hint')).toHaveText(['PDF(LaTeX / Pandoc)', 'Markdown(其他规范)', 'Native(Pandoc)', 'Pandoc 自定义格式', '自定义命令'])
  await expect(emptyHint).toHaveCount(0)

  const saved = await page.evaluate(() =>
    (window.typozaTest!.host.settings.exportItems as Record<string, unknown>[]).map((x) => ({ template: x.template, name: x.name, to: x.to, ext: x.ext, pdfEngine: x.pdfEngine, dialog: x.dialog })),
  )
  expect(saved).toEqual([
    { template: 'pandoc-pdf', name: 'PDF(LaTeX)', to: 'pdf', ext: 'pdf', pdfEngine: 'xelatex', dialog: 'none' },
    { template: 'markdown', name: 'Markdown(GFM)', to: 'gfm', ext: 'md', pdfEngine: '', dialog: 'none' },
    { template: 'native', name: 'Pandoc Native', to: 'native', ext: 'native', pdfEngine: '', dialog: 'none' },
    { template: 'pandoc', name: 'Pandoc 自定义格式', to: 'html5', ext: 'html', pdfEngine: '', dialog: 'none' },
    { template: 'command', name: '自定义命令', to: '', ext: '', pdfEngine: '', dialog: 'file' },
  ])
  // 外壳按这份清单把导出项挂到 文件 ▸ 导出 末尾
  const synced = await hostCalls(page, 'setExportItems')
  expect((synced[synced.length - 1][0] as { name: string }[]).map((x) => x.name)).toEqual(names)
})

test('F-36 导出设置…:打开偏好设置并直接停在「导出」页', async ({ page }) => {
  await openApp(page)
  await runMenuCommand(page, 'app.exportSettings')
  await expect(page.locator('.tz-modal-head h2')).toHaveText('偏好设置')
  await expect(page.locator('.tz-settings-tab.is-active')).toHaveText('导出')
  await expect(page.locator('.tz-settings-content select[data-key="exportTemplate"]')).toBeVisible()
})

// ---------- E-01 撤消与重做 ----------

test.describe('撤消与重做', () => {
  /** 鼠标移到块上,等「⋮⋮」出现(同 notion-keys.spec.ts)。 */
  async function gripOf(page: Page, block: Locator): Promise<Locator> {
    await block.hover()
    const grip = page.locator('.tz-handle-grip')
    await expect(grip).toBeVisible()
    return grip
  }

  /** Playwright 在 Linux WebKit 上的原生拖放送不到 ProseMirror,直接派发 DragEvent(同 notion-keys.spec.ts 的 dragBlock)。 */
  async function dragBlock(grip: Locator, target: Locator): Promise<void> {
    const box = await target.boundingBox()
    if (!box) throw new Error('取不到落点的位置')
    // 落在目标段落行尾:ProseMirror 按落点在块的后半段,插在该块之后
    await grip.evaluate(
      (el, { x, y }) => {
        const dt = new DataTransfer()
        const fire = (node: Element, type: string, cx: number, cy: number) =>
          node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }))
        const g = el.getBoundingClientRect()
        fire(el, 'dragstart', g.x + g.width / 2, g.y + g.height / 2)
        const over = document.elementFromPoint(x, y)
        if (!over) throw new Error('落点下没有元素')
        fire(over, 'dragenter', x, y)
        fire(over, 'dragover', x, y)
        fire(over, 'drop', x, y)
        fire(el, 'dragend', x, y)
      },
      { x: box.x + box.width - 4, y: box.y + box.height / 2 },
    )
  }

  test('E-01 输入后 ⌘Z 撤消,「重做」恢复', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '甲\n')
    await page.keyboard.type('乙')
    await expect.poll(() => markdown(page)).toBe('甲乙\n')
    await page.keyboard.press(`${await modKey(page)}+z`)
    await expect.poll(() => markdown(page)).toBe('甲\n')
    // 重做走命令(⇧⌘Z 的键位已由冒烟核对;macOS 上由菜单栏键位触发)
    await runMenuCommand(page, 'edit.redo')
    await expect.poll(() => markdown(page)).toBe('甲乙\n')
  })

  test('E-01 拖动块移动位置后可撤消', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '甲\n\n乙\n\n丙\n')
    const paras = page.locator('.tz-editor p')
    await dragBlock(await gripOf(page, paras.nth(0)), paras.nth(2))
    await expect.poll(async () => (await markdown(page)).trim()).toBe('乙\n\n丙\n\n甲')
    await runMenuCommand(page, 'edit.undo')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('甲\n\n乙\n\n丙')
  })

  test('E-01 ⌘/ 转换块类型后可撤消', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '文字\n')
    await page.keyboard.press(`${await modKey(page)}+/`)
    await page.locator('.tz-turn-menu .tz-menu-item[data-id="turn.h2"]').click()
    await expect.poll(() => markdown(page)).toBe('## 文字\n')
    await runMenuCommand(page, 'edit.undo')
    await expect.poll(() => markdown(page)).toBe('文字\n')
  })

  test('E-01 删除块后 ⌘Z 撤消', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '一\n\n二\n\n三\n')
    // Esc 选中光标所在块,⌫ 删除整块
    await page.keyboard.press('Escape')
    await page.keyboard.press('Backspace')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('一\n\n二')
    await page.keyboard.press(`${await modKey(page)}+z`)
    await expect.poll(async () => (await markdown(page)).trim()).toBe('一\n\n二\n\n三')
  })
})

// ---------- E-02 剪切 / 粘贴 ----------

/** 往编辑器派发剪切 / 粘贴事件(给定剪贴板里的各类型数据),返回事件处理后剪贴板里的 HTML 与纯文本。 */
function fireClipboard(page: Page, type: 'cut' | 'paste', given: Record<string, string> = {}): Promise<{ html: string; text: string }> {
  return page.evaluate(
    ([t, items]) => {
      const data = new DataTransfer()
      for (const [k, v] of Object.entries(items)) data.setData(k, v)
      const editor = document.querySelector('.tz-editor')
      if (!editor) throw new Error('找不到编辑器')
      editor.dispatchEvent(new ClipboardEvent(t, { clipboardData: data, bubbles: true, cancelable: true }))
      return { html: data.getData('text/html'), text: data.getData('text/plain') }
    },
    [type, given] as const,
  )
}

test('E-02 剪切:选中内容移出正文,剪贴板写入 HTML 与 Markdown 文字,随后由外壳补上 RTF', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '保留**粗体**')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  // 剪切取的是 ProseMirror 的选区:等原生选区同步过去
  await expect.poll(() => selection(page)).toEqual({ from: 3, text: '粗体' })
  const written = await fireClipboard(page, 'cut')
  expect(written.html).toContain('<strong>粗体</strong>')
  expect(written.text).toBe('**粗体**')
  await expect.poll(() => markdown(page)).toBe('保留\n')
  // 与拷贝同一条链路(plugins/paste.ts copyWithRichText):网页写完后外壳用同样的 HTML 与文字重写并加 RTF
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard)).toEqual({ text: '**粗体**', html: written.html, rtf: true })
})

test('E-02 粘贴 HTML:优先取 HTML 并转成 Markdown,不用同时给的纯文本', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '')
  await fireClipboard(page, 'paste', { 'text/html': '<p><strong>粗</strong>和<em>斜</em></p>', 'text/plain': '纯文本版本' })
  await expect.poll(() => markdown(page)).toBe('**粗**和*斜*\n')
  await expect(page.locator('.tz-editor strong')).toHaveText('粗')
})

// ---------- E-04 ~ E-06 复制为纯文本 / Markdown / HTML 代码 ----------

test.describe('复制为纯文本 / Markdown / HTML 代码', () => {
  // 这三个命令经宿主写剪贴板(app/app.ts copyText):读内存宿主记下的写入
  const copied = (page: Page) =>
    page.evaluate(() => window.typozaTest!.host.calls.filter((c) => c.method === 'clipboardWrite').map((c) => (c.args[0] as { text: string }).text))

  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '**粗**文字')
    await page.keyboard.press('Shift+Home')
    await expect.poll(() => selection(page)).toEqual({ from: 1, text: '粗文字' })
  })

  test('E-04 复制为纯文本:只写文字,不带格式与 Markdown 符号', async ({ page }) => {
    await runMenuCommand(page, 'edit.copyPlain')
    await expect.poll(() => copied(page)).toEqual(['粗文字'])
  })

  test('E-05 复制为 Markdown:写入 Markdown 源码', async ({ page }) => {
    await runMenuCommand(page, 'edit.copyMarkdown')
    await expect.poll(() => copied(page)).toEqual(['**粗**文字'])
  })

  test('E-06 复制为 HTML 代码:把选区的 HTML 源码当纯文本写入', async ({ page }) => {
    await runMenuCommand(page, 'edit.copyHtml')
    await expect.poll(async () => (await copied(page)).length).toBe(1)
    const [html] = await copied(page)
    expect(html).toContain('<strong>粗</strong>文字')
    expect(html).not.toContain('**')
  })
})

// ---------- E-24 刷新所有数学公式 ----------

test('E-24 刷新所有数学公式:改了 \\def 宏定义后,其他公式要刷新才按新定义重新渲染', async ({ page }) => {
  await openApp(page)
  // 同一文档的公式共享宏定义(views/katex.ts):第一个公式定义 \tzv,后面的块公式与行内公式都用它
  await loadDoc(page, '$$\n\\def\\tzv{p}\\tzv\n$$\n\n$$\n\\tzv+1\n$$\n\n行内 $\\tzv^2$ 结尾\n')
  const first = page.locator('.tz-math-preview').nth(0).locator('.katex-mathml mi')
  const second = page.locator('.tz-math-preview').nth(1).locator('.katex-mathml mi')
  const inline = page.locator('.tz-editor .tz-math-inline .katex-mathml mi')
  // KaTeX 按需加载,首次渲染给足时间
  await expect(second).toHaveText('p', { timeout: 15_000 })
  await expect(inline).toHaveText('p')

  // 只改第一个公式里的定义:它自己重新渲染,其他公式源码没变、不会自动重画,仍是旧结果
  await page.evaluate(() => {
    const view = window.typozaTest!.app.view
    let at = -1
    view.state.doc.forEach((node, offset) => {
      if (at < 0 && node.type.name === 'math_block') at = offset + 1 + node.textContent.indexOf('{p}') + 1
    })
    if (at < 0) throw new Error('找不到第一个公式块')
    view.dispatch(view.state.tr.insertText('q', at, at + 1))
  })
  await expect(first).toHaveText('q')
  await expect(second).toHaveText('p')
  await expect(inline).toHaveText('p')

  await runMenuCommand(page, 'math.refresh')
  await expect(second).toHaveText('q')
  await expect(inline).toHaveText('q')
  await expect(first).toHaveText('q')
})

// ---------- E-26 / E-27 换行符 ----------

test('E-26 换行符改为 LF:CRLF 文档提示已改,写回内容全为 LF;再选一次提示已是 LF', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '第一段\r\n\r\n第二段\r\n', '/demo/换行.md')
  expect(await markdown(page)).toBe('第一段\r\n\r\n第二段\r\n')
  await runMenuCommand(page, 'doc.lineEndingLF')
  await expect(page.locator('.tz-toast')).toHaveText('换行符已改为 Unix 换行符(LF)')
  expect(await markdown(page)).toBe('第一段\n\n第二段\n')
  // 改换行符算修改,按自动保存写盘
  await expect.poll(() => fileText(page, '/demo/换行.md'), { timeout: 5000 }).toBe('第一段\n\n第二段\n')
  await runMenuCommand(page, 'doc.lineEndingLF')
  await expect(page.locator('.tz-toast')).toHaveText('当前已是 Unix 换行符(LF)')
})

test('E-27 保存时在文末添加空行:菜单开关切换;关掉后写回不补换行,打开后补且只补 1 个', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '第一行', '/demo/文末.md')
  // 默认开,菜单切一次即关
  await runMenuCommand(page, 'edit.trailingNewline')
  await expect(page.locator('.tz-toast')).toHaveText('保存时在文末添加空行:已关闭')
  expect(await page.evaluate(() => window.typozaTest!.host.settings.ensureTrailingNewline)).toBe(false)
  await page.keyboard.type('改')
  await expect.poll(() => fileText(page, '/demo/文末.md'), { timeout: 5000 }).toBe('第一行改')

  await runMenuCommand(page, 'edit.trailingNewline')
  await expect(page.locator('.tz-toast')).toHaveText('保存时在文末添加空行:已开启')
  await runMenuCommand(page, 'file.save')
  await expect.poll(() => fileText(page, '/demo/文末.md')).toBe('第一行改\n')

  // 原文已有结尾换行:不重复补
  await loadDoc(page, '已有换行\n', '/demo/文末2.md')
  await page.keyboard.type('改')
  await expect.poll(() => fileText(page, '/demo/文末2.md'), { timeout: 5000 }).toBe('已有换行改\n')
})

// ---------- E-42 / E-44 查找与替换 ----------

test('E-42 查找下一个 / 上一个:在匹配项间循环跳转、选中匹配;查找框内 ↩ / ⇧↩ 同效', async ({ page }) => {
  await openApp(page)
  // 两处「苹果」:第一段文首(位置 1)、第二段文首(位置 8)
  await loadDoc(page, '苹果 香蕉\n\n苹果派\n')
  await runMenuCommand(page, 'find.open')
  const input = page.locator('.tz-find-input').first()
  const count = page.locator('.tz-find-count')
  const currentIn = (i: number) => page.locator('.tz-editor > p').nth(i).locator('.tz-find-match.is-current')
  await input.fill('苹果')
  // 光标在文末,后面没有匹配,当前项回到第一处
  await expect(count).toHaveText('1/2')

  await runMenuCommand(page, 'find.next')
  await expect(count).toHaveText('2/2')
  await expect(currentIn(1)).toHaveCount(1)
  await expect.poll(() => selection(page)).toEqual({ from: 8, text: '苹果' })
  // 到最后一处后回到第一处
  await runMenuCommand(page, 'find.next')
  await expect(count).toHaveText('1/2')
  await expect(currentIn(0)).toHaveCount(1)
  await expect.poll(() => selection(page)).toEqual({ from: 1, text: '苹果' })
  await runMenuCommand(page, 'find.prev')
  await expect(count).toHaveText('2/2')
  await expect.poll(() => selection(page)).toEqual({ from: 8, text: '苹果' })

  await input.press('Enter')
  await expect(count).toHaveText('1/2')
  await expect.poll(() => selection(page)).toEqual({ from: 1, text: '苹果' })
  await input.press('Shift+Enter')
  await expect(count).toHaveText('2/2')
  await expect.poll(() => selection(page)).toEqual({ from: 8, text: '苹果' })
})

test('E-44 替换下一个:只替换当前一处并选中剩下的下一处(两处匹配);全部换完提示未找到', async ({ page }) => {
  await openApp(page)
  await loadDoc(page, '苹果 香蕉\n\n苹果派\n')
  await runMenuCommand(page, 'find.replace')
  const inputs = page.locator('.tz-find-input')
  const count = page.locator('.tz-find-count')
  await inputs.first().fill('苹果')
  await expect(count).toHaveText('1/2')
  await inputs.nth(1).fill('梨')

  await runMenuCommand(page, 'find.replaceNext')
  await expect.poll(() => markdown(page)).toBe('梨 香蕉\n\n苹果派\n')
  await expect(count).toHaveText('1/1')
  // 第一段变成「梨 香蕉」后,第二段文首在位置 7
  await expect.poll(() => selection(page)).toEqual({ from: 7, text: '苹果' })

  await runMenuCommand(page, 'find.replaceNext')
  await expect.poll(() => markdown(page)).toBe('梨 香蕉\n\n梨派\n')
  await expect(count).toHaveText('未找到所查内容')
})
