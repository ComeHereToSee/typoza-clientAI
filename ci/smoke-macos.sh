#!/usr/bin/env bash
# 用法:ci/smoke-macos.sh <Typoza.app 路径> <输出目录>
# 以冒烟模式启动打包好的应用:编辑器就绪后自检、截图、写 smoke.json 并退出。超时 300 秒判失败(含 5MB 大文档性能实测)。
set -euo pipefail
app="${1:?需要 .app 路径}"
out="${2:?需要输出目录}"
mkdir -p "$out"
start=$(python3 -c 'import time; print(time.time())')
status=0
perl -e 'alarm shift; exec @ARGV' 300 "$app/Contents/MacOS/Typoza" --smoke-out "$out" || status=$?
end=$(python3 -c 'import time; print(time.time())')
if [ "$status" -ne 0 ]; then
  # 崩溃时把系统生成的崩溃报告带回来(调用栈),否则只看得到「Trace/BPT trap」
  sleep 20
  mkdir -p "$out/crash"
  for d in "$HOME/Library/Logs/DiagnosticReports" /Library/Logs/DiagnosticReports; do
    ls -lt "$d" 2>/dev/null | head -5
    find "$d" -name 'Typoza*' -mmin -15 -exec cp {} "$out/crash/" \; 2>/dev/null || true
  done
  for f in "$out"/crash/*; do [ -f "$f" ] && head -c 400000 "$f"; done
  exit "$status"
fi
python3 - "$out/smoke.json" "$start" "$end" "$(dirname "$0")/menu-keys.json" <<'PY'
import json, sys
path, start, end, expected_path = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4]
report = json.load(open(path))
report["wallSeconds"] = round(end - start, 3)
json.dump(report, open(path, "w"), ensure_ascii=False, indent=2)
print(json.dumps(report, ensure_ascii=False, indent=2))
if "error" in report or not report.get("result", {}).get("ok"):
    sys.exit("冒烟自检失败")
# 原生菜单的键位与 docs/prd/notion-input.md 5.2 逐项核对(期望表 ci/menu-keys.json;Linux 上的 E2E 按不出这些键)
menu = report.get("menuKeys", [])
actual = {tuple(x) for x in menu}
titles = {t for t, _ in menu}
missing = [(t, k) for t, k in json.load(open(expected_path)) if (t, k) not in actual]
for t, k in missing:
    have = [mk for mt, mk in menu if mt == t]
    print(f"菜单键位不符:「{t}」期望 {k},实际 {'、'.join(have) if have else '菜单里没有这一项'}", file=sys.stderr)
if missing:
    sys.exit("菜单键位与 notion-input.md 5.2 不符")
print(f"菜单键位核对通过:{len(actual)} 项里期望的 {len(json.load(open(expected_path)))} 项都对")
# 同名同键位出现两次 = 菜单里有重复项(系统自动插入的项与应用自己的项撞了)
dups = sorted({(t, k) for t, k in menu if menu.count([t, k]) > 1})
if dups:
    sys.exit("菜单里有重复项:" + "、".join(f"{t} {k}" for t, k in dups))
# 外壳行为自检(最近文件 / 目录、置顶、重开关闭的文件、全部保存、欢迎文档、新建窗口 / 标签、真按键、导出读回、命令行打开、恢复草稿等;见 AppDelegate.runNativeSmoke)
native = report.get("nativeChecks", {})
failed = [k for k, v in native.items() if v is not True]
if not native or failed:
    sys.exit(f"外壳行为自检失败:{'、'.join(failed) or '没有结果'}")
print(f"外壳行为自检通过:{'、'.join(native)}")
PY

# 启动选项(对照表 PF-01):四种选项各冷启动一次,核对打开的文档与侧栏目录
python3 - "$app" "$out" <<'PY'
import json, os, subprocess, sys, tempfile
app, out = sys.argv[1], sys.argv[2]
support = os.path.expanduser('~/Library/Application Support/Typoza')
settings_path = os.path.join(support, 'settings.json')
drafts = os.path.join(support, 'drafts')
base = tempfile.mkdtemp(prefix='typoza-startup-')
last_folder = os.path.join(base, '上次目录')
custom = os.path.join(base, '指定目录')
os.makedirs(last_folder)
os.makedirs(custom)
last_file = os.path.join(last_folder, '上次文件.md')
with open(last_file, 'w') as f:
    f.write('# 上次文件\n')
real = lambda p: os.path.realpath(p) if p else None
cases = [('newFile', None, None), ('lastFolder', None, last_folder), ('lastFilesAndFolder', last_file, last_folder), ('customFolder', None, custom)]
results = {}
for action, want_path, want_folder in cases:
    # 有未命名草稿时启动先恢复草稿、不走启动选项:清掉前面自检留下的
    if os.path.isdir(drafts):
        for name in os.listdir(drafts):
            os.remove(os.path.join(drafts, name))
    settings = json.load(open(settings_path)) if os.path.exists(settings_path) else {}
    settings.update({'startupAction': action, 'lastFile': last_file, 'lastFolder': last_folder, 'startupFolder': custom})
    json.dump(settings, open(settings_path, 'w'), ensure_ascii=False)
    d = os.path.join(out, f'startup-{action}')
    code = subprocess.run(['perl', '-e', 'alarm shift; exec @ARGV', '60', f'{app}/Contents/MacOS/Typoza', '--startup-check-out', d]).returncode
    try:
        got = json.load(open(os.path.join(d, 'smoke.json')))
    except Exception as e:
        got = {'error': f'没有结果({e}),退出码 {code}'}
    ok = code == 0 and real(got.get('path')) == real(want_path) and real(got.get('folder') or None) == real(want_folder)
    results[action] = ok
    print(f"启动选项 {action}:{'通过' if ok else '不符'} {json.dumps(got, ensure_ascii=False)}")
json.dump(results, open(os.path.join(out, 'startup.json'), 'w'), ensure_ascii=False)
if not all(results.values()):
    sys.exit('启动选项冷启动核对失败')
print('启动选项冷启动核对通过:' + '、'.join(results))
PY
