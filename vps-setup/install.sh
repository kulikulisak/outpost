#!/usr/bin/env bash
# Install or update Remote Claude on a VPS without the desktop app:
#   curl -fsSL https://raw.githubusercontent.com/kulikulisak/claudevps/main/vps-setup/install.sh | bash
# Installs dependencies + Claude Code (bootstrap.sh), the rcc helper, the phone server and the phone app,
# then starts the phone server. Re-run any time to update.
set -euo pipefail
REPO="${RCC_REPO:-https://github.com/kulikulisak/claudevps}"
BRANCH="${RCC_BRANCH:-main}"
SRC="$HOME/.rcc/src"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
command -v git >/dev/null 2>&1 || { say "安装 git"; if command -v apt-get >/dev/null; then ${SUDO:-$( [ "$(id -u)" = 0 ] || echo sudo )} apt-get update -y >/dev/null && ${SUDO:-$( [ "$(id -u)" = 0 ] || echo sudo )} apt-get install -y git >/dev/null; fi; }

say "下载 $REPO ($BRANCH)"
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin "$BRANCH" && git -C "$SRC" reset -q --hard "origin/$BRANCH"
else rm -rf "$SRC"; git clone -q --depth 1 -b "$BRANCH" "$REPO" "$SRC"; fi

say "检查并安装依赖（Node.js、tmux、TigerVNC、Chromium、Claude Code…）"
bash "$SRC/vps-setup/bootstrap.sh" | while IFS= read -r line; do
  case "$line" in
    *'"type":"install"'*'"status":"start"'*) printf '   安装 %s…\n' "$(printf '%s' "$line" | sed -n 's/.*"name":"\([^"]*\)".*/\1/p')";;
    *'"type":"fatal"'*) printf '   \033[31m%s\033[0m\n' "$line";;
    *'"type":"done"'*) :;;
  esac
done

say "安装 rcc 和手机服务"
mkdir -p "$HOME/.local/bin" "$HOME/.rcc/mobile/web"
install -m 755 "$SRC/vps-agent/rcc.mjs" "$HOME/.local/bin/rcc"
install -m 755 "$SRC/vps-agent/rcc-serve.mjs" "$HOME/.local/bin/rcc-serve.mjs"
rm -rf "$HOME/.rcc/mobile/web"; cp -r "$SRC/vps-agent/web" "$HOME/.rcc/mobile/web"
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

say "启动手机服务（只监听 127.0.0.1）"
rcc serve start

cat <<'EOF'

完成。接下来：
  1. 登录 Claude：在电脑端点「登录」，或在这里运行  claude  按提示登录
  2. 让手机能访问（任选一种）：
       rcc serve tailscale          # 推荐：装 Tailscale，发布私网 HTTPS（手机也装 Tailscale）
       rcc serve url https://你的域名  # 已有反向代理 / Cloudflare Tunnel 指向 127.0.0.1:7788
  3. 配对手机：
       rcc pair                     # 终端里显示二维码，手机相机扫一下
EOF
