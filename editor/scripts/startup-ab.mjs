// 启动对比(perf 工作流用):同一台机器、同一次运行里,把基准提交与当前代码各构建一份生产包,
// 轮流在 Chromium 与 WebKit 里冷启动(每次新开浏览器上下文,没有缓存),量从导航到编辑器就绪,取中位数;
// 另统计两份包启动时要下载的脚本(入口 + 预载)体积。
// 为什么要同机同次:同一份代码换一台 CI 机器,冷启动中位数能差一半(258 / 163 毫秒),跨运行的数字不能直接比。
// 用法(在 editor/ 下,需要完整 git 历史):node scripts/startup-ab.mjs <基准提交> <输出目录>
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { chromium, webkit } from '@playwright/test'

const [base, out] = process.argv.slice(2)
if (!base || !/^[0-9a-f]{7,40}$/.test(base) || !out) throw new Error('用法:node scripts/startup-ab.mjs <基准提交(十六进制)> <输出目录>')
mkdirSync(out, { recursive: true })
const here = process.cwd()
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

// 两边依赖必须相同:基准那份直接借用当前的 node_modules
try {
  execFileSync('git', ['diff', '--quiet', base, 'HEAD', '--', 'package.json', 'package-lock.json'])
} catch {
  throw new Error(`基准提交 ${base} 的依赖与当前不同,不能共用 node_modules`)
}
const head = git('rev-parse', 'HEAD')
const baseDir = join(mkdtempSync(join(tmpdir(), 'tz-ab-')), 'editor')
// git archive 的路径按仓库根算,在 editor/ 的上一级执行
execFileSync('bash', ['-c', `git -C "${resolve(here, '..')}" archive --format=tar ${base} editor | tar -x -C "${resolve(baseDir, '..')}"`])
symlinkSync(resolve(here, 'node_modules'), join(baseDir, 'node_modules'))

const builds = [
  { name: '基准', ref: git('rev-parse', '--short', base), cwd: baseDir, outDir: join(baseDir, 'dist-ab'), port: 5181 },
  { name: '当前', ref: head.slice(0, 7), cwd: here, outDir: join(here, 'dist-ab'), port: 5182 },
]
for (const b of builds) {
  log('构建', b.name, b.ref)
  execFileSync('npx', ['vite', 'build', '--outDir', b.outDir, '--emptyOutDir'], { cwd: b.cwd, stdio: 'inherit' })
}

/** 启动时要下载的脚本:index.html 里的入口与 modulepreload */
function startupScripts(outDir) {
  const html = readFileSync(join(outDir, 'index.html'), 'utf8')
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g), ...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1])
  let raw = 0
  let gz = 0
  for (const src of new Set(srcs)) {
    const file = join(outDir, src.replace(/^\.?\//, ''))
    raw += statSync(file).size
    gz += gzipSync(readFileSync(file)).length
  }
  return { files: new Set(srcs).size, kb: Math.round(raw / 1024), gzipKb: Math.round(gz / 1024) }
}

// 每个预览服务单独成进程组:只杀 npx 时 vite 子进程还占着 CI 的 tee 管道
const servers = builds.map((b) => spawn('npx', ['vite', 'preview', '--outDir', b.outDir, '--port', String(b.port), '--strictPort'], { cwd: b.cwd, stdio: ['ignore', 'pipe', 'inherit'], detached: true }))
process.on('exit', () => {
  for (const s of servers) {
    try {
      process.kill(-s.pid, 'SIGTERM')
    } catch {
      // 进程组已经退出
    }
  }
})
await Promise.all(
  servers.map(
    (s, i) =>
      new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`${builds[i].name}的预览服务 60 秒内没起来`)), 60_000)
        s.stdout.on('data', (d) => {
          if (String(d).includes(String(builds[i].port))) {
            clearTimeout(timer)
            ok()
          }
        })
      }),
  ),
)

async function coldLoad(browser, port) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await ctx.newPage()
  const t = Date.now()
  await page.goto(`http://localhost:${port}/`)
  await page.waitForSelector('html[data-ready="true"]', { timeout: 60_000 })
  const ms = Date.now() - t
  await ctx.close()
  return ms
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

const ROUNDS = 11
const result = { head, base: builds[0].ref, scripts: builds.map((b) => ({ name: b.name, ref: b.ref, ...startupScripts(b.outDir) })), browsers: {} }
for (const [label, type] of [
  ['Chromium', chromium],
  ['WebKit', webkit],
]) {
  const browser = await type.launch()
  try {
    // 各先热身一次(浏览器进程与磁盘缓存),不计
    for (const b of builds) await coldLoad(browser, b.port)
    const runs = builds.map(() => [])
    // 轮流量,每轮交换先后,抵消先后顺序的影响
    for (let r = 0; r < ROUNDS; r++) {
      const order = r % 2 ? [1, 0] : [0, 1]
      for (const i of order) runs[i].push(await coldLoad(browser, builds[i].port))
    }
    result.browsers[label] = builds.map((b, i) => ({ name: b.name, medianMs: median(runs[i]), runs: runs[i] }))
    log(label, result.browsers[label].map((x) => `${x.name} 中位 ${x.medianMs} 毫秒`).join(','))
  } finally {
    await browser.close()
  }
}

writeFileSync(join(out, 'startup-ab.json'), JSON.stringify(result, null, 2))
const lines = [
  `# 启动对比(同一台机器、同一次运行)`,
  '',
  `当前 ${head.slice(0, 7)},基准 ${result.base};每种浏览器各 ${ROUNDS} 轮冷启动(新上下文、无缓存),量导航到编辑器就绪。`,
  '',
  '| 浏览器 | 基准中位(毫秒) | 当前中位(毫秒) | 变化 | 基准各次 | 当前各次 |',
  '|---|---|---|---|---|---|',
  ...Object.entries(result.browsers).map(([label, [a, b]]) => `| ${label} | ${a.medianMs} | ${b.medianMs} | ${Math.round(((b.medianMs - a.medianMs) / a.medianMs) * 100)}% | ${a.runs.join(' / ')} | ${b.runs.join(' / ')} |`),
  '',
  '| 构建 | 提交 | 启动时下载的脚本 | 体积 KB | gzip KB |',
  '|---|---|---|---|---|',
  ...result.scripts.map((s) => `| ${s.name} | ${s.ref} | ${s.files} 个 | ${s.kb} | ${s.gzipKb} |`),
]
writeFileSync(join(out, 'startup-ab.md'), lines.join('\n') + '\n')
log('写好', join(out, 'startup-ab.md'))
process.exit(0)
