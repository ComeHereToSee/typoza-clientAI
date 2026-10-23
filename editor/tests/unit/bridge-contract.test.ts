import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// 网页经桥接调用的方法(host/native.ts 的 call('…'))在外壳的分发(DocumentWindowController 的 switch)里各有且只有一个分支。
// 两个分支同名时 Swift 只走第一个:曾有「下载到」与「下载并覆盖」同名、参数名不同,复制网络图片到文件夹必失败。
// 测试在 editor/ 下跑
const shellDir = resolve(process.cwd(), '../app/Sources/Typoza')

function webMethods(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'src/host/native.ts'), 'utf8')
  return [...new Set([...source.matchAll(/call(?:<[^>]*>)?\('([^']+)'/g)].map((m) => m[1]))]
}

function shellCases(): string[] {
  const source = readdirSync(shellDir)
    .filter((f) => f.startsWith('DocumentWindowController') && f.endsWith('.swift'))
    .map((f) => readFileSync(resolve(shellDir, f), 'utf8'))
    .join('\n')
  return [...source.matchAll(/case\s+((?:"[^"]+"\s*,\s*)*"[^"]+")\s*:/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]))
}

describe('桥接契约', () => {
  it('网页调用的每个方法,外壳都恰好有一个分支', () => {
    const cases = shellCases()
    const count = (m: string) => cases.filter((c) => c === m).length
    const methods = webMethods()
    expect(methods.length).toBeGreaterThan(40)
    expect(methods.filter((m) => count(m) !== 1).map((m) => `${m} × ${count(m)}`)).toEqual([])
  })
})
