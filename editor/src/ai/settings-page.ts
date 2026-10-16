// 偏好设置里的 AI 页签(PRD 3.1 服务商与模型、3.4 AI 动作、3.6 MCP 与连接器、3.8 技能、3.9 助手):
// 「AI 服务商」「AI 助手」「AI 动作」「MCP 服务器」「技能」。设置存在辅助进程(ai.settings.update 整体替换给出的字段);
// 密钥只写不读:输入框保存时调 ai.secret.set(外壳写钥匙串),页面上只显示有没有密钥。
import type { AiAction, AiSettings, Assistant, McpServer, McpStatus, ModelInfo, Provider, Skill, ToolInfo, ToolPolicy } from '../host/ai-types'
import { h } from '../ui/dom'
import { type AiController, errorText } from './controller'
import { mcpSecretRef, modelOptions, newId, parseRefKey, PROTOCOL_LABELS, PROVIDER_PRESETS, providerFromPreset, providerSecretRef, refKey } from './models'
import { BUILTIN_ACTIONS, validateAction } from './prompt'

interface PageCtx {
  ai: AiController
  settings: AiSettings
  rerender(): void
  /** 保存设置;失败时提示并按原设置重画,返回 false */
  save(patch: Partial<AiSettings>): Promise<boolean>
}

type Option = { value: string; label: string }

const POLICY_OPTIONS: Option[] = [
  { value: 'allow', label: '总是允许' },
  { value: 'ask', label: '每次询问' },
  { value: 'deny', label: '禁用' },
]

const MCP_STATE: Record<McpStatus['state'], string> = { connected: '已连接', connecting: '连接中', failed: '失败', disabled: '已停用' }

/** 改文档的内置工具始终需要确认(docs/tech/ai-architecture.md 第 4 节) */
const ALWAYS_ASK_TOOLS = new Set(['typoza__edit_document'])

// ---------- 小部件 ----------

function field(label: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'tz-field' }, h('span', { class: 'tz-field-label' }, label), control, hint ? h('span', { class: 'tz-field-hint' }, hint) : null)
}

function heading(text: string): HTMLElement {
  return h('h3', { class: 'tz-pref-heading' }, text)
}

function textInput(name: string, value: string, onChange: (v: string) => void, placeholder = '', type = 'text'): HTMLInputElement {
  const input = h('input', { type, name, placeholder, spellcheck: 'false', autocomplete: 'off' })
  input.value = value
  input.addEventListener('change', () => onChange(input.value))
  return input
}

function checkbox(name: string, checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox', name })
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  return input
}

function selectBox(name: string, options: Option[], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const select = h('select', { name }, ...options.map((o) => h('option', { value: o.value }, o.label)))
  select.value = value
  select.addEventListener('change', () => onChange(select.value))
  return select
}

function button(name: string, label: string, run: () => unknown, cls = ''): HTMLButtonElement {
  const b = h('button', { type: 'button', name, class: `tz-pref-btn ${cls}` }, label)
  b.addEventListener('click', () => {
    b.disabled = true
    Promise.resolve(run()).finally(() => {
      if (b.isConnected) b.disabled = false
    })
  })
  return b
}

function labeled(text: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'tz-ai-inline-label' }, control, text)
}

function numberOrUndefined(v: string): number | undefined {
  if (v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 页面骨架:先读设置(及本页要的其它数据),读完再画;读失败就地显示原因 */
function page(ai: AiController, render: (ctx: PageCtx) => HTMLElement, load?: (ctx: PageCtx) => Promise<void>): HTMLElement {
  const root = h('div', { class: 'tz-ai-settings tz-settings-fields' }, h('div', { class: 'tz-field-hint' }, '正在读取 AI 设置…'))
  void (async () => {
    const settings = await ai.refreshSettings()
    if (!settings) {
      root.replaceChildren(h('div', { class: 'tz-ai-notice', role: 'alert' }, `AI 组件不可用:${ai.settingsError ?? '未知原因'}`))
      return
    }
    const ctx: PageCtx = {
      ai,
      settings,
      rerender: () => root.replaceChildren(render(ctx)),
      save: async (patch) => {
        try {
          ctx.settings = await ai.updateSettings(patch)
          return true
        } catch (err) {
          ai.deps.toast(`保存 AI 设置失败:${errorText(err)}`, true)
          ctx.rerender()
          return false
        }
      },
    }
    try {
      await load?.(ctx)
    } catch (err) {
      ai.deps.toast(errorText(err), true)
    }
    ctx.rerender()
  })()
  return root
}

// ---------- AI 服务商 ----------

function providersPage(ai: AiController): HTMLElement {
  /** 「获取模型列表」拿到、还没加进去的模型,按服务商 */
  const fetched = new Map<string, ModelInfo[]>()
  /** 检测连接的结果,按服务商 */
  const tested = new Map<string, { ok: boolean; text: string }>()

  const render = (ctx: PageCtx): HTMLElement => {
    const s = ctx.settings
    const saveProvider = (id: string, change: Partial<Provider>) => ctx.save({ providers: ctx.settings.providers.map((p) => (p.id === id ? { ...p, ...change } : p)) }).then(() => ctx.rerender())

    const card = (p: Provider): HTMLElement => {
      const keyInput = textInput('apiKey', '', () => {}, p.hasKey ? '已保存在钥匙串;输入新密钥可替换' : '未设置(本机服务商可不填)', 'password')
      const saveKey = button('saveKey', '保存密钥', async () => {
        const value = keyInput.value.trim()
        if (!value) {
          ai.deps.toast('请先输入密钥', true)
          return
        }
        try {
          await ai.call('ai.secret.set', { ref: providerSecretRef(p.id), value })
          keyInput.value = ''
          ai.deps.toast('密钥已保存到钥匙串')
        } catch (err) {
          ai.deps.toast(`保存密钥失败:${errorText(err)}`, true)
        }
        const next = await ai.refreshSettings()
        if (next) ctx.settings = next
        ctx.rerender()
      })
      const deleteKey = button('deleteKey', '删除密钥', async () => {
        try {
          await ai.call('ai.secret.set', { ref: providerSecretRef(p.id), value: '' })
        } catch (err) {
          ai.deps.toast(`删除密钥失败:${errorText(err)}`, true)
        }
        const next = await ai.refreshSettings()
        if (next) ctx.settings = next
        ctx.rerender()
      })
      deleteKey.hidden = !p.hasKey

      const models = h(
        'div',
        { class: 'tz-ai-models' },
        ...p.models.map((m) =>
          h(
            'span',
            { class: 'tz-ai-model', 'data-model-id': m.id },
            h('strong', null, m.name || m.id),
            labeled('工具', checkbox('modelTools', Boolean(m.tools), (v) => void saveProvider(p.id, { models: p.models.map((x) => (x.id === m.id ? { ...x, tools: v } : x)) }))),
            labeled('看图', checkbox('modelVision', Boolean(m.vision), (v) => void saveProvider(p.id, { models: p.models.map((x) => (x.id === m.id ? { ...x, vision: v } : x)) }))),
            button('removeModel', '×', () => saveProvider(p.id, { models: p.models.filter((x) => x.id !== m.id) }), 'tz-ai-mini'),
          ),
        ),
      )
      const newModel = textInput('newModel', '', () => {}, '手动添加模型 ID')
      const addModel = button('addModel', '添加', () => {
        const id = newModel.value.trim()
        if (!id) return
        if (p.models.some((m) => m.id === id)) {
          ai.deps.toast(`已有模型 ${id}`, true)
          return
        }
        return saveProvider(p.id, { models: [...p.models, { id }] })
      })
      const fetchModels = button('fetchModels', '获取模型列表', async () => {
        try {
          const r = await ai.call<{ models: ModelInfo[] }>('ai.provider.models', { providerId: p.id })
          fetched.set(
            p.id,
            r.models.filter((m) => !p.models.some((x) => x.id === m.id)),
          )
          if (!r.models.length) ai.deps.toast('服务商没有返回模型,请手动添加', true)
        } catch (err) {
          ai.deps.toast(`获取模型列表失败:${errorText(err)}(服务商没有列表接口时请手动添加模型 ID)`, true)
        }
        ctx.rerender()
      })
      const pending = fetched.get(p.id) ?? []
      let picker: HTMLElement | null = null
      if (pending.length) {
        const boxes = pending.map((m) => ({ m, box: h('input', { type: 'checkbox', name: 'fetchedModel', value: m.id }) }))
        picker = h(
          'div',
          { class: 'tz-ai-fetched' },
          ...boxes.map(({ m, box }) => labeled(m.name && m.name !== m.id ? `${m.name}(${m.id})` : m.id, box)),
          button('addFetched', '添加所选', () => {
            const chosen = boxes.filter((b) => b.box.checked).map((b) => b.m)
            fetched.delete(p.id)
            return saveProvider(p.id, { models: [...p.models, ...chosen] })
          }),
        )
      }
      const testModel = selectBox('testModel', p.models.map((m) => ({ value: m.id, label: m.name || m.id })), p.models[0]?.id ?? '', () => {})
      const result = tested.get(p.id)
      const test = button('testConnection', '检测连接', async () => {
        if (!testModel.value) {
          ai.deps.toast('先添加一个模型再检测', true)
          return
        }
        try {
          const r = await ai.call<{ ok: boolean; latencyMs: number }>('ai.provider.test', { providerId: p.id, modelId: testModel.value })
          tested.set(p.id, { ok: true, text: `连接成功,用时 ${r.latencyMs} 毫秒` })
        } catch (err) {
          tested.set(p.id, { ok: false, text: errorText(err) })
        }
        ctx.rerender()
      })
      const remove = button(
        'deleteProvider',
        '删除',
        async () => {
          const choice = await ai.deps.host.confirm({ title: `删除服务商「${p.name}」?`, message: '它的密钥会一并从钥匙串删除;用它的助手改用默认模型。', buttons: ['删除', '取消'], style: 'warning' })
          if (choice !== 0) return
          const uses = (ref: AiSettings['defaultModel']) => ref?.providerId === p.id
          const assistants = ctx.settings.assistants.map((a) => (uses(a.model) ? { ...a, model: undefined } : a))
          const affected = ctx.settings.assistants.some((a) => uses(a.model))
          const patch = {
            providers: ctx.settings.providers.filter((x) => x.id !== p.id),
            assistants,
            actions: ctx.settings.actions.map((a) => (uses(a.model) ? { ...a, model: undefined } : a)),
            // 默认模型指向它时清空(null 表示去掉该项)
            ...(uses(ctx.settings.defaultModel) ? { defaultModel: null } : {}),
            ...(uses(ctx.settings.fastModel) ? { fastModel: null } : {}),
          } as unknown as Partial<AiSettings>
          if (!(await ctx.save(patch))) return
          if (p.hasKey) await ai.call('ai.secret.set', { ref: providerSecretRef(p.id), value: '' }).catch((err: unknown) => ai.deps.toast(`删除密钥失败:${errorText(err)}`, true))
          ai.deps.toast(affected ? `已删除「${p.name}」;用到它的助手改用默认模型` : `已删除「${p.name}」`)
          ctx.rerender()
        },
        'is-danger',
      )

      return h(
        'div',
        { class: 'tz-ai-card-set tz-ai-provider', 'data-provider-id': p.id },
        h(
          'div',
          { class: 'tz-ai-card-set-head' },
          textInput('providerName', p.name, (v) => void saveProvider(p.id, { name: v.trim() || p.name }), '名称'),
          labeled('启用', checkbox('providerEnabled', p.enabled, (v) => void saveProvider(p.id, { enabled: v }))),
          remove,
        ),
        field(
          '接口协议',
          selectBox('protocol', Object.entries(PROTOCOL_LABELS).map(([value, label]) => ({ value, label })), p.protocol, (v) => void saveProvider(p.id, { protocol: v as Provider['protocol'] })),
        ),
        field('API 地址', textInput('baseUrl', p.baseUrl, (v) => void saveProvider(p.id, { baseUrl: v.trim() }), 'https://…'), '一般只填根地址;末尾写 # 表示原样使用、不自动拼接口路径'),
        field(
          '密钥',
          h('span', { class: 'tz-pref-path' }, keyInput, saveKey, deleteKey),
          `${p.hasKey ? '已保存在钥匙串' : '未设置'}。多个密钥用英文逗号分隔;密钥只存在 macOS 钥匙串,这里读不到原文`,
        ),
        field('模型', h('div', { class: 'tz-ai-models-box' }, models, h('span', { class: 'tz-pref-path' }, newModel, addModel, fetchModels), picker ?? '')),
        field('检测连接', h('span', { class: 'tz-pref-path' }, testModel, test), result?.text),
      )
    }

    const addPreset = selectBox('addProvider', [{ value: '', label: '添加服务商…' }, ...PROVIDER_PRESETS.map((p, i) => ({ value: String(i), label: p.name }))], '', (v) => {
      const preset = PROVIDER_PRESETS[Number(v)]
      if (!preset) return
      void ctx.save({ providers: [...ctx.settings.providers, providerFromPreset(preset)] }).then(() => ctx.rerender())
    })
    const options = [{ value: '', label: '未设置' }, ...modelOptions(s)]
    const clearAll = button(
      'clearConversations',
      '清除全部对话…',
      async () => {
        const choice = await ai.deps.host.confirm({ title: '清除全部 AI 对话?', message: '本机保存的所有 AI 对话都会删除,不能恢复。', buttons: ['清除', '取消'], style: 'critical' })
        if (choice !== 0) return
        try {
          await ai.call('ai.conversations.clear')
          ai.store.clear()
          ai.store.summaries = []
          ai.panel.onSettingsChanged()
          ai.deps.toast('已清除全部对话')
        } catch (err) {
          ai.deps.toast(`清除失败:${errorText(err)}`, true)
        }
      },
      'is-danger',
    )
    return h(
      'div',
      { class: 'tz-settings-fields' },
      heading('服务商'),
      ...s.providers.map(card),
      s.providers.length ? '' : h('div', { class: 'tz-field-hint' }, '还没有服务商。添加后填地址与密钥,再获取模型。'),
      addPreset,
      heading('默认模型'),
      field('默认模型', selectBox('defaultModel', options, refKey(s.defaultModel), (v) => void ctx.save({ defaultModel: parseRefKey(v) ?? null } as unknown as Partial<AiSettings>)), '用于对话与 AI 动作'),
      field(
        '快速模型',
        selectBox('fastModel', [{ value: '', label: '同默认模型' }, ...modelOptions(s)], refKey(s.fastModel), (v) => void ctx.save({ fastModel: parseRefKey(v) ?? null } as unknown as Partial<AiSettings>)),
        '用于起对话标题、生成摘要这类轻任务',
      ),
      heading('其它'),
      field('空行按空格唤起 AI', checkbox('spaceTriggersAi', s.spaceTriggersAi, (v) => void ctx.save({ spaceTriggersAi: v })), '关掉后空格照常输入;斜杠菜单「AI 写作」仍可用'),
      field('对话记录', clearAll, '对话只存本机,不进云同步'),
    )
  }
  return page(ai, render)
}

// ---------- AI 助手 ----------

function assistantsPage(ai: AiController): HTMLElement {
  let skills: Skill[] = []
  const render = (ctx: PageCtx): HTMLElement => {
    const s = ctx.settings
    const saveAssistant = (id: string, next: Assistant) => ctx.save({ assistants: ctx.settings.assistants.map((a) => (a.id === id ? next : a)) }).then(() => ctx.rerender())
    const card = (a: Assistant): HTMLElement => {
      const update = (change: Partial<Assistant>) => {
        const next: Assistant = { ...a, ...change }
        // 留空的参数不发(跟随模型默认值)
        for (const k of ['temperature', 'topP', 'maxTokens'] as const) if (next[k] === undefined) delete next[k]
        if (!next.model) delete next.model
        return saveAssistant(a.id, next)
      }
      const toggleIn = (list: string[], item: string, on: boolean) => (on ? [...new Set([...list, item])] : list.filter((x) => x !== item))
      const remove = button(
        'deleteAssistant',
        '删除',
        async () => {
          if (ctx.settings.assistants.length <= 1) {
            ai.deps.toast('至少保留一个助手', true)
            return
          }
          const choice = await ai.deps.host.confirm({ title: `删除助手「${a.name}」?`, message: '用它的对话会保留,改用默认助手。', buttons: ['删除', '取消'], style: 'warning' })
          if (choice !== 0) return
          const rest = ctx.settings.assistants.filter((x) => x.id !== a.id)
          const defaultAssistantId = ctx.settings.defaultAssistantId === a.id ? rest[0].id : ctx.settings.defaultAssistantId
          if (await ctx.save({ assistants: rest, defaultAssistantId })) ctx.rerender()
        },
        'is-danger',
      )
      const isDefault = h('input', { type: 'radio', name: 'defaultAssistant', value: a.id })
      isDefault.checked = s.defaultAssistantId === a.id
      isDefault.addEventListener('change', () => void ctx.save({ defaultAssistantId: a.id }).then(() => ctx.rerender()))
      const num = (name: string, key: 'temperature' | 'topP' | 'maxTokens', placeholder: string) =>
        textInput(name, a[key] === undefined ? '' : String(a[key]), (v) => void update({ [key]: numberOrUndefined(v) } as Partial<Assistant>), placeholder, 'number')
      return h(
        'div',
        { class: 'tz-ai-card-set tz-ai-assistant-card', 'data-assistant-id': a.id },
        h(
          'div',
          { class: 'tz-ai-card-set-head' },
          textInput('assistantIcon', a.icon ?? '', (v) => void update({ icon: v.trim() || undefined }), '图标'),
          textInput('assistantName', a.name, (v) => void update({ name: v.trim() || a.name }), '名称'),
          labeled('默认', isDefault),
          remove,
        ),
        field('系统提示词', (() => {
          const area = h('textarea', { name: 'systemPrompt', rows: 4, spellcheck: 'false' })
          area.value = a.systemPrompt
          area.addEventListener('change', () => void update({ systemPrompt: area.value }))
          return area
        })()),
        field('模型', selectBox('assistantModel', [{ value: '', label: '跟随默认模型' }, ...modelOptions(s)], refKey(a.model), (v) => void update({ model: parseRefKey(v) }))),
        field('温度', num('temperature', 'temperature', '留空跟随模型默认')),
        field('Top P', num('topP', 'topP', '留空跟随模型默认')),
        field('最大输出长度', num('maxTokens', 'maxTokens', '留空跟随模型默认')),
        field(
          '技能',
          skills.length
            ? h('div', { class: 'tz-ai-checks' }, ...skills.filter((k) => !k.error).map((k) => labeled(k.name, checkbox('assistantSkill', a.skills.includes(k.name), (v) => void update({ skills: toggleIn(a.skills, k.name, v) })))))
            : h('span', { class: 'tz-field-hint' }, '还没有技能'),
        ),
        field(
          'MCP 服务器',
          s.mcpServers.length
            ? h('div', { class: 'tz-ai-checks' }, ...s.mcpServers.map((m) => labeled(m.name, checkbox('assistantMcp', a.mcpServers.includes(m.id), (v) => void update({ mcpServers: toggleIn(a.mcpServers, m.id, v) })))))
            : h('span', { class: 'tz-field-hint' }, '还没有 MCP 服务器'),
        ),
      )
    }
    const add = button('addAssistant', '添加助手', async () => {
      if (await ctx.save({ assistants: [...ctx.settings.assistants, { id: newId(), name: '新助手', systemPrompt: '', skills: [], mcpServers: [] }] })) ctx.rerender()
    })
    return h('div', { class: 'tz-settings-fields' }, h('div', { class: 'tz-field-hint' }, '助手 = 系统提示词 + 模型与参数 + 选用的技能与 MCP 服务器。侧栏底部选择助手,新对话用所选助手。'), ...s.assistants.map(card), add)
  }
  return page(ai, render, async (ctx) => {
    skills = (await ctx.ai.call<{ skills: Skill[] }>('ai.skills.list')).skills
  })
}

// ---------- AI 动作 ----------

function actionsPage(ai: AiController): HTMLElement {
  /** 新加、还没保存的动作 */
  let draft: AiAction | null = null
  const render = (ctx: PageCtx): HTMLElement => {
    const s = ctx.settings
    const list = draft ? [...s.actions, draft] : s.actions
    const card = (a: AiAction, index: number): HTMLElement => {
      const isDraft = a === draft
      const name = textInput('actionName', a.name, () => {}, '名称,如「改成口语」')
      const prompt = h('textarea', { name: 'actionPrompt', rows: 4, spellcheck: 'false', placeholder: '提示词,如:把下面的内容改得更口语化:{{selection}}' })
      prompt.value = a.prompt
      const model = selectBox('actionModel', [{ value: '', label: '默认模型' }, ...modelOptions(s)], refKey(a.model), () => {})
      const error = h('div', { class: 'tz-ai-form-error', role: 'alert', hidden: true })
      const save = button('saveAction', '保存', async () => {
        const next: AiAction = { id: a.id, name: name.value.trim(), prompt: prompt.value }
        const ref = parseRefKey(model.value)
        if (ref) next.model = ref
        const problem = validateAction(next)
        if (problem) {
          error.textContent = problem
          error.hidden = false
          return
        }
        const actions = isDraft ? [...ctx.settings.actions, next] : ctx.settings.actions.map((x) => (x.id === a.id ? next : x))
        if (await ctx.save({ actions })) {
          if (isDraft) draft = null
          ai.deps.toast('已保存动作')
          ctx.rerender()
        }
      })
      const move = (delta: number) => async () => {
        const actions = [...ctx.settings.actions]
        const j = index + delta
        if (isDraft || j < 0 || j >= actions.length) return
        ;[actions[index], actions[j]] = [actions[j], actions[index]]
        if (await ctx.save({ actions })) ctx.rerender()
      }
      const remove = button(
        'deleteAction',
        '删除',
        async () => {
          if (isDraft) {
            draft = null
            ctx.rerender()
            return
          }
          if (await ctx.save({ actions: ctx.settings.actions.filter((x) => x.id !== a.id) })) ctx.rerender()
        },
        'is-danger',
      )
      return h(
        'div',
        { class: 'tz-ai-card-set tz-ai-action-card', 'data-action-id': a.id },
        h('div', { class: 'tz-ai-card-set-head' }, name, isDraft ? '' : button('moveUp', '↑', move(-1), 'tz-ai-mini'), isDraft ? '' : button('moveDown', '↓', move(1), 'tz-ai-mini'), remove),
        field('提示词', prompt, '可用 {{selection}}(选中的文字)、{{document}}(全文)、{{language}}(翻译目标语言)'),
        field('模型', model),
        error,
        h('div', null, save),
      )
    }
    return h(
      'div',
      { class: 'tz-settings-fields' },
      heading('内置动作'),
      h('div', { class: 'tz-ai-checks' }, ...BUILTIN_ACTIONS.map((b) => h('span', { class: 'tz-ai-chip is-static' }, b.name))),
      heading('自定义动作'),
      ...list.map(card),
      list.length ? '' : h('div', { class: 'tz-field-hint' }, '还没有自定义动作。选中文字后的「AI」菜单里会列出这里的动作。'),
      button('addAction', '添加动作', () => {
        draft ??= { id: newId(), name: '', prompt: '' }
        ctx.rerender()
      }),
    )
  }
  return page(ai, render)
}

// ---------- MCP 服务器与连接器 ----------

function kvEditor(ai: AiController, server: McpServer, key: 'env' | 'headers', save: (next: Record<string, string>) => Promise<unknown>): HTMLElement {
  const entries: [string, string][] = Object.entries(server[key] ?? {})
  const box = h('div', { class: 'tz-ai-kv', 'data-kv': key })
  const write = (rows: [string, string][]) => save(Object.fromEntries(rows.filter(([k]) => k.trim())))
  entries.forEach(([name, value], i) => {
    const inKeychain = value === ''
    const nameInput = textInput('kvName', name, (v) => void write(entries.map((e, j): [string, string] => (j === i ? [v.trim(), e[1]] : e))), key === 'env' ? '变量名' : '请求头')
    const valueInput = textInput('kvValue', inKeychain ? '' : value, () => {}, inKeychain ? '(在钥匙串)' : '值', inKeychain ? 'password' : 'text')
    const secret = checkbox('kvSecret', inKeychain, () => {})
    const commit = async () => {
      if (secret.checked) {
        // 密钥存钥匙串,配置里只留空串(docs/tech/ai-architecture.md 3.2 McpServer)
        if (valueInput.value) {
          try {
            await ai.call('ai.secret.set', { ref: mcpSecretRef(server.id, name), value: valueInput.value })
          } catch (err) {
            ai.deps.toast(`保存到钥匙串失败:${errorText(err)}`, true)
            return
          }
        }
        await write(entries.map((e, j): [string, string] => (j === i ? [e[0], ''] : e)))
      } else {
        await write(entries.map((e, j): [string, string] => (j === i ? [e[0], valueInput.value] : e)))
      }
    }
    valueInput.addEventListener('change', () => void commit())
    secret.addEventListener('change', () => void commit())
    const remove = button('kvRemove', '×', () => write(entries.filter((_e, j) => j !== i)), 'tz-ai-mini')
    box.append(h('div', { class: 'tz-ai-kv-row' }, nameInput, valueInput, labeled('存钥匙串', secret), remove))
  })
  box.append(button('kvAdd', key === 'env' ? '添加环境变量' : '添加请求头', () => write([...entries, [`NEW_${entries.length + 1}`, ''] as [string, string]])))
  return box
}

function mcpPage(ai: AiController): HTMLElement {
  let statuses = new Map<string, McpStatus>()
  let builtins: ToolInfo[] = []
  let unsubscribe: (() => void) | null = null
  const render = (ctx: PageCtx): HTMLElement => {
    const s = ctx.settings
    const saveServer = (id: string, change: Partial<McpServer>) => ctx.save({ mcpServers: ctx.settings.mcpServers.map((m) => (m.id === id ? { ...m, ...change } : m)) }).then(() => ctx.rerender())
    const policySelect = (tool: string) => {
      const select = selectBox('toolPolicy', POLICY_OPTIONS, ALWAYS_ASK_TOOLS.has(tool) ? 'ask' : (s.toolPolicies[tool] ?? 'ask'), (v) => {
        void ctx.save({ toolPolicies: { ...ctx.settings.toolPolicies, [tool]: v as ToolPolicy } })
      })
      select.dataset.tool = tool
      select.disabled = ALWAYS_ASK_TOOLS.has(tool)
      return select
    }
    const toolRow = (t: ToolInfo) => h('div', { class: 'tz-ai-tool-row' }, h('span', { class: 'tz-ai-tool-row-name', title: t.description }, t.title || t.name), h('code', null, t.name), policySelect(t.name))

    const card = (m: McpServer): HTMLElement => {
      const st = statuses.get(m.id)
      const state = st?.state ?? (m.enabled ? 'connecting' : 'disabled')
      const restart = button('restartMcp', '重启', async () => {
        try {
          statuses.set(m.id, await ai.call<McpStatus>('ai.mcp.restart', { serverId: m.id }))
        } catch (err) {
          ai.deps.toast(`重启失败:${errorText(err)}`, true)
        }
        ctx.rerender()
      })
      const remove = button(
        'deleteMcp',
        '删除',
        async () => {
          const choice = await ai.deps.host.confirm({ title: `删除 MCP 服务器「${m.name}」?`, message: '', buttons: ['删除', '取消'], style: 'warning' })
          if (choice !== 0) return
          const prefix = `mcp__${m.id}__`
          const toolPolicies = Object.fromEntries(Object.entries(ctx.settings.toolPolicies).filter(([k]) => !k.startsWith(prefix)))
          const assistants = ctx.settings.assistants.map((a) => ({ ...a, mcpServers: a.mcpServers.filter((x) => x !== m.id) }))
          if (await ctx.save({ mcpServers: ctx.settings.mcpServers.filter((x) => x.id !== m.id), toolPolicies, assistants })) ctx.rerender()
        },
        'is-danger',
      )
      const transport = selectBox(
        'transport',
        [
          { value: 'stdio', label: '本机命令(stdio)' },
          { value: 'http', label: 'Streamable HTTP' },
        ],
        m.transport,
        (v) => void saveServer(m.id, { transport: v as McpServer['transport'] }),
      )
      const body: (HTMLElement | string)[] = [field('传输方式', transport)]
      if (m.transport === 'stdio') {
        body.push(
          field('命令', textInput('command', m.command ?? '', (v) => void saveServer(m.id, { command: v.trim() }), 'npx'), '将以你的权限在本机运行此命令'),
          field('参数', textInput('args', (m.args ?? []).join(' '), (v) => void saveServer(m.id, { args: v.split(/\s+/).filter(Boolean) }), '-y @modelcontextprotocol/server-filesystem ~/Documents'), '用空格分隔'),
          field('环境变量', kvEditor(ai, m, 'env', (env) => saveServer(m.id, { env }))),
        )
      } else {
        body.push(
          field('地址', textInput('url', m.url ?? '', (v) => void saveServer(m.id, { url: v.trim() }), 'https://example.com/mcp')),
          field('请求头', kvEditor(ai, m, 'headers', (headers) => saveServer(m.id, { headers }))),
        )
      }
      if (st?.error) body.push(h('div', { class: 'tz-ai-form-error' }, st.error))
      if (st) {
        body.push(
          h('details', { class: 'tz-ai-mcp-detail', 'data-role': 'tools' }, h('summary', null, `工具(${st.tools.length})`), ...st.tools.map(toolRow)),
          h('details', { class: 'tz-ai-mcp-detail' }, h('summary', null, `提示词(${st.prompts.length})`), ...st.prompts.map((p) => h('div', { class: 'tz-ai-tool-row' }, h('code', null, p.name), h('span', null, p.description ?? '')))),
          h('details', { class: 'tz-ai-mcp-detail' }, h('summary', null, `资源(${st.resources.length})`), ...st.resources.map((r) => h('div', { class: 'tz-ai-tool-row' }, h('span', null, r.name), h('code', null, r.uri)))),
          h('details', { class: 'tz-ai-mcp-detail', 'data-role': 'log', open: st.state === 'failed' }, h('summary', null, '最近日志'), h('pre', { class: 'tz-ai-log' }, st.log.slice(-200).join('\n') || '(没有日志)')),
        )
      }
      return h(
        'div',
        { class: 'tz-ai-card-set tz-ai-mcp', 'data-server-id': m.id, 'data-state': state },
        h(
          'div',
          { class: 'tz-ai-card-set-head' },
          textInput('serverName', m.name, (v) => void saveServer(m.id, { name: v.trim() || m.name }), '名称'),
          h('span', { class: `tz-ai-badge is-${state}`, 'data-role': 'state' }, MCP_STATE[state]),
          labeled('启用', checkbox('serverEnabled', m.enabled, (v) => void saveServer(m.id, { enabled: v }))),
          restart,
          remove,
        ),
        ...body,
      )
    }

    const addServer = selectBox(
      'addMcp',
      [
        { value: '', label: '添加 MCP 服务器…' },
        { value: 'stdio', label: '本机命令(stdio)' },
        { value: 'http', label: 'Streamable HTTP' },
      ],
      '',
      (v) => {
        if (!v) return
        const server: McpServer = { id: newId(), name: v === 'stdio' ? '新的本机服务器' : '新的远程服务器', enabled: false, transport: v as McpServer['transport'], ...(v === 'stdio' ? { command: '', args: [], env: {} } : { url: '', headers: {} }) }
        if (v === 'stdio') ai.deps.toast('本机命令类 MCP 服务器将以你的权限在本机运行,填好命令后再启用')
        void ctx.save({ mcpServers: [...ctx.settings.mcpServers, server] }).then(() => ctx.rerender())
      },
    )
    const json = h('textarea', { name: 'mcpJson', rows: 5, spellcheck: 'false', placeholder: '{"mcpServers": {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]}}}' })
    const importJson = button('importMcp', '导入', async () => {
      try {
        const r = await ai.call<{ added: string[] }>('ai.mcp.import', { json: json.value })
        const next = await ai.refreshSettings()
        if (next) ctx.settings = next
        // added 是新服务器的 ID;像密钥的环境变量 / 请求头导入时值被置空,要用户重填(ai-architecture 3.6 第 9 条)
        const added = ctx.settings.mcpServers.filter((m) => r.added.includes(m.id))
        const blanks = added.flatMap((m) =>
          Object.entries({ ...m.env, ...m.headers })
            .filter(([, v]) => v === '')
            .map(([k]) => `${m.name} 的 ${k}`),
        )
        ai.deps.toast(
          added.length
            ? `已导入:${added.map((m) => m.name).join('、')}${blanks.length ? `。${blanks.join('、')} 像是密钥,没有导入值,请在下方重新填写` : ''}`
            : '没有可导入的服务器',
        )
        statuses = new Map((await ai.call<{ servers: McpStatus[] }>('ai.mcp.status')).servers.map((x): [string, McpStatus] => [x.serverId, x]))
        ctx.rerender()
      } catch (err) {
        ai.deps.toast(`导入失败:${errorText(err)}`, true)
      }
    })
    return h(
      'div',
      { class: 'tz-settings-fields' },
      heading('连接器'),
      field('当前文件夹', checkbox('connectorFolder', s.connectors.folder, (v) => void ctx.save({ connectors: { ...ctx.settings.connectors, folder: v } })), '列出、搜索、读取当前文件夹里的文档;写入需确认'),
      field('网页读取', checkbox('connectorWeb', s.connectors.web, (v) => void ctx.save({ connectors: { ...ctx.settings.connectors, web: v } })), '把网址正文转为 Markdown;会访问外部网站'),
      builtins.length ? h('details', { class: 'tz-ai-mcp-detail', 'data-role': 'builtin-tools' }, h('summary', null, `内置工具权限(${builtins.length})`), ...builtins.map(toolRow)) : '',
      heading('MCP 服务器'),
      ...s.mcpServers.map(card),
      s.mcpServers.length ? '' : h('div', { class: 'tz-field-hint' }, '还没有 MCP 服务器。'),
      addServer,
      heading('从 JSON 导入'),
      h('div', { class: 'tz-field-hint' }, '粘贴 mcpServers 格式的配置,可一次导入多个;本机命令类服务器将以你的权限在本机运行。'),
      json,
      h('div', null, importJson),
    )
  }
  return page(ai, render, async (ctx) => {
    const [st, tools] = await Promise.all([ai.call<{ servers: McpStatus[] }>('ai.mcp.status'), ai.call<{ tools: ToolInfo[] }>('ai.tools.list')])
    statuses = new Map(st.servers.map((x): [string, McpStatus] => [x.serverId, x]))
    builtins = tools.tools.filter((t) => t.name.startsWith('typoza__'))
    unsubscribe?.()
    // 状态变化(连上、失败)实时刷新;页面关掉后退订
    unsubscribe = ai.subscribe((ev) => {
      if (ev.type !== 'mcp.status') return
      statuses.set(ev.status.serverId, ev.status)
      if (document.querySelector('.tz-ai-settings')) ctx.rerender()
      else {
        unsubscribe?.()
        unsubscribe = null
      }
    })
  })
}

// ---------- 技能 ----------

function skillsPage(ai: AiController): HTMLElement {
  let skills: Skill[] = []
  const reload = async () => {
    skills = (await ai.call<{ skills: Skill[] }>('ai.skills.list')).skills
  }
  const render = (ctx: PageCtx): HTMLElement => {
    const s = ctx.settings
    const install = (directory: boolean) => async () => {
      const paths = await ai.deps.host.openDialog(directory ? { directory: true } : { extensions: ['zip'] })
      if (!paths?.[0]) return
      try {
        const skill = await ai.call<Skill>('ai.skills.install', { path: paths[0] })
        if (skill.error) ai.deps.toast(`「${skill.name}」不符合技能规范,没有加载:${skill.error}`, true)
        else if (skill.hasScripts) ai.deps.toast(`已安装「${skill.name}」。此技能包含脚本,Typoza 不会执行`)
        else ai.deps.toast(`已安装「${skill.name}」`)
        await reload()
      } catch (err) {
        ai.deps.toast(`安装失败:${errorText(err)}`, true)
      }
      ctx.rerender()
    }
    const row = (k: Skill): HTMLElement => {
      const enabled = checkbox('skillEnabled', !s.disabledSkills.includes(k.name), (v) => {
        const disabled = v ? ctx.settings.disabledSkills.filter((x) => x !== k.name) : [...new Set([...ctx.settings.disabledSkills, k.name])]
        void ctx.save({ disabledSkills: disabled })
      })
      enabled.disabled = Boolean(k.error)
      const remove =
        k.source === 'typoza'
          ? button(
              'removeSkill',
              '删除',
              async () => {
                const choice = await ai.deps.host.confirm({ title: `删除技能「${k.name}」?`, message: k.path, buttons: ['删除', '取消'], style: 'warning' })
                if (choice !== 0) return
                try {
                  await ai.call('ai.skills.remove', { name: k.name })
                  await reload()
                } catch (err) {
                  ai.deps.toast(`删除失败:${errorText(err)}`, true)
                }
                ctx.rerender()
              },
              'is-danger',
            )
          : h('span', { class: 'tz-field-hint' }, '来自 ~/.agents/skills')
      return h(
        'div',
        { class: 'tz-ai-card-set tz-ai-skill-row', 'data-skill': k.name },
        h('div', { class: 'tz-ai-card-set-head' }, labeled(k.name, enabled), remove),
        k.description ? h('div', { class: 'tz-field-hint' }, k.description) : '',
        k.error ? h('div', { class: 'tz-ai-form-error' }, `没有加载:${k.error}`) : '',
        k.hasScripts ? h('div', { class: 'tz-field-hint' }, '此技能包含脚本,Typoza 不会执行') : '',
      )
    }
    return h(
      'div',
      { class: 'tz-settings-fields' },
      field('启用技能', checkbox('skillsEnabled', s.skillsEnabled, (v) => void ctx.save({ skillsEnabled: v })), '对话开始时只把技能的名字与描述交给模型,需要时再读正文'),
      field(
        '也读取 ~/.agents/skills/',
        checkbox('readAgentsSkills', s.readAgentsSkills, (v) => {
          void ctx.save({ readAgentsSkills: v }).then(async () => {
            await reload()
            ctx.rerender()
          })
        }),
      ),
      heading('已安装的技能'),
      ...skills.map(row),
      skills.length ? '' : h('div', { class: 'tz-field-hint' }, '还没有技能。'),
      h('div', { class: 'tz-pref-path' }, button('installFolder', '从文件夹安装…', install(true)), button('installZip', '从 ZIP 安装…', install(false))),
    )
  }
  return page(ai, render, reload)
}

export function aiSettingsSections(ai: AiController): { title: string; render: () => HTMLElement }[] {
  return [
    { title: 'AI 服务商', render: () => providersPage(ai) },
    { title: 'AI 助手', render: () => assistantsPage(ai) },
    { title: 'AI 动作', render: () => actionsPage(ai) },
    { title: 'MCP 服务器', render: () => mcpPage(ai) },
    { title: '技能', render: () => skillsPage(ai) },
  ]
}
