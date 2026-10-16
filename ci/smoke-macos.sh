#!/usr/bin/env bash
# 用法:ci/smoke-macos.sh <Typoza.app 路径> <输出目录>
# 以冒烟模式启动打包好的应用:编辑器就绪后自检、截图、写 smoke.json 并退出。超时 300 秒判失败(含 5MB 大文档性能实测)。
set -euo pipefail
app="${1:?需要 .app 路径}"
out="${2:?需要输出目录}"
mkdir -p "$out"
start=$(python3 -c 'import time; print(time.time())')
perl -e 'alarm shift; exec @ARGV' 300 "$app/Contents/MacOS/Typoza" --smoke-out "$out"
end=$(python3 -c 'import time; print(time.time())')
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
PY
