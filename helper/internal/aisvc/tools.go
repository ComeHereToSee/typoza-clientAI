package aisvc

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 内置工具全名。
const (
	toolListDocuments  = "typoza__list_documents"
	toolSearchDocument = "typoza__search_documents"
	toolReadDocument   = "typoza__read_document"
	toolEditDocument   = "typoza__edit_document"
	toolReadSkill      = "typoza__read_skill"
	toolFetchURL       = "typoza__fetch_url"
)

// builtinSource 是内置工具在 ToolInfo.source 里的显示名。
const builtinSource = "内置"

type toolImpl struct {
	info ToolInfo
	// defaultPolicy 是用户没设过权限时的取值
	defaultPolicy string
	docEdit       bool // 改当前文档:走 doc.edit,由网页执行
	skill         bool // 读取技能:记一个 skill 部件
	run           func(ctx context.Context, input json.RawMessage) (string, error)
}

type toolset struct {
	list   []*toolImpl
	byName map[string]*toolImpl
}

func (ts *toolset) add(t *toolImpl) {
	ts.list = append(ts.list, t)
	ts.byName[t.info.Name] = t
}

// toolEnv 是决定提供哪些内置工具的上下文。
type toolEnv struct {
	folder  string  // 「当前文件夹」连接器的根;空表示这轮对话没有带路径的文档
	hasDoc  bool    // 正在回答的消息带着当前文档(提供改文档工具)
	skills  []Skill // 启用的技能
	listing bool    // ai.tools.list:不看具体消息,列出开关允许的全部工具
}

func mustSchema(s string) map[string]any {
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		panic(fmt.Sprintf("aisvc: 内置工具参数结构写错了: %v", err))
	}
	return m
}

var (
	schemaListDocuments = mustSchema(`{"type":"object","properties":{"dir":{"type":"string","description":"子文件夹,相对当前文件夹;不填表示整个文件夹"}}}`)
	schemaSearch        = mustSchema(`{"type":"object","properties":{"query":{"type":"string","description":"要查找的文字(不区分大小写)"}},"required":["query"]}`)
	schemaReadDocument  = mustSchema(`{"type":"object","properties":{"path":{"type":"string","description":"文档路径,相对当前文件夹"}},"required":["path"]}`)
	// 位置语义与网页一致:from / to 是当前文档 Markdown 原文里的字符位置(换行为 \n、不含 BOM);给了 find 时以 find 为准
	schemaEditDocument = mustSchema(`{"type":"object","properties":{
		"kind":{"type":"string","enum":["replace_all","replace_range","insert"],"description":"replace_all:用 text 替换全文;replace_range:把 find 那段原文(或 from 到 to 的区间)替换为 text;insert:在 from 位置插入 text,from 与 find 都不给时追加到文末"},
		"text":{"type":"string","description":"新的内容(Markdown)"},
		"find":{"type":"string","description":"要替换的原文,须与文档 Markdown 原文完全一致;给了 find 时以它为准"},
		"from":{"type":"integer","description":"起始位置:文档 Markdown 原文里的字符序号,从 0 开始,换行算一个字符"},
		"to":{"type":"integer","description":"结束位置(不含),同 from"}},"required":["kind","text"]}`)
	schemaReadSkill = mustSchema(`{"type":"object","properties":{"name":{"type":"string","description":"技能名"},"path":{"type":"string","description":"技能目录里的相对路径;不填读取 SKILL.md 正文"}},"required":["name"]}`)
	schemaFetchURL  = mustSchema(`{"type":"object","properties":{"url":{"type":"string","description":"http 或 https 网址"}},"required":["url"]}`)
)

// buildTools 组出本次可用的工具:按连接器开关与上下文给内置工具,再加助手绑定的 MCP 服务器的工具。
// a 为 nil 时列出全部已连接服务器的工具(ai.tools.list 不带 assistantId)。
func (s *Service) buildTools(st *Settings, a *Assistant, env toolEnv) *toolset {
	ts := &toolset{byName: map[string]*toolImpl{}}
	if st.Connectors.Folder && (env.folder != "" || env.listing) {
		root := env.folder
		ts.add(&toolImpl{
			info:          ToolInfo{Name: toolListDocuments, Title: "列出文件夹里的文档", Description: "列出当前文档所在文件夹(含子文件夹)里的 Markdown 与文本文档。", Source: builtinSource, InputSchema: schemaListDocuments},
			defaultPolicy: policyAllow,
			run: func(_ context.Context, in json.RawMessage) (string, error) {
				var p struct {
					Dir string `json:"dir"`
				}
				if err := json.Unmarshal(in, &p); err != nil {
					return "", fmt.Errorf("参数不对:%v", err)
				}
				return listDocuments(root, p.Dir)
			},
		})
		ts.add(&toolImpl{
			info:          ToolInfo{Name: toolSearchDocument, Title: "在文件夹里搜索", Description: "在当前文档所在文件夹的文档里查找文字,返回出现的位置与所在行。", Source: builtinSource, InputSchema: schemaSearch},
			defaultPolicy: policyAllow,
			run: func(_ context.Context, in json.RawMessage) (string, error) {
				var p struct {
					Query string `json:"query"`
				}
				if err := json.Unmarshal(in, &p); err != nil {
					return "", fmt.Errorf("参数不对:%v", err)
				}
				return searchDocuments(root, p.Query)
			},
		})
		ts.add(&toolImpl{
			info:          ToolInfo{Name: toolReadDocument, Title: "读取文档", Description: "读取当前文档所在文件夹里的一篇文档的全文。", Source: builtinSource, InputSchema: schemaReadDocument},
			defaultPolicy: policyAllow,
			run: func(_ context.Context, in json.RawMessage) (string, error) {
				var p struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(in, &p); err != nil {
					return "", fmt.Errorf("参数不对:%v", err)
				}
				return readDocument(root, p.Path)
			},
		})
	}
	if env.hasDoc || env.listing {
		ts.add(&toolImpl{
			info:          ToolInfo{Name: toolEditDocument, Title: "修改当前文档", Description: "修改用户当前打开的文档。用户会先看到差异预览,确认后才写入。", Source: builtinSource, InputSchema: schemaEditDocument},
			defaultPolicy: policyAsk,
			docEdit:       true,
		})
	}
	if len(env.skills) > 0 || (env.listing && st.SkillsEnabled) {
		skills := env.skills
		ts.add(&toolImpl{
			info:          ToolInfo{Name: toolReadSkill, Title: "读取技能", Description: "读取一个技能的完整说明(SKILL.md 正文),或技能目录里的其他文件。", Source: builtinSource, InputSchema: schemaReadSkill},
			defaultPolicy: policyAllow,
			skill:         true,
			run: func(_ context.Context, in json.RawMessage) (string, error) {
				var p struct {
					Name string `json:"name"`
					Path string `json:"path"`
				}
				if err := json.Unmarshal(in, &p); err != nil {
					return "", fmt.Errorf("参数不对:%v", err)
				}
				return readSkill(skills, p.Name, p.Path)
			},
		})
	}
	if st.Connectors.Web {
		ts.add(&toolImpl{
			info: ToolInfo{Name: toolFetchURL, Title: "读取网页", Description: "下载一个网页并把正文转成 Markdown。", Source: builtinSource, InputSchema: schemaFetchURL},
			// 读网页会把模型给的网址发出去(可能夹带上下文里的内容),默认每次询问【假设】
			defaultPolicy: policyAsk,
			run: func(ctx context.Context, in json.RawMessage) (string, error) {
				var p struct {
					URL string `json:"url"`
				}
				if err := json.Unmarshal(in, &p); err != nil {
					return "", fmt.Errorf("参数不对:%v", err)
				}
				return s.fetchURL(ctx, p.URL)
			},
		})
	}
	var servers []string
	if a != nil {
		servers = a.MCPServers
	} else {
		for _, m := range st.MCPServers {
			if m.Enabled {
				servers = append(servers, m.ID)
			}
		}
	}
	for _, id := range servers {
		for _, t := range s.mcp.tools(id) {
			ts.add(t)
		}
	}
	return ts
}

// policyFor 读当前设置里的工具权限(「总是允许」可能刚在本轮改过,所以不用快照)。
func (s *Service) policyFor(t *toolImpl) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p, ok := s.settings.ToolPolicies[t.info.Name]; ok {
		return p
	}
	return t.defaultPolicy
}

type toolsListParams struct {
	AssistantID string `json:"assistantId"`
}

func (s *Service) toolsList(_ context.Context, p toolsListParams) (any, error) {
	sn := s.snap()
	var a *Assistant
	if p.AssistantID != "" {
		if a = sn.st.assistant(p.AssistantID); a == nil {
			return nil, errf(codeNotFound, "没有这个助手")
		}
	}
	ts := s.buildTools(&sn.st, a, toolEnv{listing: true})
	out := make([]ToolInfo, 0, len(ts.list))
	for _, t := range ts.list {
		out = append(out, t.info)
	}
	return map[string]any{"tools": out}, nil
}

// ---------- 「当前文件夹」连接器 ----------

// docExts 是当作文档的扩展名。
var docExts = map[string]bool{".md": true, ".markdown": true, ".mdown": true, ".mkd": true, ".txt": true}

const (
	maxListedDocs  = 500
	maxSearchHits  = 50
	maxSearchBytes = 2 << 20 // 单个文件超过这么大就不搜了
	maxReadBytes   = 4 << 20
)

// within 把相对路径解析到 root 里;解析后(含符号链接)跑出 root 的一律拒绝。
func within(root, p string) (string, error) {
	if root == "" {
		return "", fmt.Errorf("这轮对话没有带当前文档,不知道是哪个文件夹")
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(root, p)
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("文件夹 %s 不可用:%v", root, err)
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(p))
	if err != nil {
		return "", fmt.Errorf("找不到 %s", p)
	}
	rel, err := filepath.Rel(realRoot, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("只能访问当前文件夹里的文件")
	}
	return real, nil
}

// walkDocs 遍历 dir 下的文档(跳过隐藏目录、node_modules 与符号链接),fn 返回 false 时停止。
func walkDocs(dir string, fn func(path string, d fs.DirEntry) bool) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == dir {
				return err
			}
			return nil // 读不了的子目录跳过
		}
		if d.IsDir() {
			if path != dir && (strings.HasPrefix(d.Name(), ".") || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			return nil
		}
		// 符号链接可能指到文件夹外面,不跟
		if d.Type()&fs.ModeSymlink != 0 || !docExts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		if !fn(path, d) {
			return filepath.SkipAll
		}
		return nil
	})
}

func listDocuments(root, sub string) (string, error) {
	dir, err := within(root, sub)
	if err != nil {
		return "", err
	}
	realRoot, _ := filepath.EvalSymlinks(root)
	var lines []string
	total := 0
	err = walkDocs(dir, func(path string, d fs.DirEntry) bool {
		total++
		if len(lines) < maxListedDocs {
			rel, _ := filepath.Rel(realRoot, path)
			size := int64(0)
			if info, err := d.Info(); err == nil {
				size = info.Size()
			}
			lines = append(lines, fmt.Sprintf("%s (%s)", filepath.ToSlash(rel), humanSize(size)))
		}
		return true
	})
	if err != nil {
		return "", fmt.Errorf("列出文档失败:%v", err)
	}
	if total == 0 {
		return "文件夹里没有文档", nil
	}
	sort.Strings(lines)
	out := strings.Join(lines, "\n")
	if total > len(lines) {
		out += fmt.Sprintf("\n(还有 %d 篇没有列出)", total-len(lines))
	}
	return out, nil
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func searchDocuments(root, query string) (string, error) {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return "", fmt.Errorf("请给出要查找的文字")
	}
	dir, err := within(root, "")
	if err != nil {
		return "", err
	}
	var hits []string
	more := false
	err = walkDocs(dir, func(path string, d fs.DirEntry) bool {
		info, err := d.Info()
		if err != nil || info.Size() > maxSearchBytes {
			return true
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return true
		}
		rel, _ := filepath.Rel(dir, path)
		for i, line := range strings.Split(string(b), "\n") {
			if strings.Contains(strings.ToLower(line), q) {
				if len(hits) == maxSearchHits {
					more = true
					return false
				}
				hits = append(hits, fmt.Sprintf("%s:%d: %s", filepath.ToSlash(rel), i+1, truncateRunes(strings.TrimSpace(line), 200)))
			}
		}
		return true
	})
	if err != nil {
		return "", fmt.Errorf("搜索失败:%v", err)
	}
	if len(hits) == 0 {
		return fmt.Sprintf("没有找到「%s」", query), nil
	}
	out := strings.Join(hits, "\n")
	if more {
		out += fmt.Sprintf("\n(只列出前 %d 处)", maxSearchHits)
	}
	return out, nil
}

func readDocument(root, path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("请给出文档路径")
	}
	real, err := within(root, path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", fmt.Errorf("找不到 %s", path)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s 是文件夹,不是文档", path)
	}
	return readTextFile(real, maxReadBytes)
}
