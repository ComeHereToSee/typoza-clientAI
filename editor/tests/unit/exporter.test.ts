// 导出 HTML(PRD 3.7 导出、3.12;对照表 M-10、PM-23、PM-24、PX-04、PX-05):去掉编辑器元素、资源改相对路径、公式输出、注释隐藏。
import { describe, expect, it } from 'vitest'
import { buildExportHtml, headingSlug } from '../../src/app/exporter'

function editorDom(): HTMLElement {
  const el = document.createElement('div')
  el.id = 'write'
  el.className = 'tz-editor tz-focus-mode'
  el.setAttribute('contenteditable', 'true')
  el.innerHTML = `
<h1>标题 一</h1>
<p class="tz-placeholder" data-placeholder="输入「/」唤出命令">他说 <span class="tz-smart" data-smart="“">"</span>你好<span class="tz-smart" data-smart="”">"</span> <span class="tz-smart" data-smart="–">--</span> 再见</p>
<div class="tz-image-toolbar">工具条</div>
<p><img src="typoza://local/Users/test/docs/assets/a%20b.png" alt="图"></p>
<div class="tz-html-block is-comment"><div class="tz-html-preview"><span class="tz-html-comment">&lt;!-- 块注释 --&gt;</span></div><pre class="tz-html-source">&lt;!-- 块注释 --&gt;</pre></div>
<p>行内<span class="tz-html-inline tz-html-comment">&lt;!-- 行内注释 --&gt;</span>文字<span class="tz-md-marker">**</span></p>
<div class="tz-math-block"><div class="tz-math-preview"><span class="katex"><span class="katex-mathml"><math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">\\begin{equation}x^2\\end{equation}</annotation></semantics></math></span><span class="katex-html">x2</span></span></div><pre class="tz-math-source">x^2</pre></div>
<p>公式 <span class="tz-math-inline"><span class="katex"><span class="katex-mathml"><math><semantics><mi>y</mi><annotation encoding="application/x-tex">y</annotation></semantics></math></span><span class="katex-html">y</span></span></span></p>
<h2>小节</h2>
<h2>小节</h2>
<div class="tz-html-block"><div class="tz-html-preview"><div data-tz-class="note box" data-tz-id="anchor-1">HTML 块</div></div><pre class="tz-html-source">&lt;div class="note box" id="anchor-1"&gt;HTML 块&lt;/div&gt;</pre></div>`
  return el
}

const base = { title: '文档', targetPath: '/Users/test/docs/文档.html' }

describe('buildExportHtml', () => {
  it('去掉编辑器界面元素、注释、占位与编辑标记;本机图片改成相对导出文件的路径', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: true })
    for (const gone of ['tz-image-toolbar', '块注释', '行内注释', 'data-placeholder', 'tz-placeholder', 'contenteditable', 'tz-md-marker', 'tz-math-source', 'tz-focus-mode']) {
      expect(html, gone).not.toContain(gone)
    }
    expect(html).toContain('src="assets/a b.png"')
    expect(html).toContain('<title>文档</title>')
  })

  it('智能标点「渲染时转换」导出成真正的弯引号与破折号', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: false })
    expect(html).toContain('他说 “你好” – 再见')
    expect(html).not.toContain('tz-smart')
  })

  it('有样式:带主题与深色标记,公式保留 KaTeX 渲染结果', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: true, theme: 'pixyll', dark: true })
    expect(html).toMatch(/<html [^>]*data-theme="pixyll"/)
    expect(html).toMatch(/<html [^>]*class="tz-dark"/)
    expect(html).toContain('katex-html')
  })

  it('无样式 HTML 的公式:MathML(块级带 display="block")', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: false, mathOutput: 'mathml' })
    expect(html).not.toContain('<style>')
    expect(html).not.toContain('katex-html')
    expect(html).toMatch(/<math display="block">/)
    expect(html).not.toContain('data-theme')
  })

  it('无样式 HTML 的公式:LaTeX 源码(块级取编辑区原文)', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: false, mathOutput: 'latex' })
    expect(html).toContain('$$\nx^2\n$$')
    expect(html).toContain('$y$')
    expect(html).not.toContain('<math')
  })

  it('大纲侧边栏、按一级标题分页、保留空白、字号、追加的 HTML 与作者', () => {
    const html = buildExportHtml(editorDom(), {
      ...base,
      withStyles: false,
      outline: true,
      h1PageBreak: true,
      preserveWhitespace: true,
      fontSize: 20,
      appendHead: '<meta name="x" content="头">',
      appendBody: '<script>/* 尾 */</script>',
      author: '小明',
    })
    expect(html).toContain('<nav class="tz-export-outline">')
    expect(html).toContain('<h1 id="标题-一">')
    expect(html).toContain('href="#标题-一"')
    // 重名标题加序号
    expect(html).toContain('id="小节-1"')
    expect(html).toContain('class="tz-export has-outline"')
    expect(html).toContain('break-before: page')
    expect(html).toContain('white-space: pre-wrap')
    expect(html).toContain('--tz-font-size: 20px')
    expect(html).toContain('<meta name="x" content="头">')
    expect(html).toContain('<script>/* 尾 */</script>')
    expect(html).toContain('<meta name="author" content="小明">')
  })

  it('标题锚点与 Typora 一致', () => {
    const used = new Map<string, number>()
    expect(headingSlug('Hello, World!', used)).toBe('hello-world')
    expect(headingSlug('Hello, World!', used)).toBe('hello-world-1')
    expect(headingSlug('配置 · 说明', used)).toBe('配置-说明')
  })
})

describe('HTML 块的 class、id(对照表 X-44)', () => {
  it('预览里去掉,导出时还原', () => {
    const html = buildExportHtml(editorDom(), { ...base, withStyles: false })
    expect(html).toContain('<div class="note box" id="anchor-1">HTML 块</div>')
    expect(html).not.toContain('data-tz-class')
    expect(html).not.toContain('data-tz-id')
  })
})
