# CI 回传、命令行与协作的坑

> 分类:踩坑。来源:2026-10-23 收尾阶段(三仓公开后的 CI、冒烟扩展、并行子代理补用例)。

## 读 CI 结果
- 仓库名是 `typoza-client` / `typoza-clientAI` / `typoza-backend`(本地目录名不同);API 地址写错仓库名返回 404。`ci/<job>` 分支每次运行强推覆盖,只有最新一次的结果。
- `ci/macos` 分支带 DMG 等大文件,`git fetch origin ci/macos` 经 ssh.github.com:443 偶发卡死(`perl alarm` 只杀了 git,ssh 子进程还挂着)。仓库公开后直接读 `https://raw.githubusercontent.com/<owner>/<repo>/ci/<job>/<文件>`(SUMMARY.md、steps.tsv、e2e.log、smoke.log、smoke/smoke.json),快且不占 git。
- zsh 里 `"origin/ci/$b:steps.tsv"` 的 `$b:s` 会被当成变量修饰符(替换),`git show` 拿到的路径不对、把整个提交打出来。变量后紧跟冒号时写 `${b}`。
- 推送有新提交时同一工作流的旧运行会被取消(并发设置);要看某次结果就等它跑完再推。只改 `docs/**` 不触发 CI。

## Swift 写法(本机不编译,只能等 CI 报)
- `steps[i] { results in … }` 被解析成「带尾随闭包的下标」,报 `extra trailing closure passed in subscript`:先 `let step = steps[i]` 再调用。
- Release(-O)构建里强制解包、越界等运行时陷阱可能不打印消息;冒烟脚本在失败时拷回崩溃报告,并把每个桥接调用与外壳自检进度写到标准错误,崩溃停在哪一步一眼可见。

- 嵌套类型在闭包参数里写 `Self.X` 或裸写 `X`,在类的扩展方法里会报 `'X' is not a member type of type 'Self'`;放到文件级(`private struct`)最省事。
- 本机能做的只有语法检查:`swiftc -parse 文件`(不建模块、不做类型检查,类型错误仍要等 CI)。用 Python 拼 Swift 源码时别写出 `""""` 这种四连引号,会在行首多出一个 `"`。

## 依赖补丁(scripts/patch-deps.mjs)
- 同一文件可以打多个补丁(循环里每次重新读文件)。补丁改过之后,本机已经打过旧版的 node_modules 会被重复插入,本地检查前先把旧补丁去掉再跑;CI 每次 `npm ci` 都是干净的。

## 真机电脑操作(后台模式)
- 后台操作时应用不在前台,网页里 `document.hasFocus()` 为 false:依赖焦点的逻辑(CodeMirror 的 `hasFocus`)会和真用户不一样,正好暴露「只在有焦点时同步」这类缺陷。
- 屏幕锁定或窗口被遮挡时 WebKit 节流动画与 requestAnimationFrame,灯箱等动画看起来「卡住」,不代表有缺陷;截图可能是旧画面。
- 保存面板的「存储」在后台被操作工具拦下(要先展开面板、且工具能看清目标文件夹);导出内容以 CI 冒烟为准。
- 系统授权框点错被拒后不要立刻重弹,等用户说明。

## CI 环境(2026-10-23~24)
- **Playwright 装系统依赖卡死**:GitHub 的 Ubuntu 机器取源走镜像清单 `/etc/apt/apt-mirrors.txt`(日志里的 `Mirrorlist` 一行),Azure 镜像偶尔极慢,连续三轮卡满 18 分钟、e2e 全挂、macOS 打包拿不到图标。只改 `sources` 里的地址不生效;`timeout` 掐掉 npx 后 `sudo apt-get` 还活着占着锁,重试直接失败。做法见 `ci/playwright-install.sh`:浏览器本体与系统依赖分开装、各自限时,重试前结束残留 apt、`dpkg --configure -a`、改写镜像清单换官方源。
- **raw.githubusercontent 有缓存**:`?t=<时间戳>` 也会读到旧文件,而且同一轮里不同文件新旧不一(SUMMARY 新、smoke.json 旧或反过来)。读结果先核 `SUMMARY.md` 的 sha,报告里自带提交号的再核一次;等待脚本里只看 SUMMARY 会被旧缓存提前放行。GitHub 接口匿名每小时 60 次,轮询会很快用光。
- **跨 CI 机器的性能数字不能比**:同一份代码换一台机器,浏览器冷启动中位数 258 / 163 毫秒;macOS 冒烟的网页段 0.5~1.0 秒。前后对比要同一台机器、同一次运行里构建两份轮流量(`editor/scripts/startup-ab.mjs`,perf 工作流)。
- **偶发失败先看时序**:冒烟或用例改了网页选区紧接着执行编辑器命令,编辑器自己的选区(`view.state.selection`)可能还没跟上;CI 偶发「复制为空」。等状态跟上(或等只在状态里才出现的界面,如表格工具条)再执行。

## 用例写法补充(Linux WebKit / jsdom)
- 测试环境连不上的网络图片会加载失败,`img` 被隐藏(`.tz-image.is-broken img { display:none }`),点 `img` 会一直等可见直到超时;点外层 `.tz-image`。
- jsdom 会规整 style 写法(`font-size:20px` → `font-size: 20px;`),断言用正则。
- 断言几何位置(居中与否)容易受正文宽度影响,优先断言计算样式(`display`、`margin-left`)或类名。

## 并行子代理
- 子代理会话中途被限额或应用退出打断时,没落盘的进度全丢(一次逐行映射对照表证据的工作两次归零)。派单写明「每核完约 15 行就覆盖写一次整份文件」,并按编号前缀分片给多路,各写各的文件,主会话再合并。
- 子代理不能跑测试时写出的用例要靠 CI 校正;这一轮五路共写近 180 条用例,首轮 CI 只有个位数失败,失败多是环境假设(网络图片、焦点、jsdom 规整),不是断言算错。
