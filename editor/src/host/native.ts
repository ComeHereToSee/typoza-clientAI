// 原生宿主:经 WKScriptMessageHandlerWithReply(名为 typoza)调用 Swift;Swift 通过 window.__typozaEmit 推事件。
import { AiError, type AiCallReply, type AiEvent } from './ai-types'
import { type Host, type HostEvents, SyncError } from './types'

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, { postMessage(msg: unknown): Promise<unknown> }> }
    __typozaEmit?: (event: string, payload: unknown) => void
  }
}

type Listener = (payload: unknown) => void

export interface AppInfo {
  home: string
  /** 应用数据目录与缓存目录(随应用包的名称与标识,派生版本各用各的) */
  dataDir: string
  cacheDir: string
  version: string
  /** 启动时要打开的文件或文件夹(Finder 双击打开时由外壳传入) */
  openPath: string | null
  openIsDir: boolean
  dark: boolean
  /** 应用启动时建的第一个窗口 */
  launch?: boolean
}

function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const handler = window.webkit?.messageHandlers?.typoza
  if (!handler) return Promise.reject(new Error(`原生桥接不可用,无法调用 ${method}`))
  return handler.postMessage({ method, params }) as Promise<T>
}

export function hasNativeBridge(): boolean {
  return Boolean(window.webkit?.messageHandlers?.typoza)
}

export async function createNativeHost(): Promise<{ host: Host; info: AppInfo }> {
  const info = await call<AppInfo>('app.info')
  const listeners = new Map<string, Set<Listener>>()
  window.__typozaEmit = (event, payload) => {
    for (const fn of listeners.get(event) ?? []) fn(payload)
  }

  const host: Host = {
    platform: 'macos',
    isLaunchWindow: info.launch ?? false,
    resourceURL: (p) => `typoza://local${p.split('/').map(encodeURIComponent).join('/')}`,
    homeDir: () => info.home,
    dataDir: () => info.dataDir,
    cacheDir: () => info.cacheDir,

    readText: (path, encoding) => call('fs.readText', { path, encoding: encoding ?? null }),
    writeText: (path, text, encoding) => call('fs.writeText', { path, text, encoding: encoding ?? null }),
    writeBase64: (path, base64) => call('fs.writeBase64', { path, base64 }),
    copyFile: (from, to) => call('fs.copyFile', { from, to }),
    stat: (path) => call('fs.stat', { path }),
    listDir: (path) => call('fs.listDir', { path }),
    mkdir: (path) => call('fs.mkdir', { path }),
    rename: (from, to) => call('fs.rename', { from, to }),
    trash: (path) => call('fs.trash', { path }),
    watch: (paths) => call('fs.watch', { paths }),
    search: (root, query, options) => call('fs.search', { root, query, ...options }),
    listMarkdown: (root) => call('fs.listMarkdown', { root }),
    firstHeadings: (paths) => call('fs.firstHeadings', { paths }),

    setWindowState: (state) => {
      void call('window.setState', { ...state })
    },
    openDialog: (options) => call('dialog.open', { ...options }),
    saveDialog: (options) => call('dialog.save', { ...options }),
    confirm: (options) => call('dialog.confirm', { ...options }),
    revealInFinder: (path) => call('system.reveal', { path }),
    openExternal: (url) => call('system.openURL', { url }),
    openDocument: (path, options) => call('app.openDocument', { path, newWindow: options?.newWindow ?? false, tab: options?.tab ?? false }),
    focusDocument: (path) => call('app.focusDocument', { path }),
    quickLook: (path) => call('system.quickLook', { path }),
    openWith: (path) => call('system.openWith', { path }),
    openWithDefaultApp: (path) => call('system.openWithDefaultApp', { path }),
    copyImageToClipboard: (path) => call('system.copyImage', { path }),
    fetchLinkPreview: (url) => call('net.linkPreview', { url }),
    closeWindow: () => {
      void call('window.close')
    },

    getSettings: () => call('settings.get'),
    setSettings: (patch) => call('settings.set', { patch }),

    historyList: (path) => call('history.list', { path }),
    historyRead: (path, id) => call('history.read', { path, id }),
    historySnapshot: (path, text) => call('history.snapshot', { path, text }),
    historyDeleted: () => call('history.deleted'),

    draftSave: (id, text) => call('draft.save', { id, text }),
    draftRemove: (id) => call('draft.remove', { id }),
    draftPending: () => call('draft.pending'),

    exportDocument: (options) => call('export.run', { ...options }),
    print: () => call('export.print'),
    uploadImages: (options, paths) => call('image.upload', { service: options.service, command: options.command, paths }),
    downloadFile: (url, target) => call('net.download', { url, target }),
    importDocument: (path) => call('app.importDocument', { path }),
    runCommand: (command, cwd) => call('system.runCommand', { command, cwd }),
    clearRecentDocuments: () => call('system.clearRecent'),
    setSpellingLanguage: (language) => call('system.setSpellingLanguage', { language }),
    setMenuKeys: (overrides) => call('menu.setKeys', { overrides }),
    setExportItems: (items) => call('menu.setExportItems', { items }),
    runNativeCommand: (id) => call('app.nativeCommand', { id }),

    async syncCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const r = await call<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>('sync.call', { method, params })
      if (!r.ok) throw new SyncError(r.error?.code ?? 'error', r.error?.message ?? '云同步出错')
      return r.result as T
    },

    // 与 syncCall 同一套返回结构:外壳把 ai.* 转给辅助进程,结果里带 ok 与错误码
    async aiCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const r = await call<AiCallReply>('ai.call', { method, params })
      if (!r.ok) throw new AiError(r.error?.code ?? 'internal', r.error?.message ?? 'AI 调用出错')
      return r.result as T
    },
    onAiEvent(cb) {
      const set = listeners.get('ai.event') ?? new Set<Listener>()
      listeners.set('ai.event', set)
      const fn: Listener = (payload) => cb(payload as AiEvent)
      set.add(fn)
      return () => {
        set.delete(fn)
      }
    },

    clipboardWrite: (data) => call('clipboard.write', { text: data.text, html: data.html ?? null, rtf: data.rtf ?? false }),
    clipboardText: () => call('clipboard.readText'),
    copyRegionAsImage: (rect) => call('clipboard.snapshot', { ...rect }),
    nativePaste: () => call('edit.paste'),
    checkEmbed: (url) => call('net.checkEmbed', { url }),
    download: (url, to) => call('net.downloadNew', { url, to }),
    openInPreview: (path) => call('system.openInPreview', { path }),

    on<K extends keyof HostEvents>(event: K, handler: (payload: HostEvents[K]) => void) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(handler as Listener)
      return () => set.delete(handler as Listener)
    },
  }
  return { host, info }
}

/** 少量不经 Host 抽象的原生调用(同步、历史等由各模块直接用)。 */
export const nativeCall = call
