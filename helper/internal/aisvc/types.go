package aisvc

import (
	"encoding/json"
)

// 本文件的结构体与 JSON 字段名就是契约(docs/tech/ai-architecture.md 3.2),改名前先改契约。

// 接口协议(Provider.protocol)。
const (
	protoAnthropic       = "anthropic"
	protoOpenAIChat      = "openai-chat"
	protoOpenAIResponses = "openai-responses"
	protoGemini          = "gemini"
)

// 工具权限(AiSettings.toolPolicies 的值)。
const (
	policyAllow = "allow"
	policyAsk   = "ask"
	policyDeny  = "deny"
)

// 消息状态。
const (
	statusStreaming = "streaming"
	statusWaiting   = "waiting"
	statusDone      = "done"
	statusStopped   = "stopped"
	statusError     = "error"
)

// 工具调用部件状态。
const (
	callPending = "pending"
	callRunning = "running"
	callDone    = "done"
	callError   = "error"
	callDenied  = "denied"
)

type Provider struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	Protocol string      `json:"protocol"`
	BaseURL  string      `json:"baseUrl"`
	Enabled  bool        `json:"enabled"`
	HasKey   bool        `json:"hasKey"` // 只读:读设置时按内存里的密钥算出,写盘时恒为 false
	Models   []ModelInfo `json:"models"`
}

type ModelInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name,omitempty"`
	Tools  *bool  `json:"tools,omitempty"`
	Vision *bool  `json:"vision,omitempty"`
}

type ModelRef struct {
	ProviderID string `json:"providerId"`
	ModelID    string `json:"modelId"`
}

type Assistant struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Icon         string    `json:"icon,omitempty"`
	SystemPrompt string    `json:"systemPrompt"`
	Model        *ModelRef `json:"model,omitempty"`
	Temperature  *float64  `json:"temperature,omitempty"`
	TopP         *float64  `json:"topP,omitempty"`
	MaxTokens    *int      `json:"maxTokens,omitempty"`
	Skills       []string  `json:"skills"`
	MCPServers   []string  `json:"mcpServers"`
}

type AIAction struct {
	ID     string    `json:"id"`
	Name   string    `json:"name"`
	Prompt string    `json:"prompt"`
	Model  *ModelRef `json:"model,omitempty"`
}

type MCPServer struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Enabled   bool              `json:"enabled"`
	Transport string            `json:"transport"` // stdio | http
	Command   string            `json:"command,omitempty"`
	Args      []string          `json:"args,omitempty"`
	Env       map[string]string `json:"env,omitempty"` // 值为空串表示在钥匙串(mcp:<serverId>:<name>)
	URL       string            `json:"url,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"` // 同 Env
}

type Connectors struct {
	Folder bool `json:"folder"`
	Web    bool `json:"web"`
}

type Settings struct {
	Providers          []Provider        `json:"providers"`
	DefaultModel       *ModelRef         `json:"defaultModel,omitempty"`
	FastModel          *ModelRef         `json:"fastModel,omitempty"`
	Assistants         []Assistant       `json:"assistants"`
	DefaultAssistantID string            `json:"defaultAssistantId"`
	Actions            []AIAction        `json:"actions"`
	MCPServers         []MCPServer       `json:"mcpServers"`
	ToolPolicies       map[string]string `json:"toolPolicies"`
	Connectors         Connectors        `json:"connectors"`
	SkillsEnabled      bool              `json:"skillsEnabled"`
	ReadAgentsSkills   bool              `json:"readAgentsSkills"`
	DisabledSkills     []string          `json:"disabledSkills"`
	SpaceTriggersAI    bool              `json:"spaceTriggersAi"`
}

// ToolInfo 描述一个可用工具。工具全名:外部 MCP 为 mcp__<serverId>__<toolName>,内置为 typoza__<name>。
type ToolInfo struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Source      string `json:"source"`
	InputSchema any    `json:"inputSchema"`
}

// 部件类型。
const (
	partText     = "text"
	partToolCall = "tool_call"
	partSkill    = "skill"
)

// Part 是消息里的一个部件:文字、工具调用或「用到了某个技能」。三种形状共用一个结构体,
// 编码时按类型只写出该类型的字段。
type Part struct {
	Type   string          `json:"type"`
	Text   string          `json:"text,omitempty"`
	CallID string          `json:"callId,omitempty"`
	Tool   string          `json:"tool,omitempty"`
	Input  json.RawMessage `json:"input,omitempty"`
	Status string          `json:"status,omitempty"`
	Result *string         `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
	Name   string          `json:"name,omitempty"`
}

func (p Part) MarshalJSON() ([]byte, error) {
	switch p.Type {
	case partText:
		return json.Marshal(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{p.Type, p.Text})
	case partSkill:
		return json.Marshal(struct {
			Type string `json:"type"`
			Name string `json:"name"`
		}{p.Type, p.Name})
	default:
		input := p.Input
		if len(input) == 0 {
			input = json.RawMessage("{}")
		}
		return json.Marshal(struct {
			Type   string          `json:"type"`
			CallID string          `json:"callId"`
			Tool   string          `json:"tool"`
			Input  json.RawMessage `json:"input"`
			Status string          `json:"status"`
			Result *string         `json:"result,omitempty"`
			Error  string          `json:"error,omitempty"`
		}{p.Type, p.CallID, p.Tool, input, p.Status, p.Result, p.Error})
	}
}

type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ContextItem struct {
	Kind  string `json:"kind"` // document | selection | file | conversation | resource
	Title string `json:"title"`
	Path  string `json:"path,omitempty"`
	Text  string `json:"text,omitempty"`
	Ref   string `json:"ref,omitempty"`
}

type Message struct {
	ID        string        `json:"id"`
	ParentID  *string       `json:"parentId"`
	Role      string        `json:"role"` // user | assistant
	Parts     []Part        `json:"parts"`
	Model     *ModelRef     `json:"model,omitempty"`
	Status    string        `json:"status"`
	Error     *ErrorInfo    `json:"error,omitempty"`
	Context   []ContextItem `json:"context,omitempty"`
	CreatedAt int64         `json:"createdAt"`
}

type Conversation struct {
	ID          string              `json:"id"`
	Title       string              `json:"title"`
	AssistantID string              `json:"assistantId"`
	CreatedAt   int64               `json:"createdAt"`
	UpdatedAt   int64               `json:"updatedAt"`
	Messages    map[string]*Message `json:"messages"`
	LeafID      *string             `json:"leafId"`
}

type ConversationSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Skill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Path        string `json:"path"` // 技能目录
	HasScripts  bool   `json:"hasScripts"`
	Source      string `json:"source"` // typoza | agents
	Error       string `json:"error,omitempty"`
}

// PromptInfo 是 MCP 服务器提供的提示词。arguments 是契约之外新增的字段:网页调 ai.mcp.prompt 前要知道该填哪些参数。
type PromptInfo struct {
	Name        string           `json:"name"`
	Description string           `json:"description,omitempty"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}

type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

type ResourceInfo struct {
	URI  string `json:"uri"`
	Name string `json:"name"`
}

// MCP 服务器状态。
const (
	mcpConnected  = "connected"
	mcpConnecting = "connecting"
	mcpFailed     = "failed"
	mcpDisabled   = "disabled"
)

type MCPStatus struct {
	ServerID  string         `json:"serverId"`
	State     string         `json:"state"`
	Error     string         `json:"error,omitempty"`
	Tools     []ToolInfo     `json:"tools"`
	Prompts   []PromptInfo   `json:"prompts"`
	Resources []ResourceInfo `json:"resources"`
	Log       []string       `json:"log"`
}
