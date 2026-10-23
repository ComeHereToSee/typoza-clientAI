import { expect, test, type Page } from '@playwright/test'
import { loadDoc, markdown, openApp } from './helpers'
import { contextMenuAt, hostCalls, putFile, runMenuCommand } from './media-helpers'

// Typora 对照表(docs/prd/typora-parity.md)C、S、PF 区里缺用例为证的行:编辑区右键菜单、表格工具条「更多」、侧栏文件操作、文件偏好。
// S-01 / PF-02 的「大纲无折叠」在 tests/unit/parity-p3a.test.ts:侧栏只在创建时读一次这个偏好,
// 内存宿主刷新页面后设置不保留,E2E 进不到「关着启动」的状态。

const menuItem = (id: string) => `.tz-context-menu [data-id="${id}"]`
const treeRow = (path: string) => `.tz-tree-item[data-path="${path}"]`

const currentPath = (page: Page) => page.evaluate(() => window.typozaTest!.app.session.path)

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

const confirmTitles = (page: Page) =>
  page.evaluate(() => window.typozaTest!.host.calls.filter((c) => c.method === 'confirm').map((c) => (c.args[0] as { title: string }).title))

const savedSetting = (page: Page, key: string) => page.evaluate((k) => window.typozaTest!.host.settings[k], key)

const sidebarRoot = (page: Page) => page.evaluate(() => window.typozaTest!.app['sidebar'].rootFolder)

/** 复制为纯文本 / Markdown / HTML、复制公式直接写 navigator.clipboard:换成记录,免得受系统剪贴板权限影响 */
async function recordClipboard(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const copied: string[] = []
    ;(window as unknown as { __copied: string[] }).__copied = copied
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void copied.push(text) },
    })
  })
  return () => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
}

/** 示例目录里再放一个子文件夹和一篇文档(文件树要有文件夹条目才列得出来,所以两项都写) */
async function seedFolder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const files = window.typozaTest!.host.files
    files.set('/demo/资料', { kind: 'dir', mtime: Date.now() })
    files.set('/demo/资料/深处.md', { kind: 'file', data: '# 深处\n', mtime: Date.now() })
  })
}

async function closeModal(page: Page): Promise<void> {
  await page.locator('.tz-modal').last().locator('.tz-modal-close').click()
  await expect(page.locator('.tz-modal')).toHaveCount(0)
}

// ---------- 编辑区右键菜单(C 区) ----------

test.describe('编辑区右键菜单', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  /** 在正文段落上右键 ▸ 插入 ▸ 某项。只派发右键事件:光标落到点击处,不经过右键按下(WebKit 右键按下可能选中词) */
  const insertVia = async (page: Page, id: string) => {
    await contextMenuAt(page, '.tz-editor > p', { x: 8, y: 10 })
    await page.locator(menuItem('ctx.insert')).hover()
    await page.locator(menuItem(`ctx.${id}`)).click()
  }

  test('C-01 右键 ▸ 插入 ▸ 段落(上方)/ 段落(下方):新段落在当前块上 / 下,光标进新段落', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await insertVia(page, 'block.paragraphBefore')
    await page.keyboard.type('上方')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('上方\n\n文字')

    await loadDoc(page, '文字\n')
    await insertVia(page, 'block.paragraphAfter')
    await page.keyboard.type('下方')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('文字\n\n下方')
  })

  test('C-01 右键 ▸ 插入 ▸ 图片:输入地址后插入', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await insertVia(page, 'insert.image')
    const input = page.locator('.tz-prompt-input')
    await input.fill('assets/id.svg')
    await input.press('Enter')
    await expect(page.locator('.tz-editor .tz-image')).toHaveCount(1)
    await expect.poll(() => markdown(page)).toContain('![](assets/id.svg)')
  })

  test('C-01 右键 ▸ 插入 ▸ 表格:弹窗点选 3 列 × 2 行', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await insertVia(page, 'insert.table')
    const dialog = page.locator('.tz-table-size')
    await expect(dialog).toBeVisible()
    // 网格按下即选定(行数含表头行)
    await dialog.locator('.tz-table-size-cell[data-row="2"][data-col="3"]').click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.tz-editor tr')).toHaveCount(2)
    await expect(page.locator('.tz-editor th')).toHaveCount(3)
  })

  // 当前段落有字时插在它后面:[命令, 条目名, 插入后出现的元素, Markdown 里应有的写法]
  const blocks: [string, string, string, string][] = [
    ['insert.codeBlock', '代码块', '.tz-code-block', '文字\n\n```\n```'],
    ['insert.mathBlock', '公式块', '.tz-math-block', '文字\n\n$$\n$$'],
    ['insert.callout', '标注块', '.tz-callout', '文字\n\n> [!NOTE]'],
    ['insert.toggle', '折叠块', '.tz-toggle', '文字\n\n<details>'],
    ['insert.toc', '目录', '.tz-toc', '文字\n\n[TOC]'],
    ['insert.linkReference', '链接引用', '.tz-definition', '文字\n\n[ref]: https://'],
  ]
  for (const [id, label, selector, expected] of blocks) {
    test(`C-01 右键 ▸ 插入 ▸ ${label}:插在当前段落之后`, async ({ page }) => {
      await loadDoc(page, '文字\n')
      await insertVia(page, id)
      await expect(page.locator(`.tz-editor ${selector}`)).toHaveCount(1)
      await expect.poll(() => markdown(page)).toContain(expected)
    })
  }

  test('C-01 右键 ▸ 插入 ▸ HTML 内容 / 脚注 / YAML Front Matter', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await insertVia(page, 'insert.htmlBlock')
    await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(1)
    await page.keyboard.type('<kbd>K</kbd>')
    await expect.poll(() => markdown(page)).toContain('<kbd>K</kbd>')

    // 脚注:光标处插脚注号,文末插定义
    await loadDoc(page, '文字\n')
    await insertVia(page, 'insert.footnote')
    await expect(page.locator('.tz-editor .tz-footnote-ref')).toHaveCount(1)
    const out = await markdown(page)
    expect(out).toContain('[^1]')
    expect(out).toContain('\n[^1]:')

    // YAML 插在文首,光标进块里
    await loadDoc(page, '文字\n')
    await insertVia(page, 'insert.frontMatter')
    await expect(page.locator('.tz-editor .tz-frontmatter')).toHaveCount(1)
    await page.keyboard.type('title: 测试')
    await expect.poll(() => markdown(page)).toMatch(/^---\ntitle: 测试\n---\n/)
  })

  test('C-04 右键 ▸ 复制 / 粘贴为:复制为纯文本、复制为 Markdown、复制为 HTML 代码;粘贴并匹配样式', async ({ page }) => {
    const copied = await recordClipboard(page)
    await loadDoc(page, '**粗体**文字')
    await page.keyboard.press('Shift+Home')
    // 右键点在选区里:选区保持不变
    const copyAs = async (id: string) => {
      await contextMenuAt(page, '.tz-editor p', { x: 8, y: 14 })
      await page.locator(menuItem('ctx.copyPasteAs')).hover()
      await page.locator(menuItem(`ctx.${id}`)).click()
    }
    await copyAs('edit.copyPlain')
    await expect.poll(copied).toEqual(['粗体文字'])
    await copyAs('edit.copyMarkdown')
    await expect.poll(copied).toEqual(['粗体文字', '**粗体**文字'])
    await copyAs('edit.copyHtml')
    await expect.poll(async () => (await copied()).length).toBe(3)
    const html = (await copied())[2]
    expect(html).toContain('<strong>粗体</strong>文字')
    expect(html).not.toContain('**')

    // 粘贴并匹配样式:按字面粘贴,不解析 Markdown
    await loadDoc(page, '')
    await page.evaluate(() => {
      window.typozaTest!.host.clipboard.text = '**不加粗**'
    })
    await page.locator('.tz-editor p').first().click({ button: 'right' })
    await page.locator(menuItem('ctx.copyPasteAs')).hover()
    await page.locator(menuItem('ctx.edit.pasteMatchStyle')).click()
    await expect.poll(() => markdown(page)).toBe('\\*\\*不加粗\\*\\*\n')
  })

  test('C-05 / C-08 右键公式块:复制为图片截取公式渲染区域;删除公式', async ({ page }) => {
    await loadDoc(page, '$$\nE=mc^2\n$$\n\n段落\n')
    const preview = '.tz-editor .tz-math-preview'
    await expect(page.locator(`${preview} .katex`).first()).toBeVisible({ timeout: 15_000 })
    await contextMenuAt(page, preview, { x: 10, y: 10 })
    await page.locator(menuItem('ctx.copyAsImage')).click()
    await expect.poll(async () => (await hostCalls(page, 'copyRegionAsImage')).length).toBe(1)
    const [[rect]] = (await hostCalls(page, 'copyRegionAsImage')) as [[{ width: number; height: number }]]
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)

    await contextMenuAt(page, preview, { x: 10, y: 10 })
    await page.locator(menuItem('ctx.math.delete')).click()
    await expect.poll(() => markdown(page)).toBe('段落\n')
  })

  test('C-05 / C-08 右键图表(mermaid):复制为图片截取图表区域;删除图表', async ({ page }) => {
    await loadDoc(page, '```mermaid\ngraph TD\n  A-->B\n```\n\n段落\n')
    const preview = '.tz-editor .tz-diagram-preview'
    await expect(page.locator(`${preview} svg`)).toBeVisible({ timeout: 20_000 })
    await contextMenuAt(page, preview, { x: 10, y: 10 })
    await page.locator(menuItem('ctx.copyAsImage')).click()
    await expect.poll(async () => (await hostCalls(page, 'copyRegionAsImage')).length).toBe(1)
    const [[rect]] = (await hostCalls(page, 'copyRegionAsImage')) as [[{ width: number; height: number }]]
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)

    await contextMenuAt(page, preview, { x: 10, y: 10 })
    await expect(page.locator(menuItem('ctx.diagram.delete'))).toHaveText('删除图表')
    await page.locator(menuItem('ctx.diagram.delete')).click()
    await expect.poll(() => markdown(page)).toBe('段落\n')
  })

  test('C-07 右键公式 ▸ 复制公式:复制为 TeX 代码、复制为 MathML', async ({ page }) => {
    const copied = await recordClipboard(page)
    await loadDoc(page, '$$\nE=mc^2\n$$\n\n段落\n')
    const preview = '.tz-editor .tz-math-preview'
    await expect(page.locator(`${preview} .katex`).first()).toBeVisible({ timeout: 15_000 })
    const copyMath = async (id: string) => {
      await contextMenuAt(page, preview, { x: 10, y: 10 })
      await page.locator(menuItem('ctx.math.copy')).hover()
      await page.locator(menuItem(`ctx.${id}`)).click()
    }
    await copyMath('math.copyTex')
    await expect.poll(copied).toEqual(['E=mc^2'])
    await expect(page.locator('.tz-toast')).toHaveText('已复制 Tex 代码')

    // MathML 由 KaTeX 异步生成
    await copyMath('math.copyMathML')
    await expect.poll(async () => (await copied()).length).toBe(2)
    const mathml = (await copied())[1]
    expect(mathml).toMatch(/^<math[\s\S]*<\/math>$/)
    expect(mathml).toContain('<mi>E</mi>')
    await expect(page.locator('.tz-toast')).toHaveText('已复制 MathML')
  })

  test('C-11 右键视频 ▸ 播放 / 暂停:条目随播放状态切换,不改文档', async ({ page }) => {
    await putFile(page, '/demo/assets/clip.mp4', 'fake')
    await page.evaluate(() => {
      // 内存里的假视频不能真播放:记录 play / pause 调用(同 media.spec.ts 空格播放用例)
      const log: string[] = []
      ;(window as unknown as { __media: string[] }).__media = log
      const playing = new WeakSet<HTMLMediaElement>()
      Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
        configurable: true,
        get(this: HTMLMediaElement) {
          return !playing.has(this)
        },
      })
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        playing.add(this)
        log.push('play')
        return Promise.resolve()
      }
      HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
        playing.delete(this)
        log.push('pause')
      }
    })
    const source = '<video src="assets/clip.mp4" controls></video>\n'
    await loadDoc(page, source)
    const media = () => page.evaluate(() => (window as unknown as { __media: string[] }).__media)
    const item = page.locator(menuItem('ctx.media.play'))

    await contextMenuAt(page, '.tz-editor .tz-media video', { x: 40, y: 40 })
    await expect(item.locator('.tz-menu-label')).toHaveText('播放')
    await item.click()
    await expect.poll(media).toEqual(['play'])

    await contextMenuAt(page, '.tz-editor .tz-media video', { x: 40, y: 40 })
    await expect(item.locator('.tz-menu-label')).toHaveText('暂停')
    await item.click()
    await expect.poll(media).toEqual(['play', 'pause'])
    expect(await markdown(page)).toBe(source)
  })

  test('C-14 右键 ▸ 跳转到 ▸ 所选内容:滚回选区末端,选区不变', async ({ page }) => {
    const md = `${Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段`).join('\n\n')}\n`
    await loadDoc(page, md)
    // 从第一段开头选到文末。右键点在选区外会先把光标移到点击处,所以右键点在选区里的第一段
    const range = await page.evaluate(() => {
      const view = window.typozaTest!.app.view
      const Sel = view.state.selection.constructor as unknown as {
        create(doc: typeof view.state.doc, anchor: number, head: number): typeof view.state.selection
      }
      view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, 1, view.state.doc.content.size - 1)))
      return { from: view.state.selection.from, to: view.state.selection.to }
    })
    const headInView = () =>
      page.evaluate(() => {
        const view = window.typozaTest!.app.view
        const caret = view.coordsAtPos(view.state.selection.head)
        const box = document.querySelector('.tz-scroll')!.getBoundingClientRect()
        return caret.top >= box.top && caret.bottom <= box.bottom
      })
    await page.evaluate(() => {
      document.querySelector('.tz-scroll')!.scrollTop = 0
    })
    await expect.poll(headInView).toBe(false)

    await contextMenuAt(page, '.tz-editor > p', { x: 8, y: 10 })
    await page.locator(menuItem('ctx.jump')).hover()
    await page.locator(menuItem('ctx.jump.selection')).click()
    await expect.poll(headInView).toBe(true)
    expect(await page.evaluate(() => ({ from: window.typozaTest!.app.view.state.selection.from, to: window.typozaTest!.app.view.state.selection.to }))).toEqual(range)
    expect(await markdown(page)).toBe(md)
  })
})

// ---------- 表格工具条「更多」(C-15) ----------

test.describe('C-15 表格工具条「更多」', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  const table = '| a | b |\n| - | - |\n| 1 | 2 |\n'
  /** 各行各格的文字(表头为第一行) */
  const cells = (page: Page) =>
    page.evaluate(() => Array.from(document.querySelectorAll('.tz-editor tr')).map((tr) => Array.from(tr.querySelectorAll('th, td')).map((c) => c.textContent ?? '')))
  /** 光标放进「1」那格,点工具条「更多」里的一项 */
  const more = async (page: Page, id: string) => {
    await page.locator('.tz-editor td').filter({ hasText: /^1$/ }).click()
    const toolbar = page.locator('.tz-table-toolbar')
    await expect(toolbar).toBeVisible()
    await toolbar.locator('button[title="更多"]').click()
    await page.locator(`.tz-table-more [data-id="${id}"]`).click()
  }

  test('C-15 上 / 下方插入行、左 / 右侧插入列、删除行、删除列', async ({ page }) => {
    // 光标在第 2 行第 1 列(「1」)
    const cases: [string, string[][]][] = [
      ['table.rowAbove', [['a', 'b'], ['', ''], ['1', '2']]],
      ['table.rowBelow', [['a', 'b'], ['1', '2'], ['', '']]],
      ['table.colLeft', [['', 'a', 'b'], ['', '1', '2']]],
      ['table.colRight', [['a', '', 'b'], ['1', '', '2']]],
      ['table.deleteRow', [['a', 'b']]],
      ['table.deleteCol', [['b'], ['2']]],
    ]
    for (const [id, expected] of cases) {
      await loadDoc(page, table)
      await more(page, id)
      await expect.poll(() => cells(page)).toEqual(expected)
    }
    // 删除列后整表按新结构写回
    expect((await markdown(page)).trim()).toBe('| b |\n| - |\n| 2 |')
  })

  test('C-15 复制表格:剪贴板同时有 Markdown 与 HTML', async ({ page }) => {
    await loadDoc(page, table)
    await more(page, 'table.copy')
    // 选中整表走系统拷贝,拷贝事件里外壳重写剪贴板(纯文本部分按偏好写 Markdown 源码)
    await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(await page.evaluate(() => window.typozaTest!.host.clipboard.html ?? '')).toContain('<table')
  })
})

// ---------- 侧栏(S 区) ----------

test.describe('侧栏文件操作', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
  })

  /** 侧栏里右键某一行,点菜单项 */
  const sideMenu = async (page: Page, row: string, id: string) => {
    await page.locator(row).click({ button: 'right' })
    await page.locator(menuItem(id)).click()
  }

  test('S-03 文档列表:文件超过 500 个时提示切到文件树,只列前 500 个', async ({ page }) => {
    await page.evaluate(() => {
      const files = window.typozaTest!.host.files
      files.set('/demo/批量', { kind: 'dir', mtime: Date.now() })
      for (let i = 1; i <= 501; i++) files.set(`/demo/批量/第${i}篇.md`, { kind: 'file', data: `# 第${i}篇\n`, mtime: Date.now() })
    })
    await runMenuCommand(page, 'view.docList')
    await expect(page.locator('.tz-doc-list .tz-side-notice')).toHaveText('当前文件夹内文件过多,请切换至文件树视图以获得更佳的使用体验。')
    await expect(page.locator('.tz-doc-item')).toHaveCount(500)
  })

  test('S-07 新建文件 / 新建文件夹:直接输入名称;同名时提示「目标路径已存在同名文件」', async ({ page }) => {
    await runMenuCommand(page, 'view.fileTree')
    const input = page.locator('.tz-prompt-input')

    // 不带扩展名时补 .md;新建后打开它
    await sideMenu(page, '.tz-tree-root', 'new.file')
    await expect(page.locator('.tz-prompt-title')).toHaveText('新建文件')
    await input.fill('新笔记')
    await input.press('Enter')
    await expect(page.locator(treeRow('/demo/新笔记.md'))).toBeVisible()
    expect(await fileText(page, '/demo/新笔记.md')).toBe('')
    await expect.poll(() => currentPath(page)).toBe('/demo/新笔记.md')

    await sideMenu(page, '.tz-tree-root', 'new.folder')
    await expect(page.locator('.tz-prompt-title')).toHaveText('新建文件夹')
    await input.fill('资料夹')
    await input.press('Enter')
    await expect(page.locator(treeRow('/demo/资料夹'))).toBeVisible()
    expect(await page.evaluate(() => window.typozaTest!.host.files.get('/demo/资料夹')?.kind)).toBe('dir')

    await sideMenu(page, '.tz-tree-root', 'new.file')
    await input.fill('另一篇')
    await input.press('Enter')
    await expect(page.locator('.tz-toast')).toContainText('目标路径已存在同名文件')
    expect(await fileText(page, '/demo/另一篇.md')).toBe('# 另一篇\n\n用于测试文档链接。\n')
  })

  test('S-10 移动到…:目标已有同名文件先确认,取消不动;替换后被替换的文件进废纸篓', async ({ page }) => {
    await putFile(page, '/demo/assets/另一篇.md', '旧的内容\n')
    await runMenuCommand(page, 'view.fileTree')
    await page.evaluate(() => {
      const host = window.typozaTest!.host
      // 两次都选 assets 文件夹;第一次确认选「取消」(第 2 个按钮),第二次选「替换」
      host.dialogQueue.push(['/demo/assets'], ['/demo/assets'])
      host.confirmQueue.push(1, 0)
    })

    await sideMenu(page, treeRow('/demo/另一篇.md'), 'move')
    await expect.poll(() => confirmTitles(page)).toEqual(['「另一篇.md」已存在'])
    const ask = await page.evaluate(() => window.typozaTest!.host.calls.find((c) => c.method === 'confirm')?.args[0] as { message: string; buttons: string[] })
    expect(ask.message).toBe('是否继续移动并替换原有文件?')
    expect(ask.buttons).toEqual(['替换', '取消'])
    expect(await fileText(page, '/demo/另一篇.md')).toBe('# 另一篇\n\n用于测试文档链接。\n')
    expect(await fileText(page, '/demo/assets/另一篇.md')).toBe('旧的内容\n')

    await sideMenu(page, treeRow('/demo/另一篇.md'), 'move')
    await expect.poll(() => fileText(page, '/demo/assets/另一篇.md')).toBe('# 另一篇\n\n用于测试文档链接。\n')
    expect(await fileText(page, '/demo/另一篇.md')).toBeNull()
    expect(await fileText(page, '/Users/test/.Trash/另一篇.md')).toBe('旧的内容\n')
    await expect(page.locator('.tz-toast')).toContainText('已移到「assets」')
  })

  test('S-13 在 Finder 中显示;文档列表里「在侧边栏中显示」切到文件树并展开到该文件', async ({ page }) => {
    await seedFolder(page)
    await runMenuCommand(page, 'view.fileTree')
    await sideMenu(page, treeRow('/demo/另一篇.md'), 'reveal')
    await expect.poll(() => hostCalls(page, 'revealInFinder')).toEqual([['/demo/另一篇.md']])

    await runMenuCommand(page, 'view.docList')
    await sideMenu(page, '.tz-doc-item[data-path="/demo/资料/深处.md"]', 'reveal.tree')
    await expect(page.locator('.tz-side-tab[data-tab="files"]')).toHaveClass(/is-active/)
    // 上级文件夹「资料」原本收着,显示时自动展开
    await expect(page.locator(treeRow('/demo/资料/深处.md'))).toBeVisible()
  })

  test('S-14 在新标签页 / 新窗口中打开、打开方式…、快速查看', async ({ page }) => {
    await runMenuCommand(page, 'view.fileTree')
    const before = await currentPath(page)
    const target = treeRow('/demo/另一篇.md')
    await sideMenu(page, target, 'open.tab')
    await sideMenu(page, target, 'open.window')
    await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([
      ['/demo/另一篇.md', { tab: true }],
      ['/demo/另一篇.md', { newWindow: true }],
    ])
    await sideMenu(page, target, 'open.with')
    await expect.poll(() => hostCalls(page, 'openWith')).toEqual([['/demo/另一篇.md']])
    await sideMenu(page, target, 'quicklook')
    await expect.poll(() => hostCalls(page, 'quickLook')).toEqual([['/demo/另一篇.md']])
    // 另开的不替换当前文档
    expect(await currentPath(page)).toBe(before)
  })

  test('S-15 拷贝文件路径:剪贴板里是绝对路径', async ({ page }) => {
    await runMenuCommand(page, 'view.fileTree')
    await sideMenu(page, treeRow('/demo/另一篇.md'), 'copy.path')
    await expect.poll(() => page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('/demo/另一篇.md')
  })

  test('S-16 打开文件夹…:空态按钮与文件菜单都切换侧栏根文件夹', async ({ page }) => {
    await seedFolder(page)
    await page.evaluate(() => window.typozaTest!.app['sidebar'].setRoot(null))
    await runMenuCommand(page, 'view.fileTree')
    await expect(page.locator('.tz-side-empty p')).toHaveText('没有打开的文件夹')
    await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/资料']))
    await page.locator('.tz-side-empty-btn', { hasText: '打开文件夹…' }).click()
    await expect(page.locator('.tz-tree-root')).toHaveAttribute('data-path', '/demo/资料')
    await expect(page.locator(treeRow('/demo/资料/深处.md'))).toBeVisible()
    expect(await hostCalls(page, 'openDialog')).toEqual([[{ directory: true }]])

    await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo']))
    await runMenuCommand(page, 'file.openFolder')
    await expect(page.locator('.tz-tree-root')).toHaveAttribute('data-path', '/demo')
    await expect(page.locator(treeRow('/demo/另一篇.md'))).toBeVisible()
  })

  test('S-17 磁盘变化后文件树自动刷新;右键「刷新」重读', async ({ page }) => {
    await runMenuCommand(page, 'view.fileTree')
    await expect(page.locator(treeRow('/demo/另一篇.md'))).toBeVisible()
    // 外壳监听到文件夹变化后推送 fs.changed
    await page.evaluate(() => {
      const host = window.typozaTest!.host
      host.files.set('/demo/外部新建.md', { kind: 'file', data: '# 外部\n', mtime: Date.now() })
      host.emit('fs.changed', { paths: ['/demo/外部新建.md'] })
    })
    await expect(page.locator(treeRow('/demo/外部新建.md'))).toBeVisible()

    // 没有推送时树不变,右键「刷新」后才出现
    await putFile(page, '/demo/手动刷新.md', '# 手动\n')
    await expect(page.locator(treeRow('/demo/手动刷新.md'))).toHaveCount(0)
    await sideMenu(page, '.tz-tree-root', 'refresh')
    await expect(page.locator(treeRow('/demo/手动刷新.md'))).toBeVisible()
  })

  test('S-18 固定 / 取消固定根文件夹;最近列表里固定项排前,可从列表中删除', async ({ page }) => {
    await runMenuCommand(page, 'view.fileTree')
    await page.locator('.tz-tree-root').click({ button: 'right' })
    await expect(page.locator(menuItem('pin'))).toHaveText('固定')
    await page.locator(menuItem('pin')).click()
    await expect.poll(() => savedSetting(page, 'pinnedFolders')).toEqual(['/demo'])
    await page.locator('.tz-tree-root').click({ button: 'right' })
    await expect(page.locator(menuItem('pin'))).toHaveText('取消固定')
    await page.locator(menuItem('pin')).click()
    await expect.poll(() => savedSetting(page, 'pinnedFolders')).toEqual([])

    // 没有打开文件夹时的「最近使用的目录」:固定的排在最近的前面
    await page.evaluate(async () => {
      const t = window.typozaTest!
      await t.host.setSettings({ recentFolders: ['/近期/甲', '/demo'], pinnedFolders: ['/demo'] })
      t.app['sidebar'].setRoot(null)
    })
    await runMenuCommand(page, 'view.fileTree')
    const order = () => page.locator('.tz-folder-item').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.folder))
    await expect.poll(order).toEqual(['/demo', '/近期/甲'])

    const row = (p: string) => page.locator(`.tz-folder-item[data-folder="${p}"]`)
    await row('/近期/甲').locator('.tz-folder-btn[title="固定"]').click()
    await expect.poll(order).toEqual(['/近期/甲', '/demo'])
    await row('/demo').locator('.tz-folder-btn[title="从列表中删除"]').click()
    await expect.poll(order).toEqual(['/近期/甲'])
    await row('/近期/甲').locator('.tz-folder-btn[title="取消固定"]').click()
    await expect(row('/近期/甲').locator('.tz-folder-btn[title="固定"]')).toBeVisible()
    expect(await page.evaluate(() => window.typozaTest!.host.settings)).toEqual(expect.objectContaining({ recentFolders: ['/近期/甲'], pinnedFolders: [] }))
  })
})

// ---------- 偏好设置 ▸ 文件(PF 区) ----------

test.describe('偏好设置 ▸ 文件', () => {
  type SettingsPatch = Parameters<NonNullable<Window['typozaTest']>['app']['updateSettings']>[0]

  test('PF-01 启动选项:打开新文件 / 上次目录 / 上次文件和目录 / 指定目录', async ({ page }) => {
    // 启动恢复只在外壳的首个窗口、没有指定打开路径时触发(内存宿主不是首个窗口),这里直接调应用的启动恢复逻辑
    await openApp(page)
    await seedFolder(page)
    const start = await currentPath(page)
    const restoreWith = (patch: SettingsPatch) =>
      page.evaluate(async (p) => {
        const app = window.typozaTest!.app
        app['sidebar'].setRoot('/demo')
        await app.updateSettings(p)
        await app['restoreStartup']()
        return { root: app['sidebar'].rootFolder, path: app.session.path }
      }, patch)

    expect(await restoreWith({ startupAction: 'newFile', lastFolder: '/demo/资料', lastFile: '/demo/资料/深处.md' })).toEqual({ root: '/demo', path: start })
    expect(await restoreWith({ startupAction: 'customFolder', startupFolder: '/demo/资料' })).toEqual({ root: '/demo/资料', path: start })
    expect(await restoreWith({ startupAction: 'lastFolder', lastFolder: '/demo/资料', lastFile: '/demo/资料/深处.md' })).toEqual({ root: '/demo/资料', path: start })
    expect(await restoreWith({ startupAction: 'lastFilesAndFolder', lastFolder: '/demo/资料', lastFile: '/demo/资料/深处.md' })).toEqual({
      root: '/demo/资料',
      path: '/demo/资料/深处.md',
    })
  })

  test('PF-03 默认扩展名选 .markdown:新文件保存框默认「未命名.markdown」;另存为的类型列表以它打头', async ({ page }) => {
    await openApp(page, '?empty')
    await runMenuCommand(page, 'app.preferences')
    await page.locator('.tz-settings-tab[data-page="文件"]').click()
    await page.locator('select[data-key=newFileExtension]').selectOption('markdown')
    await expect.poll(() => savedSetting(page, 'newFileExtension')).toBe('markdown')
    await closeModal(page)

    await page.locator('.tz-editor').click()
    await page.keyboard.type('正文')
    await runMenuCommand(page, 'file.save')
    await expect.poll(() => hostCalls(page, 'saveDialog')).toEqual([[{ defaultName: '未命名.markdown', extensions: ['markdown', 'md', 'txt', 'textbundle'] }]])
    await expect.poll(() => fileText(page, '/Users/test/未命名.markdown')).toBe('正文\n')

    await runMenuCommand(page, 'file.saveAs')
    await expect.poll(async () => (await hostCalls(page, 'saveDialog')).length).toBe(2)
    const [, [again]] = (await hostCalls(page, 'saveDialog')) as [unknown[], [{ extensions: string[] }]]
    expect(again.extensions[0]).toBe('markdown')
  })

  test('PF-03 默认扩展名选自定义 .mdx:新文件保存框默认「未命名.mdx」', async ({ page }) => {
    await openApp(page, '?empty')
    await runMenuCommand(page, 'app.preferences')
    await page.locator('.tz-settings-tab[data-page="文件"]').click()
    await page.locator('select[data-key=newFileExtension]').selectOption('custom')
    // 选「自定义」后才出现扩展名输入框;失焦时保存
    const custom = page.locator('input[data-key=customExtension]')
    await custom.fill('.mdx')
    await custom.press('Tab')
    await expect.poll(() => savedSetting(page, 'customExtension')).toBe('.mdx')
    await closeModal(page)

    await page.locator('.tz-editor').click()
    await page.keyboard.type('正文')
    await runMenuCommand(page, 'file.save')
    await expect.poll(() => hostCalls(page, 'saveDialog')).toEqual([[{ defaultName: '未命名.mdx', extensions: ['mdx', 'md', 'markdown', 'txt', 'textbundle'] }]])
    await expect.poll(() => fileText(page, '/Users/test/未命名.mdx')).toBe('正文\n')
  })

  test('PF-05 侧栏切换文件时自动保存上一个文件、不询问;关掉自动保存后切换会询问', async ({ page }) => {
    await openApp(page)
    await runMenuCommand(page, 'view.fileTree')
    await loadDoc(page, '# 切换\n\n原文\n', '/demo/切换.md')
    await page.keyboard.type('改动')
    await page.locator(treeRow('/demo/另一篇.md')).click()
    // 切换要等上一个文件写完才换文档:路径变了时上一个文件已经写盘
    await expect.poll(() => currentPath(page)).toBe('/demo/另一篇.md')
    expect(await fileText(page, '/demo/切换.md')).toBe('# 切换\n\n原文改动\n')
    expect(await confirmTitles(page)).toEqual([])

    await loadDoc(page, '# 切换二\n\n原文\n', '/demo/切换二.md')
    await page.evaluate(() => window.typozaTest!.app.updateSettings({ autoSave: false }))
    await page.keyboard.type('改')
    // 选「不保存」(第 2 个按钮)
    await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(1))
    await page.locator(treeRow('/demo/另一篇.md')).click()
    await expect.poll(() => confirmTitles(page)).toEqual(['是否保存更改?'])
    await expect.poll(() => currentPath(page)).toBe('/demo/另一篇.md')
    expect(await fileText(page, '/demo/切换二.md')).toBe('# 切换二\n\n原文\n')
  })

  /** 模拟从 Finder 拖进编辑区:外壳截下拖放后发 app.dropFiles(带真实路径),落点在第一段末尾 */
  async function dropOnFirstParagraph(page: Page, paths: string[]): Promise<void> {
    const box = await page.locator('.tz-editor p').first().boundingBox()
    if (!box) throw new Error('第一段不可见')
    await page.evaluate(({ p, x, y }) => window.typozaTest!.host.emit('app.dropFiles', { paths: p, x, y }), {
      p: paths,
      x: box.x + box.width - 4,
      y: box.y + box.height / 2,
    })
  }

  test('PF-08 拖入文件夹选「插入文件夹链接」:插入 [文件夹名](相对路径/),侧栏不换根', async ({ page }) => {
    await openApp(page)
    await seedFolder(page)
    await runMenuCommand(page, 'app.preferences')
    await page.locator('.tz-settings-tab[data-page="文件"]').click()
    await page.locator('select[data-key=dropFolderAction]').selectOption('link')
    await expect.poll(() => savedSetting(page, 'dropFolderAction')).toBe('link')
    await closeModal(page)
    await loadDoc(page, '参见\n', '/demo/拖入文件夹.md')
    await dropOnFirstParagraph(page, ['/demo/资料'])
    await expect.poll(async () => (await markdown(page)).trim()).toBe('参见[资料](资料/)')
    expect(await sidebarRoot(page)).toBe('/demo')
  })

  test('PF-09 拖入 Markdown 文件默认「打开」:在新窗口打开,当前文档不变', async ({ page }) => {
    await openApp(page)
    await loadDoc(page, '参见\n', '/demo/拖入默认.md')
    await dropOnFirstParagraph(page, ['/demo/另一篇.md'])
    await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([['/demo/另一篇.md', { newWindow: true }]])
    expect(await markdown(page)).toBe('参见\n')
    expect(await currentPath(page)).toBe('/demo/拖入默认.md')
  })

  test('PF-10 拖入可导入文件(.docx)默认「导入」:经 Pandoc 导入后在新窗口打开,当前文档不变', async ({ page }) => {
    await openApp(page)
    await putFile(page, '/demo/报告.docx', 'fake docx')
    await loadDoc(page, '参见\n', '/demo/拖入导入.md')
    await dropOnFirstParagraph(page, ['/demo/报告.docx'])
    await expect.poll(() => hostCalls(page, 'importDocument')).toEqual([['/demo/报告.docx']])
    // 内存宿主的导入把同名 .md 写在原文件旁
    await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([['/demo/报告.md', { newWindow: true }]])
    expect(await markdown(page)).toBe('参见\n')
  })
})
