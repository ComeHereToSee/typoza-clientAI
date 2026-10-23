import { expect, test } from '@playwright/test'
import { loadDoc, markdown, openApp } from './helpers'
import { clipboardEvent, contextMenuAt, hostCalls, runMenuCommand, toDocStart } from './media-helpers'

// 右键菜单(对照表 C 区)、编辑菜单(E 区)、查找替换、HTML 块、页面图标与封面(差距清单 41、46、64、67、68 与第三节)
test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const menuItem = (id: string) => `.tz-context-menu [data-id="${id}"]`

test.describe('右键菜单', () => {
  test('右键图片:图像工具、删除图片', async ({ page }) => {
    await loadDoc(page, '![标识](assets/id.svg)\n')
    await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
    await expect(page.locator(menuItem('ctx.image.tools'))).toBeVisible()
    await page.locator(menuItem('ctx.image.tools')).hover()
    await expect(page.locator(menuItem('ctx.image.copy'))).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
    await page.locator(menuItem('ctx.image.delete')).click()
    await expect.poll(() => markdown(page)).not.toContain('id.svg')
  })

  test('右键图片:缩放图片至 50%', async ({ page }) => {
    await loadDoc(page, '![标识](assets/id.svg)\n')
    await page.locator('.tz-editor .tz-image img').click({ button: 'right' })
    await page.locator(menuItem('ctx.image.tools')).hover()
    await page.locator(menuItem('ctx.image.zoom')).hover()
    await page.locator(menuItem('ctx.image.zoom.50%')).click()
    await expect.poll(() => markdown(page)).toBe('<img src="assets/id.svg" alt="标识" style="zoom:50%;" />\n')
  })

  test('选中文字右键:用搜索引擎搜索、内联样式', async ({ page }) => {
    await loadDoc(page, '文字')
    await page.keyboard.press('Shift+Home')
    // 选中的文字上右键(只派发菜单事件,不让右键按下改动选区)
    await contextMenuAt(page, '.tz-editor p', { x: 8, y: 14 })
    await page.locator(menuItem('ctx.search')).hover()
    await page.locator(menuItem('ctx.search.google')).click()
    await expect.poll(() => hostCalls(page, 'openExternal')).toContainEqual([`https://www.google.com/search?q=${encodeURIComponent('文字')}`])

    await contextMenuAt(page, '.tz-editor p', { x: 8, y: 14 })
    await page.locator(menuItem('ctx.inlineStyle')).hover()
    await page.locator(menuItem('ctx.format.bold')).click()
    await expect.poll(() => markdown(page)).toBe('**文字**\n')
  })

  test('右键插入分割线', async ({ page }) => {
    await loadDoc(page, '文字')
    await page.locator('.tz-editor p').first().click({ button: 'right' })
    await page.locator(menuItem('ctx.insert')).hover()
    await page.locator(menuItem('ctx.insert.divider')).click()
    await expect.poll(() => markdown(page)).toContain('文字\n\n---')
  })

  test('右键代码块:删除代码块', async ({ page }) => {
    await loadDoc(page, '```js\nconst a = 1\n```\n\n段落\n')
    await page.locator('.tz-editor .tz-code-block .cm-content').click({ button: 'right' })
    await page.locator(menuItem('ctx.code.delete')).click()
    await expect.poll(() => markdown(page)).toBe('段落\n')
  })

  test('右键粘贴为纯文本:Markdown 符号按字面保留', async ({ page }) => {
    await loadDoc(page, '')
    await page.evaluate(() => {
      window.typozaTest!.host.clipboard.text = '**不加粗**'
    })
    await page.locator('.tz-editor p').first().click({ button: 'right' })
    await page.locator(menuItem('ctx.copyPasteAs')).hover()
    await page.locator(menuItem('ctx.edit.pastePlain')).click()
    await expect.poll(() => markdown(page)).toBe('\\*\\*不加粗\\*\\*\n')
  })

  test('按住 ⌥ 右键不弹自定义菜单(保留系统菜单)', async ({ page }) => {
    await loadDoc(page, '文字')
    await page.locator('.tz-editor p').first().click({ button: 'right', modifiers: ['Alt'] })
    await expect(page.locator('.tz-context-menu')).toHaveCount(0)
  })
})

test.describe('拷贝与粘贴', () => {
  test('拷贝时由外壳重写剪贴板并带上 RTF', async ({ page }) => {
    await loadDoc(page, '**粗体**文字')
    await page.keyboard.press('Shift+Home')
    // 复制取的是编辑器自己的选区:等它跟上 ⇧Home(CI 上偶尔慢一拍,复制时还是空选区)
    await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.empty)).toBe(false)
    const written = await clipboardEvent(page, 'copy')
    expect(written.html).toContain('<strong>粗体</strong>')
    await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard)).toEqual({
      text: '**粗体**文字',
      html: written.html,
      rtf: true,
    })
  })

  test('⌘V 纯文本按 Markdown 解析;⇧⌘V 按字面粘贴', async ({ page }) => {
    await loadDoc(page, '')
    await clipboardEvent(page, 'paste', '**粗体**')
    await expect.poll(() => markdown(page)).toBe('**粗体**\n')

    await loadDoc(page, '')
    await page.keyboard.down('Shift')
    await clipboardEvent(page, 'paste', '**粗体**')
    await page.keyboard.up('Shift')
    await expect.poll(() => markdown(page)).toBe('\\*\\*粗体\\*\\*\n')
    await expect(page.locator('.tz-editor strong')).toHaveCount(0)
  })

  test('复制内容并简化格式:去掉颜色等样式', async ({ page }) => {
    await loadDoc(page, '<span style="color: #D44C47">红字</span>正文')
    await page.keyboard.press('Shift+Home')
    await runMenuCommand(page, 'edit.copySimplified')
    await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard.rtf)).toBe(true)
    const html = await page.evaluate(() => window.typozaTest!.host.clipboard.html ?? '')
    expect(html).toContain('红字')
    expect(html).not.toContain('style=')
  })
})

test.describe('编辑菜单', () => {
  test('换行符改为 CRLF 后写回', async ({ page }) => {
    await loadDoc(page, '第一段\n\n第二段\n')
    await runMenuCommand(page, 'doc.lineEndingCRLF')
    await expect(page.locator('.tz-toast')).toContainText('换行符已改为 Windows 换行符(CRLF)')
    expect(await markdown(page)).toBe('第一段\r\n\r\n第二段\r\n')
  })

  test('转换大小写', async ({ page }) => {
    await loadDoc(page, 'hello wORLD')
    await page.keyboard.press('Shift+Home')
    await runMenuCommand(page, 'text.uppercase')
    await expect.poll(() => markdown(page)).toBe('HELLO WORLD\n')
    await runMenuCommand(page, 'text.capitalize')
    await expect.poll(() => markdown(page)).toBe('Hello World\n')
  })

  test('空格与换行:显示 <br/>、忽略单换行、首行缩进', async ({ page }) => {
    await loadDoc(page, '前<br>后\n\n上一行\n下一行\n')
    await runMenuCommand(page, 'view.showBrTag')
    await expect(page.locator('.tz-editor .tz-br-tag')).toHaveCount(1)
    await runMenuCommand(page, 'edit.preserveSingleNewline')
    await expect(page.locator('.tz-editor .tz-soft-break')).toHaveCount(1)
    await runMenuCommand(page, 'view.firstLineIndent')
    await expect(page.locator('html')).toHaveClass(/tz-first-line-indent/)
    // 只影响显示,文件不变
    expect(await markdown(page)).toBe('前<br>后\n\n上一行\n下一行\n')
  })

  test('解析时转化 Unicode 标点:》 按引用识别,原文不变', async ({ page }) => {
    await loadDoc(page, '》引用内容\n')
    await expect(page.locator('.tz-editor blockquote')).toHaveCount(0)
    await runMenuCommand(page, 'edit.unicodePunctuation')
    await expect(page.locator('.tz-editor blockquote')).toHaveCount(1)
    expect(await markdown(page)).toBe('》引用内容\n')
  })

  test('替换 ▸ 智能标点、智能引号、智能破折号与偏好同一组设置;更多选项打开偏好 Markdown 页', async ({ page }) => {
    const setting = (key: string) => page.evaluate((k) => window.typozaTest!.host.settings[k], key)
    await loadDoc(page, '正文\n')
    await runMenuCommand(page, 'edit.smartPunctuationRender')
    await expect.poll(() => setting('smartPunctuationMode')).toBe('render')
    await runMenuCommand(page, 'edit.smartPunctuationRender')
    await expect.poll(() => setting('smartPunctuationMode')).toBe('off')
    await runMenuCommand(page, 'edit.smartQuotes')
    await expect.poll(() => setting('smartQuotes')).toBe(true)
    await expect(page.locator('.tz-toast')).toContainText('智能标点当前已关闭')
    await runMenuCommand(page, 'edit.substitutionOptions')
    await expect(page.locator('.tz-settings-tab[data-page="Markdown"]')).toHaveClass(/is-active/)
  })

  test('插入 HTML 块', async ({ page }) => {
    await loadDoc(page, '')
    await runMenuCommand(page, 'insert.htmlBlock')
    await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(1)
    await page.keyboard.type('<kbd>K</kbd>')
    await expect.poll(() => markdown(page)).toContain('<kbd>K</kbd>')
  })
})

test.describe('查找与替换', () => {
  test('无结果提示「未找到所查内容」', async ({ page }) => {
    await loadDoc(page, 'abc')
    await runMenuCommand(page, 'find.open')
    await page.locator('.tz-find-input').first().fill('zzz')
    await expect(page.locator('.tz-find-count')).toHaveText('未找到所查内容')
  })

  test('限「选中部分」全部替换', async ({ page }) => {
    await loadDoc(page, 'a a\n\na a')
    await toDocStart(page)
    await page.keyboard.press('Shift+End')
    await runMenuCommand(page, 'find.replace')
    await page.locator('.tz-find-input').first().fill('a')
    await page.locator('.tz-find-scope-toggle').click()
    await expect(page.locator('.tz-find-scope-toggle')).toHaveClass(/is-on/)
    await expect(page.locator('.tz-find-count')).toHaveText('1/2')
    await page.locator('.tz-find-replace .tz-find-input').fill('b')
    await page.locator('.tz-find-action', { hasText: '全部替换' }).click()
    await expect.poll(() => markdown(page)).toBe('b b\n\na a\n')
  })
})

test.describe('HTML 块', () => {
  test('style 只显示源码', async ({ page }) => {
    await loadDoc(page, '<style>\n.x { color: red; }\n</style>\n\n段落\n')
    await expect(page.locator('.tz-editor .tz-html-preview code.tz-html-raw')).toContainText('.x { color: red; }')
    expect(await page.evaluate(() => document.querySelectorAll('.tz-editor style').length)).toBe(0)
  })

  test('点内容不展开源码,⌘+点击展开', async ({ page }) => {
    await loadDoc(page, '<div>HTML 内容</div>\n\n段落\n')
    const content = page.locator('.tz-editor .tz-html-preview div', { hasText: 'HTML 内容' })
    await content.click({ position: { x: 6, y: 14 } })
    await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(0)
    await content.click({ position: { x: 6, y: 14 }, modifiers: ['Meta'] })
    await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(1)
  })
})

test.describe('页面图标与封面', () => {
  test('添加、移除页面图标', async ({ page }) => {
    await loadDoc(page, '正文\n')
    await page.locator('.tz-page-actions button', { hasText: '添加图标' }).click()
    await page.locator('.tz-prompt-input').fill('📘')
    await page.locator('.tz-prompt-input').press('Enter')
    await expect.poll(() => markdown(page)).toBe('---\nicon: 📘\n---\n\n正文\n')
    await expect(page.locator('.tz-page-icon')).toHaveText('📘')
    await page.locator('.tz-page-icon').click()
    await page.locator('.tz-prompt-input').fill('')
    await page.locator('.tz-prompt-input').press('Enter')
    await expect.poll(() => markdown(page)).not.toContain('icon:')
  })

  test('添加封面:选图片拷进资源目录;移除封面', async ({ page }) => {
    await loadDoc(page, '正文\n')
    await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/assets/form.svg']))
    await page.locator('.tz-page-actions button', { hasText: '添加封面' }).click()
    await expect.poll(() => markdown(page)).toMatch(/^---\ncover: assets\/form-1\.svg\n---\n/)
    await expect(page.locator('.tz-cover')).toBeVisible()
    await page.locator('.tz-cover-btn').click()
    await expect.poll(() => markdown(page)).not.toContain('cover:')
  })

  test('添加封面时取消选图:用渐变色封面', async ({ page }) => {
    await loadDoc(page, '正文\n')
    await page.locator('.tz-page-actions button', { hasText: '添加封面' }).click()
    await expect.poll(() => markdown(page)).toContain('cover: linear-gradient(')
  })
})
