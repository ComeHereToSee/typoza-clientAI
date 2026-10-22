import { expect, type Locator, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { clipboardEvent, hostCalls } from './media-helpers'

// Notion 快捷输入与键位补测(notion-input.md 2.1、2.2、三、5.1、7.1;验收第 1 轮 A5)。
// 只写网页自己处理的键:编辑区键位见 core/keymap.ts 的 DEFAULT_KEYS;浏览器里的应用级键位是 app/shortcuts.ts 的 MENU_KEYS,
// 由 App.bindBrowserKeys(app/app.ts)处理,native.*(⌘T、⇧⌘T、⌥⌘S……)只有原生外壳能做,这里不测。
// CI 跑在 Linux WebKit 上,Mod 就是 Ctrl:⌃⌘X 与 ⌘X 在这里是同一个键,个别用例因此先把焦点移出正文,见各条注释。

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

/** 焦点移出正文(相当于点了侧栏或页面空白处)。 */
async function blurEditor(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

// ---------- 2.1 块级快捷输入 ----------

test.describe('2.1 块级快捷输入', () => {
  /** [条目, 敲的字符, 结果块的选择器, 期望的 Markdown] */
  const cases: [string, string, string, string][] = [
    ['#1 + 空格成无序列表,存偏好符号 -', '+ 项目', 'ul', '- 项目'],
    ['#3 - [ ] 成未完成待办', '- [ ] 待办', '.tz-task', '- [ ] 待办'],
    ['#3 - [x] 成已完成待办', '- [x] 完成', '.tz-task', '- [x] 完成'],
    // 字母与罗马编号没有标准 Markdown 写法,统一存数字(core/inputrules.ts 有序列表规则 start 取 1)
    ['#4 a. 成有序列表,存数字', 'a. 第一', 'ol', '1. 第一'],
    ['#4 i. 成有序列表,存数字', 'i. 第一', 'ol', '1. 第一'],
    ['#7 ### 成标题 3', '### 三级', 'h3', '### 三级'],
    ['#8 #### 成标题 4', '#### 四级', 'h4', '#### 四级'],
    ['#8 ##### 成标题 5', '##### 五级', 'h5', '##### 五级'],
    ['#8 ###### 成标题 6', '###### 六级', 'h6', '###### 六级'],
  ]

  for (const [name, typed, selector, expected] of cases) {
    test(name, async ({ page }) => {
      await loadDoc(page, '')
      await page.keyboard.type(typed)
      await expect(page.locator(`.tz-editor ${selector}`)).toHaveCount(1)
      expect((await markdown(page)).trim()).toBe(expected)
    })
  }

  test('#13 --- 成分割线:全文第一个块存 ***,其余位置存 ---', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('---')
    await expect(page.locator('.tz-editor hr')).toHaveCount(1)
    // 文首写 --- 会被当成 YAML front matter 的开头(core/markdown/serialize.ts serializeMarkdown)
    expect((await markdown(page)).trim()).toBe('***')

    await loadDoc(page, '文字\n')
    await page.keyboard.press('Enter')
    await page.keyboard.type('---')
    await expect(page.locator('.tz-editor hr')).toHaveCount(1)
    expect((await markdown(page)).trim()).toBe('文字\n\n---')
  })

  test('#15 $$ 后回车成公式块', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('$$')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tz-editor .tz-math-block')).toHaveCount(1)
    await page.keyboard.type('E=mc^2')
    expect((await markdown(page)).trim()).toBe('$$\nE=mc^2\n$$')
  })

  test('#17 [toc] 后回车成目录,存 [TOC],目录随标题更新', async ({ page }) => {
    await loadDoc(page, '# 第一章\n')
    await page.keyboard.press('Enter')
    await page.keyboard.type('[toc]')
    await page.keyboard.press('Enter')
    const items = page.locator('.tz-editor .tz-toc .tz-toc-item')
    await expect(items).toHaveText(['第一章'])
    // 回车后光标在目录下方的新段落里;新标题出现后目录刷新(plugins/basics.ts tocRefreshPlugin)
    await page.keyboard.type('## 第二章')
    await expect(items).toHaveText(['第一章', '第二章'])
    expect((await markdown(page)).trim()).toBe('# 第一章\n\n[TOC]\n\n## 第二章')
  })
})

// ---------- 2.2 行内快捷输入 ----------

test.describe('2.2 行内快捷输入', () => {
  test('#2 _文字_ 成斜体,存 *文字*', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('前 _斜体_ 后')
    await expect(page.locator('.tz-editor em')).toHaveText('斜体')
    expect((await markdown(page)).trim()).toBe('前 *斜体* 后')
  })

  test('#5 ~~文字~~ 成删除线', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('前 ~~删除~~ 后')
    await expect(page.locator('.tz-editor s, .tz-editor del')).toHaveText('删除')
    expect((await markdown(page)).trim()).toBe('前 ~~删除~~ 后')
  })

  test('#8 敲完 [文字](网址) 成链接', async ({ page }) => {
    await loadDoc(page, '')
    // 敲 [ 和 ( 时自动配对会补出 ] 与 ),敲收尾符号时越过 / 一并替换(plugins/basics.ts autoPairPlugin、core/inputrules.ts pairedCloser)
    await page.keyboard.type('见 [文字](https://example.com)')
    await expect(page.locator('.tz-editor a[href="https://example.com"]')).toHaveText('文字')
    expect((await markdown(page)).trim()).toBe('见 [文字](https://example.com)')
  })

  test('#9 敲完 ![替代文字](路径) 成图片', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('见 ![图](assets/form.svg)')
    await expect(page.locator('.tz-editor .tz-image')).toHaveCount(1)
    expect((await markdown(page)).trim()).toBe('见 ![图](assets/form.svg)')
  })

  test('#10 正文里的网址敲空格后自动成链接,保存仍是裸网址', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('见 https://example.com 后')
    await expect(page.locator('.tz-editor a[href="https://example.com"]')).toHaveText('https://example.com')
    expect((await markdown(page)).trim()).toBe('见 https://example.com 后')
  })

  test('#15 选中文字后粘贴网址:文字变链接,不弹粘贴菜单', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await page.keyboard.press(`${await modKey(page)}+a`)
    await clipboardEvent(page, 'paste', 'https://example.com')
    await expect(page.locator('.tz-editor a[href="https://example.com"]')).toHaveText('文字')
    await expect(page.locator('.tz-paste-menu')).toHaveCount(0)
    expect((await markdown(page)).trim()).toBe('[文字](https://example.com)')
  })
})

// ---------- 三、粘贴网址 ----------

test('三 粘贴音频直链:菜单首项是【音频】,选中存 <audio>', async ({ page }) => {
  await loadDoc(page, '')
  await clipboardEvent(page, 'paste', 'https://a.example/song.mp3')
  const menu = page.locator('.tz-paste-menu')
  await expect(menu.locator('.tz-menu-label')).toHaveText(['音频', '保持链接', '书签卡片', '嵌入网页'])
  await page.keyboard.press('Enter')
  await expect.poll(() => markdown(page)).toContain('<audio src="https://a.example/song.mp3" controls></audio>')
})

// ---------- 5.1 应用级键位(浏览器里由网页自己处理) ----------

test.describe('5.1 应用级键位', () => {
  test('#1 ⌘F 打开文内查找,焦点进查找框', async ({ page }) => {
    await loadDoc(page, '苹果 香蕉 苹果\n')
    await page.keyboard.press(`${await modKey(page)}+f`)
    const input = page.locator('.tz-find-input').first()
    await expect(input).toBeFocused()
    await page.keyboard.type('苹果')
    await expect(page.locator('.tz-find-count')).toHaveText(/^\d\/2$/)
  })

  test('#2 ⌘P 打开快速打开', async ({ page }) => {
    await loadDoc(page, '文字\n')
    await page.keyboard.press(`${await modKey(page)}+p`)
    await expect(page.locator('.tz-quick-open')).toBeVisible()
    await expect(page.locator('.tz-qo-input')).toBeFocused()
  })

  test('#3 ⌘L 复制当前文档路径', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '文字\n')
    await page.evaluate(() => {
      // 命令直接写 navigator.clipboard(app/app.ts file.copyPath),测试环境换成记录,免得受系统剪贴板权限影响
      const copied: string[] = []
      ;(window as unknown as { __copied: string[] }).__copied = copied
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => void copied.push(text) },
      })
    })
    // Linux 上正文里的 Ctrl-L 是「选中当前行或句」(⌃⌘L 在非 macOS 上与 ⌘L 重合),焦点移出正文才轮到 ⌘L;macOS 上是两个键
    await blurEditor(page)
    await page.keyboard.press(`${mod}+l`)
    await expect(page.locator('.tz-toast')).toHaveText('已复制文档路径')
    const path = await currentPath(page)
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([path])
  })

  test('#4 ⌘[ 回到上一个查看位置,#5 ⌘] 前进', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '去看 [另一篇](另一篇.md)\n')
    const origin = await currentPath(page)
    await page.locator('.tz-editor a', { hasText: '另一篇' }).click()
    await page.locator('.tz-link-card button[name=open]').click()
    await expect.poll(() => currentPath(page)).toBe('/demo/另一篇.md')
    await page.keyboard.press(`${mod}+BracketLeft`)
    await expect.poll(() => currentPath(page)).toBe(origin)
    await page.keyboard.press(`${mod}+BracketRight`)
    await expect.poll(() => currentPath(page)).toBe('/demo/另一篇.md')
  })

  test('#7 ⇧⌘L 切换浅色 / 深色外观', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '文字\n')
    // Linux 上 Mod 是 Ctrl,焦点在正文时 Ctrl+Shift+L 到不了应用级键位(同 ⌘L);真应用里走原生菜单
    await blurEditor(page)
    const html = page.locator('html')
    await expect(html).not.toHaveClass(/tz-dark/)
    await page.keyboard.press(`${mod}+Shift+l`)
    await expect(html).toHaveClass(/tz-dark/)
    await page.keyboard.press(`${mod}+Shift+l`)
    await expect(html).not.toHaveClass(/tz-dark/)
  })

  test('#8 ⌘N 与 #9 ⇧⌘N 新建窗口', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '文字\n')
    await page.keyboard.press(`${mod}+n`)
    await page.keyboard.press(`${mod}+Shift+n`)
    // 浏览器里没有原生外壳:native.newWindow 换成网页命令 file.newWindow,经宿主开新窗口(app/shortcuts.ts BROWSER_ALIASES)
    await expect.poll(() => hostCalls(page, 'openDocument')).toEqual([
      ['', { newWindow: true }],
      ['', { newWindow: true }],
    ])
  })

  test('#35 ⌘+ 页面放大,#36 ⌘- 页面缩小', async ({ page }) => {
    const mod = await modKey(page)
    const zoom = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tz-zoom'))
    await loadDoc(page, '文字\n')
    // Linux 上正文里的 Ctrl-= / Ctrl-- 是提升 / 降低标题级别(⌃⌘= / ⌃⌘- 在非 macOS 上与 ⌘= / ⌘- 重合),焦点移出正文才轮到页面缩放
    await blurEditor(page)
    await page.keyboard.press(`${mod}+Equal`)
    await expect.poll(zoom).toBe('1.1')
    await page.keyboard.press(`${mod}+Minus`)
    await expect.poll(zoom).toBe('1')
    expect((await markdown(page)).trim()).toBe('文字')
  })
})

// ---------- 5.1 编辑区键位 ----------

test.describe('5.1 编辑区键位', () => {
  test('#14 空列表项上 ↩ 退出列表', async ({ page }) => {
    await loadDoc(page, '- 一\n')
    await page.keyboard.press('Enter')
    await expect(page.locator('.tz-editor li')).toHaveCount(2)
    await page.keyboard.press('Enter')
    await expect(page.locator('.tz-editor li')).toHaveCount(1)
    await page.keyboard.type('正文')
    expect((await markdown(page)).trim()).toBe('- 一\n\n正文')
  })

  test('#15 ⇧↩ 段内换行,存行尾反斜杠', async ({ page }) => {
    await loadDoc(page, '')
    await page.keyboard.type('第一行')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('第二行')
    await expect(page.locator('.tz-editor p')).toHaveCount(1)
    expect((await markdown(page)).trim()).toBe('第一行\\\n第二行')
  })

  /** [条目, 按键(Mod 代表 ⌘ / Ctrl), 对选中的「文字」按键后的 Markdown] */
  const formatCases: [string, string, string][] = [
    ['#18 ⌘I 斜体', 'Mod+i', '*文字*'],
    ['#19 ⌘U 下划线', 'Mod+u', '<u>文字</u>'],
    ['#20 ⇧⌘S 删除线', 'Mod+Shift+s', '~~文字~~'],
    // ⌘E 的 Typora 别名(notion-input.md 5.2「格式」行),在 macOS 与 Linux 上都是同一个键
    ['⌃` 行内代码(⌘E 的别名)', 'Control+Backquote', '`文字`'],
  ]

  for (const [name, keys, expected] of formatCases) {
    test(name, async ({ page }) => {
      const mod = await modKey(page)
      await loadDoc(page, '文字\n')
      await page.keyboard.press(`${mod}+a`)
      await page.keyboard.press(keys.replace('Mod', mod))
      expect((await markdown(page)).trim()).toBe(expected)
    })
  }

  test('#22 ⌘E 行内代码', async ({ page }) => {
    const mod = await modKey(page)
    // 非 macOS 上 Mod 就是 Ctrl:⌃⌘E(选中当前格式文本)与 ⌘E 都成了 Ctrl-E,core/keymap.ts 里后写的选中格式文本生效,
    // CI 的 Linux WebKit 按不出 ⌘E;只在 macOS 上跑,两个平台都能跑的别名 ⌃` 见上一组
    test.skip(mod !== 'Meta', '非 macOS 上 ⌘E 与 ⌃⌘E 是同一个键')
    await loadDoc(page, '文字\n')
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.press(`${mod}+e`)
    expect((await markdown(page)).trim()).toBe('`文字`')
  })

  test('#21 正文里 ⌘K 给选中文字加链接,剪贴板里的网址自动填入', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '文字\n')
    await page.evaluate(() => {
      window.typozaTest!.host.clipboard.text = 'https://example.com/a'
    })
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.press(`${mod}+k`)
    const input = page.locator('.tz-prompt-input')
    await expect(input).toHaveValue('https://example.com/a')
    await input.press('Enter')
    await expect.poll(async () => (await markdown(page)).trim()).toBe('[文字](https://example.com/a)')
  })

  test('#23 Tab 列表缩进,#24 ⇧Tab 反缩进', async ({ page }) => {
    await loadDoc(page, '- 一\n- 二\n')
    await page.keyboard.press('Tab')
    expect((await markdown(page)).trim()).toBe('- 一\n  - 二')
    await page.keyboard.press('Shift+Tab')
    expect((await markdown(page)).trim()).toBe('- 一\n- 二')
  })

  test('#34 ⌥⌘9 把当前块转为新文档,原处换成链接', async ({ page }) => {
    await loadDoc(page, '会议纪要\n')
    await page.keyboard.press(`${await modKey(page)}+Alt+9`)
    // 以块文字为文件名在当前文件夹新建(app/app.ts blockToDocument)
    await expect.poll(async () => (await markdown(page)).trim()).toBe('[会议纪要](会议纪要.md)')
    expect(await fileText(page, '/demo/会议纪要.md')).toBe('# 会议纪要\n')
    await expect(page.locator('.tz-toast')).toHaveText('已新建「会议纪要.md」')
  })

  test('#42 ⌘A:第 1 次选中当前块文字,第 2 次全选', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '第一段\n\n第二段\n')
    const selected = () =>
      page.evaluate(() => {
        const s = window.typozaTest!.app.view.state
        return s.doc.textBetween(s.selection.from, s.selection.to, '|')
      })
    await page.keyboard.press(`${mod}+a`)
    expect(await selected()).toBe('第二段')
    await page.keyboard.press(`${mod}+a`)
    expect(await selected()).toBe('第一段|第二段')
    await page.keyboard.press('Backspace')
    expect((await markdown(page)).trim()).toBe('')
  })

  test('#54 ⇧⌘H 应用上次使用的颜色;从未用过时为黄色背景', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '甲\n\n乙\n')
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.press(`${mod}+Shift+h`)
    expect((await markdown(page)).trim()).toBe('甲\n\n<span style="background-color: #FBF3DB">乙</span>')
    // 收起选区,格式条随之隐藏,不挡下面的点击
    await page.keyboard.press('End')
    await expect(page.locator('.tz-toolbar')).toBeHidden()

    // 用斜杠菜单给「甲」设红色:记为上次使用的颜色(plugins/items.ts colorItems → rememberColor)
    await page.locator('.tz-editor p').first().click()
    await page.keyboard.press('Home')
    await page.keyboard.type('/red')
    await expect(page.locator('.tz-slash-menu .tz-menu-item').first()).toHaveAttribute('data-id', 'color.red')
    await page.keyboard.press('Enter')

    await page.locator('.tz-editor p').nth(1).click()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.press(`${mod}+Shift+h`)
    expect((await markdown(page)).trim()).toBe('<span style="color: #D44C47">甲</span>\n\n<span style="color: #D44C47">乙</span>')
  })

  test('#56 ⇧⌘E 把选中文字转为行内公式', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, 'x^2\n')
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.press(`${mod}+Shift+e`)
    await expect(page.locator('.tz-editor .tz-math-inline')).toHaveCount(1)
    expect((await markdown(page)).trim()).toBe('$x^2$')
  })
})

// ---------- 5.1 块选中态键位(Esc 之后) ----------

test.describe('5.1 块选中态键位', () => {
  const selectedNode = (page: Page) => page.locator('.tz-editor .ProseMirror-selectednode')

  test('#44 ↑ ↓ 换选上 / 下一块,不改内容', async ({ page }) => {
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.keyboard.press('Escape')
    await expect(selectedNode(page)).toHaveText('三')
    await page.keyboard.press('ArrowUp')
    await expect(selectedNode(page)).toHaveText('二')
    await page.keyboard.press('ArrowUp')
    await expect(selectedNode(page)).toHaveText('一')
    await page.keyboard.press('ArrowDown')
    await expect(selectedNode(page)).toHaveText('二')
    expect((await markdown(page)).trim()).toBe('一\n\n二\n\n三')
  })

  test('#45 ⇧↓ 向下扩选', async ({ page }) => {
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.locator('.tz-editor p').first().click()
    await page.keyboard.press('Escape')
    await expect(selectedNode(page)).toHaveText('一')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.locator('.tz-editor .tz-block-selected')).toHaveText(['一', '二'])
  })

  test('#48 Delete 删除所选块', async ({ page }) => {
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.keyboard.press('Escape')
    await expect(selectedNode(page)).toHaveText('三')
    await page.keyboard.press('Delete')
    expect((await markdown(page)).trim()).toBe('一\n\n二')
  })

  test('#50 ↩ 光标进入所选块末尾编辑', async ({ page }) => {
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.keyboard.press('Escape')
    await expect(selectedNode(page)).toHaveText('三')
    await page.keyboard.press('Enter')
    await expect(selectedNode(page)).toHaveCount(0)
    await page.keyboard.type('尾')
    expect((await markdown(page)).trim()).toBe('一\n\n二\n\n三尾')
  })

  test('#52 ⇧⌘↓ 下移所选块;文字编辑态不移动块', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.locator('.tz-editor p').first().click()
    // 文字编辑态保留系统的扩选行为(core/registry.ts block.moveDownSelected 只认块选中态)
    await page.keyboard.press(`${mod}+Shift+ArrowDown`)
    expect((await markdown(page)).trim()).toBe('一\n\n二\n\n三')
    await page.keyboard.press('Escape')
    await expect(selectedNode(page)).toHaveText('一')
    await page.keyboard.press(`${mod}+Shift+ArrowDown`)
    expect((await markdown(page)).trim()).toBe('二\n\n一\n\n三')
  })
})

// ---------- 7.1 块手柄拖动(「+」见 notion-slash-items.spec.ts 4.1) ----------

test.describe('7.1 块手柄拖动', () => {
  /** 鼠标移到块上,等「⋮⋮」出现。 */
  async function gripOf(page: Page, block: Locator): Promise<Locator> {
    await block.hover()
    const grip = page.locator('.tz-handle-grip')
    await expect(grip).toBeVisible()
    return grip
  }

  /**
   * 在页面里用真实的 DragEvent + DataTransfer 走一遍拖放(dragstart → dragenter / dragover → drop → dragend)。
   * Playwright 在 Linux WebKit 上模拟原生拖放时,编辑区收不到 drop(CI trace:鼠标按下、移动、松开都做了,文档不变;
   * 侧栏那条走自己的放置处理能过)。这里直接派发事件,验证手柄写入的拖动数据与 ProseMirror 的落点处理。
   */
  async function dragBlock(page: Page, grip: Locator, target: Locator, position: { x: number; y: number }, alt = false): Promise<void> {
    const box = await target.boundingBox()
    if (!box) throw new Error('取不到落点的位置')
    await grip.evaluate(
      (el, { x, y, alt }) => {
        const dt = new DataTransfer()
        const fire = (node: Element, type: string, cx: number, cy: number) =>
          node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy, altKey: alt }))
        const g = el.getBoundingClientRect()
        fire(el, 'dragstart', g.x + g.width / 2, g.y + g.height / 2)
        const over = document.elementFromPoint(x, y)
        if (!over) throw new Error('落点下没有元素')
        fire(over, 'dragenter', x, y)
        fire(over, 'dragover', x, y)
        fire(over, 'drop', x, y)
        fire(el, 'dragend', x, y)
      },
      { x: box.x + position.x, y: box.y + position.y, alt },
    )
  }

  /** 落在段落行尾:ProseMirror 按落点在块的后半段,插在该块之后 */
  async function endOf(block: Locator): Promise<{ x: number; y: number }> {
    const box = await block.boundingBox()
    if (!box) throw new Error('取不到块的位置')
    return { x: box.width - 4, y: box.height / 2 }
  }

  test('拖「⋮⋮」到其他块之后:移动块', async ({ page }) => {
    await loadDoc(page, '甲\n\n乙\n\n丙\n')
    const paras = page.locator('.tz-editor p')
    const target = paras.nth(2)
    const grip = await gripOf(page, paras.nth(0))
    await dragBlock(page, grip, target, await endOf(target))
    await expect.poll(async () => (await markdown(page)).trim()).toBe('乙\n\n丙\n\n甲')
  })

  test('#40 按住 ⌥ 拖「⋮⋮」:原块保留,落点出现副本', async ({ page }) => {
    await loadDoc(page, '甲\n\n乙\n\n丙\n')
    const paras = page.locator('.tz-editor p')
    const target = paras.nth(2)
    const grip = await gripOf(page, paras.nth(0))
    // 落下时按着 ⌥ 即复制(plugins/blockselect.ts dragCopies)
    await dragBlock(page, grip, target, await endOf(target), true)
    await expect.poll(async () => (await markdown(page)).trim()).toBe('甲\n\n乙\n\n丙\n\n甲')
  })

  test('拖「⋮⋮」到侧栏文档:块追加到该文档末尾,当前文档移除该块', async ({ page }) => {
    await command(page, 'view.fileTree')
    const target = page.locator('.tz-tree-item[data-path="/demo/另一篇.md"]')
    await expect(target).toBeVisible()
    await loadDoc(page, '留下\n\n移走\n')
    const grip = await gripOf(page, page.locator('.tz-editor p').nth(1))
    await grip.dragTo(target)
    await expect.poll(async () => (await markdown(page)).trim()).toBe('留下')
    expect(await fileText(page, '/demo/另一篇.md')).toBe('# 另一篇\n\n用于测试文档链接。\n\n移走\n')
    await expect(page.locator('.tz-toast')).toHaveText('已移动到「另一篇」')
  })

  test('拖动多个已选块:一起移动,保持原有先后顺序', async ({ page }) => {
    await loadDoc(page, '一\n\n二\n\n三\n')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+ArrowUp')
    await expect(page.locator('.tz-editor .tz-block-selected')).toHaveText(['二', '三'])
    const paras = page.locator('.tz-editor p')
    const target = paras.nth(0)
    const box = await target.boundingBox()
    if (!box) throw new Error('取不到块的位置')
    // 拖任一所选块的「⋮⋮」作用于全部所选块(plugins/handle.ts inMultiSelection);落在第一块行首 = 插在它之前
    const grip = await gripOf(page, paras.nth(1))
    await dragBlock(page, grip, target, { x: 2, y: box.height / 2 })
    await expect.poll(async () => (await markdown(page)).trim()).toBe('二\n\n三\n\n一')
  })
})
