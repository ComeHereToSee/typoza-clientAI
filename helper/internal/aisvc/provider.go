package aisvc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	// requestIdle 是流式请求多久收不到数据算超时(PRD 3.1【假设】请求超时 120 秒)。
	requestIdle = 120 * time.Second
	// testTimeout 是「检测连接」的超时(PRD 3.1【假设】20 秒),获取模型列表同此。
	testTimeout = 20 * time.Second
	// anthropicMaxTokens 是 Anthropic 必填的 max_tokens 在助手没设时的取值【假设】。
	anthropicMaxTokens = 8192
)

// ---------- 统一的内部消息 ----------

// llmMsg 是协议无关的一条消息:assistant 带文字与工具调用;user 带工具结果(紧接上一条 assistant)与文字。
type llmMsg struct {
	role    string // user | assistant
	text    string
	calls   []llmCall
	results []llmResult
}

type llmCall struct {
	id   string
	name string // 工具全名
	args json.RawMessage
	sig  string // Gemini 的 thoughtSignature:同一轮工具循环里要原样带回,只在内存里
}

type llmResult struct {
	callID  string
	name    string // 工具全名
	content string
	isError bool
}

type llmTool struct {
	name        string // 工具全名
	description string
	schema      any
}

type llmRequest struct {
	model       string
	system      string
	messages    []llmMsg
	tools       []llmTool
	temperature *float64
	topP        *float64
	maxTokens   *int
}

type llmResponse struct {
	text  string
	calls []llmCall
}

// ---------- 工具名 ----------

var wireNameRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// wireName 把工具全名变成各家都接受的函数名(OpenAI 要求 ^[a-zA-Z0-9_-]{1,64}$):
// 不合规的字符换成 _,过长的截短并接上哈希,保证同一个全名总是得到同一个结果。
func wireName(full string) string {
	if wireNameRe.MatchString(full) {
		return full
	}
	b := []byte(full)
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			b[i] = '_'
		}
	}
	s := string(b)
	if len(s) > 64 || s != full {
		sum := sha256.Sum256([]byte(full))
		if len(s) > 55 {
			s = s[:55]
		}
		s += "_" + hex.EncodeToString(sum[:4])
	}
	return s
}

// toolNames 记录本次请求里函数名到工具全名的对应。
type toolNames map[string]string

func newToolNames(tools []llmTool) toolNames {
	n := toolNames{}
	for _, t := range tools {
		n[wireName(t.name)] = t.name
	}
	return n
}

func (n toolNames) full(wire string) string {
	if f, ok := n[wire]; ok {
		return f
	}
	return wire
}

// argsObject 保证工具参数是 JSON 对象(各家都要求);模型给的参数不是对象时按空对象发回去。
func argsObject(raw json.RawMessage) json.RawMessage {
	t := bytes.TrimSpace(raw)
	if len(t) > 0 && t[0] == '{' && json.Valid(t) {
		return t
	}
	return json.RawMessage("{}")
}

// flattenTools 把历史里的工具调用改写成文字:本次请求不带工具时,有的服务商(如 Anthropic)
// 不接受历史里出现工具调用块。
func flattenTools(msgs []llmMsg) []llmMsg {
	out := make([]llmMsg, 0, len(msgs))
	for _, m := range msgs {
		if len(m.calls) == 0 && len(m.results) == 0 {
			out = append(out, m)
			continue
		}
		var b strings.Builder
		for _, r := range m.results {
			fmt.Fprintf(&b, "[工具 %s 的结果]\n%s\n\n", r.name, r.content)
		}
		b.WriteString(m.text)
		for _, c := range m.calls {
			fmt.Fprintf(&b, "\n[调用工具 %s,参数 %s]", c.name, argsObject(c.args))
		}
		out = append(out, llmMsg{role: m.role, text: strings.TrimSpace(b.String())})
	}
	return out
}

// ---------- 地址 ----------

var versionSuffixRe = regexp.MustCompile(`/v\d+[a-z0-9]*$`)

func defaultBaseURL(protocol string) string {
	switch protocol {
	case protoAnthropic:
		return "https://api.anthropic.com"
	case protoGemini:
		return "https://generativelanguage.googleapis.com"
	default:
		return "https://api.openai.com"
	}
}

func chatPath(protocol, model string) string {
	switch protocol {
	case protoAnthropic:
		return "/messages"
	case protoOpenAIResponses:
		return "/responses"
	case protoGemini:
		return "/models/" + url.PathEscape(strings.TrimPrefix(model, "models/")) + ":streamGenerateContent?alt=sse"
	default:
		return "/chat/completions"
	}
}

// apiURL 拼出接口地址。kind 为 chat 或 models。
// 一般只填根地址:没写版本段(/v1、/v1beta、/v4…)就补默认版本,再接接口路径;
// 末尾写 # 表示给的就是完整地址,原样使用、不拼路径(与 Cherry Studio 一致)。
func apiURL(p Provider, kind, model string) (string, error) {
	base := strings.TrimSpace(p.BaseURL)
	if base == "" {
		base = defaultBaseURL(p.Protocol)
	}
	if strings.HasSuffix(base, "#") {
		raw := strings.TrimSuffix(base, "#")
		if kind == "chat" {
			if p.Protocol == protoGemini {
				raw = strings.ReplaceAll(raw, "{model}", url.PathEscape(model))
				// 只认 SSE 流,用户没写 alt=sse 时补上
				if !strings.Contains(raw, "alt=sse") {
					if strings.Contains(raw, "?") {
						raw += "&alt=sse"
					} else {
						raw += "?alt=sse"
					}
				}
			}
			return raw, nil
		}
		// 完整地址只对应聊天接口,模型列表接口按约定的路径反推
		if p.Protocol == protoGemini {
			if i := strings.Index(raw, "/models/"); i >= 0 {
				return raw[:i] + "/models?pageSize=1000", nil
			}
		} else if path := chatPath(p.Protocol, model); strings.HasSuffix(raw, path) {
			return strings.TrimSuffix(raw, path) + "/models", nil
		}
		return "", errf(codeInvalid, "地址以 # 结尾,推断不出模型列表接口,请手动添加模型")
	}
	b := strings.TrimRight(base, "/")
	if !versionSuffixRe.MatchString(b) {
		if p.Protocol == protoGemini {
			b += "/v1beta"
		} else {
			b += "/v1"
		}
	}
	if kind == "chat" {
		return b + chatPath(p.Protocol, model), nil
	}
	switch p.Protocol {
	case protoGemini:
		return b + "/models?pageSize=1000", nil
	case protoAnthropic:
		return b + "/models?limit=1000", nil
	default:
		return b + "/models", nil
	}
}

// setAuth 按协议写鉴权头;key 为空(本机服务商可不填密钥)时不写。
func setAuth(protocol string, h http.Header, key string) {
	switch protocol {
	case protoAnthropic:
		h.Set("anthropic-version", "2023-06-01")
		if key != "" {
			h.Set("x-api-key", key)
		}
	case protoGemini:
		if key != "" {
			h.Set("x-goog-api-key", key)
		}
	default:
		if key != "" {
			h.Set("Authorization", "Bearer "+key)
		}
	}
}

// ---------- 请求 ----------

// providerClient 是对某个服务商的一次调用。
type providerClient struct {
	svc  *Service
	p    Provider
	keys []string
}

func (s *Service) providerClient(p Provider, secrets map[string]string) *providerClient {
	return &providerClient{svc: s, p: p, keys: splitKeys(secrets[providerSecretRef(p.ID)])}
}

// do 发请求;有多个密钥时遇 401 / 429 换下一个(PRD 3.1【假设】),成功的密钥下次优先用。
func (c *providerClient) do(ctx context.Context, method, u string, body []byte) (*http.Response, error) {
	keys := c.keys
	if len(keys) == 0 {
		keys = []string{""}
	}
	c.svc.mu.Lock()
	start := c.svc.keyIndex[c.p.ID]
	c.svc.mu.Unlock()
	var lastErr error
	for i := range keys {
		idx := (start + i) % len(keys)
		var rd io.Reader = http.NoBody
		if body != nil {
			rd = bytes.NewReader(body)
		}
		req, err := http.NewRequestWithContext(ctx, method, u, rd)
		if err != nil {
			return nil, errf(codeInvalid, "服务商地址不对:%v", err)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		setAuth(c.p.Protocol, req.Header, keys[idx])
		resp, err := c.svc.http.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode/100 == 2 {
			c.svc.mu.Lock()
			c.svc.keyIndex[c.p.ID] = idx
			c.svc.mu.Unlock()
			return resp, nil
		}
		lastErr = httpStatusError(resp)
		if resp.StatusCode != http.StatusUnauthorized && resp.StatusCode != http.StatusTooManyRequests {
			break
		}
	}
	return nil, lastErr
}

func (c *providerClient) post(ctx context.Context, u string, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("编码请求: %w", err)
	}
	resp, err := c.do(ctx, http.MethodPost, u, b)
	if err != nil {
		return nil, err
	}
	// 有的代理在出错时仍回 200 加一段 JSON,而不是 SSE
	if strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		if msg := errorMessage(raw); msg != "" {
			return nil, errf(codeProvider, "服务商返回错误:%s", msg)
		}
		return nil, errf(codeProvider, "服务商没有返回流式数据:%s", truncateRunes(string(raw), 300))
	}
	return resp, nil
}

// httpStatusError 把非 2xx 响应转成契约错误码,message 带服务商原文。
func httpStatusError(resp *http.Response) *aiError {
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	msg := errorMessage(raw)
	if msg == "" {
		msg = strings.TrimSpace(truncateRunes(string(raw), 500))
	}
	if msg == "" {
		msg = resp.Status
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return errf(codeAuth, "鉴权失败(HTTP %d):%s。请检查密钥", resp.StatusCode, msg)
	case http.StatusTooManyRequests:
		return errf(codeRateLimit, "请求太频繁或额度不足(HTTP 429):%s", msg)
	default:
		return errf(codeProvider, "服务商返回错误(HTTP %d):%s", resp.StatusCode, msg)
	}
}

// errorMessage 从各家的错误体里取出说明:{error:{message}}、{error:"…"}、{message}、[{error:{message}}]。
func errorMessage(raw []byte) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return ""
	}
	if arr, ok := v.([]any); ok && len(arr) > 0 {
		v = arr[0]
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	switch e := obj["error"].(type) {
	case string:
		return e
	case map[string]any:
		if m, ok := e["message"].(string); ok {
			return m
		}
	}
	if m, ok := obj["message"].(string); ok {
		return m
	}
	if m, ok := obj["detail"].(string); ok {
		return m
	}
	return ""
}

var errIdle = errors.New("idle timeout")

// idleContext 返回一个「多久没收到数据就取消」的 ctx:kick 表示刚收到数据,done 释放计时器。
func idleContext(parent context.Context, d time.Duration) (ctx context.Context, kick func(), done func()) {
	ctx, cancel := context.WithCancelCause(parent)
	t := time.AfterFunc(d, func() { cancel(errIdle) })
	return ctx, func() { t.Reset(d) }, func() { t.Stop(); cancel(nil) }
}

// classifyErr 把请求过程中的错误归到契约错误码。
func classifyErr(ctx context.Context, err error) *aiError {
	var ae *aiError
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(context.Cause(ctx), errIdle) {
		return errf(codeNetwork, "服务商 %d 秒没有响应,已断开", int(requestIdle/time.Second))
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return errf(codeNetwork, "请求超时")
	}
	if ctx.Err() != nil {
		return errf(codeCancelled, "已停止")
	}
	return errf(codeNetwork, "网络错误:%v", err)
}

// ---------- SSE ----------

type sseEvent struct {
	event string
	data  string
}

// readSSE 逐个事件回调 fn;fn 返回 errStopSSE 表示正常结束。
func readSSE(r io.Reader, kick func(), fn func(sseEvent) error) error {
	br := bufio.NewReaderSize(r, 64<<10)
	var event string
	var data strings.Builder
	hasData := false
	dispatch := func() error {
		if !hasData {
			event = ""
			return nil
		}
		ev := sseEvent{event: event, data: data.String()}
		event, hasData = "", false
		data.Reset()
		return fn(ev)
	}
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			kick()
		}
		if err != nil && err != io.EOF {
			return err
		}
		eof := err == io.EOF
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if err := dispatch(); err != nil {
				return err
			}
		case strings.HasPrefix(line, ":"):
			// 注释行(心跳)
		default:
			field, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "event":
				event = value
			case "data":
				if hasData {
					data.WriteByte('\n')
				}
				data.WriteString(value)
				hasData = true
			}
		}
		if eof {
			return dispatch()
		}
	}
}

var errStopSSE = errors.New("sse done")

// ---------- 对外入口 ----------

// stream 发一次流式请求;onText 收到文字增量时调用(可为 nil)。
func (c *providerClient) stream(ctx context.Context, req *llmRequest, onText func(string)) (*llmResponse, error) {
	if onText == nil {
		onText = func(string) {}
	}
	if len(req.tools) == 0 {
		r := *req
		r.messages = flattenTools(req.messages)
		req = &r
	}
	ictx, kick, done := idleContext(ctx, requestIdle)
	defer done()
	var resp *llmResponse
	var err error
	switch c.p.Protocol {
	case protoAnthropic:
		resp, err = c.streamAnthropic(ictx, req, kick, onText)
	case protoOpenAIChat:
		resp, err = c.streamOpenAIChat(ictx, req, kick, onText)
	case protoOpenAIResponses:
		resp, err = c.streamResponses(ictx, req, kick, onText)
	case protoGemini:
		resp, err = c.streamGemini(ictx, req, kick, onText)
	default:
		return nil, errf(codeInvalid, "接口协议「%s」不支持", c.p.Protocol)
	}
	if err != nil {
		return nil, classifyErr(ictx, err)
	}
	return resp, nil
}

// listModels 调服务商的模型列表接口。
func (c *providerClient) listModels(ctx context.Context) ([]ModelInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, testTimeout)
	defer cancel()
	u, err := apiURL(c.p, "models", "")
	if err != nil {
		return nil, err
	}
	resp, err := c.do(ctx, http.MethodGet, u, nil)
	if err != nil {
		ae := classifyErr(ctx, err)
		if ae.Code == codeProvider && strings.Contains(ae.Message, "HTTP 404") {
			return nil, errf(codeProvider, "这个服务商没有模型列表接口,请手动添加模型")
		}
		return nil, ae
	}
	defer resp.Body.Close()
	var body struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
		Models []struct {
			Name                       string   `json:"name"`
			DisplayName                string   `json:"displayName"`
			SupportedGenerationMethods []string `json:"supportedGenerationMethods"`
		} `json:"models"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(&body); err != nil {
		return nil, errf(codeProvider, "模型列表格式不对:%v", err)
	}
	out := []ModelInfo{}
	if c.p.Protocol == protoGemini {
		for _, m := range body.Models {
			if len(m.SupportedGenerationMethods) > 0 && !contains(m.SupportedGenerationMethods, "generateContent") {
				continue
			}
			out = append(out, ModelInfo{ID: strings.TrimPrefix(m.Name, "models/"), Name: m.DisplayName})
		}
	} else {
		for _, m := range body.Data {
			out = append(out, ModelInfo{ID: m.ID, Name: m.DisplayName})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// ---------- RPC ----------

type providerModelsParams struct {
	ProviderID string `json:"providerId"`
}

func (s *Service) providerModels(ctx context.Context, p providerModelsParams) (any, error) {
	sn := s.snap()
	prov := sn.st.provider(p.ProviderID)
	if prov == nil {
		return nil, errf(codeNotFound, "没有这个服务商")
	}
	models, err := s.providerClient(*prov, sn.secrets).listModels(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"models": models}, nil
}

type providerTestParams struct {
	ProviderID string `json:"providerId"`
	ModelID    string `json:"modelId"`
}

// providerTest 用所选模型发一条极短的请求,成功返回耗时。
func (s *Service) providerTest(ctx context.Context, p providerTestParams) (any, error) {
	sn := s.snap()
	prov := sn.st.provider(p.ProviderID)
	if prov == nil {
		return nil, errf(codeNotFound, "没有这个服务商")
	}
	if p.ModelID == "" {
		return nil, errf(codeInvalid, "请选择要检测的模型")
	}
	ctx, cancel := context.WithTimeout(ctx, testTimeout)
	defer cancel()
	maxTokens := 16
	start := time.Now()
	_, err := s.providerClient(*prov, sn.secrets).stream(ctx, &llmRequest{
		model:     p.ModelID,
		messages:  []llmMsg{{role: "user", text: "Hi"}},
		maxTokens: &maxTokens,
	}, nil)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errf(codeNetwork, "检测超时(%d 秒没有完成)", int(testTimeout/time.Second))
		}
		return nil, err
	}
	return map[string]any{"ok": true, "latencyMs": time.Since(start).Milliseconds()}, nil
}
