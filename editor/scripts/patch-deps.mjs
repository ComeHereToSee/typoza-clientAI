// npm 安装后(postinstall)修补依赖里的性能问题:直接改 node_modules 里指定文件的指定片段。
// 片段对不上就失败退出,防止依赖升级后补丁静默失效;已经修补过的跳过(重复安装安全)。
// 构建期插件对 node_modules 不可靠(Vite 8 构建时不经插件转换依赖文件),所以放在安装阶段。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 依赖的 exports 不开放子路径,按 node_modules 目录直接定位
const modules = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules')

const PATCHES = [
  {
    // micromark-extension-gfm-table 2.1.2:EditMap.consume 把第一处修改之前的全部事件复制一遍再塞回去;
    // 这段前缀根本没变,不必复制(对很长的事件数组反复调用时,复制是主要耗时)。
    file: 'micromark-extension-gfm-table/lib/edit-map.js',
    before: '    vecs.push(events.slice());\n    events.length = 0;\n    let slice = vecs.pop();',
    after: '    // [typoza 补丁] 不复制未改动的前缀\n    let slice = vecs.pop();',
  },
  {
    // 同一处的开发版(Vite 开发服务器与带 development 条件的运行环境会用到)
    file: 'micromark-extension-gfm-table/dev/lib/edit-map.js',
    before: '    vecs.push(events.slice())\n    events.length = 0\n\n    let slice = vecs.pop()',
    after: '    // [typoza 补丁] 不复制未改动的前缀\n    let slice = vecs.pop()',
  },
  {
    // micromark-util-edit-map 1.0.0(上面那份的独立包版本):micromark 的文档分词器每关一次容器(列表、引用)
    // 都对「整篇到目前为止的事件」调用 consume,同样复制整个前缀,整篇解析成了平方级(剖析热点,5MB 约 50 秒)
    file: 'micromark-util-edit-map/index.js',
    before: '    vecs.push(events.slice());\n    events.length = 0;\n    let slice = vecs.pop();',
    after: '    // [typoza 补丁] 不复制未改动的前缀\n    let slice = vecs.pop();',
  },
  {
    file: 'micromark-util-edit-map/dev/index.js',
    before: '    vecs.push(events.slice())\n    events.length = 0\n\n    let slice = vecs.pop()',
    after: '    // [typoza 补丁] 不复制未改动的前缀\n    let slice = vecs.pop()',
  },
]

for (const p of PATCHES) {
  const path = join(modules, p.file)
  const code = readFileSync(path, 'utf8')
  if (code.includes(p.after)) continue
  if (!code.includes(p.before)) {
    console.error(`依赖补丁对不上:${path} 的内容与预期不符,依赖可能已升级,请复核 scripts/patch-deps.mjs`)
    process.exit(1)
  }
  writeFileSync(path, code.replace(p.before, p.after))
  console.log(`已修补 ${p.file}`)
}
