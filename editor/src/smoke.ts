// 打包产物冒烟自检(macOS CI 上以 --smoke-out 启动应用时由外壳调用):
// 在临时目录写一篇带图片 / 表格 / 动图的文档 → 打开 → 双击表格里的图片 → 确认灯箱打开且图片真的加载出来;
// 再走一遍真实的导出 / 导入(外壳离屏渲染与 Pandoc)、指定编码重新打开、拷贝图片。
import { NodeSelection, TextSelection } from 'prosemirror-state'
import type { App } from './app/app'
import { createEditorState } from './core/editor'
import { parseMarkdown, parseTimings } from './core/markdown/parse'
import { runCommand } from './core/registry'
import { DEMO_MARKDOWN, TINY_GIF, sampleSvg } from './demo'

export interface SmokeResult {
  ok: boolean
  checks: Record<string, boolean>
  timings: Record<string, number>
  error?: string
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (cond()) return true
    await wait(30)
  }
  return cond()
}

/** 约 target 字节的混排文档:标题、段落(含行内格式与链接)、列表、待办、引用;每 10 节一张表格和一段代码。 */
export function bigMarkdown(target: number): string {
  const enc = new TextEncoder()
  const parts: string[] = []
  let bytes = 0
  for (let i = 1; bytes < target; i++) {
    let s = `## 第 ${i} 节 · 资助项目配置\n\n左栏「对象类型」→ 右上「新建对象类型」,填完点右上「保存并生效」。**加粗**、*斜体*、\`代码\` 与 [链接](https://example.com/${i}) 混排,用于测试大文件的打开与输入。\n\n- 唯一标识符:aid_project_${i}\n- 名称:资助项目 ${i}\n- [ ] 待办事项 ${i}\n\n> 第 ${i} 节的引用段落。\n\n`
    if (i % 10 === 0) s += `| 配置项 | 填什么 | 说明 |\n| --- | --- | --- |\n| 唯一标识符 | \`aid_${i}\` | 英文小写 |\n| 名称 | 资助项目 | 显示名 |\n\n\`\`\`js\nconst project${i} = { id: ${i}, name: '资助项目' }\n\`\`\`\n\n`
    parts.push(s)
    bytes += enc.encode(s).length
  }
  return parts.join('')
}

function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export async function runSmoke(app: App, bootTimings: Record<string, number> = {}): Promise<SmokeResult> {
  const checks: Record<string, boolean> = {}
  const timings: Record<string, number> = { ...bootTimings, bootMs: Math.round(performance.now()) }
  try {
    const host = app.host
    const dir = `${host.homeDir()}/Library/Caches/app.typoza.mac/smoke`
    await host.mkdir(`${dir}/assets`)
    const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
    await host.writeBase64(`${dir}/assets/form.svg`, b64(sampleSvg('基本信息表单', 1200, 680)))
    await host.writeBase64(`${dir}/assets/id.svg`, b64(sampleSvg('标识符', 400, 240, '#448361')))
    await host.writeBase64(`${dir}/assets/name.svg`, b64(sampleSvg('名称', 400, 240, '#D9730D')))
    await host.writeBase64(`${dir}/assets/anim.gif`, TINY_GIF)
    await host.writeText(`${dir}/smoke.md`, DEMO_MARKDOWN)

    // PRD 质量要求:5MB 文档从发起打开到首屏渲染完成;在其中连续输入的单键耗时(p95);保存耗时
    const big = bigMarkdown(5 * 1024 * 1024)
    await host.writeText(`${dir}/big.md`, big)
    timings.bigBytes = new TextEncoder().encode(big).length
    // 先单独量解析各阶段与建状态找瓶颈,再走真实的打开流程(读盘 + 解析 + 建视图 + 首帧)计总时
    let t = performance.now()
    const parsed = parseMarkdown(big, { inlineMath: true })
    timings.bigParseMs = Math.round(performance.now() - t)
    for (const [k, v] of Object.entries(parseTimings)) timings[`bigParse_${k}`] = v
    t = performance.now()
    createEditorState(parsed.doc, app.env)
    timings.bigStateMs = Math.round(performance.now() - t)
    // PRD 口径「首屏渲染完成、可滚动」= bigOpenMs;其余分段在后台续上,全文载完 = bigLoadedMs
    t = performance.now()
    await app.openFile(`${dir}/big.md`, { replace: true })
    timings.bigOpenSyncMs = Math.round(performance.now() - t)
    await nextFrame()
    timings.bigOpenMs = Math.round(performance.now() - t)
    while (app.loading) await new Promise((r) => setTimeout(r, 50))
    timings.bigLoadedMs = Math.round(performance.now() - t)
    checks.bigDocLoaded = app.view.state.doc.childCount > 10000
    const view = app.view
    view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(view.state.doc.child(0).nodeSize - 1))))
    // 单键耗时分两段:事务(状态 + 插件 + 视图更新)与之后的强制排版
    const samples: number[] = []
    const dispatchSamples: number[] = []
    for (let i = 0; i < 60; i++) {
      const s0 = performance.now()
      view.dispatch(view.state.tr.insertText('字'))
      const s1 = performance.now()
      void view.dom.getBoundingClientRect().height // 强制排版,计入上屏前的布局
      dispatchSamples.push(s1 - s0)
      samples.push(performance.now() - s0)
    }
    timings.bigInputDispatchP95Ms = Math.round(percentile(dispatchSamples, 95) * 10) / 10
    timings.bigInputP95Ms = Math.round(percentile(samples, 95) * 10) / 10
    timings.bigInputMaxMs = Math.round(Math.max(...samples) * 10) / 10
    t = performance.now()
    checks.bigSaved = await app.save()
    timings.bigSaveMs = Math.round(performance.now() - t)

    // 从大文档换到小文档:含拆除大文档的耗时
    const t0 = performance.now()
    await app.openFile(`${dir}/smoke.md`, { replace: true })
    timings.openMs = Math.round(performance.now() - t0)
    checks.documentLoaded = app.view.state.doc.textContent.includes('资助项目')

    const tableImg = document.querySelector<HTMLImageElement>('.tz-editor table .tz-image img')
    checks.tableImageRendered = Boolean(tableImg)
    checks.tableImageLoaded = await until(() => Boolean(tableImg?.complete && tableImg.naturalWidth > 0), 5000)

    tableImg?.closest('.tz-image')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    checks.lightboxOpened = await until(() => Boolean(document.querySelector('.tz-lightbox')), 2000)
    const lbImg = document.querySelector<HTMLImageElement>('.tz-lightbox .tz-lb-img')
    checks.lightboxImageLoaded = await until(() => Boolean(lbImg && lbImg.naturalWidth > 0 && !lbImg.hidden), 5000)
    checks.lightboxCounter = (document.querySelector('.tz-lb-counter')?.textContent ?? '').includes('/')

    // 保存往返:未编辑的文档写回后与原文逐字相同
    checks.roundTrip = app.markdown() === DEMO_MARKDOWN

    // 云同步链路:网页 → 外壳 → 辅助进程 → 返回;全新环境下应为未登录
    const t1 = performance.now()
    const sync = await host.syncCall<{ signedIn: boolean; vaults: unknown[] }>('sync.status')
    timings.syncStatusMs = Math.round(performance.now() - t1)
    checks.syncHelper = sync.signedIn === false && Array.isArray(sync.vaults)

    await imageCopyCheck(app, checks)
    await exportChecks(app, dir, checks, timings)
    await encodingCheck(app, dir, checks)
  } catch (err) {
    return { ok: false, checks, timings, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) }
  }
  return { ok: Object.values(checks).every(Boolean), checks, timings }
}

/** 拷贝图片(对照表 E-03):选中动图执行「拷贝图片」,外壳把图像数据放进系统剪贴板(外壳自检 nativeChecks.copyImage 读回核对)。 */
async function imageCopyCheck(app: App, checks: Record<string, boolean>): Promise<void> {
  const view = app.view
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at < 0 && node.type.name === 'image' && String(node.attrs.src).includes('anim.gif')) at = pos
    return at < 0
  })
  checks.copyImageCommand = at >= 0
  if (at < 0) return
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)))
  checks.copyImageCommand = runCommand(view, 'image.copy')
  // 命令是异步的:等外壳回执(下一步导出不能抢在它前面改剪贴板,导出本身不碰剪贴板)
  await wait(500)
}

/** 导出格式与文件扩展名(对照表 F-22 ~ F-34);Pandoc 格式需要 CI 机装好 Pandoc。 */
const EXPORTS: [string, string][] = [
  ['html', 'html'],
  ['html-plain', 'html'],
  ['pdf', 'pdf'],
  ['image', 'png'],
  ['docx', 'docx'],
  ['odt', 'odt'],
  ['rtf', 'rtf'],
  ['epub', 'epub'],
  ['latex', 'tex'],
  ['mediawiki', 'wiki'],
  ['rst', 'rst'],
  ['textile', 'textile'],
  ['opml', 'opml'],
]
/** 纯文本产物:读回核对正文在里面(RTF 把中文写成 \uNNNN 转义,只核对文件头) */
const TEXT_EXPORTS = new Set(['html', 'html-plain', 'latex', 'mediawiki', 'rst', 'textile', 'opml'])

/**
 * 导出(对照表 F-22 ~ F-34、PX-02、PX-04、PX-06)与导入(F-21):走真实流程(网页拼 HTML 与参数 → 外壳离屏渲染 / Pandoc),
 * 只把保存框换成固定路径。PDF 纸张与页首、PNG 像素宽度由外壳自检用 PDFKit / NSImage 读回核对(nativeChecks.exportPdf / exportPng)。
 */
async function exportChecks(app: App, dir: string, checks: Record<string, boolean>, timings: Record<string, number>): Promise<void> {
  const host = app.host
  const out = `${dir}/out`
  await host.mkdir(out)
  // PX-04:A5 + 页首变量;PX-06:宽 600、质量「高」(2 倍)→ 1200 像素宽;PX-02:Pandoc 路径留空 = 自动检测
  await app.updateSettings({ exportPdfPaper: 'A5', exportPdfHeader: '页首 ${pageNo}', exportImageWidth: 600, exportImageQuality: 'high', exportAfter: 'none', pandocPath: '' })
  let target = ''
  const saveDialog = host.saveDialog
  host.saveDialog = async () => target
  try {
    for (const [format, ext] of EXPORTS) {
      target = `${out}/smoke-${format}.${ext}`
      const t = performance.now()
      // exportAs 是私有方法:冒烟要走与菜单同一条导出流程
      await app['exportAs'](format)
      timings[`export_${format}Ms`] = Math.round(performance.now() - t)
      const st = await host.stat(target)
      let ok = Boolean(st && st.size > 0)
      if (ok && TEXT_EXPORTS.has(format)) ok = (await host.readText(target)).text.includes('资助项目')
      if (ok && format === 'rtf') ok = (await host.readText(target)).text.startsWith('{\\rtf')
      checks[`export_${format}`] = ok
    }
  } finally {
    host.saveDialog = saveDialog
  }
  // PX-02 指定可执行文件:填上 Pandoc 的实际路径再导入(F-21:把刚导出的 docx 导回 Markdown)
  const which = await host.runCommand('command -v pandoc', null)
  await app.updateSettings({ pandocPath: which.output.trim() })
  try {
    const md = await host.importDocument(`${out}/smoke-docx.docx`)
    checks.importDocx = md.endsWith('.md') && (await host.readText(md)).text.includes('资助项目')
  } finally {
    await app.updateSettings({ pandocPath: '' })
  }
}

/** 选择编码重新打开(对照表 F-41):Big5 文件按自动识别会被当成 GB18030 读乱,指定 big5 后正确;改动保存后仍是 Big5。 */
async function encodingCheck(app: App, dir: string, checks: Record<string, boolean>): Promise<void> {
  const host = app.host
  const path = `${dir}/繁體.md`
  await host.writeText(path, '# 繁體中文\n\n資料內容\n', 'big5')
  await app.openFile(path, { replace: true, encoding: 'big5' })
  const view = app.view
  checks.encodingReopen = view.state.doc.textContent.includes('資料內容')
  view.dispatch(view.state.tr.insertText('追加', view.state.doc.content.size - 1))
  await app.save()
  const back = await host.readText(path, 'big5')
  checks.encodingSaved = back.text.includes('資料內容追加')
}
