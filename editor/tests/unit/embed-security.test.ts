import { describe, expect, it } from 'vitest'
import { type EditorEnv, frameSandbox, resourceUrl } from '../../src/core/env'
import { isPdfSource } from '../../src/core/schema'
import { parseMarkdown } from '../../src/core/markdown/parse'
import { createMemoryHost } from '../../src/host/memory'

// 嵌入内容隔离(PRD 3.5「嵌入内容隔离运行、读不到本地文件」):本地网页不能拿到 typoza://local 的源,
// 不认的协议不能进嵌入框(javascript: 会以编辑器自己的源执行)。

const env = (path: string | null) => ({ host: createMemoryHost(), ctx: { path, rootUrl: null } }) as unknown as EditorEnv

describe('嵌入框沙箱', () => {
  it('只有远程网页给同源', () => {
    expect(frameSandbox('https://www.youtube.com/embed/x')).toContain('allow-same-origin')
    for (const url of ['typoza://local/Users/a/x.html', 'x.html', 'data:text/html,<p>1</p>', 'blob:typoza://app/1', '']) {
      expect(frameSandbox(url)).not.toContain('allow-same-origin')
      expect(frameSandbox(url)).toContain('allow-scripts')
    }
  })

  it('PDF 只看路径:x.html#.pdf 不算 PDF(否则绕开沙箱)', () => {
    expect(isPdfSource('a.pdf')).toBe(true)
    expect(isPdfSource('https://x.com/a.PDF#page=2')).toBe(true)
    expect(isPdfSource('a.pdf?v=1')).toBe(true)
    expect(isPdfSource('x.html#.pdf')).toBe(false)
    expect(isPdfSource('x.html?.pdf')).toBe(false)
  })

  it('文档里写的 iframe 按路径归类', () => {
    const kinds: string[] = []
    parseMarkdown('<iframe src="x.html#.pdf"></iframe>\n\n<iframe src="a.pdf"></iframe>\n', { inlineMath: true }).doc.descendants((n) => {
      if (n.type.name === 'media') kinds.push(n.attrs.kind as string)
    })
    expect(kinds).toEqual(['embed', 'pdf'])
  })
})

describe('资源地址的协议', () => {
  it('不认的协议给空串,未保存的文档也一样', () => {
    for (const path of [null, '/notes/a.md']) {
      expect(resourceUrl(env(path), 'javascript:alert(1)')).toBe('')
      expect(resourceUrl(env(path), 'JavaScript:alert(1)')).toBe('')
      expect(resourceUrl(env(path), 'vbscript:x')).toBe('')
    }
  })

  it('网址、data、blob 原样;相对路径走本机', () => {
    expect(resourceUrl(env(null), 'https://a.com/x.png')).toBe('https://a.com/x.png')
    expect(resourceUrl(env(null), 'data:image/png;base64,AA')).toBe('data:image/png;base64,AA')
    expect(resourceUrl(env('/notes/a.md'), 'img/x.png')).not.toBe('img/x.png')
  })
})
