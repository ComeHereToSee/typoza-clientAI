import type { Node as PMNode } from 'prosemirror-model'
import { DOMSerializer } from 'prosemirror-model'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/core/markdown/parse'
import { serializeMarkdown } from '../../src/core/markdown/serialize'
import { schema } from '../../src/core/schema'

// 段落里成对的行内 HTML 标签照样渲染(对照表 X-43):kbd、ruby、font、带其它样式的 span
const opts = { inlineMath: true }

/** 用 JSON 重建文档:每个块都当成编辑过,走序列化器而不是原文 */
function edited(md: string): string {
  const { doc, meta } = parseMarkdown(md, opts)
  return serializeMarkdown(schema.nodeFromJSON(doc.toJSON()), meta, { inlineMath: true, ensureTrailingNewline: false })
}

function html(md: string): string {
  const { doc } = parseMarkdown(md, opts)
  const box = document.createElement('div')
  box.append(DOMSerializer.fromSchema(schema).serializeFragment((doc.firstChild as PMNode).content))
  return box.innerHTML
}

describe('段落里的成对行内 HTML 标签', () => {
  it('kbd:渲染成 <kbd>,编辑后原样写回', () => {
    expect(html('按 <kbd>Ctrl</kbd> 键')).toBe('按 <kbd>Ctrl</kbd> 键')
    expect(edited('按 <kbd>Ctrl</kbd> 键')).toBe('按 <kbd>Ctrl</kbd> 键')
  })

  it('ruby 里套 rt:两层都渲染,写回不变', () => {
    expect(html('<ruby>汉<rt>hàn</rt></ruby>字')).toBe('<ruby>汉<rt>hàn</rt></ruby>字')
    expect(edited('<ruby>汉<rt>hàn</rt></ruby>字')).toBe('<ruby>汉<rt>hàn</rt></ruby>字')
  })

  it('font color 与带字号的 span:保留属性渲染,开标签原文写回', () => {
    expect(html('<font color="red">红字</font>')).toBe('<font color="red">红字</font>')
    expect(edited('<font color="red">红字</font>')).toBe('<font color="red">红字</font>')
    // jsdom 会把 style 规整成「font-size: 20px;」
    expect(html('<span style="font-size:20px">大字</span>')).toMatch(/^<span style="font-size: ?20px;?">大字<\/span>$/)
    expect(edited('<span style="font-size:20px">大字</span>')).toBe('<span style="font-size:20px">大字</span>')
  })

  it('只认白名单属性:事件处理、class、id 不进渲染结果,但写回原文不变', () => {
    const md = '<kbd onclick="alert(1)" class="x" id="y" title="快捷键">K</kbd>'
    expect(html(md)).toBe('<kbd title="快捷键">K</kbd>')
    expect(edited(md)).toBe(md)
  })

  it('标签里套 Markdown 格式:内层照常识别', () => {
    const { doc } = parseMarkdown('<kbd>**粗**</kbd>', opts)
    const marks = (doc.firstChild as PMNode).firstChild!.marks.map((m) => m.type.name).sort()
    expect(marks).toEqual(['html_tag', 'strong'])
    // 两层格式等长时按标记先后嵌套,两种写法含义相同
    expect(['<kbd>**粗**</kbd>', '**<kbd>粗</kbd>**']).toContain(edited('<kbd>**粗**</kbd>'))
  })

  it('纯颜色 span 仍走颜色标记(可在界面里改色)', () => {
    const { doc } = parseMarkdown('<span style="color: red">红</span>', opts)
    expect((doc.firstChild as PMNode).firstChild!.marks.map((m) => m.type.name)).toEqual(['color'])
  })

  it('不成对的标签原样保留,不吞内容', () => {
    expect(edited('前 <kbd>没闭合')).toBe('前 <kbd>没闭合')
  })
})
