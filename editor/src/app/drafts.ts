// 未命名草稿(PRD 3.1、对照表 X-56、X-19)。
// - 没保存过的新文档:停止输入 1 秒后备份到 Typoza 数据目录(外壳 DraftStore),网页进程崩溃或应用重启后恢复到原标签;
//   首次保存成功、或用户在关闭询问里选「不保存」后删掉备份。
// - 未保存时插入的图片先放在数据目录的 assets 里(assets.ts),首次保存时搬到文档旁并改写成相对路径。
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { basename, dirname, joinPath, relativePath } from '../core/paths'
import { schema } from '../core/schema'
import type { Host } from '../host/types'
import { type ImportContext, targetFolder } from './assets'

const DRAFT_DELAY = 1000

export function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export class DraftKeeper {
  /** 当前文档对应的草稿;还没备份过为 null */
  id: string | null = null
  private timer = 0

  constructor(
    private readonly host: Host,
    private readonly text: () => string,
    private readonly onError: (message: string) => void,
  ) {}

  /** 未命名文档有修改:停止输入 1 秒后备份 */
  schedule(): void {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.flush().catch((err: unknown) => this.onError(`未命名草稿备份失败:${err instanceof Error ? err.message : String(err)}`))
    }, DRAFT_DELAY)
  }

  /** 立即备份(退出应用前) */
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.id ??= newDraftId()
    await this.host.draftSave(this.id, this.text())
  }

  /** 已保存或用户放弃:删掉备份 */
  async discard(): Promise<void> {
    clearTimeout(this.timer)
    const id = this.id
    this.id = null
    if (id) await this.host.draftRemove(id)
  }

  /** 恢复出来的草稿继续用原来的备份 */
  adopt(id: string): void {
    clearTimeout(this.timer)
    this.id = id
  }
}

/** 未保存文档插入的资源所在文件夹(与 assets.ts 的 targetFolder 一致) */
export function draftAssetsDir(host: Host): string {
  return `${host.dataDir()}/assets`
}

async function uniquePath(host: Host, folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let candidate = joinPath(folder, name)
  for (let i = 1; await host.stat(candidate); i++) candidate = joinPath(folder, `${stem}-${i}${ext}`)
  return candidate
}

/**
 * 首次保存:把文档里引用数据目录 assets 的图片与媒体搬到按「插入图片时」规则算出的文件夹(ctx.docPath 是新路径),
 * 地址改写为相对路径(偏好关了相对路径时写绝对路径)。返回搬动的文件数。
 */
export async function relocateDraftAssets(view: EditorView, ctx: ImportContext): Promise<number> {
  const docPath = ctx.docPath
  if (!docPath) return 0
  const prefix = `${draftAssetsDir(ctx.host)}/`
  const targets: { pos: number; node: PMNode }[] = []
  view.state.doc.descendants((node, pos) => {
    if ((node.type === schema.nodes.image || node.type === schema.nodes.media) && String(node.attrs.src).startsWith(prefix)) targets.push({ pos, node })
    return true
  })
  if (targets.length === 0) return 0
  // 「不处理」模式:图片本来就按原路径引用,不搬
  const folder = targetFolder(ctx)
  if (!folder) return 0
  await ctx.host.mkdir(folder)
  const moved = new Map<string, string>()
  for (const { node } of targets) {
    const from = String(node.attrs.src)
    if (moved.has(from) || !(await ctx.host.stat(from))) continue
    const dest = await uniquePath(ctx.host, folder, basename(from))
    await ctx.host.rename(from, dest)
    moved.set(from, ctx.settings.imageUseRelative ? relativePath(dirname(docPath), dest) : dest)
  }
  const tr = view.state.tr
  for (const { pos, node } of targets) {
    const src = moved.get(String(node.attrs.src))
    if (!src) continue
    // 媒体块的 html 是原文缓存,地址变了要清掉,否则保存时写回旧地址
    tr.setNodeMarkup(pos, undefined, node.type === schema.nodes.media ? { ...node.attrs, src, html: null } : { ...node.attrs, src })
  }
  if (tr.docChanged) view.dispatch(tr)
  return moved.size
}
