// 编辑区右键菜单(对照表 C-01、C-03 ~ C-05、C-08 ~ C-12、C-14;notion-input 7.2「右键块空白处」)。
// 按右键位置给出:图片 / 媒体 / 公式 / 代码块与图表的专属操作,剪切拷贝粘贴、复制 / 粘贴为、内联样式、搜索、插入、跳转、块菜单。
// 按住 ⌥ 右键保留系统菜单(拼写建议、查询等系统能力)。
import type { Node as PMNode, NodeType } from 'prosemirror-model'
import { NodeSelection, Plugin, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { aiHooks } from '../ai/plugin'
import { type EditorEnv, localPathOf, openImageLightbox, resourceUrl } from '../core/env'
import { ZOOM_PRESETS, currentImage, deleteImage, setImageAttrs, zoomAttrs } from '../core/image-ops'
import { getCommand, runCommand } from '../core/registry'
import { schema } from '../core/schema'
import { FloatingMenu, type MenuItem } from '../ui/menu'
import { isDiagramLanguage } from '../views/diagram'
import { openPdfExternally, playerAt, togglePlayback } from './media-keys'

const n = schema.nodes

interface Hit {
  node: PMNode
  pos: number
  dom: HTMLElement
}

/** 右键所在的节点:按节点视图的 DOM 反查文档位置(比坐标换算可靠,也覆盖 CodeMirror 代码块里)。 */
function hitNode(view: EditorView, target: Element, selector: string, types: NodeType[]): Hit | null {
  const dom = target.closest<HTMLElement>(selector)
  if (!dom || !view.dom.contains(dom)) return null
  let hit: Hit | null = null
  view.state.doc.descendants((node, pos) => {
    if (hit) return false
    if (types.includes(node.type) && view.nodeDOM(pos) === dom) hit = { node, pos, dom }
    return !hit
  })
  return hit
}

/** 搜索引擎(对照表 C-12)。 */
export const SEARCH_ENGINES = [
  { id: 'google', label: '使用 Google 搜索', url: (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { id: 'bing', label: '使用 Bing 搜索', url: (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { id: 'baidu', label: '使用百度搜索', url: (q: string) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}` },
]

export function contextMenuPlugin(env: EditorEnv): Plugin {
  const menu = new FloatingMenu({ className: 'tz-context-menu' })
  return new Plugin({
    props: {
      handleKeyDown(_view, event) {
        if (!menu.isOpen) return false
        if (menu.handleKey(event)) {
          event.preventDefault()
          return true
        }
        menu.close('api')
        return false
      },
    },
    // 直接挂在编辑器根节点上:节点视图(媒体、代码块)会拦下交给编辑器的事件,右键也要能在它们上面弹出
    view(editorView) {
      const onContextMenu = (e: MouseEvent) => {
        if (e.altKey || !(e.target instanceof Element)) return
        e.preventDefault()
        const items = buildItems(editorView, env, e.target, e)
        if (items.length) menu.open(items, { left: e.clientX, top: e.clientY, bottom: e.clientY })
      }
      editorView.dom.addEventListener('contextmenu', onContextMenu)
      return {
        destroy() {
          editorView.dom.removeEventListener('contextmenu', onContextMenu)
          menu.close('api')
        },
      }
    },
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 右键点在选区之外时,先把光标移到点击处(与系统一致);点在选区里保留选区。 */
function placeCaret(view: EditorView, e: MouseEvent): void {
  const found = view.posAtCoords({ left: e.clientX, top: e.clientY })
  if (!found) return
  const { from, to, empty } = view.state.selection
  if (!empty && found.pos >= from && found.pos <= to) return
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(found.pos))))
}

function buildItems(view: EditorView, env: EditorEnv, target: Element, e: MouseEvent): MenuItem[] {
  const image = hitNode(view, target, '.tz-image', [n.image])
  const media = image ? null : hitNode(view, target, '.tz-media', [n.media])
  const math = image || media ? null : hitNode(view, target, '.tz-math-block, .tz-math-inline', [n.math_block, n.math_inline])
  const code = image || media || math ? null : hitNode(view, target, '.tz-code-block', [n.code_block])

  // 图片、媒体先选中整块,菜单里的命令作用于它
  if (image || media) {
    const pos = (image ?? media)!.pos
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)))
  } else if (!math && !code) {
    placeCaret(view, e)
  }

  const has = (id: string) => Boolean(getCommand(id))
  const command = (id: string, label: string, group: string, hint?: string): MenuItem | null =>
    has(id) ? { id: `ctx.${id}`, label, hint, group, run: () => (runCommand(view, id), view.focus()) } : null
  const items: (MenuItem | null)[] = []

  if (image) items.push(...imageItems(view, env, image))
  if (media) items.push(...mediaItems(view, env, media))
  if (math) items.push(...mathItems(view, env, math, command))
  if (code) items.push(...codeItems(view, env, code))

  const text = view.state.selection.empty ? '' : view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, ' ', ' ').trim()
  const edit = '编辑'
  items.push(
    { id: 'ctx.cut', label: '剪切', hint: '⌘X', group: edit, run: () => void document.execCommand('cut') },
    { id: 'ctx.copy', label: '拷贝', hint: '⌘C', group: edit, run: () => void document.execCommand('copy') },
    {
      id: 'ctx.paste',
      label: '粘贴',
      hint: '⌘V',
      group: edit,
      run: () => env.host.nativePaste().catch((err: unknown) => env.actions.notify(`粘贴失败:${errorText(err)}`, true)),
    },
    submenu('ctx.copyPasteAs', '复制 / 粘贴为', edit, [
      command('edit.copyPlain', '复制为纯文本', edit),
      command('edit.copyMarkdown', '复制为 Markdown', edit, '⇧⌘C'),
      command('edit.copyHtml', '复制为 HTML 代码', edit),
      command('edit.copySimplified', '复制内容并简化格式', edit),
      command('edit.pastePlain', '粘贴为纯文本', edit, '⇧⌘V'),
      command('edit.pasteMatchStyle', '粘贴并匹配样式', edit, '⌥⇧⌘V'),
    ]),
  )
  if (!image && !media && !code) {
    items.push(
      submenu('ctx.inlineStyle', '内联样式', edit, [
        command('format.bold', '加粗', edit, '⌘B'),
        command('format.italic', '斜体', edit, '⌘I'),
        command('format.underline', '下划线', edit, '⌘U'),
        command('format.strike', '删除线', edit, '⇧⌘S'),
        command('format.code', '行内代码', edit, '⌘E'),
        command('format.inlineMath', '行内公式', edit, '⇧⌘E'),
        command('format.highlight', '高亮', edit, '⌃⌘H'),
        command('format.superscript', '上标', edit),
        command('format.subscript', '下标', edit),
        command('insert.comment', '注释', edit, '⌃-'),
        command('format.link', '超链接', edit, '⌘K'),
        command('format.clear', '清除样式', edit, '⌘\\'),
      ]),
    )
  }
  if (text) {
    // AI 版:选中文字的 AI 动作(ai-prd 3.4「右键 AI ▸」)
    items.push(submenu('ctx.ai', 'AI', edit, aiHooks.selectionMenu?.(view) ?? []))
    items.push(
      submenu(
        'ctx.search',
        '搜索',
        edit,
        SEARCH_ENGINES.map((s) => ({
          id: `ctx.search.${s.id}`,
          label: s.label,
          group: edit,
          run: () => void env.host.openExternal(s.url(text)),
        })),
      ),
    )
  }

  const more = '插入与跳转'
  items.push(
    submenu('ctx.insert', '插入', more, [
      command('block.paragraphBefore', '段落(上方)', more),
      command('block.paragraphAfter', '段落(下方)', more),
      command('insert.image', '图片', more, '⌃⌘I'),
      command('insert.table', '表格', more, '⌥⇧⌘T'),
      command('insert.codeBlock', '代码块', more),
      command('insert.mathBlock', '公式块', more),
      command('insert.htmlBlock', 'HTML 内容', more),
      command('insert.callout', '标注块', more),
      command('insert.toggle', '折叠块', more),
      command('insert.divider', '分割线', more),
      command('insert.toc', '目录', more),
      command('insert.footnote', '脚注', more),
      command('insert.linkReference', '链接引用', more),
      command('insert.frontMatter', 'YAML Front Matter', more),
    ]),
    submenu('ctx.jump', '跳转到', more, jumpItems(view, target, more)),
  )
  // 块菜单由块手柄模块注册(命令 block.menu);未注册时不显示
  if (has('block.menu')) {
    items.push({
      id: 'ctx.blockMenu',
      label: '块菜单…',
      group: more,
      run: () => {
        runCommand(view, 'block.menu')
      },
    })
  }
  return items.filter((it): it is MenuItem => it !== null)
}

function submenu(id: string, label: string, group: string, children: (MenuItem | null)[]): MenuItem | null {
  const list = children.filter((c): c is MenuItem => c !== null)
  return list.length ? { id, label, group, children: () => list } : null
}

/** 图片:图像工具 ▸、在浏览器 / 默认应用中打开、删除图片(对照表 C-09、C-10)。 */
function imageItems(view: EditorView, env: EditorEnv, hit: Hit): (MenuItem | null)[] {
  const group = '图片'
  const src = hit.node.attrs.src as string
  const local = localPathOf(env, src)
  const has = (id: string) => Boolean(getCommand(id))
  const cmd = (id: string, label: string): MenuItem | null =>
    has(id) ? { id: `ctx.${id}`, label, group, run: () => (runCommand(view, id), view.focus()) } : null
  const tools = [
    cmd('image.copy', '拷贝图片'),
    local ? cmd('image.reveal', '打开图片位置') : null,
    submenu(
      'ctx.image.zoom',
      '缩放图片',
      group,
      ZOOM_PRESETS.map((z) => ({
        id: `ctx.image.zoom.${z}`,
        label: `缩放图片至 ${z}`,
        group,
        run: () => {
          const ref = currentImage(view.state)
          if (ref) setImageAttrs(view, ref.pos, zoomAttrs(z))
        },
      })),
    ),
    submenu('ctx.image.syntax', '转换图片语法', group, [cmd('image.toMarkdown', 'Markdown 格式'), cmd('image.toHtml', 'HTML 格式')]),
    cmd('image.replace', '替换图片…'),
    cmd('image.deleteFile', '删除图片文件…'),
    cmd('image.copyTo', '复制图片到…'),
    local ? cmd('image.moveTo', '重命名 / 移动图片到…') : null,
    cmd('image.upload', '上传图片'),
  ]
  return [
    { id: 'ctx.image.view', label: '查看大图', hint: '空格', group, run: () => openImageLightbox(view, env, { pos: hit.pos }) },
    submenu('ctx.image.tools', '图像工具', group, tools),
    local
      ? {
          id: 'ctx.image.open',
          label: '用默认应用打开',
          group,
          run: () => env.host.openWithDefaultApp(local).catch((err: unknown) => env.actions.notify(`打开图片失败:${errorText(err)}`, true)),
        }
      : { id: 'ctx.image.browser', label: '在浏览器中打开图片', group, run: () => void env.host.openExternal(resourceUrl(env, src)) },
    {
      id: 'ctx.image.delete',
      label: '删除图片',
      group,
      run: () => {
        const ref = currentImage(view.state)
        if (ref) deleteImage(view, ref.pos)
        view.focus()
      },
    },
  ]
}

/** 视频 / 音频:播放 / 暂停(对照表 C-11);PDF:用「预览」打开。 */
function mediaItems(view: EditorView, env: EditorEnv, hit: Hit): (MenuItem | null)[] {
  const kind = hit.node.attrs.kind as string
  const group = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '媒体'
  const items: (MenuItem | null)[] = []
  const player = playerAt(view, hit.pos)
  if (player) {
    items.push({ id: 'ctx.media.play', label: player.paused ? '播放' : '暂停', hint: '空格', group, run: () => void togglePlayback(view, env, hit.pos) })
  }
  if (kind === 'pdf') {
    items.push({ id: 'ctx.media.preview', label: '用「预览」打开', hint: '⌘↩', group, run: () => openPdfExternally(env, hit.node.attrs.src as string) })
  }
  items.push({
    id: 'ctx.media.delete',
    label: '删除',
    group,
    run: () => {
      const pos = currentPos(view, hit.node)
      if (pos !== null) view.dispatch(view.state.tr.delete(pos, pos + hit.node.nodeSize))
      view.focus()
    },
  })
  return items
}

/** 公式:复制为 TeX / MathML(命令由公式模块注册)、复制为图片、删除公式(对照表 C-05、C-07、C-08)。 */
function mathItems(
  view: EditorView,
  env: EditorEnv,
  hit: Hit,
  command: (id: string, label: string, group: string) => MenuItem | null,
): (MenuItem | null)[] {
  const group = '公式'
  // 公式命令作用于选中的公式:行内公式选中节点,公式块把光标放进去
  const sel = hit.node.type === n.math_inline ? NodeSelection.create(view.state.doc, hit.pos) : TextSelection.create(view.state.doc, hit.pos + 1)
  view.dispatch(view.state.tr.setSelection(sel))
  return [
    submenu('ctx.math.copy', '复制公式', group, [command('math.copyTex', '复制为 TeX 代码', group), command('math.copyMathML', '复制为 MathML', group)]),
    copyAsImageItem(env, hit, '.tz-math-preview', group),
    { id: 'ctx.math.delete', label: '删除公式', group, run: () => deleteNode(view, hit.node) },
  ]
}

/** 代码块:删除代码块;图表(mermaid 等)另有复制为图片、删除图表(对照表 C-05、C-08)。 */
function codeItems(view: EditorView, env: EditorEnv, hit: Hit): (MenuItem | null)[] {
  const diagram = isDiagramLanguage(hit.node.attrs.language as string)
  const group = diagram ? '图表' : '代码块'
  return [
    diagram ? copyAsImageItem(env, hit, '.tz-diagram-preview', group) : null,
    { id: diagram ? 'ctx.diagram.delete' : 'ctx.code.delete', label: diagram ? '删除图表' : '删除代码块', group, run: () => deleteNode(view, hit.node) },
  ]
}

/** 复制为图片:截取渲染结果所在区域。 */
function copyAsImageItem(env: EditorEnv, hit: Hit, previewSelector: string, group: string): MenuItem {
  return {
    id: 'ctx.copyAsImage',
    label: '复制为图片',
    group,
    run: () => {
      const el = hit.dom.querySelector<HTMLElement>(previewSelector) ?? hit.dom
      const r = el.getBoundingClientRect()
      env.host
        .copyRegionAsImage({ x: r.left, y: r.top, width: r.width, height: r.height })
        .catch((err: unknown) => env.actions.notify(`复制为图片失败:${errorText(err)}`, true))
    },
  }
}

function currentPos(view: EditorView, node: PMNode): number | null {
  let found: number | null = null
  view.state.doc.descendants((child, pos) => {
    if (found !== null) return false
    if (child === node) found = pos
    return found === null
  })
  return found
}

function deleteNode(view: EditorView, node: PMNode): void {
  const pos = currentPos(view, node)
  if (pos !== null) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView())
  view.focus()
}

/** 跳转到 ▸:文首、文末、所选内容;脚注引用 ↔ 脚注定义(对照表 C-14)。 */
function jumpItems(view: EditorView, target: Element, group: string): (MenuItem | null)[] {
  const jump = (sel: Selection) => {
    view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
    view.focus()
  }
  const items: (MenuItem | null)[] = [
    { id: 'ctx.jump.start', label: '文首', hint: '⌘↑', group, run: () => jump(Selection.atStart(view.state.doc)) },
    { id: 'ctx.jump.end', label: '文末', hint: '⌘↓', group, run: () => jump(Selection.atEnd(view.state.doc)) },
  ]
  if (getCommand('edit.jumpToSelection')) {
    items.push({ id: 'ctx.jump.selection', label: '所选内容', hint: '⌥⌘J', group, run: () => (runCommand(view, 'edit.jumpToSelection'), view.focus()) })
  }
  const ref = hitNode(view, target, 'sup.tz-footnote-ref', [n.footnote_ref])
  const def = ref ? null : hitNode(view, target, '.tz-footnote-def', [n.footnote_def])
  const label = (ref ?? def)?.node.attrs.label as string | undefined
  const to = label === undefined ? null : footnoteTarget(view.state.doc, label, ref ? 'definition' : 'reference')
  if (to !== null) {
    items.push({
      id: 'ctx.jump.footnote',
      label: ref ? '脚注定义' : '脚注引用',
      group,
      run: () => jump(TextSelection.near(view.state.doc.resolve(Math.min(to, view.state.doc.content.size)))),
    })
  }
  return items
}

/** 脚注定义的正文开头,或第一处引用之后。 */
function footnoteTarget(doc: PMNode, label: string, want: 'definition' | 'reference'): number | null {
  let to: number | null = null
  doc.descendants((node, pos) => {
    if (to !== null) return false
    if (want === 'definition' && node.type === n.footnote_def && node.attrs.label === label) to = pos + 2
    if (want === 'reference' && node.type === n.footnote_ref && node.attrs.label === label) to = pos + node.nodeSize
    return to === null
  })
  return to
}
