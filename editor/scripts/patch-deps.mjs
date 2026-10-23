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
  {
    // prosemirror-view 1.42.6:每次更新都逐个比对容器的全部子节点(preMatch 从末尾倒着建一张 Map、iterDeco 逐个算装饰)。
    // 5MB 文档顶层约 5 万个块,WebKit 里每打一个字这一步就要 15 毫秒左右。子节点很多的块级容器先走快速路径:
    // 前后没变的子节点只比对象与装饰标记,中间只改了一个子节点时原地更新它;其余情况照走原来的完整比对。
    file: 'prosemirror-view/dist/index.js',
    before: '    updateChildren(view, pos) {\n        let inline = this.node.inlineContent, off = pos;',
    after:
      '    updateChildren(view, pos) {\n' +
      '        // [typoza 补丁] 子节点很多的块级容器(大文档顶层)只比对改动的那一段\n' +
      '        if (!this.node.inlineContent && this.children.length > 200 && this.dirty != CONTENT_DIRTY && tzFastBlockUpdate(this, view))\n' +
      '            return;\n' +
      '        let inline = this.node.inlineContent, off = pos;',
  },
  {
    file: 'prosemirror-view/dist/index.js',
    before: '// Iterate from the end of the fragment and array of descs to find\n// directly matching ones',
    after: `// [typoza 补丁] 块级容器的快速更新,返回 false 表示不适用(照走完整比对)。
// 前缀 / 后缀:子节点对象没变、不脏、外层与内层装饰都没变的跳过;只在有装饰的位置才做完整的 matchesNode。
// 中间新旧各只有一个子节点时原地 update;增删子节点、容器层有小部件或行内装饰、输入法组合不在这个子节点里、
// 原地更新不了,都返回 false。返回 false 之前不改任何状态。
function tzFastBlockUpdate(desc, view) {
    let node = desc.node, kids = desc.children, n = node.childCount, m = kids.length;
    let deco = desc.innerDeco, locals = deco.locals(node);
    let marks = [];
    for (let i = 0; i < locals.length; i++) {
        if (locals[i].widget || locals[i].inline)
            return false;
        marks.push(locals[i].from);
    }
    let sets = deco instanceof DecorationGroup ? deco.members : [deco];
    for (let i = 0; i < sets.length; i++)
        for (let j = 0; j < sets[i].children.length; j += 3)
            marks.push(sets[i].children[j]);
    marks.sort((a, b) => a - b);
    let outerAt = (off) => {
        let found = none;
        for (let i = 0; i < locals.length; i++)
            if (locals[i].from <= off && locals[i].to > off)
                (found == none ? (found = []) : found).push(locals[i]);
        return found;
    };
    let clean = (d, child, off, marked) => {
        if (d.node !== child || d.dirty != NOT_DIRTY)
            return false;
        if (!marked && !d.outerDeco.length && d.innerDeco == empty)
            return true;
        return d.matchesNode(child, outerAt(off), deco.forChild(off, child));
    };
    let lim = Math.min(m, n), p = 0, off = 0, mi = 0;
    while (p < lim) {
        let child = node.child(p);
        while (mi < marks.length && marks[mi] < off)
            mi++;
        if (!clean(kids[p], child, off, mi < marks.length && marks[mi] == off))
            break;
        off += child.nodeSize;
        p++;
    }
    let s = 0, end = node.content.size, mj = marks.length - 1;
    while (s < lim - p) {
        let child = node.child(n - 1 - s), o = end - child.nodeSize;
        while (mj >= 0 && marks[mj] > o)
            mj--;
        if (!clean(kids[m - 1 - s], child, o, mj >= 0 && marks[mj] == o))
            break;
        end = o;
        s++;
    }
    if (m - p - s == 0 && n - p - s == 0)
        return true;
    if (m - p - s != 1 || n - p - s != 1)
        return false;
    let d = kids[p], child = node.child(p);
    if (!d.node || d.dirty == NODE_DIRTY)
        return false;
    let comp = view.composing && view.input.compositionNode;
    if (comp && !d.dom.contains(comp.parentNode))
        return false;
    let dom = d.dom;
    if (!d.update(child, outerAt(off), deco.forChild(off, child), view))
        return false;
    if (d.dom != dom)
        renderDescs(desc.contentDOM, kids, view);
    return true;
}
// Iterate from the end of the fragment and array of descs to find
// directly matching ones`,
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
