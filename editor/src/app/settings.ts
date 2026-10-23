// 偏好设置:持久化在宿主(macOS 应用支持目录下的 settings.json),这里只定义键与默认值。
// 分页与选项对照 docs/prd/typora-parity.md 的 PF / PE / PI / PM / PX / PA / PG 行。
import type { Host } from '../host/types'

/** 导出设置里「从模板添加」的导出项模板(对照表 F-35)。 */
export type ExportItemTemplate = 'pandoc-pdf' | 'markdown' | 'native' | 'pandoc' | 'command'

/** 用户添加的导出项(对照表 PX-08 ~ PX-11),出现在 文件 ▸ 导出 菜单末尾。 */
export interface ExportItem {
  id: string
  name: string
  template: ExportItemTemplate
  /** Pandoc 目标格式:markdown 模板为方言名,pandoc 模板为任意格式名 */
  to: string
  /** 导出文件扩展名(不带点) */
  ext: string
  /** 额外的 Pandoc 参数 */
  args: string
  /** PDF(LaTeX)用的引擎 */
  pdfEngine: string
  /** Markdown 方言:每行字符数,0 表示不折行 */
  columns: number
  /** Markdown 方言:换行符 */
  eol: 'lf' | 'crlf' | 'native'
  /** Markdown 方言:使用引用式链接 */
  referenceLinks: boolean
  /** Markdown 方言:只用 ASCII 字符 */
  ascii: boolean
  /** 自定义命令导出:命令(可用 ${currentPath} ${outputPath} 等变量) */
  command: string
  /** 自定义命令导出:执行前弹出的选择框 */
  dialog: 'none' | 'file' | 'folder'
  /** 自定义命令导出:显示命令输出 */
  showOutput: boolean
}

/** 某个文档最近一次成功的导出(F-37、F-38 重复导出用)。 */
export interface LastExport {
  /** 内置格式名或 item:导出项 ID */
  format: string
  target: string
}

export interface AppSettings {
  // ---------- 外观 ----------
  theme: string
  /** 深色模式下使用的主题(T-06) */
  darkTheme: string
  appearance: 'system' | 'light' | 'dark'
  fontFamily: 'default' | 'serif' | 'mono'
  /** 字号跟随主题,或用下面的自定义字号(PA-02) */
  fontSizeMode: 'theme' | 'custom'
  fontSize: number
  pageWidth: 'normal' | 'wide' | 'full'
  zoom: number
  /** 按住 ⌘ 滚动滚轮缩放页面(PA-03) */
  zoomWithWheel: boolean
  /** 触控板双指捏合缩放页面(V-11) */
  pinchZoom: boolean
  showStatusBar: boolean
  /** 状态栏常驻字数;关闭时鼠标移到状态栏才显示(PA-04) */
  alwaysShowWordCount: boolean
  /** 阅读速度:每分钟字数(中日韩按字、西文按词,PA-05) */
  readingSpeed: number
  /** 打开文档时侧栏默认显示大纲(PA-06) */
  outlineByDefault: boolean
  // ---------- 文件 ----------
  /** 启动选项(PF-01) */
  startupAction: 'newFile' | 'lastFolder' | 'lastFilesAndFolder' | 'customFolder'
  startupFolder: string
  /** 上次使用的文件与文件夹(启动时恢复用,不在界面上显示) */
  lastFile: string
  lastFolder: string
  /** 允许折叠和展开侧边栏的大纲视图(PF-02) */
  outlineCollapsible: boolean
  /** 新文件扩展名(PF-03) */
  newFileExtension: 'md' | 'markdown' | 'text' | 'custom'
  customExtension: string
  autoSave: boolean
  ensureTrailingNewline: boolean
  /** 记录最近打开的文件与文件夹(PF-07) */
  recordRecent: boolean
  /** 拖入文件夹 / Markdown 文件 / 可导入文件时的处理(PF-08 ~ PF-10) */
  dropFolderAction: 'open' | 'link'
  dropMarkdownAction: 'open' | 'link'
  dropImportableAction: 'import' | 'link'
  // ---------- 编辑器 ----------
  /** 菜单或快捷键生成列表时的缩进:与列表标记对齐 / 4 个空格(PE-01) */
  listIndent: 'one' | 'tab'
  autoPair: boolean
  /** 匹配 Markdown 字符(PE-03,默认关) */
  autoPairMarkdown: boolean
  /** 编辑时显示 Markdown 标记(PE-04 / X-01,默认关) */
  showMarkdownMarkers: boolean
  /** 复制时纯文本部分写 Markdown 源码(PE-05) */
  copyPlainAsMarkdown: boolean
  /** 无选区时复制或剪切整行(PE-06) */
  copyLineWithoutSelection: boolean
  /** 新文件换行符(PE-07) */
  defaultLineEnding: 'lf' | 'crlf'
  spellcheck: boolean
  /** 拼写检查语言:auto = 自动检测,其余为 macOS 语言代码(PE-08) */
  spellcheckLanguage: string
  /** 打字机模式:true = 始终居中(含鼠标点选),false = 只在输入时居中(PE-09) */
  typewriterAlways: boolean
  // ---------- 图像 ----------
  imageInsertAction: 'none' | 'copyToCurrent' | 'copyToAssets' | 'copyToFilenameAssets' | 'upload' | 'copyToCustom'
  imageAssetsFolder: string
  imageCustomFolder: string
  /** 规则作用于本地 / 网络位置的图片(PI-02) */
  imageApplyToLocal: boolean
  imageApplyToNetwork: boolean
  /** 允许根据 YAML(typora-copy-images-to: upload)自动上传(PI-03) */
  imageUploadByYaml: boolean
  imageUseRelative: boolean
  /** 为相对路径添加 ./(PI-05) */
  imageRelativeDotSlash: boolean
  /** 插入时自动转义图片 URL(PI-06) */
  imageEscapeUrl: boolean
  /** 上传服务(PI-07) */
  imageUploadService: 'upic' | 'picsee' | 'picgo-core' | 'picgo-app' | 'piclist' | 'custom'
  imageUploadCommand: string
  // ---------- Markdown ----------
  /** 严格模式(PM-01):关闭时 `#标题`(# 后无空格)也识别为标题 */
  strictMode: boolean
  /** 生成标题的写法(PM-02) */
  headingStyle: 'atx' | 'atx-closed' | 'setext' | 'setext-variable'
  /** 生成无序列表的符号(PM-03) */
  listBullet: '-' | '+' | '*'
  /** 有序列表编号:1. 2. 3.(true)/ 1. 1. 1.(false)(PM-04) */
  orderedListIncrement: boolean
  /** 自动识别正文里的网址(PM-05) */
  autolink: boolean
  inlineMath: boolean
  /** 识别 ~下标~ / ^上标^(PM-08、PM-09,默认关) */
  subscript: boolean
  superscript: boolean
  /** 识别 ==高亮==(PM-10) */
  highlight: boolean
  /** 识别 GitHub 警报框 > [!NOTE](PM-11) */
  alerts: boolean
  /** 渲染图表代码块(PM-12) */
  diagrams: boolean
  /** 智能标点:关闭 / 输入时转换 / 渲染时转换(E-32) */
  smartPunctuationMode: 'off' | 'input' | 'render'
  /** 解析时把全角标点当标记识别(E-36;解析开关见 core/markdown/parse.ts setUnicodePunctuation) */
  unicodePunctuation: boolean
  /** 空格与换行(E-28 ~ E-30,只影响显示;见 plugins/display.ts) */
  firstLineIndent: boolean
  showBrTag: boolean
  preserveSingleNewline: boolean
  /** 智能引号与引号样式(两个字符:左右引号,PM-13) */
  smartQuotes: boolean
  doubleQuotes: string
  singleQuotes: string
  /** 智能破折号:-- 转 –、--- 转 —(en-em)/ 都转 —(em)(PM-14) */
  smartDashes: boolean
  dashRule: 'en-em' | 'em'
  codeLineNumbers: boolean
  codeLineWrap: boolean
  /** 代码块缩进宽度(空格数,PM-18) */
  codeIndentWidth: number
  /** 把 ```math 代码块显示为公式(PM-07) */
  mathCodeFence: boolean
  /** 公式自动编号(PM-22) */
  mathNumbering: 'none' | 'ams' | 'all'
  /** physics 宏(PM-21) */
  mathPhysics: boolean
  /** 块公式里 \\ 与 \newline 换行(PM-20) */
  mathLineBreak: boolean
  /** 无样式 HTML 里公式的输出形式(PM-23) */
  exportMathOutput: 'mathml' | 'latex'
  /** 导出与打印时连续空格与单个换行:忽略 / 保留(PM-24) */
  exportWhitespace: 'ignore' | 'preserve'
  // ---------- 导出 ----------
  exportFolder: 'auto' | 'same' | 'custom'
  exportCustomFolder: string
  exportAfter: 'none' | 'revealFile' | 'openFile' | 'command'
  exportAfterCommand: string
  exportShowCommandOutput: boolean
  /** 允许 YAML front matter 覆盖导出设置(PX-10) */
  exportYamlOverride: boolean
  exportPdfPaper: 'A3' | 'A4' | 'A5' | 'Letter' | 'Legal' | 'Tabloid' | 'custom'
  /** 自定义纸张宽高与页边距,单位毫米 */
  exportPdfWidth: number
  exportPdfHeight: number
  exportPdfMargin: number
  /** 导出用主题;空串 = 当前主题 */
  exportPdfTheme: string
  exportPdfH1Break: boolean
  exportPdfHeader: string
  exportPdfFooter: string
  exportPdfAuthor: string
  exportPdfAppendHead: string
  exportHtmlOutline: boolean
  exportHtmlTheme: string
  exportHtmlAppendHead: string
  exportHtmlAppendBody: string
  /** 图片导出宽度(像素) */
  exportImageWidth: number
  exportImageQuality: 'auto' | 'medium' | 'high' | 'veryHigh'
  /** 图片导出字号;0 = 跟随主题 */
  exportImageFontSize: number
  exportImageTheme: string
  exportPandocArgs: string
  exportWordReferenceDoc: string
  exportEpubCss: string
  exportEpubTocDepth: number
  pandocPath: string
  exportItems: ExportItem[]
  /** 文档路径(未保存的新文档为空串)→ 最近一次导出 */
  exportHistory: Record<string, LastExport>
  // ---------- 通用 ----------
  /** 所有窗口关闭后自动退出(PG-01,默认关);由外壳 AppDelegate 读取 */
  quitOnLastWindowClosed: boolean
  language: 'zh-Hans'
  autoCheckUpdates: boolean
  updateChannel: 'stable' | 'beta'
  /** 已选「不再提示」的警告(PG-06 重置时清空) */
  dismissedWarnings: string[]
  // ---------- 侧栏 ----------
  sidebarVisible: boolean
  sidebarTab: 'files' | 'list' | 'outline' | 'search'
  sidebarWidth: number
  // 快捷键:键 → 命令 ID(空串表示取消该键的默认绑定)
  keybindings: Record<string, string>
  // 视图模式
  focusMode: boolean
  typewriterMode: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'github',
  darkTheme: 'night',
  appearance: 'system',
  fontFamily: 'default',
  fontSizeMode: 'theme',
  fontSize: 16,
  pageWidth: 'normal',
  zoom: 1,
  zoomWithWheel: true,
  pinchZoom: true,
  showStatusBar: true,
  alwaysShowWordCount: true,
  readingSpeed: 382,
  outlineByDefault: false,
  startupAction: 'lastFilesAndFolder',
  startupFolder: '',
  lastFile: '',
  lastFolder: '',
  outlineCollapsible: true,
  newFileExtension: 'md',
  customExtension: '',
  autoSave: true,
  ensureTrailingNewline: true,
  recordRecent: true,
  dropFolderAction: 'open',
  dropMarkdownAction: 'open',
  dropImportableAction: 'import',
  listIndent: 'one',
  autoPair: true,
  autoPairMarkdown: false,
  showMarkdownMarkers: false,
  copyPlainAsMarkdown: true,
  copyLineWithoutSelection: false,
  defaultLineEnding: 'lf',
  spellcheck: false,
  spellcheckLanguage: 'auto',
  typewriterAlways: true,
  imageInsertAction: 'copyToAssets',
  imageAssetsFolder: './assets',
  imageCustomFolder: '',
  imageApplyToLocal: true,
  imageApplyToNetwork: false,
  // 「图片 ▸ 插入图片时 ▸ 上传图片」写的就是这个 YAML,默认按它上传;首次上传前另有确认
  imageUploadByYaml: true,
  imageUseRelative: true,
  imageRelativeDotSlash: false,
  imageEscapeUrl: false,
  imageUploadService: 'custom',
  imageUploadCommand: '',
  strictMode: true,
  headingStyle: 'atx',
  listBullet: '-',
  orderedListIncrement: true,
  autolink: true,
  inlineMath: true,
  subscript: false,
  superscript: false,
  highlight: true,
  alerts: true,
  diagrams: true,
  smartPunctuationMode: 'input',
  unicodePunctuation: false,
  firstLineIndent: false,
  showBrTag: false,
  preserveSingleNewline: true,
  smartQuotes: false,
  doubleQuotes: '“”',
  singleQuotes: '‘’',
  smartDashes: true,
  dashRule: 'en-em',
  codeLineNumbers: false,
  codeLineWrap: true,
  codeIndentWidth: 2,
  mathCodeFence: true,
  mathNumbering: 'ams',
  mathPhysics: false,
  mathLineBreak: true,
  exportMathOutput: 'mathml',
  exportWhitespace: 'ignore',
  exportFolder: 'auto',
  exportCustomFolder: '',
  exportAfter: 'none',
  exportAfterCommand: '',
  exportShowCommandOutput: false,
  exportYamlOverride: true,
  exportPdfPaper: 'A4',
  exportPdfWidth: 210,
  exportPdfHeight: 297,
  exportPdfMargin: 18,
  exportPdfTheme: '',
  exportPdfH1Break: false,
  exportPdfHeader: '',
  exportPdfFooter: '',
  exportPdfAuthor: '',
  exportPdfAppendHead: '',
  exportHtmlOutline: false,
  exportHtmlTheme: '',
  exportHtmlAppendHead: '',
  exportHtmlAppendBody: '',
  exportImageWidth: 900,
  exportImageQuality: 'auto',
  exportImageFontSize: 0,
  exportImageTheme: '',
  exportPandocArgs: '',
  exportWordReferenceDoc: '',
  exportEpubCss: '',
  exportEpubTocDepth: 3,
  pandocPath: '',
  exportItems: [],
  exportHistory: {},
  quitOnLastWindowClosed: false,
  language: 'zh-Hans',
  autoCheckUpdates: true,
  updateChannel: 'stable',
  dismissedWarnings: [],
  sidebarVisible: true,
  sidebarTab: 'files',
  sidebarWidth: 260,
  keybindings: {},
  focusMode: false,
  typewriterMode: false,
}

export async function loadSettings(host: Host): Promise<AppSettings> {
  const stored = await host.getSettings()
  const out = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const def = DEFAULT_SETTINGS[key]
    const value = stored[key]
    if (!(key in stored) || typeof value !== typeof def) continue
    // 数组与普通对象 typeof 都是 object,要分开校验,避免旧版本写进去的形状把界面弄坏
    if (value === null || Array.isArray(def) !== Array.isArray(value)) continue
    ;(out as Record<string, unknown>)[key] = value
  }
  // 早期版本的默认主题 typoza 已并入 Github(PRD 3.11 默认 Github)
  if (out.theme === 'typoza') out.theme = 'github'
  if (out.darkTheme === 'typoza') out.darkTheme = 'night'
  return out
}

/** 新文件扩展名(PF-03,不带点);自定义留空时用 md。 */
export function newFileExtension(s: AppSettings): string {
  if (s.newFileExtension !== 'custom') return s.newFileExtension
  return s.customExtension.trim().replace(/^\./, '') || 'md'
}

export interface ThemeInfo {
  id: string
  label: string
  /** 深色主题:应用整体切到深色配色 */
  dark: boolean
}

/** 内置主题(PRD 3.11):Github、Gothic、Newsprint、Night、Pixyll、Whitey,默认 Github。 */
export const BUILTIN_THEMES: ThemeInfo[] = [
  { id: 'github', label: 'Github', dark: false },
  { id: 'gothic', label: 'Gothic', dark: false },
  { id: 'newsprint', label: 'Newsprint', dark: false },
  { id: 'night', label: 'Night', dark: true },
  { id: 'pixyll', label: 'Pixyll', dark: false },
  { id: 'whitey', label: 'Whitey', dark: false },
]

/** 用户主题文件夹(T-02):放进去的 .css 无需重启即出现在主题菜单。 */
export function themesFolder(host: Host): string {
  return `${host.dataDir()}/themes`
}

/** 警告提示的标识(「不再提示」后记进 dismissedWarnings,PG-06 可重置)。 */
export const WARNINGS = {
  /** 首次上传图片前确认会调用第三方服务(PI-07) */
  imageUpload: 'imageUpload',
} as const
