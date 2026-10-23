// 弹出面板:字数统计,以及各面板共用的模态框。偏好设置在 preferences.ts,历史版本在 historypanel.ts。
import { h } from '../ui/dom'

/** closable 为 false 时只能由调用方关(没有 ×,Esc 与点遮罩不关):用于必须确认的面板,如恢复码 */
export function modal(title: string, body: HTMLElement, onClose?: () => void, { closable = true } = {}): { root: HTMLElement; close: () => void } {
  const closeBtn = closable ? h('button', { type: 'button', class: 'tz-modal-close', title: '关闭(Esc)' }, '×') : null
  const panel = h('div', { class: 'tz-modal-panel', role: 'dialog', 'aria-label': title }, h('div', { class: 'tz-modal-head' }, h('h2', null, title), closeBtn), body)
  const root = h('div', { class: 'tz-modal' }, panel)
  const close = () => {
    root.remove()
    window.removeEventListener('keydown', onKey, true)
    onClose?.()
  }
  const onKey = (e: KeyboardEvent) => {
    // 叠了几层面板时 Esc 只归最上面一层(各层都在 window 上监听,先注册的先收到)
    if ([...document.querySelectorAll('.tz-modal')].pop() !== root) return
    // 正在录制快捷键的控件要自己收 Esc(取消录制),不关面板
    if (e.key === 'Escape' && !(e.target instanceof Element && e.target.closest('[data-tz-capture-keys]'))) {
      e.preventDefault()
      e.stopPropagation()
      if (closable) close()
    }
  }
  closeBtn?.addEventListener('click', close)
  root.addEventListener('mousedown', (e) => {
    if (e.target === root && closable) close()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(root)
  return { root, close }
}

// ---------- 字数统计 ----------

export interface WordStats {
  characters: number
  charactersNoSpace: number
  words: number
  cjk: number
  lines: number
  paragraphs: number
  readingMinutes: number
}

const CJK = /[\u{3400}-\u{9FFF}\u{F900}-\u{FAFF}\u{3040}-\u{30FF}\u{AC00}-\u{D7AF}]/gu

/**
 * 字数:中日韩字符每字算一个词,其它按空白分词(与 Typora 的口径一致)。
 * 阅读时间 = 字数 ÷ 阅读速度(偏好「外观」PA-05,中日韩按字、西文按词,默认 382 字每分钟),不足 1 分钟按 1 分钟。
 */
export function countWords(text: string, readingSpeed = 382): WordStats {
  const cjk = (text.match(CJK) ?? []).length
  const latin = text.replace(CJK, ' ')
  const latinWords = (latin.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length
  const words = cjk + latinWords
  return {
    characters: text.length,
    charactersNoSpace: text.replace(/\s/g, '').length,
    words,
    cjk,
    lines: text ? text.split('\n').length : 0,
    paragraphs: text.split(/\n{2,}/).filter((p) => p.trim()).length,
    readingMinutes: Math.max(1, Math.round(words / Math.max(1, readingSpeed))),
  }
}

export function showWordCount(stats: WordStats, selection: WordStats | null): void {
  const row = (label: string, v: number, s?: number) => h('tr', null, h('th', null, label), h('td', null, String(v)), h('td', null, s === undefined ? '' : String(s)))
  const table = h(
    'table',
    { class: 'tz-wordcount' },
    h('thead', null, h('tr', null, h('th', null, ''), h('th', null, '全文'), h('th', null, selection ? '选中' : ''))),
    h(
      'tbody',
      null,
      row('字数', stats.words, selection?.words),
      row('字符数', stats.characters, selection?.characters),
      row('字符数(不含空白)', stats.charactersNoSpace, selection?.charactersNoSpace),
      row('中日韩字符', stats.cjk, selection?.cjk),
      row('段落', stats.paragraphs, selection?.paragraphs),
      row('行数', stats.lines, selection?.lines),
      row('阅读时间(分钟)', stats.readingMinutes, selection?.readingMinutes),
    ),
  )
  modal('字数统计', table)
}
