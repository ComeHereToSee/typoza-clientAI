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
  sleep 5
  mkdir -p "$out/crash"
  find "$HOME/Library/Logs/DiagnosticReports" -name 'Typoza*' -mmin -15 -exec cp {} "$out/crash/" \; 2>/dev/null || true
  for f in "$out"/crash/*; do [ -f "$f" ] && head -c 20000 "$f"; done
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
# 外壳行为自检(最近文件 / 目录、置顶、重开关闭的文件、全部保存、欢迎文档、新建窗口 / 标签、真按键、导出读回、命令行打开、恢复草稿等;见 AppDelegate.runNativeSmoke)
native = report.get("nativeChecks", {})
failed = [k for k, v in native.items() if v is not True]
if not native or failed:
    sys.exit(f"外壳行为自检失败:{'、'.join(failed) or '没有结果'}")
print(f"外壳行为自检通过:{'、'.join(native)}")
PY
