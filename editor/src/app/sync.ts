// 云同步界面:偏好设置里的「云同步」页、状态栏同步指示、冲突提示、历史面板里的云端版本。
// 同步本身在辅助进程里(helper/internal/syncsvc),这里只经 host.syncCall 调用并展示状态。
import { diffRows } from '../core/linediff'
import { basename } from '../core/paths'
import type { CloudTrashItem, CloudVersion, RemoteVault, SyncAccount, SyncDevice, SyncEvent, SyncStatus, VaultStatus } from '../host/sync-types'
import { type Host, SyncError } from '../host/types'
import { h } from '../ui/dom'
import { modal } from './panels'

export interface SyncUi {
  toast(message: string, error?: boolean, action?: { label: string; run: () => void }): void
  /** 同步状态变了,重画状态栏 */
  renderStatus(): void
  /** 打开偏好设置并切到云同步页 */
  openSyncPreferences(): void
  /** 文件同步状态变了,更新文件树上的同步标记 */
  filesChanged(): void
}

/** 主密码最短长度(PRD 3.15),与辅助进程一致 */
const MIN_PASSWORD = 10
/** 窗口回到前台时拉取更新的最小间隔 */
const FOCUS_SYNC_INTERVAL = 30_000

export type FileSyncState = 'synced' | 'pending' | 'syncing' | 'error'
const FILE_STATE_LABEL: Record<FileSyncState, string> = { synced: '已同步', pending: '待上传', syncing: '同步中', error: '同步失败' }

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function formatTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '从未'
  const t = Date.parse(iso)
  const diff = Math.max(0, now - t)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (new Date(t).toDateString() === new Date(now).toDateString()) return `今天 ${new Date(t).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

/** 一个库的状态文字。 */
export function vaultStateText(v: VaultStatus): string {
  if (!v.active) return v.lastError ? `未在同步:${v.lastError}` : '未在同步'
  if (v.syncing) return '正在同步…'
  if (v.lastError) return `同步出错:${v.lastError}`
  return `已同步 · ${formatTime(v.lastSuccessAt)}`
}

/** 状态栏上的同步摘要;没有用云同步时返回 null(不显示)。 */
export function summarize(status: SyncStatus | null): { text: string; level: 'ok' | 'busy' | 'error' } | null {
  if (!status) return null
  if (status.authError) return { text: '需要重新登录', level: 'error' }
  if (!status.signedIn || status.vaults.length === 0) return null
  if (status.vaults.some((v) => v.syncing)) return { text: '同步中…', level: 'busy' }
  const failed = status.vaults.find((v) => v.lastError || !v.active)
  if (failed) return { text: `同步失败:${failed.lastError || '未在同步'}`, level: 'error' }
  return { text: '已同步', level: 'ok' }
}

export class SyncController {
  status: SyncStatus | null = null
  private section: HTMLElement | null = null
  private vaultList: HTMLElement | null = null
  /** 正在传输的文件(本机绝对路径) */
  private readonly transferring = new Set<string>()
  /** 同步失败的文件 → 原因 */
  private readonly failed = new Map<string, string>()
  private lastFocusSync = 0

  constructor(
    private readonly host: Host,
    private readonly ui: SyncUi,
  ) {}

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.host.syncCall<T>(method, params)
  }

  /** 接收辅助进程的通知。启动时不主动调用同步组件:没用过云同步的人不启动辅助进程。 */
  bind(): void {
    this.host.on('sync.event', ({ method, params }) => {
      if (method === 'sync.status') this.setStatus(params as SyncStatus)
      else if (method === 'sync.event') this.onEvent(params as SyncEvent)
    })
    // PRD 3.16:窗口回到前台时拉取更新(引擎平时靠实时通知与 5 分钟轮询)
    window.addEventListener('focus', () => {
      if (!this.status?.signedIn || this.status.vaults.length === 0 || Date.now() - this.lastFocusSync < FOCUS_SYNC_INTERVAL) return
      this.lastFocusSync = Date.now()
      this.call('sync.now').catch((err) => console.warn('回到前台时同步失败(状态栏会显示原因):', err))
    })
  }

  private setStatus(next: SyncStatus): void {
    const flipped = this.status?.signedIn !== next.signedIn
    this.status = next
    this.ui.renderStatus()
    this.ui.filesChanged()
    if (!this.section?.isConnected) return
    if (flipped) this.renderSection(this.section)
    else if (this.vaultList?.isConnected) this.fillVaults(this.vaultList)
  }

  private onEvent(ev: SyncEvent): void {
    const path = ev.absPath
    switch (ev.kind) {
      case 'progress':
        if (path) {
          if ((ev.bytes ?? 0) < (ev.total ?? 0)) this.transferring.add(path)
          else this.transferring.delete(path)
        }
        break
      case 'synced':
        if (path) {
          this.transferring.delete(path)
          this.failed.delete(path)
        }
        break
      case 'error':
        if (path) this.failed.set(path, ev.error ?? '未知原因')
        break
      case 'sync_finished': {
        this.transferring.clear()
        const root = this.status?.vaults.find((v) => v.id === ev.vaultId)?.root
        if (!ev.error && root) for (const p of [...this.failed.keys()]) if (p.startsWith(`${root}/`)) this.failed.delete(p)
        break
      }
      case 'conflict':
        // PRD 3.16:本机版本另存为冲突副本,提示并可并排对比;从不静默覆盖
        if (ev.conflictAbsPath && path) {
          const copy = ev.conflictAbsPath
          this.ui.toast(`「${basename(path)}」发现修改冲突,你的版本已另存为冲突副本`, true, { label: '并排对比', run: () => void this.compare(path, copy) })
        }
        break
    }
    this.ui.filesChanged()
  }

  /** 文件树同步标记:不在已登录的同步文件夹里返回 null(仅本地)。 */
  fileState(path: string, mtime: number, isDir: boolean): { state: FileSyncState; label: string } | null {
    const st = this.status
    if (!st?.signedIn) return null
    const vault = st.vaults.find((v) => path === v.root || path.startsWith(`${v.root}/`))
    if (!vault) return null
    const make = (state: FileSyncState, detail?: string) => ({ state, label: detail ? `${FILE_STATE_LABEL[state]}:${detail}` : FILE_STATE_LABEL[state] })
    if (isDir) {
      if (path !== vault.root) return null
      if (vault.syncing) return make('syncing')
      if (vault.lastError || !vault.active) return make('error', vault.lastError || '未在同步')
      return make('synced', `上次同步 ${formatTime(vault.lastSuccessAt)}`)
    }
    const reason = this.failed.get(path)
    if (reason) return make('error', reason)
    if (this.transferring.has(path)) return make('syncing')
    // 上次成功同步之后又改过的文件:待上传(引擎监听到修改后约 1 秒内开始上传)
    if (!vault.lastSuccessAt || mtime > Date.parse(vault.lastSuccessAt)) return make('pending')
    return make('synced')
  }

  /** 冲突副本并排对比:左边是云端版本(原文件),右边是你的版本(冲突副本)。 */
  private compare(original: string, copy: string): Promise<void> {
    return this.guard(async () => {
      const [left, right] = await Promise.all([this.host.readText(original), this.host.readText(copy)])
      const grid = h('div', { class: 'tz-compare-grid' }, h('div', { class: 'tz-compare-head' }, `云端版本 · ${basename(original)}`), h('div', { class: 'tz-compare-head' }, `你的版本 · ${basename(copy)}`))
      const rows = diffRows(left.text, right.text)
      if (rows) {
        for (const r of rows) {
          const cell = (text: string | null, side: 'left' | 'right') =>
            h('div', { class: `tz-compare-line${text === null ? ' is-empty' : r.kind === 'changed' ? ` is-${side}` : ''}` }, text ?? '')
          grid.append(cell(r.left, 'left'), cell(r.right, 'right'))
        }
      } else {
        grid.append(h('pre', { class: 'tz-compare-line' }, left.text), h('pre', { class: 'tz-compare-line' }, right.text))
      }
      const keepCloud = h('button', { type: 'button', class: 'tz-sync-btn', name: 'keepCloud' }, '保留云端版本')
      const keepMine = h('button', { type: 'button', class: 'tz-sync-btn', name: 'keepMine' }, '保留我的版本')
      const keepBoth = h('button', { type: 'button', class: 'tz-btn-primary', name: 'keepBoth' }, '两份都保留')
      const dlg = modal('并排对比', h('div', { class: 'tz-compare' }, rows ? null : h('p', { class: 'tz-sync-muted' }, '文件太大,不标注差异'), grid, h('div', { class: 'tz-sync-actions' }, keepCloud, keepMine, keepBoth)))
      keepBoth.addEventListener('click', dlg.close)
      // 两种「保留一份」都把冲突副本移进废纸篓(可找回),不直接删除
      keepCloud.addEventListener('click', () =>
        void this.guard(async () => {
          await this.host.trash(copy)
          dlg.close()
          this.ui.toast('已保留云端版本,冲突副本已移到废纸篓')
        }),
      )
      keepMine.addEventListener('click', () =>
        void this.guard(async () => {
          await this.host.writeText(original, right.text, right.encoding)
          await this.host.trash(copy)
          dlg.close()
          this.ui.toast('已保留你的版本,冲突副本已移到废纸篓')
        }),
      )
    })
  }

  // ---------- 状态栏 ----------

  statusButton(): HTMLElement | null {
    const s = summarize(this.status)
    if (!s) return null
    const last = this.status?.vaults.map((v) => v.lastSuccessAt).filter(Boolean).sort().pop()
    const btn = h('button', { type: 'button', class: `tz-status-btn tz-sync-indicator is-${s.level}`, title: `${s.text} · 上次成功 ${formatTime(last)}` }, `☁ ${s.text}`)
    btn.addEventListener('click', () => this.ui.openSyncPreferences())
    const box = h('span', { class: 'tz-sync-status' }, btn)
    // PRD 3.16:同步失败时状态栏给【重试】
    if (s.level === 'error' && this.status?.signedIn) {
      const retry = h('button', { type: 'button', class: 'tz-status-btn tz-sync-retry' }, '重试')
      retry.addEventListener('click', () => void this.syncNow(''))
      box.append(retry)
    }
    return box
  }

  // ---------- 历史面板 ----------

  /** 当前文件在云端的历史版本(不含删除记录);没登录或不在同步文件夹里时返回空。 */
  async cloudVersions(path: string): Promise<CloudVersion[]> {
    if (!this.status?.signedIn) return []
    try {
      const r = await this.call<{ tracked: boolean; versions: CloudVersion[] }>('sync.versions', { path })
      return r.versions.filter((v) => !v.deleted)
    } catch (err) {
      this.ui.toast(`读取云端版本失败:${errorText(err)}`, true)
      return []
    }
  }

  async readVersion(path: string, version: number): Promise<string> {
    const r = await this.call<{ text: string }>('sync.readVersion', { path, version })
    return r.text
  }

  // ---------- 偏好设置页 ----------

  settingsSection(): { title: string; render: () => HTMLElement } {
    return {
      title: '云同步',
      render: () => {
        const root = h('div', { class: 'tz-sync' })
        this.section = root
        void this.load(root)
        return root
      },
    }
  }

  private async load(root: HTMLElement): Promise<void> {
    root.replaceChildren(h('div', { class: 'tz-sync-muted' }, '正在连接同步组件…'))
    try {
      this.status = await this.call<SyncStatus>('sync.status')
    } catch (err) {
      root.replaceChildren(h('div', { class: 'tz-sync-error' }, `同步组件不可用:${errorText(err)}`))
      return
    }
    this.ui.renderStatus()
    this.renderSection(root)
  }

  private renderSection(root: HTMLElement): void {
    root.replaceChildren(this.status?.signedIn ? this.signedInView() : this.signedOutView())
  }

  private signedOutView(): HTMLElement {
    const st = this.status
    type Mode = 'login' | 'register' | 'recover'
    let mode: Mode = st?.email ? 'login' : 'register'
    const field = (label: string, input: HTMLInputElement, hint?: string) => h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, label), input, hint ? h('span', { class: 'tz-field-hint' }, hint) : null)
    const input = (type: string, name: string, placeholder = '', value = '') => {
      const el = h('input', { type, name, placeholder, spellcheck: 'false', autocomplete: 'off' })
      el.value = value
      return el
    }
    const server = input('text', 'server', 'https://sync.example.com', st?.server ?? '')
    const email = input('text', 'email', 'you@example.com', st?.email ?? '')
    const password = input('password', 'password')
    const confirm = input('password', 'confirm')
    const recovery = input('text', 'recoveryCode', 'XXXX-XXXX-…')
    const totp = input('text', 'totp', '6 位数字')
    totp.inputMode = 'numeric'
    const rows = {
      confirm: field('确认主密码', confirm),
      recovery: field('恢复码', recovery, 'Typoza 无法替你找回主密码,只能用注册时保存的恢复码重设'),
      totp: field('两步验证码', totp, '验证器 App 上当前显示的 6 位数字'),
    }
    const passwordRow = field('主密码', password, `注册时至少 ${MIN_PASSWORD} 位。主密码只在本机解锁密钥,服务器拿不到`)
    const error = h('div', { class: 'tz-sync-error', hidden: true })
    const submit = h('button', { type: 'button', class: 'tz-btn-primary', name: 'submit' }, '登录')
    const tabs = h('div', { class: 'tz-sync-tabs', role: 'tablist' })
    const labels: Record<Mode, string> = { login: '登录', register: '注册', recover: '用恢复码重置主密码' }
    const apply = () => {
      for (const b of Array.from(tabs.children)) b.classList.toggle('is-active', (b as HTMLElement).dataset.mode === mode)
      rows.confirm.hidden = mode === 'login'
      rows.recovery.hidden = mode !== 'recover'
      rows.totp.hidden = true
      ;(passwordRow.firstChild as HTMLElement).textContent = mode === 'recover' ? '新主密码' : '主密码'
      submit.textContent = mode === 'login' ? '登录' : mode === 'register' ? '注册并登录' : '重置并登录'
      error.hidden = true
    }
    for (const m of Object.keys(labels) as Mode[]) {
      const b = h('button', { type: 'button', class: 'tz-sync-tab', 'data-mode': m }, labels[m])
      b.addEventListener('click', () => {
        mode = m
        apply()
      })
      tabs.append(b)
    }
    const showError = (msg: string) => {
      error.textContent = msg
      error.hidden = false
    }
    const run = async () => {
      if (mode !== 'login' && [...password.value].length < MIN_PASSWORD) return showError(`主密码至少 ${MIN_PASSWORD} 位`)
      if (mode !== 'login' && password.value !== confirm.value) return showError('两次输入的主密码不一致')
      submit.disabled = true
      error.hidden = true
      try {
        if (mode === 'login') {
          this.status = await this.call<SyncStatus>('sync.login', { server: server.value, email: email.value, password: password.value, totp: totp.value.trim() })
        } else if (mode === 'register') {
          const r = await this.call<{ recoveryCode: string; status: SyncStatus }>('sync.register', { server: server.value, email: email.value, password: password.value })
          this.status = r.status
          showRecoveryCode(this.host, r.recoveryCode)
        } else {
          this.status = await this.call<SyncStatus>('sync.recover', { server: server.value, email: email.value, recoveryCode: recovery.value, newPassword: password.value })
        }
        this.ui.renderStatus()
        if (this.section) this.renderSection(this.section)
      } catch (err) {
        const code = err instanceof SyncError ? err.code : ''
        if (code === 'totp_required' || code === 'totp_invalid') {
          rows.totp.hidden = false
          totp.focus()
        }
        showError(errorText(err))
      } finally {
        submit.disabled = false
      }
    }
    submit.addEventListener('click', () => void run())
    const form = h(
      'div',
      { class: 'tz-settings-fields' },
      st?.authError ? h('div', { class: 'tz-sync-error' }, st.authError) : null,
      h('p', { class: 'tz-sync-intro' }, '端到端加密:文件在本机加密后才上传,服务器只保存密文。主密码与恢复码只有你知道,两者都丢失时云端数据无法解开。'),
      tabs,
      field('服务器地址', server, '自建的 Typoza 同步服务地址'),
      field('邮箱', email),
      passwordRow,
      rows.confirm,
      rows.recovery,
      rows.totp,
      error,
      h('div', { class: 'tz-sync-actions' }, submit),
    )
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
        e.preventDefault()
        void run()
      }
    })
    apply()
    return form
  }

  private signedInView(): HTMLElement {
    const st = this.status!
    const logout = h('button', { type: 'button', class: 'tz-sync-btn', name: 'logout' }, '退出登录')
    logout.addEventListener('click', () => void this.logout())
    const usage = h('div', { class: 'tz-sync-muted', 'data-role': 'usage' }, '正在读取用量…')
    void this.call<SyncAccount>('sync.account')
      .then((a) => {
        usage.textContent = `已用 ${formatBytes(a.usage.usedBytes)} / ${formatBytes(a.usage.quotaBytes)} · 两步验证${a.totpEnabled ? '已开启' : '未开启'}`
        usage.dataset.totp = String(a.totpEnabled)
      })
      .catch((err) => (usage.textContent = `读取用量失败:${errorText(err)}`))
    this.vaultList = h('div', { class: 'tz-sync-vaults' })
    this.fillVaults(this.vaultList)
    const add = h('button', { type: 'button', class: 'tz-btn-primary', name: 'addVault' }, '添加同步文件夹…')
    add.addEventListener('click', () => void this.addVault())
    const syncAll = h('button', { type: 'button', class: 'tz-sync-btn', name: 'syncAll' }, '全部立即同步')
    syncAll.addEventListener('click', () => void this.syncNow(''))
    const security = (label: string, name: string, fn: () => void) => {
      const b = h('button', { type: 'button', class: 'tz-sync-btn', name }, label)
      b.addEventListener('click', fn)
      return b
    }
    return h(
      'div',
      { class: 'tz-settings-fields' },
      h('div', { class: 'tz-sync-account' }, h('div', null, h('strong', null, st.email), h('div', { class: 'tz-sync-muted' }, `${st.server} · 本机名称「${st.deviceName}」`), usage), logout),
      h('h3', { class: 'tz-sync-h' }, '同步文件夹'),
      this.vaultList,
      h('div', { class: 'tz-sync-actions' }, syncAll, add),
      h('h3', { class: 'tz-sync-h' }, '账号安全'),
      h(
        'div',
        { class: 'tz-sync-actions is-start' },
        security('修改主密码…', 'changePassword', () => this.changePassword()),
        security('两步验证…', 'totp', () => void this.totp(usage.dataset.totp === 'true')),
        security('登录设备…', 'devices', () => void this.devices()),
      ),
    )
  }

  private fillVaults(list: HTMLElement): void {
    const vaults = this.status?.vaults ?? []
    if (vaults.length === 0) {
      list.replaceChildren(h('div', { class: 'tz-side-empty' }, '还没有同步文件夹。添加一个笔记文件夹,里面的文件会加密后同步到云端。'))
      return
    }
    list.replaceChildren(
      ...vaults.map((v) => {
        const state = vaultStateText(v)
        const row = h(
          'div',
          { class: `tz-sync-vault${v.lastError || !v.active ? ' has-error' : ''}`, 'data-vault': v.id },
          h('div', { class: 'tz-sync-vault-main' }, h('strong', null, v.name), h('div', { class: 'tz-sync-muted tz-sync-path', title: v.root }, v.root), h('div', { class: 'tz-sync-vault-state' }, state)),
        )
        const btn = (label: string, name: string, fn: () => void) => {
          const b = h('button', { type: 'button', class: 'tz-sync-btn', name }, label)
          b.addEventListener('click', fn)
          return b
        }
        row.append(
          h(
            'div',
            { class: 'tz-sync-vault-actions' },
            btn('立即同步', 'syncNow', () => void this.syncNow(v.id)),
            btn('在 Finder 中显示', 'reveal', () => void this.host.revealInFinder(v.root)),
            btn('云端回收站…', 'trash', () => void this.trash(v)),
            btn('停止同步', 'unlink', () => void this.unlink(v)),
          ),
        )
        return row
      }),
    )
  }

  // ---------- 操作 ----------

  private async guard(work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (err) {
      this.ui.toast(errorText(err), true)
    }
  }

  /** PRD 3.15:退出时可选保留本机文件(默认)或同时删除本机副本(移到废纸篓,云端数据不受影响)。 */
  private logout(): Promise<void> {
    return this.guard(async () => {
      const vaults = this.status?.vaults ?? []
      const choice = await this.host.confirm({
        title: '退出云同步登录?',
        message: '云端数据都会保留。选「保留本机文件」,重新登录同一账号后接着同步;选「同时删除本机副本」,同步文件夹会移到废纸篓并解除关联。',
        buttons: ['保留本机文件', '同时删除本机副本', '取消'],
      })
      if (choice === 2) return
      if (choice === 1) {
        for (const v of vaults) {
          await this.call('sync.unlinkVault', { vaultId: v.id })
          await this.host.trash(v.root)
        }
      }
      this.setStatus(await this.call<SyncStatus>('sync.logout'))
    })
  }

  private syncNow(vaultId: string): Promise<void> {
    return this.guard(async () => {
      await this.call('sync.now', { vaultId })
      this.ui.toast('同步完成')
    })
  }

  private unlink(v: VaultStatus): Promise<void> {
    return this.guard(async () => {
      const choice = await this.host.confirm({
        title: `停止同步「${v.name}」?`,
        message: `本机文件夹 ${v.root} 与云端数据都会保留;以后可以再把这个云端库关联回来。`,
        buttons: ['停止同步', '取消'],
      })
      if (choice !== 0) return
      this.setStatus(await this.call<SyncStatus>('sync.unlinkVault', { vaultId: v.id }))
    })
  }

  private addVault(): Promise<void> {
    return this.guard(async () => {
      const picked = await this.host.openDialog({ directory: true })
      const root = picked?.[0]
      if (!root) return
      const remote = (await this.call<RemoteVault[]>('sync.remoteVaults')).filter((r) => !r.root)
      const select = h('select', { name: 'target' }, h('option', { value: '' }, '新建云端库'), ...remote.map((r) => h('option', { value: r.id }, `已有的云端库:${r.name}`)))
      const name = h('input', { type: 'text', name: 'name', spellcheck: 'false' })
      name.value = basename(root)
      const nameRow = h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, '云端库名称'), name, h('span', { class: 'tz-field-hint' }, '库名同样加密后保存'))
      select.addEventListener('change', () => (nameRow.hidden = select.value !== ''))
      const error = h('div', { class: 'tz-sync-error', hidden: true })
      const ok = h('button', { type: 'button', class: 'tz-btn-primary', name: 'confirm' }, '开始同步')
      const body = h(
        'div',
        { class: 'tz-sync-dialog tz-settings-fields' },
        h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, '本机文件夹'), h('span', { class: 'tz-sync-path' }, root)),
        h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, '同步到'), select, h('span', { class: 'tz-field-hint' }, '选已有的云端库时,两边的文件会合并;同名文件内容不同会保留两份')),
        nameRow,
        error,
        h('div', { class: 'tz-sync-actions' }, ok),
      )
      const dlg = modal('同步这个文件夹', body)
      ok.addEventListener('click', async () => {
        ok.disabled = true
        try {
          this.setStatus(await this.call<SyncStatus>('sync.linkVault', { root, vaultId: select.value, name: name.value.trim() }))
          dlg.close()
        } catch (err) {
          error.textContent = errorText(err)
          error.hidden = false
          ok.disabled = false
        }
      })
    })
  }

  private trash(v: VaultStatus): Promise<void> {
    return this.guard(async () => {
      const list = h('div', { class: 'tz-sync-list' })
      const render = async () => {
        const items = await this.call<CloudTrashItem[]>('sync.trash', { vaultId: v.id })
        if (items.length === 0) {
          list.replaceChildren(h('div', { class: 'tz-side-empty' }, '回收站是空的'))
          return
        }
        list.replaceChildren(
          ...items.map((t) => {
            const restore = h('button', { type: 'button', class: 'tz-sync-btn', name: 'restore' }, '恢复')
            const purge = h('button', { type: 'button', class: 'tz-sync-btn is-danger', name: 'purge' }, '永久删除')
            restore.addEventListener('click', () =>
              void this.guard(async () => {
                await this.call('sync.restoreTrash', { vaultId: v.id, fileId: t.fileId })
                this.ui.toast(`已恢复「${basename(t.path)}」`)
                await render()
              }),
            )
            purge.addEventListener('click', () =>
              void this.guard(async () => {
                const c = await this.host.confirm({ title: `永久删除「${basename(t.path)}」?`, message: '永久删除后无法恢复,确定删除?', buttons: ['永久删除', '取消'], style: 'warning' })
                if (c !== 0) return
                await this.call('sync.purge', { vaultId: v.id, fileId: t.fileId })
                await render()
              }),
            )
            return h('div', { class: 'tz-sync-row' }, h('div', null, h('div', null, t.path), h('div', { class: 'tz-sync-muted' }, `删除于 ${formatTime(t.deletedAt)}`)), h('div', { class: 'tz-sync-vault-actions' }, restore, purge))
          }),
        )
      }
      await render()
      modal(`云端回收站 · ${v.name}`, h('div', { class: 'tz-sync-dialog' }, h('p', { class: 'tz-sync-muted' }, '其他设备上删除的文件会先移进这里,保留期内可以恢复。'), list))
    })
  }

  private changePassword(): void {
    const input = (name: string) => h('input', { type: 'password', name })
    const oldPw = input('oldPassword')
    const newPw = input('newPassword')
    const confirmPw = input('confirm')
    const error = h('div', { class: 'tz-sync-error', hidden: true })
    const ok = h('button', { type: 'button', class: 'tz-btn-primary', name: 'confirm' }, '修改')
    const row = (label: string, el: HTMLElement) => h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, label), el)
    const dlg = modal(
      '修改主密码',
      h(
        'div',
        { class: 'tz-sync-dialog tz-settings-fields' },
        h('p', { class: 'tz-sync-muted' }, '修改后,其他设备需要用新主密码重新登录;恢复码不变。'),
        row('当前主密码', oldPw),
        row('新主密码', newPw),
        row('确认新主密码', confirmPw),
        error,
        h('div', { class: 'tz-sync-actions' }, ok),
      ),
    )
    ok.addEventListener('click', async () => {
      const fail = (msg: string) => {
        error.textContent = msg
        error.hidden = false
      }
      if ([...newPw.value].length < MIN_PASSWORD) return fail(`主密码至少 ${MIN_PASSWORD} 位`)
      if (newPw.value !== confirmPw.value) return fail('两次输入的新主密码不一致')
      ok.disabled = true
      try {
        await this.call('sync.changePassword', { oldPassword: oldPw.value, newPassword: newPw.value })
        dlg.close()
        this.ui.toast('主密码已修改,其他设备需要重新登录')
      } catch (err) {
        fail(errorText(err))
        ok.disabled = false
      }
    })
  }

  private async totp(enabled: boolean): Promise<void> {
    const code = h('input', { type: 'text', name: 'code', placeholder: '6 位数字', spellcheck: 'false' })
    code.inputMode = 'numeric'
    const error = h('div', { class: 'tz-sync-error', hidden: true })
    const ok = h('button', { type: 'button', class: 'tz-btn-primary', name: 'confirm' }, enabled ? '关闭两步验证' : '开启')
    const body = h('div', { class: 'tz-sync-dialog tz-settings-fields' })
    if (enabled) {
      body.append(h('p', null, '两步验证已开启。输入验证器上的当前验证码即可关闭。'))
    } else {
      let setup: { secret: string; otpauthUrl: string }
      try {
        setup = await this.call('sync.totpSetup')
      } catch (err) {
        this.ui.toast(errorText(err), true)
        return
      }
      const qr = h('div', { class: 'tz-sync-qr', 'data-role': 'qr' })
      void import('qrcode-generator').then(({ default: qrcode }) => {
        const q = qrcode(0, 'M')
        q.addData(setup.otpauthUrl)
        q.make()
        qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
      })
      body.append(
        h('p', null, '用验证器 App(如 1Password、Google Authenticator)扫描二维码,或手动输入密钥,然后填入显示的 6 位验证码。'),
        qr,
        h('div', { class: 'tz-sync-secret', 'data-role': 'secret' }, setup.secret.replace(/(.{4})/g, '$1 ').trim()),
      )
    }
    body.append(h('label', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, '验证码'), code), error, h('div', { class: 'tz-sync-actions' }, ok))
    const dlg = modal('两步验证', body)
    ok.addEventListener('click', async () => {
      ok.disabled = true
      try {
        await this.call(enabled ? 'sync.totpDisable' : 'sync.totpEnable', { code: code.value.trim() })
        dlg.close()
        this.ui.toast(enabled ? '两步验证已关闭' : '两步验证已开启,下次登录需要验证码')
        if (this.section) this.renderSection(this.section)
      } catch (err) {
        error.textContent = errorText(err)
        error.hidden = false
        ok.disabled = false
      }
    })
    code.focus()
  }

  private devices(): Promise<void> {
    return this.guard(async () => {
      const list = h('div', { class: 'tz-sync-list' })
      const render = async () => {
        const devices = await this.call<SyncDevice[]>('sync.devices')
        list.replaceChildren(
          ...devices.map((d) => {
            const row = h(
              'div',
              { class: 'tz-sync-row' },
              h('div', null, h('div', null, d.name, d.current ? h('span', { class: 'tz-sync-badge' }, '本机') : null), h('div', { class: 'tz-sync-muted' }, `最近使用 ${formatTime(d.lastSeenAt)} · 首次登录 ${formatTime(d.createdAt)}`)),
            )
            if (!d.current) {
              const revoke = h('button', { type: 'button', class: 'tz-sync-btn is-danger', name: 'revoke' }, '移除')
              revoke.addEventListener('click', () =>
                void this.guard(async () => {
                  const c = await this.host.confirm({ title: `移除「${d.name}」?`, message: '这台设备会立即退出登录,需要主密码才能重新登录。', buttons: ['移除', '取消'], style: 'warning' })
                  if (c !== 0) return
                  await this.call('sync.revokeDevice', { id: d.id })
                  await render()
                }),
              )
              row.append(revoke)
            }
            return row
          }),
        )
      }
      await render()
      modal('登录设备', h('div', { class: 'tz-sync-dialog' }, list))
    })
  }
}

/** 注册成功后展示恢复码:必须勾选「已保存」才能关闭(Esc、×、点遮罩都不关:恢复码只显示这一次)。 */
function showRecoveryCode(host: Host, code: string): void {
  const done = h('button', { type: 'button', class: 'tz-btn-primary', name: 'done', disabled: true }, '完成')
  const check = h('input', { type: 'checkbox', name: 'saved' })
  check.addEventListener('change', () => (done.disabled = !check.checked))
  const copy = h('button', { type: 'button', class: 'tz-sync-btn', name: 'copy' }, '复制')
  // 走宿主剪贴板:typoza:// 页面里 navigator.clipboard 不一定可用,复制失败要让人知道
  copy.addEventListener('click', () => {
    host.clipboardWrite({ text: code }).then(
      () => (copy.textContent = '已复制'),
      (err: unknown) => (copy.textContent = `复制失败:${err instanceof Error ? err.message : String(err)}`),
    )
  })
  const dlg = modal(
    '请保存恢复码',
    h(
      'div',
      { class: 'tz-sync-dialog tz-settings-fields' },
      h('p', null, '恢复码只显示这一次。忘记主密码且丢失恢复码,你的数据将无法解密。请抄在纸上或存进密码管理器。'),
      h('div', { class: 'tz-sync-secret', 'data-role': 'recovery-code' }, code),
      h('div', { class: 'tz-sync-actions is-start' }, copy),
      h('label', { class: 'tz-sync-check' }, check, '我已妥善保存恢复码'),
      h('div', { class: 'tz-sync-actions' }, done),
    ),
    undefined,
    { closable: false },
  )
  done.addEventListener('click', dlg.close)
}
