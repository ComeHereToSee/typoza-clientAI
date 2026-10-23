// 对照表(docs/prd/typora-parity.md)里缺单测证据的偏好项:PE-07 新文件换行符、PM-06 关掉内联公式、PM-20 公式内换行开关、
// PM-24 导出时的空白处理,以及导出流程的 PX-01 默认导出文件夹、PX-03 导出后动作、PX-07 / PX-08 交给外壳的 Pandoc 选项、
// PX-10 YAML 覆盖、PX-11 自定义命令导出。外壳拿到 Pandoc 选项后怎么拼命令行见 app/Tests/TypozaKitTests/ParityPandocTests.swift。
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentSession } from '../../src/app/document'
import { type ExportContext, MARKDOWN_VARIANTS, newExportItem, runExport } from '../../src/app/export-flow'
import { type AppSettings, DEFAULT_SETTINGS, type ExportItem } from '../../src/app/settings'
import { parseMarkdown } from '../../src/core/markdown/parse'
import { serializeMarkdown } from '../../src/core/markdown/serialize'
import { schema } from '../../src/core/schema'
import { createMemoryHost, type MemoryHost } from '../../src/host/memory'
import { texToMathML } from '../../src/views/katex'

const para = (text: string) => schema.nodes.paragraph.create(null, schema.text(text))
const docOf = (blocks: PMNode[]) => schema.nodes.doc.create(null, blocks)

function fileText(host: MemoryHost, path: string): string | null {
  const e = host.files.get(path)
  if (!e || e.kind !== 'file') return null
  return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
}

function count(doc: PMNode, type: string): number {
  let n = 0
  doc.descendants((node) => {
    if (node.type.name === type) n++
  })
  return n
}

const argsOf = (host: MemoryHost, method: string) => host.calls.filter((c) => c.method === method).map((c) => c.args)

/** 编辑区的渲染结果:导出 HTML / PDF 时克隆它。段落里有连续空格与单个换行(PM-24 用)。 */
function editorDom(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'write'
  el.className = 'tz-editor'
  el.innerHTML = '<p>甲  乙\n丙</p>'
  return el
}

/** 导出上下文:文档 /n/周报.md,frontMatter 为文档 YAML 原文。 */
function setup(patch: Partial<AppSettings> = {}, frontMatter: string | null = null) {
  const host = createMemoryHost()
  host.files.set('/n', { kind: 'dir', mtime: 1 })
  const toasts: string[] = []
  const settings: AppSettings = { ...DEFAULT_SETTINGS, exportHistory: {}, exportItems: [], ...patch }
  const ctx: ExportContext = {
    host,
    settings,
    systemDark: false,
    view: { dom: editorDom() } as unknown as EditorView,
    docPath: '/n/周报.md',
    markdown: '# 周报\n',
    fallbackName: '周报',
    frontMatter,
    update: async (next) => {
      Object.assign(settings, next)
    },
    toast: (m) => toasts.push(m),
  }
  return { host, ctx, toasts, settings }
}

// 「显示命令行输出」弹的是挂在 body 上的面板,每个用例后清掉
afterEach(() => {
  for (const el of document.querySelectorAll('.tz-modal')) el.remove()
})

describe('PE-07 新文件默认换行符', () => {
  it('PE-07 选 CRLF 时新建的文档按 \\r\\n 写盘;默认 LF', async () => {
    expect(DEFAULT_SETTINGS.defaultLineEnding).toBe('lf')
    for (const [ending, expected] of [
      ['crlf', '第一行\r\n\r\n第二行\r\n'],
      ['lf', '第一行\n\n第二行\n'],
    ] as const) {
      const host = createMemoryHost()
      const settings: AppSettings = { ...DEFAULT_SETTINGS, defaultLineEnding: ending }
      const session = new DocumentSession(host, () => settings)
      // 新窗口 / 新文档都从 createEmpty 开始(app.ts init、onPathTrashed)
      session.createEmpty()
      await session.save(docOf([para('第一行'), para('第二行')]), '/n/新建.md')
      expect(fileText(host, '/n/新建.md'), ending).toBe(expected)
    }
  })

  it('PE-07 打开的已有文件保持原换行符,不跟偏好走', async () => {
    const host = createMemoryHost()
    const settings: AppSettings = { ...DEFAULT_SETTINGS, defaultLineEnding: 'crlf' }
    const session = new DocumentSession(host, () => settings)
    host.files.set('/n/旧.md', { kind: 'file', data: 'a\n\nb\n', mtime: 1 })
    const loaded = await session.load('/n/旧.md')
    // 末尾加一段新内容再存:新段落也用文件原来的 LF
    await session.save(docOf([...loaded.content.content, para('新段')]))
    expect(fileText(host, '/n/旧.md')).toBe('a\n\nb\n\n新段\n')
  })
})

describe('PM-06 内联公式开关', () => {
  it('PM-06 关掉内联公式:$…$ 按普通文字解析并原样写回;所在段落被编辑过也不加转义', () => {
    const md = '单价 $5$ 与变量 $y$\n'
    expect(DEFAULT_SETTINGS.inlineMath).toBe(true)
    expect(count(parseMarkdown(md, { inlineMath: true }).doc, 'math_inline')).toBe(2)

    const { doc, meta } = parseMarkdown(md, { inlineMath: false })
    expect(count(doc, 'math_inline')).toBe(0)
    expect(doc.textContent).toBe('单价 $5$ 与变量 $y$')
    const options = { inlineMath: false, ensureTrailingNewline: true }
    expect(serializeMarkdown(doc, meta, options)).toBe(md)
    // 重新生成(编辑过)的段落:单个 $ 后面不是 $ 时不转义(mdast-util-math 的 singleDollarTextMath: false)
    expect(serializeMarkdown(schema.nodeFromJSON(doc.toJSON()), meta, options)).toBe(md)
  })
})

describe('PM-20 公式内换行开关', () => {
  it('PM-20 块公式里的 \\\\ 与 \\newline:开着时换行;关掉后不换行,也不报错', async () => {
    expect(DEFAULT_SETTINGS.mathLineBreak).toBe(true)
    const tex = 'a \\\\ b \\newline c'
    const on = await texToMathML(tex, true, { autoNumber: 'none', physics: false, lineBreak: true })
    expect(on.match(/linebreak="newline"/g)).toHaveLength(2)
    // 关掉时 KaTeX 按 LaTeX 规则处理:块公式顶层的 \\ 不换行(views/katex.ts 的 strict 回调)
    const off = await texToMathML(tex, true, { autoNumber: 'none', physics: false, lineBreak: false })
    expect(off).not.toContain('linebreak')
    expect(off).toContain('<mi>c</mi>')
  })
})

describe('PM-24 导出时的连续空格与单个换行', () => {
  // exporter.ts 选「保留」时追加的样式;「忽略」时导出页的 #write 是 white-space: normal(themes.css)
  const PRESERVE_CSS = '#write p, #write li, #write td, #write th { white-space: pre-wrap; }'

  it('PM-24 默认「忽略」:导出的 HTML 与 PDF 不保留空白;选「保留」后加上 pre-wrap', async () => {
    expect(DEFAULT_SETTINGS.exportWhitespace).toBe('ignore')
    for (const [whitespace, kept] of [
      ['ignore', false],
      ['preserve', true],
    ] as const) {
      const { host, ctx } = setup({ exportWhitespace: whitespace })
      await runExport(ctx, 'html', 'new')
      const html = fileText(host, '/n/周报.html') ?? ''
      expect(html).toContain('甲  乙\n丙')
      expect(html.includes(PRESERVE_CSS), `HTML ${whitespace}`).toBe(kept)

      // PDF 用同一份 HTML 由外壳离屏渲染;内存宿主只存 HTML 导出的内容,这里截下请求
      const pdf: string[] = []
      host.exportDocument = async (req) => {
        pdf.push(req.html)
      }
      await runExport(ctx, 'pdf', 'new')
      expect(pdf).toHaveLength(1)
      expect(pdf[0].includes(PRESERVE_CSS), `PDF ${whitespace}`).toBe(kept)
    }
  })
})

describe('PX-01 默认导出文件夹', () => {
  const history = { '/n/周报.md': { format: 'docx', target: '/out/上次/周报.docx' } }

  it('PX-01「自动」:导出过之后沿用这篇文档上一次导出的位置', async () => {
    const { host, ctx } = setup({ exportFolder: 'auto', exportHistory: { ...history } })
    await runExport(ctx, 'epub', 'new')
    expect(argsOf(host, 'saveDialog')).toEqual([[{ defaultName: '周报.epub', extensions: ['epub'], directory: '/out/上次' }]])
  })

  it('PX-01「与原文件同一目录」:不管上次导出到哪,都用文档所在文件夹', async () => {
    const { host, ctx } = setup({ exportFolder: 'same', exportHistory: { ...history } })
    await runExport(ctx, 'epub', 'new')
    expect(argsOf(host, 'saveDialog')[0][0]).toMatchObject({ directory: '/n' })
  })

  it('PX-01「自定义」:用指定的文件夹', async () => {
    const { host, ctx } = setup({ exportFolder: 'custom', exportCustomFolder: '/导出', exportHistory: { ...history } })
    await runExport(ctx, 'epub', 'new')
    expect(argsOf(host, 'saveDialog')[0][0]).toMatchObject({ directory: '/导出' })
    expect(argsOf(host, 'exportDocument').map((a) => a[1])).toEqual(['/导出/周报.epub'])
  })
})

describe('PX-03 导出后动作', () => {
  it('PX-03「打开导出文件」:导出后用默认应用打开导出的文件', async () => {
    const { host, ctx } = setup({ exportAfter: 'openFile' })
    await runExport(ctx, 'docx', 'new')
    expect(argsOf(host, 'openWithDefaultApp')).toEqual([['/n/周报.docx']])
    expect(argsOf(host, 'revealInFinder')).toEqual([])
  })

  it('PX-03 运行自定义命令并「显示命令行输出」:弹出命令输出,没输出时写明;不勾选不弹', async () => {
    const run = async (show: boolean, output: string) => {
      const env = setup({ exportAfter: 'command', exportAfterCommand: 'upload "${outputPath}"', exportShowCommandOutput: show })
      env.host.runCommand = async (command, cwd) => {
        env.host.calls.push({ method: 'runCommand', args: [command, cwd] })
        return { status: 0, output }
      }
      await runExport(env.ctx, 'docx', 'new')
      return argsOf(env.host, 'runCommand')
    }
    // 命令在导出文件所在文件夹执行
    expect(await run(false, '已上传\n')).toEqual([['upload "/n/周报.docx"', '/n']])
    expect(document.querySelector('.tz-modal')).toBeNull()

    await run(true, '已上传\n')
    expect(document.querySelector('.tz-modal h2')?.textContent).toBe('命令输出')
    expect(document.querySelector('.tz-modal .tz-command-output')?.textContent).toBe('已上传\n')
    document.querySelector('.tz-modal')?.remove()

    await run(true, '  \n')
    expect(document.querySelector('.tz-modal .tz-command-output')?.textContent).toBe('(命令没有输出)')
  })
})

describe('PX-07 / PX-08 交给外壳的 Pandoc 选项', () => {
  it('PX-07 Word 样式参考文件只给 docx,Epub 样式表与目录层级只给 epub;额外参数都带上', async () => {
    const { host, ctx } = setup({
      exportPandocArgs: '--number-sections',
      exportWordReferenceDoc: '/样式/公司模板.docx',
      exportEpubCss: '/样式/epub.css',
      exportEpubTocDepth: 2,
    })
    await runExport(ctx, 'docx', 'new')
    await runExport(ctx, 'epub', 'new')
    expect(argsOf(host, 'exportDocument')).toEqual([
      ['docx', '/n/周报.docx', { args: '--number-sections', referenceDoc: '/样式/公司模板.docx', css: '', tocDepth: 0, title: '周报', author: '' }],
      ['epub', '/n/周报.epub', { args: '--number-sections', referenceDoc: '', css: '/样式/epub.css', tocDepth: 2, title: '周报', author: '' }],
    ])
  })

  it('PX-07 「PDF(LaTeX)」导出项:所选 PDF 引擎随导出项交给外壳', async () => {
    const item: ExportItem = { ...newExportItem('pandoc-pdf'), id: 'tex', pdfEngine: 'lualatex' }
    const { host, ctx } = setup({ exportItems: [item] })
    await runExport(ctx, 'item:tex', 'new')
    expect(argsOf(host, 'exportDocument')).toEqual([['pandoc', '/n/周报.pdf', { to: 'pdf', args: '', title: '周报', author: '', pdfEngine: 'lualatex' }]])
  })

  it('PX-08「Markdown(其他规范)」导出项:七种变体可选;所选变体、每行字符数、换行符、引用式链接、只用 ASCII 交给外壳', async () => {
    expect(MARKDOWN_VARIANTS.map((v) => v.value)).toEqual(['markdown', 'markdown_phpextra', 'markdown_mmd', 'markdown_strict', 'commonmark', 'gfm', 'commonmark_x'])
    const item: ExportItem = { ...newExportItem('markdown'), id: 'mmd', to: 'markdown_mmd', ext: 'mmd', columns: 72, eol: 'crlf', referenceLinks: true, ascii: true }
    const { host, ctx } = setup({ exportItems: [item] })
    await runExport(ctx, 'item:mmd', 'new')
    expect(argsOf(host, 'exportDocument')).toEqual([
      ['pandoc', '/n/周报.mmd', { to: 'markdown_mmd', args: '', title: '周报', author: '', columns: 72, eol: 'crlf', referenceLinks: true, ascii: true }],
    ])
  })
})

describe('PX-10 YAML front matter 覆盖导出设置', () => {
  const yaml = 'title: 年报\nauthor: 小红\nheader: 第 ${pageNo} 页 · ${title}\nappend-head: <meta name="source" content="yaml">'

  it('PX-10 默认允许覆盖:title / author 进导出参数,header 换掉页首设置,append-head 进导出的 HTML', async () => {
    expect(DEFAULT_SETTINGS.exportYamlOverride).toBe(true)
    const { host, ctx } = setup({ exportPdfHeader: '${title}', exportPdfAuthor: '编辑部' }, yaml)
    await runExport(ctx, 'docx', 'new')
    await runExport(ctx, 'pdf', 'new')
    await runExport(ctx, 'html', 'new')
    const [docx, pdf] = argsOf(host, 'exportDocument')
    expect(docx[2]).toMatchObject({ title: '年报', author: '小红' })
    // ${pageNo} 由外壳逐页替换,这里原样保留
    expect(pdf[2]).toMatchObject({ header: '第 ${pageNo} 页 · 年报', title: '年报', author: '小红' })
    const html = fileText(host, '/n/周报.html') ?? ''
    expect(html).toContain('<title>年报</title>')
    expect(html).toContain('<meta name="author" content="小红">')
    expect(html).toContain('<meta name="source" content="yaml">')
  })

  it('PX-10 关掉「允许 YAML front matter 覆盖当前设置」:文档 YAML 不影响导出,用偏好里的值', async () => {
    const { host, ctx } = setup({ exportYamlOverride: false, exportPdfHeader: '${title}', exportPdfAuthor: '编辑部' }, yaml)
    await runExport(ctx, 'docx', 'new')
    await runExport(ctx, 'pdf', 'new')
    await runExport(ctx, 'html', 'new')
    const [docx, pdf] = argsOf(host, 'exportDocument')
    expect(docx[2]).toMatchObject({ title: '周报', author: '编辑部' })
    expect(pdf[2]).toMatchObject({ header: '周报', title: '周报', author: '编辑部' })
    const html = fileText(host, '/n/周报.html') ?? ''
    expect(html).toContain('<title>周报</title>')
    expect(html).not.toContain('<meta name="source" content="yaml">')
  })
})

describe('PX-11 自定义命令导出', () => {
  const commandItem = (patch: Partial<ExportItem>): ExportItem => ({ ...newExportItem('command'), id: 'cmd', name: '发布', ...patch })

  it('PX-11 执行前弹出「选择文件」:保存框按目标扩展名给默认文件名,${outputPath} 为所选文件', async () => {
    const { host, ctx, toasts } = setup({ exportItems: [commandItem({ dialog: 'file', ext: 'pdf', command: 'conv "${currentPath}" -o "${outputPath}"' })] })
    await runExport(ctx, 'item:cmd', 'new')
    expect(argsOf(host, 'saveDialog')).toEqual([[{ defaultName: '周报.pdf', extensions: ['pdf'], directory: '/n' }]])
    expect(argsOf(host, 'openDialog')).toEqual([])
    expect(argsOf(host, 'runCommand')).toEqual([['conv "/n/周报.md" -o "/n/周报.pdf"', '/n']])
    expect(toasts).toEqual(['导出成功'])
  })

  it('PX-11 执行前弹出「选择文件夹」:${outputPath} 为所选文件夹;在选择框里取消就不执行', async () => {
    const { host, ctx, toasts } = setup({ exportItems: [commandItem({ dialog: 'folder', command: 'publish --to "${outputPath}"' })] })
    host.dialogQueue.push(['/站点/发布'])
    await runExport(ctx, 'item:cmd', 'new')
    expect(argsOf(host, 'openDialog')).toEqual([[{ directory: true }]])
    expect(argsOf(host, 'saveDialog')).toEqual([])
    expect(argsOf(host, 'runCommand')).toEqual([['publish --to "/站点/发布"', '/n']])
    // 第二次:对话框队列已取空,宿主返回 null,相当于取消
    await runExport(ctx, 'item:cmd', 'new')
    expect(argsOf(host, 'openDialog')).toHaveLength(2)
    expect(argsOf(host, 'runCommand')).toHaveLength(1)
    expect(toasts).toEqual(['导出成功'])
  })

  it('PX-11 不弹选择框:直接执行,${outputPath} 为空', async () => {
    const { host, ctx } = setup({ exportItems: [commandItem({ dialog: 'none', command: 'sync "${currentPath}" "${outputPath}"' })] })
    await runExport(ctx, 'item:cmd', 'new')
    expect(argsOf(host, 'openDialog')).toEqual([])
    expect(argsOf(host, 'saveDialog')).toEqual([])
    expect(argsOf(host, 'runCommand')).toEqual([['sync "/n/周报.md" ""', '/n']])
  })

  it('PX-11 勾选「显示命令行输出」:执行后弹出命令输出;不勾选不弹', async () => {
    const run = async (showOutput: boolean) => {
      const { host, ctx } = setup({ exportItems: [commandItem({ dialog: 'none', command: 'publish', showOutput })] })
      host.runCommand = async () => ({ status: 0, output: '已发布 3 篇\n' })
      await runExport(ctx, 'item:cmd', 'new')
    }
    await run(false)
    expect(document.querySelector('.tz-modal')).toBeNull()
    await run(true)
    expect(document.querySelector('.tz-modal h2')?.textContent).toBe('命令输出')
    expect(document.querySelector('.tz-modal .tz-command-output')?.textContent).toBe('已发布 3 篇\n')
  })
})
