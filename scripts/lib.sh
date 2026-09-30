#!/bin/sh
# 同禾境网站运维公共函数（POSIX sh，Alpine/BusyBox 可用）
# 用法： . "$(dirname "$0")/lib.sh"

# ---- 定位工作区 ----
# 优先级：环境变量 MCWEB_DIR > /workspace/mcweb > 脚本所在 skill 的 templates 说明
resolve_app_dir() {
  if [ -n "${MCWEB_DIR:-}" ] && [ -f "$MCWEB_DIR/server.js" ]; then echo "$MCWEB_DIR"; return 0; fi
  if [ -f /workspace/mcweb/server.js ]; then echo /workspace/mcweb; return 0; fi
  for d in "$HOME/mcweb" "$HOME/thj/mcweb" /opt/mcweb; do
    [ -f "$d/server.js" ] && { echo "$d"; return 0; }
  done
  echo "" ; return 1
}

# ---- 读取 VPS 凭据 + 站点地址（永不打印密码）----
# 需要的键（写在 /workspace/.secrets/vps.env）：
#   VPS_HOST=服务器IP   VPS_USER=root   SSHPASS=密码   PUBLIC_BASE=https://域名:端口
load_creds() {
  VPS_USER="${VPS_USER:-root}"
  APP_REMOTE="${APP_REMOTE:-/opt/mcweb}"
  for f in "${CRED_FILE:-}" /workspace/.secrets/vps.env "$HOME/.aether/secrets/vps.env" "$HOME/.secrets/vps.env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    _h=$(grep -E '^VPS_HOST=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    _u=$(grep -E '^VPS_USER=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    _b=$(grep -E '^PUBLIC_BASE=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    _p=$(grep -E '^(SSHPASS|VPS_PASS)=' "$f" 2>/dev/null | head -1 | cut -d= -f2-)
    [ -n "$_h" ] && VPS_HOST="$_h"
    [ -n "$_u" ] && VPS_USER="$_u"
    [ -n "$_b" ] && PUBLIC_BASE="$_b"
    if [ -n "$_p" ] && [ -z "${SSHPASS:-}" ]; then SSHPASS="$_p"; export SSHPASS; fi
  done
  [ -n "${VPS_HOST:-}" ] || { echo "❌ 缺少 VPS_HOST（在 /workspace/.secrets/vps.env 里加 VPS_HOST=服务器IP）" >&2; return 1; }
  [ -n "${PUBLIC_BASE:-}" ] || PUBLIC_BASE="https://$VPS_HOST"
  export VPS_HOST VPS_USER PUBLIC_BASE
  [ -n "${SSHPASS:-}" ] || { echo "❌ 缺少 SSHPASS（在 /workspace/.secrets/vps.env 里加 SSHPASS=密码）" >&2; return 1; }
}

SSH_BASE="sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"
SCP_BASE="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"

do_ssh()  { $SSH_BASE "$VPS_USER@$VPS_HOST" "$@" 2>/dev/null; }
do_scp()  { $SCP_BASE "$@" 2>/dev/null; }

# ---- 输出 ----
c() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m✅ %s\033[0m\n' "$*"; }
bad() { printf '\033[1;31m❌ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠️  %s\033[0m\n' "$*"; }

# ---- Node 探测（沙箱没有 curl，用 node 代替）----
need_node() {
  command -v node >/dev/null 2>&1 || { echo "❌ 需要 node" >&2; return 1; }
}

# ---- 用法：fetch_json <url> [秒] ----
fetch_json() {
  node -e "
    (async () => {
      try {
        const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(($2||20)*1000) });
        const t = await r.text();
        process.stdout.write(r.status + ' ' + t.slice(0, 400));
      } catch (e) { process.stdout.write('ERR ' + e.message); }
    })()" "$1"
}
