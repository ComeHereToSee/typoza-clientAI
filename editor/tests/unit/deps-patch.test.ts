import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// scripts/patch-deps.mjs 在 npm 安装时修补依赖;这里确认补丁真的落到了会被打包的文件上
describe('依赖性能补丁', () => {
  it('GFM 表格解析不再复制未改动的事件前缀', () => {
    for (const file of ['lib/edit-map.js', 'dev/lib/edit-map.js']) {
      const code = readFileSync(resolve(process.cwd(), 'node_modules/micromark-extension-gfm-table', file), 'utf8')
      expect(code).toContain('[typoza 补丁]')
      expect(code).not.toContain('vecs.push(events.slice())')
    }
  })

  it('文档分词器关容器时不再复制整篇事件前缀(micromark-util-edit-map)', () => {
    for (const file of ['index.js', 'dev/index.js']) {
      const code = readFileSync(resolve(process.cwd(), 'node_modules/micromark-util-edit-map', file), 'utf8')
      expect(code).toContain('[typoza 补丁]')
      expect(code).not.toContain('vecs.push(events.slice())')
    }
  })
})
