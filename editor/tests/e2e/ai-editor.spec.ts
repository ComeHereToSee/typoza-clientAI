import { expect, test, type Page } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { aiCalls, ask, lastAnswer, openAiPanel, queueReply, selectText } from './ai-helpers'
import { contextMenuAt } from './media-helpers'

// 正文里的 AI:选中文字的 AI 动作(ai-prd 3.4)、/ai 与空行按空格(3.5)、模型改文档的差异预览(3.7)、未配置模型时的提示(3.1)。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

const card = (page: Page) => page.locator('.tz-editor .tz-ai-card')

async function runAction(page: Page, text: string, actionId: string): Promise<void> {
  await selectText(page, text)
  await expect(page.locator('.tz-toolbar')).toBeVisible()
  await page.locator('.tz-toolbar button.tz-tb-ai').click()
  await page.locator(`.tz-ai-action-menu .tz-menu-item[data-id="ai.action.${actionId}"]`).click()
}

test.describe('选中文字 ▸ AI 动作', () => {
  test('格式条【AI】▸ 润色:结果在选区下方,【替换】一步可撤回', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '原来的句子写得不好。\n')
    await queueReply(page, [{ text: '改好的**句子**。' }])
    await runAction(page, '原来的句子写得不好。', 'builtin.polish')
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    await expect(card(page).locator('.tz-ai-card-result')).toHaveText('改好的句子。')
    // 预览期间不改文档
    expect(await markdown(page)).toBe('原来的句子写得不好。\n')
    const [req] = await aiCalls(page, 'ai.complete')
    expect(req.selection).toBe('原来的句子写得不好。')
    expect(req.prompt).toContain('润色')
    expect(req.prompt).toContain('原来的句子写得不好。')
    await page.screenshot({ path: 'test-results/screens/ai-selection.png' })

    await card(page).locator('button[name=replace]').click()
    await expect(card(page)).toHaveCount(0)
    expect(await markdown(page)).toBe('改好的**句子**。\n')
    await page.keyboard.press(`${mod}+z`)
    expect(await markdown(page)).toBe('原来的句子写得不好。\n')
  })

  test('【插入下方】;翻译可选目标语言', async ({ page }) => {
    await loadDoc(page, '你好世界\n')
    await queueReply(page, [{ text: 'Hello world' }])
    await selectText(page, '你好世界')
    await page.locator('.tz-toolbar button.tz-tb-ai').click()
    await page.locator('.tz-ai-action-menu .tz-menu-item[data-id="ai.action.builtin.translate"]').click()
    await page.locator('.tz-ai-action-menu .tz-menu-item[data-id="ai.lang.英文"]').click()
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    expect((await aiCalls(page, 'ai.complete'))[0].prompt).toContain('翻译成英文')
    await card(page).locator('button[name=insertBelow]').click()
    expect(await markdown(page)).toBe('你好世界\n\nHello world\n')
  })

  test('Esc 放弃;右键「AI ▸」同样可用', async ({ page }) => {
    await loadDoc(page, '一段要缩短的文字。\n')
    await queueReply(page, [{ text: '不要的结果' }], [{ text: '缩短了' }])
    await runAction(page, '一段要缩短的文字。', 'builtin.shorten')
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    await page.keyboard.press('Escape')
    await expect(card(page)).toHaveCount(0)
    expect(await markdown(page)).toBe('一段要缩短的文字。\n')

    await selectText(page, '一段要缩短的文字。')
    // 在选中的文字上右键(只派发菜单事件,不让右键按下改动选区)
    await contextMenuAt(page, '.tz-editor p', { x: 8, y: 14 })
    await page.locator('.tz-context-menu .tz-menu-item[data-id="ctx.ai"]').hover()
    await page.locator('.tz-context-menu .tz-menu-item[data-id="ai.action.builtin.shorten"]').click()
    await expect(card(page).locator('.tz-ai-card-result')).toHaveText('缩短了')
    await card(page).locator('button[name=discard]').click()
    await expect(card(page)).toHaveCount(0)
    expect(await markdown(page)).toBe('一段要缩短的文字。\n')
  })

  test('生成中原文被改动:【替换】改为提示,只能重新生成或插入下方', async ({ page }) => {
    await loadDoc(page, '需要改写的原文。\n')
    await queueReply(page, [{ text: '改写结果' }, { hold: true }])
    await runAction(page, '需要改写的原文。', 'builtin.rewrite')
    await expect(card(page).locator('.tz-ai-card-result')).toHaveText('改写结果')
    await expect(card(page)).toHaveAttribute('data-status', 'streaming')
    await page.evaluate(() => {
      const v = window.typozaTest!.app.view
      v.dispatch(v.state.tr.insertText('又', 3))
    })
    await page.evaluate(() => window.typozaTest!.host.ai.release())
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    await expect(card(page).locator('[data-role=changed]')).toHaveText('原文已改动,请重新生成或插入下方')
    await expect(card(page).locator('button[name=replace]')).toHaveCount(0)
    await expect(card(page).locator('button[name=insertBelow]')).toBeEnabled()
  })
})

test.describe('/ai 与空行按空格', () => {
  test('/ai 生成待确认块:未接受前保存不写入文件,【接受】后写入', async ({ page }) => {
    const path = '/demo/AI 写作.md'
    await loadDoc(page, '第一段。\n', path)
    await page.keyboard.press('Enter')
    await page.keyboard.type('/ai')
    await expect(page.locator('.tz-slash-menu .tz-menu-item').first()).toContainText('AI 写作')
    await page.keyboard.press('Enter')
    const input = card(page).locator('textarea')
    await expect(input).toBeFocused()
    await queueReply(page, [{ text: '这是 AI 写的结尾。' }])
    await input.fill('写一句结尾')
    await input.press('Enter')
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    await expect(card(page).locator('.tz-ai-card-result')).toHaveText('这是 AI 写的结尾。')
    const [req] = await aiCalls(page, 'ai.complete')
    expect(req.prompt).toBe('写一句结尾')
    expect(req.document).toContain('第一段。')
    expect(typeof req.cursor).toBe('number')

    await page.evaluate(() => window.typozaTest!.app.save())
    const saved = () =>
      page.evaluate((p) => {
        const entry = window.typozaTest!.host.files.get(p)
        return entry?.kind === 'file' ? String(entry.data) : ''
      }, path)
    expect(await saved()).not.toContain('AI 写的结尾')
    expect(await markdown(page)).not.toContain('AI 写的结尾')

    await card(page).locator('button[name=accept]').click()
    await expect(card(page)).toHaveCount(0)
    expect(await markdown(page)).toBe('第一段。\n\n这是 AI 写的结尾。\n')
    await page.evaluate(() => window.typozaTest!.app.save())
    expect(await saved()).toBe('第一段。\n\n这是 AI 写的结尾。\n')
  })

  test('/ai 放弃后正文不变', async ({ page }) => {
    await loadDoc(page, '第一段。\n')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/ai')
    await page.keyboard.press('Enter')
    await queueReply(page, [{ text: '不要这段' }])
    await card(page).locator('textarea').fill('随便写点')
    await card(page).locator('textarea').press('Enter')
    await expect(card(page)).toHaveAttribute('data-status', 'done')
    await card(page).locator('button[name=discard]').click()
    await expect(card(page)).toHaveCount(0)
    expect(await markdown(page)).not.toContain('不要这段')
  })

  test('空行行首按空格唤起 AI;设置关闭后空格照常输入', async ({ page }) => {
    await loadDoc(page, '第一段。\n')
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await expect(card(page).locator('textarea')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(card(page)).toHaveCount(0)
    await page.keyboard.type('x')
    expect(await page.locator('.tz-editor p').last().evaluate((el) => el.textContent)).toBe('x')

    await page.evaluate(() => window.typozaTest!.app.ai.updateSettings({ spaceTriggersAi: false }))
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await page.keyboard.type('y')
    await expect(card(page)).toHaveCount(0)
    // 行首空格可能被浏览器写成不换行空格
    expect(await page.locator('.tz-editor p').last().evaluate((el) => el.textContent)).toMatch(/^\sy$/)
  })
})

test.describe('模型改文档(doc.edit)', () => {
  test('正文里显示差异预览,【应用】一步写入并回报结果,⌘Z 撤回', async ({ page }) => {
    const mod = await modKey(page)
    await loadDoc(page, '# 计划\n\n第一段旧内容。\n\n第二段保持不变。\n')
    await openAiPanel(page)
    await queueReply(page, [{ edit: { kind: 'replace_range', find: '第一段旧内容。', text: '第一段新内容。' } }, { text: '已经改好了。' }])
    await ask(page, '改一下第一段')
    const del = page.locator('.tz-editor .tz-ai-del')
    await expect(del).toHaveCount(1)
    await expect(del).toContainText('第一段旧内容。')
    await expect(page.locator('.tz-editor .tz-ai-ins')).toContainText('第一段新内容。')
    await expect(lastAnswer(page).locator('.tz-ai-tool[data-tool="typoza__edit_document"] [data-edit-state=preview]')).toBeVisible()
    // 确认前不写入
    expect(await markdown(page)).toBe('# 计划\n\n第一段旧内容。\n\n第二段保持不变。\n')
    await page.screenshot({ path: 'test-results/screens/ai-doc-edit.png' })

    await page.locator('.tz-ai-diff-bar button[name=applyEdit]').click()
    await expect(del).toHaveCount(0)
    await expect(page.locator('.tz-editor .tz-ai-ins')).toHaveCount(0)
    expect(await markdown(page)).toBe('# 计划\n\n第一段新内容。\n\n第二段保持不变。\n')
    await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('已经改好了。')
    const [decide] = await aiCalls(page, 'ai.tool.decide')
    expect(decide).toMatchObject({ decision: 'allow', result: '已应用修改(共 1 处)' })

    await page.locator('.tz-editor h1').click()
    await page.keyboard.press(`${mod}+z`)
    expect(await markdown(page)).toBe('# 计划\n\n第一段旧内容。\n\n第二段保持不变。\n')
  })

  test('确认前改了正文:预览失效并提示;【拒绝】回报给模型', async ({ page }) => {
    await loadDoc(page, '# 计划\n\n正文。\n')
    await openAiPanel(page)
    await queueReply(page, [{ edit: { kind: 'insert', text: '新增的一段。' } }, { text: '好的,不加了。' }])
    await ask(page, '在文末加一段')
    await expect(page.locator('.tz-editor .tz-ai-ins')).toContainText('新增的一段。')
    await page.locator('.tz-editor h1').click()
    await page.keyboard.type('!')
    const tool = lastAnswer(page).locator('.tz-ai-tool[data-tool="typoza__edit_document"]')
    await expect(tool.locator('[data-role=stale]')).toHaveText('正文已改动,预览已失效')
    await expect(page.locator('.tz-editor .tz-ai-ins')).toHaveCount(0)
    await expect(tool.locator('button[name=repreview]')).toBeVisible()
    await tool.locator('button[name=rejectEdit]').click()
    await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('好的,不加了。')
    expect((await aiCalls(page, 'ai.tool.decide'))[0]).toMatchObject({ decision: 'deny' })
    expect(await markdown(page)).not.toContain('新增的一段')
  })

  test('要替换的原文找不到:不预览,直接把原因回报模型', async ({ page }) => {
    await loadDoc(page, '正文。\n')
    await openAiPanel(page)
    await queueReply(page, [{ edit: { kind: 'replace_range', find: '不存在的句子', text: 'x' } }, { text: '没找到。' }])
    await ask(page, '改一下')
    await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
    await expect(lastAnswer(page).locator('[data-edit-state=failed]')).toContainText('找不到要修改的原文')
    expect((await aiCalls(page, 'ai.tool.decide'))[0]).toMatchObject({ decision: 'deny', result: expect.stringContaining('修改失败') })
    expect(await markdown(page)).toBe('正文。\n')
  })
})

test.describe('未配置模型', () => {
  test('各入口提示去设置,其余照常', async ({ page }) => {
    await loadDoc(page, '一段文字\n')
    await page.evaluate(() => window.typozaTest!.host.ai.reset({ configured: false }))
    await openAiPanel(page)
    const notice = page.locator('.tz-ai-panel [data-role=not-configured]')
    await expect(notice).toContainText('请先在设置 ▸ AI 服务商中添加模型')
    await expect(page.locator('.tz-ai-panel textarea[name=prompt]')).toBeDisabled()

    // 选中文字 ▸ AI:提示并给【去设置】
    await selectText(page, '一段文字')
    await page.locator('.tz-toolbar button.tz-tb-ai').click()
    const toast = page.locator('.tz-toast')
    await expect(toast).toContainText('请先在设置 ▸ AI 服务商中添加模型')
    await toast.locator('.tz-toast-action').click()
    await expect(page.locator('.tz-settings-tab[data-page="AI 服务商"]')).toHaveClass(/is-active/)
    await page.locator('.tz-modal').last().locator('.tz-modal-close').click()

    // 空行按空格照常输入空格
    await page.locator('.tz-editor p').last().click()
    await page.keyboard.press((await modKey(page)) === 'Meta' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await expect(card(page)).toHaveCount(0)
    expect(await page.locator('.tz-editor p').last().evaluate((el) => el.textContent)).toMatch(/^\s$/)

    // 侧栏的【去设置】直达 AI 服务商页
    await page.locator('.tz-ai-panel button[name=goSettings]').click()
    await expect(page.locator('.tz-settings-tab[data-page="AI 服务商"]')).toHaveClass(/is-active/)
    expect(await aiCalls(page, 'ai.chat.send')).toEqual([])
    expect(await aiCalls(page, 'ai.complete')).toEqual([])
  })
})

test('⌥⌘J 仍然跳转到所选内容;⌘J 打开 AI 侧栏', async ({ page }) => {
  const mod = await modKey(page)
  const paras = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 段,写一些足够长的文字让文档可以滚动。`).join('\n\n')
  await loadDoc(page, `${paras}\n`)
  await selectText(page, '第 1 段')
  const scroll = page.locator('.tz-scroll')
  const toBottom = () => scroll.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await toBottom()
  const bottom = await scroll.evaluate((el) => el.scrollTop)
  expect(bottom).toBeGreaterThan(1000)
  await page.keyboard.press(`${mod}+Alt+j`)
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBeLessThan(bottom - 500)
  await expect(page.locator('.tz-ai-panel')).toBeHidden()

  await toBottom()
  const before = await scroll.evaluate((el) => el.scrollTop)
  await page.keyboard.press(`${mod}+j`)
  await expect(page.locator('.tz-ai-panel')).toBeVisible()
  expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(before - 50)
})
