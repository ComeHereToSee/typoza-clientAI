package aisvc

import (
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// chatMessages 取 OpenAI Chat 请求里的消息(角色 + 内容)。
func chatMessages(t *testing.T, body string) []string {
	t.Helper()
	var req struct {
		Messages []struct {
			Role    string  `json:"role"`
			Content *string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("请求体解不开:%v", err)
	}
	var out []string
	for _, m := range req.Messages {
		if m.Role == "system" {
			continue
		}
		out = append(out, m.Role+":"+deref(m.Content))
	}
	return out
}

// 回答按请求序号编号,方便断言下一次请求带的是哪条路线。
func numberedLLM(t *testing.T) *mockLLM {
	llm := newMockLLM(t, protoOpenAIChat)
	n := 0
	llm.fallback = func(r recorded) turn {
		if strings.Contains(r.body, `"model":"fast"`) {
			return turn{text: []string{"标题"}}
		}
		n++
		return turn{text: []string{"答" + string(rune('0'+n))}}
	}
	return llm
}

// 分支:中间分支、重新生成、切换版本后,每次请求带的上下文都只沿当前路线。
func TestBranchesKeepContextPerRoute(t *testing.T) {
	env := newTestService(t)
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)

	r1 := env.send(t, map[string]any{"text": "问一"})
	env.host.waitDone(t, r1.AssistantMessageID) // 答1
	conv := r1.ConversationID
	r2 := env.send(t, map[string]any{"conversationId": conv, "text": "问二"})
	env.host.waitDone(t, r2.AssistantMessageID) // 答2
	if got := chatMessages(t, llm.chatPosts()[1].body); strings.Join(got, "|") != "user:问一|assistant:答1|user:问二" {
		t.Fatalf("接在末端后的请求上下文不对:%v", got)
	}

	// 重新生成第一条回答:新版本与原回答同父,上下文只到「问一」
	var regen struct {
		AssistantMessageID string `json:"assistantMessageId"`
	}
	env.callInto(t, "ai.chat.regenerate", map[string]any{"conversationId": conv, "messageId": r1.AssistantMessageID}, &regen)
	env.host.waitDone(t, regen.AssistantMessageID) // 答3
	if got := chatMessages(t, llm.chatPosts()[2].body); strings.Join(got, "|") != "user:问一" {
		t.Fatalf("重新生成的上下文应只到被回答的那条:%v", got)
	}
	c := env.conversation(t, conv)
	if *c.Messages[regen.AssistantMessageID].ParentID != r1.UserMessageID || deref(c.LeafID) != regen.AssistantMessageID {
		t.Fatalf("新版本应与原回答同父,并成为当前末端:%+v leaf=%s", c.Messages[regen.AssistantMessageID], deref(c.LeafID))
	}
	if textOfParts(partsOf(c, r1.AssistantMessageID)) != "答1" {
		t.Fatal("重新生成不应改动原回答")
	}

	// 切回原版本:后续对话跟着原版本走,末端落到「答2」
	var after Conversation
	env.callInto(t, "ai.chat.setLeaf", map[string]any{"conversationId": conv, "leafId": r1.AssistantMessageID}, &after)
	if deref(after.LeafID) != r2.AssistantMessageID {
		t.Fatalf("切到原版本后末端应是它后面最新的消息 %s,实际 %s", r2.AssistantMessageID, deref(after.LeafID))
	}

	// 从中间分支:接在「答1」后问「问三」,上下文不含「问二」
	r3 := env.send(t, map[string]any{"conversationId": conv, "parentId": r1.AssistantMessageID, "text": "问三"})
	env.host.waitDone(t, r3.AssistantMessageID) // 答4
	if got := chatMessages(t, llm.chatPosts()[3].body); strings.Join(got, "|") != "user:问一|assistant:答1|user:问三" {
		t.Fatalf("中间分支的上下文不对:%v", got)
	}

	// 编辑第一条后重发:网页先把末端清空,再发(不给 parentId),新消息成为新的根
	var cleared Conversation
	env.callInto(t, "ai.chat.setLeaf", map[string]any{"conversationId": conv, "leafId": nil}, &cleared)
	if cleared.LeafID != nil || len(cleared.Messages) != 7 {
		t.Fatalf("清空末端不应删消息:leaf=%v 消息 %d 条", cleared.LeafID, len(cleared.Messages))
	}
	r4 := env.send(t, map[string]any{"conversationId": conv, "text": "问一改"})
	env.host.waitDone(t, r4.AssistantMessageID)
	if got := chatMessages(t, llm.chatPosts()[4].body); strings.Join(got, "|") != "user:问一改" {
		t.Fatalf("编辑第一条后重发的上下文不对:%v", got)
	}
	c = env.conversation(t, conv)
	if c.Messages[r4.UserMessageID].ParentID != nil {
		t.Fatal("编辑第一条后重发的消息应没有父消息")
	}
	// 发送与重新生成只追加:2+2+1+2+2 条
	if len(c.Messages) != 9 {
		t.Fatalf("消息数应为 9,实际 %d", len(c.Messages))
	}
	env.wantErr(t, codeNotFound, "ai.chat.send", map[string]any{"conversationId": conv, "parentId": "nope", "text": "x"})
	env.wantErr(t, codeNotFound, "ai.chat.setLeaf", map[string]any{"conversationId": conv, "leafId": "nope"})
	env.wantErr(t, codeNotFound, "ai.chat.regenerate", map[string]any{"conversationId": conv, "messageId": r1.UserMessageID})
}

func TestSendValidation(t *testing.T) {
	env := newTestService(t)
	env.wantErr(t, codeNotConfigured, "ai.chat.send", map[string]any{"text": "你好"})
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "", nil)
	env.wantErr(t, codeInvalid, "ai.chat.send", map[string]any{"text": "   "})
	env.wantErr(t, codeInvalid, "ai.chat.send", map[string]any{"text": "x", "context": []map[string]any{{"kind": "video", "title": "x"}}})
	env.wantErr(t, codeNotFound, "ai.chat.send", map[string]any{"text": "x", "assistantId": "nope"})
	env.wantErr(t, codeNotFound, "ai.chat.send", map[string]any{"text": "x", "conversationId": "nope"})
	// 没有可用模型时什么都不建
	var list struct {
		Items []ConversationSummary `json:"items"`
	}
	env.callInto(t, "ai.conversations.list", nil, &list)
	if len(list.Items) != 0 {
		t.Fatalf("校验失败不应留下对话:%+v", list.Items)
	}
}

func TestStopKeepsPartialText(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"写到一半"}, hold: true})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "写一篇长文"})
	llm.waitHeld(t)
	env.host.waitFor(t, "第一段文字", func(e map[string]any) bool {
		return e["type"] == "message.delta" && e["messageId"] == r.AssistantMessageID
	})
	env.call(t, "ai.chat.stop", map[string]any{"conversationId": r.ConversationID, "messageId": r.AssistantMessageID})
	done := env.host.waitDone(t, r.AssistantMessageID)
	if done["status"] != statusStopped || done["error"] != nil {
		t.Fatalf("停止后应为 stopped:%v", done)
	}
	c := env.conversation(t, r.ConversationID)
	if m := c.Messages[r.AssistantMessageID]; m.Status != statusStopped || textOfParts(m.Parts) != "写到一半" {
		t.Fatalf("应保留已输出部分:%+v", m)
	}
	// 已经结束的回答再停一次不算错
	env.call(t, "ai.chat.stop", map[string]any{"conversationId": r.ConversationID, "messageId": r.AssistantMessageID})
}

func TestTitleFromFastModelAndFallback(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat)
	llm.fallback = func(r recorded) turn {
		if strings.Contains(r.body, `"model":"fast"`) {
			return turn{text: []string{"「", "春游计划", "」。"}}
		}
		return turn{text: []string{"可以去公园。"}}
	}
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "周末去哪儿春游?顺便推荐些吃的"})
	// 先用首句截断,随后换成快速模型起的标题
	updated := env.host.waitFor(t, "标题更新", func(e map[string]any) bool {
		sum, _ := e["summary"].(map[string]any)
		return e["type"] == "conversation.updated" && sum["title"] == "春游计划"
	})
	if updated["summary"].(map[string]any)["id"] != r.ConversationID {
		t.Fatalf("标题事件对应的对话不对:%v", updated)
	}
	env.host.waitFor(t, "首句标题", func(e map[string]any) bool {
		sum, _ := e["summary"].(map[string]any)
		return e["type"] == "conversation.updated" && sum["title"] == "周末去哪儿春游"
	})
	if got := env.conversation(t, r.ConversationID).Title; got != "春游计划" {
		t.Fatalf("标题应为快速模型给的,实际 %q", got)
	}
	// 快速模型的请求带着第一轮的问答
	var titleReq string
	for _, p := range llm.posts() {
		if strings.Contains(p.body, `"model":"fast"`) {
			titleReq = p.body
		}
	}
	if !strings.Contains(titleReq, "周末去哪儿春游") || !strings.Contains(titleReq, "可以去公园") {
		t.Fatalf("起标题的请求应带第一轮问答:%s", titleReq)
	}
	// 第二轮不再起标题
	r2 := env.send(t, map[string]any{"conversationId": r.ConversationID, "text": "那吃什么"})
	env.host.waitDone(t, r2.AssistantMessageID)
	n := 0
	for _, p := range llm.posts() {
		if strings.Contains(p.body, `"model":"fast"`) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("只在第一轮起标题,实际 %d 次", n)
	}
}

func TestTitleFallsBackToFirstSentence(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat)
	llm.fallback = func(r recorded) turn {
		if strings.Contains(r.body, `"model":"fast"`) {
			return turn{status: 500, body: `{"error":{"message":"坏了"}}`}
		}
		return turn{text: []string{"好"}}
	}
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "第一句话。第二句话"})
	env.host.waitDone(t, r.AssistantMessageID)
	if got := env.conversation(t, r.ConversationID).Title; got != "第一句话" {
		t.Fatalf("起标题失败时应沿用首句,实际 %q", got)
	}
	if got := fallbackTitle(strings.Repeat("长", 30)); got != strings.Repeat("长", 20)+"…" {
		t.Fatalf("首句应截到 20 个字:%q", got)
	}
	if fallbackTitle("\n\n") != "新对话" {
		t.Fatal("空消息的标题应为「新对话」")
	}
}

func TestConversationsListRenameDeleteClear(t *testing.T) {
	env := newTestService(t)
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	a := env.send(t, map[string]any{"text": "甲"})
	env.host.waitDone(t, a.AssistantMessageID)
	b := env.send(t, map[string]any{"text": "乙"})
	env.host.waitDone(t, b.AssistantMessageID)

	var list struct {
		Items []ConversationSummary `json:"items"`
	}
	env.callInto(t, "ai.conversations.list", nil, &list)
	if len(list.Items) != 2 || list.Items[0].UpdatedAt < list.Items[1].UpdatedAt {
		t.Fatalf("列表应按更新时间倒序:%+v", list.Items)
	}

	env.call(t, "ai.conversations.rename", map[string]any{"id": a.ConversationID, "title": " 改过的名字 "})
	env.host.waitFor(t, "改名事件", func(e map[string]any) bool {
		sum, _ := e["summary"].(map[string]any)
		return e["type"] == "conversation.updated" && sum["title"] == "改过的名字"
	})
	env.wantErr(t, codeInvalid, "ai.conversations.rename", map[string]any{"id": a.ConversationID, "title": "  "})
	env.wantErr(t, codeNotFound, "ai.conversations.get", map[string]any{"id": "../../etc/passwd"})

	file := filepath.Join(env.dir, "ai", "conversations", a.ConversationID+".json")
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("对话应存成一个文件:%v", err)
	}
	env.call(t, "ai.conversations.delete", map[string]any{"id": a.ConversationID})
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("删除后文件应不在了")
	}
	env.wantErr(t, codeNotFound, "ai.conversations.get", map[string]any{"id": a.ConversationID})

	env.call(t, "ai.conversations.clear", nil)
	env.callInto(t, "ai.conversations.list", nil, &list)
	if len(list.Items) != 0 {
		t.Fatalf("清除后应没有对话:%+v", list.Items)
	}
	left, _ := os.ReadDir(filepath.Join(env.dir, "ai", "conversations"))
	if len(left) != 0 {
		t.Fatalf("清除后目录应为空,还剩 %d 个文件", len(left))
	}
}

// 辅助进程重启后:对话从文件读回;上次还在生成的回答标为出错,可以重新生成。
func TestConversationSurvivesRestart(t *testing.T) {
	env := newTestService(t)
	llm := numberedLLM(t)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "你好"})
	env.host.waitDone(t, r.AssistantMessageID)
	env.s.Close()

	// 模拟崩溃前正在生成:把回答状态改回 streaming 写盘
	file := filepath.Join(env.dir, "ai", "conversations", r.ConversationID+".json")
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var c Conversation
	if err := json.Unmarshal(b, &c); err != nil {
		t.Fatal(err)
	}
	c.Messages[r.AssistantMessageID].Status = statusStreaming
	if err := writeJSONAtomic(file, c); err != nil {
		t.Fatal(err)
	}

	s2, err := New(Options{Dir: filepath.Join(env.dir, "ai"), SkillsDir: filepath.Join(env.dir, "skills"), Host: env.host, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s2.Close)
	env2 := &testEnv{s: s2, host: env.host, dir: env.dir}
	got := env2.conversation(t, r.ConversationID)
	m := got.Messages[r.AssistantMessageID]
	if m.Status != statusError || m.Error == nil || m.Error.Code != codeCancelled {
		t.Fatalf("中断的回答应标为出错:%+v", m)
	}
	if textOfParts(m.Parts) != "答1" || got.Messages[r.UserMessageID] == nil {
		t.Fatalf("对话内容应完整读回:%+v", got)
	}
}
