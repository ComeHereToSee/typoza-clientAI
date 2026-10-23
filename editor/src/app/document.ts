// 一个窗口里正在编辑的文档:路径、原文格式信息(换行符、编码、BOM)、保存状态。
import type { Node as PMNode } from 'prosemirror-model'
import YAML from 'yaml'
import { bundleOf } from '../core/filetypes'
import { assembleDoc, type DocMeta, MarkdownChunks, parseMarkdown } from '../core/markdown/parse'
import { serializeMarkdown } from '../core/markdown/serialize'
import { dirname, joinPath, normalizePath } from '../core/paths'
import { schema } from '../core/schema'
import type { Host, ReadResult } from '../host/types'
import { parseOptionsFrom, serializeOptionsFrom } from './markdown-prefs'
import type { AppSettings } from './settings'

export interface FrontMatterInfo {
  title?: string
  icon?: string
  cover?: string
  rootUrl: string | null
  copyImagesTo: string | null
}

export class DocumentSession {
  path: string | null = null
  meta: DocMeta = { lineEnding: '\n', bom: false, leading: '', trailing: '\n', bullet: null }
  encoding = 'utf-8'
  savedMtime = 0
  dirty = false
  /** 改动计数:写盘回执回来时若期间又改过,仍算未保存 */
  private revision = 0
  /** 最近一次写盘(或读盘)的文本,用于判断外部修改是否只是我们自己的保存 */
  savedText = ''
  /** 只读原因(PRD 3.1 异常):permission = 没有写权限,large = 超过大文件阈值、以只读源码打开;null 为可写 */
  /** permission:没有写权限;large:超大文件只读源码;partial:后半部分解析失败、只载入了前半部分(不能存回原文件) */
  readOnly: 'permission' | 'large' | 'partial' | null = null
  /** 大文档还在分段载入:正文不全,不能编辑、保存、导出 */
  loading = false

  constructor(
    private readonly host: Host,
    private readonly settings: () => AppSettings,
  ) {}

  get title(): string {
    if (!this.path) return '未命名'
    // TextBundle 包里的正文以包名作标题
    const shown = bundleOf(this.path) ?? this.path
    return shown.slice(shown.lastIndexOf('/') + 1)
  }

  async load(path: string, encoding?: string): Promise<PMNode> {
    const result = await this.host.readText(path, encoding)
    // 先解析再改状态:解析失败时会话仍指向原文档,不会把旧内容存到新路径
    const parsed = parseMarkdown(result.text, parseOptionsFrom(this.settings()))
    this.adopt(path, result)
    this.meta = parsed.meta
    return parsed.doc
  }

  /**
   * 渐进打开:读入全文,只先解析第一段返回;其余段由调用方用 rest 逐段解析后追加(rest 为 null 表示已全部解析)。
   * 会话的 meta 与 rest 共用一个对象,最后一段解析完时文末原文(trailing)才确定。
   */
  async loadProgressive(path: string, encoding?: string): Promise<{ doc: PMNode; rest: MarkdownChunks | null }> {
    const result = await this.host.readText(path, encoding)
    const chunks = new MarkdownChunks(result.text, parseOptionsFrom(this.settings()))
    const blocks: PMNode[] = []
    // 第一段若只到 front matter 为止就再多解析一段:半截文档的末尾不能是 front matter(组装时会补空段落)
    do blocks.push(...chunks.nextBlocks())
    while (!chunks.done && (blocks.length === 0 || blocks[blocks.length - 1].type === schema.nodes.frontmatter))
    const doc = chunks.done ? assembleDoc(blocks) : schema.nodes.doc.create(null, blocks)
    this.adopt(path, result)
    this.meta = chunks.meta
    return { doc, rest: chunks.done ? null : chunks }
  }

  /** 只读进原文、不解析(超大文件以只读源码打开) */
  async loadText(path: string, encoding?: string): Promise<string> {
    const result = await this.host.readText(path, encoding)
    this.adopt(path, result)
    this.meta = { lineEnding: result.text.includes('\r\n') ? '\r\n' : '\n', bom: false, leading: '', trailing: '\n', bullet: '-' }
    return result.text
  }

  private adopt(path: string, result: ReadResult): void {
    this.path = path
    this.encoding = result.encoding
    this.savedMtime = result.mtime
    this.savedText = result.text
    this.dirty = false
    this.readOnly = null
    this.loading = false
  }

  createEmpty(): PMNode {
    this.path = null
    // 新文件换行符按偏好(PE-07);无序列表符号跟偏好走(bullet 为 null)
    this.meta = { lineEnding: this.settings().defaultLineEnding === 'crlf' ? '\r\n' : '\n', bom: false, leading: '', trailing: '\n', bullet: null }
    this.encoding = 'utf-8'
    this.savedMtime = 0
    this.savedText = ''
    this.dirty = false
    this.readOnly = null
    this.loading = false
    return schema.nodes.doc.create(null, schema.nodes.paragraph.create())
  }

  serialize(doc: PMNode): string {
    const s = this.settings()
    return serializeMarkdown(doc, this.meta, serializeOptionsFrom(s))
  }

  markDirty(): void {
    this.dirty = true
    this.revision++
  }

  /** 正在写盘的那次保存;文件监视的通知可能比写盘的回执先到,判断「被其他程序修改」前要等它写完 */
  saving: Promise<void> | null = null

  /** 同一文档的保存一次一个:外壳在后台并发写盘,两次保存可能乱序落盘,磁盘上留下旧版 */
  async save(doc: PMNode, path = this.path): Promise<void> {
    if (!path) throw new Error('文档还没有保存位置')
    // 计数取调用时的:doc 是那一刻的内容,等前一次保存期间的改动不算存上
    const revision = this.revision
    while (this.saving) await this.saving.catch(() => undefined)
    const text = this.serialize(doc)
    const write = this.host.writeText(path, text, this.encoding).then(({ mtime }) => {
      this.path = path
      this.savedMtime = mtime
      this.savedText = text
      // 写盘途中又打了字:那些字还没存
      if (this.revision === revision) this.dirty = false
    })
    this.saving = write
    try {
      await write
    } finally {
      if (this.saving === write) this.saving = null
    }
  }
}

/** 解析 front matter(图标、封面、Typora 的 root-url 与 copy-images-to)。YAML 写错时按没有处理,不打断编辑。 */
export function frontMatterInfo(doc: PMNode, docPath: string | null): FrontMatterInfo {
  const first = doc.firstChild
  const info: FrontMatterInfo = { rootUrl: null, copyImagesTo: null }
  if (!first || first.type !== schema.nodes.frontmatter) return info
  let data: unknown
  try {
    data = YAML.parse(first.textContent)
  } catch {
    return info
  }
  if (!data || typeof data !== 'object') return info
  const d = data as Record<string, unknown>
  if (typeof d.title === 'string') info.title = d.title
  if (typeof d.icon === 'string') info.icon = d.icon
  if (typeof d.cover === 'string') info.cover = d.cover
  const root = d['typora-root-url']
  if (typeof root === 'string' && root) {
    info.rootUrl = root.startsWith('/') ? normalizePath(root) : docPath ? joinPath(dirname(docPath), root) : null
  }
  const copy = d['typora-copy-images-to']
  if (typeof copy === 'string' && copy) info.copyImagesTo = copy
  return info
}

/** 改 front matter 里的一个键(图标、封面),返回新的 YAML 文本;value 为 null 时删除该键。 */
export function updateFrontMatterText(yamlText: string, key: string, value: string | null): string {
  const doc = YAML.parseDocument(yamlText || '')
  if (value === null) doc.delete(key)
  else doc.set(key, value)
  return String(doc).replace(/\n$/, '')
}
