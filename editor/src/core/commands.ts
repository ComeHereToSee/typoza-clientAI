// 编辑命令。快捷键、斜杠菜单、块菜单、原生菜单栏都调用这里,保证同一个功能只有一份实现。
import { lift, selectAll, setBlockType, toggleMark, wrapIn } from 'prosemirror-commands'
import { redo, undo } from 'prosemirror-history'
import { Fragment, type Mark, type MarkType, type Node as PMNode, type NodeType, type ResolvedPos } from 'prosemirror-model'
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list'
import { type Command, type EditorState, NodeSelection, Selection, TextSelection, type Transaction } from 'prosemirror-state'
import { CellSelection, TableMap, addRow, goToNextCell, isInTable, selectedRect } from 'prosemirror-tables'
import type { EditorView } from 'prosemirror-view'
import { BlockSelection, reselectBlocks, selectBlocks, selectedBlocks } from './block-selection'
import { type BlockInfo, blockAt, selectedBlock, selectedBlockRange } from './blocks'
import type { DocMeta } from './markdown/parse'
import { serializeBlocks } from './markdown/serialize'
import { type MediaKind, schema } from './schema'

const n = schema.nodes
const m = schema.marks

/** 只改界面状态(如折叠块展开)的事务带这个标记:不进撤销历史、不算文档修改。 */
export const UI_ONLY = 'tz-ui-only'

export function isUiOnly(tr: Transaction): boolean {
  return tr.getMeta(UI_ONLY) === true
}

// ---------- 通用工具 ----------

export function findAncestor($pos: ResolvedPos, type: NodeType): { node: PMNode; pos: number; depth: number } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type === type) return { node, pos: $pos.before(d), depth: d }
  }
  return null
}

/** 光标处某个标记的连续范围(用于编辑链接、颜色)。光标在标记末尾时也算。 */
export function markRange($pos: ResolvedPos, type: MarkType): { from: number; to: number; mark: Mark } | null {
  const parent = $pos.parent
  const offset = $pos.parentOffset
  const after = parent.childAfter(offset)
  const before = offset > 0 ? parent.childBefore(offset) : null
  let found: Mark | undefined
  let index: number
  if (after.node && (found = type.isInSet(after.node.marks))) index = after.index
  else if (before?.node && (found = type.isInSet(before.node.marks))) index = before.index
  else return null
  const mark = found
  let first = index
  let last = index + 1
  while (first > 0 && mark.isInSet(parent.child(first - 1).marks)) first--
  while (last < parent.childCount && mark.isInSet(parent.child(last).marks)) last++
  let from = $pos.start()
  for (let i = 0; i < first; i++) from += parent.child(i).nodeSize
  let to = from
  for (let i = first; i < last; i++) to += parent.child(i).nodeSize
  return { from, to, mark }
}

function liftAllLists(view: EditorView): void {
  let guard = 0
  while (findAncestor(view.state.selection.$from, n.list_item) && guard++ < 20) {
    if (!liftListItem(n.list_item)(view.state, view.dispatch)) break
  }
}

// ---------- 块类型(Notion「转换为」) ----------

export type BlockKind =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'bullet'
  | 'numbered'
  | 'todo'
  | 'toggle'
  | 'toggleh1'
  | 'toggleh2'
  | 'toggleh3'
  | 'quote'
  | 'callout'
  | 'code'
  | 'math'

/** 折叠块与折叠标题 1~3 对应的标题级别(0 为普通折叠块)。 */
const TOGGLE_LEVEL: Partial<Record<BlockKind, number>> = { toggle: 0, toggleh1: 1, toggleh2: 2, toggleh3: 3 }

/** 当前块的类型,用于菜单打勾。 */
export function currentBlockKind(state: EditorState): BlockKind | null {
  return blockKindAt(state.selection.$from)
}

/** 某个文字位置所在块的类型。 */
export function blockKindAt($from: ResolvedPos): BlockKind | null {
  const tb = $from.parent
  const item = findAncestor($from, n.list_item)
  if (item) {
    if (item.node.attrs.checked !== null) return 'todo'
    const list = $from.node(item.depth - 1)
    return list.type === n.ordered_list ? 'numbered' : 'bullet'
  }
  if (tb.type === n.toggle_summary) {
    const level = tb.attrs.level as number
    return level >= 1 && level <= 3 ? (`toggleh${level}` as BlockKind) : 'toggle'
  }
  if (tb.type === n.heading) return `h${tb.attrs.level}` as BlockKind
  if (tb.type === n.code_block) return 'code'
  if (tb.type === n.math_block) return 'math'
  if (findAncestor($from, n.callout)) return 'callout'
  if (findAncestor($from, n.blockquote)) return 'quote'
  if (tb.type === n.paragraph) return 'paragraph'
  return null
}

function unwrapToggle(view: EditorView): boolean {
  const { state } = view
  const $from = state.selection.$from
  const toggle = findAncestor($from, n.toggle)
  if (!toggle || $from.parent.type !== n.toggle_summary) return false
  const summary = toggle.node.firstChild!
  const blocks: PMNode[] = [n.paragraph.create(null, summary.content)]
  toggle.node.forEach((child, _o, i) => {
    if (i > 0) blocks.push(child)
  })
  const offset = $from.parentOffset
  const tr = state.tr.replaceWith(toggle.pos, toggle.pos + toggle.node.nodeSize, blocks)
  tr.setSelection(TextSelection.create(tr.doc, toggle.pos + 1 + offset))
  view.dispatch(tr)
  return true
}

const SOURCE_META: DocMeta = { lineEnding: '\n', bom: false, leading: '', trailing: '\n', bullet: '-' }

/**
 * 行内内容 → Markdown 源码文字(转为代码块 / 公式块时行内样式变成源码,notion-input.md 7.3)。
 * 段内换行变成换行符;没有任何格式时直接取文字,避免序列化转义改动原文(如「1. 」会被写成「1\. 」)。
 */
export function inlineSourceText(content: Fragment): string {
  const lines: PMNode[][] = [[]]
  let styled = false
  content.forEach((child) => {
    if (child.type === n.hard_break) {
      lines.push([])
      return
    }
    if (!child.isText || child.marks.length > 0) styled = true
    lines[lines.length - 1].push(child)
  })
  return lines
    .map((nodes) => {
      if (nodes.length === 0) return ''
      if (!styled) return nodes.map((x) => x.text ?? '').join('')
      return serializeBlocks([n.paragraph.create(null, nodes)], SOURCE_META, { inlineMath: true, ensureTrailingNewline: false }).replace(/\n+$/, '')
    })
    .join('\n')
}

/** 代码块 / 公式块 → 段落:多行合为一个段落,行间为段内换行(notion-input.md 7.3【假设】)。 */
function codeToParagraph(view: EditorView): void {
  const { state } = view
  const $f = state.selection.$from
  const tb = $f.parent
  const content: PMNode[] = []
  tb.textContent.split('\n').forEach((line, i) => {
    if (i > 0) content.push(n.hard_break.create())
    if (line) content.push(schema.text(line))
  })
  const start = $f.before()
  const tr = state.tr.replaceWith(start, start + tb.nodeSize, n.paragraph.create(null, content))
  tr.setSelection(TextSelection.create(tr.doc, start + 1))
  view.dispatch(tr)
}

/** 只有不带格式的文字(没有标记、没有图片等行内节点)。 */
function isPlainText(content: Fragment): boolean {
  const flags: boolean[] = []
  content.forEach((child) => flags.push(child.isText && child.marks.length === 0))
  return flags.every(Boolean)
}

/** 当前文本块的行内样式换成 Markdown 源码文字(随后再改成代码块 / 公式块)。 */
function inlineToSource(view: EditorView): void {
  const { state } = view
  const $f = state.selection.$from
  const tb = $f.parent
  if (tb.type.spec.code || tb.content.size === 0 || isPlainText(tb.content)) return
  const source = inlineSourceText(tb.content)
  const tr = state.tr.replaceWith($f.start(), $f.end(), source ? schema.text(source) : Fragment.empty)
  tr.setSelection(TextSelection.create(tr.doc, $f.start()))
  view.dispatch(tr)
}

export function turnInto(view: EditorView, kind: BlockKind, attrs: Record<string, unknown> = {}): boolean {
  const first = view.state.selection.$from
  if (!first.parent.isTextblock) return false
  const toggleLevel = TOGGLE_LEVEL[kind]
  if (first.parent.type === n.toggle_summary && toggleLevel === undefined) unwrapToggle(view)
  if ((first.parent.type === n.code_block || first.parent.type === n.math_block) && kind !== 'code' && kind !== 'math') codeToParagraph(view)
  const $from = view.state.selection.$from

  switch (kind) {
    case 'paragraph':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
    case 'code':
    case 'math': {
      liftAllLists(view)
      if (kind === 'paragraph') {
        // 引用 / 提示框里的段落再「转为文本」时,先移出容器(Notion:引用转文本就是普通文本)
        const s = view.state
        if (s.selection.$from.parent.type === n.paragraph && (findAncestor(s.selection.$from, n.blockquote) || findAncestor(s.selection.$from, n.callout))) {
          return lift(s, view.dispatch)
        }
      }
      if (kind === 'code' || kind === 'math') inlineToSource(view)
      const type = kind === 'paragraph' ? n.paragraph : kind === 'code' ? n.code_block : kind === 'math' ? n.math_block : n.heading
      const a = kind.startsWith('h') ? { level: Number(kind.slice(1)) } : kind === 'code' ? { language: attrs.language ?? '' } : null
      return setBlockType(type, a)(view.state, view.dispatch)
    }
    case 'bullet':
    case 'numbered':
    case 'todo':
      return toList(view, kind)
    case 'toggle':
    case 'toggleh1':
    case 'toggleh2':
    case 'toggleh3': {
      const level = toggleLevel ?? 0
      liftAllLists(view)
      const s = view.state
      const $f = s.selection.$from
      const tb = $f.parent
      if (tb.type === n.toggle_summary) {
        if (tb.attrs.level !== level) view.dispatch(s.tr.setNodeMarkup($f.before(), null, { level }))
        return true
      }
      if (!(tb.type === n.paragraph || tb.type === n.heading)) return false
      const start = $f.before()
      const toggle = n.toggle.create(null, [n.toggle_summary.create({ level }, tb.content)])
      const tr = s.tr.replaceWith(start, start + tb.nodeSize, toggle)
      tr.setSelection(TextSelection.create(tr.doc, start + 2 + $f.parentOffset))
      view.dispatch(tr)
      return true
    }
    case 'quote':
      if (findAncestor($from, n.blockquote)) return lift(view.state, view.dispatch)
      liftAllLists(view)
      return wrapIn(n.blockquote)(view.state, view.dispatch)
    case 'callout': {
      const callout = findAncestor($from, n.callout)
      if (callout) {
        // 已在标注块里:指定了别的类型就切换类型,否则移出标注块
        if (typeof attrs.kind === 'string' && attrs.kind !== callout.node.attrs.kind) {
          view.dispatch(view.state.tr.setNodeMarkup(callout.pos, null, { ...callout.node.attrs, kind: attrs.kind }))
          return true
        }
        return lift(view.state, view.dispatch)
      }
      liftAllLists(view)
      // /callout 默认提醒类(`> [!NOTE]`,notion-input.md 4.2)
      return wrapIn(n.callout, { kind: typeof attrs.kind === 'string' ? attrs.kind : 'note', title: '' })(view.state, view.dispatch)
    }
  }
}

/** 块里第一个文本块的内容起点;没有文本块返回 null。 */
export function firstTextPos(doc: PMNode, pos: number): number | null {
  const node = doc.nodeAt(pos)
  if (!node) return null
  if (node.isTextblock) return pos + 1
  let found: number | null = null
  node.descendants((child, offset) => {
    if (found !== null) return false
    if (child.isTextblock) {
      found = pos + 1 + offset + 1
      return false
    }
    return true
  })
  return found
}

/** 「转换为」作用于当前选择:光标所在块,或选中的一块 / 多块(多块逐块转换,notion-input.md 7.3)。 */
export function turnSelectedInto(view: EditorView, kind: BlockKind, attrs: Record<string, unknown> = {}): boolean {
  const sel = view.state.selection
  if (!(sel instanceof BlockSelection) && !(sel instanceof NodeSelection && sel.node.isBlock)) return turnInto(view, kind, attrs)
  const blocks = selectedBlocks(view.state)
  let ok = false
  // 从后往前转换:后面块的结构变化不影响前面块的位置
  for (const b of [...blocks].reverse()) {
    const start = firstTextPos(view.state.doc, b.pos)
    if (start === null) continue
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)))
    if (turnInto(view, kind, attrs)) ok = true
  }
  return ok
}

/** 只含图片的段落(在 Notion 里就是一个图片块)。 */
export function isImageParagraph(node: PMNode): boolean {
  if (node.type !== n.paragraph || node.childCount === 0) return false
  let images = 0
  let other = false
  node.forEach((child) => {
    if (child.type === n.image) images++
    else if (!(child.isText && !(child.text ?? '').trim())) other = true
  })
  return images > 0 && !other
}

/** 能「转换为」其它类型的块;表格、图片、媒体、分割线、目录等不可转换(notion-input.md 7.3)。 */
export function isConvertibleBlock(node: PMNode): boolean {
  if (node.type === n.paragraph) return !isImageParagraph(node)
  if (node.type === n.heading || node.type === n.code_block || node.type === n.math_block) return true
  if (node.type === n.list_item || node.type === n.toggle || node.type === n.blockquote || node.type === n.callout) {
    return Boolean(node.firstChild?.isTextblock) && !isImageParagraph(node.firstChild!)
  }
  return false
}

/** 能设颜色的块;表格、图片、媒体、代码、公式块不显示「颜色」(notion-input.md 7.2)。 */
export function isColorableBlock(node: PMNode): boolean {
  const excluded = [n.table, n.media, n.code_block, n.math_block, n.horizontal_rule, n.toc, n.definition, n.html_block, n.frontmatter]
  return !excluded.includes(node.type) && !isImageParagraph(node)
}

/** 给若干块里的全部文字设颜色(整块设色;代码块等不含格式的文本块跳过)。 */
export function setBlocksColor(blocks: readonly BlockInfo[], color: string | null, background: string | null): Command {
  return (state, dispatch) => {
    if (blocks.length === 0) return false
    if (dispatch) {
      const tr = state.tr
      const paint = (from: number, to: number) => {
        if (to <= from) return
        tr.removeMark(from, to, m.color)
        if (color || background) tr.addMark(from, to, m.color.create({ color, background }))
      }
      for (const b of blocks) {
        if (b.node.isTextblock) {
          if (!b.node.type.spec.code) paint(b.pos + 1, b.pos + 1 + b.node.content.size)
          continue
        }
        b.node.descendants((child, offset) => {
          if (!child.isTextblock) return true
          if (!child.type.spec.code) {
            const start = b.pos + 1 + offset + 1
            paint(start, start + child.content.size)
          }
          return false
        })
      }
      dispatch(tr)
    }
    return true
  }
}

/** 若干块 → Markdown(复制为 Markdown、移动到…)。同一列表里连续的列表项仍合成一个列表。 */
export function blocksToMarkdown(doc: PMNode, blocks: readonly BlockInfo[], inlineMath: boolean): string {
  const out: PMNode[] = []
  let group: { listPos: number; items: PMNode[]; list: PMNode } | null = null
  const flush = () => {
    if (!group) return
    const { list, items } = group
    out.push(list.type === n.ordered_list ? n.ordered_list.create({ ...list.attrs, start: 1 }, items) : n.bullet_list.create(list.attrs, items))
    group = null
  }
  for (const b of blocks) {
    if (b.node.type !== n.list_item) {
      flush()
      out.push(b.node)
      continue
    }
    const $b = doc.resolve(b.pos)
    const listPos = $b.before()
    if (!group || group.listPos !== listPos) {
      flush()
      group = { listPos, items: [], list: $b.parent }
    }
    group.items.push(b.node)
  }
  flush()
  return serializeBlocks(out, SOURCE_META, { inlineMath, ensureTrailingNewline: false }).replace(/\n+$/, '')
}

function toList(view: EditorView, kind: 'bullet' | 'numbered' | 'todo'): boolean {
  const state = view.state
  const $from = state.selection.$from
  const listType = kind === 'numbered' ? n.ordered_list : n.bullet_list
  const checked = kind === 'todo' ? false : null
  const item = findAncestor($from, n.list_item)
  if (item) {
    const listDepth = item.depth - 1
    const list = $from.node(listDepth)
    const listPos = $from.before(listDepth)
    const tr = state.tr
    if (list.type !== listType) tr.setNodeMarkup(listPos, listType, listType === n.ordered_list ? { start: 1, tight: list.attrs.tight } : { tight: list.attrs.tight })
    const current = item.node.attrs.checked
    if ((checked === null) !== (current === null)) tr.setNodeMarkup(item.pos, null, { checked })
    view.dispatch(tr)
    return true
  }
  if (!wrapInList(listType)(state, view.dispatch)) return false
  if (checked !== null) {
    const it = findAncestor(view.state.selection.$from, n.list_item)
    if (it) view.dispatch(view.state.tr.setNodeMarkup(it.pos, null, { checked }))
  }
  return true
}

// ---------- 块操作 ----------

export const selectCurrentBlock: Command = (state, dispatch) => {
  const block = selectedBlock(state.selection)
  if (!block) return false
  if (dispatch) dispatch(state.tr.setSelection(NodeSelection.create(state.doc, block.pos)))
  return true
}

/** 选择对应的连续块范围;多块选择不连续时为 null(不能整体移动)。 */
function blockRangeOf(state: EditorState): { from: number; to: number; depth: number } | null {
  if (!(state.selection instanceof BlockSelection)) return selectedBlockRange(state)
  const blocks = selectedBlocks(state)
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].pos !== blocks[i - 1].pos + blocks[i - 1].node.nodeSize) return null
  }
  const last = blocks[blocks.length - 1]
  return { from: blocks[0].pos, to: last.pos + last.node.nodeSize, depth: blocks[0].depth }
}

/** ⌘D:复制所选块;表格里选中多个单元格时为向下填充(notion-input.md 5.1 第 39 行)。 */
export const duplicateBlock: Command = (state, dispatch) => {
  if (state.selection instanceof CellSelection) return fillCells('down')(state, dispatch)
  const sel = state.selection
  if (sel instanceof BlockSelection) {
    // 多块:副本按原顺序放在最后一个所选块之后,并选中副本
    const blocks = selectedBlocks(state)
    const last = blocks[blocks.length - 1]
    const end = last.pos + last.node.nodeSize
    if (dispatch) {
      const tr = state.tr.insert(end, Fragment.fromArray(blocks.map((b) => b.node)))
      const positions: number[] = []
      let pos = end
      for (const b of blocks) {
        positions.push(pos)
        pos += b.node.nodeSize
      }
      tr.setSelection(selectBlocks(tr.doc, positions, positions[0], positions[positions.length - 1]))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  const range = selectedBlockRange(state)
  if (!range) return false
  const content = state.doc.slice(range.from, range.to).content
  if (dispatch) {
    const size = range.to - range.from
    const tr = state.tr.insert(range.to, content)
    if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, sel.from + size))
    else tr.setSelection(TextSelection.create(tr.doc, sel.anchor + size, sel.head + size))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export function moveBlock(dir: -1 | 1): Command {
  return (state, dispatch) => {
    const range = blockRangeOf(state)
    if (!range) return false
    const $start = state.doc.resolve(range.from)
    const container = $start.node(range.depth)
    const first = $start.index(range.depth)
    const after = state.doc.resolve(range.to).index(range.depth)
    const sel = state.selection
    const tr = state.tr
    let delta: number
    if (dir < 0) {
      if (first === 0) return false
      const prev = container.child(first - 1)
      if (prev.type === n.frontmatter || prev.type === n.toggle_summary) return false
      tr.delete(range.from - prev.nodeSize, range.from)
      tr.insert(range.to - prev.nodeSize, prev)
      delta = -prev.nodeSize
    } else {
      if (after >= container.childCount) return false
      const next = container.child(after)
      tr.delete(range.to, range.to + next.nodeSize)
      tr.insert(range.from, next)
      delta = next.nodeSize
    }
    if (dispatch) {
      if (sel instanceof BlockSelection) {
        tr.setSelection(selectBlocks(tr.doc, sel.positions.map((p) => p + delta), sel.anchorBlock + delta, sel.headBlock + delta))
      } else if (sel instanceof NodeSelection) tr.setSelection(NodeSelection.create(tr.doc, sel.from + delta))
      else tr.setSelection(TextSelection.create(tr.doc, sel.anchor + delta, sel.head + delta))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
}

export const deleteBlock: Command = (state, dispatch) => {
  if (state.selection instanceof BlockSelection) {
    const blocks = selectedBlocks(state)
    if (dispatch) {
      const $first = state.doc.resolve(blocks[0].pos)
      let selectable = 0
      $first.parent.forEach((child) => {
        if (child.type !== n.frontmatter && child.type !== n.toggle_summary) selectable++
      })
      const tr = state.tr
      if (blocks.length >= selectable) {
        // 容器里的块全删了:留一个空段落,容器结构保持合法
        const last = blocks[blocks.length - 1]
        tr.replaceWith(blocks[0].pos, last.pos + last.node.nodeSize, n.paragraph.create())
      } else {
        for (const b of [...blocks].reverse()) tr.delete(b.pos, b.pos + b.node.nodeSize)
      }
      tr.setSelection(Selection.near(tr.doc.resolve(Math.min(blocks[0].pos, tr.doc.content.size))))
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  const range = selectedBlockRange(state)
  if (!range) return false
  if (dispatch) {
    const container = state.doc.resolve(range.from).node(range.depth)
    const removesAll = range.to - range.from >= container.content.size
    const tr = removesAll
      ? state.tr.replaceWith(range.from, range.to, n.paragraph.create())
      : state.tr.delete(range.from, range.to)
    const pos = Math.min(range.from, tr.doc.content.size)
    tr.setSelection(Selection.near(tr.doc.resolve(pos)))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Cmd+A:先选中当前块的文字,再按一次全选(Notion 行为)。 */
export const progressiveSelectAll: Command = (state, dispatch) => {
  const { $from, $to } = state.selection
  if ($from.sameParent($to) && $from.parent.isTextblock) {
    const start = $from.start()
    const end = $from.end()
    if (!(state.selection.from === start && state.selection.to === end) && end > start) {
      if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)))
      return true
    }
  }
  return selectAll(state, dispatch)
}

// ---------- 缩进 ----------

/** 代码缩进宽度(偏好「代码缩进」,对照表 PM-18);由编辑器按设置更新。 */
let codeIndentWidth = 2

export function setCodeIndentWidth(width: number): void {
  codeIndentWidth = Math.max(1, Math.min(8, Math.round(width)))
}

function indentCode(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, dir: 1 | -1): boolean {
  const { $from, from, to } = state.selection
  if ($from.parent.type !== n.code_block && $from.parent.type !== n.math_block) return false
  if (!dispatch) return true
  const unit = ' '.repeat(codeIndentWidth)
  const start = $from.start()
  const text = $from.parent.textContent
  const tr = state.tr
  // 逐行处理选区覆盖的行;从后往前改,位置不受前面修改影响
  const lineStarts: number[] = []
  let offset = 0
  for (const line of text.split('\n')) {
    const lineFrom = start + offset
    const lineTo = lineFrom + line.length
    if (lineTo >= from && lineFrom <= to) lineStarts.push(lineFrom)
    offset += line.length + 1
  }
  if (dir > 0 && state.selection.empty) {
    dispatch(tr.insertText(unit))
    return true
  }
  const leading = new RegExp(`^( {1,${codeIndentWidth}}|\\t)`)
  for (const ls of lineStarts.reverse()) {
    if (dir > 0) tr.insertText(unit, ls)
    else {
      const lineText = text.slice(ls - start)
      const spaces = leading.exec(lineText)
      if (spaces) tr.delete(ls, ls + spaces[0].length)
    }
  }
  dispatch(tr)
  return true
}

/** 块选中态(一块或多块列表项)按 Tab / ⇧Tab:整项缩进或反缩进,完成后仍选中这些块。 */
function shiftSelectedItems(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined, dir: 1 | -1): boolean | null {
  const sel = state.selection
  if (!(sel instanceof BlockSelection) && !(sel instanceof NodeSelection && sel.node.isBlock)) return null
  const blocks = selectedBlocks(state)
  if (blocks.length === 0 || !blocks.every((b) => b.node.type === n.list_item)) return true
  const first = blocks[0]
  const last = blocks[blocks.length - 1]
  // 列表命令按文字选区找要移动的列表项:临时换成覆盖这些项的文字选区
  const span = TextSelection.between(state.doc.resolve(first.pos + 1), state.doc.resolve(last.pos + last.node.nodeSize - 1))
  const temp = state.apply(state.tr.setSelection(span))
  const cmd = dir > 0 ? sinkListItem(n.list_item) : liftListItem(n.list_item)
  cmd(temp, (tr) => {
    if (!dispatch) return
    const positions = blocks.map((b) => tr.mapping.map(b.pos, 1))
    tr.setSelection(reselectBlocks(tr.doc, positions, positions[0], positions[positions.length - 1]))
    dispatch(tr)
  })
  return true
}

/** 表格里 Tab:跳到下一格;已在末格时在表格末尾加一行,光标进新行第一格(PRD 3.6)。 */
function nextCellOrNewRow(state: EditorState, dispatch: ((tr: Transaction) => void) | undefined): boolean {
  if (goToNextCell(1)(state, dispatch)) return true
  if (dispatch) {
    const rect = selectedRect(state)
    const tr = addRow(state.tr, rect, rect.map.height)
    const table = tr.doc.nodeAt(rect.tableStart - 1)
    if (!table) throw new Error('末格 Tab 加行后找不到表格')
    const map = TableMap.get(table)
    tr.setSelection(TextSelection.create(tr.doc, rect.tableStart + map.positionAt(map.height - 1, 0, table) + 1))
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Tab:列表项下沉;代码块缩进;表格跳下一格;段落紧跟在列表后时并入上一个列表项(Notion 的「嵌套到上一块」)。 */
export const indent: Command = (state, dispatch) => {
  if (isInTable(state)) return nextCellOrNewRow(state, dispatch)
  const shifted = shiftSelectedItems(state, dispatch, 1)
  if (shifted !== null) return shifted
  if (indentCode(state, dispatch, 1)) return true
  if (findAncestor(state.selection.$from, n.list_item)) return sinkListItem(n.list_item)(state, dispatch) || true
  const block = blockAt(state.selection.$from)
  if (!block) return true
  const $b = state.doc.resolve(block.pos)
  const index = $b.index(block.depth)
  if (index === 0) return true
  const prev = $b.node(block.depth).child(index - 1)
  if (prev.type !== n.bullet_list && prev.type !== n.ordered_list) return true
  if (dispatch) {
    // 插入点:上一个列表最后一项的内容末尾(列表项结束标记之前)
    const insertAt = block.pos - 2
    const offset = state.selection.from - block.pos
    const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize).insert(insertAt, block.node)
    tr.setSelection(TextSelection.create(tr.doc, insertAt + offset))
    dispatch(tr)
  }
  return true
}

export const outdent: Command = (state, dispatch) => {
  // 首格 ⇧Tab 不跳出表格
  if (isInTable(state)) return goToNextCell(-1)(state, dispatch) || true
  const shifted = shiftSelectedItems(state, dispatch, -1)
  if (shifted !== null) return shifted
  if (indentCode(state, dispatch, -1)) return true
  if (findAncestor(state.selection.$from, n.list_item)) return liftListItem(n.list_item)(state, dispatch) || true
  return true
}

// ---------- 待办与折叠 ----------

/** Cmd+Enter:切换待办勾选;在折叠块标题里则展开/收起。 */
export const toggleCheckOrFold: Command = (state, dispatch) => {
  const $from = state.selection.$from
  const item = findAncestor($from, n.list_item)
  if (item && item.node.attrs.checked !== null) {
    if (dispatch) dispatch(state.tr.setNodeMarkup(item.pos, null, { checked: !item.node.attrs.checked }))
    return true
  }
  const toggle = findAncestor($from, n.toggle)
  if (toggle && $from.parent.type === n.toggle_summary) {
    if (dispatch) dispatch(setToggleOpen(state.tr, toggle.pos, !toggle.node.attrs.open))
    return true
  }
  return false
}

/** 标记为已完成 / 未完成(对照表 P-30):光标所在待办项设成指定状态。 */
export function setTaskChecked(checked: boolean): Command {
  return (state, dispatch) => {
    const item = findAncestor(state.selection.$from, n.list_item)
    if (!item || item.node.attrs.checked === null) return false
    if (dispatch && item.node.attrs.checked !== checked) dispatch(state.tr.setNodeMarkup(item.pos, null, { ...item.node.attrs, checked }))
    return true
  }
}

export function setToggleOpen(tr: Transaction, pos: number, open: boolean): Transaction {
  const node = tr.doc.nodeAt(pos)
  if (!node || node.type !== n.toggle) return tr
  return tr.setNodeMarkup(pos, null, { ...node.attrs, open }).setMeta(UI_ONLY, true).setMeta('addToHistory', false)
}

/** Cmd+Option+T:全部展开 / 全部收起(有任何收起的就全部展开)。 */
export const toggleAllFolds: Command = (state, dispatch) => {
  const toggles: { pos: number; open: boolean }[] = []
  state.doc.descendants((node, pos) => {
    if (node.type === n.toggle) toggles.push({ pos, open: node.attrs.open })
  })
  if (toggles.length === 0) return false
  const open = toggles.some((t) => !t.open)
  if (dispatch) {
    let tr = state.tr
    for (const t of toggles) tr = setToggleOpen(tr, t.pos, open)
    dispatch(tr)
  }
  return true
}

// ---------- 标题级别 ----------

export function setHeading(level: number): Command {
  return (state, dispatch) => {
    const tb = state.selection.$from.parent
    if (tb.type === n.heading && tb.attrs.level === level) return setBlockType(n.paragraph)(state, dispatch)
    return setBlockType(n.heading, { level })(state, dispatch)
  }
}

export function shiftHeading(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const tb = state.selection.$from.parent
    if (tb.type === n.paragraph && delta > 0) return setBlockType(n.heading, { level: 6 })(state, dispatch)
    if (tb.type !== n.heading) return false
    const level = tb.attrs.level - delta
    if (level > 6) return setBlockType(n.paragraph)(state, dispatch)
    return setBlockType(n.heading, { level: Math.max(1, level) })(state, dispatch)
  }
}

// ---------- 行内格式 ----------

export function toggleFormat(type: MarkType): Command {
  return toggleMark(type)
}

export function setColor(color: string | null, background: string | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection
    const type = m.color
    if (!dispatch) return true
    const tr = state.tr
    if (empty) {
      if (!color && !background) tr.removeStoredMark(type)
      else tr.addStoredMark(type.create({ color, background }))
    } else {
      tr.removeMark(from, to, type)
      if (color || background) tr.addMark(from, to, type.create({ color, background }))
    }
    dispatch(tr)
    return true
  }
}

export function setLink(href: string, title: string | null = null): Command {
  return (state, dispatch) => {
    const { from, to, empty, $from } = state.selection
    if (!dispatch) return true
    const tr = state.tr
    if (empty) {
      const existing = markRange($from, m.link)
      if (existing) {
        tr.removeMark(existing.from, existing.to, m.link).addMark(existing.from, existing.to, m.link.create({ href, title }))
      } else {
        const text = href
        tr.insertText(text, from).addMark(from, from + text.length, m.link.create({ href, title }))
      }
    } else {
      tr.removeMark(from, to, m.link).addMark(from, to, m.link.create({ href, title }))
    }
    dispatch(tr)
    return true
  }
}

export const removeLink: Command = (state, dispatch) => {
  const { from, to, empty, $from } = state.selection
  const range = empty ? markRange($from, m.link) : { from, to }
  if (!range) return false
  if (dispatch) dispatch(state.tr.removeMark(range.from, range.to, m.link))
  return true
}

export const clearFormatting: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection
  if (empty) return false
  if (dispatch) {
    const tr = state.tr
    for (const type of Object.values(schema.marks)) if (type !== m.link) tr.removeMark(from, to, type)
    dispatch(tr)
  }
  return true
}

// ---------- 插入 ----------

/** 插入块:当前是空段落就替换它,否则插在当前块之后。光标放进新块(或其后的段落)。 */
export function insertBlock(node: PMNode, cursorInside = true): Command {
  return (state, dispatch) => {
    const $from = state.selection.$from
    const tb = $from.parent
    if (!dispatch) return true
    const tr = state.tr
    let pos: number
    if (tb.type === n.paragraph && tb.content.size === 0) {
      pos = $from.before()
      tr.replaceWith(pos, pos + tb.nodeSize, node)
    } else {
      // 插在当前块(块选中态时为最后一个所选块)之后
      const blocks = selectedBlocks(state)
      const last = blocks[blocks.length - 1]
      pos = last ? last.pos + last.node.nodeSize : state.doc.content.size
      tr.insert(pos, node)
    }
    if (cursorInside && (node.isTextblock || node.firstChild?.isTextblock || node.type === n.table)) {
      tr.setSelection(Selection.near(tr.doc.resolve(pos + 1)))
    } else {
      const after = pos + node.nodeSize
      const next = tr.doc.resolve(after).nodeAfter
      if (!next || !next.isTextblock) tr.insert(after, n.paragraph.create())
      tr.setSelection(TextSelection.create(tr.doc, after + 1))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

export function createTable(rows: number, cols: number): PMNode {
  const cells = (type: NodeType) => Array.from({ length: cols }, () => type.create())
  const header = n.table_row.create(null, cells(n.table_header))
  const body = Array.from({ length: Math.max(0, rows - 1) }, () => n.table_row.create(null, cells(n.table_cell)))
  return n.table.create(null, [header, ...body])
}

export const insertTable = (rows = 3, cols = 3): Command => insertBlock(createTable(rows, cols))
export const insertDivider: Command = (s, d) => insertBlock(n.horizontal_rule.create(), false)(s, d)
export const insertToc: Command = (s, d) => insertBlock(n.toc.create(), false)(s, d)
export const insertMathBlock: Command = (s, d) => insertBlock(n.math_block.create())(s, d)
export const insertCodeBlock = (language = ''): Command => insertBlock(n.code_block.create({ language }))
export const insertCallout = (kind = 'note'): Command => insertBlock(n.callout.create({ kind }, n.paragraph.create()))
export const insertToggle: Command = (s, d) => insertBlock(n.toggle.create(null, [n.toggle_summary.create()]))(s, d)
export const insertHtmlBlock: Command = (s, d) => insertBlock(n.html_block.create())(s, d)

export function insertMedia(kind: MediaKind, src: string, title = ''): Command {
  return insertBlock(n.media.create({ kind, src, title }), false)
}

export function insertImage(src: string, alt = ''): Command {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(n.image.create({ src, alt })).scrollIntoView())
    return true
  }
}

export const insertInlineMath: Command = (state, dispatch) => {
  const { from, to, empty } = state.selection
  const tex = empty ? '' : state.doc.textBetween(from, to)
  if (dispatch) {
    const tr = state.tr.replaceSelectionWith(n.math_inline.create({ tex }))
    tr.setSelection(NodeSelection.create(tr.doc, from))
    dispatch(tr)
  }
  return true
}

export const insertFootnote: Command = (state, dispatch) => {
  let max = 0
  state.doc.descendants((node) => {
    if (node.type === n.footnote_ref || node.type === n.footnote_def) {
      const v = Number.parseInt(node.attrs.label, 10)
      if (Number.isFinite(v)) max = Math.max(max, v)
    }
  })
  const label = String(max + 1)
  if (dispatch) {
    const tr = state.tr.replaceSelectionWith(n.footnote_ref.create({ label }), false)
    tr.insert(tr.doc.content.size, n.footnote_def.create({ label }, n.paragraph.create()))
    dispatch(tr.scrollIntoView())
  }
  return true
}

export const insertFrontMatter: Command = (state, dispatch) => {
  const first = state.doc.firstChild
  if (dispatch) {
    if (first?.type === n.frontmatter) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, 1 + first.content.size)).scrollIntoView())
    } else {
      const tr = state.tr.insert(0, n.frontmatter.create())
      tr.setSelection(TextSelection.create(tr.doc, 1))
      dispatch(tr.scrollIntoView())
    }
  }
  return true
}

// ---------- 表格 ----------

/**
 * 选中多个单元格后批量填充(PRD 3.6):向下填充每列用最上面一格的内容,向右填充每行用最左边一格。
 * 不是单元格多选时返回 false,让 ⌘D 回到复制块、⌘R 交给系统。
 */
export function fillCells(dir: 'down' | 'right'): Command {
  return (state, dispatch) => {
    if (!(state.selection instanceof CellSelection)) return false
    if (dispatch) {
      const { map, table, tableStart, left, right, top, bottom } = selectedRect(state)
      const at = (row: number, col: number) => map.map[row * map.width + col]
      const pairs: [number, number][] = []
      if (dir === 'down') {
        for (let col = left; col < right; col++) for (let row = top + 1; row < bottom; row++) pairs.push([at(top, col), at(row, col)])
      } else {
        for (let row = top; row < bottom; row++) for (let col = left + 1; col < right; col++) pairs.push([at(row, left), at(row, col)])
      }
      const tr = state.tr
      for (const [src, dst] of pairs) {
        const source = table.nodeAt(src)
        const target = table.nodeAt(dst)
        if (!source || !target || src === dst) continue
        const from = tr.mapping.map(tableStart + dst + 1)
        const to = tr.mapping.map(tableStart + dst + 1 + target.content.size)
        tr.replaceWith(from, to, source.content)
      }
      dispatch(tr)
    }
    return true
  }
}

// ---------- 撤销 ----------

export { redo, undo }

/** 把节点列表包成片段,供外部插入。 */
export function fragmentOf(nodes: PMNode[]): Fragment {
  return Fragment.fromArray(nodes)
}
