import { expect, test } from '@playwright/test'
import { loadDoc, markdown, modKey, openApp } from './helpers'
import { aiCalls, answers, ask, lastAnswer, openAiPanel, queueReply } from './ai-helpers'

// AI 侧栏(ai-prd 3.2 对话、3.3 分支、3.7 工具调用确认),由模拟 AI 服务按脚本驱动。

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('⌘J 打开侧栏:带上当前文档发送,回答流式渲染;停止;出错显示原因并重试', async ({ page }) => {
  await loadDoc(page, '# 季度计划\n\n正文第一段。\n')
  await openAiPanel(page)
  const panel = page.locator('.tz-ai-panel')
  await expect(panel.locator('.tz-ai-chip[data-kind=document]')).toBeVisible()

  await queueReply(page, [{ text: '这是**第一段**回答,内容比较长,会分很多段推送出来。' }])
  await ask(page, '帮我总结')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).locator('.tz-ai-markdown strong')).toHaveText('第一段')
  const [sent] = await aiCalls(page, 'ai.chat.send')
  expect(sent.text).toBe('帮我总结')
  expect((sent.context as { kind: string; text?: string }[])[0]).toMatchObject({ kind: 'document', text: '# 季度计划\n\n正文第一段。\n' })
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-msg-text')).toHaveText('帮我总结')

  // 停止:保留已输出的部分
  await queueReply(page, [{ text: '前半段' }, { hold: true }, { text: '后半段' }])
  await ask(page, '继续写')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('前半段')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'streaming')
  await panel.locator('button[name=stop]').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'stopped')
  await expect(lastAnswer(page)).toContainText('已停止')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('前半段')
  await expect(panel.locator('button[name=send]')).toBeVisible()

  // 出错:显示服务商给的原因,401 提示检查密钥;【重试】得到新版本
  await queueReply(page, [{ error: { code: 'auth', message: '401 Unauthorized' } }], [{ text: '重试成功' }])
  await ask(page, '再来一次')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'error')
  await expect(lastAnswer(page).locator('.tz-ai-error')).toContainText('401 Unauthorized')
  await expect(lastAnswer(page).locator('.tz-ai-error')).toContainText('请检查服务商密钥')
  await lastAnswer(page).locator('button[name=retry]').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('重试成功')
  await expect(lastAnswer(page).locator('.tz-ai-version')).toHaveText('2/2')
  await page.screenshot({ path: 'test-results/screens/ai-panel.png' })
})

test('选区作为上下文;回答插入到光标、插入文末与复制', async ({ page }) => {
  const mod = await modKey(page)
  await loadDoc(page, '第一段。\n\n第二段。\n')
  await page.evaluate(() => {
    const v = window.typozaTest!.app.view
    v.focus()
    const Sel = v.state.selection.constructor as unknown as { create(doc: unknown, a: number, b: number): typeof v.state.selection }
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, 1, 4)))
  })
  await openAiPanel(page)
  const panel = page.locator('.tz-ai-panel')
  await expect(panel.locator('.tz-ai-chip[data-kind=selection]')).toBeVisible()
  await queueReply(page, [{ text: 'AI 的回答' }])
  await ask(page, '解释一下')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  const [sent] = await aiCalls(page, 'ai.chat.send')
  expect((sent.context as { kind: string; text?: string }[])[0]).toMatchObject({ kind: 'selection', text: '第一段' })

  await lastAnswer(page).locator('button[name=insertEnd]').click()
  expect(await markdown(page)).toBe('第一段。\n\n第二段。\n\nAI 的回答\n')
  // 一次插入 = 一步撤销
  await page.keyboard.press(`${mod}+z`)
  expect(await markdown(page)).toBe('第一段。\n\n第二段。\n')

  await lastAnswer(page).locator('button[name=replaceSelection]').click()
  expect(await markdown(page)).toBe('AI 的回答。\n\n第二段。\n')

  await lastAnswer(page).locator('button[name=copy]').click()
  expect(await page.evaluate(() => window.typozaTest!.host.clipboard.text)).toBe('AI 的回答')
})

test('分支:重新生成多版本切换、从这里分支、分支下拉切换', async ({ page }) => {
  await loadDoc(page, '正文\n')
  await openAiPanel(page)
  const panel = page.locator('.tz-ai-panel')
  await queueReply(page, [{ text: '回答一' }], [{ text: '回答一·版本二' }], [{ text: '回答二' }], [{ text: '分支上的回答' }])

  await ask(page, '问题一')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await lastAnswer(page).locator('button[name=regenerate]').click()
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('回答一·版本二')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).locator('.tz-ai-version')).toHaveText('2/2')
  await lastAnswer(page).locator('button[name=prevVersion]').click()
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('回答一')
  await expect(lastAnswer(page).locator('.tz-ai-version')).toHaveText('1/2')

  // 后续对话跟着所选版本走
  await ask(page, '问题二')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('回答二')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(answers(page)).toHaveCount(2)
  const second = (await aiCalls(page, 'ai.chat.send'))[1]
  expect(second.conversationId).toBeTruthy()

  // 从第一条回答分支:路线只到这条,原分支保留
  await answers(page).first().locator('button[name=msgMenu]').click()
  await page.locator('.tz-ai-menu .tz-menu-item[data-id="msg.branch"]').click()
  await expect(answers(page)).toHaveCount(1)
  await ask(page, '另一个问题')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('分支上的回答')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-msg-text')).toHaveText(['问题一', '另一个问题'])

  // 顶栏分支下拉:三条分支,切回「问题二」那条
  await expect(panel.locator('button[name=branches]')).toHaveText('⑂ 3')
  await panel.locator('button[name=branches]').click()
  const items = page.locator('.tz-ai-menu .tz-menu-item')
  await expect(items).toHaveCount(3)
  await items.filter({ hasText: '问题二' }).click()
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-msg-text')).toHaveText(['问题一', '问题二'])
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('回答二')
  const leaves = await aiCalls(page, 'ai.chat.setLeaf')
  expect(leaves.length).toBeGreaterThanOrEqual(3)
})

test('编辑后重发形成新分支', async ({ page }) => {
  await loadDoc(page, '正文\n')
  await openAiPanel(page)
  const panel = page.locator('.tz-ai-panel')
  await queueReply(page, [{ text: '第一版回答' }], [{ text: '改问后的回答' }])
  await ask(page, '原来的问题')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await panel.locator('.tz-ai-msg.is-user button[name=editResend]').click()
  const edit = panel.locator('textarea[name=editText]')
  await expect(edit).toHaveValue('原来的问题')
  await edit.fill('改过的问题')
  await edit.press('Enter')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('改问后的回答')
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-msg-text')).toHaveText('改过的问题')
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-version')).toHaveText('2/2')
  await panel.locator('.tz-ai-msg.is-user button[name=prevVersion]').click()
  await expect(panel.locator('.tz-ai-msg.is-user .tz-ai-msg-text')).toHaveText('原来的问题')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('第一版回答')
})

test('工具卡片:每次询问的允许 / 拒绝 / 总是允许', async ({ page }) => {
  await loadDoc(page, '正文\n')
  await openAiPanel(page)
  const card = () => lastAnswer(page).locator('.tz-ai-tool[data-tool="mcp__demo__search"]')

  // 允许:显示工具名、来源、参数,执行后显示结果
  await queueReply(page, [{ tool: 'mcp__demo__search', input: { query: '季度' }, result: '找到 3 条' }, { text: '根据搜索结果整理好了。' }])
  await ask(page, '搜一下季度资料')
  await expect(card()).toHaveAttribute('data-status', 'pending')
  await expect(card().locator('.tz-ai-tool-name')).toContainText('搜索资料')
  await expect(card().locator('.tz-ai-tool-source')).toHaveText('演示服务器')
  await expect(card().locator('.tz-ai-tool-args pre')).toContainText('"query": "季度"')
  await card().locator('button[name=allowTool]').click()
  await expect(card()).toHaveAttribute('data-status', 'done')
  await expect(card().locator('.tz-ai-tool-result')).toContainText('找到 3 条')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('根据搜索结果整理好了。')

  // 拒绝:模型继续回答
  await queueReply(page, [{ tool: 'mcp__demo__search', input: { query: '别搜' } }, { text: '好的,不搜了。' }])
  await ask(page, '再搜一次')
  await card().locator('button[name=denyTool]').click()
  await expect(card()).toHaveAttribute('data-status', 'denied')
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('好的,不搜了。')

  // 总是允许:之后同一工具不再询问
  await queueReply(page, [{ tool: 'mcp__demo__search', result: '第一次' }, { text: '一' }], [{ tool: 'mcp__demo__search', result: '自动执行' }, { text: '二' }])
  await ask(page, '第三次')
  await card().locator('button[name=alwaysTool]').click()
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  expect(await page.evaluate(() => window.typozaTest!.host.ai.settings.toolPolicies['mcp__demo__search'])).toBe('allow')
  await ask(page, '第四次')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await expect(card()).toHaveAttribute('data-status', 'done')
  await expect(card().locator('button[name=allowTool]')).toHaveCount(0)
  await expect(card().locator('.tz-ai-tool-result')).toContainText('自动执行')
  expect((await aiCalls(page, 'ai.tool.decide')).map((p) => p.decision)).toEqual(['allow', 'deny', 'always'])
})

test('对话列表:新建、切换、改名、删除', async ({ page }) => {
  await loadDoc(page, '正文\n')
  await openAiPanel(page)
  const panel = page.locator('.tz-ai-panel')
  await queueReply(page, [{ text: '甲的回答' }], [{ text: '乙的回答' }])
  await ask(page, '对话甲')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')
  await panel.locator('button[name=newChat]').click()
  await expect(answers(page)).toHaveCount(0)
  await ask(page, '对话乙')
  await expect(lastAnswer(page)).toHaveAttribute('data-status', 'done')

  await panel.locator('button[name=conversations]').click()
  await page.locator('.tz-ai-menu .tz-menu-item', { hasText: '对话甲' }).click()
  await expect(lastAnswer(page).locator('.tz-ai-markdown')).toHaveText('甲的回答')

  await panel.locator('button[name=more]').click()
  await page.locator('.tz-ai-menu .tz-menu-item[data-id="conv.rename"]').click()
  await page.locator('.tz-prompt-input').fill('改名后的对话')
  await page.locator('.tz-prompt-input').press('Enter')
  await expect(panel.locator('button[name=conversations]')).toContainText('改名后的对话')

  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(0))
  await panel.locator('button[name=more]').click()
  await page.locator('.tz-ai-menu .tz-menu-item[data-id="conv.delete"]').click()
  await expect(answers(page)).toHaveCount(0)
  expect(await page.evaluate(() => [...window.typozaTest!.host.ai.conversations.values()].map((c) => c.title))).toEqual(['对话乙'])

  // 关闭侧栏:⌘J 在侧栏里再按一次即关
  await panel.locator('textarea[name=prompt]').focus()
  await page.keyboard.press(`${await modKey(page)}+j`)
  await expect(panel).toBeHidden()
})
