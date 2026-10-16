// 编辑器里的 AI 插件:承载 AI 的装饰(选中文字动作的结果卡片、/ai 待确认块、改文档的差异预览),
// 空行行首按空格唤起 AI、Esc 收起 AI 浮层,并把「用户改了正文」告诉 AI 模块(选区原文已改动、预览失效)。
// 装饰不进文档:未接受的生成内容不会被保存(PRD 3.5)。
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state'
import { type Decoration, DecorationSet, type EditorView } from 'prosemirror-view'
import { isUiOnly } from '../core/commands'
import { schema } from '../core/schema'
import type { MenuItem } from '../ui/menu'

/** 装饰分槽:选中文字动作、在光标处生成、改文档预览,各自整体替换 */
export type AiSlot = 'selection' | 'inline' | 'diff'

interface AiPluginState {
  decos: DecorationSet
  /** 用户改正文的次数(AI 自己的改动、纯界面变化不算) */
  userEdits: number
}

interface SlotMeta {
  slot: AiSlot
  decorations: Decoration[]
}

export const aiKey = new PluginKey<AiPluginState>('tz-ai')

/** 标记 AI 模块自己发出的改动(接受生成、替换选区、应用修改),不算「用户改了正文」 */
export const AI_EDIT = 'tz-ai-edit'

/** AI 模块注入的回调(编辑器视图换了也一直有效) */
export interface AiEditorHooks {
  /** 空行行首按空格:返回 true 表示已接管(弹出 AI 输入框),否则照常输入空格 */
  spaceTrigger?(view: EditorView): boolean
  /** 编辑器里的按键(AI 菜单打开时的方向键、Esc 收起 AI 浮层):返回 true 表示已处理 */
  keydown?(view: EditorView, event: KeyboardEvent): boolean
  /** 用户改了正文 */
  userEdit?(view: EditorView): void
  /** 编辑器视图销毁(换文档、切源码模式):挂在旧视图上的 AI 卡片与预览要收起 */
  viewDestroyed?(view: EditorView): void
  /** 选区或文档变了(侧栏的上下文标签跟着变「当前文档 / 选区」) */
  update?(view: EditorView): void
  /** 右键菜单「AI ▸」的子项(选中了文字时) */
  selectionMenu?(view: EditorView): MenuItem[]
}

export const aiHooks: AiEditorHooks = {}

/** 整体替换某个槽的装饰(空数组即清空);不进撤销历史 */
export function setAiDecorations(tr: Transaction, slot: AiSlot, decorations: Decoration[]): Transaction {
  return tr.setMeta(aiKey, { slot, decorations } satisfies SlotMeta)
}

/** 某个槽当前的装饰(已随文档改动映射过位置) */
export function aiDecorations(view: EditorView, slot: AiSlot): Decoration[] {
  return aiKey.getState(view.state)?.decos.find(undefined, undefined, (spec: { slot?: AiSlot }) => spec.slot === slot) ?? []
}

export function userEditCount(view: EditorView): number {
  return aiKey.getState(view.state)?.userEdits ?? 0
}

export function aiPlugin(): Plugin<AiPluginState> {
  return new Plugin<AiPluginState>({
    key: aiKey,
    state: {
      init: () => ({ decos: DecorationSet.empty, userEdits: 0 }),
      apply(tr, prev) {
        let decos = tr.docChanged ? prev.decos.map(tr.mapping, tr.doc) : prev.decos
        const meta = tr.getMeta(aiKey) as SlotMeta | undefined
        if (meta) {
          decos = decos.remove(decos.find(undefined, undefined, (spec: { slot?: AiSlot }) => spec.slot === meta.slot))
          if (meta.decorations.length) decos = decos.add(tr.doc, meta.decorations)
        }
        const byUser = tr.docChanged && !tr.getMeta(AI_EDIT) && !isUiOnly(tr)
        return { decos, userEdits: prev.userEdits + (byUser ? 1 : 0) }
      },
    },
    props: {
      decorations: (state) => aiKey.getState(state)?.decos,
      handleKeyDown(view, event) {
        if (aiHooks.keydown?.(view, event)) {
          event.preventDefault()
          return true
        }
        if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || view.composing) return false
        const { $from, empty } = view.state.selection
        const para = $from.parent
        if (!empty || para.type !== schema.nodes.paragraph || para.content.size !== 0) return false
        if (!aiHooks.spaceTrigger?.(view)) return false
        event.preventDefault()
        return true
      },
    },
    view(editorView) {
      return {
        update(view, prevState) {
          const before = aiKey.getState(prevState)?.userEdits ?? 0
          if (userEditCount(view) !== before) aiHooks.userEdit?.(view)
          aiHooks.update?.(view)
        },
        destroy() {
          aiHooks.viewDestroyed?.(editorView)
        },
      }
    },
  })
}
