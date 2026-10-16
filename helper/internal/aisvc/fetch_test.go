package aisvc

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const samplePage = `<!doctype html><html><head><title> 示例 页面 </title><style>p{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/">首页</a></nav>
<article>
  <h1>大标题</h1>
  <p>第一段,有<strong>加粗</strong>和<em> 斜体 </em>,还有<a href="/doc?id=1">相对链接</a>。</p>
  <ul><li>甲</li><li>乙<ul><li>乙一</li></ul></li></ul>
  <ol><li>第一</li><li>第二</li></ol>
  <pre><code>func main() {
	fmt.Println("hi")
}</code></pre>
  <blockquote><p>引用的话</p></blockquote>
  <table><tr><th>名</th><th>值</th></tr><tr><td>a|b</td><td>1</td></tr></table>
  <img src="/pic.png" alt="图片">
</article>
<footer>页脚</footer></body></html>`

func TestHTMLToMarkdown(t *testing.T) {
	base, _ := url.Parse("https://example.com/blog/post")
	md, err := htmlToMarkdown(strings.NewReader(samplePage), base)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# 示例 页面",
		"# 大标题",
		"第一段,有**加粗**和 *斜体* ,还有[相对链接](https://example.com/doc?id=1)。",
		"- 甲\n- 乙\n\n  - 乙一",
		"1. 第一\n2. 第二",
		"```\nfunc main() {\n\tfmt.Println(\"hi\")\n}\n```",
		"> 引用的话",
		"| 名 | 值 |\n| --- | --- |\n| a\\|b | 1 |",
		"![图片](https://example.com/pic.png)",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("应包含 %q\n实际:\n%s", want, md)
		}
	}
	for _, bad := range []string{"alert", "color:red", "首页", "页脚", "\x00"} {
		if strings.Contains(md, bad) {
			t.Errorf("不应包含 %q:\n%s", bad, md)
		}
	}
}

func TestFetchURLToolInChat(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(samplePage))
		case "/data.json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"k":"值"}`))
		case "/bin":
			w.Header().Set("Content-Type", "application/octet-stream")
			_, _ = w.Write([]byte{0, 1, 2})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(page.Close)
	env := newTestService(t)
	llm := newMockLLM(t, protoOpenAIChat,
		turn{calls: []mockCall{
			{id: "f1", name: toolFetchURL, args: `{"url":"` + page.URL + `/page"}`},
			{id: "f2", name: toolFetchURL, args: `{"url":"` + page.URL + `/data.json"}`},
			{id: "f3", name: toolFetchURL, args: `{"url":"` + page.URL + `/bin"}`},
			{id: "f4", name: toolFetchURL, args: `{"url":"file:///etc/passwd"}`},
			{id: "f5", name: toolFetchURL, args: `{"url":"` + page.URL + `/missing"}`},
		}},
		turn{text: []string{"读完了"}},
	)
	// 网页读取默认关;打开后默认每次询问,这里设成总是允许
	env.useProvider(t, protoOpenAIChat, llm.srv.URL, "k", map[string]any{
		"connectors":   map[string]bool{"folder": true, "web": true},
		"toolPolicies": map[string]string{toolFetchURL: policyAllow},
	})
	r := env.send(t, map[string]any{"text": "读一下这些网址"})
	env.host.waitDone(t, r.AssistantMessageID)
	c := env.conversation(t, r.ConversationID)
	if p := callPart(t, c, r.AssistantMessageID, "f1"); p.Status != callDone || !strings.Contains(deref(p.Result), "# 大标题") {
		t.Fatalf("网页应转成 Markdown:%+v", p)
	}
	if p := callPart(t, c, r.AssistantMessageID, "f2"); deref(p.Result) != `{"k":"值"}` {
		t.Fatalf("JSON 应原样返回:%+v", p)
	}
	for id, frag := range map[string]string{"f3": "不支持", "f4": "http", "f5": "404"} {
		if p := callPart(t, c, r.AssistantMessageID, id); p.Status != callError || !strings.Contains(p.Error, frag) {
			t.Errorf("%s 应失败并提到 %q:%+v", id, frag, p)
		}
	}
}

func TestFetchURLDefaultsToAsk(t *testing.T) {
	env := newTestService(t)
	ts := env.s.buildTools(&Settings{Connectors: Connectors{Web: true}}, &Assistant{}, toolEnv{})
	if tl := ts.byName[toolFetchURL]; tl == nil || env.s.policyFor(tl) != policyAsk {
		t.Fatal("网页读取默认应每次询问")
	}
	if ts.byName[toolListDocuments] != nil {
		t.Fatal("文件夹连接器关着时不应有文件夹工具")
	}
}
