// 对话分支(PRD 3.3):消息以 parentId 连成树,leafId 决定显示哪条路线;发送 / 重新生成都只追加节点。
// 这里只做纯计算:当前路线、同一位置的多个版本、切到某版本后的末端、分支列表、导出为 Markdown。
import type { Conversation, Message, Part } from '../host/ai-types'

/** 根 → leaf 的消息路线;遇到断链或环就停。 */
export function pathTo(conv: Conversation, leafId: string | null): Message[] {
  const out: Message[] = []
  const seen = new Set<string>()
  let id = leafId
  while (id && !seen.has(id)) {
    seen.add(id)
    const msg = conv.messages[id]
    if (!msg) break
    out.push(msg)
    id = msg.parentId
  }
  return out.reverse()
}

const byTime = (a: Message, b: Message) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 某条消息的子消息(按创建时间);parentId 为 null 取根消息。 */
export function childrenOf(conv: Conversation, parentId: string | null): Message[] {
  return Object.values(conv.messages)
    .filter((m) => m.parentId === parentId)
    .sort(byTime)
}

/** 同一位置的各个版本:同父、同角色(重新生成的回答、编辑后重发的提问),按创建时间排。 */
export function versionsOf(conv: Conversation, msg: Message): Message[] {
  return childrenOf(conv, msg.parentId).filter((m) => m.role === msg.role)
}

/** 从某条消息往下,一直走最新的子消息,到没有子消息为止(切换版本后,后续对话跟着所选版本走)。 */
export function latestLeaf(conv: Conversation, fromId: string): string {
  let id = fromId
  const seen = new Set<string>([id])
  for (;;) {
    const kids = childrenOf(conv, id)
    const next = kids[kids.length - 1]
    if (!next || seen.has(next.id)) return id
    seen.add(next.id)
    id = next.id
  }
}

/** 消息里的纯文字(工具卡片、技能不算)。 */
export function messageText(msg: Pick<Message, 'parts'>): string {
  return msg.parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

export interface BranchInfo {
  leafId: string
  /** 以分叉处消息开头命名;没有分叉的路线用第一条提问 */
  label: string
  current: boolean
}

function snippet(text: string, max = 24): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return [...one].length > max ? `${[...one].slice(0, max).join('')}…` : one || '(空)'
}

/** 对话里的全部分支(每个末端一条),按末端创建时间排。 */
export function branches(conv: Conversation): BranchInfo[] {
  const parents = new Set(Object.values(conv.messages).map((m) => m.parentId))
  const leaves = Object.values(conv.messages)
    .filter((m) => !parents.has(m.id))
    .sort(byTime)
  const current = conv.leafId ? pathTo(conv, conv.leafId) : []
  const currentLeaf = current[current.length - 1]?.id ?? null
  return leaves.map((leaf) => {
    const path = pathTo(conv, leaf.id)
    let fork: Message | undefined
    for (const m of path) if (childrenOf(conv, m.parentId).length > 1) fork = m
    const named = fork ?? path.find((m) => m.role === 'user') ?? path[0]
    const prefix = fork && fork.role === 'assistant' ? `回答 ${versionsOf(conv, fork).indexOf(fork) + 1}:` : ''
    return { leafId: leaf.id, label: prefix + snippet(messageText(named)), current: leaf.id === currentLeaf }
  })
}

/** 当前路线导出为 Markdown:提问写成引用块,回答原样;工具调用只记一行。 */
export function pathMarkdown(conv: Conversation, leafId: string | null): string {
  const lines: string[] = [`# ${conv.title || '对话'}`, '']
  for (const msg of pathTo(conv, leafId)) {
    if (msg.role === 'user') {
      lines.push('**我:**', '', ...messageText(msg).split('\n').map((l) => (l ? `> ${l}` : '>')), '')
    } else {
      lines.push('**AI:**', '')
      for (const part of msg.parts) {
        if (part.type === 'text') lines.push(part.text.trim(), '')
        else if (part.type === 'tool_call') lines.push(`> 调用工具 \`${part.tool}\`(${part.status})`, '')
      }
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}
