// 编辑时显示 Markdown 标记(偏好 PE-04 / 对照表 X-01,默认关):光标进入行内样式时在两端显示对应符号,
// 光标在标题里时在行首显示 #。只是不可编辑的提示,存储不变;关掉时与 Notion 一样不显示任何标记。
import type { Mark, MarkType } from 'prosemirror-model'
import { Plugin } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { markRange } from '../core/commands'
import type { EditorEnv } from '../core/env'
import { schema } from '../core/schema'

/** 行内标记两端的源码写法(与 serialize.ts 的输出一致)。 */
function tokens(mark: Mark): [string, string] | null {
  const m = schema.marks
  switch (mark.type) {
    case m.strong:
      return ['**', '**']
    case m.em:
      return ['*', '*']
    case m.strike:
      return ['~~', '~~']
    case m.code:
      return ['`', '`']
    case m.highlight:
      return ['==', '==']
    case m.underline:
      return ['<u>', '</u>']
    case m.sup:
      return mark.attrs.syntax === 'typora' ? ['^', '^'] : ['<sup>', '</sup>']
    case m.sub:
      return mark.attrs.syntax === 'typora' ? ['~', '~'] : ['<sub>', '</sub>']
    case m.link:
      return ['[', `](${mark.attrs.href as string})`]
    case m.html_tag:
      return [mark.attrs.open as string, `</${mark.attrs.tag as string}>`]
    default:
      return null
  }
}

function marker(text: string): () => HTMLElement {
  return () => {
    const el = document.createElement('span')
    el.className = 'tz-md-marker'
    el.textContent = text
    return el
  }
}

export function markdownMarkersPlugin(env: EditorEnv): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (!env.settings.showMarkdownMarkers) return null
        const { $from } = state.selection
        const parent = $from.parent
        if (!parent.isTextblock || parent.type.spec.code) return null
        const decos: Decoration[] = []
        if (parent.type === schema.nodes.heading) {
          const level = parent.attrs.level as number
          decos.push(Decoration.widget($from.start(), marker(`${'#'.repeat(level)} `), { side: -1, key: `h${level}` }))
        }
        const candidates = [...$from.marks(), ...($from.nodeBefore?.marks ?? []), ...($from.nodeAfter?.marks ?? [])]
        const seen = new Set<MarkType>()
        for (const mark of candidates) {
          if (seen.has(mark.type)) continue
          seen.add(mark.type)
          const range = markRange($from, mark.type)
          const pair = range ? tokens(range.mark) : null
          if (!range || !pair) continue
          decos.push(
            Decoration.widget(range.from, marker(pair[0]), { side: -1, key: `o${mark.type.name}${range.from}` }),
            Decoration.widget(range.to, marker(pair[1]), { side: 1, key: `c${mark.type.name}${range.to}` }),
          )
        }
        return decos.length ? DecorationSet.create(state.doc, decos) : null
      },
    },
  })
}
