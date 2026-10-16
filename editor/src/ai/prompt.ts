// AI 动作与提示词(PRD 3.4):内置动作在网页里定义,自定义动作来自 AI 设置的 actions;提示词里的占位符由网页替换后再发给 ai.complete。
import type { AiAction, ModelRef } from '../host/ai-types'

export interface ActionDef {
  id: string
  name: string
  /** 可含 {{selection}} {{document}} {{language}} */
  prompt: string
  model?: ModelRef
  /** 内置动作(设置页只读);自定义动作调 ai.complete 时带上 actionId */
  builtin: boolean
  /** 需要选目标语言(翻译) */
  needsLanguage?: boolean
  /** 代码块里也给(PRD 3.4:代码块里只给「解释」「改写」) */
  inCode?: boolean
}

export const BUILTIN_ACTIONS: ActionDef[] = [
  { id: 'builtin.rewrite', name: '改写', builtin: true, inCode: true, prompt: '改写下面的内容,意思不变、表达更清楚,保持原有的 Markdown 格式,只输出改写结果:\n\n{{selection}}' },
  { id: 'builtin.polish', name: '润色', builtin: true, prompt: '润色下面的内容,让语句更通顺自然,保持原意与 Markdown 格式,只输出润色结果:\n\n{{selection}}' },
  { id: 'builtin.shorten', name: '缩短', builtin: true, prompt: '在不丢失要点的前提下把下面的内容缩短到一半左右,只输出结果:\n\n{{selection}}' },
  { id: 'builtin.expand', name: '扩写', builtin: true, prompt: '扩写下面的内容,补充细节与例子,保持原有语气,只输出结果:\n\n{{selection}}' },
  { id: 'builtin.fix', name: '改正错别字与语法', builtin: true, prompt: '改正下面内容里的错别字、标点与语法错误,不改动其余表达,只输出改正后的内容:\n\n{{selection}}' },
  { id: 'builtin.translate', name: '翻译', builtin: true, needsLanguage: true, prompt: '把下面的内容翻译成{{language}},保持 Markdown 格式,只输出译文:\n\n{{selection}}' },
  { id: 'builtin.explain', name: '解释', builtin: true, inCode: true, prompt: '用简洁的中文解释下面的内容:\n\n{{selection}}' },
  { id: 'builtin.summarize', name: '总结', builtin: true, prompt: '用几句话总结下面内容的要点:\n\n{{selection}}' },
  { id: 'builtin.continue', name: '续写', builtin: true, prompt: '参考全文,接着下面这段内容往下写一段,保持风格一致,只输出新写的部分:\n\n{{selection}}\n\n全文:\n{{document}}' },
]

/** 翻译的目标语言 */
export const TRANSLATE_LANGUAGES = ['中文', '英文', '日文', '韩文', '法文', '德文', '西班牙文']

export interface PromptVars {
  selection?: string
  document?: string
  language?: string
}

/** 替换 {{selection}} {{document}} {{language}}(允许花括号里有空格);没给值的占位符换成空串,不认识的占位符原样保留。 */
export function fillPrompt(template: string, vars: PromptVars): string {
  return template.replace(/\{\{\s*(selection|document|language)\s*\}\}/g, (_m, name: keyof PromptVars) => vars[name] ?? '')
}

/** 选中文字可用的动作:内置在前、自定义在后;代码块里只给标了 inCode 的内置动作。 */
export function actionsFor(custom: readonly AiAction[], inCode: boolean): ActionDef[] {
  const builtins = BUILTIN_ACTIONS.filter((a) => !inCode || a.inCode)
  if (inCode) return builtins
  return [...builtins, ...custom.map((a) => ({ id: a.id, name: a.name, prompt: a.prompt, model: a.model, builtin: false }))]
}

/** 自定义动作能否保存:名称与提示词都不能为空(PRD 3.4「提示词为空不能保存」)。返回错误提示,合法时为 null。 */
export function validateAction(action: Pick<AiAction, 'name' | 'prompt'>): string | null {
  if (!action.name.trim()) return '请填写动作名称'
  if (!action.prompt.trim()) return '提示词不能为空'
  return null
}
