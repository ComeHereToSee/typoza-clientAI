// 导出流程(PRD 3.12;对照表 F-37、F-38、PX-01 ~ PX-11、X-22、X-23):变量、YAML 覆盖、重复导出、Pandoc 缺失提示、自定义命令。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EditorView } from 'prosemirror-view'
import { describe, expect, it } from 'vitest'
import { type ExportContext, PANDOC_INSTALL_URL, expandCommandVariables, expandVariables, newExportItem, readExportYaml, runExport } from '../../src/app/export-flow'
import { type AppSettings, DEFAULT_SETTINGS } from '../../src/app/settings'
import { createMemoryHost } from '../../src/host/memory'

function setup(patch: Partial<AppSettings> = {}) {
  const host = createMemoryHost()
  host.files.set('/n', { kind: 'dir', mtime: 1 })
  const toasts: string[] = []
  const settings: AppSettings = { ...DEFAULT_SETTINGS, exportHistory: {}, ...patch }
  const ctx: ExportContext = {
    host,
    settings,
    systemDark: false,
    // Word 等 Pandoc 格式不用编辑器渲染结果
    view: {} as EditorView,
    docPath: '/n/周报.md',
    markdown: '# 周报\n',
    fallbackName: '周报',
    frontMatter: null,
    update: async (p) => {
      Object.assign(settings, p)
    },
    toast: (m) => toasts.push(m),
  }
  return { host, ctx, toasts, settings }
}

const argsOf = (host: ReturnType<typeof createMemoryHost>, method: string) => host.calls.filter((c) => c.method === method).map((c) => c.args)

describe('变量与 YAML', () => {
  it('替换 ${变量},不认识的原样保留', () => {
    expect(expandVariables('${title} 第 ${pageNo} 页 ${author}', { title: '周报', author: '小明' })).toBe('周报 第 ${pageNo} 页 小明')
  })

  it('自定义命令里的变量只当文字:按所在位置转义,文件名与 YAML 里的内容执行不了命令', () => {
    const vars = { currentPath: '/n/$(touch 中招).md', title: 'a"; rm -rf ~; "b', author: "it's `who`" }
    expect(expandCommandVariables('pandoc "${currentPath}" --title "${title}"', vars)).toBe('pandoc "/n/\\$(touch 中招).md" --title "a\\"; rm -rf ~; \\"b"')
    expect(expandCommandVariables('echo ${title}', vars)).toBe(`echo 'a"; rm -rf ~; "b'`)
    expect(expandCommandVariables("echo '${author}'", vars)).toBe(`echo 'it'\\''s \`who\`'`)
    // 不认识的变量、转义过的引号与普通文字不动
    expect(expandCommandVariables('open "${outputPath}" \\" ${pageNo}', { outputPath: '/n/周报.docx' })).toBe('open "/n/周报.docx" \\" ${pageNo}')
  })

  it('变量放在双引号里的 $( )、反引号、单引号与嵌套里也只当文字:交给真 shell 执行,输出就是原值,没执行任何命令', () => {
    // 外壳用 zsh -lc 执行;CI 的 Linux 上没有 zsh 时用 bash(这几种写法两者规则一致)
    const shells = ['/bin/zsh', '/bin/bash'].filter((sh) => existsSync(sh))
    expect(shells.length).toBeGreaterThan(0)
    // 不含空格(引号外的命令替换结果会被按空格拆开);${IFS} 在被当成命令时会变成空格,让 touch 生效
    const values = ['x\'"\\$(touch${IFS}P1)`touch${IFS}P2`;touch${IFS}P3;\\\\\\`$HOME', 'a;touch${IFS}P4', '/n/$(touch${IFS}P5).md', 'it\'s`touch${IFS}P6`"q"']
    const templates = [
      'printf %s ${v}',
      'printf %s "${v}"',
      "printf %s '${v}'",
      'printf %s "$(printf %s ${v})"',
      'printf %s "$(printf %s "${v}")"',
      "printf %s $(printf %s '${v}')",
      'printf %s `printf %s ${v}`',
      'printf %s "`printf %s ${v}`"',
      'printf %s `printf %s "${v}"`',
      "printf %s `printf %s '${v}'`",
      'printf %s "$(printf %s $(printf %s ${v}))"',
      'printf %s "$((1+1))${v}"',
    ]
    for (const sh of shells)
      for (const t of templates)
        for (const v of values) {
          const dir = mkdtempSync(join(tmpdir(), 'tz-cmd-'))
          const out = execFileSync(sh, ['-c', expandCommandVariables(t, { v })], { cwd: dir, encoding: 'utf8' })
          expect(out, `${sh}:${t}`).toBe(t.includes('$((1+1))') ? `2${v}` : v)
          expect(readdirSync(dir), `${sh}:${t}`).toEqual([])
        }
  })

  it('读文档 YAML 里的导出键;YAML 写错按没有处理', () => {
    expect(readExportYaml('title: 年报\nauthor: 小红\nappend-head: <meta name="a">\nfooter: 第 ${pageNo} 页')).toEqual({
      title: '年报',
      author: '小红',
      header: undefined,
      footer: '第 ${pageNo} 页',
      appendHead: '<meta name="a">',
      appendBody: undefined,
    })
    expect(readExportYaml('title: [未闭合')).toEqual({})
    expect(readExportYaml(null)).toEqual({})
  })

  it('从模板新建导出项', () => {
    const item = newExportItem('command')
    expect(item.template).toBe('command')
    expect(() => newExportItem('nope' as never)).toThrow('未知的导出模板')
  })
})

describe('runExport', () => {
  it('第一次导出默认放在文档所在文件夹;成功后记下,「使用上一次设置导出」沿用格式与位置', async () => {
    const { host, ctx, toasts, settings } = setup()
    await runExport(ctx, 'docx', 'new')
    expect(argsOf(host, 'saveDialog')[0][0]).toMatchObject({ defaultName: '周报.docx', directory: '/n' })
    expect(argsOf(host, 'exportDocument').map((a) => [a[0], a[1]])).toEqual([['docx', '/n/周报.docx']])
    expect(toasts).toEqual(['导出成功'])
    expect(settings.exportHistory['/n/周报.md']).toEqual({ format: 'docx', target: '/n/周报.docx' })

    await runExport(ctx, '', 'previous')
    expect(argsOf(host, 'saveDialog')[1][0]).toMatchObject({ defaultName: '周报.docx', directory: '/n' })
    expect(argsOf(host, 'exportDocument')).toHaveLength(2)
  })

  it('导出并覆盖:先确认,取消就不导出;没导出过时提示', async () => {
    const { host, ctx, toasts } = setup({ exportHistory: { '/n/周报.md': { format: 'docx', target: '/out/周报.docx' } } })
    host.confirm = async (o) => {
      host.calls.push({ method: 'confirm', args: [o] })
      return 1
    }
    await runExport(ctx, '', 'overwrite')
    expect((argsOf(host, 'confirm')[0][0] as { title: string; buttons: string[] }).title).toBe(
      '"导出并覆盖上一次导出的文件" 会覆盖位于 /out/周报.docx 的文件,是否继续?',
    )
    expect(argsOf(host, 'exportDocument')).toHaveLength(0)
    host.confirm = async () => 0
    await runExport(ctx, '', 'overwrite')
    expect(argsOf(host, 'exportDocument').map((a) => a[1])).toEqual(['/out/周报.docx'])
    expect(argsOf(host, 'saveDialog')).toHaveLength(0)

    const fresh = setup()
    await runExport(fresh.ctx, '', 'overwrite')
    expect(fresh.toasts).toEqual(['这篇文档还没有导出过'])
    expect(toasts).toEqual(['导出成功'])
  })

  it('没装 Pandoc:提示「需要安装 Pandoc 以继续…」并给【安装说明】', async () => {
    const { host, ctx, toasts } = setup()
    host.exportDocument = async () => {
      throw new Error('需要安装 Pandoc 以继续…')
    }
    await runExport(ctx, 'docx', 'new')
    const confirm = argsOf(host, 'confirm')[0][0] as { title: string; buttons: string[] }
    expect(confirm.title).toBe('需要安装 Pandoc 以继续…')
    expect(confirm.buttons).toEqual(['安装说明', '好'])
    expect(argsOf(host, 'openExternal')).toEqual([[PANDOC_INSTALL_URL]])
    expect(toasts).toEqual([])
  })

  it('其它失败提示「导出失败:」+ 原因;导出后运行命令失败单独提示', async () => {
    const failing = setup()
    failing.host.exportDocument = async () => {
      throw new Error('磁盘已满')
    }
    await runExport(failing.ctx, 'docx', 'new')
    expect(failing.toasts).toEqual(['导出失败:磁盘已满'])

    const after = setup({ exportAfter: 'command', exportAfterCommand: 'open "${outputPath}"' })
    after.host.runCommand = async (command, cwd) => {
      after.host.calls.push({ method: 'runCommand', args: [command, cwd] })
      return { status: 1, output: '没有权限' }
    }
    await runExport(after.ctx, 'docx', 'new')
    expect(argsOf(after.host, 'runCommand')).toEqual([['open "/n/周报.docx"', '/n']])
    expect(after.toasts).toEqual(['导出成功', '导出后运行自定义脚本失败:没有权限'])
  })

  it('自定义命令导出项:在文档所在文件夹执行,变量替换', async () => {
    const item = { ...newExportItem('command'), id: 'pub', name: '发布', command: 'publish "${currentPath}" --title "${title}"' }
    const { host, ctx, toasts } = setup({ exportItems: [item] })
    await runExport(ctx, 'item:pub', 'new')
    expect(argsOf(host, 'runCommand')).toEqual([['publish "/n/周报.md" --title "周报"', '/n']])
    expect(toasts).toEqual(['导出成功'])
  })
})
