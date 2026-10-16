// Package aisvc 是辅助进程里的 AI 服务:服务商适配与流式请求、对话存储与分支、工具调用循环、
// MCP 客户端、内置连接器、Skills 读取、助手与 AI 设置存储。接口契约见 docs/tech/ai-architecture.md 第 3 节。
//
// 密钥(服务商密钥、MCP 环境变量与请求头里的凭据)不落辅助进程的磁盘:外壳从钥匙串取出后经 ai.secrets
// 全量推送,只存在内存里。设置与对话文件里只有引用名。
package aisvc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// NotifyEvent 是推给外壳的 AI 事件通知;外壳原样广播给所有窗口,网页 host.onAiEvent 收到 params。
const NotifyEvent = "ai.event"

// Host 是外壳一侧的能力。
type Host interface {
	// Notify 推送通知(无需回执)。
	Notify(method string, params any) error
	// OpenURL 让外壳用系统浏览器打开网址(MCP 授权与征询;规范要求客户端看不到页面内容)。
	OpenURL(ctx context.Context, url string) error
	// Elicit 让外壳弹原生表单向用户征询信息(MCP elicitation)。
	Elicit(ctx context.Context, req ElicitArgs) (ElicitAnswer, error)
	// StoreSecret 让外壳把 MCP OAuth 令牌写进钥匙串(ref 以 mcp-oauth: 开头;value 为空表示删除),
	// 外壳随后全量推回 ai.secrets。
	StoreSecret(ctx context.Context, ref, value string) error
}

// ElicitArgs 是 host.elicit 的参数。serverName 是契约之外新增的字段,外壳弹窗标题用它显示服务器名。
type ElicitArgs struct {
	ServerID   string `json:"serverId"`
	ServerName string `json:"serverName,omitempty"`
	Message    string `json:"message"`
	Schema     any    `json:"schema"`
}

// ElicitAnswer 是 host.elicit 的结果:action 为 accept / decline / cancel。
type ElicitAnswer struct {
	Action  string         `json:"action"`
	Content map[string]any `json:"content,omitempty"`
}

// Options 是 Service 的构造参数。
type Options struct {
	// Dir 是 AI 数据目录(settings.json 与 conversations/),外壳的 Typoza 数据目录下的 ai/。
	Dir string
	// SkillsDir 是 Typoza 自己的技能目录(…/Typoza/skills)。
	SkillsDir string
	// AgentsSkillsDir 是通用技能目录 ~/.agents/skills,设置里打开 readAgentsSkills 才读;空表示不支持。
	AgentsSkillsDir string
	Host            Host
	// HTTPClient 用于服务商请求与网页读取,可选,测试里替换。
	HTTPClient *http.Client
	Logger     *slog.Logger
	// Version 是辅助进程版本,作为 MCP 客户端版本号上报。
	Version string
}

// Service 是 AI 服务。方法可并发调用。
type Service struct {
	opts Options
	log  *slog.Logger
	http *http.Client
	ctx  context.Context
	stop context.CancelFunc
	// wg 跟踪后台任务(生成回答、起标题、单轮生成),退出时等它们把状态写盘
	wg sync.WaitGroup

	// mu 保护以下字段
	mu        sync.Mutex
	settings  Settings
	secrets   map[string]string
	keyIndex  map[string]int // 服务商 ID → 上次成功的密钥序号(多密钥轮换)
	gens      map[string]*generation
	waits     map[string]chan decision // conversationId/callId → 等待用户确认
	completes map[string]context.CancelFunc

	convs *convStore
	mcp   *mcpManager
}

// New 读取设置;不联网、不启动 MCP 服务器(第一次用到时才连)。
func New(opts Options) (*Service, error) {
	if opts.Dir == "" || !filepath.IsAbs(opts.Dir) {
		return nil, fmt.Errorf("AI 数据目录 %q 必须是绝对路径", opts.Dir)
	}
	if opts.SkillsDir == "" || !filepath.IsAbs(opts.SkillsDir) {
		return nil, fmt.Errorf("技能目录 %q 必须是绝对路径", opts.SkillsDir)
	}
	if opts.Host == nil {
		return nil, errors.New("aisvc: 缺少 Host")
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	if opts.Version == "" {
		opts.Version = "dev"
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		// 不设整体超时:流式回答可能持续很久,改由 idleContext 按「多久没收到数据」判超时
		httpClient = &http.Client{}
	}
	ctx, stop := context.WithCancel(context.Background())
	s := &Service{
		opts:      opts,
		log:       opts.Logger,
		http:      httpClient,
		ctx:       ctx,
		stop:      stop,
		secrets:   map[string]string{},
		keyIndex:  map[string]int{},
		gens:      map[string]*generation{},
		waits:     map[string]chan decision{},
		completes: map[string]context.CancelFunc{},
	}
	s.settings = loadSettings(s.settingsPath(), s.log)
	s.convs = newConvStore(filepath.Join(opts.Dir, "conversations"), s.log)
	s.mcp = newMCPManager(s)
	return s, nil
}

// Close 停止全部生成与 MCP 连接;正在生成的回答记为已停止并写盘。
func (s *Service) Close() {
	s.stop()
	s.mcp.closeAll()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		s.log.Warn("AI 后台任务没能在 3 秒内结束")
	}
}

// emit 推送一个 ai.event;fields 里必须有 type。
func (s *Service) emit(fields map[string]any) {
	if err := s.opts.Host.Notify(NotifyEvent, fields); err != nil {
		s.log.Warn("推送 AI 事件失败", "type", fields["type"], "err", err)
	}
}

// goBackground 在服务的生命周期内跑一个后台任务。
func (s *Service) goBackground(fn func()) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		fn()
	}()
}
