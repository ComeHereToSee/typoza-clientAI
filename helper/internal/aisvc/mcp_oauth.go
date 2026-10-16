package aisvc

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
	"golang.org/x/oauth2"
)

// MCP 的 OAuth 授权(只用于 HTTP 服务器):SDK 的授权码流程 + 本机回调地址;登录页交给系统浏览器打开
// (规范要求客户端看不到页面内容)。客户端用动态注册(DCR)取得:Typoza 没有可公开托管的客户端元数据文档。
//
// 令牌经 host.storeSecret 交给外壳存进钥匙串 mcp-oauth:<serverId>(JSON,oauth2.Token 格式),
// 重启后先用存下的访问令牌;过期后服务器回 401,再走一次浏览器登录(动态注册的客户端不落盘,
// 重启后没法用刷新令牌换新)。每次连上时存一次,删掉服务器时一并删除。

type tokenSource = oauth2.TokenSource

// initialToken 先用本进程里上次拿到的令牌,再看钥匙串里有没有。
func (m *mcpManager) initialToken(serverID string, secrets map[string]string) tokenSource {
	m.mu.Lock()
	ts := m.tokens[serverID]
	m.mu.Unlock()
	if ts != nil {
		return ts
	}
	raw := secrets[mcpOAuthSecretRef(serverID)]
	if raw == "" {
		return nil
	}
	var tok oauth2.Token
	if err := json.Unmarshal([]byte(raw), &tok); err != nil || tok.AccessToken == "" {
		// 不是 JSON 就当作裸的访问令牌
		tok = oauth2.Token{AccessToken: raw, TokenType: "Bearer"}
	}
	return oauth2.StaticTokenSource(&tok)
}

// oauthHandler 准备授权处理器与本机回调;返回的 cleanup 关掉回调监听。
func (m *mcpManager) oauthHandler(c *mcpConn, secrets map[string]string) (*auth.AuthorizationCodeHandler, func(), error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, fmt.Errorf("开本机回调端口失败:%w", err)
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)
	results := make(chan url.Values, 1)
	srv := &http.Server{
		ReadHeaderTimeout: 10 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/callback" {
				http.NotFound(w, r)
				return
			}
			select {
			case results <- r.URL.Query():
			default:
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(w, "<!doctype html><meta charset=utf-8><title>Typoza</title><p>授权已完成,可以回到 Typoza 了。</p>")
		}),
	}
	go func() { _ = srv.Serve(ln) }()
	cleanup := func() { _ = srv.Close() }

	h, err := auth.NewAuthorizationCodeHandler(&auth.AuthorizationCodeHandlerConfig{
		DynamicClientRegistrationConfig: &auth.DynamicClientRegistrationConfig{Metadata: &oauthex.ClientRegistrationMetadata{
			RedirectURIs:            []string{redirect},
			ClientName:              "Typoza",
			GrantTypes:              []string{"authorization_code", "refresh_token"},
			ResponseTypes:           []string{"code"},
			TokenEndpointAuthMethod: "none",
		}},
		RedirectURL: redirect,
		AuthorizationCodeFetcher: func(ctx context.Context, args *auth.AuthorizationArgs) (*auth.AuthorizationResult, error) {
			c.log.add("需要授权:已在浏览器中打开登录页")
			if err := m.svc.opts.Host.OpenURL(ctx, args.URL); err != nil {
				return nil, fmt.Errorf("打开浏览器失败:%w", err)
			}
			select {
			case q := <-results:
				if e := q.Get("error"); e != "" {
					return nil, fmt.Errorf("授权没有完成:%s %s", e, q.Get("error_description"))
				}
				return &auth.AuthorizationResult{Code: q.Get("code"), State: q.Get("state"), Iss: q.Get("iss")}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		RequestRefreshToken: true,
		InitialTokenSource:  m.initialToken(c.cfg.ID, secrets),
	})
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return h, cleanup, nil
}

// saveToken 把连上时的令牌交给外壳写钥匙串;和钥匙串里已有的相同就不写。
func (m *mcpManager) saveToken(ctx context.Context, c *mcpConn, ts tokenSource) {
	tok, err := ts.Token()
	if err != nil || tok == nil || tok.AccessToken == "" {
		return
	}
	b, err := json.Marshal(tok)
	if err != nil {
		return
	}
	ref := mcpOAuthSecretRef(c.cfg.ID)
	if m.svc.snap().secrets[ref] == string(b) {
		return
	}
	if err := m.svc.opts.Host.StoreSecret(ctx, ref, string(b)); err != nil {
		c.log.add("保存授权令牌失败,下次启动需要重新登录:" + err.Error())
	}
}

// forgetTokens 删掉已移除服务器在钥匙串里的令牌。
func (m *mcpManager) forgetTokens(serverIDs []string) {
	secrets := m.svc.snap().secrets
	for _, id := range serverIDs {
		ref := mcpOAuthSecretRef(id)
		if secrets[ref] == "" {
			continue
		}
		go func() {
			ctx, cancel := context.WithTimeout(m.svc.ctx, 10*time.Second)
			defer cancel()
			if err := m.svc.opts.Host.StoreSecret(ctx, ref, ""); err != nil {
				m.svc.log.Warn("删除 MCP 授权令牌失败", "server", id, "err", err)
			}
		}()
	}
}
