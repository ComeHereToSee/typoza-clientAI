import { expect, type Page, test } from '@playwright/test'
import { loadDoc, markdown, openApp } from './helpers'
import { hostCalls, putFile } from './media-helpers'

// 斜杠菜单交互(notion-input.md 4.1)与条目全表(4.2)补测。
// slash.spec.ts 已覆盖标题 1、标题 2(插在下方)、表格、标注块、警告、折叠标题 2、日期、链接到文档;PDF、视频见 media.spec.ts。
// 条目定义在 plugins/items.ts slashItems,过滤与排序在 ui/menu.ts filterMenuItems;每条先确认第一项的 data-id 再回车,
// 保证插入的确实是要测的条目。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const menu = '.tz-slash-menu'
const firstItem = (page: Page) => page.locator(`${menu} .tz-menu-item`).first()

/** 敲「/查询词」,确认第一项是 id 后回车。 */
async function slash(page: Page, query: string, id: string): Promise<void> {
  await page.keyboard.type(`/${query}`)
  await expect(firstItem(page)).toHaveAttribute('data-id', id)
  await page.keyboard.press('Enter')
}

/** 光标先回到块首再敲斜杠:回车时查询词被删掉,块里只剩原有文字,不会留下斜杠前的空格。 */
async function slashAtStart(page: Page, query: string, id: string): Promise<void> {
  await page.keyboard.press('Home')
  await slash(page, query, id)
}

const fileText = (page: Page, path: string) =>
  page.evaluate((p) => {
    const e = window.typozaTest!.host.files.get(p)
    if (!e || e.kind !== 'file') return null
    return typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data)
  }, path)

// ---------- 4.1 交互 ----------

test.describe('4.1 斜杠菜单交互', () => {
  test('点块左侧「+」:在下方新建空块并打开斜杠菜单(7.1)', async ({ page }) => {
    await loadDoc(page, '第一段\n\n第二段\n')
    await page.locator('.tz-editor p').first().hover()
    const plus = page.locator('.tz-handle-plus')
    await expect(plus).toBeVisible()
    await plus.click()
    await expect(page.locator(menu)).toBeVisible()
    await page.keyboard.type('h2')
    await expect(firstItem(page)).toHaveAttribute('data-id', 'slash.h2')
    await page.keyboard.press('Enter')
    await page.keyboard.type('新标题')
    expect((await markdown(page)).trim()).toBe('第一段\n\n## 新标题\n\n第二段')
  })

  test('↑ ↓ 移动选择,↩ 插入所选条目', async ({ page }) => {
    await loadDoc(page, '')
    // 「/h」没有完全匹配的条目;前缀匹配里标题 1~3 按菜单原顺序排在最前
    await page.keyboard.type('/h')
    const selected = page.locator(`${menu} .tz-menu-item.is-selected`)
    await expect(selected).toHaveAttribute('data-id', 'slash.h1')
    await page.keyboard.press('ArrowDown')
    await expect(selected).toHaveAttribute('data-id', 'slash.h2')
    await page.keyboard.press('ArrowDown')
    await expect(selected).toHaveAttribute('data-id', 'slash.h3')
    await page.keyboard.press('ArrowUp')
    await expect(selected).toHaveAttribute('data-id', 'slash.h2')
    await page.keyboard.press('Enter')
    await page.keyboard.type('二级')
    expect((await markdown(page)).trim()).toBe('## 二级')
  })

  test('鼠标点击条目与回车同效', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('/quote')
    await page.locator(`${menu} .tz-menu-item[data-id="slash.quote"]`).click()
    await expect(page.locator(menu)).toHaveCount(0)
    await page.keyboard.type('引文')
    expect((await markdown(page)).trim()).toBe('> 引文')
  })

  test('排序:完全匹配 > 前缀匹配 > 包含,/red 先出红色', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('/red')
    const labels = page.locator(`${menu} .tz-menu-label`)
    await expect(labels.nth(0)).toHaveText('红色')
    await expect(labels.nth(1)).toHaveText('红色背景')
    // 只是包含 red 的(numbered、ordered)排在后面
    const all = await labels.allTextContents()
    expect(all.indexOf('有序列表')).toBeGreaterThan(1)
  })
})

// ---------- 4.2 条目:插入后敲文字,断言存储语法 ----------

test.describe('4.2 斜杠条目:块类型', () => {
  /** [查询词, 第一项 data-id, 插入后敲的文字, 期望的 Markdown] */
  const cases: [string, string, string, string][] = [
    ['h3', 'slash.h3', '标题', '### 标题'],
    ['h4', 'slash.h4', '标题', '#### 标题'],
    ['h5', 'slash.h5', '标题', '##### 标题'],
    ['h6', 'slash.h6', '标题', '###### 标题'],
    ['bullet', 'slash.bullet', '内容', '- 内容'],
    ['numbered', 'slash.numbered', '内容', '1. 内容'],
    ['todo', 'slash.todo', '内容', '- [ ] 内容'],
    ['toggle', 'slash.toggle', '标题', '<details>\n<summary>标题</summary>\n\n</details>'],
    ['toggleh1', 'slash.toggleh1', '标题', '<details>\n<summary><h1>标题</h1></summary>\n\n</details>'],
    ['toggleh3', 'slash.toggleh3', '标题', '<details>\n<summary><h3>标题</h3></summary>\n\n</details>'],
    ['quote', 'slash.quote', '内容', '> 内容'],
    ['code', 'slash.code', 'x = 1', '```\nx = 1\n```'],
    ['math', 'slash.math', 'x^2', '$$\nx^2\n$$'],
    ['mermaid', 'slash.diagram', 'graph TD', '```mermaid\ngraph TD\n```'],
    ['note', 'slash.callout.note', '内容', '> [!NOTE]\n> 内容'],
    ['tip', 'slash.callout.tip', '内容', '> [!TIP]\n> 内容'],
    ['important', 'slash.callout.important', '内容', '> [!IMPORTANT]\n> 内容'],
    ['caution', 'slash.callout.caution', '内容', '> [!CAUTION]\n> 内容'],
  ]

  for (const [query, id, typed, expected] of cases) {
    test(`/${query} → ${id}`, async ({ page }) => {
      await loadDoc(page, '')
      await slash(page, query, id)
      await page.keyboard.type(typed)
      // 代码块的文字经 CodeMirror 同步回文档,轮询等它落地
      await expect.poll(async () => (await markdown(page)).trim()).toBe(expected)
    })
  }

  test('/text 把空标题转回正文', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'h2', 'slash.h2')
    await expect(page.locator('.tz-editor h2')).toHaveCount(1)
    await slash(page, 'text', 'slash.paragraph')
    await page.keyboard.type('正文')
    await expect(page.locator('.tz-editor h2')).toHaveCount(0)
    expect((await markdown(page)).trim()).toBe('正文')
  })

  test('/divider 插入分割线,光标落到下一段', async ({ page }) => {
    await loadDoc(page, '前文\n')
    await page.keyboard.press('Enter')
    await slash(page, 'divider', 'slash.divider')
    await expect(page.locator('.tz-editor hr')).toHaveCount(1)
    await page.keyboard.type('后文')
    expect((await markdown(page)).trim()).toBe('前文\n\n---\n\n后文')
  })

  test('/toc 插入目录', async ({ page }) => {
    await loadDoc(page, '# 第一章\n')
    await page.keyboard.press('Enter')
    await slash(page, 'toc', 'slash.toc')
    await expect(page.locator('.tz-editor .tz-toc .tz-toc-item')).toHaveText(['第一章'])
    expect((await markdown(page)).trim()).toBe('# 第一章\n\n[TOC]')
  })

  test('/yaml 在文首插入 YAML 元数据块', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'yaml', 'slash.yaml')
    await expect(page.locator('.tz-editor .tz-frontmatter')).toHaveCount(1)
    await page.keyboard.type('title: 测试')
    await expect.poll(() => markdown(page)).toMatch(/^---\ntitle: 测试\n---\n/)
  })

  test('/html 插入 HTML 块', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'html', 'slash.html')
    await expect(page.locator('.tz-editor .tz-html-block.is-editing')).toHaveCount(1)
    await page.keyboard.type('<kbd>K</kbd>')
    await expect.poll(() => markdown(page)).toContain('<kbd>K</kbd>')
  })

  test('/linkref 插入引用式链接定义', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'linkref', 'slash.linkref')
    await expect.poll(() => markdown(page)).toContain('[ref]: https://')
  })

  test('/footnote 在光标处插脚注号,文末插定义', async ({ page }) => {
    await loadDoc(page, '正文\n')
    // 斜杠要在空白或标点后才触发
    await page.keyboard.type(' ')
    await slash(page, 'footnote', 'slash.footnote')
    const out = await markdown(page)
    expect(out).toContain('正文 [^1]')
    expect(out).toContain('\n[^1]:')
  })
})

test.describe('4.2 斜杠条目:行内', () => {
  test('/equation 打开行内公式输入框,回车存 $公式$', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'equation', 'slash.inlineMath')
    const input = page.locator('.tz-math-input')
    await expect(input).toBeFocused()
    await page.keyboard.type('x^2')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('$x^2$')
  })

  test('/mention 打开文档提及菜单,选中插入相对链接', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'mention', 'slash.mention')
    await page.keyboard.type('另一')
    await expect(page.locator('.tz-suggest-menu .tz-menu-item', { hasText: '另一篇' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('[另一篇](另一篇.md)')
  })

  test('/emoji 在光标处打开表情菜单,选中存 Unicode 表情', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'emoji', 'slash.emoji')
    await page.keyboard.type('smile')
    await expect(page.locator('.tz-suggest-menu .tz-menu-item').first()).toContainText(':smile:')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('😄')
  })
})

test.describe('4.2 斜杠条目:媒体', () => {
  test('/image ▸ 图片网址…:插入网络图片', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'image', 'slash.image')
    await page.locator(`${menu} .tz-menu-item[data-id="image.url"]`).click()
    const input = page.locator('.tz-prompt-input')
    await input.fill('https://example.com/pic.png')
    await input.press('Enter')
    await expect.poll(() => markdown(page)).toContain('![](https://example.com/pic.png)')
  })

  test('/bookmark 输入网址生成书签卡片', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'bookmark', 'slash.bookmark')
    const input = page.locator('.tz-prompt-input')
    await input.fill('https://example.com/post')
    await input.press('Enter')
    // 网页标题与描述由内存宿主的 fetchLinkPreview 给出
    await expect
      .poll(() => markdown(page))
      .toContain('<a href="https://example.com/post" title="内存宿主生成的链接预览" data-tz-type="bookmark">预览:https://example.com/post</a>')
  })

  test('/audio 填音频直链存 <audio>', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'audio', 'slash.audio')
    const input = page.locator('.tz-media-source input')
    await expect(input).toBeFocused()
    await input.fill('https://a.example/song.mp3')
    await input.press('Enter')
    await expect.poll(() => markdown(page)).toContain('<audio src="https://a.example/song.mp3" controls></audio>')
  })

  test('/file 选本地文件:复制到附件目录,存附件卡片', async ({ page }) => {
    await putFile(page, '/Users/test/notes.txt', '记录')
    await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/Users/test/notes.txt']))
    await loadDoc(page, '')
    await slash(page, 'file', 'slash.file')
    await expect.poll(() => markdown(page)).toContain('<a href="assets/notes.txt" data-tz-type="file">notes.txt</a>')
    expect(await fileText(page, '/demo/assets/notes.txt')).toBe('记录')
  })

  test('/embed 输入视频网站网址存播放器嵌入', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'embed', 'slash.embed')
    const input = page.locator('.tz-prompt-input')
    await input.fill('https://www.youtube.com/watch?v=abc123')
    await input.press('Enter')
    await expect
      .poll(() => markdown(page))
      .toContain('<iframe src="https://www.youtube.com/embed/abc123" width="100%" height="400" frameborder="0" allowfullscreen></iframe>')
  })

  test('推文 / 地图 / 云盘不单设条目,并入【嵌入】', async ({ page }) => {
    for (const query of ['tweet', 'maps', 'drive']) {
      await loadDoc(page, '')
      await page.keyboard.type(`/${query}`)
      await expect(firstItem(page)).toHaveAttribute('data-id', 'slash.embed')
      await page.keyboard.press('Escape')
      await expect(page.locator(menu)).toHaveCount(0)
    }
  })
})

test.describe('4.2 斜杠条目:新文档与块操作', () => {
  test('/page 在当前文件夹新建「未命名.md」,原处插链接并在新标签页打开', async ({ page }) => {
    await loadDoc(page, '')
    await slash(page, 'page', 'slash.page')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('[未命名](未命名.md)')
    expect(await fileText(page, '/demo/未命名.md')).toBe('')
    await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([['/demo/未命名.md', { tab: true }]])
  })

  test('/duplicate 在下方复制当前块', async ({ page }) => {
    await loadDoc(page, '原段\n')
    await slashAtStart(page, 'duplicate', 'slash.duplicate')
    expect((await markdown(page)).trim()).toBe('原段\n\n原段')
  })

  test('/delete 删除当前块', async ({ page }) => {
    await loadDoc(page, '留下\n\n删掉\n')
    await slashAtStart(page, 'delete', 'slash.delete')
    expect((await markdown(page)).trim()).toBe('留下')
  })

  test('/moveto 选目标文档:当前块移到其末尾', async ({ page }) => {
    await loadDoc(page, '留下\n\n移走\n')
    await slashAtStart(page, 'moveto', 'slash.moveTo')
    await expect(page.locator('.tz-pick-menu .tz-menu-search')).toBeFocused()
    await page.keyboard.type('另一篇')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('留下')
    expect(await fileText(page, '/demo/另一篇.md')).toBe('# 另一篇\n\n用于测试文档链接。\n\n移走\n')
  })

  test('/turn 打开带搜索框的「转换为」子菜单', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await slashAtStart(page, 'turn', 'slash.turn')
    await expect(page.locator(`${menu} .tz-menu-search`)).toBeFocused()
    await page.keyboard.type('引用')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('> 文字')
  })

  test('/turnbullet 直达条目只在搜索时出现,选中即转换当前块', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await slashAtStart(page, 'turnbullet', 'slash.turn.bullet')
    expect((await markdown(page)).trim()).toBe('- 文字')
  })
})

test.describe('4.2 斜杠条目:颜色', () => {
  test('/red 给当前块设文字颜色', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await slashAtStart(page, 'red', 'color.red')
    expect((await markdown(page)).trim()).toBe('<span style="color: #D44C47">文字</span>')
  })

  test('/blue background 给当前块设背景色', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await slashAtStart(page, 'blue background', 'bg.blue')
    expect((await markdown(page)).trim()).toBe('<span style="background-color: #E7F3F8">文字</span>')
  })

  test('/default 去掉颜色(选「默认」= 去掉 <span> 包裹)', async ({ page }) => {
    await loadDoc(page, '<span style="color: #D44C47">文字</span>\n')
    await slashAtStart(page, 'default', 'color.default')
    expect((await markdown(page)).trim()).toBe('文字')
  })
})

test.describe('4.2 斜杠条目:页面图标与封面', () => {
  test('/icon 输入表情作页面图标,写进 YAML', async ({ page }) => {
    await loadDoc(page, '正文\n')
    await slashAtStart(page, 'icon', 'slash.icon')
    const input = page.locator('.tz-prompt-input')
    await input.fill('📘')
    await input.press('Enter')
    await expect.poll(() => markdown(page)).toBe('---\nicon: 📘\n---\n\n正文\n')
  })

  test('/cover 选图片作页面封面:拷进资源目录,写进 YAML', async ({ page }) => {
    await loadDoc(page, '正文\n')
    await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/demo/assets/form.svg']))
    await slashAtStart(page, 'cover', 'slash.cover')
    await expect.poll(() => markdown(page)).toMatch(/^---\ncover: assets\/form-1\.svg\n---\n/)
  })
})

test('4.2「不做」的条目搜不到:提醒、按钮、模板、面包屑、评论、同步块、分栏、数据库', async ({ page }) => {
  for (const query of ['reminder', 'button', 'template', 'bread', 'comment', 'synced', 'column', 'database']) {
    await loadDoc(page, '')
    await page.keyboard.type(`/${query}`)
    // 无匹配:菜单显示「无结果」或已自动关闭,两种情况都没有可选条目,敲的字原样保留
    await expect(page.locator(`${menu} .tz-menu-item`)).toHaveCount(0)
    expect((await markdown(page)).trim()).toBe(`/${query}`)
  }
})
