// 代码块:在 ProseMirror 里嵌 CodeMirror 6(按 prosemirror.net 官方「嵌入代码编辑器」示例的同步方式)。
// 语言按需加载;mermaid / sequence / flow 图表与 ```math 公式在代码下方渲染预览,光标不在块内时只显示渲染结果(Typora 行为)。
// 缩进宽度按偏好(PM-18);「调整缩进」命令按语言规则重排所选行或整个代码块(P-24)。
// 大文档里有上千个代码块:CodeMirror 等块接近视口或要编辑时才建,之前用静态 <pre> 占位(建 / 拆实例与逐个测量是打开和关闭大文档的主要耗时)。
import { defaultKeymap, indentSelection, indentWithTab } from '@codemirror/commands'
import { LanguageDescription, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { Compartment, EditorState as CMState } from '@codemirror/state'
import { EditorView as CMView, type KeyBinding, type ViewUpdate, drawSelection, keymap as cmKeymap, lineNumbers } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { chainCommands, exitCode, setBlockType } from 'prosemirror-commands'
import { redo, undo } from 'prosemirror-history'
import { undoInputRule } from 'prosemirror-inputrules'
import type { Node as PMNode } from 'prosemirror-model'
import { type Command, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import { EDITOR_OPTION_DEFAULTS, type EditorEnv } from '../core/env'
import { registerCommand } from '../core/registry'
import { schema } from '../core/schema'
import { ICONS, h, svgIcon } from '../ui/dom'
import { renderDiagram, isDiagramLanguage } from './diagram'
import { renderTex, trackMath, untrackMath } from './katex'
import { mathFenceEnabled, mathOptions } from './math'

/** 渲染预览的类型:图表、公式;偏好关掉时按普通代码显示。 */
function previewKind(language: string, env: EditorEnv): 'diagram' | 'math' | null {
  const name = language.toLowerCase()
  if (name === 'math') return mathFenceEnabled(env) ? 'math' : null
  if (isDiagramLanguage(name)) return (env.settings.diagrams ?? EDITOR_OPTION_DEFAULTS.diagrams) ? 'diagram' : null
  return null
}

function indentExtensions(env: EditorEnv) {
  const width = env.settings.codeIndentWidth ?? EDITOR_OPTION_DEFAULTS.codeIndentWidth
  return [indentUnit.of(' '.repeat(width)), CMState.tabSize.of(width)]
}

/** 正在显示的代码块(「调整缩进」命令找光标所在的那一个)。 */
const codeViews = new Set<CodeBlockView>()

/** 代码块进入视口附近时再建 CodeMirror;提前一屏左右,滚动时看不到占位到编辑器的切换。 */
let lazyObserver: IntersectionObserver | null = null
const lazyViews = new WeakMap<Element, CodeBlockView>()

function observeLazy(el: HTMLElement, view: CodeBlockView): void {
  if (typeof IntersectionObserver === 'undefined') {
    view.ensureEditor()
    return
  }
  lazyObserver ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        lazyObserver?.unobserve(e.target)
        lazyViews.get(e.target)?.ensureEditor()
      }
    },
    { rootMargin: '800px 0px' },
  )
  lazyViews.set(el, view)
  lazyObserver.observe(el)
}

function unobserveLazy(el: HTMLElement): void {
  lazyObserver?.unobserve(el)
  lazyViews.delete(el)
}

function activeCodeView(view: EditorView): CodeBlockView | undefined {
  return [...codeViews].find((v) => v.owns(view))
}

/** 偏好变化后让已显示的代码块按新设置重新配置(行号、换行、缩进宽度、预览开关)。 */
export function refreshCodeBlocks(): void {
  for (const v of codeViews) v.reconfigure()
}

/** 为选中内容 / 整个代码块调整缩进(对照表 P-24)。 */
registerCommand({ id: 'code.indentSelection', label: '为选中内容调整缩进', run: (view) => activeCodeView(view)?.reindent(false) ?? false })
registerCommand({ id: 'code.indentBlock', label: '为整个代码块调整缩进', run: (view) => activeCodeView(view)?.reindent(true) ?? false })
/** 复制代码块内容(对照表 P-23),与右上角【复制代码】按钮同一做法。 */
registerCommand({
  id: 'code.copyBlock',
  label: '复制代码块内容',
  run: (view) => {
    const code = activeCodeView(view)
    if (!code) return false
    void code.copyAll()
    return true
  },
})

const ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  golang: 'go',
  rs: 'rust',
  kt: 'kotlin',
  objc: 'objective-c',
}

function findLanguage(name: string): LanguageDescription | null {
  if (!name) return null
  const key = ALIASES[name.toLowerCase()] ?? name
  return LanguageDescription.matchLanguageName(languages, key, true)
}

export class CodeBlockView implements NodeView {
  dom: HTMLElement
  /** 还没建 CodeMirror 时为 null,此时正文显示在 placeholder 里 */
  private cm: CMView | null = null
  private placeholder: HTMLPreElement | null
  private updating = false
  private readonly language = new Compartment()
  private readonly gutter = new Compartment()
  private readonly wrap = new Compartment()
  private readonly indent = new Compartment()
  private readonly langInput: HTMLInputElement
  private readonly preview: HTMLDivElement
  private loadedLanguage = ''
  private renderTimer = 0
  /** 当前的渲染预览类型(图表 / 公式),没有为 null */
  private previewing: 'diagram' | 'math' | null = null

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly env: EditorEnv,
  ) {
    this.langInput = h('input', {
      class: 'tz-code-lang',
      placeholder: '语言',
      value: node.attrs.language ?? '',
      spellcheck: 'false',
      list: 'tz-code-languages',
    })
    this.langInput.addEventListener('change', () => this.setLanguageAttr(this.langInput.value.trim()))
    this.langInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.setLanguageAttr(this.langInput.value.trim())
        this.ensureEditor().focus()
      }
    })
    const copy = h(
      'button',
      {
        class: 'tz-code-copy',
        title: '复制代码',
        type: 'button',
        onclick: ((e: Event) => {
          e.preventDefault()
          void this.copyAll().then(() => {
            copy.classList.add('is-done')
            setTimeout(() => copy.classList.remove('is-done'), 1200)
          })
        }) as EventListener,
      },
      svgIcon(ICONS.copy, 14),
    )
    const header = h('div', { class: 'tz-code-header', contenteditable: 'false' }, this.langInput, copy)
    this.preview = h('div', { class: 'tz-diagram-preview', contenteditable: 'false', hidden: true })
    this.preview.addEventListener('mousedown', (e) => {
      // 点图表进入编辑
      e.preventDefault()
      this.ensureEditor().focus()
      const pos = this.getPos()
      if (pos !== undefined) this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1)))
    })
    this.placeholder = h('pre', { class: 'tz-code-static', spellcheck: 'false' }, node.textContent)
    // 点占位:建编辑器并把光标放到点击处附近的行首
    this.placeholder.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const cm = this.ensureEditor()
      const at = cm.posAtCoords({ x: e.clientX, y: e.clientY }) ?? 0
      cm.focus()
      cm.dispatch({ selection: { anchor: at } })
    })
    if (!env.settings.codeLineWrap) this.placeholder.classList.add('is-nowrap')
    this.dom = h('div', { class: 'tz-code-block' }, header, this.placeholder, this.preview)
    ensureLanguageList()
    codeViews.add(this)
    trackMath(this)
    this.applyLanguage()
    observeLazy(this.dom, this)
  }

  /** 建 CodeMirror 并换下占位(已建时直接返回)。 */
  ensureEditor(): CMView {
    if (this.cm) return this.cm
    unobserveLazy(this.dom)
    const cm = new CMView({
      state: CMState.create({
        doc: this.node.textContent,
        extensions: [
          cmKeymap.of([...this.escapeKeys(), indentWithTab, ...defaultKeymap]),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(classHighlighter),
          this.language.of([]),
          this.indent.of(indentExtensions(this.env)),
          this.gutter.of(this.env.settings.codeLineNumbers ? lineNumbers() : []),
          this.wrap.of(this.env.settings.codeLineWrap ? CMView.lineWrapping : []),
          CMView.updateListener.of((update) => this.forwardUpdate(update)),
          CMView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        ],
      }),
    })
    this.cm = cm
    this.placeholder?.replaceWith(cm.dom)
    this.placeholder = null
    this.loadLanguage()
    if (this.previewing) this.schedulePreview()
    return cm
  }

  /** 光标(ProseMirror 选区或 CodeMirror 焦点)在这个代码块里。 */
  owns(view: EditorView): boolean {
    if (view !== this.view) return false
    if (this.cm?.hasFocus) return true
    const pos = this.getPos()
    const { from, to } = view.state.selection
    return pos !== undefined && from > pos && to < pos + this.node.nodeSize
  }

  /** 整块代码写进剪贴板。走宿主剪贴板:typoza:// 页面里 navigator.clipboard 不一定可用。 */
  copyAll(): Promise<void> {
    return this.env.host
      .clipboardWrite({ text: this.node.textContent })
      .catch((err: unknown) => this.env.actions.notify(`复制失败:${err instanceof Error ? err.message : String(err)}`, true))
  }

  /** 按语言的缩进规则重排所选行(whole 为整个代码块)。 */
  reindent(whole: boolean): boolean {
    const cm = this.ensureEditor()
    // 改动经 CodeMirror 的更新回调同步回文档,回调只在 CodeMirror 有焦点时转发
    cm.focus()
    if (!whole) return indentSelection(cm)
    const head = cm.state.selection.main.head
    cm.dispatch({ selection: { anchor: 0, head: cm.state.doc.length } })
    const ok = indentSelection(cm)
    cm.dispatch({ selection: { anchor: Math.min(head, cm.state.doc.length) } })
    return ok
  }

  /** 「刷新所有数学公式」:```math 预览重新渲染。 */
  refresh(): void {
    if (this.previewing === 'math') this.schedulePreview()
  }

  private setLanguageAttr(language: string): void {
    const pos = this.getPos()
    if (pos === undefined || language === this.node.attrs.language) return
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, language }))
  }

  private applyLanguage(): void {
    const name = this.node.attrs.language ?? ''
    this.dom.dataset.language = name
    this.previewing = previewKind(name, this.env)
    this.dom.classList.toggle('is-diagram', this.previewing !== null)
    this.preview.hidden = this.previewing === null
    if (this.previewing) this.schedulePreview()
    this.loadLanguage()
  }

  /** 按语言加载语法高亮(编辑器建好后才需要)。 */
  private loadLanguage(): void {
    const cm = this.cm
    const name = this.node.attrs.language ?? ''
    if (!cm || name === this.loadedLanguage) return
    this.loadedLanguage = name
    const desc = findLanguage(name)
    if (!desc) {
      cm.dispatch({ effects: this.language.reconfigure([]) })
      return
    }
    void desc.load().then((support) => {
      if (this.loadedLanguage === name) cm.dispatch({ effects: this.language.reconfigure(support) })
    })
  }

  private schedulePreview(): void {
    // 图表、公式预览也等块接近视口(建好编辑器)时再画:隐藏的块里 Mermaid 量不到文字尺寸会画错,也省得一次画几百张
    if (!this.cm) return
    clearTimeout(this.renderTimer)
    this.renderTimer = window.setTimeout(() => {
      const code = this.node.textContent
      if (this.previewing === 'math') {
        this.preview.classList.toggle('is-empty', !code.trim())
        if (!code.trim()) this.preview.textContent = '空公式'
        else void renderTex(code, this.preview, true, mathOptions(this.env, this.view.state.doc))
      } else if (this.previewing === 'diagram') {
        void renderDiagram(this.node.attrs.language, code, this.preview)
      }
    }, 250)
  }

  // ---------- CodeMirror ↔ ProseMirror 同步 ----------

  private forwardUpdate(update: ViewUpdate): void {
    if (this.updating || !this.cm?.hasFocus) return
    const pos = this.getPos()
    if (pos === undefined) return
    let offset = pos + 1
    const { main } = update.state.selection
    const selFrom = offset + main.from
    const selTo = offset + main.to
    const pmSel = this.view.state.selection
    if (update.docChanged || pmSel.from !== selFrom || pmSel.to !== selTo) {
      const tr = this.view.state.tr
      update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
        if (text.length) tr.replaceWith(offset + fromA, offset + toA, schema.text(text.toString()))
        else tr.delete(offset + fromA, offset + toA)
        offset += toB - fromB - (toA - fromA)
      })
      tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo))
      this.view.dispatch(tr)
    }
  }

  setSelection(anchor: number, head: number): void {
    const cm = this.ensureEditor()
    cm.focus()
    this.updating = true
    cm.dispatch({ selection: { anchor, head } })
    this.updating = false
  }

  private escapeKeys(): KeyBinding[] {
    const view = this.view
    const pm = (cmd: Command) => () => cmd(view.state, view.dispatch, view)
    return [
      { key: 'ArrowUp', run: () => this.maybeEscape('line', -1) },
      { key: 'ArrowLeft', run: () => this.maybeEscape('char', -1) },
      { key: 'ArrowDown', run: () => this.maybeEscape('line', 1) },
      { key: 'ArrowRight', run: () => this.maybeEscape('char', 1) },
      {
        key: 'Mod-Enter',
        run: () => {
          if (!exitCode(view.state, view.dispatch)) return false
          view.focus()
          return true
        },
      },
      {
        // 空代码块里退格:变回普通段落(与 Notion 一致)
        key: 'Backspace',
        run: () => {
          if ((this.cm?.state.doc.length ?? 0) > 0) return false
          const ok = setBlockType(schema.nodes.paragraph)(view.state, view.dispatch)
          if (ok) view.focus()
          return ok
        },
      },
      // 自动转换(如「```js 空格」)后立即 ⌘Z 撤回为原字符(PRD 3.3「撤回」)
      { key: 'Mod-z', run: pm(chainCommands(undoInputRule, undo)) },
      { key: 'Mod-Shift-z', run: pm(redo) },
      { key: 'Mod-y', run: pm(redo) },
    ]
  }

  private maybeEscape(unit: 'line' | 'char', dir: -1 | 1): boolean {
    if (!this.cm) return false
    const { state } = this.cm
    let range: { from: number; to: number } = state.selection.main
    if (!state.selection.main.empty) return false
    if (unit === 'line') range = state.doc.lineAt(state.selection.main.head)
    if (dir < 0 ? range.from > 0 : range.to < state.doc.length) return false
    const pos = this.getPos()
    if (pos === undefined) return false
    const target = pos + (dir < 0 ? 0 : this.node.nodeSize)
    const selection = Selection.near(this.view.state.doc.resolve(target), dir)
    this.view.dispatch(this.view.state.tr.setSelection(selection).scrollIntoView())
    this.view.focus()
    return true
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const languageChanged = node.attrs.language !== this.node.attrs.language
    this.node = node
    if (languageChanged) {
      this.langInput.value = node.attrs.language ?? ''
      this.applyLanguage()
    }
    if (this.updating) return true
    const next = node.textContent
    if (!this.cm) {
      if (this.placeholder && this.placeholder.textContent !== next) this.placeholder.textContent = next
      if (this.previewing) this.schedulePreview()
      return true
    }
    const cur = this.cm.state.doc.toString()
    if (next !== cur) {
      let start = 0
      let curEnd = cur.length
      let nextEnd = next.length
      while (start < curEnd && cur.charCodeAt(start) === next.charCodeAt(start)) start++
      while (curEnd > start && nextEnd > start && cur.charCodeAt(curEnd - 1) === next.charCodeAt(nextEnd - 1)) {
        curEnd--
        nextEnd--
      }
      this.updating = true
      this.cm.dispatch({ changes: { from: start, to: curEnd, insert: next.slice(start, nextEnd) } })
      this.updating = false
    }
    if (this.previewing) this.schedulePreview()
    return true
  }

  /** 设置变化(行号、自动换行、缩进宽度)时由编辑器调用。 */
  reconfigure(): void {
    this.cm?.dispatch({
      effects: [
        this.gutter.reconfigure(this.env.settings.codeLineNumbers ? lineNumbers() : []),
        this.wrap.reconfigure(this.env.settings.codeLineWrap ? CMView.lineWrapping : []),
        this.indent.reconfigure(indentExtensions(this.env)),
      ],
    })
    // 图表 / 公式预览开关也可能变了
    this.applyLanguage()
  }

  selectNode(): void {
    this.ensureEditor().focus()
  }

  stopEvent(): boolean {
    return true
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    clearTimeout(this.renderTimer)
    codeViews.delete(this)
    untrackMath(this)
    unobserveLazy(this.dom)
    this.cm?.destroy()
  }
}

/** 语言输入框的候选列表(全局一份)。 */
function ensureLanguageList(): void {
  if (document.getElementById('tz-code-languages')) return
  const list = h('datalist', { id: 'tz-code-languages' })
  const names = new Set<string>(['mermaid', 'sequence', 'flow', 'math'])
  for (const l of languages) names.add(l.name.toLowerCase())
  for (const name of [...names].sort()) list.append(h('option', { value: name }))
  document.body.append(list)
}

/** 方向键从普通文本块进入代码块时,把光标交给 CodeMirror(官方示例的 arrowHandler)。 */
export function codeBlockArrowHandler(dir: 'left' | 'right' | 'up' | 'down'): Command {
  return (state, dispatch, view) => {
    if (state.selection.empty && view?.endOfTextblock(dir)) {
      const side = dir === 'left' || dir === 'up' ? -1 : 1
      const $head = state.selection.$head
      const next = Selection.near(state.doc.resolve(side > 0 ? $head.after() : $head.before()), side)
      if (next.$head && next.$head.parent.type === schema.nodes.code_block) {
        if (dispatch) dispatch(state.tr.setSelection(next))
        return true
      }
    }
    return false
  }
}
