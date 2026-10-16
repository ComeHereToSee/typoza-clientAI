// 侧栏的对话状态:按 ai.event 增量更新;事件先于 ai.chat.send 的返回到达时先存着,登记后补上(ai-architecture 3.4)。
import { describe, expect, it } from 'vitest'
import { ChatStore } from '../../src/ai/chat-store'
import type { Conversation } from '../../src/host/ai-types'

const tool = { name: 'mcp__demo__search', title: '搜索资料', description: '', source: '演示服务器', inputSchema: {} }

describe('ChatStore', () => {
  it('新对话:回答的增量先到、send 的结果后到,登记后文字一个不丢', () => {
    const store = new ChatStore()
    store.creating = true
    store.apply({ type: 'message.delta', conversationId: 'c1', messageId: 'a1', text: '你' })
    store.apply({ type: 'message.delta', conversationId: 'c1', messageId: 'a1', text: '好' })
    expect(store.conv).toBeNull()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '打个招呼', [], 'writer', null)
    const conv = store.conv!
    expect(conv.leafId).toBe('a1')
    expect(conv.messages.u1).toMatchObject({ role: 'user', parentId: null, parts: [{ type: 'text', text: '打个招呼' }] })
    expect(conv.messages.a1).toMatchObject({ role: 'assistant', parentId: 'u1', status: 'streaming', parts: [{ type: 'text', text: '你好' }] })
    expect(store.summaries.map((s) => s.id)).toEqual(['c1'])
    expect(store.apply({ type: 'message.done', conversationId: 'c1', messageId: 'a1', status: 'done' })).toBe('a1')
    expect(conv.messages.a1.status).toBe('done')
  })

  it('不是当前对话的事件不记;对话列表跟着 conversation.updated 排序', () => {
    const store = new ChatStore()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '问', [], 'writer', null)
    expect(store.apply({ type: 'message.delta', conversationId: 'other', messageId: 'x', text: '?' })).toBeNull()
    expect(store.apply({ type: 'conversation.updated', summary: { id: 'c2', title: '新的', updatedAt: Date.now() + 1000 } })).toBe('')
    store.apply({ type: 'conversation.updated', summary: { id: 'c1', title: '改了名', updatedAt: 1 } })
    expect(store.summaries.map((s) => s.id)).toEqual(['c2', 'c1'])
    expect(store.conv?.title).toBe('改了名')
  })

  it('工具调用:确认请求挂起,状态变化后撤下;同一 callId 的部件就地更新', () => {
    const store = new ChatStore()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '搜一下', [], 'writer', null)
    const part = { type: 'tool_call' as const, callId: 't1', tool: tool.name, input: { query: 'x' }, status: 'pending' as const }
    store.apply({ type: 'message.part', conversationId: 'c1', messageId: 'a1', part })
    store.apply({ type: 'tool.request', conversationId: 'c1', messageId: 'a1', callId: 't1', tool, input: part.input })
    expect(store.requests.get('t1')?.tool.title).toBe('搜索资料')
    expect(store.tools.get(tool.name)?.source).toBe('演示服务器')
    expect(store.conv!.messages.a1.status).toBe('waiting')
    store.apply({ type: 'message.part', conversationId: 'c1', messageId: 'a1', part: { ...part, status: 'done', result: '3 条' } })
    expect(store.requests.has('t1')).toBe(false)
    expect(store.conv!.messages.a1.parts).toEqual([{ ...part, status: 'done', result: '3 条' }])
    // 工具之后的文字另起一段
    store.apply({ type: 'message.delta', conversationId: 'c1', messageId: 'a1', text: '结果如下' })
    expect(store.conv!.messages.a1.parts.map((p) => p.type)).toEqual(['tool_call', 'text'])
  })

  it('重新生成:新版本与原回答同父并成为末端;技能部件不重复记', () => {
    const store = new ChatStore()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '问', [], 'writer', null)
    store.registerRegenerate('a1', 'a2')
    expect(store.conv!.messages.a2).toMatchObject({ parentId: 'u1', role: 'assistant' })
    expect(store.conv!.leafId).toBe('a2')
    store.apply({ type: 'message.part', conversationId: 'c1', messageId: 'a2', part: { type: 'skill', name: 'meeting-notes' } })
    store.apply({ type: 'message.part', conversationId: 'c1', messageId: 'a2', part: { type: 'skill', name: 'meeting-notes' } })
    expect(store.conv!.messages.a2.parts).toEqual([{ type: 'skill', name: 'meeting-notes' }])
  })

  it('换成辅助进程给的完整对话时,本地正在输出的消息以本地为准', () => {
    const store = new ChatStore()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '问', [], 'writer', null)
    store.apply({ type: 'message.delta', conversationId: 'c1', messageId: 'a1', text: '本地已收到的文字' })
    const remote: Conversation = {
      id: 'c1',
      title: '问',
      assistantId: 'writer',
      createdAt: 1,
      updatedAt: 2,
      leafId: 'a1',
      messages: {
        u1: { id: 'u1', parentId: null, role: 'user', parts: [{ type: 'text', text: '问' }], status: 'done', createdAt: 1 },
        a1: { id: 'a1', parentId: 'u1', role: 'assistant', parts: [], status: 'streaming', createdAt: 2 },
      },
    }
    store.adopt(remote)
    expect(store.conv!.messages.a1.parts).toEqual([{ type: 'text', text: '本地已收到的文字' }])
  })

  it('编辑后重发:给了 parentId 时提问挂在它下面', () => {
    const store = new ChatStore()
    store.registerSend({ conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }, '原问题', [], 'writer', null)
    store.registerSend({ conversationId: 'c1', userMessageId: 'u2', assistantMessageId: 'a2' }, '改过的问题', [{ kind: 'selection', title: '选区', text: '片段' }], 'writer', 'p0')
    expect(store.conv!.messages.u2).toMatchObject({ parentId: 'p0', context: [{ kind: 'selection', text: '片段' }] })
    expect(store.conv!.leafId).toBe('a2')
  })
})
