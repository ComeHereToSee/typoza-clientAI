import { expect, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'

// Typora 对照表(docs/prd/typora-parity.md)里缺 E2E 证据、网页侧能测的项:E-16、P-15、F-18(验收第 1 轮 A6)。
// F-07 重新打开关闭的文件(⇧⌘T)、F-17 保存全部(⌥⌘S)、H-06 欢迎向导(快速上手)是 native.* 命令,
// 只在原生外壳(app/Sources/Typoza/MainMenu.swift)里有,浏览器里的网页按键处理会跳过它们(app/app.ts bindBrowserKeys),这里不测。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

async function command(page: Page, id: string): Promise<void> {
  await page.evaluate((cmd) => window.typozaTest!.host.emit('menu.command', { id: cmd }), id)
}

const currentPath = (page: Page) => page.evaluate(() => window.typozaTest!.app.session.path)

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

test('E-16 ⌘J 跳转到所选内容:滚回光标所在处', async ({ page }) => {
  const mod = await modKey(page)
  const md = `${Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段`).join('\n\n')}\n`
  // loadDoc 把光标放在文末
  await loadDoc(page, md)
  const caretInView = () =>
    page.evaluate(() => {
      const view = window.typozaTest!.app.view
      const caret = view.coordsAtPos(view.state.selection.head)
      const box = document.querySelector('.tz-scroll')!.getBoundingClientRect()
      return caret.top >= box.top && caret.bottom <= box.bottom
    })
  await page.evaluate(() => {
    document.querySelector('.tz-scroll')!.scrollTop = 0
  })
  await expect.poll(caretInView).toBe(false)
  await page.keyboard.press(`${mod}+j`)
  await expect.poll(caretInView).toBe(true)
  expect(await markdown(page)).toBe(md)
})

test('P-15 表格 ⌃⌘→ 右移该列、⌃⌘← 左移该列', async ({ page }) => {
  const mod = await modKey(page)
  // 非 macOS 上 Mod 就是 Ctrl,⌃⌘ 方向键即 Ctrl + 方向键(与 table.spec.ts 的 ⌃⌘↓ 同理)
  const key = (arrow: string) => (mod === 'Meta' ? `Control+Meta+${arrow}` : `Control+${arrow}`)
  const cell = (text: string) => page.locator('.tz-editor td, .tz-editor th').filter({ hasText: new RegExp(`^${text}$`) })
  await loadDoc(page, '| a | b |\n| - | - |\n| 1 | 2 |\n')
  await cell('1').click()
  await page.keyboard.press(key('ArrowRight'))
  expect((await markdown(page)).trim()).toBe('| b | a |\n| - | - |\n| 2 | 1 |')
  // 重新点进「1」所在的格(现在在第 2 列),再左移回去
  await cell('1').click()
  await page.keyboard.press(key('ArrowLeft'))
  expect((await markdown(page)).trim()).toBe('| a | b |\n| - | - |\n| 1 | 2 |')
})

test('F-18 复原到已保存:先确认「放弃更改」,取消则保留修改', async ({ page }) => {
  await loadDoc(page, '# 复原\n\n原文\n')
  const path = await currentPath(page)
  if (!path) throw new Error('文档没有路径')
  // 关掉自动保存,否则输入一秒后就写盘,磁盘版本跟着变(app/app.ts AUTOSAVE_DELAY)
  await page.evaluate(() => window.typozaTest!.app.updateSettings({ autoSave: false }))
  await page.keyboard.type('改动')
  await expect.poll(() => markdown(page)).toBe('# 复原\n\n原文改动\n')

  const confirms = () =>
    page.evaluate(() =>
      window.typozaTest!.host.calls.filter((c) => c.method === 'confirm').map((c) => c.args[0] as { title: string; buttons: string[] }),
    )
  // 第一次选「取消」(第 2 个按钮):不复原
  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(1))
  await command(page, 'file.revert')
  await expect.poll(async () => (await confirms()).length).toBe(1)
  const [ask] = await confirms()
  expect(ask.title).toBe('要复原到上次保存的版本吗?')
  expect(ask.buttons).toEqual(['放弃更改', '取消'])
  expect(await markdown(page)).toBe('# 复原\n\n原文改动\n')

  // 第二次选「放弃更改」(确认队列为空时宿主返回 0):回到磁盘上的版本
  await command(page, 'file.revert')
  await expect.poll(() => markdown(page)).toBe('# 复原\n\n原文\n')
  expect(await fileText(page, path)).toBe('# 复原\n\n原文\n')
})
