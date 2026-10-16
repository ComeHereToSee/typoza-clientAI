// CI 用的大文档性能剖析:构建一份不压缩的生产版(与打包进应用的代码一致,函数名保真)并 preview → Chromium 打开编辑器 →
// 分阶段(解析 / 打开并渲染 / 连续输入 / 切回小文档)计时,并用 CDP 采样剖析器统计每阶段的函数自耗时 Top。
// 用法:node scripts/perf-profile.mjs <输出目录>
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, webkit } from '@playwright/test'

const out = process.argv[2]
if (!out) throw new Error('需要输出目录参数')
mkdirSync(out, { recursive: true })
const PORT = 5175

/** 与 src/smoke.ts 的 bigMarkdown 相同的混排文档(约 target 字节)。 */
function bigMarkdown(target) {
  const enc = new TextEncoder()
  const parts = []
  let bytes = 0
  for (let i = 1; bytes < target; i++) {
    let s = `## 第 ${i} 节 · 资助项目配置\n\n左栏「对象类型」→ 右上「新建对象类型」,填完点右上「保存并生效」。**加粗**、*斜体*、\`代码\` 与 [链接](https://example.com/${i}) 混排,用于测试大文件的打开与输入。\n\n- 唯一标识符:aid_project_${i}\n- 名称:资助项目 ${i}\n- [ ] 待办事项 ${i}\n\n> 第 ${i} 节的引用段落。\n\n`
    if (i % 10 === 0) s += `| 配置项 | 填什么 | 说明 |\n| --- | --- | --- |\n| 唯一标识符 | \`aid_${i}\` | 英文小写 |\n| 名称 | 资助项目 | 显示名 |\n\n\`\`\`js\nconst project${i} = { id: ${i}, name: '资助项目' }\n\`\`\`\n\n`
    parts.push(s)
    bytes += enc.encode(s).length
  }
  return parts.join('')
}

/** CDP 剖析结果 → 按函数聚合的自耗时与含子调用耗时(毫秒),各取前 n 名。 */
function summarize(profile, n = 40) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const c of node.children ?? []) parent.set(c, node.id)
  const selfUs = new Map()
  profile.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)))
  const keyOf = (node) => {
    const f = node.callFrame
    const url = f.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
    return `${f.functionName || '(匿名)'} ${url}:${f.lineNumber + 1}`
  }
  const self = new Map()
  const total = new Map()
  for (const [id, us] of selfUs) {
    const node = byId.get(id)
    if (!node) continue
    const k = keyOf(node)
    self.set(k, (self.get(k) ?? 0) + us)
    // 含子调用耗时:沿祖先链给每个函数记一次(递归只记一次)
    const seen = new Set()
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const ck = keyOf(byId.get(cur))
      if (seen.has(ck)) continue
      seen.add(ck)
      total.set(ck, (total.get(ck) ?? 0) + us)
    }
  }
  const top = (m) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, us]) => ({ fn: k, ms: Math.round(us / 100) / 10 }))
  return { self: top(self), total: top(total) }
}

/** 打包文件里模块标记(`//#region node_modules/…` 或 `src/…`)对应的包名 / 源码目录。 */
function moduleGroup(path) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)
  if (m) return m[1]
  return path.split('/').slice(0, 2).join('/')
}

/** V8 覆盖率 → 每个脚本启动时执行过的字节,并按模块标记分组,看启动时加载了却没执行的大头。 */
function coverageReport(entries) {
  const scripts = []
  const groups = new Map()
  for (const e of entries) {
    if (!e.url.includes('/assets/') || !e.source) continue
    const used = new Uint8Array(e.source.length)
    // 外层范围先填、内层后填覆盖(V8 的块覆盖是嵌套的)
    const ranges = e.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset)
    for (const r of ranges) used.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset)
    let usedBytes = 0
    for (const b of used) usedBytes += b
    scripts.push({ script: e.url.replace(/^https?:\/\/[^/]+/, ''), kb: Math.round(e.source.length / 1024), usedKb: Math.round(usedBytes / 1024) })
    const re = /^\/\/(?:#region)? ?((?:\.\.\/)*node_modules\/\S+|src\/\S+)/gm
    let name = '(未标记)'
    let start = 0
    const flush = (end) => {
      let u = 0
      for (let i = start; i < end; i++) u += used[i]
      const g = groups.get(name) ?? { bytes: 0, used: 0 }
      g.bytes += end - start
      g.used += u
      groups.set(name, g)
    }
    for (let m = re.exec(e.source); m; m = re.exec(e.source)) {
      flush(m.index)
      name = moduleGroup(m[1])
      start = m.index
    }
    flush(e.source.length)
  }
  const modules = [...groups.entries()]
    .map(([name, g]) => ({ module: name, kb: Math.round(g.bytes / 1024), unusedKb: Math.round((g.bytes - g.used) / 1024) }))
    .sort((a, b) => b.unusedKb - a.unusedKb)
    .slice(0, 30)
  return { scripts, modules }
}

// 开发服务器会走依赖的 development 构建(micromark 带断言与 debug),剖析结果失真;这里用生产构建
await new Promise((resolve, reject) => {
  const build = spawn('npx', ['vite', 'build', '--minify', 'false', '--outDir', 'dist-perf'], { stdio: 'inherit' })
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`构建失败:${code}`))))
})
// 单独成进程组:npx 拉起的 vite 子进程继承了标准错误,只杀 npx 时它还占着 CI 的 tee 管道,步骤会一直等到超时
const server = spawn('npx', ['vite', 'preview', '--outDir', 'dist-perf', '--port', String(PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
const stopServer = () => {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    // 进程组已经退出
  }
}
process.on('exit', stopServer)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Vite 开发服务器 60 秒内没起来')), 60_000)
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(timer)
      resolve()
    }
  })
})

const report = { scaling: [], scalingWebkit: [], startup: {}, phases: {}, profiles: {}, hotSource: {} }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
function writeReport() {
  writeFileSync(join(out, 'perf.json'), JSON.stringify(report, null, 2))
  const lines = [`# 大文档性能剖析(Chromium,不压缩的生产构建)`, '', '## 规模与耗时', '', '```json', JSON.stringify(report.scaling, null, 2), '```', '', `剖析文档 ${report.bytes} 字节,${report.blocks} 个顶层块`, '', '```json', JSON.stringify(report.phases, null, 2), '```']
  lines.push('', '## WebKit 规模与耗时', '', '```json', JSON.stringify(report.scalingWebkit, null, 2), '```')
  if (report.startup.scripts) {
    lines.push('', `## 启动 · 到编辑器就绪 ${report.startup.readyMs} 毫秒`, '', '| 脚本 | KB | 启动时执行过 KB |', '|---|---|---|', ...report.startup.scripts.map((x) => `| ${x.script} | ${x.kb} | ${x.usedKb} |`))
    lines.push('', '## 启动 · 加载了没执行的模块 Top', '', '| 模块 | KB | 没执行 KB |', '|---|---|---|', ...report.startup.modules.map((x) => `| ${x.module} | ${x.kb} | ${x.unusedKb} |`))
  }
  for (const [fn, src] of Object.entries(report.hotSource)) {
    lines.push('', `## 热点源码 · ${fn}`, '', `所属:${src.origin || '未识别'}`, '', '```js', src.code, '```')
  }
  for (const [name, p] of Object.entries(report.profiles)) {
    lines.push('', `## ${name} · 自耗时 Top`, '', '| 毫秒 | 函数 |', '|---|---|', ...p.self.map((x) => `| ${x.ms} | ${x.fn} |`))
    lines.push('', `## ${name} · 含子调用 Top`, '', '| 毫秒 | 函数 |', '|---|---|', ...p.total.slice(0, 25).map((x) => `| ${x.ms} | ${x.fn} |`))
  }
  writeFileSync(join(out, 'perf.md'), `${lines.join('\n')}\n`)
}

// 解析与打开都在页面里计时;size 档位用来看耗时随文档大小怎么增长(线性还是平方)
const measure = (page, size, path) =>
  page.evaluate(
    async ({ text, path }) => {
      const t0 = performance.now()
      const { doc } = window.typozaTest.parse(text, { inlineMath: true })
      const parseMs = performance.now() - t0
      window.typozaTest.host.files.set(path, { kind: 'file', data: text, mtime: Date.now() })
      const t1 = performance.now()
      await window.typozaTest.app.openFile(path, { replace: true })
      await new Promise((r) => requestAnimationFrame(() => r()))
      const openMs = performance.now() - t1
      // 大文档分段载入:等全文载完(最多 3 分钟,载不完记为 -1,别让整个剖析挂住)
      while (window.typozaTest.app.loading && performance.now() - t1 < 180_000) await new Promise((r) => setTimeout(r, 20))
      const loadedMs = window.typozaTest.app.loading ? -1 : performance.now() - t1
      const t2 = performance.now()
      await window.typozaTest.load('# 小文档\n\n一段话。\n')
      const closeMs = performance.now() - t2
      return { blocks: doc.childCount, parseMs: Math.round(parseMs), openMs: Math.round(openMs), loadedMs: Math.round(loadedMs), closeMs: Math.round(closeMs) }
    },
    { text: bigMarkdown(size), path },
  )

const browser = await chromium.launch()
try {
  // 启动:从导航到编辑器就绪的 CPU 剖析与脚本覆盖率(冷启动 ≤1 秒的 JS 一侧)
  {
    const sp = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const scdp = await sp.context().newCDPSession(sp)
    await scdp.send('Profiler.enable')
    await scdp.send('Profiler.setSamplingInterval', { interval: 200 })
    await sp.coverage.startJSCoverage({ resetOnNavigation: false })
    await scdp.send('Profiler.start')
    const t = Date.now()
    await sp.goto(`http://localhost:${PORT}/`)
    await sp.waitForSelector('html[data-ready="true"]', { timeout: 120_000 })
    report.startup.readyMs = Date.now() - t
    const { profile } = await scdp.send('Profiler.stop')
    report.profiles['启动'] = summarize(profile)
    Object.assign(report.startup, coverageReport(await sp.coverage.stopJSCoverage()))
    report.startup.marks = await sp.evaluate(() => performance.getEntriesByType('mark').map((m) => ({ name: m.name, ms: Math.round(m.startTime) })))
    await sp.close()
    log('启动剖析完成', report.startup.readyMs, 'ms')
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.setDefaultTimeout(600_000)
  await page.goto(`http://localhost:${PORT}/`)
  await page.waitForSelector('html[data-ready="true"]', { timeout: 120_000 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
  const profiled = async (name, fn) => {
    await cdp.send('Profiler.start')
    const result = await fn()
    const { profile } = await cdp.send('Profiler.stop')
    report.profiles[name] = summarize(profile)
    log('剖析完成', name)
    return result
  }

  for (const kb of [256, 512, 1024, 2048, 5120]) {
    const r = await measure(page, kb * 1024, `/demo/size-${kb}.md`)
    report.scaling.push({ kb, ...r })
    log('档位', kb, 'KB', JSON.stringify(r))
  }
  const md = bigMarkdown(1024 * 1024)
  report.bytes = Buffer.byteLength(md)
  await page.evaluate((text) => {
    window.__bigMd = text
  }, md)
  report.phases.parseMs = await profiled('解析', () =>
    page.evaluate(() => {
      const t = performance.now()
      const { doc } = window.typozaTest.parse(window.__bigMd, { inlineMath: true })
      window.__bigBlocks = doc.childCount
      return Math.round(performance.now() - t)
    }),
  )
  report.blocks = await page.evaluate(() => window.__bigBlocks)
  report.phases.openMs = await profiled('打开并渲染', () =>
    page.evaluate(async () => {
      window.typozaTest.host.files.set('/demo/big.md', { kind: 'file', data: window.__bigMd, mtime: Date.now() })
      const t = performance.now()
      await window.typozaTest.app.openFile('/demo/big.md', { replace: true })
      await new Promise((r) => requestAnimationFrame(() => r()))
      const first = Math.round(performance.now() - t)
      while (window.typozaTest.app.loading && performance.now() - t < 180_000) await new Promise((r) => setTimeout(r, 20))
      return { firstScreen: first, loaded: window.typozaTest.app.loading ? -1 : Math.round(performance.now() - t) }
    }),
  )
  report.phases.input = await profiled('连续输入', () =>
    page.evaluate(() => {
      const view = window.typozaTest.app.view
      // 分两段计:事务(状态 + 插件 + 视图更新)与之后强制布局,看延迟落在哪一侧
      const total = []
      const dispatch = []
      for (let i = 0; i < 40; i++) {
        const t = performance.now()
        view.dispatch(view.state.tr.insertText('字', 3))
        const t1 = performance.now()
        void view.dom.getBoundingClientRect().height
        dispatch.push(t1 - t)
        total.push(performance.now() - t)
      }
      const stat = (xs) => {
        xs.sort((a, b) => a - b)
        return { p50: Math.round(xs[20] * 10) / 10, p95: Math.round(xs[37] * 10) / 10, max: Math.round(xs[39] * 10) / 10 }
      }
      return { total: stat(total), dispatch: stat(dispatch) }
    }),
  )
  report.phases.switchBackMs = await profiled('切回小文档', () =>
    page.evaluate(async () => {
      const t = performance.now()
      await window.typozaTest.load('# 小文档\n\n一段话。\n')
      return Math.round(performance.now() - t)
    }),
  )
  // 解析阶段自耗时前 6 名的源码片段(打包文件不压缩,按行号截取),确认热点到底是哪个依赖里的函数
  const sources = new Map()
  for (const item of report.profiles['解析']?.self.slice(0, 6) ?? []) {
    const m = /^(.*) (\/assets\/[^:]+):(\d+)$/.exec(item.fn)
    if (!m) continue
    const [, , url, lineText] = m
    if (!sources.has(url)) sources.set(url, (await (await fetch(`http://localhost:${PORT}${url}`)).text()).split('\n'))
    const lines = sources.get(url)
    const line = Number(lineText)
    // 往前找最近的模块注释或文件路径标记,便于认出所属依赖
    let origin = ''
    for (let i = line - 1; i >= 0 && i > line - 4000; i--) {
      const hit = /^\/\/(?:#region)? ?((?:\.\.\/)*node_modules\/\S+|src\/\S+)/.exec(lines[i])
      if (hit) {
        origin = hit[1]
        break
      }
    }
    report.hotSource[item.fn] = { origin, code: lines.slice(Math.max(0, line - 3), line + 12).join('\n') }
  }
} finally {
  await browser.close()
}

writeReport()

// 同样的流程在 WebKit(与应用同内核的 JavaScriptCore)上只计时,看是否超线性;每档限时,超时就停在那一档
{
  const wk = await webkit.launch()
  try {
    const wpage = await wk.newPage({ viewport: { width: 1280, height: 860 } })
    await wpage.goto(`http://localhost:${PORT}/`)
    await wpage.waitForSelector('html[data-ready="true"]', { timeout: 120_000 })
    for (const kb of [64, 128, 256, 512, 1024, 2048, 5120]) {
      const started = Date.now()
      const r = await Promise.race([
        measure(wpage, kb * 1024, `/demo/wk-${kb}.md`),
        new Promise((resolve) => setTimeout(() => resolve(null), 240_000)),
      ])
      if (!r) {
        report.scalingWebkit.push({ kb, timeout: true, waitedMs: Date.now() - started })
        log('WebKit 档位', kb, 'KB 超时')
        break
      }
      report.scalingWebkit.push({ kb, ...r })
      log('WebKit 档位', kb, 'KB', JSON.stringify(r))
    }
  } finally {
    await wk.close()
    stopServer()
  }
}
writeReport()
console.log(JSON.stringify(report.phases))
// 显式退出:还有未结束的句柄时 node 不会自己退
process.exit(0)
