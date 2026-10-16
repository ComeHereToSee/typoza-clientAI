package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// Anthropic Messages 接口:POST {base}/v1/messages,SSE 里 content_block_delta 带 text_delta / input_json_delta。

func (c *providerClient) streamAnthropic(ctx context.Context, req *llmRequest, kick func(), onText func(string)) (*llmResponse, error) {
	names := newToolNames(req.tools)
	maxTokens := anthropicMaxTokens
	if req.maxTokens != nil {
		maxTokens = *req.maxTokens
	}
	body := map[string]any{
		"model":      req.model,
		"max_tokens": maxTokens,
		"stream":     true,
		"messages":   anthropicMessages(req.messages),
	}
	if req.system != "" {
		body["system"] = req.system
	}
	if req.temperature != nil {
		body["temperature"] = *req.temperature
	}
	if req.topP != nil {
		body["top_p"] = *req.topP
	}
	if len(req.tools) > 0 {
		tools := make([]map[string]any, 0, len(req.tools))
		for _, t := range req.tools {
			tools = append(tools, map[string]any{"name": wireName(t.name), "description": t.description, "input_schema": objectSchema(t.schema)})
		}
		body["tools"] = tools
	}
	u, err := apiURL(c.p, "chat", req.model)
	if err != nil {
		return nil, err
	}
	resp, err := c.post(ctx, u, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	type toolBlock struct {
		id, name string
		args     strings.Builder
	}
	blocks := map[int]*toolBlock{}
	var order []int
	var text strings.Builder
	completed := false
	err = readSSE(resp.Body, kick, func(ev sseEvent) error {
		var d struct {
			Type         string `json:"type"`
			Index        int    `json:"index"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
			} `json:"delta"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(ev.data), &d); err != nil {
			return errf(codeProvider, "服务商返回的数据格式不对:%v", err)
		}
		switch d.Type {
		case "content_block_start":
			if d.ContentBlock.Type == "tool_use" {
				blocks[d.Index] = &toolBlock{id: d.ContentBlock.ID, name: d.ContentBlock.Name}
				order = append(order, d.Index)
			}
		case "content_block_delta":
			switch d.Delta.Type {
			case "text_delta":
				text.WriteString(d.Delta.Text)
				onText(d.Delta.Text)
			case "input_json_delta":
				if b := blocks[d.Index]; b != nil {
					b.args.WriteString(d.Delta.PartialJSON)
				}
			}
		case "message_stop":
			completed = true
			return errStopSSE
		case "error":
			return anthropicStreamError(d.Error.Type, d.Error.Message)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopSSE) {
		return nil, err
	}
	if !completed {
		return nil, errf(codeNetwork, "回答没有正常结束,连接可能中断了")
	}
	out := &llmResponse{text: text.String()}
	for _, i := range order {
		b := blocks[i]
		args := strings.TrimSpace(b.args.String())
		if args == "" {
			args = "{}"
		}
		out.calls = append(out.calls, llmCall{id: b.id, name: names.full(b.name), args: json.RawMessage(args)})
	}
	return out, nil
}

func anthropicStreamError(typ, msg string) *aiError {
	switch typ {
	case "rate_limit_error":
		return errf(codeRateLimit, "请求太频繁或额度不足:%s", msg)
	case "authentication_error", "permission_error":
		return errf(codeAuth, "鉴权失败:%s。请检查密钥", msg)
	case "overloaded_error":
		return errf(codeProvider, "服务商繁忙,请稍后重试:%s", msg)
	default:
		return errf(codeProvider, "服务商返回错误:%s", msg)
	}
}

// anthropicMessages 转成 Anthropic 的消息:工具结果放在 user 消息开头,相邻同角色消息合并(要求一问一答交替)。
func anthropicMessages(msgs []llmMsg) []map[string]any {
	var out []map[string]any
	for _, m := range msgs {
		var blocks []any
		if m.role == "user" {
			for _, r := range m.results {
				b := map[string]any{"type": "tool_result", "tool_use_id": r.callID, "content": r.content}
				if r.isError {
					b["is_error"] = true
				}
				blocks = append(blocks, b)
			}
			if m.text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.text})
			}
		} else {
			if m.text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": m.text})
			}
			for _, c := range m.calls {
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": c.id, "name": wireName(c.name), "input": argsObject(c.args)})
			}
		}
		if len(blocks) == 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1]["role"] == m.role {
			out[n-1]["content"] = append(out[n-1]["content"].([]any), blocks...)
			continue
		}
		out = append(out, map[string]any{"role": m.role, "content": blocks})
	}
	return out
}

// objectSchema 保证工具的参数结构是 JSON Schema 对象;MCP 工具没给时补一个空对象结构。
func objectSchema(schema any) any {
	if schema == nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	if m, ok := schema.(map[string]any); ok && m["type"] == nil {
		cp := make(map[string]any, len(m)+1)
		for k, v := range m {
			cp[k] = v
		}
		cp["type"] = "object"
		return cp
	}
	return schema
}
