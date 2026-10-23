// 应用主控:一个窗口 = 一个文档(可带一个根文件夹)。负责文档读写、侧栏、各类面板、应用级命令与宿主事件。
import type { Node as PMNode } from 'prosemirror-model'
import { type EditorState, Selection, TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { AiController } from '../ai/controller'
import { collectHeadings, type HeadingItem } from '../core/blocks'
import { createEditorState, createEditorView, sliceToMarkdown } from '../core/editor'
import { selectionText } from '../core/block-selection'
import { type DocumentRef, type EditorEnv, DEFAULT_EDITOR_SETTINGS, type ImportFile, type OpenWhere } from '../core/env'
import { detectEmbed } from '../core/embed'
import { bundleOf, isTextBundle, TEXT_EXTENSIONS } from '../core/filetypes'
import { scrollToAnchor } from '../core/links'
import { type MarkdownChunks, parseMarkdown } from '../core/markdown/parse'
import { UI_ONLY } from '../core/commands'
import { basename, dirname, joinPath, markdownHref, relativePath, resolveLocalPath } from '../core/paths'
import { getCommand, registerCommand, runCommand } from '../core/registry'
import { schema } from '../core/schema'
import { setViewModes } from '../plugins/basics'
import { buildPattern } from '../plugins/find'
import type { DraftRestore, ExportFormat, FileStat, HistoryEntry, Host } from '../host/types'
import { h } from '../ui/dom'
import { closeLightbox, isLightboxOpen } from '../ui/lightbox'
import { promptInput, validateUrl } from '../ui/prompt'
import { renderCodePreviews } from '../views/codeblock'
import { resetMacros } from '../views/katex'
import { applyAppearance as applyAppearanceSettings, bindZoomGestures, clampZoom, isDarkMode, loadThemeCss, openThemesFolder, printDocument } from './appearance'
import { importFile, importNetworkImage, uploadImages } from './assets'
import { appendMarkdown, createDocumentIn, documentRefs } from './doc-links'
import { DocumentSession, frontMatterInfo, updateFrontMatterText } from './document'
import { registerEditCommands } from './edit-commands'
import { registerImageCommands } from './images'
import { DraftKeeper, relocateDraftAssets } from './drafts'
import { handleDroppedPaths } from './drop'
import { hasLastExport, reportPandocOrError, runExport, syncExportItems } from './export-flow'
import { FileOps } from './fileops'
import { formatVersionTime, showHistory } from './historypanel'
import { parseOptionsFrom } from './markdown-prefs'
import { type LinkTarget, type NavEntry, NavHistory, resolveLinkTarget } from './navigation'
import { countWords, showWordCount } from './panels'
import { showPreferences } from './preferences'
import { applyEditorPrefs, editorSettingsFrom, initEditorPrefs, syncMenuKeys, syncSpelling } from './prefs-apply'
import { SyncController } from './sync'
import { showQuickOpen } from './quickopen'
import { type AppSettings, BUILTIN_THEMES, loadSettings, newFileExtension } from './settings'
import { appKeyTable, BROWSER_ALIASES, keyName } from './shortcuts'
import { type SearchFlags, Sidebar, type SidebarTab, showOutlinePopover } from './sidebar'
import type { SourceEditor } from './source'
import { docPosToSource, sourceToDocPos } from './sourcemap'
import { createTextBundle, textBundleText } from './textbundle'

type SourceModule = typeof import('./source')
/** 源代码模式的 CodeMirror 按需载入(不进启动主包),载入后同步可用 */
let sourceModule: SourceModule | null = null
async function loadSourceModule(): Promise<SourceModule> {
  sourceModule ??= await import('./source')
  return sourceModule
}

export interface AppOptions {
  host: Host
  mount: HTMLElement
  /** 启动时打开的文件或文件夹 */
  openPath: string | null
  openIsDir: boolean
  dark: boolean
}

const AUTOSAVE_DELAY = 1000

/** 超过这个大小以只读源码打开(PRD 3.1 异常、对照表 X-51)。【假设:阈值待研发压测后定;5MB 以内必须正常打开,先取 10MB】 */
export const LARGE_FILE_BYTES = 10 * 1024 * 1024

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class App {
  readonly host: Host
  settings!: AppSettings
  readonly session: DocumentSession
  readonly env: EditorEnv
  readonly sync: SyncController
  /** AI 版:AI 侧栏、正文里的 AI 动作与改文档预览、AI 设置页 */
  readonly ai: AiController
  view!: EditorView
  private source: SourceEditor | null = null
  private sidebar!: Sidebar
  private readonly els: Record<'app' | 'main' | 'scroll' | 'page' | 'header' | 'editor' | 'status' | 'toast', HTMLElement>
  private autosaveTimer = 0
  private statusTimer = 0
  private systemDark: boolean
  private readonly nav = new NavHistory()
  private recent: string[] = []
  readonly drafts: DraftKeeper
  readonly fileOps: FileOps
  /** 只读文件已提示过(每次打开提示一次) */
  private readOnlyWarned = false
  /** 每换一篇文档加一,分段载入据此判断是否已换文档 */
  private loadToken = 0
  private loadProgress: () => number = () => 0
  /** 连续保存失败中:自动保存失败只在第一次把全文放进剪贴板,免得边打字边覆盖用户的剪贴板 */
  private saveFailing = false

  constructor(private readonly options: AppOptions) {
    this.host = options.host
    this.systemDark = options.dark
    this.session = new DocumentSession(this.host, () => this.settings)
    this.sync = new SyncController(this.host, {
      toast: (message, error, action) => this.toast(message, error, action),
      renderStatus: () => this.renderStatus(),
      openSyncPreferences: () => this.runAppCommand('app.syncPreferences'),
      filesChanged: () => this.sidebar?.updateSyncBadges(),
    })
    this.env = {
      host: this.host,
      ctx: { path: null, rootUrl: null },
      settings: { ...DEFAULT_EDITOR_SETTINGS },
      actions: {
        insertLocalMedia: (view, kind) => this.insertLocalMedia(view, kind),
        insertFromUrl: (view, kind) => void this.insertFromUrl(view, kind),
        insertDocLink: (view) => void this.insertDocLink(view),
        listDocuments: () => this.listDocuments(),
        newDocument: () => void this.runAppCommand('file.newWindow'),
        importFiles: (view, files, at) => this.importFiles(view, files, at),
        notify: (message, error) => this.toast(message, error),
        createDocument: (name, content) => this.createLinkedDocument(name, content ?? ''),
        appendToDocument: (path, markdown) => appendMarkdown(this.host, path, markdown).then(() => this.sidebar.refresh()),
      },
      openDocumentLink: (target, where) => void this.openLink(target, where),
    }
    this.drafts = new DraftKeeper(this.host, () => this.session.serialize(this.currentDoc()), (message) => this.toast(message, true))
    this.fileOps = new FileOps(this.host, {
      toast: (message, error, action) => this.toast(message, error, action),
      moved: (from, to) => this.onPathMoved(from, to),
      trashed: (path) => this.onPathTrashed(path),
      refresh: () => this.sidebar?.refresh(),
      root: () => this.sidebar?.rootFolder ?? null,
      saveCurrent: async () => {
        if (this.session.dirty && this.session.path && !this.session.readOnly) await this.save()
      },
      rewritten: async (paths) => {
        if (this.session.path && paths.includes(this.session.path)) await this.onExternalChange()
      },
    })
    this.ai = new AiController({
      host: this.host,
      view: () => this.view,
      documentText: () => this.aiDocumentText(),
      sourceOffset: (pos) => docPosToSource(this.view.state.doc, pos, this.aiDocumentText(), { ...this.session.meta, bom: false }, this.serializeOptions()),
      selectionText: () => {
        const { from, to } = this.view.state.selection
        return sliceToMarkdown(this.view.state.doc.slice(from, to).content, this.env)
      },
      parseOptions: () => parseOptionsFrom(this.settings),
      documentTitle: () => this.session.title,
      documentPath: () => this.session.path,
      rootFolder: () => this.sidebar?.rootFolder ?? null,
      // 分段载入期间正文不全,AI 的插入 / 替换一律不做(与编辑器载入期只读一致)
      readOnly: () => this.session.readOnly !== null || this.loading,
      loading: () => this.loading,
      ensureRichMode: () => {
        if (this.source) this.toggleSourceMode(false)
      },
      listDocuments: () => this.listDocuments(),
      toast: (message, error, action) => this.toast(message, error, action),
      openPreferences: (page) => this.openPreferences(page),
    })
    const header = h('div', { class: 'tz-page-header' })
    const editor = h('div', { class: 'tz-editor-host' })
    const page = h('div', { class: 'tz-page', id: 'write-wrapper' }, header, editor)
    const scroll = h('div', { class: 'tz-scroll' }, page)
    const status = h('footer', { class: 'tz-statusbar' })
    const main = h('main', { class: 'tz-main' }, scroll, status)
    const toast = h('div', { class: 'tz-toast', hidden: true, role: 'status' })
    const app = h('div', { class: 'tz-app' }, main, toast)
    this.els = { app, main, scroll, page, header, editor, status, toast }
  }

  async init(): Promise<void> {
    // 启动分段打点(冒烟报告与性能剖析读 performance 的 mark):读偏好、建界面、查草稿、打开文档
    this.settings = await loadSettings(this.host)
    performance.mark('tz:settings')
    initEditorPrefs(this.settings)
    this.syncEditorSettings()
    this.sidebar = new Sidebar(this.host, {
      openFile: (path, where) => void this.openFile(path, { where }),
      openAt: (path, line, query, flags) => void this.openAt(path, line, query, flags),
      ops: this.fileOps,
      jumpToHeading: (item) => this.jumpToHeading(item),
      currentPath: () => this.session.path,
      onTabChange: (tab) => void this.updateSettings({ sidebarTab: tab, sidebarVisible: true }),
      onError: (msg) => this.toast(msg, true),
      syncBadge: (path, mtime, isDir) => this.sync.fileState(path, mtime, isDir),
    })
    this.els.app.prepend(this.sidebar.el, this.resizer())
    // AI 侧栏在编辑区右侧
    this.els.app.append(this.ai.el)
    this.options.mount.replaceChildren(this.els.app)
    this.applyAppearance()
    this.extraSettingsSections.push(this.sync.settingsSection(), ...this.ai.settingsSections())
    this.registerCommands()
    this.ai.init()
    this.bindHostEvents()
    this.sync.bind()
    this.bindBrowserKeys()
    bindZoomGestures(
      () => this.settings,
      (zoom) => void this.updateSettings({ zoom }),
    )

    const doc = this.session.createEmpty()
    this.view = this.newView(createEditorState(doc, this.env))
    this.applyViewModes()
    // 偏好「默认显示大纲视图」(PA-06)
    void this.sidebar.setTab(this.settings.outlineByDefault ? 'outline' : this.settings.sidebarTab)
    this.syncExportItems()
    if (Object.keys(this.settings.keybindings).length) syncMenuKeys(this.host, this.settings)
    syncSpelling(this.host, this.settings)
    performance.mark('tz:ui')

    // 重启或网页进程崩溃后,外壳要求本窗口恢复的未命名草稿(PRD 3.1)
    const draft = await this.host.draftPending()
    performance.mark('tz:draft')
    if (draft) this.restoreDraft(draft)
    const openPath = this.options.openPath
    if (openPath) {
      if (this.options.openIsDir && !isTextBundle(openPath)) this.sidebar.setRoot(openPath)
      else await this.openFile(openPath, draft ? { where: 'tab' } : { replace: true })
    } else if (!draft && this.host.isLaunchWindow) {
      await this.restoreStartup()
    }
    performance.mark('tz:open')
    this.updateWindowState()
    this.renderStatus()
    this.view.focus()
  }

  // ---------- 设置与外观 ----------

  private syncEditorSettings(): void {
    Object.assign(this.env.settings, editorSettingsFrom(this.settings))
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    Object.assign(this.settings, patch)
    this.syncEditorSettings()
    await this.host.setSettings(patch as Record<string, unknown>)
    this.applyAppearance()
    // 输入规则、快捷键、识别规则等是建编辑器状态时定的,改了要重建或重新解析(保留文档与选区);之后再恢复专注 / 打字机状态
    if (this.view) applyEditorPrefs({ view: this.view, env: this.env, session: this.session, host: this.host }, this.settings, patch)
    this.applyViewModes()
    if ('exportItems' in patch) this.syncExportItems()
    if ('exportHistory' in patch) this.updateWindowState()
    if ('outlineCollapsible' in patch) this.sidebar.setOutlineCollapsible(this.settings.outlineCollapsible)
    this.renderStatus()
  }

  private applyAppearance(): void {
    const s = this.settings
    applyAppearanceSettings(this.host, s, this.systemDark, (message) => this.toast(message, true))
    this.els.status.hidden = !s.showStatusBar
    this.els.status.classList.toggle('is-words-hover', !s.alwaysShowWordCount)
    this.sidebar?.el.toggleAttribute('hidden', !s.sidebarVisible)
    this.els.app.style.setProperty('--tz-sidebar-width', `${s.sidebarWidth}px`)
  }

  private applyViewModes(): void {
    if (!this.view) return
    setViewModes(this.view, { focus: this.settings.focusMode, typewriter: this.settings.typewriterMode, typewriterAlways: this.settings.typewriterAlways })
  }

  /** 主题菜单里选主题:深色模式下改「深色模式主题」,否则改主题;再点同一个主题会重读它的 CSS(改了主题文件后用)。 */
  private async setTheme(id: string): Promise<void> {
    await this.updateSettings(isDarkMode(this.settings, this.systemDark) ? { darkTheme: id } : { theme: id })
    await loadThemeCss(this.host, id, true).catch((err: unknown) => this.toast(err instanceof Error ? err.message : String(err), true))
  }

  /** 启动选项(PF-01):应用启动的第一个窗口按偏好打开上次的文件与目录,或指定目录。 */
  private async restoreStartup(): Promise<void> {
    const s = this.settings
    const folder = s.startupAction === 'customFolder' ? s.startupFolder : s.startupAction === 'newFile' ? '' : s.lastFolder
    if (folder && (await this.host.stat(folder))?.isDir) this.sidebar.setRoot(folder)
    if (s.startupAction === 'lastFilesAndFolder' && s.lastFile && (await this.host.stat(s.lastFile))) await this.openFile(s.lastFile, { replace: true })
  }

  /** 记下上次使用的文件与目录(启动选项用);关了「记录历史文件和文件夹」(PF-07)就不记。 */
  private rememberLocation(): void {
    const s = this.settings
    if (!s.recordRecent) return
    const lastFile = this.session.path ?? s.lastFile
    const lastFolder = this.sidebar.rootFolder ?? s.lastFolder
    if (lastFile !== s.lastFile || lastFolder !== s.lastFolder) void this.updateSettings({ lastFile, lastFolder })
  }

  private syncExportItems(): void {
    syncExportItems(this.host, this.settings.exportItems, (formatId) => void this.exportAs(formatId))
  }

  private resizer(): HTMLElement {
    const el = h('div', { class: 'tz-side-resizer', title: '拖动调整侧栏宽度' })
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      el.setPointerCapture(e.pointerId)
      const startX = e.clientX
      const start = this.settings.sidebarWidth
      const move = (ev: PointerEvent) => this.els.app.style.setProperty('--tz-sidebar-width', `${Math.min(520, Math.max(180, start + ev.clientX - startX))}px`)
      const up = (ev: PointerEvent) => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        void this.updateSettings({ sidebarWidth: Math.min(520, Math.max(180, start + ev.clientX - startX)) })
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    })
    return el
  }

  // ---------- 文档 ----------

  private newView(state: EditorState): EditorView {
    return createEditorView(this.els.editor, state, this.env, {
      onDocChange: () => this.onDocChange(),
      onUpdate: (v) => this.onEditorUpdate(v),
    })
  }

  /**
   * 换一篇文档:新建编辑器视图,不在旧视图上 updateState。
   * 新旧文档差异很大时 updateState 会在已挂载的 DOM 上逐个拆旧节点(5MB 文档在 WebKit 里要几十秒);
   * destroy 先整块摘下旧 DOM 再销毁节点视图,快得多。
   */
  private replaceView(state: EditorState): void {
    const focused = this.view.hasFocus()
    this.view.destroy()
    this.view = this.newView(state)
    if (focused) this.view.focus()
  }

  private setDocument(doc: PMNode): void {
    // 换了文档:停掉上一篇还没载完的分段与还没到点的自动保存
    this.loadToken++
    clearTimeout(this.autosaveTimer)
    resetMacros()
    const fm = frontMatterInfo(doc, this.session.path)
    this.env.ctx.path = this.session.path
    this.env.ctx.rootUrl = fm.rootUrl
    this.readOnlyWarned = false
    this.replaceView(createEditorState(doc, this.env))
    this.applyViewModes()
    this.renderHeader()
    this.els.scroll.scrollTop = 0
    if (this.session.path) {
      void this.host.watch([this.session.path])
      if (this.settings.recordRecent) this.recent = [this.session.path, ...this.recent.filter((p) => p !== this.session.path)].slice(0, 20)
    }
    this.sidebar.markCurrent()
    this.updateWindowState()
    this.onEditorUpdate(this.view)
  }

  /** 大文档还在分段载入(冒烟与性能剖析用来等全文载完) */
  /** 侧栏当前打开的文件夹(没有时为 null) */
  get rootFolder(): string | null {
    return this.sidebar.rootFolder
  }

  get loading(): boolean {
    return this.session.loading
  }

  /**
   * 大文档其余各段:每次解析一段追加到文末,之间让出主线程,滚动与界面保持响应。
   * 载完之前正文不可编辑、不能保存或导出(正文不全);换了文档就停下。追加不算修改、不进撤销历史。
   */
  private continueLoading(chunks: MarkdownChunks): void {
    const token = ++this.loadToken
    this.session.loading = true
    this.view.setProps({ editable: () => !this.session.loading })
    const step = () => {
      if (token !== this.loadToken) return
      try {
        // 每步在约 50ms 内多解析几段再一次追加:追加一次要走一遍全文的插件与视图更新,步数越少越快
        const started = performance.now()
        const blocks: PMNode[] = []
        do blocks.push(...chunks.nextBlocks())
        while (!chunks.done && performance.now() - started < 50)
        if (blocks.length) {
          const tr = this.view.state.tr.insert(this.view.state.doc.content.size, blocks)
          this.view.dispatch(tr.setMeta(UI_ONLY, true).setMeta('addToHistory', false))
        }
      } catch (err) {
        // 后面的段解析失败:停在已载入的部分,只读,避免把半截文档存回去
        this.session.loading = false
        this.session.readOnly = 'partial'
        this.toast(`文档后半部分解析失败,已停止载入并改为只读:${errText(err)}`, true)
        this.renderStatus()
        return
      }
      if (chunks.done) {
        this.session.loading = false
        this.view.setProps({ editable: () => true })
      } else {
        window.setTimeout(step, 0)
      }
      this.renderStatus()
    }
    this.loadProgress = () => Math.round((chunks.parsed / chunks.total) * 100)
    window.setTimeout(step, 0)
  }

  /**
   * 打开文档。where:current 在当前标签打开,tab / window 另开(PRD 3.1、notion 5.1 第 10、11 行);
   * 已在别的窗口或标签打开时切过去,不重复打开。返回是否在当前标签载入了文档。
   */
  async openFile(path: string, opts: { where?: OpenWhere; replace?: boolean; encoding?: string } = {}): Promise<boolean> {
    const where = opts.where ?? 'current'
    let textPath = path
    let stat: FileStat | null
    try {
      stat = await this.host.stat(path)
      // TextBundle:打开包里的 text.md(对照表 X-53)
      if (stat && isTextBundle(path)) {
        textPath = await textBundleText(this.host, path)
        stat = await this.host.stat(textPath)
      }
    } catch (err) {
      this.toast(`无法打开 ${basename(path)}:${errText(err)}`, true)
      return false
    }
    if (!stat) {
      this.toast('目标文件或文件夹不存在。', true)
      return false
    }
    if (where !== 'current') {
      await this.host.openDocument(path, where === 'window' ? { newWindow: true } : { tab: true })
      return false
    }
    if (textPath !== this.session.path && (await this.host.focusDocument(textPath))) return false
    if (!(await this.confirmLeave())) return false
    if (this.session.path && !opts.replace && this.session.path !== textPath) this.nav.push(this.here())
    try {
      this.closeSource()
      if (stat.size > LARGE_FILE_BYTES) {
        // 超大文件:不解析,以只读源码打开
        const [text, source] = await Promise.all([this.session.loadText(textPath, opts.encoding), loadSourceModule()])
        this.session.readOnly = 'large'
        this.setDocument(schema.nodes.doc.create(null, schema.nodes.paragraph.create()))
        this.openSource(source, text, true)
        this.toast(`文件较大(${(stat.size / 1024 / 1024).toFixed(1)} MB),已以只读源码方式打开`)
      } else {
        // 大文档先显示第一段,其余分段在后台续上(PRD 质量要求:5MB 文档首屏 ≤1.5 秒)
        const { doc, rest } = await this.session.loadProgressive(textPath, opts.encoding)
        if (stat.writable === false) this.session.readOnly = 'permission'
        this.setDocument(doc)
        if (rest) this.continueLoading(rest)
      }
      if (!this.sidebar.rootFolder) this.sidebar.setRoot(dirname(bundleOf(textPath) ?? textPath))
      this.renderStatus()
      return true
    } catch (err) {
      this.toast(`无法打开 ${basename(path)}:${errText(err)}`, true)
      return false
    }
  }

  /**
   * 离开当前文档前(切换文档、关窗口、退出):有未保存修改时自动保存或询问。返回 false 表示用户取消。
   * 退出应用且自动保存开着时,未命名文档不询问:草稿留在数据目录,下次启动恢复到原标签(PRD 3.1、对照表 X-56)。
   */
  async confirmLeave(reason: 'switch' | 'close' | 'quit' = 'switch'): Promise<boolean> {
    if (!this.session.dirty) return true
    if (this.session.path && this.settings.autoSave && !this.session.readOnly) {
      if (await this.save()) return true
    } else if (!this.session.path && this.settings.autoSave && reason === 'quit') {
      try {
        await this.drafts.flush()
        return true
      } catch (err) {
        this.toast(`未命名草稿备份失败:${errText(err)}`, true)
      }
    }
    const choice = await this.host.confirm({
      title: '是否保存更改?',
      message: '如果不保存,您的更改将会丢失。',
      buttons: ['保存', '不保存', '取消'],
      style: 'warning',
    })
    if (choice === 2) return false
    if (choice === 0) return this.save()
    this.session.dirty = false
    await this.drafts.discard().catch((err: unknown) => this.toast(`删除草稿备份失败:${errText(err)}`, true))
    return true
  }

  private onDocChange(): void {
    this.session.markDirty()
    this.updateWindowState()
    this.renderHeader()
    if (this.session.readOnly === 'permission') this.warnReadOnly()
    if (!this.session.path) this.drafts.schedule()
    else this.scheduleAutosave()
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer)
    if (this.session.path && this.settings.autoSave && !this.session.readOnly) {
      this.autosaveTimer = window.setTimeout(() => void this.save({ auto: true }), AUTOSAVE_DELAY)
    }
  }

  /** 只读文件可以浏览、可以改,第一次输入时提示改动存不了,给【另存为】(PRD 3.1 异常) */
  private warnReadOnly(): void {
    if (this.readOnlyWarned) return
    this.readOnlyWarned = true
    this.toast('该文件只读,修改无法保存', true, { label: '另存为', run: () => void this.saveAs() })
  }

  private currentDoc(): PMNode {
    if (!this.source) return this.view.state.doc
    // 源码模式下以源码为准;源码编辑器内部一律用 \n,写回时沿用文件原来的换行符
    const parsed = parseMarkdown(this.source.text, parseOptionsFrom(this.settings))
    this.session.meta = { ...parsed.meta, lineEnding: this.session.meta.lineEnding }
    return parsed.doc
  }

  async save(opts: { auto?: boolean } = {}): Promise<boolean> {
    clearTimeout(this.autosaveTimer)
    // 自动保存只存有改动的:没改过的文档不重新写一遍(重新生成的 Markdown 可能与原文排版不同)
    if (opts.auto && !this.session.dirty) return true
    if (this.session.loading) {
      this.toast('文档还在载入,载入完成后才能保存', true)
      return false
    }
    if (this.session.readOnly === 'large') {
      this.toast('文件过大,以只读源码方式打开,不能保存', true)
      return false
    }
    if (this.session.readOnly === 'partial') {
      this.toast('文档只载入了前半部分(后半部分解析失败),不能保存,以免原文件被截断;可另存为其它文件', true)
      return false
    }
    // 没有写权限:改为另存为(PRD 3.1 异常)
    if (!this.session.path || this.session.readOnly === 'permission') return this.saveAs()
    try {
      await this.session.save(this.currentDoc())
      this.saveFailing = false
      this.updateWindowState()
      this.renderStatus()
      return true
    } catch (err) {
      await this.reportSaveFailure(err, !opts.auto || !this.saveFailing)
      this.saveFailing = true
      return false
    }
  }

  /** 写盘失败(PRD 二 功能流程图、对照表 X-52):提示保存失败,全文放进剪贴板以免丢失。 */
  private async reportSaveFailure(err: unknown, copy: boolean): Promise<void> {
    const reason = errText(err).replace(/^保存失败:/, '')
    if (!copy) {
      this.toast(`保存失败:${reason}`, true, { label: '另存为', run: () => void this.saveAs() })
      return
    }
    try {
      await this.host.clipboardWrite({ text: this.session.serialize(this.currentDoc()) })
      this.toast(`保存失败:${reason}。全文已放入剪贴板,可粘贴到新文档后另存。`, true, { label: '另存为', run: () => void this.saveAs() })
    } catch (clipErr) {
      this.toast(`保存失败:${reason};放入剪贴板也失败:${errText(clipErr)}`, true)
    }
  }

  async saveAs(): Promise<boolean> {
    if (this.session.loading) {
      this.toast('文档还在载入,载入完成后才能保存', true)
      return false
    }
    const wasUntitled = !this.session.path
    const shown = this.session.path ? (bundleOf(this.session.path) ?? this.session.path) : null
    // 新文件扩展名按偏好(PF-03)
    const ext = newFileExtension(this.settings)
    const defaultName = shown ? basename(shown) : `${this.firstHeadingText() || '未命名'}.${ext}`
    const chosen = await this.host.saveDialog({ defaultName, extensions: [...new Set([ext, 'md', 'markdown', 'txt', 'textbundle'])] })
    if (!chosen) return false
    if (this.session.readOnly === 'partial' && chosen === shown) {
      this.toast('文档只载入了前半部分,不能覆盖原文件;请另存为其它文件', true)
      return false
    }
    const previousCtx = this.env.ctx.path
    try {
      const target = isTextBundle(chosen) ? await createTextBundle(this.host, chosen) : chosen
      // 未保存时插入的图片先在数据目录里,首次保存时搬到文档旁、改写为相对路径(对照表 X-19)
      this.env.ctx.path = target
      if (wasUntitled && !this.source) await relocateDraftAssets(this.view, { ...this.importContext(), docPath: target })
      await this.session.save(this.currentDoc(), target)
      this.session.readOnly = null
      this.saveFailing = false
      this.env.ctx.rootUrl = frontMatterInfo(this.view.state.doc, target).rootUrl
      if (!this.sidebar.rootFolder) this.sidebar.setRoot(dirname(bundleOf(target) ?? target))
      this.sidebar.refresh()
      this.sidebar.markCurrent()
      void this.host.watch([target])
      this.recent = [target, ...this.recent.filter((p) => p !== target)].slice(0, 20)
      this.updateWindowState()
      this.renderStatus()
    } catch (err) {
      this.env.ctx.path = previousCtx
      await this.reportSaveFailure(err, true)
      return false
    }
    if (wasUntitled) await this.drafts.discard().catch((err: unknown) => this.toast(`删除草稿备份失败:${errText(err)}`, true))
    return true
  }

  private firstHeadingText(): string {
    return collectHeadings(this.view.state.doc)[0]?.text.replace(/[/:]/g, '-').slice(0, 60) ?? ''
  }

  /** 外部修改:没有未保存修改就静默重载;有则询问(PRD 3.1 外部修改)。 */
  private async onExternalChange(): Promise<void> {
    // 自己这次保存触发的通知:等写盘回执(更新已保存的时间与内容)再比,否则会误报「被其他程序修改」
    if (this.session.saving) await this.session.saving.catch(() => undefined)
    // 比对与询问期间不能自动保存:否则外部版本还没比完、用户还没选,就被本地内容覆盖
    clearTimeout(this.autosaveTimer)
    try {
      await this.checkExternalChange()
    } finally {
      if (this.session.dirty) this.scheduleAutosave()
    }
  }

  private async checkExternalChange(): Promise<void> {
    const path = this.session.path
    if (!path) return
    const stat = await this.host.stat(path)
    if (!stat) {
      this.toast('文件已被移动或删除;再次保存会在原位置重新创建', true)
      return
    }
    if (stat.mtime === this.session.savedMtime) return
    const { text } = await this.host.readText(path, this.session.encoding)
    if (text === this.session.savedText) {
      this.session.savedMtime = stat.mtime
      return
    }
    if (this.session.readOnly === 'large') {
      await this.openFile(path, { replace: true, encoding: this.session.encoding })
      return
    }
    if (this.session.dirty) {
      const choice = await this.host.confirm({
        title: '文件已被其他程序修改',
        message: `「${basename(bundleOf(path) ?? path)}」`,
        buttons: ['重新加载', '保留我的修改'],
        style: 'warning',
      })
      if (choice !== 0) {
        this.session.savedMtime = stat.mtime
        return
      }
    }
    const pos = this.view.state.selection.from
    const scroll = this.els.scroll.scrollTop
    const doc = await this.session.load(path, this.session.encoding)
    if (stat.writable === false) this.session.readOnly = 'permission'
    this.setDocument(doc)
    this.els.scroll.scrollTop = scroll
    const clamped = Math.min(pos, this.view.state.doc.content.size)
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(clamped))))
  }

  private updateWindowState(): void {
    this.host.setWindowState({ path: this.session.path, title: this.session.title, edited: this.session.dirty, hasLastExport: hasLastExport(this.settings, this.session.path) })
    this.rememberLocation()
  }

  // ---------- 页面头部:Notion 的图标与封面(存 front matter) ----------

  private renderHeader(): void {
    const fm = frontMatterInfo(this.view.state.doc, this.session.path)
    const header = this.els.header
    header.replaceChildren()
    if (fm.cover) {
      const url = this.coverUrl(fm.cover)
      const cover = h('div', { class: 'tz-cover' })
      if (url.startsWith('linear-gradient')) cover.style.background = url
      else cover.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`
      const change = h('button', { type: 'button', class: 'tz-cover-btn' }, '移除封面')
      change.addEventListener('click', () => this.setFrontMatter('cover', null))
      cover.append(change)
      header.append(cover)
    }
    if (fm.icon) {
      const icon = h('button', { type: 'button', class: 'tz-page-icon', title: '更换图标' }, fm.icon)
      icon.addEventListener('click', () => void this.pickIcon())
      header.append(icon)
    }
    const actions = h('div', { class: 'tz-page-actions' })
    if (!fm.icon) {
      const b = h('button', { type: 'button' }, '☺ 添加图标')
      b.addEventListener('click', () => void this.pickIcon())
      actions.append(b)
    }
    if (!fm.cover) {
      const b = h('button', { type: 'button' }, '▧ 添加封面')
      b.addEventListener('click', () => void this.pickCover())
      actions.append(b)
    }
    header.append(actions)
    header.classList.toggle('has-cover', Boolean(fm.cover))
    header.classList.toggle('has-icon', Boolean(fm.icon))
  }

  private coverUrl(cover: string): string {
    if (cover.startsWith('linear-gradient')) return cover
    const local = resolveLocalPath(cover, this.env.ctx)
    return local ? this.host.resourceURL(local) : cover
  }

  private async pickIcon(): Promise<void> {
    const value = await promptInput({ title: '页面图标', placeholder: '输入或粘贴一个表情,如 📘(留空移除)', value: frontMatterInfo(this.view.state.doc, this.session.path).icon ?? '' })
    if (value === null) return
    this.setFrontMatter('icon', value || null)
  }

  private async pickCover(): Promise<void> {
    const paths = await this.host.openDialog({ extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] })
    if (!paths?.[0]) {
      this.setFrontMatter('cover', 'linear-gradient(135deg, rgb(246, 211, 101) 0%, rgb(253, 160, 133) 100%)')
      return
    }
    const imported = await importFile(this.importContext(), { name: basename(paths[0]), path: paths[0] })
    if (imported) this.setFrontMatter('cover', imported.src)
  }

  private setFrontMatter(key: string, value: string | null): void {
    const { state } = this.view
    const first = state.doc.firstChild
    const tr = state.tr
    if (first?.type === schema.nodes.frontmatter) {
      const text = updateFrontMatterText(first.textContent, key, value)
      const content = text ? schema.text(text) : null
      tr.replaceWith(0, first.nodeSize, schema.nodes.frontmatter.create(null, content))
    } else if (value !== null) {
      tr.insert(0, schema.nodes.frontmatter.create(null, schema.text(updateFrontMatterText('', key, value))))
    }
    if (tr.docChanged) this.view.dispatch(tr)
  }

  // ---------- 编辑器更新:大纲、状态栏 ----------

  private onEditorUpdate(view: EditorView): void {
    clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => {
      const headings = collectHeadings(view.state.doc)
      const pos = view.state.selection.from
      let active = -1
      headings.forEach((x, i) => {
        if (x.pos <= pos) active = i
      })
      this.sidebar.setHeadings(headings, active)
      this.renderStatus()
    }, 120)
  }

  private jumpToHeading(item: HeadingItem): void {
    if (this.source) this.toggleSourceMode(false)
    const tr = this.view.state.tr.setSelection(TextSelection.create(this.view.state.doc, item.pos + 1))
    this.view.dispatch(tr)
    const dom = this.view.nodeDOM(item.pos)
    if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'start', behavior: 'smooth' })
    this.view.focus()
  }

  private renderStatus(): void {
    if (!this.view || !this.settings.showStatusBar) return
    // 超大文件(只读源码)与正在分段载入的文档不逐字统计,免得每次刷新状态栏都扫一遍
    const large = this.session.readOnly === 'large'
    const loading = this.session.loading
    const text = this.source ? (large ? '' : this.source.text) : loading ? '' : this.view.state.doc.textBetween(0, this.view.state.doc.content.size, '\n\n', ' ')
    const stats = countWords(text, this.settings.readingSpeed)
    // 有选区或选中了块(含多块)时显示所选部分的字数
    const selected = this.source ? null : selectionText(this.view.state)
    const sel = selected === null ? null : countWords(selected, this.settings.readingSpeed)
    const words = h('button', { type: 'button', class: 'tz-status-btn tz-status-words', title: '字数统计' }, loading ? `载入中 ${this.loadProgress()}%` : large ? '只读源码' : sel ? `已选 ${sel.words} 字 / 共 ${stats.words} 字` : `${stats.words} 字`)
    words.addEventListener('click', () => runCommand(this.view, 'view.wordCount'))
    const sidebarBtn = h('button', { type: 'button', class: 'tz-status-btn', title: '显示 / 隐藏侧栏(⌃⌘S)' }, '☰')
    sidebarBtn.addEventListener('click', () => this.runAppCommand('view.toggleSidebar'))
    const sourceBtn = h('button', { type: 'button', class: `tz-status-btn${this.source ? ' is-on' : ''}`, title: '源代码模式(⌃⌘/)' }, '</>')
    sourceBtn.addEventListener('click', () => this.runAppCommand('view.sourceMode'))
    const saved = this.session.dirty ? (this.settings.autoSave && this.session.path ? '正在保存…' : '未保存') : this.session.path ? '已保存' : ''
    const state = h('span', { class: 'tz-status-text' }, this.session.readOnly ? `只读${this.session.dirty ? ' · 未保存' : ''}` : saved)
    this.els.status.replaceChildren(sidebarBtn, sourceBtn, h('span', { class: 'tz-status-spacer' }), this.sync.statusButton() ?? '', state, words)
  }

  // ---------- 源码模式 ----------

  private serializeOptions(): { inlineMath: boolean; ensureTrailingNewline: boolean } {
    return { inlineMath: this.settings.inlineMath, ensureTrailingNewline: this.settings.ensureTrailingNewline }
  }

  private openSource(mod: SourceModule, text: string, readOnly: boolean): SourceEditor {
    this.els.editor.hidden = true
    this.els.header.hidden = true
    const mount = h('div', { class: 'tz-source-host' })
    this.els.page.append(mount)
    this.source = new mod.SourceEditor(mount, text, () => this.onDocChange(), this.settings.codeLineNumbers, readOnly)
    return this.source
  }

  private closeSource(): void {
    if (!this.source) return
    this.source.destroy()
    this.els.page.querySelector('.tz-source-host')?.remove()
    this.source = null
    this.els.editor.hidden = false
    this.els.header.hidden = false
  }

  /** 切换源代码模式,来回切换保持光标所在位置(PRD 3.10)。 */
  toggleSourceMode(on = !this.source): void {
    if (this.session.loading) {
      this.toast('文档还在载入,载入完成后才能切换源代码模式', true)
      return
    }
    if (this.session.readOnly === 'large') {
      if (!on) this.toast('文件过大,只能以只读源码方式查看', true)
      return
    }
    if (on && !this.source) {
      // 第一次切换时先载入 CodeMirror,载入后再切
      if (!sourceModule) {
        loadSourceModule().then(
          () => this.toggleSourceMode(true),
          (err: unknown) => this.toast(`源代码模式载入失败:${err instanceof Error ? err.message : String(err)}`, true),
        )
        return
      }
      const doc = this.view.state.doc
      const pos = this.view.state.selection.from
      const source = this.openSource(sourceModule, this.session.serialize(doc), false)
      source.setCursor(docPosToSource(doc, pos, source.text, this.session.meta, this.serializeOptions()))
      source.focus()
    } else if (!on && this.source) {
      const text = this.source.text
      const offset = this.source.cursor
      const doc = this.currentDoc()
      this.closeSource()
      this.replaceView(createEditorState(doc, this.env))
      this.applyViewModes()
      this.renderHeader()
      this.placeCursor(sourceToDocPos(doc, offset, text, this.session.meta, this.serializeOptions()))
    }
    this.renderStatus()
  }

  // ---------- 跳转:后退 / 前进(⌘[ / ⌘])、文内锚点、全局搜索定位 ----------

  private here(): NavEntry {
    return { path: this.session.path, pos: this.source ? 0 : this.view.state.selection.from }
  }

  private placeCursor(pos: number): void {
    const doc = this.view.state.doc
    const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))
    this.view.dispatch(this.view.state.tr.setSelection(Selection.near($pos)).scrollIntoView())
    this.view.focus()
  }

  /** 回到上一个(或下一个)查看位置,跨文档时打开原文档并恢复跳转前的光标(notion 5.1 第 4、5 行) */
  private async navigate(dir: -1 | 1): Promise<void> {
    const here = this.here()
    const target = dir < 0 ? this.nav.goBack(here) : this.nav.goForward(here)
    if (!target) return
    if (target.path !== this.session.path) {
      if (!target.path || !(await this.openFile(target.path, { replace: true }))) return
    }
    if (this.source) this.toggleSourceMode(false)
    if (!this.source) this.placeCursor(target.pos)
  }

  private jumpToAnchor(anchor: string): void {
    const here = this.here()
    if (this.source) this.toggleSourceMode(false)
    if (scrollToAnchor(this.view, anchor)) this.nav.push(here)
    else this.toast(`找不到标题或锚点:#${anchor}`, true)
  }

  /** 全局搜索结果:打开文件并选中命中行里的匹配文字(PRD 3.9) */
  private async openAt(path: string, line: number, query: string, flags: SearchFlags): Promise<void> {
    if (path !== this.session.path && path !== bundleOf(this.session.path ?? '') && !(await this.openFile(path))) return
    const text = this.source ? this.source.text : this.session.serialize(this.view.state.doc).replace(/\r\n?/g, '\n')
    let start = 0
    for (let i = 1; i < line; i++) {
      const next = text.indexOf('\n', start)
      if (next < 0) break
      start = next + 1
    }
    const lineEnd = text.indexOf('\n', start)
    const lineText = text.slice(start, lineEnd < 0 ? text.length : lineEnd)
    let length = 0
    try {
      const m = buildPattern({ query, ...flags })?.exec(lineText)
      if (m) {
        start += m.index
        length = m[0].length
      }
    } catch {
      // 正则写错时搜索本身已报错,这里只定位到行首
      length = 0
    }
    if (this.source) {
      this.source.setCursor(start)
      this.source.focus()
      return
    }
    const doc = this.view.state.doc
    const from = sourceToDocPos(doc, start, text, this.session.meta, this.serializeOptions())
    let to = length ? sourceToDocPos(doc, start + length, text, this.session.meta, this.serializeOptions()) : from
    // 匹配跨到下一个块时只放光标
    if (to < from || to - from > length * 4 + 8) to = from
    this.view.dispatch(this.view.state.tr.setSelection(TextSelection.between(doc.resolve(from), doc.resolve(to))).scrollIntoView())
    this.view.focus()
  }

  // ---------- 文件与历史版本 ----------

  /** 文件或文件夹改名 / 移动后,当前文档路径、后退历史、最近文件跟着变 */
  private onPathMoved(from: string, to: string): void {
    const follow = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)
    this.nav.rename(from, to)
    this.recent = this.recent.map(follow)
    const cur = this.session.path
    if (!cur || follow(cur) === cur) return
    const next = follow(cur)
    this.session.path = next
    this.env.ctx.path = next
    this.env.ctx.rootUrl = frontMatterInfo(this.view.state.doc, next).rootUrl
    void this.host.watch([next])
    this.updateWindowState()
    this.sidebar.markCurrent()
  }

  /** 当前文档被移到废纸篓:本标签换成空白新文档(文件可从废纸篓恢复,历史版本保留) */
  private onPathTrashed(path: string): void {
    const cur = this.session.path
    if (!cur || !(cur === path || cur.startsWith(`${path}/`))) return
    clearTimeout(this.autosaveTimer)
    this.closeSource()
    this.setDocument(this.session.createEmpty())
  }

  /** 恢复外壳交回的未命名草稿(PRD 3.1:重启或网页进程崩溃后恢复到原标签) */
  private restoreDraft(draft: DraftRestore): void {
    const { doc, meta } = parseMarkdown(draft.text, { inlineMath: this.settings.inlineMath })
    this.session.createEmpty()
    this.session.meta = meta
    this.setDocument(doc)
    this.session.markDirty()
    this.drafts.adopt(draft.id)
    this.updateWindowState()
    this.renderStatus()
  }

  /** 【恢复此版本】:先把当前内容记成快照,再替换为所选版本(可 ⌘Z 撤回),提示恢复到的时间(PRD 3.14) */
  private async restoreVersion(text: string, time: number): Promise<void> {
    const path = this.session.path
    if (!path) return
    if (this.source) this.toggleSourceMode(false)
    await this.host.historySnapshot(path, this.session.serialize(this.view.state.doc))
    const { doc, meta } = parseMarkdown(text, { inlineMath: this.settings.inlineMath })
    this.session.meta = meta
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content)
    this.view.dispatch(tr.setSelection(Selection.atStart(tr.doc)).scrollIntoView())
    this.toast(`已恢复到 ${formatVersionTime(time)} 的版本`)
  }

  /** 找回已删除的文件:把所选版本写回原位置并在新标签打开 */
  private async recoverDeleted(path: string, text: string, time: number): Promise<void> {
    if (await this.host.stat(path)) throw new Error(`原位置已有同名文件:${path}`)
    await this.host.writeText(path, text)
    this.sidebar.refresh()
    this.toast(`已找回「${basename(path)}」(${formatVersionTime(time)} 的版本)`)
    await this.openFile(path, { where: 'tab' })
  }

  /** 复原到已保存 / 从磁盘重新载入:有未保存的修改先确认「放弃更改」(对照表 F-18) */
  private async revertToSaved(): Promise<void> {
    const path = this.session.path
    if (!path) return
    if (this.session.dirty) {
      const choice = await this.host.confirm({ title: '要复原到上次保存的版本吗?', message: '当前未保存的修改会丢失。', buttons: ['放弃更改', '取消'], style: 'warning' })
      if (choice !== 0) return
    }
    clearTimeout(this.autosaveTimer)
    this.session.dirty = false
    await this.openFile(path, { replace: true, encoding: this.session.encoding })
  }

  /** 创建副本(对照表 F-16):在同一文件夹复制一份并在新标签打开 */
  private async duplicateCurrent(): Promise<void> {
    const path = this.session.path
    if (!path) {
      this.toast('文档还没有保存', true)
      return
    }
    if (this.session.dirty && !this.session.readOnly) await this.save()
    const copy = await this.fileOps.duplicate(bundleOf(path) ?? path)
    if (copy) await this.openFile(copy, { where: 'tab' })
  }

  /** 文件菜单里针对当前文档的操作:没保存过的新文档没有文件可操作 */
  private withCurrentFile(run: (path: string) => void): void {
    const path = this.session.path
    if (!path) {
      this.toast('文档还没有保存', true)
      return
    }
    run(bundleOf(path) ?? path)
  }

  // ---------- 资源插入(EditorActions) ----------

  private importContext() {
    return {
      host: this.host,
      settings: this.settings,
      docPath: this.session.path,
      copyImagesTo: frontMatterInfo(this.view.state.doc, this.session.path).copyImagesTo,
      dismissWarning: (id: string) => void this.updateSettings({ dismissedWarnings: [...this.settings.dismissedWarnings, id] }),
    }
  }

  async importFiles(view: EditorView, files: ImportFile[], at?: number): Promise<void> {
    try {
      const nodes: PMNode[] = []
      for (const f of files) {
        const r = await importFile(this.importContext(), f)
        // 用户在「目录不存在」或「首次上传」的询问里取消:整批都不插
        if (!r) return
        if (r.kind === 'image') nodes.push(schema.nodes.image.create({ src: r.src, alt: r.name.replace(/\.[^.]+$/, '') }))
        else nodes.push(schema.nodes.media.create({ kind: r.kind, src: r.src, title: r.kind === 'file' ? r.name : '' }))
      }
      if (nodes.length && this.session.path && bundleOf(this.session.path)) this.toast('图片已存储到 TextBundle 文件中')
      const { state } = view
      const pos = at ?? state.selection.from
      const tr = state.tr
      const inline = nodes.every((n) => n.isInline)
      if (inline) {
        tr.insert(pos, nodes)
      } else {
        const $pos = state.doc.resolve(pos)
        const after = $pos.depth > 0 ? $pos.after(1) : pos
        tr.insert(after, nodes.map((n) => (n.isInline ? schema.nodes.paragraph.create(null, n) : n)))
      }
      view.dispatch(tr.scrollIntoView())
    } catch (err) {
      this.toast(`插入失败:${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  private async insertLocalMedia(view: EditorView, kind: 'image' | 'video' | 'audio' | 'pdf' | 'file'): Promise<void> {
    const ext: Record<string, string[]> = {
      image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic'],
      video: ['mp4', 'mov', 'm4v', 'webm'],
      audio: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac'],
      pdf: ['pdf'],
      file: [],
    }
    const paths = await this.host.openDialog({ multiple: true, extensions: ext[kind].length ? ext[kind] : undefined })
    if (!paths?.length) return
    await this.importFiles(view, paths.map((p) => ({ name: basename(p), path: p })))
  }

  private async insertFromUrl(view: EditorView, kind: 'image' | 'embed' | 'bookmark' | 'video' | 'audio'): Promise<void> {
    const titles = { image: '图片网址', embed: '要嵌入的网址(YouTube、哔哩哔哩、Figma……)', bookmark: '网页地址', video: '视频网址', audio: '音频网址' }
    const coords = view.coordsAtPos(view.state.selection.from)
    const url = await promptInput({ title: titles[kind], placeholder: 'https://', anchor: coords, validate: validateUrl })
    view.focus()
    if (!url) return
    let src = url
    if (kind === 'image') {
      // 偏好「对网络位置的图片应用上述规则」(PI-02):下载到资源文件夹或转传上传服务
      try {
        const local = await importNetworkImage(this.importContext(), url)
        if (local === null) return
        src = local
      } catch (err) {
        this.toast(`插入失败:${err instanceof Error ? err.message : String(err)}`, true)
        return
      }
    }
    const { state } = view
    const n = schema.nodes
    let node: PMNode
    if (kind === 'image') node = n.paragraph.create(null, n.image.create({ src }))
    else if (kind === 'embed') {
      const target = detectEmbed(url)
      node = n.media.create({ kind: target?.kind === 'embed' ? 'embed' : target && target.kind !== 'image' ? target.kind : 'embed', src: target?.src ?? url })
    } else node = n.media.create({ kind, src: url })
    const $from = state.selection.$from
    const para = $from.parent
    const tr = state.tr
    if (para.type === n.paragraph && para.content.size === 0) tr.replaceWith($from.before(), $from.after(), node)
    else tr.insert($from.after(1), node)
    view.dispatch(tr.scrollIntoView())
  }

  /** [[ / 「链接到文档」:选当前文件夹里的文档,插入相对链接 [标题](相对路径.md)。 */
  /** 指向 path 的相对链接(相对当前文档所在文件夹)。 */
  private docHref(path: string, root: string): string {
    return markdownHref(relativePath(this.session.path ? dirname(this.session.path) : root, path))
  }

  /** @ 提及的候选文档:根文件夹(或当前文档所在文件夹)下的 Markdown,最近打开的排前面。 */
  private async listDocuments(): Promise<DocumentRef[]> {
    const root = this.sidebar.rootFolder ?? (this.session.path ? dirname(this.session.path) : null)
    if (!root) return []
    const files = (await this.host.listMarkdown(root)).filter((p) => p !== this.session.path)
    const recent = new Map(this.recent.map((p, i) => [p, i]))
    files.sort((a, b) => (recent.get(a) ?? Infinity) - (recent.get(b) ?? Infinity))
    // 标题取目标文档首个一级标题,没有则用文件名(notion-input.md 4.3)
    return documentRefs(this.host, files, root, this.session.path ? dirname(this.session.path) : root)
  }

  /** [[ 的「+ 新建」与 /page:在当前文档所在文件夹(未保存时为根文件夹)新建文档。 */
  private async createLinkedDocument(name: string, content: string): Promise<DocumentRef | null> {
    const dir = this.session.path ? dirname(this.session.path) : this.sidebar.rootFolder
    if (!dir) {
      this.toast('先保存当前文档或打开文件夹,才能新建文档', true)
      return null
    }
    try {
      const ref = await createDocumentIn(this.host, dir, name, content, dir)
      this.sidebar.refresh()
      return ref
    } catch (err) {
      this.toast(`新建文档失败:${err instanceof Error ? err.message : String(err)}`, true)
      return null
    }
  }

  private async insertDocLink(view: EditorView): Promise<void> {
    const root = this.sidebar.rootFolder ?? (this.session.path ? dirname(this.session.path) : null)
    if (!root) {
      this.toast('先保存文档或打开文件夹,才能链接到其它文档', true)
      return
    }
    const files = (await this.host.listMarkdown(root)).filter((p) => p !== this.session.path)
    showQuickOpen({
      root,
      files,
      recent: this.recent.filter((p) => p !== this.session.path),
      open: (path) => {
        const href = this.docHref(path, root)
        const title = basename(path).replace(/\.(md|markdown)$/i, '')
        const { from, to } = view.state.selection
        const tr = view.state.tr.insertText(title, from, to)
        tr.addMark(from, from + title.length, schema.marks.link.create({ href }))
        view.dispatch(tr)
        view.focus()
      },
    })
  }

  /**
   * 打开文档内链接(PRD 3.2):`#标题` 文内跳转并入后退栈;本地文档按 where 打开(⌘+点击新标签、⌥⇧+点击新窗口);
   * 其它本机文件用默认应用;目标不存在时询问「无法打开 X,是否在 Y 新建文件并继续?」。
   */
  private async openLink(target: string, where: OpenWhere | boolean): Promise<void> {
    const w: OpenWhere = where === true ? 'tab' : where === false ? 'current' : where
    let t: LinkTarget
    try {
      t = await resolveLinkTarget(this.host, target, this.env.ctx, this.sidebar.rootFolder)
    } catch (err) {
      this.toast(`无法打开链接:${errText(err)}`, true)
      return
    }
    switch (t.kind) {
      case 'anchor':
        this.jumpToAnchor(t.anchor)
        return
      case 'file':
        await this.host.openWithDefaultApp(t.path).catch((err: unknown) => this.toast(errText(err), true))
        return
      case 'doc': {
        if (t.path === this.session.path || t.path === bundleOf(this.session.path ?? '')) {
          if (t.anchor) this.jumpToAnchor(t.anchor)
          return
        }
        const loaded = await this.openFile(t.path, { where: w })
        if (loaded && t.anchor) scrollToAnchor(this.view, t.anchor)
        return
      }
      case 'missing': {
        if (!t.creatable) {
          this.toast('目标文件或文件夹不存在。', true)
          return
        }
        const choice = await this.host.confirm({ title: `无法打开 ${basename(t.path)},是否在 ${dirname(t.path)} 新建文件并继续?`, message: '', buttons: ['新建', '取消'] })
        if (choice !== 0) return
        try {
          await this.host.writeText(t.path, '')
        } catch (err) {
          this.toast(`新建失败:${errText(err)}`, true)
          return
        }
        this.sidebar.refresh()
        await this.openFile(t.path, { where: w })
      }
    }
  }

  // ---------- 导出 ----------

  /** 导出(流程见 export-flow.ts):formatId 为内置格式名或 item:导出项 ID;mode 为重复导出(F-37、F-38)。 */
  private async exportAs(formatId: string, mode: 'new' | 'previous' | 'overwrite' = 'new'): Promise<void> {
    if (this.session.loading) {
      this.toast('文档还在载入,载入完成后才能导出', true)
      return
    }
    if (this.session.readOnly === 'large') {
      this.toast('文件过大,以只读源码方式打开,不能导出', true)
      return
    }
    if (this.source) this.toggleSourceMode(false)
    const first = this.view.state.doc.firstChild
    await runExport(
      {
        host: this.host,
        settings: this.settings,
        systemDark: this.systemDark,
        view: this.view,
        docPath: this.session.path,
        markdown: this.session.serialize(this.view.state.doc),
        fallbackName: this.firstHeadingText(),
        frontMatter: first?.type === schema.nodes.frontmatter ? first.textContent : null,
        update: (patch) => this.updateSettings(patch),
        toast: (message, error) => this.toast(message, error),
      },
      formatId,
      mode,
    ).catch((err: unknown) => this.toast(`导出失败:${err instanceof Error ? err.message : String(err)}`, true))
  }

  /** 从 Finder 拖进窗口的文件(外壳给真实路径):落在编辑区按类型处理(PF-08 ~ PF-10),落在别处交给那里的界面。 */
  private async onNativeDrop(paths: string[], x: number, y: number): Promise<void> {
    const target = document.elementFromPoint(x, y)
    if (!target || !this.els.main.contains(target)) {
      target?.dispatchEvent(new CustomEvent('tz-file-drop', { bubbles: true, detail: { paths } }))
      return
    }
    if (this.source) {
      this.toast('源代码模式下不能拖入文件,请先退出源代码模式', true)
      return
    }
    const at = this.view.posAtCoords({ left: x, top: y })?.pos ?? this.view.state.selection.from
    try {
      await handleDroppedPaths(
        {
          host: this.host,
          settings: this.settings,
          view: this.view,
          docPath: this.session.path,
          openFolder: (path) => {
            this.sidebar.setRoot(path)
            void this.updateSettings({ sidebarVisible: true })
            this.rememberLocation()
          },
          openDocument: (path) => void this.openFile(path, { where: 'window' }),
          importDocument: (path) => this.importDocument(path),
          importFiles: (files, pos) => this.importFiles(this.view, files, pos),
        },
        paths,
        at,
      )
    } catch (err) {
      this.toast(`拖入失败:${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  /** 经 Pandoc 导入(docx 等)后在新窗口打开;没装 Pandoc 时给安装说明(PRD 3.12、对照表 F-21)。 */
  private async importDocument(path: string): Promise<void> {
    try {
      const markdownPath = await this.host.importDocument(path)
      await this.host.openDocument(markdownPath, { newWindow: true })
    } catch (err) {
      await reportPandocOrError(this.host, (message, error) => this.toast(message, error), err, '导入失败:')
    }
  }

  // ---------- 命令 ----------

  private runAppCommand(id: string): void {
    runCommand(this.view, id)
  }

  /** 写纯文本进系统剪贴板。走宿主:菜单栏转来的命令不算一次用户操作,网页自己的拷贝(navigator.clipboard、execCommand)在 WebKit 里可能写不进去 */
  private copyText(text: string): void {
    this.host.clipboardWrite({ text }).catch((err: unknown) => this.toast(`复制失败:${errText(err)}`, true))
  }

  private registerCommands(): void {
    const cmd = (id: string, label: string, run: () => void) => registerCommand({ id, label, run: () => (run(), true) })
    cmd('file.save', '保存', () => void this.save())
    cmd('file.saveAs', '另存为…', () => void this.saveAs())
    cmd('file.newWindow', '新建', () => void this.host.openDocument('', { newWindow: true }))
    cmd('file.newDocument', '新建文档', () => void this.host.openDocument('', { newWindow: true }))
    cmd('file.open', '打开…', () => {
      void this.host.openDialog({ extensions: [...TEXT_EXTENSIONS, 'textbundle'] }).then((p) => {
        if (p?.[0]) void this.openFile(p[0])
      })
    })
    cmd('file.openFolder', '打开文件夹…', () => {
      void this.host.openDialog({ directory: true }).then((p) => {
        if (p?.[0]) {
          this.sidebar.setRoot(p[0])
          void this.updateSettings({ sidebarVisible: true })
          this.rememberLocation()
        }
      })
    })
    cmd('file.quickOpen', '快速打开…', () => {
      const root = this.sidebar.rootFolder
      void (root ? this.host.listMarkdown(root) : Promise.resolve([])).then((files) =>
        showQuickOpen({ root, files, recent: this.recent, titles: (paths) => this.host.firstHeadings(paths), open: (p, where) => void this.openFile(p, { where }) }),
      )
    })
    cmd('file.revealInFinder', '在 Finder 中显示', () => {
      // TextBundle 显示包本身(与侧栏右键一致),不是包里的 text.md
      if (this.session.path) void this.host.revealInFinder(bundleOf(this.session.path) ?? this.session.path)
    })
    cmd('file.copyPath', '复制当前文档路径', () => {
      if (this.session.path) {
        this.copyText(this.session.path)
        this.toast('已复制文档路径')
      }
    })
    cmd('file.history', '浏览所有版本…', () => {
      const path = this.session.path
      // 本机快照 + 云端版本(文件在同步文件夹里时);未保存的新文档只看「已删除的文件」
      const load = async (): Promise<[HistoryEntry[], Awaited<ReturnType<SyncController['cloudVersions']>>]> =>
        path ? Promise.all([this.host.historyList(path), this.sync.cloudVersions(path)]) : [[], []]
      void load().then(
        ([entries, cloud]) =>
          showHistory({
            host: this.host,
            path,
            entries,
            cloud: cloud.map((v) => {
              // 云端版本时间是 RFC 3339 字符串
              const time = Date.parse(v.mtime)
              return {
                time,
                label: formatVersionTime(time),
                meta: `云端 · 第 ${v.version} 版 · ${v.thisDevice ? '本机' : '其他设备'} · ${(v.size / 1024).toFixed(1)} KB`,
                load: () => this.sync.readVersion(path ?? '', v.version),
              }
            }),
            current: () => this.session.serialize(this.currentDoc()),
            restore: (text, time) => this.restoreVersion(text, time),
            recover: (deleted, text, time) => this.recoverDeleted(deleted, text, time),
            toast: (message, error) => this.toast(message, error),
          }),
        (err: unknown) => this.toast(`读取历史版本失败:${errText(err)}`, true),
      )
    })
    cmd('file.reload', '从磁盘重新载入', () => void this.revertToSaved())
    cmd('file.revert', '复原到已保存', () => void this.revertToSaved())
    cmd('file.info', '显示简介…', () => this.withCurrentFile((p) => void this.fileOps.showInfo(p, '简介')))
    cmd('file.revealInList', '在文档列表中显示', () =>
      this.withCurrentFile((p) => {
        void this.updateSettings({ sidebarVisible: true })
        void this.sidebar.revealInList(p)
      }),
    )
    cmd('file.revealInTree', '在文件树中显示', () =>
      this.withCurrentFile((p) => {
        void this.updateSettings({ sidebarVisible: true })
        void this.sidebar.revealInTree(p)
      }),
    )
    cmd('file.rename', '重命名…', () => this.withCurrentFile((p) => void this.fileOps.rename(p)))
    cmd('file.moveTo', '移动到…', () => this.withCurrentFile((p) => void this.fileOps.chooseAndMove(p)))
    cmd('file.duplicate', '创建副本', () => void this.duplicateCurrent())
    cmd('file.delete', '删除…', () => this.withCurrentFile((p) => void this.fileOps.trash(p)))
    cmd('file.reopenWithEncoding', '以其它编码重新打开…', () => {
      const path = this.session.path
      if (!path) return
      void promptInput({ title: '编码', placeholder: 'utf-8 / gb18030 / big5 / shift_jis / utf-16le', value: this.session.encoding }).then((enc) => {
        if (enc) void this.openFile(path, { replace: true, encoding: enc })
      })
    })
    // 深色主题时临时改用浅色主题打印(PRD 3.12);离视口远的图表、公式预览先画齐
    cmd('file.print', '打印…', () =>
      void renderCodePreviews(this.view)
        .then(() => printDocument(this.host, this.settings, this.systemDark, () => this.applyAppearance()))
        .catch((err: unknown) => this.toast(`打印失败:${err instanceof Error ? err.message : String(err)}`, true)),
    )
    for (const f of ['pdf', 'html', 'html-plain', 'image', 'docx', 'odt', 'rtf', 'epub', 'latex', 'mediawiki', 'rst', 'textile', 'opml'] as ExportFormat[]) {
      cmd(`file.export.${f}`, `导出 ${f}`, () => void this.exportAs(f))
    }
    cmd('file.exportPrevious', '使用上一次设置导出', () => void this.exportAs('', 'previous'))
    cmd('file.exportOverwrite', '导出并覆盖上一次导出的文件', () => void this.exportAs('', 'overwrite'))
    cmd('nav.back', '后退', () => void this.navigate(-1))
    cmd('nav.forward', '前进', () => void this.navigate(1))
    cmd('view.outlinePopover', '大纲窗口', () => {
      const headings = collectHeadings(this.view.state.doc)
      const pos = this.view.state.selection.from
      showOutlinePopover(headings, headings.reduce((active, x, i) => (x.pos <= pos ? i : active), -1), (item) => this.jumpToHeading(item))
    })
    cmd('view.toggleSidebar', '显示 / 隐藏侧栏', () => void this.updateSettings({ sidebarVisible: !this.settings.sidebarVisible }))
    for (const [id, tab] of [
      ['view.outline', 'outline'],
      ['view.docList', 'list'],
      ['view.fileTree', 'files'],
      ['view.search', 'search'],
    ] as [string, SidebarTab][]) {
      cmd(id, tab, () => {
        void this.updateSettings({ sidebarVisible: true })
        void this.sidebar.setTab(tab)
      })
    }
    cmd('view.sourceMode', '源代码模式', () => this.toggleSourceMode())
    cmd('view.focusMode', '专注模式', () => void this.updateSettings({ focusMode: !this.settings.focusMode }))
    cmd('view.typewriterMode', '打字机模式', () => void this.updateSettings({ typewriterMode: !this.settings.typewriterMode }))
    cmd('view.statusBar', '显示状态栏', () => void this.updateSettings({ showStatusBar: !this.settings.showStatusBar }))
    cmd('view.zoomIn', '放大', () => void this.updateSettings({ zoom: clampZoom(Math.round((this.settings.zoom + 0.1) * 10) / 10) }))
    cmd('view.zoomOut', '缩小', () => void this.updateSettings({ zoom: clampZoom(Math.round((this.settings.zoom - 0.1) * 10) / 10) }))
    cmd('view.zoomReset', '实际大小', () => void this.updateSettings({ zoom: 1 }))
    cmd('view.pinchZoom', '双指缩放', () => void this.updateSettings({ pinchZoom: !this.settings.pinchZoom }))
    cmd('view.toggleDark', '切换浅色 / 深色', () => void this.updateSettings({ appearance: isDarkMode(this.settings, this.systemDark) ? 'light' : 'dark' }))
    cmd('view.wordCount', '字数统计', () => {
      const doc = this.view.state.doc
      const { from, to, empty } = this.view.state.selection
      const speed = this.settings.readingSpeed
      showWordCount(countWords(doc.textBetween(0, doc.content.size, '\n\n', ' '), speed), empty ? null : countWords(doc.textBetween(from, to, '\n\n', ' '), speed))
    })
    cmd('view.pageWidth', '页面宽度', () => {
      const order: AppSettings['pageWidth'][] = ['normal', 'wide', 'full']
      void this.updateSettings({ pageWidth: order[(order.indexOf(this.settings.pageWidth) + 1) % order.length] })
    })
    for (const t of BUILTIN_THEMES) cmd(`theme.${t.id}`, t.label, () => void this.setTheme(t.id))
    cmd('theme.openFolder', '打开主题文件夹', () =>
      void openThemesFolder(this.host).catch((err: unknown) => this.toast(`打开主题文件夹失败:${err instanceof Error ? err.message : String(err)}`, true)),
    )
    cmd('app.preferences', '偏好设置…', () => this.openPreferences())
    cmd('app.syncPreferences', '云同步…', () => this.openPreferences('云同步'))
    cmd('app.exportSettings', '导出设置…', () => this.openPreferences('导出'))
    cmd('edit.copyMarkdown', '复制为 Markdown', () => {
      const { from, to } = this.view.state.selection
      this.copyText(sliceToMarkdown(this.view.state.doc.slice(from, to).content, this.env))
    })
    cmd('edit.copyPlain', '复制为纯文本', () => {
      const { from, to } = this.view.state.selection
      this.copyText(this.view.state.doc.textBetween(from, to, '\n\n', ' '))
    })
    cmd('edit.copyHtml', '复制为 HTML 代码', () => {
      const { dom } = this.view.serializeForClipboard(this.view.state.selection.content())
      this.copyText(dom.innerHTML)
    })
    cmd('block.toDocument', '转为新文档', () => void this.blockToDocument())
    // 「格式 ▸ 图像」(含 insert.image)与「编辑」菜单补齐的命令
    registerImageCommands({
      host: this.host,
      env: this.env,
      settings: () => this.settings,
      docPath: () => this.session.path,
      toast: (message, error) => this.toast(message, error),
      importFile: (file) => importFile(this.importContext(), file),
      upload: (paths) => uploadImages(this.importContext(), paths),
      setFrontMatter: (key, value) => this.setFrontMatter(key, value),
      openPreferences: (page) => this.openPreferences(page),
    })
    registerEditCommands({
      host: this.host,
      session: this.session,
      settings: () => this.settings,
      updateSettings: (patch) => this.updateSettings(patch),
      markDirty: () => this.onDocChange(),
      toast: (message, error) => this.toast(message, error),
      openPreferences: (page) => this.openPreferences(page),
    })
    // 斜杠 /icon、/cover(对照表 Z-11)
    cmd('page.icon', '页面图标', () => void this.pickIcon())
    cmd('page.cover', '页面封面', () => void this.pickCover())
  }

  /** 其它模块(如云同步)往偏好设置里加的页签。 */
  extraSettingsSections: { title: string; render: () => HTMLElement }[] = []

  /** 打开偏好设置;page 为页名(如「图像」「导出」),其它模块的菜单项按页名直达。 */
  openPreferences(page?: string): void {
    showPreferences(
      {
        settings: this.settings,
        host: this.host,
        update: (patch) => this.updateSettings(patch),
        toast: (message, error) => this.toast(message, error),
        clearRecent: () => {
          this.recent = []
          return this.host.clearRecentDocuments()
        },
        extraSections: this.extraSettingsSections,
      },
      page,
    )
  }

  /** ⌥⌘9:把当前块转成新文档——以块文字为文件名在当前文件夹新建,原处换成指向它的链接。 */
  private async blockToDocument(): Promise<void> {
    const dir = this.session.path ? dirname(this.session.path) : this.sidebar.rootFolder
    if (!dir) {
      this.toast('先保存当前文档,才能在同一文件夹里新建', true)
      return
    }
    const { $from } = this.view.state.selection
    const block = $from.parent
    const title = (block.textContent.trim() || '未命名').replace(/[/:]/g, '-').slice(0, 80)
    let path = joinPath(dir, `${title}.md`)
    for (let i = 1; await this.host.stat(path); i++) path = joinPath(dir, `${title}-${i}.md`)
    await this.host.writeText(path, `# ${title}\n`)
    const href = markdownHref(relativePath(dir, path))
    const start = $from.start()
    const end = $from.end()
    const tr = this.view.state.tr.replaceWith(start, end, schema.text(title, [schema.marks.link.create({ href })]))
    this.view.dispatch(tr)
    this.sidebar.refresh()
    this.toast(`已新建「${basename(path)}」`)
  }

  private bindHostEvents(): void {
    this.host.on('menu.command', ({ id }) => {
      if (isLightboxOpen() && id !== 'app.preferences') closeLightbox()
      // 主题菜单里的自定义主题(主题文件夹里的 css)没有预先注册的命令
      if (id.startsWith('theme.') && !getCommand(id)) {
        void this.setTheme(id.slice('theme.'.length))
        return
      }
      try {
        runCommand(this.view, id)
      } catch (err) {
        this.toast(err instanceof Error ? err.message : String(err), true)
      }
    })
    this.host.on('app.open', ({ path, isDir }) => {
      if (isDir && !isTextBundle(path)) {
        this.sidebar.setRoot(path)
        this.rememberLocation()
      } else void this.openFile(path)
    })
    this.host.on('app.dropFiles', ({ paths, x, y }) => void this.onNativeDrop(paths, x, y))
    this.host.on('fs.changed', ({ paths }) => {
      if (this.session.path && paths.some((p) => p === this.session.path)) void this.onExternalChange()
      this.sidebar.refresh()
    })
    this.host.on('app.appearance', ({ dark }) => {
      this.systemDark = dark
      this.applyAppearance()
    })
    this.host.on('window.willClose', () => {
      void this.confirmLeave('close').then((ok) => {
        if (ok) this.host.closeWindow()
      })
    })
  }

  /** 浏览器里(开发、E2E)没有原生菜单,应用级快捷键(含用户自定义的)由网页自己处理。 */
  private bindBrowserKeys(): void {
    if (this.host.platform !== 'browser') return
    window.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return
      const found = appKeyTable(this.settings.keybindings).get(keyName(e))
      const id = found ? (BROWSER_ALIASES[found] ?? found) : undefined
      // native.* 只有原生外壳能做(新标签页、全部保存……)
      if (!id || id.startsWith('native.')) return
      e.preventDefault()
      runCommand(this.view, id)
    })
  }

  // ---------- 提示 ----------

  toast(message: string, error = false, action?: { label: string; run: () => void }): void {
    const t = this.els.toast
    t.replaceChildren(message)
    if (action) {
      const btn = h('button', { type: 'button', class: 'tz-toast-action' }, action.label)
      btn.addEventListener('click', () => {
        t.hidden = true
        action.run()
      })
      t.append(btn)
    }
    t.classList.toggle('is-error', error)
    t.hidden = false
    clearTimeout(Number(t.dataset.timer))
    // 带操作按钮的提示多留一会儿,给用户时间点
    t.dataset.timer = String(window.setTimeout(() => (t.hidden = true), action ? 12000 : error ? 6000 : 2500))
  }

  /** 发给 AI 的当前文档:Markdown 原文,换行统一为 \n、去掉 BOM(doc.edit 的偏移也按这个算) */
  private aiDocumentText(): string {
    return this.session
      .serialize(this.currentDoc())
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
  }

  /** 供 E2E 与冒烟测试使用的当前 Markdown。 */
  markdown(): string {
    return this.session.serialize(this.currentDoc())
  }
}
