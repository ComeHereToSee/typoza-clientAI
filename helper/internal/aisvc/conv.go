package aisvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// convStore 管理对话文件:一个对话一个 JSON 文件(conversations/<id>.json),原子写。
// 读过的对话留在内存里,同一对话的修改由 convEntry.mu 串行化。
type convStore struct {
	dir string
	log *slog.Logger

	mu      sync.Mutex
	entries map[string]*convEntry
}

type convEntry struct {
	mu      sync.Mutex
	conv    *Conversation
	deleted bool // 已删除:后台任务晚到的写盘一律跳过,免得把文件写回来
}

func newConvStore(dir string, log *slog.Logger) *convStore {
	return &convStore{dir: dir, log: log, entries: map[string]*convEntry{}}
}

func (cs *convStore) path(id string) string { return filepath.Join(cs.dir, id+".json") }

func (cs *convStore) get(id string) (*convEntry, error) {
	if !validID(id) {
		return nil, errf(codeNotFound, "没有这个对话")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if e := cs.entries[id]; e != nil {
		return e, nil
	}
	b, err := os.ReadFile(cs.path(id)) // #nosec G304 -- AI 数据目录里的对话文件,id 已用 validID 校验
	if errors.Is(err, fs.ErrNotExist) {
		return nil, errf(codeNotFound, "没有这个对话")
	}
	if err != nil {
		return nil, errf(codeInternal, "读取对话失败:%v", err)
	}
	var c Conversation
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, errf(codeInternal, "对话文件 %s 已损坏:%v", cs.path(id), err)
	}
	if c.Messages == nil {
		c.Messages = map[string]*Message{}
	}
	// 上次辅助进程退出时还在生成的回答:不会再有后续了,标为出错,让用户可以重新生成
	for _, m := range c.Messages {
		if m.Status == statusStreaming || m.Status == statusWaiting {
			m.Status = statusError
			m.Error = &ErrorInfo{Code: codeCancelled, Message: "生成被中断(AI 组件已退出)"}
			for i := range m.Parts {
				if m.Parts[i].Type == partToolCall && (m.Parts[i].Status == callPending || m.Parts[i].Status == callRunning) {
					m.Parts[i].Status = callError
					m.Parts[i].Error = "已中断"
				}
			}
		}
	}
	e := &convEntry{conv: &c}
	cs.entries[id] = e
	return e, nil
}

// add 登记一个新建并已写盘的对话。
func (cs *convStore) add(e *convEntry) {
	cs.mu.Lock()
	cs.entries[e.conv.ID] = e
	cs.mu.Unlock()
}

// save 写盘;调用方持有 e.mu。
func (cs *convStore) save(e *convEntry) error {
	if e.deleted {
		return nil
	}
	if err := writeJSONAtomic(cs.path(e.conv.ID), e.conv); err != nil {
		return errf(codeInternal, "保存对话失败:%v", err)
	}
	return nil
}

// saveLogged 用在后台任务里:写盘失败只能记日志(用户在界面上仍能看到内存里的内容)。
func (cs *convStore) saveLogged(e *convEntry) {
	if err := cs.save(e); err != nil {
		cs.log.Error("保存对话失败", "id", e.conv.ID, "err", err)
	}
}

func (cs *convStore) remove(id string) error {
	cs.mu.Lock()
	e := cs.entries[id]
	delete(cs.entries, id)
	cs.mu.Unlock()
	if e != nil {
		e.mu.Lock()
		e.deleted = true
		e.mu.Unlock()
	}
	err := os.Remove(cs.path(id))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return errf(codeInternal, "删除对话失败:%v", err)
	}
	return nil
}

// ids 列出磁盘上与内存里的全部对话 ID。
func (cs *convStore) ids() ([]string, error) {
	seen := map[string]bool{}
	ents, err := os.ReadDir(cs.dir)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, errf(codeInternal, "读取对话目录失败:%v", err)
	}
	for _, de := range ents {
		name := de.Name()
		if de.IsDir() || !strings.HasSuffix(name, ".json") || strings.HasPrefix(name, ".") {
			continue
		}
		if id := strings.TrimSuffix(name, ".json"); validID(id) {
			seen[id] = true
		}
	}
	cs.mu.Lock()
	for id := range cs.entries {
		seen[id] = true
	}
	cs.mu.Unlock()
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out, nil
}

// ---------- 树操作(调用方持有 e.mu) ----------

func strPtr(s string) *string { return &s }

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// pathTo 返回从根到 id 的消息链(含 id 本身)。
func pathTo(c *Conversation, id string) []*Message {
	var rev []*Message
	seen := map[string]bool{}
	for cur := id; cur != "" && !seen[cur]; {
		seen[cur] = true
		m := c.Messages[cur]
		if m == nil {
			break
		}
		rev = append(rev, m)
		cur = deref(m.ParentID)
	}
	out := make([]*Message, len(rev))
	for i, m := range rev {
		out[len(rev)-1-i] = m
	}
	return out
}

// deepestLeaf 从 id 沿最新创建的子消息一路走到底:切换到某个版本时,后续对话跟着这个版本走(PRD 3.3)。
func deepestLeaf(c *Conversation, id string) string {
	children := map[string][]*Message{}
	for _, m := range c.Messages {
		if m.ParentID != nil {
			children[*m.ParentID] = append(children[*m.ParentID], m)
		}
	}
	seen := map[string]bool{}
	for !seen[id] {
		seen[id] = true
		kids := children[id]
		if len(kids) == 0 {
			break
		}
		sort.Slice(kids, func(i, j int) bool {
			if kids[i].CreatedAt != kids[j].CreatedAt {
				return kids[i].CreatedAt < kids[j].CreatedAt
			}
			return kids[i].ID < kids[j].ID
		})
		id = kids[len(kids)-1].ID
	}
	return id
}

// copyMessages 深拷贝一段消息链,供锁外使用。
func copyMessages(ms []*Message) []Message {
	out := make([]Message, len(ms))
	for i, m := range ms {
		cp := *m
		cp.Parts = append([]Part(nil), m.Parts...)
		cp.Context = append([]ContextItem(nil), m.Context...)
		out[i] = cp
	}
	return out
}

func summaryOf(c *Conversation) ConversationSummary {
	return ConversationSummary{ID: c.ID, Title: c.Title, UpdatedAt: c.UpdatedAt}
}

func (s *Service) emitConvUpdated(sum ConversationSummary) {
	s.emit(map[string]any{"type": "conversation.updated", "summary": sum})
}

// ---------- RPC ----------

func (s *Service) convList(context.Context, struct{}) (any, error) {
	ids, err := s.convs.ids()
	if err != nil {
		return nil, err
	}
	items := []ConversationSummary{}
	for _, id := range ids {
		e, err := s.convs.get(id)
		if err != nil {
			// 一个坏文件不该让整个列表打不开
			s.log.Warn("跳过读不了的对话", "id", id, "err", err)
			continue
		}
		e.mu.Lock()
		items = append(items, summaryOf(e.conv))
		e.mu.Unlock()
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].UpdatedAt != items[j].UpdatedAt {
			return items[i].UpdatedAt > items[j].UpdatedAt
		}
		return items[i].ID < items[j].ID
	})
	return map[string]any{"items": items}, nil
}

type idParams struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// convJSON 在锁内编码,返回原样 JSON:生成中的对话随时在变,不能把指针交出去在锁外编码。
func convJSON(e *convEntry) (json.RawMessage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	b, err := json.Marshal(e.conv)
	if err != nil {
		return nil, errf(codeInternal, "编码对话失败:%v", err)
	}
	return b, nil
}

func (s *Service) convGet(_ context.Context, p idParams) (any, error) {
	e, err := s.convs.get(p.ID)
	if err != nil {
		return nil, err
	}
	return convJSON(e)
}

func (s *Service) convRename(_ context.Context, p idParams) (any, error) {
	title := strings.TrimSpace(p.Title)
	if title == "" {
		return nil, errf(codeInvalid, "标题不能为空")
	}
	e, err := s.convs.get(p.ID)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	e.conv.Title = title
	e.conv.UpdatedAt = nowMs()
	err = s.convs.save(e)
	sum := summaryOf(e.conv)
	e.mu.Unlock()
	if err != nil {
		return nil, err
	}
	s.emitConvUpdated(sum)
	return map[string]any{}, nil
}

func (s *Service) convDelete(_ context.Context, p idParams) (any, error) {
	if _, err := s.convs.get(p.ID); err != nil {
		return nil, err
	}
	s.stopConversation(p.ID)
	if err := s.convs.remove(p.ID); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

func (s *Service) convClear(context.Context, struct{}) (any, error) {
	ids, err := s.convs.ids()
	if err != nil {
		return nil, err
	}
	var failed []string
	for _, id := range ids {
		s.stopConversation(id)
		if err := s.convs.remove(id); err != nil {
			failed = append(failed, id)
		}
	}
	if len(failed) > 0 {
		return nil, errf(codeInternal, "有 %d 个对话没能删除", len(failed))
	}
	return map[string]any{}, nil
}

// stopConversation 停掉某个对话里正在生成的回答,最多等 3 秒让它们收尾。
func (s *Service) stopConversation(convID string) {
	prefix := convID + "/"
	s.mu.Lock()
	var gens []*generation
	for key, g := range s.gens {
		if strings.HasPrefix(key, prefix) {
			gens = append(gens, g)
		}
	}
	s.mu.Unlock()
	for _, g := range gens {
		g.cancel()
	}
	deadline := time.After(3 * time.Second)
	for _, g := range gens {
		select {
		case <-g.done:
		case <-deadline:
			s.log.Warn("等待生成结束超时", "conversation", convID)
			return
		}
	}
}

// renderConversation 把某个对话当前分支转成文字(@ 引用之前的对话时用)。
func (s *Service) renderConversation(id string) (string, error) {
	e, err := s.convs.get(id)
	if err != nil {
		return "", err
	}
	e.mu.Lock()
	path := copyMessages(pathTo(e.conv, deref(e.conv.LeafID)))
	title := e.conv.Title
	e.mu.Unlock()
	var b strings.Builder
	fmt.Fprintf(&b, "对话「%s」:\n\n", title)
	for _, m := range path {
		who := "用户"
		if m.Role == "assistant" {
			who = "助手"
		}
		var text strings.Builder
		for _, p := range m.Parts {
			if p.Type == partText {
				text.WriteString(p.Text)
			}
		}
		if text.Len() == 0 {
			continue
		}
		fmt.Fprintf(&b, "%s:%s\n\n", who, text.String())
	}
	return strings.TrimSpace(b.String()), nil
}
