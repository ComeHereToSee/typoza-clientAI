package aisvc

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Skills:符合 Agent Skills 开放规范(agentskills.io)的技能目录,SKILL.md = YAML 头 + Markdown 正文。
// 系统提示词里只放 name 与 description,模型需要时调用 typoza__read_skill 读正文(渐进加载);不执行 scripts/。

const (
	skillFile         = "SKILL.md"
	maxSkillFiles     = 20000     // 与 Cherry Studio 的 ZIP 上限一致
	maxSkillBytes     = 100 << 20 // 解压后总大小上限
	maxSkillFileBytes = 1 << 20   // read_skill 单个文件上限
)

// listSkills 扫描 Typoza 技能目录与(开关打开时)~/.agents/skills;同名时 Typoza 目录优先。
func (s *Service) listSkills(st *Settings) []Skill {
	out := scanSkillDir(s.opts.SkillsDir, "typoza")
	if st.ReadAgentsSkills && s.opts.AgentsSkillsDir != "" {
		seen := map[string]bool{}
		for _, sk := range out {
			seen[sk.Name] = true
		}
		for _, sk := range scanSkillDir(s.opts.AgentsSkillsDir, "agents") {
			if !seen[sk.Name] {
				out = append(out, sk)
			}
		}
	}
	return out
}

func scanSkillDir(dir, source string) []Skill {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return []Skill{}
	}
	out := []Skill{}
	for _, de := range ents {
		name := de.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		path := filepath.Join(dir, name)
		// 目录可能是符号链接(CC Switch 等工具用软链接同步技能)
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			continue
		}
		sk, _ := parseSkill(path, name, source)
		out = append(out, sk)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// parseSkill 读并校验一个技能目录;不合规时 Skill.error 写原因,同时返回 body 为空。
// wantName 是技能应有的名字(规范要求与目录名一致)。
func parseSkill(dir, wantName, source string) (Skill, string) {
	sk := Skill{Name: wantName, Path: dir, Source: source, HasScripts: hasScripts(dir)}
	b, err := os.ReadFile(filepath.Join(dir, skillFile)) // #nosec G304 -- 技能目录里固定文件名的 SKILL.md
	if err != nil {
		sk.Error = "缺少 SKILL.md"
		if !errors.Is(err, fs.ErrNotExist) {
			sk.Error = "读不了 SKILL.md:" + err.Error()
		}
		return sk, ""
	}
	meta, body, err := splitFrontmatter(string(b))
	if err != nil {
		sk.Error = err.Error()
		return sk, ""
	}
	name, _ := meta["name"].(string)
	desc, _ := meta["description"].(string)
	name, desc = strings.TrimSpace(name), strings.TrimSpace(desc)
	if name != "" {
		sk.Name = name
	}
	sk.Description = desc
	if err := validateSkill(meta, name, desc, wantName); err != nil {
		sk.Error = err.Error()
		return sk, ""
	}
	return sk, body
}

func hasScripts(dir string) bool {
	ents, err := os.ReadDir(filepath.Join(dir, "scripts"))
	return err == nil && len(ents) > 0
}

// validateSkill 按 agentskills 规范校验:name 1–64 字符、只用小写字母数字与连字符、不以连字符开头结尾、
// 不连续两个连字符、与目录名一致;description 1–1024 字符;compatibility 不超过 500 字符。
func validateSkill(meta map[string]any, name, desc, dirName string) error {
	if name == "" {
		return errors.New("SKILL.md 头部缺少 name")
	}
	if utf8.RuneCountInString(name) > 64 {
		return errors.New("name 超过 64 个字符")
	}
	for _, r := range name {
		if r == '-' {
			continue
		}
		if !(unicode.IsLetter(r) || unicode.IsDigit(r)) || unicode.IsUpper(r) {
			return fmt.Errorf("name「%s」只能用小写字母、数字和连字符", name)
		}
	}
	if strings.HasPrefix(name, "-") || strings.HasSuffix(name, "-") {
		return fmt.Errorf("name「%s」不能以连字符开头或结尾", name)
	}
	if strings.Contains(name, "--") {
		return fmt.Errorf("name「%s」不能有连续的连字符", name)
	}
	if name != dirName {
		return fmt.Errorf("name「%s」与目录名「%s」不一致", name, dirName)
	}
	if desc == "" {
		return errors.New("SKILL.md 头部缺少 description")
	}
	if utf8.RuneCountInString(desc) > 1024 {
		return errors.New("description 超过 1024 个字符")
	}
	if c, ok := meta["compatibility"].(string); ok && utf8.RuneCountInString(c) > 500 {
		return errors.New("compatibility 超过 500 个字符")
	}
	return nil
}

// splitFrontmatter 拆出 --- 包围的 YAML 头与正文。
func splitFrontmatter(src string) (map[string]any, string, error) {
	src = strings.TrimPrefix(src, "\ufeff")
	src = strings.ReplaceAll(src, "\r\n", "\n")
	if !strings.HasPrefix(src, "---\n") {
		return nil, "", errors.New("SKILL.md 开头缺少 YAML 头(--- 包围的 name 与 description)")
	}
	rest := src[4:]
	end := -1
	if strings.HasPrefix(rest, "---\n") || rest == "---" {
		end = 0
	} else if i := strings.Index(rest, "\n---\n"); i >= 0 {
		end = i + 1
	} else if strings.HasSuffix(rest, "\n---") {
		end = len(rest) - 3
	}
	if end < 0 {
		return nil, "", errors.New("SKILL.md 的 YAML 头没有结束的 ---")
	}
	head := rest[:end]
	body := strings.TrimPrefix(strings.TrimPrefix(rest[end:], "---"), "\n")
	meta, err := parseYAMLSubset(head)
	if err != nil {
		return nil, "", fmt.Errorf("SKILL.md 的 YAML 头格式不对:%v", err)
	}
	return meta, strings.TrimLeft(body, "\n"), nil
}

// parseYAMLSubset 解析 SKILL.md 头部常见的 YAML 子集:顶层 key: value(纯量、单双引号、| 与 > 块、
// [a, b] 列表)、一层缩进的映射(如 metadata)与 - 列表。值统一成 string、map[string]string 或 []string。
// 规范只用到这些写法;为此引入完整的 YAML 库不划算。
func parseYAMLSubset(src string) (map[string]any, error) {
	lines := strings.Split(src, "\n")
	out := map[string]any{}
	indentOf := func(l string) int { return len(l) - len(strings.TrimLeft(l, " \t")) }
	isBlank := func(l string) bool {
		t := strings.TrimSpace(l)
		return t == "" || strings.HasPrefix(t, "#")
	}
	for i := 0; i < len(lines); {
		line := lines[i]
		if isBlank(line) {
			i++
			continue
		}
		if indentOf(line) > 0 {
			return nil, fmt.Errorf("第 %d 行缩进不对", i+1)
		}
		key, rest, ok := strings.Cut(line, ":")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			return nil, fmt.Errorf("第 %d 行不是 key: value", i+1)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("「%s」重复出现", key)
		}
		rest = strings.TrimSpace(rest)
		i++
		// 收集后面缩进的行(属于这个 key)
		start := i
		for i < len(lines) && (strings.TrimSpace(lines[i]) == "" || indentOf(lines[i]) > 0) {
			i++
		}
		block := lines[start:i]
		switch {
		case rest == "":
			v, err := parseNested(block, start)
			if err != nil {
				return nil, err
			}
			out[key] = v
		case rest[0] == '|' || rest[0] == '>':
			out[key] = blockScalar(rest, block)
		case rest[0] == '"' || rest[0] == '\'':
			v, err := quotedScalar(rest, block)
			if err != nil {
				return nil, fmt.Errorf("「%s」:%v", key, err)
			}
			out[key] = v
		case rest[0] == '[':
			out[key] = flowList(rest)
		default:
			// 纯量,可以折行写在后面缩进的行里
			parts := []string{stripComment(rest)}
			for _, l := range block {
				if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
					parts = append(parts, t)
				}
			}
			out[key] = strings.Join(parts, " ")
		}
	}
	return out, nil
}

func stripComment(s string) string {
	if i := strings.Index(s, " #"); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// parseNested 解析缩进块:「- 项」列表或「key: value」映射。
func parseNested(block []string, firstLine int) (any, error) {
	var list []string
	m := map[string]string{}
	for j, l := range block {
		t := strings.TrimSpace(l)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if strings.HasPrefix(t, "- ") || t == "-" {
			list = append(list, unquote(strings.TrimSpace(strings.TrimPrefix(t, "-"))))
			continue
		}
		k, v, ok := strings.Cut(t, ":")
		if !ok {
			return nil, fmt.Errorf("第 %d 行不是 key: value", firstLine+j+1)
		}
		m[strings.TrimSpace(k)] = unquote(stripComment(strings.TrimSpace(v)))
	}
	if len(list) > 0 && len(m) > 0 {
		return nil, fmt.Errorf("第 %d 行起列表与映射混写", firstLine+1)
	}
	if len(list) > 0 {
		return list, nil
	}
	if len(m) > 0 {
		return m, nil
	}
	return "", nil
}

func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' && s[len(s)-1] == '"') {
		if u, err := strconv.Unquote(s); err == nil {
			return u
		}
		return s[1 : len(s)-1]
	}
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		return strings.ReplaceAll(s[1:len(s)-1], "''", "'")
	}
	return s
}

// blockScalar 处理 | 与 > 块:| 保留换行,> 把相邻行折成空格;- 去掉末尾换行,+ 保留,缺省保留一个。
func blockScalar(header string, block []string) string {
	literal := header[0] == '|'
	chomp := ""
	if strings.Contains(header, "-") {
		chomp = "-"
	} else if strings.Contains(header, "+") {
		chomp = "+"
	}
	indent := -1
	var lines []string
	for _, l := range block {
		if strings.TrimSpace(l) == "" {
			lines = append(lines, "")
			continue
		}
		n := len(l) - len(strings.TrimLeft(l, " \t"))
		if indent < 0 {
			indent = n // 以第一行非空内容的缩进为准
		}
		if n >= indent {
			lines = append(lines, l[indent:])
		} else {
			lines = append(lines, strings.TrimLeft(l, " \t"))
		}
	}
	// 去掉末尾空行,按 chomp 再补
	trailing := 0
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
		trailing++
	}
	var text string
	if literal {
		text = strings.Join(lines, "\n")
	} else {
		var b strings.Builder
		for i, l := range lines {
			switch {
			case i == 0:
			case l == "":
				b.WriteString("\n") // 折叠块里的空行是一个换行
				continue
			case lines[i-1] == "":
				// 前面的空行已经换过行
			default:
				b.WriteString(" ")
			}
			b.WriteString(l)
		}
		text = b.String()
	}
	switch chomp {
	case "-":
		return text
	case "+":
		return text + strings.Repeat("\n", trailing+1)
	default:
		return text + "\n"
	}
}

// quotedScalar 处理单双引号字符串,允许跨行(跨行处折成一个空格)。
func quotedScalar(first string, block []string) (string, error) {
	q := first[0]
	s := first
	for _, l := range block {
		if closedQuote(s, q) {
			break
		}
		s += " " + strings.TrimSpace(l)
	}
	if !closedQuote(s, q) {
		return "", errors.New("引号没有闭合")
	}
	end := closingIndex(s, q)
	body := s[:end+1]
	if q == '"' {
		u, err := strconv.Unquote(body)
		if err != nil {
			// YAML 的转义比 Go 宽松,解不了就去掉引号原样用
			return body[1 : len(body)-1], nil
		}
		return u, nil
	}
	return strings.ReplaceAll(body[1:len(body)-1], "''", "'"), nil
}

func closedQuote(s string, q byte) bool { return closingIndex(s, q) > 0 }

// closingIndex 找与开头引号配对的结束引号位置;没有返回 -1。
func closingIndex(s string, q byte) int {
	for i := 1; i < len(s); i++ {
		switch {
		case q == '"' && s[i] == '\\':
			i++
		case s[i] == q:
			if q == '\'' && i+1 < len(s) && s[i+1] == '\'' {
				i++
				continue
			}
			return i
		}
	}
	return -1
}

func flowList(s string) []string {
	s = strings.TrimSpace(stripComment(s))
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = unquote(strings.TrimSpace(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// enabledSkills 是这个助手这轮能用的技能:全局开关打开、助手选用了、没被停用、校验通过。
func (s *Service) enabledSkills(st *Settings, a *Assistant) []Skill {
	if !st.SkillsEnabled || len(a.Skills) == 0 {
		return nil
	}
	want := map[string]bool{}
	for _, n := range a.Skills {
		want[n] = true
	}
	for _, n := range st.DisabledSkills {
		delete(want, n)
	}
	var out []Skill
	for _, sk := range s.listSkills(st) {
		if sk.Error == "" && want[sk.Name] {
			out = append(out, sk)
		}
	}
	return out
}

// readSkill 是 typoza__read_skill:不给 path 读 SKILL.md 正文,给了读技能目录里的那个文件。
func readSkill(skills []Skill, name, path string) (string, error) {
	var sk *Skill
	for i := range skills {
		if skills[i].Name == name {
			sk = &skills[i]
		}
	}
	if sk == nil {
		return "", fmt.Errorf("没有启用名为「%s」的技能", name)
	}
	if path == "" || path == skillFile {
		_, body := parseSkill(sk.Path, sk.Name, sk.Source)
		if body == "" {
			return "", fmt.Errorf("技能「%s」的 SKILL.md 读不了或没有正文", name)
		}
		return body, nil
	}
	real, err := within(sk.Path, path)
	if err != nil {
		return "", err
	}
	return readTextFile(real, maxSkillFileBytes)
}

// ---------- RPC ----------

func (s *Service) skillsList(context.Context, struct{}) (any, error) {
	sn := s.snap()
	return map[string]any{"skills": s.listSkills(&sn.st)}, nil
}

type skillPathParams struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// skillsInstall 从文件夹或 .zip 安装到技能目录;已有同名技能时替换。名字以 SKILL.md 里的 name 为准。
func (s *Service) skillsInstall(_ context.Context, p skillPathParams) (any, error) {
	if p.Path == "" || !filepath.IsAbs(p.Path) {
		return nil, errf(codeInvalid, "请给出技能文件夹或 .zip 的绝对路径")
	}
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, errf(codeNotFound, "找不到 %s", p.Path)
	}
	if err := os.MkdirAll(s.opts.SkillsDir, 0o755); err != nil { // #nosec G301 -- 用户的技能文件夹,与 Finder 新建的权限一致
		return nil, errf(codeInternal, "创建技能目录失败:%v", err)
	}
	// 先在技能目录里的临时目录备好,确认合规后再改名换上,中途失败不留半个技能
	staging, err := os.MkdirTemp(s.opts.SkillsDir, ".install-")
	if err != nil {
		return nil, errf(codeInternal, "创建临时目录失败:%v", err)
	}
	defer os.RemoveAll(staging)
	unpacked := filepath.Join(staging, "src")
	switch {
	case info.IsDir():
		if err := copyTree(p.Path, unpacked); err != nil {
			return nil, err
		}
	case strings.EqualFold(filepath.Ext(p.Path), ".zip"):
		if err := unzip(p.Path, unpacked); err != nil {
			return nil, err
		}
	default:
		return nil, errf(codeInvalid, "只能安装文件夹或 .zip")
	}
	root, err := findSkillRoot(unpacked)
	if err != nil {
		return nil, err
	}
	meta, _, err := splitFrontmatter(readFileString(filepath.Join(root, skillFile)))
	if err != nil {
		return nil, errf(codeInvalid, "%v", err)
	}
	name, _ := meta["name"].(string)
	name = strings.TrimSpace(name)
	desc, _ := meta["description"].(string)
	// 装进去的目录以 name 命名,所以和来源目录名不一致也没关系
	if err := validateSkill(meta, name, strings.TrimSpace(desc), name); err != nil {
		return nil, errf(codeInvalid, "技能不合规:%v", err)
	}
	dest := filepath.Join(s.opts.SkillsDir, name)
	old := filepath.Join(staging, "old")
	if _, err := os.Lstat(dest); err == nil {
		if err := os.Rename(dest, old); err != nil {
			return nil, errf(codeInternal, "替换已有技能失败:%v", err)
		}
	}
	if err := os.Rename(root, dest); err != nil {
		if _, statErr := os.Lstat(old); statErr == nil {
			_ = os.Rename(old, dest)
		}
		return nil, errf(codeInternal, "安装技能失败:%v", err)
	}
	sk, _ := parseSkill(dest, name, "typoza")
	return sk, nil
}

func readFileString(path string) string {
	b, err := os.ReadFile(path) // #nosec G304 -- 技能文件夹里的说明文件
	if err != nil {
		return ""
	}
	return string(b)
}

// findSkillRoot 找 SKILL.md 所在目录:就在根上,或在唯一的一层子目录里(ZIP 常见)。
func findSkillRoot(dir string) (string, error) {
	if _, err := os.Stat(filepath.Join(dir, skillFile)); err == nil {
		return dir, nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return "", errf(codeInternal, "读取技能失败:%v", err)
	}
	var dirs []string
	for _, de := range ents {
		if de.IsDir() && !strings.HasPrefix(de.Name(), ".") && de.Name() != "__MACOSX" {
			dirs = append(dirs, filepath.Join(dir, de.Name()))
		}
	}
	if len(dirs) == 1 {
		if _, err := os.Stat(filepath.Join(dirs[0], skillFile)); err == nil {
			return dirs[0], nil
		}
	}
	return "", errf(codeInvalid, "没有找到 SKILL.md")
}

// copyTree 复制目录;跳过符号链接(可能指到别处),文件数与大小设上限。
func copyTree(src, dst string) error {
	files, total := 0, int64(0)
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return errf(codeInternal, "读取 %s 失败:%v", path, err)
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if d.IsDir() {
			if path != src && d.Name() == ".git" {
				return filepath.SkipDir
			}
			return os.MkdirAll(target, 0o755) // #nosec G301 -- 安装技能时复制出的普通文件夹
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return errf(codeInternal, "读取 %s 失败:%v", path, err)
		}
		files++
		total += info.Size()
		if files > maxSkillFiles || total > maxSkillBytes {
			return errf(codeInvalid, "技能太大(最多 %d 个文件、%d MB)", maxSkillFiles, maxSkillBytes>>20)
		}
		return copyFile(path, target, info.Mode().Perm())
	})
}

func copyFile(src, dst string, perm fs.FileMode) error {
	in, err := os.Open(src) // #nosec G304 -- 安装技能:读用户选中的技能文件夹里的文件
	if err != nil {
		return errf(codeInternal, "读取 %s 失败:%v", src, err)
	}
	defer in.Close()
	return writeStream(in, dst, perm, -1)
}

// writeStream 把 r 写到 dst;limit ≥ 0 时最多写这么多字节,超了算错。
func writeStream(r io.Reader, dst string, perm fs.FileMode, limit int64) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil { // #nosec G301 -- 技能文件夹里的普通子文件夹
		return errf(codeInternal, "创建目录失败:%v", err)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm|0o600) // #nosec G304 G302 -- 写进技能文件夹,沿用源文件权限(至少本人可读写)
	if err != nil {
		return errf(codeInternal, "写 %s 失败:%v", dst, err)
	}
	if limit >= 0 {
		r = io.LimitReader(r, limit+1)
	}
	n, err := io.Copy(out, r)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return errf(codeInternal, "写 %s 失败:%v", dst, err)
	}
	if limit >= 0 && n > limit {
		return errf(codeInvalid, "技能太大(最多 %d MB)", maxSkillBytes>>20)
	}
	return nil
}

// unzip 解压;拒绝 ../ 与绝对路径(zip slip),跳过符号链接,文件数与大小设上限。
func unzip(zipPath, dst string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return errf(codeInvalid, "打不开 ZIP:%v", err)
	}
	defer zr.Close()
	if len(zr.File) > maxSkillFiles {
		return errf(codeInvalid, "ZIP 里文件太多(最多 %d 个)", maxSkillFiles)
	}
	remaining := int64(maxSkillBytes)
	for _, f := range zr.File {
		name := filepath.FromSlash(f.Name)
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(filepath.Clean(name), ".."+string(filepath.Separator)) {
			return errf(codeInvalid, "ZIP 里有不安全的路径:%s", f.Name)
		}
		target := filepath.Join(dst, name) // #nosec G305 -- 上面已拒绝绝对路径与 .. 开头的路径
		mode := f.Mode()
		switch {
		case mode.IsDir():
			if err := os.MkdirAll(target, 0o755); err != nil { // #nosec G301 -- 解压出的技能子文件夹
				return errf(codeInternal, "解压失败:%v", err)
			}
			continue
		case mode&fs.ModeSymlink != 0 || !mode.IsRegular():
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return errf(codeInvalid, "解压 %s 失败:%v", f.Name, err)
		}
		err = writeStream(rc, target, mode.Perm(), remaining)
		rc.Close()
		if err != nil {
			return err
		}
		if st, err := os.Stat(target); err == nil {
			remaining -= st.Size()
		}
	}
	return nil
}

// skillsRemove 删除 Typoza 技能目录里的技能;~/.agents/skills 里的不归 Typoza 管,不删。
func (s *Service) skillsRemove(_ context.Context, p skillPathParams) (any, error) {
	name := strings.TrimSpace(p.Name)
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return nil, errf(codeInvalid, "技能名不对")
	}
	dir := filepath.Join(s.opts.SkillsDir, name)
	if _, err := os.Lstat(dir); err != nil {
		if s.opts.AgentsSkillsDir != "" {
			if _, err := os.Stat(filepath.Join(s.opts.AgentsSkillsDir, name)); err == nil {
				return nil, errf(codeInvalid, "「%s」在 ~/.agents/skills 里,Typoza 不删除那里的技能", name)
			}
		}
		return nil, errf(codeNotFound, "没有这个技能")
	}
	if err := os.RemoveAll(dir); err != nil {
		return nil, errf(codeInternal, "删除技能失败:%v", err)
	}
	return map[string]any{}, nil
}
