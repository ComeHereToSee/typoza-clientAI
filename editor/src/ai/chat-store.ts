// 侧栏当前对话的本地状态:按 ai.event 增量更新(文字增量、部件、结束、工具确认请求)。
// 事件可能先于 ai.chat.send 的返回到达(外壳的回执与广播走两条通道),认不出的消息的事件先存着,登记后再补上。
import type { AiEvent, ChatSendResult, ContextItem, Conversation, ConversationSummary, Message, ToolInfo } from '../host/ai-types'

export interface ToolRequest {
  conversationId: string
  messageId: string
  callId: string
  tool: ToolInfo
  input: unknown
}

/** 暂存事件的上限:超过时丢最早的(对应的对话已经不在显示) */
const MAX_PENDING = 2000

type ConvEvent = Extract<AiEvent, { conversationId: string }>

export class ChatStore {
  conv: Conversation | null = null
  summaries: ConversationSummary[] = []
  /** 等待用户确认的工具调用(tool.request),按 callId */
  readonly requests = new Map<string, ToolRequest>()
  /** 见过的工具信息,按工具全名(卡片显示名字与来源) */
  readonly tools = new Map<string, ToolInfo>()
  /** 正在新建对话(ai.chat.send 未返回):这期间陌生对话的事件先存着 */
  creating = false
  private pending: ConvEvent[] = []

  /** 应用一个事件;返回受影响的消息 ID(与当前对话无关时为 null,对话列表变化时为空串) */
  apply(ev: AiEvent): string | null {
    switch (ev.type) {
      case 'conversation.updated': {
        const list = this.summaries.filter((s) => s.id !== ev.summary.id)
        list.push(ev.summary)
        this.summaries = list.sort((a, b) => b.updatedAt - a.updatedAt)
        if (this.conv?.id === ev.summary.id) {
          this.conv.title = ev.summary.title
          this.conv.updatedAt = ev.summary.updatedAt
        }
        return ''
      }
      case 'message.delta':
      case 'message.part':
      case 'message.done':
      case 'tool.request':
      case 'doc.edit':
        return this.applyConvEvent(ev)
      default:
        return null
    }
  }

  private applyConvEvent(ev: ConvEvent): string | null {
    if (ev.type === 'tool.request') this.tools.set(ev.tool.name, ev.tool)
    const conv = this.conv
    const msg = conv && conv.id === ev.conversationId ? conv.messages[ev.messageId] : undefined
    if (!msg) {
      if ((conv && conv.id === ev.conversationId) || (this.creating && !conv)) {
        this.pending.push(ev)
        if (this.pending.length > MAX_PENDING) this.pending.shift()
      }
      // 工具确认请求即使对话不在显示也记下:切回该对话时卡片上仍有按钮
      if (ev.type === 'tool.request') this.requests.set(ev.callId, { conversationId: ev.conversationId, messageId: ev.messageId, callId: ev.callId, tool: ev.tool, input: ev.input })
      return null
    }
    switch (ev.type) {
      case 'message.delta': {
        const last = msg.parts[msg.parts.length - 1]
        if (last?.type === 'text') last.text += ev.text
        else msg.parts.push({ type: 'text', text: ev.text })
        if (msg.status !== 'waiting') msg.status = 'streaming'
        break
      }
      case 'message.part': {
        const part = ev.part
        if (part.type === 'tool_call') {
          const i = msg.parts.findIndex((p) => p.type === 'tool_call' && p.callId === part.callId)
          if (i >= 0) msg.parts[i] = part
          else msg.parts.push(part)
          if (part.status !== 'pending') this.requests.delete(part.callId)
        } else if (part.type === 'skill') {
          if (!msg.parts.some((p) => p.type === 'skill' && p.name === part.name)) msg.parts.push(part)
        } else {
          msg.parts.push(part)
        }
        break
      }
      case 'message.done':
        msg.status = ev.status
        if (ev.error) msg.error = ev.error
        for (const [id, r] of this.requests) if (r.messageId === msg.id) this.requests.delete(id)
        break
      case 'tool.request':
        this.requests.set(ev.callId, { conversationId: ev.conversationId, messageId: ev.messageId, callId: ev.callId, tool: ev.tool, input: ev.input })
        msg.status = 'waiting'
        break
      case 'doc.edit':
        msg.status = 'waiting'
        break
    }
    return msg.id
  }

  /** 换成辅助进程给的完整对话(打开历史对话、切换分支);本地正在输出的消息以本地为准 */
  adopt(next: Conversation): void {
    const local = this.conv && this.conv.id === next.id ? this.conv : null
    if (local) {
      for (const [id, msg] of Object.entries(local.messages)) {
        if ((msg.status === 'streaming' || msg.status === 'waiting') && next.messages[id]) next.messages[id] = msg
      }
    } else {
      this.pending = this.pending.filter((ev) => ev.conversationId !== next.id)
    }
    this.conv = next
    this.flush()
  }

  /** 新对话(还没发送) */
  clear(): void {
    this.conv = null
    this.pending = []
  }

  /** ai.chat.send 返回后登记提问与回答 */
  registerSend(r: ChatSendResult, text: string, context: ContextItem[], assistantId: string, parentId: string | null): void {
    const now = Date.now()
    const existing = this.conv && this.conv.id === r.conversationId ? this.conv : null
    const conv: Conversation = existing ?? { id: r.conversationId, title: [...text].slice(0, 20).join(''), assistantId, createdAt: now, updatedAt: now, messages: {}, leafId: null }
    this.conv = conv
    const user: Message = { id: r.userMessageId, parentId: parentId ?? conv.leafId, role: 'user', parts: [{ type: 'text', text }], status: 'done', context, createdAt: now }
    conv.messages[user.id] ??= user
    conv.messages[r.assistantMessageId] ??= { id: r.assistantMessageId, parentId: user.id, role: 'assistant', parts: [], status: 'streaming', createdAt: now + 1 }
    conv.leafId = r.assistantMessageId
    conv.updatedAt = now
    if (!this.summaries.some((s) => s.id === conv.id)) this.summaries.unshift({ id: conv.id, title: conv.title, updatedAt: now })
    this.creating = false
    this.flush()
  }

  /** ai.chat.regenerate 返回后登记新版本(与原回答同父) */
  registerRegenerate(oldId: string, newId: string): void {
    const conv = this.conv
    const old = conv?.messages[oldId]
    if (!conv || !old) return
    conv.messages[newId] ??= { id: newId, parentId: old.parentId, role: 'assistant', parts: [], status: 'streaming', createdAt: Math.max(Date.now(), old.createdAt + 1) }
    conv.leafId = newId
    this.flush()
  }

  /** 补上之前认不出的事件 */
  private flush(): void {
    const list = this.pending
    this.pending = []
    for (const ev of list) this.applyConvEvent(ev)
  }
}
