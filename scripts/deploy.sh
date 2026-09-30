#!/bin/sh
# ============================================================================
#  部署到生产（同禾境网站）
#
#  用法：
#    sh deploy.sh                 # 全量部署（server.js + lib/*.js + public/）
#    sh deploy.sh --only-public   # 只改了前端（快）
#    sh deploy.sh --no-verify     # 不跑部署后体检
#    sh deploy.sh --dry-run       # 只看「本地 vs 线上」差异，不部署（推荐先跑这个）
#
#  ★ 铁律：绝对不要单文件 scp 部署！
#    曾只 scp 了 server.js 而漏传 lib/fakes.js → 线上 MODULE_NOT_FOUND → 502。
#    本脚本优先调用工作区里经过实战的 deploy-update.sh（备份→全量同步→preflight
#    →重启轮询健康→失败自动回滚），工作区丢了才用 skill 自带的同名副本。
# ============================================================================
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/lib.sh"
load_creds || exit 1

ONLY_PUBLIC=0; NO_VERIFY=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --only-public) ONLY_PUBLIC=1; shift;;
    --dry-run) DRY=1; shift;;
    --no-verify) NO_VERIFY=1; shift;;
    --app) MCWEB_DIR="$2"; shift 2;;
    -h|--help) sed -n '2,15p' "$0"; exit 0;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done

APP=$(resolve_app_dir) || { bad "找不到工作区"; exit 1; }
export MCWEB_DIR="$APP" VPS_HOST VPS_USER APP_REMOTE

# 部署前提醒：本地和线上已有哪些差异（可能含着别人的未完成改动）
c "0/3 部署前差异速查"
( cd "$APP" && md5sum server.js public/app.js public/style.css $(ls lib/*.js) 2>/dev/null ) | sort -k2 > /tmp/.dep.local
do_ssh "cd $APP_REMOTE && md5sum server.js public/app.js public/style.css \$(ls lib/*.js) 2>/dev/null" | sort -k2 > /tmp/.dep.remote
if [ -s /tmp/.dep.remote ]; then
  DIFFOUT=$(diff /tmp/.dep.local /tmp/.dep.remote | grep -E '^[+-]' | grep -vE '^(---|\+\+\+)')
  CH=$(printf '%s\n' "$DIFFOUT" | grep -c . || true)
  echo "   本地与线上不同的文件：$CH 个（部署会把本地版本推上去）"
  printf '%s\n' "$DIFFOUT" | awk '{print "   " $1, $2}' | sort -u | head -20
else
  warn "拿不到线上 md5，直接部署有风险"
fi

if [ "$DRY" = "1" ]; then
  warn "DRY RUN：只列出将要推送的差异，不做任何改动"
  exit 0
fi

c "1/3 执行部署"
if [ -f "$APP/deploy-update.sh" ]; then
  SCRIPT="$APP/deploy-update.sh"
else
  warn "工作区没有 deploy-update.sh，使用 skill 自带副本"
  SCRIPT="$DIR/deploy-update.sh"
fi
if [ "$ONLY_PUBLIC" = "1" ]; then
  sh "$SCRIPT" --only-public
else
  sh "$SCRIPT"
fi
RC=$?
if [ $RC -ne 0 ]; then
  bad "部署脚本返回失败（$RC）。它通常已自动回滚，仍请手动跑 verify-live.sh 确认"
  exit $RC
fi
ok "部署脚本完成"

c "2/3 关键接口复测"
HB=$(fetch_json "$PUBLIC_BASE/api/health" 25)
case "$HB" in
  200*'"ok":true'*) ok "公网健康: $(echo "$HB" | head -c 150)";;
  *) bad "公网健康异常: $(echo "$HB" | head -c 200)";;
esac

if [ "$NO_VERIFY" = "0" ]; then
  c "3/3 全量体检（md5 一致性 + 接口 + 更新链路）"
  sh "$DIR/verify-live.sh" --app "$APP"
else
  warn "跳过全量体检（--no-verify）"
fi
