// AI 改文档(doc.edit,PRD 3.7「改文档」)的纯计算:把改动套到 Markdown 原文上,再按顶层块算出差异段,供正文里的差异预览与应用。

import type { DocEdit } from '../host/ai-types'

/** 改动套不上(要替换的原文找不到、偏移越界) */
export class DocEditError extends Error {
  override name = 'DocEditError'
}

/**
 * 把 doc.edit 套到原文上,返回新原文。原文换行统一为 \n;from / to 为原文里的字符偏移。
 * replace_all 整篇替换;replace_range 有 find 时替换第一处 find,否则替换 [from, to);
 * insert 有 from 插在 from 处,否则有 find 插在第一处 find 之后,都没有插到文末(与上一段之间空一行)。
 */
export function applyDocEdit(text: string, edit: DocEdit): string {
  const checkOffset = (n: number | undefined, name: string): number => {
    if (n === undefined || !Number.isInteger(n) || n < 0 || n > text.length) throw new DocEditError(`${name} 超出文档范围`)
    return n
  }
  const locate = (find: string): number => {
    const at = text.indexOf(find)
    if (at < 0) throw new DocEditError(`文档里找不到要修改的原文:「${find.length > 40 ? `${find.slice(0, 40)}…` : find}」`)
    return at
  }
  switch (edit.kind) {
    case 'replace_all':
      return edit.text
    case 'replace_range': {
      if (edit.find) {
        const at = locate(edit.find)
        return text.slice(0, at) + edit.text + text.slice(at + edit.find.length)
      }
      const from = checkOffset(edit.from, 'from')
      const to = checkOffset(edit.to ?? edit.from, 'to')
      if (to < from) throw new DocEditError('to 不能小于 from')
      return text.slice(0, from) + edit.text + text.slice(to)
    }
    case 'insert': {
      if (edit.from !== undefined) {
        const at = checkOffset(edit.from, 'from')
        return text.slice(0, at) + edit.text + text.slice(at)
      }
      if (edit.find) {
        const at = locate(edit.find) + edit.find.length
        return text.slice(0, at) + edit.text + text.slice(at)
      }
      const body = text.replace(/\n+$/, '')
      return `${body}${body ? '\n\n' : ''}${edit.text.replace(/\n+$/, '')}\n`
    }
    default:
      throw new DocEditError(`未知的修改方式:${String((edit as { kind?: unknown }).kind)}`)
  }
}

/** 一段差异:旧序列 [aFrom, aTo) 换成新序列 [bFrom, bTo)。 */
export interface Hunk {
  aFrom: number
  aTo: number
  bFrom: number
  bTo: number
}

/** 两段序列都超过这个乘积时不做 LCS,首尾相同部分之外整段算一处差异 */
const MAX_CELLS = 250_000

/**
 * 序列差分(用于顶层块):去掉首尾相同的部分,中间做 LCS;相邻的删除与新增合成一段。
 * 相同的两段序列返回空数组。
 */
export function diffSequences<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && eq(a[pre], b[pre])) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && eq(a[a.length - 1 - suf], b[b.length - 1 - suf])) suf++
  const n = a.length - pre - suf
  const m = b.length - pre - suf
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) return [{ aFrom: pre, aTo: pre + n, bFrom: pre, bTo: pre + m }]

  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = eq(a[pre + i], b[pre + j]) ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const hunks: Hunk[] = []
  let open: Hunk | null = null
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && eq(a[pre + i], b[pre + j])) {
      if (open) hunks.push(open)
      open = null
      i++
      j++
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      open ??= { aFrom: pre + i, aTo: pre + i, bFrom: pre + j, bTo: pre + j }
      open.aTo++
      i++
    } else {
      open ??= { aFrom: pre + i, aTo: pre + i, bFrom: pre + j, bTo: pre + j }
      open.bTo++
      j++
    }
  }
  if (open) hunks.push(open)
  return hunks
}
