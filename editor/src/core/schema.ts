// 文档模型。一个节点类型对应一种 Markdown 结构;Notion 式的块(折叠块、标注块、媒体)落成标准 Markdown 或通用 HTML,
// 对应关系见 markdown/parse.ts 与 markdown/serialize.ts。
import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema } from 'prosemirror-model'
import { tableNodes } from 'prosemirror-tables'

/**
 * 地址是否指向 PDF:只看路径,不看 ? 与 # 之后。`x.html#.pdf` 不算——PDF 框不加沙箱(要用系统的 PDF 显示),
 * 若按整串判断,本地网页就能借它绕开嵌入沙箱。
 */
export function isPdfSource(src: string): boolean {
  // 只认网址与本机路径:data: / blob: 等内容由地址自己决定,`data:text/html,….pdf` 也会以网页运行
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1].toLowerCase()
  if (scheme && !['http', 'https', 'file', 'typoza'].includes(scheme)) return false
  return /\.pdf$/i.test(src.replace(/[?#][\s\S]*$/, ''))
}

export type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'
export const CALLOUT_KINDS: CalloutKind[] = ['note', 'tip', 'important', 'warning', 'caution']

export type MediaKind = 'video' | 'audio' | 'embed' | 'pdf' | 'bookmark' | 'file'

function dataAttr(dom: HTMLElement, name: string): string | null {
  const v = dom.getAttribute(`data-${name}`)
  return v === null || v === '' ? null : v
}

function numAttr(dom: HTMLElement, name: string): number | null {
  const v = dom.getAttribute(name)
  if (v === null || v === '') return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'frontmatter? block+' },

  // YAML front matter:只能在文首,永远不从粘贴创建
  frontmatter: {
    content: 'text*',
    marks: '',
    code: true,
    defining: true,
    isolating: true,
    selectable: true,
    toDOM: () => ['pre', { class: 'tz-frontmatter' }, ['code', 0]],
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: () => ['p', 0],
  },

  heading: {
    attrs: { level: { default: 1, validate: 'number' } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } })),
    toDOM: (node) => [`h${node.attrs.level}`, 0],
  },

  blockquote: {
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM: () => ['blockquote', 0],
  },

  // GitHub 提示框 `> [!NOTE] 标题`;title 保留标记后同一行的文字(Obsidian 兼容)
  callout: {
    attrs: { kind: { default: 'note' }, title: { default: '' } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [
      {
        tag: 'div.tz-callout',
        getAttrs: (dom) => ({ kind: dataAttr(dom, 'kind') ?? 'note', title: dataAttr(dom, 'title') ?? '' }),
        contentElement: '.tz-callout-body',
      },
    ],
    toDOM: (node) => [
      'div',
      { class: `tz-callout tz-callout-${node.attrs.kind}`, 'data-kind': node.attrs.kind, 'data-title': node.attrs.title },
      ['div', { class: 'tz-callout-body' }, 0],
    ],
  },

  // 折叠块 <details>:open 是界面状态(不入文件);openInSource 记录原文是否写了 open,保存时原样写回
  toggle: {
    attrs: { open: { default: true }, openInSource: { default: false } },
    content: 'toggle_summary block*',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'details', getAttrs: (dom) => ({ open: true, openInSource: dom.hasAttribute('open') }) }],
    toDOM: (node) => ['div', { class: `tz-toggle${node.attrs.open ? ' is-open' : ''}` }, 0],
  },

  // level>0 是折叠标题(Notion 的 Toggle heading),存为 <summary><h2>…</h2></summary>
  toggle_summary: {
    attrs: { level: { default: 0 } },
    content: 'inline*',
    defining: true,
    parseDOM: [
      {
        tag: 'summary',
        getAttrs: (dom) => {
          const hd = dom.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')
          return { level: hd ? Number(hd.tagName.slice(1)) : 0 }
        },
        contentElement: (dom) => dom.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6') ?? dom,
      },
    ],
    toDOM: (node) => ['div', { class: `tz-toggle-summary${node.attrs.level ? ` tz-toggle-h${node.attrs.level}` : ''}` }, 0],
  },

  bullet_list: {
    attrs: { tight: { default: true } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (node) => ['ul', { class: node.attrs.tight ? 'tz-tight' : null }, 0],
  },

  ordered_list: {
    attrs: { start: { default: 1 }, tight: { default: true } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ol', getAttrs: (dom) => ({ start: numAttr(dom, 'start') ?? 1 }) }],
    toDOM: (node) => [
      'ol',
      { start: node.attrs.start === 1 ? null : node.attrs.start, class: node.attrs.tight ? 'tz-tight' : null },
      0,
    ],
  },

  // checked: null = 普通列表项;true/false = 任务项(GFM `- [ ]`,Notion 的待办)
  // 列表项第一块可以不是段落(如直接以代码块开头,CommonMark 允许),所以是 block+ 而不是 paragraph block*
  list_item: {
    attrs: { checked: { default: null } },
    content: 'block+',
    defining: true,
    parseDOM: [
      {
        tag: 'li',
        getAttrs: (dom) => {
          const c = dom.getAttribute('data-checked')
          if (c === 'true') return { checked: true }
          if (c === 'false') return { checked: false }
          const box = dom.querySelector(':scope > input[type=checkbox]')
          return { checked: box ? (box as HTMLInputElement).checked : null }
        },
      },
    ],
    toDOM: (node) =>
      node.attrs.checked === null
        ? ['li', 0]
        : ['li', { class: 'tz-task', 'data-checked': String(node.attrs.checked) }, 0],
  },

  code_block: {
    attrs: { language: { default: '' }, meta: { default: null } },
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [
      {
        tag: 'pre',
        preserveWhitespace: 'full',
        getAttrs: (dom) => {
          const fromData = dataAttr(dom, 'language')
          if (fromData) return { language: fromData }
          const cls = dom.querySelector('code')?.className ?? ''
          const m = /(?:^|\s)language-([\w+#-]+)/.exec(cls)
          return { language: m ? m[1] : '' }
        },
      },
    ],
    toDOM: (node) => ['pre', { 'data-language': node.attrs.language || null }, ['code', 0]],
  },

  math_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    parseDOM: [{ tag: 'div.tz-math-block', preserveWhitespace: 'full' }],
    toDOM: () => ['div', { class: 'tz-math-block' }, 0],
  },

  ...tableNodes({
    tableGroup: 'block',
    cellContent: 'inline*',
    cellAttributes: {
      align: {
        default: null,
        getFromDOM: (dom) => dom.style.textAlign || dom.getAttribute('align') || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `${(attrs.style as string | undefined) ?? ''}text-align: ${String(value)};`
        },
      },
    },
  }),

  horizontal_rule: {
    group: 'block',
    parseDOM: [{ tag: 'hr' }],
    toDOM: () => ['hr'],
  },

  // 原样保留的 HTML 块:渲染净化后的预览,光标进入时显示源码
  html_block: {
    content: 'text*',
    marks: '',
    group: 'block',
    code: true,
    defining: true,
    toDOM: () => ['div', { class: 'tz-html-block' }, ['pre', 0]],
  },

  // 媒体块:视频 / 音频 / 在线嵌入 / PDF / 书签卡片 / 附件。html 保存原文,未编辑时原样写回
  media: {
    attrs: {
      kind: { default: 'video' },
      src: { default: '' },
      title: { default: '' },
      width: { default: null },
      height: { default: null },
      html: { default: null },
      // 书签卡片的网页描述(存在 <a title="…">)
      description: { default: '' },
    },
    group: 'block',
    atom: true,
    selectable: true,
    draggable: true,
    parseDOM: [
      { tag: 'video[src]', getAttrs: (dom) => ({ kind: 'video', src: dom.getAttribute('src') }) },
      { tag: 'audio[src]', getAttrs: (dom) => ({ kind: 'audio', src: dom.getAttribute('src') }) },
      {
        tag: 'iframe[src]',
        getAttrs: (dom) => {
          const src = dom.getAttribute('src') ?? ''
          return { kind: isPdfSource(src) ? 'pdf' : 'embed', src, width: dom.getAttribute('width'), height: dom.getAttribute('height') }
        },
      },
      {
        tag: 'div.tz-media',
        getAttrs: (dom) => ({
          kind: dataAttr(dom, 'kind') ?? 'video',
          src: dataAttr(dom, 'src') ?? '',
          title: dataAttr(dom, 'title') ?? '',
        }),
      },
    ],
    toDOM: (node) => [
      'div',
      { class: 'tz-media', 'data-kind': node.attrs.kind, 'data-src': node.attrs.src, 'data-title': node.attrs.title },
    ],
  },

  // Typora 的 [TOC]
  toc: {
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'div.tz-toc' }],
    toDOM: () => ['div', { class: 'tz-toc' }],
  },

  footnote_def: {
    attrs: { label: { default: '' } },
    content: 'block+',
    group: 'block',
    defining: true,
    parseDOM: [
      { tag: 'div.tz-footnote-def', getAttrs: (dom) => ({ label: dataAttr(dom, 'label') ?? '' }), contentElement: '.tz-footnote-body' },
    ],
    toDOM: (node) => [
      'div',
      { class: 'tz-footnote-def', 'data-label': node.attrs.label },
      ['span', { class: 'tz-footnote-label', contenteditable: 'false' }, `[^${node.attrs.label}]:`],
      ['div', { class: 'tz-footnote-body' }, 0],
    ],
  },

  // 链接引用定义 `[id]: url "title"`
  definition: {
    attrs: { label: { default: '' }, url: { default: '' }, title: { default: null } },
    group: 'block',
    atom: true,
    selectable: true,
    toDOM: (node) => [
      'div',
      { class: 'tz-definition' },
      `[${node.attrs.label}]: ${node.attrs.url}${node.attrs.title ? ` "${node.attrs.title}"` : ''}`,
    ],
  },

  text: { group: 'inline' },

  // syntax:backslash(`\` 换行)/ spaces(行尾两空格)/ html(`<br>`,表格单元格里只能用它)
  hard_break: {
    attrs: { syntax: { default: 'backslash' } },
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM: () => ['br'],
  },

  // html=true 表示原文是 <img> 标签(带 width / zoom 等 Markdown 表达不了的属性);ref 表示引用式图片
  image: {
    attrs: {
      src: { default: '' },
      alt: { default: '' },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      zoom: { default: null },
      align: { default: null },
      html: { default: false },
      ref: { default: null },
      refType: { default: null },
    },
    inline: true,
    group: 'inline',
    draggable: true,
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs: (dom) => {
          const zoom = /zoom:\s*([\d.]+%?)/.exec(dom.getAttribute('style') ?? '')
          return {
            src: dom.getAttribute('data-tz-src') ?? dom.getAttribute('src'),
            alt: dom.getAttribute('alt') ?? '',
            title: dom.getAttribute('title'),
            width: dom.getAttribute('width'),
            height: dom.getAttribute('height'),
            zoom: zoom ? zoom[1] : null,
          }
        },
      },
    ],
    toDOM: (node) => ['img', { src: node.attrs.src, alt: node.attrs.alt, title: node.attrs.title }],
  },

  math_inline: {
    attrs: { tex: { default: '' } },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'span.tz-math-inline', getAttrs: (dom) => ({ tex: dataAttr(dom, 'tex') ?? dom.textContent ?? '' }) }],
    toDOM: (node) => ['span', { class: 'tz-math-inline', 'data-tex': node.attrs.tex }, node.attrs.tex],
  },

  footnote_ref: {
    attrs: { label: { default: '' } },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [{ tag: 'sup.tz-footnote-ref', getAttrs: (dom) => ({ label: dataAttr(dom, 'label') ?? '' }) }],
    toDOM: (node) => ['sup', { class: 'tz-footnote-ref', 'data-label': node.attrs.label }, node.attrs.label],
  },

  // 无法转成格式标记的行内 HTML(注释、<kbd> 等),原样保留
  html_inline: {
    attrs: { html: { default: '' } },
    inline: true,
    group: 'inline',
    atom: true,
    toDOM: (node) => ['span', { class: 'tz-html-inline' }, node.attrs.html],
  },

  // [[目标|别名]](Obsidian 风格,打开既有文件时识别;新插入的文档链接用标准相对链接)
  wikilink: {
    attrs: { target: { default: '' }, alias: { default: null } },
    inline: true,
    group: 'inline',
    atom: true,
    parseDOM: [
      { tag: 'a.tz-wikilink', getAttrs: (dom) => ({ target: dataAttr(dom, 'target') ?? '', alias: dataAttr(dom, 'alias') }) },
    ],
    toDOM: (node) => [
      'a',
      { class: 'tz-wikilink', 'data-target': node.attrs.target, 'data-alias': node.attrs.alias },
      node.attrs.alias ?? node.attrs.target,
    ],
  },
}

const ATTENTION = 'strong em strike underline highlight sup sub color'

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: {
      href: { default: '' },
      title: { default: null },
      ref: { default: null },
      refType: { default: null },
      autolink: { default: false },
    },
    inclusive: false,
    parseDOM: [
      {
        tag: 'a[href]',
        getAttrs: (dom) =>
          dom.classList.contains('tz-wikilink') ? false : { href: dom.getAttribute('href'), title: dom.getAttribute('title') },
      },
    ],
    // 自动识别出的网址(显示文字就是链接地址)不做拼写检查(对照表 E-38)
    toDOM: (mark) => ['a', { href: mark.attrs.href, title: mark.attrs.title, rel: 'noopener noreferrer', spellcheck: mark.attrs.autolink ? 'false' : null }, 0],
  },

  strong: {
    parseDOM: [
      { tag: 'strong' },
      // Google Docs 等会用 <b style="font-weight:normal"> 包整段,不能当加粗
      { tag: 'b', getAttrs: (dom) => dom.style.fontWeight !== 'normal' && null },
      { style: 'font-weight=400', clearMark: (m) => m.type.name === 'strong' },
      { style: 'font-weight', getAttrs: (value) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null },
    ],
    toDOM: () => ['strong', 0],
  },

  em: {
    parseDOM: [
      { tag: 'i' },
      { tag: 'em' },
      { style: 'font-style=italic' },
      { style: 'font-style=normal', clearMark: (m) => m.type.name === 'em' },
    ],
    toDOM: () => ['em', 0],
  },

  // 行内代码里不能再有其它格式(Markdown 语义),但可以被链接包住
  code: {
    excludes: ATTENTION,
    code: true,
    parseDOM: [{ tag: 'code' }],
    // 行内代码不做拼写检查(对照表 E-38)
    toDOM: () => ['code', { spellcheck: 'false' }, 0],
  },

  strike: {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0],
  },

  underline: {
    parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
    toDOM: () => ['u', 0],
  },

  highlight: {
    parseDOM: [{ tag: 'mark' }],
    toDOM: () => ['mark', 0],
  },

  // syntax:html(新建时写 <sup>,通用)/ typora(打开的文件里是 ^x^,原样写回)
  sup: {
    attrs: { syntax: { default: 'html' } },
    excludes: 'sup sub',
    parseDOM: [{ tag: 'sup', getAttrs: (dom) => (dom.classList.contains('tz-footnote-ref') ? false : null) }],
    toDOM: () => ['sup', 0],
  },

  sub: {
    attrs: { syntax: { default: 'html' } },
    excludes: 'sup sub',
    parseDOM: [{ tag: 'sub' }],
    toDOM: () => ['sub', 0],
  },

  // 文字颜色 / 背景色(Notion 调色板),存为 <span style>。只从本应用复制出的内容识别,避免粘贴网页带进一堆颜色
  color: {
    attrs: { color: { default: null }, background: { default: null } },
    parseDOM: [
      {
        tag: 'span[data-tz-color]',
        getAttrs: (dom) => ({ color: dom.style.color || null, background: dom.style.backgroundColor || null }),
      },
    ],
    toDOM: (mark): DOMOutputSpec => {
      const style = [
        mark.attrs.color ? `color: ${mark.attrs.color}` : '',
        mark.attrs.background ? `background-color: ${mark.attrs.background}` : '',
      ]
        .filter(Boolean)
        .join('; ')
      return ['span', { style, 'data-tz-color': '' }, 0]
    },
  },
}

/** 段落里照样渲染的成对行内 HTML 标签(对照表 X-43);u、sup、sub、mark、s、b、i 与纯颜色 span 另有专门的格式标记 */
export const HTML_TAG_MARKS = new Set(['kbd', 'ruby', 'rb', 'rt', 'rp', 'small', 'big', 'abbr', 'cite', 'q', 'var', 'samp', 'dfn', 'bdi', 'bdo', 'time', 'span', 'font'])
/** 通用行内标签只保留这些属性:不带事件处理、class、id(与 HTML 块预览同一口径) */
const HTML_TAG_ATTRS = new Set(['style', 'title', 'lang', 'dir', 'color', 'face', 'size', 'datetime'])
const ATTR_RE = /\s([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g

function htmlTagAttrs(open: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of open.matchAll(ATTR_RE)) {
    const name = m[1].toLowerCase()
    if (!HTML_TAG_ATTRS.has(name)) continue
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    out[name] = name === 'style' ? withoutPositioning(value) : value
  }
  return out
}

/** 去掉定位与层级:行内标签没法像 HTML 块那样关在预览框里,带 position:fixed 就能盖住整个窗口仿冒界面 */
function withoutPositioning(style: string): string {
  return style
    .split(';')
    .filter((decl) => !/^\s*(position|z-index)\s*:/i.test(decl))
    .join(';')
}

marks.html_tag = {
  attrs: { tag: { default: 'span' }, open: { default: '<span>' } },
  // ruby 里套 rt:同一种标记可以叠多层
  excludes: '',
  inclusive: false,
  toDOM: (mark): DOMOutputSpec => [HTML_TAG_MARKS.has(mark.attrs.tag) ? mark.attrs.tag : 'span', htmlTagAttrs(mark.attrs.open), 0],
}

export const schema = new Schema({ nodes, marks })

/** Notion 调色板(浅色主题取值)。 */
export const NOTION_COLORS = [
  { name: 'gray', label: '灰色', color: '#787774', background: '#F1F1EF' },
  { name: 'brown', label: '棕色', color: '#9F6B53', background: '#F4EEEE' },
  { name: 'orange', label: '橙色', color: '#D9730D', background: '#FBECDD' },
  { name: 'yellow', label: '黄色', color: '#CB912F', background: '#FBF3DB' },
  { name: 'green', label: '绿色', color: '#448361', background: '#EDF3EC' },
  { name: 'blue', label: '蓝色', color: '#337EA9', background: '#E7F3F8' },
  { name: 'purple', label: '紫色', color: '#9065B0', background: '#F6F3F9' },
  { name: 'pink', label: '粉色', color: '#C14C8A', background: '#FAF1F5' },
  { name: 'red', label: '红色', color: '#D44C47', background: '#FDEBEC' },
] as const
