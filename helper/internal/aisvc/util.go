package aisvc

import (
	"bytes"
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// newID 生成契约规定的 ID:随机 12 字节,base32 小写(20 个字符)。
func newID() string {
	var b [12]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误
	return strings.ToLower(idEncoding.EncodeToString(b[:]))
}

// validID 判断 ID 能否安全地拼进文件名(对话文件以 ID 命名,防止 ../ 之类越出目录)。
func validID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}

func nowMs() int64 { return time.Now().UnixMilli() }

// writeFileAtomic 先写同目录临时文件再改名,中途崩溃也不会留下半个文件。
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建目录 %s: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+"-*.tmp")
	if err != nil {
		return fmt.Errorf("写 %s: %w", path, err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("写 %s: %w", path, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("写 %s: %w", path, err)
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("写 %s: %w", path, err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("写 %s: %w", path, err)
	}
	return nil
}

func writeJSONAtomic(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Errorf("编码 %s: %w", filepath.Base(path), err)
	}
	return writeFileAtomic(path, b)
}

// truncateRunes 截到 n 个字符,超出时加省略号。
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	i := 0
	for j := range s {
		if i == n {
			return s[:j] + "…"
		}
		i++
	}
	return s
}

// maxToolResult 是单次工具结果交给模型的上限(PRD 3.7【假设】20000 字)。
const maxToolResult = 20000

// truncateResult 超过上限时截断并注明原长度,让模型知道内容不完整。
func truncateResult(s string) string {
	n := utf8.RuneCountInString(s)
	if n <= maxToolResult {
		return s
	}
	i := 0
	for j := range s {
		if i == maxToolResult {
			return s[:j] + fmt.Sprintf("\n\n[结果过长:共 %d 字,只保留了前 %d 字]", n, maxToolResult)
		}
		i++
	}
	return s
}

// lineLog 保留最近若干行文本(MCP 服务器的标准错误与连接记录),可当 io.Writer 用。
type lineLog struct {
	mu      sync.Mutex
	max     int
	lines   []string
	partial []byte
}

func newLineLog(max int) *lineLog { return &lineLog{max: max} }

func (l *lineLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.partial = append(l.partial, p...)
	for {
		i := bytes.IndexByte(l.partial, '\n')
		if i < 0 {
			break
		}
		l.push(strings.TrimRight(string(l.partial[:i]), "\r"))
		l.partial = l.partial[i+1:]
	}
	// 不换行的超长输出也按行记,免得缓冲无限增长
	if len(l.partial) > 4096 {
		l.push(string(l.partial))
		l.partial = nil
	}
	return len(p), nil
}

func (l *lineLog) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.push(line)
}

func (l *lineLog) push(line string) {
	l.lines = append(l.lines, line)
	if len(l.lines) > 2*l.max {
		l.lines = append([]string(nil), l.lines[len(l.lines)-l.max:]...)
	}
}

func (l *lineLog) snapshot() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	lines := l.lines
	if len(lines) > l.max {
		lines = lines[len(lines)-l.max:]
	}
	out := append([]string{}, lines...)
	if len(l.partial) > 0 {
		out = append(out, string(l.partial))
	}
	return out
}

// tail 返回最后 n 行,用于失败原因里附上标准错误。
func (l *lineLog) tail(n int) []string {
	s := l.snapshot()
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

// readFull 尽量读满 buf;读到文件尾不算错。
func readFull(r io.Reader, buf []byte) (int, error) {
	n, err := io.ReadFull(r, buf)
	if err == io.ErrUnexpectedEOF || err == io.EOF {
		return n, nil
	}
	return n, err
}
