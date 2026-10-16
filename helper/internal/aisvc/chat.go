package aisvc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// maxToolRounds 是一次回答里连续调用工具的轮数上限(PRD 3.7【假设】20 轮)。
const maxToolRounds = 20

// mcpWaitReady 是发消息时等助手绑定的 MCP 服务器连上的最长时间(第一次用 AI 时服务器才开始连)。
const mcpWaitReady = 15 * time.Second

type generation struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type decision struct {
	decision string // allow | always | deny
	result   *string
}

// validContextKinds 是 ContextItem.kind 的取值。
var validContextKinds = map[string]bool{"document": true, "selection": true, "file": true, "conversation": true, "resource": true}

// sendParams:parentId 为空则接在当前末端后;当前末端为空(网页先 setLeaf 为 null)时新消息成为新的根,
// 用于编辑第一条消息后重发。
type sendParams struct {
	ConversationID string        `json:"conversationId"`
	ParentID       string        `json:"parentId"`
	AssistantID    string        `json:"assistantId"`
	Model          *ModelRef     `json:"model"`
	Text           string        `json:"text"`
	Context        []ContextItem `json:"context"`
}

// genSetup 是一次生成要用的设置快照。
type genSetup struct {
	snap          snapshot
	assistant     Assistant
	model         resolved
	makeTitle     bool   // 对话的第一轮:回答完成后用快速模型起标题
	fallbackTitle string // 起标题前先用的首句截断;用户改过名就不再覆盖
	userText      string
}

// chatSend 追加一条用户消息与一条空的回答,随后在后台流式生成。发送只追加节点,不改已有节点。
func (s *Service) chatSend(_ context.Context, p sendParams) (any, error) {
	if strings.TrimSpace(p.Text) == "" {
		return nil, errf(codeInvalid, "消息不能为空")
	}
	for _, c := range p.Context {
		if !validContextKinds[c.Kind] {
			return nil, errf(codeInvalid, "上下文类型「%s」不支持", c.Kind)
		}
	}
	sn := s.snap()
	if p.AssistantID != "" && sn.st.assistant(p.AssistantID) == nil {
		return nil, errf(codeNotFound, "没有这个助手")
	}
	var e *convEntry
	isNew := p.ConversationID == ""
	if isNew {
		a := sn.st.assistantOrDefault(p.AssistantID)
		// 没有可用模型时什么也不建,直接让网页提示去设置
		if _, err := sn.st.resolveModel(p.Model, a.Model); err != nil {
			return nil, err
		}
		now := nowMs()
		// 新对话写盘成功后才登记,校验失败不会留下空对话
		e = &convEntry{conv: &Conversation{ID: newID(), AssistantID: a.ID, CreatedAt: now, UpdatedAt: now, Messages: map[string]*Message{}}}
	} else {
		var err error
		if e, err = s.convs.get(p.ConversationID); err != nil {
			return nil, err
		}
	}

	e.mu.Lock()
	c := e.conv
	if p.AssistantID != "" {
		c.AssistantID = p.AssistantID
	}
	a := sn.st.assistantOrDefault(c.AssistantID)
	model, err := sn.st.resolveModel(p.Model, a.Model)
	if err != nil {
		e.mu.Unlock()
		return nil, err
	}
	parent := c.LeafID
	if p.ParentID != "" {
		if c.Messages[p.ParentID] == nil {
			e.mu.Unlock()
			return nil, errf(codeNotFound, "要接着的那条消息不存在")
		}
		parent = &p.ParentID
	}
	now := nowMs()
	user := &Message{
		ID: newID(), ParentID: copyStrPtr(parent), Role: "user",
		Parts: []Part{{Type: partText, Text: p.Text}}, Status: statusDone, Context: p.Context, CreatedAt: now,
	}
	answer := &Message{
		ID: newID(), ParentID: strPtr(user.ID), Role: "assistant",
		Parts: []Part{}, Model: model.ref(), Status: statusStreaming, CreatedAt: now,
	}
	c.Messages[user.ID] = user
	c.Messages[answer.ID] = answer
	c.LeafID = strPtr(answer.ID)
	c.UpdatedAt = now
	g := genSetup{snap: sn, assistant: a, model: model, userText: p.Text}
	if c.Title == "" {
		g.fallbackTitle = fallbackTitle(p.Text)
		c.Title = g.fallbackTitle
		g.makeTitle = len(c.Messages) == 2
	}
	err = s.convs.save(e)
	sum := summaryOf(c)
	convID := c.ID
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if isNew {
		s.convs.add(e)
	}
	s.emitConvUpdated(sum)
	s.startGeneration(e, convID, answer.ID, g)
	return map[string]any{"conversationId": convID, "userMessageId": user.ID, "assistantMessageId": answer.ID}, nil
}

func copyStrPtr(p *string) *string {
	if p == nil {
		return nil
	}
	return strPtr(*p)
}

type messageParams struct {
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId"`
}

// chatRegenerate 为某条回答生成新版本:新回答与原回答同父,原回答保留。
// 模型优先用原回答的模型(侧栏里临时选的模型),它不可用了再用助手或默认模型【假设】。
func (s *Service) chatRegenerate(_ context.Context, p messageParams) (any, error) {
	e, err := s.convs.get(p.ConversationID)
	if err != nil {
		return nil, err
	}
	sn := s.snap()
	e.mu.Lock()
	c := e.conv
	old := c.Messages[p.MessageID]
	if old == nil || old.Role != "assistant" {
		e.mu.Unlock()
		return nil, errf(codeNotFound, "没有这条回答")
	}
	a := sn.st.assistantOrDefault(c.AssistantID)
	model, err := sn.st.resolveModel(old.Model, a.Model)
	if err != nil {
		e.mu.Unlock()
		return nil, err
	}
	now := nowMs()
	answer := &Message{
		ID: newID(), ParentID: copyStrPtr(old.ParentID), Role: "assistant",
		Parts: []Part{}, Model: model.ref(), Status: statusStreaming, CreatedAt: now,
	}
	c.Messages[answer.ID] = answer
	c.LeafID = strPtr(answer.ID)
	c.UpdatedAt = now
	err = s.convs.save(e)
	sum := summaryOf(c)
	convID := c.ID
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}
	s.emitConvUpdated(sum)
	s.startGeneration(e, convID, answer.ID, genSetup{snap: sn, assistant: a, model: model})
	return map[string]any{"assistantMessageId": answer.ID}, nil
}

// chatStop 停止生成;已经结束的回答再停一次不算错。
func (s *Service) chatStop(_ context.Context, p messageParams) (any, error) {
	s.mu.Lock()
	g := s.gens[p.ConversationID+"/"+p.MessageID]
	s.mu.Unlock()
	if g != nil {
		g.cancel()
	}
	return map[string]any{}, nil
}

type setLeafParams struct {
	ConversationID string  `json:"conversationId"`
	LeafID         *string `json:"leafId"`
}

// chatSetLeaf 切换分支 / 版本。给的不是末端时沿最新的子消息走到底【假设】:
// 在 ‹ 2/3 › 切到某个版本后,后续对话跟着这个版本走(PRD 3.3)。
// leafId 为 null 表示清空当前末端:接着发的消息成为新的根(编辑第一条消息后重发),原来的树保留。
func (s *Service) chatSetLeaf(_ context.Context, p setLeafParams) (any, error) {
	e, err := s.convs.get(p.ConversationID)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	switch {
	case p.LeafID == nil:
		e.conv.LeafID = nil
	case e.conv.Messages[*p.LeafID] == nil:
		e.mu.Unlock()
		return nil, errf(codeNotFound, "没有这条消息")
	default:
		e.conv.LeafID = strPtr(deepestLeaf(e.conv, *p.LeafID))
	}
	err = s.convs.save(e)
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return convJSON(e)
}

type decideParams struct {
	ConversationID string  `json:"conversationId"`
	CallID         string  `json:"callId"`
	Decision       string  `json:"decision"`
	Result         *string `json:"result"`
}

// toolDecide 把用户的决定交给等待中的工具调用(每次询问的工具,或改文档的确认)。
func (s *Service) toolDecide(_ context.Context, p decideParams) (any, error) {
	switch p.Decision {
	case "allow", "always", "deny":
	default:
		return nil, errf(codeInvalid, "decision 只能是 allow / always / deny")
	}
	key := p.ConversationID + "/" + p.CallID
	s.mu.Lock()
	ch := s.waits[key]
	delete(s.waits, key)
	s.mu.Unlock()
	if ch == nil {
		return nil, errf(codeNotFound, "没有等待确认的工具调用")
	}
	ch <- decision{decision: p.Decision, result: p.Result}
	return map[string]any{}, nil
}

// ---------- 生成 ----------

func (s *Service) startGeneration(e *convEntry, convID, msgID string, g genSetup) {
	ctx, cancel := context.WithCancel(s.ctx)
	gen := &generation{cancel: cancel, done: make(chan struct{})}
	key := convID + "/" + msgID
	s.mu.Lock()
	s.gens[key] = gen
	s.mu.Unlock()
	s.goBackground(func() {
		defer close(gen.done)
		defer func() {
			s.mu.Lock()
			delete(s.gens, key)
			s.mu.Unlock()
			cancel()
		}()
		s.runGeneration(ctx, e, convID, msgID, g)
	})
}

// genRun 是一条回答的生成过程:把增量写进对话并推事件。
type genRun struct {
	svc    *Service
	e      *convEntry
	convID string
	msgID  string
}

func (s *Service) runGeneration(ctx context.Context, e *convEntry, convID, msgID string, g genSetup) {
	r := &genRun{svc: s, e: e, convID: convID, msgID: msgID}
	status, aerr := r.run(ctx, g)

	e.mu.Lock()
	answer := ""
	if m := e.conv.Messages[msgID]; m != nil {
		m.Status = status
		if aerr != nil {
			m.Error = aerr.info()
		}
		for i := range m.Parts {
			if pt := &m.Parts[i]; pt.Type == partToolCall && (pt.Status == callPending || pt.Status == callRunning) {
				pt.Status = callError
				pt.Error = "已停止"
			}
		}
		answer = textOf(m)
		e.conv.UpdatedAt = nowMs()
		s.convs.saveLogged(e)
	}
	sum := summaryOf(e.conv)
	e.mu.Unlock()

	done := map[string]any{"type": "message.done", "conversationId": convID, "messageId": msgID, "status": status}
	if aerr != nil {
		done["error"] = aerr.info()
	}
	s.emit(done)
	s.emitConvUpdated(sum)
	if g.makeTitle && status == statusDone {
		s.makeTitle(g, convID, answer)
	}
}

func textOf(m *Message) string {
	var b strings.Builder
	for _, p := range m.Parts {
		if p.Type == partText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

func (r *genRun) run(ctx context.Context, g genSetup) (string, *aiError) {
	s := r.svc
	r.e.mu.Lock()
	m := r.e.conv.Messages[r.msgID]
	if m == nil {
		r.e.mu.Unlock()
		return statusError, errf(codeNotFound, "消息不存在")
	}
	path := copyMessages(pathTo(r.e.conv, deref(m.ParentID)))
	r.e.mu.Unlock()

	env := toolEnv{folder: folderOf(path), hasDoc: lastUserHasDocument(path), skills: s.enabledSkills(&g.snap.st, &g.assistant)}
	if len(g.assistant.MCPServers) > 0 {
		s.mcp.ensureStarted()
		s.mcp.waitReady(ctx, g.assistant.MCPServers, mcpWaitReady)
	}
	tools := s.buildTools(&g.snap.st, &g.assistant, env)
	req := &llmRequest{
		model:       g.model.modelID,
		system:      systemPrompt(g.assistant, env.skills),
		messages:    s.historyToLLM(path),
		temperature: g.assistant.Temperature,
		topP:        g.assistant.TopP,
		maxTokens:   g.assistant.MaxTokens,
	}
	if g.model.supportsTools() {
		for _, t := range tools.list {
			req.tools = append(req.tools, llmTool{name: t.info.Name, description: t.info.Description, schema: t.info.InputSchema})
		}
	}
	client := s.providerClient(g.model.provider, g.snap.secrets)
	for round := 1; ; round++ {
		resp, err := client.stream(ctx, req, r.appendText)
		if err != nil {
			ae := asAIError(err)
			if ae.Code == codeCancelled {
				return statusStopped, nil
			}
			return statusError, ae
		}
		if len(resp.calls) == 0 {
			return statusDone, nil
		}
		if round > maxToolRounds {
			r.addCalls(resp.calls, callError, "超过工具调用轮次上限,没有执行")
			r.appendText(fmt.Sprintf("\n\n(工具调用已达 %d 轮上限,已停止。)", maxToolRounds))
			return statusDone, nil
		}
		req.messages = append(req.messages, llmMsg{role: "assistant", text: resp.text, calls: resp.calls})
		r.addCalls(resp.calls, callPending, "")
		results := make([]llmResult, 0, len(resp.calls))
		for _, call := range resp.calls {
			results = append(results, r.runTool(ctx, tools, call))
			if ctx.Err() != nil {
				return statusStopped, nil
			}
		}
		req.messages = append(req.messages, llmMsg{role: "user", results: results})
	}
}

// appendText 把文字增量接在最后一个文字部件上;最后一个部件不是文字(如工具调用)时新开一个。
// 网页按同样的规则处理 message.delta。
func (r *genRun) appendText(delta string) {
	if delta == "" {
		return
	}
	r.e.mu.Lock()
	if m := r.e.conv.Messages[r.msgID]; m != nil {
		if n := len(m.Parts); n > 0 && m.Parts[n-1].Type == partText {
			m.Parts[n-1].Text += delta
		} else {
			m.Parts = append(m.Parts, Part{Type: partText, Text: delta})
		}
	}
	r.e.mu.Unlock()
	r.svc.emit(map[string]any{"type": "message.delta", "conversationId": r.convID, "messageId": r.msgID, "text": delta})
}

// callInput 是存进部件的参数:模型给的参数不是合法 JSON 时按字符串存,照样能展示。
func callInput(args json.RawMessage) json.RawMessage {
	t := bytes.TrimSpace(args)
	if len(t) == 0 {
		return json.RawMessage("{}")
	}
	if json.Valid(t) {
		return t
	}
	b, _ := json.Marshal(string(args))
	return b
}

func (r *genRun) addCalls(calls []llmCall, status, errText string) {
	r.e.mu.Lock()
	var parts []Part
	if m := r.e.conv.Messages[r.msgID]; m != nil {
		for _, c := range calls {
			p := Part{Type: partToolCall, CallID: c.id, Tool: c.name, Input: callInput(c.args), Status: status, Error: errText}
			m.Parts = append(m.Parts, p)
			parts = append(parts, p)
		}
		r.svc.convs.saveLogged(r.e)
	}
	r.e.mu.Unlock()
	for _, p := range parts {
		r.emitPart(p)
	}
}

func (r *genRun) emitPart(p Part) {
	r.svc.emit(map[string]any{"type": "message.part", "conversationId": r.convID, "messageId": r.msgID, "part": p})
}

// updateCall 改一个工具调用部件的状态并推送。
func (r *genRun) updateCall(callID string, fn func(*Part)) {
	r.e.mu.Lock()
	var out *Part
	if m := r.e.conv.Messages[r.msgID]; m != nil {
		for i := len(m.Parts) - 1; i >= 0; i-- {
			if m.Parts[i].Type == partToolCall && m.Parts[i].CallID == callID {
				fn(&m.Parts[i])
				cp := m.Parts[i]
				out = &cp
				break
			}
		}
		r.svc.convs.saveLogged(r.e)
	}
	r.e.mu.Unlock()
	if out != nil {
		r.emitPart(*out)
	}
}

// addSkill 记下本轮用到的技能(同一条回答里只记一次)。
func (r *genRun) addSkill(name string) {
	r.e.mu.Lock()
	added := false
	if m := r.e.conv.Messages[r.msgID]; m != nil {
		for _, p := range m.Parts {
			if p.Type == partSkill && p.Name == name {
				r.e.mu.Unlock()
				return
			}
		}
		m.Parts = append(m.Parts, Part{Type: partSkill, Name: name})
		added = true
	}
	r.e.mu.Unlock()
	if added {
		r.emitPart(Part{Type: partSkill, Name: name})
	}
}

func (r *genRun) setStatus(status string) {
	r.e.mu.Lock()
	if m := r.e.conv.Messages[r.msgID]; m != nil {
		m.Status = status
	}
	r.e.mu.Unlock()
}

// ask 发出确认请求(tool.request 或 doc.edit)并等用户经 ai.tool.decide 回复;停止生成时返回 ctx 的错误。
func (r *genRun) ask(ctx context.Context, callID string, event map[string]any) (decision, error) {
	s := r.svc
	key := r.convID + "/" + callID
	ch := make(chan decision, 1)
	s.mu.Lock()
	s.waits[key] = ch
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.waits, key)
		s.mu.Unlock()
	}()
	r.setStatus(statusWaiting)
	s.emit(event)
	select {
	case d := <-ch:
		r.setStatus(statusStreaming)
		return d, nil
	case <-ctx.Done():
		return decision{}, ctx.Err()
	}
}

func (r *genRun) interrupted(call llmCall) llmResult {
	r.updateCall(call.id, func(p *Part) { p.Status = callError; p.Error = "已停止" })
	return llmResult{callID: call.id, name: call.name, content: "未执行(已中断)", isError: true}
}

func (r *genRun) denied(callID, msg string) {
	r.updateCall(callID, func(p *Part) { p.Status = callDenied; p.Result = strPtr(msg) })
}

// runTool 按权限执行一次工具调用,返回交给模型的结果。
func (r *genRun) runTool(ctx context.Context, tools *toolset, call llmCall) llmResult {
	s := r.svc
	res := llmResult{callID: call.id, name: call.name}
	t := tools.byName[call.name]
	if t == nil {
		msg := "没有这个工具:" + call.name
		r.updateCall(call.id, func(p *Part) { p.Status = callError; p.Error = msg })
		res.content, res.isError = msg, true
		return res
	}
	input := bytes.TrimSpace(call.args)
	if len(input) == 0 {
		input = []byte("{}")
	}
	if !json.Valid(input) {
		msg := "工具参数不是合法的 JSON"
		r.updateCall(call.id, func(p *Part) { p.Status = callError; p.Error = msg })
		res.content, res.isError = msg, true
		return res
	}
	policy := s.policyFor(t)
	if policy == policyDeny {
		// 契约 4:禁用的工具直接回「已被用户禁用」
		msg := "该工具已被用户禁用"
		r.denied(call.id, msg)
		res.content, res.isError = msg, true
		return res
	}
	if t.docEdit {
		return r.runDocEdit(ctx, call, input, res)
	}
	if policy == policyAsk {
		d, err := r.ask(ctx, call.id, map[string]any{
			"type": "tool.request", "conversationId": r.convID, "messageId": r.msgID,
			"callId": call.id, "tool": t.info, "input": json.RawMessage(input),
		})
		if err != nil {
			return r.interrupted(call)
		}
		switch d.decision {
		case "deny":
			msg := "用户拒绝了这次调用"
			r.denied(call.id, msg)
			res.content, res.isError = msg, true
			return res
		case "always":
			if err := s.setPolicy(t.info.Name, policyAllow); err != nil {
				s.log.Error("记录「总是允许」失败", "tool", t.info.Name, "err", err)
			}
		}
	}
	r.updateCall(call.id, func(p *Part) { p.Status = callRunning })
	out, err := t.run(ctx, input)
	if err != nil {
		if ctx.Err() != nil {
			return r.interrupted(call)
		}
		msg := err.Error()
		r.updateCall(call.id, func(p *Part) { p.Status = callError; p.Error = msg })
		res.content, res.isError = "工具出错:"+msg, true
		return res
	}
	out = truncateResult(out)
	if out == "" {
		out = "(没有返回内容)"
	}
	r.updateCall(call.id, func(p *Part) { p.Status = callDone; p.Result = strPtr(out) })
	if t.skill {
		// 读成功了才算用到这个技能
		var in struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(input, &in) == nil && in.Name != "" {
			r.addSkill(in.Name)
		}
	}
	res.content = out
	return res
}

// docEdit 是 typoza__edit_document 的参数,也是 doc.edit 事件里的 edit。
type docEdit struct {
	Kind string `json:"kind"` // replace_all | replace_range | insert
	Text string `json:"text"`
	From *int   `json:"from,omitempty"`
	To   *int   `json:"to,omitempty"`
	Find string `json:"find,omitempty"`
}

// runDocEdit 改当前文档:始终要用户确认(契约 4)。网页收到 doc.edit 后展示差异,
// 确认后自己写入,再用 ai.tool.decide 带 result 回报。
func (r *genRun) runDocEdit(ctx context.Context, call llmCall, input []byte, res llmResult) llmResult {
	var edit docEdit
	err := json.Unmarshal(input, &edit)
	switch {
	case err != nil:
		err = fmt.Errorf("参数不对:%v", err)
	case edit.Kind != "replace_all" && edit.Kind != "replace_range" && edit.Kind != "insert":
		err = fmt.Errorf("kind 只能是 replace_all / replace_range / insert")
	case edit.Kind == "replace_range" && edit.Find == "" && (edit.From == nil || edit.To == nil):
		err = fmt.Errorf("replace_range 需要 find,或同时给出 from 与 to")
	}
	if err != nil {
		msg := err.Error()
		r.updateCall(call.id, func(p *Part) { p.Status = callError; p.Error = msg })
		res.content, res.isError = msg, true
		return res
	}
	d, err := r.ask(ctx, call.id, map[string]any{
		"type": "doc.edit", "conversationId": r.convID, "messageId": r.msgID, "callId": call.id, "edit": edit,
	})
	if err != nil {
		return r.interrupted(call)
	}
	if d.decision == "deny" {
		msg := "用户没有采纳这次修改"
		if d.result != nil && *d.result != "" {
			msg = *d.result
		}
		r.denied(call.id, msg)
		res.content, res.isError = msg, true
		return res
	}
	out := "用户已确认,修改已写入文档"
	if d.result != nil && *d.result != "" {
		out = truncateResult(*d.result)
	}
	r.updateCall(call.id, func(p *Part) { p.Status = callDone; p.Result = strPtr(out) })
	res.content = out
	return res
}

// ---------- 历史与上下文 ----------

// historyToLLM 把根到当前位置的消息链转成内部消息。
func (s *Service) historyToLLM(path []Message) []llmMsg {
	var out []llmMsg
	for _, m := range path {
		if m.Role == "user" {
			out = append(out, llmMsg{role: "user", text: s.userContent(m)})
			continue
		}
		out = append(out, assistantToLLM(m)...)
	}
	return out
}

// assistantToLLM 把一条回答拆回多轮:文字跟在工具调用后面说明是下一轮的开始。
func assistantToLLM(m Message) []llmMsg {
	var out []llmMsg
	cur := llmMsg{role: "assistant"}
	var results []llmResult
	flush := func() {
		if cur.text == "" && len(cur.calls) == 0 {
			return
		}
		out = append(out, cur)
		if len(results) > 0 {
			out = append(out, llmMsg{role: "user", results: results})
		}
		cur = llmMsg{role: "assistant"}
		results = nil
	}
	for _, p := range m.Parts {
		switch p.Type {
		case partText:
			if len(cur.calls) > 0 {
				flush()
			}
			cur.text += p.Text
		case partToolCall:
			cur.calls = append(cur.calls, llmCall{id: p.CallID, name: p.Tool, args: p.Input})
			results = append(results, resultOfPart(p))
		}
	}
	flush()
	return out
}

// resultOfPart 是历史里某次工具调用交给模型的结果;没执行完的也要给一个,各家都要求调用与结果一一对应。
func resultOfPart(p Part) llmResult {
	r := llmResult{callID: p.CallID, name: p.Tool}
	switch p.Status {
	case callDone:
		r.content = deref(p.Result)
	case callError:
		r.content, r.isError = "工具出错:"+p.Error, true
	case callDenied:
		r.content, r.isError = deref(p.Result), true
		if r.content == "" {
			r.content = "用户拒绝了这次调用"
		}
	default:
		r.content, r.isError = "未执行(已中断)", true
	}
	if r.content == "" {
		r.content = "(没有返回内容)"
	}
	return r
}

// maxContextFile 是 @ 引用的文件最多读多少字节。
const maxContextFile = 2 << 20

var contextTags = map[string]string{
	"document": "document", "selection": "selection", "file": "document", "conversation": "conversation", "resource": "resource",
}

// userContent 把用户消息与随它发出的上下文拼成发给模型的文字。
func (s *Service) userContent(m Message) string {
	var b strings.Builder
	for _, c := range m.Context {
		if isFolderItem(c) {
			continue // 「当前文件夹」只给内置工具定根,内容由模型按需用工具读
		}
		text := c.Text
		var note string
		if text == "" {
			switch c.Kind {
			case "file":
				if c.Path != "" {
					t, err := readTextFile(c.Path, maxContextFile)
					if err != nil {
						note = err.Error()
					}
					text = t
				}
			case "conversation":
				if c.Ref != "" {
					t, err := s.renderConversation(c.Ref)
					if err != nil {
						note = err.Error()
					}
					text = t
				}
			}
		}
		tag := contextTags[c.Kind]
		attrs := fmt.Sprintf(" title=%q", c.Title)
		if c.Path != "" {
			attrs += fmt.Sprintf(" path=%q", c.Path)
		}
		if text == "" {
			if note == "" {
				note = "没有内容"
			}
			fmt.Fprintf(&b, "<%s%s>(读不到:%s,已跳过)</%s>\n\n", tag, attrs, note, tag)
			continue
		}
		fmt.Fprintf(&b, "<%s%s>\n%s\n</%s>\n\n", tag, attrs, text, tag)
	}
	for _, p := range m.Parts {
		if p.Type == partText {
			b.WriteString(p.Text)
		}
	}
	return b.String()
}

// readTextFile 读文本文件,超过 limit 字节时截断。
func readTextFile(path string, limit int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("打不开 %s:%v", filepath.Base(path), err)
	}
	defer f.Close()
	buf := make([]byte, limit+1)
	n, err := readFull(f, buf)
	if err != nil {
		return "", fmt.Errorf("读取 %s 失败:%v", filepath.Base(path), err)
	}
	data := buf[:n]
	truncated := int64(n) > limit
	if truncated {
		data = data[:limit]
	}
	if bytes.IndexByte(data, 0) >= 0 {
		return "", fmt.Errorf("%s 不是文本文件", filepath.Base(path))
	}
	text := strings.ToValidUTF8(string(data), "")
	if truncated {
		text += "\n\n[文件过长,只读了前一部分]"
	}
	return text, nil
}

// isFolderItem 判断上下文是不是网页带来的「当前文件夹」:{kind:'file', ref:'folder', path:<文件夹绝对路径>}。
func isFolderItem(c ContextItem) bool { return c.Kind == "file" && c.Ref == "folder" }

// folderOf 取「当前文件夹」连接器的根:从最近的用户消息往前找,优先用网页带来的文件夹;
// 没有时退到当前文档所在的文件夹。
func folderOf(path []Message) string {
	for i := len(path) - 1; i >= 0; i-- {
		m := path[i]
		if m.Role != "user" {
			continue
		}
		for _, c := range m.Context {
			if isFolderItem(c) && filepath.IsAbs(c.Path) {
				return c.Path
			}
		}
		for _, c := range m.Context {
			if (c.Kind == "document" || c.Kind == "selection") && filepath.IsAbs(c.Path) {
				return filepath.Dir(c.Path)
			}
		}
	}
	return ""
}

// lastUserHasDocument 判断正在回答的那条用户消息是否带着当前文档(决定是否提供改文档工具)。
func lastUserHasDocument(path []Message) bool {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i].Role != "user" {
			continue
		}
		for _, c := range path[i].Context {
			if c.Kind == "document" || c.Kind == "selection" {
				return true
			}
		}
		return false
	}
	return false
}

// systemPrompt 是助手的系统提示词,加上启用技能的名字与描述(渐进加载:正文等模型调用 typoza__read_skill 再读)。
func systemPrompt(a Assistant, skills []Skill) string {
	var b strings.Builder
	b.WriteString(strings.TrimSpace(a.SystemPrompt))
	if len(skills) > 0 {
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString("# 技能\n下面是可用的技能。任务与某个技能的描述相符时,先调用 typoza__read_skill 读取它的完整说明再照做;技能目录里的其他文件也可以用同一个工具按相对路径读取。\n")
		for _, sk := range skills {
			fmt.Fprintf(&b, "- %s:%s\n", sk.Name, sk.Description)
		}
	}
	return strings.TrimSpace(b.String())
}

// ---------- 标题 ----------

const titleSystemPrompt = "你负责给对话起标题。用不超过 16 个字概括对话主题,只输出标题本身,不要引号和句末标点。标题语言与用户一致。"

// makeTitle 用快速模型(没设时用默认模型)起标题;失败就沿用首句截断。
func (s *Service) makeTitle(g genSetup, convID, answer string) {
	model, err := g.snap.st.resolveModel(g.snap.st.FastModel)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()
	resp, err := s.providerClient(model.provider, g.snap.secrets).stream(ctx, &llmRequest{
		model:    model.modelID,
		system:   titleSystemPrompt,
		messages: []llmMsg{{role: "user", text: "用户:" + truncateRunes(g.userText, 2000) + "\n\n助手:" + truncateRunes(answer, 2000)}},
	}, nil)
	if err != nil {
		s.log.Info("起标题失败,沿用首句", "conversation", convID, "err", err)
		return
	}
	title := cleanTitle(resp.text)
	if title == "" {
		return
	}
	e, err := s.convs.get(convID)
	if err != nil {
		return
	}
	e.mu.Lock()
	if e.conv.Title != g.fallbackTitle {
		e.mu.Unlock()
		return // 用户已经改过名
	}
	e.conv.Title = title
	s.convs.saveLogged(e)
	sum := summaryOf(e.conv)
	e.mu.Unlock()
	s.emitConvUpdated(sum)
}

// fallbackTitle 是首句截断:到第一个换行或句末问号、叹号、句号为止,最多 20 个字。
func fallbackTitle(text string) string {
	t := strings.TrimSpace(text)
	if i := strings.IndexAny(t, "\n。\uff01\uff1f!?"); i > 0 {
		t = t[:i]
	}
	t = strings.TrimSpace(t)
	if t == "" {
		return "新对话"
	}
	return truncateRunes(t, 20)
}

// 标题两端要去掉的引号、强调符号与句末标点。
const (
	titleQuotes   = " \t\"'\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u300a\u300b#*`"
	titleEndPunct = "\u3002.\uff01!\uff1f?"
)

func cleanTitle(s string) string {
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		for _, prefix := range []string{"标题\uff1a", "标题:", "Title:", "title:"} {
			t = strings.TrimSpace(strings.TrimPrefix(t, prefix))
		}
		// 「标题」。这种引号套句号的写法要交替去两遍
		for range 2 {
			t = strings.TrimRight(strings.Trim(t, titleQuotes), titleEndPunct)
		}
		if t != "" {
			return truncateRunes(t, 30)
		}
	}
	return ""
}
