// 启动:有原生桥接(macOS 外壳)用原生宿主;否则(浏览器开发、E2E)用内存宿主加载示例文件夹。
import './styles/index.css'
import { App } from './app/app'
import type { MemoryHost } from './host/memory'
import { createNativeHost, hasNativeBridge } from './host/native'
import { parseMarkdown } from './core/markdown/parse'
import type { SmokeResult } from './smoke'

declare global {
  interface Window {
    typoza: {
      smoke(): Promise<SmokeResult>
      markdown(): string
      prepareClose(reason?: string): Promise<boolean>
      /** CI 冷启动核对启动选项用:当前文档与侧栏目录 */
      startupState(): { path: string | null; folder: string | null }
    }
    typozaTest?: { host: MemoryHost; app: App; load(markdown: string, path?: string): Promise<void>; markdown(): string; parse: typeof parseMarkdown }
  }
}

let loadSeq = 0
// 启动分段计时(冒烟报告用):模块开始执行时刻、应用初始化完成时刻,均相对页面导航起点
const bootTimings: Record<string, number> = { moduleStartMs: Math.round(performance.now()), timeOriginEpochMs: Math.round(performance.timeOrigin) }

async function boot(): Promise<void> {
  const mount = document.getElementById('app')
  if (!mount) throw new Error('缺少 #app 挂载点')
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  let app: App
  if (hasNativeBridge()) {
    const { host, info } = await createNativeHost()
    bootTimings.hostReadyMs = Math.round(performance.now())
    app = new App({ host, mount, openPath: info.openPath, openIsDir: info.openIsDir, dark: info.dark })
    await app.init()
    bootTimings.appInitMs = Math.round(performance.now())
  } else {
    // 内存宿主、模拟同步与示例文档只在浏览器里用(开发、E2E),按需加载,不进应用启动时的主包
    const [{ createMemoryHost }, { DEMO_DOC, DEMO_ROOT, seedDemo }] = await Promise.all([import('./host/memory'), import('./demo')])
    const host = createMemoryHost()
    seedDemo(host)
    const params = new URLSearchParams(location.search)
    const empty = params.has('empty')
    // E2E 用:以给定偏好启动(只在启动时读一次的选项,如「默认显示大纲视图」)
    const preset = params.get('settings')
    if (preset) Object.assign(host.settings, JSON.parse(preset) as Record<string, unknown>)
    app = new App({ host, mount, openPath: empty ? DEMO_ROOT : DEMO_DOC, openIsDir: empty, dark })
    await app.init()
    window.typozaTest = {
      host,
      app,
      // 每次默认用新路径:同一路径会先自动保存当前文档,把刚预置的内容覆盖掉
      async load(markdown, path = `${DEMO_ROOT}/测试-${++loadSeq}.md`) {
        host.files.set(path, { kind: 'file', data: markdown, mtime: Date.now() })
        await app.openFile(path, { replace: true })
        // 大文档分段载入:等全文载完再交给用例
        while (app.loading) await new Promise((r) => setTimeout(r, 10))
      },
      markdown: () => app.markdown(),
      parse: parseMarkdown,
    }
  }
  // 冒烟自检只在 CI 与本机验证时调用,按需加载
  window.typoza = {
    smoke: async () => (await import('./smoke')).runSmoke(app, bootTimings),
    markdown: () => app.markdown(),
    prepareClose: (reason) => app.confirmLeave(reason === 'quit' ? 'quit' : 'close'),
    startupState: () => ({ path: app.session.path, folder: app.rootFolder }),
  }
  document.documentElement.dataset.ready = 'true'
  void window.webkit?.messageHandlers?.typoza?.postMessage({ method: 'app.ready', params: {} })
}

boot().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  document.body.innerHTML = ''
  const pre = document.createElement('pre')
  pre.className = 'tz-fatal'
  pre.textContent = `Typoza 启动失败:\n${message}`
  document.body.append(pre)
  void window.webkit?.messageHandlers?.typoza?.postMessage({ method: 'app.fatal', params: { message } })
})
