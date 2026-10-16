// 模拟 AI 服务(浏览器宿主与 E2E 用)与辅助进程契约对齐:密钥只写不读、未配置模型报 not_configured、工具权限三档、doc.edit 等网页回报。
import { describe, expect, it } from 'vitest'
import { createFakeAi } from '../../src/host/fake-ai'
import { AiError, type AiEvent, type AiSettings } from '../../src/host/ai-types'

function collect(fake: ReturnType<typeof createFakeAi>) {
  const events: AiEvent[] = []
  fake.subscribe((ev) => events.push(ev))
  const until = async (pred: (ev: AiEvent) => boolean) => {
    for (let i = 0; i < 400; i++) {
      const hit = events.find(pred)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('等不到事件')
  }
  return { events, until }
}

describe('模拟 AI 服务', () => {
  it('密钥写进去后读不出来:设置里只有 hasKey,调用记录里是 ***', async () => {
    const fake = createFakeAi()
    await fake.call('ai.secret.set', { ref: 'provider:fake', value: 'sk-unit-SECRET' })
    const settings = (await fake.call('ai.settings.get', {})) as AiSettings
    expect(settings.providers[0].hasKey).toBe(true)
    expect(JSON.stringify(settings)).not.toContain('sk-unit-SECRET')
    expect(JSON.stringify(fake.calls)).not.toContain('sk-unit-SECRET')
    expect(fake.secretRefs()).toEqual(['provider:fake'])
    await expect(fake.call('ai.secrets', {})).rejects.toBeInstanceOf(AiError)
    await fake.call('ai.secret.set', { ref: 'provider:fake', value: '' })
    expect(((await fake.call('ai.settings.get', {})) as AiSettings).providers[0].hasKey).toBe(false)
  })

  it('没有可用模型时发送报 not_configured', async () => {
    const fake = createFakeAi()
    fake.reset({ configured: false })
    await expect(fake.call('ai.chat.send', { text: '你好', context: [] })).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('按脚本流式推文字;每次询问的工具等确认,总是允许后不再问', async () => {
    const fake = createFakeAi()
    fake.delay = 1
    const { events, until } = collect(fake)
    fake.scripts.push([{ tool: 'mcp__demo__search', input: { q: 'x' }, result: '3 条' }, { text: '结果有三条' }])
    const r = (await fake.call('ai.chat.send', { text: '搜', context: [] })) as { conversationId: string; assistantMessageId: string }
    const req = (await until((e) => e.type === 'tool.request')) as Extract<AiEvent, { type: 'tool.request' }>
    expect(req.tool.source).toBe('演示服务器')
    await fake.call('ai.tool.decide', { conversationId: r.conversationId, callId: req.callId, decision: 'always' })
    await until((e) => e.type === 'message.done')
    const text = events.filter((e): e is Extract<AiEvent, { type: 'message.delta' }> => e.type === 'message.delta').map((e) => e.text).join('')
    expect(text).toBe('结果有三条')
    expect(fake.settings.toolPolicies['mcp__demo__search']).toBe('allow')

    events.length = 0
    fake.scripts.push([{ tool: 'mcp__demo__search', result: '自动' }])
    await fake.call('ai.chat.send', { conversationId: r.conversationId, text: '再搜', context: [] })
    await until((e) => e.type === 'message.done')
    expect(events.some((e) => e.type === 'tool.request')).toBe(false)
    const parts = events.filter((e): e is Extract<AiEvent, { type: 'message.part' }> => e.type === 'message.part').map((e) => e.part)
    expect(parts[parts.length - 1]).toMatchObject({ type: 'tool_call', status: 'done', result: '自动' })
  })

  it('doc.edit 等网页回报 result;停住的回答可以停止', async () => {
    const fake = createFakeAi()
    fake.delay = 1
    const { until } = collect(fake)
    fake.scripts.push([{ edit: { kind: 'insert', text: '新的一段' } }, { hold: true }, { text: '不会出现' }])
    const r = (await fake.call('ai.chat.send', { text: '加一段', context: [] })) as { conversationId: string; assistantMessageId: string }
    const edit = (await until((e) => e.type === 'doc.edit')) as Extract<AiEvent, { type: 'doc.edit' }>
    expect(edit.edit).toEqual({ kind: 'insert', text: '新的一段' })
    await fake.call('ai.tool.decide', { conversationId: r.conversationId, callId: edit.callId, decision: 'allow', result: '已应用修改(共 1 处)' })
    await until((e) => e.type === 'message.part' && e.part.type === 'tool_call' && e.part.status === 'done')
    await fake.call('ai.chat.stop', { conversationId: r.conversationId, messageId: r.assistantMessageId })
    const done = (await until((e) => e.type === 'message.done')) as Extract<AiEvent, { type: 'message.done' }>
    expect(done.status).toBe('stopped')
    const conv = fake.conversations.get(r.conversationId)!
    expect(conv.messages[r.assistantMessageId].parts[0]).toMatchObject({ status: 'done', result: '已应用修改(共 1 处)' })
  })
})
