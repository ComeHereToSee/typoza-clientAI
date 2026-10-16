package aisvc

import (
	"context"
	"errors"
	"fmt"

	"github.com/ComeHereToSee/typoza-client/helper/internal/rpc"
)

// 错误码(契约 3.1):网页据此分支,message 直接展示。
const (
	codeNotConfigured = "not_configured"
	codeAuth          = "auth"
	codeRateLimit     = "rate_limit"
	codeNetwork       = "network"
	codeProvider      = "provider"
	codeInvalid       = "invalid"
	codeNotFound      = "not_found"
	codeCancelled     = "cancelled"
	codeInternal      = "internal"
)

// aiError 是带错误码的业务错误。
type aiError struct {
	Code    string
	Message string
}

func (e *aiError) Error() string { return e.Message }

func errf(code, format string, args ...any) *aiError {
	return &aiError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// asAIError 把任意错误归到契约错误码;没带错误码的一律算 internal。
func asAIError(err error) *aiError {
	var ae *aiError
	if errors.As(err, &ae) {
		return ae
	}
	if errors.Is(err, context.Canceled) {
		return errf(codeCancelled, "已停止")
	}
	return errf(codeInternal, "%v", err)
}

// toRPC 包成 RPC 业务错误:外壳从 data.code 取错误码转给网页(与云同步一致)。
func toRPC(err error) *rpc.Error {
	ae := asAIError(err)
	return &rpc.Error{Code: rpc.CodeApp, Message: ae.Message, Data: map[string]string{"code": ae.Code}}
}

func (e *aiError) info() *ErrorInfo { return &ErrorInfo{Code: e.Code, Message: e.Message} }
