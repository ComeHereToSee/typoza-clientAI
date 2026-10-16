package aisvc

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var allProtocols = []string{protoAnthropic, protoOpenAIChat, protoOpenAIResponses, protoGemini}

// 四种协议:第一轮流式吐文字并调用工具,第二轮带着工具结果给出最终回答。
func TestProtocolsStreamTextAndToolCalls(t *testing.T) {
	wantPath := map[string]string{
		protoAnthropic:       "/v1/messages",
		protoOpenAIChat:      "/v1/chat/completions",
		protoOpenAIResponses: "/v1/responses",
		protoGemini:          "/v1beta/models/m1:streamGenerateContent",
	}
	// 第二次请求里工具结果的写法各家不同
	resultMarker := map[string]string{
		protoAnthropic:       `"tool_result"`,
		protoOpenAIChat:      `"role":"tool"`,
		protoOpenAIResponses: `"function_call_output"`,
		protoGemini:          `"functionResponse"`,
	}
	for _, proto := range allProtocols {
		t.Run(proto, func(t *testing.T) {
			env := newTestService(t)
			folder := t.TempDir()
			for name, body := range map[string]string{"note.md": "# 笔记", "draft.md": "草稿"} {
				if err := os.WriteFile(filepath.Join(folder, name), []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			llm := newMockLLM(t, proto,
				turn{text: []string{"我先", "看看文件夹。"}, calls: []mockCall{{id: "call_1", name: toolListDocuments, args: `{}`}}},
				turn{text: []string{"有两篇文档。"}},
			)
			env.useProvider(t, proto, llm.srv.URL, "sk-test-123", nil)
			r := env.send(t, map[string]any{
				"text":    "文件夹里有什么?",
				"context": []map[string]any{{"kind": "document", "title": "笔记", "path": filepath.Join(folder, "note.md"), "text": "# 笔记"}},
			})
			done := env.host.waitDone(t, r.AssistantMessageID)
			if done["status"] != statusDone {
				t.Fatalf("回答应正常结束:%v", done)
			}

			c := env.conversation(t, r.ConversationID)
			parts := partsOf(c, r.AssistantMessageID)
			if len(parts) != 3 || parts[0].Type != partText || parts[1].Type != partToolCall || parts[2].Type != partText {
				t.Fatalf("部件应为 文字、工具调用、文字:%+v", parts)
			}
			if parts[0].Text != "我先看看文件夹。" || parts[2].Text != "有两篇文档。" {
				t.Fatalf("文字不对:%q / %q", parts[0].Text, parts[2].Text)
			}
			call := parts[1]
			if call.Status != callDone || call.Tool != toolListDocuments || call.CallID != "call_1" {
				t.Fatalf("工具调用不对:%+v", call)
			}
			if res := deref(call.Result); !strings.Contains(res, "draft.md") || !strings.Contains(res, "note.md") {
				t.Fatalf("工具结果应列出两篇文档:%q", res)
			}
			if c.Messages[r.AssistantMessageID].Status != statusDone || c.Messages[r.AssistantMessageID].Model.ModelID != "m1" {
				t.Fatalf("消息状态或模型不对:%+v", c.Messages[r.AssistantMessageID])
			}

			// 增量事件拼起来就是全部文字
			var deltas strings.Builder
			env.host.count(func(e map[string]any) bool {
				if e["type"] == "message.delta" && e["messageId"] == r.AssistantMessageID {
					deltas.WriteString(e["text"].(string))
				}
				return false
			})
			if deltas.String() != "我先看看文件夹。有两篇文档。" {
				t.Fatalf("message.delta 拼起来不对:%q", deltas.String())
			}

			posts := llm.chatPosts()
			if len(posts) != 2 {
				t.Fatalf("应请求两次,实际 %d 次", len(posts))
			}
			if posts[0].path != wantPath[proto] {
				t.Fatalf("请求路径应为 %s,实际 %s", wantPath[proto], posts[0].path)
			}
			switch proto {
			case protoAnthropic:
				if posts[0].header.Get("x-api-key") != "sk-test-123" || posts[0].header.Get("anthropic-version") == "" {
					t.Fatalf("Anthropic 鉴权头不对:%v", posts[0].header)
				}
			case protoGemini:
				if posts[0].header.Get("x-goog-api-key") != "sk-test-123" || posts[0].query != "alt=sse" {
					t.Fatalf("Gemini 鉴权头或查询串不对:%v %s", posts[0].header, posts[0].query)
				}
			default:
				if posts[0].header.Get("Authorization") != "Bearer sk-test-123" {
					t.Fatalf("鉴权头不对:%v", posts[0].header)
				}
			}
			if !strings.Contains(posts[0].body, toolListDocuments) || !strings.Contains(posts[0].body, "文件夹里有什么") {
				t.Fatalf("第一次请求应带工具定义与用户问题:%s", posts[0].body)
			}
			second := posts[1].body
			if !strings.Contains(second, resultMarker[proto]) || !strings.Contains(second, "draft.md") {
				t.Fatalf("第二次请求应带工具结果:%s", second)
			}
			if proto == protoGemini && !strings.Contains(second, `"thoughtSignature":"sig-0"`) {
				t.Fatalf("Gemini 的 thoughtSignature 应原样带回:%s", second)
			}
		})
	}
}

func TestModelListPerProtocol(t *testing.T) {
	want := map[string][]string{
		protoAnthropic:       {"claude-a", "claude-b"},
		protoOpenAIChat:      {"gpt-a", "gpt-b"},
		protoOpenAIResponses: {"gpt-a", "gpt-b"},
		protoGemini:          {"gemini-a", "gemini-b"}, // 只列能 generateContent 的,去掉 models/ 前缀
	}
	wantPath := map[string]string{
		protoAnthropic: "/v1/models", protoOpenAIChat: "/v1/models", protoOpenAIResponses: "/v1/models", protoGemini: "/v1beta/models",
	}
	for _, proto := range allProtocols {
		t.Run(proto, func(t *testing.T) {
			env := newTestService(t)
			llm := newMockLLM(t, proto)
			env.useProvider(t, proto, llm.srv.URL, "k", nil)
			var res struct {
				Models []ModelInfo `json:"models"`
			}
			env.callInto(t, "ai.provider.models", map[string]any{"providerId": "p1"}, &res)
			var ids []string
			for _, m := range res.Models {
				ids = append(ids, m.ID)
			}
			if strings.Join(ids, ",") != strings.Join(want[proto], ",") {
				t.Fatalf("模型列表应为 %v,实际 %v", want[proto], ids)
			}
			reqs := llm.requests()
			if len(reqs) != 1 || reqs[0].path != wantPath[proto] {
				t.Fatalf("模型列表请求不对:%+v", reqs)
			}
		})
	}
}

func TestProviderTestReportsLatencyAndSendsShortRequest(t *testing.T) {
	for _, proto := range allProtocols {
		t.Run(proto, func(t *testing.T) {
			env := newTestService(t)
			llm := newMockLLM(t, proto, turn{text: []string{"Hi"}})
			env.useProvider(t, proto, llm.srv.URL, "k", nil)
			var res struct {
				OK        bool  `json:"ok"`
				LatencyMs int64 `json:"latencyMs"`
			}
			env.callInto(t, "ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"}, &res)
			if !res.OK || res.LatencyMs < 0 {
				t.Fatalf("检测结果不对:%+v", res)
			}
			body := llm.posts()[0].body
			for _, key := range []string{`"max_tokens":16`, `"max_output_tokens":16`, `"maxOutputTokens":16`} {
				if strings.Contains(body, key) {
					return
				}
			}
			t.Fatalf("检测请求应限制输出长度:%s", body)
		})
	}
}

func TestErrorCodesFromProvider(t *testing.T) {
	cases := []struct {
		status int
		body   string
		code   string
		inMsg  string
	}{
		{401, `{"error":{"message":"invalid x-api-key"}}`, codeAuth, "invalid x-api-key"},
		{403, `{"error":{"message":"forbidden"}}`, codeAuth, "forbidden"},
		{429, `{"error":{"message":"slow down"}}`, codeRateLimit, "slow down"},
		{500, `[{"error":{"code":500,"message":"服务器炸了"}}]`, codeProvider, "服务器炸了"},
		{400, `bad request text`, codeProvider, "bad request text"},
	}
	for _, tc := range cases {
		env := newTestService(t)
		llm := newMockLLM(t, protoOpenAIChat, turn{status: tc.status, body: tc.body})
		env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
		_, err := env.callErr("ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"})
		if errCode(err) != tc.code || !strings.Contains(err.Error(), tc.inMsg) {
			t.Fatalf("HTTP %d 应得 %s 且带原文 %q,实际 %s %v", tc.status, tc.code, tc.inMsg, errCode(err), err)
		}
	}
}

func TestChatErrorEndsMessageWithCode(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoAnthropic, turn{status: 401, body: `{"type":"error","error":{"type":"authentication_error","message":"bad key"}}`})
	env.useProvider(t, protoAnthropic, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "你好"})
	done := env.host.waitDone(t, r.AssistantMessageID)
	errInfo, _ := done["error"].(map[string]any)
	if done["status"] != statusError || errInfo["code"] != codeAuth || !strings.Contains(errInfo["message"].(string), "bad key") {
		t.Fatalf("鉴权失败应以 error / auth 结束:%v", done)
	}
	c := env.conversation(t, r.ConversationID)
	if m := c.Messages[r.AssistantMessageID]; m.Status != statusError || m.Error == nil || m.Error.Code != codeAuth {
		t.Fatalf("消息应记下错误:%+v", m)
	}
}

// 流没有正常结束(连接中途断开)算 network 错误。
func TestStreamEndingEarlyIsNetworkError(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, "broken") // 不认识的协议:回一个空的 SSE 流
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "你好"})
	done := env.host.waitDone(t, r.AssistantMessageID)
	if e, _ := done["error"].(map[string]any); done["status"] != statusError || e["code"] != codeNetwork {
		t.Fatalf("没有正常结束的流应以 error / network 结束:%v", done)
	}
}

// 流到一半服务商发来 error 事件:按事件里的类型给错误码,已收到的文字保留。
func TestErrorEventInsideStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"一半\"}}\n\n")
		fmt.Fprint(w, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"太快了\"}}\n\n")
	}))
	t.Cleanup(srv.Close)
	env := newTestService(t)
	env.useProvider(t, protoAnthropic, srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "你好"})
	done := env.host.waitDone(t, r.AssistantMessageID)
	if e, _ := done["error"].(map[string]any); done["status"] != statusError || e["code"] != codeRateLimit {
		t.Fatalf("流里的 rate_limit_error 应得 rate_limit:%v", done)
	}
	if got := textOfParts(partsOf(env.conversation(t, r.ConversationID), r.AssistantMessageID)); got != "一半" {
		t.Fatalf("出错前收到的文字应保留:%q", got)
	}
}

// 多个密钥:401、429 时换下一个;成功的密钥下次优先用。
func TestKeyRotationOn401And429(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat)
	llm.keyStatus["k1"] = 401
	llm.keyStatus["k2"] = 429
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k1, k2 ,k3", nil)
	env.call(t, "ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"})
	env.call(t, "ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"})
	var keys []string
	for _, r := range llm.requests() {
		keys = append(keys, headerKey(r.header))
	}
	if strings.Join(keys, ",") != "k1,k2,k3,k3" {
		t.Fatalf("密钥使用顺序应为 k1,k2,k3,k3,实际 %v", keys)
	}
}

func TestAllKeysRejected(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat)
	llm.keyStatus["k1"] = 401
	llm.keyStatus["k2"] = 401
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k1,k2", nil)
	env.wantErr(t, codeAuth, "ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"})
	if n := len(llm.requests()); n != 2 {
		t.Fatalf("两个密钥都该试一次,实际 %d 次", n)
	}
}

func TestBaseURLHashUsedVerbatim(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"ok"}})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL+"/custom/endpoint#", "", nil)
	env.call(t, "ai.provider.test", map[string]any{"providerId": "p1", "modelId": "m1"})
	r := llm.posts()[0]
	if r.path != "/custom/endpoint" {
		t.Fatalf("末尾 # 的地址应原样使用,实际请求 %s", r.path)
	}
	if r.header.Get("Authorization") != "" {
		t.Fatalf("没填密钥时不应带鉴权头:%v", r.header)
	}
}

func TestAPIURL(t *testing.T) {
	cases := []struct {
		protocol, base, kind, model, want string
	}{
		{protoAnthropic, "https://api.anthropic.com", "chat", "c", "https://api.anthropic.com/v1/messages"},
		{protoAnthropic, "", "models", "", "https://api.anthropic.com/v1/models?limit=1000"},
		{protoOpenAIChat, "https://openrouter.ai/api/v1", "chat", "x", "https://openrouter.ai/api/v1/chat/completions"},
		{protoOpenAIChat, "https://open.bigmodel.cn/api/paas/v4/", "chat", "x", "https://open.bigmodel.cn/api/paas/v4/chat/completions"},
		{protoOpenAIChat, "http://localhost:11434", "models", "", "http://localhost:11434/v1/models"},
		{protoOpenAIResponses, "https://api.openai.com/", "chat", "x", "https://api.openai.com/v1/responses"},
		{protoGemini, "", "chat", "gemini-x", "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse"},
		{protoGemini, "https://g.example/v1beta", "models", "", "https://g.example/v1beta/models?pageSize=1000"},
		{protoOpenAIChat, "https://x.example/custom/chat#", "chat", "x", "https://x.example/custom/chat"},
		{protoOpenAIChat, "https://x.example/v1/chat/completions#", "models", "", "https://x.example/v1/models"},
		{protoGemini, "https://g.example/v1beta/models/{model}:streamGenerateContent#", "chat", "m", "https://g.example/v1beta/models/m:streamGenerateContent?alt=sse"},
		{protoGemini, "https://g.example/v1beta/models/{model}:streamGenerateContent#", "models", "", "https://g.example/v1beta/models?pageSize=1000"},
	}
	for _, tc := range cases {
		got, err := apiURL(Provider{Protocol: tc.protocol, BaseURL: tc.base}, tc.kind, tc.model)
		if err != nil || got != tc.want {
			t.Errorf("%s %q %s:应为 %s,实际 %s %v", tc.protocol, tc.base, tc.kind, tc.want, got, err)
		}
	}
	if _, err := apiURL(Provider{Protocol: protoOpenAIChat, BaseURL: "https://x.example/custom#"}, "models", ""); asAIError(err).Code != codeInvalid {
		t.Fatalf("推断不出模型列表接口时应报 invalid:%v", err)
	}
}

func TestReadSSE(t *testing.T) {
	src := ": 心跳\r\nevent: a\r\ndata: 第一行\r\ndata: 第二行\r\n\r\ndata:{\"x\":1}\n\nevent: b\ndata: 结尾没有空行"
	var got []sseEvent
	err := readSSE(strings.NewReader(src), func() {}, func(ev sseEvent) error {
		got = append(got, ev)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []sseEvent{{"a", "第一行\n第二行"}, {"", `{"x":1}`}, {"b", "结尾没有空行"}}
	if len(got) != len(want) {
		t.Fatalf("事件数不对:%+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("第 %d 个事件应为 %+v,实际 %+v", i, want[i], got[i])
		}
	}
}

func TestWireName(t *testing.T) {
	if wireName("mcp__abc__search") != "mcp__abc__search" {
		t.Fatal("合规的名字应原样使用")
	}
	dotted := wireName("mcp__abc__files.read")
	if !wireNameRe.MatchString(dotted) || dotted == wireName("mcp__abc__files_read") {
		t.Fatalf("含点的名字应换成合规且不与别的工具撞名:%s", dotted)
	}
	long := wireName("mcp__abcdefghijklmnopqrst__" + strings.Repeat("x", 80))
	if len(long) != 64 || !wireNameRe.MatchString(long) || long != wireName("mcp__abcdefghijklmnopqrst__"+strings.Repeat("x", 80)) {
		t.Fatalf("过长的名字应稳定地截成 64 个字符:%s", long)
	}
	names := newToolNames([]llmTool{{name: "mcp__abc__files.read"}})
	if names.full(dotted) != "mcp__abc__files.read" {
		t.Fatal("应能从函数名找回工具全名")
	}
}

func TestGeminiSchemaSanitized(t *testing.T) {
	var in map[string]any
	_ = json.Unmarshal([]byte(`{"$schema":"x","type":"object","additionalProperties":false,
		"properties":{"q":{"type":["string","null"],"format":"uri","description":"查询"},
		"n":{"type":"integer","enum":[1,2]},"opts":{"type":"object","properties":{}}},"required":["q"]}`), &in)
	out, _ := json.Marshal(geminiSchema(in))
	s := string(out)
	for _, bad := range []string{"$schema", "additionalProperties", `"format"`, `"enum"`, `"opts"`} {
		if strings.Contains(s, bad) {
			t.Fatalf("不该保留 %s:%s", bad, s)
		}
	}
	if !strings.Contains(s, `"nullable":true`) || !strings.Contains(s, `"type":"string"`) || !strings.Contains(s, `"required":["q"]`) {
		t.Fatalf("类型数组应改成 type + nullable:%s", s)
	}
	if geminiSchema(map[string]any{"type": "object", "properties": map[string]any{}}) != nil {
		t.Fatal("没有参数的对象应省略")
	}
}

func TestFlattenToolsWhenNoToolsOffered(t *testing.T) {
	msgs := []llmMsg{
		{role: "user", text: "问"},
		{role: "assistant", text: "查一下", calls: []llmCall{{id: "c1", name: "typoza__read_document", args: json.RawMessage(`{"path":"a.md"}`)}}},
		{role: "user", results: []llmResult{{callID: "c1", name: "typoza__read_document", content: "内容"}}},
	}
	out := flattenTools(msgs)
	for _, m := range out {
		if len(m.calls) > 0 || len(m.results) > 0 {
			t.Fatalf("不带工具时历史里不应再有工具块:%+v", out)
		}
	}
	if !strings.Contains(out[1].text, "typoza__read_document") || !strings.Contains(out[2].text, "内容") {
		t.Fatalf("工具调用与结果应改写成文字:%+v", out)
	}
}
