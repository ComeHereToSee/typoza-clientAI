// AI 输出的显示与写回:复用基础版的 Markdown 解析(parseMarkdown → 文档模型),显示用 schema 的 toDOM 生成只读 DOM,
// 写回正文时转成 Slice。流式输出按 50 毫秒节流重画(PRD 质量要求「每段输出 50 毫秒内上屏」)。
import { DOMSerializer, Fragment, Slice } from 'prosemirror-model'
import { type ParseOptions, parseMarkdown } from '../core/markdown/parse'
import { schema } from '../core/schema'
import { renderTex } from '../views/katex'

let serializer: DOMSerializer | null = null

/**
 * Markdown → 只读 DOM。HTML 块与行内 HTML 按 schema 的 toDOM 显示为文字,不执行;
 * 公式只在 final(输出结束)时交给 KaTeX,流式过程中显示 TeX 源码,免得半截公式反复报错、反复排版。
 */
export function renderMarkdown(text: string, target: HTMLElement, options: ParseOptions, final: boolean): void {
  serializer ??= DOMSerializer.fromSchema(schema)
  const { doc } = parseMarkdown(text, options)
  target.replaceChildren(serializer.serializeFragment(doc.content))
  if (!final) return
  for (const el of Array.from(target.querySelectorAll<HTMLElement>('.tz-math-block'))) void renderTex(el.textContent ?? '', el, true)
  for (const el of Array.from(target.querySelectorAll<HTMLElement>('.tz-math-inline'))) void renderTex(el.dataset.tex ?? el.textContent ?? '', el, false)
}

/**
 * AI 给的 Markdown → 可插入正文的 Slice:只有一段文字时取段内的行内内容(插在光标处不拆段),
 * 否则是若干块(插在段落中间时拆开段落)。
 */
export function markdownSlice(text: string, options: ParseOptions): Slice {
  const { doc } = parseMarkdown(text.replace(/\r\n?/g, '\n'), options)
  const first = doc.firstChild
  if (doc.childCount === 1 && first?.type === schema.nodes.paragraph) return new Slice(first.content, 0, 0)
  return new Slice(doc.content, 0, 0)
}

/** AI 给的 Markdown → 顶层块(插到某块之后、插到文末)。空文本给一个空段落。 */
export function markdownBlocks(text: string, options: ParseOptions): Fragment {
  const { doc } = parseMarkdown(text.replace(/\r\n?/g, '\n'), options)
  return doc.childCount ? doc.content : Fragment.from(schema.nodes.paragraph.create())
}

/** 节流:schedule 之后最多 ms 毫秒执行一次;距上次执行已超过 ms 时下一轮事件循环就执行。 */
export class Throttle {
  private last = 0
  private timer = 0

  constructor(
    private readonly ms: number,
    private readonly fn: () => void,
  ) {}

  schedule(): void {
    if (this.timer) return
    const wait = Math.max(0, this.last + this.ms - performance.now())
    this.timer = window.setTimeout(() => {
      this.timer = 0
      this.last = performance.now()
      this.fn()
    }, wait)
  }

  /** 立即执行(输出结束时画最后一遍) */
  flush(): void {
    this.cancel()
    this.last = performance.now()
    this.fn()
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = 0
  }
}
