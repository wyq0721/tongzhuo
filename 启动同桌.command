#!/bin/zsh
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo '需要先安装 Node.js 22.13 或以上。'
  read -r '?按回车关闭。'
  exit 1
fi
node scripts/start.mjs --share --open
if [[ $? -ne 0 ]]; then
  echo '本机页面可能已经可用；请查看上面的提示。'
  read -r '?按回车关闭。'
fi
