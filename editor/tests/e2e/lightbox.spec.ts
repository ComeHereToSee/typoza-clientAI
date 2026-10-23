import { expect, test } from '@playwright/test'
import { loadDoc, openApp } from './helpers'

// 用户点名场景:文档里有标题、段落、表单截图、配置表格混排,双击任意图片(包括表格里的)放大查看。
test.describe('图片灯箱', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await expect(page.locator('.tz-editor table .tz-image img').first()).toBeVisible()
  })

  test('双击表格里的图片打开灯箱,可切换、缩放、关闭', async ({ page }) => {
    const tableImage = page.locator('.tz-editor table .tz-image').first()
    await tableImage.dblclick()
    const box = page.locator('.tz-lightbox')
    await expect(box).toBeVisible()
    await expect(page.locator('.tz-lb-counter')).toHaveText('2 / 4')
    const img = page.locator('.tz-lb-img')
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await page.screenshot({ path: 'test-results/screens/lightbox-open.png' })

    // ← / → 切换本文档的全部图片
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.tz-lb-counter')).toHaveText('3 / 4')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(page.locator('.tz-lb-counter')).toHaveText('1 / 4')

    // 缩放:+ 放大,0 适配,1 原始大小
    const zoom = page.locator('.tz-lb-zoom')
    const fitted = await zoom.textContent()
    await page.keyboard.press('+')
    await expect(zoom).not.toHaveText(fitted ?? '')
    await page.keyboard.press('1')
    await expect(zoom).toHaveText('100%')
    await page.keyboard.press('0')
    await expect(zoom).toHaveText(fitted ?? '')

    // 双击灯箱里的图片:适配 ↔ 放大
    await img.dblclick()
    await expect(box).toHaveClass(/is-zoomed/)
    await page.screenshot({ path: 'test-results/screens/lightbox-zoomed.png' })

    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
  })

  test('双击正文大图打开,点空白处关闭', async ({ page }) => {
    await page.locator('.tz-editor > p .tz-image').first().dblclick()
    await expect(page.locator('.tz-lb-counter')).toHaveText('1 / 4')
    // 左上角空白处(避开左右切换按钮与右上工具条)
    await page.mouse.click(60, 60)
    await expect(page.locator('.tz-lightbox')).toHaveCount(0)
  })

  test('动图在表格里正常显示并可放大', async ({ page }) => {
    const gif = page.locator('.tz-editor table img[data-tz-src="assets/anim.gif"]')
    await expect.poll(() => gif.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await gif.dblclick()
    await expect(page.locator('.tz-lb-counter')).toHaveText('4 / 4')
  })

  test('选中图片按空格也能打开(Notion)', async ({ page }) => {
    await page.locator('.tz-editor > p .tz-image img').first().click()
    await page.keyboard.press(' ')
    await expect(page.locator('.tz-lightbox')).toBeVisible()
  })

  // PRD 3.4 灯箱内操作:首尾不循环、旋转、复制;失败提示「图片无法加载」
  test('首尾不循环:第一张按 ← 停住,最后一张按 → 停住', async ({ page }) => {
    await page.locator('.tz-editor > p .tz-image').first().dblclick()
    const counter = page.locator('.tz-lb-counter')
    await expect(counter).toHaveText('1 / 4')
    await expect(page.locator('.tz-lb-prev')).toBeDisabled()
    await page.keyboard.press('ArrowLeft')
    await expect(counter).toHaveText('1 / 4')
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText('4 / 4')
    await expect(page.locator('.tz-lb-next')).toBeDisabled()
    await page.keyboard.press('ArrowRight')
    await expect(counter).toHaveText('4 / 4')
  })

  test('旋转每次 90°,复制图片交给外壳', async ({ page }) => {
    await page.locator('.tz-editor > p .tz-image').first().dblclick()
    const img = page.locator('.tz-lb-img')
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
    await page.locator('.tz-lb-rotate').click()
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.style.transform)).toContain('rotate(90deg)')
    await page.keyboard.press('r')
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.style.transform)).toContain('rotate(180deg)')
    await page.locator('.tz-lb-copy').click()
    await expect
      .poll(() => page.evaluate(() => window.typozaTest!.host.calls.filter((c) => c.method === 'copyImageToClipboard').map((c) => c.args)))
      .toEqual([['/demo/assets/form.svg']])
  })

  test('图片加载失败:灯箱内提示「图片无法加载」', async ({ page }) => {
    await loadDoc(page, '![丢失](assets/missing.png)\n')
    await page.locator('.tz-editor .tz-image').dblclick()
    await expect(page.locator('.tz-lb-status')).toHaveText('图片无法加载')
  })
})

// 补测:放大后拖动平移;⌘ / ⌃ + 滚轮缩放。实现在 ui/lightbox.ts bindPointer:
// 舞台上 pointerdown / pointermove / pointerup 平移(移动不足 3px 不算拖动,拖过不关灯箱);
// wheel 带 metaKey 或 ctrlKey 时以光标为中心缩放(触控板捏合在 WebKit 里是带 ctrlKey 的滚轮),不带时平移。
test.describe('图片灯箱:拖动平移与滚轮缩放', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page)
    await page.locator('.tz-editor > p .tz-image').first().dblclick()
    await expect(page.locator('.tz-lightbox')).toBeVisible()
    // 图片载入后才按窗口适配并写出缩放比例;载入前按键缩放会被载入时的适配覆盖
    await expect(page.locator('.tz-lb-zoom')).toHaveText(/^\d+%$/)
  })

  test('放大后按住拖动平移图片,松手后灯箱仍开着', async ({ page }) => {
    const box = page.locator('.tz-lightbox')
    const zoom = page.locator('.tz-lb-zoom')
    // 图片 transform 里第二个 translate 是平移量(第一个 translate(-50%, -50%) 用于居中)
    const offset = () =>
      page.locator('.tz-lb-img').evaluate((el: HTMLImageElement) => {
        const m = /translate\((-?[\d.]+)px(?:,\s*(-?[\d.]+)px)?\)/.exec(el.style.transform)
        return m ? [Number(m[1]), Number(m[2] ?? 0)] : null
      })
    await page.keyboard.press('+')
    await expect(box).toHaveClass(/is-zoomed/)
    expect(await offset()).toEqual([0, 0])
    const zoomed = (await zoom.textContent()) ?? ''

    const size = page.viewportSize()
    if (!size) throw new Error('取不到视口大小')
    // 舞台铺满窗口,放大后的图片盖住窗口中心
    const x = size.width / 2
    const y = size.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 80, y + 40, { steps: 8 })
    await page.mouse.up()
    await expect.poll(offset).toEqual([80, 40])
    await expect(box).toBeVisible()
    await expect(box).not.toHaveClass(/is-dragging/)
    // 平移不改缩放比例
    await expect(zoom).toHaveText(zoomed)
  })

  test('⌘ / ⌃ + 滚轮缩放图片,页面本身的缩放不变', async ({ page }) => {
    const percent = async () => Number.parseInt((await page.locator('.tz-lb-zoom').textContent()) ?? '', 10)
    const pageZoom = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--tz-zoom'))
    const pageZoomBefore = await pageZoom()
    const fitted = await percent()
    const size = page.viewportSize()
    if (!size) throw new Error('取不到视口大小')
    await page.mouse.move(size.width / 2, size.height / 2)

    // ⌘ + 滚轮向上:放大
    await page.keyboard.down('Meta')
    await page.mouse.wheel(0, -400)
    await page.keyboard.up('Meta')
    await expect.poll(percent).toBeGreaterThan(fitted)
    const zoomed = await percent()

    // ⌃ + 滚轮向下(触控板捏合):缩小
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, 100)
    await page.keyboard.up('Control')
    await expect.poll(percent).toBeLessThan(zoomed)

    await expect(page.locator('.tz-lightbox')).toBeVisible()
    // 灯箱开着时整页缩放不处理滚轮(app/appearance.ts bindZoomGestures)
    expect(await pageZoom()).toBe(pageZoomBefore)
  })
})
