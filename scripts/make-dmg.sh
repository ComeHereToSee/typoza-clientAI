#!/usr/bin/env bash
# 用法:scripts/make-dmg.sh <Typoza.app 路径> <输出 dmg 路径>
set -euo pipefail
app="${1:?需要 .app 路径}"
dmg="${2:?需要输出 dmg 路径}"
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
hdiutil create -volname "$(plutil -extract CFBundleName raw "$app/Contents/Info.plist")" -srcfolder "$stage" -ov -format UDZO "$dmg"
ls -la "$dmg"
