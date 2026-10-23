import { describe, expect, it } from 'vitest'
import { Schema } from 'prosemirror-model'

describe('单测环境', () => {
  it('ProseMirror 可在 jsdom 中构建文档', () => {
    const schema = new Schema({ nodes: { doc: { content: 'text*' }, text: {} } })
    expect(schema.node('doc', null, [schema.text('ok')]).textContent).toBe('ok')
  })
})
