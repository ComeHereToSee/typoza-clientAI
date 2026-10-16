package aisvc

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// folderEnv 准备一个带两篇文档的文件夹,并把其中一篇当作当前文档随消息带上。
type folderEnv struct {
	*testEnv
	llm    *mockLLM
	folder string
}

func newFolderEnv(t *testing.T, extra map[string]any, turns ...turn) *folderEnv {
	t.Helper()
	env := newTestService(t)
	folder := t.TempDir()
	files := map[string]string{"current.md": "# 当前文档\n正文", "other.md": "另一篇,提到了苹果", filepath.Join("sub", "deep.md"): "深处的苹果"}
	for name, body := range files {
		p := filepath.Join(folder, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	llm := newMockLLM(t, protoOpenAIChat, turns...)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", extra)
	return &folderEnv{testEnv: env, llm: llm, folder: folder}
}

// sendWithDoc 按网页的做法带上当前文档与「当前文件夹」({kind:'file', ref:'folder', path})。
func (f *folderEnv) sendWithDoc(t *testing.T, text string) sendResult {
	t.Helper()
	return f.send(t, map[string]any{
		"text": text,
		"context": []map[string]any{
			{"kind": "document", "title": "当前文档", "text": "# 当前文档\n正文"},
			{"kind": "file", "ref": "folder", "title": "笔记", "path": f.folder},
		},
	})
}

func toolRequest(callID string) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["type"] == "tool.request" && e["callId"] == callID }
}

func callPart(t *testing.T, c Conversation, msgID, callID string) Part {
	t.Helper()
	for _, p := range partsOf(c, msgID) {
		if p.Type == partToolCall && p.CallID == callID {
			return p
		}
	}
	t.Fatalf("消息里没有工具调用 %s:%+v", callID, partsOf(c, msgID))
	return Part{}
}

var askList = map[string]any{"toolPolicies": map[string]string{toolListDocuments: policyAsk}}

func TestToolAskAllow(t *testing.T) {
	f := newFolderEnv(t, askList,
		turn{calls: []mockCall{{id: "c1", name: toolListDocuments, args: `{"dir":""}`}}},
		turn{text: []string{"列好了"}},
	)
	r := f.sendWithDoc(t, "列出文档")
	req := f.host.waitFor(t, "工具确认请求", toolRequest("c1"))
	tool := req["tool"].(map[string]any)
	if tool["name"] != toolListDocuments || tool["source"] != builtinSource || req["messageId"] != r.AssistantMessageID {
		t.Fatalf("tool.request 字段不对:%v", req)
	}
	if in, _ := req["input"].(map[string]any); in == nil || in["dir"] != "" {
		t.Fatalf("tool.request 应带参数:%v", req["input"])
	}
	c := f.conversation(t, r.ConversationID)
	if c.Messages[r.AssistantMessageID].Status != statusWaiting || callPart(t, c, r.AssistantMessageID, "c1").Status != callPending {
		t.Fatalf("等待确认时消息应为 waiting、调用为 pending:%+v", c.Messages[r.AssistantMessageID])
	}
	if len(f.llm.chatPosts()) != 1 {
		t.Fatal("用户确认前不应继续请求模型")
	}
	f.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "c1", "decision": "allow"})
	done := f.host.waitDone(t, r.AssistantMessageID)
	if done["status"] != statusDone {
		t.Fatalf("回答应正常结束:%v", done)
	}
	part := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1")
	if part.Status != callDone || !strings.Contains(deref(part.Result), "sub/deep.md") {
		t.Fatalf("允许后应执行并记下结果:%+v", part)
	}
	// 同一个调用不能再确认一次
	f.wantErr(t, codeNotFound, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "c1", "decision": "allow"})
}

func TestToolAskDeny(t *testing.T) {
	f := newFolderEnv(t, askList,
		turn{calls: []mockCall{{id: "c1", name: toolListDocuments, args: `{}`}}},
		turn{text: []string{"好的,不看了"}},
	)
	r := f.sendWithDoc(t, "列出文档")
	f.host.waitFor(t, "工具确认请求", toolRequest("c1"))
	f.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "c1", "decision": "deny"})
	f.host.waitDone(t, r.AssistantMessageID)
	part := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1")
	if part.Status != callDenied || deref(part.Result) != "用户拒绝了这次调用" {
		t.Fatalf("拒绝后应为 denied:%+v", part)
	}
	// 拒绝后模型继续回答,并知道被拒绝了
	posts := f.llm.chatPosts()
	if len(posts) != 2 || !strings.Contains(posts[1].body, "用户拒绝了这次调用") {
		t.Fatalf("拒绝的结果应交回模型:%d %v", len(posts), posts)
	}
}

func TestToolAskAlwaysAllowsLaterCalls(t *testing.T) {
	f := newFolderEnv(t, askList,
		turn{calls: []mockCall{{id: "c1", name: toolListDocuments, args: `{}`}}},
		turn{calls: []mockCall{{id: "c2", name: toolListDocuments, args: `{"dir":"sub"}`}}},
		turn{text: []string{"都看完了"}},
	)
	r := f.sendWithDoc(t, "列出文档")
	f.host.waitFor(t, "工具确认请求", toolRequest("c1"))
	f.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "c1", "decision": "always"})
	f.host.waitDone(t, r.AssistantMessageID)
	if n := f.host.count(isType("tool.request")); n != 1 {
		t.Fatalf("总是允许后第二次调用不应再询问,实际询问 %d 次", n)
	}
	c := f.conversation(t, r.ConversationID)
	if callPart(t, c, r.AssistantMessageID, "c1").Status != callDone || callPart(t, c, r.AssistantMessageID, "c2").Status != callDone {
		t.Fatal("两次调用都应执行")
	}
	var st Settings
	f.callInto(t, "ai.settings.get", nil, &st)
	if st.ToolPolicies[toolListDocuments] != policyAllow {
		t.Fatalf("总是允许应记进设置:%v", st.ToolPolicies)
	}
}

func TestToolDenyPolicy(t *testing.T) {
	f := newFolderEnv(t, map[string]any{"toolPolicies": map[string]string{toolListDocuments: policyDeny}},
		turn{calls: []mockCall{{id: "c1", name: toolListDocuments, args: `{}`}}},
		turn{text: []string{"那我不看了"}},
	)
	r := f.sendWithDoc(t, "列出文档")
	f.host.waitDone(t, r.AssistantMessageID)
	part := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1")
	if part.Status != callDenied || deref(part.Result) != "该工具已被用户禁用" {
		t.Fatalf("禁用的工具应直接回「已被用户禁用」:%+v", part)
	}
	if f.host.count(isType("tool.request")) != 0 {
		t.Fatal("禁用的工具不应询问")
	}
	if posts := f.llm.chatPosts(); !strings.Contains(posts[1].body, "该工具已被用户禁用") {
		t.Fatalf("禁用的说明应交回模型:%s", posts[1].body)
	}
}

func TestToolRoundLimit(t *testing.T) {
	f := newFolderEnv(t, nil)
	n := 0
	f.llm.fallback = func(recorded) turn {
		// 模型一直要调用工具
		n++
		return turn{calls: []mockCall{{id: fmt.Sprintf("c%d", n), name: toolSearchDocument, args: `{"query":"苹果"}`}}}
	}
	r := f.sendWithDoc(t, "一直查")
	done := f.host.waitDone(t, r.AssistantMessageID)
	if done["status"] != statusDone {
		t.Fatalf("到上限应停下并正常结束:%v", done)
	}
	if n := len(f.llm.chatPosts()); n != maxToolRounds+1 {
		t.Fatalf("应请求模型 %d 次,实际 %d 次", maxToolRounds+1, n)
	}
	parts := partsOf(f.conversation(t, r.ConversationID), r.AssistantMessageID)
	executed, skipped := 0, 0
	for _, p := range parts {
		if p.Type != partToolCall {
			continue
		}
		switch p.Status {
		case callDone:
			executed++
		case callError:
			skipped++
		}
	}
	if executed != maxToolRounds || skipped != 1 {
		t.Fatalf("应执行 %d 次、跳过 1 次,实际执行 %d、跳过 %d", maxToolRounds, executed, skipped)
	}
	if last := parts[len(parts)-1]; last.Type != partText || !strings.Contains(last.Text, "20 轮上限") {
		t.Fatalf("到上限应提示:%+v", last)
	}
}

func TestToolResultTruncated(t *testing.T) {
	f := newFolderEnv(t, nil,
		turn{calls: []mockCall{{id: "c1", name: toolReadDocument, args: `{"path":"big.md"}`}}},
		turn{text: []string{"读完了"}},
	)
	if err := os.WriteFile(filepath.Join(f.folder, "big.md"), []byte(strings.Repeat("字", 30000)), 0o644); err != nil {
		t.Fatal(err)
	}
	r := f.sendWithDoc(t, "读 big.md")
	f.host.waitDone(t, r.AssistantMessageID)
	res := deref(callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1").Result)
	if !strings.HasPrefix(res, strings.Repeat("字", maxToolResult)) || strings.Contains(res, strings.Repeat("字", maxToolResult+1)) {
		t.Fatal("结果应截到 20000 字")
	}
	if !strings.Contains(res, "共 30000 字") {
		t.Fatalf("截断后应注明原长度:%q", res[len(res)-80:])
	}
	if !strings.Contains(f.llm.chatPosts()[1].body, "共 30000 字") {
		t.Fatal("交给模型的是截断后的结果")
	}
}

func TestFolderToolsStayInsideFolder(t *testing.T) {
	f := newFolderEnv(t, nil,
		turn{calls: []mockCall{
			{id: "c1", name: toolSearchDocument, args: `{"query":"苹果"}`},
			{id: "c2", name: toolReadDocument, args: `{"path":"../../etc/passwd"}`},
			{id: "c3", name: toolReadDocument, args: `{"path":"other.md"}`},
			{id: "c4", name: "typoza__nope", args: `{}`},
		}},
		turn{text: []string{"好"}},
	)
	outside := filepath.Join(t.TempDir(), "secret.md")
	if err := os.WriteFile(outside, []byte("外面的秘密苹果"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(f.folder, "link.md")); err != nil {
		t.Fatal(err)
	}
	r := f.sendWithDoc(t, "找苹果")
	f.host.waitDone(t, r.AssistantMessageID)
	c := f.conversation(t, r.ConversationID)
	search := deref(callPart(t, c, r.AssistantMessageID, "c1").Result)
	if !strings.Contains(search, "other.md:1:") || !strings.Contains(search, "sub/deep.md:1:") || strings.Contains(search, "秘密") {
		t.Fatalf("搜索应只在文件夹里找,不跟符号链接:%q", search)
	}
	if p := callPart(t, c, r.AssistantMessageID, "c2"); p.Status != callError {
		t.Fatalf("读文件夹外的文件应失败:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "c3"); p.Status != callDone || deref(p.Result) != "另一篇,提到了苹果" {
		t.Fatalf("读文件夹里的文档:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "c4"); p.Status != callError || !strings.Contains(p.Error, "没有这个工具") {
		t.Fatalf("不存在的工具应报错:%+v", p)
	}
	if _, err := readDocument(f.folder, "link.md"); err == nil {
		t.Fatal("指向文件夹外的符号链接不应能读")
	}
}

func TestEditDocumentGoesThroughWeb(t *testing.T) {
	f := newFolderEnv(t, nil,
		turn{calls: []mockCall{{id: "e1", name: toolEditDocument, args: `{"kind":"replace_range","find":"正文","text":"新的正文"}`}}},
		turn{text: []string{"改好了"}},
	)
	r := f.sendWithDoc(t, "把正文改一下")
	ev := f.host.waitFor(t, "doc.edit", func(e map[string]any) bool { return e["type"] == "doc.edit" && e["callId"] == "e1" })
	edit := ev["edit"].(map[string]any)
	if edit["kind"] != "replace_range" || edit["find"] != "正文" || edit["text"] != "新的正文" || ev["messageId"] != r.AssistantMessageID {
		t.Fatalf("doc.edit 字段不对:%v", ev)
	}
	if f.host.count(isType("tool.request")) != 0 {
		t.Fatal("改文档走 doc.edit,不发 tool.request")
	}
	f.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "e1", "decision": "allow", "result": "已替换 1 处"})
	f.host.waitDone(t, r.AssistantMessageID)
	part := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "e1")
	if part.Status != callDone || deref(part.Result) != "已替换 1 处" {
		t.Fatalf("网页回报的结果应记下:%+v", part)
	}
	if !strings.Contains(f.llm.chatPosts()[1].body, "已替换 1 处") {
		t.Fatal("网页回报的结果应交回模型")
	}
}

func TestEditDocumentRejectedAndInvalid(t *testing.T) {
	f := newFolderEnv(t, nil,
		turn{calls: []mockCall{
			{id: "e1", name: toolEditDocument, args: `{"kind":"move","text":"x"}`},
			{id: "e2", name: toolEditDocument, args: `{"kind":"replace_all","text":"全新"}`},
		}},
		turn{text: []string{"好吧"}},
	)
	r := f.sendWithDoc(t, "改")
	f.host.waitFor(t, "doc.edit", func(e map[string]any) bool { return e["type"] == "doc.edit" && e["callId"] == "e2" })
	f.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "e2", "decision": "deny"})
	f.host.waitDone(t, r.AssistantMessageID)
	c := f.conversation(t, r.ConversationID)
	if p := callPart(t, c, r.AssistantMessageID, "e1"); p.Status != callError || !strings.Contains(p.Error, "kind") {
		t.Fatalf("参数不对的修改应报错:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "e2"); p.Status != callDenied {
		t.Fatalf("用户没采纳的修改应为 denied:%+v", p)
	}
}

func TestStopWhileWaitingForDecision(t *testing.T) {
	f := newFolderEnv(t, askList, turn{calls: []mockCall{{id: "c1", name: toolListDocuments, args: `{}`}}})
	r := f.sendWithDoc(t, "列出文档")
	f.host.waitFor(t, "工具确认请求", toolRequest("c1"))
	f.call(t, "ai.chat.stop", map[string]any{"conversationId": r.ConversationID, "messageId": r.AssistantMessageID})
	done := f.host.waitDone(t, r.AssistantMessageID)
	if done["status"] != statusStopped {
		t.Fatalf("等待确认时停止应为 stopped:%v", done)
	}
	if p := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1"); p.Status != callError || p.Error != "已停止" {
		t.Fatalf("没执行的调用应标为已停止:%+v", p)
	}
	f.wantErr(t, codeNotFound, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "c1", "decision": "allow"})
}

func TestToolsListFollowsConnectors(t *testing.T) {
	env := newTestService(t)
	names := func() []string {
		var res struct {
			Tools []ToolInfo `json:"tools"`
		}
		env.callInto(t, "ai.tools.list", nil, &res)
		var out []string
		for _, tl := range res.Tools {
			out = append(out, tl.Name)
		}
		return out
	}
	got := strings.Join(names(), ",")
	if !strings.Contains(got, toolListDocuments) || !strings.Contains(got, toolEditDocument) || !strings.Contains(got, toolReadSkill) || strings.Contains(got, toolFetchURL) {
		t.Fatalf("缺省连接器下的工具不对:%s", got)
	}
	env.call(t, "ai.settings.update", map[string]any{"connectors": map[string]bool{"folder": false, "web": true}, "skillsEnabled": false})
	got = strings.Join(names(), ",")
	if strings.Contains(got, toolListDocuments) || !strings.Contains(got, toolFetchURL) || strings.Contains(got, toolReadSkill) {
		t.Fatalf("关掉文件夹、打开网页读取后的工具不对:%s", got)
	}
	env.wantErr(t, codeNotFound, "ai.tools.list", map[string]any{"assistantId": "nope"})
}

// 没带当前文档的消息不提供改文档与文件夹工具。
func TestNoDocumentNoDocTools(t *testing.T) {
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat, turn{text: []string{"你好"}})
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", nil)
	r := env.send(t, map[string]any{"text": "随便聊聊"})
	env.host.waitDone(t, r.AssistantMessageID)
	// 缺省连接器下又没有技能:一个工具也没有
	if body := llm.chatPosts()[0].body; strings.Contains(body, `"tools"`) {
		t.Fatalf("没有当前文档时不该提供文档工具:%s", body)
	}
}

func TestModelMarkedWithoutToolsGetsNoTools(t *testing.T) {
	f := newFolderEnv(t, nil, turn{text: []string{"好"}})
	f.call(t, "ai.settings.update", map[string]any{"providers": []map[string]any{{
		"id": "p1", "name": "模拟", "protocol": protoOpenAIChat, "baseUrl": f.llm.srv.URL, "enabled": true,
		"models": []map[string]any{{"id": "m1", "tools": false}},
	}}})
	r := f.sendWithDoc(t, "你好")
	f.host.waitDone(t, r.AssistantMessageID)
	if strings.Contains(f.llm.chatPosts()[0].body, `"tools"`) {
		t.Fatal("标为不支持工具调用的模型不应带工具")
	}
}

// 「当前文件夹」只用来给工具定根,不当成文件读进提示词;没带文件夹时退到当前文档所在的文件夹。
func TestFolderContextItem(t *testing.T) {
	f := newFolderEnv(t, nil, turn{calls: []mockCall{{id: "c1", name: toolReadDocument, args: `{"path":"other.md"}`}}}, turn{text: []string{"好"}})
	r := f.sendWithDoc(t, "读 other.md")
	f.host.waitDone(t, r.AssistantMessageID)
	first := f.llm.chatPosts()[0].body
	if strings.Contains(first, "读不到") || !strings.Contains(first, toolReadDocument) {
		t.Fatalf("文件夹不应渲染进提示词,但要提供文件夹工具:%s", first)
	}
	if p := callPart(t, f.conversation(t, r.ConversationID), r.AssistantMessageID, "c1"); deref(p.Result) != "另一篇,提到了苹果" {
		t.Fatalf("应以网页给的文件夹为根:%+v", p)
	}

	path := []Message{{Role: "user", Context: []ContextItem{{Kind: "document", Path: filepath.Join(f.folder, "current.md")}}}}
	if got := folderOf(path); got != f.folder {
		t.Fatalf("没带文件夹时应退到当前文档所在的文件夹:%s", got)
	}
	path[0].Context = append(path[0].Context, ContextItem{Kind: "file", Ref: "folder", Path: "/explicit"})
	if got := folderOf(path); got != "/explicit" {
		t.Fatalf("网页给的文件夹优先:%s", got)
	}
}
