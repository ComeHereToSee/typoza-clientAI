package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
)

// OpenAI Chat Completions:POST {base}/v1/chat/completions,SSE 里 choices[].delta 带 content / tool_calls,以 [DONE] 结束。

func (c *providerClient) streamOpenAIChat(ctx context.Context, req *llmRequest, kick func(), onText func(string)) (*llmResponse, error) {
	names := newToolNames(req.tools)
	msgs := []map[string]any{}
	if req.system != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.system})
	}
	for _, m := range req.messages {
		if m.role == "user" {
			for _, r := range m.results {
				msgs = append(msgs, map[string]any{"role": "tool", "tool_call_id": r.callID, "content": r.content})
			}
			if m.text != "" {
				msgs = append(msgs, map[string]any{"role": "user", "content": m.text})
			}
			continue
		}
		if m.text == "" && len(m.calls) == 0 {
			continue
		}
		am := map[string]any{"role": "assistant", "content": nil}
		if m.text != "" {
			am["content"] = m.text
		}
		if len(m.calls) > 0 {
			calls := make([]map[string]any, 0, len(m.calls))
			for _, call := range m.calls {
				calls = append(calls, map[string]any{
					"id": call.id, "type": "function",
					"function": map[string]any{"name": wireName(call.name), "arguments": string(argsObject(call.args))},
				})
			}
			am["tool_calls"] = calls
		}
		msgs = append(msgs, am)
	}
	body := map[string]any{"model": req.model, "messages": msgs, "stream": true}
	if req.temperature != nil {
		body["temperature"] = *req.temperature
	}
	if req.topP != nil {
		body["top_p"] = *req.topP
	}
	if req.maxTokens != nil {
		body["max_tokens"] = *req.maxTokens
	}
	if len(req.tools) > 0 {
		tools := make([]map[string]any, 0, len(req.tools))
		for _, t := range req.tools {
			tools = append(tools, map[string]any{"type": "function", "function": map[string]any{
				"name": wireName(t.name), "description": t.description, "parameters": objectSchema(t.schema),
			}})
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

	type toolCall struct {
		id, name string
		args     strings.Builder
	}
	var calls []*toolCall
	byIndex := map[int]*toolCall{}
	var text strings.Builder
	completed := false
	err = readSSE(resp.Body, kick, func(ev sseEvent) error {
		if strings.TrimSpace(ev.data) == "[DONE]" {
			completed = true
			return errStopSSE
		}
		var d struct {
			Choices []struct {
				Delta struct {
					Content   string `json:"content"`
					ToolCalls []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason string `json:"finish_reason"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(ev.data), &d); err != nil {
			return errf(codeProvider, "服务商返回的数据格式不对:%v", err)
		}
		if d.Error != nil {
			return errf(codeProvider, "服务商返回错误:%s", d.Error.Message)
		}
		for _, ch := range d.Choices {
			if ch.Delta.Content != "" {
				text.WriteString(ch.Delta.Content)
				onText(ch.Delta.Content)
			}
			for _, f := range ch.Delta.ToolCalls {
				tc := byIndex[f.Index]
				// 有的兼容接口不给 index(全是 0),靠新的 id 区分并行的多个调用
				if tc == nil || (f.ID != "" && tc.id != "" && f.ID != tc.id) {
					tc = &toolCall{}
					byIndex[f.Index] = tc
					calls = append(calls, tc)
				}
				if f.ID != "" {
					tc.id = f.ID
				}
				if tc.name == "" {
					tc.name = f.Function.Name
				}
				tc.args.WriteString(f.Function.Arguments)
			}
			if ch.FinishReason != "" {
				completed = true
			}
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
	for _, tc := range calls {
		args := strings.TrimSpace(tc.args.String())
		if args == "" {
			args = "{}"
		}
		id := tc.id
		if id == "" {
			id = "call_" + newID()
		}
		out.calls = append(out.calls, llmCall{id: id, name: names.full(tc.name), args: json.RawMessage(args)})
	}
	return out, nil
}

// OpenAI Responses:POST {base}/v1/responses,SSE 里 response.output_text.delta 带文字,
// response.output_item.done 带完整的 function_call 项。store=false:不在服务商那边留存对话。

func (c *providerClient) streamResponses(ctx context.Context, req *llmRequest, kick func(), onText func(string)) (*llmResponse, error) {
	names := newToolNames(req.tools)
	input := []any{}
	for _, m := range req.messages {
		if m.role == "user" {
			for _, r := range m.results {
				input = append(input, map[string]any{"type": "function_call_output", "call_id": r.callID, "output": r.content})
			}
			if m.text != "" {
				input = append(input, map[string]any{"role": "user", "content": m.text})
			}
			continue
		}
		if m.text != "" {
			input = append(input, map[string]any{"role": "assistant", "content": m.text})
		}
		for _, call := range m.calls {
			input = append(input, map[string]any{"type": "function_call", "call_id": call.id, "name": wireName(call.name), "arguments": string(argsObject(call.args))})
		}
	}
	body := map[string]any{"model": req.model, "input": input, "stream": true, "store": false}
	if req.system != "" {
		body["instructions"] = req.system
	}
	if req.temperature != nil {
		body["temperature"] = *req.temperature
	}
	if req.topP != nil {
		body["top_p"] = *req.topP
	}
	if req.maxTokens != nil {
		body["max_output_tokens"] = *req.maxTokens
	}
	if len(req.tools) > 0 {
		tools := make([]map[string]any, 0, len(req.tools))
		for _, t := range req.tools {
			tools = append(tools, map[string]any{"type": "function", "name": wireName(t.name), "description": t.description, "parameters": objectSchema(t.schema)})
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

	out := &llmResponse{}
	var text strings.Builder
	completed := false
	err = readSSE(resp.Body, kick, func(ev sseEvent) error {
		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal([]byte(ev.data), &head); err != nil {
			return errf(codeProvider, "服务商返回的数据格式不对:%v", err)
		}
		switch head.Type {
		case "response.output_text.delta":
			var d struct {
				Delta string `json:"delta"`
			}
			if err := json.Unmarshal([]byte(ev.data), &d); err != nil {
				return errf(codeProvider, "服务商返回的数据格式不对:%v", err)
			}
			text.WriteString(d.Delta)
			onText(d.Delta)
		case "response.output_item.done":
			var d struct {
				Item struct {
					Type      string `json:"type"`
					CallID    string `json:"call_id"`
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"item"`
			}
			if err := json.Unmarshal([]byte(ev.data), &d); err != nil {
				return errf(codeProvider, "服务商返回的数据格式不对:%v", err)
			}
			if d.Item.Type == "function_call" {
				args := strings.TrimSpace(d.Item.Arguments)
				if args == "" {
					args = "{}"
				}
				id := d.Item.CallID
				if id == "" {
					id = "call_" + newID()
				}
				out.calls = append(out.calls, llmCall{id: id, name: names.full(d.Item.Name), args: json.RawMessage(args)})
			}
		case "response.completed", "response.incomplete":
			completed = true
			return errStopSSE
		case "response.failed":
			var d struct {
				Response struct {
					Error *struct {
						Message string `json:"message"`
					} `json:"error"`
				} `json:"response"`
			}
			_ = json.Unmarshal([]byte(ev.data), &d)
			msg := "未知原因"
			if d.Response.Error != nil {
				msg = d.Response.Error.Message
			}
			return errf(codeProvider, "服务商返回错误:%s", msg)
		case "error":
			if msg := errorMessage([]byte(ev.data)); msg != "" {
				return errf(codeProvider, "服务商返回错误:%s", msg)
			}
			return errf(codeProvider, "服务商返回错误:%s", truncateRunes(ev.data, 300))
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopSSE) {
		return nil, err
	}
	if !completed {
		return nil, errf(codeNetwork, "回答没有正常结束,连接可能中断了")
	}
	out.text = text.String()
	return out, nil
}
