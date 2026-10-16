// 选中文字时的浮动格式条(Notion)、⌘/「转换为」菜单;链接的单击浮层、悬停预览与 ⌘K 见 linkcard.ts。
import type { MarkType } from 'prosemirror-model'
import { NodeSelection, Plugin, type EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { CellSelection } from 'prosemirror-tables'
import { BlockSelection } from '../core/block-selection'
import { currentBlockKind, markRange } from '../core/commands'
import type { EditorEnv } from '../core/env'
import { openHref } from '../core/links'
import { getCommand, registerCommand, runCommand } from '../core/registry'
import { schema } from '../core/schema'
import { ICONS, h, svgIcon } from '../ui/dom'
import { FloatingMenu } from '../ui/menu'
import { BLOCK_KINDS, colorItems, turnIntoItems, turnMenuItems } from './items'
import { clickTarget, DRAG_PATH_TYPE, editLink, insertFileLink, LinkCard } from './linkcard'

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

const m = schema.marks

function isMarkActive(state: EditorState, type: MarkType): boolean {
  const { from, to, empty, $from } = state.selection
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()))
  return state.doc.rangeHasMark(from, to, type)
}

/** 焦点不在正文(侧栏、无文档时),且不在输入框里。 */
function focusOutsideEditor(view: EditorView): boolean {
  if (view.hasFocus()) return false
  const active = document.activeElement
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active instanceof HTMLElement && active.isContentEditable))) return false
  return true
}

export function toolbarPlugin(env: EditorEnv): Plugin {
  registerCommand({
    id: 'format.link',
    label: '链接',
    run: (view) => {
      // ⌘K:正文内加链接;焦点不在正文时为快速打开(notion-input.md 六 第 2 行)
      if (focusOutsideEditor(view) && getCommand('file.quickOpen')) return runCommand(view, 'file.quickOpen')
      void editLink(view, env)
      return true
    },
  })
  let card: LinkCard | null = null
  const turnMenu = new FloatingMenu({ className: 'tz-turn-menu', search: '转换为…' })
  registerCommand({
    id: 'block.turnIntoMenu',
    label: '转换为…',
    run: (view) => {
      // 光标所在块或块选中态都可用;不可转换的块只给创建副本 / 移动到 / 复制为 Markdown / 删除(notion-input.md 7.3)
      const c = view.coordsAtPos(view.state.selection.from)
      turnMenu.open(turnMenuItems(view), c)
      return true
    },
  })
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        if (turnMenu.isOpen && turnMenu.handleKey(event)) {
          event.preventDefault()
          return true
        }
        return false
      },
      handleClick(view, pos, event) {
        const link = markRange(view.state.doc.resolve(pos), m.link)
        if (!link) return false
        // ⌘+点击直接打开(本地文档开新标签),⌥⇧+点击开新窗口(PRD 3.1、3.2);单击显示链接浮层
        const where = clickTarget(event)
        if (where) {
          openHref(view, env, link.mark.attrs.href, where)
          return true
        }
        const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
        if (anchor && card) card.showFor(anchor, pos)
        return false
      },
      handleDOMEvents: {
        // ⌥⇧+点击:ProseMirror 对按住 ⇧ 的点击走默认的扩选、不调 handleClick,所以在按下时就截住
        mousedown(view, event) {
          if (!(event.altKey && event.shiftKey) || event.button !== 0) return false
          const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
          if (!anchor || !view.dom.contains(anchor)) return false
          const link = markRange(view.state.doc.resolve(view.posAtDOM(anchor, 0)), m.link)
          if (!link) return false
          event.preventDefault()
          openHref(view, env, link.mark.attrs.href, 'window')
          return true
        },
      },
      handleDrop(view, event) {
        const path = event.dataTransfer?.getData(DRAG_PATH_TYPE)
        if (!path) return false
        event.preventDefault()
        insertFileLink(view, env, path, { left: event.clientX, top: event.clientY })
        return true
      },
    },
    view: (view) => {
      const toolbar = new SelectionToolbar(view, env)
      const links = new LinkCard(view, env)
      card = links
      return {
        update: (v: EditorView, prev: EditorState) => {
          toolbar.update(v, prev)
          links.update(v, prev)
        },
        destroy: () => {
          toolbar.destroy()
          links.destroy()
          if (card === links) card = null
        },
      }
    },
  })
}

class SelectionToolbar {
  private readonly el: HTMLDivElement
  private readonly menu = new FloatingMenu({ className: 'tz-toolbar-menu' })
  private mouseDown = false
  private readonly onDown = () => {
    this.mouseDown = true
    this.hide()
  }
  private readonly onUp = () => {
    this.mouseDown = false
    setTimeout(() => this.update(this.view), 0)
  }
  /** 焦点不在正文时 ⌘K 打开快速打开(原生菜单的 ⌘K 走 format.link 命令,浏览器宿主没有菜单,在这里接) */
  private readonly onKey = (e: KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k' || e.defaultPrevented) return
    if (!focusOutsideEditor(this.view) || !getCommand('file.quickOpen')) return
    e.preventDefault()
    runCommand(this.view, 'file.quickOpen')
  }

  constructor(
    private readonly view: EditorView,
    private readonly env: EditorEnv,
  ) {
    this.el = h('div', { class: 'tz-toolbar', hidden: true })
    this.el.addEventListener('mousedown', (e) => e.preventDefault())
    document.body.append(this.el)
    view.dom.addEventListener('mousedown', this.onDown)
    document.addEventListener('mouseup', this.onUp)
    document.addEventListener('keydown', this.onKey)
  }

  private button(label: string | Node, title: string, run: () => void, active = false, cls = ''): HTMLButtonElement {
    return h(
      'button',
      {
        type: 'button',
        class: `tz-tb-btn${active ? ' is-active' : ''} ${cls}`,
        title,
        onclick: ((e: Event) => {
          e.preventDefault()
          run()
        }) as EventListener,
      },
      label,
    )
  }

  private render(): void {
    const view = this.view
    const state = view.state
    const kind = currentBlockKind(state)
    const kindLabel = BLOCK_KINDS.find((k) => k.kind === kind)?.label ?? '文本'
    const cmd = (id: string) => () => {
      runCommand(view, id)
      this.render()
    }
    const turn = this.button(`${kindLabel} ▾`, '转换为', () => {
      const r = turn.getBoundingClientRect()
      this.menu.open(turnIntoItems(view), r)
    }, false, 'tz-tb-turn')
    const color = this.button(h('span', { class: 'tz-tb-color' }, 'A'), '文字颜色与背景色', () => {
      const r = color.getBoundingClientRect()
      this.menu.open(colorItems(view, false), r)
    }, isMarkActive(state, m.color))
    // AI 版:格式条最前面的【AI】(ai-prd 3.4),弹出 AI 动作菜单
    const ai = getCommand('ai.selection') ? [this.button('AI', 'AI 动作', () => runCommand(view, 'ai.selection'), false, 'tz-tb-ai'), h('span', { class: 'tz-tb-sep' })] : []
    this.el.replaceChildren(
      ...ai,
      turn,
      h('span', { class: 'tz-tb-sep' }),
      this.button(svgIcon(ICONS.link, 15), '链接(⌘K)', () => void editLink(view, this.env), isMarkActive(state, m.link)),
      h('span', { class: 'tz-tb-sep' }),
      this.button(h('b', null, 'B'), '加粗(⌘B)', cmd('format.bold'), isMarkActive(state, m.strong)),
      this.button(h('i', null, 'I'), '斜体(⌘I)', cmd('format.italic'), isMarkActive(state, m.em)),
      this.button(h('u', null, 'U'), '下划线(⌘U)', cmd('format.underline'), isMarkActive(state, m.underline)),
      this.button(h('s', null, 'S'), '删除线(⌘⇧S)', cmd('format.strike'), isMarkActive(state, m.strike)),
      this.button(h('code', null, '<>'), '行内代码(⌘E)', cmd('format.code'), isMarkActive(state, m.code)),
      this.button('√x', '行内公式(⌘⇧E)', cmd('format.inlineMath')),
      this.button(h('mark', null, 'H'), '高亮(⌘⇧H)', cmd('format.highlight'), isMarkActive(state, m.highlight)),
      this.button('x²', '上标', cmd('format.superscript'), isMarkActive(state, m.sup)),
      this.button('x₂', '下标', cmd('format.subscript'), isMarkActive(state, m.sub)),
      h('span', { class: 'tz-tb-sep' }),
      color,
    )
  }

  update(view: EditorView, prev?: EditorState): void {
    const state = view.state
    if (prev && prev.selection.eq(state.selection) && prev.doc.eq(state.doc) && !this.el.hidden) return
    const sel = state.selection
    const show =
      !this.mouseDown &&
      view.hasFocus() &&
      !sel.empty &&
      !(sel instanceof NodeSelection) &&
      !(sel instanceof BlockSelection) &&
      !(sel instanceof CellSelection) &&
      !sel.$from.parent.type.spec.code &&
      !view.composing
    if (!show) {
      if (!this.menu.isOpen) this.hide()
      return
    }
    this.render()
    this.el.hidden = false
    const start = view.coordsAtPos(sel.from)
    const end = view.coordsAtPos(sel.to)
    const box = this.el.getBoundingClientRect()
    const mid = (Math.min(start.left, end.left) + Math.max(start.right, end.right)) / 2
    let top = Math.min(start.top, end.top) - box.height - 8
    if (top < 8) top = Math.max(start.bottom, end.bottom) + 8
    const left = Math.min(Math.max(8, mid - box.width / 2), window.innerWidth - box.width - 8)
    this.el.style.left = `${left}px`
    this.el.style.top = `${top}px`
  }

  private hide(): void {
    this.el.hidden = true
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousedown', this.onDown)
    document.removeEventListener('mouseup', this.onUp)
    document.removeEventListener('keydown', this.onKey)
    this.menu.close('api')
    this.el.remove()
  }
}
