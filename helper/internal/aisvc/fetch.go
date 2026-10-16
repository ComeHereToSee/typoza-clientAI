package aisvc

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// 「网页读取」连接器:下载网页,把正文转成 Markdown 交给模型。

const (
	fetchTimeout  = 20 * time.Second
	maxFetchBytes = 5 << 20
)

func (s *Service) fetchURL(ctx context.Context, raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("只支持 http / https 网址")
	}
	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", fmt.Errorf("网址不对:%v", err)
	}
	req.Header.Set("User-Agent", "Typoza/"+s.opts.Version)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.9,*/*;q=0.5")
	resp, err := s.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("下载失败:%v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("网页返回 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes))
	if err != nil {
		return "", fmt.Errorf("下载失败:%v", err)
	}
	if len(body) == 0 {
		return "(网页没有内容)", nil
	}
	ct := resp.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ct)
	isHTML := mediaType == "text/html" || mediaType == "application/xhtml+xml" ||
		(mediaType == "" && bytes.Contains(bytes.ToLower(body[:min(len(body), 1024)]), []byte("<html")))
	switch {
	case isHTML:
		// 按 Content-Type 与 <meta charset> 转成 UTF-8(国内不少网页还是 GBK)
		r, err := charset.NewReader(bytes.NewReader(body), ct)
		if err != nil {
			return "", fmt.Errorf("网页编码识别不了:%v", err)
		}
		return htmlToMarkdown(r, resp.Request.URL)
	case strings.HasPrefix(mediaType, "text/") || mediaType == "application/json" || strings.HasSuffix(mediaType, "+json") ||
		mediaType == "application/xml" || strings.HasSuffix(mediaType, "+xml"):
		r, err := charset.NewReader(bytes.NewReader(body), ct)
		if err != nil {
			return "", fmt.Errorf("编码识别不了:%v", err)
		}
		b, err := io.ReadAll(r)
		if err != nil {
			return "", fmt.Errorf("读取失败:%v", err)
		}
		return strings.ToValidUTF8(string(b), ""), nil
	default:
		return "", fmt.Errorf("不支持读取这种内容(%s)", mediaType)
	}
}

// ---------- HTML → Markdown ----------

// htmlToMarkdown 把网页正文转成 Markdown:优先取 <article>、<main>,丢掉脚本、导航、页脚等。
// 只求让模型读得懂,不追求逐字还原。
func htmlToMarkdown(r io.Reader, base *url.URL) (string, error) {
	doc, err := html.Parse(r)
	if err != nil {
		return "", fmt.Errorf("网页解析失败:%v", err)
	}
	c := &mdConv{base: base}
	out := strings.ReplaceAll(tidyMarkdown(c.render(pickContent(doc))), indentMark, " ")
	if title := strings.TrimSpace(collapseSpace(textContent(findElement(doc, "title")))); title != "" {
		out = "# " + title + "\n\n" + out
	}
	return strings.TrimSpace(out), nil
}

func findElement(n *html.Node, tag string) *html.Node {
	if n == nil {
		return nil
	}
	if n.Type == html.ElementNode && n.Data == tag {
		return n
	}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if f := findElement(ch, tag); f != nil {
			return f
		}
	}
	return nil
}

func pickContent(doc *html.Node) *html.Node {
	for _, tag := range []string{"article", "main", "body"} {
		if n := findElement(doc, tag); n != nil && len(strings.TrimSpace(textContent(n))) > 0 {
			return n
		}
	}
	return doc
}

func textContent(n *html.Node) string {
	if n == nil {
		return ""
	}
	if n.Type == html.TextNode {
		return n.Data
	}
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		b.WriteString(textContent(ch))
	}
	return b.String()
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

// collapseSpace 把连续空白合成一个空格(HTML 的空白规则)。
func collapseSpace(s string) string {
	var b strings.Builder
	space := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

var skipTags = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true, "svg": true, "iframe": true, "form": true,
	"button": true, "nav": true, "footer": true, "aside": true, "head": true, "select": true, "input": true, "canvas": true,
}

var blockTags = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "main": true, "header": true, "figure": true,
	"figcaption": true, "dl": true, "dt": true, "dd": true, "address": true, "details": true, "summary": true,
	"body": true, "html": true,
}

type mdConv struct{ base *url.URL }

// indentMark 标记列表续行的缩进:中间各层整理空白时不会被当成 HTML 空白去掉,最后才换成空格。
const indentMark = "\x00"

func (c *mdConv) resolve(href string) string {
	u, err := url.Parse(strings.TrimSpace(href))
	if err != nil || c.base == nil {
		return href
	}
	return c.base.ResolveReference(u).String()
}

func (c *mdConv) children(n *html.Node) string {
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		b.WriteString(c.render(ch))
	}
	return b.String()
}

func (c *mdConv) render(n *html.Node) string {
	switch n.Type {
	case html.TextNode:
		return collapseSpace(n.Data)
	case html.DocumentNode:
		return c.children(n)
	case html.ElementNode:
	default:
		return ""
	}
	tag := n.Data
	if skipTags[tag] {
		return ""
	}
	switch tag {
	case "h1", "h2", "h3", "h4", "h5", "h6":
		t := strings.TrimSpace(oneLine(c.children(n)))
		if t == "" {
			return ""
		}
		return "\n\n" + strings.Repeat("#", int(tag[1]-'0')) + " " + t + "\n\n"
	case "br":
		return "\n"
	case "hr":
		return "\n\n---\n\n"
	case "pre":
		return "\n\n```\n" + strings.TrimRight(textContent(n), "\n") + "\n```\n\n"
	case "code":
		t := textContent(n)
		if strings.TrimSpace(t) == "" {
			return ""
		}
		return "`" + oneLine(t) + "`"
	case "strong", "b":
		return wrapInline(c.children(n), "**")
	case "em", "i":
		return wrapInline(c.children(n), "*")
	case "del", "s":
		return wrapInline(c.children(n), "~~")
	case "a":
		text := strings.TrimSpace(oneLine(c.children(n)))
		href := strings.TrimSpace(attr(n, "href"))
		if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(strings.ToLower(href), "javascript:") {
			return text
		}
		abs := c.resolve(href)
		if text == "" {
			text = abs
		}
		return "[" + text + "](" + abs + ")"
	case "img":
		src := strings.TrimSpace(attr(n, "src"))
		if src == "" || strings.HasPrefix(src, "data:") {
			return ""
		}
		return "![" + oneLine(attr(n, "alt")) + "](" + c.resolve(src) + ")"
	case "ul", "ol":
		return "\n\n" + c.list(n, tag == "ol") + "\n\n"
	case "blockquote":
		inner := strings.TrimSpace(tidyMarkdown(c.children(n)))
		if inner == "" {
			return ""
		}
		lines := strings.Split(inner, "\n")
		for i, l := range lines {
			lines[i] = strings.TrimRight("> "+l, " ")
		}
		return "\n\n" + strings.Join(lines, "\n") + "\n\n"
	case "table":
		return "\n\n" + c.table(n) + "\n\n"
	}
	inner := c.children(n)
	if blockTags[tag] || tag == "li" {
		return "\n\n" + inner + "\n\n"
	}
	return inner
}

// wrapInline 给行内文字加强调标记,空白留在标记外面(**foo** 而不是 ** foo **)。
func wrapInline(s, mark string) string {
	t := strings.TrimSpace(s)
	if t == "" {
		return s
	}
	lead := s[:len(s)-len(strings.TrimLeft(s, " "))]
	trail := s[len(strings.TrimRight(s, " ")):]
	return lead + mark + t + mark + trail
}

func oneLine(s string) string { return strings.TrimSpace(collapseSpace(s)) }

func (c *mdConv) list(n *html.Node, ordered bool) string {
	var items []string
	i := 1
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type != html.ElementNode || ch.Data != "li" {
			continue
		}
		body := strings.TrimSpace(tidyMarkdown(c.children(ch)))
		marker := "- "
		if ordered {
			marker = fmt.Sprintf("%d. ", i)
			i++
		}
		lines := strings.Split(body, "\n")
		for j := 1; j < len(lines); j++ {
			if lines[j] != "" {
				lines[j] = strings.Repeat(indentMark, len(marker)) + lines[j]
			}
		}
		items = append(items, marker+strings.Join(lines, "\n"))
	}
	return strings.Join(items, "\n")
}

func (c *mdConv) table(n *html.Node) string {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		for ch := x.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type != html.ElementNode {
				continue
			}
			switch ch.Data {
			case "thead", "tbody", "tfoot":
				walk(ch)
			case "tr":
				var cells []string
				for td := ch.FirstChild; td != nil; td = td.NextSibling {
					if td.Type == html.ElementNode && (td.Data == "td" || td.Data == "th") {
						cells = append(cells, strings.ReplaceAll(oneLine(tidyMarkdown(c.children(td))), "|", "\\|"))
					}
				}
				if len(cells) > 0 {
					rows = append(rows, cells)
				}
			}
		}
	}
	walk(n)
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, r := range rows {
		cols = max(cols, len(r))
	}
	var b strings.Builder
	for i, r := range rows {
		for len(r) < cols {
			r = append(r, "")
		}
		b.WriteString("| " + strings.Join(r, " | ") + " |\n")
		if i == 0 {
			b.WriteString("|" + strings.Repeat(" --- |", cols) + "\n")
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// tidyMarkdown 去掉行首尾多余空格、把三个以上的换行压成两个;代码块里的内容原样保留。
func tidyMarkdown(s string) string {
	lines := strings.Split(s, "\n")
	var out []string
	inCode := false
	blank := 0
	for _, l := range lines {
		if t := strings.TrimLeft(l, " \t"+indentMark); strings.HasPrefix(t, "```") {
			inCode = !inCode
			blank = 0
			out = append(out, strings.TrimRight(strings.TrimLeft(l, " \t"), " \t"))
			continue
		}
		if inCode {
			out = append(out, l)
			continue
		}
		// 行首空格来自 HTML 里的空白,去掉;列表续行的缩进用 indentMark 标着,不受影响
		t := strings.TrimLeft(strings.TrimRight(l, " \t"), " \t")
		if t == "" {
			blank++
			if blank > 1 {
				continue
			}
		} else {
			blank = 0
		}
		out = append(out, t)
	}
	return strings.Trim(strings.Join(out, "\n"), "\n")
}
