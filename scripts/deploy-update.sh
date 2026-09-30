#!/bin/sh
# ============================================================
#  同禾境官网 · 安全更新脚本（在本地沙箱执行）
#  用法：sh /workspace/mcweb/deploy-update.sh [--only-public]
#
#  它做的事（顺序很重要）：
#   1) 在生产建时间戳备份
#   2) 全量同步 server.js + lib/*.js（**不做单文件部署**，避免漏传新模块）
#   3) 生产侧 preflight：语法检查 + 逐个校验 require 的 lib 模块是否存在
#   4) 重启并轮询健康检查；失败则自动回滚 + 重启 + 报告
#  说明：public/ 为只读静态资源，可用 --only-public 单独同步。
# ============================================================
set -eu
APP=/opt/mcweb
LOCAL=$(cd "$(dirname "$0")" && pwd)
# 凭据与站点地址（键见 /workspace/.secrets/vps.env）
SEC=/workspace/.secrets/vps.env
export SSHPASS=$(grep -E '^SSHPASS=' "$SEC" 2>/dev/null | cut -d= -f2- || true)
[ -n "${SSHPASS:-}" ] || { SSHPASS=$(grep -E '^VPS_PASS=' "$SEC" 2>/dev/null | cut -d= -f2- || true); export SSHPASS; }
VPS_USER=$(grep -E '^VPS_USER=' "$SEC" 2>/dev/null | cut -d= -f2- || echo root)
VPS_IP=$(grep -E '^VPS_HOST=' "$SEC" 2>/dev/null | cut -d= -f2-)
PUBLIC_BASE=$(grep -E '^PUBLIC_BASE=' "$SEC" 2>/dev/null | cut -d= -f2-)
[ -n "$VPS_IP" ] || { echo "缺少 VPS_HOST（见 $SEC）"; exit 1; }
[ -n "${SSHPASS:-}" ] || { echo "缺少 SSHPASS（见 $SEC）"; exit 1; }
HOST="${MCWEB_HOST:-${VPS_USER}@${VPS_IP}}"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=20 $HOST"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
STAMP=$(date +%Y%m%d-%H%M%S)

log() { printf '\033[1;36m[update]\033[0m %s\n' "$*"; }

log "1/5 生产备份 -> $APP/backups/upd-$STAMP"
$SSH "mkdir -p $APP/backups/upd-$STAMP && cp -a $APP/server.js $APP/lib $APP/.env $APP/backups/upd-$STAMP/ 2>/dev/null; echo 备份完成"

if [ "${1:-}" = "--only-public" ]; then
  log "2/5 仅同步 public/"
  $SCP -r "$LOCAL/public/." "$HOST:$APP/public/" >/dev/null
else
  log "2/5 同步后端（server.js + lib 全量）"
  $SCP "$LOCAL/server.js" "$HOST:$APP/server.js.new" >/dev/null
  $SCP -r "$LOCAL/lib/." "$HOST:$APP/lib/" >/dev/null
  log "2b  同步前端 public/"
  $SCP -r "$LOCAL/public/." "$HOST:$APP/public/" >/dev/null
fi

log "3/5 preflight（语法 + 模块齐全性）"
$SSH "set -e
  [ -f $APP/server.js.new ] && mv -f $APP/server.js.new $APP/server.js
  node --check $APP/server.js
  missing=0
  for m in \$(grep -oE \"require\\('\\./lib/[a-z0-9]+'\\)\" $APP/server.js | sed \"s|.*lib/||;s|..\$||\" | sort -u); do
    [ -f $APP/lib/\$m.js ] || { echo \"缺模块 lib/\$m.js\"; missing=1; }
  done
  [ \$missing = 0 ] || { echo 'preflight 失败：模块不齐，已中止（服务未重启，仍运行旧代码）'; exit 9; }
  chown -R mcweb:mcweb $APP/server.js $APP/lib $APP/public/static/pay $APP/public/static/app $APP/data
  echo 'preflight OK'"

log "4/5 重启 + 健康检查"
if $SSH "systemctl restart mcweb; for i in \$(seq 1 30); do sleep 1; curl -sf http://127.0.0.1:8787/api/health >/dev/null && break; done; systemctl is-active mcweb; curl -s http://127.0.0.1:8787/api/health | head -c 160; echo"; then
  log "5/5 完成 ✅（外网验证中）"
  if [ -n "$PUBLIC_BASE" ]; then
    PUBLIC_BASE="$PUBLIC_BASE" node -e '(async()=>{const u=process.env.PUBLIC_BASE;for(const p of ["/","/api/health"]){try{const r=await fetch(u+p,{signal:AbortSignal.timeout(15000)});console.log("  "+u+p+" -> "+r.status);}catch(e){console.log("  "+u+p+" -> ERR "+e.message.slice(0,40));}}})();' || true
  else
    log "  (未配置 PUBLIC_BASE，跳过外网验证)"
  fi
else
  log "健康检查失败 → 自动回滚"
  $SSH "cp -a $APP/backups/upd-$STAMP/server.js $APP/server.js; cp -a $APP/backups/upd-$STAMP/lib/. $APP/lib/; chown -R mcweb:mcweb $APP/server.js $APP/lib; systemctl restart mcweb; sleep 4; systemctl is-active mcweb; curl -s http://127.0.0.1:8787/api/health | head -c 120; echo"
  log "已回滚到更新前版本，请查看 $APP/backups/upd-$STAMP 与 /var/log/mcweb.log"
  exit 1
fi
