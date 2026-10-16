import { expect, test } from '@playwright/test'
import { loadDoc, openApp } from './helpers'

// 文档内容不能在编辑器页面里执行脚本、嵌入的本地网页拿不到 typoza://local 的源(PRD 3.5)。
// 编辑器页面一旦被执行脚本,就能经原生桥读写本机任意文件。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

declare global {
  interface Window {
    __tzXss?: string
  }
}

test('折叠块标题里的 <img onerror> 不在编辑器页面执行', async ({ page }) => {
  await loadDoc(page, '<details>\n<summary>标题<img src="x" onerror="window.__tzXss=\'summary\'"></summary>\n\n内容\n\n</details>\n')
  await expect(page.locator('.tz-toggle')).toHaveCount(1)
  // 给图片加载失败留出时间
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => window.__tzXss)).toBeUndefined()
})

test('嵌入框不认 javascript: 地址(未保存的文档也一样)', async ({ page }) => {
  await loadDoc(page, '<iframe src="javascript:parent.__tzXss=\'iframe\'"></iframe>\n')
  await page.waitForTimeout(800)
  expect(await page.evaluate(() => window.__tzXss)).toBeUndefined()
  for (const src of await page.locator('.tz-editor iframe').evaluateAll((els) => els.map((e) => e.getAttribute('src') ?? ''))) {
    expect(src.toLowerCase()).not.toContain('javascript:')
  }
})

test('本地网页嵌入不给同源;远程网页照常给;x.html#.pdf 不当 PDF', async ({ page }) => {
  await loadDoc(
    page,
    '<iframe src="page.html"></iframe>\n\n<iframe src="page.html#.pdf"></iframe>\n\n<iframe src="https://www.youtube.com/embed/abc"></iframe>\n',
    '/notes/a.md',
  )
  const frames = page.locator('.tz-editor iframe')
  await expect(frames).toHaveCount(3)
  const sandboxes = await frames.evaluateAll((els) => els.map((e) => e.getAttribute('sandbox')))
  expect(sandboxes[0]).not.toContain('allow-same-origin')
  // 第二个原先被当成 PDF(PDF 框没有沙箱)
  expect(sandboxes[1]).not.toBeNull()
  expect(sandboxes[1]).not.toContain('allow-same-origin')
  expect(sandboxes[2]).toContain('allow-same-origin')
})

test('HTML 预览去掉 class、id(防借应用样式仿冒界面),源码保留', async ({ page }) => {
  await loadDoc(page, '<div class="tz-modal" id="fake">提示</div>\n')
  const div = page.locator('.tz-html-preview div', { hasText: '提示' })
  await expect(div).toHaveCount(1)
  expect(await div.evaluate((el) => [el.getAttribute('class'), el.getAttribute('id')])).toEqual([null, null])
  expect(await page.evaluate(() => window.typozaTest!.markdown())).toContain('class="tz-modal" id="fake"')
})

test('HTML 块里的相对链接按文档链接打开,不把编辑器页面换掉', async ({ page }) => {
  await page.evaluate(() => window.typozaTest!.host.files.set('/notes/other.md', { kind: 'file', data: '# 另一篇\n', mtime: Date.now() }))
  await loadDoc(page, '<p><a href="other.md">去另一篇</a></p>\n', '/notes/a.md')
  const before = page.url()
  await page.locator('.tz-html-preview a', { hasText: '去另一篇' }).click()
  await expect.poll(() => page.evaluate(() => window.typozaTest!.app.session.path)).toBe('/notes/other.md')
  expect(page.url()).toBe(before)
})
