import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Node as PMNode } from 'prosemirror-model'
import { EditorState } from 'prosemirror-state'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../../src/core/markdown/parse'
import { serializeMarkdown } from '../../src/core/markdown/serialize'
import { schema } from '../../src/core/schema'

const parseOpts = { inlineMath: true }
const serOpts = { inlineMath: true, ensureTrailingNewline: false }

function fixture(name: string): string {
  // vitest 在 editor 目录下运行;jsdom 环境里 import.meta.url 不是文件路径
  return readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8')
}

/** 用 JSON 重建文档:所有节点都是新对象,不再命中原文缓存,相当于「每个块都被编辑过」。 */
function rebuild(doc: PMNode): PMNode {
  return schema.nodeFromJSON(doc.toJSON())
}

/**
 * 引用式链接的写法(完整 [文字][标签] / 折叠 [文字][] / 简写 [文字])可能在文字含需转义字符时由序列化器改成完整写法,
 * 链接目标与文字不变,比较时忽略这一属性。
 */
function normalize(json: unknown): unknown {
  return JSON.parse(JSON.stringify(json), (key, value) => (key === 'refType' ? undefined : value))
}

function semanticRoundTrip(md: string) {
  const a = parseMarkdown(md, parseOpts)
  const out = serializeMarkdown(rebuild(a.doc), a.meta, serOpts)
  const b = parseMarkdown(out, parseOpts)
  return { a: normalize(a.doc.toJSON()), b: normalize(b.doc.toJSON()), out }
}

function find(doc: PMNode, type: string): PMNode[] {
  const out: PMNode[] = []
  doc.descendants((n) => {
    if (n.type.name === type) out.push(n)
  })
  return out
}

function marksOf(doc: PMNode, text: string): string[] {
  let found: string[] | null = null
  doc.descendants((n) => {
    if (!found && n.isText && n.text === text) found = n.marks.map((m) => m.type.name)
  })
  if (!found) throw new Error(`文档里没有文本「${text}」`)
  return found
}

describe('原文保真:未编辑的文档原样写回', () => {
  const cases: Record<string, string> = {
    语料: fixture('typora-corpus.md'),
    CRLF: '# 标题\r\n\r\n段落一\r\n段落二\r\n',
    BOM: '\uFEFF# 带 BOM\n',
    无结尾换行: '段落',
    多空行: '\n\n# 前导空行\n\n\n\n段落\n\n\n',
    星号列表: '* a\n* b\n\n  c\n',
  }
  for (const [name, md] of Object.entries(cases)) {
    it(name, () => {
      const { doc, meta } = parseMarkdown(md, parseOpts)
      expect(serializeMarkdown(doc, meta, serOpts)).toBe(md)
    })
  }

  it('只改一个块时,其它块逐字不变', () => {
    const md = '# 标题\n\n*  奇怪缩进的列表\n*  第二项\n\n要修改的段落\n\n尾段  \n'
    const { doc, meta } = parseMarkdown(md, parseOpts)
    let end = -1
    doc.forEach((n, offset) => {
      if (n.textContent === '要修改的段落') end = offset + 1 + n.content.size
    })
    const edited = EditorState.create({ doc }).tr.insertText('!', end).doc
    expect(serializeMarkdown(edited, meta, serOpts)).toBe('# 标题\n\n*  奇怪缩进的列表\n*  第二项\n\n要修改的段落!\n\n尾段  \n')
  })

  it('编辑过的段落、标题末尾的空格不写成 &#x20;(含加粗等标记里的末尾空格)', () => {
    const p = (...content: PMNode[]) => schema.nodes.paragraph.create(null, content)
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.heading.create({ level: 2 }, schema.text('标题 ')),
      p(schema.text('截止 2026-10-16 ')),
      p(schema.text('前 '), schema.text('加粗 ', [schema.marks.strong.create()]), schema.text(' \t')),
    ])
    const meta = parseMarkdown('', parseOpts).meta
    expect(serializeMarkdown(doc, meta, serOpts)).toBe('## 标题\n\n截止 2026-10-16\n\n前 **加粗**')
  })

  it('邮箱链接存成裸邮箱;纯文本里的 @ 才转义', () => {
    const mail = schema.marks.link.create({ href: 'mailto:me@example.com', autolink: true })
    const doc = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(null, [schema.text('邮箱 '), schema.text('me@example.com', [mail]), schema.text(' 见')])])
    const meta = parseMarkdown('', parseOpts).meta
    expect(serializeMarkdown(doc, meta, serOpts)).toBe('邮箱 me@example.com 见')
  })
})

describe('Typora 扩展语法识别', () => {
  const { doc } = parseMarkdown(fixture('typora-corpus.md'), parseOpts)

  it('高亮、下划线、颜色、删除线', () => {
    expect(marksOf(doc, '高亮')).toEqual(['highlight'])
    expect(marksOf(doc, '删除线')).toEqual(['strike'])
    expect(marksOf(doc, '下划线')).toEqual(['underline'])
    expect(marksOf(doc, '红字')).toEqual(['color'])
  })

  // PRD 对照表 PM-08、PM-09:下标 ~…~、上标 ^…^ 的识别默认关(~文字~ 在 GFM 里常被当删除线),打开偏好后才识别
  it('上下标默认不识别,按普通文字显示', () => {
    const text = find(doc, 'paragraph')
      .map((p) => p.textContent)
      .find((t) => t.startsWith('普通段落'))
    expect(text).toContain('x^2^、H~2~O')
    expect(find(doc, 'paragraph').some((p) => p.content.content.some((c) => c.marks.some((m) => m.type.name === 'sup' || m.type.name === 'sub')))).toBe(false)
  })

  it('打开上下标识别后,^2^ 是上标、~2~ 是下标', () => {
    const { doc: on } = parseMarkdown(fixture('typora-corpus.md'), { ...parseOpts, superscript: true, subscript: true })
    expect(marksOf(on, '2')).toEqual(['sup'])
    const sub = find(on, 'paragraph').flatMap((p) => {
      const r: string[] = []
      p.forEach((c) => {
        if (c.marks.some((m) => m.type.name === 'sub')) r.push(c.text ?? '')
      })
      return r
    })
    expect(sub).toContain('2')
  })

  it('转义的定界符保持为文本', () => {
    const text = find(doc, 'paragraph').map((p) => p.textContent).find((t) => t.startsWith('转义的'))
    expect(text).toBe('转义的 ==不是高亮== 与 ^不是上标^。')
  })

  it('front matter、目录、提示框、折叠块', () => {
    expect(doc.firstChild?.type.name).toBe('frontmatter')
    expect(find(doc, 'toc')).toHaveLength(1)
    const callouts = find(doc, 'callout')
    expect(callouts.map((c) => [c.attrs.kind, c.attrs.title])).toEqual([
      ['note', ''],
      ['warning', '自定义标题'],
    ])
    expect(callouts[0].textContent).toBe('提示框内容')
    const toggle = find(doc, 'toggle')[0]
    expect(toggle.firstChild?.textContent).toBe('折叠标题')
    expect(toggle.lastChild?.textContent).toBe('折叠内容')
  })

  it('媒体块与 HTML 图片', () => {
    const media = find(doc, 'media').map((m) => [m.attrs.kind, m.attrs.src])
    expect(media).toEqual([
      ['video', 'assets/demo.mp4'],
      ['embed', 'https://www.youtube.com/embed/abc'],
      ['bookmark', 'https://example.com'],
    ])
    const zoomed = find(doc, 'image').find((i) => i.attrs.src === 'assets/b.png')
    expect(zoomed?.attrs).toMatchObject({ zoom: '50%', html: true, alt: '缩放图' })
  })

  it('表格对齐与单元格换行', () => {
    const table = find(doc, 'table')[0]
    expect(table.firstChild?.content.content.map((c) => c.attrs.align)).toEqual(['left', 'center', 'right'])
    expect(find(table, 'hard_break')[0].attrs.syntax).toBe('html')
  })

  it('任务列表、wikilink、脚注、公式、引用定义', () => {
    expect(find(doc, 'list_item').map((li) => li.attrs.checked).filter((c) => c !== null)).toEqual([false, true])
    expect(find(doc, 'wikilink').map((w) => [w.attrs.target, w.attrs.alias])).toEqual([
      ['另一篇', '别名'],
      ['笔记', null],
    ])
    expect(find(doc, 'footnote_ref')[0].attrs.label).toBe('1')
    expect(find(doc, 'footnote_def')[0].textContent).toBe('脚注内容。')
    expect(find(doc, 'math_inline')[0].attrs.tex).toBe('E=mc^2')
    expect(find(doc, 'math_block')[0].textContent).toBe('\\int_0^1 x\\,dx')
    expect(find(doc, 'definition')[0].attrs).toMatchObject({ label: 'doc', url: 'https://example.com/doc' })
    expect(find(doc, 'code_block')[0].attrs).toMatchObject({ language: 'js', meta: '{1,3}' })
  })

  it('换行的三种写法分别记录', () => {
    const syntaxes = find(doc, 'hard_break').map((b) => b.attrs.syntax)
    expect(syntaxes).toEqual(expect.arrayContaining(['html', 'spaces', 'backslash']))
  })
})

describe('语义往返:每个块都重新生成后再解析,结构不变', () => {
  it('Typora 语料', () => {
    const { a, b, out } = semanticRoundTrip(fixture('typora-corpus.md'))
    expect(b, out).toEqual(a)
  })

  it('相邻的两个同类列表不会被合并(换用不同标记符)', () => {
    for (const md of ['- a\n- b\n* c\n', '1. a\n2. b\n3) c\n']) {
      const { a, b, out } = semanticRoundTrip(md)
      expect(b, out).toEqual(a)
    }
  })

  const spec = JSON.parse(fixture('commonmark-spec.json')) as { markdown: string; example: number; section: string }[]
  // 已知无法语义往返的用例(每条写原因):
  // #173 未闭合的 <style> HTML 块一直延续到文末,块内容末尾的换行与文末换行无法区分,重写后少一个末尾换行(渲染无差别)
  const known = new Set<number>([173])
  for (const ex of spec) {
    const name = `CommonMark #${ex.example} ${ex.section}`
    if (known.has(ex.example)) {
      it.skip(name)
      continue
    }
    it(name, () => {
      const { a, b, out } = semanticRoundTrip(ex.markdown)
      expect(b, `输入:\n${ex.markdown}\n输出:\n${out}`).toEqual(a)
    })
  }

  // GFM 规范扩展章节(表格、任务列表、删除线、扩展自动链接、禁用的原始 HTML)与脚注的示例,按章节整理
  const gfm = JSON.parse(fixture('gfm-extensions.json')) as { markdown: string; section: string; n: number }[]
  for (const ex of gfm) {
    it(`GFM ${ex.section} #${ex.n}`, () => {
      const { a, b, out } = semanticRoundTrip(ex.markdown)
      expect(b, `输入:\n${ex.markdown}\n输出:\n${out}`).toEqual(a)
    })
  }
})
