package aisvc

import (
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultSettings(t *testing.T) {
	env := newTestService(t)
	var st Settings
	env.callInto(t, "ai.settings.get", nil, &st)
	if st.DefaultAssistantID != defaultAssistantID || len(st.Assistants) != 1 || st.Assistants[0].Name != "写作助手" {
		t.Fatalf("缺省应有内置的写作助手并设为默认:%+v", st.Assistants)
	}
	// 内置的选中文字动作只在网页里,设置里只放用户自定义的
	if len(st.Actions) != 0 {
		t.Fatalf("缺省设置里不应有动作:%+v", st.Actions)
	}
	if !st.Connectors.Folder || st.Connectors.Web || !st.SkillsEnabled || st.ReadAgentsSkills || !st.SpaceTriggersAI {
		t.Fatalf("缺省开关不对:%+v", st)
	}
	// 数组与对象字段永远不是 null
	raw := env.call(t, "ai.settings.get", nil)
	for _, key := range []string{`"providers":[]`, `"actions":[]`, `"mcpServers":[]`, `"toolPolicies":{}`, `"disabledSkills":[]`} {
		if !strings.Contains(string(raw), key) {
			t.Fatalf("缺省设置里应有 %s:%s", key, raw)
		}
	}
	if _, err := os.Stat(env.s.settingsPath()); !os.IsNotExist(err) {
		t.Fatal("没改过设置时不写盘")
	}
}

func TestSettingsUpdateReplacesGivenFields(t *testing.T) {
	env := newTestService(t)
	var st Settings
	env.callInto(t, "ai.settings.update", map[string]any{
		"providers":    []map[string]any{{"name": " 我的服务商 ", "protocol": protoGemini, "baseUrl": "", "enabled": true, "models": []map[string]any{{"id": "g1", "tools": true}}}},
		"actions":      []map[string]any{{"name": "加 emoji", "prompt": "给 {{selection}} 加表情"}},
		"connectors":   map[string]bool{"web": true},
		"toolPolicies": map[string]string{"typoza__fetch_url": "allow"},
	}, &st)
	if len(st.Providers) != 1 || st.Providers[0].ID == "" || !validID(st.Providers[0].ID) || st.Providers[0].Name != "我的服务商" {
		t.Fatalf("新服务商应分配 ID 并去掉首尾空格:%+v", st.Providers)
	}
	if len(st.Actions) != 1 || st.Actions[0].ID == "" {
		t.Fatalf("actions 应整体替换,新动作分配 ID:%+v", st.Actions)
	}
	// connectors 整体替换:没给的 folder 变成 false
	if st.Connectors.Folder || !st.Connectors.Web {
		t.Fatalf("connectors 应整体替换:%+v", st.Connectors)
	}
	if len(st.Assistants) != 1 || !st.SkillsEnabled {
		t.Fatal("没给的字段应保持原样")
	}
	env.call(t, "ai.settings.update", map[string]any{"defaultModel": map[string]any{"providerId": st.Providers[0].ID, "modelId": "g1"}})
	var cleared Settings
	env.callInto(t, "ai.settings.update", map[string]any{"defaultModel": nil}, &cleared)
	if cleared.DefaultModel != nil || strings.Contains(string(env.call(t, "ai.settings.get", nil)), "defaultModel") {
		t.Fatal("defaultModel 传 null 应删除该字段")
	}
	env.call(t, "ai.settings.update", map[string]any{"toolPolicies": map[string]string{"typoza__read_document": "deny"}})
	var after Settings
	env.callInto(t, "ai.settings.get", nil, &after)
	if len(after.ToolPolicies) != 1 || after.ToolPolicies["typoza__read_document"] != policyDeny {
		t.Fatalf("toolPolicies 应整体替换,不与旧值合并:%v", after.ToolPolicies)
	}

	// 写盘后新进程读回来一样
	s2, err := New(Options{Dir: env.s.opts.Dir, SkillsDir: env.s.opts.SkillsDir, Host: env.host, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s2.Close)
	a, _ := json.Marshal(env.s.settingsView())
	b, _ := json.Marshal(s2.settingsView())
	if string(a) != string(b) {
		t.Fatalf("重启后设置应一致:\n%s\n%s", a, b)
	}
}

func TestSettingsUpdateValidation(t *testing.T) {
	env := newTestService(t)
	bad := []map[string]any{
		{"providers": []map[string]any{{"name": "x", "protocol": "cohere"}}},
		{"providers": []map[string]any{{"name": "", "protocol": protoOpenAIChat}}},
		{"providers": []map[string]any{{"id": "a", "name": "x", "protocol": protoOpenAIChat}, {"id": "a", "name": "y", "protocol": protoOpenAIChat}}},
		{"actions": []map[string]any{{"name": "空", "prompt": "  "}}},
		{"assistants": []map[string]any{}},
		{"defaultAssistantId": "nope"},
		{"mcpServers": []map[string]any{{"name": "x", "transport": "stdio"}}},
		{"mcpServers": []map[string]any{{"name": "x", "transport": "http"}}},
		{"mcpServers": []map[string]any{{"id": "a__b", "name": "x", "transport": "http", "url": "http://x"}}},
		{"mcpServers": []map[string]any{{"name": "x", "transport": "sse", "url": "http://x"}}},
		{"toolPolicies": map[string]string{"x": "sometimes"}},
		{"unknownField": true},
		{"skillsEnabled": "yes"},
	}
	for _, patch := range bad {
		env.wantErr(t, codeInvalid, "ai.settings.update", patch)
	}
	// 校验失败不改设置、不写盘
	if _, err := os.Stat(env.s.settingsPath()); !os.IsNotExist(err) {
		t.Fatal("校验失败不应写盘")
	}
}

func TestHasKeyComesFromSecretsAndNeverHitsDisk(t *testing.T) {
	env := newTestService(t)
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "", nil)
	var st Settings
	env.callInto(t, "ai.settings.get", nil, &st)
	if st.Providers[0].HasKey {
		t.Fatal("没有密钥时 hasKey 应为 false")
	}
	env.call(t, "ai.secrets", map[string]any{"secrets": map[string]string{
		"provider:p1":        "sk-test-plaintext-1, sk-test-plaintext-2",
		"mcp:srv:API_KEY":    "sk-test-mcp-env",
		"mcp-oauth:srv":      "sk-test-oauth",
		"provider:unrelated": "sk-test-other",
	}})
	env.callInto(t, "ai.settings.get", nil, &st)
	if !st.Providers[0].HasKey {
		t.Fatal("推来密钥后 hasKey 应为 true")
	}
	// 网页回写设置时带着 hasKey 也不会存进去
	env.call(t, "ai.settings.update", map[string]any{"providers": st.Providers, "mcpServers": []map[string]any{
		{"id": "srv", "name": "s", "enabled": false, "transport": "stdio", "command": "x", "env": map[string]string{"API_KEY": ""}},
	}})
	r := env.send(t, map[string]any{"text": "你好"})
	env.host.waitDone(t, r.AssistantMessageID)
	if got := llm.chatPosts()[0].header.Get("Authorization"); got != "Bearer sk-test-plaintext-1" {
		t.Fatalf("请求应带内存里的密钥:%q", got)
	}

	// PRD 验收 8:扫描 AI 数据目录,不出现测试密钥明文
	err := filepath.WalkDir(env.dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(b), "sk-test") {
			t.Errorf("%s 里出现了密钥明文", path)
		}
		if strings.Contains(string(b), `"hasKey": true`) {
			t.Errorf("%s 里存了 hasKey", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCorruptSettingsFileFallsBackToDefaults(t *testing.T) {
	dir := t.TempDir()
	aiDir := filepath.Join(dir, "ai")
	if err := os.MkdirAll(aiDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aiDir, "settings.json"), []byte("{坏掉了"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := New(Options{Dir: aiDir, SkillsDir: filepath.Join(dir, "skills"), Host: newFakeHost(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	if st := s.settingsView(); st.DefaultAssistantID != defaultAssistantID {
		t.Fatalf("坏掉的设置文件应改用缺省设置:%+v", st)
	}
	if b, err := os.ReadFile(filepath.Join(aiDir, "settings.json.bad")); err != nil || string(b) != "{坏掉了" {
		t.Fatalf("坏文件应改名留底:%v", err)
	}
}

func TestDeletedProviderFallsBackToDefaultModel(t *testing.T) {
	env := newTestService(t)
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "", map[string]any{
		"assistants": []map[string]any{{"id": defaultAssistantID, "name": "写作助手", "systemPrompt": "", "skills": []string{}, "mcpServers": []string{},
			"model": map[string]any{"providerId": "gone", "modelId": "x"}}},
	})
	r := env.send(t, map[string]any{"text": "你好"})
	env.host.waitDone(t, r.AssistantMessageID)
	c := env.conversation(t, r.ConversationID)
	if m := c.Messages[r.AssistantMessageID].Model; m == nil || m.ProviderID != "p1" || m.ModelID != "m1" {
		t.Fatalf("助手的模型指向已删除的服务商时应改用默认模型:%+v", m)
	}
	// 显式指定模型优先
	r2 := env.send(t, map[string]any{"conversationId": r.ConversationID, "text": "再问", "model": map[string]any{"providerId": "p1", "modelId": "fast"}})
	env.host.waitDone(t, r2.AssistantMessageID)
	if m := env.conversation(t, r.ConversationID).Messages[r2.AssistantMessageID].Model; m.ModelID != "fast" {
		t.Fatalf("显式指定的模型应优先:%+v", m)
	}
}
