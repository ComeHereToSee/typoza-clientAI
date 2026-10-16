// AI 侧栏(PRD 3.2 对话、3.3 分支、3.7 工具卡片):编辑区右侧,可拖宽、可关闭,⌘J 打开。
// 顶栏:对话列表(切换、新建)、分支下拉、更多(改名、删除、导出 / 插入当前分支);中间是当前分支的消息,回答流式渲染 Markdown;
// 底部输入框:上下文标签(当前文档 / 选区,可移除)、@ 引用(文件夹文档、之前的对话、MCP 资源)、/ 指令(AI 动作、MCP 提示词)。
import { closeHistory } from 'prosemirror-history'
import type { EditorView } from 'prosemirror-view'
import type { ChatSendResult, ContextItem, Conversation, ConversationSummary, McpStatus, Message, ToolCallPart } from '../host/ai-types'
import { h } from '../ui/dom'
import { FloatingMenu, type MenuItem } from '../ui/menu'
import { promptInput } from '../ui/prompt'
import { branches, latestLeaf, messageText, pathMarkdown, pathTo, versionsOf } from './branch'
import { type AiController, describeError, errorText } from './controller'
import { NOT_CONFIGURED_TEXT } from './models'
import { actionsFor, fillPrompt } from './prompt'
import { markdownBlocks, markdownSlice, renderMarkdown, Throttle } from './render'

/** 随消息带上的文档最长字数;超过时截断并提示(PRD 3.2「上下文」)【假设:不知道各模型的上下文长度,先取 10 万字】 */
export const MAX_DOCUMENT_CHARS = 100_000

const MIN_WIDTH = 280
const MAX_WIDTH = 720

/** @ 引用加进来的上下文 */
interface ExtraContext {
  kind: 'file' | 'conversation' | 'resource'
  title: string
  path?: string
  ref?: string
  serverId?: string
}

const TOOL_STATUS: Record<ToolCallPart['status'], string> = { pending: '等待确认', running: '执行中', done: '完成', error: '出错', denied: '已拒绝' }

function timeLabel(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(ms)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 工具全名 → 显示名与来源(没收到 tool.request 时按命名规则推断) */
function toolLabel(name: string): { title: string; source: string } {
  if (name === 'typoza__edit_document') return { title: '修改当前文档', source: '内置' }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { title: mcp[2], source: mcp[1] }
  if (name.startsWith('typoza__')) return { title: name.slice('typoza__'.length), source: '内置' }
  return { title: name, source: '' }
}

export class AiPanel {
  readonly el: HTMLElement
  private readonly head: HTMLElement
  private readonly list: HTMLElement
  private readonly chips: HTMLElement
  private readonly input: HTMLTextAreaElement
  private readonly assistant: HTMLSelectElement
  private readonly sendBtn: HTMLButtonElement
  private readonly stopBtn: HTMLButtonElement
  private readonly menu = new FloatingMenu({ className: 'tz-ai-menu' })
  private readonly suggest = new FloatingMenu({ className: 'tz-ai-menu tz-ai-suggest', emptyText: '无结果' })
  private suggestMode: '@' | '/' | null = null
  private open = false
  private sending = false
  /** 用户移除了默认的「当前文档 / 选区」标签(发送后恢复) */
  private removedDefault = false
  private extra: ExtraContext[] = []
  /** 正在「编辑后重发」的提问 */
  private editing: string | null = null
  private lastSelectionEmpty: boolean | null = null
  private readonly throttles = new Map<string, Throttle>()

  constructor(private readonly ai: AiController) {
    this.head = h('div', { class: 'tz-ai-head' })
    this.list = h('div', { class: 'tz-ai-messages' })
    this.list.addEventListener('click', (e) => {
      // 回答里的链接交给系统浏览器,不在应用里跳转
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!a) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (/^https?:\/\//i.test(href)) void this.ai.deps.host.openExternal(href)
    })
    this.chips = h('div', { class: 'tz-ai-chips' })
    this.input = h('textarea', { class: 'tz-ai-input', name: 'prompt', rows: 3, placeholder: '问 AI…(@ 引用文档,/ 指令;回车发送,⇧回车换行)', spellcheck: 'false' })
    this.input.addEventListener('keydown', (e) => this.onInputKey(e))
    this.input.addEventListener('input', () => this.updateSuggest())
    this.input.addEventListener('blur', () => setTimeout(() => this.closeSuggestIfBlurred(), 150))
    this.assistant = h('select', { class: 'tz-ai-assistant', name: 'assistant', title: '助手(新对话用所选助手)' })
    this.sendBtn = h('button', { type: 'button', class: 'tz-ai-btn is-primary', name: 'send' }, '发送')
    this.sendBtn.addEventListener('click', () => void this.send())
    this.stopBtn = h('button', { type: 'button', class: 'tz-ai-btn', name: 'stop', hidden: true }, '停止')
    this.stopBtn.addEventListener('click', () => void this.stop())
    const composer = h('div', { class: 'tz-ai-composer' }, this.chips, this.input, h('div', { class: 'tz-ai-composer-foot' }, this.assistant, h('span', { class: 'tz-ai-spacer' }), this.stopBtn, this.sendBtn))
    const resizer = h('div', { class: 'tz-ai-resizer', title: '拖动调整宽度' })
    this.bindResizer(resizer)
    this.el = h('aside', { class: 'tz-ai-panel', hidden: true, 'aria-label': 'AI 对话' }, resizer, h('div', { class: 'tz-ai-inner' }, this.head, this.list, composer))
  }

  get isOpen(): boolean {
    return this.open
  }

  // ---------- 打开 / 关闭 / 宽度 ----------

  /** ⌘J:没打开就打开并聚焦输入框;焦点已在侧栏里就关掉;否则把焦点移到输入框 */
  toggleFromShortcut(): void {
    if (!this.open) this.show()
    else if (this.el.contains(document.activeElement)) this.hide()
    else this.input.focus()
  }

  show(): void {
    this.open = true
    this.el.hidden = false
    this.render()
    void this.ai.refreshSettings()
    void this.loadSummaries()
    requestAnimationFrame(() => this.input.focus())
  }

  hide(): void {
    this.open = false
    this.el.hidden = true
    this.menu.close('api')
    this.suggest.close('api')
    this.ai.deps.view().focus()
  }

  async restoreWidth(): Promise<void> {
    const saved = (await this.ai.deps.host.getSettings()).aiPanelWidth
    if (typeof saved === 'number') this.setWidth(saved)
  }

  private setWidth(width: number): number {
    const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
    this.el.style.width = `${w}px`
    return w
  }

  private bindResizer(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const start = this.el.getBoundingClientRect().width
      const move = (ev: PointerEvent) => this.setWidth(start - (ev.clientX - startX))
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        const width = this.setWidth(start - (ev.clientX - startX))
        this.ai.deps.host.setSettings({ aiPanelWidth: width }).catch((err: unknown) => this.ai.deps.toast(`保存侧栏宽度失败:${errorText(err)}`, true))
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    })
  }

  // ---------- 外部通知 ----------

  onSettingsChanged(): void {
    if (this.open) this.render()
  }

  /** 选区有无变化时,默认上下文标签在「当前文档」与「选区」之间切换 */
  onEditorUpdate(view: EditorView): void {
    if (!this.open) return
    const empty = view.state.selection.empty
    if (empty === this.lastSelectionEmpty) return
    this.lastSelectionEmpty = empty
    this.renderChips()
  }

  /** 对话状态变了:messageId 为空串表示对话列表 / 标题变化 */
  onStoreChange(messageId: string): void {
    if (!this.open) return
    if (!messageId) {
      this.renderHead()
      return
    }
    const conv = this.ai.store.conv
    const msg = conv?.messages[messageId]
    // 不在当前分支上的消息(切走了的分支还在输出)不重画
    if (!conv || !msg || !pathTo(conv, conv.leafId).some((m) => m.id === messageId)) {
      this.renderComposerState()
      return
    }
    const el = this.messageEl(messageId)
    if (!el) {
      this.renderMessages()
      this.renderComposerState()
      return
    }
    // 输出中的文字按 50 毫秒节流重画;结构变化(工具卡片、结束)立即重画
    let throttle = this.throttles.get(messageId)
    if (!throttle) {
      throttle = new Throttle(50, () => this.replaceMessage(messageId))
      this.throttles.set(messageId, throttle)
    }
    if (msg.status === 'streaming') throttle.schedule()
    else throttle.flush()
    this.renderComposerState()
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.renderHead()
    this.renderMessages()
    this.renderChips()
    this.renderComposerState()
  }

  private button(name: string, label: string, title: string, run: (btn: HTMLButtonElement) => void, cls = ''): HTMLButtonElement {
    const b = h('button', { type: 'button', name, class: `tz-ai-icon-btn ${cls}`, title }, label)
    b.addEventListener('click', (e) => {
      e.preventDefault()
      run(b)
    })
    return b
  }

  private renderHead(): void {
    const conv = this.ai.store.conv
    const title = this.button('conversations', `${conv?.title || '新对话'} ▾`, '切换对话', (b) => void this.openConversationMenu(b), 'tz-ai-title')
    const list = conv ? branches(conv) : []
    const branchBtn = list.length > 1 ? this.button('branches', `⑂ ${list.length}`, '切换分支', (b) => this.openBranchMenu(b)) : null
    this.head.replaceChildren(
      title,
      h('span', { class: 'tz-ai-spacer' }),
      branchBtn ?? '',
      this.button('newChat', '＋', '新对话', () => this.newChat()),
      this.button('more', '⋯', '更多', (b) => this.openMoreMenu(b)),
      this.button('close', '×', '关闭(⌘J)', () => this.hide()),
    )
  }

  private renderMessages(): void {
    const ai = this.ai
    for (const t of this.throttles.values()) t.cancel()
    this.throttles.clear()
    if (ai.settingsError && !ai.settings) {
      this.list.replaceChildren(h('div', { class: 'tz-ai-notice', role: 'alert' }, `AI 组件不可用:${ai.settingsError}`))
      return
    }
    if (ai.settings && !ai.configured) {
      const go = h('button', { type: 'button', class: 'tz-ai-btn is-primary', name: 'goSettings' }, '去设置')
      go.addEventListener('click', () => ai.openSettings())
      this.list.replaceChildren(h('div', { class: 'tz-ai-notice', 'data-role': 'not-configured' }, h('p', null, NOT_CONFIGURED_TEXT), go))
      return
    }
    const conv = ai.store.conv
    if (!conv) {
      this.list.replaceChildren(h('div', { class: 'tz-ai-empty' }, '问点什么吧。默认带上当前文档;选中文字时只带选区。'))
      return
    }
    const near = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80
    this.list.replaceChildren(...pathTo(conv, conv.leafId).map((m) => this.renderMessage(conv, m)))
    if (near || this.sending) this.list.scrollTop = this.list.scrollHeight
  }

  private messageEl(id: string): HTMLElement | null {
    return this.list.querySelector<HTMLElement>(`.tz-ai-msg[data-id="${CSS.escape(id)}"]`)
  }

  private replaceMessage(id: string): void {
    const conv = this.ai.store.conv
    const msg = conv?.messages[id]
    const el = this.messageEl(id)
    if (!conv || !msg || !el) return
    const near = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80
    el.replaceWith(this.renderMessage(conv, msg))
    if (near) this.list.scrollTop = this.list.scrollHeight
  }

  private renderMessage(conv: Conversation, msg: Message): HTMLElement {
    const el = h('div', { class: `tz-ai-msg is-${msg.role}`, 'data-id': msg.id, 'data-status': msg.status })
    const busy = msg.status === 'streaming' || msg.status === 'waiting'
    if (msg.role === 'user') {
      if (this.editing === msg.id) {
        el.append(this.editBox(msg))
        return el
      }
      el.append(h('div', { class: 'tz-ai-msg-text' }, messageText(msg)))
      if (msg.context?.length) {
        el.append(h('div', { class: 'tz-ai-msg-context' }, ...msg.context.map((c) => h('span', { class: 'tz-ai-chip is-static' }, `${c.kind === 'selection' ? '✂' : c.kind === 'conversation' ? '💬' : '📄'} ${c.title}`))))
      }
    } else {
      const body = h('div', { class: 'tz-ai-msg-body' })
      for (const part of msg.parts) {
        if (part.type === 'text') {
          const md = h('div', { class: 'tz-ai-markdown' })
          renderMarkdown(part.text, md, this.ai.deps.parseOptions(), !busy)
          body.append(md)
        } else if (part.type === 'tool_call') {
          body.append(this.toolCard(conv, msg, part))
        } else {
          body.append(h('div', { class: 'tz-ai-skill' }, `用到技能:${part.name}`))
        }
      }
      if (msg.status === 'streaming' && !msg.parts.length) body.append(h('div', { class: 'tz-ai-typing' }, '正在思考…'))
      el.append(body)
      if (msg.status === 'error' && msg.error) {
        const retry = h('button', { type: 'button', class: 'tz-ai-btn', name: 'retry' }, '重试')
        retry.addEventListener('click', () => void this.regenerate(msg))
        el.append(h('div', { class: 'tz-ai-error', role: 'alert' }, h('span', null, describeError(msg.error)), retry))
      } else if (msg.status === 'stopped') {
        el.append(h('div', { class: 'tz-ai-stopped' }, '已停止'))
      }
    }
    if (!busy) el.append(this.messageActions(conv, msg))
    return el
  }

  private messageActions(conv: Conversation, msg: Message): HTMLElement {
    const bar = h('div', { class: 'tz-ai-msg-actions' })
    const versions = versionsOf(conv, msg)
    if (versions.length > 1) {
      const i = versions.findIndex((v) => v.id === msg.id)
      const go = (k: number) => void this.setLeaf(latestLeaf(conv, versions[k].id))
      const prev = this.button('prevVersion', '‹', '上一个版本', () => go(i - 1))
      const next = this.button('nextVersion', '›', '下一个版本', () => go(i + 1))
      prev.disabled = i <= 0
      next.disabled = i >= versions.length - 1
      bar.append(h('span', { class: 'tz-ai-versions' }, prev, h('span', { class: 'tz-ai-version' }, `${i + 1}/${versions.length}`), next))
    }
    const md = messageText(msg)
    if (msg.role === 'assistant') {
      const readOnly = this.ai.deps.readOnly()
      const insert = (name: string, label: string, title: string, where: 'cursor' | 'replace' | 'end') => {
        const b = this.button(name, label, title, () => this.insertIntoDocument(md, where))
        b.disabled = readOnly || !md.trim()
        return b
      }
      bar.append(
        this.button('copy', '复制', '复制(Markdown)', () => void this.copy(md)),
        insert('insertCursor', '插入', '插入到光标处', 'cursor'),
        insert('replaceSelection', '替换选区', '替换正文里的选区', 'replace'),
        insert('insertEnd', '插入文末', '插入到文末', 'end'),
        this.button('regenerate', '↻', '重新生成', () => void this.regenerate(msg)),
      )
    } else {
      bar.append(this.button('editResend', '编辑', '编辑后重发', () => this.startEdit(msg.id)))
    }
    bar.append(this.button('msgMenu', '⋯', '更多', (b) => this.openMessageMenu(b, conv, msg)))
    return bar
  }

  private toolCard(conv: Conversation, msg: Message, part: ToolCallPart): HTMLElement {
    const info = this.ai.store.tools.get(part.tool)
    const label = info ? { title: info.title || info.name, source: info.source } : toolLabel(part.tool)
    const card = h('div', { class: 'tz-ai-tool', 'data-call-id': part.callId, 'data-status': part.status, 'data-tool': part.tool })
    card.append(
      h(
        'div',
        { class: 'tz-ai-tool-head' },
        h('span', { class: 'tz-ai-tool-name' }, `🔧 ${label.title}`),
        label.source ? h('span', { class: 'tz-ai-tool-source' }, label.source) : '',
        h('span', { class: 'tz-ai-tool-status' }, TOOL_STATUS[part.status] ?? part.status),
      ),
    )
    // 参数与长结果默认折叠(PRD 3.7「参数里的长文本折叠显示」)
    const args = h('details', { class: 'tz-ai-tool-args' }, h('summary', null, '参数'), h('pre', null, JSON.stringify(part.input ?? {}, null, 2)))
    card.append(args)
    if (part.result) {
      const result = h('details', { class: 'tz-ai-tool-result' }, h('summary', null, '结果'), h('pre', null, part.result))
      result.open = part.result.length <= 600
      card.append(result)
    }
    if (part.error) card.append(h('div', { class: 'tz-ai-tool-error' }, part.error))
    const request = this.ai.store.requests.get(part.callId)
    if (request && part.status === 'pending') {
      const decide = (decision: 'allow' | 'always' | 'deny') => async () => {
        if (await this.ai.decideTool(request.conversationId, part.callId, decision)) {
          this.ai.store.requests.delete(part.callId)
          this.replaceMessage(msg.id)
        }
      }
      card.append(
        h(
          'div',
          { class: 'tz-ai-tool-actions' },
          this.textButton('allowTool', '允许', decide('allow'), true),
          this.textButton('alwaysTool', '总是允许此工具', decide('always')),
          this.textButton('denyTool', '拒绝', decide('deny')),
        ),
      )
    }
    const edit = this.ai.edits.items.get(part.callId)
    if (edit) {
      const row = h('div', { class: 'tz-ai-tool-actions', 'data-edit-state': edit.state })
      if (edit.state === 'preview') {
        row.append(h('span', { class: 'tz-ai-tool-note' }, '正文里已显示修改预览'), this.textButton('applyEdit', '应用', () => this.ai.edits.apply(part.callId), true), this.textButton('rejectEdit', '拒绝', () => this.ai.edits.reject(part.callId)))
      } else if (edit.state === 'stale') {
        row.append(h('span', { class: 'tz-ai-tool-note', 'data-role': 'stale' }, edit.note ?? '预览已失效'))
        if (edit.path === this.ai.deps.documentPath()) row.append(this.textButton('repreview', '重新预览', () => this.ai.edits.repreview(part.callId), true))
        row.append(this.textButton('rejectEdit', '拒绝', () => this.ai.edits.reject(part.callId)))
      } else if (edit.state === 'queued') {
        row.append(h('span', { class: 'tz-ai-tool-note' }, '等前一处修改处理完再预览'), this.textButton('rejectEdit', '拒绝', () => this.ai.edits.reject(part.callId)))
      } else {
        const text = { applied: '已应用到正文', rejected: '已拒绝', failed: `没能应用:${edit.note ?? ''}` }[edit.state]
        row.append(h('span', { class: 'tz-ai-tool-note' }, text))
      }
      card.append(row)
    }
    return card
  }

  private textButton(name: string, label: string, run: () => unknown, primary = false): HTMLButtonElement {
    const b = h('button', { type: 'button', name, class: `tz-ai-btn${primary ? ' is-primary' : ''}` }, label)
    b.addEventListener('click', (e) => {
      e.preventDefault()
      b.disabled = true
      Promise.resolve(run()).finally(() => {
        b.disabled = false
      })
    })
    return b
  }

  private editBox(msg: Message): HTMLElement {
    const area = h('textarea', { class: 'tz-ai-input', name: 'editText', rows: 3 })
    area.value = messageText(msg)
    const resend = () => {
      const text = area.value.trim()
      if (!text) return
      // 编辑后重发 = 在原提问的父节点下再发一条,形成新分支;原提问是第一条时先把末端清空,新提问成为新的根
      void this.send(text, msg.parentId ? { parentId: msg.parentId } : { resetLeaf: true })
    }
    area.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        resend()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.editing = null
        this.renderMessages()
      }
    })
    const cancel = this.textButton('cancelEdit', '取消', () => {
      this.editing = null
      this.renderMessages()
    })
    requestAnimationFrame(() => area.focus())
    return h('div', { class: 'tz-ai-edit' }, area, h('div', { class: 'tz-ai-msg-actions' }, this.textButton('resend', '发送', resend, true), cancel))
  }

  private startEdit(id: string): void {
    this.editing = id
    this.renderMessages()
  }

  // ---------- 上下文标签 ----------

  private renderChips(): void {
    const deps = this.ai.deps
    const chips: HTMLElement[] = []
    const remove = (run: () => void) => {
      const b = h('button', { type: 'button', class: 'tz-ai-chip-x', name: 'removeChip', title: '移除' }, '×')
      b.addEventListener('click', () => {
        run()
        this.renderChips()
      })
      return b
    }
    if (!this.removedDefault) {
      const selection = !deps.view().state.selection.empty
      chips.push(
        h(
          'span',
          { class: 'tz-ai-chip', 'data-kind': selection ? 'selection' : 'document' },
          selection ? '✂ 选区' : `📄 ${deps.documentTitle()}`,
          remove(() => {
            this.removedDefault = true
          }),
        ),
      )
    }
    for (const x of this.extra) {
      chips.push(
        h(
          'span',
          { class: 'tz-ai-chip', 'data-kind': x.kind },
          `${x.kind === 'conversation' ? '💬' : x.kind === 'resource' ? '🔗' : '📄'} ${x.title}`,
          remove(() => {
            this.extra = this.extra.filter((e) => e !== x)
          }),
        ),
      )
    }
    this.chips.replaceChildren(...chips)
    this.chips.hidden = chips.length === 0
  }

  private renderComposerState(): void {
    const ai = this.ai
    const usable = ai.configured
    const conv = ai.store.conv
    const settings = ai.settings
    const assistants = settings?.assistants ?? []
    const chosen = conv?.assistantId ?? (this.assistant.value || settings?.defaultAssistantId || '')
    this.assistant.replaceChildren(...assistants.map((a) => h('option', { value: a.id }, `${a.icon ?? ''} ${a.name}`.trim())))
    this.assistant.value = chosen
    // 已有对话沿用它的助手;换助手从新对话开始(PRD 3.9)
    this.assistant.disabled = Boolean(conv) || !assistants.length
    const path = conv ? pathTo(conv, conv.leafId) : []
    const last = path[path.length - 1]
    const running = Boolean(last && last.role === 'assistant' && (last.status === 'streaming' || last.status === 'waiting'))
    this.stopBtn.hidden = !running
    this.sendBtn.hidden = running
    this.sendBtn.disabled = this.sending || !usable
    this.input.disabled = !usable
  }

  // ---------- 输入框:@ 引用与 / 指令 ----------

  private onInputKey(e: KeyboardEvent): void {
    if (this.suggest.isOpen && this.suggest.handleKey(e)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void this.send()
    } else if (e.key === 'Escape' && this.suggest.isOpen) {
      e.preventDefault()
      this.suggest.close('escape')
    }
  }

  private closeSuggestIfBlurred(): void {
    if (document.activeElement !== this.input) this.suggest.close('api')
  }

  /** 光标前是 @词 或整段是 /词 时弹出建议;查询词随输入过滤 */
  private updateSuggest(): void {
    const before = this.input.value.slice(0, this.input.selectionStart ?? this.input.value.length)
    const at = /(?:^|\s)@([^\s@]*)$/.exec(before)
    const slash = /^\/(\S*)$/.exec(before)
    const mode = at ? '@' : slash ? '/' : null
    const query = at?.[1] ?? slash?.[1] ?? ''
    if (!mode) {
      this.suggestMode = null
      this.suggest.close('api')
      return
    }
    const r = this.input.getBoundingClientRect()
    const anchor = { left: r.left, top: r.top, bottom: r.top }
    if (this.suggestMode !== mode || !this.suggest.isOpen) {
      this.suggestMode = mode
      this.suggest.open([], anchor, '', undefined, false)
      void (mode === '@' ? this.mentionItems() : this.commandItems()).then((items) => {
        if (this.suggestMode !== mode) return
        this.suggest.open(items, anchor, '', undefined, false)
        this.suggest.setQuery(this.currentQuery())
      })
    }
    this.suggest.setQuery(query)
  }

  private currentQuery(): string {
    const before = this.input.value.slice(0, this.input.selectionStart ?? this.input.value.length)
    return (/(?:^|\s)@([^\s@]*)$/.exec(before) ?? /^\/(\S*)$/.exec(before))?.[1] ?? ''
  }

  /** 去掉光标前的 @查询词 */
  private dropMentionQuery(): void {
    const caret = this.input.selectionStart ?? this.input.value.length
    const before = this.input.value.slice(0, caret).replace(/@[^\s@]*$/, '')
    this.input.value = before + this.input.value.slice(caret)
    this.input.setSelectionRange(before.length, before.length)
    this.suggestMode = null
    this.input.focus()
  }

  private addExtra(x: ExtraContext): void {
    this.dropMentionQuery()
    if (!this.extra.some((e) => e.kind === x.kind && e.path === x.path && e.ref === x.ref)) this.extra.push(x)
    this.renderChips()
  }

  /** @ 的候选:文件夹里的文档、之前的对话、MCP 资源(PRD 3.2) */
  private async mentionItems(): Promise<MenuItem[]> {
    const ai = this.ai
    const items: MenuItem[] = []
    const warn = (what: string) => (err: unknown) => ai.deps.toast(`读取${what}失败:${errorText(err)}`, true)
    const [docs, convs, mcp] = await Promise.all([
      ai.deps.listDocuments().catch((err: unknown) => (warn('文档列表')(err), [])),
      ai.call<{ items: ConversationSummary[] }>('ai.conversations.list').catch((err: unknown) => (warn('对话列表')(err), { items: [] })),
      ai.call<{ servers: McpStatus[] }>('ai.mcp.status').catch((err: unknown) => (warn('MCP 状态')(err), { servers: [] })),
    ])
    for (const d of docs) {
      items.push({ id: `doc:${d.path}`, label: d.title, hint: d.dir, icon: '📄', group: '文档', keywords: [d.path], run: () => this.addExtra({ kind: 'file', title: d.title, path: d.path }) })
    }
    for (const c of convs.items) {
      if (c.id === ai.store.conv?.id) continue
      items.push({ id: `conv:${c.id}`, label: c.title || '未命名对话', hint: timeLabel(c.updatedAt), icon: '💬', group: '对话', run: () => this.addExtra({ kind: 'conversation', title: c.title || '对话', ref: c.id }) })
    }
    const names = new Map((ai.settings?.mcpServers ?? []).map((s): [string, string] => [s.id, s.name]))
    for (const s of mcp.servers) {
      for (const r of s.resources) {
        items.push({ id: `res:${s.serverId}:${r.uri}`, label: r.name, hint: names.get(s.serverId) ?? s.serverId, icon: '🔗', group: 'MCP 资源', keywords: [r.uri], run: () => this.addExtra({ kind: 'resource', title: r.name, ref: r.uri, serverId: s.serverId }) })
      }
    }
    return items
  }

  /** / 的候选:AI 动作、MCP 提示词(PRD 3.2、3.6) */
  private async commandItems(): Promise<MenuItem[]> {
    const ai = this.ai
    const target = this.ai.deps.view().state.selection.empty ? '当前文档' : '所选内容'
    const fill = (text: string) => {
      this.input.value = text
      this.input.setSelectionRange(text.length, text.length)
      this.suggestMode = null
      this.input.focus()
    }
    const items: MenuItem[] = actionsFor(ai.settings?.actions ?? [], false).map((a) => ({
      id: `cmd:${a.id}`,
      label: a.name,
      icon: '✦',
      group: 'AI 动作',
      // 内容由上下文标签带上,输入框里只放指令
      run: () => fill(a.builtin ? `${a.name}${target}${a.needsLanguage ? '为英文' : ''}` : fillPrompt(a.prompt, { selection: `「${target}」`, document: '「当前文档」', language: '中文' })),
    }))
    const mcp = await ai.call<{ servers: McpStatus[] }>('ai.mcp.status').catch((err: unknown) => {
      ai.deps.toast(`读取 MCP 状态失败:${errorText(err)}`, true)
      return { servers: [] as McpStatus[] }
    })
    const names = new Map((ai.settings?.mcpServers ?? []).map((s): [string, string] => [s.id, s.name]))
    for (const s of mcp.servers) {
      for (const p of s.prompts) {
        items.push({
          id: `prompt:${s.serverId}:${p.name}`,
          label: p.name,
          hint: p.description ?? names.get(s.serverId) ?? s.serverId,
          icon: '⌁',
          group: 'MCP 提示词',
          run: () =>
            void (async () => {
              // 提示词带参数时逐个询问;取消任何一个就不取
              const args: Record<string, string> = {}
              for (const a of p.arguments ?? []) {
                const v = await promptInput({
                  title: `${p.name}:${a.description || a.name}`,
                  placeholder: a.name,
                  validate: (x) => (a.required && !x ? `${a.name} 必填` : null),
                })
                if (v === null) return
                if (v) args[a.name] = v
              }
              const r = await ai.call<{ text: string }>('ai.mcp.prompt', { serverId: s.serverId, name: p.name, args })
              fill(r.text)
            })().catch((err: unknown) => ai.deps.toast(`读取提示词失败:${errorText(err)}`, true)),
        })
      }
    }
    return items
  }

  // ---------- 发送与对话操作 ----------

  /** 本次随消息发出的上下文:当前文档或选区、@ 引用的内容;读不到的提示并跳过(PRD 3.2) */
  private async buildContext(): Promise<ContextItem[]> {
    const ai = this.ai
    const deps = ai.deps
    const items: ContextItem[] = []
    const path = deps.documentPath() ?? undefined
    if (!this.removedDefault) {
      if (!deps.view().state.selection.empty) {
        items.push({ kind: 'selection', title: '选区', path, text: deps.selectionText() })
      } else {
        let text = deps.documentText()
        if (text.length > MAX_DOCUMENT_CHARS) {
          text = text.slice(0, MAX_DOCUMENT_CHARS)
          deps.toast(`文档过长,只带了前 ${MAX_DOCUMENT_CHARS} 字`)
        }
        items.push({ kind: 'document', title: deps.documentTitle(), path, text })
      }
    }
    for (const x of this.extra) {
      try {
        if (x.kind === 'file' && x.path) {
          items.push({ kind: 'file', title: x.title, path: x.path, text: (await deps.host.readText(x.path)).text })
        } else if (x.kind === 'conversation' && x.ref) {
          const conv = await ai.call<Conversation>('ai.conversations.get', { id: x.ref })
          items.push({ kind: 'conversation', title: x.title, ref: x.ref, text: pathMarkdown(conv, conv.leafId) })
        } else if (x.kind === 'resource' && x.ref) {
          const r = await ai.call<{ text: string }>('ai.mcp.resource', { serverId: x.serverId, uri: x.ref })
          items.push({ kind: 'resource', title: x.title, ref: x.ref, text: r.text })
        }
      } catch (err) {
        deps.toast(`「${x.title}」读不到,已跳过:${errorText(err)}`, true)
      }
    }
    // 「当前文件夹」连接器:文件夹随消息带上,由辅助进程的内置工具列出、搜索、读取【假设:见报告「契约偏差」】
    const root = deps.rootFolder()
    if (root && ai.settings?.connectors.folder) items.push({ kind: 'file', title: '当前文件夹', path: root, ref: 'folder' })
    return items
  }

  async send(override?: string, opts: { parentId?: string; resetLeaf?: boolean } = {}): Promise<void> {
    const ai = this.ai
    const text = (override ?? this.input.value).trim()
    if (!text || this.sending) return
    if (!(await ai.ensureConfigured())) {
      this.render()
      return
    }
    this.sending = true
    this.renderComposerState()
    const store = ai.store
    try {
      const context = await this.buildContext()
      const conv = store.conv
      const assistantId = conv?.assistantId ?? (this.assistant.value || ai.settings?.defaultAssistantId || '')
      if (opts.resetLeaf && conv) {
        await ai.call('ai.chat.setLeaf', { conversationId: conv.id, leafId: null })
        conv.leafId = null
      }
      store.creating = !conv
      const r = await ai.call<ChatSendResult>('ai.chat.send', { conversationId: conv?.id, parentId: opts.parentId, assistantId, text, context })
      store.registerSend(r, text, context, assistantId, opts.parentId ?? null)
      if (override === undefined) this.input.value = ''
      this.extra = []
      this.removedDefault = false
      this.editing = null
    } catch (err) {
      store.creating = false
      ai.deps.toast(`发送失败:${errorText(err)}`, true)
    } finally {
      this.sending = false
    }
    this.render()
    this.list.scrollTop = this.list.scrollHeight
  }

  private async stop(): Promise<void> {
    const conv = this.ai.store.conv
    if (!conv) return
    const path = pathTo(conv, conv.leafId)
    const last = path[path.length - 1]
    if (!last || last.role !== 'assistant') return
    try {
      await this.ai.call('ai.chat.stop', { conversationId: conv.id, messageId: last.id })
    } catch (err) {
      this.ai.deps.toast(`停止失败:${errorText(err)}`, true)
    }
  }

  private async regenerate(msg: Message): Promise<void> {
    const conv = this.ai.store.conv
    if (!conv) return
    if (!(await this.ai.ensureConfigured())) return
    try {
      const r = await this.ai.call<{ assistantMessageId: string }>('ai.chat.regenerate', { conversationId: conv.id, messageId: msg.id })
      this.ai.store.registerRegenerate(msg.id, r.assistantMessageId)
    } catch (err) {
      this.ai.deps.toast(`重新生成失败:${errorText(err)}`, true)
    }
    this.render()
  }

  /** 切换分支 / 版本:辅助进程改末端后给回完整对话 */
  private async setLeaf(leafId: string): Promise<void> {
    const conv = this.ai.store.conv
    if (!conv) return
    try {
      this.ai.store.adopt(await this.ai.call<Conversation>('ai.chat.setLeaf', { conversationId: conv.id, leafId }))
    } catch (err) {
      this.ai.deps.toast(`切换分支失败:${errorText(err)}`, true)
    }
    this.render()
  }

  /** 从这里分支(PRD 3.3):回答 → 末端移到这条,接着提问即是新分支;提问 → 给这条提问重新生成一个回答 */
  private async branchFrom(conv: Conversation, msg: Message): Promise<void> {
    if (msg.role === 'assistant') {
      await this.setLeaf(msg.id)
      this.ai.deps.toast('已从这里分支:接着提问即形成新分支,原分支保留在分支列表里')
      this.input.focus()
      return
    }
    const answers = Object.values(conv.messages).filter((m) => m.parentId === msg.id && m.role === 'assistant')
    const latest = answers.sort((a, b) => a.createdAt - b.createdAt).pop()
    if (latest) await this.regenerate(latest)
    else await this.setLeaf(msg.id)
  }

  private newChat(): void {
    this.ai.store.clear()
    this.editing = null
    this.render()
    this.input.focus()
  }

  private async loadSummaries(): Promise<void> {
    try {
      this.ai.store.summaries = (await this.ai.call<{ items: ConversationSummary[] }>('ai.conversations.list')).items
    } catch {
      // 未配置或组件不可用时侧栏里已有提示;列表留空
      this.ai.store.summaries = []
    }
  }

  private async openConversation(id: string): Promise<void> {
    try {
      this.ai.store.adopt(await this.ai.call<Conversation>('ai.conversations.get', { id }))
      this.editing = null
    } catch (err) {
      this.ai.deps.toast(`打开对话失败:${errorText(err)}`, true)
    }
    this.render()
  }

  private async openConversationMenu(anchor: HTMLElement): Promise<void> {
    await this.loadSummaries()
    const current = this.ai.store.conv?.id
    const items: MenuItem[] = [
      { id: 'conv.new', label: '＋ 新对话', run: () => this.newChat() },
      ...this.ai.store.summaries.map((s) => ({
        id: `conv:${s.id}`,
        label: s.title || '未命名对话',
        hint: timeLabel(s.updatedAt),
        group: '历史对话',
        active: s.id === current,
        run: () => void this.openConversation(s.id),
      })),
    ]
    const r = anchor.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom })
  }

  private openBranchMenu(anchor: HTMLElement): void {
    const conv = this.ai.store.conv
    if (!conv) return
    const items: MenuItem[] = branches(conv).map((b, i) => ({ id: `branch:${b.leafId}`, label: b.label, hint: `分支 ${i + 1}`, active: b.current, run: () => void this.setLeaf(b.leafId) }))
    const r = anchor.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom })
  }

  private openMoreMenu(anchor: HTMLElement): void {
    const conv = this.ai.store.conv
    const items: MenuItem[] = conv
      ? [
          { id: 'conv.rename', label: '改名…', run: () => void this.rename(conv) },
          { id: 'conv.export', label: '导出当前分支为 Markdown…', run: () => void this.exportBranch(conv) },
          { id: 'conv.insert', label: '插入当前分支到文档', run: () => this.insertIntoDocument(pathMarkdown(conv, conv.leafId), 'cursor') },
          { id: 'conv.delete', label: '删除对话…', run: () => void this.deleteConversation(conv) },
        ]
      : []
    items.push({ id: 'conv.settings', label: 'AI 设置…', run: () => this.ai.openSettings() })
    const r = anchor.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom })
  }

  private openMessageMenu(anchor: HTMLElement, conv: Conversation, msg: Message): void {
    const items: MenuItem[] = [{ id: 'msg.branch', label: '从这里分支', run: () => void this.branchFrom(conv, msg) }]
    if (msg.role === 'user') items.push({ id: 'msg.edit', label: '编辑后重发', run: () => this.startEdit(msg.id) })
    items.push({ id: 'msg.copy', label: '复制', run: () => void this.copy(messageText(msg)) })
    const r = anchor.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom })
  }

  private async rename(conv: Conversation): Promise<void> {
    const r = this.head.getBoundingClientRect()
    const title = await promptInput({ title: '对话名称', value: conv.title, anchor: { left: r.left + 8, top: r.top, bottom: r.bottom } })
    if (!title) return
    try {
      await this.ai.call('ai.conversations.rename', { id: conv.id, title })
      conv.title = title
      this.ai.store.summaries = this.ai.store.summaries.map((s) => (s.id === conv.id ? { ...s, title } : s))
    } catch (err) {
      this.ai.deps.toast(`改名失败:${errorText(err)}`, true)
    }
    this.renderHead()
  }

  private async deleteConversation(conv: Conversation): Promise<void> {
    const host = this.ai.deps.host
    const choice = await host.confirm({ title: '删除这个对话?', message: `「${conv.title || '未命名对话'}」的全部分支都会删除,不能恢复。`, buttons: ['删除', '取消'], style: 'warning' })
    if (choice !== 0) return
    try {
      await this.ai.call('ai.conversations.delete', { id: conv.id })
      this.ai.store.summaries = this.ai.store.summaries.filter((s) => s.id !== conv.id)
      if (this.ai.store.conv?.id === conv.id) this.ai.store.clear()
    } catch (err) {
      this.ai.deps.toast(`删除失败:${errorText(err)}`, true)
    }
    this.render()
  }

  private async exportBranch(conv: Conversation): Promise<void> {
    const host = this.ai.deps.host
    const name = `${(conv.title || '对话').replace(/[/:\\]/g, '-').slice(0, 60)}.md`
    const target = await host.saveDialog({ defaultName: name, extensions: ['md'] })
    if (!target) return
    try {
      await host.writeText(target, pathMarkdown(conv, conv.leafId))
      this.ai.deps.toast(`已导出到 ${target}`)
    } catch (err) {
      this.ai.deps.toast(`导出失败:${errorText(err)}`, true)
    }
  }

  private async copy(markdown: string): Promise<void> {
    try {
      await this.ai.deps.host.clipboardWrite({ text: markdown })
      this.ai.deps.toast('已复制')
    } catch (err) {
      this.ai.deps.toast(`复制失败:${errorText(err)}`, true)
    }
  }

  /** 回答写回正文:插入到光标处 / 替换选区 / 插入文末,都是一次编辑(⌘Z 一步撤回) */
  insertIntoDocument(markdown: string, where: 'cursor' | 'replace' | 'end'): void {
    const deps = this.ai.deps
    if (deps.readOnly()) {
      deps.toast('文档只读,不能插入', true)
      return
    }
    deps.ensureRichMode()
    const view = deps.view()
    if (where === 'replace' && view.state.selection.empty) {
      deps.toast('请先在正文里选中要替换的内容', true)
      return
    }
    const options = deps.parseOptions()
    const tr = closeHistory(view.state.tr)
    if (where === 'end') tr.insert(tr.doc.content.size, markdownBlocks(markdown, options))
    else tr.replaceSelection(markdownSlice(markdown, options))
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }
}
