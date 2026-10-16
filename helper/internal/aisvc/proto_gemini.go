package aisvc

import (
	"context"
	"encoding/json"
	"strings"
)

// Gemini:POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse,每个 SSE 数据是一份
// GenerateContentResponse,candidates[0].content.parts 里是 text 或完整的 functionCall。

func (c *providerClient) streamGemini(ctx context.Context, req *llmRequest, kick func(), onText func(string)) (*llmResponse, error) {
	names := newToolNames(req.tools)
	var contents []map[string]any
	for _, m := range req.messages {
		role := "user"
		var parts []any
		if m.role == "assistant" {
			role = "model"
			if m.text != "" {
				parts = append(parts, map[string]any{"text": m.text})
			}
			for _, call := range m.calls {
				p := map[string]any{"functionCall": map[string]any{"name": wireName(call.name), "args": argsObject(call.args)}}
				// Gemini 3 校验同一轮里函数调用的 thoughtSignature,要原样带回
				if call.sig != "" {
					p["thoughtSignature"] = call.sig
				}
				parts = append(parts, p)
			}
		} else {
			for _, r := range m.results {
				key := "result"
				if r.isError {
					key = "error"
				}
				parts = append(parts, map[string]any{"functionResponse": map[string]any{
					"name": wireName(r.name), "response": map[string]any{key: r.content},
				}})
			}
			if m.text != "" {
				parts = append(parts, map[string]any{"text": m.text})
			}
		}
		if len(parts) == 0 {
			continue
		}
		// 相邻同角色合并:Gemini 要求 user / model 交替
		if n := len(contents); n > 0 && contents[n-1]["role"] == role {
			contents[n-1]["parts"] = append(contents[n-1]["parts"].([]any), parts...)
			continue
		}
		contents = append(contents, map[string]any{"role": role, "parts": parts})
	}
	body := map[string]any{"contents": contents}
	if req.system != "" {
		body["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": req.system}}}
	}
	gen := map[string]any{}
	if req.temperature != nil {
		gen["temperature"] = *req.temperature
	}
	if req.topP != nil {
		gen["topP"] = *req.topP
	}
	if req.maxTokens != nil {
		gen["maxOutputTokens"] = *req.maxTokens
	}
	if len(gen) > 0 {
		body["generationConfig"] = gen
	}
	if len(req.tools) > 0 {
		decls := make([]map[string]any, 0, len(req.tools))
		for _, t := range req.tools {
			d := map[string]any{"name": wireName(t.name), "description": t.description}
			if s := geminiSchema(objectSchema(t.schema)); s != nil {
				d["parameters"] = s
			}
			decls = append(decls, d)
		}
		body["tools"] = []any{map[string]any{"functionDeclarations": decls}}
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
	finish := ""
	err = readSSE(resp.Body, kick, func(ev sseEvent) error {
		var d struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text         string `json:"text"`
						Thought      bool   `json:"thought"`
						FunctionCall *struct {
							ID   string          `json:"id"`
							Name string          `json:"name"`
							Args json.RawMessage `json:"args"`
						} `json:"functionCall"`
						ThoughtSignature string `json:"thoughtSignature"`
					} `json:"parts"`
				} `json:"content"`
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
			PromptFeedback *struct {
				BlockReason string `json:"blockReason"`
			} `json:"promptFeedback"`
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
		if d.PromptFeedback != nil && d.PromptFeedback.BlockReason != "" {
			return errf(codeProvider, "请求被服务商拦截(%s)", d.PromptFeedback.BlockReason)
		}
		if len(d.Candidates) == 0 {
			return nil
		}
		cand := d.Candidates[0]
		for _, p := range cand.Content.Parts {
			switch {
			case p.FunctionCall != nil:
				args := json.RawMessage("{}")
				if len(p.FunctionCall.Args) > 0 && string(p.FunctionCall.Args) != "null" {
					args = p.FunctionCall.Args
				}
				id := p.FunctionCall.ID
				if id == "" {
					id = "call_" + newID()
				}
				out.calls = append(out.calls, llmCall{id: id, name: names.full(p.FunctionCall.Name), args: args, sig: p.ThoughtSignature})
			case p.Text != "" && !p.Thought:
				text.WriteString(p.Text)
				onText(p.Text)
			}
		}
		if cand.FinishReason != "" {
			finish = cand.FinishReason
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if finish == "" {
		return nil, errf(codeNetwork, "回答没有正常结束,连接可能中断了")
	}
	out.text = text.String()
	if out.text == "" && len(out.calls) == 0 && finish != "STOP" && finish != "MAX_TOKENS" {
		return nil, errf(codeProvider, "回答被服务商拦截(%s)", finish)
	}
	return out, nil
}

// geminiAllowedKeys 是 Gemini 函数参数结构(OpenAPI 子集)认得的字段;多出的字段(如 additionalProperties、$schema)会被拒收。
var geminiAllowedKeys = map[string]bool{
	"type": true, "format": true, "title": true, "description": true, "nullable": true, "enum": true,
	"maxItems": true, "minItems": true, "properties": true, "required": true, "minProperties": true,
	"maxProperties": true, "minLength": true, "maxLength": true, "pattern": true, "example": true,
	"anyOf": true, "propertyOrdering": true, "default": true, "items": true, "minimum": true, "maximum": true,
}

// geminiSchema 把 JSON Schema 裁成 Gemini 接受的样子;没有参数的对象返回 nil(Gemini 不接受空 properties 的对象)。
func geminiSchema(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	out := map[string]any{}
	for k, val := range m {
		if !geminiAllowedKeys[k] {
			continue
		}
		switch k {
		case "type":
			// ["string","null"] 这种写法改成 type + nullable
			if arr, ok := val.([]any); ok {
				for _, t := range arr {
					if s, _ := t.(string); s == "null" {
						out["nullable"] = true
					} else if s != "" {
						out["type"] = s
					}
				}
				continue
			}
			out[k] = val
		case "properties":
			props, ok := val.(map[string]any)
			if !ok {
				continue
			}
			cp := map[string]any{}
			for name, p := range props {
				// 嵌套的空对象 Gemini 同样不收,只能丢掉这个参数
				if sub := geminiSchema(p); sub != nil {
					cp[name] = sub
				}
			}
			out[k] = cp
		case "items":
			if sub := geminiSchema(val); sub != nil {
				out[k] = sub
			}
		case "anyOf":
			arr, ok := val.([]any)
			if !ok {
				continue
			}
			cp := make([]any, 0, len(arr))
			for _, p := range arr {
				cp = append(cp, geminiSchema(p))
			}
			out[k] = cp
		case "enum":
			// Gemini 只接受字符串枚举
			arr, ok := val.([]any)
			if !ok {
				continue
			}
			allString := true
			for _, e := range arr {
				if _, ok := e.(string); !ok {
					allString = false
				}
			}
			if allString {
				out[k] = val
			}
		case "format":
			if s, _ := val.(string); s == "date-time" || s == "enum" || s == "int32" || s == "int64" || s == "float" || s == "double" {
				out[k] = val
			}
		default:
			out[k] = val
		}
	}
	if out["type"] == "object" {
		props, _ := out["properties"].(map[string]any)
		if len(props) == 0 {
			return nil
		}
	}
	return out
}
