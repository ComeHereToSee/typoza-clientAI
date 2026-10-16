package aisvc

import (
	"context"
	"strings"
)

// ai.complete:选中文字的 AI 动作与 /ai 的单轮生成,不入对话,结果以 complete.* 事件流式推送。

const completeSystemPrompt = "你是 Typoza 编辑器里的写作助手。只输出结果正文(Markdown),不要解释、不要客套,也不要用代码围栏包住整个结果。"

// completeParams:网页总是发已经填好占位符({{selection}} {{document}} {{language}})的完整 prompt,
// 自定义动作另带 actionId(用来取动作指定的模型),/ai 另带 cursor;selection / document / cursor
// 已经体现在 prompt 里,这里不再拼接。
type completeParams struct {
	RequestID string    `json:"requestId"`
	ActionID  string    `json:"actionId"`
	Prompt    string    `json:"prompt"`
	Selection string    `json:"selection"`
	Document  string    `json:"document"`
	Cursor    *int      `json:"cursor"`
	Model     *ModelRef `json:"model"`
}

func (s *Service) complete(_ context.Context, p completeParams) (any, error) {
	if p.RequestID == "" {
		return nil, errf(codeInvalid, "缺少 requestId")
	}
	if strings.TrimSpace(p.Prompt) == "" {
		return nil, errf(codeInvalid, "缺少 prompt")
	}
	sn := s.snap()
	var actionModel *ModelRef
	if p.ActionID != "" {
		a := sn.st.action(p.ActionID)
		if a == nil {
			return nil, errf(codeNotFound, "没有这个 AI 动作")
		}
		actionModel = a.Model
	}
	model, err := sn.st.resolveModel(p.Model, actionModel)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(s.ctx)
	s.mu.Lock()
	if _, dup := s.completes[p.RequestID]; dup {
		s.mu.Unlock()
		cancel()
		return nil, errf(codeInvalid, "requestId 重复")
	}
	s.completes[p.RequestID] = cancel
	s.mu.Unlock()

	s.goBackground(func() {
		defer func() {
			s.mu.Lock()
			delete(s.completes, p.RequestID)
			s.mu.Unlock()
			cancel()
		}()
		_, err := s.providerClient(model.provider, sn.secrets).stream(ctx, &llmRequest{
			model:    model.modelID,
			system:   completeSystemPrompt,
			messages: []llmMsg{{role: "user", text: p.Prompt}},
		}, func(delta string) {
			s.emit(map[string]any{"type": "complete.delta", "requestId": p.RequestID, "text": delta})
		})
		done := map[string]any{"type": "complete.done", "requestId": p.RequestID, "status": statusDone}
		if err != nil {
			ae := asAIError(err)
			if ae.Code == codeCancelled {
				done["status"] = statusStopped
			} else {
				done["status"] = statusError
				done["error"] = ae.info()
			}
		}
		s.emit(done)
	})
	return map[string]any{}, nil
}

type completeStopParams struct {
	RequestID string `json:"requestId"`
}

func (s *Service) completeStop(_ context.Context, p completeStopParams) (any, error) {
	s.mu.Lock()
	cancel := s.completes[p.RequestID]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return map[string]any{}, nil
}
