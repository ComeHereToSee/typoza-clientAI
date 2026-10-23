// 宿主接口:编辑内核(网页)与 macOS 外壳(Swift)之间的桥接契约。
// 原生实现见 native.ts(经 WKScriptMessageHandlerWithReply 调 Swift);浏览器开发与 E2E 用 memory.ts。
// 方法名同时是桥接消息的 method(如 fs.readText),Swift 侧 BridgeRouter 按同名分发。
import type { AiEvent } from './ai-types'

export interface FileStat {
  path: string
  name: string
  isDir: boolean
  size: number
  /** 修改时间,毫秒时间戳 */
  mtime: number
  /** 创建时间,毫秒时间戳(取不到时省略) */
  ctime?: number
  /** 能否写入(文件本身与所在文件夹都可写);省略表示未知,按可写处理 */
  writable?: boolean
}

export interface ReadResult {
  text: string
  /** 实际使用的编码名(utf-8 / gb18030 / big5 / shift_jis / utf-16le …) */
  encoding: string
  mtime: number
}

export interface SearchOptions {
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  /** 最多返回多少个文件 */
  limit: number
  /** 只搜这些文件(侧栏分批搜索,边搜边显示);省略时搜 root 下全部可打开文件 */
  paths?: string[]
  /** 命中行累计到这个数就停(PRD 3.9:超过 1000 处提示「匹配结果过多」) */
  maxMatches?: number
}

export interface SearchHit {
  path: string
  /** 文件名本身匹配(PRD 3.9 全局搜索文件名与正文) */
  nameMatch?: boolean
  /** 命中行(去掉首尾空白,最长 200 字符) */
  matches: { line: number; text: string }[]
}

export interface LinkPreview {
  url: string
  title: string
  description: string
  image: string | null
  icon: string | null
}

export interface HistoryEntry {
  id: string
  /** 毫秒时间戳 */
  time: number
  size: number
  source: 'local' | 'cloud'
}

/** 历史版本还在、文件已不在原位置的文档(PRD 3.14「已删除的文件」) */
export interface DeletedHistoryFile {
  path: string
  /** 最近一个版本的时间,毫秒时间戳 */
  time: number
  count: number
}

/** 外壳要求本窗口恢复的未命名草稿 */
export interface DraftRestore {
  id: string
  text: string
}

export type ExportFormat =
  | 'pdf'
  | 'html'
  | 'html-plain'
  | 'image'
  | 'docx'
  | 'odt'
  | 'rtf'
  | 'epub'
  | 'latex'
  | 'mediawiki'
  | 'rst'
  | 'textile'
  | 'opml'
  /** 用户添加的 Pandoc 导出项:目标格式等放在 options 里 */
  | 'pandoc'

export type EmbedCheck = 'ok' | 'refused' | 'unreachable'

export interface ConfirmOptions {
  title: string
  message: string
  buttons: string[]
  style?: 'info' | 'warning' | 'critical'
}

export interface WindowState {
  /** 当前文档路径;未保存的新文档为 null */
  path: string | null
  title: string
  edited: boolean
  /** 当前文档有可重复的导出(菜单「使用上一次设置导出」等是否可用) */
  hasLastExport?: boolean
}

export interface HostEvents {
  /** 菜单栏或系统发来的命令 ID(与编辑器命令注册表同名) */
  'menu.command': { id: string }
  /** 监听的文件或目录有变化 */
  'fs.changed': { paths: string[] }
  /** 原生要求打开某个文件 / 文件夹(Finder 双击、拖到 Dock 图标、最近文件) */
  'app.open': { path: string; isDir: boolean }
  /** 窗口将要关闭:网页侧保存或询问后调用 window.close 回执 */
  'window.willClose': Record<string, never>
  /** 系统外观切换 */
  'app.appearance': { dark: boolean }
  /** 云同步通知(外壳转发辅助进程的 sync.status / sync.event) */
  'sync.event': { method: string; params: unknown }
  /** 从 Finder 拖进窗口的文件(外壳截下拖放,带真实路径;x、y 为网页视口坐标) */
  'app.dropFiles': { paths: string[]; x: number; y: number }
}

/** 云同步调用失败:code 是辅助进程给的错误码(如 totp_required、session_lost),message 可直接展示。 */
export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'SyncError'
  }
}

export interface Host {
  readonly platform: 'macos' | 'browser'
  /** 应用启动时建的第一个窗口(偏好「启动时」选项只对它生效) */
  readonly isLaunchWindow: boolean

  /** 本机文件在网页里可加载的地址(typoza://local/…) */
  resourceURL(absPath: string): string
  /** 展开 ~ 开头的路径 */
  homeDir(): string
  /** 应用数据目录(~/Library/Application Support/<应用名>):派生版本与基础版同机并装时各用各的 */
  dataDir(): string
  /** 应用缓存目录(~/Library/Caches/<应用名>) */
  cacheDir(): string

  // 文件
  readText(path: string, encoding?: string): Promise<ReadResult>
  writeText(path: string, text: string, encoding?: string): Promise<{ mtime: number }>
  writeBase64(path: string, base64: string): Promise<void>
  copyFile(from: string, to: string): Promise<void>
  stat(path: string): Promise<FileStat | null>
  listDir(path: string): Promise<FileStat[]>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** 移到废纸篓;返回它在废纸篓里的路径(撤销用),拿不到时为 null */
  trash(path: string): Promise<string | null>
  watch(paths: string[]): Promise<void>
  search(root: string, query: string, options: SearchOptions): Promise<SearchHit[]>
  /** 列出目录下全部 Markdown 文件(递归,用于快速打开与 [[ 链接) */
  listMarkdown(root: string): Promise<string[]>
  /** 各文件的第一个标题(快速打开按标题匹配),与 paths 一一对应;没有标题为 null */
  firstHeadings(paths: string[]): Promise<(string | null)[]>

  // 窗口与系统
  setWindowState(state: WindowState): void
  openDialog(options: { directory?: boolean; multiple?: boolean; extensions?: string[] }): Promise<string[] | null>
  /** directory:初始文件夹;不给时用当前文档所在文件夹 */
  saveDialog(options: { defaultName: string; extensions?: string[]; directory?: string }): Promise<string | null>
  confirm(options: ConfirmOptions): Promise<number>
  revealInFinder(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** 在 Typoza 里另开一个文档:tab 开成当前窗口组里的新标签,newWindow 开新窗口;已在别处打开时切过去 */
  openDocument(path: string, options?: { newWindow?: boolean; tab?: boolean }): Promise<void>
  /** 这个文件已在别的窗口或标签里打开时切过去并返回 true(同一文件只开一处) */
  focusDocument(path: string): Promise<boolean>
  /** 快速查看(Quick Look) */
  quickLook(path: string): Promise<void>
  /** 选一个应用打开(打开方式…) */
  openWith(path: string): Promise<void>
  /** 用系统默认应用打开本机文件(附件块) */
  openWithDefaultApp(path: string): Promise<void>
  copyImageToClipboard(path: string): Promise<void>
  fetchLinkPreview(url: string): Promise<LinkPreview | null>
  /** 关闭窗口的回执(响应 window.willClose) */
  closeWindow(): void

  // 设置(持久化在应用支持目录)
  getSettings(): Promise<Record<string, unknown>>
  setSettings(patch: Record<string, unknown>): Promise<void>

  // 本地历史版本
  historyList(path: string): Promise<HistoryEntry[]>
  historyRead(path: string, id: string): Promise<string>
  /** 把一段内容记成不会被合并掉的快照(恢复旧版本前先记下当前内容) */
  historySnapshot(path: string, text: string): Promise<void>
  historyDeleted(): Promise<DeletedHistoryFile[]>

  // 未命名草稿(存 Typoza 数据目录,重启或网页进程崩溃后恢复)
  draftSave(id: string, text: string): Promise<void>
  draftRemove(id: string): Promise<void>
  draftPending(): Promise<DraftRestore | null>

  // 导出与打印
  /** options:各格式参数(PDF 纸张与页首页尾、图片宽度、Pandoc 参数……),键见 ExportService.swift */
  exportDocument(options: { format: ExportFormat; html: string; markdown: string; sourcePath: string | null; target: string; options?: Record<string, unknown> }): Promise<void>
  /** 系统打印;打印面板关闭后才返回 */
  print(): Promise<void>
  /** 用偏好设置的上传服务(uPic、PicGo……或自定义命令)上传图片,返回网址(顺序与 paths 一致) */
  uploadImages(options: { service: string; command: string }, paths: string[]): Promise<string[]>
  /** 下载网络文件到本机路径(插入网络图片时按规则落盘) */
  downloadFile(url: string, target: string): Promise<void>
  /** 经 Pandoc 把 docx 等导入成 Markdown,返回生成的文件路径 */
  importDocument(path: string): Promise<string>
  /** 在 shell 里执行用户配置的命令(导出后动作、自定义命令导出),返回退出码与输出 */
  runCommand(command: string, cwd: string | null): Promise<{ status: number; output: string }>

  // 系统集成
  /** 清除「打开最近使用」记录 */
  clearRecentDocuments(): Promise<void>
  /** 拼写检查语言:auto = 自动检测 */
  setSpellingLanguage(language: string): Promise<void>
  /** 原生菜单键位:列出的命令改用给定键位(空串 = 无键位),其余恢复出厂键位 */
  setMenuKeys(overrides: { id: string; key: string }[]): Promise<void>
  /** 文件 ▸ 导出 菜单末尾的用户导出项(点选时发 file.export.item.<id> 命令) */
  setExportItems(items: { id: string; name: string }[]): Promise<void>
  /** 执行外壳的原生菜单命令(native.*,如 native.recoverDrafts),网页里的按钮与菜单走同一条路 */
  runNativeCommand(id: string): Promise<void>

  /** 云同步:调用辅助进程的 sync.* 方法;失败抛 SyncError */
  syncCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>

  /** AI:经外壳调用辅助进程的 ai.* 方法(外壳只放行 ai. 开头、不含 ai.secrets);失败抛 AiError(ai-types.ts) */
  aiCall<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  /** AI 通知(辅助进程发 ai.event,外壳原样广播);返回取消订阅 */
  onAiEvent(cb: (event: AiEvent) => void): () => void

  // 剪贴板、媒体(网页写不了 RTF、读剪贴板会弹系统授权,这些交给外壳)
  /** 清空剪贴板后写入纯文本,可带 HTML;rtf 为 true 时外壳从同一段 HTML 生成 RTF 一并写入 */
  clipboardWrite(data: { text: string; html?: string; rtf?: boolean }): Promise<void>
  /** 剪贴板里的纯文本(没有时为空串) */
  clipboardText(): Promise<string>
  /** 把窗口里的一块区域(CSS 像素,相对视口)截成图片放进剪贴板(「复制为图片」) */
  copyRegionAsImage(rect: { x: number; y: number; width: number; height: number }): Promise<void>
  /** 执行一次系统「粘贴」(右键菜单里的粘贴:网页自己读不到带格式的剪贴板) */
  nativePaste(): Promise<void>
  /** 网址能否被嵌入:站点拒绝(X-Frame-Options / CSP)为 refused,连不上为 unreachable */
  checkEmbed(url: string): Promise<EmbedCheck>
  /** 下载网络文件到本机路径(目标已存在时报错) */
  download(url: string, to: string): Promise<void>
  /** 用系统「预览」打开本机文件(PDF 选中时 ⌘↩) */
  openInPreview(path: string): Promise<void>

  on<K extends keyof HostEvents>(event: K, handler: (payload: HostEvents[K]) => void): () => void
}
