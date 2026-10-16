package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MCP 客户端:用官方 Go SDK 按设置连接 stdio 与 Streamable HTTP 服务器(连不上时退回已废弃的 HTTP+SSE)。
// 第一次用到 MCP(打开 MCP 设置、列工具、发消息)时才开始连,免得只用云同步时也拉起一堆子进程。

const (
	mcpLogLines       = 200 // 契约 4:stdio 服务器的标准错误保留末尾 200 行
	mcpConnectTimeout = 60 * time.Second
	// HTTP 服务器可能要在浏览器里完成 OAuth 登录,多给些时间
	mcpHTTPConnectTimeout = 5 * time.Minute
	mcpCallTimeout        = 2 * time.Minute
	mcpCloseWait          = 2 * time.Second
)

type mcpManager struct {
	svc *Service

	mu      sync.Mutex
	started bool
	closed  bool
	conns   map[string]*mcpConn
	tokens  map[string]tokenSource // serverId → 上次 OAuth 拿到的令牌,重连时复用(只在内存里)

	// transports 给出连接候选(依次尝试);测试里换成内存传输。cleanup 释放连接用到的资源。
	transports func(ctx context.Context, c *mcpConn, secrets map[string]string) (ts []mcp.Transport, cleanup func(), err error)
}

// mcpConn 是对一个服务器的一次连接;改配置或重启时整个换成新对象,旧对象上的后台任务据此放弃。
type mcpConn struct {
	cfg    MCPServer
	log    *lineLog
	ctx    context.Context
	cancel context.CancelFunc
	ready  chan struct{} // 这次连接尝试结束(成功或失败)时关闭
	oauth  *auth.AuthorizationCodeHandler

	// 以下字段由 mcpManager.mu 保护
	state     string
	err       string
	session   *mcp.ClientSession
	cleanup   func()
	tools     []*mcp.Tool
	prompts   []*mcp.Prompt
	resources []*mcp.Resource
}

func newMCPManager(s *Service) *mcpManager {
	m := &mcpManager{svc: s, conns: map[string]*mcpConn{}, tokens: map[string]tokenSource{}}
	m.transports = m.defaultTransports
	return m
}

// ensureStarted 第一次调用时按当前设置连接全部启用的服务器。
func (m *mcpManager) ensureStarted() {
	m.mu.Lock()
	if m.started || m.closed {
		m.mu.Unlock()
		return
	}
	m.started = true
	m.mu.Unlock()
	m.reconcile(m.svc.snap().st.MCPServers)
}

// newConnLocked 建一个连接对象;调用方持有 m.mu。
func (m *mcpManager) newConnLocked(cfg MCPServer, log *lineLog) *mcpConn {
	ctx, cancel := context.WithCancel(m.svc.ctx)
	c := &mcpConn{cfg: cfg, log: log, ctx: ctx, cancel: cancel, ready: make(chan struct{}), state: mcpConnecting}
	if !cfg.Enabled {
		c.state = mcpDisabled
		close(c.ready)
	}
	return c
}

// reconcile 让连接与设置一致:新增的连上、删掉的断开、改了配置的重连、停用的断开。
func (m *mcpManager) reconcile(servers []MCPServer) {
	m.mu.Lock()
	if !m.started || m.closed {
		m.mu.Unlock()
		return
	}
	want := map[string]bool{}
	var toClose, changed []*mcpConn
	for _, cfg := range servers {
		want[cfg.ID] = true
		old := m.conns[cfg.ID]
		if old != nil && reflect.DeepEqual(old.cfg, cfg) {
			continue
		}
		log := newLineLog(mcpLogLines)
		if old != nil {
			toClose = append(toClose, old)
			log = old.log
		}
		c := m.newConnLocked(cfg, log)
		m.conns[cfg.ID] = c
		changed = append(changed, c)
	}
	var removed []string
	for id, c := range m.conns {
		if !want[id] {
			toClose = append(toClose, c)
			delete(m.conns, id)
			delete(m.tokens, id)
			removed = append(removed, id)
		}
	}
	m.mu.Unlock()
	for _, c := range toClose {
		go m.closeConn(c)
	}
	m.forgetTokens(removed)
	for _, c := range changed {
		if c.cfg.Enabled {
			go m.connect(c)
		} else {
			m.notify(c)
		}
	}
}

func (m *mcpManager) current(c *mcpConn) bool {
	return !m.closed && m.conns[c.cfg.ID] == c
}

func (m *mcpManager) connect(c *mcpConn) {
	defer close(c.ready)
	m.notify(c)
	timeout := mcpConnectTimeout
	if c.cfg.Transport == "http" {
		timeout = mcpHTTPConnectTimeout
	}
	ctx, cancel := context.WithTimeout(c.ctx, timeout)
	defer cancel()
	session, cleanup, err := m.dial(ctx, c)
	if err != nil {
		m.fail(c, err)
		return
	}
	tools, prompts, resources, err := listAll(ctx, session)
	if err != nil {
		_ = session.Close()
		cleanup()
		m.fail(c, fmt.Errorf("读取工具列表失败:%w", err))
		return
	}
	if c.oauth != nil {
		if ts, _ := c.oauth.TokenSource(ctx); ts != nil {
			m.mu.Lock()
			m.tokens[c.cfg.ID] = ts
			m.mu.Unlock()
			m.saveToken(ctx, c, ts)
		}
	}
	m.mu.Lock()
	if !m.current(c) {
		m.mu.Unlock()
		_ = session.Close()
		cleanup()
		return
	}
	c.state, c.err = mcpConnected, ""
	c.session, c.cleanup = session, cleanup
	c.tools, c.prompts, c.resources = tools, prompts, resources
	m.mu.Unlock()
	c.log.add(fmt.Sprintf("已连接:%d 个工具、%d 个提示词、%d 个资源", len(tools), len(prompts), len(resources)))
	m.notify(c)
	go func() {
		werr := session.Wait()
		m.mu.Lock()
		lost := m.current(c) && c.session == session
		if lost {
			c.state, c.err, c.session = mcpFailed, "连接已断开", nil
		}
		m.mu.Unlock()
		if lost {
			cleanup()
			if werr != nil {
				c.log.add("连接断开:" + werr.Error())
			} else {
				c.log.add("连接断开")
			}
			m.notify(c)
		}
	}()
}

func (m *mcpManager) fail(c *mcpConn, err error) {
	msg := err.Error()
	if errors.Is(err, context.DeadlineExceeded) {
		msg = "连接超时"
	}
	c.log.add("连接失败:" + msg)
	m.mu.Lock()
	cur := m.current(c)
	if cur {
		c.state, c.err = mcpFailed, msg
	}
	m.mu.Unlock()
	if cur {
		m.notify(c)
	}
}

// dial 依次尝试候选传输,全部失败时报第一个的错误。
func (m *mcpManager) dial(ctx context.Context, c *mcpConn) (*mcp.ClientSession, func(), error) {
	secrets := m.svc.snap().secrets
	ts, cleanup, err := m.transports(ctx, c, secrets)
	if err != nil {
		return nil, nil, err
	}
	cleanup = onceFunc(cleanup)
	client := mcp.NewClient(&mcp.Implementation{Name: "typoza", Title: "Typoza", Version: m.svc.opts.Version}, &mcp.ClientOptions{
		// 不声明 roots(规范 2026-07-28 已废弃);声明表单与网址两种征询
		Capabilities: &mcp.ClientCapabilities{Elicitation: &mcp.ElicitationCapabilities{
			Form: &mcp.FormElicitationCapabilities{}, URL: &mcp.URLElicitationCapabilities{},
		}},
		ElicitationHandler: func(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			return m.elicit(ctx, c.cfg, req)
		},
		ToolListChangedHandler:     func(context.Context, *mcp.ToolListChangedRequest) { go m.refresh(c) },
		PromptListChangedHandler:   func(context.Context, *mcp.PromptListChangedRequest) { go m.refresh(c) },
		ResourceListChangedHandler: func(context.Context, *mcp.ResourceListChangedRequest) { go m.refresh(c) },
	})
	var firstErr error
	for i, t := range ts {
		session, err := client.Connect(ctx, t, nil)
		if err == nil {
			if i > 0 {
				c.log.add("Streamable HTTP 连不上,已按旧的 HTTP+SSE 方式连接(该方式已废弃)")
			}
			return session, cleanup, nil
		}
		if firstErr == nil {
			firstErr = err
		}
		if ctx.Err() != nil {
			break
		}
	}
	cleanup()
	return nil, nil, firstErr
}

func onceFunc(f func()) func() {
	if f == nil {
		return func() {}
	}
	return sync.OnceFunc(f)
}

// listAll 读服务器的工具、提示词、资源;服务器没声明的能力不读。
func listAll(ctx context.Context, s *mcp.ClientSession) (tools []*mcp.Tool, prompts []*mcp.Prompt, resources []*mcp.Resource, err error) {
	var caps *mcp.ServerCapabilities
	if ir := s.InitializeResult(); ir != nil {
		caps = ir.Capabilities
	}
	if caps == nil || caps.Tools != nil {
		for t, err := range s.Tools(ctx, nil) {
			if err != nil {
				return nil, nil, nil, err
			}
			tools = append(tools, t)
		}
	}
	if caps != nil && caps.Prompts != nil {
		for p, err := range s.Prompts(ctx, nil) {
			if err != nil {
				return nil, nil, nil, err
			}
			prompts = append(prompts, p)
		}
	}
	if caps != nil && caps.Resources != nil {
		for r, err := range s.Resources(ctx, nil) {
			if err != nil {
				return nil, nil, nil, err
			}
			resources = append(resources, r)
		}
	}
	return tools, prompts, resources, nil
}

// refresh 服务器通知列表有变时重新读取。
func (m *mcpManager) refresh(c *mcpConn) {
	m.mu.Lock()
	session := c.session
	ok := m.current(c) && session != nil
	m.mu.Unlock()
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(c.ctx, 30*time.Second)
	defer cancel()
	tools, prompts, resources, err := listAll(ctx, session)
	if err != nil {
		c.log.add("刷新列表失败:" + err.Error())
		return
	}
	m.mu.Lock()
	if m.current(c) {
		c.tools, c.prompts, c.resources = tools, prompts, resources
	}
	m.mu.Unlock()
	m.notify(c)
}

func (m *mcpManager) closeConn(c *mcpConn) {
	c.cancel()
	m.mu.Lock()
	session, cleanup := c.session, c.cleanup
	c.session, c.cleanup = nil, nil
	m.mu.Unlock()
	if session != nil {
		_ = session.Close()
	}
	if cleanup != nil {
		cleanup()
	}
}

// closeAll 退出时断开全部服务器(stdio 子进程先关标准输入再终止),最多等 mcpCloseWait。
func (m *mcpManager) closeAll() {
	m.mu.Lock()
	m.closed = true
	conns := make([]*mcpConn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, c := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			m.closeConn(c)
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(mcpCloseWait):
	}
}

// waitReady 等指定服务器的连接尝试结束,最多等 d。
func (m *mcpManager) waitReady(ctx context.Context, ids []string, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	for _, id := range ids {
		m.mu.Lock()
		c := m.conns[id]
		m.mu.Unlock()
		if c == nil {
			continue
		}
		select {
		case <-c.ready:
		case <-timer.C:
			return
		case <-ctx.Done():
			return
		}
	}
}

// ---------- 状态 ----------

func mcpToolName(serverID, tool string) string { return "mcp__" + serverID + "__" + tool }

func mcpToolInfo(cfg MCPServer, t *mcp.Tool) ToolInfo {
	title := t.Title
	if title == "" && t.Annotations != nil {
		title = t.Annotations.Title
	}
	if title == "" {
		title = t.Name
	}
	return ToolInfo{Name: mcpToolName(cfg.ID, t.Name), Title: title, Description: t.Description, Source: cfg.Name, InputSchema: t.InputSchema}
}

func (m *mcpManager) statusLocked(c *mcpConn) MCPStatus {
	st := MCPStatus{ServerID: c.cfg.ID, State: c.state, Error: c.err, Tools: []ToolInfo{}, Prompts: []PromptInfo{}, Resources: []ResourceInfo{}, Log: c.log.snapshot()}
	if c.state != mcpConnected {
		return st
	}
	for _, t := range c.tools {
		st.Tools = append(st.Tools, mcpToolInfo(c.cfg, t))
	}
	for _, p := range c.prompts {
		pi := PromptInfo{Name: p.Name, Description: p.Description}
		for _, a := range p.Arguments {
			pi.Arguments = append(pi.Arguments, PromptArgument{Name: a.Name, Description: a.Description, Required: a.Required})
		}
		st.Prompts = append(st.Prompts, pi)
	}
	for _, r := range c.resources {
		name := r.Title
		if name == "" {
			name = r.Name
		}
		st.Resources = append(st.Resources, ResourceInfo{URI: r.URI, Name: name})
	}
	return st
}

func (m *mcpManager) notify(c *mcpConn) {
	m.mu.Lock()
	if !m.current(c) {
		m.mu.Unlock()
		return
	}
	st := m.statusLocked(c)
	m.mu.Unlock()
	m.svc.emit(map[string]any{"type": "mcp.status", "status": st})
}

// statuses 按设置里的顺序列出全部服务器的状态。
func (m *mcpManager) statuses(servers []MCPServer) []MCPStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]MCPStatus, 0, len(servers))
	for _, cfg := range servers {
		if c := m.conns[cfg.ID]; c != nil {
			out = append(out, m.statusLocked(c))
			continue
		}
		state := mcpConnecting
		if !cfg.Enabled {
			state = mcpDisabled
		}
		out = append(out, MCPStatus{ServerID: cfg.ID, State: state, Tools: []ToolInfo{}, Prompts: []PromptInfo{}, Resources: []ResourceInfo{}, Log: []string{}})
	}
	return out
}

// tools 是某个已连接服务器的工具;MCP 工具默认每次询问(PRD 3.6)。
func (m *mcpManager) tools(serverID string) []*toolImpl {
	m.mu.Lock()
	c := m.conns[serverID]
	if c == nil || c.state != mcpConnected {
		m.mu.Unlock()
		return nil
	}
	cfg, tools := c.cfg, c.tools
	m.mu.Unlock()
	out := make([]*toolImpl, 0, len(tools))
	for _, t := range tools {
		out = append(out, &toolImpl{
			info:          mcpToolInfo(cfg, t),
			defaultPolicy: policyAsk,
			run: func(ctx context.Context, in json.RawMessage) (string, error) {
				return m.callTool(ctx, serverID, t.Name, in)
			},
		})
	}
	return out
}

func (m *mcpManager) session(serverID string) (*mcp.ClientSession, *mcpConn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := m.conns[serverID]
	if c == nil {
		return nil, nil, errf(codeNotFound, "没有这个 MCP 服务器")
	}
	if c.session == nil {
		return nil, nil, errf(codeInvalid, "MCP 服务器「%s」还没连上", c.cfg.Name)
	}
	return c.session, c, nil
}

func (m *mcpManager) callTool(ctx context.Context, serverID, name string, input json.RawMessage) (string, error) {
	session, c, err := m.session(serverID)
	if err != nil {
		return "", err
	}
	// 审计:工具调用记进服务器日志(PRD「日志可查」),参数不记,里面可能有用户内容
	c.log.add("调用工具 " + name)
	ctx, cancel := context.WithTimeout(ctx, mcpCallTimeout)
	defer cancel()
	res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
	if err != nil {
		c.log.add("调用 " + name + " 失败:" + err.Error())
		return "", fmt.Errorf("调用失败:%v", err)
	}
	text := contentText(res.Content)
	if text == "" && res.StructuredContent != nil {
		b, _ := json.Marshal(res.StructuredContent)
		text = string(b)
	}
	if res.IsError {
		if text == "" {
			text = "工具报告了错误"
		}
		return "", errors.New(text)
	}
	return text, nil
}

// contentText 把 MCP 返回的内容转成交给模型的文字;图片、音频等只给占位说明。
func contentText(cs []mcp.Content) string {
	var parts []string
	for _, c := range cs {
		switch v := c.(type) {
		case *mcp.TextContent:
			parts = append(parts, v.Text)
		case *mcp.ImageContent:
			parts = append(parts, fmt.Sprintf("[图片 %s,未展示]", v.MIMEType))
		case *mcp.AudioContent:
			parts = append(parts, "[音频,未展示]")
		case *mcp.ResourceLink:
			parts = append(parts, fmt.Sprintf("[%s](%s)", v.Name, v.URI))
		case *mcp.EmbeddedResource:
			if v.Resource != nil && v.Resource.Text != "" {
				parts = append(parts, v.Resource.Text)
			} else if v.Resource != nil {
				parts = append(parts, fmt.Sprintf("[资源 %s,二进制内容未展示]", v.Resource.URI))
			}
		default:
			parts = append(parts, "[不支持展示的内容]")
		}
	}
	return strings.Join(parts, "\n\n")
}

// elicit 处理服务器的征询:表单交给外壳弹原生表单;网址先经外壳征得同意(显示完整网址)再交给系统浏览器。
func (m *mcpManager) elicit(ctx context.Context, cfg MCPServer, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
	p := req.Params
	host := m.svc.opts.Host
	if p.Mode == "url" || (p.Mode == "" && p.URL != "") {
		ans, err := host.Elicit(ctx, ElicitArgs{
			ServerID: cfg.ID, ServerName: cfg.Name,
			Message: strings.TrimSpace(p.Message + "\n\n需要在浏览器中打开:\n" + p.URL),
			Schema:  map[string]any{"type": "object", "properties": map[string]any{}},
		})
		if err != nil {
			return nil, err
		}
		if ans.Action == "accept" {
			if err := host.OpenURL(ctx, p.URL); err != nil {
				return nil, err
			}
		}
		return &mcp.ElicitResult{Action: ans.Action}, nil
	}
	ans, err := host.Elicit(ctx, ElicitArgs{ServerID: cfg.ID, ServerName: cfg.Name, Message: p.Message, Schema: p.RequestedSchema})
	if err != nil {
		return nil, err
	}
	if ans.Action != "accept" {
		return &mcp.ElicitResult{Action: ans.Action}, nil
	}
	return &mcp.ElicitResult{Action: ans.Action, Content: ans.Content}, nil
}

// ---------- 传输 ----------

func (m *mcpManager) defaultTransports(ctx context.Context, c *mcpConn, secrets map[string]string) ([]mcp.Transport, func(), error) {
	switch c.cfg.Transport {
	case "stdio":
		t, err := stdioTransport(c, secrets)
		if err != nil {
			return nil, nil, err
		}
		return []mcp.Transport{t}, nil, nil
	case "http":
		return m.httpTransports(c, secrets)
	default:
		return nil, nil, fmt.Errorf("传输方式「%s」不支持", c.cfg.Transport)
	}
}

// resolveSecretValues 把值为空串的项换成钥匙串里的值(引用名 mcp:<serverId>:<name>)。
func resolveSecretValues(c *mcpConn, kind string, values map[string]string, secrets map[string]string) map[string]string {
	out := make(map[string]string, len(values))
	for name, v := range values {
		if v == "" {
			sv, ok := secrets[mcpSecretRef(c.cfg.ID, name)]
			if !ok {
				c.log.add(fmt.Sprintf("%s %s 的值应在钥匙串里,但没有找到", kind, name))
				continue
			}
			v = sv
		}
		out[name] = v
	}
	return out
}

func stdioTransport(c *mcpConn, secrets map[string]string) (mcp.Transport, error) {
	path := searchPath()
	cmdPath, err := lookPath(c.cfg.Command, path)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(cmdPath, c.cfg.Args...) // #nosec G204 -- 用户在设置里配置的 MCP 本机命令,按设计以用户权限运行(设置页已明示)
	env := make([]string, 0, len(os.Environ())+len(c.cfg.Env)+1)
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "PATH=") {
			env = append(env, kv)
		}
	}
	env = append(env, "PATH="+path)
	extra := resolveSecretValues(c, "环境变量", c.cfg.Env, secrets)
	names := make([]string, 0, len(extra))
	for name := range extra {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		env = append(env, name+"="+extra[name])
	}
	cmd.Env = env
	// 标准错误进状态日志(保留末尾 200 行),启动失败时界面能看到原因
	cmd.Stderr = c.log
	c.log.add("启动:" + strings.Join(append([]string{cmdPath}, c.cfg.Args...), " "))
	return &mcp.CommandTransport{Command: cmd, TerminateDuration: time.Second}, nil
}

// searchPath 是找命令用的 PATH。从访达启动的应用只有 /usr/bin:/bin:/usr/sbin:/sbin,
// 用 Homebrew、npm、uv 装的 npx / uvx 都找不到,所以补上常见的安装目录【假设】。
func searchPath() string {
	home, _ := os.UserHomeDir()
	dirs := filepath.SplitList(os.Getenv("PATH"))
	extra := []string{"/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}
	if home != "" {
		extra = append(extra, filepath.Join(home, ".local/bin"), filepath.Join(home, ".cargo/bin"),
			filepath.Join(home, ".bun/bin"), filepath.Join(home, ".volta/bin"), filepath.Join(home, ".deno/bin"))
	}
	seen := map[string]bool{}
	var out []string
	for _, d := range append(dirs, extra...) {
		if d != "" && !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	return strings.Join(out, string(filepath.ListSeparator))
}

func lookPath(command, path string) (string, error) {
	command = strings.TrimSpace(command)
	if strings.Contains(command, "/") {
		if isExecutable(command) {
			return command, nil
		}
		return "", fmt.Errorf("命令「%s」不存在或不能执行", command)
	}
	for _, dir := range filepath.SplitList(path) {
		p := filepath.Join(dir, command)
		if isExecutable(p) {
			return p, nil
		}
	}
	return "", fmt.Errorf("找不到命令「%s」(已在 %s 中查找)", command, path)
}

func isExecutable(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir() && info.Mode()&0o111 != 0
}

// headerTransport 给每个请求加上配置里的请求头。
type headerTransport struct {
	base    http.RoundTripper
	headers map[string]string
}

func (t *headerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	for k, v := range t.headers {
		r.Header.Set(k, v)
	}
	return t.base.RoundTrip(r)
}

func (m *mcpManager) httpTransports(c *mcpConn, secrets map[string]string) ([]mcp.Transport, func(), error) {
	headers := resolveSecretValues(c, "请求头", c.cfg.Headers, secrets)
	hc := &http.Client{Transport: &headerTransport{base: http.DefaultTransport, headers: headers}}
	st := &mcp.StreamableClientTransport{Endpoint: c.cfg.URL, HTTPClient: hc}
	var cleanup func()
	// 配了 Authorization 头的服务器不走 OAuth
	hasAuth := false
	for k := range headers {
		if strings.EqualFold(k, "Authorization") {
			hasAuth = true
		}
	}
	if !hasAuth {
		h, done, err := m.oauthHandler(c, secrets)
		if err != nil {
			c.log.add("准备 OAuth 授权失败,按无授权连接:" + err.Error())
		} else {
			c.oauth = h
			st.OAuthHandler = h
			cleanup = done
		}
	}
	return []mcp.Transport{st, &mcp.SSEClientTransport{Endpoint: c.cfg.URL, HTTPClient: hc}}, cleanup, nil
}

// ---------- RPC ----------

func (s *Service) mcpStatus(context.Context, struct{}) (any, error) {
	sn := s.snap()
	return map[string]any{"servers": s.mcp.statuses(sn.st.MCPServers)}, nil
}

type serverParams struct {
	ServerID string            `json:"serverId"`
	Name     string            `json:"name"`
	Args     map[string]string `json:"args"`
	URI      string            `json:"uri"`
}

// mcpRestart 用当前设置重连一个服务器,等这次连接尝试结束再返回状态。
func (s *Service) mcpRestart(ctx context.Context, p serverParams) (any, error) {
	sn := s.snap()
	cfg := sn.st.mcpServer(p.ServerID)
	if cfg == nil {
		return nil, errf(codeNotFound, "没有这个 MCP 服务器")
	}
	m := s.mcp
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil, errf(codeCancelled, "AI 组件正在退出")
	}
	old := m.conns[cfg.ID]
	log := newLineLog(mcpLogLines)
	if old != nil {
		log = old.log
	}
	c := m.newConnLocked(*cfg, log)
	m.conns[cfg.ID] = c
	m.mu.Unlock()
	if old != nil {
		m.closeConn(old)
	}
	if cfg.Enabled {
		c.log.add("重新连接")
		go m.connect(c)
		select {
		case <-c.ready:
		case <-ctx.Done():
		}
	} else {
		m.notify(c)
	}
	m.mu.Lock()
	st := m.statusLocked(c)
	m.mu.Unlock()
	return st, nil
}

func (s *Service) mcpPrompt(ctx context.Context, p serverParams) (any, error) {
	session, _, err := s.mcp.session(p.ServerID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, mcpCallTimeout)
	defer cancel()
	res, err := session.GetPrompt(ctx, &mcp.GetPromptParams{Name: p.Name, Arguments: p.Args})
	if err != nil {
		return nil, errf(codeProvider, "取提示词失败:%v", err)
	}
	var parts []string
	for _, msg := range res.Messages {
		if msg == nil || msg.Content == nil {
			continue
		}
		if t := contentText([]mcp.Content{msg.Content}); t != "" {
			parts = append(parts, t)
		}
	}
	return map[string]any{"text": strings.Join(parts, "\n\n")}, nil
}

func (s *Service) mcpResource(ctx context.Context, p serverParams) (any, error) {
	session, _, err := s.mcp.session(p.ServerID)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, mcpCallTimeout)
	defer cancel()
	res, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: p.URI})
	if err != nil {
		return nil, errf(codeProvider, "读取资源失败:%v", err)
	}
	var parts []string
	for _, c := range res.Contents {
		if c == nil {
			continue
		}
		if c.Text != "" {
			parts = append(parts, c.Text)
		} else if len(c.Blob) > 0 {
			parts = append(parts, fmt.Sprintf("[二进制内容 %s,未展示]", c.MIMEType))
		}
	}
	return map[string]any{"text": strings.Join(parts, "\n\n")}, nil
}

type importParams struct {
	JSON json.RawMessage `json:"json"`
}

type importedServer struct {
	Type      string            `json:"type"`
	Transport string            `json:"transport"`
	Command   string            `json:"command"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`
	URL       string            `json:"url"`
	BaseURL   string            `json:"baseUrl"`
	ServerURL string            `json:"serverUrl"`
	Headers   map[string]string `json:"headers"`
	Disabled  bool              `json:"disabled"`
}

// secretNameRe 判断环境变量 / 请求头名像不像放密钥的。
var secretNameRe = regexp.MustCompile(`(?i)(key|token|secret|passw|auth|credential|cookie|session)`)

// mcpImport 导入 {"mcpServers": {...}}(Claude Desktop / Cursor 等通用格式)。
// 像密钥的环境变量与请求头只留名字、值置空(= 在钥匙串里),需要用户在设置页重新填写:
// 辅助进程写不了钥匙串,而设置文件不能有明文密钥【假设】。
func (s *Service) mcpImport(_ context.Context, p importParams) (any, error) {
	raw := p.JSON
	var str string
	if json.Unmarshal(raw, &str) == nil {
		raw = json.RawMessage(str)
	}
	var doc struct {
		MCPServers map[string]importedServer `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errf(codeInvalid, "JSON 格式不对:%v", err)
	}
	if len(doc.MCPServers) == 0 {
		return nil, errf(codeInvalid, "没有找到 mcpServers")
	}
	names := make([]string, 0, len(doc.MCPServers))
	for n := range doc.MCPServers {
		names = append(names, n)
	}
	sort.Strings(names)
	var added []MCPServer
	for _, n := range names {
		in := doc.MCPServers[n]
		srv := MCPServer{ID: newID(), Name: n, Enabled: !in.Disabled, Args: in.Args}
		url := firstNonEmpty(in.URL, in.ServerURL, in.BaseURL)
		switch {
		case in.Command != "":
			srv.Transport, srv.Command = "stdio", in.Command
			srv.Env = blankSecrets(in.Env)
		case url != "":
			srv.Transport, srv.URL = "http", url
			srv.Headers = blankSecrets(in.Headers)
		default:
			return nil, errf(codeInvalid, "「%s」既没有 command 也没有 url", n)
		}
		added = append(added, srv)
	}
	st, err := s.mutateSettings(func(st *Settings) error {
		st.MCPServers = append(st.MCPServers, added...)
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.mcp.reconcile(st.MCPServers)
	ids := make([]string, 0, len(added))
	for _, a := range added {
		ids = append(ids, a.ID)
	}
	return map[string]any{"added": ids}, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func blankSecrets(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		if secretNameRe.MatchString(k) {
			v = ""
		}
		out[k] = v
	}
	return out
}
