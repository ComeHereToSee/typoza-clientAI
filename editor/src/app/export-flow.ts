// 导出流程(PRD 3.12;对照表 F-22 ~ F-38、PX-01 ~ PX-11、X-22、X-23):
// 选目标(默认导出文件夹、上一次的位置)→ 按格式参数生成 → 记下这次导出 → 「导出成功」→ 导出后动作。
// 「使用上一次设置导出」沿用上次的格式与位置再弹保存框;「导出并覆盖上一次导出的文件」确认后直接覆盖。
import type { EditorView } from 'prosemirror-view'
import YAML from 'yaml'
import { basename, dirname } from '../core/paths'
import { registerCommand } from '../core/registry'
import type { ExportFormat, Host } from '../host/types'
import { h } from '../ui/dom'
import { renderCodePreviews } from '../views/codeblock'
import { effectiveTheme, isBuiltinTheme, isDarkTheme } from './appearance'
import { type ExportHtmlOptions, buildExportHtml } from './exporter'
import { modal } from './panels'
import type { AppSettings, ExportItem, ExportItemTemplate, LastExport } from './settings'

/** 内置导出格式与扩展名(Pandoc 格式需要用户装了 Pandoc)。 */
export const BUILTIN_FORMATS: Record<Exclude<ExportFormat, 'pandoc'>, string> = {
  pdf: 'pdf',
  html: 'html',
  'html-plain': 'html',
  image: 'png',
  docx: 'docx',
  odt: 'odt',
  rtf: 'rtf',
  epub: 'epub',
  latex: 'tex',
  mediawiki: 'wiki',
  rst: 'rst',
  textile: 'textile',
  opml: 'opml',
}

export const PANDOC_INSTALL_URL = 'https://pandoc.org/installing.html'

/** 「从模板添加」的导出项模板(对照表 F-35)。 */
export const EXPORT_TEMPLATES: { template: ExportItemTemplate; label: string; defaults: Partial<ExportItem> }[] = [
  { template: 'pandoc-pdf', label: 'PDF(LaTeX / Pandoc)', defaults: { name: 'PDF(LaTeX)', to: 'pdf', ext: 'pdf', pdfEngine: 'xelatex' } },
  { template: 'markdown', label: 'Markdown(其他规范)', defaults: { name: 'Markdown(GFM)', to: 'gfm', ext: 'md' } },
  { template: 'native', label: 'Native(Pandoc)', defaults: { name: 'Pandoc Native', to: 'native', ext: 'native' } },
  { template: 'pandoc', label: 'Pandoc 自定义格式', defaults: { name: 'Pandoc 自定义格式', to: 'html5', ext: 'html' } },
  { template: 'command', label: '自定义命令', defaults: { name: '自定义命令', ext: '', dialog: 'file' } },
]

/** Markdown(其他规范)的方言(对照表 PX-08),值为 Pandoc 格式名。 */
export const MARKDOWN_VARIANTS: { value: string; label: string }[] = [
  { value: 'markdown', label: 'Pandoc Markdown' },
  { value: 'markdown_phpextra', label: 'PHP Markdown Extra' },
  { value: 'markdown_mmd', label: 'MultiMarkdown' },
  { value: 'markdown_strict', label: '原始 Markdown' },
  { value: 'commonmark', label: 'CommonMark' },
  { value: 'gfm', label: 'GitHub Flavored Markdown' },
  { value: 'commonmark_x', label: 'CommonMark + 扩展' },
]

export function newExportItem(template: ExportItemTemplate): ExportItem {
  const preset = EXPORT_TEMPLATES.find((t) => t.template === template)
  if (!preset) throw new Error(`未知的导出模板:${template}`)
  return {
    id: Date.now().toString(36),
    name: '',
    template,
    to: '',
    ext: '',
    args: '',
    pdfEngine: '',
    columns: 0,
    eol: 'lf',
    referenceLinks: false,
    ascii: false,
    command: '',
    dialog: 'none',
    showOutput: false,
    ...preset.defaults,
  }
}

export interface ExportContext {
  host: Host
  settings: AppSettings
  systemDark: boolean
  /** 编辑器视图:导出 HTML / PDF / 图像时克隆它的渲染结果 */
  view: EditorView
  docPath: string | null
  /** 文档的 Markdown(Pandoc 格式用) */
  markdown: string
  /** 未保存文档的默认文件名(首个标题) */
  fallbackName: string
  /** front matter 原文(没有为 null) */
  frontMatter: string | null
  update(patch: Partial<AppSettings>): Promise<void>
  toast(message: string, error?: boolean): void
}

/** 文档 YAML 里与导出相关的键(对照表 X-22),开启 PX-10 时覆盖导出设置。 */
export interface ExportYaml {
  title?: string
  author?: string
  header?: string
  footer?: string
  appendHead?: string
  appendBody?: string
}

/** 读 YAML 导出键;YAML 写错时按没有处理(与 frontMatterInfo 一致,不打断导出)。 */
export function readExportYaml(text: string | null): ExportYaml {
  if (!text) return {}
  let data: unknown
  try {
    data = YAML.parse(text)
  } catch {
    return {}
  }
  if (!data || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const str = (key: string) => (typeof d[key] === 'string' || typeof d[key] === 'number' ? String(d[key]) : undefined)
  return { title: str('title'), author: str('author'), header: str('header'), footer: str('footer'), appendHead: str('append-head'), appendBody: str('append-body') }
}

/** 替换 ${变量}(对照表 X-23);不认识的变量原样保留(${pageNo} ${pageCount} 由外壳逐页替换)。 */
export function expandVariables(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? vars[name] : whole))
}

function today(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function exportVariables(ctx: ExportContext, yaml: ExportYaml, target: string): Record<string, string> {
  const stem = ctx.docPath ? basename(ctx.docPath).replace(/\.[^.]+$/, '') : ''
  return {
    title: yaml.title ?? (stem || ctx.fallbackName || '未命名'),
    author: yaml.author ?? ctx.settings.exportPdfAuthor,
    today: today(),
    outputPath: target,
    outputFolder: target ? dirname(target) : '',
    currentPath: ctx.docPath ?? '',
    currentFolder: ctx.docPath ? dirname(ctx.docPath) : '',
    currentFileName: stem,
  }
}

export function hasLastExport(settings: AppSettings, docPath: string | null): boolean {
  return Boolean(settings.exportHistory[docPath ?? ''])
}

/** 记下这篇文档的最近一次导出;只保留最近 100 篇,避免设置文件越长越大。 */
function withHistory(history: Record<string, LastExport>, key: string, entry: LastExport): Record<string, LastExport> {
  const next: Record<string, LastExport> = { ...history }
  delete next[key]
  next[key] = entry
  const keys = Object.keys(next)
  for (const k of keys.slice(0, Math.max(0, keys.length - 100))) delete next[k]
  return next
}

/** 默认导出文件夹(PX-01);undefined 交给外壳用文档所在文件夹。 */
function exportDirectory(ctx: ExportContext, historyKey: string): string | undefined {
  const s = ctx.settings
  if (s.exportFolder === 'custom' && s.exportCustomFolder) return s.exportCustomFolder
  if (s.exportFolder === 'same') return ctx.docPath ? dirname(ctx.docPath) : undefined
  // 自动:沿用这篇文档上次导出的文件夹;第一次导出用文档所在文件夹
  const last = s.exportHistory[historyKey]
  if (last) return dirname(last.target)
  return ctx.docPath ? dirname(ctx.docPath) : undefined
}

export function showCommandOutput(output: string): void {
  modal('命令输出', h('pre', { class: 'tz-command-output' }, output.trim() ? output : '(命令没有输出)'))
}

/** 导出失败:没装 Pandoc 时给【安装说明】(PRD 3.12),其余提示「导出失败:」+ 原因。 */
export async function reportPandocOrError(host: Host, toast: (message: string, error?: boolean) => void, err: unknown, prefix: string): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  if (message.startsWith('需要安装 Pandoc')) {
    const choice = await host.confirm({
      title: message,
      message: '导出 Word、Epub、LaTeX 等格式与导入文件都要用到 Pandoc;装好后也可以在偏好设置「导出」页填写 Pandoc 路径。',
      buttons: ['安装说明', '好'],
      style: 'warning',
    })
    if (choice === 0) await host.openExternal(PANDOC_INSTALL_URL)
    return
  }
  toast(`${prefix}${message}`, true)
}

const QUALITY_SCALE: Record<AppSettings['exportImageQuality'], number> = { auto: 0, medium: 1, high: 2, veryHigh: 3 }

/** 生成 HTML 的公共参数:主题(导出页可单独选,空 = 当前主题)。 */
function htmlOptions(ctx: ExportContext, themeSetting: string, yaml: ExportYaml, title: string): Omit<ExportHtmlOptions, 'targetPath' | 'withStyles'> {
  const current = effectiveTheme(ctx.settings, ctx.systemDark)
  const theme = themeSetting || current
  return {
    title,
    theme,
    dark: isDarkTheme(theme),
    mathOutput: ctx.settings.exportMathOutput,
    outline: false,
    h1PageBreak: false,
    preserveWhitespace: ctx.settings.exportWhitespace === 'preserve',
    fontSize: null,
    appendHead: yaml.appendHead ?? '',
    appendBody: yaml.appendBody ?? '',
    author: yaml.author ?? ctx.settings.exportPdfAuthor,
    // 选了别的内置主题时不带当前自定义主题的样式
    excludeUserTheme: theme !== current && isBuiltinTheme(theme),
  }
}

type ExportMode = 'new' | 'previous' | 'overwrite'

/**
 * 导出。formatId:内置格式名,或 item:导出项 ID。
 * 成功提示「导出成功」并执行导出后动作;失败提示「导出失败:」+ 原因(PRD 3.12 结果反馈)。
 */
export async function runExport(ctx: ExportContext, formatId: string, mode: ExportMode): Promise<void> {
  const s = ctx.settings
  const historyKey = ctx.docPath ?? ''
  const last = s.exportHistory[historyKey]
  if (mode !== 'new' && !last) {
    ctx.toast('这篇文档还没有导出过', true)
    return
  }
  const id = mode === 'new' || !last ? formatId : last.format
  const item = id.startsWith('item:') ? s.exportItems.find((i) => i.id === id.slice(5)) : undefined
  if (id.startsWith('item:') && !item) {
    ctx.toast(`找不到导出项(可能已在偏好设置里删除):${id.slice(5)}`, true)
    return
  }
  const builtinExt = (BUILTIN_FORMATS as Record<string, string | undefined>)[id]
  if (!item && !builtinExt) throw new Error(`未知的导出格式:${id}`)
  if (item?.template === 'command' && !ctx.docPath) {
    ctx.toast('先保存文档,才能用自定义命令导出', true)
    return
  }
  const ext = item ? item.ext : (builtinExt as string)
  const yaml = s.exportYamlOverride ? readExportYaml(ctx.frontMatter) : {}

  // ---------- 目标位置 ----------
  let target: string
  if (mode === 'overwrite' && last) {
    const choice = await ctx.host.confirm({
      title: `"导出并覆盖上一次导出的文件" 会覆盖位于 ${last.target} 的文件,是否继续?`,
      message: '',
      buttons: ['覆盖', '取消'],
      style: 'warning',
    })
    if (choice !== 0) return
    target = last.target
  } else if (item?.template === 'command' && item.dialog !== 'file') {
    if (item.dialog === 'folder') {
      const picked = await ctx.host.openDialog({ directory: true })
      if (!picked?.[0]) return
      target = picked[0]
    } else {
      target = ''
    }
  } else {
    const stem = ctx.docPath ? basename(ctx.docPath).replace(/\.[^.]+$/, '') : ctx.fallbackName || '未命名'
    const picked = await ctx.host.saveDialog({
      defaultName: mode === 'previous' && last ? basename(last.target) : ext ? `${stem}.${ext}` : stem,
      extensions: ext ? [ext] : undefined,
      directory: mode === 'previous' && last ? dirname(last.target) : exportDirectory(ctx, historyKey),
    })
    if (!picked) return
    target = picked
  }

  const vars = exportVariables(ctx, yaml, target)
  try {
    if (item?.template === 'command') await runCommandExport(ctx, item, vars)
    else {
      // 内置格式用渲染结果生成 HTML:离视口远的图表、公式预览先画齐
      if (!item) await renderCodePreviews(ctx.view)
      await ctx.host.exportDocument(exportRequest(ctx, id, item, target, yaml, vars))
    }
  } catch (err) {
    await reportPandocOrError(ctx.host, ctx.toast, err, '导出失败:')
    return
  }
  await ctx.update({ exportHistory: withHistory(s.exportHistory, historyKey, { format: id, target }) })
  ctx.toast('导出成功')
  await afterExport(ctx, target, vars)
}

function exportRequest(ctx: ExportContext, id: string, item: ExportItem | undefined, target: string, yaml: ExportYaml, vars: Record<string, string>) {
  const s = ctx.settings
  const base = { markdown: ctx.markdown, sourcePath: ctx.docPath, target }
  if (item) {
    const options: Record<string, unknown> = { to: item.to, args: item.args, title: vars.title, author: vars.author }
    if (item.template === 'pandoc-pdf') Object.assign(options, { to: 'pdf', pdfEngine: item.pdfEngine || 'xelatex' })
    if (item.template === 'native') options.to = 'native'
    if (item.template === 'markdown') Object.assign(options, { columns: item.columns, eol: item.eol, referenceLinks: item.referenceLinks, ascii: item.ascii })
    return { ...base, format: 'pandoc' as const, html: '', options }
  }
  const format = id as Exclude<ExportFormat, 'pandoc'>
  const html = (themeSetting: string, extra: Partial<ExportHtmlOptions>, withStyles = true) =>
    buildExportHtml(ctx.view.dom, { ...htmlOptions(ctx, themeSetting, yaml, vars.title), ...extra, targetPath: target, withStyles })
  switch (format) {
    case 'pdf':
      return {
        ...base,
        format,
        html: html(s.exportPdfTheme, { h1PageBreak: s.exportPdfH1Break, appendHead: [s.exportPdfAppendHead, yaml.appendHead ?? ''].filter(Boolean).join('\n') }),
        options: {
          paper: s.exportPdfPaper,
          width: s.exportPdfWidth,
          height: s.exportPdfHeight,
          margin: s.exportPdfMargin,
          header: expandVariables(yaml.header ?? s.exportPdfHeader, vars),
          footer: expandVariables(yaml.footer ?? s.exportPdfFooter, vars),
          title: vars.title,
          author: vars.author,
        },
      }
    case 'html':
      return {
        ...base,
        format,
        html: html(s.exportHtmlTheme, {
          outline: s.exportHtmlOutline,
          appendHead: [s.exportHtmlAppendHead, yaml.appendHead ?? ''].filter(Boolean).join('\n'),
          appendBody: [s.exportHtmlAppendBody, yaml.appendBody ?? ''].filter(Boolean).join('\n'),
        }),
      }
    case 'html-plain':
      return { ...base, format, html: html('', {}, false) }
    case 'image':
      return {
        ...base,
        format,
        html: html(s.exportImageTheme, { fontSize: s.exportImageFontSize > 0 ? s.exportImageFontSize : null }),
        options: { width: s.exportImageWidth, scale: QUALITY_SCALE[s.exportImageQuality] },
      }
    default:
      return {
        ...base,
        format,
        html: '',
        options: {
          args: s.exportPandocArgs,
          referenceDoc: format === 'docx' ? s.exportWordReferenceDoc : '',
          css: format === 'epub' ? s.exportEpubCss : '',
          tocDepth: format === 'epub' ? s.exportEpubTocDepth : 0,
          title: vars.title,
          author: vars.author,
        },
      }
  }
}

/** 自定义命令导出(对照表 PX-11):在文档所在文件夹执行命令,变量见 X-23。 */
async function runCommandExport(ctx: ExportContext, item: ExportItem, vars: Record<string, string>): Promise<void> {
  if (!item.command.trim()) throw new Error(`导出项「${item.name}」还没有填写命令`)
  const r = await ctx.host.runCommand(expandVariables(item.command, vars), ctx.docPath ? dirname(ctx.docPath) : null)
  if (r.status !== 0) throw new Error(r.output.trim() || `命令退出码 ${r.status}`)
  if (item.showOutput) showCommandOutput(r.output)
}

/** 导出后动作(对照表 PX-03)。 */
async function afterExport(ctx: ExportContext, target: string, vars: Record<string, string>): Promise<void> {
  const s = ctx.settings
  if (!target) return
  try {
    if (s.exportAfter === 'revealFile') await ctx.host.revealInFinder(target)
    else if (s.exportAfter === 'openFile') await ctx.host.openWithDefaultApp(target)
    else if (s.exportAfter === 'command' && s.exportAfterCommand.trim()) {
      const r = await ctx.host.runCommand(expandVariables(s.exportAfterCommand, vars), dirname(target))
      if (r.status !== 0) throw new Error(r.output.trim() || `退出码 ${r.status}`)
      if (s.exportShowCommandOutput) showCommandOutput(r.output)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.toast(s.exportAfter === 'command' ? `导出后运行自定义脚本失败:${reason}` : `导出后打开失败:${reason}`, true)
  }
}

/** 把导出项注册成命令(file.export.item.<ID>)并同步到原生 文件 ▸ 导出 菜单。 */
export function syncExportItems(host: Host, items: ExportItem[], run: (formatId: string) => void): void {
  for (const item of items) {
    registerCommand({ id: `file.export.item.${item.id}`, label: `导出 ${item.name}`, run: () => (run(`item:${item.id}`), true) })
  }
  void host.setExportItems(items.map((i) => ({ id: i.id, name: i.name }))).catch((err: unknown) => console.error('同步导出菜单失败', err))
}
