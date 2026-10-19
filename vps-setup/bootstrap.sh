#!/usr/bin/env bash
# VPS 环境自检 + 自动安装
# 客户端通过 SSH 执行：bash -s < bootstrap.sh   （或先 SFTP 上传再执行）
# 每一步输出一行 JSON，客户端逐行解析，渲染成进度清单。
#   {"type":"check","name":"tmux","ok":false}
#   {"type":"install","name":"tmux","status":"start|ok|fail","msg":"..."}
#   {"type":"done","ok":true}
set -uo pipefail

emit() { printf '%s\n' "$1"; }
jstr() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }
check() { emit "{\"type\":\"check\",\"name\":\"$1\",\"ok\":$2}"; }
inst()  { emit "{\"type\":\"install\",\"name\":\"$1\",\"status\":\"$2\",\"msg\":\"$(jstr "${3:-}")\"}"; }
fatal() { emit "{\"type\":\"fatal\",\"msg\":\"$(jstr "$1")\"}"; exit 1; }

# ---------- 0. 基础信息 ----------
ARCH=$(uname -m)
case "$ARCH" in x86_64|aarch64|arm64) ;; *) fatal "不支持的 CPU 架构: $ARCH" ;; esac

MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
[ "$MEM_MB" -lt 3800 ] && emit "{\"type\":\"warn\",\"msg\":\"内存 ${MEM_MB}MB，低于建议的 4GB\"}"

. /etc/os-release 2>/dev/null || fatal "无法识别系统（缺少 /etc/os-release）"
OS_ID="${ID:-unknown}"

if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif sudo -n true 2>/dev/null; then SUDO="sudo -n"
else fatal "当前用户没有免密 sudo，无法自动安装系统组件"; fi

if   command -v apt-get >/dev/null; then PM=apt
elif command -v dnf     >/dev/null; then PM=dnf
elif command -v apk     >/dev/null; then PM=apk
else fatal "不支持的包管理器（需要 apt / dnf / apk）"; fi
emit "{\"type\":\"info\",\"os\":\"$OS_ID\",\"arch\":\"$ARCH\",\"mem_mb\":$MEM_MB,\"pm\":\"$PM\"}"

PM_UPDATED=0
pm_install() {
  case $PM in
    apt)
      [ $PM_UPDATED -eq 0 ] && { $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1; PM_UPDATED=1; }
      $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" ;;
    dnf) $SUDO dnf install -y "$@" ;;
    apk) $SUDO apk add --no-cache "$@" ;;
  esac
}

# ---------- 1. 组件表：名称 | 检测命令 | 各包管理器的包名 ----------
has_chromium() { command -v chromium || command -v chromium-browser || command -v google-chrome; }
has_wm()       { command -v matchbox-window-manager; }

declare -A DETECT=(
  [curl]="command -v curl"
  [git]="command -v git"
  [node]="command -v node"
  [xclip]="command -v xclip"
  [tmux]="command -v tmux"
  [xvnc]="command -v Xvnc"
  [wm]="has_wm"
  [websockify]="command -v websockify"
  [chromium]="has_chromium"
  [fonts]="fc-list 2>/dev/null | grep -qi -e noto -e cjk"
  [qrencode]="command -v qrencode"
  [poppler]="command -v pdftoppm"
  [office]="command -v soffice"
)
declare -A PKG_apt=( [git]="git" [node]="nodejs" [xclip]="xclip" [curl]="curl" [tmux]="tmux" [xvnc]="tigervnc-standalone-server tigervnc-tools" [wm]="matchbox-window-manager"
  [websockify]="websockify" [chromium]="chromium" [fonts]="fonts-noto-cjk fonts-noto-color-emoji fontconfig" [qrencode]="qrencode" [poppler]="poppler-utils" [office]="libreoffice-writer-nogui" )
declare -A PKG_dnf=( [git]="git" [node]="nodejs" [xclip]="xclip" [curl]="curl" [tmux]="tmux" [xvnc]="tigervnc-server" [wm]="matchbox-window-manager"
  [websockify]="python3-websockify" [chromium]="chromium" [fonts]="google-noto-sans-cjk-fonts fontconfig" [qrencode]="qrencode" [poppler]="poppler-utils" [office]="libreoffice-writer" )
declare -A PKG_apk=( [git]="git" [node]="nodejs" [xclip]="xclip" [curl]="curl bash" [tmux]="tmux" [xvnc]="tigervnc" [wm]="matchbox-wm"
  [websockify]="py3-websockify" [chromium]="chromium" [fonts]="font-noto-cjk fontconfig" [qrencode]="libqrencode-tools" [poppler]="poppler-utils" [office]="libreoffice-writer" )

# Ubuntu 的 chromium 是 snap 过渡包，包名不同
[ "$OS_ID" = "ubuntu" ] && PKG_apt[chromium]="chromium-browser"

# office = Word 文件卡片的第一页缩略图（LibreOffice，无界面版）
ORDER=(curl git node tmux xvnc wm websockify chromium xclip qrencode poppler office)
# 可选：登录窗口里网页出现中文方块时，传 WITH_CJK_FONTS=1 再装字体
[ "${WITH_CJK_FONTS:-0}" = "1" ] && ORDER+=(fonts)
ALL_OK=true

for name in "${ORDER[@]}"; do
  if eval "${DETECT[$name]}" >/dev/null 2>&1; then
    check "$name" true; continue
  fi
  check "$name" false
  eval "pkgs=\${PKG_${PM}[$name]}"
  inst "$name" start "$pkgs"
  if out=$(pm_install $pkgs 2>&1) && eval "${DETECT[$name]}" >/dev/null 2>&1; then
    inst "$name" ok
  else
    inst "$name" fail "$(printf '%s' "$out" | tail -n 3)"
    ALL_OK=false
  fi
done

# ---------- 2. Claude Code（官方原生安装器，不需要 sudo） ----------
export PATH="$HOME/.local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  check claude true
  emit "{\"type\":\"version\",\"name\":\"claude\",\"value\":\"$(jstr "$(claude --version 2>/dev/null)")\"}"
else
  check claude false
  inst claude start "official native installer"
  if out=$(curl -fsSL https://claude.ai/install.sh | bash 2>&1) && command -v claude >/dev/null 2>&1; then
    inst claude ok "$(claude --version 2>/dev/null)"
    grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
  else
    inst claude fail "$(printf '%s' "$out" | tail -n 3)"
    ALL_OK=false
  fi
fi

# ---------- 3. 登录状态（只读检测，不触发登录） ----------
if [ -f "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  emit '{"type":"auth","logged_in":true}'
else
  emit '{"type":"auth","logged_in":false}'
fi

emit "{\"type\":\"done\",\"ok\":$ALL_OK}"
