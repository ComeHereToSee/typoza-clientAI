import { expect, type Page, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'

// 大文档视口裁剪(plugins/viewport.ts):离视口远的顶层块不参与排版,光标所在块与视口附近的块照常显示、可编辑
test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const BLOCKS = 3000
const bigDoc = (n = BLOCKS) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 段,用于测试大文档的视口裁剪。`).join('\n\n') + '\n'

const displayOf = (page: Page, index: number) =>
  page.evaluate((i) => {
    const el = document.querySelector('.tz-editor')?.children[i]
    return el ? getComputedStyle(el).display : 'missing'
  }, index)

test('远处的块不排版;跳到文末后可见并可输入;滚回开头仍可见', async ({ page }) => {
  await page.evaluate((md) => window.typozaTest!.load(md, '/demo/大文档.md'), bigDoc())
  await expect.poll(() => displayOf(page, 0)).toBe('block')
  await expect.poll(() => displayOf(page, BLOCKS - 1)).toBe('none')

  // 跳到文末:光标所在块进入窗口
  // WebKit 里要真实点击聚焦,原生的光标移动键才生效
  await page.locator('.tz-editor > p').first().click()
  await page.keyboard.press((await modKey(page)) === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
  await expect.poll(() => displayOf(page, BLOCKS - 1)).toBe('block')
  await page.keyboard.type('尾')
  await expect.poll(async () => (await markdown(page)).trimEnd().endsWith('裁剪。尾')).toBe(true)

  // 滚回开头:按滚动位置重新定窗口
  await page.evaluate(() => {
    document.querySelector('.tz-scroll')!.scrollTop = 0
  })
  await expect.poll(() => displayOf(page, 0)).toBe('block')
  await expect(page.locator('.tz-editor > p').first()).toBeInViewport()
})

test('大文档分段载入:先显示开头、载入中不可编辑;载完后全文完整,写回逐字相同', async ({ page }) => {
  // 八千段约 24 万字符,按 32KB 一段分成七八段载入,足够在载完前看到「载入中」。
  // 不用更大:CI 的 Linux WebKit 排版比 macOS 真应用慢得多,两万段要 70~85 秒,贴着超时偶发失败(真应用 5MB 约 6 秒)
  test.setTimeout(90_000)
  const total = 8000
  const md = bigDoc(total)
  await page.evaluate((text) => window.typozaTest!.host.files.set('/demo/分段.md', { kind: 'file', data: text, mtime: Date.now() }), md)
  // 打开后立即(同一次执行里,后续段落还没来得及续上)看状态:正在载入、状态栏显示进度、不可编辑
  const first = await page.evaluate(async () => {
    const app = window.typozaTest!.app
    await app.openFile('/demo/分段.md', { replace: true })
    return {
      loading: app.loading,
      blocks: app.view.state.doc.childCount,
      editable: app.view.editable,
      status: document.querySelector('.tz-status-words')?.textContent ?? '',
    }
  })
  expect(first.loading).toBe(true)
  expect(first.blocks).toBeLessThan(total)
  expect(first.status).toContain('载入中')
  expect(first.editable).toBe(false)
  // 每秒记一次状态栏的载入进度,载不完时随断言带出(区分「慢」与「卡住」)
  const samples: string[] = []
  for (let i = 0; i < 40 && (await page.evaluate(() => window.typozaTest!.app.loading)); i++) {
    samples.push(`${i}s:${await page.locator('.tz-status-words').textContent()}`)
    await page.waitForTimeout(1000)
  }
  expect(await page.evaluate(() => window.typozaTest!.app.loading), samples.join(' ')).toBe(false)
  expect(await page.evaluate(() => window.typozaTest!.app.view.state.doc.childCount)).toBe(total)
  expect(await page.evaluate(() => window.typozaTest!.app.view.editable)).toBe(true)
  expect(await markdown(page)).toBe(md)
})

test('小文档不启用裁剪', async ({ page }) => {
  await loadDoc(page, '一\n\n二\n\n三\n')
  expect(await page.evaluate(() => document.querySelector('.tz-editor-host')!.classList.contains('tz-vp'))).toBe(false)
})
