// 媒体块视图:本地/在线视频与音频、在线嵌入(YouTube、B 站……)、PDF 内嵌、书签卡片、附件。
// 失败处理按 PRD 3.5:媒体文件丢失、嵌入离线或被拒、书签取不到网页信息都有明确提示。
import type { Node as PMNode } from 'prosemirror-model'
import { NodeSelection } from 'prosemirror-state'
import type { EditorView, NodeView } from 'prosemirror-view'
import { isVideoEmbed, providerName } from '../core/embed'
import { type EditorEnv, frameSandbox, localPathOf, resourceUrl } from '../core/env'
import { basename } from '../core/paths'
import { ICONS, h, svgIcon } from '../ui/dom'
import type { EmbedCheck, LinkPreview } from '../host/types'

const previewCache = new Map<string, Promise<LinkPreview | null>>()
const embedChecks = new Map<string, Promise<EmbedCheck>>()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 取到的网页信息是否可用:LinkPreview 取不到标题时会退回网址本身。 */
function usablePreview(p: LinkPreview | null, src: string): LinkPreview | null {
  const title = p?.title.trim() ?? ''
  return p && title && title !== src ? p : null
}

export class MediaView implements NodeView {
  dom: HTMLElement
  private body: HTMLElement

  constructor(
    private node: PMNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly env: EditorEnv,
  ) {
    this.body = h('div', { class: 'tz-media-body' })
    const toolbar = this.buildToolbar()
    this.dom = h('div', { class: 'tz-media', contenteditable: 'false' }, this.body, toolbar)
    this.render()
  }

  private select(): void {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)))
    // 焦点留在工具条按钮上时,按键事件落在节点视图内部、编辑器不处理
    this.view.focus()
  }

  private buildToolbar(): HTMLElement {
    const btn = (icon: string, title: string, run: () => void) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tz-media-tool',
          title,
          onmousedown: ((e: Event) => e.preventDefault()) as EventListener,
          onclick: ((e: Event) => {
            e.stopPropagation()
            run()
          }) as EventListener,
        },
        svgIcon(icon, 14),
      )
    return h(
      'div',
      { class: 'tz-media-toolbar' },
      btn(ICONS.grip, '选中此块', () => this.select()),
      btn(ICONS.external, '打开', () => this.open()),
      btn(ICONS.finder, '在 Finder 中显示', () => {
        const p = localPathOf(this.env, this.node.attrs.src)
        if (p) void this.env.host.revealInFinder(p)
      }),
      btn(ICONS.trash, '删除', () => {
        const pos = this.getPos()
        if (pos !== undefined) this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize))
      }),
    )
  }

  private open(): void {
    const src = this.node.attrs.src as string
    const local = localPathOf(this.env, src)
    if (local) void this.env.host.openWithDefaultApp(local)
    else void this.env.host.openExternal(src)
  }

  private render(): void {
    const a = this.node.attrs
    const kind = a.kind as string
    this.dom.dataset.kind = kind
    this.dom.classList.remove('is-broken', 'tz-embed-failed')
    this.dom.classList.toggle('is-local', localPathOf(this.env, a.src) !== null)
    this.body.replaceChildren()
    const url = resourceUrl(this.env, a.src)
    switch (kind) {
      case 'video': {
        const video = h('video', { src: url, controls: true, preload: 'metadata', playsinline: true })
        if (a.width) video.style.width = /^\d+$/.test(a.width) ? `${a.width}px` : a.width
        video.addEventListener('error', () => this.playbackFailed('视频无法播放'))
        this.body.append(video)
        this.checkLocalFile()
        break
      }
      case 'audio': {
        const audio = h('audio', { src: url, controls: true, preload: 'metadata' })
        audio.addEventListener('error', () => this.playbackFailed('音频无法播放'))
        this.body.append(h('div', { class: 'tz-audio-name' }, a.title || basename(a.src)), audio)
        this.checkLocalFile()
        break
      }
      case 'embed': {
        const frame = h('iframe', {
          src: url,
          loading: 'lazy',
          allowfullscreen: true,
          allow: 'fullscreen; picture-in-picture; encrypted-media; clipboard-write; autoplay',
          referrerpolicy: 'strict-origin-when-cross-origin',
          // 第三方页面:允许脚本与同源(播放器需要),禁止顶层跳转。本地网页不给同源:
          // typoza://local 下所有文件同源,带着它跑脚本就能读走本机任意文件(PRD 3.5)
          sandbox: frameSandbox(url),
          title: providerName(a.src),
        })
        const wrap = h('div', { class: isVideoEmbed(a.src) ? 'tz-embed tz-embed-video' : 'tz-embed' }, frame)
        if (!isVideoEmbed(a.src) && a.height) wrap.style.height = /^\d+$/.test(a.height) ? `${a.height}px` : a.height
        this.body.append(wrap, h('div', { class: 'tz-embed-caption' }, providerName(a.src)))
        this.checkEmbed(a.src)
        break
      }
      case 'pdf': {
        const frame = h('iframe', { src: url, class: 'tz-pdf', title: a.title || basename(a.src) })
        if (a.height) frame.style.height = /^\d+$/.test(a.height) ? `${a.height}px` : a.height
        this.body.append(frame, h('div', { class: 'tz-embed-caption' }, a.title || basename(a.src)))
        this.checkLocalFile()
        break
      }
      case 'bookmark':
        this.renderBookmark()
        break
      case 'file':
        this.renderFile()
        break
      default:
        this.showError(`未知媒体类型:${kind}`)
    }
  }

  /**
   * 错误提示:detail 是原路径等补充信息,actions 是可点的按钮。
   * replace 为 true 时替换掉播放器 / 预览(文件丢失、嵌入失败);否则附在下方(文件在但播放失败,播放器留着可重试)。
   */
  private showError(message: string, detail?: string, actions: HTMLElement[] = [], replace = true): void {
    this.dom.classList.add('is-broken')
    const box = h(
      'div',
      { class: 'tz-media-error' },
      h('div', { class: 'tz-media-error-title' }, message),
      detail ? h('div', { class: 'tz-media-error-detail' }, detail) : null,
      actions.length ? h('div', { class: 'tz-media-error-actions' }, ...actions) : null,
    )
    if (replace) {
      this.body.replaceChildren(box)
      return
    }
    this.body.querySelector('.tz-media-error')?.remove()
    this.body.append(box)
  }

  /** 本机媒体文件丢失时显示「找不到媒体文件」与原路径(PRD 3.5 视频与音频)。 */
  private checkLocalFile(): void {
    const src = this.node.attrs.src as string
    const local = localPathOf(this.env, src)
    if (!local) return
    void this.env.host.stat(local).then((s) => {
      if (!s && this.node.attrs.src === src) this.showError('找不到媒体文件', src)
    })
  }

  private playbackFailed(message: string): void {
    const src = this.node.attrs.src as string
    const local = localPathOf(this.env, src)
    if (!local) {
      this.showError(message, src, [], false)
      return
    }
    void this.env.host.stat(local).then((s) => {
      if (this.node.attrs.src !== src) return
      if (s) this.showError(message, src, [], false)
      else this.showError('找不到媒体文件', src)
    })
  }

  // ---------- 在线嵌入:离线或站点拒绝时降级(PRD 3.5 在线嵌入、notion-input 三) ----------

  private checkEmbed(src: string): void {
    if (!navigator.onLine) {
      this.showEmbedFailure(src, 'unreachable')
      return
    }
    let pending = embedChecks.get(src)
    if (!pending) {
      pending = this.env.host.checkEmbed(src).catch((): EmbedCheck => 'unreachable')
      embedChecks.set(src, pending)
    }
    void pending.then((result) => {
      // 连不上的结果不缓存:网络恢复后重新打开文档会再试
      if (result === 'unreachable') embedChecks.delete(src)
      if (result === 'ok' || this.node.attrs.kind !== 'embed' || this.node.attrs.src !== src) return
      this.showEmbedFailure(src, result)
    })
  }

  private showEmbedFailure(src: string, result: 'refused' | 'unreachable'): void {
    const action = (label: string, run: () => void) => {
      const b = h('button', { type: 'button', class: 'tz-media-action' }, label)
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        run()
      })
      return b
    }
    this.showError('无法加载嵌入内容', result === 'refused' ? '该网站不允许嵌入,可改为书签卡片' : src, [
      action('在浏览器中打开', () => void this.env.host.openExternal(src)),
      action('改为书签', () => this.convertToBookmark()),
    ])
    this.dom.classList.add('tz-embed-failed')
  }

  /** 【改为书签】:同一网址换成书签卡片,标题留空,由书签视图取网页信息后写回。 */
  private convertToBookmark(): void {
    const pos = this.getPos()
    if (pos === undefined) return
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, kind: 'bookmark', title: '', description: '', width: null, height: null, html: null }),
    )
  }

  // ---------- 书签卡片 ----------

  private renderBookmark(): void {
    const a = this.node.attrs
    const src = a.src as string
    // 标题为空 = 刚插入、还没取过网页信息(已存进文件的书签链接文字至少是网址)
    const fresh = !a.title
    const title = h('div', { class: 'tz-bookmark-title' }, a.title || src)
    const desc = h('div', { class: 'tz-bookmark-desc' }, a.description || (fresh ? '正在获取网页信息…' : ''))
    const link = h('div', { class: 'tz-bookmark-url' }, src)
    const thumb = h('div', { class: 'tz-bookmark-thumb', hidden: true })
    const card = h('a', { class: 'tz-bookmark', href: src, title: src }, h('div', { class: 'tz-bookmark-text' }, title, desc, link), thumb)
    card.addEventListener('click', (e) => {
      e.preventDefault()
      void this.env.host.openExternal(src)
    })
    this.body.append(card)
    let pending = previewCache.get(src)
    if (!pending) {
      pending = this.env.host.fetchLinkPreview(src).catch(() => null)
      previewCache.set(src, pending)
    }
    void pending.then((raw) => {
      if (this.node.attrs.src !== src || this.node.attrs.kind !== 'bookmark') return
      const p = usablePreview(raw, src)
      if (fresh) {
        this.writeBack(src, p)
        return
      }
      if (!p) return
      // 文件里已存的书签:只补显示,不改文件
      if (!this.node.attrs.description && p.description) desc.textContent = p.description
      if (p.icon) link.prepend(h('img', { class: 'tz-bookmark-icon', src: p.icon, alt: '' }))
      if (p.image) {
        thumb.hidden = false
        thumb.append(h('img', { src: p.image, alt: '', loading: 'lazy' }))
      }
    })
  }

  /**
   * 新书签取到网页信息后写回文档:标题成为链接文字,描述写进 title 属性(PRD 3.5 书签卡片)。
   * 取不到时用网址作标题并提示。写回不进撤销历史:⌘Z 直接撤掉插入书签这一步。
   */
  private writeBack(src: string, info: LinkPreview | null): void {
    const pos = this.getPos()
    if (pos === undefined) return
    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type !== this.node.type || node.attrs.src !== src || node.attrs.title) return
    const title = info ? info.title.trim() : src
    const description = info ? info.description.replace(/\s+/g, ' ').trim() : ''
    const tr = this.view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, title, description, html: null })
    this.view.dispatch(tr.setMeta('addToHistory', false))
    if (!info) this.env.actions.notify('无法获取网页信息,已用网址作标题')
  }

  private renderFile(): void {
    const src = this.node.attrs.src as string
    const name = this.node.attrs.title || basename(src)
    const meta = h('span', { class: 'tz-file-meta' })
    const card = h('div', { class: 'tz-file-card', title: src }, svgIcon(ICONS.file, 20), h('span', { class: 'tz-file-name' }, name), meta)
    card.addEventListener('click', () => this.open())
    this.body.append(card)
    const local = localPathOf(this.env, src)
    if (local) {
      void this.env.host.stat(local).then((s) => {
        meta.textContent = s ? formatSize(s.size) : '文件不存在'
        card.classList.toggle('is-missing', !s)
      })
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false
    const a = node.attrs
    const b = this.node.attrs
    const same = a.kind === b.kind && a.src === b.src && a.title === b.title && a.description === b.description
    this.node = node
    if (!same) this.render()
    return true
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode')
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode')
  }

  // 播放器、卡片、工具条上的操作都交给它们自己,编辑器不接管
  stopEvent(e: Event): boolean {
    return e.type !== 'dragstart' && e.type !== 'drop'
  }

  ignoreMutation(): boolean {
    return true
  }
}
