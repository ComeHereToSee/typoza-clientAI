// 正文里的 AI(PRD 3.4、3.5):
// - 选中文字 ▸ AI 动作:结果流式显示在选区下方的卡片里,不直接改文档;【替换】【插入下方】【重试】【放弃】,Esc 放弃;
//   生成中选区原文被改动时【替换】改为提示。
// - /ai 与空行按空格:在光标处输入指令,结果以待确认块显示;【接受】【重试】【放弃】。卡片是装饰,未接受前不进文档、不会被保存。
// 替换、插入、接受都是一次编辑,⌘Z 一步撤回。
import { closeHistory } from 'prosemirror-history'
import { TextSelection, type Transaction } from 'prosemirror-state'
import { Decoration, type EditorView } from 'prosemirror-view'
import { schema } from '../core/schema'
import type { AiDoneStatus, AiErrorInfo } from '../host/ai-types'
import { h } from '../ui/dom'
import { FloatingMenu, type MenuItem } from '../ui/menu'
import { type AiController, describeError } from './controller'
import { type ActionDef, actionsFor, fillPrompt, TRANSLATE_LANGUAGES } from './prompt'
import { AI_EDIT, aiDecorations, setAiDecorations } from './plugin'
import { markdownBlocks, markdownSlice, renderMarkdown, Throttle } from './render'

type CardStatus = 'input' | 'streaming' | 'done' | 'stopped' | 'error'

interface Card {
  mode: 'selection' | 'write'
  view: EditorView
  el: HTMLElement
  result: HTMLElement
  status: CardStatus
  text: string
  error?: AiErrorInfo
  requestId: string | null
  /** 每次重新生成加一,丢弃旧请求迟到的输出 */
  generation: number
  throttle: Throttle
  // 选中文字动作
  action?: ActionDef
  language?: string
  /** 发起时选区的文字(判断原文是否被改动) */
  original?: string
  /** 发起时选区的 Markdown(交给模型) */
  selectionMarkdown?: string
  // 在光标处生成
  instruction?: string
  input?: HTMLTextAreaElement
}

const ACTION_VERBS: Record<CardStatus, string> = { input: '', streaming: '正在生成…', done: '', stopped: '已停止', error: '出错' }

export class AiAssist {
  private card: Card | null = null
  private readonly menu = new FloatingMenu({ className: 'tz-ai-action-menu' })

  constructor(private readonly ai: AiController) {}

  // ---------- 选中文字动作 ----------

  /** 当前选区所在的是不是代码(代码块里只给「解释」「改写」) */
  private inCode(view: EditorView): boolean {
    const { $from } = view.state.selection
    return Boolean($from.parent.type.spec.code) || $from.marks().some((m) => m.type === schema.marks.code)
  }

  /** 格式条【AI】与右键「AI ▸」共用的动作列表 */
  selectionMenuItems(view: EditorView): MenuItem[] {
    if (view.state.selection.empty) return []
    const custom = this.ai.settings?.actions ?? []
    return actionsFor(custom, this.inCode(view)).map((action) => ({
      id: `ai.action.${action.id}`,
      label: action.name,
      icon: '✦',
      group: action.builtin ? 'AI 动作' : '自定义动作',
      children: action.needsLanguage
        ? () => TRANSLATE_LANGUAGES.map((lang) => ({ id: `ai.lang.${lang}`, label: lang, run: () => void this.runAction(view, action, lang) }))
        : undefined,
      run: action.needsLanguage ? undefined : () => void this.runAction(view, action),
    }))
  }

  /** 命令 ai.selection:在选区处弹出 AI 动作菜单 */
  openActionMenu(view: EditorView): boolean {
    if (view.state.selection.empty) {
      this.ai.deps.toast('请先选中文字', true)
      return true
    }
    void this.ai.ensureConfigured().then((ok) => {
      if (!ok) return
      const end = view.coordsAtPos(view.state.selection.to)
      this.menu.open(this.selectionMenuItems(view), { left: end.left, top: end.top, bottom: end.bottom })
    })
    return true
  }

  async runAction(target: EditorView, action: ActionDef, language?: string): Promise<void> {
    if (!(await this.ai.ensureConfigured())) return
    this.ai.deps.ensureRichMode()
    // 切回所见即所得会换编辑器视图;此外菜单打开期间也可能换了文档
    const view = this.ai.deps.view()
    if (view !== target && !target.isDestroyed) return
    const { from, to, empty } = view.state.selection
    if (empty) return
    this.discard()
    const doc = view.state.doc
    const $to = doc.resolve(to)
    const anchor = $to.depth > 0 ? $to.after($to.depth) : to
    const card = this.newCard('selection', view)
    card.action = action
    card.language = language
    card.original = doc.textBetween(from, to, '\n\n', ' ')
    card.selectionMarkdown = this.ai.deps.selectionText()
    this.card = card
    view.dispatch(
      setAiDecorations(view.state.tr, 'selection', [
        Decoration.inline(from, to, { class: 'tz-ai-range' }, { slot: 'selection', range: true }),
        this.widget(anchor, card, 'selection'),
      ]).setMeta('addToHistory', false),
    )
    await this.generate(card)
  }

  // ---------- 在光标处生成(/ai、空行按空格) ----------

  /** 命令 ai.write 与空行按空格:在光标所在块下方弹出 AI 输入框 */
  openWriter(view: EditorView): boolean {
    if (!this.ai.configured) {
      void this.ai.ensureConfigured().then((ok) => {
        if (ok) this.showWriter(view)
      })
      return true
    }
    this.showWriter(view)
    return true
  }

  private showWriter(target: EditorView): void {
    this.ai.deps.ensureRichMode()
    const view = this.ai.deps.view()
    if (view !== target && !target.isDestroyed) return
    this.discard()
    const { $from } = view.state.selection
    const pos = $from.depth > 0 ? $from.after($from.depth) : $from.pos
    const card = this.newCard('write', view)
    card.status = 'input'
    this.card = card
    view.dispatch(setAiDecorations(view.state.tr, 'inline', [this.widget(pos, card, 'inline')]).setMeta('addToHistory', false))
    this.renderCard(card)
    requestAnimationFrame(() => card.input?.focus())
  }

  // ---------- 卡片 ----------

  private newCard(mode: Card['mode'], view: EditorView): Card {
    const result = h('div', { class: 'tz-ai-card-result tz-ai-markdown' })
    const el = h('div', { class: 'tz-ai-card', contenteditable: 'false', 'data-mode': mode })
    const card: Card = { mode, view, el, result, status: 'streaming', text: '', requestId: null, generation: 0, throttle: new Throttle(50, () => this.renderResult(card, false)) }
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        this.discard()
        view.focus()
      }
    })
    return card
  }

  private widget(pos: number, card: Card, slot: 'selection' | 'inline'): Decoration {
    return Decoration.widget(pos, card.el, { slot, side: 1, key: `tz-ai-card-${slot}`, stopEvent: () => true, ignoreSelection: true })
  }

  private async generate(card: Card): Promise<void> {
    const generation = ++card.generation
    card.text = ''
    card.error = undefined
    card.status = 'streaming'
    this.renderCard(card)
    const deps = this.ai.deps
    const docText = deps.documentText()
    let params: Record<string, unknown>
    if (card.mode === 'selection' && card.action) {
      const action = card.action
      params = {
        prompt: fillPrompt(action.prompt, { selection: card.selectionMarkdown, document: docText, language: card.language }),
        actionId: action.builtin ? undefined : action.id,
        selection: card.selectionMarkdown,
        document: docText,
        model: action.model,
      }
    } else {
      // 带上全文并标明光标位置(PRD 3.5):cursor 为卡片所在位置在原文里的偏移
      const at = this.anchorPos(card)
      params = { prompt: card.instruction ?? '', document: docText, cursor: at === null ? undefined : deps.sourceOffset(at) }
    }
    const live = () => this.card === card && card.generation === generation
    card.requestId = await this.ai.startCompletion(params, {
      delta: (text) => {
        if (!live()) return
        card.text += text
        card.throttle.schedule()
      },
      done: (status, error) => {
        if (!live()) return
        this.finish(card, status, error)
      },
    })
  }

  private finish(card: Card, status: AiDoneStatus, error?: AiErrorInfo): void {
    card.requestId = null
    card.status = status
    card.error = error
    card.throttle.cancel()
    this.renderCard(card)
  }

  private renderResult(card: Card, final: boolean): void {
    if (!card.text) {
      card.result.replaceChildren()
      return
    }
    renderMarkdown(card.text, card.result, this.ai.deps.parseOptions(), final)
  }

  /** 选区原文是否已被改动(范围被删掉也算) */
  private originalChanged(card: Card): boolean {
    const range = this.range(card)
    if (!range) return true
    return card.view.state.doc.textBetween(range.from, range.to, '\n\n', ' ') !== card.original
  }

  private range(card: Card): { from: number; to: number } | null {
    const deco = aiDecorations(card.view, 'selection').find((d) => (d.spec as { range?: boolean }).range)
    return deco ? { from: deco.from, to: deco.to } : null
  }

  /** 卡片当前所在位置(已随文档改动映射) */
  private anchorPos(card: Card): number | null {
    const slot = card.mode === 'selection' ? 'selection' : 'inline'
    const deco = aiDecorations(card.view, slot).find((d) => !(d.spec as { range?: boolean }).range)
    return deco ? deco.from : null
  }

  private renderCard(card: Card): void {
    const button = (name: string, label: string, run: () => void, primary = false, disabled = false) => {
      const b = h('button', { type: 'button', name, class: `tz-ai-btn${primary ? ' is-primary' : ''}`, disabled }, label)
      b.addEventListener('click', (e) => {
        e.preventDefault()
        run()
      })
      return b
    }
    const title = card.mode === 'selection' ? `AI · ${card.action?.name ?? ''}${card.language ? `(${card.language})` : ''}` : 'AI 写作'
    const head = h('div', { class: 'tz-ai-card-head' }, h('span', { class: 'tz-ai-card-title' }, `✦ ${title}`), h('span', { class: 'tz-ai-card-state' }, ACTION_VERBS[card.status]))
    const parts: (HTMLElement | null)[] = [head]
    const readOnly = this.ai.deps.readOnly()
    if (card.mode === 'write') {
      if (card.status === 'input') {
        const input = h('textarea', { class: 'tz-ai-card-input', rows: 1, placeholder: '告诉 AI 要写什么,回车生成(Esc 取消)', spellcheck: 'false' })
        input.value = card.instruction ?? ''
        input.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            const text = input.value.trim()
            if (!text) return
            card.instruction = text
            void this.generate(card)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            this.discard()
            card.view.focus()
          }
        })
        card.input = input
        parts.push(input)
      } else {
        parts.push(h('div', { class: 'tz-ai-card-prompt' }, card.instruction ?? ''))
      }
    }
    if (card.status !== 'input') parts.push(card.result)
    if (card.status === 'error' && card.error) parts.push(h('div', { class: 'tz-ai-card-error', role: 'alert' }, describeError(card.error)))
    const actions = h('div', { class: 'tz-ai-card-actions' })
    if (card.status === 'streaming') {
      actions.append(
        button('stop', '停止', () => this.stop(card)),
        button('discard', '放弃', () => this.discardAndFocus()),
      )
    } else if (card.status === 'input') {
      actions.append(button('discard', '取消', () => this.discardAndFocus()))
    } else {
      const hasText = card.text.trim() !== ''
      if (card.mode === 'selection') {
        if (this.originalChanged(card)) parts.push(h('div', { class: 'tz-ai-card-hint', 'data-role': 'changed' }, '原文已改动,请重新生成或插入下方'))
        else actions.append(button('replace', '替换', () => this.replace(card), true, !hasText || readOnly))
        actions.append(button('insertBelow', '插入下方', () => this.insertBelow(card), false, !hasText || readOnly))
      } else {
        actions.append(button('accept', '接受', () => this.accept(card), true, !hasText || readOnly))
      }
      actions.append(
        button('retry', '重试', () => void this.generate(card)),
        button('discard', '放弃', () => this.discardAndFocus()),
      )
    }
    parts.push(actions)
    card.el.dataset.status = card.status
    card.el.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null))
    if (card.status !== 'input') this.renderResult(card, card.status !== 'streaming')
  }

  private stop(card: Card): void {
    if (card.requestId) this.ai.stopCompletion(card.requestId)
    this.finish(card, 'stopped')
  }

  // ---------- 写回正文 ----------

  private replace(card: Card): void {
    const range = this.range(card)
    if (!range || this.originalChanged(card)) {
      this.renderCard(card)
      return
    }
    const view = card.view
    const tr = closeHistory(view.state.tr)
    tr.replaceRange(range.from, range.to, markdownSlice(card.text, this.ai.deps.parseOptions()))
    this.commit(card, tr)
  }

  private insertBelow(card: Card): void {
    const view = card.view
    const at = this.anchorPos(card) ?? view.state.selection.to
    const blocks = markdownBlocks(card.text, this.ai.deps.parseOptions())
    const tr = closeHistory(view.state.tr)
    try {
      tr.insert(at, blocks)
    } catch {
      // 卡片位置放不下块(如表格单元格里):退到顶层块之后
      const $at = view.state.doc.resolve(at)
      tr.insert($at.depth > 0 ? $at.after(1) : at, blocks)
    }
    this.commit(card, tr)
  }

  /** 接受生成:光标所在的空段落直接换成结果,否则插在卡片位置 */
  private accept(card: Card): void {
    const view = card.view
    const at = this.anchorPos(card)
    if (at === null) {
      this.discard()
      return
    }
    const blocks = markdownBlocks(card.text, this.ai.deps.parseOptions())
    const before = view.state.doc.resolve(at).nodeBefore
    const tr = closeHistory(view.state.tr)
    const replaceEmpty = before?.type === schema.nodes.paragraph && before.content.size === 0
    const start = replaceEmpty && before ? at - before.nodeSize : at
    tr.replaceWith(start, at, blocks)
    const end = tr.mapping.map(at)
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(end, tr.doc.content.size)), -1))
    this.commit(card, tr)
  }

  private commit(card: Card, tr: Transaction): void {
    const slot = card.mode === 'selection' ? 'selection' : 'inline'
    tr.setMeta(AI_EDIT, true)
    setAiDecorations(tr, slot, [])
    card.view.dispatch(tr.scrollIntoView())
    this.card = null
    card.throttle.cancel()
    card.view.focus()
  }

  // ---------- 收起 ----------

  /** 放弃当前卡片:停止生成、去掉装饰 */
  discard(): void {
    const card = this.card
    if (!card) return
    this.card = null
    card.throttle.cancel()
    if (card.requestId) this.ai.stopCompletion(card.requestId)
    const slot = card.mode === 'selection' ? 'selection' : 'inline'
    if (!card.view.isDestroyed) card.view.dispatch(setAiDecorations(card.view.state.tr, slot, []).setMeta('addToHistory', false))
  }

  private discardAndFocus(): void {
    const view = this.card?.view
    this.discard()
    view?.focus()
  }

  /** 编辑器里的按键:AI 动作菜单打开时接管方向键与回车;Esc 收起菜单或放弃卡片 */
  handleKey(event: KeyboardEvent): boolean {
    if (this.menu.isOpen) return this.menu.handleKey(event)
    if (event.key !== 'Escape' || !this.card) return false
    this.discard()
    return true
  }

  /** 用户改了正文:选中文字动作要重新判断原文是否被改动;卡片被删掉时收起 */
  onUserEdit(view: EditorView): void {
    const card = this.card
    if (!card || card.view !== view) return
    if (this.anchorPos(card) === null) {
      this.discard()
      return
    }
    if (card.mode === 'selection' && card.status !== 'streaming' && card.status !== 'input') this.renderCard(card)
  }

  onViewDestroyed(view: EditorView): void {
    const card = this.card
    if (!card || card.view !== view) return
    this.card = null
    card.throttle.cancel()
    if (card.requestId) this.ai.stopCompletion(card.requestId)
  }
}

