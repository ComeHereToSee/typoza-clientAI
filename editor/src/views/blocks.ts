// 其余块与行内节点的视图:折叠块、待办列表项、目录、HTML 块与行内 HTML、YAML、脚注引用、wikilink。
import DOMPurify from 'dompurify'
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import { collectHeadings } from '../core/blocks'
import { insertBlock, setToggleOpen } from '../core/commands'
import { type EditorEnv, frameSandbox, openImageLightbox, resourceUrl } from '../core/env'
import { openHref } from '../core/links'
import { schema } from '../core/schema'
import { ICONS, h, svgIcon } from '../ui/dom'

// ---------- 折叠块 ----------

export class ToggleView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    const button = h(
      'button',
      { type: 'button', class: 'tz-toggle-btn', contenteditable: 'false', title: '展开 / 收起(⌘↵)', tabindex: '-1' },
      svgIcon(ICONS.chevron, 14),
    )
    button.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos !== undefined) this.view.dispatch(setToggleOpen(this.view.state.tr, pos, !this.node.attrs.open))
    })
    this.contentDOM = h('div', { class: 'tz-toggle-content' })
    this.dom = h('div', { class: 'tz-toggle' }, button, this.contentDOM)
    this.sync()
  }

  private sync(): void {
    this.dom.classList.toggle('is-open', Boolean(this.node.attrs.open))
    this.dom.classList.toggle('is-empty-body', this.node.childCount <= 1)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.sync()
    return true
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return m.type === 'attributes' && m.target === this.dom
  }
}

// ---------- 列表项(待办带勾选框) ----------

export class ListItemView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
  ) {
    if (node.attrs.checked === null) {
      this.dom = this.contentDOM = h('li')
      return
    }
    const box = h('span', {
      class: 'tz-task-box',
      contenteditable: 'false',
      role: 'checkbox',
      'aria-checked': String(node.attrs.checked),
    })
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos !== undefined) this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { checked: !this.node.attrs.checked }))
    })
    this.contentDOM = h('div', { class: 'tz-task-content' })
    this.dom = h('li', { class: 'tz-task', 'data-checked': String(node.attrs.checked) }, box, this.contentDOM)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    // 普通项与待办之间切换时 DOM 结构不同,重建
    if ((node.attrs.checked === null) !== (this.node.attrs.checked === null)) return false
    this.node = node
    if (node.attrs.checked !== null) {
      this.dom.dataset.checked = String(node.attrs.checked)
      this.dom.querySelector('.tz-task-box')?.setAttribute('aria-checked', String(node.attrs.checked))
    }
    return true
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return m.type === 'attributes' && (m.target === this.dom || (m.target as HTMLElement).classList?.contains('tz-task-box'))
  }
}

// ---------- 目录 ----------

const tocViews = new Set<TocView>()

/** 文档变化后刷新所有目录块(目录依赖整篇文档,节点自身不变时不会收到 update)。 */
export function refreshTocs(): void {
  for (const v of tocViews) v.render()
}

export class TocView implements NodeView {
  dom: HTMLElement

  constructor(private readonly view: EditorView) {
    this.dom = h('nav', { class: 'tz-toc', contenteditable: 'false', 'aria-label': '目录' })
    tocViews.add(this)
    this.render()
  }

  render(): void {
    const headings = collectHeadings(this.view.state.doc)
    if (headings.length === 0) {
      this.dom.replaceChildren(h('div', { class: 'tz-toc-empty' }, '目录:文档里还没有标题'))
      return
    }
    const min = Math.min(...headings.map((x) => x.level))
    this.dom.replaceChildren(
      ...headings.map((item) => {
        const a = h('a', { class: `tz-toc-item tz-toc-l${item.level - min + 1}`, href: `#${item.id}` }, item.text || '(无标题)')
        a.addEventListener('click', (e) => {
          e.preventDefault()
          const tr = this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, item.pos + 1))
          this.view.dispatch(tr.scrollIntoView())
          this.view.focus()
        })
        return a
      }),
    )
  }

  stopEvent(e: Event): boolean {
    return e.type === 'click' || e.type === 'mousedown'
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    tocViews.delete(this)
  }
}

// ---------- HTML ----------

/** style、meta 不生效,换成显示其源码的 <code>(对照表 X-44:style、meta 只显示源码)。 */
export function showStyleAndMetaAsSource(html: string): string {
  if (!/<(style|meta)\b/i.test(html)) return html
  // <template> 里解析:<style>、<meta> 留在原位,不会像 DOMParser 那样被挪进 <head>
  const template = document.createElement('template')
  template.innerHTML = html
  for (const el of Array.from(template.content.querySelectorAll('style, meta'))) {
    const code = document.createElement('code')
    code.className = 'tz-html-raw'
    // 净化会去掉 class(见 sanitizeHtml),靠这个标记补回
    code.setAttribute('data-tz-raw', '')
    code.textContent = el.outerHTML
    el.replaceWith(code)
  }
  return template.innerHTML
}

/** class、id 在预览里不生效(对照表 X-44);原值暂存到 data-tz-class / data-tz-id,导出时还原(app/exporter.ts)。 */
function stashClassAndId(html: string): string {
  if (!/\s(?:class|id)\s*=/i.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const el of Array.from(template.content.querySelectorAll('[class], [id]'))) {
    if (el.hasAttribute('data-tz-raw')) continue
    const cls = el.getAttribute('class')
    const id = el.getAttribute('id')
    if (cls !== null) el.setAttribute('data-tz-class', cls)
    if (id !== null) el.setAttribute('data-tz-id', id)
  }
  return template.innerHTML
}

/** 净化并改写资源地址:本机图片、视频走 typoza://local/。 */
export function sanitizeHtml(html: string, env: EditorEnv): DocumentFragment {
  const fragment = DOMPurify.sanitize(stashClassAndId(showStyleAndMetaAsSource(html)), {
    RETURN_DOM_FRAGMENT: true,
    ADD_TAGS: ['iframe', 'video', 'audio', 'source', 'details', 'summary', 'kbd'],
    ADD_ATTR: ['allowfullscreen', 'frameborder', 'controls', 'loop', 'muted', 'playsinline', 'target', 'align'],
    FORBID_TAGS: ['script', 'style', 'object', 'embed', 'form'],
    // class、id 只在预览里去掉(源码保留,导出时由 data-tz-class / data-tz-id 还原,对照表 X-44):
    // 文档里的 class 会套上应用自己的样式,比如全屏遮罩类,能盖住界面仿冒对话框
    FORBID_ATTR: ['class', 'id'],
  })
  for (const el of Array.from(fragment.querySelectorAll('[data-tz-raw]'))) el.classList.add('tz-html-raw')
  for (const el of Array.from(fragment.querySelectorAll<HTMLElement>('img[src], video[src], audio[src], source[src], iframe[src]'))) {
    const src = el.getAttribute('src') ?? ''
    el.setAttribute('data-tz-src', src)
    const url = resourceUrl(env, src)
    el.setAttribute('src', url)
    if (el.tagName === 'IFRAME') el.setAttribute('sandbox', frameSandbox(url))
  }
  return fragment
}

export class HtmlBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private preview: HTMLDivElement
  private rendered: string | null = null

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly env: EditorEnv,
  ) {
    this.preview = h('div', { class: 'tz-html-preview', contenteditable: 'false' })
    this.contentDOM = h('pre', { class: 'tz-html-source', spellcheck: 'false' })
    this.dom = h('div', { class: 'tz-html-block' }, this.preview, this.contentDOM)
    this.preview.addEventListener('dblclick', (e) => {
      const img = (e.target as HTMLElement).closest('img')
      if (img) {
        e.preventDefault()
        openImageLightbox(this.view, this.env, { element: img })
      }
    })
    this.preview.addEventListener('mousedown', (e) => {
      if (!this.wantsSource(e)) return
      const pos = this.getPos()
      if (pos === undefined) return
      e.preventDefault()
      this.view.focus()
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)))
    })
    // ⌘+点击链接是展开源码,不跳转;普通点击按文档链接打开(对照表 X-45「点在链接上照常交互」)。
    // 不能交给页面自己跳:相对地址会把编辑器页面换成 typoza://app/<地址>
    this.preview.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a')
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href')
      if (!e.metaKey && href) openHref(this.view, this.env, href)
    })
    this.render()
  }

  private render(): void {
    const html = this.node.textContent
    if (html === this.rendered) return
    this.rendered = html
    const isComment = /^\s*<!--[\s\S]*-->\s*$/.test(html)
    this.dom.classList.toggle('is-comment', isComment)
    if (isComment) {
      this.preview.replaceChildren(h('span', { class: 'tz-html-comment' }, html.trim()))
      return
    }
    this.preview.replaceChildren(sanitizeHtml(html, this.env))
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  /**
   * 点击预览的空白处或 ⌘+点击才展开源码(对照表 X-45);点在文字、链接、图片、媒体上照常交互。
   * 注释块整块都是源码文字,单击即展开。
   */
  private wantsSource(e: MouseEvent): boolean {
    if (e.button !== 0 || e.detail > 1) return false
    if (e.metaKey || this.dom.classList.contains('is-comment')) return true
    if ((e.target as HTMLElement).closest('a, img, video, audio, iframe, summary, button, input, select, textarea')) return false
    return !pointOnText(e.clientX, e.clientY)
  }

  stopEvent(e: Event): boolean {
    if (!this.preview.contains(e.target as Node)) return false
    // 不展开源码的点击不交给编辑器,否则光标会落进隐藏的源码里
    if (e.type === 'mousedown') return !this.wantsSource(e as MouseEvent)
    return true
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return this.preview.contains(m.target as Node)
  }
}

/** 坐标是否落在文字上(而不是元素的空白处)。 */
function pointOnText(x: number, y: number): boolean {
  const caret = document.caretRangeFromPoint(x, y)
  const node = caret?.startContainer
  if (!node || node.nodeType !== Node.TEXT_NODE) return false
  const range = document.createRange()
  range.selectNodeContents(node)
  return Array.from(range.getClientRects()).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
}

/** 插入 HTML 块(右键「插入 ▸ HTML 内容」、斜杠 /html,对照表 P-38):光标进入源码。 */
export function insertHtmlBlock(view: EditorView): boolean {
  return insertBlock(schema.nodes.html_block.create())(view.state, view.dispatch)
}

export class HtmlInlineView implements NodeView {
  dom: HTMLElement

  constructor(node: PMNode, env: EditorEnv) {
    const html = node.attrs.html as string
    if (/^<!--[\s\S]*-->$/.test(html.trim())) {
      this.dom = h('span', { class: 'tz-html-inline tz-html-comment', title: html }, html)
    } else if (/^<\/?[a-z][^>]*>$/i.test(html.trim())) {
      // 单个不成对的标签:以弱化文字显示,便于用户看到并修正
      this.dom = h('span', { class: 'tz-html-inline tz-html-tag', title: '未成对的 HTML 标签' }, html)
    } else {
      this.dom = h('span', { class: 'tz-html-inline' })
      this.dom.append(sanitizeHtml(html, env))
    }
  }

  ignoreMutation(): boolean {
    return true
  }
}

// ---------- YAML ----------

export class FrontMatterView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement

  constructor() {
    this.contentDOM = h('code', { spellcheck: 'false' })
    this.dom = h('div', { class: 'tz-frontmatter' }, h('span', { class: 'tz-frontmatter-label', contenteditable: 'false' }, 'YAML'), h('pre', null, this.contentDOM))
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return (m.target as HTMLElement).classList?.contains('tz-frontmatter-label') ?? false
  }
}

// ---------- 脚注引用:悬停预览、⌘+点击跳到定义(对照表 X-46) ----------

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** ⌘(macOS)/ Ctrl(其它平台)+点击。 */
function modClick(e: MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

/** 脚注未定义时的提示(Typora 原文,{0} 为脚注名、{1} 为脚注标签)。 */
export function undefinedFootnoteHint(label: string): string {
  return `请按语法 [^${label}]: www.example.com 定义脚注 ${label}`
}

export class FootnoteRefView implements NodeView {
  dom: HTMLElement
  private tip: HTMLElement | null = null

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly env: EditorEnv,
  ) {
    this.dom = h('sup', { class: 'tz-footnote-ref' }, `[${node.attrs.label}]`)
    this.dom.addEventListener('mouseenter', () => this.showTip())
    this.dom.addEventListener('mouseleave', () => this.hideTip())
    this.dom.addEventListener('click', (e) => {
      // 单击只选中脚注号;⌘+点击才跳到定义
      if (!modClick(e)) return
      e.preventDefault()
      const def = this.findDefinition()
      if (!def) {
        this.env.actions.notify(undefinedFootnoteHint(this.node.attrs.label as string), true)
        return
      }
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, def.pos + 2)).scrollIntoView())
      this.view.focus()
    })
  }

  private findDefinition(): { node: PMNode; pos: number } | null {
    let found: { node: PMNode; pos: number } | null = null
    this.view.state.doc.descendants((n, pos) => {
      if (found) return false
      if (n.type === schema.nodes.footnote_def && n.attrs.label === this.node.attrs.label) found = { node: n, pos }
      return !found
    })
    return found
  }

  private showTip(): void {
    const def = this.findDefinition()
    const text = def ? def.node.textContent : undefinedFootnoteHint(this.node.attrs.label as string)
    this.tip = h('div', { class: 'tz-popover tz-footnote-tip' }, text)
    document.body.append(this.tip)
    const r = this.dom.getBoundingClientRect()
    this.tip.style.left = `${r.left}px`
    this.tip.style.top = `${r.bottom + 6}px`
  }

  private hideTip(): void {
    this.tip?.remove()
    this.tip = null
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.dom.textContent = `[${node.attrs.label}]`
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    this.hideTip()
  }
}

// ---------- wikilink ----------

export class WikiLinkView implements NodeView {
  dom: HTMLElement

  constructor(node: PMNode, env: EditorEnv) {
    const target = node.attrs.target as string
    this.dom = h('a', { class: 'tz-wikilink', href: '#', title: `⌘+点击在新标签页打开「${target}」` }, node.attrs.alias ?? target)
    this.dom.addEventListener('click', (e) => {
      e.preventDefault()
      // 单击不跳转(便于编辑);⌘+点击在新标签页打开(notion-input.md 4.3、5.1 第 11 行)
      if (modClick(e)) env.openDocumentLink(target, true)
    })
  }

  stopEvent(e: Event): boolean {
    return e.type === 'click'
  }

  ignoreMutation(): boolean {
    return true
  }
}
