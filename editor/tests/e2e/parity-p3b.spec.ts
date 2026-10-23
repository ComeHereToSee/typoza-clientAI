import { expect, test, type Page } from '@playwright/test'
import { loadDoc, markdown, openApp } from './helpers'
import { hostCalls, runMenuCommand } from './media-helpers'

// 对照表(docs/prd/typora-parity.md)偏好「编辑器」「Markdown」「导出」「外观」「通用」页里此前缺用例的项:
// PE-02 ~ PE-09、PM-06 / PM-07 / PM-12 / PM-15 / PM-16 / PM-20、PX-09、PA-02、PA-04、PG-06。
// 开关都在偏好设置面板里改(与 preferences.spec.ts 同一做法),证明界面上的选项接到了行为上。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

async function openPreferences(page: Page, tab: string): Promise<void> {
  await runMenuCommand(page, 'app.preferences')
  await page.locator(`.tz-settings-tab[data-page="${tab}"]`).click()
  await expect(page.locator(`.tz-settings-tab[data-page="${tab}"]`)).toHaveClass(/is-active/)
}

async function closeModal(page: Page): Promise<void> {
  await page.locator('.tz-modal').last().locator('.tz-modal-close').click()
  await expect(page.locator('.tz-modal')).toHaveCount(0)
}

const savedSetting = (page: Page, key: string) => page.evaluate((k) => window.typozaTest!.host.settings[k], key)

const docText = (page: Page) => page.evaluate(() => window.typozaTest!.app.view.state.doc.textContent)

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

/** 往编辑器派发拷贝 / 剪切事件,返回写进事件剪贴板的内容(media-helpers 的 clipboardEvent 不含剪切)。 */
async function clipboardOn(page: Page, type: 'copy' | 'cut'): Promise<{ html: string; text: string }> {
  return page.evaluate((t) => {
    const data = new DataTransfer()
    const editor = document.querySelector('.tz-editor')
    if (!editor) throw new Error('找不到编辑器')
    editor.dispatchEvent(new ClipboardEvent(t, { clipboardData: data, bubbles: true, cancelable: true }))
    return { html: data.getData('text/html'), text: data.getData('text/plain') }
  }, type)
}

test.describe('偏好「编辑器」页', () => {
  test('PE-02 匹配括号和引号:敲 ( 补出 ),敲 ) 越过,成对符号之间退格一起删;关掉后不补', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('(')
    await expect.poll(() => docText(page)).toBe('()')
    // 光标停在一对括号中间
    await page.keyboard.type('甲')
    await expect.poll(() => docText(page)).toBe('(甲)')
    // 后面正好是补出来的 ):越过它,不再多出一个
    await page.keyboard.type(')')
    await page.keyboard.type('乙')
    await expect.poll(() => docText(page)).toBe('(甲)乙')
    await page.keyboard.type('《')
    await expect.poll(() => docText(page)).toBe('(甲)乙《》')
    await page.keyboard.press('Backspace')
    await expect.poll(() => docText(page)).toBe('(甲)乙')

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=autoPair]').uncheck()
    await expect.poll(() => savedSetting(page, 'autoPair')).toBe(false)
    await closeModal(page)
    await loadDoc(page, '')
    await page.keyboard.type('(甲')
    await expect.poll(() => docText(page)).toBe('(甲')
  })

  test('PE-03 匹配 Markdown 字符:默认关;打开后敲 * _ ~ 补出另一半,收尾时照常转成格式,反引号不补', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('*')
    await expect.poll(() => docText(page)).toBe('*')

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=autoPairMarkdown]').check()
    await expect.poll(() => savedSetting(page, 'autoPairMarkdown')).toBe(true)
    await closeModal(page)

    await loadDoc(page, '')
    await page.keyboard.type('_')
    await expect.poll(() => docText(page)).toBe('__')
    await page.keyboard.type('甲')
    await expect.poll(() => docText(page)).toBe('_甲_')
    // 敲收尾的 _:先去掉补出来的那一半,再由输入规则转成斜体(plugins/editing-prefs.ts markdownPairsPlugin)
    await page.keyboard.type('_')
    await expect(page.locator('.tz-editor em')).toHaveText('甲')
    expect((await markdown(page)).trim()).toBe('*甲*')

    await page.keyboard.type(' ~')
    await expect.poll(() => docText(page)).toBe('甲 ~~')
    await page.keyboard.type('乙~')
    await expect(page.locator('.tz-editor s')).toHaveText('乙')
    await expect.poll(() => docText(page)).toBe('甲 乙')

    // 反引号不配对:与 ``` 回车建代码块冲突
    await loadDoc(page, '')
    await page.keyboard.type('`')
    await expect.poll(() => docText(page)).toBe('`')
  })

  test('PE-04 编辑时显示 Markdown 标记:默认不显示;打开后光标进标题显示 #、进加粗显示 **,移开后隐藏', async ({ page }) => {
    const source = '# 标题\n\n正文 **粗体** 后\n'
    const markers = page.locator('.tz-editor .tz-md-marker')
    await loadDoc(page, source)
    await page.locator('.tz-editor h1').click()
    await expect(markers).toHaveCount(0)

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=showMarkdownMarkers]').check()
    await expect.poll(() => savedSetting(page, 'showMarkdownMarkers')).toBe(true)
    await closeModal(page)

    await page.locator('.tz-editor h1').click()
    await expect(markers).toHaveCount(1)
    await expect(page.locator('.tz-editor h1 .tz-md-marker')).toHaveText(/^#\s*$/)
    await page.locator('.tz-editor strong').click()
    await expect(markers).toHaveText(['**', '**'])
    // 光标移到行尾(加粗之外):标记收起
    await page.keyboard.press('End')
    await expect(markers).toHaveCount(0)
    // 标记只是显示,不进文件
    expect(await markdown(page)).toBe(source)
  })

  test('PE-05 复制纯文本时复制 Markdown 源码:默认带标记;关掉后纯文本只有文字,富文本不变', async ({ page }) => {
    await loadDoc(page, '**粗体**文字')
    await page.keyboard.press('Shift+Home')
    // 复制取的是编辑器自己的选区:等它跟上 ⇧Home(CI 上偶尔慢一拍)
    await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.empty)).toBe(false)
    expect((await clipboardOn(page, 'copy')).text).toBe('**粗体**文字')

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=copyPlainAsMarkdown]').uncheck()
    await expect.poll(() => savedSetting(page, 'copyPlainAsMarkdown')).toBe(false)
    await closeModal(page)

    await loadDoc(page, '**粗体**文字')
    await page.keyboard.press('Shift+Home')
    // 复制取的是编辑器自己的选区:等它跟上 ⇧Home(CI 上偶尔慢一拍,复制时还是空选区)
    await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.empty)).toBe(false)
    const written = await clipboardOn(page, 'copy')
    expect(written.text).toBe('粗体文字')
    expect(written.html).toContain('<strong>粗体</strong>')
    // 外壳随后用同样的内容重写系统剪贴板(带 RTF)
    await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('粗体文字')
  })

  test('PE-06 无选区时复制或剪切整行:默认不复制;打开后复制光标所在整段,剪切去掉整段', async ({ page }) => {
    const source = '第一行\n\n第二行\n\n第三行\n'
    const second = page.locator('.tz-editor > p').nth(1)
    await loadDoc(page, source)
    await second.click()
    expect(await clipboardOn(page, 'copy')).toEqual({ html: '', text: '' })

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=copyLineWithoutSelection]').check()
    await expect.poll(() => savedSetting(page, 'copyLineWithoutSelection')).toBe(true)
    await closeModal(page)

    await second.click()
    // 无选区时复制的是编辑器选区所在的那段:等它跟上这次点击
    await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.$from.parent.textContent)).toBe('第二行')
    const copied = await clipboardOn(page, 'copy')
    expect(copied.text).toBe('第二行')
    expect(copied.html).toContain('第二行')
    expect(copied.html).not.toContain('第一行')
    expect(await markdown(page)).toBe(source)

    const cut = await clipboardOn(page, 'cut')
    expect(cut.text).toBe('第二行')
    await expect.poll(() => markdown(page)).toBe('第一行\n\n第三行\n')
  })

  test('PE-07 默认换行符选 CRLF:新建的文档按 \\r\\n 写盘;已有的 LF 文件保持 LF', async ({ page }) => {
    await openPreferences(page, '编辑器')
    await page.locator('select[data-key=defaultLineEnding]').selectOption('crlf')
    await expect.poll(() => savedSetting(page, 'defaultLineEnding')).toBe('crlf')
    await closeModal(page)

    // 浏览器里没有新窗口;把当前文档移到废纸篓后,本标签换成空白新文档(app.ts onPathTrashed),与新窗口同走 createEmpty
    await runMenuCommand(page, 'view.fileTree')
    await page.locator('.tz-tree-item[data-path="/demo/欢迎使用 Typoza.md"]').click({ button: 'right' })
    await page.locator('.tz-context-menu .tz-menu-item[data-id="trash"]').click()
    await expect.poll(() => page.evaluate(() => window.typozaTest!.app.session.path)).toBeNull()
    await page.locator('.tz-editor').click()
    await page.keyboard.type('第一行')
    await page.keyboard.press('Enter')
    await page.keyboard.type('第二行')
    // 未命名文档保存走另存为;内存宿主的保存框返回 /Users/test/默认文件名
    await runMenuCommand(page, 'file.save')
    await expect.poll(() => fileText(page, '/Users/test/未命名.md')).toBe('第一行\r\n\r\n第二行\r\n')

    await loadDoc(page, '甲\n', '/demo/旧文件.md')
    await page.keyboard.type('乙')
    await expect.poll(() => fileText(page, '/demo/旧文件.md'), { timeout: 5000 }).toBe('甲乙\n')
  })

  test('PE-08 拼写检查语言:选语言后交给系统词典并打开拼写检查;选「不使用」关闭', async ({ page }) => {
    const editor = page.locator('.tz-editor')
    await loadDoc(page, 'colour\n')
    await expect(editor).toHaveAttribute('spellcheck', 'false')

    await openPreferences(page, '编辑器')
    const select = page.locator('select[data-key=spellcheckLanguage]')
    await expect(select).toHaveValue('off')
    await select.selectOption('en_GB')
    await expect.poll(() => hostCalls(page, 'setSpellingLanguage')).toEqual([['en_GB']])
    await expect.poll(() => savedSetting(page, 'spellcheck')).toBe(true)
    expect(await savedSetting(page, 'spellcheckLanguage')).toBe('en_GB')
    await expect(editor).toHaveAttribute('spellcheck', 'true')

    await select.selectOption('auto')
    await expect.poll(() => hostCalls(page, 'setSpellingLanguage')).toEqual([['en_GB'], ['auto']])

    await select.selectOption('off')
    await expect.poll(() => savedSetting(page, 'spellcheck')).toBe(false)
    await expect(editor).toHaveAttribute('spellcheck', 'false')
    expect(await hostCalls(page, 'setSpellingLanguage')).toHaveLength(2)
  })

  test('PE-09 打字机模式始终居中:默认鼠标点选也滚到屏幕中间;关掉后点选不滚动,输入时才居中', async ({ page }) => {
    // 光标所在行顶部离可视区 45% 处有多远(居中位置见 plugins/basics.ts viewModesPlugin)
    const caretOffset = () =>
      page.evaluate(() => {
        const view = window.typozaTest!.app.view
        const caret = view.coordsAtPos(view.state.selection.head)
        const box = document.querySelector('.tz-scroll')!.getBoundingClientRect()
        return Math.abs(caret.top - (box.top + box.height * 0.45))
      })
    const scrollTop = () => page.evaluate(() => document.querySelector('.tz-scroll')!.scrollTop)
    // 滚回顶部,点一段靠近可视区底部、且不是光标所在的段落(选区要真的变),等选区落进去
    const clickLowParagraph = async () => {
      await page.evaluate(() => {
        document.querySelector('.tz-scroll')!.scrollTop = 0
      })
      const index = await page.evaluate(() => {
        const current = window.typozaTest!.app.view.state.selection.$head.parent.textContent
        const box = document.querySelector('.tz-scroll')!.getBoundingClientRect()
        return Array.from(document.querySelectorAll('.tz-editor > p')).findIndex((p) => {
          const r = p.getBoundingClientRect()
          return r.top > box.top + box.height * 0.7 && r.bottom < box.bottom - 4 && p.textContent !== current
        })
      })
      expect(index).toBeGreaterThan(0)
      const para = page.locator('.tz-editor > p').nth(index)
      const text = (await para.textContent()) ?? ''
      await para.click()
      await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.selection.$head.parent.textContent)).toBe(text)
    }

    await loadDoc(page, `${Array.from({ length: 80 }, (_, i) => `第 ${i + 1} 段`).join('\n\n')}\n`)
    await runMenuCommand(page, 'view.typewriterMode')
    await expect(page.locator('.tz-editor')).toHaveClass(/tz-typewriter-mode/)
    await clickLowParagraph()
    await expect.poll(caretOffset).toBeLessThan(6)

    await openPreferences(page, '编辑器')
    await page.locator('input[data-key=typewriterAlways]').uncheck()
    await expect.poll(() => savedSetting(page, 'typewriterAlways')).toBe(false)
    await closeModal(page)
    await expect(page.locator('.tz-editor')).toHaveClass(/tz-typewriter-mode/)
    await clickLowParagraph()
    expect(await scrollTop()).toBe(0)
    await page.keyboard.type('续')
    await expect.poll(caretOffset).toBeLessThan(6)
    expect(await scrollTop()).toBeGreaterThan(0)
  })
})

test.describe('偏好「Markdown」页', () => {
  test('PM-06 内联公式 $…$:默认渲染为公式;关掉后按普通文字显示,文件不变', async ({ page }) => {
    const source = '单价 $5$ 与 $y$\n'
    const inline = page.locator('.tz-editor .tz-math-inline')
    await loadDoc(page, source)
    await expect(inline).toHaveCount(2)

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=inlineMath]').uncheck()
    await expect(inline).toHaveCount(0)
    await expect(page.locator('.tz-editor p').first()).toHaveText('单价 $5$ 与 $y$')
    expect(await markdown(page)).toBe(source)
  })

  test('PM-07 代码块公式 ```math:默认显示为公式;关掉后按普通代码块显示,源码不变', async ({ page }) => {
    const source = '```math\nE=mc^2\n```\n\n结尾\n'
    const block = page.locator('.tz-editor .tz-code-block')
    await loadDoc(page, source)
    await expect(block.locator('.tz-diagram-preview .katex').first()).toBeVisible({ timeout: 15_000 })
    await expect(block).toHaveClass(/is-diagram/)

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=mathCodeFence]').uncheck()
    // 改了要重画节点视图(prefs-apply.ts REDRAW_KEYS):新视图不再是预览块
    await expect(block).not.toHaveClass(/is-diagram/)
    await expect(block.locator('.katex')).toHaveCount(0)
    await expect(block.locator('.tz-diagram-preview')).toBeHidden()
    await expect(block).toContainText('E=mc^2')
    expect(await markdown(page)).toBe(source)
  })

  test('PM-12 图表:默认 mermaid 渲染成图;关掉后显示源码、不出图,源码不变', async ({ page }) => {
    const source = '```mermaid\ngraph TD\n  A-->B\n```\n\n结尾\n'
    const block = page.locator('.tz-editor .tz-code-block')
    await loadDoc(page, source)
    await expect(block.locator('.tz-diagram-preview svg')).toBeVisible({ timeout: 20_000 })

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=diagrams]').uncheck()
    await expect(block).not.toHaveClass(/is-diagram/)
    await expect(block.locator('.tz-diagram-preview svg')).toHaveCount(0)
    await expect(block).toContainText('graph TD')
    expect(await markdown(page)).toBe(source)
  })

  test('PM-15 代码块显示行号:默认没有行号栏;打开后代码块带行号,关掉后不带', async ({ page }) => {
    const source = '```js\nconst a = 1\nconst b = 2\nconst c = 3\n```\n\n结尾\n'
    const content = page.locator('.tz-code-block .cm-content')
    const numbers = page.locator('.tz-code-block .cm-lineNumbers')
    await loadDoc(page, source)
    // CodeMirror 等代码块进入视口附近才建(views/codeblock.ts observeLazy)
    await expect(content).toBeVisible({ timeout: 15_000 })
    await expect(numbers).toHaveCount(0)

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=codeLineNumbers]').check()
    await expect.poll(() => savedSetting(page, 'codeLineNumbers')).toBe(true)
    await closeModal(page)
    // 行号在建代码块视图时读取,已显示的代码块不跟着重建,所以重新打开文档再看
    await loadDoc(page, source)
    await expect(numbers).toBeVisible({ timeout: 15_000 })
    await expect(numbers.locator('.cm-gutterElement', { hasText: /^3$/ })).toHaveCount(1)
    expect(await markdown(page)).toBe(source)

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=codeLineNumbers]').uncheck()
    await expect.poll(() => savedSetting(page, 'codeLineNumbers')).toBe(false)
    await closeModal(page)
    await loadDoc(page, source)
    await expect(content).toBeVisible({ timeout: 15_000 })
    await expect(numbers).toHaveCount(0)
  })

  test('PM-16 代码块自动换行:默认长行折行;关掉后长行不折、出现横向滚动', async ({ page }) => {
    const source = "```js\nconst s = '" + '很长的一行代码'.repeat(60) + "'\n```\n\n结尾\n"
    const content = page.locator('.tz-code-block .cm-content')
    const overflow = () => page.locator('.tz-code-block .cm-scroller').evaluate((el) => el.scrollWidth - el.clientWidth)
    await loadDoc(page, source)
    await expect(content).toBeVisible({ timeout: 15_000 })
    await expect(content).toHaveClass(/cm-lineWrapping/)
    await expect.poll(overflow).toBeLessThanOrEqual(1)

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=codeLineWrap]').uncheck()
    await expect.poll(() => savedSetting(page, 'codeLineWrap')).toBe(false)
    await closeModal(page)
    // 与行号一样在建代码块视图时读取,重新打开文档再看
    await loadDoc(page, source)
    await expect(content).toBeVisible({ timeout: 15_000 })
    await expect(content).not.toHaveClass(/cm-lineWrapping/)
    await expect.poll(overflow).toBeGreaterThan(200)
    expect(await markdown(page)).toBe(source)
  })

  test('PM-20 公式内 \\\\ 换行:默认换行;关掉后不换行,公式照常渲染', async ({ page }) => {
    const source = '$$\na \\\\ b\n$$\n\n结尾\n'
    const preview = page.locator('.tz-editor .tz-math-preview').first()
    // 只在渲染出 KaTeX 后才比较换行数:重画后的新预览先是空的
    const state = () =>
      preview.evaluate((el) => ({
        rendered: el.querySelector('.katex') !== null,
        error: el.classList.contains('is-error'),
        breaks: el.querySelectorAll('.katex-newline').length,
      }))
    await loadDoc(page, source)
    await expect.poll(state, { timeout: 15_000 }).toEqual({ rendered: true, error: false, breaks: 1 })

    await openPreferences(page, 'Markdown')
    await page.locator('input[data-key=mathLineBreak]').uncheck()
    await expect.poll(state, { timeout: 15_000 }).toEqual({ rendered: true, error: false, breaks: 0 })
    expect(await markdown(page)).toBe(source)
  })
})

test.describe('偏好「导出」页', () => {
  test('PX-09 导出项管理:从模板添加、重命名、上移 / 下移、删除前确认「删除该导出选项 ?」', async ({ page }) => {
    const items = page.locator('.tz-export-item')
    const saved = () =>
      page.evaluate(() =>
        ((window.typozaTest!.host.settings.exportItems as { id: string; name: string }[] | undefined) ?? []).map((i) => ({ id: i.id, name: i.name })),
      )
    const ids = async () => (await saved()).map((i) => i.id)
    const names = async () => (await saved()).map((i) => i.name)
    const button = (index: number, label: string) => items.nth(index).getByRole('button', { name: label, exact: true })

    await openPreferences(page, '导出')
    const add = page.locator('select[data-key=exportTemplate]')
    await add.selectOption('markdown')
    await expect(items).toHaveCount(1)
    await add.selectOption('command')
    await expect(items).toHaveCount(2)
    const [a, b] = await ids()
    expect(a).not.toBe(b)
    await expect.poll(names).toEqual(['Markdown(GFM)', '自定义命令'])

    // 重命名:名称框是每项第一个文本框,改完(change)即保存,项头跟着变
    const name = items.nth(1).locator('input[type=text]').first()
    await name.fill('发布到博客')
    await name.dispatchEvent('change')
    await expect(items.nth(1).locator('.tz-export-item-head strong')).toHaveText('发布到博客')
    await expect.poll(names).toEqual(['Markdown(GFM)', '发布到博客'])

    // 第一项不能再上移,最后一项不能再下移
    await expect(button(0, '上移')).toBeDisabled()
    await expect(button(1, '下移')).toBeDisabled()
    await button(1, '上移').click()
    await expect.poll(ids).toEqual([b, a])
    await button(0, '下移').click()
    await expect.poll(ids).toEqual([a, b])

    // 删除前确认:第一次选「取消」(第 2 个按钮)不删;确认队列取空时宿主返回 0,即「删除」
    const confirms = async () => (await hostCalls(page, 'confirm')).map((c) => c[0] as { title: string; message: string; buttons: string[] })
    await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(1))
    await button(0, '删除').click()
    await expect.poll(async () => (await confirms()).length).toBe(1)
    expect((await confirms())[0]).toMatchObject({ title: '删除该导出选项 ?', message: 'Markdown(GFM)', buttons: ['删除', '取消'] })
    await expect(items).toHaveCount(2)
    await button(0, '删除').click()
    await expect(items).toHaveCount(1)
    await expect.poll(saved).toEqual([{ id: b, name: '发布到博客' }])
    // 文件 ▸ 导出 菜单末尾的导出项跟着同步
    await expect.poll(async () => (await hostCalls(page, 'setExportItems')).at(-1)).toEqual([[{ id: b, name: '发布到博客' }]])
  })
})

test.describe('偏好「外观」页', () => {
  test('PA-02 字体大小:自定义 20 像素后正文变 20px;切回「使用主题的字体大小」还原', async ({ page }) => {
    const fontSize = () => page.locator('.tz-editor').evaluate((el) => getComputedStyle(el).fontSize)
    const rootVar = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tz-font-size'))
    await loadDoc(page, '正文\n')
    const themeSize = await fontSize()
    expect(themeSize).not.toBe('20px')

    await openPreferences(page, '外观')
    await page.locator('select[data-key=fontSizeMode]').selectOption('custom')
    const size = page.locator('input[data-key=fontSize]')
    await expect(size).toHaveValue('16')
    await size.fill('20')
    await size.dispatchEvent('change')
    await expect.poll(() => savedSetting(page, 'fontSize')).toBe(20)
    await expect.poll(rootVar).toBe('20px')
    await expect.poll(fontSize).toBe('20px')

    // 跟随主题时不写行内变量,主题自己的字号生效
    await page.locator('select[data-key=fontSizeMode]').selectOption('theme')
    await expect(size).toHaveCount(0)
    await expect.poll(rootVar).toBe('')
    await expect.poll(fontSize).toBe(themeSize)
  })

  test('PA-04 总是显示字数统计:默认常驻;关掉后状态栏字数隐藏,鼠标移到状态栏才显示', async ({ page }) => {
    const bar = page.locator('.tz-statusbar')
    const words = page.locator('.tz-statusbar .tz-status-words')
    await loadDoc(page, '五个字的话\n')
    await expect(words).toContainText('字')
    await expect(bar).not.toHaveClass(/is-words-hover/)
    await expect(words).toHaveCSS('opacity', '1')

    await openPreferences(page, '外观')
    await page.locator('input[data-key=alwaysShowWordCount]').uncheck()
    await expect.poll(() => savedSetting(page, 'alwaysShowWordCount')).toBe(false)
    await closeModal(page)
    await expect(bar).toHaveClass(/is-words-hover/)
    await page.locator('.tz-editor p').first().hover()
    await expect(words).toHaveCSS('opacity', '0')
    await bar.hover()
    await expect(words).toHaveCSS('opacity', '1')
    await page.locator('.tz-editor p').first().hover()
    await expect(words).toHaveCSS('opacity', '0')
  })
})

test.describe('偏好「通用」页', () => {
  test('PG-06 重置全部警告提示对话框:确认过的「上传图片」提示不再出现,重置后再次出现', async ({ page }) => {
    const uploadAsks = async () => (await hostCalls(page, 'confirm')).filter((c) => (c[0] as { title: string }).title === '上传图片').length
    await page.evaluate(() => window.typozaTest!.app.updateSettings({ imageUploadCommand: 'picgo upload' }))

    // 第一次上传先确认(确认队列取空时宿主返回 0,即「继续上传」),之后记进 dismissedWarnings
    await loadDoc(page, '![甲](assets/id.svg)\n')
    await runMenuCommand(page, 'image.uploadAll')
    await expect.poll(() => markdown(page)).toContain('https://img.example.com/demo/assets/id.svg')
    expect(await uploadAsks()).toBe(1)
    await expect.poll(() => savedSetting(page, 'dismissedWarnings')).toEqual(['imageUpload'])

    await loadDoc(page, '![乙](assets/name.svg)\n')
    await runMenuCommand(page, 'image.uploadAll')
    await expect.poll(() => markdown(page)).toContain('https://img.example.com/demo/assets/name.svg')
    expect(await uploadAsks()).toBe(1)

    await openPreferences(page, '通用')
    await page.getByRole('button', { name: '重置全部警告提示对话框' }).click()
    await expect(page.locator('.tz-toast')).toHaveText('警告提示对话框已被重置')
    await expect.poll(() => savedSetting(page, 'dismissedWarnings')).toEqual([])
    await closeModal(page)

    await loadDoc(page, '![丙](assets/id.svg)\n')
    await runMenuCommand(page, 'image.uploadAll')
    await expect.poll(uploadAsks).toBe(2)
    await expect.poll(() => markdown(page)).toContain('https://img.example.com/demo/assets/id.svg')
  })
})
