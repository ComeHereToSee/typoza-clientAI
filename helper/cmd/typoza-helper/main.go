// typoza-helper 是 Typoza 的辅助进程:由 macOS 外壳按需启动,经标准输入输出走 JSON-RPC,
// 负责云同步(加密、上传下载、冲突处理)与 AI(服务商请求、对话、工具调用、MCP、Skills)。
// 不用云同步也不用 AI 时不会启动,不影响冷启动速度。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/ComeHereToSee/typoza-client/helper/internal/aisvc"
	"github.com/ComeHereToSee/typoza-client/helper/internal/rpc"
	"github.com/ComeHereToSee/typoza-client/helper/internal/syncsvc"
)

var version = "dev"

// shellHost 经 RPC 通道使用外壳的能力。
type shellHost struct{ srv *rpc.Server }

func (h shellHost) Notify(method string, params any) error { return h.srv.Notify(method, params) }

func (h shellHost) Trash(ctx context.Context, absPath string) error {
	return h.srv.Call(ctx, "host.trash", map[string]string{"path": absPath}, nil)
}

// OpenURL 让外壳用系统浏览器打开网址(MCP 授权与征询)。
func (h shellHost) OpenURL(ctx context.Context, url string) error {
	return h.srv.Call(ctx, "host.openURL", map[string]string{"url": url}, nil)
}

// Elicit 让外壳弹原生表单向用户征询(MCP elicitation)。
func (h shellHost) Elicit(ctx context.Context, req aisvc.ElicitArgs) (aisvc.ElicitAnswer, error) {
	var ans aisvc.ElicitAnswer
	err := h.srv.Call(ctx, "host.elicit", req, &ans)
	return ans, err
}

func main() {
	dataDir := flag.String("data-dir", "", "同步配置与状态目录(绝对路径);AI 数据放在它的同级 ai/ 与 skills/")
	deviceName := flag.String("device-name", "", "本机名称")
	flag.Parse()
	// 日志写标准错误,外壳把它转存到 ~/Library/Logs/Typoza/helper.log;标准输出只走 RPC
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := rpc.NewServer(os.Stdout)
	svc, err := syncsvc.New(syncsvc.Options{DataDir: *dataDir, DeviceName: *deviceName, Host: shellHost{srv}, Logger: log})
	if err != nil {
		fmt.Fprintln(os.Stderr, "typoza-helper:", err)
		os.Exit(2)
	}
	// AI 数据与同步数据同在 ~/Library/Application Support/Typoza/ 下:--data-dir 是其中的 sync/
	supportDir := filepath.Dir(*dataDir)
	agentsSkills := ""
	if home, err := os.UserHomeDir(); err == nil {
		agentsSkills = filepath.Join(home, ".agents", "skills")
	}
	ai, err := aisvc.New(aisvc.Options{
		Dir: filepath.Join(supportDir, "ai"), SkillsDir: filepath.Join(supportDir, "skills"), AgentsSkillsDir: agentsSkills,
		Host: shellHost{srv}, Logger: log, Version: version,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "typoza-helper:", err)
		os.Exit(2)
	}
	for method, h := range svc.Routes() {
		srv.Handle(method, h)
	}
	for method, h := range ai.Routes() {
		srv.Handle(method, h)
	}
	srv.Handle("helper.version", func(ctx context.Context, params json.RawMessage) (any, error) {
		return map[string]string{"version": version}, nil
	})
	log.Info("辅助进程已启动", "version", version, "pid", os.Getpid())
	// 正常退出是外壳关闭管道(EOF);收到信号时关掉标准输入让 Serve 返回,再停引擎
	go func() {
		<-ctx.Done()
		_ = os.Stdin.Close()
	}()
	serveErr := srv.Serve(ctx, os.Stdin)
	ai.Close()
	svc.Close()
	if serveErr != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, "typoza-helper:", serveErr)
		os.Exit(1)
	}
}
