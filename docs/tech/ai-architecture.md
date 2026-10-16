# Typoza AI 版技术方案

> 版本 v0.1 · 2026-10-16 · 研发。产品口径见 `docs/prd/ai-prd.md`;基础版架构见 `architecture.md`。
> 本文第 3 节是三方(网页 / 外壳 / 辅助进程)之间的**接口契约**,各模块按此实现,改动要先改本文。

## 1. 分工

| 部分 | 做什么 | 位置 |
|---|---|---|
| 辅助进程(Go) | 服务商适配与流式请求、对话存储与分支、工具调用循环、MCP 客户端、内置连接器、Skills 读取、助手与 AI 设置存储 | `helper/internal/aisvc/` |
| 外壳(Swift) | 把网页的 `ai.*` 转给辅助进程并把 `ai.*` 通知广播给窗口;钥匙串存取 AI 密钥(服务 `app.typoza.mac.ai`);菜单「AI」 | `HelperManager`、`AISecrets`(TypozaKit)、`MainMenu` |
| 网页(TS) | AI 侧栏、选中文字动作、`/ai` 与空行空格、工具卡片与改文档的差异预览、AI 设置页;浏览器宿主用模拟实现 | `editor/src/ai/`、`editor/src/host/ai-types.ts`、`editor/src/host/fake-ai.ts` |

- 为什么在辅助进程里发请求:网页从 `typoza://app` 发往外部 API 受跨源限制,密钥也不该进网页;Go 擅长流式 HTTP 与子进程管理(stdio MCP)。
- 辅助进程按需启动:第一次调用 `ai.*` 时由外壳拉起(与云同步共用同一个进程)。

## 2. 数据存放

| 内容 | 位置 | 说明 |
|---|---|---|
| AI 设置(服务商、模型、助手、AI 动作、MCP 服务器、工具权限、技能开关) | `~/Library/Application Support/Typoza/ai/settings.json` | 不含密钥;密钥字段只存引用名 `secretRef` |
| 对话 | `~/Library/Application Support/Typoza/ai/conversations/<id>.json` | 一个对话一个文件,原子写(先写临时文件再改名) |
| 技能 | `~/Library/Application Support/Typoza/skills/<name>/SKILL.md` | 可选再读 `~/.agents/skills/` |
| 密钥 | 钥匙串:服务 `app.typoza.mac.ai`,账户 = `secretRef` | 外壳启动辅助进程后以 `ai.secrets` 推送;网页只能写、不能读 |

`secretRef` 取值:服务商密钥 `provider:<providerId>`;MCP 环境变量或请求头 `mcp:<serverId>:<name>`;MCP OAuth 令牌 `mcp-oauth:<serverId>`。

## 3. 接口契约

### 3.1 通用约定

- 网页 → 外壳:`host.aiCall(method, params)`,外壳只放行 `ai.` 开头且不在禁止名单(`ai.secrets`)里的方法,转给辅助进程;返回与云同步一致:`{ok: true, result}` 或 `{ok: false, error: {code, message}}`。
- 辅助进程 → 网页的通知:辅助进程发 `ai.event`,外壳原样广播给所有窗口,网页 `host.onAiEvent(cb)` 收到 `{type, ...}`。
- 时间一律毫秒时间戳(number);ID 一律字符串(辅助进程生成,随机 12 字节 base32 小写)。
- 错误码:`not_configured`(没有可用模型)、`auth`(401/403)、`rate_limit`(429)、`network`、`provider`(服务商返回的其他错误,message 带原文)、`invalid`(参数不合法)、`not_found`、`cancelled`、`internal`。

### 3.2 数据结构(JSON,字段名即契约)

```ts
type Protocol = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini'

interface Provider { id: string; name: string; protocol: Protocol; baseUrl: string; enabled: boolean;
  hasKey: boolean /* 只读:钥匙串里有没有密钥 */; models: ModelInfo[] }
interface ModelInfo { id: string; name?: string; tools?: boolean; vision?: boolean }
interface ModelRef { providerId: string; modelId: string }

interface Assistant { id: string; name: string; icon?: string; systemPrompt: string; model?: ModelRef;
  temperature?: number; topP?: number; maxTokens?: number; skills: string[] /* 技能名 */; mcpServers: string[] /* serverId */ }

interface AiAction { id: string; name: string; prompt: string /* 可含 {{selection}} {{document}} {{language}} */; model?: ModelRef }

interface McpServer { id: string; name: string; enabled: boolean;
  transport: 'stdio' | 'http'; command?: string; args?: string[]; env?: Record<string, string> /* 值为空串表示在钥匙串 */;
  url?: string; headers?: Record<string, string> /* 同上 */ }
type ToolPolicy = 'allow' | 'ask' | 'deny'

interface AiSettings { providers: Provider[]; defaultModel?: ModelRef; fastModel?: ModelRef; assistants: Assistant[];
  defaultAssistantId: string; actions: AiAction[]; mcpServers: McpServer[];
  toolPolicies: Record<string, ToolPolicy> /* 键 = 工具全名 */; connectors: { folder: boolean; web: boolean };
  skillsEnabled: boolean; readAgentsSkills: boolean; disabledSkills: string[]; spaceTriggersAi: boolean }

// 工具全名:外部 MCP 为 `mcp__<serverId>__<toolName>`;内置为 `typoza__<name>`
interface ToolInfo { name: string; title: string; description: string; source: string /* 服务器名或「内置」 */; inputSchema: unknown }

interface Part { type: 'text'; text: string } | { type: 'tool_call'; callId: string; tool: string; input: unknown;
    status: 'pending' | 'running' | 'done' | 'error' | 'denied'; result?: string; error?: string }
  | { type: 'skill'; name: string }
interface Message { id: string; parentId: string | null; role: 'user' | 'assistant'; parts: Part[];
  model?: ModelRef; status: 'streaming' | 'waiting' | 'done' | 'stopped' | 'error'; error?: { code: string; message: string };
  context?: ContextItem[] /* 仅用户消息:随消息发出的上下文 */; createdAt: number }
interface ContextItem { kind: 'document' | 'selection' | 'file' | 'conversation' | 'resource'; title: string;
  path?: string; text?: string /* document / selection 由网页给出原文 */; ref?: string }
interface Conversation { id: string; title: string; assistantId: string; createdAt: number; updatedAt: number;
  messages: Record<string, Message>; leafId: string | null /* 当前显示的分支末端 */ }
interface ConversationSummary { id: string; title: string; updatedAt: number }
interface Skill { name: string; description: string; path: string; hasScripts: boolean; source: 'typoza' | 'agents'; error?: string }
interface McpStatus { serverId: string; state: 'connected' | 'connecting' | 'failed' | 'disabled'; error?: string;
  tools: ToolInfo[]; prompts: { name: string; description?: string }[]; resources: { uri: string; name: string }[]; log: string[] }
```

### 3.3 方法(网页可调用)

| 方法 | 参数 | 结果 |
|---|---|---|
| `ai.settings.get` | — | `AiSettings` |
| `ai.settings.update` | `Partial<AiSettings>`(整体替换给出的字段) | `AiSettings` |
| `ai.secret.set` | `{ref, value}`;value 为空串表示删除 | `{}`(**外壳处理**:写钥匙串后以 `ai.secrets` 转告辅助进程,不经网页回读) |
| `ai.provider.models` | `{providerId}` | `{models: ModelInfo[]}`(调服务商模型列表接口) |
| `ai.provider.test` | `{providerId, modelId}` | `{ok: true, latencyMs}`;失败按错误码返回 |
| `ai.chat.send` | `{conversationId?, parentId?, assistantId?, model?, text, context: ContextItem[]}`:不给 conversationId 则新建对话;parentId 为空则接在当前 leaf 后 | `{conversationId, userMessageId, assistantMessageId}`,随后以事件流式推送 |
| `ai.chat.regenerate` | `{conversationId, messageId}`(要重新生成的回答) | `{assistantMessageId}`(新版本与原回答同父) |
| `ai.chat.stop` | `{conversationId, messageId}` | `{}` |
| `ai.chat.setLeaf` | `{conversationId, leafId}`(切换分支 / 版本) | `Conversation` |
| `ai.tool.decide` | `{conversationId, callId, decision: 'allow' \| 'always' \| 'deny', result?: string}`;`result` 只用于网页执行的工具(改文档)回报结果 | `{}` |
| `ai.conversations.list` | — | `{items: ConversationSummary[]}`(按更新时间倒序) |
| `ai.conversations.get` | `{id}` | `Conversation` |
| `ai.conversations.rename` / `delete` | `{id, title}` / `{id}` | `{}` |
| `ai.conversations.clear` | — | `{}`(删除全部对话) |
| `ai.complete` | `{requestId, actionId?, prompt?, selection?, document?, cursor?: number, model?}`:选中文字动作与 `/ai` 用;不入对话 | `{}`,结果以 `complete.*` 事件流式推送 |
| `ai.complete.stop` | `{requestId}` | `{}` |
| `ai.mcp.status` | — | `{servers: McpStatus[]}` |
| `ai.mcp.restart` | `{serverId}` | `McpStatus` |
| `ai.mcp.import` | `{json}`(`{"mcpServers": {...}}` 格式) | `{added: string[]}` |
| `ai.mcp.prompt` | `{serverId, name, args?}` | `{text}`(展开后的提示词) |
| `ai.mcp.resource` | `{serverId, uri}` | `{text}` |
| `ai.tools.list` | `{assistantId?}` | `{tools: ToolInfo[]}`(当前可用的全部工具,含内置) |
| `ai.skills.list` | — | `{skills: Skill[]}` |
| `ai.skills.install` | `{path}`(文件夹或 .zip 的绝对路径) | `Skill` |
| `ai.skills.remove` | `{name}` | `{}` |

### 3.4 事件(`ai.event` 的 params)

| type | 字段 | 说明 |
|---|---|---|
| `message.delta` | `conversationId, messageId, text` | 回答的文字增量 |
| `message.part` | `conversationId, messageId, part: Part` | 新增或更新一个部件(工具调用状态变化、用到技能) |
| `message.done` | `conversationId, messageId, status, error?` | 一条回答结束(done / stopped / error) |
| `conversation.updated` | `summary: ConversationSummary` | 标题、更新时间变化 |
| `tool.request` | `conversationId, messageId, callId, tool: ToolInfo, input` | 需要用户确认(权限为 ask)。用户回 `ai.tool.decide` |
| `doc.edit` | `conversationId, messageId, callId, edit: {kind: 'replace_all' \| 'replace_range' \| 'insert', text, from?, to?, find?}` | 模型要改当前文档;网页展示差异,用户确认后自行写入,用 `ai.tool.decide` 带 `result` 回报 |
| `complete.delta` / `complete.done` | `requestId, text` / `requestId, status, error?` | `ai.complete` 的流式结果 |
| `mcp.status` | `status: McpStatus` | 某服务器状态变化 |

### 3.5 外壳与辅助进程之间

| 方法 | 方向 | 说明 |
|---|---|---|
| `ai.secrets` | 外壳 → 辅助进程 | `{secrets: Record<secretRef, string>}`,启动后与每次 `ai.secret.set` 后全量推送 |
| `host.openURL` | 辅助进程 → 外壳(请求) | `{url}`:MCP OAuth 与征询的网址交给系统浏览器 |
| `host.elicit` | 辅助进程 → 外壳(请求) | `{serverId, message, schema}` → `{action: 'accept' \| 'decline' \| 'cancel', content?}`;外壳弹原生表单 |

## 4. 关键实现

- **服务商适配**:四种协议各一个适配器,统一成内部消息(文本、工具调用、工具结果)。流式一律走 SSE:Anthropic `content_block_delta`(`text_delta` / `input_json_delta`)、OpenAI Chat `choices[].delta`(`content` / `tool_calls`)、OpenAI Responses `response.output_text.delta` 与 `function_call` 项、Gemini `streamGenerateContent?alt=sse` 的 `parts`(`text` / `functionCall`)。地址末尾 `#` 表示原样使用。多个密钥按 401 / 429 轮换。
- **工具循环**:模型给出工具调用 → 查权限(deny 直接回「已被用户禁用」;ask 发 `tool.request` 等决定;allow 执行)→ 结果交回模型 → 再请求,最多 20 轮;单次结果超过 20000 字截断并注明。
- **内置工具**:`typoza__list_documents` / `typoza__search_documents` / `typoza__read_document`(连接器「当前文件夹」,文件夹由网页随消息带上)、`typoza__edit_document`(改当前文档,走 `doc.edit`,始终需确认)、`typoza__read_skill`(读取技能正文或资源文件)、`typoza__fetch_url`(连接器「网页读取」,默认关)。
- **Skills**:每轮把启用技能的 `name` + `description` 放进系统提示词;模型调用 `typoza__read_skill` 读取正文(渐进加载);不执行 `scripts/`。
- **MCP**:用官方 Go SDK(`github.com/modelcontextprotocol/go-sdk`)的客户端,支持 stdio 与 Streamable HTTP;stdio 服务器的标准错误进状态日志(保留末尾 200 行)。
- **对话分支**:消息以 `parentId` 连成树;`leafId` 决定显示哪条路线;发送 / 重新生成都只追加节点,不改已有节点。

## 5. 测试

- Go:四种协议的模拟服务商(httptest,按脚本吐 SSE)、对话分支、工具循环(允许 / 拒绝 / 总是允许 / 禁用 / 轮次上限)、MCP(SDK 的内存传输 + httptest 的 Streamable HTTP 服务器)、Skills 解析(合规 / 不合规)、设置读写不含密钥。
- 网页:`host/fake-ai.ts` 按脚本模拟事件流;Playwright 覆盖侧栏对话与分支、工具卡片、选中文字改写、`/ai`、设置页。
- 外壳:`swift test` 覆盖 `ai.*` 转发白名单、密钥写入后推送。
