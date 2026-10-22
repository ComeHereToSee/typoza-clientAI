// 模型改当前文档(doc.edit,PRD 3.7「改文档」):先在正文里以差异预览展示(删除标红、新增标绿),用户确认后才写入,
// 一次确认 = 一步撤销;确认前用户改了正文,预览失效并提示。结果用 ai.tool.decide 带 result 回报给模型。
// 差异按顶层块算:没改动的块保留原节点(写回时仍是原文),只替换改动的块。
import { closeHistory } from 'prosemirror-history'
import { DOMSerializer, Fragment, type Node as PMNode } from 'prosemirror-model'
import { Selection } from 'prosemirror-state'
import { Decoration, type EditorView } from 'prosemirror-view'
import { parseMarkdown } from '../core/markdown/parse'
import { schema } from '../core/schema'
import type { AiEvent, DocEdit } from '../host/ai-types'
import { h } from '../ui/dom'
import { type AiController, errorText } from './controller'
import { applyDocEdit, diffSequences, type Hunk } from './diff'
import { AI_EDIT, setAiDecorations, userEditCount } from './plugin'

export type EditState = 'queued' | 'preview' | 'stale' | 'failed' | 'applied' | 'rejected'

export interface PendingEdit {
  conversationId: string
  messageId: string
  callId: string
  edit: DocEdit
  /** 收到修改时打开的文档;换了文档后不能再应用 */
  path: string | null
  state: EditState
  /** 失败、失效的原因 */
  note?: string
  hunks: Hunk[]
  newBlocks: PMNode[]
  oldDoc: PMNode | null
  view: EditorView | null
  /** 预览时用户改正文的次数;之后变了就是预览失效 */
  edits: number
}

/** 顶层块的起始位置表:starts[k] 为第 k 块的起点,starts[n] 为文末 */
function blockStarts(doc: PMNode): number[] {
  const starts = [0]
  doc.forEach((node) => starts.push(starts[starts.length - 1] + node.nodeSize))
  return starts
}

function children(doc: PMNode): PMNode[] {
  const out: PMNode[] = []
  doc.forEach((node) => out.push(node))
  return out
}

export class DocEditPreview {
  /** 按 callId;侧栏卡片据此显示状态与按钮 */
  readonly items = new Map<string, PendingEdit>()
  private queue: PendingEdit[] = []
  private serializer: DOMSerializer | null = null

  constructor(private readonly ai: AiController) {}

  onEvent(ev: Extract<AiEvent, { type: 'doc.edit' }>): void {
    const item: PendingEdit = {
      conversationId: ev.conversationId,
      messageId: ev.messageId,
      callId: ev.callId,
      edit: ev.edit,
      path: this.ai.deps.documentPath(),
      state: 'queued',
      hunks: [],
      newBlocks: [],
      oldDoc: null,
      view: null,
      edits: 0,
    }
    this.items.set(item.callId, item)
    this.queue.push(item)
    if (!this.active()) this.next()
  }

  /** 正在预览(或预览已失效、等用户处理)的那一个 */
  private active(): PendingEdit | undefined {
    return this.queue.find((i) => i.state === 'preview' || i.state === 'stale')
  }

  private next(): void {
    const item = this.queue.find((i) => i.state === 'queued')
    if (item) this.preview(item)
  }

  private changed(item: PendingEdit): void {
    this.ai.panel.onStoreChange(item.messageId)
  }

  /** 算差异并在正文里显示;改动套不上时直接以失败回报模型 */
  preview(item: PendingEdit): void {
    const deps = this.ai.deps
    if (deps.documentPath() !== item.path) {
      item.state = 'stale'
      item.note = '当前文档已切换,不能应用这次修改'
      this.changed(item)
      return
    }
    if (deps.loading()) {
      // 大文档还在分段载入,正文不全:等载完再算差异,否则会按半篇文档改写
      item.note = '文档还在载入,载完后显示修改预览'
      this.changed(item)
      setTimeout(() => {
        if (item.state === 'queued') this.preview(item)
      }, 200)
      return
    }
    if (deps.readOnly()) {
      void this.resolve(item, 'failed', 'deny', '修改失败:当前文档只读,不能修改', '当前文档只读,不能修改')
      return
    }
    deps.ensureRichMode()
    const view = deps.view()
    let text: string
    try {
      text = applyDocEdit(deps.documentText(), item.edit)
    } catch (err) {
      void this.resolve(item, 'failed', 'deny', `修改失败:${errorText(err)}`, errorText(err))
      return
    }
    const oldDoc = view.state.doc
    const newBlocks = children(parseMarkdown(text, deps.parseOptions()).doc)
    const hunks = diffSequences(children(oldDoc), newBlocks, (a, b) => a.eq(b))
    if (!hunks.length) {
      void this.resolve(item, 'applied', 'allow', '文档已经是修改后的内容,没有需要改动的地方')
      return
    }
    Object.assign(item, { state: 'preview' as EditState, note: undefined, hunks, newBlocks, oldDoc, view, edits: userEditCount(view) })
    const starts = blockStarts(oldDoc)
    const decos: Decoration[] = []
    for (const hunk of hunks) {
      for (let k = hunk.aFrom; k < hunk.aTo; k++) decos.push(Decoration.node(starts[k], starts[k + 1], { class: 'tz-ai-del' }, { slot: 'diff' }))
      if (hunk.bTo > hunk.bFrom) {
        const ins = this.insertion(newBlocks.slice(hunk.bFrom, hunk.bTo))
        decos.push(Decoration.widget(starts[hunk.aTo], ins, { slot: 'diff', side: -1, key: `tz-ai-ins-${item.callId}-${hunk.aTo}-${hunk.bFrom}`, stopEvent: () => true, ignoreSelection: true }))
      }
    }
    const bar = this.bar(item)
    decos.push(Decoration.widget(starts[hunks[0].aFrom], bar, { slot: 'diff', side: -2, key: `tz-ai-bar-${item.callId}`, stopEvent: () => true, ignoreSelection: true }))
    // 光标移到第一处改动:大文档里视口裁剪只排版光标附近的块,改动在别处时预览条会被一起藏起来
    const tr = setAiDecorations(view.state.tr, 'diff', decos).setMeta('addToHistory', false)
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(starts[hunks[0].aFrom], tr.doc.content.size))))
    view.dispatch(tr)
    requestAnimationFrame(() => bar.scrollIntoView({ block: 'center' }))
    this.changed(item)
  }

  private insertion(blocks: PMNode[]): HTMLElement {
    this.serializer ??= DOMSerializer.fromSchema(schema)
    const el = h('div', { class: 'tz-ai-ins tz-ai-markdown', contenteditable: 'false' })
    el.append(this.serializer.serializeFragment(Fragment.fromArray(blocks)))
    return el
  }

  private bar(item: PendingEdit): HTMLElement {
    const apply = h('button', { type: 'button', name: 'applyEdit', class: 'tz-ai-btn is-primary' }, '应用')
    const reject = h('button', { type: 'button', name: 'rejectEdit', class: 'tz-ai-btn' }, '拒绝')
    apply.addEventListener('click', () => this.apply(item.callId))
    reject.addEventListener('click', () => void this.reject(item.callId))
    return h('div', { class: 'tz-ai-diff-bar', contenteditable: 'false' }, h('span', null, `✦ AI 建议修改 ${item.hunks.length} 处`), apply, reject)
  }

  /** 应用修改:一次编辑写入(⌘Z 一步撤回),然后回报模型 */
  apply(callId: string): void {
    const item = this.items.get(callId)
    if (!item || item.state !== 'preview' || !item.view || !item.oldDoc) return
    const view = item.view
    if (view.isDestroyed || view !== this.ai.deps.view() || userEditCount(view) !== item.edits || view.state.doc !== item.oldDoc) {
      this.markStale(item)
      return
    }
    const starts = blockStarts(item.oldDoc)
    const tr = closeHistory(view.state.tr)
    for (const hunk of [...item.hunks].reverse()) {
      tr.replaceWith(starts[hunk.aFrom], starts[hunk.aTo], Fragment.fromArray(item.newBlocks.slice(hunk.bFrom, hunk.bTo)))
    }
    setAiDecorations(tr, 'diff', [])
    view.dispatch(tr.setMeta(AI_EDIT, true).scrollIntoView())
    void this.resolve(item, 'applied', 'allow', `已应用修改(共 ${item.hunks.length} 处)`)
  }

  async reject(callId: string): Promise<void> {
    const item = this.items.get(callId)
    if (!item || (item.state !== 'preview' && item.state !== 'stale' && item.state !== 'queued')) return
    this.clearDecorations(item)
    await this.resolve(item, 'rejected', 'deny', '用户拒绝了这次修改')
  }

  /** 预览失效后按当前正文重新预览 */
  repreview(callId: string): void {
    const item = this.items.get(callId)
    if (!item || item.state !== 'stale') return
    this.preview(item)
  }

  private markStale(item: PendingEdit): void {
    this.clearDecorations(item)
    item.state = 'stale'
    item.note = '正文已改动,预览已失效'
    this.changed(item)
  }

  private clearDecorations(item: PendingEdit): void {
    const view = item.view
    if (view && !view.isDestroyed) view.dispatch(setAiDecorations(view.state.tr, 'diff', []).setMeta('addToHistory', false))
  }

  private async resolve(item: PendingEdit, state: EditState, decision: 'allow' | 'deny', result: string, note?: string): Promise<void> {
    item.state = state
    item.note = note
    this.queue = this.queue.filter((i) => i !== item)
    this.changed(item)
    await this.ai.decideTool(item.conversationId, item.callId, decision, result)
    if (!this.active()) this.next()
  }

  onUserEdit(view: EditorView): void {
    const item = this.active()
    if (item?.state === 'preview' && item.view === view) this.markStale(item)
  }

  onViewDestroyed(view: EditorView): void {
    const item = this.active()
    if (item?.state !== 'preview' || item.view !== view) return
    item.state = 'stale'
    item.note = '文档已切换或重新载入,预览已失效'
    item.view = null
    this.changed(item)
  }
}
