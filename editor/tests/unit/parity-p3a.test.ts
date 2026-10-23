import { describe, expect, it } from 'vitest'
import type { FileOps } from '../../src/app/fileops'
import { Sidebar } from '../../src/app/sidebar'
import type { HeadingItem } from '../../src/core/blocks'
import { createMemoryHost } from '../../src/host/memory'

// 对照表 S-01 / PF-02:侧栏大纲的「可折叠 / 无折叠」两种形态。
// 侧栏创建时读一次偏好 outlineCollapsible;E2E 的内存宿主刷新页面后设置不保留,进不了「关着启动」的状态,这里直接建侧栏看渲染结果。

const heading = (level: number, text: string): HeadingItem => ({ level, text, pos: 0, id: text })
const headings = [heading(1, 'A'), heading(2, 'A1'), heading(3, 'A1a'), heading(2, 'A2'), heading(1, 'B')]

async function outline(settings: Record<string, unknown>): Promise<{ el: HTMLElement; jumped: string[] }> {
  const host = createMemoryHost()
  Object.assign(host.settings, settings)
  const jumped: string[] = []
  const sidebar = new Sidebar(host, {
    openFile: () => {},
    openAt: () => {},
    jumpToHeading: (item) => void jumped.push(item.text),
    currentPath: () => null,
    onTabChange: () => {},
    onError: (message) => {
      throw new Error(message)
    },
    // 大纲用不到文件操作
    ops: {} as FileOps,
  })
  // 偏好在构造时异步读取:等它读完再切到大纲
  await new Promise((resolve) => setTimeout(resolve, 0))
  sidebar.setHeadings(headings, -1)
  await sidebar.setTab('outline')
  return { el: sidebar.el, jumped }
}

/** 没被折叠隐藏的标题文字 */
const visible = (el: HTMLElement) =>
  Array.from(el.querySelectorAll<HTMLElement>('.tz-outline-item'))
    .filter((row) => !row.hidden)
    .map((row) => row.lastElementChild?.textContent)

const twisties = (el: HTMLElement) => Array.from(el.querySelectorAll('.tz-outline-twisty')).map((t) => t.textContent)

describe('大纲折叠开关(对照表 S-01、PF-02)', () => {
  it('默认可折叠:有下级的标题带折叠箭头,有「全部折叠 / 全部展开」;点箭头收起下级', async () => {
    const { el, jumped } = await outline({})
    expect(el.querySelector('button[name=collapseAll]')).not.toBeNull()
    expect(el.querySelector('button[name=expandAll]')).not.toBeNull()
    expect(twisties(el)).toEqual(['▾', '▾', '', '', ''])
    el.querySelector<HTMLElement>('.tz-outline-twisty')!.click()
    expect(visible(el)).toEqual(['A', 'B'])
    // 点箭头只折叠,不跳转
    expect(jumped).toEqual([])
  })

  it('关掉「允许折叠和展开侧边栏的大纲视图」:没有箭头和折叠按钮,标题全部显示,点击照常跳转', async () => {
    const { el, jumped } = await outline({ outlineCollapsible: false })
    expect(el.querySelector('button[name=collapseAll]')).toBeNull()
    expect(el.querySelector('button[name=expandAll]')).toBeNull()
    expect(twisties(el)).toEqual(['', '', '', '', ''])
    el.querySelector<HTMLElement>('.tz-outline-twisty')!.click()
    expect(visible(el)).toEqual(['A', 'A1', 'A1a', 'A2', 'B'])
    expect(jumped).toEqual(['A'])
  })
})
