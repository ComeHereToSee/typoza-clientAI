// Typora 的 :smile: 语法:已有文档里的表情短码显示成表情,源文字原样保留(保存不改写)。
// 光标移到短码上时露出源文字以便编辑。只重扫被修改的段落,大文档输入不受影响。
import type { Node as PMNode } from 'prosemirror-model'
import { type EditorState, Plugin, PluginKey, type Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { emojiIndexIfLoaded, loadEmoji } from '../core/emoji'
import { schema } from '../core/schema'

interface Candidate {
  from: number
  to: number
  code: string
}

interface ShortcodeState {
  candidates: Candidate[]
  decorations: DecorationSet
}

const key = new PluginKey<ShortcodeState>('tz-emoji-shortcodes')
const SHORTCODE = /:([a-z0-9_+-]+):/g

/** 扫描一个文本块里的短码(代码块、行内代码不算)。pos 是文本块自身的位置。 */
function scanBlock(block: PMNode, pos: number, out: Candidate[]): void {
  if (block.type.spec.code) return
  block.forEach((child, offset) => {
    if (!child.isText || child.marks.some((m) => m.type === schema.marks.code)) return
    const text = child.text ?? ''
    for (const m of text.matchAll(SHORTCODE)) {
      const from = pos + 1 + offset + (m.index ?? 0)
      out.push({ from, to: from + m[0].length, code: m[1] })
    }
  })
}

function scanAll(doc: PMNode): Candidate[] {
  const out: Candidate[] = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      scanBlock(node, pos, out)
      return false
    }
    return true
  })
  return out
}

/** 文档变化后:未改动段落里的候选按映射平移,改动过的段落整段重扫。 */
function rescan(prev: Candidate[], tr: Transaction): Candidate[] {
  const doc = tr.doc
  // 记下遍历时拿到的节点:之后再用 doc.nodeAt(pos) 定位,顶层要线性扫子节点,
  // 大文档一次追加上千块(分段载入)时就成了「块数 × 全文块数」
  const blocks: [number, number, PMNode][] = []
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1)
    map.forEach((_a, _b, start, end) => {
      const from = Math.max(0, rest.map(start, -1))
      const to = Math.min(doc.content.size, rest.map(end, 1))
      doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          blocks.push([pos, pos + node.nodeSize, node])
          return false
        }
        return true
      })
    })
  })
  const touched = (p: number) => blocks.some(([a, b]) => p >= a && p < b)
  const out: Candidate[] = []
  for (const c of prev) {
    const from = tr.mapping.mapResult(c.from, 1)
    const to = tr.mapping.mapResult(c.to, -1)
    if (from.deleted || to.deleted || to.pos - from.pos !== c.to - c.from || touched(from.pos)) continue
    out.push({ from: from.pos, to: to.pos, code: c.code })
  }
  const seen = new Set<number>()
  for (const [pos, , node] of blocks) {
    if (seen.has(pos)) continue
    seen.add(pos)
    scanBlock(node, pos, out)
  }
  return out.sort((a, b) => a.from - b.from)
}

function decorate(state: EditorState, candidates: Candidate[]): DecorationSet {
  const index = emojiIndexIfLoaded()
  if (!index || candidates.length === 0) return DecorationSet.empty
  const { from: selFrom, to: selTo } = state.selection
  const decos: Decoration[] = []
  for (const c of candidates) {
    const char = index.byShortcode.get(c.code)
    // 光标在短码上或紧挨着:露出源文字
    if (!char || (selTo >= c.from && selFrom <= c.to)) continue
    decos.push(
      Decoration.widget(
        c.from,
        () => {
          const span = document.createElement('span')
          span.className = 'tz-emoji'
          span.textContent = char
          span.title = `:${c.code}:`
          return span
        },
        { side: -1, key: `${c.code}` },
      ),
      Decoration.inline(c.from, c.to, { class: 'tz-emoji-src' }),
    )
  }
  return DecorationSet.create(state.doc, decos)
}

export function emojiShortcodePlugin(): Plugin<ShortcodeState> {
  return new Plugin<ShortcodeState>({
    key,
    state: {
      init: (_config, state) => {
        const candidates = scanAll(state.doc)
        return { candidates, decorations: decorate(state, candidates) }
      },
      apply(tr, prev, _old, state) {
        if (!tr.docChanged && !tr.selectionSet && !tr.getMeta(key)) return prev
        const candidates = tr.docChanged ? rescan(prev.candidates, tr) : prev.candidates
        return { candidates, decorations: decorate(state, candidates) }
      },
    },
    props: {
      decorations: (state) => key.getState(state)?.decorations,
    },
    view(view) {
      // 文档里有短码时才加载表情数据,加载完重画一次
      let requested = false
      const check = () => {
        if (requested || emojiIndexIfLoaded() || !key.getState(view.state)?.candidates.length) return
        requested = true
        void loadEmoji().then(() => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, 'loaded'))
        })
      }
      check()
      return { update: check }
    },
  })
}
