// 大文档分段:在「分开解析与整篇解析结果相同」的块边界把原文切成若干段。
// micromark 解析耗时随文档变大超线性增长(5MB 在 WebKit 里约 50 秒),分段后总耗时近似线性,
// 也让打开大文档时能先显示第一段、其余在后台续上(PRD 质量要求:5MB 文档首屏 ≤1.5 秒)。
//
// 只在空行之后、下一行顶格且不会接续前面结构的地方切:
// - 不切在围栏代码块、$$ 公式块、front matter、HTML 块(类型 1~5,可跨空行)、<details> 折叠块里;
// - 下一行不能是列表项(会与上一段的列表合并成松散列表)、缩进内容(会接续列表项或成为缩进代码)、空行;
// - 文中有链接或脚注定义([标签]: 地址、[^标签]: 内容)时不切:引用与定义可能分在两段。

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const MATH_FENCE = /^ {0,3}\$\$/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m
const DETAILS_OPEN = /^ {0,3}<details(?:\s[^>]*)?>/i
const DETAILS_CLOSE = /<\/details>\s*$/i
/** HTML 块类型 1~5 的起止(CommonMark 4.6):可以跨空行 */
const HTML_RAW: [RegExp, RegExp][] = [
  [/^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
]

/** 文中有引用定义时整篇解析(定义可能在另一段) */
export function canSplitMarkdown(text: string): boolean {
  return !DEFINITION.test(text)
}

/**
 * 按约 target 字符切段;返回的各段首尾相接等于原文。不能切或不必切时返回只有整篇的一段。
 * 原文换行须已统一为 \n。
 */
export function splitMarkdown(text: string, target: number): string[] {
  if (text.length <= target * 1.5 || !canSplitMarkdown(text)) return [text]
  const parts: string[] = []
  let start = 0
  let fence: string | null = null
  let math = false
  let rawEnd: RegExp | null = null
  let details = 0
  let frontMatter = text.startsWith('---\n')
  let prevBlank = false
  let lineStart = 0
  let lineNo = 0
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? text.length : nl
    const line = text.slice(lineStart, lineEnd)
    const blank = line.trim() === ''
    // 先判断这一行开头能不能作为新一段的起点(看的是进入这一行之前的状态)
    if (
      prevBlank &&
      !blank &&
      lineStart - start >= target &&
      fence === null &&
      !math &&
      rawEnd === null &&
      details === 0 &&
      !frontMatter &&
      !/^[ \t]/.test(line) &&
      !LIST_ITEM.test(line)
    ) {
      parts.push(text.slice(start, lineStart))
      start = lineStart
    }
    // 再按这一行更新状态
    if (frontMatter) {
      if (lineNo > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontMatter = false
    } else if (fence !== null) {
      const m = FENCE.exec(line)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.slice(m[0].length).trim() === '') fence = null
    } else if (math) {
      if (MATH_FENCE.test(line)) math = false
    } else if (rawEnd !== null) {
      if (rawEnd.test(line)) rawEnd = null
    } else {
      const f = FENCE.exec(line)
      if (f) fence = f[1]
      else if (MATH_FENCE.test(line)) {
        // 同一行里 $$…$$ 写完的不算开块
        if (!/^ {0,3}\$\$.*\S.*\$\$\s*$/.test(line)) math = true
      } else {
        for (const [open, close] of HTML_RAW) {
          if (open.test(line)) {
            // 同一行里已经闭合的不算跨行
            if (!close.test(line.replace(open, ''))) rawEnd = close
            break
          }
        }
      }
      if (DETAILS_OPEN.test(line) && !DETAILS_CLOSE.test(line)) details++
      else if (details > 0 && /^ {0,3}<\/details>\s*$/i.test(line)) details--
    }
    prevBlank = blank
    lineNo++
    lineStart = nl < 0 ? text.length : nl + 1
  }
  parts.push(text.slice(start))
  return parts.filter((p, i) => p.length > 0 || i === 0)
}
