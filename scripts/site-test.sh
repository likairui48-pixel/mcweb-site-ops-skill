#!/bin/sh
# ============================================================================
#  同禾境网站「改完必跑」回归测试
#
#  用法：
#    sh site-test.sh                     # 跑 Tier 1（默认，约 420 项，2~4 分钟）
#    sh site-test.sh --tier all          # Tier 1 + Tier 2 全量
#    sh site-test.sh --suite test-shop   # 只跑某个套件（可逗号分隔）
#    sh site-test.sh --list              # 看有哪些套件
#    sh site-test.sh --keep              # 跑完不关服务（方便手工复现）
#    sh site-test.sh --app /path/mcweb   # 指定工作区
#
#  做了什么：造一个假 MC 服务器根目录 → 端口 8792 起站（数据在 /tmp，不碰生产）
#           → 逐个跑套件 → 汇总 → 关服务（只杀自己起的 pid，绝不 pkill）
# ============================================================================
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/lib.sh"
need_node || exit 1

TIER=1
SUITES=""
KEEP=0
PORT="${PORT:-8792}"
WORK="${WORK:-/tmp/mcwtest}"

while [ $# -gt 0 ]; do
  case "$1" in
    --tier) TIER="$2"; shift 2;;
    --suite) SUITES="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --app) MCWEB_DIR="$2"; shift 2;;
    --work) WORK="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    --list) ls "$DIR/../tests" | sed 's/\.cjs$//' | tr '\n' ' '; echo; exit 0;;
    -h|--help) sed -n '2,16p' "$0"; exit 0;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done

APP=$(resolve_app_dir) || { bad "找不到 mcweb 工作区（用 --app 指定）"; exit 1; }
c "工作区: $APP"

# ---------- Tier 定义（Tier 1 = 每次改代码都跑） ----------
TIER1="test-v2 test-ui3 test-pages test-ui4 test-feat2 test-appapi test-sec-p0"
# 其余为 Tier 2：按模块挑着跑，见 reference/test-matrix.md
if [ -n "$SUITES" ]; then
  LIST=$(echo "$SUITES" | tr ',' ' ')
elif [ "$TIER" = "all" ]; then
  LIST=""
  for f in "$DIR/../tests"/*.cjs; do LIST="$LIST $(basename "$f" .cjs)"; done
elif [ "$TIER" = "1" ]; then
  LIST="$TIER1"
else
  LIST="$TIER1"
fi
# 去重 + 只保留存在的
FINAL=""
for s in $LIST; do
  case " $FINAL " in *" $s "*) continue;; esac
  { [ -f "$APP/test/$s.cjs" ] || [ -f "$DIR/../tests/$s.cjs" ]; } || { warn "跳过不存在的套件: $s"; continue; }
  FINAL="$FINAL $s"
done
LIST="$FINAL"

# ---------- 造干净环境 ----------
rm -rf "$WORK"
mkdir -p "$WORK/data"
cp -r "$DIR/../templates/fakemc" "$WORK/mcfake" 2>/dev/null || bad "fixture 缺失: $DIR/../templates/fakemc"

# ---------- 起站 ----------
PIDF="$WORK/pid"
LOG="$WORK/server.log"
cd "$APP" || exit 1
# 注意：带 .env 里的变量（与历史回归一致），但用测试值覆盖 MC/端口/数据目录
ENVARGS=""
if [ -f .env ]; then
  ENVARGS=$(grep -v '^#' .env | grep '=' | grep -v '^SSHPASS=' | tr '\n' ' ')
fi
# shellcheck disable=SC2086
setsid nohup env $ENVARGS \
  MC_HOST=127.0.0.1 MC_RCON_HOST=127.0.0.1 MC_RCON_PORT=1 \
  DATA_DIR="$WORK/data" MC_LOCAL_ROOT="$WORK/mcfake" \
  SCAN_START_DELAY_MS=300 LOG_POLL_MS=5000 PORT="$PORT" \
  COOKIE_SECURE=0 BIND_HOST=127.0.0.1 \
  node server.js > "$LOG" 2>&1 &
echo $! > "$PIDF"

i=0; READY=0
while [ $i -lt 60 ]; do
  if node -e "fetch('http://127.0.0.1:$PORT/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then READY=1; break; fi
  i=$((i+1)); sleep 0.5
done
if [ "$READY" != "1" ]; then
  bad "服务没起来（端口 $PORT）。日志尾部："
  tail -20 "$LOG"
  kill "$(cat "$PIDF")" 2>/dev/null
  exit 1
fi
ok "服务就绪 http://127.0.0.1:$PORT （pid $(cat "$PIDF")）"

# ---------- 跑套件 ----------
PASS=0; FAIL=0; FAILED=""
cleanup() {
  if [ "$KEEP" = "1" ]; then warn "保留了服务（pid $(cat "$PIDF" 2>/dev/null)），收工请执行: kill \$(cat $PIDF)"; else
    kill "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null
    # 兜底：按 pidfile 校验过的进程号，再确认一次命令行含本工作区路径才杀（绝不 pkill）
    for p in /proc/[0-9]*; do
      p_pid=${p#/proc/}
      [ "$p_pid" = "$$" ] && continue
      [ -r "$p/cmdline" ] || continue
      cmd=$(tr '\0' ' ' 2>/dev/null < "$p/cmdline")
      case "$cmd" in *"$APP/server.js"*) kill "$p_pid" 2>/dev/null;; esac
    done
  fi
}
trap cleanup EXIT INT TERM

for s in $LIST; do
  # 套件路径：工作区 test/ 优先（那里是最新的），skill 自带快照兜底
  SF="$APP/test/$s.cjs"
  [ -f "$SF" ] || SF="$DIR/../tests/$s.cjs"
  printf '\n\033[1;35m======== %s ========  (%s)\033[0m\n' "$s" "$SF"
  OUT=$(cd "$APP" && BASE="http://127.0.0.1:$PORT" MC_LOCAL_ROOT="$WORK/mcfake" DATA_DIR="$WORK/data" \
        MCWEB_DIR="$APP" node "$SF" 2>&1)
  RC=$?
  echo "$OUT" | tail -8
  TAILFAIL=$(echo "$OUT" | tail -5 | grep -cE 'FAIL|!!|✗|❌|失败 [1-9]' || true)
  if [ $RC -eq 0 ] && [ "$TAILFAIL" = "0" ]; then
    ok "$s 通过"
    PASS=$((PASS+1))
  else
    bad "$s 失败（退出码 $RC）"
    FAIL=$((FAIL+1)); FAILED="$FAILED $s"
  fi
done

printf '\n================================================\n'
if [ $FAIL -eq 0 ]; then
  ok "全部通过：$PASS 个套件"
else
  bad "失败 $FAIL 个：$FAILED"
  ok "通过 $PASS 个"
fi
printf '================================================\n'
[ "$FAIL" -eq 0 ] || exit 1
