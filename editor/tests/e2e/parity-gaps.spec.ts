import { expect, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { contextMenuAt, hostCalls, runMenuCommand } from './media-helpers'

// 对照表「实现」行里此前没有用例为证、或补实现后要验证的几项:X-15、X-60、C-10、C-13、C-14、P-11、P-13、P-17、P-23、P-30、M-12、M-20、M-21、S-01、PF-02、E-44、PA-06、PM-15、PM-16、X-43、E-38、PX-04、PX-06、Notion 2.1 #2 与 5.1 #55,以及 HTML 块里的图片双击放大
test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const menuItem = (id: string) => `.tz-context-menu [data-id="${id}"]`
const selectionFrom = (page: import('@playwright/test').Page) => page.evaluate(() => window.typozaTest!.app.view.state.selection.from)

test('X-15 剪贴板里是图片文件(Finder 里拷贝)时粘贴:存进 assets 并插入图片', async ({ page }) => {
  await loadDoc(page, '段落\n', '/demo/粘贴文件.md')
  // WebKit 粘贴 Finder 拷贝的文件时只给 Files,不给含路径的 text/plain
  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], '贴图.gif', { type: 'image/gif' }))
    document.querySelector('.tz-editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect.poll(() => markdown(page)).toContain('![贴图](assets/贴图.gif)')
  expect(await page.evaluate(() => window.typozaTest!.host.files.has('/demo/assets/贴图.gif'))).toBe(true)
})

test('X-60 段落只有一张图时居中,和文字同段时不居中;补上文字后不再居中', async ({ page }) => {
  // id.svg 宽 400,比正文窄,看得出是否居中
  await loadDoc(page, '![标识](assets/id.svg)\n\n前面的字 ![标识](assets/id.svg)\n')
  const paras = page.locator('.tz-editor > p')
  const layout = (i: number) =>
    paras.nth(i).evaluate((p) => {
      const img = p.querySelector<HTMLElement>('.tz-image')!
      const a = p.getBoundingClientRect()
      const b = img.getBoundingClientRect()
      const css = getComputedStyle(img)
      return {
        center: Math.abs(a.left + a.width / 2 - (b.left + b.width / 2)),
        narrower: b.width > 0 && b.width < a.width - 40,
        display: css.display,
        marginLeft: parseFloat(css.marginLeft),
      }
    })
  await expect.poll(async () => (await layout(0)).narrower, { timeout: 5000 }).toBe(true)
  await expect(paras.nth(0)).toHaveClass(/tz-image-only/)
  await expect(paras.nth(1)).not.toHaveClass(/tz-image-only/)
  const solo = await layout(0)
  expect(solo.center).toBeLessThan(2)
  expect(solo.display).toBe('block')
  expect(solo.marginLeft).toBeGreaterThan(20)
  // 和文字同段:照常行内排在文字后面
  expect(await layout(1)).toMatchObject({ display: 'inline-block', marginLeft: 0 })
  // 在第一段图片后补字:不再是单图段落
  await page.evaluate(() => {
    const view = window.typozaTest!.app.view
    view.dispatch(view.state.tr.insertText('说明', 2))
  })
  await expect(paras.nth(0)).not.toHaveClass(/tz-image-only/)
  expect(await layout(0)).toMatchObject({ display: 'inline-block', marginLeft: 0 })
})

test.describe('C-10 右键图片:在浏览器 / 默认应用中打开', () => {
  test('网络图片:在浏览器中打开图片', async ({ page }) => {
    await loadDoc(page, '![远程](https://img.example.com/pic.png)\n')
    // 测试环境连不上这个网址:图片加载失败后 img 隐藏,右键点占位框
    await page.locator('.tz-editor .tz-image').click({ button: 'right' })
    await expect(page.locator(menuItem('ctx.image.open'))).toHaveCount(0)
    await page.locator(menuItem('ctx.image.browser')).click()
    await expect.poll(() => hostCalls(page, 'openExternal')).toContainEqual(['https://img.example.com/pic.png'])
  })

  test('本机图片:用默认应用打开(传绝对路径)', async ({ page }) => {
    await loadDoc(page, '![表单](assets/form.svg)\n', '/demo/默认应用.md')
    await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
    await expect(page.locator(menuItem('ctx.image.browser'))).toHaveCount(0)
    await page.locator(menuItem('ctx.image.open')).click()
    await expect.poll(() => hostCalls(page, 'openWithDefaultApp')).toContainEqual(['/demo/assets/form.svg'])
  })
})

test.describe('C-14 右键 ▸ 跳转到', () => {
  test('文首、文末', async ({ page }) => {
    await loadDoc(page, '# 标题\n\n中间段落\n\n末段文字\n')
    const end = await selectionFrom(page)
    await contextMenuAt(page, '.tz-editor p', { x: 8, y: 10 })
    await page.locator(menuItem('ctx.jump')).hover()
    await page.locator(menuItem('ctx.jump.start')).click()
    await expect.poll(() => selectionFrom(page)).toBe(1)
    await contextMenuAt(page, '.tz-editor p', { x: 8, y: 10 })
    await page.locator(menuItem('ctx.jump')).hover()
    await page.locator(menuItem('ctx.jump.end')).click()
    await expect.poll(() => selectionFrom(page)).toBe(end)
  })

  test('脚注引用上右键跳到脚注定义,定义上右键跳回引用', async ({ page }) => {
    await loadDoc(page, '正文[^1]说明\n\n中间段落\n\n[^1]: 脚注内容\n')
    const inDef = () =>
      page.evaluate(() => {
        const $from = window.typozaTest!.app.view.state.selection.$from
        for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'footnote_def') return true
        return false
      })
    await page.locator('.tz-editor .tz-footnote-ref').click({ button: 'right' })
    await page.locator(menuItem('ctx.jump')).hover()
    await expect(page.locator(menuItem('ctx.jump.footnote'))).toHaveText(/脚注定义/)
    await page.locator(menuItem('ctx.jump.footnote')).click()
    await expect.poll(inDef).toBe(true)

    await page.locator('.tz-editor .tz-footnote-def').click({ button: 'right' })
    await page.locator(menuItem('ctx.jump')).hover()
    await expect(page.locator(menuItem('ctx.jump.footnote'))).toHaveText(/脚注引用/)
    await page.locator(menuItem('ctx.jump.footnote')).click()
    await expect.poll(inDef).toBe(false)
    // 跳回第一处引用之后:光标在第一段
    expect(await page.evaluate(() => window.typozaTest!.app.view.state.selection.$from.parent.textContent)).toContain('正文')
  })
})

test('HTML 块里的图片双击打开灯箱', async ({ page }) => {
  await loadDoc(page, '<div align="center"><img src="assets/form.svg" alt="表单"></div>\n')
  await page.locator('.tz-html-preview img').dblclick()
  await expect(page.locator('.tz-lightbox')).toBeVisible()
  await expect.poll(() => page.locator('.tz-lb-img').evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 5000 }).toBeGreaterThan(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.tz-lightbox')).toHaveCount(0)
})

test.describe('P-11 / P-13 / P-17 右键 ▸ 表格', () => {
  test('上方插入行、左侧 / 右侧插入列、删除列', async ({ page }) => {
    await loadDoc(page, '| a | b |\n| - | - |\n| 1 | 2 |\n')
    const rows = page.locator('.tz-editor tr')
    const cols = rows.first().locator('th, td')
    const one = page.locator('.tz-editor td').filter({ hasText: /^1$/ })
    const pick = async (id: string) => {
      await one.click({ button: 'right' })
      await page.locator(menuItem('ctx.table')).hover()
      await page.locator(menuItem(`ctx.${id}`)).click()
    }
    await pick('table.rowAbove')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(1)).not.toContainText('1')
    await expect(rows.nth(2)).toContainText('1')
    await pick('table.colLeft')
    await expect(cols).toHaveCount(3)
    await pick('table.colRight')
    await expect(cols).toHaveCount(4)
    // 删掉「1」所在列:表头 a 与「1」一起没了,b、2 还在
    await pick('table.deleteCol')
    await expect(cols).toHaveCount(3)
    await expect(one).toHaveCount(0)
    await expect(page.locator('.tz-editor th').filter({ hasText: /^a$/ })).toHaveCount(0)
    await expect(page.locator('.tz-editor td').filter({ hasText: /^2$/ })).toHaveCount(1)
  })

  test('表格外右键没有「表格」子菜单', async ({ page }) => {
    await loadDoc(page, '段落\n\n| a |\n| - |\n| 1 |\n')
    await page.locator('.tz-editor > p').first().click({ button: 'right' })
    await expect(page.locator(menuItem('ctx.insert'))).toBeVisible()
    await expect(page.locator(menuItem('ctx.table'))).toHaveCount(0)
  })
})

test('C-13 / M-12 右键链接:复制链接地址、复制链接文字、打开链接', async ({ page }) => {
  await loadDoc(page, '看 [示例站点](https://example.com/a) 这里\n')
  const link = page.locator('.tz-editor a', { hasText: '示例站点' })
  const clipboard = () => page.evaluate(() => window.typozaTest!.host.clipboard.text)
  await link.click({ button: 'right' })
  await page.locator(menuItem('ctx.link.copyUrl')).click()
  await expect.poll(clipboard).toBe('https://example.com/a')
  await link.click({ button: 'right' })
  await expect(page.locator(menuItem('ctx.link.copyText'))).toContainText('复制「示例站点」')
  await page.locator(menuItem('ctx.link.copyText')).click()
  await expect.poll(clipboard).toBe('示例站点')
  await link.click({ button: 'right' })
  await page.locator(menuItem('ctx.link.open')).click()
  await expect.poll(() => hostCalls(page, 'openExternal')).toContainEqual(['https://example.com/a'])
})

test('P-23 代码工具 ▸ 复制代码块内容;右上角【复制代码】按钮同样写进剪贴板', async ({ page }) => {
  await loadDoc(page, '```js\nconst a = 1\nconst b = 2\n```\n\n段落\n')
  const clipboard = () => page.evaluate(() => window.typozaTest!.host.clipboard.text)
  await page.locator('.tz-editor .tz-code-block .cm-content').click()
  await runMenuCommand(page, 'code.copyBlock')
  await expect.poll(clipboard).toBe('const a = 1\nconst b = 2')
  await page.evaluate(() => {
    window.typozaTest!.host.clipboard.text = ''
  })
  await page.locator('.tz-editor .tz-code-block .tz-code-copy').click()
  await expect.poll(clipboard).toBe('const a = 1\nconst b = 2')
})

test('P-30 任务状态 ▸ 标记为已完成 / 标记为未完成', async ({ page }) => {
  await loadDoc(page, '- [ ] 待办一\n')
  await runMenuCommand(page, 'block.markDone')
  await expect.poll(() => markdown(page)).toBe('- [x] 待办一\n')
  // 已完成再标记已完成:不变
  await runMenuCommand(page, 'block.markDone')
  await expect.poll(() => markdown(page)).toBe('- [x] 待办一\n')
  await runMenuCommand(page, 'block.markUndone')
  await expect.poll(() => markdown(page)).toBe('- [ ] 待办一\n')
})

test('M-20 / M-21 复制图片后的地址与插入图片同一规则:「为相对路径添加 ./」时加 ./,文档文件夹外写 ../', async ({ page }) => {
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ imageRelativeDotSlash: true }))
  await loadDoc(page, '![标识](assets/id.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/out']))
  await runMenuCommand(page, 'image.copyTo')
  await expect.poll(() => markdown(page)).toBe('![标识](./out/id.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/其他']))
  await runMenuCommand(page, 'image.copyTo')
  await expect.poll(() => markdown(page)).toBe('![标识](../其他/id.svg)\n')
})

test('S-01 / PF-02 关掉「允许折叠和展开侧边栏的大纲视图」当场生效:箭头与折叠按钮消失,再打开恢复', async ({ page }) => {
  await loadDoc(page, '# 甲\n\n## 甲一\n\n# 乙\n')
  await page.evaluate(async () => {
    const t = window.typozaTest!
    await t.app.updateSettings({ sidebarVisible: true })
    await (t.app as unknown as { sidebar: { setTab(tab: string): Promise<void> } }).sidebar.setTab('outline')
  })
  const fold = page.locator('.tz-outline button[name=collapseAll]')
  const arrows = page.locator('.tz-outline-twisty', { hasText: '▾' })
  await expect(fold).toHaveCount(1)
  await expect(arrows).toHaveCount(1)
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ outlineCollapsible: false }))
  await expect(fold).toHaveCount(0)
  await expect(arrows).toHaveCount(0)
  await expect(page.locator('.tz-outline-item')).toHaveCount(3)
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ outlineCollapsible: true }))
  await expect(fold).toHaveCount(1)
})

test('E-44 替换下一个(三处匹配):替换第一处后选中第二处,不跳过', async ({ page }) => {
  await loadDoc(page, '苹果一\n\n苹果二\n\n苹果三\n')
  await runMenuCommand(page, 'find.replace')
  const inputs = page.locator('.tz-find-input')
  const count = page.locator('.tz-find-count')
  const selected = () =>
    page.evaluate(() => {
      const { state } = window.typozaTest!.app.view
      return { from: state.selection.from, text: state.doc.textBetween(state.selection.from, state.selection.to) }
    })
  await inputs.first().fill('苹果')
  await expect(count).toHaveText('1/3')
  await inputs.nth(1).fill('梨')
  await runMenuCommand(page, 'find.replaceNext')
  await expect.poll(() => markdown(page)).toBe('梨一\n\n苹果二\n\n苹果三\n')
  await expect(count).toHaveText('1/2')
  // 第一段成了「梨一」(段长 4),第二段的「苹果」从位置 5 起
  await expect.poll(selected).toEqual({ from: 5, text: '苹果' })
  await runMenuCommand(page, 'find.replaceNext')
  await expect.poll(() => markdown(page)).toBe('梨一\n\n梨二\n\n苹果三\n')
  await expect.poll(selected).toEqual({ from: 9, text: '苹果' })
})

test('PA-06 默认显示大纲视图:打开开关后启动时侧栏显示大纲', async ({ page }) => {
  const tab = () => page.evaluate(() => (window.typozaTest!.app as unknown as { sidebar: { currentTab: string } }).sidebar.currentTab)
  await expect.poll(tab).not.toBe('outline')
  await openApp(page, `?settings=${encodeURIComponent(JSON.stringify({ outlineByDefault: true, sidebarVisible: true }))}`)
  await expect.poll(tab).toBe('outline')
})

test('PM-15 / PM-16 改代码块行号、自动换行:已显示的代码块当场生效,不用重开文档', async ({ page }) => {
  await loadDoc(page, '```js\nconst a = 1\n```\n')
  const content = page.locator('.tz-editor .tz-code-block .cm-content')
  await expect(content).toHaveCount(1)
  await expect(page.locator('.tz-editor .cm-lineNumbers')).toHaveCount(0)
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ codeLineNumbers: true }))
  await expect(page.locator('.tz-editor .cm-lineNumbers')).toHaveCount(1)
  // 自动换行默认开
  await expect(content).toHaveClass(/cm-lineWrapping/)
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ codeLineWrap: false }))
  await expect(content).not.toHaveClass(/cm-lineWrapping/)
})

test('PM-16 打印与导出 PDF 时代码块始终折行(关掉自动换行也一样)', async ({ page }) => {
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ codeLineWrap: false }))
  await loadDoc(page, '```js\nconst a = 1\n```\n')
  const content = page.locator('.tz-editor .tz-code-block .cm-content')
  await expect(content).not.toHaveClass(/cm-lineWrapping/)
  expect(await content.evaluate((el) => getComputedStyle(el).whiteSpace)).not.toBe('pre-wrap')
  await page.emulateMedia({ media: 'print' })
  expect(await content.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
})

test('X-43 段落里成对的 kbd、ruby、font 照样渲染,保存不改原文', async ({ page }) => {
  const md = '按 <kbd>Ctrl</kbd> 与 <ruby>汉<rt>hàn</rt></ruby> 和 <font color="red">红</font>\n'
  await loadDoc(page, md)
  await expect(page.locator('.tz-editor p kbd')).toHaveText('Ctrl')
  await expect(page.locator('.tz-editor p ruby rt')).toHaveText('hàn')
  await expect(page.locator('.tz-editor p font[color="red"]')).toContainText('红')
  expect(await markdown(page)).toBe(md)
})

test('E-38 行内代码、代码块、公式、自动识别的网址不做拼写检查;普通正文与链接文字照常检查', async ({ page }) => {
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ spellcheck: true }))
  await loadDoc(page, '正文 `code` 与 https://example.com/a 和 [链接文字](https://b.example)\n\n```js\nconst a = 1\n```\n\n$$\nx^2\n$$\n')
  await expect(page.locator('.tz-editor')).toHaveAttribute('spellcheck', 'true')
  await expect(page.locator('.tz-editor p code')).toHaveAttribute('spellcheck', 'false')
  await expect(page.locator('.tz-editor a[href="https://example.com/a"]')).toHaveAttribute('spellcheck', 'false')
  expect(await page.locator('.tz-editor a[href="https://b.example"]').getAttribute('spellcheck')).toBeNull()
  await expect(page.locator('.tz-editor .tz-code-block .cm-content')).toHaveAttribute('spellcheck', 'false')
  await expect(page.locator('.tz-editor .tz-math-source')).toHaveAttribute('spellcheck', 'false')
})

test('PX-04 / PX-06 导出参数:PDF 的页边距与主题、图片的字号与主题都交给导出', async ({ page }) => {
  await loadDoc(page, '# 标题\n\n正文\n', '/demo/导出参数.md')
  // 内存宿主只记格式、目标与参数;这里另外截下发给外壳的 HTML
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    const sent: { format: string; html: string; options?: Record<string, unknown> }[] = []
    ;(window as unknown as { __sent: typeof sent }).__sent = sent
    const original = host.exportDocument.bind(host)
    host.exportDocument = async (o) => {
      sent.push({ format: o.format, html: o.html, options: o.options })
      return original(o)
    }
  })
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ exportPdfMargin: 25, exportPdfTheme: 'newsprint', exportImageFontSize: 20, exportImageTheme: 'night' }))
  const sent = () => page.evaluate(() => (window as unknown as { __sent: { format: string; html: string; options?: Record<string, unknown> }[] }).__sent)
  await runMenuCommand(page, 'file.export.pdf')
  await expect.poll(async () => (await sent()).length).toBe(1)
  await runMenuCommand(page, 'file.export.image')
  await expect.poll(async () => (await sent()).length).toBe(2)
  const [pdf, image] = await sent()
  expect(pdf.format).toBe('pdf')
  expect(pdf.options?.margin).toBe(25)
  expect(pdf.html).toContain('data-theme="newsprint"')
  expect(image.format).toBe('image')
  expect(image.html).toContain('--tz-font-size: 20px')
  expect(image.html).toContain('data-theme="night"')
})

test('Notion 2.1 #2 「[ ]」加空格同「[]」一样成待办', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('[ ] 待办')
  await expect.poll(() => markdown(page)).toBe('- [ ] 待办\n')
})

test('Notion 5.1 #55 光标在文档链接上按 ⌘↩:打开链接的文档', async ({ page }) => {
  await loadDoc(page, '去 [另一篇](另一篇.md) 看\n', '/demo/链接起点.md')
  // 光标从段尾左移三格,落在链接文字「另一|篇」中间
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft')
  await expect
    .poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.$from.marks().some((m) => m.type.name === 'link')))
    .toBe(true)
  const mod = await modKey(page)
  await page.keyboard.press(`${mod}+Enter`)
  await expect.poll(() => page.evaluate(() => window.typozaTest!.app.session.path)).toBe('/demo/另一篇.md')
})

test('X-44 HTML 块里的 position:fixed 只铺满预览框,盖不住编辑器界面', async ({ page }) => {
  await loadDoc(page, '<div style="position:fixed;inset:0;background:red">盖层</div>\n\n正文\n')
  const cover = await page.locator('.tz-html-preview div', { hasText: '盖层' }).boundingBox()
  const preview = await page.locator('.tz-html-preview').first().boundingBox()
  const viewport = page.viewportSize()!
  expect(cover && preview).toBeTruthy()
  expect(cover!.width).toBeLessThanOrEqual(preview!.width + 1)
  expect(cover!.height).toBeLessThanOrEqual(preview!.height + 1)
  expect(cover!.width).toBeLessThan(viewport.width - 100)
})

test('自己保存触发的文件监视通知比写盘回执先到时,不误报「文件已被其他程序修改」', async ({ page }) => {
  await loadDoc(page, '原文\n', '/demo/自己保存.md')
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    const write = host.writeText.bind(host)
    // 模拟真机上的时序:文件监视先通知,写盘的回执晚 50 毫秒才到
    host.writeText = async (path, text, encoding) => {
      const result = await write(path, text, encoding)
      host.emit('fs.changed', { paths: [path] })
      await new Promise((r) => setTimeout(r, 50))
      return result
    }
  })
  await page.keyboard.type('追加')
  await runMenuCommand(page, 'file.save')
  await expect.poll(() => page.evaluate(() => window.typozaTest!.app.session.dirty)).toBe(false)
  // 通知的处理是异步的:多等一会儿,确认没有弹出询问
  await page.waitForTimeout(300)
  expect(await hostCalls(page, 'confirm')).toEqual([])
  expect(await markdown(page)).toBe('原文追加\n')
})
