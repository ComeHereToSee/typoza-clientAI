// 插入本机文件(图片、视频、附件……)时的落盘规则,与 Typora「插入图片时」一致(对照表 PI-01 ~ PI-07):
// 不处理(用原路径)/ 复制到 ./ / ./assets / ./${filename}.assets / 指定文件夹 / 上传。
// front matter 的 typora-copy-images-to 优先于偏好设置;值为 upload 且开了「允许根据 YAML 设置自动上传」时上传。
import { basename, dirname, extname, joinPath, normalizePath, relativePath } from '../core/paths'
import type { ImportFile } from '../core/env'
import type { Host } from '../host/types'
import { type AppSettings, WARNINGS } from './settings'

export type ImportKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

const KIND_BY_EXT: Record<string, ImportKind> = {}
for (const e of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'avif', 'svg', 'bmp', 'heic', 'tiff', 'ico']) KIND_BY_EXT[e] = 'image'
for (const e of ['mp4', 'm4v', 'mov', 'webm', 'ogv']) KIND_BY_EXT[e] = 'video'
for (const e of ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'flac', 'aac']) KIND_BY_EXT[e] = 'audio'
KIND_BY_EXT.pdf = 'pdf'

export function kindOf(name: string): ImportKind {
  return KIND_BY_EXT[extname(name)] ?? 'file'
}

export interface ImportContext {
  host: Host
  settings: AppSettings
  /** 当前文档路径;未保存的新文档为 null */
  docPath: string | null
  /** front matter 里的 typora-copy-images-to(原文) */
  copyImagesTo: string | null
  /** 用户在「首次上传确认」里点了继续:记进设置,以后不再问(偏好「通用」可重置) */
  dismissWarning?: (id: string) => void
}

/** 上传服务的显示名(PI-07)。 */
export const UPLOAD_SERVICES: { id: AppSettings['imageUploadService']; label: string }[] = [
  { id: 'upic', label: 'uPic' },
  { id: 'picsee', label: 'Picsee' },
  { id: 'picgo-core', label: 'PicGo-Core(命令行)' },
  { id: 'picgo-app', label: 'PicGo.app' },
  { id: 'piclist', label: 'PicList' },
  { id: 'custom', label: '自定义命令' },
]

function stem(path: string): string {
  const name = basename(path)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** 未保存的新文档插入的文件先放这里(Typoza 数据目录,不打扰用户)。 */
export function draftAssetsFolder(host: Host): string {
  return `${host.homeDir()}/Library/Application Support/Typoza/assets`
}

/** YAML 里写 typora-copy-images-to: upload 表示这篇文档的图片走上传(Typora 写法)。 */
function isUploadDirective(value: string | null): boolean {
  return value !== null && value.trim().toLowerCase() === 'upload'
}

/** 这次插入图片是否上传:偏好选了上传,或 YAML 要求上传且允许按 YAML 上传(PI-03)。 */
export function shouldUpload(ctx: ImportContext): boolean {
  if (isUploadDirective(ctx.copyImagesTo)) return ctx.settings.imageUploadByYaml
  return ctx.settings.imageInsertAction === 'upload'
}

/** 目标文件夹(绝对路径);null 表示不复制、直接用原路径。 */
export function targetFolder(ctx: ImportContext): string | null {
  const { settings, docPath } = ctx
  const draftDir = draftAssetsFolder(ctx.host)
  const docDir = docPath ? dirname(docPath) : null
  const expand = (p: string) => p.replace(/\$\{filename\}/g, docPath ? stem(docPath) : 'untitled')
  if (ctx.copyImagesTo && !isUploadDirective(ctx.copyImagesTo)) {
    const p = expand(ctx.copyImagesTo)
    if (p.startsWith('/')) return normalizePath(p)
    return docDir ? joinPath(docDir, p) : draftDir
  }
  switch (settings.imageInsertAction) {
    case 'none':
    case 'upload':
      return null
    case 'copyToCurrent':
      return docDir ?? draftDir
    case 'copyToFilenameAssets':
      return docDir ? joinPath(docDir, expand('./${filename}.assets')) : draftDir
    case 'copyToCustom':
      return settings.imageCustomFolder ? normalizePath(expand(settings.imageCustomFolder)) : (docDir ?? draftDir)
    default:
      return docDir ? joinPath(docDir, expand(settings.imageAssetsFolder || './assets')) : draftDir
  }
}

async function uniquePath(host: Host, folder: string, name: string): Promise<string> {
  const safe = name.replace(/[/:]/g, '-')
  const dot = safe.lastIndexOf('.')
  const base = dot > 0 ? safe.slice(0, dot) : safe
  const ext = dot > 0 ? safe.slice(dot) : ''
  let candidate = joinPath(folder, safe)
  for (let i = 1; await host.stat(candidate); i++) candidate = joinPath(folder, `${base}-${i}${ext}`)
  return candidate
}

/**
 * 目标文件夹不存在时先问(PRD 3.4、对照表 X-18);返回 false 表示用户取消。
 * 未保存文档用的数据目录是应用自己的,直接建。
 */
async function ensureFolder(ctx: ImportContext, folder: string): Promise<boolean> {
  if (await ctx.host.stat(folder)) return true
  if (folder !== draftAssetsFolder(ctx.host)) {
    const choice = await ctx.host.confirm({ title: '该目录不存在,是否立即创建?', message: folder, buttons: ['创建目录并继续', '取消'], style: 'warning' })
    if (choice !== 0) return false
  }
  await ctx.host.mkdir(folder)
  return true
}

/** 写进文档的地址:相对路径(可加 ./)或绝对路径,按设置转义(PI-04 ~ PI-06)。 */
export function documentSrc(ctx: Pick<ImportContext, 'docPath' | 'settings'>, absolute: string): string {
  const docDir = ctx.docPath ? dirname(ctx.docPath) : null
  let src = absolute
  if (docDir && ctx.settings.imageUseRelative) {
    src = relativePath(docDir, absolute)
    if (ctx.settings.imageRelativeDotSlash && !src.startsWith('../') && !src.startsWith('./')) src = `./${src}`
  }
  return ctx.settings.imageEscapeUrl ? encodeURI(src) : src
}

/** 首次上传前确认将调用第三方服务(PI-07);返回 false 表示用户取消。确认过一次后不再问(偏好「通用」可重置)。 */
async function confirmFirstUpload(ctx: ImportContext): Promise<boolean> {
  if (ctx.settings.dismissedWarnings.includes(WARNINGS.imageUpload)) return true
  const service = UPLOAD_SERVICES.find((s) => s.id === ctx.settings.imageUploadService)?.label ?? ctx.settings.imageUploadService
  const choice = await ctx.host.confirm({
    title: '上传图片',
    message: `将调用第三方上传服务「${service}」,图片会发送到该服务配置的图床。是否继续?`,
    buttons: ['继续上传', '取消'],
    style: 'warning',
  })
  if (choice !== 0) return false
  ctx.dismissWarning?.(WARNINGS.imageUpload)
  return true
}

/** 按偏好设置的上传服务上传图片,返回网址(顺序与 paths 一致)。 */
export async function uploadImages(ctx: ImportContext, paths: string[]): Promise<string[] | null> {
  const { imageUploadService: service, imageUploadCommand: command } = ctx.settings
  if (service === 'custom' && !command.trim()) throw new Error('还没有设置上传命令:请在偏好设置「图像」页填写')
  if (!(await confirmFirstUpload(ctx))) return null
  return ctx.host.uploadImages({ service, command }, paths)
}

function uploadCacheFolder(host: Host): string {
  return `${host.homeDir()}/Library/Caches/Typoza/upload`
}

/**
 * 把文件落盘(或上传)并返回要写进文档的地址;用户在询问里取消时返回 null。
 * 本机文件在「对本地位置的图片应用上述规则」关闭时直接引用原路径(PI-02);剪贴板里的图片没有原路径,照规则落盘。
 */
export async function importFile(ctx: ImportContext, file: ImportFile): Promise<{ src: string; kind: ImportKind; name: string } | null> {
  const kind = kindOf(file.name)
  const isImage = kind === 'image'
  if (isImage && shouldUpload(ctx)) {
    let source = file.path
    if (!source) {
      if (file.base64 === undefined) throw new Error(`没有可上传的内容:${file.name}`)
      const folder = uploadCacheFolder(ctx.host)
      await ctx.host.mkdir(folder)
      source = await uniquePath(ctx.host, folder, file.name)
      await ctx.host.writeBase64(source, file.base64)
    }
    const urls = await uploadImages(ctx, [source])
    return urls ? { src: urls[0], kind, name: file.name } : null
  }
  const keepOriginal = isImage && file.path && !ctx.settings.imageApplyToLocal
  const folder = keepOriginal ? null : targetFolder(ctx)
  let absolute: string
  if (!folder) {
    if (!file.path) throw new Error('「无特殊操作」模式下无法插入剪贴板里的图片:请在偏好设置里改为复制到文件夹')
    absolute = file.path
  } else {
    if (!(await ensureFolder(ctx, folder))) return null
    absolute = await uniquePath(ctx.host, folder, file.name)
    if (file.base64 !== undefined) await ctx.host.writeBase64(absolute, file.base64)
    else if (file.path) await ctx.host.copyFile(file.path, absolute)
    else throw new Error(`没有可导入的内容:${file.name}`)
  }
  return { src: documentSrc(ctx, absolute), kind, name: file.name }
}

/**
 * 插入网络图片(PI-02):开了「对网络位置的图片应用上述规则」时下载到目标文件夹(或转传到上传服务),否则保持网址。
 * 用户取消返回 null。
 */
export async function importNetworkImage(ctx: ImportContext, url: string): Promise<string | null> {
  if (!ctx.settings.imageApplyToNetwork) return url
  if (shouldUpload(ctx)) {
    const urls = await uploadImages(ctx, [url])
    return urls ? urls[0] : null
  }
  const folder = targetFolder(ctx)
  if (!folder) return url
  if (!(await ensureFolder(ctx, folder))) return null
  let name = 'image.png'
  try {
    name = decodeURIComponent(basename(new URL(url).pathname)) || name
  } catch {
    // 网址路径里有不成对的 %:用默认名
  }
  if (!extname(name)) name += '.png'
  const absolute = await uniquePath(ctx.host, folder, name)
  await ctx.host.downloadFile(url, absolute)
  return documentSrc(ctx, absolute)
}

// 1×1 透明 PNG:验证上传服务用
const TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

/** 「验证图片上传选项」(PI-07):上传一张 1×1 的测试图片,返回网址;用户取消返回 null。 */
export async function verifyUpload(ctx: ImportContext): Promise<string | null> {
  const folder = uploadCacheFolder(ctx.host)
  await ctx.host.mkdir(folder)
  const path = `${folder}/typoza-upload-test.png`
  await ctx.host.writeBase64(path, TEST_PNG)
  const urls = await uploadImages(ctx, [path])
  return urls ? urls[0] : null
}
