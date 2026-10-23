// mdast 后处理:从标准节点里识别 Typoza 扩展结构。
// 原则:识别不了的一律保持原样(落成 html_block / html_inline),保证打开再保存不丢内容。
import type { Blockquote, Html, Nodes, Paragraph, Parent, PhrasingContent, Root, RootContent, Text } from 'mdast'
import { closeTagName, openTagName, parseInlineStyle, parseSingleElement } from './html'
import type { TzCallout, TzHtmlImage, TzHtmlTag, TzInlineMark, TzMedia, TzToc, TzToggle } from './mdast-types'
import { HTML_TAG_MARKS, type MediaKind, isPdfSource } from '../schema'

type FlowParent = Parent & { children: RootContent[] }

export function transformTree(root: Root, source: string): void {
  transformFlow(root as FlowParent, source)
}

function sliceSource(node: Nodes, source: string): string | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  return start === undefined || end === undefined ? null : source.slice(start, end)
}

const FLOW_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'list', 'footnoteDefinition', 'tzCallout', 'tzToggle'])

function transformFlow(parent: FlowParent, source: string): void {
  groupDetails(parent)
  for (let i = 0; i < parent.children.length; i++) {
    const child = parent.children[i]
    const replaced = transformBlock(child, source)
    if (replaced) {
      parent.children[i] = replaced as RootContent
      continue
    }
    if (FLOW_CONTAINERS.has(child.type)) transformFlow(child as FlowParent, source)
    else if (child.type === 'paragraph' || child.type === 'heading') transformPhrasingParent(child)
    else if (child.type === 'table') {
      for (const row of child.children) for (const cell of row.children) transformPhrasingParent(cell)
    }
  }
}

function transformBlock(node: RootContent, source: string): RootContent | null {
  if (node.type === 'blockquote') {
    const callout = toCallout(node)
    if (callout) {
      transformFlow(callout as FlowParent, source)
      return callout
    }
    return null
  }
  if (node.type === 'html') {
    const el = parseSingleElement(node.value)
    if (!el) return null
    const media = mediaFromElement(el, node.value)
    if (media) return withPosition(media, node)
    if (el.tagName === 'IMG') {
      // Typora 缩放图片后整行就是一个 <img>,CommonMark 视为 HTML 块;编辑器里按段落里的图片处理
      return withPosition({ type: 'paragraph', children: [imageFromElement(el)] } as Paragraph, node)
    }
    return null
  }
  if (node.type === 'paragraph') {
    if (node.children.length === 1 && node.children[0].type === 'text' && /^\[toc\]$/i.test(node.children[0].value.trim())) {
      return withPosition<TzToc>({ type: 'tzToc' }, node)
    }
    const html = paragraphHtml(node, source)
    if (html !== null) {
      const el = parseSingleElement(html)
      const media = el ? mediaFromElement(el, html) : null
      if (media) return withPosition(media, node)
    }
  }
  return null
}

function withPosition<T extends object>(created: T, from: Nodes): T {
  return Object.assign(created, { position: from.position })
}

/** 段落若整体是一段 HTML(媒体标签、书签链接),返回其原文;否则 null。 */
function paragraphHtml(p: Paragraph, source: string): string | null {
  if (!p.children.some((c) => c.type === 'html')) return null
  const slice = sliceSource(p, source)
  if (slice !== null && !slice.includes('\n')) return slice.trim().startsWith('<') ? slice.trim() : null
  // 多行段落(在引用或列表里时原文带前缀),只在全部子节点都是 HTML 或空白时拼接
  if (p.children.every((c) => c.type === 'html' || (c.type === 'text' && c.value.trim() === ''))) {
    return p.children.map((c) => (c as Html).value ?? '').join('')
  }
  return null
}

function mediaFromElement(el: Element, html: string): TzMedia | null {
  const tag = el.tagName
  const make = (kind: MediaKind, src: string, title = '', description = ''): TzMedia => ({
    type: 'tzMedia',
    kind,
    src,
    title,
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    description,
    html,
  })
  if (tag === 'VIDEO' || tag === 'AUDIO') {
    const src = el.getAttribute('src') ?? el.querySelector('source[src]')?.getAttribute('src')
    if (!src) return null
    return make(tag === 'VIDEO' ? 'video' : 'audio', src, el.getAttribute('title') ?? '')
  }
  if (tag === 'IFRAME') {
    const src = el.getAttribute('src')
    if (!src) return null
    return make(isPdfSource(src) ? 'pdf' : 'embed', src, el.getAttribute('title') ?? '')
  }
  if (tag === 'A') {
    const type = el.getAttribute('data-tz-type')
    const href = el.getAttribute('href')
    // 书签的网页描述存在链接的 title 属性里(对应 PRD `[标题](网址 "描述")` 的链接标题)
    if ((type === 'bookmark' || type === 'file') && href) return make(type, href, el.textContent ?? '', el.getAttribute('title') ?? '')
  }
  return null
}

function imageFromElement(el: Element): TzHtmlImage {
  const style = parseInlineStyle(el.getAttribute('style'))
  return {
    type: 'tzHtmlImage',
    src: el.getAttribute('src') ?? '',
    alt: el.getAttribute('alt') ?? '',
    title: el.getAttribute('title'),
    width: el.getAttribute('width'),
    height: el.getAttribute('height'),
    zoom: style.zoom ?? null,
    align: el.getAttribute('align'),
  }
}

// ---------- 提示框 ----------

const CALLOUT_MARKER = /^\[!([A-Za-z]+)\][+-]?(?:[ \t]+([^\n]*))?(?:\n|$)/

function toCallout(bq: Blockquote): TzCallout | null {
  const first = bq.children[0]
  if (first?.type !== 'paragraph') return null
  const text = first.children[0]
  if (text?.type !== 'text') return null
  const m = CALLOUT_MARKER.exec(text.value)
  if (!m) return null
  text.value = text.value.slice(m[0].length)
  if (text.value === '') first.children.shift()
  const rest = bq.children.slice()
  if (first.children.length === 0 || first.children.every((c) => c.type === 'text' && c.value.trim() === '')) rest.shift()
  return {
    type: 'tzCallout',
    kind: m[1].toLowerCase() as TzCallout['kind'],
    title: (m[2] ?? '').trim(),
    children: rest,
    position: bq.position,
  }
}

// ---------- 折叠块 ----------

const DETAILS_OPEN = /^<details(\s[^>]*)?>/i

function groupDetails(parent: FlowParent): void {
  const children = parent.children
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type !== 'html') continue
    const value = node.value.trim()
    const open = DETAILS_OPEN.exec(value)
    if (!open || /<\/details>\s*$/i.test(value)) continue // 整段写在一个 HTML 块里的保持原样
    const rest = value.slice(open[0].length).trim()
    let summaryHtml = ''
    if (rest !== '') {
      const summary = /^<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>$/i.exec(rest)
      if (!summary) continue
      summaryHtml = summary[1].trim()
    }
    let depth = 0
    let close = -1
    for (let j = i + 1; j < children.length; j++) {
      const c = children[j]
      if (c.type !== 'html') continue
      const v = c.value.trim()
      if (DETAILS_OPEN.test(v) && !/<\/details>\s*$/i.test(v)) depth++
      else if (/^<\/details>$/i.test(v)) {
        if (depth === 0) {
          close = j
          break
        }
        depth--
      }
    }
    if (close < 0) continue
    const toggle: TzToggle = {
      type: 'tzToggle',
      openInSource: /\sopen\b/i.test(open[1] ?? ''),
      summaryHtml,
      children: children.slice(i + 1, close) as TzToggle['children'],
      position: { start: node.position!.start, end: children[close].position!.end },
    }
    children.splice(i, close - i + 1, toggle)
  }
}

// ---------- 行内 ----------

const PHRASING_CONTAINERS = new Set([
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
  'mark',
  'superscript',
  'subscript',
  'tzInlineMark',
  'tzHtmlTag',
])

type PhrasingParent = Parent & { children: PhrasingContent[] }

function transformPhrasingParent(parent: Parent): void {
  const p = parent as PhrasingParent
  p.children = pairHtml(p.children)
  p.children = p.children.flatMap(convertInline)
  for (const child of p.children) {
    if (PHRASING_CONTAINERS.has(child.type)) transformPhrasingParent(child as Parent)
  }
}

type Wrapper = (children: PhrasingContent[]) => PhrasingContent

function wrapperFor(html: string): { tag: string; wrap: Wrapper } | null {
  const tag = openTagName(html)
  if (!tag) return null
  switch (tag) {
    case 'u':
    case 'ins':
      return { tag, wrap: (children) => inlineMark('underline', null, null, children) }
    case 'mark':
      return { tag, wrap: (children) => ({ type: 'mark', children }) }
    case 'sup':
      return { tag, wrap: (children) => inlineMark('sup', null, null, children) }
    case 'sub':
      return { tag, wrap: (children) => inlineMark('sub', null, null, children) }
    case 's':
    case 'del':
    case 'strike':
      return { tag, wrap: (children) => ({ type: 'delete', children }) }
    case 'b':
    case 'strong':
      return { tag, wrap: (children) => ({ type: 'strong', children }) }
    case 'i':
    case 'em':
      return { tag, wrap: (children) => ({ type: 'emphasis', children }) }
    case 'span': {
      const el = parseSingleElement(`${html}</span>`)
      if (!el) return null
      const style = parseInlineStyle(el.getAttribute('style'))
      const keys = Object.keys(style)
      const color = style.color ?? null
      const background = style['background-color'] ?? style.background ?? null
      // 纯颜色样式进颜色标记(可在界面里改);带其它属性(字号、字体……)的 span 按通用标签渲染,开标签原文写回,不丢信息
      if ((!color && !background) || keys.some((k) => !['color', 'background-color', 'background'].includes(k))) return htmlTagWrapper(tag, html)
      return { tag, wrap: (children) => inlineMark('color', color, background, children) }
    }
    default:
      return HTML_TAG_MARKS.has(tag) ? htmlTagWrapper(tag, html) : null
  }
}

/** 其它成对的行内标签(对照表 X-43:kbd、ruby、font……):渲染成同名元素,开标签原文留着原样写回 */
function htmlTagWrapper(tag: string, html: string): { tag: string; wrap: Wrapper } {
  return { tag, wrap: (children): TzHtmlTag => ({ type: 'tzHtmlTag', tag, open: html.trim(), children }) }
}

function inlineMark(mark: TzInlineMark['mark'], color: string | null, background: string | null, children: PhrasingContent[]): TzInlineMark {
  return { type: 'tzInlineMark', mark, color, background, children }
}

/** 把同一父节点下成对的 HTML 开闭标签之间的内容包成格式节点。不成对的标签原样保留。 */
function pairHtml(children: PhrasingContent[]): PhrasingContent[] {
  const out: PhrasingContent[] = []
  const stack: { tag: string; wrap: Wrapper; at: number }[] = []
  for (const child of children) {
    if (child.type === 'html') {
      const opener = wrapperFor(child.value)
      if (opener) {
        stack.push({ ...opener, at: out.length })
        out.push(child)
        continue
      }
      const closing = closeTagName(child.value)
      if (closing) {
        let k = stack.length - 1
        while (k >= 0 && stack[k].tag !== closing) k--
        if (k >= 0) {
          const entry = stack[k]
          const inner = out.splice(entry.at)
          inner.shift() // 开标签
          out.push(entry.wrap(inner))
          stack.length = k
          continue
        }
      }
    }
    out.push(child)
  }
  return out
}

const WIKILINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g

function convertInline(node: PhrasingContent): PhrasingContent[] {
  if (node.type === 'html') {
    const value = node.value.trim()
    if (/^<br\s*\/?>$/i.test(value)) return [{ type: 'tzHtmlBreak' }]
    if (/^<img\s/i.test(value)) {
      const el = parseSingleElement(value)
      if (el?.tagName === 'IMG') return [imageFromElement(el)]
    }
    return [node]
  }
  if (node.type === 'text' && node.value.includes('[[')) return splitWikiLinks(node)
  return [node]
}

function splitWikiLinks(node: Text): PhrasingContent[] {
  const out: PhrasingContent[] = []
  let last = 0
  for (const m of node.value.matchAll(WIKILINK)) {
    const at = m.index ?? 0
    if (at > last) out.push({ type: 'text', value: node.value.slice(last, at) })
    out.push({ type: 'tzWikiLink', target: m[1].trim(), alias: m[2]?.trim() ?? null })
    last = at + m[0].length
  }
  if (out.length === 0) return [node]
  if (last < node.value.length) out.push({ type: 'text', value: node.value.slice(last) })
  return out
}
