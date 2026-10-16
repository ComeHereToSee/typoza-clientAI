// AI 接口契约:网页 ↔ 外壳 ↔ 辅助进程(helper/internal/aisvc)。字段名、方法名、事件名以 docs/tech/ai-architecture.md 第 3 节为准,不得自行改名。
// 时间一律毫秒时间戳;ID 一律字符串。

export type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'

export interface ModelInfo {
  id: string
  name?: string
  tools?: boolean
  vision?: boolean
}

export interface Provider {
  id: string
  name: string
  protocol: Protocol
  baseUrl: string
  enabled: boolean
  /** 只读:钥匙串里有没有密钥(网页只能写密钥,读不到值) */
  hasKey: boolean
  models: ModelInfo[]
}

export interface ModelRef {
  providerId: string
  modelId: string
}

export interface Assistant {
  id: string
  name: string
  icon?: string
  systemPrompt: string
  model?: ModelRef
  temperature?: number
  topP?: number
  maxTokens?: number
  /** 技能名 */
  skills: string[]
  /** serverId */
  mcpServers: string[]
}

export interface AiAction {
  id: string
  name: string
  /** 可含 {{selection}} {{document}} {{language}} */
  prompt: string
  model?: ModelRef
}

export interface McpServer {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  /** 值为空串表示在钥匙串(引用名 mcp:<serverId>:<name>) */
  env?: Record<string, string>
  url?: string
  /** 同上 */
  headers?: Record<string, string>
}

export type ToolPolicy = 'allow' | 'ask' | 'deny'

export interface AiSettings {
  providers: Provider[]
  defaultModel?: ModelRef
  fastModel?: ModelRef
  assistants: Assistant[]
  defaultAssistantId: string
  actions: AiAction[]
  mcpServers: McpServer[]
  /** 键 = 工具全名 */
  toolPolicies: Record<string, ToolPolicy>
  connectors: { folder: boolean; web: boolean }
  skillsEnabled: boolean
  readAgentsSkills: boolean
  disabledSkills: string[]
  spaceTriggersAi: boolean
}

/** 工具全名:外部 MCP 为 mcp__<serverId>__<toolName>;内置为 typoza__<name> */
export interface ToolInfo {
  name: string
  title: string
  description: string
  /** 服务器名或「内置」 */
  source: string
  inputSchema: unknown
}

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error' | 'denied'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  callId: string
  tool: string
  input: unknown
  status: ToolCallStatus
  result?: string
  error?: string
}

export interface SkillPart {
  type: 'skill'
  name: string
}

export type Part = TextPart | ToolCallPart | SkillPart

export type MessageStatus = 'streaming' | 'waiting' | 'done' | 'stopped' | 'error'

export interface AiErrorInfo {
  code: string
  message: string
}

export interface ContextItem {
  kind: 'document' | 'selection' | 'file' | 'conversation' | 'resource'
  title: string
  path?: string
  /** document / selection 由网页给出原文 */
  text?: string
  ref?: string
}

export interface Message {
  id: string
  parentId: string | null
  role: 'user' | 'assistant'
  parts: Part[]
  model?: ModelRef
  status: MessageStatus
  error?: AiErrorInfo
  /** 仅用户消息:随消息发出的上下文 */
  context?: ContextItem[]
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  assistantId: string
  createdAt: number
  updatedAt: number
  messages: Record<string, Message>
  /** 当前显示的分支末端 */
  leafId: string | null
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
}

export interface Skill {
  name: string
  description: string
  path: string
  hasScripts: boolean
  source: 'typoza' | 'agents'
  error?: string
}

export interface McpStatus {
  serverId: string
  state: 'connected' | 'connecting' | 'failed' | 'disabled'
  error?: string
  tools: ToolInfo[]
  prompts: { name: string; description?: string }[]
  resources: { uri: string; name: string }[]
  log: string[]
}

/** doc.edit 的改动。from / to 为当前文档 Markdown 原文(换行统一为 \n)里的字符偏移【假设,见 ai-web 报告】 */
export interface DocEdit {
  kind: 'replace_all' | 'replace_range' | 'insert'
  text: string
  from?: number
  to?: number
  find?: string
}

export type AiDoneStatus = 'done' | 'stopped' | 'error'

/** ai.event 的 params(外壳原样广播给所有窗口) */
export type AiEvent =
  | { type: 'message.delta'; conversationId: string; messageId: string; text: string }
  | { type: 'message.part'; conversationId: string; messageId: string; part: Part }
  | { type: 'message.done'; conversationId: string; messageId: string; status: AiDoneStatus; error?: AiErrorInfo }
  | { type: 'conversation.updated'; summary: ConversationSummary }
  | { type: 'tool.request'; conversationId: string; messageId: string; callId: string; tool: ToolInfo; input: unknown }
  | { type: 'doc.edit'; conversationId: string; messageId: string; callId: string; edit: DocEdit }
  | { type: 'complete.delta'; requestId: string; text: string }
  | { type: 'complete.done'; requestId: string; status: AiDoneStatus; error?: AiErrorInfo }
  | { type: 'mcp.status'; status: McpStatus }

/** ai.chat.send 的结果 */
export interface ChatSendResult {
  conversationId: string
  userMessageId: string
  assistantMessageId: string
}

/** 外壳回给网页的统一结果(与云同步一致) */
export type AiCallReply = { ok: true; result: unknown } | { ok: false; error?: AiErrorInfo }

/** AI 调用失败:code 为契约里的错误码(not_configured、auth、rate_limit、network、provider、invalid、not_found、cancelled、internal),message 可直接展示。 */
export class AiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AiError'
  }
}
