#!/bin/sh
# ============================================================================
#  回滚到某个部署前备份
#
#  用法：
#    sh rollback.sh --list                 # 看有哪些备份
#    sh rollback.sh                        # 回滚到最近一次备份
#    sh rollback.sh upd-20260929-212641    # 回滚到指定备份
#
#  说明：deploy-update.sh 每次会备份 server.js + lib/ + .env 到
#        /opt/mcweb/backups/upd-<时间戳>/。
#        ★ public/ 不在备份里（只读静态层），前端要回滚见 reference/pitfalls.md。
# ============================================================================
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/lib.sh"
load_creds || exit 1

WANT=""
LIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST=1; shift;;
    -h|--help) sed -n '2,14p' "$0"; exit 0;;
    *) WANT="$1"; shift;;
  esac
done

c "可用备份（新→旧）"
do_ssh "ls -1dt $APP_REMOTE/backups/upd-* 2>/dev/null | head -15 | sed 's#.*/##'"
do_ssh "ls -1d $APP_REMOTE/backups/sec-* $APP_REMOTE/backups/*.bak-* 2>/dev/null | head -10 | sed 's#.*/##'"
[ "$LIST" = "1" ] && exit 0

if [ -z "$WANT" ]; then
  WANT=$(do_ssh "ls -1dt $APP_REMOTE/backups/upd-* 2>/dev/null | head -1 | sed 's#.*/##'")
  [ -n "$WANT" ] || { bad "没有 upd-* 备份可用"; exit 1; }
  warn "未指定备份，使用最近一次：$WANT"
fi

c "回滚 → $WANT"
do_ssh "test -f $APP_REMOTE/backups/$WANT/server.js" || { bad "备份不存在: $WANT"; exit 1; }
do_ssh "cp -a $APP_REMOTE/backups/$WANT/server.js $APP_REMOTE/server.js && \
        cp -a $APP_REMOTE/backups/$WANT/lib/. $APP_REMOTE/lib/ && \
        chown -R mcweb:mcweb $APP_REMOTE/server.js $APP_REMOTE/lib && \
        systemctl restart mcweb && sleep 5 && systemctl is-active mcweb && \
        curl -s --max-time 10 http://127.0.0.1:8787/api/health | head -c 200"

ok "回滚完成。建议接着跑： sh verify-live.sh"
warn "注意：现在本地工作区与线上不一致 → 下次部署会把本地版本再推上去。"
warn "若本地那次改动是错的，记得先在本地改回来（或 git checkout）再部署。"
