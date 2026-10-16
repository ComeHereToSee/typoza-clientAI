package aisvc

import (
	"encoding/json"
	"strings"
	"testing"
)

func completeDone(env *testEnv, t *testing.T, id string) map[string]any {
	t.Helper()
	return env.host.waitFor(t, "complete.done "+id, func(e map[string]any) bool {
		return e["type"] == "complete.done" && e["requestId"] == id
	})
}

func completeText(env *testEnv, id string) string {
	var b strings.Builder
	env.host.count(func(e map[string]any) bool {
		if e["type"] == "complete.delta" && e["requestId"] == id {
			b.WriteString(e["text"].(string))
		}
		return false
	})
	return b.String()
}

// userText 取 OpenAI Chat 请求里最后一条用户消息。
func userText(t *testing.T, body string) string {
	t.Helper()
	msgs := chatMessages(t, body)
	return strings.TrimPrefix(msgs[len(msgs)-1], "user:")
}

// 网页发来的是填好占位符的完整提示词,原样交给模型;结果以 complete.delta / complete.done 推送,不入对话。
func TestCompleteSendsPromptVerbatim(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"Hello ", "world"}})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	prompt := "把下面的文字翻译成英文。\n\n你好世界"
	env.call(t, "ai.complete", map[string]any{"requestId": "r1", "prompt": prompt, "selection": "你好世界", "document": "全文", "cursor": 3})
	if done := completeDone(env, t, "r1"); done["status"] != statusDone || done["error"] != nil {
		t.Fatalf("应正常结束:%v", done)
	}
	if got := completeText(env, "r1"); got != "Hello world" {
		t.Fatalf("complete.delta 拼起来不对:%q", got)
	}
	body := llm.posts()[0].body
	if u := userText(t, body); u != prompt {
		t.Fatalf("提示词应原样交给模型:%q", u)
	}
	if !strings.Contains(body, `"model":"m1"`) {
		t.Fatal("没指定模型时用默认模型")
	}
	var list struct {
		Items []ConversationSummary `json:"items"`
	}
	env.callInto(t, "ai.conversations.list", nil, &list)
	if len(list.Items) != 0 {
		t.Fatal("ai.complete 不应产生对话")
	}
}

func TestCompleteCustomActionUsesItsModel(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"好"}}, turn{text: []string{"好"}})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", map[string]any{
		"actions": []map[string]any{{"id": "poem", "name": "改成诗", "prompt": "改成一首诗:{{selection}}", "model": map[string]any{"providerId": "p1", "modelId": "fast"}}},
	})
	env.call(t, "ai.complete", map[string]any{"requestId": "a", "actionId": "poem", "prompt": "改成一首诗:今天下雨"})
	completeDone(env, t, "a")
	if body := llm.posts()[0].body; !strings.Contains(body, `"model":"fast"`) || userText(t, body) != "改成一首诗:今天下雨" {
		t.Fatalf("自定义动作应用它指定的模型:%s", body)
	}
	// 显式指定的模型比动作的模型优先
	env.call(t, "ai.complete", map[string]any{"requestId": "b", "actionId": "poem", "prompt": "x", "model": map[string]any{"providerId": "p1", "modelId": "m1"}})
	completeDone(env, t, "b")
	if body := llm.posts()[1].body; !strings.Contains(body, `"model":"m1"`) {
		t.Fatalf("显式指定的模型应优先:%s", body)
	}
	env.wantErr(t, codeNotFound, "ai.complete", map[string]any{"requestId": "c", "actionId": "nope", "prompt": "x"})
}

func TestCompleteStopAndErrors(t *testing.T) {
	env := newTestService(t)
	env.wantErr(t, codeNotConfigured, "ai.complete", map[string]any{"requestId": "x", "prompt": "写点什么"})
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"开头"}, hold: true}, turn{status: 429, body: `{"error":{"message":"额度用完"}}`})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	env.wantErr(t, codeInvalid, "ai.complete", map[string]any{"prompt": "缺 requestId"})
	env.wantErr(t, codeInvalid, "ai.complete", map[string]any{"requestId": "x", "prompt": "  "})

	env.call(t, "ai.complete", map[string]any{"requestId": "s", "prompt": "写长文"})
	llm.waitHeld(t)
	env.wantErr(t, codeInvalid, "ai.complete", map[string]any{"requestId": "s", "prompt": "重复的 requestId"})
	env.call(t, "ai.complete.stop", map[string]any{"requestId": "s"})
	if done := completeDone(env, t, "s"); done["status"] != statusStopped {
		t.Fatalf("停止后应为 stopped:%v", done)
	}
	if got := completeText(env, "s"); got != "开头" {
		t.Fatalf("停止前的增量应已推出:%q", got)
	}

	env.call(t, "ai.complete", map[string]any{"requestId": "e", "prompt": "再写"})
	done := completeDone(env, t, "e")
	b, _ := json.Marshal(done["error"])
	if done["status"] != statusError || !strings.Contains(string(b), codeRateLimit) || !strings.Contains(string(b), "额度用完") {
		t.Fatalf("限流应以 error / rate_limit 结束并带原文:%v", done)
	}
	// 结束了的请求再停一次不算错
	env.call(t, "ai.complete.stop", map[string]any{"requestId": "e"})
}
