// 浮动菜单:斜杠菜单、块菜单、「转换为」、颜色菜单共用。键盘 ↑↓ 选择、↵ 执行、Esc 关闭,支持中英文关键词过滤。
import { h } from './dom'

export interface MenuItem {
  id: string
  label: string
  /** 右侧提示(快捷键或说明) */
  hint?: string
  /** 左侧图标:字符、emoji 或节点 */
  icon?: string | Node
  /** 过滤用关键词(英文名、拼音缩写……) */
  keywords?: string[]
  group?: string
  active?: boolean
  /** 只在输入了查询词且命中时出现(如「/turnbullet」这类直达条目) */
  searchOnly?: boolean
  /** 子菜单 */
  children?: () => MenuItem[]
  /** 子菜单顶部带搜索框(块菜单「转换为」) */
  searchable?: boolean
  run?: () => void
}

export interface MenuOptions {
  className?: string
  /** 过滤后没有结果时的提示 */
  emptyText?: string
  /** 顶部搜索框的占位文字;不设则没有搜索框(查询词由编辑器里输入的文字提供) */
  search?: string
  onClose?: (reason: 'select' | 'escape' | 'outside' | 'api') => void
}

/** 过滤时忽略大小写与空白:「/标题1」命中「标题 1」,「/blue background」命中别名「blue background」。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '')
}

/** 命中程度:0 名称或别名全等,1 前缀,2 包含;-1 不命中。 */
function matchRank(item: MenuItem, q: string): number {
  const names = [normalize(item.label), ...(item.keywords ?? []).map(normalize)]
  if (names.includes(q)) return 0
  if (names.some((n) => n.startsWith(q))) return 1
  if (names.some((n) => n.includes(q))) return 2
  return -1
}

/**
 * 按查询词过滤:没有查询词时按原顺序列出(搜索专用条目除外);
 * 有查询词时全等优先、前缀其次、包含最后,同档保持原顺序(「/red」先出红色而不是含 red 的 numbered)。
 */
export function filterMenuItems(items: readonly MenuItem[], query: string): MenuItem[] {
  const q = normalize(query)
  if (!q) return items.filter((it) => !it.searchOnly)
  return items
    .map((item, index) => ({ item, index, rank: matchRank(item, q) }))
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.item)
}

export class FloatingMenu {
  readonly el: HTMLDivElement
  private readonly list: HTMLDivElement
  private readonly footer: HTMLDivElement
  private readonly input: HTMLInputElement | null
  private items: MenuItem[] = []
  private visible: MenuItem[] = []
  private index = 0
  private query = ''
  private sub: FloatingMenu | null = null
  private parent: FloatingMenu | null = null
  /** 搜索框拿走焦点之前的焦点元素 */
  private restoreFocus: HTMLElement | null = null
  private readonly onDocDown = (e: MouseEvent) => {
    if (!this.contains(e.target as Node)) this.close('outside')
  }

  constructor(private readonly options: MenuOptions = {}) {
    this.list = h('div', { class: 'tz-menu-list' })
    this.footer = h('div', { class: 'tz-menu-footer', hidden: true })
    this.input = options.search !== undefined ? h('input', { class: 'tz-menu-search', placeholder: options.search, spellcheck: 'false' }) : null
    this.el = h('div', { class: `tz-menu ${options.className ?? ''}`, role: 'menu' }, this.input, this.list, this.footer)
    // 点菜单不抢编辑器焦点;搜索框本身要能获得焦点
    this.el.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) e.preventDefault()
    })
    const input = this.input
    if (input) {
      input.addEventListener('input', () => this.setQuery(input.value))
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        // 搜索框里 ← → 用来移动光标;框为空时才交给菜单(开合子菜单)
        const arrows = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
        if (arrows && input.value !== '') return
        if (this.handleKey(e)) e.preventDefault()
      })
    }
  }

  get isOpen(): boolean {
    return this.el.isConnected
  }

  private contains(node: Node): boolean {
    return this.el.contains(node) || Boolean(this.sub?.contains(node))
  }

  /**
   * footer:菜单底部的说明文字(块菜单的字数)。
   * focusSearch:带搜索框时是否把焦点移进搜索框(鼠标悬停展开的子菜单不抢焦点)。
   */
  open(items: MenuItem[], anchor: { left: number; top: number; bottom: number }, query = '', footer?: string, focusSearch = true): void {
    this.items = items
    this.query = query
    this.index = 0
    if (this.input) this.input.value = query
    this.footer.textContent = footer ?? ''
    this.footer.hidden = !footer
    if (!this.isOpen) {
      document.body.append(this.el)
      document.addEventListener('mousedown', this.onDocDown, true)
    }
    this.render()
    this.place(anchor)
    if (focusSearch) this.focusSearch()
  }

  /** 焦点移进搜索框;记下原来的焦点(通常是编辑器),取消时还回去。 */
  private focusSearch(): void {
    const input = this.input
    if (!input) return
    const active = document.activeElement
    if (active instanceof HTMLElement && !this.el.contains(active)) this.restoreFocus = active
    // 键盘打开时立即接管输入;鼠标打开时按下事件之后焦点可能被抢回,下一帧再确认一次
    input.focus()
    requestAnimationFrame(() => {
      if (this.isOpen && document.activeElement !== input) input.focus()
    })
  }

  setQuery(query: string): number {
    this.query = query
    this.index = 0
    this.render()
    return this.visible.length
  }

  private place(anchor: { left: number; top: number; bottom: number }): void {
    const menu = this.el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = anchor.bottom + 6
    if (top + menu.height > vh - 8 && anchor.top - menu.height - 6 > 8) top = anchor.top - menu.height - 6
    const left = Math.min(Math.max(8, anchor.left), vw - menu.width - 8)
    this.el.style.left = `${left}px`
    this.el.style.top = `${Math.max(8, top)}px`
  }

  private render(): void {
    this.visible = filterMenuItems(this.items, this.query)
    this.list.replaceChildren()
    if (this.visible.length === 0) {
      this.list.append(h('div', { class: 'tz-menu-empty' }, this.options.emptyText ?? '没有匹配的项'))
      return
    }
    // 过滤后按命中程度排序,分组标题不再成立,只在未过滤时显示
    const grouped = normalize(this.query) === ''
    let group: string | undefined
    this.visible.forEach((item, i) => {
      if (grouped && item.group && item.group !== group) {
        group = item.group
        this.list.append(h('div', { class: 'tz-menu-group' }, item.group))
      }
      const icon = typeof item.icon === 'string' ? h('span', { class: 'tz-menu-icon' }, item.icon) : item.icon ? h('span', { class: 'tz-menu-icon' }, item.icon) : null
      const row = h(
        'div',
        {
          class: `tz-menu-item${i === this.index ? ' is-selected' : ''}${item.active ? ' is-active' : ''}`,
          role: 'menuitem',
          'data-id': item.id,
        },
        icon,
        h('span', { class: 'tz-menu-label' }, item.label),
        item.hint ? h('span', { class: 'tz-menu-hint' }, item.hint) : null,
        item.children ? h('span', { class: 'tz-menu-arrow' }, '›') : null,
      )
      row.addEventListener('mouseenter', () => {
        this.index = i
        this.highlight()
        if (item.children) this.openSub(row, item, false)
        else this.closeSub()
      })
      row.addEventListener('click', () => this.choose(i))
      this.list.append(row)
    })
  }

  private highlight(): void {
    const rows = this.list.querySelectorAll('.tz-menu-item')
    rows.forEach((r, i) => r.classList.toggle('is-selected', i === this.index))
    rows[this.index]?.scrollIntoView({ block: 'nearest' })
  }

  /** focusSearch:键盘或点击展开时焦点进子菜单搜索框,鼠标悬停展开时不抢焦点。 */
  private openSub(row: HTMLElement, item: MenuItem, focusSearch: boolean): void {
    if (!item.children) return
    if (this.sub?.isOpen && this.sub.el.dataset.for === item.id) {
      if (focusSearch) this.sub.focusSearch()
      return
    }
    this.closeSub()
    const sub = new FloatingMenu({
      className: this.options.className,
      search: item.searchable ? '搜索类型' : undefined,
      onClose: (reason) => {
        if (reason === 'select') this.close('select')
      },
    })
    sub.parent = this
    sub.el.dataset.for = item.id
    const r = row.getBoundingClientRect()
    sub.open(item.children(), { left: r.right + 4, top: r.top, bottom: r.top }, '', undefined, focusSearch)
    // 右侧放不下时翻到父菜单左边:按视口夹住会盖住父菜单里的项(多级子菜单靠近窗口右缘时)
    const width = sub.el.getBoundingClientRect().width
    if (r.right + 4 + width > window.innerWidth - 8) sub.el.style.left = `${Math.max(8, r.left - 4 - width)}px`
    this.sub = sub
  }

  private closeSub(): void {
    this.sub?.close('api')
    this.sub = null
  }

  private choose(i: number): void {
    const item = this.visible[i]
    if (!item) return
    if (item.children) {
      const row = this.list.querySelectorAll<HTMLElement>('.tz-menu-item')[i]
      if (row) this.openSub(row, item, true)
      return
    }
    this.close('select')
    item.run?.()
  }

  /** 菜单打开时由编辑器转发按键;返回 true 表示已处理。 */
  handleKey(e: KeyboardEvent): boolean {
    if (this.sub?.isOpen) return this.sub.handleKey(e)
    switch (e.key) {
      case 'ArrowDown':
        this.index = (this.index + 1) % Math.max(1, this.visible.length)
        this.highlight()
        return true
      case 'ArrowUp':
        this.index = (this.index - 1 + this.visible.length) % Math.max(1, this.visible.length)
        this.highlight()
        return true
      case 'ArrowRight': {
        const item = this.visible[this.index]
        if (!item?.children) return false
        this.choose(this.index)
        return true
      }
      case 'ArrowLeft':
        if (this.parent) {
          this.close('api')
          return true
        }
        return false
      case 'Enter':
      case 'Tab':
        if (this.visible.length === 0) return false
        this.choose(this.index)
        return true
      case 'Escape':
        this.close('escape')
        return true
      default:
        return false
    }
  }

  close(reason: 'select' | 'escape' | 'outside' | 'api' = 'api'): void {
    if (!this.isOpen) return
    this.closeSub()
    document.removeEventListener('mousedown', this.onDocDown, true)
    const hadFocus = this.input !== null && document.activeElement === this.input
    this.el.remove()
    const restore = this.restoreFocus
    this.restoreFocus = null
    if (this.parent?.input) {
      // 子菜单关掉后,带搜索框的父菜单把焦点要回来,方向键继续可用
      this.parent.sub = null
      this.parent.input.focus()
    } else {
      if (this.parent) this.parent.sub = null
      // 搜索框拿着焦点时关掉(取消、退回上级):焦点还给原处(通常是编辑器);选中条目时由条目自己处理焦点
      if (hadFocus && reason !== 'select' && restore?.isConnected) restore.focus()
    }
    this.options.onClose?.(reason)
  }
}

/** 弹出带搜索框的选择菜单(「移动到…」选文档);选中返回条目 id,关闭返回 null。 */
export function pickMenuItem(items: MenuItem[], anchor: { left: number; top: number; bottom: number }, search: string, emptyText = '无结果'): Promise<string | null> {
  return new Promise((resolve) => {
    // 选中时先关菜单(reason 为 select)再执行条目,所以在条目里 resolve;其它方式关闭视为取消
    const menu = new FloatingMenu({
      className: 'tz-pick-menu',
      search,
      emptyText,
      onClose: (reason) => {
        if (reason !== 'select') resolve(null)
      },
    })
    menu.open(
      items.map((it) => ({ ...it, run: () => resolve(it.id) })),
      anchor,
    )
  })
}
