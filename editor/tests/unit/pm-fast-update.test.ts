// 依赖补丁(scripts/patch-deps.mjs):prosemirror-view 块级容器的快速更新、prosemirror-tables 修表格跳过前后相同部分。视图子节点很多(> 200)时走快速路径,
// 每一步之后的界面要与用同一状态新建的视图一模一样,没动的段落 DOM 原样保留。
import { Schema } from 'prosemirror-model'
import { EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state'
import { fixTables } from 'prosemirror-tables'
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view'
import { afterEach, describe, expect, it } from 'vitest'
import { schema as appSchema } from '../../src/core/schema'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h2', 0] },
    bullet_list: { group: 'block', content: 'list_item+', toDOM: () => ['ul', 0] },
    list_item: { content: 'paragraph', toDOM: () => ['li', 0] },
    text: { group: 'inline' },
  },
})

// 光标所在的顶层块加节点装饰(同编辑器里的 is-editing),另给第 3 段加一段行内装饰
const decorations = new Plugin({
  props: {
    decorations(state) {
      const { $from } = state.selection
      const decos = [Decoration.inline(state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + 1, state.doc.child(0).nodeSize + state.doc.child(1).nodeSize + 3, { class: 'hl' })]
      if ($from.depth > 0) decos.push(Decoration.node($from.before(1), $from.after(1), { class: 'is-editing' }))
      return DecorationSet.create(state.doc, decos)
    },
  },
})

const views: EditorView[] = []
afterEach(() => views.splice(0).forEach((v) => v.destroy()))

function mount(state: EditorState): EditorView {
  const view = new EditorView(document.body.appendChild(document.createElement('div')), { state })
  views.push(view)
  return view
}

function posOf(doc: EditorState['doc'], index: number): number {
  let pos = 0
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize
  return pos
}

describe('大文档顶层的快速更新(依赖补丁)', () => {
  it('打字、换光标位置、改块类型、增删段落、整篇替换后,界面与重新渲染的一致;没动的段落 DOM 原样保留', () => {
    const doc = schema.node('doc', null, Array.from({ length: 500 }, (_, i) => schema.node('paragraph', null, schema.text(`第 ${i} 段`))))
    let state = EditorState.create({ doc, plugins: [decorations] })
    const view = mount(state)
    const steps: ((s: EditorState) => Transaction)[] = [
      (s) => s.tr.setSelection(TextSelection.create(s.doc, posOf(s.doc, 250) + 2)),
      (s) => s.tr.insertText('字'),
      (s) => s.tr.insertText('又'),
      (s) => s.tr.setSelection(TextSelection.create(s.doc, posOf(s.doc, 10) + 1)),
      (s) => s.tr.insertText('前'),
      (s) => s.tr.setBlockType(posOf(s.doc, 300) + 1, posOf(s.doc, 300) + 1, schema.nodes.heading),
      (s) => s.tr.split(posOf(s.doc, 100) + 3),
      (s) => s.tr.delete(posOf(s.doc, 400), posOf(s.doc, 401)),
      (s) => s.tr.insertText('尾', s.doc.content.size - 1),
      (s) => s.tr.replaceWith(0, s.doc.content.size, Array.from({ length: 300 }, (_, i) => schema.node('paragraph', null, schema.text(`新 ${i}`)))),
      (s) => s.tr.insertText('改', posOf(s.doc, 150) + 1),
    ]
    for (const step of steps) {
      const before = Array.from(view.dom.children)
      const tr = step(state)
      state = state.apply(tr)
      view.updateState(state)
      expect(view.dom.innerHTML).toBe(mount(state).dom.innerHTML)
      // 只改了一个段落的步骤:其余段落还是原来那批 DOM 元素
      if (tr.doc.childCount === tr.before.childCount && tr.docChanged && tr.doc.childCount === before.length) {
        const changed = before.filter((el, i) => el !== view.dom.children[i]).length
        expect(changed).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('快速路径不适用或在内层容器里时(依赖补丁)', () => {
  const paras = (n: number, word = '段') => Array.from({ length: n }, (_, i) => schema.node('paragraph', null, schema.text(`第 ${i} ${word}`)))
  // 标题用自定义节点视图(编辑器里代码块、列表项等都是)
  const nodeViews = {
    heading: () => {
      const dom = document.createElement('h3')
      return { dom, contentDOM: dom }
    },
  }
  function run(state: EditorState, steps: ((s: EditorState) => Transaction)[]): void {
    const make = (s: EditorState) => {
      const view = new EditorView(document.body.appendChild(document.createElement('div')), { state: s, nodeViews })
      views.push(view)
      return view
    }
    const view = make(state)
    for (const step of steps) {
      state = state.apply(step(state))
      view.updateState(state)
      expect(view.dom.innerHTML).toBe(make(state).dom.innerHTML)
    }
  }

  it('顶层有小部件、有跨块的行内装饰、有自定义节点视图时,界面照样与重新渲染的一致', () => {
    const widgetAndSpan = new Plugin({
      props: {
        decorations(state) {
          return DecorationSet.create(state.doc, [
            // 块与块之间的小部件:容器层有小部件,快速路径不适用,走原逻辑
            Decoration.widget(posOf(state.doc, 100), () => Object.assign(document.createElement('hr'), { className: 'w' })),
            // 从第 250 段中间到第 252 段中间的行内装饰:分到三个子节点里
            Decoration.inline(posOf(state.doc, 250) + 2, posOf(state.doc, 252) + 2, { class: 'span' }),
          ])
        },
      },
    })
    run(EditorState.create({ doc: schema.node('doc', null, paras(500)), plugins: [widgetAndSpan] }), [
      (s) => s.tr.insertText('前', posOf(s.doc, 10) + 1),
      (s) => s.tr.insertText('中', posOf(s.doc, 251) + 1),
      (s) => s.tr.setBlockType(posOf(s.doc, 300) + 1, posOf(s.doc, 300) + 1, schema.nodes.heading),
      (s) => s.tr.insertText('题', posOf(s.doc, 300) + 1),
      (s) => s.tr.delete(posOf(s.doc, 400), posOf(s.doc, 401)),
    ])
  })

  it('超过 200 项的列表里打字、增删列表项:列表这一层也走快速路径,界面一致', () => {
    const items = Array.from({ length: 300 }, (_, i) => schema.node('list_item', null, schema.node('paragraph', null, schema.text(`项 ${i}`))))
    const doc = schema.node('doc', null, [...paras(5), schema.node('bullet_list', null, items), ...paras(5, '尾')])
    const inItem = (d: EditorState['doc'], i: number) => posOf(d, 5) + 1 + Array.from({ length: i }, (_, k) => d.child(5).child(k).nodeSize).reduce((a, b) => a + b, 0)
    run(EditorState.create({ doc }), [
      (s) => s.tr.insertText('字', inItem(s.doc, 150) + 2),
      (s) => s.tr.insertText('又', inItem(s.doc, 299) + 2),
      (s) => s.tr.delete(inItem(s.doc, 10), inItem(s.doc, 11)),
      (s) => s.tr.insert(inItem(s.doc, 20), schema.node('list_item', null, schema.node('paragraph', null, schema.text('新项')))),
    ])
  })
})

describe('大文档里修表格只看改动的部分(prosemirror-tables 依赖补丁)', () => {
  it('300 段中间新插入的不完整表格照样补齐;没动的部分不改', () => {
    const s = appSchema
    const para = (t: string) => s.node('paragraph', null, s.text(t))
    const cell = (t: string) => s.node('table_cell', null, s.text(t))
    const broken = s.node('table', null, [s.node('table_row', null, [cell('a'), cell('b')]), s.node('table_row', null, [cell('c')])])
    const doc = s.node('doc', null, Array.from({ length: 300 }, (_, i) => para(`第 ${i} 段`)))
    const old = EditorState.create({ doc })
    const next = old.apply(old.tr.insert(posOf(doc, 150), broken))
    const tr = fixTables(next, old)
    expect(tr).toBeTruthy()
    const fixed = next.apply(tr!).doc
    expect(fixed.child(150).child(1).childCount).toBe(2)
    expect(fixed.childCount).toBe(301)
    expect(fixed.child(0).textContent).toBe('第 0 段')
    expect(fixed.child(300).textContent).toBe('第 299 段')
  })
})

