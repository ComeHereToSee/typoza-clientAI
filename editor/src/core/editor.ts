// 组装编辑器:节点视图 + 插件。插件顺序有讲究:弹出菜单的按键处理排在快捷键前面,输入规则排在自动配对前面。
import { dropCursor } from 'prosemirror-dropcursor'
import { gapCursor } from 'prosemirror-gapcursor'
import { history } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Fragment, type Node as PMNode } from 'prosemirror-model'
import { type Command, EditorState, type Plugin, type Transaction } from 'prosemirror-state'
import { tableEditing } from 'prosemirror-tables'
import { EditorView } from 'prosemirror-view'
import { aiPlugin } from '../ai/plugin'
import { autoPairPlugin, editingPlugin, placeholderPlugin, tocRefreshPlugin, viewModesPlugin } from '../plugins/basics'
import { copyLinePlugin, markdownPairsPlugin } from '../plugins/editing-prefs'
import { blockSelectionPlugin } from '../plugins/blockselect'
import { emojiShortcodePlugin } from '../plugins/emoji-shortcodes'
import { findPlugin } from '../plugins/find'
import { blockHandlePlugin } from '../plugins/handle'
import { pastePlugin } from '../plugins/paste'
import { slashPlugin } from '../plugins/slash'
import { suggestPlugin } from '../plugins/suggest'
import { markdownMarkersPlugin } from '../plugins/markers'
import { smartPunctuationRenderPlugin } from '../plugins/smart-punctuation'
import { TABLE_KEYS, tableToolbarPlugin } from '../plugins/table'
import { toolbarPlugin } from '../plugins/toolbar'
import { viewportPlugin } from '../plugins/viewport'
import { contextMenuPlugin } from '../plugins/contextmenu'
import { displayPlugin } from '../plugins/display'
import { mediaKeysPlugin } from '../plugins/media-keys'
import {
  FootnoteRefView,
  FrontMatterView,
  HtmlBlockView,
  HtmlInlineView,
  ListItemView,
  TocView,
  ToggleView,
  WikiLinkView,
} from '../views/blocks'
import { CodeBlockView, codeBlockArrowHandler } from '../views/codeblock'
import { ImageView } from '../views/image'
import { MathBlockView, MathInlineView, mathPlugin } from '../views/math'
import { MediaView } from '../views/media'
import { isUiOnly, markRange } from './commands'
import { type EditorEnv, openImageLightbox } from './env'
import { buildInputRules } from './inputrules'
import { buildKeymaps } from './keymap'
import { openHref } from './links'
import type { DocMeta } from './markdown/parse'
import { serializeBlocks } from './markdown/serialize'
import { runCommand } from './registry'
import { schema } from './schema'
import { isImageSelected } from './selection-commands'

export interface EditorCallbacks {
  /** 用户修改了文档(不含展开折叠等纯界面变化) */
  onDocChange(view: EditorView, tr: Transaction): void
  /** 选区或文档变化后(大纲高亮、字数统计) */
  onUpdate?(view: EditorView): void
}

const DEFAULT_META: DocMeta = { lineEnding: '\n', bom: false, leading: '', trailing: '\n', bullet: '-' }

/** 选区 → Markdown 文本(复制时写入纯文本剪贴板,粘贴到别处就是 Markdown)。 */
export function sliceToMarkdown(content: Fragment, env: EditorEnv): string {
  const blocks: PMNode[] = []
  let inline: PMNode[] = []
  const flush = () => {
    if (inline.length) blocks.push(schema.nodes.paragraph.create(null, inline))
    inline = []
  }
  content.forEach((node) => {
    if (node.isInline) inline.push(node)
    else if (node.type === schema.nodes.table_row || node.type === schema.nodes.table_cell || node.type === schema.nodes.table_header) {
      flush()
      blocks.push(schema.nodes.paragraph.create(null, node.isTextblock ? node.content : null))
    } else if (node.type === schema.nodes.list_item) {
      flush()
      blocks.push(schema.nodes.bullet_list.create(null, node))
    } else {
      flush()
      blocks.push(node)
    }
  })
  flush()
  return serializeBlocks(blocks, DEFAULT_META, { inlineMath: env.settings.inlineMath, ensureTrailingNewline: false }).replace(/\n+$/, '')
}

function extraKeys(env: EditorEnv): Record<string, Command> {
  return {
    // 图片选中时按空格:全屏查看(Notion)
    Space: (state, _dispatch, view) => {
      if (!view || !isImageSelected(state.selection)) return false
      openImageLightbox(view, env, { pos: state.selection.from })
      return true
    },
    // ⌘↩ 修改当前块:图片 → 灯箱;光标在文档链接上 → 打开;其余交给 block.modify
    'Mod-Enter': (state, _dispatch, view) => {
      if (!view) return false
      if (isImageSelected(state.selection)) {
        openImageLightbox(view, env, { pos: state.selection.from })
        return true
      }
      const link = markRange(state.selection.$from, schema.marks.link)
      if (link && state.selection.empty && /\.(md|markdown)(#.*)?$/i.test(link.mark.attrs.href)) {
        openHref(view, env, link.mark.attrs.href, false)
        return true
      }
      return false
    },
    ArrowLeft: codeBlockArrowHandler('left'),
    ArrowRight: codeBlockArrowHandler('right'),
    ArrowUp: codeBlockArrowHandler('up'),
    ArrowDown: codeBlockArrowHandler('down'),
  }
}

function tableKeys(): Record<string, Command> {
  const out: Record<string, Command> = {}
  for (const [key, id] of Object.entries(TABLE_KEYS)) {
    out[key] = (_s, _d, view) => (view ? runCommand(view, id) : false)
  }
  return out
}

export function buildPlugins(env: EditorEnv): Plugin[] {
  return [
    // 块选中态的输入拦截、粘贴到下方要先于斜杠、表情与粘贴插件
    blockSelectionPlugin(env),
    // AI 版:AI 卡片与差异预览的装饰、空行按空格唤起 AI、AI 菜单打开时的按键
    aiPlugin(),
    slashPlugin(env),
    suggestPlugin(env),
    pastePlugin(env),
    copyLinePlugin(env),
    toolbarPlugin(env),
    findPlugin(),
    // 匹配 Markdown 字符要先于输入规则处理收尾符号
    markdownPairsPlugin(env),
    // 右键菜单(打开时接管方向键与回车)、媒体选中时的空格 / ⌘↩、「空格与换行」显示选项
    contextMenuPlugin(env),
    mediaKeysPlugin(env),
    displayPlugin(),
    buildInputRules({ smartPunctuation: env.settings.smartPunctuation }),
    autoPairPlugin(env),
    keymap(extraKeys(env)),
    keymap(tableKeys()),
    ...buildKeymaps(env.settings.keybindings),
    history(),
    dropCursor({ class: 'tz-drop-cursor', width: 3 }),
    gapCursor(),
    tableEditing(),
    placeholderPlugin(),
    emojiShortcodePlugin(),
    editingPlugin(),
    markdownMarkersPlugin(env),
    smartPunctuationRenderPlugin(env),
    tocRefreshPlugin(),
    viewModesPlugin(),
    blockHandlePlugin(env),
    // 大文档只排版视口附近的块(顶层块少时不启用)
    viewportPlugin(),
    tableToolbarPlugin(),
    mathPlugin(env),
  ]
}

export function createEditorState(doc: PMNode, env: EditorEnv): EditorState {
  return EditorState.create({ doc, plugins: buildPlugins(env) })
}

export function createEditorView(mount: HTMLElement, state: EditorState, env: EditorEnv, callbacks: EditorCallbacks): EditorView {
  const view: EditorView = new EditorView(mount, {
    state,
    attributes: () => ({
      // id="write" 与 Typora 主题的选择器一致,用户自带的 Typora 主题能部分生效
      id: 'write',
      class: 'tz-editor',
      spellcheck: env.settings.spellcheck ? 'true' : 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
    }),
    nodeViews: {
      code_block: (node, v, getPos) => new CodeBlockView(node, v, getPos, env),
      math_block: (node, v, getPos) => new MathBlockView(node, v, getPos, env),
      math_inline: (node, v, getPos) => new MathInlineView(node, v, getPos, env),
      image: (node, v, getPos) => new ImageView(node, v, getPos, env),
      media: (node, v, getPos) => new MediaView(node, v, getPos, env),
      toggle: (node, v, getPos) => new ToggleView(node, v, getPos),
      list_item: (node, v, getPos) => new ListItemView(node, v, getPos),
      toc: (_node, v) => new TocView(v),
      html_block: (node, v, getPos) => new HtmlBlockView(node, v, getPos, env),
      html_inline: (node) => new HtmlInlineView(node, env),
      frontmatter: () => new FrontMatterView(),
      footnote_ref: (node, v) => new FootnoteRefView(node, v, env),
      wikilink: (node) => new WikiLinkView(node, env),
    },
    // 偏好 PE-05:纯文本剪贴板写 Markdown 源码,或只写文字
    clipboardTextSerializer: (slice) =>
      env.settings.copyPlainAsMarkdown ? sliceToMarkdown(slice.content, env) : slice.content.textBetween(0, slice.content.size, '\n\n'),
    dispatchTransaction(tr) {
      const next = view.state.apply(tr)
      view.updateState(next)
      if (tr.docChanged && !isUiOnly(tr)) callbacks.onDocChange(view, tr)
      callbacks.onUpdate?.(view)
    },
  })
  return view
}
