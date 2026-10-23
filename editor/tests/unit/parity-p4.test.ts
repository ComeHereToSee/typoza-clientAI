// 对照表第 4 部分(X 区)缺用例的规则层:命名锚点(X-09)、绝对路径链接(X-10)、尖括号邮箱(X-12)、
// 引用式链接与图片(X-13)、YAML 里的图片根路径与插图目录(X-20、X-21)、导出变量取值(X-23)。
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView } from 'prosemirror-view'
import { describe, expect, it } from 'vitest'
import { shouldUpload, targetFolder } from '../../src/app/assets'
import { frontMatterInfo } from '../../src/app/document'
import { type ExportContext, expandVariables, exportVariables } from '../../src/app/export-flow'
import { resolveLinkTarget } from '../../src/app/navigation'
import { DEFAULT_SETTINGS } from '../../src/app/settings'
import { findAnchor } from '../../src/core/links'
import { parseMarkdown } from '../../src/core/markdown/parse'
import { type SerializeOptions, serializeMarkdown } from '../../src/core/markdown/serialize'
import { resolveLocalPath } from '../../src/core/paths'
import { schema } from '../../src/core/schema'
import { createMemoryHost } from '../../src/host/memory'

const ser: SerializeOptions = { inlineMath: true, ensureTrailingNewline: false }

/** 文档里所有带链接的文字(相邻同标记的文字 ProseMirror 会并成一个节点)。 */
function linksOf(doc: PMNode): { text: string; href: string; ref: string | null; refType: string | null }[] {
  const out: { text: string; href: string; ref: string | null; refType: string | null }[] = []
  doc.descendants((node) => {
    const link = node.marks.find((m) => m.type === schema.marks.link)
    if (node.isText && link) out.push({ text: node.text ?? '', href: link.attrs.href, ref: link.attrs.ref, refType: link.attrs.refType })
  })
  return out
}

/** 把第 index 块换成内容相同的新节点:模拟这一块被编辑过,保存时不再按原文写回,而是重新生成。 */
function edited(doc: PMNode, index: number): PMNode {
  const blocks: PMNode[] = []
  doc.forEach((b, _o, i) => blocks.push(i === index ? b.type.create(b.attrs, b.content, b.marks) : b))
  return schema.nodes.doc.create(null, blocks)
}

describe('X-09 命名锚点', () => {
  it('X-09 <a name> 命名锚点能找到:段落里的、HTML 块里的;双引号、单引号、不加引号都认', () => {
    const { doc } = parseMarkdown("# 标题\n\n段落 <a name=\"mark\"></a> 中间 <a name='single'></a> 结尾 <a name=bare></a>\n\n<div><a name=\"blk\"></a></div>\n", {
      inlineMath: true,
    })
    for (const name of ['mark', 'single', 'bare']) {
      const pos = findAnchor(doc, name)
      expect(pos).not.toBeNull()
      expect(doc.nodeAt(pos!)?.type.name).toBe('html_inline')
    }
    const block = findAnchor(doc, 'blk')
    expect(block).not.toBeNull()
    expect(doc.resolve(block!).parent.type.name).toBe('html_block')
    // 只认整名,不按前缀匹配
    expect(findAnchor(doc, 'mar')).toBeNull()
  })
})

describe('X-10 链接到本地文件:绝对路径', () => {
  const host = createMemoryHost()
  const put = (path: string) => host.files.set(path, { kind: 'file', data: '', mtime: 1 })
  put('/r/notes/笔记.md')
  put('/Users/test/随记.md')
  const ctx = { path: '/r/docs/当前.md', rootUrl: null }

  it('X-10 绝对路径、file:// 地址、~/ 开头都按本机文档打开,可省 .md、可带 #标题;不存在时可以新建', async () => {
    expect(await resolveLinkTarget(host, '/r/notes/笔记.md', ctx, '/r')).toEqual({ kind: 'doc', path: '/r/notes/笔记.md', anchor: '' })
    expect(await resolveLinkTarget(host, '/r/notes/笔记#第一节', ctx, '/r')).toEqual({ kind: 'doc', path: '/r/notes/笔记.md', anchor: '第一节' })
    // file:// 地址里的中文是百分号编码
    expect(await resolveLinkTarget(host, 'file:///r/notes/%E7%AC%94%E8%AE%B0.md', ctx, '/r')).toEqual({ kind: 'doc', path: '/r/notes/笔记.md', anchor: '' })
    expect(await resolveLinkTarget(host, '~/随记.md', ctx, '/r')).toEqual({ kind: 'doc', path: '/Users/test/随记.md', anchor: '' })
    expect(await resolveLinkTarget(host, '/r/notes/新的.md', ctx, '/r')).toEqual({ kind: 'missing', path: '/r/notes/新的.md', creatable: true })
  })
})

describe('X-12 尖括号链接与邮箱', () => {
  it('X-12 <a@b.com> 解析成 mailto: 链接,文字是邮箱;这一段改过后重新生成仍写成尖括号', () => {
    const md = '写信给 <a@b.com> 或 <https://example.com>\n'
    const { doc, meta } = parseMarkdown(md, { inlineMath: true })
    expect(linksOf(doc)).toEqual([
      { text: 'a@b.com', href: 'mailto:a@b.com', ref: null, refType: null },
      { text: 'https://example.com', href: 'https://example.com', ref: null, refType: null },
    ])
    expect(serializeMarkdown(edited(doc, 0), meta, ser)).toBe(md)
  })
})

describe('X-13 引用式链接与图片', () => {
  it('X-13 [文字][id]、[文字][]、[文字] 与 ![图][id] 的地址取自定义行;重新生成仍写成引用式', () => {
    const md = '见 [文档][doc]、[doc][] 和 [doc]。\n\n![图][img]\n\n[doc]: 另一篇.md "标题"\n[img]: assets/id.svg\n'
    const { doc, meta } = parseMarkdown(md, { inlineMath: true })
    expect(linksOf(doc)).toEqual([
      { text: '文档', href: '另一篇.md', ref: 'doc', refType: 'full' },
      { text: 'doc', href: '另一篇.md', ref: 'doc', refType: 'collapsed' },
      { text: 'doc', href: '另一篇.md', ref: 'doc', refType: 'shortcut' },
    ])
    const image = doc.child(1).firstChild
    expect(image?.type.name).toBe('image')
    expect(image?.attrs).toMatchObject({ src: 'assets/id.svg', alt: '图', ref: 'img', refType: 'full' })
    // 定义行显示为定义块,不会变成普通段落
    expect([doc.child(2).type.name, doc.child(3).type.name]).toEqual(['definition', 'definition'])
    expect(serializeMarkdown(edited(doc, 0), meta, ser)).toBe(md)
  })
})

describe('X-20 / X-21 YAML 里的 typora-root-url 与 typora-copy-images-to', () => {
  const withYaml = (yaml: string) => parseMarkdown(`---\n${yaml}\n---\n\n正文\n`, { inlineMath: true }).doc

  it('X-20 从文档 YAML 读出图片根路径:相对路径按文档所在文件夹解析;/ 开头的图片按根路径找,相对图片不受影响', () => {
    expect(frontMatterInfo(withYaml('typora-root-url: ./img'), '/n/笔记.md').rootUrl).toBe('/n/img')
    expect(frontMatterInfo(withYaml('typora-root-url: /srv/site/'), '/n/笔记.md').rootUrl).toBe('/srv/site')
    // 未保存的文档没有所在文件夹,相对的根路径无从解析
    expect(frontMatterInfo(withYaml('typora-root-url: ./img'), null).rootUrl).toBeNull()
    // YAML 写错按没有处理,不打断编辑
    expect(frontMatterInfo(withYaml('typora-root-url: ['), '/n/笔记.md').rootUrl).toBeNull()

    const root = frontMatterInfo(withYaml('typora-root-url: ./img'), '/n/笔记.md').rootUrl
    expect(resolveLocalPath('/a.png', { path: '/n/笔记.md', rootUrl: root })).toBe('/n/img/a.png')
    expect(resolveLocalPath('b.png', { path: '/n/笔记.md', rootUrl: root })).toBe('/n/b.png')
    expect(resolveLocalPath('/a.png', { path: '/n/笔记.md', rootUrl: null })).toBe('/a.png')
  })

  it('X-21 从文档 YAML 读出插图目录并决定落盘位置:相对、${filename}、绝对路径;值为 upload 时改为上传', () => {
    const host = createMemoryHost()
    const folderFor = (yaml: string) => {
      const copyImagesTo = frontMatterInfo(withYaml(yaml), '/n/笔记.md').copyImagesTo
      return targetFolder({ host, settings: DEFAULT_SETTINGS, docPath: '/n/笔记.md', copyImagesTo })
    }
    expect(frontMatterInfo(withYaml('typora-copy-images-to: ./pics'), '/n/笔记.md').copyImagesTo).toBe('./pics')
    expect(folderFor('typora-copy-images-to: ./pics')).toBe('/n/pics')
    expect(folderFor('typora-copy-images-to: ./${filename}.assets')).toBe('/n/笔记.assets')
    expect(folderFor('typora-copy-images-to: /srv/pics')).toBe('/srv/pics')
    // 没写这个键时按偏好(默认 ./assets)
    expect(folderFor('title: 无关')).toBe('/n/assets')
    const upload = frontMatterInfo(withYaml('typora-copy-images-to: upload'), '/n/笔记.md').copyImagesTo
    expect(upload).toBe('upload')
    expect(shouldUpload({ host, settings: DEFAULT_SETTINGS, docPath: '/n/笔记.md', copyImagesTo: upload })).toBe(true)
  })
})

describe('X-23 导出变量', () => {
  const host = createMemoryHost()
  const ctx = (patch: Partial<ExportContext> = {}): ExportContext => ({
    host,
    settings: { ...DEFAULT_SETTINGS, exportPdfAuthor: '小明' },
    systemDark: false,
    view: {} as EditorView,
    docPath: '/n/周报.md',
    markdown: '',
    fallbackName: '本周小结',
    frontMatter: null,
    update: async () => {},
    toast: () => {},
    ...patch,
  })
  /** 与导出流程同一写法:本地时间的年-月-日 */
  const localDate = () => {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  it('X-23 ${today} 为年-月-日;${outputFolder}、${currentFolder}、${currentFileName} 取导出位置与文档位置;页码留给外壳逐页替换', () => {
    const before = localDate()
    const vars = exportVariables(ctx(), {}, '/out/周报.pdf')
    expect([before, localDate()]).toContain(vars.today)
    expect(vars).toEqual({
      title: '周报',
      author: '小明',
      today: vars.today,
      outputPath: '/out/周报.pdf',
      outputFolder: '/out',
      currentPath: '/n/周报.md',
      currentFolder: '/n',
      currentFileName: '周报',
    })
    expect(expandVariables('${today}|${outputFolder}|${currentFolder}|${currentFileName}|第 ${pageNo}/${pageCount} 页', vars)).toBe(
      `${vars.today}|/out|/n|周报|第 \${pageNo}/\${pageCount} 页`,
    )
  })

  it('X-23 未保存的文档:标题取首个标题,文档位置相关的变量为空;YAML 的 title、author 优先', () => {
    const untitled = exportVariables(ctx({ docPath: null }), {}, '/Users/test/本周小结.pdf')
    expect(untitled).toMatchObject({ title: '本周小结', outputFolder: '/Users/test', currentPath: '', currentFolder: '', currentFileName: '' })
    expect(exportVariables(ctx(), { title: '年报', author: '小红' }, '/out/年报.pdf')).toMatchObject({ title: '年报', author: '小红' })
  })
})
