// 导出 HTML:克隆当前渲染结果(公式、图表已渲染),去掉编辑器界面元素,本机资源改成相对导出位置的路径。
// PDF、图像也用这份 HTML 由外壳离屏渲染;选项对应偏好「导出」页(对照表 PX-04 ~ PX-06)与「Markdown」页的 PM-23、PM-24。
import { dirname, relativePath } from '../core/paths'
import { escapeAttr, escapeHtml } from '../core/markdown/html'

export interface ExportHtmlOptions {
  title: string
  /** 导出文件路径;本机资源按它改写为相对路径(null 时写 file:// 绝对地址) */
  targetPath: string | null
  /** false = 「HTML(无样式)」 */
  withStyles: boolean
  /** 导出用主题(写到根节点 data-theme 上,主题样式随样式表一起带走) */
  theme: string
  dark: boolean
  /** 无样式 HTML 里公式的写法:MathML 或 LaTeX 源码(PM-23) */
  mathOutput: 'mathml' | 'latex'
  /** 保留大纲侧边栏(PX-05) */
  outline: boolean
  /** 每个一级标题另起一页(PX-04,PDF 用) */
  h1PageBreak: boolean
  /** 保留连续空格与单个换行(PM-24) */
  preserveWhitespace: boolean
  /** 覆盖正文字号(图片导出 PX-06);null = 跟随主题 */
  fontSize: number | null
  /** 追加到 <head> / <body> 末尾的原样 HTML(PX-04、PX-05、YAML append-head / append-body) */
  appendHead: string
  appendBody: string
  author: string
  /** 导出主题与当前主题不同:不带当前自定义主题的样式 */
  excludeUserTheme: boolean
}

const DEFAULTS: Omit<ExportHtmlOptions, 'title' | 'targetPath' | 'withStyles'> = {
  theme: 'github',
  dark: false,
  mathOutput: 'mathml',
  outline: false,
  h1PageBreak: false,
  preserveWhitespace: false,
  fontSize: null,
  appendHead: '',
  appendBody: '',
  author: '',
  excludeUserTheme: false,
}

function collectCss(excludeUserTheme: boolean): string {
  const out: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    if (excludeUserTheme && sheet.ownerNode instanceof Element && sheet.ownerNode.id === 'tz-user-theme') continue
    try {
      for (const rule of Array.from(sheet.cssRules)) out.push(rule.cssText)
    } catch {
      // 跨源样式表(不会出现在本应用里)读不了,跳过
    }
  }
  return out.join('\n')
}

function localPathFromUrl(url: string): string | null {
  if (!url.startsWith('typoza://local/')) return null
  try {
    return decodeURIComponent(url.slice('typoza://local'.length))
  } catch {
    return null
  }
}

// 编辑器专用元素:工具条、手柄、源码区、占位、HTML 注释(对照表 M-10「导出时隐藏」)、编辑时的 Markdown 标记
const EDITOR_ONLY = [
  '.tz-image-toolbar',
  '.tz-image-handle',
  '.tz-media-toolbar',
  '.tz-code-header',
  '.tz-toggle-btn',
  '.ProseMirror-gapcursor',
  '.tz-frontmatter',
  '.tz-html-source',
  '.ProseMirror-separator',
  '.ProseMirror-trailingBreak',
  '.tz-html-block.is-comment',
  '.tz-html-comment',
  '.tz-md-marker',
  '.tz-math-block.is-empty',
  '.tz-math-inline.is-empty',
].join(', ')

const EDITOR_CLASSES = ['tz-placeholder', 'tz-focused', 'is-editing', 'ProseMirror-selectednode', 'tz-focus-mode', 'tz-typewriter-mode']

/** 公式:有样式时保留 KaTeX 渲染结果;无样式 HTML 按偏好写 MathML 或 LaTeX 源码(PM-23)。块级公式的源码取编辑区里的原文。 */
function convertMath(clone: HTMLElement, mode: 'mathml' | 'latex' | 'keep'): void {
  clone.querySelectorAll<HTMLElement>('.tz-math-block').forEach((block) => {
    const tex = block.querySelector('.tz-math-source')?.textContent ?? ''
    if (mode === 'keep') {
      block.querySelector('.tz-math-source')?.remove()
      return
    }
    const math = block.querySelector('.katex-mathml math')
    if (mode === 'mathml' && math) {
      math.setAttribute('display', 'block')
      block.replaceWith(math)
    } else {
      block.replaceWith(Object.assign(document.createElement('p'), { className: 'math-block', textContent: `$$\n${tex}\n$$` }))
    }
  })
  if (mode === 'keep') return
  clone.querySelectorAll<HTMLElement>('.tz-math-inline').forEach((el) => {
    const math = el.querySelector('.katex-mathml math')
    const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.textContent ?? ''
    if (mode === 'mathml' && math) {
      el.replaceWith(math)
    } else {
      el.replaceWith(Object.assign(document.createElement('span'), { className: 'math-inline', textContent: `$${tex}$` }))
    }
  })
}

/** 标题锚点:与 Typora 一致,小写、空白换成 -,去掉标点;重名加 -1、-2。 */
export function headingSlug(text: string, used: Map<string, number>): string {
  const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section'
  const n = used.get(base) ?? 0
  used.set(base, n + 1)
  return n === 0 ? base : `${base}-${n}`
}

/** 大纲侧边栏(PX-05):按标题层级缩进的锚点列表。 */
function buildOutline(clone: HTMLElement): string {
  const used = new Map<string, number>()
  const items: string[] = []
  clone.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach((h) => {
    if (!h.id) h.id = headingSlug(h.textContent ?? '', used)
    const level = Number(h.tagName.slice(1))
    items.push(`<li class="tz-outline-h${level}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.textContent ?? '')}</a></li>`)
  })
  return `<nav class="tz-export-outline"><ul>${items.join('')}</ul></nav>`
}

const OUTLINE_CSS = `
.tz-export-outline { position: fixed; top: 0; left: 0; bottom: 0; width: 240px; overflow: auto; padding: 24px 12px; border-right: 1px solid var(--tz-border, #e9e9e7); font-size: 13px; box-sizing: border-box; }
.tz-export-outline ul { list-style: none; margin: 0; padding: 0; }
.tz-export-outline a { color: inherit; text-decoration: none; display: block; padding: 3px 6px; border-radius: 4px; }
.tz-export-outline a:hover { background: rgba(127, 127, 127, 0.12); }
${[2, 3, 4, 5, 6].map((l) => `.tz-export-outline .tz-outline-h${l} { padding-left: ${(l - 1) * 12}px; }`).join('\n')}
body.has-outline #write { margin-left: 280px; }
@media print { .tz-export-outline { display: none; } body.has-outline #write { margin-left: auto; } }
`

/** 生成可独立打开的 HTML。 */
export function buildExportHtml(editorDom: HTMLElement, partial: Partial<ExportHtmlOptions> & Pick<ExportHtmlOptions, 'title' | 'targetPath' | 'withStyles'>): string {
  const o: ExportHtmlOptions = { ...DEFAULTS, ...partial }
  const clone = editorDom.cloneNode(true) as HTMLElement
  clone.removeAttribute('contenteditable')
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  convertMath(clone, o.withStyles ? 'keep' : o.mathOutput)
  clone.querySelectorAll(EDITOR_ONLY).forEach((el) => el.remove())
  for (const cls of EDITOR_CLASSES) clone.querySelectorAll(`.${cls}`).forEach((el) => el.classList.remove(cls))
  clone.querySelectorAll('[data-placeholder]').forEach((el) => el.removeAttribute('data-placeholder'))
  // HTML 块预览里去掉的 class、id 导出时还原(对照表 X-44;原值由 views/blocks.ts 的净化暂存)
  clone.querySelectorAll<HTMLElement>('[data-tz-class], [data-tz-id]').forEach((el) => {
    const cls = el.getAttribute('data-tz-class')
    const id = el.getAttribute('data-tz-id')
    if (cls !== null) el.setAttribute('class', cls)
    if (id !== null) el.setAttribute('id', id)
    el.removeAttribute('data-tz-class')
    el.removeAttribute('data-tz-id')
  })
  // 智能标点「渲染时转换」:导出成真正的弯引号与破折号
  clone.querySelectorAll<HTMLElement>('.tz-smart').forEach((el) => el.replaceWith(el.dataset.smart ?? el.textContent ?? ''))
  // 代码块:CodeMirror → 普通 <pre><code>
  clone.querySelectorAll<HTMLElement>('.tz-code-block').forEach((block) => {
    const lang = block.dataset.language ?? ''
    const lines = Array.from(block.querySelectorAll('.cm-line')).map((l) => l.textContent ?? '')
    const diagram = block.querySelector('.tz-diagram-preview')
    if (diagram && block.classList.contains('is-diagram')) {
      block.replaceWith(Object.assign(document.createElement('div'), { className: 'tz-diagram', innerHTML: diagram.innerHTML }))
      return
    }
    const pre = document.createElement('pre')
    const code = document.createElement('code')
    if (lang) code.className = `language-${lang}`
    code.textContent = lines.join('\n')
    pre.append(code)
    block.replaceWith(pre)
  })
  // 本机资源:改成相对导出文件的路径
  const base = o.targetPath ? dirname(o.targetPath) : null
  clone.querySelectorAll<HTMLElement>('[src]').forEach((el) => {
    const local = localPathFromUrl(el.getAttribute('src') ?? '')
    if (local) el.setAttribute('src', base ? relativePath(base, local) : `file://${local}`)
  })
  const outline = o.outline ? buildOutline(clone) : ''
  const extraCss = [
    o.outline ? OUTLINE_CSS : '',
    o.h1PageBreak ? '#write > h1 { break-before: page; } #write > h1:first-child { break-before: auto; }' : '',
    o.preserveWhitespace ? '#write p, #write li, #write td, #write th { white-space: pre-wrap; }' : '',
    o.fontSize ? `:root { --tz-font-size: ${o.fontSize}px; }` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const css = o.withStyles ? `<style>\n${collectCss(o.excludeUserTheme)}\n${extraCss}\n</style>` : extraCss ? `<style>\n${extraCss}\n</style>` : ''
  const htmlAttrs = [`lang="zh-CN"`, o.withStyles ? `data-theme="${escapeAttr(o.theme)}"` : '', o.withStyles && o.dark ? 'class="tz-dark"' : ''].filter(Boolean).join(' ')
  const meta = o.author ? `\n<meta name="author" content="${escapeAttr(o.author)}">` : ''
  return `<!doctype html>
<html ${htmlAttrs}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${meta}
<title>${escapeHtml(o.title)}</title>
${css}${o.appendHead ? `\n${o.appendHead}` : ''}
</head>
<body class="tz-export${o.outline ? ' has-outline' : ''}">
${outline}<div id="write" class="tz-editor">
${clone.innerHTML}
</div>${o.appendBody ? `\n${o.appendBody}` : ''}
</body>
</html>
`
}
