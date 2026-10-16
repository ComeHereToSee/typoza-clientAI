// 模拟的 AI 服务:浏览器预览与 E2E 用。方法名、参数、结果结构、事件与错误码对齐辅助进程 helper/internal/aisvc
// (docs/tech/ai-architecture.md 第 3 节);不连网。回答按测试排好的脚本逐段推送事件:流式文字、用到技能、
// 工具调用(按权限询问 / 允许 / 禁用)、改文档(等网页确认后回报)、出错、停住等用户点停止。
import {
  AiError,
  type AiErrorInfo,
  type AiEvent,
  type AiSettings,
  type Conversation,
  type DocEdit,
  type McpServer,
  type McpStatus,
  type Message,
  type Part,
  type Skill,
  type ToolCallPart,
  type ToolInfo,
} from './ai-types'

/** 回答脚本的一步 */
export type FakeStep =
  /** 文字:切成小段逐段推 delta */
  | { text: string }
  /** 本轮用到了某个技能 */
  | { skill: string }
  /** 调用工具:按 toolPolicies 决定询问 / 直接执行 / 拒绝;fail 为工具执行出错的原因 */
  | { tool: string; input?: unknown; title?: string; source?: string; result?: string; fail?: string }
  /** 模型要改当前文档:推 doc.edit,等网页 ai.tool.decide 带 result 回报 */
  | { edit: DocEdit }
  /** 以出错结束 */
  | { error: AiErrorInfo }
  /** 停在这里,直到用户点停止或测试调用 release() */
  | { hold: true }

export interface FakeAi {
  call(method: string, params: Record<string, unknown>): Promise<unknown>
  subscribe(cb: (event: AiEvent) => void): () => void
  /** 排队的回答脚本:每次 ai.chat.send / ai.chat.regenerate / ai.complete 取队首;队列空时回一段默认文字 */
  scripts: FakeStep[][]
  /** 调用记录(ai.secret.set 的 value 记为 ***,不留明文) */
  calls: { method: string; params: Record<string, unknown> }[]
  /** 当前设置(与 ai.settings.get 一致,不含密钥) */
  readonly settings: AiSettings
  readonly conversations: Map<string, Conversation>
  /** 已存进「钥匙串」的引用名(只给名字,不给值) */
  secretRefs(): string[]
  /** 换回默认设置;configured 为 false 时没有任何服务商与模型 */
  reset(options?: { configured?: boolean }): void
  /** 放行停在 hold 的脚本 */
  release(): void
  /** 每段输出之间的间隔(毫秒) */
  delay: number
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** 与辅助进程同格式的 ID:随机 12 字节的 base32 小写(20 个字符) */
export function fakeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ID_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ID_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

const BUILTIN_TOOLS: ToolInfo[] = [
  { name: 'typoza__list_documents', title: '列出文档', description: '列出当前文件夹里的文档', source: '内置', inputSchema: { type: 'object' } },
  { name: 'typoza__search_documents', title: '搜索文档', description: '在当前文件夹里搜索', source: '内置', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'typoza__read_document', title: '读取文档', description: '读取当前文件夹里的一篇文档', source: '内置', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'typoza__edit_document', title: '修改当前文档', description: '修改当前打开的文档(需用户确认)', source: '内置', inputSchema: { type: 'object' } },
  { name: 'typoza__read_skill', title: '读取技能', description: '读取技能正文或资源文件', source: '内置', inputSchema: { type: 'object' } },
  { name: 'typoza__fetch_url', title: '网页读取', description: '把网址正文转为 Markdown', source: '内置', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
]

const DEMO_SERVER: McpServer = { id: 'demo', name: '演示服务器', enabled: true, transport: 'stdio', command: 'demo-mcp', args: [], env: {} }

function defaultSettings(configured: boolean): AiSettings {
  return {
    providers: configured
      ? [
          {
            id: 'fake',
            name: '模拟服务商',
            protocol: 'openai-chat',
            baseUrl: 'http://127.0.0.1:11434/v1',
            enabled: true,
            hasKey: false,
            models: [
              { id: 'fake-model', name: '模拟模型', tools: true },
              { id: 'fake-mini', name: '模拟快速模型' },
            ],
          },
        ]
      : [],
    defaultModel: configured ? { providerId: 'fake', modelId: 'fake-model' } : undefined,
    assistants: [
      { id: 'writer', name: '写作助手', icon: '✍️', systemPrompt: '你是一位细心的中文写作助手。', skills: [], mcpServers: [] },
      { id: 'translator', name: '翻译', icon: '🌐', systemPrompt: '你是一位翻译,保持原文格式。', skills: [], mcpServers: [] },
      { id: 'coder', name: '代码解释', icon: '💻', systemPrompt: '你负责解释代码。', skills: [], mcpServers: [] },
    ],
    defaultAssistantId: 'writer',
    actions: [],
    mcpServers: [structuredClone(DEMO_SERVER)],
    toolPolicies: {},
    connectors: { folder: true, web: false },
    skillsEnabled: true,
    readAgentsSkills: false,
    disabledSkills: [],
    spaceTriggersAi: true,
  }
}

function defaultSkills(): Skill[] {
  const dir = '/Users/test/Library/Application Support/Typoza/skills'
  return [
    { name: 'meeting-notes', description: '把会议记录整理成纪要。用户要整理会议记录时使用。', path: `${dir}/meeting-notes`, hasScripts: false, source: 'typoza' },
    { name: 'Bad_Name', description: '', path: `${dir}/Bad_Name`, hasScripts: false, source: 'typoza', error: 'name 只能用小写字母、数字和连字符,且要和目录名一致' },
  ]
}

interface Run {
  stopped: boolean
  /** 停止时叫醒正在等待(确认、hold)的脚本 */
  wake?: () => void
}

type Decision = { decision: 'allow' | 'always' | 'deny'; result?: string }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function chunks(text: string, size: number): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

export function createFakeAi(): FakeAi {
  let settings = defaultSettings(true)
  let skills = defaultSkills()
  const secrets = new Map<string, string>()
  const conversations = new Map<string, Conversation>()
  const listeners = new Set<(event: AiEvent) => void>()
  const decisions = new Map<string, (d: Decision) => void>()
  const running = new Map<string, Run>()
  let holds: (() => void)[] = []

  const fail = (code: string, message: string): never => {
    throw new AiError(code, message)
  }
  const emit = (event: AiEvent) => {
    for (const fn of [...listeners]) fn(structuredClone(event))
  }
  const str = (p: Record<string, unknown>, key: string) => (typeof p[key] === 'string' ? (p[key] as string) : '')
  const usable = () => settings.providers.some((p) => p.enabled && p.models.length > 0)
  const readSettings = (): AiSettings => {
    const copy = structuredClone(settings)
    for (const p of copy.providers) p.hasKey = secrets.has(`provider:${p.id}`)
    return copy
  }
  const provider = (id: string) => settings.providers.find((p) => p.id === id) ?? fail('not_found', `没有这个服务商:${id}`)
  const conversation = (id: string) => conversations.get(id) ?? fail('not_found', '对话不存在')
  const summary = (c: Conversation) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })
  const nextScript = (fallback: string): FakeStep[] => fake.scripts.shift() ?? [{ text: fallback }]

  const mcpStatus = (server: McpServer): McpStatus => {
    if (!server.enabled) return { serverId: server.id, state: 'disabled', tools: [], prompts: [], resources: [], log: [] }
    if (server.id === 'demo') {
      return {
        serverId: server.id,
        state: 'connected',
        tools: [{ name: 'mcp__demo__search', title: '搜索资料', description: '在演示资料里搜索', source: server.name, inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
        prompts: [{ name: 'summarize', description: '总结要点' }],
        resources: [{ uri: 'demo://readme', name: '演示说明' }],
        log: ['[demo-mcp] listening on stdio'],
      }
    }
    if (server.transport === 'stdio' && !server.command) return { serverId: server.id, state: 'failed', error: '没有填写命令', tools: [], prompts: [], resources: [], log: ['启动失败:没有填写命令'] }
    return { serverId: server.id, state: 'connected', tools: [], prompts: [], resources: [], log: [`[${server.name}] connected`] }
  }

  const appendText = (msg: Message, text: string) => {
    const last = msg.parts[msg.parts.length - 1]
    if (last?.type === 'text') last.text += text
    else msg.parts.push({ type: 'text', text })
  }

  const waitDecision = (callId: string, run: Run) =>
    new Promise<Decision | null>((resolve) => {
      decisions.set(callId, (d) => {
        decisions.delete(callId)
        run.wake = undefined
        resolve(d)
      })
      run.wake = () => {
        decisions.delete(callId)
        resolve(null)
      }
    })

  const waitHold = (run: Run) =>
    new Promise<void>((resolve) => {
      holds.push(resolve)
      run.wake = () => resolve()
    })

  const toolInfo = (step: { tool: string; title?: string; source?: string }): ToolInfo => {
    const known = [...BUILTIN_TOOLS, ...settings.mcpServers.flatMap((s) => mcpStatus(s).tools)].find((t) => t.name === step.tool)
    return known ?? { name: step.tool, title: step.title ?? step.tool, description: '', source: step.source ?? '演示服务器', inputSchema: {} }
  }

  async function runChat(conv: Conversation, msg: Message, steps: FakeStep[]): Promise<void> {
    const run: Run = { stopped: false }
    running.set(msg.id, run)
    const base = { conversationId: conv.id, messageId: msg.id }
    const emitPart = (part: Part) => emit({ type: 'message.part', ...base, part })
    const finish = (status: 'done' | 'stopped' | 'error', error?: AiErrorInfo) => {
      running.delete(msg.id)
      msg.status = status
      if (error) msg.error = error
      conv.updatedAt = Date.now()
      emit({ type: 'message.done', ...base, status, error })
      emit({ type: 'conversation.updated', summary: summary(conv) })
    }
    for (const step of steps) {
      await sleep(fake.delay)
      if (run.stopped) return finish('stopped')
      if ('text' in step) {
        for (const piece of chunks(step.text, 4)) {
          if (run.stopped) return finish('stopped')
          appendText(msg, piece)
          emit({ type: 'message.delta', ...base, text: piece })
          await sleep(fake.delay)
        }
      } else if ('skill' in step) {
        const part: Part = { type: 'skill', name: step.skill }
        msg.parts.push(part)
        emitPart(part)
      } else if ('tool' in step) {
        const info = toolInfo(step)
        const part: ToolCallPart = { type: 'tool_call', callId: fakeId(), tool: step.tool, input: step.input ?? {}, status: 'pending' }
        msg.parts.push(part)
        const policy = settings.toolPolicies[step.tool] ?? 'ask'
        if (policy === 'deny') {
          part.status = 'denied'
          part.error = '已被用户禁用'
          emitPart(part)
          continue
        }
        if (policy === 'ask') {
          msg.status = 'waiting'
          emitPart(part)
          emit({ type: 'tool.request', ...base, callId: part.callId, tool: info, input: part.input })
          const d = await waitDecision(part.callId, run)
          if (!d) return finish('stopped')
          msg.status = 'streaming'
          if (d.decision === 'always') settings.toolPolicies[step.tool] = 'allow'
          if (d.decision === 'deny') {
            part.status = 'denied'
            emitPart(part)
            continue
          }
        }
        part.status = 'running'
        emitPart(part)
        await sleep(fake.delay)
        if (step.fail) {
          part.status = 'error'
          part.error = step.fail
        } else {
          part.status = 'done'
          part.result = step.result ?? '完成'
        }
        emitPart(part)
      } else if ('edit' in step) {
        const part: ToolCallPart = { type: 'tool_call', callId: fakeId(), tool: 'typoza__edit_document', input: step.edit, status: 'pending' }
        msg.parts.push(part)
        msg.status = 'waiting'
        emitPart(part)
        emit({ type: 'doc.edit', ...base, callId: part.callId, edit: step.edit })
        const d = await waitDecision(part.callId, run)
        if (!d) return finish('stopped')
        msg.status = 'streaming'
        part.status = d.decision === 'deny' ? 'denied' : 'done'
        part.result = d.result
        emitPart(part)
      } else if ('error' in step) {
        return finish('error', step.error)
      } else {
        await waitHold(run)
        if (run.stopped) return finish('stopped')
      }
    }
    finish('done')
  }

  async function runComplete(requestId: string, steps: FakeStep[]): Promise<void> {
    const run: Run = { stopped: false }
    running.set(requestId, run)
    const finish = (status: 'done' | 'stopped' | 'error', error?: AiErrorInfo) => {
      running.delete(requestId)
      emit({ type: 'complete.done', requestId, status, error })
    }
    for (const step of steps) {
      await sleep(fake.delay)
      if (run.stopped) return finish('stopped')
      if ('text' in step) {
        for (const piece of chunks(step.text, 4)) {
          if (run.stopped) return finish('stopped')
          emit({ type: 'complete.delta', requestId, text: piece })
          await sleep(fake.delay)
        }
      } else if ('error' in step) {
        return finish('error', step.error)
      } else if ('hold' in step) {
        await waitHold(run)
        if (run.stopped) return finish('stopped')
      }
    }
    finish('done')
  }

  const stopRun = (id: string) => {
    const run = running.get(id)
    if (!run) return
    run.stopped = true
    run.wake?.()
  }

  const newAssistantMessage = (parentId: string | null): Message => ({
    id: fakeId(),
    parentId,
    role: 'assistant',
    parts: [],
    model: settings.defaultModel,
    status: 'streaming',
    createdAt: Date.now(),
  })

  const methods: Record<string, (p: Record<string, unknown>) => unknown> = {
    'ai.settings.get': () => readSettings(),
    'ai.settings.update': (p) => {
      const next = { ...settings } as Record<string, unknown>
      for (const [key, value] of Object.entries(p)) {
        if (!(key in settings) && !['defaultModel', 'fastModel'].includes(key)) fail('invalid', `未知的设置项:${key}`)
        next[key] = structuredClone(value)
      }
      settings = next as unknown as AiSettings
      // hasKey 只读:以钥匙串为准
      for (const pr of settings.providers) pr.hasKey = false
      return readSettings()
    },
    'ai.secret.set': (p) => {
      const ref = str(p, 'ref')
      if (!ref) fail('invalid', '缺少 ref')
      const value = str(p, 'value')
      if (value) secrets.set(ref, value)
      else secrets.delete(ref)
      return {}
    },
    'ai.provider.models': (p) => {
      provider(str(p, 'providerId'))
      return { models: [{ id: 'fake-model', name: '模拟模型', tools: true }, { id: 'fake-mini', name: '模拟快速模型' }, { id: 'fake-vision', name: '模拟看图模型', vision: true }] }
    },
    'ai.provider.test': (p) => {
      const pr = provider(str(p, 'providerId'))
      if (!pr.models.some((m) => m.id === str(p, 'modelId'))) fail('invalid', '请先选择要检测的模型')
      return { ok: true, latencyMs: 42 }
    },

    'ai.chat.send': (p) => {
      if (!usable()) fail('not_configured', '请先在设置 ▸ AI 服务商中添加模型')
      const text = str(p, 'text')
      let conv = str(p, 'conversationId') ? conversation(str(p, 'conversationId')) : null
      if (!conv) {
        const now = Date.now()
        conv = { id: fakeId(), title: [...text].slice(0, 20).join('') || '新对话', assistantId: str(p, 'assistantId') || settings.defaultAssistantId, createdAt: now, updatedAt: now, messages: {}, leafId: null }
        conversations.set(conv.id, conv)
      }
      const parentId = str(p, 'parentId') || conv.leafId
      const user: Message = { id: fakeId(), parentId, role: 'user', parts: [{ type: 'text', text }], status: 'done', context: (p.context as Message['context']) ?? [], createdAt: Date.now() }
      const answer = newAssistantMessage(user.id)
      conv.messages[user.id] = user
      conv.messages[answer.id] = answer
      conv.leafId = answer.id
      conv.updatedAt = Date.now()
      const c = conv
      void runChat(c, answer, nextScript(`这是模拟回答:${text}`))
      emit({ type: 'conversation.updated', summary: summary(c) })
      return { conversationId: c.id, userMessageId: user.id, assistantMessageId: answer.id }
    },
    'ai.chat.regenerate': (p) => {
      const conv = conversation(str(p, 'conversationId'))
      const old = conv.messages[str(p, 'messageId')] ?? fail('not_found', '消息不存在')
      if (old.role !== 'assistant') fail('invalid', '只能重新生成回答')
      const answer = newAssistantMessage(old.parentId)
      // 同一毫秒里重新生成也要排在原回答之后
      answer.createdAt = Math.max(Date.now(), old.createdAt + 1)
      conv.messages[answer.id] = answer
      conv.leafId = answer.id
      void runChat(conv, answer, nextScript('这是重新生成的模拟回答'))
      return { assistantMessageId: answer.id }
    },
    'ai.chat.stop': (p) => {
      stopRun(str(p, 'messageId'))
      return {}
    },
    'ai.chat.setLeaf': (p) => {
      const conv = conversation(str(p, 'conversationId'))
      const leaf = typeof p.leafId === 'string' ? p.leafId : null
      if (leaf && !conv.messages[leaf]) fail('not_found', '消息不存在')
      conv.leafId = leaf
      return conv
    },
    'ai.tool.decide': (p) => {
      const resolve = decisions.get(str(p, 'callId')) ?? fail('not_found', '这个工具调用已经结束')
      const decision = str(p, 'decision')
      if (decision !== 'allow' && decision !== 'always' && decision !== 'deny') fail('invalid', `未知的决定:${decision}`)
      resolve({ decision: decision as Decision['decision'], result: typeof p.result === 'string' ? p.result : undefined })
      return {}
    },
    'ai.conversations.list': () => ({ items: [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary) }),
    'ai.conversations.get': (p) => conversation(str(p, 'id')),
    'ai.conversations.rename': (p) => {
      const conv = conversation(str(p, 'id'))
      conv.title = str(p, 'title')
      conv.updatedAt = Date.now()
      emit({ type: 'conversation.updated', summary: summary(conv) })
      return {}
    },
    'ai.conversations.delete': (p) => {
      if (!conversations.delete(str(p, 'id'))) fail('not_found', '对话不存在')
      return {}
    },
    'ai.conversations.clear': () => {
      conversations.clear()
      return {}
    },

    'ai.complete': (p) => {
      if (!usable()) fail('not_configured', '请先在设置 ▸ AI 服务商中添加模型')
      const requestId = str(p, 'requestId') || fail('invalid', '缺少 requestId')
      void runComplete(requestId, nextScript(`模拟结果:${str(p, 'prompt').slice(0, 20)}`))
      return {}
    },
    'ai.complete.stop': (p) => {
      stopRun(str(p, 'requestId'))
      return {}
    },

    'ai.mcp.status': () => ({ servers: settings.mcpServers.map(mcpStatus) }),
    'ai.mcp.restart': (p) => {
      const server = settings.mcpServers.find((s) => s.id === str(p, 'serverId')) ?? fail('not_found', '没有这个 MCP 服务器')
      const status = mcpStatus(server)
      emit({ type: 'mcp.status', status })
      return status
    },
    'ai.mcp.import': (p) => {
      let data: unknown
      try {
        data = JSON.parse(str(p, 'json'))
      } catch (err) {
        return fail('invalid', `JSON 格式不对:${err instanceof Error ? err.message : String(err)}`)
      }
      const servers = (data as { mcpServers?: Record<string, Record<string, unknown>> } | null)?.mcpServers
      if (!servers || typeof servers !== 'object') return fail('invalid', '找不到 mcpServers')
      const added: string[] = []
      for (const [name, cfg] of Object.entries(servers)) {
        const http = typeof cfg.url === 'string'
        settings.mcpServers.push({
          id: fakeId(),
          name,
          enabled: true,
          transport: http ? 'http' : 'stdio',
          command: http ? undefined : String(cfg.command ?? ''),
          args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
          url: http ? String(cfg.url) : undefined,
        })
        added.push(name)
      }
      return { added }
    },
    'ai.mcp.prompt': (p) => ({ text: `请用三句话总结要点。(来自 ${str(p, 'serverId')} 的提示词 ${str(p, 'name')})` }),
    'ai.mcp.resource': (p) => ({ text: `演示资源 ${str(p, 'uri')} 的内容` }),
    'ai.tools.list': () => ({
      tools: [
        ...BUILTIN_TOOLS.filter((t) => (t.name === 'typoza__fetch_url' ? settings.connectors.web : true)),
        ...settings.mcpServers.flatMap((s) => mcpStatus(s).tools),
      ],
    }),
    'ai.skills.list': () => ({ skills }),
    'ai.skills.install': (p) => {
      const path = str(p, 'path')
      const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.zip$/i, '')
      if (!name) fail('invalid', '请选择技能文件夹或 ZIP')
      if (skills.some((s) => s.name === name)) fail('invalid', `已有同名技能:${name}`)
      const skill: Skill = { name, description: `从 ${path} 安装的技能`, path: `/Users/test/Library/Application Support/Typoza/skills/${name}`, hasScripts: /script/i.test(name), source: 'typoza' }
      skills = [...skills, skill]
      return skill
    },
    'ai.skills.remove': (p) => {
      const before = skills.length
      skills = skills.filter((s) => s.name !== str(p, 'name'))
      if (skills.length === before) fail('not_found', '没有这个技能')
      return {}
    },
  }

  const fake: FakeAi = {
    scripts: [],
    calls: [],
    delay: 15,
    get settings() {
      return readSettings()
    },
    conversations,
    async call(method, params) {
      fake.calls.push({ method, params: method === 'ai.secret.set' ? { ...params, value: params.value ? '***' : '' } : structuredClone(params) })
      // 外壳的禁止名单:密钥只由外壳推给辅助进程
      if (method === 'ai.secrets' || !method.startsWith('ai.')) fail('invalid', `不允许调用 ${method}`)
      const fn = methods[method] ?? fail('not_found', `未知方法:${method}`)
      return structuredClone(fn(params))
    },
    subscribe(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    secretRefs: () => [...secrets.keys()],
    reset(options = {}) {
      settings = defaultSettings(options.configured ?? true)
      skills = defaultSkills()
    },
    release() {
      const list = holds
      holds = []
      for (const fn of list) fn()
    },
  }
  return fake
}
