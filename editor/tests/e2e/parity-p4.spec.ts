import { expect, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { hostCalls, putFile, runMenuCommand } from './media-helpers'

// 对照表(docs/prd/typora-parity.md)第 4 部分里判为「无」「部分」、网页侧能测的 X / Z 行。
// 规则层(命名锚点、绝对路径、引用式链接、YAML 键、导出变量)的单测在 tests/unit/parity-p4.test.ts。
// X-55(命令行打开)、X-26(备忘录列表要真机样本)、Z-12(端到端加密在后端仓库)不在这里。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

/** 1×1 GIF(与 demo.ts 的 TINY_GIF 相同):粘贴、拖入图片文件用 */
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const currentPath = (page: Page) => page.evaluate(() => window.typozaTest!.app.session.path)

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

const hasFile = (page: Page, path: string) => page.evaluate((p) => window.typozaTest!.host.files.has(p), path)

/** 光标所在的文字块:类型、文字、块内偏移 */
const caret = (page: Page) =>
  page.evaluate(() => {
    const { $from } = window.typozaTest!.app.view.state.selection
    return { type: $from.parent.type.name, text: $from.parent.textContent, offset: $from.parentOffset }
  })

const link = (page: Page, text: string) => page.locator('.tz-editor a', { hasText: text }).first()
const cell = (page: Page, text: string) => page.locator('.tz-editor td, .tz-editor th').filter({ hasText: new RegExp(`^${text}$`) })

/** 把光标放到某段文字之后(WebKit 里 End 键在 macOS 上是滚动页面,不移光标) */
async function placeAfter(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const v = window.typozaTest!.app.view
    let pos = -1
    v.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text!.includes(t)) pos = p + node.text!.indexOf(t) + t.length
      return pos < 0
    })
    if (pos < 0) throw new Error(`找不到文字:${t}`)
    const Sel = v.state.selection.constructor as unknown as { create(doc: unknown, pos: number): typeof v.state.selection }
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, pos)))
    v.focus()
  }, text)
}

async function openPreferences(page: Page, tab: string): Promise<void> {
  await runMenuCommand(page, 'app.preferences')
  await page.locator(`.tz-settings-tab[data-page="${tab}"]`).click()
  await expect(page.locator(`.tz-settings-tab[data-page="${tab}"]`)).toHaveClass(/is-active/)
}

async function closeModal(page: Page): Promise<void> {
  await page.locator('.tz-modal').last().locator('.tz-modal-close').click()
  await expect(page.locator('.tz-modal')).toHaveCount(0)
}

/** 粘贴从网页拷贝的内容:剪贴板里同时有 text/html 与 text/plain */
async function pasteHtml(page: Page, html: string, text: string): Promise<void> {
  await page.evaluate(
    ([h, t]) => {
      const data = new DataTransfer()
      data.setData('text/html', h)
      data.setData('text/plain', t)
      const editor = document.querySelector('.tz-editor')
      if (!editor) throw new Error('找不到编辑器')
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    [html, text] as const,
  )
}

/** 粘贴一张图片文件(剪贴板里只有 Files,没有 text/plain) */
async function pasteGif(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ([gif, fileName]) => {
      const data = new DataTransfer()
      data.items.add(new File([Uint8Array.from(atob(gif), (c) => c.charCodeAt(0))], fileName, { type: 'image/gif' }))
      const editor = document.querySelector('.tz-editor')
      if (!editor) throw new Error('找不到编辑器')
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    },
    [GIF, name] as const,
  )
}

/**
 * 在元素右端(行尾)派发一次浏览器拖放。Playwright 自带的拖放在 Linux WebKit 上到不了 ProseMirror,
 * 这里直接派发 DragEvent;payload 可放网页拖出的 HTML / 网址,或一张 GIF 文件。
 */
async function dropAtEnd(page: Page, selector: string, payload: { html?: string; uri?: string; gifName?: string }): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) throw new Error(`元素不可见:${selector}`)
  await page.evaluate(
    ({ x, y, gif, p }) => {
      const dt = new DataTransfer()
      if (p.html) dt.setData('text/html', p.html)
      if (p.uri) dt.setData('text/uri-list', p.uri)
      if (p.gifName) dt.items.add(new File([Uint8Array.from(atob(gif), (c) => c.charCodeAt(0))], p.gifName, { type: 'image/gif' }))
      const target = document.elementFromPoint(x, y)
      if (!target) throw new Error('落点下没有元素')
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
      }
    },
    { x: box.x + box.width - 4, y: box.y + box.height / 2, gif: GIF, p: payload },
  )
}

/** 从 Finder 拖进窗口(外壳截下拖放、带真实路径),落在第一段行尾 */
async function nativeDrop(page: Page, paths: string[]): Promise<void> {
  const box = await page.locator('.tz-editor p').first().boundingBox()
  if (!box) throw new Error('取不到段落位置')
  await page.evaluate(({ p, x, y }) => window.typozaTest!.host.emit('app.dropFiles', { paths: p, x, y }), {
    p: paths,
    x: box.x + box.width - 4,
    y: box.y + box.height / 2,
  })
}

// ---------- 输入与链接 ----------

test('X-04 自动配对括号与引号:敲 ( 补出 ),敲 ) 越过;引号同理;关掉「匹配括号和引号」后不再配对', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('(')
  expect((await markdown(page)).trim()).toBe('()')
  expect((await caret(page)).offset).toBe(1)
  await page.keyboard.type('中)')
  // 敲收尾的 ) 是越过补出来的那个,不会多出一个
  expect((await markdown(page)).trim()).toBe('(中)')
  expect((await caret(page)).offset).toBe(3)
  await page.keyboard.type(' "')
  expect((await markdown(page)).trim()).toBe('(中) ""')
  await page.keyboard.type('引"')
  expect((await markdown(page)).trim()).toBe('(中) "引"')
  expect(await caret(page)).toEqual({ type: 'paragraph', text: '(中) "引"', offset: 7 })

  await openPreferences(page, '编辑器')
  await page.locator('input[data-key=autoPair]').uncheck()
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.settings.autoPair)).toBe(false)
  await closeModal(page)
  await loadDoc(page, '')
  await page.keyboard.type('(a "')
  expect((await markdown(page)).trim()).toBe('(a "')
})

test('X-06 / X-46 悬停预览:悬停脚注号显示脚注内容,悬停网址链接显示地址;脚注未定义时悬停提示定义语法', async ({ page }) => {
  await loadDoc(page, '正文[^1]和[网址](https://example.com/page)。\n\n[^1]: 脚注内容\n')
  const ref = page.locator('.tz-editor .tz-footnote-ref')
  const tip = page.locator('.tz-footnote-tip')
  await ref.hover()
  await expect(tip).toHaveText('脚注内容')
  // 移开后提示消失
  await page.mouse.move(2, 2)
  await expect(tip).toHaveCount(0)

  await link(page, '网址').hover()
  const preview = page.locator('.tz-link-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.tz-link-url')).toHaveText('https://example.com/page')

  // 删掉定义后再悬停(没有定义的 [^x] 打开文件时不会识别成脚注,所以在编辑中删定义)
  await page.evaluate(() => {
    const view = window.typozaTest!.app.view
    let from = -1
    let to = -1
    view.state.doc.forEach((node, offset) => {
      if (node.type.name === 'footnote_def') {
        from = offset
        to = offset + node.nodeSize
      }
    })
    view.dispatch(view.state.tr.delete(from, to))
  })
  await page.mouse.move(2, 2)
  await ref.hover()
  await expect(tip).toHaveText('请按语法 [^1]: www.example.com 定义脚注 1')
})

test('X-07 ⌘+点击:网址交给浏览器,#标题 文内跳转,非 Markdown 的本机文件交给默认应用', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '# 第一节\n\n去看 [网址](https://example.com/a)、[跳到第二节](#第二节)、[表单图](assets/form.svg)。\n\n## 第二节\n\n结尾\n', '/demo/点击.md')
  await link(page, '网址').click({ modifiers: [mod] })
  await expect.poll(() => hostCalls(page, 'openExternal')).toEqual([['https://example.com/a']])
  await link(page, '跳到第二节').click({ modifiers: [mod] })
  await expect.poll(async () => (await caret(page)).text).toBe('第二节')
  await link(page, '表单图').click({ modifiers: [mod] })
  await expect.poll(() => hostCalls(page, 'openWithDefaultApp')).toEqual([['/demo/assets/form.svg']])
  // 三种都不在 Typoza 里另开文档,也不弹单击才有的链接浮层
  expect(await hostCalls(page, 'openDocument')).toEqual([])
  await expect(page.locator('.tz-link-card')).toBeHidden()
  expect(await currentPath(page)).toBe('/demo/点击.md')
})

test('X-12 尖括号邮箱 <a@b.com> 显示为邮箱链接,⌘+点击交给系统打开;保存仍是 <a@b.com>', async ({ page }) => {
  const md = '写信给 <a@b.com>\n'
  await loadDoc(page, md)
  const mail = page.locator('.tz-editor a[href="mailto:a@b.com"]')
  await expect(mail).toHaveText('a@b.com')
  await mail.click({ modifiers: [await modKey(page)] })
  await expect.poll(() => hostCalls(page, 'openExternal')).toEqual([['mailto:a@b.com']])
  expect(await markdown(page)).toBe(md)
})

test('X-13 引用式链接与图片:地址取自定义行;单击浮层【打开】打开定义里的文档;引用式图片能显示', async ({ page }) => {
  await loadDoc(page, '见 [另一篇][doc] 与 [doc][]。\n\n![标识][img]\n\n[doc]: 另一篇.md\n[img]: assets/id.svg\n', '/demo/引用.md')
  await expect(page.locator('.tz-editor a', { hasText: '另一篇' })).toHaveAttribute('href', '另一篇.md')
  await expect(page.locator('.tz-editor a', { hasText: /^doc$/ })).toHaveAttribute('href', '另一篇.md')
  // id.svg 宽 400:图片按定义里的地址载入成功
  const img = page.locator('.tz-editor .tz-image img')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(400)
  await link(page, '另一篇').click()
  await page.locator('.tz-link-card button[name=open]').click()
  await expect.poll(() => currentPath(page)).toBe('/demo/另一篇.md')
})

test('X-25 智能粘贴:粘贴网页 HTML 保留标题、无序 / 有序列表、加粗与链接,存成 Markdown', async ({ page }) => {
  await loadDoc(page, '')
  await pasteHtml(
    page,
    '<h2>标题</h2><ul><li>一</li><li>二</li></ul><ol><li>甲</li><li>乙</li></ol><p>正文 <strong>粗</strong> <a href="https://example.com/">链接</a></p>',
    '标题\n一\n二\n甲\n乙\n正文 粗 链接',
  )
  await expect.poll(async () => (await markdown(page)).trim()).toBe('## 标题\n\n- 一\n- 二\n\n1. 甲\n2. 乙\n\n正文 **粗** [链接](https://example.com/)')
  await expect(page.locator('.tz-editor h2')).toHaveText('标题')
})

// ---------- 拖入与插图 ----------

test('X-16 拖入图片:Finder 一次拖入两张本机图片,都复制进 assets 并插入', async ({ page }) => {
  await page.evaluate(() => {
    const files = window.typozaTest!.host.files
    const svg = files.get('/demo/assets/id.svg')
    if (!svg || svg.kind !== 'file') throw new Error('缺少演示图片')
    files.set('/Users/test/Pictures', { kind: 'dir', mtime: Date.now() })
    for (const name of ['甲.svg', '乙.svg']) files.set(`/Users/test/Pictures/${name}`, { kind: 'file', data: svg.data, mtime: Date.now() })
  })
  await loadDoc(page, '参见\n', '/demo/拖图.md')
  await nativeDrop(page, ['/Users/test/Pictures/甲.svg', '/Users/test/Pictures/乙.svg'])
  await expect.poll(async () => (await markdown(page)).trim()).toBe('参见![甲](assets/甲.svg)![乙](assets/乙.svg)')
  expect(await hasFile(page, '/demo/assets/甲.svg')).toBe(true)
  expect(await hasFile(page, '/demo/assets/乙.svg')).toBe(true)
  // 原图留在原处(复制,不是移动)
  expect(await hasFile(page, '/Users/test/Pictures/甲.svg')).toBe(true)
  await expect(page.locator('.tz-editor .tz-image img')).toHaveCount(2)
})

test('X-16 拖入浏览器里的图片:带 <img> 的网页拖放插入网络图片;拖来的是图片文件时存进 assets', async ({ page }) => {
  await loadDoc(page, '网页\n', '/demo/拖网页图.md')
  // 从网页拖图片时 DataTransfer 里有 text/html(<img>)与 text/uri-list;偏好默认不下载网络图片,保持网址
  await dropAtEnd(page, '.tz-editor p', { html: '<img src="https://img.example.com/cat.png" alt="猫">', uri: 'https://img.example.com/cat.png' })
  await expect.poll(async () => (await markdown(page)).trim()).toBe('网页![猫](https://img.example.com/cat.png)')

  await loadDoc(page, '网页\n', '/demo/拖网页图-2.md')
  await dropAtEnd(page, '.tz-editor p', { gifName: '网页图.gif' })
  await expect.poll(async () => (await markdown(page)).trim()).toBe('网页![网页图](assets/网页图.gif)')
  expect(await hasFile(page, '/demo/assets/网页图.gif')).toBe(true)
})

test('X-17 拖入文件(默认偏好):Markdown 文件在新窗口打开;docx 等可导入文件经 Pandoc 导入后打开;正文不变', async ({ page }) => {
  await putFile(page, '/demo/报告.docx', 'PK')
  await loadDoc(page, '参见\n', '/demo/拖入.md')
  await nativeDrop(page, ['/demo/另一篇.md'])
  await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([['/demo/另一篇.md', { newWindow: true }]])
  await nativeDrop(page, ['/demo/报告.docx'])
  await expect.poll(() => hostCalls(page, 'importDocument')).toEqual([['/demo/报告.docx']])
  // 内存宿主把导入结果写成同名 .md
  await expect.poll(() => hostCalls(page, 'openDocument')).toContainEqual(['/demo/报告.md', { newWindow: true }])
  expect(await markdown(page)).toBe('参见\n')
})

test('X-17 拖入文件(偏好选「插入链接」):文件夹插入以 / 结尾的链接,可导入文件插入文件链接', async ({ page }) => {
  await putFile(page, '/demo/报告.docx', 'PK')
  await page.evaluate(() => window.typozaTest!.host.files.set('/demo/资料', { kind: 'dir', mtime: Date.now() }))
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ dropFolderAction: 'link', dropImportableAction: 'link' }))
  await loadDoc(page, '参见\n', '/demo/拖入.md')
  await nativeDrop(page, ['/demo/资料', '/demo/报告.docx'])
  await expect.poll(async () => (await markdown(page)).trim()).toBe('参见[资料](资料/) [报告.docx](报告.docx)')
  expect(await hostCalls(page, 'importDocument')).toEqual([])
  expect(await hostCalls(page, 'openDocument')).toEqual([])
})

test('X-20 YAML 写了 typora-root-url:/ 开头的图片按这个根路径找到并显示,YAML 原样保存', async ({ page }) => {
  const md = '---\ntypora-root-url: ./assets\n---\n\n![标识](/id.svg)\n'
  await loadDoc(page, md, '/demo/根路径.md')
  const img = page.locator('.tz-editor .tz-image img')
  // /id.svg 解析为 /demo/assets/id.svg(宽 400);没有根路径时会去找不存在的 /id.svg
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(400)
  await expect(page.locator('.tz-editor .tz-image')).not.toHaveClass(/is-broken/)
  expect(await markdown(page)).toBe(md)
})

test('X-21 YAML 写了 typora-copy-images-to:粘贴的图片存进该目录(不存在时先询问创建),地址写相对路径', async ({ page }) => {
  await loadDoc(page, '---\ntypora-copy-images-to: ./pics\n---\n\n段落\n', '/demo/插图目录.md')
  await page.locator('.tz-editor p').click()
  await placeAfter(page, '段落')
  // 确认框队列为空时宿主返回 0,即第一个按钮「创建目录并继续」
  await pasteGif(page, '贴图.gif')
  await expect.poll(() => markdown(page)).toContain('段落![贴图](pics/贴图.gif)')
  expect(await hasFile(page, '/demo/pics/贴图.gif')).toBe(true)
  const asks = (await hostCalls(page, 'confirm')).map((a) => a[0] as { title: string; message: string })
  expect(asks).toEqual([expect.objectContaining({ title: '该目录不存在,是否立即创建?', message: '/demo/pics' })])
  // 没有落到偏好默认的 ./assets
  expect(await hasFile(page, '/demo/assets/贴图.gif')).toBe(false)
})

test('X-23 导出 PDF:页眉页脚里的 ${title}、${currentFileName}、${today} 先替换,${pageNo}、${pageCount} 留给外壳逐页替换', async ({ page }) => {
  await page.evaluate(() =>
    window.typozaTest!.app.updateSettings({ exportPdfHeader: '${currentFileName} · ${today}', exportPdfFooter: '第 ${pageNo}/${pageCount} 页 · ${title}' }),
  )
  await loadDoc(page, '# 页码\n\n正文\n', '/demo/页码测试.md')
  await runMenuCommand(page, 'file.export.pdf')
  await expect(page.locator('.tz-toast')).toHaveText('导出成功')
  const calls = await hostCalls(page, 'exportDocument')
  expect(calls.map((a) => [a[0], a[1]])).toEqual([['pdf', '/demo/页码测试.pdf']])
  const options = calls[0][2] as { header: string; footer: string }
  const today = await page.evaluate(() => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })
  expect(options.header).toBe(`页码测试 · ${today}`)
  expect(options.footer).toBe('第 ${pageNo}/${pageCount} 页 · 页码测试')
})

// ---------- 代码块与公式 ----------

test('X-27 代码语言补全:``` 与 ~~~ 建出的代码块,语言框都接上语言清单;选定语言写进围栏', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  const lang = page.locator('.tz-editor .tz-code-lang')
  // 下拉提示是浏览器原生的 <datalist>:断言输入框接上了清单、清单里有常用语言
  expect(await lang.evaluate((el: HTMLInputElement) => el.list?.id ?? null)).toBe('tz-code-languages')
  const names = await page.locator('datalist#tz-code-languages option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value))
  expect(names).toEqual(expect.arrayContaining(['python', 'javascript', 'typescript', 'shell', 'mermaid', 'math']))
  await lang.fill('python')
  await lang.press('Enter')
  await expect.poll(async () => (await markdown(page)).trim()).toBe('```python\n```')

  await loadDoc(page, '')
  await page.keyboard.type('~~~')
  await page.keyboard.press('Enter')
  const tilde = page.locator('.tz-editor .tz-code-lang')
  expect(await tilde.evaluate((el: HTMLInputElement) => el.list?.id ?? null)).toBe('tz-code-languages')
  await tilde.fill('go')
  await tilde.press('Enter')
  await expect.poll(() => page.evaluate(() => window.typozaTest!.app.view.state.doc.firstChild?.attrs.language)).toBe('go')
})

test('X-40 代码块高亮:语言名不区分大小写(PYTHON、Python、py 都高亮);语言清单约 150 种', async ({ page }) => {
  await loadDoc(page, '```PYTHON\ndef a():\n    return 1\n```\n\n```Python\ndef b():\n    return 2\n```\n\n```py\ndef c():\n    return 3\n```\n')
  const blocks = page.locator('.tz-editor .tz-code-block')
  await expect(blocks).toHaveCount(3)
  // 语言包按需加载,出现关键字高亮才算认出了语言
  for (let i = 0; i < 3; i++) await expect(blocks.nth(i).locator('.tok-keyword').first()).toBeVisible({ timeout: 15_000 })
  // 语言框的清单就是支持高亮的全部语言(另加 mermaid、sequence、flow、math)
  expect(await page.locator('datalist#tz-code-languages option').count()).toBeGreaterThanOrEqual(140)
})

test('X-41 公式:mhchem \\ce{} 能渲染;\\newcommand 与 \\def 定义的宏在后面的公式里生效', async ({ page }) => {
  await loadDoc(page, '$$\n\\newcommand{\\RR}{\\mathbb{R}}\n\\def\\half{\\frac{1}{2}}\nx \\in \\RR\n$$\n\n$$\ny = \\half \\RR\n$$\n\n$$\n\\ce{H2O + CO2 -> H2CO3}\n$$\n')
  const previews = page.locator('.tz-editor .tz-math-preview')
  await expect(previews).toHaveCount(3)
  for (let i = 0; i < 3; i++) await expect(previews.nth(i).locator('.katex').first()).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.tz-editor .tz-math-preview.is-error')).toHaveCount(0)
  // 第二个公式里的 \RR 展开成 \mathbb{R}、\half 展开成分数:宏跨公式生效
  await expect(previews.nth(1).locator('.mathbb')).toHaveCount(1)
  await expect(previews.nth(1).locator('.mfrac')).toHaveCount(1)
})

// ---------- 表格 ----------

test('X-36 表格工具条:左 / 中 / 右对齐写出 :-、:-:、-:,只改当前列;删除表格', async ({ page }) => {
  await loadDoc(page, '前文\n\n| a | b |\n| - | - |\n| 1 | 2 |\n')
  await cell(page, '1').click()
  const toolbar = page.locator('.tz-table-toolbar')
  await expect(toolbar).toBeVisible()
  // 表格的分隔行:只由 | : - 和空格组成
  const delimiter = async () => (await markdown(page)).split('\n').find((l) => /^\|[\s:|-]+\|$/.test(l)) ?? ''
  await toolbar.locator('button[title="左对齐"]').click()
  await expect.poll(delimiter).toMatch(/^\| :-+ \| -+ \|$/)
  await toolbar.locator('button[title="居中"]').click()
  await expect.poll(delimiter).toMatch(/^\| :-+: \| -+ \|$/)
  await toolbar.locator('button[title="右对齐"]').click()
  await expect.poll(delimiter).toMatch(/^\| -+: \| -+ \|$/)
  await toolbar.locator('button[title="删除表格"]').click()
  await expect(page.locator('.tz-editor table')).toHaveCount(0)
  expect((await markdown(page)).trim()).toBe('前文')
})

test('X-37 拖列上边框的手柄换列', async ({ page }) => {
  // 光标在文末「结尾」里,表格工具条不显示(它叠在表格上方,会盖住列手柄)
  await loadDoc(page, '前文\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n\n结尾\n')
  await expect(page.locator('.tz-table-toolbar')).toBeHidden()
  await cell(page, '1').hover()
  const grip = page.locator('.tz-table-grip-col')
  await expect(grip).toBeVisible()
  const g = await grip.boundingBox()
  const target = await cell(page, '3').boundingBox()
  if (!g || !target) throw new Error('取不到手柄位置')
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, g.y + g.height / 2, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await markdown(page)).trim()).toBe('前文\n\n| b | c | a |\n| - | - | - |\n| 2 | 3 | 1 |\n\n结尾')
})

test('X-37 表头行不参与拖动:悬停表头不出行手柄;把第一行拖到表头上不换位', async ({ page }) => {
  const md = '| a |\n| - |\n| 1 |\n| 2 |\n\n结尾\n'
  await loadDoc(page, md)
  const rowGrip = page.locator('.tz-table-grip-row')
  await cell(page, '1').hover()
  await expect(rowGrip).toBeVisible()
  await cell(page, 'a').hover()
  await expect(rowGrip).toBeHidden()
  // 列手柄照常显示(换列时表头跟着列走)
  await expect(page.locator('.tz-table-grip-col')).toBeVisible()

  await cell(page, '1').hover()
  await expect(rowGrip).toBeVisible()
  const g = await rowGrip.boundingBox()
  const head = await cell(page, 'a').boundingBox()
  if (!g || !head) throw new Error('取不到手柄位置')
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(g.x + g.width / 2, head.y + head.height / 2, { steps: 6 })
  await page.mouse.up()
  expect(await markdown(page)).toBe(md)
})

test('X-38 表格内 ⇧Tab:回到上一格,行首回到上一行末格;首格按 ⇧Tab 不跳出表格', async ({ page }) => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |\n'
  await loadDoc(page, md)
  const at = async () => {
    const c = await caret(page)
    return [c.type, c.text]
  }
  await cell(page, '2').click()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(at).toEqual(['table_cell', '1'])
  await page.keyboard.press('Shift+Tab')
  await expect.poll(at).toEqual(['table_header', 'b'])
  await cell(page, 'a').click()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(at).toEqual(['table_header', 'a'])
  expect(await markdown(page)).toBe(md)
})

test('X-39 单元格里 ⇧↩ 换行,保存为 <br>', async ({ page }) => {
  await loadDoc(page, '| a | b |\n| - | - |\n| 1 | 2 |\n')
  await cell(page, '1').click()
  await placeAfter(page, '1')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('x')
  await expect.poll(() => markdown(page)).toContain('| 1<br>x | 2 |')
  await expect(page.locator('.tz-editor td br:not(.ProseMirror-trailingBreak)')).toHaveCount(1)
})

// ---------- HTML ----------

test('X-43 HTML 渲染:sup、kbd、ruby、带 style 的 span、HTML 实体在预览里生效;段落里的 <sup>、颜色 span 与实体照常显示', async ({ page }) => {
  const md =
    '<p>x<sup>2</sup>,按 <kbd>⌘</kbd>,<ruby>汉<rt>hàn</rt></ruby>,<span style="color: red">红字</span>,&copy; &amp;</p>\n\n段落里 x<sup>3</sup> 与 <span style="color: red">行内红字</span> &copy;\n'
  await loadDoc(page, md)
  const preview = page.locator('.tz-editor .tz-html-preview')
  await expect(preview.locator('sup')).toHaveText('2')
  await expect(preview.locator('kbd')).toHaveText('⌘')
  await expect(preview.locator('ruby rt')).toHaveText('hàn')
  await expect(preview.locator('span', { hasText: '红字' })).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(preview).toContainText('© &')

  const para = page.locator('.tz-editor > p')
  await expect(para.locator('sup')).toHaveText('3')
  await expect(para.locator('span[data-tz-color]')).toHaveCSS('color', 'rgb(255, 0, 0)')
  await expect(para).toContainText('©')
  expect(await markdown(page)).toBe(md)
})

test('X-44 HTML 安全:文档里的 <script> 不执行,onload 属性被去掉;源码原样保存', async ({ page }) => {
  const md =
    '<script>window.__tzP4Block = 1</script>\n\n<div><img src="assets/id.svg" alt="标识" onload="window.__tzP4Onload = 1"></div>\n\n段落 <script>window.__tzP4Inline = 1</script> 结尾\n'
  await loadDoc(page, md)
  const img = page.locator('.tz-editor .tz-html-preview img')
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
  expect(await img.getAttribute('onload')).toBeNull()
  expect(await page.evaluate(() => document.querySelectorAll('.tz-editor script').length)).toBe(0)
  const flags = await page.evaluate(async () => {
    // 让出一轮任务:图片的 load 事件排在载入完成之后派发
    await new Promise((r) => setTimeout(r, 0))
    const w = window as unknown as Record<string, unknown>
    return [typeof w.__tzP4Block, typeof w.__tzP4Onload, typeof w.__tzP4Inline]
  })
  expect(flags).toEqual(['undefined', 'undefined', 'undefined'])
  expect(await markdown(page)).toBe(md)
})

test('X-45 HTML 块:点预览的空白处展开源码;⌘+点击块内链接只展开源码,不跳转', async ({ page }) => {
  await loadDoc(page, '<div>HTML 内容</div>\n\n<p><a href="另一篇.md">去另一篇</a></p>\n\n段落\n', '/demo/HTML块.md')
  const blocks = page.locator('.tz-editor .tz-html-block')
  await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(0)
  const content = page.locator('.tz-editor .tz-html-preview div', { hasText: 'HTML 内容' })
  const box = await content.boundingBox()
  if (!box) throw new Error('取不到 HTML 块位置')
  // 文字只占左边一小段,右端是空白
  await content.click({ position: { x: box.width - 8, y: box.height / 2 } })
  await expect(blocks.nth(0)).toHaveClass(/is-editing/)

  // 光标回到正文段落,源码收起
  await page.locator('.tz-editor > p').click()
  await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(0)
  // HTML 块按 metaKey 判断 ⌘(macOS 外壳专用),Linux 上同样按 Meta
  await page.locator('.tz-html-preview a', { hasText: '去另一篇' }).click({ modifiers: ['Meta'] })
  await expect(blocks.nth(1)).toHaveClass(/is-editing/)
  expect(await hostCalls(page, 'openDocument')).toEqual([])
  expect(await currentPath(page)).toBe('/demo/HTML块.md')
})

// ---------- 字数、大纲 ----------

test('X-47 字数统计:状态栏显示全文字数,选中文字时显示选区;字数弹窗列出词、字符、行、阅读时间', async ({ page }) => {
  // 正文 = 「标题\n\nHello world 你好」:中日韩 4 字 + 西文 2 词 = 6;18 个字符,去掉空白 14;3 行 2 段
  await loadDoc(page, '# 标题\n\nHello world 你好\n')
  const words = page.locator('.tz-status-words')
  await expect(words).toHaveText('6 字')
  // 光标在文末,向左选中「你好」
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(words).toHaveText('已选 2 字 / 共 6 字')

  await runMenuCommand(page, 'view.wordCount')
  const table = page.locator('.tz-modal .tz-wordcount')
  await expect(table).toBeVisible()
  const cellsOf = (selector: string) => table.locator(selector).evaluateAll((rows) => rows.map((r) => Array.from(r.children).map((c) => c.textContent ?? '')))
  expect(await cellsOf('thead tr')).toEqual([['', '全文', '选中']])
  expect(await cellsOf('tbody tr')).toEqual([
    ['字数', '6', '2'],
    ['字符数', '18', '2'],
    ['字符数(不含空白)', '14', '2'],
    ['中日韩字符', '4', '2'],
    ['段落', '2', '1'],
    ['行数', '3', '1'],
    ['阅读时间(分钟)', '1', '1'],
  ])
})

test('X-48 大纲:点侧栏大纲里的标题,光标落到该标题;大纲窗口里点击同样定位', async ({ page }) => {
  await loadDoc(page, '# A\n\n正文一\n\n# B\n\n正文二\n\n# C\n\n正文三\n')
  await runMenuCommand(page, 'view.outline')
  const items = page.locator('.tz-outline .tz-outline-item')
  await expect(items).toHaveCount(3)
  await items.nth(1).click()
  await expect.poll(() => caret(page)).toEqual({ type: 'heading', text: 'B', offset: 0 })

  await runMenuCommand(page, 'view.outlinePopover')
  await page.locator('.tz-outline-popover .tz-outline-item', { hasText: 'C' }).click()
  await expect.poll(() => caret(page)).toEqual({ type: 'heading', text: 'C', offset: 0 })
})

// ---------- 文件 ----------

test('X-52 保存失败:自动保存连续失败只在第一次写剪贴板;手动保存失败照常写', async ({ page }) => {
  await loadDoc(page, '# 失败\n\n内容\n')
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    host.writeText = async (path) => {
      host.calls.push({ method: 'failedWrite', args: [path] })
      throw new Error('保存失败:/demo/x.md(磁盘已满)')
    }
  })
  const toast = page.locator('.tz-toast')
  const writes = async () => (await hostCalls(page, 'failedWrite')).length
  const clipboardWrites = async () => (await hostCalls(page, 'clipboardWrite')).length

  await page.keyboard.type('一')
  await expect(toast).toContainText('全文已放入剪贴板', { timeout: 5000 })
  expect(await clipboardWrites()).toBe(1)

  // 第二次自动保存仍失败:只提示,不再覆盖剪贴板
  await page.keyboard.type('二')
  await expect.poll(writes, { timeout: 5000 }).toBe(2)
  await expect(toast).not.toContainText('剪贴板')
  await expect(toast).toContainText('保存失败:/demo/x.md(磁盘已满)')
  await expect(toast.locator('.tz-toast-action')).toHaveText('另存为')
  expect(await clipboardWrites()).toBe(1)
  expect(await page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('# 失败\n\n内容一\n')

  // 用户主动保存(⌘S)失败:再放一次剪贴板,内容是最新的全文
  await runMenuCommand(page, 'file.save')
  await expect.poll(clipboardWrites).toBe(2)
  expect(await page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('# 失败\n\n内容一二\n')
})

const lastWindowTitle = (page: Page) =>
  page.evaluate(() => {
    const calls = window.typozaTest!.host.calls.filter((c) => c.method === 'setWindowState')
    return (calls[calls.length - 1]?.args[0] as { title: string } | undefined)?.title ?? null
  })

test('X-53 TextBundle:打开包,标题栏显示包名;插图存进包里的 assets 并提示;保存写回包里的 text.md', async ({ page }) => {
  await page.evaluate(() => {
    const files = window.typozaTest!.host.files
    files.set('/demo/游记.textbundle', { kind: 'dir', mtime: Date.now() })
    files.set('/demo/游记.textbundle/assets', { kind: 'dir', mtime: Date.now() })
    files.set('/demo/游记.textbundle/info.json', { kind: 'file', data: '{"version":2}\n', mtime: Date.now() })
    files.set('/demo/游记.textbundle/text.md', { kind: 'file', data: '# 游记\n\n正文\n', mtime: Date.now() })
  })
  await page.evaluate(() => window.typozaTest!.app.openFile('/demo/游记.textbundle', { replace: true }))
  await expect.poll(() => currentPath(page)).toBe('/demo/游记.textbundle/text.md')
  await expect.poll(() => lastWindowTitle(page)).toBe('游记.textbundle')

  await page.locator('.tz-editor p').first().click()
  await placeAfter(page, '正文')
  await pasteGif(page, '贴图.gif')
  await expect(page.locator('.tz-toast')).toHaveText('图片已存储到 TextBundle 文件中')
  await expect.poll(() => hasFile(page, '/demo/游记.textbundle/assets/贴图.gif')).toBe(true)
  // 自动保存写回包里的正文,图片地址相对包
  await expect.poll(() => fileText(page, '/demo/游记.textbundle/text.md'), { timeout: 5000 }).toBe('# 游记\n\n正文![贴图](assets/贴图.gif)\n')
  expect(await hasFile(page, '/demo/assets/贴图.gif')).toBe(false)
})

test('X-53 另存为选 .textbundle:建包(assets 文件夹与 info.json),正文写进包里的 text.md', async ({ page }) => {
  await loadDoc(page, '# 新包\n\n内容\n', '/demo/普通.md')
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    // 内存宿主的保存框总是返回默认文件名;这里模拟用户在保存框里选了 TextBundle
    host.saveDialog = async (options) => {
      host.calls.push({ method: 'saveDialog', args: [options] })
      return '/demo/新包.textbundle'
    }
  })
  await runMenuCommand(page, 'file.saveAs')
  await expect.poll(() => currentPath(page)).toBe('/demo/新包.textbundle/text.md')
  const [[options]] = await hostCalls(page, 'saveDialog')
  expect((options as { extensions: string[] }).extensions).toContain('textbundle')
  expect(await page.evaluate(() => window.typozaTest!.host.files.get('/demo/新包.textbundle/assets')?.kind)).toBe('dir')
  expect(JSON.parse((await fileText(page, '/demo/新包.textbundle/info.json')) ?? '{}')).toMatchObject({ version: 2, type: 'net.daringfireball.markdown' })
  expect(await fileText(page, '/demo/新包.textbundle/text.md')).toBe('# 新包\n\n内容\n')
  await expect.poll(() => lastWindowTitle(page)).toBe('新包.textbundle')
})

test('X-54 文件编码:外壳识别出的编码(GB18030)记在文档上,编辑后保存按原编码交给外壳写回', async ({ page }) => {
  await page.evaluate(() => {
    const host = window.typozaTest!.host
    const read = host.readText.bind(host)
    host.readText = async (path, encoding) => {
      const r = await read(path, encoding)
      // 内存宿主总按 UTF-8 读;这里模拟外壳把这篇识别成 GB18030
      return path === '/demo/旧编码.md' ? { ...r, encoding: encoding ?? 'gb18030' } : r
    }
    const write = host.writeText.bind(host)
    host.writeText = async (path, text, encoding) => {
      host.calls.push({ method: 'writeTextEncoding', args: [path, encoding ?? null] })
      return write(path, text, encoding)
    }
  })
  await loadDoc(page, '# 旧编码\n\n内容\n', '/demo/旧编码.md')
  expect(await page.evaluate(() => window.typozaTest!.app.session.encoding)).toBe('gb18030')
  await page.keyboard.type('改')
  await expect.poll(() => hostCalls(page, 'writeTextEncoding'), { timeout: 5000 }).toContainEqual(['/demo/旧编码.md', 'gb18030'])
  expect(await fileText(page, '/demo/旧编码.md')).toBe('# 旧编码\n\n内容改\n')
})

test('X-58 新文件名建议:未命名文档首次保存,保存框的默认文件名取首个标题', async ({ page }) => {
  await openApp(page, '?empty')
  await page.locator('.tz-editor').click()
  await page.keyboard.type('# 周报')
  await expect(page.locator('.tz-editor h1')).toHaveText('周报')
  await runMenuCommand(page, 'file.save')
  await expect.poll(async () => (await hostCalls(page, 'saveDialog')).map((a) => (a[0] as { defaultName: string }).defaultName)).toEqual(['周报.md'])
  await expect.poll(() => fileText(page, '/Users/test/周报.md')).toBe('# 周报\n')
})

test('X-58 新文件名建议:首个标题不在第一行也取它;文件名里不能用的 / 和 : 换成 -', async ({ page }) => {
  // 用「重启后恢复的未命名草稿」造一篇带内容的未命名文档(草稿存在 sessionStorage,见 host/memory.ts)
  await page.addInitScript(() => {
    sessionStorage.setItem('typoza.drafts', JSON.stringify({ 'p4-draft': '前言\n\n## 周报: 10/23\n\n# 总结\n' }))
  })
  await openApp(page, '?empty')
  await expect(page.locator('.tz-editor h2')).toHaveText('周报: 10/23')
  expect(await currentPath(page)).toBeNull()
  await runMenuCommand(page, 'file.save')
  await expect.poll(async () => (await hostCalls(page, 'saveDialog')).map((a) => (a[0] as { defaultName: string }).defaultName)).toEqual(['周报- 10-23.md'])
})

// ---------- 图片与媒体 ----------

test('Z-01 选中图片后点工具条「查看大图」打开灯箱', async ({ page }) => {
  await loadDoc(page, '![表单](assets/form.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await page.locator('.tz-editor .tz-image-tool[title^="查看大图"]').click()
  await expect(page.locator('.tz-lightbox')).toBeVisible()
  await expect.poll(() => page.locator('.tz-lb-img').evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 5000 }).toBeGreaterThan(0)
})

test('Z-02 选中图片按 ⌘↩ 打开灯箱;带链接的图片双击放大,不跳转', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '![表单](assets/form.svg)\n')
  await page.locator('.tz-editor .tz-image img').click()
  await page.keyboard.press(`${mod}+Enter`)
  await expect(page.locator('.tz-lightbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.tz-lightbox')).toHaveCount(0)

  await loadDoc(page, '[![标识](assets/id.svg)](https://example.com/detail)\n', '/demo/带链接的图.md')
  await expect(page.locator('.tz-editor a[href="https://example.com/detail"] .tz-image')).toHaveCount(1)
  await page.locator('.tz-editor .tz-image').dblclick()
  await expect(page.locator('.tz-lightbox')).toBeVisible()
  await expect.poll(() => page.locator('.tz-lb-img').evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await hostCalls(page, 'openExternal')).toEqual([])
  expect(await currentPath(page)).toBe('/demo/带链接的图.md')
})

test('Z-03 扩展名为 .apng 与 .webp 的图片按动图处理:工具条显示暂停按钮', async ({ page }) => {
  // 内容用演示动图的字节;是否显示暂停按钮只看扩展名(views/image.ts ANIMATED)
  await page.evaluate(() => {
    const files = window.typozaTest!.host.files
    const gif = files.get('/demo/assets/anim.gif')
    if (!gif || gif.kind !== 'file') throw new Error('缺少演示动图')
    for (const name of ['动图.apng', '动图.webp']) files.set(`/demo/assets/${name}`, { kind: 'file', data: gif.data, mtime: Date.now() })
  })
  for (const src of ['assets/动图.apng', 'assets/动图.webp']) {
    await loadDoc(page, `<img src="${src}" alt="动图" width="120" height="120" />\n`)
    const image = page.locator('.tz-editor .tz-image')
    // 悬停即显示工具条(与选中时同一个)
    await image.hover()
    await expect(image.locator('.tz-image-tool', { hasText: '暂停' })).toBeVisible()
  }
})

test('Z-09 选中网络 PDF 按 ⌘↩ 交给浏览器打开(本机 PDF 才用「预览」)', async ({ page }) => {
  await loadDoc(page, '<iframe src="https://example.com/files/manual.pdf" width="100%" height="600"></iframe>\n')
  const media = page.locator('.tz-editor .tz-media')
  await expect(media).toHaveAttribute('data-kind', 'pdf')
  await media.hover()
  await media.locator('button[title="选中此块"]').click()
  await expect(media).toHaveClass(/ProseMirror-selectednode/)
  await page.keyboard.press(`${await modKey(page)}+Enter`)
  await expect.poll(() => hostCalls(page, 'openExternal')).toEqual([['https://example.com/files/manual.pdf']])
  expect(await hostCalls(page, 'openInPreview')).toEqual([])
})
