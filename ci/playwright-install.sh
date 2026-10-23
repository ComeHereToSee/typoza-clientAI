#!/usr/bin/env bash
# 装 Playwright 的 WebKit 与系统依赖(在 editor/ 下执行)。
# 系统软件源(Azure 镜像)偶尔极慢,曾连续两轮卡满 18 分钟、e2e 全挂;正常 1 分钟内装完。
# 浏览器本体从 Playwright 的下载站取,与系统依赖分开装:各自每次限时,没装完就重试。
# 系统依赖超时后先结束残留的 apt(否则下一次拿不到锁)、补完半截的安装,再换 Ubuntu 官方源重试。
set -uo pipefail

for i in 1 2 3; do
  timeout 300 npx playwright install webkit && break
  echo "浏览器第 $i 次没装完,重试"
  [ "$i" = 3 ] && exit 1
done

# 正常 1 分钟内装完,第一次限 3 分钟
for i in 1 2 3; do
  timeout $([ "$i" = 1 ] && echo 180 || echo 300) npx playwright install-deps webkit && exit 0
  echo "系统依赖第 $i 次没装完,换 Ubuntu 官方源重试"
  sudo pkill -x apt-get
  for _ in $(seq 30); do pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null || break; sleep 2; done
  sudo dpkg --configure -a
  # GitHub 的 Ubuntu 机器取源走镜像清单 /etc/apt/apt-mirrors.txt(日志里的 Mirrorlist 一行),
  # 只改 sources 不生效:整份换成官方源,原清单打进日志备查
  [ -f /etc/apt/apt-mirrors.txt ] && { echo "原镜像清单:"; cat /etc/apt/apt-mirrors.txt; }
  echo 'http://archive.ubuntu.com/ubuntu/' | sudo tee /etc/apt/apt-mirrors.txt >/dev/null
  sudo sed -i 's#http://azure.archive.ubuntu.com/ubuntu#http://archive.ubuntu.com/ubuntu#g' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list 2>/dev/null
done
exit 1
