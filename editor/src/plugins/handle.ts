// Notion 块手柄:鼠标移到块上,左侧出现「+」与「⋮⋮」。
// 「+」在下方新建一行并打开斜杠菜单;「⋮⋮」单击打开块菜单(notion-input.md 7.2),拖动可移动整块(列表项按项移动)。
// 已多选块时,点或拖任一所选块的「⋮⋮」作用于全部所选块;按住 ⌥ 拖动为复制(落点处理见 blockselect 的 dragCopies)。
import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { BlockSelection, selectedBlocks } from '../core/block-selection'
import { blockAt, type BlockInfo } from '../core/blocks'
import { blocksToMarkdown } from '../core/commands'
import type { EditorEnv } from '../core/env'
import { basename } from '../core/paths'
import { registerCommand } from '../core/registry'
import { schema } from '../core/schema'
import { ICONS, h, svgIcon } from '../ui/dom'
import { FloatingMenu } from '../ui/menu'
import { removeBlocksIfUnchanged } from './blockselect'
import { blockMenu } from './items'
import { openSlashMenu } from './slash'

/** 拖块时写进 dataTransfer 的类型,值为所拖块的 Markdown。侧栏据此识别「拖来的块」。 */
export const BLOCK_DRAG_TYPE = 'application/x-typoza-blocks'

/** 正在拖动的块(拖到侧栏文档时用);拖动结束后清空。 */
let activeDrag: { view: EditorView; env: EditorEnv; blocks: BlockInfo[] } | null = null

/**
 * 侧栏收到拖来的块(dataTransfer 含 BLOCK_DRAG_TYPE)时调用:把块追加到目标文档末尾并从当前文档删除
 * (notion-input.md 7.1「拖到侧栏文档」)。返回是否已移动;写文件失败时抛出。
 */
export async function moveDraggedBlocks(path: string): Promise<boolean> {
  const drag = activeDrag
  if (!drag || drag.blocks.length === 0) return false
  const { view, env, blocks } = drag
  if (path === env.ctx.path) return false
  await env.actions.appendToDocument(path, blocksToMarkdown(view.state.doc, blocks, env.settings.inlineMath))
  const title = basename(path).replace(/\.[^.]+$/, '')
  const moved = removeBlocksIfUnchanged(view, env, blocks, title)
  if (moved) env.actions.notify(`已移动到「${title}」`)
  return moved
}

export function blockHandlePlugin(env: EditorEnv): Plugin {
  const menu = new FloatingMenu({ className: 'tz-block-menu' })
  // 右键菜单「块菜单…」:已选中的块,或光标所在块
  registerCommand({
    id: 'block.menu',
    label: '块菜单…',
    run: (view) => {
      if (selectedBlocks(view.state).length === 0) {
        const info = blockAt(view.state.selection.$from)
        if (!info) return false
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, info.pos)))
      }
      const { items, footer } = blockMenu(view)
      const c = view.coordsAtPos(view.state.selection.from)
      menu.open(items, { left: c.left, top: c.top, bottom: c.bottom }, '', footer)
      return true
    },
  })
  return new Plugin({ view: (view) => new BlockHandle(view, env) })
}

/** dom 是某个列表项里的第一块时返回该列表项(待办项的内容包在 .tz-task-content 里) */
function firstBlockOfListItem(dom: HTMLElement): HTMLElement | null {
  const parent = dom.parentElement
  const li = parent?.tagName === 'LI' ? parent : parent?.classList.contains('tz-task-content') ? parent.parentElement : null
  if (!li || li.tagName !== 'LI') return null
  const content = li.classList.contains('tz-task') ? li.querySelector(':scope > .tz-task-content') : li
  return content?.firstElementChild === dom ? li : null
}

class BlockHandle {
  private readonly el: HTMLDivElement
  private readonly grip: HTMLButtonElement
  private current: BlockInfo | null = null
  private readonly menu = new FloatingMenu({ className: 'tz-block-menu' })
  private hideTimer = 0
  private readonly container: HTMLElement
  private readonly onMove = (e: MouseEvent) => this.track(e)
  private readonly onLeave = () => this.scheduleHide()

  constructor(
    private readonly view: EditorView,
    private readonly env: EditorEnv,
  ) {
    const plus = h('button', { type: 'button', class: 'tz-handle-plus', title: '点击在下方添加块', tabindex: '-1' }, svgIcon(ICONS.plus, 16))
    this.grip = h('button', { type: 'button', class: 'tz-handle-grip', title: '拖动移动 · 点击打开菜单', draggable: 'true', tabindex: '-1' }, svgIcon(ICONS.grip, 16))
    this.el = h('div', { class: 'tz-block-handle', hidden: true }, plus, this.grip)
    this.container = view.dom.parentElement ?? document.body
    this.container.append(this.el)

    plus.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.addBelow()
    })
    this.grip.addEventListener('mousedown', (e) => e.stopPropagation())
    this.grip.addEventListener('click', (e) => {
      e.preventDefault()
      this.openMenu()
    })
    this.grip.addEventListener('dragstart', (e) => this.startDrag(e))
    this.grip.addEventListener('dragend', () => this.endDrag())
    this.el.addEventListener('mouseenter', () => clearTimeout(this.hideTimer))
    this.el.addEventListener('mouseleave', this.onLeave)
    view.dom.addEventListener('mousemove', this.onMove)
    view.dom.addEventListener('mouseleave', this.onLeave)
  }

  private track(e: MouseEvent): void {
    if (this.view.composing || !this.view.editable || this.menu.isOpen) return
    // 文字左侧的空白也算在块上:向右偏一点取位置
    const found = this.view.posAtCoords({ left: e.clientX + 40, top: e.clientY }) ?? this.view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!found) return
    let info: BlockInfo | null = null
    if (found.inside >= 0) {
      const node = this.view.state.doc.nodeAt(found.inside)
      // 原子块(媒体、目录)与代码类块(代码、公式、HTML 的内容在节点视图里,取不到里面的位置)按整块处理
      if (node && node.isBlock && (node.isAtom || node.type.spec.code)) {
        const $p = this.view.state.doc.resolve(found.inside)
        info = { node, pos: found.inside, depth: $p.depth }
      }
    }
    info ??= blockAt(this.view.state.doc.resolve(found.pos))
    if (!info || info.node.type === schema.nodes.frontmatter) return
    this.show(info)
  }

  private show(info: BlockInfo): void {
    const dom = this.view.nodeDOM(info.pos)
    if (!(dom instanceof HTMLElement)) return
    clearTimeout(this.hideTimer)
    this.current = info
    const box = this.container.getBoundingClientRect()
    const rect = dom.getBoundingClientRect()
    // 与块第一行文字垂直居中
    const style = getComputedStyle(dom)
    const line = Number.parseFloat(style.lineHeight) || 24
    const top = rect.top - box.top + this.container.scrollTop + Math.max(0, Math.min(line, rect.height) / 2 - 12) + (Number.parseFloat(style.paddingTop) || 0)
    // 列表项的首段按整项对齐,手柄放在项目符号 / 待办复选框左边,不盖住复选框(对照表 P-30「点击复选框」)
    const li = info.node.type === schema.nodes.list_item ? dom : firstBlockOfListItem(dom)
    const left = (li ? li.getBoundingClientRect().left - 72 : rect.left - 52) - box.left + this.container.scrollLeft
    this.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
    this.el.hidden = false
  }

  private scheduleHide(): void {
    clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      if (!this.menu.isOpen) this.el.hidden = true
    }, 300)
  }

  /** 手柄所在块已在多块选择里:保留多块选择(菜单、拖动作用于全部所选块)。 */
  private inMultiSelection(): boolean {
    const sel = this.view.state.selection
    return sel instanceof BlockSelection && this.current !== null && sel.positions.includes(this.current.pos)
  }

  private selectBlock(): boolean {
    if (this.inMultiSelection()) return true
    const info = this.current
    if (!info) return false
    const node = this.view.state.doc.nodeAt(info.pos)
    if (!node || node !== info.node) return false
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, info.pos)))
    return true
  }

  private addBelow(): void {
    const info = this.current
    if (!info) return
    const end = info.pos + info.node.nodeSize
    const tr = this.view.state.tr
    // 列表项下方新增的是同一列表里的新项
    if (info.node.type === schema.nodes.list_item) {
      tr.insert(end, schema.nodes.list_item.create({ checked: info.node.attrs.checked === null ? null : false }, schema.nodes.paragraph.create()))
      tr.setSelection(TextSelection.create(tr.doc, end + 2))
    } else {
      tr.insert(end, schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, end + 1))
    }
    this.view.dispatch(tr.scrollIntoView())
    this.view.focus()
    openSlashMenu(this.view)
  }

  private openMenu(): void {
    if (!this.selectBlock()) return
    const { items, footer } = blockMenu(this.view)
    const r = this.grip.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom }, '', footer)
  }

  private startDrag(e: DragEvent): void {
    if (!e.dataTransfer || !this.selectBlock()) {
      e.preventDefault()
      return
    }
    const view = this.view
    const sel = view.state.selection
    const blocks = selectedBlocks(view.state)
    const { dom, text, slice } = view.serializeForClipboard(sel.content())
    e.dataTransfer.clearData()
    e.dataTransfer.setData('text/html', dom.innerHTML)
    e.dataTransfer.setData('text/plain', text)
    e.dataTransfer.setData(BLOCK_DRAG_TYPE, blocksToMarkdown(view.state.doc, blocks, this.env.settings.inlineMath))
    e.dataTransfer.effectAllowed = 'copyMove'
    const blockDom = view.nodeDOM(blocks[0]?.pos ?? sel.from)
    if (blockDom instanceof HTMLElement) e.dataTransfer.setDragImage(blockDom, 0, 0)
    // 放下时由 ProseMirror 删除原位置并插入到落点:单块用内部字段 node 精确指向被拖的块;
    // 多块不给 node,落点处理会删除当前选择(即全部所选块)。是否复制由落下时是否按住 ⌥ 决定
    view.dragging = { slice, move: true, node: sel instanceof NodeSelection ? sel : undefined } as unknown as EditorView['dragging']
    activeDrag = { view, env: this.env, blocks }
    this.el.classList.add('is-dragging')
  }

  private endDrag(): void {
    this.el.classList.remove('is-dragging')
    const view = this.view
    const dragging = view.dragging
    // 拖到编辑区外(如侧栏)时 ProseMirror 收不到 drop,这里清掉,免得下次外部拖入被当成移动
    window.setTimeout(() => {
      if (view.dragging === dragging) view.dragging = null
      activeDrag = null
    }, 50)
  }

  update(): void {
    if (this.current && this.view.state.doc.nodeAt(this.current.pos) !== this.current.node) {
      this.current = null
      this.el.hidden = true
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.view.dom.removeEventListener('mouseleave', this.onLeave)
    this.menu.close('api')
    this.el.remove()
  }
}
