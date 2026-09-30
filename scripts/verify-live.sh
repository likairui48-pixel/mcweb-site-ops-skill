#!/bin/sh
# ============================================================================
#  线上体检：本地↔线上一致性 + 进程健康 + 关键接口 + 公网 HTTPS
#
#  用法： sh verify-live.sh [--app /path/mcweb]
#  退出码：0 = 全绿；1 = 有问题
#
#  为什么要有它：曾发生「只传了 server.js 没传 lib/」→ 线上 502 MODULE_NOT_FOUND；
#  也曾发生本地改了 lib/social.js 没上线 → 线上跑旧逻辑（暗色背景预设被静默重置）。
#  ★ 部署后必跑本脚本，看到「文件全量一致」才算部署成功。
# ============================================================================
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/lib.sh"

while [ $# -gt 0 ]; do
  case "$1" in
    --app) MCWEB_DIR="$2"; shift 2;;
    -h|--help) sed -n '2,12p' "$0"; exit 0;;
    *) echo "未知参数: $1"; exit 2;;
  esac
done

APP=$(resolve_app_dir) || { bad "找不到 mcweb 工作区（--app 指定）"; exit 1; }
need_node || exit 1
load_creds || exit 1

PROBLEM=0
TMP=/tmp/.verifylive.$$
FILESPEC="server.js public/index.html public/app.js public/style.css"
[ -f "$APP/public/static/app/version.json" ] && FILESPEC="$FILESPEC public/static/app/version.json"
LIBS=$(cd "$APP" && ls lib/*.js 2>/dev/null | tr '\n' ' ')

# ---------------- 1. 本地 ↔ 线上 md5 ----------------
c "1/4 文件一致性（本地 ↔ 线上）"
( cd "$APP" && md5sum $FILESPEC $LIBS 2>/dev/null ) | awk '{print $1, $2}' | sort -k2 > "$TMP.local"
do_ssh "cd $APP_REMOTE && md5sum $FILESPEC $LIBS 2>/dev/null" | awk '{print $1, $2}' | sort -k2 > "$TMP.remote"
if [ -s "$TMP.remote" ]; then
  if diff -q "$TMP.local" "$TMP.remote" >/dev/null 2>&1; then
    ok "全部一致（$(wc -l < "$TMP.local" | tr -d ' ') 个文件）"
  else
    bad "存在差异（左=本地 右=线上）："
    diff "$TMP.local" "$TMP.remote" | grep -E '^[+-]' | grep -vE '^(---|\+\+\+)' | head -20
    PROBLEM=1
  fi
else
  bad "拿不到线上 md5（SSH 不通？）"; PROBLEM=1
fi

# ---------------- 2. 进程与健康 ----------------
c "2/4 进程 / 健康"
SV=$(do_ssh 'systemctl is-active mcweb; systemctl is-active nginx')
echo "   systemd: $(echo "$SV" | tr '\n' ' ')"
case "$SV" in *failed*|*inactive*) bad "有服务未运行"; PROBLEM=1;; esac
H=$(do_ssh 'curl -s --max-time 10 http://127.0.0.1:8787/api/health')
case "$H" in
  *'"ok":true'*) ok "健康: $(echo "$H" | head -c 160)";;
  "") bad "健康接口无响应"; PROBLEM=1;;
  *) bad "健康异常: $(echo "$H" | head -c 160)"; PROBLEM=1;;
esac
case "$H" in
  *'"rcon":{"connected":true'*) :;;
  *'"connected":false'*) warn "RCON 未连接（游戏服抽风时会自愈，持续 >10 分钟再查）";;
esac

# ---------------- 3. 关键接口（公网 HTTPS）----------------
c "3/4 公网接口 $PUBLIC_BASE"
need_node
node -e '
const B = process.argv[1];
const paths = ["/api/health", "/api/status", "/api/rank/board?limit=3", "/api/app/version", "/api/app/config", "/api/search?q=a", "/api/chat/recent", "/api/pay/info"];
(async () => {
  for (const p of paths) {
    try {
      const t0 = Date.now();
      const r = await fetch(B + p, { signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      let tag = r.ok ? "ok  " : "BAD ";
      if (r.ok) { try { const j = JSON.parse(t); if (j && j.ok === false) tag = "BAD "; } catch (_) {} }
      console.log(`   ${tag} ${String(r.status).padEnd(3)} ${String(Date.now() - t0).padStart(5)}ms  ${p}  ${t.slice(0, 90).replace(/\s+/g, " ")}`);
      if (tag === "BAD ") process.exitCode = 9;
    } catch (e) {
      console.log(`   ERR      -  ${p}  ${e.message}`);
      process.exitCode = 9;
    }
  }
})()' "$PUBLIC_BASE" || PROBLEM=1

# ---------------- 4. App 更新链路（下载链接必须带端口）----------------
c "4/4 App 在线更新链路"
node -e '
const B = process.argv[1];
(async () => {
  try {
    const r = await fetch(B + "/api/app/version", { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    const m = j.latest || {};
    console.log(`   版本 ${m.version} (code ${m.versionCode})  force=${m.force}  size=${m.size || "?"}`);
    console.log(`   链接 ${m.url}`);
    // 最常见的坑：nginx 的 $host 不含端口 → 链接丢 :8443 → 手机点下载打不开。
    // 真正的判据是「能不能下到」，所以下面直接取 256 字节实测。
    const origin = (m.url.match(/^https?:\/\/[^/]+/) || [""])[0];
    if (origin && origin.indexOf(":", 6) < 0) {
      console.log("   ⚠️  链接没带端口（依赖 443 直连）；建议线上 .env 设 PUBLIC_BASE_URL=https://域名:8443");
    }
    const d = await fetch(m.url, { headers: { Range: "bytes=0-255" }, signal: AbortSignal.timeout(30000) });
    console.log(`   下载自测 HTTP ${d.status}  ${d.headers.get("content-range") || d.headers.get("content-length")}  ${d.headers.get("content-type")}`);
    if (d.status !== 206 && d.status !== 200) process.exit(9);
  } catch (e) { console.log("   ❌ " + e.message); process.exit(9); }
})()' "$PUBLIC_BASE" || PROBLEM=1

rm -f "$TMP.local" "$TMP.remote"
printf '\n================================================\n'
if [ "$PROBLEM" = "0" ]; then ok "体检通过：本地=线上，服务健康，接口与更新链路正常"; else bad "体检发现问题（见上）"; fi
printf '================================================\n'
exit "$PROBLEM"
