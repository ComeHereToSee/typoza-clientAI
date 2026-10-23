// 内存宿主:浏览器开发与 E2E 测试用。文件全部放在内存里,测试经 window.typozaTest 预置。
import { firstHeadingOf } from '../core/excerpt'
import { isOpenable, isTextBundle, isTextDocument } from '../core/filetypes'
import { createFakeAi, type FakeAi } from './fake-ai'
import { createFakeSync } from './fake-sync'
import type { DeletedHistoryFile, DraftRestore, FileStat, Host, HostEvents, SearchHit } from './types'

type Entry = { kind: 'dir'; mtime: number } | { kind: 'file'; data: string | Uint8Array; mtime: number; ctime?: number; readonly?: boolean }
type Listener = (payload: unknown) => void

/** 本地历史版本(对齐外壳 HistoryStore:写盘前留原文、写盘后记新内容;不做 5 分钟合并) */
interface MemoryVersion {
  id: string
  time: number
  text: string
  pinned: boolean
}

export interface MemoryHost extends Host {
  files: Map<string, Entry>
  settings: Record<string, unknown>
  emit<K extends keyof HostEvents>(event: K, payload: HostEvents[K]): void
  /** 记录调用,测试断言用 */
  calls: { method: string; args: unknown[] }[]
  /** 测试预置的「打开」对话框结果,按调用顺序取出;取空时返回 null(相当于取消) */
  dialogQueue: (string[] | null)[]
  /** 模拟的系统剪贴板(clipboardWrite 写入、clipboardText 读出;测试可直接预置) */
  clipboard: { text: string; html: string | null; rtf: boolean }
  /** 测试预置的确认框选择(按钮序号),按调用顺序取出;取空时返回 0 */
  confirmQueue: number[]
  /** 模拟「已在别的窗口打开」的文件 */
  openElsewhere: Set<string>
  history: Map<string, MemoryVersion[]>
  drafts: Map<string, string>
  /** 模拟外壳要求本窗口恢复的草稿 */
  pendingDraft: DraftRestore | null
  /** 模拟的 AI 服务(测试排脚本、查调用记录) */
  ai: FakeAi
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}

function mime(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

const TRASH = '/Users/test/.Trash'
/** 草稿存在 sessionStorage 里:刷新页面相当于重启应用,用来测「重启后恢复未命名草稿」 */
const DRAFT_STORE = 'typoza.drafts'

function storedDrafts(): Map<string, string> {
  const raw = sessionStorage.getItem(DRAFT_STORE)
  return new Map(Object.entries(raw ? (JSON.parse(raw) as Record<string, string>) : {}))
}

export function createMemoryHost(): MemoryHost {
  const files = new Map<string, Entry>([['/', { kind: 'dir', mtime: Date.now() }]])
  const listeners = new Map<string, Set<Listener>>()
  const blobUrls = new Map<string, string>()
  const calls: MemoryHost['calls'] = []
  const settings: Record<string, unknown> = {}
  const history = new Map<string, MemoryVersion[]>()
  let versionSeq = 0
  const drafts = storedDrafts()
  const saveDrafts = () => sessionStorage.setItem(DRAFT_STORE, JSON.stringify(Object.fromEntries(drafts)))
  const [firstDraft] = drafts

  const ensureDir = (path: string) => {
    const parts = path.split('/').filter(Boolean)
    let cur = ''
    for (const p of parts) {
      cur += `/${p}`
      if (!files.has(cur)) files.set(cur, { kind: 'dir', mtime: Date.now() })
    }
  }
  const put = (path: string, data: string | Uint8Array) => {
    ensureDir(parentOf(path))
    const old = files.get(path)
    files.set(path, { kind: 'file', data, mtime: Date.now(), ctime: old?.kind === 'file' ? old.ctime : Date.now() })
    blobUrls.delete(path)
  }
  const statOf = (path: string, e: Entry): FileStat => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    isDir: e.kind === 'dir',
    size: e.kind === 'file' ? (typeof e.data === 'string' ? e.data.length : e.data.byteLength) : 0,
    mtime: e.mtime,
    ctime: e.kind === 'file' ? (e.ctime ?? e.mtime) : e.mtime,
    writable: !(e.kind === 'file' && e.readonly),
  })
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args })
  const text = (path: string): string => {
    const e = files.get(path)
    if (!e || e.kind !== 'file') throw new Error(`文件不存在:${path}`)
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }
  const snapshot = (path: string, content: string, pinned: boolean) => {
    const list = history.get(path) ?? []
    const last = list[list.length - 1]
    if (last && last.text === content) {
      if (pinned) last.pinned = true
    } else {
      const time = Date.now()
      list.push({ id: String(time * 1000 + (versionSeq++ % 1000)), time, text: content, pinned })
    }
    history.set(path, list)
  }
  /** 整棵子树换位置(改名、移动、移到废纸篓),历史版本跟着走 */
  const moveTree = (from: string, to: string) => {
    for (const [p, e] of [...files]) {
      if (p === from || p.startsWith(`${from}/`)) {
        files.delete(p)
        files.set(to + p.slice(from.length), e)
        blobUrls.delete(p)
      }
    }
    for (const [p, list] of [...history]) {
      if (p === from || p.startsWith(`${from}/`)) {
        history.delete(p)
        history.set(to + p.slice(from.length), list)
      }
    }
  }
  /** 只列可打开的文件;TextBundle 包算一个文件,不列包里的正文 */
  const openableFiles = (root: string): string[] => {
    const prefix = root === '/' ? '/' : `${root}/`
    const out: string[] = []
    for (const [p, e] of files) {
      if (!p.startsWith(prefix) || p.split('/').some((part) => part.startsWith('.'))) continue
      if (p.slice(0, p.lastIndexOf('/')).split('/').some((part) => isTextBundle(part))) continue
      if ((e.kind === 'file' && isTextDocument(p)) || (e.kind === 'dir' && isTextBundle(p))) out.push(p)
    }
    return out.sort()
  }

  // 模拟的云同步:浏览器预览与 E2E 用,行为与错误码对齐辅助进程(helper/internal/syncsvc)
  const fakeSync = createFakeSync({
    emit: (payload) => host.emit('sync.event', payload),
    readText: (path) => (files.has(path) ? text(path) : null),
  })

  // 模拟的 AI 服务:不连网,按测试排好的脚本推事件(行为与错误码对齐辅助进程 helper/internal/aisvc)
  const fakeAi = createFakeAi()

  const host: MemoryHost = {
    platform: 'browser',
    isLaunchWindow: false,
    files,
    settings,
    calls,
    dialogQueue: [],
    clipboard: { text: '', html: null, rtf: false },
    confirmQueue: [],
    openElsewhere: new Set(),
    history,
    drafts,
    pendingDraft: firstDraft ? { id: firstDraft[0], text: firstDraft[1] } : null,
    ai: fakeAi,
    emit(event, payload) {
      for (const fn of listeners.get(event) ?? []) fn(payload)
    },
    resourceURL(path) {
      const e = files.get(path)
      if (!e || e.kind !== 'file') return `memory-missing:${path}`
      let url = blobUrls.get(path)
      if (!url) {
        const part: BlobPart = typeof e.data === 'string' ? e.data : new Uint8Array(e.data)
        url = URL.createObjectURL(new Blob([part], { type: mime(path) }))
        blobUrls.set(path, url)
      }
      return url
    },
    homeDir: () => '/Users/test',
    dataDir: () => '/Users/test/Library/Application Support/Typoza',
    cacheDir: () => '/Users/test/Library/Caches/Typoza',
    async readText(path) {
      return { text: text(path), encoding: 'utf-8', mtime: files.get(path)!.mtime }
    },
    async writeText(path, t) {
      record('writeText', path, t)
      const old = files.get(path)
      if (old?.kind === 'file' && old.readonly) throw new Error(`保存失败:${path}(没有写入权限)`)
      const tracked = isTextDocument(path)
      if (tracked && old?.kind === 'file') snapshot(path, text(path), false)
      put(path, t)
      if (tracked) snapshot(path, t, false)
      return { mtime: files.get(path)!.mtime }
    },
    async writeBase64(path, base64) {
      record('writeBase64', path)
      put(path, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
    },
    async copyFile(from, to) {
      record('copyFile', from, to)
      const e = files.get(from)
      if (!e) throw new Error(`文件不存在:${from}`)
      if (files.has(to)) throw new Error(`目标已存在:${to}`)
      if (e.kind === 'file') {
        put(to, e.data)
        return
      }
      for (const [p, sub] of [...files]) {
        if (p !== from && !p.startsWith(`${from}/`)) continue
        if (sub.kind === 'file') put(to + p.slice(from.length), sub.data)
        else ensureDir(to + p.slice(from.length))
      }
    },
    async stat(path) {
      const e = files.get(path)
      return e ? statOf(path, e) : null
    },
    async listDir(path) {
      const prefix = path === '/' ? '/' : `${path}/`
      const out: FileStat[] = []
      for (const [p, e] of files) {
        if (p !== path && p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.push(statOf(p, e))
      }
      return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
    },
    async mkdir(path) {
      ensureDir(path)
    },
    async rename(from, to) {
      record('rename', from, to)
      if (!files.has(from)) throw new Error(`文件不存在:${from}`)
      // 与外壳 FileService.rename 一致:目标已存在时拒绝,不静默覆盖
      if (files.has(to)) throw new Error(`目标已存在:${to}`)
      ensureDir(parentOf(to))
      moveTree(from, to)
    },
    async trash(path) {
      record('trash', path)
      if (!files.has(path)) throw new Error(`文件不存在:${path}`)
      const name = path.slice(path.lastIndexOf('/') + 1)
      let target = `${TRASH}/${name}`
      for (let i = 2; files.has(target); i++) target = `${TRASH}/${name} ${i}`
      ensureDir(TRASH)
      moveTree(path, target)
      // 废纸篓里的文件不算「原位置」,历史版本留在原路径下(PRD 3.14 已删除的文件可找回)
      for (const [p, list] of [...history]) {
        if (p === target || p.startsWith(`${target}/`)) {
          history.delete(p)
          history.set(path + p.slice(target.length), list)
        }
      }
      return target
    },
    async watch() {},
    async search(root, query, options) {
      const hits: SearchHit[] = []
      const flags = options.caseSensitive ? 'gu' : 'giu'
      const source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])` : source, flags)
      const test = (s: string) => {
        re.lastIndex = 0
        return re.test(s)
      }
      let total = 0
      const max = options.maxMatches ?? Infinity
      for (const p of options.paths ?? openableFiles(root)) {
        const e = files.get(p)
        if (!e || e.kind !== 'file') continue
        const nameMatch = test(p.slice(p.lastIndexOf('/') + 1))
        const lines = text(p).split('\n')
        const matches: SearchHit['matches'] = []
        for (let i = 0; i < lines.length && total + matches.length < max; i++) {
          if (test(lines[i])) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) })
        }
        total += matches.length
        if (matches.length || nameMatch) hits.push({ path: p, nameMatch, matches })
        if (hits.length >= options.limit || total >= max) break
      }
      return hits
    },
    async listMarkdown(root) {
      return openableFiles(root)
    },
    async firstHeadings(paths) {
      return paths.map((p) => {
        const e = files.get(p)
        return e?.kind === 'file' && isOpenable(p) ? firstHeadingOf(text(p)) : null
      })
    },
    setWindowState(state) {
      record('setWindowState', state)
      document.title = `${state.edited ? '● ' : ''}${state.title}`
    },
    async openDialog(options) {
      record('openDialog', options)
      return host.dialogQueue.shift() ?? null
    },
    async saveDialog(options) {
      record('saveDialog', options)
      return `${options.directory ?? '/Users/test'}/${options.defaultName}`
    },
    async confirm(options) {
      record('confirm', options)
      return host.confirmQueue.shift() ?? 0
    },
    async revealInFinder(path) {
      record('revealInFinder', path)
    },
    async openExternal(url) {
      record('openExternal', url)
    },
    async openDocument(path, options) {
      record('openDocument', path, options)
    },
    async focusDocument(path) {
      record('focusDocument', path)
      return host.openElsewhere.has(path)
    },
    async quickLook(path) {
      record('quickLook', path)
    },
    async openWith(path) {
      record('openWith', path)
    },
    async openWithDefaultApp(path) {
      record('openWithDefaultApp', path)
    },
    async copyImageToClipboard(path) {
      record('copyImageToClipboard', path)
    },
    async fetchLinkPreview(url) {
      return { url, title: `预览:${url}`, description: '内存宿主生成的链接预览', image: null, icon: null }
    },
    closeWindow() {
      record('closeWindow')
    },
    async getSettings() {
      return { ...settings }
    },
    async setSettings(patch) {
      Object.assign(settings, patch)
    },
    async historyList(path) {
      return (history.get(path) ?? [])
        .slice()
        .reverse()
        .map((v) => ({ id: v.id, time: v.time, size: v.text.length, source: 'local' as const }))
    },
    async historyRead(path, id) {
      const v = history.get(path)?.find((x) => x.id === id)
      if (!v) throw new Error('找不到这个版本')
      return v.text
    },
    async historySnapshot(path, t) {
      record('historySnapshot', path, t)
      snapshot(path, t, true)
    },
    async historyDeleted() {
      const out: DeletedHistoryFile[] = []
      for (const [p, list] of history) {
        if (files.has(p) || list.length === 0) continue
        out.push({ path: p, time: list[list.length - 1].time, count: list.length })
      }
      return out.sort((a, b) => b.time - a.time)
    },
    async draftSave(id, t) {
      record('draftSave', id)
      drafts.set(id, t)
      saveDrafts()
    },
    async draftRemove(id) {
      record('draftRemove', id)
      drafts.delete(id)
      saveDrafts()
    },
    async draftPending() {
      const d = host.pendingDraft
      host.pendingDraft = null
      return d
    },
    async exportDocument(options) {
      record('exportDocument', options.format, options.target, options.options ?? {})
      put(options.target, options.format === 'html' || options.format === 'html-plain' ? options.html : `导出的 ${options.format}`)
    },
    async print() {
      record('print', document.documentElement.dataset.theme, document.documentElement.classList.contains('tz-dark'))
    },
    async uploadImages(options, paths) {
      record('uploadImages', options, paths)
      return paths.map((p) => `https://img.example.com${p.startsWith('/') ? p : `/${p}`}`)
    },
    async downloadFile(url, target) {
      record('downloadFile', url, target)
      put(target, `下载自 ${url}`)
    },
    async importDocument(path) {
      record('importDocument', path)
      const target = `${path.replace(/\.[^./]+$/, '')}.md`
      put(target, `# 导入自 ${path.slice(path.lastIndexOf('/') + 1)}\n`)
      return target
    },
    async runCommand(command, cwd) {
      record('runCommand', command, cwd)
      return { status: 0, output: '' }
    },
    async clearRecentDocuments() {
      record('clearRecentDocuments')
    },
    async setSpellingLanguage(language) {
      record('setSpellingLanguage', language)
    },
    async setMenuKeys(overrides) {
      record('setMenuKeys', overrides)
    },
    async setExportItems(items) {
      record('setExportItems', items)
    },
    async runNativeCommand(id) {
      record('runNativeCommand', id)
    },
    syncCall: (method, params) => fakeSync(method, params ?? {}) as Promise<never>,
    aiCall: (method, params) => fakeAi.call(method, params ?? {}) as Promise<never>,
    onAiEvent: (cb) => fakeAi.subscribe(cb),
    async clipboardWrite(data) {
      record('clipboardWrite', data)
      host.clipboard = { text: data.text, html: data.html ?? null, rtf: Boolean(data.rtf) }
    },
    async clipboardText() {
      return host.clipboard.text
    },
    async copyRegionAsImage(rect) {
      record('copyRegionAsImage', rect)
    },
    async nativePaste() {
      record('nativePaste')
    },
    async checkEmbed(url) {
      record('checkEmbed', url)
      return 'ok' as const
    },
    async download(url, to) {
      record('download', url, to)
      if (files.has(to)) throw new Error(`目标位置已有同名文件:${to}`)
      put(to, new TextEncoder().encode(`下载自 ${url}`))
    },
    async openInPreview(path) {
      record('openInPreview', path)
    },
    on(event, handler) {
      let set = listeners.get(event)
      if (!set) listeners.set(event, (set = new Set()))
      set.add(handler as Listener)
      return () => set.delete(handler as Listener)
    },
  }
  return host
}
