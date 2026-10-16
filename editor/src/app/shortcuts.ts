// 快捷键表与自定义(偏好「快捷键」页,PRD 3.13;notion-input 一「键位总则」、六 第 17、18 行;对照表 PG-04)。
// 键名沿用 prosemirror-keymap 写法(Mod = ⌘,Ctrl = ⌃,Alt = ⌥),修饰键顺序统一为 Ctrl-Mod-Alt-Shift。
// 用户改动存在 settings.keybindings(键 → 命令 ID,空串 = 取消该键的默认绑定):编辑区由 core/keymap.ts 的 buildKeymaps 生效,
// 原生菜单由 menuKeyOverrides 算出差异后经桥接改菜单项的 keyEquivalent。
import { DEFAULT_KEYS } from '../core/keymap'
import { allCommands, getCommand } from '../core/registry'
import { TABLE_KEYS } from '../plugins/table'

/**
 * 原生菜单与应用层的默认键位(编辑区键位见 core/keymap.ts 的 DEFAULT_KEYS)。
 * 与 app/Sources/Typoza/MainMenu.swift 的菜单键位一致;native.* 由外壳直接处理,网页里没有同名命令。
 */
export const MENU_KEYS: Record<string, string> = {
  'Mod-,': 'app.preferences',
  'Mod-n': 'native.newWindow',
  'Mod-Shift-n': 'native.newWindow',
  'Mod-t': 'native.newTab',
  'Mod-o': 'native.open',
  'Mod-p': 'file.quickOpen',
  'Mod-Shift-o': 'file.quickOpen',
  'Mod-Shift-t': 'native.reopenClosed',
  'Mod-s': 'file.save',
  'Mod-Alt-Shift-s': 'file.saveAs',
  'Mod-Alt-s': 'native.saveAll',
  'Mod-l': 'file.copyPath',
  'Mod-Shift-p': 'file.print',
  'Mod-Shift-c': 'edit.copyMarkdown',
  'Mod-f': 'find.open',
  'Mod-g': 'find.next',
  'Mod-Shift-g': 'find.prev',
  'Mod-Alt-f': 'find.replace',
  'Mod-Alt-e': 'find.replaceNext',
  'Mod-Shift-f': 'view.search',
  'Ctrl-Mod-i': 'insert.image',
  'Ctrl-Mod-/': 'view.sourceMode',
  'Ctrl-Mod-s': 'view.toggleSidebar',
  'Ctrl-Mod-1': 'view.outline',
  'Ctrl-Mod-2': 'view.docList',
  'Ctrl-Mod-3': 'view.fileTree',
  F8: 'view.focusMode',
  F9: 'view.typewriterMode',
  'Mod-Shift-0': 'view.zoomReset',
  'Mod-=': 'view.zoomIn',
  'Mod-Shift-=': 'view.zoomIn',
  'Mod--': 'view.zoomOut',
  'Mod-Shift--': 'view.zoomOut',
  'Mod-Shift-l': 'view.toggleDark',
  'Mod-[': 'nav.back',
  'Mod-]': 'nav.forward',
  'Mod-Shift-/': 'native.welcome',
  // AI 版:菜单「AI ▸ 打开对话」(ai-prd 3.2)
  'Mod-j': 'ai.open',
}

/** 只在原生外壳里有的命令(网页注册表里没有),快捷键页照样列出。 */
const NATIVE_LABELS: Record<string, string> = {
  'native.newWindow': '新建窗口',
  'native.newTab': '新建标签页',
  'native.open': '打开…',
  'native.reopenClosed': '重新打开关闭的文件',
  'native.saveAll': '全部保存',
  'native.import': '导入…',
  'native.welcome': '快速上手',
  'native.alwaysOnTop': '保持窗口在最前端',
}

/** 浏览器里(开发、E2E)没有原生外壳,native.* 换成网页里的同义命令。 */
export const BROWSER_ALIASES: Record<string, string> = {
  'native.open': 'file.open',
  'native.newWindow': 'file.newWindow',
}

/** 注册表里名字太简略的命令,在快捷键页换个能看懂的名字。 */
const LABELS: Record<string, string> = {
  'view.outline': '大纲',
  'view.docList': '文档列表',
  'view.fileTree': '文件树',
  'view.search': '在文件夹中搜索',
  'file.export.pdf': '导出 PDF',
  'file.export.html': '导出 HTML',
  'file.export.html-plain': '导出 HTML(无样式)',
  'file.export.image': '导出图像',
  'file.export.docx': '导出 Word(.docx)',
  'file.export.odt': '导出 OpenOffice(.odt)',
  'file.export.rtf': '导出 RTF',
  'file.export.epub': '导出 Epub',
  'file.export.latex': '导出 LaTeX',
  'file.export.mediawiki': '导出 Media Wiki',
  'file.export.rst': '导出 reStructuredText',
  'file.export.textile': '导出 Textile',
  'file.export.opml': '导出 OPML',
}

/**
 * macOS 系统保留键与标准编辑项(notion-input 一「键位总则」):任何命令都不能占用,录制时就地提示被谁占用。
 */
export const RESERVED_KEYS: Record<string, string> = {
  'Mod-q': '退出 Typoza',
  'Mod-h': '隐藏 Typoza',
  'Mod-Alt-h': '隐藏其他',
  'Mod-m': '最小化',
  'Mod-w': '关闭',
  'Mod-,': '偏好设置…',
  'Mod-`': '在窗口间切换',
  'Ctrl-Mod-f': '切换全屏',
  'Ctrl-Mod-Space': '表情与符号',
  'Ctrl-Mod-d': '查询',
  'Ctrl-Mod-q': '锁定屏幕',
  'Mod-x': '剪切',
  'Mod-c': '拷贝',
  'Mod-v': '粘贴',
  'Mod-Shift-v': '粘贴为纯文本',
  'Mod-;': '立即检查文稿',
  'Mod-Shift-;': '显示拼写和语法',
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** 把键名整理成统一写法(修饰键顺序 Ctrl-Mod-Alt-Shift,单字符键小写,空格写作 Space)。 */
export function normalizeKey(name: string): string {
  const parts = name.split(/-(?!$)/)
  let key = parts[parts.length - 1]
  let ctrl = false
  let mod = false
  let alt = false
  let shift = false
  for (const p of parts.slice(0, -1)) {
    if (/^(cmd|meta|m|mod)$/i.test(p)) mod = true
    else if (/^(c|ctrl|control)$/i.test(p)) ctrl = true
    else if (/^(a|alt|option)$/i.test(p)) alt = true
    else if (/^s(hift)?$/i.test(p)) shift = true
    else throw new Error(`无法识别的修饰键「${p}」(键位 ${name})`)
  }
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toLowerCase()
  return [ctrl ? 'Ctrl' : '', mod ? 'Mod' : '', alt ? 'Alt' : '', shift ? 'Shift' : '', key].filter(Boolean).join('-')
}

// 带修饰键时 e.key 会变成别的字符(⌥A = å、⇧1 = !),按物理键还原
const CODE_KEYS: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Backquote: '`',
  Space: 'Space',
}

/** KeyboardEvent → 统一写法的键名。非 macOS 上 Ctrl 就是 Mod(与 prosemirror-keymap 一致)。 */
export function keyName(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey && IS_MAC) parts.push('Ctrl')
  if (e.metaKey || (e.ctrlKey && !IS_MAC)) parts.push('Mod')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  let key = e.key
  if (/^Key[A-Z]$/.test(e.code) && (e.altKey || e.shiftKey)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit\d$/.test(e.code) && (e.altKey || e.shiftKey)) key = e.code.slice(5)
  else if (CODE_KEYS[e.code] && (e.altKey || e.shiftKey || key === ' ')) key = CODE_KEYS[e.code]
  else if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toLowerCase()
  parts.push(key)
  return parts.join('-')
}

const KEY_SYMBOLS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Escape: 'Esc',
  Tab: '⇥',
  Space: '空格',
}

/** 键名 → 菜单上的写法(⌃⌥⇧⌘ 顺序与 macOS 一致),如 Mod-Shift-s → ⇧⌘S。 */
export function displayKey(name: string): string {
  const parts = normalizeKey(name).split(/-(?!$)/)
  const key = parts.pop() ?? ''
  const has = (m: string) => parts.includes(m)
  const mods = `${has('Ctrl') ? '⌃' : ''}${has('Alt') ? '⌥' : ''}${has('Shift') ? '⇧' : ''}${has('Mod') ? '⌘' : ''}`
  return mods + (KEY_SYMBOLS[key] ?? (key.length === 1 ? key.toUpperCase() : key))
}

/** 键 → 命令 ID。 */
export type KeyTable = Map<string, string>

/** 出厂键位:编辑区 + 表格 + 菜单。 */
export function defaultKeyTable(): KeyTable {
  const table: KeyTable = new Map()
  for (const source of [DEFAULT_KEYS, TABLE_KEYS, MENU_KEYS]) {
    for (const [key, id] of Object.entries(source)) table.set(normalizeKey(key), id)
  }
  return table
}

/** 出厂键位叠加用户改动后的实际键位。 */
export function effectiveKeyTable(custom: Record<string, string>): KeyTable {
  const table = defaultKeyTable()
  for (const [key, id] of Object.entries(custom)) {
    const k = normalizeKey(key)
    if (id) table.set(k, id)
    else table.delete(k)
  }
  return table
}

export function keysOf(table: KeyTable, id: string): string[] {
  return [...table].filter(([, v]) => v === id).map(([k]) => k)
}

/** 该键位已被占用时返回占用者的名字(系统保留键也算),否则 null。 */
export function keyOwner(table: KeyTable, key: string, exceptId: string): { label: string; reserved: boolean } | null {
  const k = normalizeKey(key)
  const reserved = RESERVED_KEYS[k]
  if (reserved) return { label: reserved, reserved: true }
  const id = table.get(k)
  return id && id !== exceptId ? { label: commandLabel(id), reserved: false } : null
}

/** 去掉某命令现有的全部键位:出厂键位记为取消(空串),用户加的直接删。 */
export function clearCommandKeys(custom: Record<string, string>, id: string): Record<string, string> {
  const defaults = defaultKeyTable()
  const next: Record<string, string> = {}
  for (const [k, v] of Object.entries(custom)) next[normalizeKey(k)] = v
  for (const k of keysOf(effectiveKeyTable(custom), id)) {
    if (defaults.has(k)) next[k] = ''
    else delete next[k]
  }
  return next
}

/** 把 key 设为命令 id 的唯一键位;原来占用该键的命令因此失去这个键(PRD 3.13「确认后原命令改为无键位」)。 */
export function assignKey(custom: Record<string, string>, id: string, key: string): Record<string, string> {
  const next = clearCommandKeys(custom, id)
  next[normalizeKey(key)] = id
  return next
}

/** 编辑区键位只交给 buildKeymaps 网页里存在的命令;native.* 由原生菜单处理。 */
export function editorKeybindings(custom: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, id] of Object.entries(custom)) if (!id.startsWith('native.')) out[k] = id
  return out
}

/** 浏览器里由网页自己处理的应用级键位(菜单命令)。编辑区命令的键由编辑器键位表处理,不在这里。 */
export function appKeyTable(custom: Record<string, string>): KeyTable {
  const menuIds = new Set(Object.values(MENU_KEYS))
  const table: KeyTable = new Map()
  for (const [key, id] of Object.entries(MENU_KEYS)) table.set(normalizeKey(key), id)
  for (const [key, id] of Object.entries(custom)) {
    const k = normalizeKey(key)
    if (id && menuIds.has(id)) table.set(k, id)
    else table.delete(k)
  }
  return table
}

/** 与出厂键位不同的命令及其新主键位(空串 = 无键位),发给原生菜单改 keyEquivalent;没列出的命令外壳恢复出厂键位。 */
export function menuKeyOverrides(custom: Record<string, string>): { id: string; key: string }[] {
  const defaults = defaultKeyTable()
  const effective = effectiveKeyTable(custom)
  const ids = new Set([...defaults.values(), ...effective.values()])
  const out: { id: string; key: string }[] = []
  for (const id of ids) {
    const before = keysOf(defaults, id)
    const after = keysOf(effective, id)
    const same = before.length === after.length && before.every((k) => after.includes(k))
    if (!same) out.push({ id, key: after[0] ?? '' })
  }
  return out
}

export function commandLabel(id: string): string {
  if (LABELS[id]) return LABELS[id]
  if (NATIVE_LABELS[id]) return NATIVE_LABELS[id]
  const label = getCommand(id)?.label
  if (id.startsWith('theme.') && label) return `主题:${label}`
  return label ?? id
}

export interface CommandRow {
  id: string
  label: string
  keys: string[]
}

/** 快捷键页的全部命令:注册表里的命令 + 只在外壳里的命令,按名字排序。 */
export function commandRows(custom: Record<string, string>): CommandRow[] {
  const table = effectiveKeyTable(custom)
  const ids = new Set([...allCommands().map((c) => c.id), ...Object.keys(NATIVE_LABELS)])
  return [...ids]
    .map((id) => ({ id, label: commandLabel(id), keys: keysOf(table, id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
}
