import { describe, expect, it } from 'vitest'
import { canSplitMarkdown, splitMarkdown } from '../../src/core/markdown/chunks'
import { MarkdownChunks, assembleDoc, parseMarkdown } from '../../src/core/markdown/parse'
import { serializeMarkdown } from '../../src/core/markdown/serialize'

const OPTIONS = { inlineMath: true }
const SER = { inlineMath: true, ensureTrailingNewline: true }

/** 不分段的整篇解析(一段装下全文),作为对照 */
function parseWhole(text: string) {
  const chunks = new MarkdownChunks(text, OPTIONS, Number.MAX_SAFE_INTEGER)
  const blocks = []
  while (!chunks.done) blocks.push(...chunks.nextBlocks())
  return { doc: assembleDoc(blocks), meta: chunks.meta }
}

// 各种会跨空行的结构:围栏代码、$$ 公式、HTML 注释、<details> 折叠块、松散列表、表格、引用
const TRICKY = `## 小节 N

普通段落,**加粗** 与 \`代码\`。

\`\`\`js
const a = 1

const b = 2
\`\`\`

$$
x^2

+ y^2
$$

<!-- 注释

跨空行 -->

<details>
<summary>折叠标题</summary>

折叠内容

</details>

- 松散列表一

- 松散列表二

  续行

| a | b |
| - | - |
| 1 | 2 |

> 引用

后面的段落。

`

const big = (n: number) => Array.from({ length: n }, (_, i) => TRICKY.replace('N', String(i + 1))).join('')

describe('大文档分段(core/markdown/chunks.ts)', () => {
  it('各段首尾相接等于原文,且每段都不小于目标大小(最后一段除外)', () => {
    const text = big(200)
    const parts = splitMarkdown(text, 4096)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.join('')).toBe(text)
    for (const p of parts.slice(0, -1)) expect(p.length).toBeGreaterThanOrEqual(4096)
  })

  it('只在空行后、顶格且不是列表项的行前切开', () => {
    const parts = splitMarkdown(big(200), 4096)
    // 可以作为段首的只有各结构的第一行;代码 / 公式 / 注释 / 折叠块内部、列表项、缩进行都不行
    const allowed = ['## 小节', '普通段落', '```js', '$$', '<!--', '<details>', '| a', '> 引用', '后面的段落']
    for (const p of parts.slice(1)) expect(allowed.some((a) => p.startsWith(a))).toBe(true)
  })

  it('有链接或脚注定义时不切', () => {
    const text = `${big(100)}[ref]: https://example.com\n`
    expect(canSplitMarkdown(text)).toBe(false)
    expect(splitMarkdown(text, 4096)).toEqual([text])
    expect(canSplitMarkdown(`${big(10)}[^1]: 脚注\n`)).toBe(false)
  })

  it('小文档整篇一段', () => {
    expect(splitMarkdown(TRICKY, 4096)).toEqual([TRICKY])
  })
})

describe('分段解析与整篇解析结果相同', () => {
  for (const [name, text] of [
    ['混排结构', big(200)],
    ['带 front matter 与 CRLF', `---\ntitle: 测试\n---\n\n${big(150)}`.replace(/\n/g, '\r\n')],
    ['开头有空行、结尾多个换行', `\n\n${big(150)}\n\n\n`],
  ] as const) {
    it(name, () => {
      const whole = parseWhole(text)
      const chunked = new MarkdownChunks(text, OPTIONS, 4096)
      expect(chunked.total).toBeGreaterThan(3)
      const blocks = []
      while (!chunked.done) blocks.push(...chunked.nextBlocks())
      const doc = assembleDoc(blocks)
      expect(doc.eq(whole.doc)).toBe(true)
      expect(chunked.meta).toEqual(whole.meta)
      // 未编辑时写回与原文逐字相同(块的原文与块间间隔跨段接续)
      expect(serializeMarkdown(doc, chunked.meta, SER)).toBe(serializeMarkdown(whole.doc, whole.meta, SER))
    })
  }

  it('parseMarkdown 对大文档走分段,结果不变', () => {
    const text = big(400)
    const { doc, meta } = parseMarkdown(text, OPTIONS)
    const whole = parseWhole(text)
    expect(doc.eq(whole.doc)).toBe(true)
    expect(serializeMarkdown(doc, meta, SER)).toBe(serializeMarkdown(whole.doc, whole.meta, SER))
  })
})
