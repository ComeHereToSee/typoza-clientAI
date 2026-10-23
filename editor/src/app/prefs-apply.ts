// 偏好设置 → 编辑器与外壳:各项设置落到哪里,改完怎样立即生效(PRD 3.13「所有选项改完立即生效」)。
import { Selection } from 'prosemirror-state'
import type { EditorView, NodeViewConstructor } from 'prosemirror-view'
import { createEditorState } from '../core/editor'
import type { EditorEnv, EditorSettings } from '../core/env'
import { parseMarkdown, setUnicodePunctuation } from '../core/markdown/parse'
import type { SmartPunctuation } from '../core/smart-punctuation'
import type { Host } from '../host/types'
import { setDisplayOptions } from '../plugins/display'
import type { DocumentSession } from './document'
import { parseOptionsFrom } from './markdown-prefs'
import type { AppSettings } from './settings'
import { editorKeybindings, menuKeyOverrides } from './shortcuts'

export function smartPunctuationFrom(s: AppSettings): SmartPunctuation {
  return {
    mode: s.smartPunctuationMode,
    quotes: s.smartQuotes,
    doubleQuotes: s.doubleQuotes,
    singleQuotes: s.singleQuotes,
    dashes: s.smartDashes,
    dashRule: s.dashRule,
  }
}

export function editorSettingsFrom(s: AppSettings): EditorSettings {
  return {
    inlineMath: s.inlineMath,
    smartPunctuation: smartPunctuationFrom(s),
    autoPair: s.autoPair,
    autoPairMarkdown: s.autoPairMarkdown,
    showMarkdownMarkers: s.showMarkdownMarkers,
    copyPlainAsMarkdown: s.copyPlainAsMarkdown,
    copyLineWithoutSelection: s.copyLineWithoutSelection,
    codeLineNumbers: s.codeLineNumbers,
    codeLineWrap: s.codeLineWrap,
    spellcheck: s.spellcheck,
    keybindings: editorKeybindings(s.keybindings),
    codeIndentWidth: s.codeIndentWidth,
    mathCodeFence: s.mathCodeFence,
    mathAutoNumber: s.mathNumbering,
    mathPhysics: s.mathPhysics,
    mathLineBreak: s.mathLineBreak,
    diagrams: s.diagrams,
  }
}

type Key = keyof AppSettings

// 输入规则、快捷键、插件、代码块配置是建编辑器状态时定的,改了要重建状态(保留文档与选区)
const REBUILD_KEYS: Key[] = [
  'smartPunctuationMode',
  'smartQuotes',
  'doubleQuotes',
  'singleQuotes',
  'smartDashes',
  'dashRule',
  'keybindings',
  'codeLineNumbers',
  'codeLineWrap',
  'showMarkdownMarkers',
  // 代码块 Tab 缩进宽度是建插件时读的
  'codeIndentWidth',
]
// 改了识别规则要按新规则重新解析当前文档(文件内容不变)
const REPARSE_KEYS: Key[] = ['inlineMath', 'subscript', 'superscript', 'highlight', 'alerts', 'autolink', 'strictMode', 'unicodePunctuation']
// 空格与换行:只影响显示,交给显示插件
const DISPLAY_KEYS: Key[] = ['firstLineIndent', 'showBrTag', 'preserveSingleNewline']
// 改了图表、公式、代码块显示选项要重画节点视图(已显示的代码块当场换上行号 / 折行,对照表 PM-15、PM-16)
const REDRAW_KEYS: Key[] = ['diagrams', 'mathNumbering', 'mathPhysics', 'mathLineBreak', 'mathCodeFence', 'codeIndentWidth', 'codeLineNumbers', 'codeLineWrap']

export interface LiveEditor {
  view: EditorView
  env: EditorEnv
  session: DocumentSession
  host: Host
}

/** 启动时(打开第一个文档之前)把解析与显示的模块级开关设成偏好值。 */
export function initEditorPrefs(s: AppSettings): void {
  setUnicodePunctuation(s.unicodePunctuation)
  setDisplayOptions({ firstLineIndent: s.firstLineIndent, showBrTag: s.showBrTag, preserveSingleNewline: s.preserveSingleNewline })
}

/** 设置改动后让编辑器与外壳跟上。外观(主题、字号、缩放)由 appearance.ts 处理。 */
export function applyEditorPrefs(live: LiveEditor, s: AppSettings, patch: Partial<AppSettings>): void {
  const has = (keys: Key[]) => keys.some((k) => k in patch)
  // Unicode 标点开关是解析器的模块级状态,要在重新解析之前设好
  if ('unicodePunctuation' in patch) setUnicodePunctuation(s.unicodePunctuation)
  if (has(REPARSE_KEYS)) reparse(live, s)
  else if (has(REBUILD_KEYS)) rebuild(live)
  if (has(REDRAW_KEYS)) redrawNodeViews(live.view)
  if (has(DISPLAY_KEYS)) setDisplayOptions({ firstLineIndent: s.firstLineIndent, showBrTag: s.showBrTag, preserveSingleNewline: s.preserveSingleNewline }, live.view)
  if ('keybindings' in patch) syncMenuKeys(live.host, s)
  if ('spellcheck' in patch || 'spellcheckLanguage' in patch) syncSpelling(live.host, s)
}

function restoreSelection(live: LiveEditor, state: ReturnType<typeof createEditorState>, pos: number): void {
  const at = Math.min(pos, state.doc.content.size)
  live.view.updateState(state.apply(state.tr.setSelection(Selection.near(state.doc.resolve(at)))))
}

function rebuild(live: LiveEditor): void {
  const { doc, selection } = live.view.state
  restoreSelection(live, createEditorState(doc, live.env), selection.from)
}

/** 按新的识别规则重新解析当前文档:先按原规则写成文本(没动过的块就是原文),再解析;不算修改。 */
function reparse(live: LiveEditor, s: AppSettings): void {
  const text = live.session.serialize(live.view.state.doc)
  const { doc, meta } = parseMarkdown(text, parseOptionsFrom(s))
  live.session.meta = meta
  restoreSelection(live, createEditorState(doc, live.env), live.view.state.selection.from)
}

/** 换一组新的节点视图构造函数,ProseMirror 会重建全部节点视图(图表、公式按新选项重新渲染)。 */
export function redrawNodeViews(view: EditorView): void {
  const fresh: Record<string, NodeViewConstructor> = {}
  for (const [name, make] of Object.entries(view.props.nodeViews ?? {})) {
    fresh[name] = (...args: Parameters<NodeViewConstructor>) => make(...args)
  }
  view.setProps({ nodeViews: fresh })
}

/** 自定义快捷键同步到原生菜单(PRD 3.13 快捷键页)。 */
export function syncMenuKeys(host: Host, s: AppSettings): void {
  void host.setMenuKeys(menuKeyOverrides(s.keybindings)).catch((err: unknown) => console.error('同步菜单快捷键失败', err))
}

/** 拼写检查语言交给系统词典(PE-08)。 */
export function syncSpelling(host: Host, s: AppSettings): void {
  if (!s.spellcheck) return
  void host.setSpellingLanguage(s.spellcheckLanguage).catch((err: unknown) => console.error('设置拼写检查语言失败', err))
}
