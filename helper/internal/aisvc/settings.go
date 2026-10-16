package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

// defaultAssistantID 是内置「写作助手」的 ID(固定,便于网页识别)。
const defaultAssistantID = "writing"

const writerSystemPrompt = `你是 Typoza 编辑器里的写作助手。用户用 Markdown 写作,会把当前文档、选中的文字或其他文档作为上下文发给你。
- 回答用 Markdown,语言跟随用户。
- 用户要你改写、续写、整理内容时,直接给出可以放进文档的成稿,少说套话。
- 需要直接修改当前文档时,用修改文档的工具(有的话);用户确认后才会写入。`

func defaultSettings() Settings {
	return Settings{
		Providers: []Provider{},
		Assistants: []Assistant{{
			ID: defaultAssistantID, Name: "写作助手", SystemPrompt: writerSystemPrompt,
			Skills: []string{}, MCPServers: []string{},
		}},
		DefaultAssistantID: defaultAssistantID,
		// 9 个内置的选中文字动作只在网页里;这里只放用户自定义的
		Actions:      []AIAction{},
		MCPServers:   []MCPServer{},
		ToolPolicies: map[string]string{},
		// PRD 3.6:「网页读取」默认关;「当前文件夹」随开随用
		Connectors:      Connectors{Folder: true, Web: false},
		SkillsEnabled:   true,
		DisabledSkills:  []string{},
		SpaceTriggersAI: true,
	}
}

// loadSettings 读取设置;文件不存在用缺省值(等第一次修改时才写盘)。
// 文件损坏时改名留底、改用缺省值并记日志:AI 设置坏了不该拖垮同一进程里的云同步。
func loadSettings(path string, log *slog.Logger) Settings {
	st := defaultSettings()
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return st
	}
	if err == nil {
		err = applyPatch(&st, b, true)
	}
	if err != nil {
		bad := path + ".bad"
		_ = os.Rename(path, bad)
		log.Error("AI 设置文件读不了,已改名留底并改用缺省设置", "path", path, "backup", bad, "err", err)
		return defaultSettings()
	}
	st.fill()
	if len(st.Assistants) == 0 {
		// 手改坏的文件:至少留一个助手,其余代码都假定有
		def := defaultSettings()
		st.Assistants, st.DefaultAssistantID = def.Assistants, def.DefaultAssistantID
	}
	return st
}

// fill 把空集合补成空数组 / 空对象,网页拿到的字段永远不是 null。
func (st *Settings) fill() {
	if st.Providers == nil {
		st.Providers = []Provider{}
	}
	for i := range st.Providers {
		if st.Providers[i].Models == nil {
			st.Providers[i].Models = []ModelInfo{}
		}
	}
	if st.Assistants == nil {
		st.Assistants = []Assistant{}
	}
	for i := range st.Assistants {
		if st.Assistants[i].Skills == nil {
			st.Assistants[i].Skills = []string{}
		}
		if st.Assistants[i].MCPServers == nil {
			st.Assistants[i].MCPServers = []string{}
		}
	}
	if st.Actions == nil {
		st.Actions = []AIAction{}
	}
	if st.MCPServers == nil {
		st.MCPServers = []MCPServer{}
	}
	if st.ToolPolicies == nil {
		st.ToolPolicies = map[string]string{}
	}
	if st.DisabledSkills == nil {
		st.DisabledSkills = []string{}
	}
}

// clone 深拷贝(设置很小,走一遍 JSON 最省事也最不容易漏字段)。
func (st Settings) clone() Settings {
	b, err := json.Marshal(st)
	if err != nil {
		panic(fmt.Sprintf("aisvc: 设置无法编码: %v", err))
	}
	var out Settings
	if err := json.Unmarshal(b, &out); err != nil {
		panic(fmt.Sprintf("aisvc: 设置无法解码: %v", err))
	}
	out.fill()
	return out
}

// prepare 给新增的条目分配 ID 并校验;网页新建服务商、助手、动作、MCP 服务器时 id 可留空。
func (st *Settings) prepare() error {
	st.fill()
	seen := map[string]bool{}
	unique := func(kind, id string) error {
		key := kind + "\x00" + id
		if seen[key] {
			return errf(codeInvalid, "%s的 ID「%s」重复", kind, id)
		}
		seen[key] = true
		return nil
	}
	for i := range st.Providers {
		p := &st.Providers[i]
		if p.ID == "" {
			p.ID = newID()
		}
		p.HasKey = false
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" {
			return errf(codeInvalid, "服务商名称不能为空")
		}
		switch p.Protocol {
		case protoAnthropic, protoOpenAIChat, protoOpenAIResponses, protoGemini:
		default:
			return errf(codeInvalid, "服务商「%s」的接口协议「%s」不支持", p.Name, p.Protocol)
		}
		if !validID(p.ID) {
			return errf(codeInvalid, "服务商 ID「%s」只能用小写字母、数字、- 和 _", p.ID)
		}
		if err := unique("服务商", p.ID); err != nil {
			return err
		}
	}
	if len(st.Assistants) == 0 {
		return errf(codeInvalid, "至少要保留一个助手")
	}
	for i := range st.Assistants {
		a := &st.Assistants[i]
		if a.ID == "" {
			a.ID = newID()
		}
		a.Name = strings.TrimSpace(a.Name)
		if a.Name == "" {
			return errf(codeInvalid, "助手名称不能为空")
		}
		if err := unique("助手", a.ID); err != nil {
			return err
		}
	}
	if st.DefaultAssistantID == "" {
		st.DefaultAssistantID = st.Assistants[0].ID
	}
	if st.assistant(st.DefaultAssistantID) == nil {
		return errf(codeInvalid, "默认助手「%s」不存在", st.DefaultAssistantID)
	}
	for i := range st.Actions {
		a := &st.Actions[i]
		if a.ID == "" {
			a.ID = newID()
		}
		a.Name = strings.TrimSpace(a.Name)
		if a.Name == "" {
			return errf(codeInvalid, "AI 动作的名称不能为空")
		}
		if strings.TrimSpace(a.Prompt) == "" {
			return errf(codeInvalid, "AI 动作「%s」的提示词为空,不能保存", a.Name)
		}
		if err := unique("AI 动作", a.ID); err != nil {
			return err
		}
	}
	for i := range st.MCPServers {
		m := &st.MCPServers[i]
		if m.ID == "" {
			m.ID = newID()
		}
		m.Name = strings.TrimSpace(m.Name)
		if m.Name == "" {
			m.Name = m.ID
		}
		// serverId 会拼进工具全名 mcp__<serverId>__<toolName>,只允许不会和分隔符混淆的字符
		if !validID(m.ID) || strings.Contains(m.ID, "__") {
			return errf(codeInvalid, "MCP 服务器 ID「%s」只能用小写字母、数字、- 和 _,且不能含连续下划线", m.ID)
		}
		switch m.Transport {
		case "stdio":
			if strings.TrimSpace(m.Command) == "" {
				return errf(codeInvalid, "MCP 服务器「%s」缺少启动命令", m.Name)
			}
		case "http":
			if strings.TrimSpace(m.URL) == "" {
				return errf(codeInvalid, "MCP 服务器「%s」缺少地址", m.Name)
			}
		default:
			return errf(codeInvalid, "MCP 服务器「%s」的传输方式「%s」不支持", m.Name, m.Transport)
		}
		if err := unique("MCP 服务器", m.ID); err != nil {
			return err
		}
	}
	for name, p := range st.ToolPolicies {
		if p != policyAllow && p != policyAsk && p != policyDeny {
			return errf(codeInvalid, "工具「%s」的权限「%s」不对,只能是 allow / ask / deny", name, p)
		}
	}
	return nil
}

func (st *Settings) provider(id string) *Provider {
	for i := range st.Providers {
		if st.Providers[i].ID == id {
			return &st.Providers[i]
		}
	}
	return nil
}

func (st *Settings) assistant(id string) *Assistant {
	for i := range st.Assistants {
		if st.Assistants[i].ID == id {
			return &st.Assistants[i]
		}
	}
	return nil
}

// assistantOrDefault 找不到(如助手已删除)时用默认助手:PRD 3.9「删除助手时其对话保留,改用默认助手」。
func (st *Settings) assistantOrDefault(id string) Assistant {
	if a := st.assistant(id); a != nil {
		return *a
	}
	if a := st.assistant(st.DefaultAssistantID); a != nil {
		return *a
	}
	return st.Assistants[0]
}

func (st *Settings) action(id string) *AIAction {
	for i := range st.Actions {
		if st.Actions[i].ID == id {
			return &st.Actions[i]
		}
	}
	return nil
}

func (st *Settings) mcpServer(id string) *MCPServer {
	for i := range st.MCPServers {
		if st.MCPServers[i].ID == id {
			return &st.MCPServers[i]
		}
	}
	return nil
}

// resolved 是一次请求实际用的服务商与模型。
type resolved struct {
	provider Provider
	modelID  string
}

func (r resolved) ref() *ModelRef { return &ModelRef{ProviderID: r.provider.ID, ModelID: r.modelID} }

// supportsTools 只有模型被明确标为「不支持工具调用」时才不带工具。
func (r resolved) supportsTools() bool {
	for _, m := range r.provider.Models {
		if m.ID == r.modelID && m.Tools != nil {
			return *m.Tools
		}
	}
	return true
}

// resolveModel 依次尝试候选模型、默认模型;候选指向已删除或停用的服务商时跳过
// (PRD 3.1:删除服务商后,用它的助手与对话改用默认模型)。
// 都没有时退到第一个启用且有模型的服务商【假设】,免得用户加了服务商却忘了选默认模型就用不了。
func (st *Settings) resolveModel(cands ...*ModelRef) (resolved, error) {
	cands = append(cands, st.DefaultModel)
	for _, r := range cands {
		if r == nil || r.ModelID == "" {
			continue
		}
		p := st.provider(r.ProviderID)
		if p == nil || !p.Enabled {
			continue
		}
		return resolved{provider: *p, modelID: r.ModelID}, nil
	}
	for _, p := range st.Providers {
		if p.Enabled && len(p.Models) > 0 {
			return resolved{provider: p, modelID: p.Models[0].ID}, nil
		}
	}
	return resolved{}, errf(codeNotConfigured, "请先在设置 ▸ AI 服务商中添加模型")
}

// ---------- 服务方法 ----------

func (s *Service) settingsPath() string { return filepath.Join(s.opts.Dir, "settings.json") }

// settingsView 是给网页的设置:hasKey 按内存里的密钥算出。
func (s *Service) settingsView() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.viewLocked()
}

func (s *Service) viewLocked() Settings {
	st := s.settings.clone()
	for i := range st.Providers {
		st.Providers[i].HasKey = len(splitKeys(s.secrets[providerSecretRef(st.Providers[i].ID)])) > 0
	}
	return st
}

// settingsFields 把契约字段名映射到设置结构体的字段,ai.settings.update 只替换给出的字段。
func settingsFields(st *Settings) map[string]any {
	return map[string]any{
		"providers":          &st.Providers,
		"defaultModel":       &st.DefaultModel,
		"fastModel":          &st.FastModel,
		"assistants":         &st.Assistants,
		"defaultAssistantId": &st.DefaultAssistantID,
		"actions":            &st.Actions,
		"mcpServers":         &st.MCPServers,
		"toolPolicies":       &st.ToolPolicies,
		"connectors":         &st.Connectors,
		"skillsEnabled":      &st.SkillsEnabled,
		"readAgentsSkills":   &st.ReadAgentsSkills,
		"disabledSkills":     &st.DisabledSkills,
		"spaceTriggersAi":    &st.SpaceTriggersAI,
	}
}

// mutateSettings 在设置副本上改动、校验、写盘,成功后才替换内存里的设置。
func (s *Service) mutateSettings(fn func(*Settings) error) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := s.settings.clone()
	if err := fn(&cp); err != nil {
		return Settings{}, err
	}
	if err := cp.prepare(); err != nil {
		return Settings{}, err
	}
	if err := writeJSONAtomic(s.settingsPath(), cp); err != nil {
		return Settings{}, errf(codeInternal, "保存 AI 设置失败:%v", err)
	}
	s.settings = cp
	return cp.clone(), nil
}

// applyPatch 用 JSON 里给出的字段整体替换设置里的对应字段;lenient 时忽略不认识的字段(读旧版本写的文件)。
func applyPatch(st *Settings, raw []byte, lenient bool) error {
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil {
		return errf(codeInvalid, "设置格式不对:%v", err)
	}
	fields := settingsFields(st)
	for key, val := range patch {
		ptr, ok := fields[key]
		if !ok {
			if lenient {
				continue
			}
			return errf(codeInvalid, "未知的设置项「%s」", key)
		}
		// 先清零再解码:json 解进已有的 map / 切片会和旧内容合并,而这里要整体替换
		reflect.ValueOf(ptr).Elem().SetZero()
		if err := json.Unmarshal(val, ptr); err != nil {
			return errf(codeInvalid, "设置项「%s」格式不对:%v", key, err)
		}
	}
	return nil
}

func (s *Service) updateSettings(_ context.Context, raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		raw = json.RawMessage("{}")
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal(raw, &patch); err != nil {
		return nil, errf(codeInvalid, "设置格式不对:%v", err)
	}
	st, err := s.mutateSettings(func(cp *Settings) error { return applyPatch(cp, raw, false) })
	if err != nil {
		return nil, err
	}
	if _, ok := patch["mcpServers"]; ok {
		s.mcp.reconcile(st.MCPServers)
	}
	return s.settingsView(), nil
}

// setPolicy 记下「总是允许」等选择。
func (s *Service) setPolicy(tool, policy string) error {
	_, err := s.mutateSettings(func(cp *Settings) error {
		cp.ToolPolicies[tool] = policy
		return nil
	})
	return err
}

// ---------- 密钥 ----------

func providerSecretRef(providerID string) string { return "provider:" + providerID }

func mcpSecretRef(serverID, name string) string { return "mcp:" + serverID + ":" + name }

func mcpOAuthSecretRef(serverID string) string { return "mcp-oauth:" + serverID }

// splitKeys 拆开逗号分隔的多个密钥(PRD 3.1)。
func splitKeys(v string) []string {
	var out []string
	for _, k := range strings.Split(v, ",") {
		if k = strings.TrimSpace(k); k != "" {
			out = append(out, k)
		}
	}
	return out
}

type secretsParams struct {
	Secrets map[string]string `json:"secrets"`
}

// setSecrets 收外壳推来的全量密钥,只放内存。
func (s *Service) setSecrets(_ context.Context, p secretsParams) (any, error) {
	m := make(map[string]string, len(p.Secrets))
	for k, v := range p.Secrets {
		m[k] = v
	}
	s.mu.Lock()
	s.secrets = m
	s.mu.Unlock()
	return map[string]any{}, nil
}

// snapshot 是某一时刻的设置与密钥副本,一次生成从头到尾用同一份,不受中途改设置影响。
type snapshot struct {
	st      Settings
	secrets map[string]string
}

func (s *Service) snap() snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	sec := make(map[string]string, len(s.secrets))
	for k, v := range s.secrets {
		sec[k] = v
	}
	return snapshot{st: s.settings.clone(), secrets: sec}
}
