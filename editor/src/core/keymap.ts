// 键盘:Notion 快捷键优先;Typora 独有且不冲突的保留。用户可在设置里改「键 → 命令 ID」。
// Enter / Backspace 的 Notion 式行为(折叠块、列表、容器)在这里实现。
import { baseKeymap, chainCommands, createParagraphNear, lift, liftEmptyBlock, newlineInCode, setBlockType, splitBlock } from 'prosemirror-commands'
import { undoInputRule } from 'prosemirror-inputrules'
import { keymap } from 'prosemirror-keymap'
import { splitListItem } from 'prosemirror-schema-list'
import { type Command, type EditorState, type Plugin, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { isBlockSelected } from './block-selection'
import { findAncestor } from './commands'
import { runCommand } from './registry'
import { schema } from './schema'

const n = schema.nodes

/**
 * 默认快捷键:键 → 命令 ID。Mod = macOS 上的 Cmd。来源与冲突处理见 docs/prd/notion-input.md 第五、六节。
 * 只列编辑区内生效的键;文件、视图类(⌘P、⌘N、⌃⌘S……)由原生菜单与应用层处理。
 */
export const DEFAULT_KEYS: Record<string, string> = {
  // Notion 行内格式
  'Mod-b': 'format.bold',
  'Mod-i': 'format.italic',
  'Mod-u': 'format.underline',
  'Mod-Shift-s': 'format.strike',
  'Mod-e': 'format.code',
  'Mod-Shift-e': 'format.inlineMath',
  'Mod-k': 'format.link',
  'Mod-Shift-h': 'format.lastColor',
  // Typora 行内格式(改键与别名)
  'Ctrl-Mod-h': 'format.highlight',
  'Ctrl-Shift-`': 'format.strike',
  'Ctrl-`': 'format.code',
  'Ctrl-m': 'format.inlineMath',
  'Ctrl--': 'insert.comment',
  'Mod-\\': 'format.clear',
  // Notion 块类型
  'Mod-Alt-0': 'block.paragraph',
  'Mod-Alt-1': 'block.h1',
  'Mod-Alt-2': 'block.h2',
  'Mod-Alt-3': 'block.h3',
  'Mod-Alt-4': 'block.todo',
  'Mod-Alt-5': 'block.bullet',
  'Mod-Alt-6': 'block.numbered',
  'Mod-Alt-7': 'block.toggle',
  'Mod-Alt-8': 'block.code',
  'Mod-Alt-9': 'block.toDocument',
  // Typora 段落
  'Mod-0': 'block.paragraph',
  'Mod-1': 'block.h1',
  'Mod-2': 'block.h2',
  'Mod-3': 'block.h3',
  'Mod-4': 'block.h4',
  'Mod-5': 'block.h5',
  'Mod-6': 'block.h6',
  'Ctrl-Mod-=': 'block.headingUp',
  'Ctrl-Mod--': 'block.headingDown',
  'Mod-Alt-c': 'block.code',
  'Mod-Alt-b': 'block.math',
  'Mod-Alt-q': 'block.quote',
  'Mod-Alt-o': 'block.numbered',
  'Mod-Alt-u': 'block.bullet',
  'Mod-Alt-x': 'block.todo',
  'Mod-Alt--': 'insert.divider',
  'Mod-Alt-l': 'insert.linkReference',
  'Mod-Alt-r': 'insert.footnote',
  'Mod-Alt-Shift-t': 'insert.table',
  'Ctrl-x': 'block.toggleCheck',
  // Notion 块操作
  'Mod-d': 'block.duplicate',
  'Mod-Shift-ArrowUp': 'block.moveUpSelected',
  'Mod-Shift-ArrowDown': 'block.moveDownSelected',
  'Mod-Enter': 'block.modify',
  'Mod-Alt-t': 'block.toggleAllFolds',
  Escape: 'block.escape',
  'Mod-Alt-p': 'block.select',
  'Mod-/': 'block.turnIntoMenu',
  'Mod-a': 'edit.selectAll',
  Tab: 'block.indent',
  'Shift-Tab': 'block.outdent',
  // Typora 选择与删除(改键)
  'Ctrl-Mod-l': 'select.line',
  'Ctrl-Mod-e': 'select.format',
  'Ctrl-Mod-w': 'select.word',
  'Mod-Alt-Shift-p': 'block.delete',
  'Mod-Alt-Shift-l': 'delete.line',
  'Mod-Alt-Shift-e': 'delete.format',
  'Mod-Shift-d': 'delete.word',
  // AI 版:⌘J 给「打开 AI 对话」(Notion Ask AI,见 app/shortcuts.ts 的 MENU_KEYS),跳转到所选内容改为 ⌥⌘J
  'Mod-Alt-j': 'edit.jumpToSelection',
  // 撤销
  'Mod-z': 'edit.undo',
  'Mod-Shift-z': 'edit.redo',
  'Mod-y': 'edit.redo',
}

/** 块选中态(Esc 之后,一块或多块)专用的键,先于默认键匹配。 */
const BLOCK_SELECTED_KEYS: Record<string, string> = {
  ArrowUp: 'block.selectPrev',
  ArrowDown: 'block.selectNext',
  'Shift-ArrowUp': 'block.extendUp',
  'Shift-ArrowDown': 'block.extendDown',
  Enter: 'block.editSelected',
  Backspace: 'block.delete',
  Delete: 'block.delete',
}

// ---------- Enter ----------

/** 段落里只有 ```lang / $$ / [TOC] / |a|b| 时回车转换(Typora 的回车触发写法)。 */
const enterShortcuts: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  const para = $from.parent
  if (!empty || para.type !== n.paragraph || $from.parentOffset !== para.content.size) return false
  const text = para.textContent
  const start = $from.before()
  const replace = (node: ReturnType<typeof n.paragraph.create>, cursor: number) => {
    if (!dispatch) return true
    const tr = state.tr.replaceWith(start, start + para.nodeSize, node)
    tr.setSelection(Selection.near(tr.doc.resolve(start + cursor)))
    dispatch(tr.scrollIntoView())
    return true
  }
  // ``` 与 ~~~ 同效(notion-input.md 2.1 第 14 行)
  const fence = /^(?:```|~~~)([\w+#.-]*)$/.exec(text)
  if (fence) return replace(n.code_block.create({ language: fence[1] }), 1)
  if (text === '$$') return replace(n.math_block.create(), 1)
  if (/^\[toc\]$/i.test(text)) {
    if (!dispatch) return true
    const tr = state.tr.replaceWith(start, start + para.nodeSize, [n.toc.create(), n.paragraph.create()])
    tr.setSelection(TextSelection.create(tr.doc, start + 2))
    dispatch(tr.scrollIntoView())
    return true
  }
  const row = /^\|(.+)\|$/.exec(text)
  if (row) {
    const headers = row[1].split('|').map((s) => s.trim())
    const headerRow = n.table_row.create(
      null,
      headers.map((h) => n.table_header.create(null, h ? schema.text(h) : null)),
    )
    const bodyRow = n.table_row.create(null, headers.map(() => n.table_cell.create()))
    if (!dispatch) return true
    const tr = state.tr.replaceWith(start, start + para.nodeSize, n.table.create(null, [headerRow, bodyRow]))
    // 光标放到第二行第一格
    tr.setSelection(Selection.near(tr.doc.resolve(start + 1 + headerRow.nodeSize + 2)))
    dispatch(tr.scrollIntoView())
    return true
  }
  return false
}

/** 折叠块标题里回车:展开时在块内首行新建段落;标题与内容都空时退回普通段落;收起时在折叠块后新建段落。 */
const enterInToggleSummary: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if ($from.parent.type !== n.toggle_summary || !empty) return false
  const toggle = findAncestor($from, n.toggle)
  if (!toggle) return false
  if (!dispatch) return true
  const summary = $from.parent
  const tr = state.tr
  if (summary.content.size === 0 && toggle.node.childCount === 1) {
    tr.replaceWith(toggle.pos, toggle.pos + toggle.node.nodeSize, n.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, toggle.pos + 1))
    dispatch(tr)
    return true
  }
  const rest = summary.content.cut($from.parentOffset)
  tr.delete($from.pos, $from.end())
  if (toggle.node.attrs.open) {
    const insertAt = tr.mapping.map($from.after())
    tr.insert(insertAt, n.paragraph.create(null, rest))
    tr.setSelection(TextSelection.create(tr.doc, insertAt + 1))
  } else {
    const after = tr.mapping.map(toggle.pos + toggle.node.nodeSize)
    tr.insert(after, n.paragraph.create(null, rest))
    tr.setSelection(TextSelection.create(tr.doc, after + 1))
  }
  dispatch(tr.scrollIntoView())
  return true
}

/** 列表项回车:待办拆出的新项默认未勾选;普通项保持普通。 */
const splitItem: Command = (state, dispatch) => {
  const item = findAncestor(state.selection.$from, n.list_item)
  if (!item) return false
  return splitListItem(n.list_item, { checked: item.node.attrs.checked === null ? null : false })(state, dispatch)
}

const enter = chainCommands(newlineInCode, enterShortcuts, enterInToggleSummary, splitItem, createParagraphNear, liftEmptyBlock, splitBlock)

// ---------- Backspace ----------

/** 块开头退格(Notion):标题等先变回正文;列表项、折叠块、引用先移出容器;都不是才与上一块合并。 */
const backspaceAtStart: Command = (state, dispatch) => {
  const { $from, empty } = state.selection
  if (!empty || $from.parentOffset !== 0) return false
  const tb = $from.parent
  if (tb.type === n.heading || tb.type === n.math_block) return setBlockType(n.paragraph)(state, dispatch)
  if (tb.type === n.code_block && tb.content.size === 0) return setBlockType(n.paragraph)(state, dispatch)
  if (tb.type === n.toggle_summary) {
    const toggle = findAncestor($from, n.toggle)
    if (!toggle) return false
    if (!dispatch) return true
    const blocks = [n.paragraph.create(null, tb.content)]
    toggle.node.forEach((c, _o, i) => {
      if (i > 0) blocks.push(c)
    })
    const tr = state.tr.replaceWith(toggle.pos, toggle.pos + toggle.node.nodeSize, blocks)
    tr.setSelection(TextSelection.create(tr.doc, toggle.pos + 1))
    dispatch(tr)
    return true
  }
  const item = findAncestor($from, n.list_item)
  if (item && $from.index(item.depth) === 0) {
    // 待办先去掉勾选框变普通项,再退格才移出列表
    if (item.node.attrs.checked !== null) {
      if (dispatch) dispatch(state.tr.setNodeMarkup(item.pos, null, { checked: null }))
      return true
    }
    return lift(state, dispatch)
  }
  const container = $from.depth >= 2 ? $from.node($from.depth - 1) : null
  if (container && (container.type === n.blockquote || container.type === n.callout) && $from.index($from.depth - 1) === 0) {
    return lift(state, dispatch)
  }
  return false
}

const backspace = chainCommands(undoInputRule, backspaceAtStart, baseKeymap.Backspace)

const insertHardBreak: Command = chainCommands(newlineInCode, (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView())
  return true
})

/** 构建按键插件。customKeys 覆盖默认映射(值为空串表示取消该键)。 */
export function buildKeymaps(customKeys: Record<string, string> = {}): Plugin[] {
  const keys = { ...DEFAULT_KEYS, ...customKeys }
  const bindings: Record<string, Command> = {}
  for (const [key, id] of Object.entries(keys)) {
    if (!id) continue
    bindings[key] = (_state: EditorState, _dispatch, view?: EditorView) => (view ? runCommand(view, id) : false)
  }
  const blockSelected: Record<string, Command> = {}
  for (const [key, id] of Object.entries(BLOCK_SELECTED_KEYS)) {
    blockSelected[key] = (state: EditorState, _dispatch, view?: EditorView) => (isBlockSelected(state.selection) && view ? runCommand(view, id) : false)
  }
  return [
    keymap(blockSelected),
    keymap({ Enter: enter, Backspace: backspace, 'Shift-Enter': insertHardBreak }),
    keymap(bindings),
    keymap(baseKeymap),
  ]
}

