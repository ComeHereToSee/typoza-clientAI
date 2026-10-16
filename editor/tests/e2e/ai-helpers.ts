// AI 版 E2E 的公共步骤:模拟 AI 服务(host/fake-ai.ts)按脚本回答,不连网。
import { expect, type Page } from '@playwright/test'
import type { FakeStep } from '../../src/host/fake-ai'
import { modKey } from './helpers'

/** 给接下来的回答排脚本:每次发送 / 重新生成 / AI 动作取一个 */
export async function queueReply(page: Page, ...scripts: FakeStep[][]): Promise<void> {
  await page.evaluate((list) => {
    for (const s of list) window.typozaTest!.host.ai.scripts.push(s)
  }, scripts)
}

export async function openAiPanel(page: Page): Promise<void> {
  await page.keyboard.press(`${await modKey(page)}+j`)
  await expect(page.locator('.tz-ai-panel')).toBeVisible()
}

/** 在侧栏输入框里提问并回车发送 */
export async function ask(page: Page, text: string): Promise<void> {
  const input = page.locator('.tz-ai-panel textarea[name=prompt]')
  await input.fill(text)
  await input.press('Enter')
}

export const answers = (page: Page) => page.locator('.tz-ai-panel .tz-ai-msg.is-assistant')
export const lastAnswer = (page: Page) => answers(page).last()

/** 模拟服务收到的某个方法的调用参数(按顺序) */
export async function aiCalls(page: Page, method: string): Promise<Record<string, unknown>[]> {
  return page.evaluate((m) => window.typozaTest!.host.ai.calls.filter((c) => c.method === m).map((c) => c.params), method)
}

export async function command(page: Page, id: string): Promise<void> {
  await page.evaluate((cmd) => window.typozaTest!.host.emit('menu.command', { id: cmd }), id)
}

/** 选中正文里第一处 text(先聚焦再设选区,格式条才会出现) */
export async function selectText(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    const v = window.typozaTest!.app.view
    v.focus()
    let from = -1
    v.state.doc.descendants((node, p) => {
      if (from < 0 && node.isText && node.text!.includes(t)) from = p + node.text!.indexOf(t)
      return from < 0
    })
    if (from < 0) throw new Error(`正文里没有「${t}」`)
    const Sel = v.state.selection.constructor as unknown as { create(doc: unknown, anchor: number, head: number): typeof v.state.selection }
    v.dispatch(v.state.tr.setSelection(Sel.create(v.state.doc, from, from + t.length)))
  }, text)
}
