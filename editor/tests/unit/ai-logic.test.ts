// AI 版的纯计算:提示词占位替换、AI 动作列表、分支路线、改文档的套用与块差分、模型选择(ai-prd 3.1、3.3、3.4、3.7)。
import { describe, expect, it } from 'vitest'
import { branches, latestLeaf, messageText, pathMarkdown, pathTo, versionsOf } from '../../src/ai/branch'
import { applyDocEdit, diffSequences, DocEditError } from '../../src/ai/diff'
import { hasUsableModel, modelOptions, newId, parseRefKey, refKey } from '../../src/ai/models'
import { actionsFor, BUILTIN_ACTIONS, fillPrompt, validateAction } from '../../src/ai/prompt'
import type { AiSettings, Conversation, Message } from '../../src/host/ai-types'

describe('提示词占位替换', () => {
  it('替换 selection / document / language,允许花括号里有空格', () => {
    const out = fillPrompt('把「{{selection}}」译成{{ language }};全文:{{document}}', { selection: '你好', document: '# 文档', language: '英文' })
    expect(out).toBe('把「你好」译成英文;全文:# 文档')
  })

  it('没给值的占位符换成空串,不认识的原样保留,同一占位符可出现多次', () => {
    expect(fillPrompt('{{selection}}|{{selection}}|{{other}}|{{document}}', { selection: 'A' })).toBe('A|A|{{other}}|')
  })

  it('替换值里含 $ 等特殊字符时照原样放进去', () => {
    expect(fillPrompt('值:{{selection}}', { selection: '$& $1 $$' })).toBe('值:$& $1 $$')
  })
})

describe('AI 动作', () => {
  const custom = [{ id: 'c1', name: '改成口语', prompt: '改口语:{{selection}}' }]

  it('内置在前、自定义在后;内置动作齐全', () => {
    const list = actionsFor(custom, false)
    expect(list.map((a) => a.name)).toEqual([...BUILTIN_ACTIONS.map((a) => a.name), '改成口语'])
    expect(BUILTIN_ACTIONS.map((a) => a.name)).toEqual(['改写', '润色', '缩短', '扩写', '改正错别字与语法', '翻译', '解释', '总结', '续写'])
    expect(list.find((a) => a.id === 'c1')?.builtin).toBe(false)
  })

  it('代码块里只给「解释」「改写」', () => {
    expect(actionsFor(custom, true).map((a) => a.name).sort()).toEqual(['改写', '解释'].sort())
  })

  it('名称或提示词为空不能保存', () => {
    expect(validateAction({ name: '动作', prompt: '  ' })).toBe('提示词不能为空')
    expect(validateAction({ name: '', prompt: 'x' })).toBe('请填写动作名称')
    expect(validateAction({ name: '动作', prompt: '{{selection}}' })).toBeNull()
  })
})

function msg(id: string, parentId: string | null, role: 'user' | 'assistant', text: string, createdAt: number): Message {
  return { id, parentId, role, parts: [{ type: 'text', text }], status: 'done', createdAt }
}

/**
 * 问 1 → 答 1(版本 1)→ 问 2 → 答 2
 *      → 答 1(版本 2,重新生成)
 * 答 1 → 问 3(从这里分支)→ 答 3
 */
function sample(leafId: string): Conversation {
  const list = [
    msg('u1', null, 'user', '问题一', 1),
    msg('a1', 'u1', 'assistant', '回答一', 2),
    msg('a1b', 'u1', 'assistant', '回答一·版本二', 5),
    msg('u2', 'a1', 'user', '问题二', 3),
    msg('a2', 'u2', 'assistant', '回答二', 4),
    msg('u3', 'a1', 'user', '另一个问题', 6),
    msg('a3', 'u3', 'assistant', '分支上的回答', 7),
  ]
  return { id: 'c', title: '示例', assistantId: 'writer', createdAt: 0, updatedAt: 7, messages: Object.fromEntries(list.map((m) => [m.id, m])), leafId }
}

describe('对话分支', () => {
  it('当前路线:根 → leaf', () => {
    expect(pathTo(sample('a2'), 'a2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(pathTo(sample('a2'), null)).toEqual([])
  })

  it('断链或成环时停下,不死循环', () => {
    const conv = sample('a2')
    conv.messages.u1.parentId = 'a2'
    expect(pathTo(conv, 'a2').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    conv.messages.u1.parentId = 'missing'
    expect(pathTo(conv, 'a1').map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('同一位置的版本:同父同角色、按时间排;切到某版本后沿最新的子消息走到末端', () => {
    const conv = sample('a2')
    expect(versionsOf(conv, conv.messages.a1).map((m) => m.id)).toEqual(['a1', 'a1b'])
    expect(versionsOf(conv, conv.messages.u2).map((m) => m.id)).toEqual(['u2', 'u3'])
    expect(latestLeaf(conv, 'a1')).toBe('a3')
    expect(latestLeaf(conv, 'a1b')).toBe('a1b')
    expect(latestLeaf(conv, 'u2')).toBe('a2')
  })

  it('分支列表:每个末端一条,以分叉处消息开头命名,标出当前分支', () => {
    const list = branches(sample('a2'))
    expect(list.map((b) => b.leafId)).toEqual(['a2', 'a1b', 'a3'])
    expect(list.map((b) => b.label)).toEqual(['问题二', '回答 2:回答一·版本二', '另一个问题'])
    expect(list.map((b) => b.current)).toEqual([true, false, false])
  })

  it('没有分叉时以第一条提问命名', () => {
    const conv = sample('a1')
    for (const id of ['a1b', 'u2', 'a2', 'u3', 'a3']) delete conv.messages[id]
    expect(branches(conv)).toEqual([{ leafId: 'a1', label: '问题一', current: true }])
  })

  it('导出当前分支为 Markdown:提问写成引用块,工具调用记一行', () => {
    const conv = sample('a2')
    conv.messages.a2.parts.push({ type: 'tool_call', callId: 't', tool: 'mcp__demo__search', input: {}, status: 'done', result: 'r' })
    const md = pathMarkdown(conv, 'a2')
    expect(md).toBe('# 示例\n\n**我:**\n\n> 问题一\n\n**AI:**\n\n回答一\n\n**我:**\n\n> 问题二\n\n**AI:**\n\n回答二\n\n> 调用工具 `mcp__demo__search`(done)\n')
    expect(md).not.toContain('版本二')
    expect(messageText({ parts: [{ type: 'text', text: 'a' }, { type: 'skill', name: 's' }, { type: 'text', text: 'b' }] })).toBe('ab')
  })
})

describe('改文档:套用 doc.edit', () => {
  const text = '# 计划\n\n第一段旧内容。\n\n第二段。\n'

  it('replace_all 整篇替换', () => {
    expect(applyDocEdit(text, { kind: 'replace_all', text: '全新\n' })).toBe('全新\n')
  })

  it('replace_range:有 find 替换第一处,否则按偏移替换', () => {
    expect(applyDocEdit(text, { kind: 'replace_range', find: '旧内容', text: '新内容' })).toBe('# 计划\n\n第一段新内容。\n\n第二段。\n')
    const from = text.indexOf('第二段')
    expect(applyDocEdit(text, { kind: 'replace_range', from, to: from + 3, text: '最后一段' })).toBe('# 计划\n\n第一段旧内容。\n\n最后一段。\n')
  })

  it('insert:按偏移、按 find 之后、默认插到文末(空一行)', () => {
    expect(applyDocEdit(text, { kind: 'insert', from: 0, text: '前言\n\n' })).toBe(`前言\n\n${text}`)
    expect(applyDocEdit(text, { kind: 'insert', find: '第一段旧内容。', text: '(补充)' })).toBe('# 计划\n\n第一段旧内容。(补充)\n\n第二段。\n')
    expect(applyDocEdit(text, { kind: 'insert', text: '结尾\n' })).toBe('# 计划\n\n第一段旧内容。\n\n第二段。\n\n结尾\n')
    expect(applyDocEdit('', { kind: 'insert', text: '唯一一段' })).toBe('唯一一段\n')
  })

  it('找不到原文、偏移越界、to 小于 from 时报错说明原因', () => {
    expect(() => applyDocEdit(text, { kind: 'replace_range', find: '不存在', text: 'x' })).toThrow(DocEditError)
    expect(() => applyDocEdit(text, { kind: 'replace_range', find: '不存在', text: 'x' })).toThrow('找不到要修改的原文')
    expect(() => applyDocEdit(text, { kind: 'replace_range', from: 0, to: 9999, text: 'x' })).toThrow('超出文档范围')
    expect(() => applyDocEdit(text, { kind: 'replace_range', from: 5, to: 2, text: 'x' })).toThrow('to 不能小于 from')
    expect(() => applyDocEdit(text, { kind: 'insert', from: -1, text: 'x' })).toThrow('超出文档范围')
  })
})

describe('改文档:按块差分', () => {
  const eq = (a: string, b: string) => a === b

  it('相同序列没有差异', () => {
    expect(diffSequences(['a', 'b'], ['a', 'b'], eq)).toEqual([])
  })

  it('只改中间一块:一段替换', () => {
    expect(diffSequences(['h', 'p1', 'p2'], ['h', 'p1x', 'p2'], eq)).toEqual([{ aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 }])
  })

  it('文末追加、开头删除', () => {
    expect(diffSequences(['a', 'b'], ['a', 'b', 'c'], eq)).toEqual([{ aFrom: 2, aTo: 2, bFrom: 2, bTo: 3 }])
    expect(diffSequences(['x', 'a', 'b'], ['a', 'b'], eq)).toEqual([{ aFrom: 0, aTo: 1, bFrom: 0, bTo: 0 }])
  })

  it('分散的多处改动各成一段,没改的块不动', () => {
    const a = ['h', 'p1', 'p2', 'p3', 'p4']
    const b = ['h', 'P1', 'p2', 'p3', 'P4', 'p5']
    const hunks = diffSequences(a, b, eq)
    expect(hunks).toEqual([
      { aFrom: 1, aTo: 2, bFrom: 1, bTo: 2 },
      { aFrom: 4, aTo: 5, bFrom: 4, bTo: 6 },
    ])
    // 把差异段套回去得到新序列
    const out = [...a]
    for (const hk of [...hunks].reverse()) out.splice(hk.aFrom, hk.aTo - hk.aFrom, ...b.slice(hk.bFrom, hk.bTo))
    expect(out).toEqual(b)
  })

  it('先插入后删除的交错也能还原', () => {
    const a = ['a', 'b', 'c', 'd']
    const b = ['x', 'a', 'c', 'y', 'd', 'z']
    const out = [...a]
    for (const hk of [...diffSequences(a, b, eq)].reverse()) out.splice(hk.aFrom, hk.aTo - hk.aFrom, ...b.slice(hk.bFrom, hk.bTo))
    expect(out).toEqual(b)
  })
})

describe('服务商与模型', () => {
  const settings = (providers: AiSettings['providers']): AiSettings => ({
    providers,
    assistants: [],
    defaultAssistantId: '',
    actions: [],
    mcpServers: [],
    toolPolicies: {},
    connectors: { folder: true, web: false },
    skillsEnabled: true,
    readAgentsSkills: false,
    disabledSkills: [],
    spaceTriggersAi: true,
  })
  const provider = (id: string, enabled: boolean, models: string[]) => ({ id, name: id.toUpperCase(), protocol: 'openai-chat' as const, baseUrl: '', enabled, hasKey: false, models: models.map((m) => ({ id: m })) })

  it('至少一个启用的服务商里有模型才算可用', () => {
    expect(hasUsableModel(null)).toBe(false)
    expect(hasUsableModel(settings([]))).toBe(false)
    expect(hasUsableModel(settings([provider('a', true, [])]))).toBe(false)
    expect(hasUsableModel(settings([provider('a', false, ['m'])]))).toBe(false)
    expect(hasUsableModel(settings([provider('a', false, ['m']), provider('b', true, ['n'])]))).toBe(true)
  })

  it('模型选择项只列启用的服务商;模型 ID 里有斜杠也能来回转换', () => {
    const s = settings([provider('a', true, ['m1', 'org/model']), provider('b', false, ['x'])])
    expect(modelOptions(s)).toEqual([
      { value: 'a/m1', label: 'A · m1' },
      { value: 'a/org/model', label: 'A · org/model' },
    ])
    expect(parseRefKey('a/org/model')).toEqual({ providerId: 'a', modelId: 'org/model' })
    expect(refKey(parseRefKey('a/m1'))).toBe('a/m1')
    expect(parseRefKey('')).toBeUndefined()
    expect(refKey(undefined)).toBe('')
  })

  it('新条目 ID 与辅助进程同格式:20 位 base32 小写,不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{20}$/)
  })
})
