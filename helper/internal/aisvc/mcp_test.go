package aisvc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// stdioServerEnv 置 1 时,测试二进制本身作为 stdio MCP 服务器运行(测 stdio 传输,不依赖外部命令)。
const stdioServerEnv = "TYPOZA_AISVC_STDIO_SERVER"

func TestMain(m *testing.M) {
	if os.Getenv(stdioServerEnv) == "1" {
		fmt.Fprintln(os.Stderr, "测试服务器已启动")
		if err := newTestMCPServer().Run(context.Background(), &mcp.StdioTransport{}); err != nil {
			fmt.Fprintln(os.Stderr, "测试服务器退出:", err)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func objSchema(props string) json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{` + props + `}}`)
}

// newTestMCPServer 有 echo / fail / ask_name 三个工具、一个提示词、一个资源。
func newTestMCPServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "test-server", Version: "1.0.0"}, nil)
	s.AddTool(&mcp.Tool{Name: "echo", Description: "原样返回", InputSchema: objSchema(`"text":{"type":"string"}`)},
		func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var in struct {
				Text string `json:"text"`
			}
			if err := json.Unmarshal(req.Params.Arguments, &in); err != nil {
				return nil, err
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "echo:" + in.Text}}}, nil
		})
	s.AddTool(&mcp.Tool{Name: "fail", Description: "总是失败", InputSchema: objSchema(``)},
		func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "坏了"}}}, nil
		})
	// 征询:新协议下服务器返回 inputRequests,客户端征询用户后带着回答重发
	s.AddTool(&mcp.Tool{Name: "ask_name", Description: "问名字", InputSchema: objSchema(``)},
		func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			resp, ok := req.Params.InputResponses["name"]
			if !ok {
				return &mcp.CallToolResult{InputRequests: mcp.InputRequestMap{"name": &mcp.ElicitParams{
					Message:         "请告诉我你的名字",
					RequestedSchema: map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}},
				}}}, nil
			}
			er, _ := resp.(*mcp.ElicitResult)
			if er == nil || er.Action != "accept" {
				return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "用户不肯说"}}}, nil
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("你好,%v", er.Content["name"])}}}, nil
		})
	s.AddPrompt(&mcp.Prompt{Name: "greet", Description: "打招呼", Arguments: []*mcp.PromptArgument{{Name: "who", Required: true}}},
		func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: "请向" + req.Params.Arguments["who"] + "问好"}}}}, nil
		})
	s.AddResource(&mcp.Resource{URI: "test://doc", Name: "doc", Title: "测试文档", MIMEType: "text/plain"},
		func(_ context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: req.Params.URI, MIMEType: "text/plain", Text: "资源内容"}}}, nil
		})
	return s
}

// useInMemoryMCP 让所有 MCP 服务器都走 SDK 的内存传输,连到 newTestMCPServer。
func useInMemoryMCP(env *testEnv) {
	env.s.mcp.transports = func(ctx context.Context, _ *mcpConn, _ map[string]string) ([]mcp.Transport, func(), error) {
		serverSide, clientSide := mcp.NewInMemoryTransports()
		ss, err := newTestMCPServer().Connect(ctx, serverSide, nil)
		if err != nil {
			return nil, nil, err
		}
		return []mcp.Transport{clientSide}, func() { _ = ss.Close() }, nil
	}
}

func addMCPServer(t *testing.T, env *testEnv, srv map[string]any) {
	t.Helper()
	env.call(t, "ai.settings.update", map[string]any{"mcpServers": []map[string]any{srv}})
}

// waitMCP 等某个服务器进入指定状态。
func waitMCP(t *testing.T, env *testEnv, id, state string) MCPStatus {
	t.Helper()
	ev := env.host.waitFor(t, "MCP "+id+" "+state, func(e map[string]any) bool {
		st, _ := e["status"].(map[string]any)
		return e["type"] == "mcp.status" && st["serverId"] == id && st["state"] == state
	})
	b, _ := json.Marshal(ev["status"])
	var st MCPStatus
	_ = json.Unmarshal(b, &st)
	return st
}

func TestMCPInMemoryListsAndCalls(t *testing.T) {
	env := newTestService(t)
	useInMemoryMCP(env)
	addMCPServer(t, env, map[string]any{"id": "mem", "name": "内存服务器", "enabled": true, "transport": "stdio", "command": "unused"})
	// 第一次用到 MCP 时才开始连
	if env.host.count(isType("mcp.status")) != 0 {
		t.Fatal("改设置不应拉起 MCP 服务器")
	}
	env.call(t, "ai.mcp.status", nil)
	st := waitMCP(t, env, "mem", mcpConnected)
	var tools []string
	for _, tl := range st.Tools {
		tools = append(tools, tl.Name)
		if tl.Source != "内存服务器" {
			t.Fatalf("工具来源应是服务器名:%+v", tl)
		}
	}
	if len(tools) != 3 || !hasTool(st.Tools, "mcp__mem__echo") || !hasTool(st.Tools, "mcp__mem__fail") || !hasTool(st.Tools, "mcp__mem__ask_name") {
		t.Fatalf("工具全名应为 mcp__<serverId>__<toolName>:%v", tools)
	}
	if len(st.Prompts) != 1 || st.Prompts[0].Name != "greet" || len(st.Prompts[0].Arguments) != 1 || !st.Prompts[0].Arguments[0].Required {
		t.Fatalf("提示词不对:%+v", st.Prompts)
	}
	if len(st.Resources) != 1 || st.Resources[0].URI != "test://doc" || st.Resources[0].Name != "测试文档" {
		t.Fatalf("资源不对:%+v", st.Resources)
	}

	var prompt, res struct {
		Text string `json:"text"`
	}
	env.callInto(t, "ai.mcp.prompt", map[string]any{"serverId": "mem", "name": "greet", "args": map[string]string{"who": "小王"}}, &prompt)
	if prompt.Text != "请向小王问好" {
		t.Fatalf("提示词展开不对:%q", prompt.Text)
	}
	env.callInto(t, "ai.mcp.resource", map[string]any{"serverId": "mem", "uri": "test://doc"}, &res)
	if res.Text != "资源内容" {
		t.Fatalf("资源内容不对:%q", res.Text)
	}
	env.wantErr(t, codeNotFound, "ai.mcp.prompt", map[string]any{"serverId": "nope", "name": "greet"})

	out, err := env.s.mcp.callTool(context.Background(), "mem", "echo", json.RawMessage(`{"text":"hi"}`))
	if err != nil || out != "echo:hi" {
		t.Fatalf("调用工具:%q %v", out, err)
	}
	if _, err := env.s.mcp.callTool(context.Background(), "mem", "fail", json.RawMessage(`{}`)); err == nil || err.Error() != "坏了" {
		t.Fatalf("工具报错应原样返回:%v", err)
	}

	// 不带 assistantId 列出全部;助手没绑定服务器时只有内置工具
	var all, writer struct {
		Tools []ToolInfo `json:"tools"`
	}
	env.callInto(t, "ai.tools.list", nil, &all)
	env.callInto(t, "ai.tools.list", map[string]any{"assistantId": defaultAssistantID}, &writer)
	if !hasTool(all.Tools, "mcp__mem__echo") || hasTool(writer.Tools, "mcp__mem__echo") {
		t.Fatal("ai.tools.list 应按助手绑定的服务器列工具")
	}
}

func hasTool(tools []ToolInfo, name string) bool {
	for _, t := range tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// 对话里调用 MCP 工具:默认每次询问,允许后执行并把结果交回模型;征询经外壳弹表单。
func TestMCPToolInChat(t *testing.T) {
	env := newTestService(t)
	useInMemoryMCP(env)
	env.host.onElicit = func(req ElicitArgs) ElicitAnswer {
		return ElicitAnswer{Action: "accept", Content: map[string]any{"name": "小明"}}
	}
	llm := newMockLLM(t, protoOpenAIChat,
		turn{calls: []mockCall{{id: "m1", name: "mcp__mem__echo", args: `{"text":"你好"}`}, {id: "m2", name: "mcp__mem__ask_name", args: `{}`}}},
		turn{text: []string{"完成"}},
	)
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", map[string]any{
		"mcpServers": []map[string]any{{"id": "mem", "name": "内存服务器", "enabled": true, "transport": "stdio", "command": "unused"}},
		"assistants": []map[string]any{{"id": defaultAssistantID, "name": "写作助手", "systemPrompt": "", "skills": []string{}, "mcpServers": []string{"mem"}}},
	})
	r := env.send(t, map[string]any{"text": "打个招呼"})
	req := env.host.waitFor(t, "MCP 工具确认", toolRequest("m1"))
	if tool := req["tool"].(map[string]any); tool["source"] != "内存服务器" || tool["name"] != "mcp__mem__echo" {
		t.Fatalf("tool.request 的工具信息不对:%v", req)
	}
	env.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "m1", "decision": "allow"})
	env.host.waitFor(t, "第二个工具确认", toolRequest("m2"))
	env.call(t, "ai.tool.decide", map[string]any{"conversationId": r.ConversationID, "callId": "m2", "decision": "allow"})
	env.host.waitDone(t, r.AssistantMessageID)
	c := env.conversation(t, r.ConversationID)
	if p := callPart(t, c, r.AssistantMessageID, "m1"); p.Status != callDone || deref(p.Result) != "echo:你好" {
		t.Fatalf("MCP 工具结果不对:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "m2"); p.Status != callDone || deref(p.Result) != "你好,小明" {
		t.Fatalf("征询后的结果不对:%+v", p)
	}
	env.host.mu.Lock()
	elicits := append([]ElicitArgs(nil), env.host.elicits...)
	env.host.mu.Unlock()
	if len(elicits) != 1 || elicits[0].ServerID != "mem" || elicits[0].ServerName != "内存服务器" || elicits[0].Message != "请告诉我你的名字" {
		t.Fatalf("征询应交给外壳并标明服务器:%+v", elicits)
	}
	second := llm.chatPosts()[1].body
	if !strings.Contains(second, "echo:你好") || !strings.Contains(second, "你好,小明") {
		t.Fatalf("工具结果应交回模型:%s", second)
	}
	// 工具调用记进服务器日志
	st := env.s.mcp.statuses([]MCPServer{{ID: "mem", Enabled: true}})[0]
	if !strings.Contains(strings.Join(st.Log, "\n"), "调用工具 echo") {
		t.Fatalf("工具调用应记进日志:%v", st.Log)
	}
}

func TestMCPRestartDisableAndRemove(t *testing.T) {
	env := newTestService(t)
	useInMemoryMCP(env)
	srv := map[string]any{"id": "mem", "name": "内存服务器", "enabled": true, "transport": "stdio", "command": "unused"}
	addMCPServer(t, env, srv)
	env.call(t, "ai.mcp.status", nil)
	waitMCP(t, env, "mem", mcpConnected)

	var st MCPStatus
	env.callInto(t, "ai.mcp.restart", map[string]any{"serverId": "mem"}, &st)
	if st.State != mcpConnected || len(st.Tools) != 3 {
		t.Fatalf("重启后应重新连上:%+v", st)
	}
	env.wantErr(t, codeNotFound, "ai.mcp.restart", map[string]any{"serverId": "nope"})

	srv["enabled"] = false
	addMCPServer(t, env, srv)
	waitMCP(t, env, "mem", mcpDisabled)
	var all struct {
		Servers []MCPStatus `json:"servers"`
	}
	env.callInto(t, "ai.mcp.status", nil, &all)
	if len(all.Servers) != 1 || all.Servers[0].State != mcpDisabled || len(all.Servers[0].Tools) != 0 {
		t.Fatalf("停用后的状态不对:%+v", all.Servers)
	}
	env.call(t, "ai.settings.update", map[string]any{"mcpServers": []any{}})
	env.callInto(t, "ai.mcp.status", nil, &all)
	if len(all.Servers) != 0 {
		t.Fatalf("删除后不应再有状态:%+v", all.Servers)
	}
}

func TestMCPStreamableHTTP(t *testing.T) {
	server := newTestMCPServer()
	ts := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
	})
	env := newTestService(t)
	addMCPServer(t, env, map[string]any{"id": "web", "name": "HTTP 服务器", "enabled": true, "transport": "http", "url": ts.URL})
	env.call(t, "ai.mcp.status", nil)
	st := waitMCP(t, env, "web", mcpConnected)
	if !hasTool(st.Tools, "mcp__web__echo") {
		t.Fatalf("应列出 HTTP 服务器的工具:%+v", st.Tools)
	}
	out, err := env.s.mcp.callTool(context.Background(), "web", "echo", json.RawMessage(`{"text":"经 HTTP"}`))
	if err != nil || out != "echo:经 HTTP" {
		t.Fatalf("经 Streamable HTTP 调用工具:%q %v", out, err)
	}
}

func TestMCPHTTPHeadersFromKeychain(t *testing.T) {
	server := newTestMCPServer()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	// 不带钥匙串里的请求头就拒绝:能连上就说明请求头取对了
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != "mcp-secret-value" {
			http.Error(w, "missing key", http.StatusBadRequest)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
	})
	env := newTestService(t)
	env.call(t, "ai.secrets", map[string]any{"secrets": map[string]string{"mcp:web:X-Api-Key": "mcp-secret-value"}})
	addMCPServer(t, env, map[string]any{"id": "web", "name": "HTTP", "enabled": true, "transport": "http", "url": ts.URL, "headers": map[string]string{"X-Api-Key": ""}})
	env.call(t, "ai.mcp.status", nil)
	waitMCP(t, env, "web", mcpConnected)
}

func TestMCPOAuthTokenFromKeychainSavedAndForgotten(t *testing.T) {
	server := newTestMCPServer()
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	// 只认钥匙串里存的访问令牌:能连上就说明启动时用了它,没有走浏览器登录
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer stored-token" {
			http.Error(w, "unauthorized", http.StatusBadRequest)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		ts.CloseClientConnections()
		ts.Close()
	})
	env := newTestService(t)
	env.call(t, "ai.secrets", map[string]any{"secrets": map[string]string{"mcp-oauth:web": `{"access_token":"stored-token","token_type":"Bearer"}`}})
	addMCPServer(t, env, map[string]any{"id": "web", "name": "HTTP", "enabled": true, "transport": "http", "url": ts.URL})
	env.call(t, "ai.mcp.status", nil)
	waitMCP(t, env, "web", mcpConnected)
	env.host.mu.Lock()
	opened := append([]string(nil), env.host.opened...)
	env.host.mu.Unlock()
	if len(opened) != 0 {
		t.Fatalf("有存下的令牌就不应打开登录页:%v", opened)
	}
	// 连上后把令牌交给外壳写钥匙串
	waitStored(t, env, func(ref, value string) bool { return ref == "mcp-oauth:web" && strings.Contains(value, "stored-token") })
	// 删掉服务器时一并删除钥匙串里的令牌
	env.call(t, "ai.settings.update", map[string]any{"mcpServers": []any{}})
	waitStored(t, env, func(ref, value string) bool { return ref == "mcp-oauth:web" && value == "" })
}

// waitStored 等外壳收到满足 pred 的 host.storeSecret。
func waitStored(t *testing.T, env *testEnv, pred func(ref, value string) bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		env.host.mu.Lock()
		stored := append([][2]string(nil), env.host.stored...)
		env.host.mu.Unlock()
		for _, kv := range stored {
			if pred(kv[0], kv[1]) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("外壳一直没收到期望的 host.storeSecret:%q", stored)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitLog 轮询 ai.mcp.status,等某个服务器的日志里出现 want(标准错误是异步写进来的)。
func waitLog(t *testing.T, env *testEnv, id, want string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var all struct {
			Servers []MCPStatus `json:"servers"`
		}
		env.callInto(t, "ai.mcp.status", nil, &all)
		for _, st := range all.Servers {
			if st.ServerID == id && strings.Contains(strings.Join(st.Log, "\n"), want) {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("日志里一直没有 %q:%+v", want, all.Servers)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestMCPStdioSubprocess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Skip("拿不到测试二进制的路径:", err)
	}
	env := newTestService(t)
	addMCPServer(t, env, map[string]any{"id": "proc", "name": "子进程", "enabled": true, "transport": "stdio", "command": exe,
		"env": map[string]string{stdioServerEnv: "1"}})
	env.call(t, "ai.mcp.status", nil)
	st := waitMCP(t, env, "proc", mcpConnected)
	if !hasTool(st.Tools, "mcp__proc__echo") {
		t.Fatalf("应列出子进程服务器的工具:%+v", st.Tools)
	}
	out, err := env.s.mcp.callTool(context.Background(), "proc", "echo", json.RawMessage(`{"text":"stdio"}`))
	if err != nil || out != "echo:stdio" {
		t.Fatalf("经 stdio 调用工具:%q %v", out, err)
	}
	// 子进程的标准错误进状态日志
	waitLog(t, env, "proc", "测试服务器已启动")
}

func TestMCPStdioMissingCommandFails(t *testing.T) {
	env := newTestService(t)
	addMCPServer(t, env, map[string]any{"id": "bad", "name": "坏的", "enabled": true, "transport": "stdio", "command": "typoza-no-such-command-xyz"})
	env.call(t, "ai.mcp.status", nil)
	st := waitMCP(t, env, "bad", mcpFailed)
	if !strings.Contains(st.Error, "找不到命令") || len(st.Log) == 0 {
		t.Fatalf("命令不存在应失败并说明原因:%+v", st)
	}
}

func TestMCPImport(t *testing.T) {
	env := newTestService(t)
	useInMemoryMCP(env)
	doc := `{"mcpServers":{
		"files":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"],"env":{"API_KEY":"sk-imported-secret","DEBUG":"1"}},
		"remote":{"type":"streamableHttp","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer imported-token","X-Region":"cn"}}}}`
	var res struct {
		Added []string `json:"added"`
	}
	env.callInto(t, "ai.mcp.import", map[string]any{"json": doc}, &res)
	if len(res.Added) != 2 {
		t.Fatalf("应导入两个服务器:%+v", res)
	}
	var st Settings
	env.callInto(t, "ai.settings.get", nil, &st)
	byName := map[string]MCPServer{}
	for _, m := range st.MCPServers {
		byName[m.Name] = m
	}
	files, remote := byName["files"], byName["remote"]
	if files.Transport != "stdio" || files.Command != "npx" || len(files.Args) != 3 || files.Env["DEBUG"] != "1" || files.Env["API_KEY"] != "" {
		t.Fatalf("stdio 服务器导入不对(密钥应置空):%+v", files)
	}
	if remote.Transport != "http" || remote.URL != "https://mcp.example.com/mcp" || remote.Headers["Authorization"] != "" || remote.Headers["X-Region"] != "cn" {
		t.Fatalf("HTTP 服务器导入不对(密钥应置空):%+v", remote)
	}
	b, err := os.ReadFile(env.s.settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "sk-imported-secret") || strings.Contains(string(b), "imported-token") {
		t.Fatal("导入的密钥不应写进设置文件")
	}
	env.wantErr(t, codeInvalid, "ai.mcp.import", map[string]any{"json": `{"servers":{}}`})
	env.wantErr(t, codeInvalid, "ai.mcp.import", map[string]any{"json": `{"mcpServers":{"x":{}}}`})
}
