import { expect, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

// Notion 块级快捷输入:行首敲标记 + 空格即时转换
const blockCases: [string, string, string][] = [
  ['# 标题', '# 标题', 'h1'],
  ['## 二级', '## 二级', 'h2'],
  ['- 项目', '- 项目', 'ul'],
  ['* 项目', '- 项目', 'ul'],
  ['1. 第一', '1. 第一', 'ol'],
  ['[] 待办', '- [ ] 待办', '.tz-task'],
  ['" 引用', '> 引用', 'blockquote'],
  ['> 折叠', '<details>\n<summary>折叠</summary>\n\n</details>', '.tz-toggle'],
]

for (const [typed, expected, selector] of blockCases) {
  test(`块级输入:${typed.split(' ')[0]}`, async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type(typed)
    await expect(page.locator(`.tz-editor ${selector}`)).toHaveCount(1)
    expect((await markdown(page)).trim()).toBe(expected)
  })
}

test('分割线 --- 与代码块 ```', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('---')
  await expect(page.locator('.tz-editor hr')).toHaveCount(1)
  await page.keyboard.type('```js ')
  await expect(page.locator('.tz-editor .tz-code-block')).toHaveCount(1)
  await page.keyboard.type('const a = 1')
  expect(await markdown(page)).toContain('```js\nconst a = 1\n```')
})

const inlineCases: [string, string][] = [
  ['**粗体**', '**粗体**'],
  ['*斜体*', '*斜体*'],
  ['`代码`', '`代码`'],
  ['~删除~', '~~删除~~'],
  ['==高亮==', '==高亮=='],
  ['$$x^2$$', '$x^2$'],
]

for (const [typed, expected] of inlineCases) {
  test(`行内输入:${typed}`, async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type(`前 ${typed} 后`)
    expect((await markdown(page)).trim()).toBe(`前 ${expected} 后`)
  })
}

test('快捷键:加粗、标题、复制块、待办切换', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '')
  await page.keyboard.type('文字')
  await page.keyboard.press(`${mod}+a`)
  await page.keyboard.press(`${mod}+b`)
  expect((await markdown(page)).trim()).toBe('**文字**')
  await page.keyboard.press('End')
  await page.keyboard.press(`${mod}+Alt+1`)
  expect((await markdown(page)).trim()).toBe('# **文字**')
  await page.keyboard.press(`${mod}+d`)
  expect((await markdown(page)).trim()).toBe('# **文字**\n\n# **文字**')
  await loadDoc(page, '- [ ] 任务\n')
  await page.keyboard.press(`${mod}+Enter`)
  expect((await markdown(page)).trim()).toBe('- [x] 任务')
})

test('待办复选框与文字第一行垂直居中对齐(默认主题与行高更大的主题、改字号)', async ({ page }) => {
  await loadDoc(page, '- 项目\n- 名称\n\n- [ ] 待办事项 2\n- [x] 已完成\n')
  /** 复选框中心与第一行文字中心的垂直偏差(像素) */
  const offsets = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.tz-editor li.tz-task')].map((li) => {
        const box = li.querySelector('.tz-task-box')!.getBoundingClientRect()
        const p = li.querySelector<HTMLElement>('.tz-task-content > p')!
        // 第一行的行盒:段落内容区顶部 + 半个行高(不用字形框:CI 上的中文回退字体上下不对称)
        const cs = getComputedStyle(p)
        const lineTop = p.getBoundingClientRect().top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)
        return Math.abs(box.top + box.height / 2 - (lineTop + parseFloat(cs.lineHeight) / 2))
      }),
    )
  for (const o of await offsets()) expect(o).toBeLessThan(1.5)
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'whitey'
    document.documentElement.style.setProperty('--tz-font-size', '20px')
  })
  for (const o of await offsets()) expect(o).toBeLessThan(1.5)
})

test('Esc 选中块后用方向键与 ⇧⌘↑ 移动', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '第一段\n\n第二段\n')
  await page.keyboard.press('Escape')
  await expect(page.locator('.tz-editor .ProseMirror-selectednode')).toHaveText('第二段')
  await page.keyboard.press(`${mod}+Shift+ArrowUp`)
  expect((await markdown(page)).trim()).toBe('第二段\n\n第一段')
})

test('斜杠菜单:过滤并插入表格', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('/')
  const menu = page.locator('.tz-slash-menu')
  await expect(menu).toBeVisible()
  await page.keyboard.type('table')
  await expect(menu.locator('.tz-menu-item').first()).toContainText('表格')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tz-editor table')).toHaveCount(1)
  await expect(menu).toHaveCount(0)
  expect(await markdown(page)).not.toContain('/table')
})

test('斜杠菜单支持中文与拼音关键词', async ({ page }) => {
  await loadDoc(page, '')
  await page.keyboard.type('/daiban')
  await expect(page.locator('.tz-slash-menu .tz-menu-item').first()).toContainText('待办')
  await page.keyboard.press('Escape')
  await expect(page.locator('.tz-slash-menu')).toHaveCount(0)
})

test('选中文字出现格式条', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '一段文字')
  await page.keyboard.press(`${mod}+a`)
  await expect(page.locator('.tz-toolbar')).toBeVisible()
  await page.locator('.tz-toolbar button[title^="斜体"]').click()
  expect((await markdown(page)).trim()).toBe('*一段文字*')
})
