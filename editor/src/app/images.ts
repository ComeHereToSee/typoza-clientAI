// 「格式 ▸ 图像」菜单与图片批量操作(对照表 M-13 ~ M-28、E-03)。
// 命令按 ID 注册,菜单栏、右键「图像工具」、图片工具条共用;作用于选中的图片(或紧挨光标的图片)。
import type { EditorView } from 'prosemirror-view'
import { insertImage } from '../core/commands'
import { detectEmbed } from '../core/embed'
import { type EditorEnv, type ImportFile, localPathOf, resourceUrl } from '../core/env'
import {
  type ImageRef,
  ZOOM_PRESETS,
  allImages,
  convertImageSyntax,
  currentImage,
  deleteImage,
  locateNode,
  replaceImageSources,
  setImageAttrs,
  zoomAttrs,
} from '../core/image-ops'
import { basename, dirname, extname, joinPath, normalizePath, relativePath } from '../core/paths'
import { registerCommand } from '../core/registry'
import type { Host } from '../host/types'
import { promptInput } from '../ui/prompt'
import { reloadAllImages } from '../views/image'
import { documentSrc } from './assets'
import { frontMatterInfo } from './document'
import type { AppSettings } from './settings'

export interface ImageCommandContext {
  host: Host
  env: EditorEnv
  settings(): AppSettings
  /** 当前文档路径;未保存的新文档为 null */
  docPath(): string | null
  toast(message: string, error?: boolean): void
  /** 按「插入图片时」规则落盘(与粘贴、拖入一致),返回写进文档的地址 */
  /** 用户在首次上传确认里取消时为 null */
  importFile(file: ImportFile): Promise<{ src: string } | null>
  /** 按偏好的上传服务上传(首次会确认);用户取消返回 null */
  upload(paths: string[]): Promise<string[] | null>
  setFrontMatter(key: string, value: string | null): void
  /** 打开偏好设置的某一页 */
  openPreferences(page: string): void
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'heic']

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 目标文件夹里不重名的路径(与插入图片的规则一致:重名加 -1、-2)。 */
async function uniqueTarget(host: Host, folder: string, name: string): Promise<string> {
  const safe = name.replace(/[/:]/g, '-') || 'image'
  const dot = safe.lastIndexOf('.')
  const base = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let candidate = joinPath(folder, safe)
  for (let i = 1; await host.stat(candidate); i++) candidate = joinPath(folder, `${base}-${i}${ext}`)
  return candidate
}

/** 网络图片下载后的文件名:网址路径的最后一段,没有扩展名时补 .png。 */
function remoteFileName(url: string): string {
  let name = ''
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
  } catch {
    // 网址里有不成对的 % 时按没有文件名处理
    name = ''
  }
  if (!name) name = 'image'
  return /\.[a-z0-9]+$/i.test(name) ? name : `${name}.png`
}

/** 写进文档的地址:与插入图片同一规则(相对路径、加 ./、转义按偏好 PI-04 / PI-05;对照表 M-20、M-21)。 */
function srcFor(ctx: ImageCommandContext, absolute: string): string {
  return documentSrc({ docPath: ctx.docPath(), settings: ctx.settings() }, absolute)
}

/** 写进 YAML 的文件夹:在文档所在文件夹之内写 ./相对路径,否则写绝对路径。 */
function folderValue(ctx: ImageCommandContext, folder: string): string {
  const doc = ctx.docPath()
  if (!doc) return folder
  const rel = relativePath(dirname(doc), folder)
  if (rel === '.') return './'
  return rel.startsWith('..') ? folder : `./${rel}`
}

function requireImage(ctx: ImageCommandContext, view: EditorView): ImageRef | null {
  const ref = currentImage(view.state)
  if (!ref) ctx.toast('请先选中一张图片', true)
  return ref
}

/** 自定义上传命令没填时提示并返回 false(批量上传前先查,免得每张都报同一个错)。 */
function uploadReady(ctx: ImageCommandContext): boolean {
  const { imageUploadService: service, imageUploadCommand: command } = ctx.settings()
  if (service === 'custom' && !command.trim()) {
    ctx.toast('还没有设置图片上传命令:请在偏好设置「图像」页填写', true)
    return false
  }
  return true
}

/** 把一张图片放进文件夹:本机图片复制或移动,网络图片下载。返回新文件的绝对路径;本来就在该文件夹里时原样返回。 */
async function placeInFolder(ctx: ImageCommandContext, src: string, folder: string, mode: 'copy' | 'move'): Promise<string> {
  const local = localPathOf(ctx.env, src)
  if (local) {
    if (normalizePath(dirname(local)) === normalizePath(folder)) return local
    if (!(await ctx.host.stat(local))) throw new Error(`找不到图片文件:${local}`)
    const target = await uniqueTarget(ctx.host, folder, basename(local))
    if (mode === 'move') await ctx.host.rename(local, target)
    else await ctx.host.copyFile(local, target)
    return target
  }
  if (!/^https?:\/\//i.test(src)) throw new Error(`无法处理的图片地址:${src.slice(0, 80)}`)
  const target = await uniqueTarget(ctx.host, folder, remoteFileName(src))
  await ctx.host.download(src, target)
  return target
}

export function registerImageCommands(ctx: ImageCommandContext): void {
  // 命令可能是异步的(对话框、文件操作):失败统一提示,不吞错误
  const cmd = (id: string, label: string, run: (view: EditorView) => void | Promise<void>) =>
    registerCommand({
      id,
      label,
      run: (view) => {
        Promise.resolve()
          .then(() => run(view))
          .catch((err: unknown) => ctx.toast(`${label.replace(/…$/, '')}失败:${errorText(err)}`, true))
        return true
      },
    })

  // M-13:剪贴板里是图片网址时直接插入;否则输入地址
  cmd('insert.image', '插入图片…', async (view) => {
    const clip = (await ctx.host.clipboardText()).trim()
    if (detectEmbed(clip)?.kind === 'image') {
      insertImage(clip)(view.state, view.dispatch)
      return
    }
    const c = view.coordsAtPos(view.state.selection.from)
    const src = await promptInput({ title: '插入图片', placeholder: '图片网址或本机路径', anchor: c })
    view.focus()
    if (src) insertImage(src)(view.state, view.dispatch)
  })
  cmd('image.insertLocal', '插入本地图片…', (view) => ctx.env.actions.insertLocalMedia(view, 'image'))

  cmd('image.reveal', '打开图片位置', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const local = localPathOf(ctx.env, ref.node.attrs.src as string)
    if (!local) {
      ctx.toast('网络图片没有本机位置', true)
      return
    }
    await ctx.host.revealInFinder(local)
  })

  // M-16 / E-03:网络图片由外壳下载后放进剪贴板
  cmd('image.copy', '拷贝图片', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const src = ref.node.attrs.src as string
    await ctx.host.copyImageToClipboard(localPathOf(ctx.env, src) ?? resourceUrl(ctx.env, src))
  })

  for (const preset of ZOOM_PRESETS) {
    cmd(`image.zoom.${preset.replace('%', '')}`, `缩放图片至 ${preset}`, (view) => {
      const ref = requireImage(ctx, view)
      if (ref) setImageAttrs(view, ref.pos, zoomAttrs(preset))
    })
  }

  for (const to of ['markdown', 'html'] as const) {
    cmd(to === 'markdown' ? 'image.toMarkdown' : 'image.toHtml', to === 'markdown' ? '转为 Markdown 格式' : '转为 HTML 格式', (view) => {
      const ref = requireImage(ctx, view)
      if (!ref) return
      const message = convertImageSyntax(view, ref.pos, to)
      if (message) ctx.toast(message, true)
    })
  }

  cmd('image.delete', '删除图片', (view) => {
    const ref = requireImage(ctx, view)
    if (ref) deleteImage(view, ref.pos)
  })

  // M-19:本机图片先确认再移到废纸篓;网络图片只删引用
  cmd('image.deleteFile', '删除图片文件…', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const local = localPathOf(ctx.env, ref.node.attrs.src as string)
    const choice = await ctx.host.confirm({
      title: '删除图片文件',
      message: local ? `「${basename(local)}」会移到废纸篓,文档里的这张图片也会删除。` : '这是网络图片,只会从文档中删除这张图片。',
      buttons: [local ? '移到废纸篓' : '删除图片', '取消'],
      style: 'warning',
    })
    if (choice !== 0) return
    if (local && (await ctx.host.stat(local))) await ctx.host.trash(local)
    const pos = locateNode(view.state.doc, ref.node)
    if (pos !== null) deleteImage(view, pos)
  })

  // M-20:复制到文件夹并改用新路径(网络图片下载过去)
  cmd('image.copyTo', '复制图片到…', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const folder = (await ctx.host.openDialog({ directory: true }))?.[0]
    if (!folder) return
    const target = await placeInFolder(ctx, ref.node.attrs.src as string, folder, 'copy')
    const pos = locateNode(view.state.doc, ref.node)
    if (pos !== null) setImageAttrs(view, pos, { src: srcFor(ctx, target) })
    ctx.toast(`已将图片复制到了 ${folder}。`)
  })

  // M-21:改名或移动本机图片文件并更新路径
  cmd('image.moveTo', '重命名 / 移动图片到…', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const local = localPathOf(ctx.env, ref.node.attrs.src as string)
    if (!local) {
      ctx.toast('网络图片不能移动,可用「复制图片到…」保存到本机', true)
      return
    }
    const ext = extname(local)
    const target = await ctx.host.saveDialog({ defaultName: basename(local), extensions: ext ? [ext] : undefined })
    if (!target || normalizePath(target) === normalizePath(local)) return
    if (await ctx.host.stat(target)) throw new Error(`目标路径已存在同名文件:${target}`)
    await ctx.host.rename(local, target)
    const pos = locateNode(view.state.doc, ref.node)
    if (pos !== null) setImageAttrs(view, pos, { src: srcFor(ctx, target) })
  })

  // M-22
  cmd('image.upload', '上传图片', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const local = localPathOf(ctx.env, ref.node.attrs.src as string)
    if (!local) {
      ctx.toast('这张图片已经是网络图片')
      return
    }
    if (!uploadReady(ctx)) return
    const urls = await ctx.upload([local])
    if (!urls) return
    const [url] = urls
    if (!url) throw new Error('上传命令没有返回网址')
    const pos = locateNode(view.state.doc, ref.node)
    if (pos !== null) setImageAttrs(view, pos, { src: url })
  })

  // 工具条【替换】:选本机图片,按插入规则落盘后换掉地址,替代文字与尺寸保留
  cmd('image.replace', '替换图片…', async (view) => {
    const ref = requireImage(ctx, view)
    if (!ref) return
    const path = (await ctx.host.openDialog({ extensions: IMAGE_EXTENSIONS }))?.[0]
    if (!path) return
    const imported = await ctx.importFile({ name: basename(path), path })
    if (!imported) return
    const pos = locateNode(view.state.doc, ref.node)
    if (pos !== null) setImageAttrs(view, pos, { src: imported.src })
  })

  // M-23:批量复制 / 移动本文全部图片;网络图片下载到目标文件夹
  const relocateAll = (mode: 'copy' | 'move') => async (view: EditorView) => {
    const images = allImages(view.state.doc)
    if (!images.length) {
      ctx.toast('文档里没有图片')
      return
    }
    const folder = (await ctx.host.openDialog({ directory: true }))?.[0]
    if (!folder) return
    await ctx.host.mkdir(folder)
    const map = new Map<string, string>()
    const failures: string[] = []
    for (const src of new Set(images.map((i) => i.node.attrs.src as string))) {
      try {
        map.set(src, srcFor(ctx, await placeInFolder(ctx, src, folder, mode)))
      } catch (err) {
        failures.push(`${src}:${errorText(err)}`)
      }
    }
    replaceImageSources(view, map)
    if (failures.length) ctx.toast(`有 ${failures.length} 张图片未能处理:${failures[0]}`, true)
    else ctx.toast(mode === 'copy' ? `已将图片复制到了 ${folder}。` : `已将图片移动到了 ${folder}。`)
  }
  cmd('image.copyAllTo', '复制所有图片到…', relocateAll('copy'))
  cmd('image.moveAllTo', '移动所有图片到…', relocateAll('move'))

  // M-24:逐张上传,结果按 Typora 原文提示
  cmd('image.uploadAll', '上传所有本地图片', async (view) => {
    const locals = new Map<string, string>()
    for (const { node } of allImages(view.state.doc)) {
      const src = node.attrs.src as string
      const local = localPathOf(ctx.env, src)
      if (local) locals.set(src, local)
    }
    if (!locals.size) {
      ctx.toast('文档未包含本地图片。')
      return
    }
    if (!uploadReady(ctx)) return
    const map = new Map<string, string>()
    let failed = 0
    for (const [src, path] of locals) {
      try {
        const urls = await ctx.upload([path])
        // 用户在首次上传确认里取消:一张都没传,直接结束
        if (!urls) return
        const [url] = urls
        if (!url) throw new Error('上传命令没有返回网址')
        map.set(src, url)
      } catch (err) {
        failed++
        console.error(`上传图片失败:${path}`, err)
      }
    }
    replaceImageSources(view, map)
    ctx.toast(`成功上传 ${map.size} 个图片,失败 ${failed} 个。`, failed > 0)
  })

  cmd('image.reloadAll', '重新加载所有图片', () => {
    reloadAllImages()
  })

  // M-26:为当前文档单独设插图规则,写 YAML(键名沿用 Typora)
  cmd('image.whenInsert.copyTo', '复制图片到文件夹…', async () => {
    const folder = (await ctx.host.openDialog({ directory: true }))?.[0]
    if (!folder) return
    const value = folderValue(ctx, folder)
    ctx.setFrontMatter('typora-copy-images-to', value)
    ctx.toast(`本文插入的本地图片将复制到 ${value}`)
  })
  cmd('image.whenInsert.upload', '上传图片', () => {
    ctx.setFrontMatter('typora-copy-images-to', 'upload')
    ctx.toast('本文插入的本地图片将上传到图床')
  })

  // M-27:以 / 开头的图片路径按这个根目录解析,设完立即按新根目录显示
  cmd('image.setRootUrl', '设置图片根目录…', async (view) => {
    const folder = (await ctx.host.openDialog({ directory: true }))?.[0]
    if (!folder) return
    ctx.setFrontMatter('typora-root-url', folderValue(ctx, folder))
    ctx.env.ctx.rootUrl = frontMatterInfo(view.state.doc, ctx.docPath()).rootUrl
    reloadAllImages()
  })

  cmd('image.globalSettings', '全局图像设置…', () => ctx.openPreferences('图像'))
}
