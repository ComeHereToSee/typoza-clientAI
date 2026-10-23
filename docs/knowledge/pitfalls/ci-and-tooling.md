# CI 回传、命令行与协作的坑

> 分类:踩坑。来源:2026-10-23 收尾阶段(三仓公开后的 CI、冒烟扩展、并行子代理补用例)。

## 读 CI 结果
- `ci/macos` 分支带 DMG 等大文件,`git fetch origin ci/macos` 经 ssh.github.com:443 偶发卡死(`perl alarm` 只杀了 git,ssh 子进程还挂着)。仓库公开后直接读 `https://raw.githubusercontent.com/<owner>/<repo>/ci/<job>/<文件>`(SUMMARY.md、steps.tsv、e2e.log、smoke.log、smoke/smoke.json),快且不占 git。
- zsh 里 `"origin/ci/$b:steps.tsv"` 的 `$b:s` 会被当成变量修饰符(替换),`git show` 拿到的路径不对、把整个提交打出来。变量后紧跟冒号时写 `${b}`。
- 推送有新提交时同一工作流的旧运行会被取消(并发设置);要看某次结果就等它跑完再推。只改 `docs/**` 不触发 CI。

## Swift 写法(本机不编译,只能等 CI 报)
- `steps[i] { results in … }` 被解析成「带尾随闭包的下标」,报 `extra trailing closure passed in subscript`:先 `let step = steps[i]` 再调用。
- Release(-O)构建里强制解包、越界等运行时陷阱可能不打印消息;冒烟脚本在失败时拷回崩溃报告,并把每个桥接调用与外壳自检进度写到标准错误,崩溃停在哪一步一眼可见。

## 用例写法补充(Linux WebKit / jsdom)
- 测试环境连不上的网络图片会加载失败,`img` 被隐藏(`.tz-image.is-broken img { display:none }`),点 `img` 会一直等可见直到超时;点外层 `.tz-image`。
- jsdom 会规整 style 写法(`font-size:20px` → `font-size: 20px;`),断言用正则。
- 断言几何位置(居中与否)容易受正文宽度影响,优先断言计算样式(`display`、`margin-left`)或类名。

## 并行子代理
- 子代理会话中途被限额或应用退出打断时,没落盘的进度全丢(一次逐行映射对照表证据的工作两次归零)。派单写明「每核完约 15 行就覆盖写一次整份文件」,并按编号前缀分片给多路,各写各的文件,主会话再合并。
- 子代理不能跑测试时写出的用例要靠 CI 校正;这一轮五路共写近 180 条用例,首轮 CI 只有个位数失败,失败多是环境假设(网络图片、焦点、jsdom 规整),不是断言算错。
