// 菜单条目:块类型、颜色、媒体插入、块操作。斜杠菜单、块菜单、「转换为」菜单共用同一份定义。
// 条目名与别名按 docs/prd/notion-input.md 4.2(斜杠)、7.2(块菜单)、7.3(转换为)、第八节(颜色)。
import type { Mark } from 'prosemirror-model'
import { type EditorState, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { countWords } from '../app/panels'
import { blocksText, selectedBlocks } from '../core/block-selection'
import { type BlockInfo, blockAt } from '../core/blocks'
import {
  type BlockKind,
  blockKindAt,
  firstTextPos,
  insertTable,
  isColorableBlock,
  isConvertibleBlock,
  setBlocksColor,
  setColor,
  turnInto,
  turnSelectedInto,
} from '../core/commands'
import type { EditorEnv } from '../core/env'
import { CALLOUT_LABELS, getCommand, runCommand } from '../core/registry'
import { CALLOUT_KINDS, NOTION_COLORS, schema } from '../core/schema'
import { rememberColor } from '../core/selection-commands'
import type { MenuItem } from '../ui/menu'
import { chooseMediaSource } from './media-insert'
import { localDate, suggestKey } from './suggest'

export interface BlockKindDef {
  kind: BlockKind
  label: string
  icon: string
  hint: string
  keywords: string[]
  /** 「/turn…」直接转换用的英文名(notion-input.md 4.2「转换为」别名) */
  turn: string[]
}

/** 「转换为」的目标类型(notion-input.md 7.3,新文档另列)。 */
export const BLOCK_KINDS: BlockKindDef[] = [
  { kind: 'paragraph', label: '正文', icon: 'T', hint: '⌥⌘0', keywords: ['text', 'plain', 'paragraph', 'zhengwen', 'zw', 'wenben'], turn: ['text', 'plain'] },
  { kind: 'h1', label: '标题 1', icon: 'H1', hint: '#', keywords: ['h1', '#', 'heading1', 'heading 1', 'title', 'biaoti', 'bt1'], turn: ['h1', 'heading1'] },
  { kind: 'h2', label: '标题 2', icon: 'H2', hint: '##', keywords: ['h2', '##', 'heading2', 'heading 2', 'biaoti', 'bt2'], turn: ['h2', 'heading2'] },
  { kind: 'h3', label: '标题 3', icon: 'H3', hint: '###', keywords: ['h3', '###', 'heading3', 'heading 3', 'biaoti', 'bt3'], turn: ['h3', 'heading3'] },
  { kind: 'h4', label: '标题 4', icon: 'H4', hint: '####', keywords: ['h4', '####', 'heading4', 'bt4'], turn: ['h4', 'heading4'] },
  { kind: 'h5', label: '标题 5', icon: 'H5', hint: '#####', keywords: ['h5', '#####', 'heading5', 'bt5'], turn: ['h5', 'heading5'] },
  { kind: 'h6', label: '标题 6', icon: 'H6', hint: '######', keywords: ['h6', '######', 'heading6', 'bt6'], turn: ['h6', 'heading6'] },
  { kind: 'bullet', label: '无序列表', icon: '•', hint: '-', keywords: ['bullet', 'ul', 'list', 'wuxu', 'wx', 'liebiao'], turn: ['bullet', 'ul'] },
  { kind: 'numbered', label: '有序列表', icon: '1.', hint: '1.', keywords: ['num', 'numbered', 'ol', 'ordered', 'youxu', 'yx', 'liebiao'], turn: ['numbered', 'num', 'ol'] },
  { kind: 'todo', label: '待办', icon: '☑', hint: '[]', keywords: ['todo', 'task', 'checkbox', 'daiban', 'db', 'renwu'], turn: ['todo', 'task'] },
  { kind: 'toggle', label: '折叠块', icon: '▸', hint: '>', keywords: ['toggle', 'details', 'zhedie', 'zd'], turn: ['toggle'] },
  { kind: 'toggleh1', label: '折叠标题 1', icon: '▸1', hint: '', keywords: ['toggleh1', 'toggle heading', 'toggle heading1', 'zhediebiaoti', 'zdbt1'], turn: ['toggleh1', 'toggleheading1'] },
  { kind: 'toggleh2', label: '折叠标题 2', icon: '▸2', hint: '', keywords: ['toggleh2', 'toggle heading', 'toggle heading2', 'zhediebiaoti', 'zdbt2'], turn: ['toggleh2', 'toggleheading2'] },
  { kind: 'toggleh3', label: '折叠标题 3', icon: '▸3', hint: '', keywords: ['toggleh3', 'toggle heading', 'toggle heading3', 'zhediebiaoti', 'zdbt3'], turn: ['toggleh3', 'toggleheading3'] },
  { kind: 'quote', label: '引用', icon: '❝', hint: '"', keywords: ['quote', 'blockquote', 'yinyong', 'yy'], turn: ['quote'] },
  { kind: 'callout', label: '标注块', icon: '💡', hint: '', keywords: ['callout', 'biaozhu', 'bzk'], turn: ['callout'] },
  { kind: 'code', label: '代码块', icon: '</>', hint: '```', keywords: ['code', 'codeblock', 'daima', 'dm'], turn: ['code'] },
  { kind: 'math', label: '公式块', icon: '∑', hint: '$$', keywords: ['math', 'latex', 'equation block', 'katex', 'gongshi', 'gsk'], turn: ['math', 'equation'] },
]

function kindDef(kind: BlockKind): BlockKindDef {
  const def = BLOCK_KINDS.find((k) => k.kind === kind)
  if (!def) throw new Error(`未定义的块类型:${kind}`)
  return def
}

/** 块的类型(用于转换菜单打勾);块里没有文字时为 null。 */
function kindOfBlock(state: EditorState, block: BlockInfo): BlockKind | null {
  const pos = firstTextPos(state.doc, block.pos)
  return pos === null ? null : blockKindAt(state.doc.resolve(pos))
}

/** 块选中态下先把光标放进第一个所选块(「新文档」等只认光标的命令用)。 */
function enterFirstBlock(view: EditorView): void {
  const sel = view.state.selection
  if (sel instanceof TextSelection) return
  const first = selectedBlocks(view.state)[0]
  const pos = first ? firstTextPos(view.state.doc, first.pos) : null
  if (pos !== null) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

/** 「转换为」列表:作用于光标所在块或所选的一块 / 多块。 */
export function turnIntoItems(view: EditorView): MenuItem[] {
  const blocks = selectedBlocks(view.state)
  const current = blocks.length === 1 ? kindOfBlock(view.state, blocks[0]) : null
  const items: MenuItem[] = BLOCK_KINDS.map((k) => ({
    id: `turn.${k.kind}`,
    label: k.label,
    icon: k.icon,
    hint: k.hint,
    keywords: k.keywords,
    active: current === k.kind,
    run: () => {
      turnSelectedInto(view, k.kind)
      view.focus()
    },
  }))
  if (blocks.length <= 1) {
    items.push({
      id: 'turn.page',
      label: '新文档',
      icon: '📄',
      hint: '⌥⌘9',
      keywords: ['page', 'document', 'xinwendang', 'xwd'],
      run: () => {
        enterFirstBlock(view)
        runCommand(view, 'block.toDocument')
      },
    })
  }
  return items
}

/** 块操作:创建副本、移动到…、复制为 Markdown、删除(块菜单与不可转换块的 ⌘/ 菜单共用)。 */
export function blockActionItems(view: EditorView): MenuItem[] {
  const run = (id: string, refocus = true) => () => {
    runCommand(view, id)
    if (refocus) view.focus()
  }
  return [
    { id: 'block.duplicate', label: '创建副本', icon: '⧉', hint: '⌘D', keywords: ['duplicate', 'chuangjianfuben', 'fuben'], run: run('block.duplicate') },
    // 移动到会弹出文档选择框,焦点交给它
    { id: 'block.moveTo', label: '移动到…', icon: '↪', keywords: ['move', 'moveto', 'yidong'], run: run('block.moveTo', false) },
    { id: 'block.copyMarkdown', label: '复制为 Markdown', icon: 'M', keywords: ['copy', 'markdown', 'fuzhi'], run: run('block.copyMarkdown') },
    { id: 'block.delete', label: '删除', icon: '🗑', hint: '⌫', keywords: ['delete', 'shanchu'], run: run('block.delete') },
  ]
}

/** ⌘/ 菜单:所选块都可转换时列「转换为」目标,否则只给块操作(notion-input.md 7.3「不可转换」)。 */
export function turnMenuItems(view: EditorView): MenuItem[] {
  const blocks = selectedBlocks(view.state)
  if (blocks.length > 0 && blocks.every((b) => isConvertibleBlock(b.node))) return turnIntoItems(view)
  return blockActionItems(view)
}

// ---------- 颜色 ----------

/** 当前文字(或整块)上的颜色标记。 */
function currentColor(state: EditorState, wholeBlock: boolean): { color: string | null; background: string | null } {
  const type = schema.marks.color
  const found: Mark[] = []
  const visit = (node: { marks: readonly Mark[] }) => {
    if (found.length) return false
    const mark = type.isInSet(node.marks)
    if (mark) found.push(mark)
    return found.length === 0
  }
  if (wholeBlock) {
    selectedBlocks(state)[0]?.node.descendants(visit)
  } else {
    const { from, to, empty, $from } = state.selection
    if (empty) {
      const mark = type.isInSet(state.storedMarks ?? $from.marks())
      if (mark) found.push(mark)
    } else state.doc.nodesBetween(from, to, visit)
  }
  const mark = found[0]
  return { color: (mark?.attrs.color as string | null | undefined) ?? null, background: (mark?.attrs.background as string | null | undefined) ?? null }
}

const sameColor = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase()

/** 颜色菜单(第八节):文字颜色 10 种、背景色 10 种;非清单内的色值显示为「自定义」。 */
export function colorItems(view: EditorView, applyToBlock: boolean): MenuItem[] {
  const current = currentColor(view.state, applyToBlock)
  const apply = (color: string | null, background: string | null) => {
    rememberColor(color, background)
    if (applyToBlock) setBlocksColor(selectedBlocks(view.state), color, background)(view.state, view.dispatch)
    else setColor(color, background)(view.state, view.dispatch)
    view.focus()
  }
  const text: MenuItem[] = [
    { id: 'color.default', label: '默认颜色', group: '文字颜色', icon: 'A', keywords: ['default', 'moren', 'color'], active: !current.color && !current.background, run: () => apply(null, null) },
    ...NOTION_COLORS.map((c) => ({
      id: `color.${c.name}`,
      label: c.label,
      group: '文字颜色',
      icon: colorSwatch(c.color, null),
      keywords: [c.name, 'color', 'yanse'],
      active: sameColor(current.color, c.color),
      run: () => apply(c.color, null),
    })),
  ]
  const custom = current.color
  if (custom && !NOTION_COLORS.some((c) => sameColor(custom, c.color))) {
    text.push({ id: 'color.custom', label: '自定义', group: '文字颜色', icon: colorSwatch(custom, null), keywords: ['custom', 'zidingyi'], active: true, run: () => apply(custom, null) })
  }
  const bg: MenuItem[] = [
    { id: 'bg.default', label: '默认背景', group: '背景色', icon: colorSwatch(null, null), keywords: ['default background', 'background', 'bg', 'beijing'], run: () => apply(null, null) },
    ...NOTION_COLORS.map((c) => ({
      id: `bg.${c.name}`,
      label: `${c.label}背景`,
      group: '背景色',
      icon: colorSwatch(null, c.background),
      keywords: [`${c.name} background`, 'background', 'bg', 'beijing'],
      active: sameColor(current.background, c.background),
      run: () => apply(null, c.background),
    })),
  ]
  const customBg = current.background
  if (customBg && !NOTION_COLORS.some((c) => sameColor(customBg, c.background))) {
    bg.push({ id: 'bg.custom', label: '自定义', group: '背景色', icon: colorSwatch(null, customBg), keywords: ['custom', 'zidingyi'], active: true, run: () => apply(null, customBg) })
  }
  return [...text, ...bg]
}

function colorSwatch(color: string | null, background: string | null): HTMLElement {
  const el = document.createElement('span')
  el.className = 'tz-swatch'
  el.textContent = 'A'
  if (color) el.style.color = color
  if (background) el.style.background = background
  return el
}

/** 标注块的「颜色」:在 5 种类型间切换(notion-input.md 7.5)。 */
export function calloutKindItems(view: EditorView, calloutPos: number): MenuItem[] {
  const node = view.state.doc.nodeAt(calloutPos)
  return CALLOUT_KINDS.map((kind) => ({
    id: `callout.${kind}`,
    label: CALLOUT_LABELS[kind],
    icon: calloutIcon(kind),
    keywords: [kind],
    active: node?.attrs.kind === kind,
    run: () => {
      const cur = view.state.doc.nodeAt(calloutPos)
      if (cur?.type === schema.nodes.callout) view.dispatch(view.state.tr.setNodeMarkup(calloutPos, null, { ...cur.attrs, kind }))
      view.focus()
    },
  }))
}

/** 标注块类型的小图标(与提示框样式里的图标一致)。 */
function calloutIcon(kind: string): string {
  return { note: 'ℹ️', tip: '💡', important: '❗', warning: '⚠️', caution: '🛑' }[kind] ?? '💡'
}

// ---------- 块菜单(点「⋮⋮」,notion-input.md 7.2) ----------

/** 所选块所属的标注块:块本身是标注块,或块直接位于标注块里。 */
function calloutOf(state: EditorState, blocks: readonly BlockInfo[]): number | null {
  if (blocks.length !== 1) return null
  const b = blocks[0]
  if (b.node.type === schema.nodes.callout) return b.pos
  const $b = state.doc.resolve(b.pos)
  return $b.parent.type === schema.nodes.callout && $b.depth > 0 ? $b.before() : null
}

export function blockMenu(view: EditorView): { items: MenuItem[]; footer: string } {
  const state = view.state
  const blocks = selectedBlocks(state)
  const items: MenuItem[] = []
  if (blocks.length > 0 && blocks.every((b) => isConvertibleBlock(b.node))) {
    items.push({ id: 'block.turnInto', label: '转换为', icon: '↻', keywords: ['turn', 'zhuanhuan'], searchable: true, children: () => turnIntoItems(view) })
  }
  const callout = calloutOf(state, blocks)
  if (callout !== null) {
    items.push({ id: 'block.color', label: '颜色', icon: '🎨', keywords: ['color', 'yanse'], children: () => calloutKindItems(view, callout) })
  } else if (blocks.length > 0 && blocks.every((b) => isColorableBlock(b.node))) {
    items.push({ id: 'block.color', label: '颜色', icon: '🎨', keywords: ['color', 'yanse'], children: () => colorItems(view, true) })
  }
  const heading = blocks.length === 1 && (blocks[0].node.type === schema.nodes.heading || (blocks[0].node.type === schema.nodes.toggle && (blocks[0].node.firstChild?.attrs.level ?? 0) > 0))
  if (heading) {
    items.push({
      id: 'block.copyLink',
      label: '复制块链接',
      icon: '🔗',
      keywords: ['link', 'copy', 'lianjie'],
      run: () => {
        runCommand(view, 'block.copyLink')
        view.focus()
      },
    })
  }
  items.push(...blockActionItems(view))
  const stats = countWords(blocksText(blocks))
  return { items, footer: `字数 ${stats.words} · 字符 ${stats.characters}` }
}

// ---------- 斜杠菜单(notion-input.md 4.2) ----------

export interface SlashHooks {
  /** 在光标处打开 [[ 文档链接菜单 */
  openLinkMenu(): void
}

/** 当前块为空 → 转换当前块;有内容 → 在下方新建一块再转换(notion-input.md 4.1「插入位置」)。 */
export function placeBlock(view: EditorView, kind: BlockKind, attrs: Record<string, unknown> = {}): void {
  const { $from } = view.state.selection
  if ($from.parent.isTextblock && $from.parent.content.size > 0) insertEmptyBelow(view)
  turnInto(view, kind, attrs)
}

/** 在当前块下方新建空块(列表项下方新建同一列表里的新项)。 */
function insertEmptyBelow(view: EditorView): void {
  const { state } = view
  const block = blockAt(state.selection.$from)
  if (!block) return
  const end = block.pos + block.node.nodeSize
  const tr = state.tr
  if (block.node.type === schema.nodes.list_item) {
    tr.insert(end, schema.nodes.list_item.create({ checked: block.node.attrs.checked === null ? null : false }, schema.nodes.paragraph.create()))
    tr.setSelection(TextSelection.create(tr.doc, end + 2))
  } else {
    tr.insert(end, schema.nodes.paragraph.create())
    tr.setSelection(TextSelection.create(tr.doc, end + 1))
  }
  view.dispatch(tr.scrollIntoView())
}

/** 在光标处插入带链接的标题文字。 */
export function insertLinkText(view: EditorView, title: string, href: string): void {
  const { from, to } = view.state.selection
  const tr = view.state.tr.insertText(title, from, to)
  tr.addMark(from, from + title.length, schema.marks.link.create({ href }))
  view.dispatch(tr.scrollIntoView())
}

/** /page:在当前文件夹新建「未命名.md」,原处插入链接,并在新标签页打开。 */
async function createPage(view: EditorView, env: EditorEnv): Promise<void> {
  const ref = await env.actions.createDocument('未命名')
  if (!ref) return
  insertLinkText(view, ref.title, ref.href)
  view.focus()
  env.openDocumentLink(ref.href, true)
}

/** 在光标处敲出触发字符并打开对应的建议菜单(@ 提及、: 表情)。 */
function openSuggest(view: EditorView, trigger: '@' | ':'): void {
  const from = view.state.selection.from
  view.dispatch(view.state.tr.insertText(trigger, from).setMeta(suggestKey, { open: from, trigger }))
  view.focus()
}

function insertText(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text).scrollIntoView())
  view.focus()
}

/** 斜杠菜单全部条目,分组与顺序同 notion-input.md 4.2。 */
export function slashItems(view: EditorView, env: EditorEnv, hooks: SlashHooks): MenuItem[] {
  const cmd = (id: string) => () => {
    runCommand(view, id)
    view.focus()
  }
  const kind = (k: BlockKind, group = '基础', label?: string): MenuItem => {
    const def = kindDef(k)
    return {
      id: `slash.${k}`,
      label: label ?? def.label,
      icon: def.icon,
      hint: def.hint,
      keywords: def.keywords,
      group,
      run: () => {
        placeBlock(view, k)
        view.focus()
      },
    }
  }
  const basic: MenuItem[] = [
    kind('paragraph'),
    { id: 'slash.page', label: '新文档', icon: '📄', group: '基础', keywords: ['page', 'xinwendang', 'xwd', 'wendang'], run: () => void createPage(view, env) },
    kind('h1'),
    kind('h2'),
    kind('h3'),
    kind('h4'),
    kind('h5'),
    kind('h6'),
    kind('bullet'),
    kind('numbered'),
    kind('todo'),
    kind('toggle'),
    kind('toggleh1'),
    kind('toggleh2'),
    kind('toggleh3'),
    kind('quote'),
    { id: 'slash.divider', label: '分割线', icon: '—', hint: '---', group: '基础', keywords: ['div', 'divider', 'hr', 'line', 'fengexian', 'fgx'], run: cmd('insert.divider') },
    { id: 'slash.link', label: '链接到文档', icon: '↗', hint: '[[', group: '基础', keywords: ['link', 'link to page', 'lianjie', 'wendang', 'ljdwd'], run: () => hooks.openLinkMenu() },
    kind('callout'),
    {
      id: 'slash.table',
      label: '表格',
      icon: '▦',
      group: '基础',
      keywords: ['table', 'biaoge', 'bg'],
      run: () => {
        // /table 直接插 3 列 × 3 行(含表头行)
        insertTable(3, 3)(view.state, view.dispatch)
        view.focus()
      },
    },
  ]
  const dates: [string, number, string[]][] = [
    ['今天', 0, ['today', 'jintian', 'jt']],
    ['明天', 1, ['tomorrow', 'mingtian', 'mt']],
    ['昨天', -1, ['yesterday', 'zuotian', 'zt']],
  ]
  const inline: MenuItem[] = [
    { id: 'slash.mention', label: '提及文档', icon: '@', group: '行内', keywords: ['mention', 'tiji', 'tjwd'], run: () => openSuggest(view, '@') },
    {
      id: 'slash.date',
      label: '日期',
      icon: '📅',
      group: '行内',
      keywords: ['date', 'riqi', 'rq'],
      children: () =>
        dates.map(([label, offset, keywords]) => {
          const date = localDate(offset)
          return { id: `date.${offset}`, label, hint: date, icon: '📅', keywords, run: () => insertText(view, date) }
        }),
    },
    { id: 'slash.inlineMath', label: '行内公式', icon: '√', hint: '⇧⌘E', group: '行内', keywords: ['equation', 'inline math', 'hangneigongshi', 'gongshi'], run: cmd('format.inlineMath') },
    { id: 'slash.emoji', label: '表情', icon: '😀', group: '行内', keywords: ['emoji', 'biaoqing', 'bq'], run: () => openSuggest(view, ':') },
  ]
  const media: MenuItem[] = [
    {
      id: 'slash.image',
      label: '图片',
      icon: '🖼',
      group: '媒体',
      keywords: ['image', 'img', 'picture', 'tupian', 'tp'],
      children: () => [
        { id: 'image.local', label: '选择本机图片…', icon: '🖼', run: () => void env.actions.insertLocalMedia(view, 'image') },
        { id: 'image.url', label: '图片网址…', icon: '🌐', run: () => env.actions.insertFromUrl(view, 'image') },
      ],
    },
    { id: 'slash.pdf', label: 'PDF', icon: '📄', group: '媒体', keywords: ['pdf'], run: () => chooseMediaSource(view, env, 'pdf') },
    { id: 'slash.bookmark', label: '书签', icon: '🔖', group: '媒体', keywords: ['book', 'bookmark', 'web', 'shuqian'], run: () => env.actions.insertFromUrl(view, 'bookmark') },
    { id: 'slash.video', label: '视频', icon: '🎬', group: '媒体', keywords: ['video', 'movie', 'mp4', 'shipin', 'sp'], run: () => chooseMediaSource(view, env, 'video') },
    { id: 'slash.audio', label: '音频', icon: '🎵', group: '媒体', keywords: ['audio', 'music', 'mp3', 'yinpin'], run: () => chooseMediaSource(view, env, 'audio') },
    kind('code', '媒体', '代码'),
    { id: 'slash.file', label: '文件', icon: '📎', group: '媒体', keywords: ['file', 'attachment', 'wenjian', 'fujian'], run: () => void env.actions.insertLocalMedia(view, 'file') },
    { id: 'slash.embed', label: '嵌入', icon: '▶', group: '媒体', keywords: ['embed', 'tweet', 'maps', 'drive', 'youtube', 'bilibili', 'iframe', 'qianru'], run: () => env.actions.insertFromUrl(view, 'embed') },
  ]
  const advanced: MenuItem[] = [
    { id: 'slash.duplicate', label: '复制块', icon: '⧉', hint: '⌘D', group: '高级', keywords: ['duplicate', 'fuzhikuai', 'fzk'], run: cmd('block.duplicate') },
    { id: 'slash.moveTo', label: '移动到', icon: '↪', group: '高级', keywords: ['moveto', 'move', 'yidongdao', 'ydd'], run: () => runCommand(view, 'block.moveTo') },
    { id: 'slash.delete', label: '删除', icon: '🗑', group: '高级', keywords: ['delete', 'shanchu', 'sc'], run: cmd('block.delete') },
    { id: 'slash.toc', label: '目录', icon: '☰', group: '高级', keywords: ['toc', 'contents', 'mulu', 'ml'], run: cmd('insert.toc') },
    kind('math', '高级'),
    {
      id: 'slash.turn',
      label: '转换为',
      icon: '↻',
      group: '高级',
      keywords: ['turn', 'turn into', 'zhuanhuanwei', 'zhw'],
      searchable: true,
      children: () => turnIntoItems(view),
    },
    // 「/turnbullet」这类直接转换:只在搜索时出现,作用于当前块
    ...BLOCK_KINDS.map((k) => ({
      id: `slash.turn.${k.kind}`,
      label: `转换为${k.label}`,
      icon: k.icon,
      group: '高级',
      keywords: k.turn.flatMap((t) => [`turn${t}`, `turninto${t}`]),
      searchOnly: true,
      run: () => {
        turnInto(view, k.kind)
        view.focus()
      },
    })),
  ]
  const colors = colorItems(view, true)
  const extended: MenuItem[] = [
    ...CALLOUT_KINDS.map((k) => ({
      id: `slash.callout.${k}`,
      label: `提示框:${CALLOUT_LABELS[k]}`,
      icon: calloutIcon(k),
      group: '扩展',
      keywords: [k, 'tishikuang', 'tsk'],
      run: cmd(`insert.callout.${k}`),
    })),
    { id: 'slash.footnote', label: '脚注', icon: '¹', group: '扩展', keywords: ['footnote', 'jiaozhu', 'jz'], run: cmd('insert.footnote') },
    { id: 'slash.yaml', label: 'YAML 元数据', icon: '⚙', group: '扩展', keywords: ['yaml', 'frontmatter', 'meta', 'yuanshuju'], run: cmd('insert.frontMatter') },
    { id: 'slash.diagram', label: '图表', icon: '◇', group: '扩展', keywords: ['mermaid', 'sequence', 'flow', 'diagram', 'tubiao', 'tb'], run: cmd('insert.diagram') },
    { id: 'slash.html', label: 'HTML', icon: '<>', group: '扩展', keywords: ['html'], run: cmd('insert.html') },
    { id: 'slash.linkref', label: '链接引用', icon: '[]', group: '扩展', keywords: ['linkref', 'reference', 'lianjieyinyong', 'ljyy'], run: cmd('insert.linkReference') },
    { id: 'slash.icon', label: '页面图标', icon: '☺', group: '扩展', keywords: ['icon', 'yemiantubiao', 'ymtb'], run: cmd('page.icon') },
    { id: 'slash.cover', label: '页面封面', icon: '▧', group: '扩展', keywords: ['cover', 'yemianfengmian', 'ymfm'], run: cmd('page.cover') },
  ]
  // AI 版:「AI 写作」(/ai,ai-prd 3.5);AI 模块注册了命令才出现
  const ai: MenuItem[] = getCommand('ai.write')
    ? [{ id: 'slash.ai', label: 'AI 写作', icon: '✦', group: 'AI', keywords: ['ai', 'ask ai', 'write', 'aixiezuo', 'xiezuo'], run: () => void runCommand(view, 'ai.write') }]
    : []
  return [...basic, ...inline, ...media, ...advanced, ...colors, ...extended, ...ai]
}
