package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ComeHereToSee/typoza-client/helper/internal/rpc"
)

// ---------- 假外壳 ----------

// fakeHost 记录推给外壳的事件;征询与打开网址按测试设定回答。
type fakeHost struct {
	mu       sync.Mutex
	events   []map[string]any
	signal   chan struct{}
	opened   []string
	elicits  []ElicitArgs
	onElicit func(ElicitArgs) ElicitAnswer
}

func newFakeHost() *fakeHost { return &fakeHost{signal: make(chan struct{}, 1)} }

func (h *fakeHost) Notify(method string, params any) error {
	if method != NotifyEvent {
		return fmt.Errorf("意外的通知 %s", method)
	}
	b, err := json.Marshal(params)
	if err != nil {
		return err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return err
	}
	h.mu.Lock()
	h.events = append(h.events, m)
	h.mu.Unlock()
	select {
	case h.signal <- struct{}{}:
	default:
	}
	return nil
}

func (h *fakeHost) OpenURL(_ context.Context, u string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opened = append(h.opened, u)
	return nil
}

func (h *fakeHost) Elicit(_ context.Context, req ElicitArgs) (ElicitAnswer, error) {
	h.mu.Lock()
	h.elicits = append(h.elicits, req)
	fn := h.onElicit
	h.mu.Unlock()
	if fn == nil {
		return ElicitAnswer{Action: "cancel"}, nil
	}
	return fn(req), nil
}

// waitFor 等到出现满足 pred 的事件(包括之前已经出现的),返回它。
func (h *fakeHost) waitFor(t *testing.T, what string, pred func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		h.mu.Lock()
		for _, e := range h.events {
			if pred(e) {
				h.mu.Unlock()
				return e
			}
		}
		h.mu.Unlock()
		select {
		case <-h.signal:
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatalf("等 %s 超时;已收到的事件:%s", what, h.dump())
		}
	}
}

func (h *fakeHost) count(pred func(map[string]any) bool) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, e := range h.events {
		if pred(e) {
			n++
		}
	}
	return n
}

func (h *fakeHost) dump() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var b strings.Builder
	for _, e := range h.events {
		j, _ := json.Marshal(e)
		b.Write(j)
		b.WriteByte('\n')
	}
	return b.String()
}

func isType(typ string) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["type"] == typ }
}

// waitDone 等某条回答结束,返回 message.done 事件。
func (h *fakeHost) waitDone(t *testing.T, msgID string) map[string]any {
	t.Helper()
	return h.waitFor(t, "回答 "+msgID+" 结束", func(e map[string]any) bool {
		return e["type"] == "message.done" && e["messageId"] == msgID
	})
}

// ---------- 服务 ----------

type testEnv struct {
	s    *Service
	host *fakeHost
	dir  string
}

func newTestService(t *testing.T) *testEnv {
	t.Helper()
	dir := t.TempDir()
	host := newFakeHost()
	s, err := New(Options{
		Dir: filepath.Join(dir, "ai"), SkillsDir: filepath.Join(dir, "skills"), AgentsSkillsDir: filepath.Join(dir, "agents-skills"),
		Host: host, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Version: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return &testEnv{s: s, host: host, dir: dir}
}

// callErr 经 Routes 调用方法(参数与结果都走 JSON,顺带校验契约字段名)。
func (e *testEnv) callErr(method string, params any) (json.RawMessage, error) {
	h := e.s.Routes()[method]
	if h == nil {
		return nil, fmt.Errorf("没有方法 %s", method)
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	res, err := h(context.Background(), raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(res)
}

func (e *testEnv) call(t *testing.T, method string, params any) json.RawMessage {
	t.Helper()
	res, err := e.callErr(method, params)
	if err != nil {
		t.Fatalf("%s 失败:%v", method, err)
	}
	return res
}

func (e *testEnv) callInto(t *testing.T, method string, params, out any) {
	t.Helper()
	if err := json.Unmarshal(e.call(t, method, params), out); err != nil {
		t.Fatalf("%s 的结果解不开:%v", method, err)
	}
}

// errCode 取 RPC 错误里的契约错误码。
func errCode(err error) string {
	var re *rpc.Error
	if !errors.As(err, &re) {
		return ""
	}
	if m, ok := re.Data.(map[string]string); ok {
		return m["code"]
	}
	return ""
}

func (e *testEnv) wantErr(t *testing.T, code, method string, params any) {
	t.Helper()
	_, err := e.callErr(method, params)
	if err == nil {
		t.Fatalf("%s 应失败(%s)", method, code)
	}
	if got := errCode(err); got != code {
		t.Fatalf("%s 的错误码应为 %s,实际 %s(%v)", method, code, got, err)
	}
}

// useProvider 配一个服务商并设为默认模型 m1;keys 为空表示不填密钥。
func (e *testEnv) useProvider(t *testing.T, protocol, baseURL string, keys string, extra map[string]any) {
	t.Helper()
	patch := map[string]any{
		"providers": []map[string]any{{
			"id": "p1", "name": "模拟", "protocol": protocol, "baseUrl": baseURL, "enabled": true,
			"models": []map[string]any{{"id": "m1"}, {"id": "fast"}},
		}},
		"defaultModel": map[string]any{"providerId": "p1", "modelId": "m1"},
		// 起标题走 fast,便于把标题请求与回答请求分开
		"fastModel": map[string]any{"providerId": "p1", "modelId": "fast"},
	}
	for k, v := range extra {
		patch[k] = v
	}
	e.call(t, "ai.settings.update", patch)
	e.call(t, "ai.secrets", map[string]any{"secrets": map[string]string{"provider:p1": keys}})
}

type sendResult struct {
	ConversationID     string `json:"conversationId"`
	UserMessageID      string `json:"userMessageId"`
	AssistantMessageID string `json:"assistantMessageId"`
}

func (e *testEnv) send(t *testing.T, params map[string]any) sendResult {
	t.Helper()
	var r sendResult
	e.callInto(t, "ai.chat.send", params, &r)
	return r
}

func (e *testEnv) conversation(t *testing.T, id string) Conversation {
	t.Helper()
	var c Conversation
	e.callInto(t, "ai.conversations.get", map[string]any{"id": id}, &c)
	return c
}

// ---------- 模拟服务商 ----------

type mockCall struct {
	id, name, args string
}

// turn 是模拟服务商的一次回答。
type turn struct {
	text   []string // 文字分段(逐段推送)
	calls  []mockCall
	status int    // 非 0 时直接回这个 HTTP 状态
	body   string // 错误体
	hold   bool   // 推完文字后挂住,直到客户端断开(测试停止)
}

type recorded struct {
	method string
	path   string
	query  string
	header http.Header
	body   string
}

// mockLLM 按协议吐 SSE 的模拟服务商:每次 POST 取下一个回答,脚本用完后用 fallback。
type mockLLM struct {
	protocol string
	srv      *httptest.Server
	quit     chan struct{}

	mu       sync.Mutex
	turns    []turn
	reqs     []recorded
	fallback func(r recorded) turn
	// keyStatus 指定某个密钥收到的 HTTP 状态(测试多密钥轮换)
	keyStatus map[string]int
	held      chan struct{} // 挂住的回答开始挂起时发信号
}

func newMockLLM(t *testing.T, protocol string, turns ...turn) *mockLLM {
	m := &mockLLM{protocol: protocol, turns: turns, quit: make(chan struct{}), keyStatus: map[string]int{}, held: make(chan struct{}, 4)}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(func() {
		close(m.quit)
		m.srv.CloseClientConnections()
		m.srv.Close()
	})
	return m
}

func (m *mockLLM) requests() []recorded {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]recorded(nil), m.reqs...)
}

// chatPosts 是回答用的请求(模型 m1),不含起标题(模型 fast)。
func (m *mockLLM) chatPosts() []recorded {
	var out []recorded
	for _, r := range m.posts() {
		if strings.Contains(r.body, `"model":"m1"`) || strings.Contains(r.path, "/models/m1:") {
			out = append(out, r)
		}
	}
	return out
}

// posts 是收到的生成请求(不含模型列表等 GET)。
func (m *mockLLM) posts() []recorded {
	var out []recorded
	for _, r := range m.requests() {
		if r.method == http.MethodPost {
			out = append(out, r)
		}
	}
	return out
}

// headerKey 取请求里带的密钥(三种鉴权头之一)。
func headerKey(h http.Header) string {
	if k := h.Get("x-api-key"); k != "" {
		return k
	}
	if k := h.Get("x-goog-api-key"); k != "" {
		return k
	}
	return strings.TrimPrefix(h.Get("Authorization"), "Bearer ")
}

func (m *mockLLM) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	m.mu.Lock()
	m.reqs = append(m.reqs, recorded{method: r.Method, path: r.URL.Path, query: r.URL.RawQuery, header: r.Header.Clone(), body: string(body)})
	status := m.keyStatus[headerKey(r.Header)]
	var tn turn
	if r.Method == http.MethodPost && status == 0 {
		if len(m.turns) > 0 {
			tn = m.turns[0]
			m.turns = m.turns[1:]
		} else if m.fallback != nil {
			tn = m.fallback(m.reqs[len(m.reqs)-1])
		} else {
			tn = turn{text: []string{"好的"}}
		}
	}
	m.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		fmt.Fprintf(w, `{"error":{"message":"密钥 %s 不可用"}}`, headerKey(r.Header))
		return
	}
	if r.Method == http.MethodGet {
		m.serveModels(w)
		return
	}
	if tn.status != 0 {
		w.WriteHeader(tn.status)
		io.WriteString(w, tn.body)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	fl := w.(http.Flusher)
	send := func(event string, data any) {
		b, _ := json.Marshal(data)
		if event != "" {
			fmt.Fprintf(w, "event: %s\n", event)
		}
		fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}
	hold := func() {
		if !tn.hold {
			return
		}
		m.held <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-m.quit:
		}
	}
	switch m.protocol {
	case protoAnthropic:
		send("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": "msg_1", "role": "assistant"}})
		idx := 0
		if len(tn.text) > 0 {
			send("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}})
			for _, t := range tn.text {
				send("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": t}})
			}
			hold()
			send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
			idx++
		}
		for _, c := range tn.calls {
			send("content_block_start", map[string]any{"type": "content_block_start", "index": idx, "content_block": map[string]any{"type": "tool_use", "id": c.id, "name": c.name, "input": map[string]any{}}})
			half := len(c.args) / 2
			for _, part := range []string{c.args[:half], c.args[half:]} {
				send("content_block_delta", map[string]any{"type": "content_block_delta", "index": idx, "delta": map[string]any{"type": "input_json_delta", "partial_json": part}})
			}
			send("content_block_stop", map[string]any{"type": "content_block_stop", "index": idx})
			idx++
		}
		send("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn"}})
		send("message_stop", map[string]any{"type": "message_stop"})
	case protoOpenAIChat:
		for _, t := range tn.text {
			send("", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": t}}}})
		}
		hold()
		for i, c := range tn.calls {
			send("", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{
				map[string]any{"index": i, "id": c.id, "type": "function", "function": map[string]any{"name": c.name, "arguments": ""}},
			}}}}})
			half := len(c.args) / 2
			for _, part := range []string{c.args[:half], c.args[half:]} {
				send("", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{
					map[string]any{"index": i, "function": map[string]any{"arguments": part}},
				}}}}})
			}
		}
		send("", map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}}})
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	case protoOpenAIResponses:
		send("response.created", map[string]any{"type": "response.created", "response": map[string]any{"id": "resp_1"}})
		for _, t := range tn.text {
			send("response.output_text.delta", map[string]any{"type": "response.output_text.delta", "delta": t})
		}
		hold()
		for _, c := range tn.calls {
			send("response.output_item.added", map[string]any{"type": "response.output_item.added", "item": map[string]any{"type": "function_call", "id": "fc_" + c.id, "call_id": c.id, "name": c.name, "arguments": ""}})
			send("response.function_call_arguments.delta", map[string]any{"type": "response.function_call_arguments.delta", "item_id": "fc_" + c.id, "delta": c.args})
			send("response.output_item.done", map[string]any{"type": "response.output_item.done", "item": map[string]any{"type": "function_call", "id": "fc_" + c.id, "call_id": c.id, "name": c.name, "arguments": c.args}})
		}
		send("response.completed", map[string]any{"type": "response.completed", "response": map[string]any{"id": "resp_1", "status": "completed"}})
	case protoGemini:
		for _, t := range tn.text {
			send("", map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": t}}}}}})
		}
		hold()
		var parts []any
		for i, c := range tn.calls {
			var args any
			_ = json.Unmarshal([]byte(c.args), &args)
			parts = append(parts, map[string]any{"functionCall": map[string]any{"id": c.id, "name": c.name, "args": args}, "thoughtSignature": fmt.Sprintf("sig-%d", i)})
		}
		last := map[string]any{"finishReason": "STOP", "content": map[string]any{"role": "model", "parts": parts}}
		if len(parts) == 0 {
			last["content"] = map[string]any{"role": "model", "parts": []any{map[string]any{"text": ""}}}
		}
		send("", map[string]any{"candidates": []any{last}})
	}
}

func (m *mockLLM) serveModels(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	switch m.protocol {
	case protoGemini:
		io.WriteString(w, `{"models":[{"name":"models/gemini-b","displayName":"B","supportedGenerationMethods":["generateContent"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]},{"name":"models/gemini-a","displayName":"A","supportedGenerationMethods":["generateContent","countTokens"]}]}`)
	case protoAnthropic:
		io.WriteString(w, `{"data":[{"id":"claude-b","display_name":"Claude B"},{"id":"claude-a","display_name":"Claude A"}],"has_more":false}`)
	default:
		io.WriteString(w, `{"object":"list","data":[{"id":"gpt-b"},{"id":"gpt-a"}]}`)
	}
}

// waitHeld 等挂住的回答开始挂起。
func (m *mockLLM) waitHeld(t *testing.T) {
	t.Helper()
	select {
	case <-m.held:
	case <-time.After(10 * time.Second):
		t.Fatal("模拟服务商没有开始挂起")
	}
}

// partsOf 取对话里某条消息的部件。
func partsOf(c Conversation, id string) []Part {
	if m := c.Messages[id]; m != nil {
		return m.Parts
	}
	return nil
}

func textOfParts(parts []Part) string {
	var b strings.Builder
	for _, p := range parts {
		if p.Type == partText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}
