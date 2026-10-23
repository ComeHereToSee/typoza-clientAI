// 块选中态与多块选择(notion-input.md 7.4、7.1):
// 所选块加底色;块选中态直接输入文字不改内容、退出选中态;⇧+点击选连续多块、⇧⌘+点击增减单块;
// 在正文左右空白处按下拖动框选;块选中态粘贴插在所选块下方;按住 ⌥ 拖动块为复制。
// 另注册块菜单里要用应用层能力的命令(复制为 Markdown、移动到…、复制块链接),
// 以及未定义引用链接的 ⌘+点击提示(对照表 X-13)。
import '../styles/notion-blocks.css'
import { Plugin, Selection, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import {
  BlockSelection,
  exitBlockSelection,
  isBlockSelected,
  isSelectableBlock,
  selectBlocks,
  selectedBlocks,
  shiftClickSelection,
  toggleBlockSelection,
} from '../core/block-selection'
import { type BlockInfo, blockAt, collectHeadings } from '../core/blocks'
import { blocksToMarkdown, deleteBlock, markRange, setCodeIndentWidth } from '../core/commands'
import { type DocumentRef, EDITOR_OPTION_DEFAULTS, type EditorEnv } from '../core/env'
import { basename, markdownHref } from '../core/paths'
import { registerCommand } from '../core/registry'
import { schema } from '../core/schema'
import { pickMenuItem } from '../ui/menu'

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|[oa]d)/.test(navigator.platform)

/** ⌘(macOS)/ Ctrl(其它平台,CI 的 Linux WebKit)是否按下,与 ProseMirror 的 Mod 一致。 */
export function modPressed(event: MouseEvent | KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey
}

/**
 * 光标处若是没有定义的引用式链接原文([文字][标签]、[文字][]),给出 Typora 的提示原文
 * (模板「请按语法 [{1}]: www.example.com 定义链接 [{0}]」,{0} 为链接文字、{1} 为标签)。
 */
export function undefinedReferenceHint(text: string, offset: number): string | null {
  for (const m of text.matchAll(/\[([^[\]]+)\]\[([^[\]]*)\]/g)) {
    const start = m.index ?? 0
    if (offset >= start && offset <= start + m[0].length) return `请按语法 [${m[2] || m[1]}]: www.example.com 定义链接 [${m[1]}]`
  }
  return null
}

/** 坐标处的块(按 Notion 块的划分:列表项、整个折叠块、其余顶层块)。 */
function blockAtCoords(view: EditorView, x: number, y: number): number | null {
  const found = view.posAtCoords({ left: x, top: y })
  if (!found) return null
  if (found.inside >= 0) {
    const node = view.state.doc.nodeAt(found.inside)
    // 原子块与代码类块(内容在节点视图里)按整块处理
    if (node && node.isBlock && (node.isAtom || node.type.spec.code) && isSelectableBlock(node)) return found.inside
  }
  const block = blockAt(view.state.doc.resolve(found.pos))
  return block && isSelectableBlock(block.node) ? block.pos : null
}

/** 与纵向区间相交的顶层块(框选用)。 */
function topBlocksBetween(view: EditorView, top: number, bottom: number): number[] {
  const out: number[] = []
  view.state.doc.forEach((node, offset) => {
    if (!isSelectableBlock(node)) return
    const dom = view.nodeDOM(offset)
    if (!(dom instanceof HTMLElement)) return
    const r = dom.getBoundingClientRect()
    if (r.bottom >= top && r.top <= bottom) out.push(offset)
  })
  return out
}

/** 点击位置在正文文字栏的左右两侧(编辑区内边距或页面空白)。 */
function outsideTextColumn(view: EditorView, e: MouseEvent): boolean {
  const rect = view.dom.getBoundingClientRect()
  const style = getComputedStyle(view.dom)
  const left = rect.left + (Number.parseFloat(style.paddingLeft) || 0)
  const right = rect.right - (Number.parseFloat(style.paddingRight) || 0)
  return e.clientX < left || e.clientX > right
}

/** 空白处按下后拖动:画框并选中框到的块;没拖动就是普通点击(在编辑区内边距点击时把光标放到最近处)。 */
function startMarquee(view: EditorView, down: MouseEvent, inEditor: boolean): void {
  const x0 = down.clientX
  const y0 = down.clientY
  let box: HTMLDivElement | null = null
  const move = (e: MouseEvent) => {
    if (!box) {
      if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 5) return
      box = document.createElement('div')
      box.className = 'tz-marquee'
      document.body.append(box)
      view.focus()
    }
    const top = Math.min(y0, e.clientY)
    const bottom = Math.max(y0, e.clientY)
    box.style.left = `${Math.min(x0, e.clientX)}px`
    box.style.top = `${top}px`
    box.style.width = `${Math.abs(e.clientX - x0)}px`
    box.style.height = `${bottom - top}px`
    const positions = topBlocksBetween(view, top, bottom)
    if (positions.length) {
      const next = selectBlocks(view.state.doc, positions, positions[0], positions[positions.length - 1])
      if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next))
    }
    e.preventDefault()
  }
  const up = (e: MouseEvent) => {
    document.removeEventListener('mousemove', move, true)
    document.removeEventListener('mouseup', up, true)
    if (box) {
      box.remove()
      return
    }
    if (!inEditor) return
    const found = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!found) return
    view.focus()
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(found.pos))))
  }
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mouseup', up, true)
}

/** 块菜单「复制为 Markdown」:复制所选块(或光标所在块)的 Markdown 源码。 */
function copyBlocksMarkdown(view: EditorView, env: EditorEnv): boolean {
  const blocks = selectedBlocks(view.state)
  if (blocks.length === 0) return false
  const markdown = blocksToMarkdown(view.state.doc, blocks, env.settings.inlineMath)
  env.host.clipboardWrite({ text: markdown }).then(
    () => env.actions.notify('已复制为 Markdown'),
    (err: unknown) => env.actions.notify(`复制失败:${err instanceof Error ? err.message : String(err)}`, true),
  )
  return true
}

/** 块菜单「复制块链接」:标题块复制「文档相对路径#标题锚点」(notion-input.md 7.2;其他块没有 Markdown 锚点)。 */
function copyBlockLink(view: EditorView, env: EditorEnv): boolean {
  const block = selectedBlocks(view.state)[0]
  if (!block) return false
  // 折叠标题的锚点在标题行(块里第一个节点)上
  const headingPos = block.node.type === schema.nodes.toggle ? block.pos + 1 : block.pos
  const item = collectHeadings(view.state.doc).find((x) => x.pos === headingPos)
  if (!item) {
    env.actions.notify('只有标题块可以复制块链接', true)
    return false
  }
  const link = `${env.ctx.path ? markdownHref(basename(env.ctx.path)) : ''}#${item.id}`
  env.host.clipboardWrite({ text: link }).then(
    () => env.actions.notify(`已复制块链接:${link}`),
    (err: unknown) => env.actions.notify(`复制失败:${err instanceof Error ? err.message : String(err)}`, true),
  )
  return true
}

/** 块菜单 / 斜杠「移动到…」:选目标文档,把所选块追加到它末尾,再从当前文档删除(notion-input.md 4.2、7.2)。 */
async function moveBlocksTo(view: EditorView, env: EditorEnv): Promise<void> {
  const blocks = selectedBlocks(view.state)
  if (blocks.length === 0) return
  const fail = (what: string, err: unknown) => env.actions.notify(`${what}:${err instanceof Error ? err.message : String(err)}`, true)
  let docs: DocumentRef[]
  try {
    docs = await env.actions.listDocuments()
  } catch (err) {
    fail('读取文档列表失败', err)
    return
  }
  if (docs.length === 0) {
    env.actions.notify('没有可以移动到的文档:先保存当前文档或打开文件夹', true)
    return
  }
  const path = await pickMenuItem(
    docs.map((d) => ({ id: d.path, label: d.title, hint: d.dir, icon: '📄', keywords: [d.name, d.path] })),
    view.coordsAtPos(blocks[0].pos),
    '移动到…',
  )
  view.focus()
  if (!path) return
  const title = docs.find((d) => d.path === path)?.title ?? basename(path)
  try {
    await env.actions.appendToDocument(path, blocksToMarkdown(view.state.doc, blocks, env.settings.inlineMath))
  } catch (err) {
    fail(`移动到「${title}」失败`, err)
    return
  }
  if (removeBlocksIfUnchanged(view, env, blocks, title)) env.actions.notify(`已移动到「${title}」`)
}

/**
 * 块已写进目标文档后,从当前文档删除这些块。等待期间文档可能被改过:块原样未动才删除,
 * 否则如实提示并保留原块。返回是否已删除。
 */
export function removeBlocksIfUnchanged(view: EditorView, env: EditorEnv, blocks: readonly BlockInfo[], targetTitle: string): boolean {
  if (blocks.length === 0) return false
  if (!blocks.every((b) => view.state.doc.nodeAt(b.pos) === b.node)) {
    env.actions.notify(`已复制到「${targetTitle}」;当前文档在此期间有改动,原块未删除`, true)
    return false
  }
  const positions = blocks.map((b) => b.pos)
  view.dispatch(view.state.tr.setSelection(selectBlocks(view.state.doc, positions, positions[0], positions[positions.length - 1])))
  return deleteBlock(view.state, view.dispatch)
}

export function blockSelectionPlugin(env: EditorEnv): Plugin {
  setCodeIndentWidth(env.settings.codeIndentWidth ?? EDITOR_OPTION_DEFAULTS.codeIndentWidth)
  registerCommand({ id: 'block.copyMarkdown', label: '复制为 Markdown', run: (view) => copyBlocksMarkdown(view, env) })
  registerCommand({ id: 'block.copyLink', label: '复制块链接', run: (view) => copyBlockLink(view, env) })
  registerCommand({ id: 'block.moveTo', label: '移动到…', run: (view) => (void moveBlocksTo(view, env), true) })

  return new Plugin({
    props: {
      decorations(state) {
        const sel = state.selection
        if (!(sel instanceof BlockSelection)) return null
        return DecorationSet.create(
          state.doc,
          selectedBlocks(state).map((b) => Decoration.node(b.pos, b.pos + b.node.nodeSize, { class: 'ProseMirror-selectednode tz-block-selected' })),
        )
      },
      // 块选中态直接输入文字:不改动内容,退出块选中态(notion-input.md 7.4)
      handleKeyPress(view, event) {
        if (!isBlockSelected(view.state.selection)) return false
        if (event.ctrlKey || event.metaKey || !event.charCode || event.charCode === 13) return false
        const exit = exitBlockSelection(view.state)
        if (exit) view.dispatch(view.state.tr.setSelection(exit).scrollIntoView())
        return true
      },
      // 块选中态粘贴:插在所选块下方,不替换所选块(notion-input.md 7.4)
      handlePaste(view, event, slice) {
        const { state } = view
        if (!isBlockSelected(state.selection)) return false
        const data = event.clipboardData
        if (data && data.files.length > 0 && !data.getData('text/plain')) return false
        const blocks = selectedBlocks(state)
        const last = blocks[blocks.length - 1]
        if (!last || slice.size === 0) return false
        const end = last.pos + last.node.nodeSize
        const tr = state.tr.replaceRange(end, end, slice)
        const inserted = tr.doc.content.size - state.doc.content.size
        tr.setSelection(Selection.near(tr.doc.resolve(end + inserted), -1))
        view.dispatch(tr.scrollIntoView().setMeta('uiEvent', 'paste'))
        return true
      },
      // 未定义的引用式链接 ⌘+点击:提示定义语法(对照表 X-13)。没有定义时解析器不把它当链接,按原文 [文字][标签] 找
      handleClick(view, pos, event) {
        if (!modPressed(event)) return false
        const $pos = view.state.doc.resolve(pos)
        if (!$pos.parent.isTextblock || $pos.parent.type.spec.code || markRange($pos, schema.marks.link)) return false
        const hint = undefinedReferenceHint($pos.parent.textBetween(0, $pos.parent.content.size, undefined, '\ufffc'), $pos.parentOffset)
        if (!hint) return false
        env.actions.notify(hint, true)
        return true
      },
      handleDOMEvents: {
        mousedown(view, event) {
          if (event.button !== 0) return false
          if (event.shiftKey) {
            const clicked = blockAtCoords(view, event.clientX, event.clientY)
            if (clicked === null) return false
            const { state } = view
            let next: Selection | null
            if (modPressed(event)) next = toggleBlockSelection(state, clicked)
            else {
              // 文字编辑态在同一块里 ⇧+点击仍是扩展文字选区
              if (!isBlockSelected(state.selection) && blockAt(state.selection.$head)?.pos === clicked) return false
              next = shiftClickSelection(state, clicked)
            }
            if (!next) return false
            event.preventDefault()
            view.focus()
            view.dispatch(state.tr.setSelection(next))
            return true
          }
          // 编辑区左右内边距(正文左右空白)按下:框选
          if (event.target === view.dom && !event.metaKey && !event.ctrlKey && !event.altKey && outsideTextColumn(view, event)) {
            event.preventDefault()
            startMarquee(view, event, true)
            return true
          }
          return false
        },
      },
      // 按住 ⌥ 拖动为复制(notion-input.md 5.1 第 40 行);不按为移动
      dragCopies: (event) => event.altKey,
    },
    view(editorView) {
      // 编辑区外、页面左右空白(编辑区的祖先元素)按下:同样框选
      const onDown = (e: MouseEvent) => {
        if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
        const target = e.target
        if (!(target instanceof HTMLElement) || target === editorView.dom || !target.contains(editorView.dom)) return
        if (target === document.body || target === document.documentElement) return
        // 点在滚动条上不算
        if (e.offsetX >= target.clientWidth || e.offsetY >= target.clientHeight) return
        if (!outsideTextColumn(editorView, e)) return
        e.preventDefault()
        startMarquee(editorView, e, false)
      }
      document.addEventListener('mousedown', onDown)
      return {
        destroy: () => document.removeEventListener('mousedown', onDown),
      }
    },
  })
}
