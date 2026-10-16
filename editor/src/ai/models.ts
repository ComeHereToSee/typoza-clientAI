// 服务商与模型(PRD 3.1):可用模型判断、模型选择项、服务商预设、新条目 ID。
import type { AiSettings, ModelRef, Protocol, Provider } from '../host/ai-types'

/** 未配置模型时各 AI 入口的提示(PRD 3.1「默认模型」边界) */
export const NOT_CONFIGURED_TEXT = '请先在设置 ▸ AI 服务商中添加模型'

/** 有没有可用的模型:至少一个启用的服务商里有模型。 */
export function hasUsableModel(settings: AiSettings | null): boolean {
  return Boolean(settings?.providers.some((p) => p.enabled && p.models.length > 0))
}

export function refKey(ref: ModelRef | undefined): string {
  return ref ? `${ref.providerId}/${ref.modelId}` : ''
}

export function parseRefKey(key: string): ModelRef | undefined {
  const i = key.indexOf('/')
  if (i <= 0) return undefined
  return { providerId: key.slice(0, i), modelId: key.slice(i + 1) }
}

/** 下拉框里的模型:启用的服务商下全部模型,显示为「服务商 · 模型」。 */
export function modelOptions(settings: AiSettings): { value: string; label: string }[] {
  return settings.providers
    .filter((p) => p.enabled)
    .flatMap((p) => p.models.map((m) => ({ value: refKey({ providerId: p.id, modelId: m.id }), label: `${p.name} · ${m.name || m.id}` })))
}

export interface ProviderPreset {
  name: string
  protocol: Protocol
  baseUrl: string
  /** 本机服务商可不填密钥 */
  local?: boolean
}

/** 预设服务商(PRD 3.1);地址末尾写 # 表示原样使用、不自动拼接口路径。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { name: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { name: 'DeepSeek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com' },
  { name: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: '本机 Ollama', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  { name: '本机 LM Studio', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  { name: '自定义', protocol: 'openai-chat', baseUrl: '' },
]

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini',
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * 设置里新建条目(服务商、助手、动作、MCP 服务器)的 ID,与辅助进程同格式(随机 12 字节 base32 小写)。
 * 由网页生成:服务商的密钥引用名 provider:<id> 要在保存设置前就确定。
 */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += ID_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ID_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function providerFromPreset(preset: ProviderPreset): Provider {
  return { id: newId(), name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, enabled: true, hasKey: false, models: [] }
}

/** 服务商密钥在钥匙串里的引用名 */
export function providerSecretRef(providerId: string): string {
  return `provider:${providerId}`
}

/** MCP 环境变量或请求头在钥匙串里的引用名 */
export function mcpSecretRef(serverId: string, name: string): string {
  return `mcp:${serverId}:${name}`
}
