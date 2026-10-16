// AI 模块总控(AI 版):持有 AI 设置缓存与 ai.event 分发,组装侧栏对话、选中文字动作 / 在光标处生成、改文档预览、设置页。
// 应用层(app.ts)只提供文档读写与提示等能力(AiAppDeps),AI 的界面与状态都在这里。
import './ai.css'
import type { EditorView } from 'prosemirror-view'
import type { ParseOptions } from '../core/markdown/parse'
import { registerCommand } from '../core/registry'
import { AiError, type AiDoneStatus, type AiErrorInfo, type AiEvent, type AiSettings } from '../host/ai-types'
import type { Host } from '../host/types'
import { AiAssist } from './assist'
import { ChatStore } from './chat-store'
import { DocEditPreview } from './docedit'
import { hasUsableModel, newId, NOT_CONFIGURED_TEXT } from './models'
import { AiPanel } from './panel'
import { aiHooks } from './plugin'
import { aiSettingsSections } from './settings-page'

export interface AiAppDeps {
  host: Host
  /** 当前编辑器视图(换文档时会换) */
  view(): EditorView
  /** 当前文档的 Markdown 原文(换行统一为 \n、不含 BOM);发给模型的「当前文档」 */
  documentText(): string
  /** 正文位置 → documentText() 里的字符偏移(/ai 标明光标位置) */
  sourceOffset(pos: number): number
  /** 选区的 Markdown 原文 */
  selectionText(): string
  parseOptions(): ParseOptions
  documentTitle(): string
  documentPath(): string | null
  /** 侧栏打开的文件夹(「当前文件夹」连接器、@ 引用文档) */
  rootFolder(): string | null
  /** 文档只读时「插入」类按钮置灰 */
  readOnly(): boolean
  /** 源码模式下先切回所见即所得(AI 的插入、替换、预览都作用在编辑器视图上) */
  ensureRichMode(): void
  /** 当前文件夹里可引用的文档(@ 引用) */
  listDocuments(): Promise<{ path: string; title: string; dir: string }[]>
  toast(message: string, error?: boolean, action?: { label: string; run: () => void }): void
  openPreferences(page?: string): void
}

export interface CompletionHandlers {
  delta(text: string): void
  done(status: AiDoneStatus, error?: AiErrorInfo): void
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function errorInfo(err: unknown): AiErrorInfo {
  return err instanceof AiError ? { code: err.code, message: err.message } : { code: 'internal', message: errorText(err) }
}

/** 出错原因的说明:401 / 403 提示检查密钥(PRD 二「消息状态」出错) */
export function describeError(error: AiErrorInfo): string {
  if (error.code === 'auth') return `${error.message}(请检查服务商密钥)`
  if (error.code === 'rate_limit') return `${error.message}(请求太频繁,请稍后重试)`
  if (error.code === 'not_configured') return NOT_CONFIGURED_TEXT
  return error.message
}

/** 去掉值为 undefined 的键:桥接参数里不带空字段 */
export function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) if (v !== undefined) out[k] = v
  return out
}

export class AiController {
  settings: AiSettings | null = null
  /** 读设置失败的原因(辅助进程起不来等) */
  settingsError: string | null = null
  readonly store = new ChatStore()
  readonly panel: AiPanel
  readonly assist: AiAssist
  readonly edits: DocEditPreview
  private readonly completions = new Map<string, CompletionHandlers>()
  private readonly listeners = new Set<(ev: AiEvent) => void>()

  constructor(readonly deps: AiAppDeps) {
    this.panel = new AiPanel(this)
    this.assist = new AiAssist(this)
    this.edits = new DocEditPreview(this)
  }

  /** 侧栏根元素(应用层放在编辑区右侧) */
  get el(): HTMLElement {
    return this.panel.el
  }

  init(): void {
    registerCommand({ id: 'ai.open', label: '打开 AI 对话', run: () => (this.panel.toggleFromShortcut(), true) })
    registerCommand({ id: 'ai.selection', label: 'AI 动作…', run: (view) => this.assist.openActionMenu(view) })
    registerCommand({ id: 'ai.write', label: 'AI 写作', run: (view) => this.assist.openWriter(view) })
    aiHooks.spaceTrigger = (view) => this.spaceTrigger(view)
    aiHooks.keydown = (_view, event) => this.assist.handleKey(event)
    // 在编辑器的更新过程中被调用:收起卡片、清预览要再发事务,放到本轮更新结束之后
    aiHooks.userEdit = (view) =>
      queueMicrotask(() => {
        if (view.isDestroyed) return
        this.assist.onUserEdit(view)
        this.edits.onUserEdit(view)
      })
    aiHooks.viewDestroyed = (view) => {
      this.assist.onViewDestroyed(view)
      this.edits.onViewDestroyed(view)
    }
    aiHooks.update = (view) => this.panel.onEditorUpdate(view)
    aiHooks.selectionMenu = (view) => this.assist.selectionMenuItems(view)
    this.deps.host.onAiEvent((ev) => this.onEvent(ev))
    // 后台读一次设置:空行按空格是同步判断的,要先知道开关与有没有可用模型
    void this.refreshSettings()
    void this.panel.restoreWidth()
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.deps.host.aiCall<T>(method, clean(params))
  }

  async refreshSettings(): Promise<AiSettings | null> {
    try {
      this.settings = await this.call<AiSettings>('ai.settings.get')
      this.settingsError = null
    } catch (err) {
      this.settingsError = errorText(err)
    }
    this.panel.onSettingsChanged()
    return this.settings
  }

  /** 改 AI 设置(给出的字段整体替换),返回新设置 */
  async updateSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
    this.settings = await this.call<AiSettings>('ai.settings.update', patch as Record<string, unknown>)
    this.panel.onSettingsChanged()
    return this.settings
  }

  get configured(): boolean {
    return hasUsableModel(this.settings)
  }

  /** 未配置模型:提示并给【去设置】(PRD 3.1) */
  notConfigured(): void {
    this.deps.toast(NOT_CONFIGURED_TEXT, true, { label: '去设置', run: () => this.openSettings() })
  }

  openSettings(page = 'AI 服务商'): void {
    this.deps.openPreferences(page)
  }

  /** 进入 AI 入口前确认有可用模型;没有时先刷新一次(可能刚在设置页里加了模型),仍没有就提示去设置 */
  async ensureConfigured(): Promise<boolean> {
    if (!this.configured) await this.refreshSettings()
    if (this.configured) return true
    this.notConfigured()
    return false
  }

  /** ai.complete:先登记回调再发请求(事件可能先于返回到达);请求失败时直接以出错结束,返回 null */
  async startCompletion(params: Record<string, unknown>, handlers: CompletionHandlers): Promise<string | null> {
    const requestId = newId()
    this.completions.set(requestId, handlers)
    try {
      await this.call('ai.complete', { requestId, ...params })
      return requestId
    } catch (err) {
      this.completions.delete(requestId)
      handlers.done('error', errorInfo(err))
      return null
    }
  }

  /** 停止并不再接收这个请求的输出 */
  stopCompletion(requestId: string): void {
    this.completions.delete(requestId)
    this.call('ai.complete.stop', { requestId }).catch((err: unknown) => this.deps.toast(`停止失败:${errorText(err)}`, true))
  }

  /** 工具调用的决定(允许 / 总是允许 / 拒绝);result 只给网页执行的工具(改文档)回报结果 */
  async decideTool(conversationId: string, callId: string, decision: 'allow' | 'always' | 'deny', result?: string): Promise<boolean> {
    try {
      await this.call('ai.tool.decide', { conversationId, callId, decision, result })
      return true
    } catch (err) {
      this.deps.toast(`操作失败:${errorText(err)}`, true)
      return false
    }
  }

  /** 订阅全部 AI 事件(设置页看 MCP 状态);返回取消订阅 */
  subscribe(fn: (ev: AiEvent) => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  settingsSections(): { title: string; render: () => HTMLElement }[] {
    return aiSettingsSections(this)
  }

  /** 空行行首按空格:开关打开、有可用模型、文档可写时弹出 AI 输入框(PRD 3.5) */
  private spaceTrigger(view: EditorView): boolean {
    if (!this.settings?.spaceTriggersAi || !this.configured || this.deps.readOnly()) return false
    return this.assist.openWriter(view)
  }

  private onEvent(ev: AiEvent): void {
    for (const fn of [...this.listeners]) fn(ev)
    switch (ev.type) {
      case 'complete.delta':
        this.completions.get(ev.requestId)?.delta(ev.text)
        return
      case 'complete.done': {
        const handlers = this.completions.get(ev.requestId)
        this.completions.delete(ev.requestId)
        handlers?.done(ev.status, ev.error)
        return
      }
      case 'mcp.status':
        return
      case 'doc.edit':
        this.edits.onEvent(ev)
        break
      default:
        break
    }
    const changed = this.store.apply(ev)
    if (changed !== null) this.panel.onStoreChange(changed)
  }
}
