// 公式:块级公式显示渲染结果,光标进入时下方露出源码(Typora);行内公式点击弹出编辑框(Notion)。
// 公式选项(自动编号、physics、\\ 换行)读偏好;\ref 按全文编号解析;「刷新所有数学公式」与复制为 TeX / MathML 命令也在这里。
import type { Node as PMNode } from 'prosemirror-model'
import { type EditorState, NodeSelection, Plugin, TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import { EDITOR_OPTION_DEFAULTS, type EditorEnv } from '../core/env'
import { registerCommand } from '../core/registry'
import { schema } from '../core/schema'
import { h } from '../ui/dom'
import { type MathOptions, refreshAllMath, renderTex, texToMathML, trackMath, untrackMath } from './katex'
import { type AutoNumber, equationLabels } from './math-tex'

/** 是否把 ```math 代码块当公式(偏好 PM-07)。 */
export function mathFenceEnabled(env: EditorEnv): boolean {
  return env.settings.mathCodeFence ?? EDITOR_OPTION_DEFAULTS.mathCodeFence
}

const labelCache = new WeakMap<PMNode, { mode: AutoNumber; fence: boolean; labels: Map<string, string> }>()

/** 全文块公式(含 ```math)的「标签 → 编号」,同一版文档只算一次。 */
function documentLabels(doc: PMNode, mode: AutoNumber, fence: boolean): Map<string, string> {
  const cached = labelCache.get(doc)
  if (cached && cached.mode === mode && cached.fence === fence) return cached.labels
  const texs: string[] = []
  doc.descendants((node) => {
    if (node.type === schema.nodes.math_block) texs.push(node.textContent)
    else if (fence && node.type === schema.nodes.code_block && String(node.attrs.language).toLowerCase() === 'math') texs.push(node.textContent)
    return !node.isTextblock
  })
  const labels = equationLabels(texs, mode)
  labelCache.set(doc, { mode, fence, labels })
  return labels
}

/** 当前偏好下的公式选项。 */
export function mathOptions(env: EditorEnv, doc: PMNode): MathOptions {
  const autoNumber = env.settings.mathAutoNumber ?? EDITOR_OPTION_DEFAULTS.mathAutoNumber
  return {
    autoNumber,
    physics: env.settings.mathPhysics ?? EDITOR_OPTION_DEFAULTS.mathPhysics,
    lineBreak: env.settings.mathLineBreak ?? EDITOR_OPTION_DEFAULTS.mathLineBreak,
    labels: documentLabels(doc, autoNumber, mathFenceEnabled(env)),
  }
}

export class MathBlockView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private preview: HTMLDivElement
  private rendered = ''

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly env: EditorEnv,
  ) {
    this.preview = h('div', { class: 'tz-math-preview', contenteditable: 'false' })
    this.contentDOM = h('pre', { class: 'tz-math-source', spellcheck: 'false' })
    this.dom = h('div', { class: 'tz-math-block' }, this.preview, this.contentDOM)
    this.preview.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos === undefined) return
      this.view.focus()
      this.view.dispatch(this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, pos + 1 + this.node.content.size)))
    })
    trackMath(this)
    this.render()
  }

  private render(force = false): void {
    const tex = this.node.textContent
    if (tex === this.rendered && !force) return
    this.rendered = tex
    this.dom.classList.toggle('is-empty', tex.trim() === '')
    if (tex.trim() === '') {
      this.preview.textContent = '点击输入公式(LaTeX)'
      return
    }
    void renderTex(tex, this.preview, true, mathOptions(this.env, this.view.state.doc))
  }

  refresh(): void {
    this.render(true)
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    this.node = node
    this.render()
    return true
  }

  ignoreMutation(mutation: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return this.preview.contains(mutation.target as Node)
  }

  destroy(): void {
    untrackMath(this)
  }
}

export class MathInlineView implements NodeView {
  dom: HTMLSpanElement
  private editor: HTMLDivElement | null = null

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly env: EditorEnv,
  ) {
    this.dom = h('span', { class: 'tz-math-inline' })
    trackMath(this)
    this.render()
  }

  private render(): void {
    const tex = this.node.attrs.tex as string
    if (!tex.trim()) {
      this.dom.textContent = '公式'
      this.dom.classList.add('is-empty')
      return
    }
    this.dom.classList.remove('is-empty')
    void renderTex(tex, this.dom, false, mathOptions(this.env, this.view.state.doc))
  }

  refresh(): void {
    this.render()
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const changed = node.attrs.tex !== this.node.attrs.tex
    this.node = node
    if (changed) this.render()
    return true
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
    this.openEditor()
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
    this.closeEditor()
  }

  private openEditor(): void {
    if (this.editor) return
    const original = this.node.attrs.tex as string
    const input = h('textarea', { class: 'tz-math-input', rows: '2', spellcheck: 'false', placeholder: 'LaTeX,如 E=mc^2' })
    input.value = original
    const done = h('button', { type: 'button', class: 'tz-math-done' }, '完成 ↵')
    const editor = h('div', { class: 'tz-popover tz-math-popover' }, input, done)
    this.editor = editor
    document.body.append(editor)
    const place = () => {
      const r = this.dom.getBoundingClientRect()
      editor.style.left = `${Math.max(8, r.left)}px`
      editor.style.top = `${r.bottom + 6}px`
    }
    place()
    const commit = (moveAfter: boolean) => {
      const pos = this.getPos()
      if (pos === undefined) return
      const tex = input.value
      const tr = this.view.state.tr
      if (tex.trim() === '') tr.delete(pos, pos + 1)
      else if (tex !== this.node.attrs.tex) tr.setNodeMarkup(pos, null, { tex })
      if (moveAfter) tr.setSelection(TextSelection.create(tr.doc, tex.trim() === '' ? pos : pos + 1))
      this.view.dispatch(tr)
      if (moveAfter) this.view.focus()
    }
    input.addEventListener('input', () => {
      // 实时预览:直接改节点属性(同一编辑会话的修改在撤销历史里合并)
      const pos = this.getPos()
      if (pos === undefined || !input.value.trim()) return
      const tr = this.view.state.tr.setNodeMarkup(pos, null, { tex: input.value })
      tr.setSelection(NodeSelection.create(tr.doc, pos))
      this.view.dispatch(tr)
      place()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        commit(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        input.value = original
        commit(true)
      }
    })
    done.addEventListener('click', () => commit(true))
    requestAnimationFrame(() => {
      input.focus()
      input.select()
    })
  }

  private closeEditor(): void {
    this.editor?.remove()
    this.editor = null
  }

  stopEvent(e: Event): boolean {
    return Boolean(this.editor?.contains(e.target as Node))
  }

  ignoreMutation(): boolean {
    return true
  }

  destroy(): void {
    untrackMath(this)
    this.closeEditor()
  }
}

/** 选区所在的公式:选中的行内 / 块公式,或光标所在的公式块、```math 代码块。 */
export function selectedTex(state: EditorState): { tex: string; display: boolean } | null {
  const sel = state.selection
  if (sel instanceof NodeSelection) {
    if (sel.node.type === schema.nodes.math_inline) return { tex: sel.node.attrs.tex as string, display: false }
    if (sel.node.type === schema.nodes.math_block) return { tex: sel.node.textContent, display: true }
  }
  const parent = sel.$from.parent
  if (parent.type === schema.nodes.math_block) return { tex: parent.textContent, display: true }
  if (parent.type === schema.nodes.code_block && String(parent.attrs.language).toLowerCase() === 'math') return { tex: parent.textContent, display: true }
  return null
}

/** 公式相关命令:刷新所有数学公式(对照表 E-24)、复制为 TeX / MathML(C-07,右键菜单入口另接)。 */
export function mathPlugin(env: EditorEnv): Plugin {
  const copy = (view: EditorView, kind: 'tex' | 'mathml'): boolean => {
    const found = selectedTex(view.state)
    if (!found) {
      env.actions.notify('光标不在公式里', true)
      return false
    }
    const text = kind === 'tex' ? Promise.resolve(found.tex) : texToMathML(found.tex, found.display, mathOptions(env, view.state.doc))
    text
      .then((value) => env.host.clipboardWrite({ text: value }))
      .then(
        () => env.actions.notify(kind === 'tex' ? '已复制 Tex 代码' : '已复制 MathML'),
        (err: unknown) => env.actions.notify(`复制失败:${err instanceof Error ? err.message : String(err)}`, true),
      )
    return true
  }
  registerCommand({ id: 'math.refresh', label: '刷新所有数学公式', run: () => (refreshAllMath(), true) })
  registerCommand({ id: 'math.copyTex', label: '复制为 Tex 代码', run: (view) => copy(view, 'tex') })
  registerCommand({ id: 'math.copyMathML', label: '复制为 MathML', run: (view) => copy(view, 'mathml') })
  return new Plugin({})
}
