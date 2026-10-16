// AI 输出写回正文与显示:一段文字插在光标处不拆段、多块按块插入;显示时 HTML 只当文字;⌘J / ⌥⌘J 键位(AI 版)。
import { describe, expect, it } from 'vitest'
import { markdownBlocks, markdownSlice, renderMarkdown } from '../../src/ai/render'
import { appKeyTable, defaultKeyTable, menuKeyOverrides } from '../../src/app/shortcuts'
import { DEFAULT_KEYS } from '../../src/core/keymap'

const options = { inlineMath: true }

describe('AI 输出 → 正文', () => {
  it('只有一段文字:取段内的行内内容(带格式)', () => {
    const slice = markdownSlice('改好的**句子**。', options)
    expect(slice.openStart).toBe(0)
    // 「改好的」「句子」(加粗)「。」三段文字
    expect(slice.content.childCount).toBe(3)
    expect(slice.content.firstChild?.isText).toBe(true)
    expect(slice.content.child(1).marks.map((m) => m.type.name)).toEqual(['strong'])
    expect(slice.content.textBetween(0, slice.content.size)).toBe('改好的句子。')
  })

  it('多块:按块插入;空文本给一个空段落', () => {
    const slice = markdownSlice('# 标题\n\n- 一\n- 二\n', options)
    expect(slice.content.childCount).toBe(2)
    expect(slice.content.firstChild?.type.name).toBe('heading')
    expect(markdownBlocks('第一段\r\n\r\n第二段', options).childCount).toBe(2)
    const empty = markdownBlocks('', options)
    expect(empty.childCount).toBe(1)
    expect(empty.firstChild?.type.name).toBe('paragraph')
  })

  it('显示:Markdown 渲染成只读 DOM,HTML 不执行', () => {
    const el = document.createElement('div')
    renderMarkdown('**粗**与 `代码`\n\n<script>alert(1)</script>\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', el, options, false)
    expect(el.querySelector('strong')?.textContent).toBe('粗')
    expect(el.querySelector('code')?.textContent).toBe('代码')
    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('<script>alert(1)</script>')
    expect(el.querySelectorAll('td')).toHaveLength(2)
  })
})

describe('AI 版键位', () => {
  it('⌘J 打开 AI 对话(菜单键位);跳转到所选内容改为 ⌥⌘J', () => {
    expect(appKeyTable({}).get('Mod-j')).toBe('ai.open')
    expect(DEFAULT_KEYS['Mod-Alt-j']).toBe('edit.jumpToSelection')
    expect(DEFAULT_KEYS['Mod-j']).toBeUndefined()
    const table = defaultKeyTable()
    expect(table.get('Mod-j')).toBe('ai.open')
    expect(table.get('Mod-Alt-j')).toBe('edit.jumpToSelection')
    // 出厂键位不需要改原生菜单(原生菜单本身要按新键位出厂,见报告)
    expect(menuKeyOverrides({})).toEqual([])
  })
})
