package aisvc

import (
	"context"
	"encoding/json"

	"github.com/ComeHereToSee/typoza-client/helper/internal/rpc"
)

// bind 把强类型处理函数包成 rpc.Handler:参数解码失败返回 invalid,业务错误带契约错误码。
// needMCP 的方法先确保 MCP 服务器开始连接(第一次用到才连)。
func bind[P any](s *Service, needMCP bool, fn func(context.Context, P) (any, error)) rpc.Handler {
	return func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p P
		if len(raw) > 0 && string(raw) != "null" {
			if err := json.Unmarshal(raw, &p); err != nil {
				return nil, toRPC(errf(codeInvalid, "参数格式不对:%v", err))
			}
		}
		if needMCP {
			s.mcp.ensureStarted()
		}
		res, err := fn(ctx, p)
		if err != nil {
			return nil, toRPC(err)
		}
		return res, nil
	}
}

// Routes 返回全部 ai.* 方法。ai.secrets 只给外壳用(参数是密钥),外壳不得把它转发给网页;
// ai.secret.set 由外壳自己处理,不到这里。
func (s *Service) Routes() map[string]rpc.Handler {
	return map[string]rpc.Handler{
		"ai.secrets": bind(s, false, s.setSecrets),

		"ai.settings.get":    bind(s, false, func(context.Context, struct{}) (any, error) { return s.settingsView(), nil }),
		"ai.settings.update": bind(s, false, s.updateSettings),
		"ai.provider.models": bind(s, false, s.providerModels),
		"ai.provider.test":   bind(s, false, s.providerTest),

		"ai.chat.send":       bind(s, true, s.chatSend),
		"ai.chat.regenerate": bind(s, true, s.chatRegenerate),
		"ai.chat.stop":       bind(s, false, s.chatStop),
		"ai.chat.setLeaf":    bind(s, false, s.chatSetLeaf),
		"ai.tool.decide":     bind(s, false, s.toolDecide),

		"ai.conversations.list":   bind(s, false, s.convList),
		"ai.conversations.get":    bind(s, false, s.convGet),
		"ai.conversations.rename": bind(s, false, s.convRename),
		"ai.conversations.delete": bind(s, false, s.convDelete),
		"ai.conversations.clear":  bind(s, false, s.convClear),

		"ai.complete":      bind(s, false, s.complete),
		"ai.complete.stop": bind(s, false, s.completeStop),

		"ai.mcp.status":   bind(s, true, s.mcpStatus),
		"ai.mcp.restart":  bind(s, true, s.mcpRestart),
		"ai.mcp.import":   bind(s, true, s.mcpImport),
		"ai.mcp.prompt":   bind(s, true, s.mcpPrompt),
		"ai.mcp.resource": bind(s, true, s.mcpResource),
		"ai.tools.list":   bind(s, true, s.toolsList),

		"ai.skills.list":    bind(s, false, s.skillsList),
		"ai.skills.install": bind(s, false, s.skillsInstall),
		"ai.skills.remove":  bind(s, false, s.skillsRemove),
	}
}
