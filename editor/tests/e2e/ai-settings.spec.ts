import { expect, test, type Page } from '@playwright/test'
import { openApp } from './helpers'
import { aiCalls, command } from './ai-helpers'

// 偏好设置里的 AI 页签(ai-prd 3.1 服务商与模型、3.4 AI 动作、3.6 MCP、3.8 技能、3.9 助手、四 安全与隐私)。

const SECRET = 'sk-test-SECRET-1234567890'

async function openAiPage(page: Page, title: string): Promise<void> {
  await command(page, 'app.preferences')
  await page.locator(`.tz-settings-tab[data-page="${title}"]`).click()
  await expect(page.locator(`.tz-settings-tab[data-page="${title}"]`)).toHaveClass(/is-active/)
  await expect(page.locator('.tz-settings-content .tz-ai-settings > .tz-settings-fields')).toBeVisible()
}

/** 页面上一切能读到的地方:偏好设置、AI 设置、调用记录、DOM 与输入框的值、本地存储 */
async function readableEverywhere(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const t = window.typozaTest!
    const ai = await t.host.aiCall('ai.settings.get')
    const values = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).map((el) => el.value)
    return JSON.stringify({
      settings: t.host.settings,
      saved: await t.host.getSettings(),
      ai,
      aiCalls: t.host.ai.calls,
      calls: t.host.calls,
      html: document.documentElement.outerHTML,
      values,
      local: { ...localStorage },
      session: { ...sessionStorage },
    })
  })
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('AI 服务商:添加、存密钥(只写不读)、加模型、获取模型、检测连接、删除', async ({ page }) => {
  await openAiPage(page, 'AI 服务商')
  const cards = page.locator('.tz-ai-provider')
  await expect(cards).toHaveCount(1)
  await page.locator('select[name=addProvider]').selectOption({ label: 'DeepSeek' })
  await expect(cards).toHaveCount(2)
  const card = cards.last()
  await expect(card.locator('input[name=providerName]')).toHaveValue('DeepSeek')
  await expect(card.locator('select[name=protocol]')).toHaveValue('openai-chat')
  await expect(card.locator('input[name=baseUrl]')).toHaveValue('https://api.deepseek.com')
  await expect(card).toContainText('未设置')

  // 密钥:保存后输入框清空,只显示「已保存」;任何能读到的地方都没有明文
  await card.locator('input[name=apiKey]').fill(SECRET)
  await card.locator('button[name=saveKey]').click()
  await expect(page.locator('.tz-toast')).toHaveText('密钥已保存到钥匙串')
  await expect(card).toContainText('已保存在钥匙串')
  await expect(card.locator('input[name=apiKey]')).toHaveValue('')
  await expect(card.locator('button[name=deleteKey]')).toBeVisible()
  expect(await readableEverywhere(page)).not.toContain(SECRET)
  const refs = await page.evaluate(() => window.typozaTest!.host.ai.secretRefs())
  expect(refs).toHaveLength(1)
  expect(refs[0]).toMatch(/^provider:[a-z2-7]{20}$/)
  const providers = await page.evaluate(async () => (await window.typozaTest!.host.aiCall<{ providers: { name: string; hasKey: boolean }[] }>('ai.settings.get')).providers)
  expect(providers.map((p) => [p.name, p.hasKey])).toEqual([
    ['模拟服务商', false],
    ['DeepSeek', true],
  ])

  // 改地址立即保存
  await card.locator('input[name=baseUrl]').fill('http://127.0.0.1:15721/v1#')
  await card.locator('input[name=baseUrl]').press('Enter')
  await expect.poll(async () => (await page.evaluate(() => window.typozaTest!.host.ai.settings.providers[1].baseUrl))).toBe('http://127.0.0.1:15721/v1#')

  // 模型:手动添加、获取列表后勾选添加
  await card.locator('input[name=newModel]').fill('deepseek-chat')
  await card.locator('button[name=addModel]').click()
  await expect(card.locator('.tz-ai-model[data-model-id="deepseek-chat"]')).toBeVisible()
  await card.locator('button[name=fetchModels]').click()
  await card.locator('input[name=fetchedModel][value="fake-vision"]').check()
  await card.locator('button[name=addFetched]').click()
  await expect(card.locator('.tz-ai-model')).toHaveCount(2)
  await expect(card.locator('.tz-ai-model[data-model-id="fake-vision"] input[name=modelVision]')).toBeChecked()

  // 检测连接
  await card.locator('button[name=testConnection]').click()
  await expect(card).toContainText('连接成功,用时 42 毫秒')
  expect((await aiCalls(page, 'ai.provider.test')).at(-1)).toMatchObject({ modelId: 'deepseek-chat' })

  // 默认模型可以选到新加的模型
  await page.locator('select[name=defaultModel]').selectOption({ label: 'DeepSeek · deepseek-chat' })
  await expect.poll(async () => page.evaluate(() => window.typozaTest!.host.ai.settings.defaultModel?.modelId)).toBe('deepseek-chat')

  // 删除:确认后服务商与钥匙串里的密钥一起删掉,默认模型清空
  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(0))
  await card.locator('button[name=deleteProvider]').click()
  await expect(cards).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.ai.secretRefs())).toEqual([])
  expect(await page.evaluate(() => window.typozaTest!.host.ai.settings.defaultModel ?? null)).toBeNull()
  expect(await readableEverywhere(page)).not.toContain(SECRET)
})

test('AI 动作:提示词为空不能保存;保存后出现在选中文字的 AI 菜单里', async ({ page }) => {
  await openAiPage(page, 'AI 动作')
  await page.locator('button[name=addAction]').click()
  const action = page.locator('.tz-ai-action-card').last()
  await action.locator('input[name=actionName]').fill('改成口语')
  await action.locator('button[name=saveAction]').click()
  await expect(action.locator('.tz-ai-form-error')).toHaveText('提示词不能为空')
  expect(await page.evaluate(() => window.typozaTest!.host.ai.settings.actions)).toEqual([])
  await action.locator('textarea[name=actionPrompt]').fill('把下面的内容改得更口语化:{{selection}}')
  await action.locator('button[name=saveAction]').click()
  await expect(page.locator('.tz-toast')).toHaveText('已保存动作')
  expect(await page.evaluate(() => window.typozaTest!.host.ai.settings.actions.map((a) => [a.name, a.prompt]))).toEqual([['改成口语', '把下面的内容改得更口语化:{{selection}}']])
  const items = await page.evaluate(() => {
    const view = window.typozaTest!.app.view
    const Sel = view.state.selection.constructor as unknown as { create(doc: unknown, a: number, b: number): typeof view.state.selection }
    view.dispatch(view.state.tr.setSelection(Sel.create(view.state.doc, 1, 3)))
    return window.typozaTest!.app.ai.assist.selectionMenuItems(view).map((i) => i.label)
  })
  expect(items).toContain('改成口语')
})

test('MCP 服务器与连接器:状态、工具权限、JSON 导入', async ({ page }) => {
  await openAiPage(page, 'MCP 服务器')
  const demo = page.locator('.tz-ai-mcp[data-server-id="demo"]')
  await expect(demo.locator('[data-role=state]')).toHaveText('已连接')
  await demo.locator('[data-role=tools] summary').click()
  const policy = demo.locator('select[name=toolPolicy][data-tool="mcp__demo__search"]')
  await expect(policy).toHaveValue('ask')
  await policy.selectOption('deny')
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.ai.settings.toolPolicies['mcp__demo__search'])).toBe('deny')

  await page.locator('input[name=connectorWeb]').check()
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.ai.settings.connectors.web)).toBe(true)

  await page.locator('textarea[name=mcpJson]').fill('{"mcpServers": {"files": {"command": "npx", "args": ["-y", "server-files"]}, "remote": {"url": "https://example.com/mcp"}}}')
  await page.locator('button[name=importMcp]').click()
  await expect(page.locator('.tz-toast')).toHaveText('已导入:files、remote')
  await expect(page.locator('.tz-ai-mcp')).toHaveCount(3)
  // 按导入顺序排在最后的是远程服务器
  await expect(page.locator('.tz-ai-mcp').last().locator('input[name=serverName]')).toHaveValue('remote')
  await expect(page.locator('.tz-ai-mcp').last().locator('select[name=transport]')).toHaveValue('http')

  await page.locator('textarea[name=mcpJson]').fill('{坏的')
  await page.locator('button[name=importMcp]').click()
  await expect(page.locator('.tz-toast')).toContainText('导入失败')
})

test('技能:列表、不合规的提示原因、安装与删除、开关', async ({ page }) => {
  await openAiPage(page, '技能')
  await expect(page.locator('.tz-ai-skill-row')).toHaveCount(2)
  await expect(page.locator('.tz-ai-skill-row[data-skill="Bad_Name"]')).toContainText('没有加载')
  await page.evaluate(() => window.typozaTest!.host.dialogQueue.push(['/Users/test/Downloads/with-scripts']))
  await page.locator('button[name=installFolder]').click()
  await expect(page.locator('.tz-toast')).toContainText('此技能包含脚本,Typoza 不会执行')
  await expect(page.locator('.tz-ai-skill-row')).toHaveCount(3)
  await page.locator('.tz-ai-skill-row[data-skill="meeting-notes"] input[name=skillEnabled]').uncheck()
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.ai.settings.disabledSkills)).toEqual(['meeting-notes'])
  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(0))
  await page.locator('.tz-ai-skill-row[data-skill="with-scripts"] button[name=removeSkill]').click()
  await expect(page.locator('.tz-ai-skill-row')).toHaveCount(2)
})

test('助手:添加、改名、设为默认;清除全部对话', async ({ page }) => {
  await openAiPage(page, 'AI 助手')
  await expect(page.locator('.tz-ai-assistant-card')).toHaveCount(3)
  await page.locator('button[name=addAssistant]').click()
  await expect(page.locator('.tz-ai-assistant-card')).toHaveCount(4)
  const added = page.locator('.tz-ai-assistant-card').last()
  await added.locator('input[name=assistantName]').fill('周报助手')
  await added.locator('input[name=assistantName]').press('Enter')
  await expect.poll(() => page.evaluate(() => window.typozaTest!.host.ai.settings.assistants.map((a) => a.name))).toContain('周报助手')
  await page.locator('.tz-ai-assistant-card').last().locator('input[name=defaultAssistant]').check()
  await expect.poll(() => page.evaluate(() => { const s = window.typozaTest!.host.ai.settings; return s.assistants.find((a) => a.id === s.defaultAssistantId)?.name })).toBe('周报助手')

  await page.locator('.tz-settings-tab[data-page="AI 服务商"]').click()
  await page.evaluate(() => window.typozaTest!.host.confirmQueue.push(0))
  await page.locator('button[name=clearConversations]').click()
  await expect(page.locator('.tz-toast')).toHaveText('已清除全部对话')
  expect(await aiCalls(page, 'ai.conversations.clear')).toHaveLength(1)
})
