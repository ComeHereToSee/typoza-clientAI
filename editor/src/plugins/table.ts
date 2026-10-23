// 表格工具条:光标在表格里时浮在表格上方(PRD 3.6、对照表 X-36):调整行列数、左 / 中 / 右对齐、删除表格、
// 更多(插入行列、删除行列、复制表格、格式化源码)。表格内 ⌃⌘ 方向键移动行列、拖行左边框 / 列上边框换位(X-37),
// 多选单元格后 ⌘D 向下填充、⌘R 向右填充。
import { NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import {
  TableMap,
  type TableRect,
  addColumn,
  addColumnAfter,
  addColumnBefore,
  addRow,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  findTable,
  isInTable,
  moveTableColumn,
  moveTableRow,
  removeColumn,
  removeRow,
  selectedRect,
} from 'prosemirror-tables'
import type { Command, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { fillCells } from '../core/commands'
import type { EditorEnv } from '../core/env'
import { registerCommand, runCommand } from '../core/registry'
import { h } from '../ui/dom'
import { FloatingMenu } from '../ui/menu'
import { pickTableSize } from '../ui/table-size'
import { clipboardWriter } from './paste'

type Align = 'left' | 'center' | 'right' | null

/** 整列对齐(GFM 的对齐是按列的)。 */
export function alignColumn(align: Align): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    const rect = selectedRect(state)
    if (dispatch) {
      const tr = state.tr
      for (let row = 0; row < rect.map.height; row++) {
        for (let col = rect.left; col < rect.right; col++) {
          const pos = rect.tableStart + rect.map.map[row * rect.map.width + col]
          const cell = tr.doc.nodeAt(pos)
          if (cell && cell.attrs.align !== align) tr.setNodeMarkup(pos, null, { ...cell.attrs, align })
        }
      }
      dispatch(tr)
    }
    return true
  }
}

function moveCurrent(kind: 'row' | 'column', dir: -1 | 1): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false
    const rect = selectedRect(state)
    if (kind === 'row') {
      const from = rect.top
      const to = from + dir
      if (to < 1 || to >= rect.map.height || from === 0) return false // 表头行不参与移动
      return moveTableRow({ from, to })(state, dispatch)
    }
    const from = rect.left
    const to = from + dir
    if (to < 0 || to >= rect.map.width) return false
    return moveTableColumn({ from, to })(state, dispatch)
  }
}

/** 把光标所在的表格调整为 rows 行(含表头行)× cols 列:在末尾增删行列。 */
export function resizeTable(rows: number, cols: number): Command {
  return (state, dispatch) => {
    const found = findTable(state.selection.$from)
    if (!found || rows < 1 || cols < 1) return false
    if (dispatch) {
      // prosemirror-tables 的 addColumn 会把位置再经过整个事务的映射,同一事务里前面已有增删时会算错;
      // 所以每加 / 删一行一列都在上一步的结果上新开事务,最后把各步合成一个事务(撤销时一步撤回)
      let current = state
      const steps: Transaction['steps'][number][] = []
      const apply = (op: (tr: Transaction, rect: TableRect) => void) => {
        const tr = current.tr
        const table = tr.doc.nodeAt(found.pos)
        if (!table) throw new Error('调整行列数时表格丢失')
        const map = TableMap.get(table)
        op(tr, { left: 0, top: 0, right: map.width, bottom: map.height, map, table, tableStart: found.pos + 1 })
        steps.push(...tr.steps)
        current = current.apply(tr)
        return map
      }
      const size = () => TableMap.get(current.doc.nodeAt(found.pos) ?? found.node)
      while (size().height < rows) apply((tr, r) => addRow(tr, r, r.map.height))
      while (size().height > rows) apply((tr, r) => removeRow(tr, r, r.map.height - 1))
      while (size().width < cols) apply((tr, r) => addColumn(tr, r, r.map.width))
      while (size().width > cols) apply((tr, r) => removeColumn(tr, r, r.map.width - 1))
      const tr = state.tr
      for (const step of steps) tr.step(step)
      // 光标放到第一格,不会落进被删的格子
      tr.setSelection(TextSelection.near(tr.doc.resolve(found.pos + 3)))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

/** 格式化表格源码:换成结构相同的新节点,保存时不再沿用原文,按对齐的竖线重写(对照表 P-19)。 */
const formatTableSource: Command = (state, dispatch) => {
  const found = findTable(state.selection.$from)
  if (!found) return false
  if (dispatch) {
    const copy = found.node.type.create(found.node.attrs, found.node.content, found.node.marks)
    const tr = state.tr.replaceWith(found.pos, found.pos + found.node.nodeSize, copy)
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(state.selection.from, tr.doc.content.size))))
    dispatch(tr)
  }
  return true
}

/** 复制表格:整张表经宿主写进剪贴板,同时有 Markdown、HTML 与 RTF(对照表 P-18;菜单栏、工具条、右键同一做法)。 */
function copyTable(view: EditorView, env: EditorEnv): boolean {
  const found = findTable(view.state.selection.$from)
  if (!found) return false
  clipboardWriter(view, env, NodeSelection.create(view.state.doc, found.pos).content())().catch((err: unknown) =>
    env.actions.notify(`复制表格失败:${err instanceof Error ? err.message : String(err)}`, true),
  )
  return true
}

/** 工具条「调整行列数」/ 菜单命令:弹出行列选择后调整当前表格。 */
function askResize(view: EditorView, anchor?: { left: number; top: number; bottom: number }): boolean {
  if (!isInTable(view.state)) return false
  const { map } = selectedRect(view.state)
  const pos = view.state.selection.from
  void pickTableSize({ title: '调整表格', initial: { rows: map.height, cols: map.width }, anchor: anchor ?? view.coordsAtPos(pos) }).then((size) => {
    view.focus()
    if (size) resizeTable(size.rows, size.cols)(view.state, view.dispatch)
  })
  return true
}

const st = (cmd: Command) => (view: EditorView) => cmd(view.state, view.dispatch)

for (const def of [
  { id: 'table.rowAbove', label: '上方插入行', run: st(addRowBefore) },
  { id: 'table.rowBelow', label: '下方插入行', run: st(addRowAfter) },
  { id: 'table.colLeft', label: '左侧插入列', run: st(addColumnBefore) },
  { id: 'table.colRight', label: '右侧插入列', run: st(addColumnAfter) },
  { id: 'table.deleteRow', label: '删除行', run: st(deleteRow) },
  { id: 'table.deleteCol', label: '删除列', run: st(deleteColumn) },
  { id: 'table.delete', label: '删除表格', run: st(deleteTable) },
  { id: 'table.alignLeft', label: '左对齐', run: st(alignColumn('left')) },
  { id: 'table.alignCenter', label: '居中', run: st(alignColumn('center')) },
  { id: 'table.alignRight', label: '右对齐', run: st(alignColumn('right')) },
  { id: 'table.moveRowUp', label: '上移该行', run: st(moveCurrent('row', -1)) },
  { id: 'table.moveRowDown', label: '下移该行', run: st(moveCurrent('row', 1)) },
  { id: 'table.moveColLeft', label: '左移该列', run: st(moveCurrent('column', -1)) },
  { id: 'table.moveColRight', label: '右移该列', run: st(moveCurrent('column', 1)) },
  { id: 'table.fillDown', label: '向下填充', run: st(fillCells('down')) },
  { id: 'table.fillRight', label: '向右填充', run: st(fillCells('right')) },
  { id: 'table.resize', label: '调整行列数', run: (view: EditorView) => askResize(view) },
  { id: 'table.formatSource', label: '格式化表格源码', run: st(formatTableSource) },
]) {
  registerCommand(def)
}

/** Typora 表格内快捷键:⌃⌘ 方向键移动行列,⇧⌘⌫ 删除行;多选单元格时 ⌘R 向右填充(⌘D 向下填充在「复制块」命令里分流)。 */
export const TABLE_KEYS: Record<string, string> = {
  'Ctrl-Mod-ArrowUp': 'table.moveRowUp',
  'Ctrl-Mod-ArrowDown': 'table.moveRowDown',
  'Ctrl-Mod-ArrowLeft': 'table.moveColLeft',
  'Ctrl-Mod-ArrowRight': 'table.moveColRight',
  'Mod-Shift-Backspace': 'table.deleteRow',
  'Mod-r': 'table.fillRight',
}

export function tableToolbarPlugin(env: EditorEnv): Plugin {
  // 复制表格要经宿主写剪贴板,命令在这里注册(要用 env)
  registerCommand({ id: 'table.copy', label: '复制表格', run: (view) => copyTable(view, env) })
  return new Plugin({ view: (view) => new TableToolbar(view) })
}

class TableToolbar {
  private readonly el: HTMLDivElement
  private readonly more = new FloatingMenu({ className: 'tz-table-more' })
  private readonly rowGrip: HTMLDivElement
  private readonly colGrip: HTMLDivElement
  private readonly drop: HTMLDivElement
  private readonly host: HTMLElement
  /** 手柄当前对应的表格位置与行 / 列序号 */
  private hover: { tablePos: number; row: number; col: number } | null = null
  private hideTimer = 0
  private readonly onMove = (e: MouseEvent) => this.trackCell(e)

  constructor(private readonly view: EditorView) {
    const btn = (label: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = h('button', { type: 'button', class: 'tz-table-btn', title }, label)
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        run(b)
      })
      return b
    }
    const cmd = (id: string) => () => {
      runCommand(this.view, id)
      this.view.focus()
    }
    const anchorOf = (b: HTMLElement) => {
      const r = b.getBoundingClientRect()
      return { left: r.left, top: r.top, bottom: r.bottom }
    }
    this.el = h(
      'div',
      { class: 'tz-table-toolbar', hidden: true },
      btn('▦', '调整行列数', (b) => askResize(this.view, anchorOf(b))),
      h('span', { class: 'tz-tb-sep' }),
      btn('⇤', '左对齐', cmd('table.alignLeft')),
      btn('⇹', '居中', cmd('table.alignCenter')),
      btn('⇥', '右对齐', cmd('table.alignRight')),
      h('span', { class: 'tz-tb-sep' }),
      btn('删表', '删除表格', cmd('table.delete')),
      btn('…', '更多', (b) =>
        this.more.open(
          [
            { id: 'table.rowAbove', label: '上方插入行', run: cmd('table.rowAbove') },
            { id: 'table.rowBelow', label: '下方插入行', hint: '⌘↩', run: cmd('table.rowBelow') },
            { id: 'table.colLeft', label: '左侧插入列', run: cmd('table.colLeft') },
            { id: 'table.colRight', label: '右侧插入列', run: cmd('table.colRight') },
            { id: 'table.deleteRow', label: '删除行', hint: '⇧⌘⌫', run: cmd('table.deleteRow') },
            { id: 'table.deleteCol', label: '删除列', run: cmd('table.deleteCol') },
            { id: 'table.copy', label: '复制表格', run: cmd('table.copy') },
            { id: 'table.formatSource', label: '格式化源码', run: cmd('table.formatSource') },
          ],
          anchorOf(b),
        ),
      ),
    )
    this.rowGrip = h('div', { class: 'tz-table-grip tz-table-grip-row', title: '拖动调整行的位置', hidden: true })
    this.colGrip = h('div', { class: 'tz-table-grip tz-table-grip-col', title: '拖动调整列的位置', hidden: true })
    this.drop = h('div', { class: 'tz-table-drop', hidden: true })
    this.host = view.dom.parentElement ?? document.body
    this.host.append(this.el, this.rowGrip, this.colGrip, this.drop)
    this.rowGrip.addEventListener('pointerdown', (e) => this.startDrag(e, 'row'))
    this.colGrip.addEventListener('pointerdown', (e) => this.startDrag(e, 'column'))
    for (const grip of [this.rowGrip, this.colGrip]) {
      grip.addEventListener('mouseenter', () => clearTimeout(this.hideTimer))
      grip.addEventListener('mouseleave', () => this.scheduleHideGrips())
    }
    view.dom.addEventListener('mousemove', this.onMove)
  }

  /** 相对编辑器外层容器的位置(工具条、手柄都绝对定位在这个容器里)。 */
  private offset(r: DOMRect): { left: number; top: number } {
    const box = this.host.getBoundingClientRect()
    return { left: r.left - box.left + this.host.scrollLeft, top: r.top - box.top + this.host.scrollTop }
  }

  update(view: EditorView): void {
    const state = view.state
    if (!isInTable(state) || !view.editable) {
      this.el.hidden = true
      return
    }
    const table = findTable(state.selection.$from)
    if (!table) {
      this.el.hidden = true
      return
    }
    const dom = view.nodeDOM(table.pos)
    if (!(dom instanceof HTMLElement)) return
    this.el.hidden = false
    const p = this.offset(dom.getBoundingClientRect())
    this.el.style.transform = `translate(${Math.round(p.left)}px, ${Math.round(p.top - this.el.offsetHeight - 6)}px)`
  }

  // ---------- 行列拖动 ----------

  private tableDom(tablePos: number): HTMLTableElement | null {
    const dom = this.view.nodeDOM(tablePos)
    if (dom instanceof HTMLTableElement) return dom
    return dom instanceof HTMLElement ? dom.querySelector('table') : null
  }

  /** 鼠标在单元格上:在该行左边框、该列上边框显示拖动手柄。 */
  private trackCell(e: MouseEvent): void {
    if (!this.view.editable || this.drop.dataset.dragging) return
    const cell = (e.target as HTMLElement).closest?.('td, th')
    if (!(cell instanceof HTMLTableCellElement) || !this.view.dom.contains(cell)) {
      this.scheduleHideGrips()
      return
    }
    const tableEl = cell.closest('table')
    const rowEl = cell.parentElement
    if (!tableEl || !(rowEl instanceof HTMLTableRowElement)) return
    const found = findTable(this.view.state.doc.resolve(this.view.posAtDOM(cell, 0)))
    if (!found) return
    clearTimeout(this.hideTimer)
    const row = rowEl.rowIndex
    const col = cell.cellIndex
    this.hover = { tablePos: found.pos, row, col }
    const t = this.offset(tableEl.getBoundingClientRect())
    const r = this.offset(rowEl.getBoundingClientRect())
    const c = this.offset(cell.getBoundingClientRect())
    const rowRect = rowEl.getBoundingClientRect()
    const cellRect = cell.getBoundingClientRect()
    // 表头行不能移动(GFM 第一行固定为表头)
    this.rowGrip.hidden = row === 0
    this.rowGrip.style.transform = `translate(${Math.round(t.left - 10)}px, ${Math.round(r.top + 4)}px)`
    this.rowGrip.style.height = `${Math.max(8, Math.round(rowRect.height - 8))}px`
    this.colGrip.hidden = false
    this.colGrip.style.transform = `translate(${Math.round(c.left + 4)}px, ${Math.round(t.top - 10)}px)`
    this.colGrip.style.width = `${Math.max(8, Math.round(cellRect.width - 8))}px`
  }

  private scheduleHideGrips(): void {
    clearTimeout(this.hideTimer)
    this.hideTimer = window.setTimeout(() => {
      if (this.drop.dataset.dragging) return
      this.rowGrip.hidden = true
      this.colGrip.hidden = true
    }, 400)
  }

  /** 按下手柄拖动:按指针位置算出目标行 / 列,松开时移动(表头行不参与)。 */
  private startDrag(e: PointerEvent, kind: 'row' | 'column'): void {
    const hover = this.hover
    if (!hover || e.button !== 0) return
    const tableEl = this.tableDom(hover.tablePos)
    if (!tableEl) return
    e.preventDefault()
    const grip = kind === 'row' ? this.rowGrip : this.colGrip
    grip.setPointerCapture(e.pointerId)
    grip.classList.add('is-dragging')
    this.drop.dataset.dragging = '1'
    const from = kind === 'row' ? hover.row : hover.col
    let to = from
    const rows = Array.from(tableEl.rows)
    const cells = Array.from(rows[0]?.cells ?? [])
    const tableRect = tableEl.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      if (kind === 'row') {
        to = rows.findIndex((r) => ev.clientY < r.getBoundingClientRect().bottom)
        if (to < 0) to = rows.length - 1
        to = Math.max(1, to)
        const target = rows[to].getBoundingClientRect()
        const p = this.offset(target)
        this.drop.style.transform = `translate(${Math.round(this.offset(tableRect).left)}px, ${Math.round(to > from ? p.top + target.height - 1 : p.top - 1)}px)`
        this.drop.style.width = `${Math.round(tableRect.width)}px`
        this.drop.style.height = '3px'
      } else {
        to = cells.findIndex((c) => ev.clientX < c.getBoundingClientRect().right)
        if (to < 0) to = cells.length - 1
        const target = cells[to].getBoundingClientRect()
        const p = this.offset(target)
        this.drop.style.transform = `translate(${Math.round(to > from ? p.left + target.width - 1 : p.left - 1)}px, ${Math.round(this.offset(tableRect).top)}px)`
        this.drop.style.width = '3px'
        this.drop.style.height = `${Math.round(tableRect.height)}px`
      }
      this.drop.hidden = to === from
    }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      grip.classList.remove('is-dragging')
      delete this.drop.dataset.dragging
      this.drop.hidden = true
      if (to === from) return
      // prosemirror-tables 取行列时按当前选区找表格(pos 参数只管找表),先把光标放进被拖的行 / 列
      const table = this.view.state.doc.nodeAt(hover.tablePos)
      if (!table) return
      const cellPos = hover.tablePos + 1 + TableMap.get(table).positionAt(kind === 'row' ? from : 0, kind === 'row' ? 0 : from, table)
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(cellPos + 1))))
      const options = { from, to, pos: hover.tablePos + 1 }
      const cmd = kind === 'row' ? moveTableRow(options) : moveTableColumn(options)
      cmd(this.view.state, this.view.dispatch)
      this.view.focus()
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }

  destroy(): void {
    clearTimeout(this.hideTimer)
    this.view.dom.removeEventListener('mousemove', this.onMove)
    this.more.close('api')
    this.el.remove()
    this.rowGrip.remove()
    this.colGrip.remove()
    this.drop.remove()
  }
}
