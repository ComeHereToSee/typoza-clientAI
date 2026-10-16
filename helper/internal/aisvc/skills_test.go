package aisvc

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSkill(t *testing.T, root, dir, skillMD string, extra map[string]string) string {
	t.Helper()
	d := filepath.Join(root, dir)
	files := map[string]string{"SKILL.md": skillMD}
	for k, v := range extra {
		files[k] = v
	}
	for name, body := range files {
		p := filepath.Join(d, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return d
}

func listSkills(t *testing.T, env *testEnv) map[string]Skill {
	t.Helper()
	var res struct {
		Skills []Skill `json:"skills"`
	}
	env.callInto(t, "ai.skills.list", nil, &res)
	out := map[string]Skill{}
	for _, sk := range res.Skills {
		out[sk.Name] = sk
	}
	return out
}

const validSkill = "---\nname: pdf-tools\ndescription: 处理 PDF:提取文字、合并文件。用户提到 PDF 时使用。\nlicense: MIT\nmetadata:\n  author: 测试\n  version: \"1.0\"\n---\n# PDF 工具\n\n第一步:读 references/guide.md。\n"

func TestSkillsValidation(t *testing.T) {
	env := newTestService(t)
	root := filepath.Join(env.dir, "skills")
	writeSkill(t, root, "pdf-tools", validSkill, map[string]string{"references/guide.md": "指南"})
	writeSkill(t, root, "with-scripts", "---\nname: with-scripts\ndescription: 带脚本的技能\n---\n正文", map[string]string{"scripts/run.sh": "echo hi"})
	writeSkill(t, root, "Upper", "---\nname: Upper\ndescription: 大写\n---\n", nil)
	writeSkill(t, root, "mismatch", "---\nname: other-name\ndescription: 名字和目录不一致\n---\n", nil)
	writeSkill(t, root, "no-desc", "---\nname: no-desc\n---\n正文", nil)
	writeSkill(t, root, "no-head", "# 只有正文", nil)
	writeSkill(t, root, "double--dash", "---\nname: double--dash\ndescription: x\n---\n", nil)
	writeSkill(t, root, "-lead", "---\nname: -lead\ndescription: x\n---\n", nil)
	if err := os.MkdirAll(filepath.Join(root, "empty-dir"), 0o755); err != nil {
		t.Fatal(err)
	}

	skills := listSkills(t, env)
	if sk := skills["pdf-tools"]; sk.Error != "" || sk.HasScripts || sk.Source != "typoza" || !strings.HasPrefix(sk.Description, "处理 PDF") || sk.Path != filepath.Join(root, "pdf-tools") {
		t.Fatalf("合规技能解析不对:%+v", sk)
	}
	if sk := skills["with-scripts"]; sk.Error != "" || !sk.HasScripts {
		t.Fatalf("带 scripts/ 的技能应标出来:%+v", sk)
	}
	wantErr := map[string]string{
		"Upper":        "小写字母",
		"other-name":   "与目录名",
		"no-desc":      "description",
		"no-head":      "YAML 头",
		"double--dash": "连续的连字符",
		"-lead":        "开头或结尾",
		"empty-dir":    "SKILL.md",
	}
	for name, frag := range wantErr {
		sk, ok := skills[name]
		if !ok || !strings.Contains(sk.Error, frag) {
			t.Errorf("技能 %s 应报「%s」相关的错:%+v", name, frag, sk)
		}
	}
}

func TestFrontmatterYAMLSubset(t *testing.T) {
	src := "---\n# 注释\nname: 'quoted-name'\ndescription: >-\n  第一行\n  接着写\n\n  新段落\ncompatibility: \"需要: 网络\" # 行尾注释\nallowed-tools: [Read, \"Write\"]\nmetadata:\n  a: 1\n  b: \"x: y\"\nliteral: |\n  保留\n  换行\nplain: 第一行\n  续行\n---\n正文\n"
	meta, body, err := splitFrontmatter(src)
	if err != nil {
		t.Fatal(err)
	}
	if body != "正文\n" {
		t.Fatalf("正文不对:%q", body)
	}
	checks := map[string]string{
		"name":          "quoted-name",
		"description":   "第一行 接着写\n新段落",
		"compatibility": "需要: 网络",
		"literal":       "保留\n换行\n",
		"plain":         "第一行 续行",
	}
	for k, want := range checks {
		if got, _ := meta[k].(string); got != want {
			t.Errorf("%s 应为 %q,实际 %q", k, want, got)
		}
	}
	if tools, _ := meta["allowed-tools"].([]string); len(tools) != 2 || tools[1] != "Write" {
		t.Errorf("流式列表不对:%v", meta["allowed-tools"])
	}
	if m, _ := meta["metadata"].(map[string]string); m["a"] != "1" || m["b"] != "x: y" {
		t.Errorf("嵌套映射不对:%v", meta["metadata"])
	}
	if _, _, err := splitFrontmatter("---\nname: a\nname: b\n---\n"); err == nil {
		t.Error("重复的键应报错")
	}
	if _, _, err := splitFrontmatter("---\nname: a\n"); err == nil {
		t.Error("没有结束的 --- 应报错")
	}
}

func TestSkillInstallFromFolderAndZip(t *testing.T) {
	env := newTestService(t)
	src := writeSkill(t, t.TempDir(), "downloaded-copy", validSkill, map[string]string{"references/guide.md": "指南", "scripts/x.py": "print(1)"})
	var sk Skill
	env.callInto(t, "ai.skills.install", map[string]any{"path": src}, &sk)
	dest := filepath.Join(env.dir, "skills", "pdf-tools")
	if sk.Name != "pdf-tools" || sk.Error != "" || !sk.HasScripts || sk.Path != dest {
		t.Fatalf("从文件夹安装:%+v", sk)
	}
	if b, err := os.ReadFile(filepath.Join(dest, "references", "guide.md")); err != nil || string(b) != "指南" {
		t.Fatalf("资源文件应一起装进去:%q %v", b, err)
	}

	// ZIP:技能在唯一的一层子目录里;同名时替换旧的
	zipPath := filepath.Join(t.TempDir(), "skill.zip")
	writeZip(t, zipPath, map[string]string{
		"pdf-tools-main/SKILL.md":         strings.Replace(validSkill, "第一步", "新版第一步", 1),
		"pdf-tools-main/references/a.md":  "新资源",
		"__MACOSX/pdf-tools-main/._x":     "垃圾",
		"pdf-tools-main/sub/dir/deep.txt": "深",
	})
	env.callInto(t, "ai.skills.install", map[string]any{"path": zipPath}, &sk)
	if sk.Name != "pdf-tools" || sk.HasScripts {
		t.Fatalf("从 ZIP 安装后应是新版本:%+v", sk)
	}
	if b, _ := os.ReadFile(filepath.Join(dest, "SKILL.md")); !strings.Contains(string(b), "新版第一步") {
		t.Fatal("同名技能应被替换")
	}
	if _, err := os.Stat(filepath.Join(dest, "references", "guide.md")); !os.IsNotExist(err) {
		t.Fatal("替换后旧版本的文件不应残留")
	}
	if entries, _ := os.ReadDir(filepath.Join(env.dir, "skills")); len(entries) != 1 {
		t.Fatalf("技能目录里不应留下临时目录:%v", entries)
	}

	env.call(t, "ai.skills.remove", map[string]any{"name": "pdf-tools"})
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("删除后目录应不在了")
	}
	env.wantErr(t, codeNotFound, "ai.skills.remove", map[string]any{"name": "pdf-tools"})
	env.wantErr(t, codeInvalid, "ai.skills.remove", map[string]any{"name": "../x"})
}

func writeZip(t *testing.T, path string, files map[string]string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSkillInstallRejectsBadInput(t *testing.T) {
	env := newTestService(t)
	outside := t.TempDir()
	evil := filepath.Join(outside, "evil.zip")
	writeZip(t, evil, map[string]string{"SKILL.md": validSkill, "../escaped.txt": "越界"})
	env.wantErr(t, codeInvalid, "ai.skills.install", map[string]any{"path": evil})
	if _, err := os.Stat(filepath.Join(env.dir, "escaped.txt")); !os.IsNotExist(err) {
		t.Fatal("ZIP 里的 ../ 不应写到技能目录外")
	}

	bad := writeSkill(t, t.TempDir(), "bad", "---\nname: Bad_Name\ndescription: x\n---\n", nil)
	env.wantErr(t, codeInvalid, "ai.skills.install", map[string]any{"path": bad})
	env.wantErr(t, codeInvalid, "ai.skills.install", map[string]any{"path": "relative/path"})
	env.wantErr(t, codeNotFound, "ai.skills.install", map[string]any{"path": filepath.Join(outside, "missing")})
	noSkill := t.TempDir()
	env.wantErr(t, codeInvalid, "ai.skills.install", map[string]any{"path": noSkill})
	if len(listSkills(t, env)) != 0 {
		t.Fatal("不合规的技能不应装进去")
	}
}

func TestAgentsSkillsDirToggle(t *testing.T) {
	env := newTestService(t)
	writeSkill(t, filepath.Join(env.dir, "agents-skills"), "shared-skill", "---\nname: shared-skill\ndescription: 通用目录里的技能\n---\n正文", nil)
	if _, ok := listSkills(t, env)["shared-skill"]; ok {
		t.Fatal("开关关着时不读 ~/.agents/skills")
	}
	env.call(t, "ai.settings.update", map[string]any{"readAgentsSkills": true})
	if sk, ok := listSkills(t, env)["shared-skill"]; !ok || sk.Source != "agents" {
		t.Fatalf("打开开关后应列出,来源为 agents:%+v", sk)
	}
	env.wantErr(t, codeInvalid, "ai.skills.remove", map[string]any{"name": "shared-skill"})
}

// 技能在对话里:系统提示词只放名字与描述;模型调用 typoza__read_skill 读正文与资源,对话记下用到的技能。
func TestSkillProgressiveLoadingInChat(t *testing.T) {
	env := newTestService(t)
	root := filepath.Join(env.dir, "skills")
	writeSkill(t, root, "pdf-tools", validSkill, map[string]string{"references/guide.md": "指南内容"})
	writeSkill(t, root, "unused-skill", "---\nname: unused-skill\ndescription: 助手没选用\n---\n正文", nil)
	llm := newMockLLM(t, protoAnthropic,
		turn{calls: []mockCall{
			{id: "s1", name: toolReadSkill, args: `{"name":"pdf-tools"}`},
			{id: "s2", name: toolReadSkill, args: `{"name":"pdf-tools","path":"references/guide.md"}`},
			{id: "s3", name: toolReadSkill, args: `{"name":"pdf-tools","path":"../unused-skill/SKILL.md"}`},
			{id: "s4", name: toolReadSkill, args: `{"name":"unused-skill"}`},
		}},
		turn{text: []string{"按技能处理好了"}},
	)
	env.useProvider(t, protoAnthropic, llm.srv.URL, "k", map[string]any{
		"assistants": []map[string]any{{"id": defaultAssistantID, "name": "写作助手", "systemPrompt": "你是助手。", "skills": []string{"pdf-tools"}, "mcpServers": []string{}}},
	})
	r := env.send(t, map[string]any{"text": "帮我处理 PDF"})
	env.host.waitDone(t, r.AssistantMessageID)

	first := llm.chatPosts()[0].body
	if !strings.Contains(first, "pdf-tools") || !strings.Contains(first, "处理 PDF:提取文字") || strings.Contains(first, "第一步:读") {
		t.Fatalf("系统提示词应只有技能名与描述,不含正文:%s", first)
	}
	if strings.Contains(first, "unused-skill") {
		t.Fatal("助手没选用的技能不应出现")
	}
	c := env.conversation(t, r.ConversationID)
	if p := callPart(t, c, r.AssistantMessageID, "s1"); p.Status != callDone || !strings.Contains(deref(p.Result), "第一步:读 references/guide.md") || strings.Contains(deref(p.Result), "description:") {
		t.Fatalf("应读到 SKILL.md 正文(不含头部):%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "s2"); deref(p.Result) != "指南内容" {
		t.Fatalf("应读到资源文件:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "s3"); p.Status != callError {
		t.Fatalf("不能读到技能目录外:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "s4"); p.Status != callError || !strings.Contains(p.Error, "没有启用") {
		t.Fatalf("没启用的技能不能读:%+v", p)
	}
	skillParts := 0
	for _, p := range partsOf(c, r.AssistantMessageID) {
		if p.Type == partSkill {
			skillParts++
			if p.Name != "pdf-tools" {
				t.Fatalf("技能部件名字不对:%+v", p)
			}
		}
	}
	// 读成功的才记;同一个技能只记一次
	if skillParts != 1 {
		t.Fatalf("应记下一次用到的技能,实际 %d 次", skillParts)
	}

	// 全局关掉技能后,提示词里不再有
	env.call(t, "ai.settings.update", map[string]any{"skillsEnabled": false})
	r2 := env.send(t, map[string]any{"conversationId": r.ConversationID, "text": "再来"})
	env.host.waitDone(t, r2.AssistantMessageID)
	posts := llm.chatPosts()
	if last := posts[len(posts)-1].body; strings.Contains(last, "处理 PDF:提取文字") {
		t.Fatal("关掉技能后提示词里不应再有技能")
	}
}
