// 大文档视口裁剪(PRD 质量要求:5MB 文档输入 p95 ≤16ms)。
// 不用节点装饰标记隐藏块:ProseMirror 的 DecorationSet 建 / 加顶层节点装饰是「子节点数 × 装饰数」,几万个块时卡死。
// 顶层块很多时,离视口较远的块用样式表隐藏(display:none,不参与排版),外层容器用上下内边距补足它们的高度,
// 每次按键与滚动只排版视口附近的一百来个块。只改样式表与外层容器,不碰 ProseMirror 管理的 DOM
// (改了会被当成外部修改而重绘)。打印与导出不受影响:规则只在屏幕上、且挂在编辑器外层容器的类上。
import type { Node as PMNode } from 'prosemirror-model'
import { type EditorState, Plugin, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

/** 顶层块达到这个数才启用(普通文档不受影响) */
export const VIEWPORT_MIN_BLOCKS = 1500
/** 视口上下各多留的高度(按视口高度的倍数),快速滚动时不露白 */
const MARGIN_SCREENS = 1.5
/** 首次打开时先显示的块数(还没量过高度) */
const INITIAL_BLOCKS = 120

const HOST_CLASS = 'tz-vp'
let styleEl: HTMLStyleElement | null = null

function ruleFor(hiddenBefore: number, lastVisible: number, keep: number): string {
  // :nth-child 从 1 起算;前 hiddenBefore 个与第 lastVisible 个之后的子元素隐藏。
  // keep(从 1 起算,0 为没有)是光标所在块:用户滚走后它也不能隐藏,否则 WebKit 里打不进字
  const sel = `.tz-editor-host.${HOST_CLASS} > .ProseMirror`
  const not = keep > 0 ? `:not(:nth-child(${keep}))` : ''
  const parts: string[] = []
  if (hiddenBefore > 0) parts.push(`${sel} > :nth-child(-n+${hiddenBefore})${not}`)
  parts.push(`${sel} > :nth-child(n+${lastVisible + 1})${not}`)
  return `@media screen { ${parts.join(', ')} { display: none !important; } }`
}

/** 位置所在的顶层块下标。 */
function topIndex(doc: PMNode, pos: number): number {
  return doc.resolve(Math.max(0, Math.min(pos, doc.content.size))).index(0)
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** ⌘↑ / ⌘↓(其它平台 Ctrl+Home / Ctrl+End)跳到文首 / 文末,带 ⇧ 时扩选;返回方向,不是这组键时为 0。 */
function docEdgeKey(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.altKey) return 0
  if (isMac) {
    if (!e.metaKey || e.ctrlKey) return 0
    return e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
  }
  if (!e.ctrlKey || e.metaKey) return 0
  return e.key === 'Home' ? -1 : e.key === 'End' ? 1 : 0
}

export function viewportPlugin(): Plugin {
  let current: Viewport | null = null
  return new Plugin({
    view: (view) => (current = new Viewport(view, () => (current = null))),
    // 光标跳进被隐藏的块(文末、查找定位、大纲跳转):要在 ProseMirror 把 DOM 选区放进去之前先显示它,
    // 放进不排版元素里的选区会被 WebKit 直接丢掉,之后 ProseMirror 也不再同步选区
    appendTransaction(_trs, oldState, newState) {
      if (current && oldState.doc === newState.doc && !oldState.selection.eq(newState.selection)) current.reveal(newState)
      return null
    },
    props: {
      // 裁剪后被隐藏的块里放不进原生光标,文首 / 文末跳转由这里按文档位置处理
      handleKeyDown(view, event) {
        if (view.state.doc.childCount < VIEWPORT_MIN_BLOCKS) return false
        const dir = docEdgeKey(event)
        if (dir === 0) return false
        const { doc, selection } = view.state
        const edge = dir < 0 ? Selection.atStart(doc) : Selection.atEnd(doc)
        const next = event.shiftKey ? TextSelection.between(selection.$anchor, edge.$head) : edge
        view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
        return true
      },
    },
  })
}

class Viewport {
  private readonly host: HTMLElement
  private readonly scroller: HTMLElement
  /** 可见的顶层块下标区间 [from, to) */
  private from = 0
  private to = 0
  private active = false
  /** 量过的块高(含与下一块之间的间距),按节点对象记:没改动的块对象不变 */
  private readonly measured = new WeakMap<PMNode, number>()
  private heights: Float64Array = new Float64Array(0)
  private frame = 0
  private readonly onScroll = () => this.schedule()
  private readonly resize = new ResizeObserver(() => this.schedule(true))
  private lastWidth = 0

  constructor(
    private readonly view: EditorView,
    private readonly onDestroy: () => void,
  ) {
    this.host = view.dom.parentElement ?? document.body
    this.scroller = (view.dom.closest('.tz-scroll') as HTMLElement | null) ?? document.documentElement
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
    this.resize.observe(view.dom)
    this.update(view, null)
  }

  update(view: EditorView, prev: EditorState | null): void {
    const doc = view.state.doc
    if (doc.childCount < VIEWPORT_MIN_BLOCKS) {
      if (this.active) this.deactivate()
      return
    }
    if (!this.active) {
      this.active = true
      this.from = 0
      this.to = Math.min(doc.childCount, INITIAL_BLOCKS)
      this.rebuildHeights(doc)
      this.host.classList.add(HOST_CLASS)
      this.apply()
      this.schedule()
      return
    }
    let changed = false
    if (prev && prev.doc !== doc && prev.doc.childCount !== doc.childCount) {
      // 顶层块数变了:改动在窗口之前则整体平移,在窗口内则窗口跟着伸缩
      const delta = doc.childCount - prev.doc.childCount
      const diff = prev.doc.content.findDiffStart(doc.content)
      const at = diff === null ? doc.childCount : topIndex(doc, diff)
      if (at < this.from) {
        this.from = Math.max(0, this.from + delta)
        this.to = Math.max(this.from, this.to + delta)
      } else if (at <= this.to) {
        this.to = Math.max(this.from + 1, this.to + delta)
      }
      // 只在文末追加了块(分段载入)时,沿用已有高度、只给新块估高
      if (at >= prev.doc.childCount && this.heights.length === prev.doc.childCount) this.appendHeights(doc)
      else this.rebuildHeights(doc)
      changed = true
    }
    // 光标移动或输入后,光标所在块必须在窗口里:跳转、全选、查找定位后要能显示光标、滚到光标。
    // 只有界面元信息的事务(没改选区和文档)不动窗口,免得用户滚走后视口被拉回
    if (!prev || prev.doc !== doc || !prev.selection.eq(view.state.selection)) {
      const head = topIndex(doc, view.state.selection.head)
      if (head < this.from || head >= this.to) {
        this.from = Math.max(0, head - 40)
        this.to = Math.min(doc.childCount, head + 80)
        changed = true
      }
    }
    this.from = Math.min(this.from, doc.childCount - 1)
    this.to = Math.min(Math.max(this.to, this.from + 1), doc.childCount)
    if (changed) {
      this.apply()
      // ProseMirror 先同步 DOM 选区、后调插件视图:同步时光标所在块可能还隐藏着(WebKit 会把选区挪到可见处),
      // 块显示出来后让它按当前选区重新同步一次
      if (view.hasFocus()) view.focus()
      // 下一帧按实际滚动位置再定一次窗口
      this.schedule()
    }
  }

  /** 新状态的光标所在块不在窗口里时,立即把窗口移过去(文档结构与当前 DOM 相同时才调用)。 */
  reveal(state: EditorState): void {
    if (!this.active) return
    const head = topIndex(state.doc, state.selection.head)
    if (head >= this.from && head < this.to) return
    this.from = Math.max(0, head - 40)
    this.to = Math.min(state.doc.childCount, head + 80)
    this.apply(state)
    this.schedule()
  }

  destroy(): void {
    this.onDestroy()
    cancelAnimationFrame(this.frame)
    this.scroller.removeEventListener('scroll', this.onScroll)
    this.resize.disconnect()
    if (this.active) this.deactivate()
  }

  private deactivate(): void {
    this.active = false
    this.host.classList.remove(HOST_CLASS)
    this.host.style.removeProperty('padding-top')
    this.host.style.removeProperty('padding-bottom')
    if (styleEl) styleEl.textContent = ''
  }

  /** 按节点估高:还没显示过的块用字数、类型粗算(行宽按编辑区宽度)。 */
  private estimate(node: PMNode, font: number, width: number): number {
    const line = font * 1.75
    const perLine = Math.max(10, width / (font * 0.75))
    const lines = (text: string) => Math.max(1, Math.ceil(text.length / perLine))
    switch (node.type.name) {
      case 'heading':
        return line * 1.6 + 24
      case 'code_block':
        return (node.textContent.split('\n').length + 1) * font * 1.6 + 32
      case 'table':
        return node.childCount * (line + 14) + 16
      case 'bullet_list':
      case 'ordered_list': {
        let h = 16
        node.forEach((item) => (h += lines(item.textContent) * line))
        return h
      }
      case 'horizontal_rule':
        return 32
      default:
        return lines(node.textContent) * line + 16
    }
  }

  private rebuildHeights(doc: PMNode): void {
    const heights = new Float64Array(doc.childCount)
    const width = Math.max(200, this.view.dom.clientWidth || 700)
    const font = Number.parseFloat(getComputedStyle(this.view.dom).fontSize) || 16
    doc.forEach((node, _offset, i) => {
      heights[i] = this.measured.get(node) ?? this.estimate(node, font, width)
    })
    this.heights = heights
  }

  private appendHeights(doc: PMNode): void {
    const heights = new Float64Array(doc.childCount)
    heights.set(this.heights)
    const width = Math.max(200, this.view.dom.clientWidth || 700)
    const font = Number.parseFloat(getComputedStyle(this.view.dom).fontSize) || 16
    for (let i = this.heights.length; i < doc.childCount; i++) heights[i] = this.estimate(doc.child(i), font, width)
    this.heights = heights
  }

  private sum(from: number, to: number): number {
    let s = 0
    for (let i = from; i < to; i++) s += this.heights[i]
    return s
  }

  /** 应用窗口:隐藏规则与上下内边距。 */
  private apply(state: EditorState = this.view.state): void {
    const first = this.domIndex(this.from)
    const last = this.domIndex(this.to - 1)
    if (first < 0 || last < 0) return
    const head = topIndex(state.doc, state.selection.head)
    const keep = head < this.from || head >= this.to ? this.domIndex(head) + 1 : 0
    styleEl ??= document.head.appendChild(Object.assign(document.createElement('style'), { id: 'tz-viewport' }))
    // 规则没变就不写:改样式表会让整页样式重算(分段追加时窗口不变,只有下内边距变)
    const rule = ruleFor(first, last + 1, keep)
    if (styleEl.textContent !== rule) styleEl.textContent = rule
    this.host.style.paddingTop = `${Math.round(this.sum(0, this.from))}px`
    this.host.style.paddingBottom = `${Math.round(this.sum(this.to, this.heights.length))}px`
  }

  /** 第 i 个顶层块在编辑区 DOM 子元素里的位置(顶层可能夹着装饰小部件,不一定与 i 相同)。 */
  private domIndex(i: number): number {
    const doc = this.view.state.doc
    if (i < 0 || i >= doc.childCount) return -1
    let pos = 0
    for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize
    const el = this.view.nodeDOM(pos)
    if (!(el instanceof Element) || el.parentElement !== this.view.dom) return i
    return Array.prototype.indexOf.call(this.view.dom.children, el) as number
  }

  private schedule(resized = false): void {
    if (!this.active) return
    if (resized) {
      const width = this.view.dom.clientWidth
      if (width === this.lastWidth) return
      this.lastWidth = width
    }
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.refresh())
  }

  /** 量可见块的实际高度,按滚动位置重定窗口;保持视口里第一块的位置不跳。 */
  private refresh(): void {
    if (!this.active || this.view.isDestroyed) return
    const doc = this.view.state.doc
    if (this.heights.length !== doc.childCount) this.rebuildHeights(doc)
    // 量:相邻两块顶边之差即该块连同间距的高度
    let pos = 0
    for (let k = 0; k < this.from; k++) pos += doc.child(k).nodeSize
    let prevTop: number | null = null
    let prevIndex = -1
    let anchor: { index: number; top: number } | null = null
    const viewTop = this.scroller.getBoundingClientRect().top
    for (let i = this.from; i < this.to; i++) {
      const node = doc.child(i)
      const el = this.view.nodeDOM(pos)
      pos += node.nodeSize
      if (!(el instanceof HTMLElement)) continue
      const top = el.getBoundingClientRect().top
      if (prevTop !== null && prevIndex >= 0) {
        const h = top - prevTop
        if (h > 0) {
          this.heights[prevIndex] = h
          this.measured.set(doc.child(prevIndex), h)
        }
      }
      if (anchor === null && top >= viewTop) anchor = { index: i, top }
      prevTop = top
      prevIndex = i
    }
    // 按滚动位置算新窗口:内容顶端在滚动区里的偏移 + 各块累计高度
    const hostTop = this.host.getBoundingClientRect().top - viewTop + this.scroller.scrollTop
    const padTop = Number.parseFloat(this.host.style.paddingTop) || 0
    const contentTop = hostTop + padTop - this.sum(0, this.from)
    const margin = this.scroller.clientHeight * MARGIN_SCREENS
    const want0 = this.scroller.scrollTop - contentTop - margin
    const want1 = this.scroller.scrollTop - contentTop + this.scroller.clientHeight + margin
    let y = 0
    let from = 0
    while (from < this.heights.length - 1 && y + this.heights[from] < want0) y += this.heights[from++]
    let to = from
    while (to < this.heights.length && y < want1) y += this.heights[to++]
    // 光标所在块留在窗口里
    const head = topIndex(doc, this.view.state.selection.head)
    if (head >= from - 200 && head < from) from = head
    if (head >= to && head < to + 200) to = head + 1
    to = Math.max(to, from + 1)
    if (from === this.from && to === this.to) return
    this.from = from
    this.to = to
    this.apply()
    // 原来视口里第一块若仍可见,把它放回原来的屏幕位置(上方块的估高换成实测值时不跳)
    if (anchor && anchor.index >= from && anchor.index < to) {
      let p = 0
      for (let k = 0; k < anchor.index; k++) p += doc.child(k).nodeSize
      const el = this.view.nodeDOM(p)
      if (el instanceof HTMLElement) this.scroller.scrollTop += el.getBoundingClientRect().top - anchor.top
    }
  }
}
