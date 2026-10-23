// 侧栏(Typora):文件树 / 文档列表 / 大纲,外加全局搜索。文件夹变化由宿主监听后推送刷新。
// 文件操作(新建、重命名、副本、移动、废纸篓、属性、撤销)见 fileops.ts。
import type { HeadingItem } from '../core/blocks'
import type { OpenWhere } from '../core/env'
import { excerptOf } from '../core/excerpt'
import { bundleOf, displayName, isOpenable, isTextBundle } from '../core/filetypes'
import { basename, dirname, joinPath } from '../core/paths'
import type { FileStat, Host, SearchHit } from '../host/types'
import { buildPattern, type FindOptions } from '../plugins/find'
import { BLOCK_DRAG_TYPE, moveDraggedBlocks } from '../plugins/handle'
import { DRAG_PATH_TYPE } from '../plugins/linkcard'
import { h } from '../ui/dom'
import { FloatingMenu, type MenuItem } from '../ui/menu'
import { type FileOps, type FolderLists, forgetFolder, formatTime, loadFolders, noteRecentFolder, setFolderPinned } from './fileops'
import { openWhereOf } from './navigation'

export type SidebarTab = 'files' | 'list' | 'outline' | 'search'

export type SearchFlags = Pick<FindOptions, 'caseSensitive' | 'wholeWord' | 'regex'>

export interface SidebarCallbacks {
  openFile(path: string, where: OpenWhere): void
  /** 全局搜索结果:打开文件并定位到命中行(PRD 3.9) */
  openAt(path: string, line: number, query: string, flags: SearchFlags): void
  jumpToHeading(item: HeadingItem): void
  currentPath(): string | null
  onTabChange(tab: SidebarTab): void
  onError(message: string): void
  /** 云同步文件夹里的文件状态(PRD 3.8 同步标记);不在同步文件夹里返回 null */
  syncBadge?(path: string, mtime: number, isDir: boolean): { state: string; label: string } | null
  ops: FileOps
}

/** 文档列表最多显示的文件数,超过时提示切到文件树(对照表 S-03) */
const MAX_LIST = 500
/** 全局搜索:每批搜多少个文件(边搜边显示),命中超过多少处提示「匹配结果过多」(PRD 3.9【假设:上限】) */
const SEARCH_BATCH = 200
export const MAX_SEARCH_MATCHES = 1000

export type ListSort = 'natural' | 'name' | 'mtime' | 'ctime'

/** 文档列表的排序与分组;存在偏好设置文件里(键 docListSort、docListSortDesc、docListGroup),重启后保留(对照表 S-04、S-05) */
interface ListPrefs {
  sort: ListSort
  desc: boolean
  group: boolean
}

const SORTS: { id: ListSort; label: string }[] = [
  { id: 'natural', label: '自然排序' },
  { id: 'name', label: '按文件名' },
  { id: 'mtime', label: '按修改时间' },
  { id: 'ctime', label: '按创建时间' },
]

/** 文档列表排序:自然排序按相对路径、数字按数值比较(与 Finder 一致);按文件名逐字比较;时间按毫秒。 */
export function sortFiles(stats: FileStat[], by: ListSort, desc: boolean, root: string): FileStat[] {
  const rel = (s: FileStat) => (s.path.startsWith(`${root}/`) ? s.path.slice(root.length + 1) : s.path)
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const cmp: Record<ListSort, (a: FileStat, b: FileStat) => number> = {
    natural: (a, b) => rel(a).localeCompare(rel(b), 'zh-CN', { numeric: true }),
    name: (a, b) => byName(a.name, b.name) || byName(rel(a), rel(b)),
    mtime: (a, b) => a.mtime - b.mtime,
    ctime: (a, b) => (a.ctime ?? a.mtime) - (b.ctime ?? b.mtime),
  }
  const f = cmp[by]
  return [...stats].sort((a, b) => (desc ? f(b, a) : f(a, b)))
}

export interface OutlineRow {
  item: HeadingItem
  index: number
  depth: number
  hasChildren: boolean
  hidden: boolean
}

/** 大纲的层级与折叠(对照表 S-01、X-48):折叠了的标题,其下级标题都隐藏。 */
export function outlineRows(headings: HeadingItem[], collapsed: Set<string>): OutlineRow[] {
  if (headings.length === 0) return []
  const min = Math.min(...headings.map((x) => x.level))
  const stack: { level: number; collapsed: boolean }[] = []
  return headings.map((item, index) => {
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop()
    const hidden = stack.some((s) => s.collapsed)
    const hasChildren = index + 1 < headings.length && headings[index + 1].level > item.level
    stack.push({ level: item.level, collapsed: hasChildren && collapsed.has(item.id) })
    return { item, index, depth: item.level - min, hasChildren, hidden }
  })
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error ?? new Error(`读取失败:${file.name}`))
    reader.readAsDataURL(file)
  })
}

export class Sidebar {
  readonly el: HTMLElement
  private readonly body: HTMLDivElement
  private readonly tabs: Record<SidebarTab, HTMLButtonElement>
  private tab: SidebarTab = 'files'
  private root: string | null = null
  private readonly expanded = new Set<string>()
  private headings: HeadingItem[] = []
  private activeHeading = -1
  private readonly collapsedHeadings = new Set<string>()
  private outlineCollapsible = true
  private searchInput: HTMLInputElement | null = null
  private searchFlags: SearchFlags = { caseSensitive: false, wholeWord: false, regex: false }
  private searchSeq = 0
  private readonly excerpts = new Map<string, string>()
  private excerptObserver: IntersectionObserver | null = null
  private readonly menu = new FloatingMenu({ className: 'tz-context-menu' })
  private renderSeq = 0

  constructor(
    private readonly host: Host,
    private readonly cb: SidebarCallbacks,
  ) {
    const tab = (id: SidebarTab, label: string, title: string) => {
      const b = h('button', { type: 'button', class: 'tz-side-tab', title, 'data-tab': id }, label)
      b.addEventListener('click', () => void this.setTab(id))
      return b
    }
    this.tabs = {
      files: tab('files', '文件', '文件树(⌃⌘3)'),
      list: tab('list', '文档', '文档列表(⌃⌘2)'),
      outline: tab('outline', '大纲', '大纲(⌃⌘1)'),
      search: tab('search', '搜索', '全局搜索(⇧⌘F)'),
    }
    this.body = h('div', { class: 'tz-side-body' })
    // tabindex:点侧栏后焦点留在侧栏,⌘Z 撤销上一次文件操作(对照表 S-20)
    this.el = h('aside', { class: 'tz-sidebar', tabindex: '-1' }, h('div', { class: 'tz-side-tabs' }, ...Object.values(this.tabs)), this.body)
    this.el.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && this.cb.ops.canUndo) {
        e.preventDefault()
        void this.cb.ops.undo()
      }
    })
    this.host.getSettings().then(
      (s) => {
        // 偏好「允许折叠和展开侧边栏的大纲视图」(对照表 PF-02),默认开
        this.outlineCollapsible = s.outlineCollapsible !== false
      },
      (err: unknown) => this.cb.onError(`读取偏好设置失败:${errText(err)}`),
    )
  }

  get currentTab(): SidebarTab {
    return this.tab
  }

  setTab(tab: SidebarTab): Promise<void> {
    this.tab = tab
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('is-active', k === tab)
    this.cb.onTabChange(tab)
    const done = this.render()
    if (tab === 'search') requestAnimationFrame(() => this.searchInput?.focus())
    return done
  }

  setRoot(root: string | null): void {
    if (root === this.root) return
    this.root = root
    if (root) {
      this.expanded.add(root)
      void this.host.watch([root])
      noteRecentFolder(this.host, root).catch((err: unknown) => this.cb.onError(`记录最近使用的目录失败:${errText(err)}`))
    }
    void this.render()
  }

  get rootFolder(): string | null {
    return this.root
  }

  setHeadings(headings: HeadingItem[], active: number): void {
    const changed = headings.length !== this.headings.length || headings.some((x, i) => x.text !== this.headings[i]?.text || x.level !== this.headings[i]?.level)
    this.headings = headings
    const activeChanged = active !== this.activeHeading
    this.activeHeading = active
    if (this.tab !== 'outline') return
    if (changed) void this.render()
    else if (activeChanged) this.highlightOutline()
  }

  /** 偏好「允许折叠和展开侧边栏的大纲视图」改了:当场重画大纲(对照表 PF-02) */
  setOutlineCollapsible(collapsible: boolean): void {
    if (collapsible === this.outlineCollapsible) return
    this.outlineCollapsible = collapsible
    if (this.tab === 'outline') void this.render()
  }

  /** 文件变化后刷新(文件树、文档列表)。 */
  refresh(): void {
    if (this.tab === 'files' || this.tab === 'list') void this.render()
  }

  /** 同步状态变了:就地更新文件树上的同步标记,不重读目录。 */
  updateSyncBadges(): void {
    for (const row of Array.from(this.body.querySelectorAll<HTMLElement>('[data-sync]'))) {
      row.querySelector('.tz-tree-sync')?.remove()
      const badge = this.syncBadge(row.dataset.path ?? '', Number(row.dataset.mtime), row.dataset.dir === 'true')
      if (badge) row.append(badge)
    }
  }

  private syncBadge(path: string, mtime: number, isDir: boolean): HTMLElement | null {
    const b = this.cb.syncBadge?.(path, mtime, isDir)
    if (!b) return null
    const glyph: Record<string, string> = { synced: '✓', pending: '↑', syncing: '↻', error: '!' }
    return h('span', { class: `tz-tree-sync is-${b.state}`, title: b.label, 'aria-label': b.label }, glyph[b.state] ?? '')
  }

  /** 当前文档在侧栏里的条目(TextBundle 包里的正文对应包本身) */
  private currentEntry(): string | null {
    const cur = this.cb.currentPath()
    return cur ? (bundleOf(cur) ?? cur) : null
  }

  markCurrent(): void {
    const cur = this.currentEntry()
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>('[data-path]'))) el.classList.toggle('is-current', el.dataset.path === cur)
  }

  /** 在文件树中显示(对照表 F-11、S-13):切到文件树、展开上级文件夹并滚到该文件。 */
  async revealInTree(path: string): Promise<void> {
    const entry = bundleOf(path) ?? path
    if (!this.root || !entry.startsWith(`${this.root}/`)) this.setRoot(dirname(entry))
    const root = this.root ?? dirname(entry)
    for (let d = dirname(entry); d.startsWith(`${root}/`); d = dirname(d)) this.expanded.add(d)
    await this.setTab('files')
    this.flash(entry)
  }

  /** 在文档列表中显示(对照表 F-10) */
  async revealInList(path: string): Promise<void> {
    const entry = bundleOf(path) ?? path
    if (!this.root || !entry.startsWith(`${this.root}/`)) this.setRoot(dirname(entry))
    await this.setTab('list')
    this.flash(entry)
  }

  private flash(path: string): void {
    const row = Array.from(this.body.querySelectorAll<HTMLElement>('[data-path]')).find((el) => el.dataset.path === path && !el.classList.contains('tz-tree-root'))
    if (!row) return
    row.scrollIntoView({ block: 'center' })
    row.classList.add('is-revealed')
    window.setTimeout(() => row.classList.remove('is-revealed'), 1500)
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq
    let content: HTMLElement
    try {
      switch (this.tab) {
        case 'files':
          content = await this.renderTree()
          break
        case 'list':
          content = await this.renderList()
          break
        case 'outline':
          content = this.renderOutline()
          break
        case 'search':
          content = this.renderSearch()
          break
      }
    } catch (err) {
      content = h('div', { class: 'tz-tree-error' }, `侧栏显示失败:${errText(err)}`)
    }
    if (seq !== this.renderSeq) return
    this.body.replaceChildren(content)
    this.markCurrent()
    if (this.tab === 'outline') this.highlightOutline()
  }

  // ---------- 没有打开文件夹:最近使用的目录(对照表 S-16、S-18) ----------

  private async emptyRoot(): Promise<HTMLElement> {
    const open = h('button', { type: 'button', class: 'tz-side-empty-btn' }, '打开文件夹…')
    open.addEventListener('click', () => {
      void this.host.openDialog({ directory: true }).then((paths) => {
        if (paths?.[0]) this.setRoot(paths[0])
      })
    })
    const box = h('div', { class: 'tz-side-empty' }, h('p', null, '没有打开的文件夹'), open)
    const lists: FolderLists = await loadFolders(this.host)
    const all = [...lists.pinned, ...lists.recent.filter((p) => !lists.pinned.includes(p))]
    if (all.length === 0) return box
    const list = h('div', { class: 'tz-folder-list' })
    for (const p of all) {
      const pinned = lists.pinned.includes(p)
      const pin = h('button', { type: 'button', class: `tz-folder-btn${pinned ? ' is-on' : ''}`, title: pinned ? '取消固定' : '固定' }, pinned ? '取消固定' : '固定')
      const remove = h('button', { type: 'button', class: 'tz-folder-btn', title: '从列表中删除' }, '×')
      const row = h('div', { class: 'tz-folder-item', title: p, 'data-folder': p }, h('span', { class: 'tz-folder-name' }, basename(p) || p), pin, remove)
      row.addEventListener('click', (e) => {
        if (e.target === pin || e.target === remove) return
        this.setRoot(p)
      })
      pin.addEventListener('click', () => void setFolderPinned(this.host, p, !pinned).then(() => this.render()))
      remove.addEventListener('click', () => void forgetFolder(this.host, p).then(() => this.render()))
      list.append(row)
    }
    return h('div', null, box, h('div', { class: 'tz-side-subtitle' }, '最近使用的目录'), list)
  }

  // ---------- 文件树 ----------

  private async renderTree(): Promise<HTMLElement> {
    const root = this.root
    if (!root) return this.emptyRoot()
    const header = h('div', { class: 'tz-tree-root', title: root, 'data-sync': '', 'data-path': root, 'data-mtime': 0, 'data-dir': 'true' }, basename(root) || root)
    const rootBadge = this.syncBadge(root, 0, true)
    if (rootBadge) header.append(rootBadge)
    header.addEventListener('contextmenu', (e) => void this.contextMenu(e, { path: root, name: basename(root), isDir: true, size: 0, mtime: 0 }))
    this.dropTarget(header, root)
    const tree = h('div', { class: 'tz-tree', role: 'tree' })
    await this.renderDir(root, tree, 0)
    return h('div', { class: 'tz-tree-wrap' }, header, tree)
  }

  private async renderDir(dir: string, into: HTMLElement, depth: number): Promise<void> {
    let entries: FileStat[]
    try {
      entries = await this.host.listDir(dir)
    } catch (err) {
      into.append(h('div', { class: 'tz-tree-error' }, `无法读取:${errText(err)}`))
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      // TextBundle 是文件夹包,当作一个文档显示(对照表 X-53)
      const folder = e.isDir && !isTextBundle(e.path)
      if (!folder && !isOpenable(e.path)) continue
      const row = h(
        'div',
        {
          class: `tz-tree-item${folder ? ' is-dir' : ''}`,
          role: 'treeitem',
          draggable: 'true',
          'data-path': e.path,
          'data-sync': '',
          'data-mtime': e.mtime,
          'data-dir': String(e.isDir),
          style: `padding-left:${8 + depth * 14}px`,
          title: e.path,
        },
        h('span', { class: 'tz-tree-twisty' }, folder ? (this.expanded.has(e.path) ? '▾' : '▸') : ''),
        h('span', { class: 'tz-tree-name' }, folder ? e.name : displayName(e.path)),
        this.syncBadge(e.path, e.mtime, e.isDir),
      )
      row.addEventListener('click', (ev) => {
        if (folder) {
          if (this.expanded.has(e.path)) this.expanded.delete(e.path)
          else this.expanded.add(e.path)
          void this.render()
        } else {
          this.cb.openFile(e.path, openWhereOf(ev))
        }
      })
      row.addEventListener('contextmenu', (ev) => void this.contextMenu(ev, e))
      row.addEventListener('dragstart', (ev) => {
        if (!ev.dataTransfer) return
        ev.dataTransfer.setData(DRAG_PATH_TYPE, e.path)
        ev.dataTransfer.setData('text/plain', e.path)
        ev.dataTransfer.effectAllowed = 'copyMove'
      })
      if (folder) this.dropTarget(row, e.path)
      else if (/\.(md|markdown)$/i.test(e.path)) this.blockDropTarget(row, e.path)
      into.append(row)
      if (folder && this.expanded.has(e.path)) await this.renderDir(e.path, into, depth + 1)
    }
  }

  /** 拖放目标(对照表 S-19):侧栏里拖动 = 移动;从 Finder 拖进来 = 拷贝进这个文件夹。 */
  private dropTarget(el: HTMLElement, dir: string): void {
    el.addEventListener('dragover', (e) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (!types.includes(DRAG_PATH_TYPE) && !types.includes('Files')) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = types.includes(DRAG_PATH_TYPE) ? 'move' : 'copy'
      el.classList.add('is-drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'))
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-drop-target')
      const dt = e.dataTransfer
      if (!dt) return
      const source = dt.getData(DRAG_PATH_TYPE)
      if (source) {
        e.preventDefault()
        void this.cb.ops.moveInto(source, dir).then((moved) => {
          if (moved) this.expanded.add(dir)
        })
      } else if (dt.files.length) {
        e.preventDefault()
        void this.copyIn(Array.from(dt.files), dir)
      }
    })
  }

  /** 从正文拖来的块(块手柄拖动)落到文档上:追加到该文档末尾并从当前文档移走(notion-input.md 7.3)。 */
  private blockDropTarget(el: HTMLElement, path: string): void {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(BLOCK_DRAG_TYPE)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      el.classList.add('is-drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'))
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-drop-target')
      if (!e.dataTransfer?.types.includes(BLOCK_DRAG_TYPE)) return
      e.preventDefault()
      moveDraggedBlocks(path).catch((err: unknown) => this.cb.onError(`移动块失败:${errText(err)}`))
    })
  }

  /** 从 Finder 拖进来的文件拷进文件夹(重名加序号) */
  private async copyIn(files: File[], dir: string): Promise<void> {
    for (const f of files) {
      try {
        const dot = f.name.lastIndexOf('.')
        const stem = dot > 0 ? f.name.slice(0, dot) : f.name
        const ext = dot > 0 ? f.name.slice(dot) : ''
        let target = joinPath(dir, f.name)
        for (let i = 2; await this.host.stat(target); i++) target = joinPath(dir, `${stem} ${i}${ext}`)
        await this.host.writeBase64(target, await readAsBase64(f))
      } catch (err) {
        this.cb.onError(`无法拷入「${f.name}」:${errText(err)}`)
      }
    }
    this.expanded.add(dir)
    void this.render()
  }

  private async contextMenu(ev: MouseEvent, e: FileStat): Promise<void> {
    ev.preventDefault()
    const anchor = { left: ev.clientX, top: ev.clientY, bottom: ev.clientY }
    const ops = this.cb.ops
    const folder = e.isDir && !isTextBundle(e.path)
    const isRoot = e.path === this.root
    const dir = folder ? e.path : dirname(e.path)
    const items: MenuItem[] = []
    if (!folder) {
      items.push(
        { id: 'open', label: '打开', run: () => this.cb.openFile(e.path, 'current') },
        { id: 'open.tab', label: '在新标签页打开', hint: '⌘ 点击', run: () => this.cb.openFile(e.path, 'tab') },
        { id: 'open.window', label: '在新窗口中打开', hint: '⌥⇧ 点击', run: () => this.cb.openFile(e.path, 'window') },
        { id: 'open.with', label: '打开方式…', run: () => void this.host.openWith(e.path).catch((err: unknown) => this.cb.onError(errText(err))) },
        { id: 'quicklook', label: '快速查看', run: () => void this.host.quickLook(e.path).catch((err: unknown) => this.cb.onError(errText(err))) },
      )
    }
    items.push(
      {
        id: 'new.file',
        label: '新建文件',
        run: () =>
          void ops.create(dir, false).then((p) => {
            if (!p) return
            this.expanded.add(dir)
            this.cb.openFile(p, 'current')
          }),
      },
      {
        id: 'new.folder',
        label: '新建文件夹',
        run: () =>
          void ops.create(dir, true).then((p) => {
            if (p) this.expanded.add(dir)
          }),
      },
    )
    if (!isRoot) {
      items.push(
        { id: 'rename', label: '重命名…', run: () => void ops.rename(e.path) },
        { id: 'duplicate', label: '创建副本', run: () => void ops.duplicate(e.path) },
        { id: 'move', label: '移动到…', run: () => void ops.chooseAndMove(e.path) },
        { id: 'trash', label: '移到废纸篓', run: () => void ops.trash(e.path) },
      )
    }
    items.push(
      { id: 'info', label: '属性', run: () => void ops.showInfo(e.path) },
      { id: 'reveal', label: '在 Finder 中显示', run: () => void this.host.revealInFinder(e.path) },
      { id: 'copy.path', label: '拷贝文件路径', run: () => void this.host.clipboardWrite({ text: e.path }).catch((err: unknown) => this.cb.onError(errText(err))) },
    )
    if (this.tab !== 'files') items.push({ id: 'reveal.tree', label: '在侧边栏中显示', run: () => void this.revealInTree(e.path) })
    if (isRoot) {
      const pinned = (await loadFolders(this.host)).pinned.includes(e.path)
      items.push({ id: 'pin', label: pinned ? '取消固定' : '固定', run: () => void setFolderPinned(this.host, e.path, !pinned) })
    }
    items.push({ id: 'refresh', label: '刷新', run: () => void this.render() })
    if (ops.canUndo) items.push({ id: 'undo', label: '撤销上一次文件操作', hint: '⌘Z', run: () => void ops.undo() })
    this.menu.open(items, anchor)
  }

  // ---------- 文档列表 ----------

  private async listPrefs(): Promise<ListPrefs> {
    const s = await this.host.getSettings()
    const sort = SORTS.some((x) => x.id === s.docListSort) ? (s.docListSort as ListSort) : 'mtime'
    return { sort, desc: typeof s.docListSortDesc === 'boolean' ? s.docListSortDesc : true, group: s.docListGroup === true }
  }

  private listMenu(anchor: HTMLElement, prefs: ListPrefs): void {
    const save = (patch: Record<string, unknown>) =>
      void this.host
        .setSettings(patch)
        .then(() => this.render())
        .catch((err: unknown) => this.cb.onError(`保存排序设置失败:${errText(err)}`))
    const items: MenuItem[] = [
      ...SORTS.map((s) => ({ id: `sort.${s.id}`, label: s.label, group: '排序', active: prefs.sort === s.id, run: () => save({ docListSort: s.id }) })),
      { id: 'asc', label: '升序', group: '顺序', active: !prefs.desc, run: () => save({ docListSortDesc: false }) },
      { id: 'desc', label: '降序', group: '顺序', active: prefs.desc, run: () => save({ docListSortDesc: true }) },
      { id: 'group', label: '按文件夹分组', group: '显示', active: prefs.group, run: () => save({ docListGroup: !prefs.group }) },
    ]
    const r = anchor.getBoundingClientRect()
    this.menu.open(items, { left: r.left, top: r.top, bottom: r.bottom })
  }

  private async renderList(): Promise<HTMLElement> {
    const root = this.root
    if (!root) return this.emptyRoot()
    const prefs = await this.listPrefs()
    const paths = await this.host.listMarkdown(root)
    const stats = (await Promise.all(paths.slice(0, MAX_LIST).map((p) => this.host.stat(p)))).filter((s): s is FileStat => s !== null)
    const sorted = sortFiles(stats, prefs.sort, prefs.desc, root)

    const sortBtn = h('button', { type: 'button', class: 'tz-list-sort', title: '排序与分组' }, `${SORTS.find((s) => s.id === prefs.sort)?.label ?? ''} · ${prefs.desc ? '降序' : '升序'} ▾`)
    sortBtn.addEventListener('click', () => this.listMenu(sortBtn, prefs))
    const list = h('div', { class: 'tz-doc-list' })
    if (paths.length > MAX_LIST) list.append(h('div', { class: 'tz-side-notice' }, '当前文件夹内文件过多,请切换至文件树视图以获得更佳的使用体验。'))

    this.excerptObserver?.disconnect()
    this.excerptObserver =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (seen) => {
              for (const x of seen) {
                if (!x.isIntersecting) continue
                this.excerptObserver?.unobserve(x.target)
                void this.fillExcerpt(x.target as HTMLElement)
              }
            },
            { root: this.body },
          )

    let lastGroup: string | null = null
    for (const s of sorted) {
      const rel = s.path.startsWith(`${root}/`) ? s.path.slice(root.length + 1) : s.path
      const folder = dirname(rel) === '/' || !rel.includes('/') ? '' : dirname(`/${rel}`).slice(1)
      if (prefs.group && folder !== lastGroup) {
        lastGroup = folder
        list.append(h('div', { class: 'tz-doc-group' }, folder || basename(root) || root))
      }
      const excerpt = h('div', { class: 'tz-doc-excerpt' }, this.excerpts.get(`${s.path}@${s.mtime}`) ?? '')
      const item = h(
        'div',
        { class: 'tz-doc-item', 'data-path': s.path, 'data-mtime': s.mtime, title: s.path },
        h('div', { class: 'tz-doc-title' }, displayName(s.path)),
        excerpt,
        h('div', { class: 'tz-doc-meta' }, `${formatTime(s.mtime)}${!prefs.group && folder ? ` · ${folder}` : ''}`),
      )
      item.addEventListener('click', (ev) => this.cb.openFile(s.path, openWhereOf(ev)))
      item.addEventListener('contextmenu', (ev) => void this.contextMenu(ev, s))
      list.append(item)
      if (!this.excerpts.has(`${s.path}@${s.mtime}`)) {
        if (this.excerptObserver) this.excerptObserver.observe(item)
        else void this.fillExcerpt(item)
      }
    }
    if (sorted.length === 0) list.append(h('div', { class: 'tz-side-empty' }, '文件夹里没有 Markdown 文件'))
    return h('div', { class: 'tz-doc-wrap' }, h('div', { class: 'tz-list-head' }, sortBtn), list)
  }

  /** 首段摘要(PRD 3.8 文档列表):滚到可见时才读文件 */
  private async fillExcerpt(item: HTMLElement): Promise<void> {
    const path = item.dataset.path ?? ''
    const key = `${path}@${item.dataset.mtime}`
    const box = item.querySelector('.tz-doc-excerpt')
    if (!box) return
    try {
      let text = this.excerpts.get(key)
      if (text === undefined) {
        const textPath = isTextBundle(path) ? (await this.host.listDir(path)).find((e) => /^text\.(md|markdown|txt)$/i.test(e.name))?.path : path
        text = textPath ? excerptOf((await this.host.readText(textPath)).text) : ''
        this.excerpts.set(key, text)
      }
      box.textContent = text
    } catch (err) {
      box.textContent = `读取失败:${errText(err)}`
    }
  }

  // ---------- 大纲 ----------

  private renderOutline(): HTMLElement {
    const box = h('div', { class: 'tz-outline' })
    if (this.headings.length === 0) {
      box.append(h('div', { class: 'tz-side-empty' }, '大纲内容为空'))
      return box
    }
    const collapsible = this.outlineCollapsible
    if (collapsible && this.headings.some((x, i) => i + 1 < this.headings.length && this.headings[i + 1].level > x.level)) {
      const fold = h('button', { type: 'button', class: 'tz-outline-btn', name: 'collapseAll' }, '全部折叠')
      const unfold = h('button', { type: 'button', class: 'tz-outline-btn', name: 'expandAll' }, '全部展开')
      fold.addEventListener('click', () => {
        for (const r of outlineRows(this.headings, new Set())) if (r.hasChildren) this.collapsedHeadings.add(r.item.id)
        void this.render()
      })
      unfold.addEventListener('click', () => {
        this.collapsedHeadings.clear()
        void this.render()
      })
      box.append(h('div', { class: 'tz-outline-head' }, fold, unfold))
    }
    for (const r of outlineRows(this.headings, collapsible ? this.collapsedHeadings : new Set())) {
      const folded = this.collapsedHeadings.has(r.item.id)
      const twisty = h('span', { class: 'tz-outline-twisty' }, collapsible && r.hasChildren ? (folded ? '▸' : '▾') : '')
      const row = h('div', { class: `tz-outline-item tz-outline-l${r.depth + 1}`, 'data-index': String(r.index), hidden: r.hidden }, twisty, h('span', null, r.item.text || '(无标题)'))
      twisty.addEventListener('click', (e) => {
        if (!collapsible || !r.hasChildren) return
        e.stopPropagation()
        if (folded) this.collapsedHeadings.delete(r.item.id)
        else this.collapsedHeadings.add(r.item.id)
        void this.render()
      })
      row.addEventListener('click', () => this.cb.jumpToHeading(r.item))
      box.append(row)
    }
    return box
  }

  private highlightOutline(): void {
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>('.tz-outline-item'))) {
      const on = Number(el.dataset.index) === this.activeHeading
      el.classList.toggle('is-active', on)
      if (on && !el.hidden) el.scrollIntoView({ block: 'nearest' })
    }
  }

  // ---------- 全局搜索(PRD 3.9、对照表 S-06) ----------

  private renderSearch(): HTMLElement {
    const input = h('input', { class: 'tz-search-input', placeholder: '在文件夹中搜索文件名与内容', spellcheck: 'false' })
    if (this.searchInput) input.value = this.searchInput.value
    this.searchInput = input
    const results = h('div', { class: 'tz-search-results' })
    const toggle = (key: keyof SearchFlags, label: string, title: string) => {
      const b = h('button', { type: 'button', class: `tz-find-toggle${this.searchFlags[key] ? ' is-on' : ''}`, title, name: key }, label)
      b.addEventListener('click', () => {
        this.searchFlags = { ...this.searchFlags, [key]: !this.searchFlags[key] }
        b.classList.toggle('is-on', this.searchFlags[key])
        void this.runSearch(input.value.trim(), results)
      })
      return b
    }
    let timer = 0
    input.addEventListener('input', () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => void this.runSearch(input.value.trim(), results), 250)
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(timer)
        void this.runSearch(input.value.trim(), results)
      }
    })
    if (input.value) void this.runSearch(input.value.trim(), results)
    const options = h(
      'div',
      { class: 'tz-search-options' },
      toggle('caseSensitive', 'Aa', '区分大小写'),
      toggle('wholeWord', 'ab', '查找整个单词'),
      toggle('regex', '.*', '正则表达式'),
    )
    return h('div', { class: 'tz-search' }, h('div', { class: 'tz-search-bar' }, input, options), results)
  }

  /** 分批搜索,边搜边显示;还没搜完时结果末尾显示「正在加载更多结果」(PRD 3.9 索引) */
  private async runSearch(q: string, results: HTMLElement): Promise<void> {
    const seq = ++this.searchSeq
    const root = this.root
    if (!root) {
      results.replaceChildren(h('div', { class: 'tz-side-empty' }, '没有打开的文件夹'))
      return
    }
    if (!q) {
      results.replaceChildren()
      return
    }
    const flags = { ...this.searchFlags }
    const more = h('div', { class: 'tz-search-more' }, '正在加载更多结果')
    results.replaceChildren(more)
    let total = 0
    let found = 0
    try {
      const files = await this.host.listMarkdown(root)
      for (let i = 0; i < files.length; i += SEARCH_BATCH) {
        const hits = await this.host.search(root, q, { ...flags, limit: SEARCH_BATCH, paths: files.slice(i, i + SEARCH_BATCH), maxMatches: MAX_SEARCH_MATCHES + 1 - total })
        if (seq !== this.searchSeq) return
        for (const hit of hits) {
          more.before(this.renderHit(hit, q, flags))
          total += hit.matches.length
          found++
        }
        if (total > MAX_SEARCH_MATCHES) {
          results.prepend(h('div', { class: 'tz-side-notice' }, '匹配结果过多'))
          break
        }
      }
    } catch (err) {
      if (seq === this.searchSeq) results.replaceChildren(h('div', { class: 'tz-tree-error' }, errText(err)))
      return
    }
    if (seq !== this.searchSeq) return
    more.remove()
    if (found === 0) results.append(h('div', { class: 'tz-side-empty' }, '没有找到'))
  }

  private renderHit(hit: SearchHit, q: string, flags: SearchFlags): HTMLElement {
    const rel = this.root && hit.path.startsWith(`${this.root}/`) ? hit.path.slice(this.root.length + 1) : hit.path
    let re: RegExp | null = null
    try {
      re = buildPattern({ query: q, ...flags })
    } catch {
      // 正则写错时宿主已经报错,这里只是不高亮
      re = null
    }
    const mark = (text: string): (Node | string)[] => {
      if (!re) return [text]
      re.lastIndex = 0
      const m = re.exec(text)
      if (!m || m[0].length === 0) return [text]
      return [text.slice(0, m.index), h('mark', null, m[0]), text.slice(m.index + m[0].length)]
    }
    const file = h('div', { class: 'tz-hit-file', title: hit.path }, h('span', { class: 'tz-hit-name' }, ...mark(rel)), h('span', { class: 'tz-hit-count' }, hit.matches.length ? String(hit.matches.length) : '文件名'))
    file.addEventListener('click', (ev) => this.cb.openFile(hit.path, openWhereOf(ev)))
    file.addEventListener('contextmenu', (ev) => void this.contextMenu(ev, { path: hit.path, name: basename(hit.path), isDir: false, size: 0, mtime: 0 }))
    const lines = hit.matches.slice(0, 50).map((m) => {
      const line = h('div', { class: 'tz-hit-line', title: `第 ${m.line} 行` }, ...mark(m.text))
      line.addEventListener('click', () => this.cb.openAt(hit.path, m.line, q, flags))
      return line
    })
    return h('div', { class: 'tz-hit', 'data-path': hit.path }, file, ...lines)
  }
}

/** 大纲窗口(对照表 V-10):浮在编辑区右上角的大纲,点标题跳转后关闭,Esc 或点别处关闭。 */
export function showOutlinePopover(headings: HeadingItem[], active: number, jump: (item: HeadingItem) => void): void {
  document.querySelector('.tz-outline-popover')?.remove()
  const box = h('div', { class: 'tz-popover tz-outline-popover', role: 'dialog', 'aria-label': '大纲' })
  const close = () => {
    box.remove()
    document.removeEventListener('mousedown', outside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const outside = (e: MouseEvent) => {
    if (!box.contains(e.target as Node)) close()
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }
  if (headings.length === 0) box.append(h('div', { class: 'tz-side-empty' }, '大纲内容为空'))
  for (const r of outlineRows(headings, new Set())) {
    const row = h('div', { class: `tz-outline-item tz-outline-l${r.depth + 1}${r.index === active ? ' is-active' : ''}` }, r.item.text || '(无标题)')
    row.addEventListener('click', () => {
      close()
      jump(r.item)
    })
    box.append(row)
  }
  document.body.append(box)
  document.addEventListener('mousedown', outside, true)
  document.addEventListener('keydown', onKey, true)
}
