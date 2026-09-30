#!/bin/sh
# ============================================================================
#  发布 App 新版本（同禾境安卓客户端）
#
#  用法：
#    sh release-app.sh <APK路径> --version 1.1.0 --code 2 --notes "新增聊天室|修复闪退"
#       [--abi arm64|arm32|x86_64|universal]   （默认 arm64）
#       [--url-abis arm64,arm32]               （同时上传多个 ABI，下载链接仍指向主 ABI）
#       [--force]                              （强制更新）
#       [--no-deploy]                          （只传文件不改 version.json / 不部署）
#
#  它会做：
#    ① 校验 APK（包名 cn.mcfuns.thj / 签名 / Release AOT）
#    ② 传到生产 /opt/mcweb/public/static/app/
#    ③ 改本地 public/static/app/version.json，再走 deploy.sh 全量部署
#    ④ 实测 /api/app/version 与下载直链（Range 206）
#
#  出包本身用另一个 skill：android-app-delivery（沙箱编译不了 → GitHub Actions）。
# ============================================================================
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
. "$DIR/lib.sh"
load_creds || exit 1

APK=""; VER=""; CODE=""; NOTES=""; ABI=arm64; URL_ABIS=""; FORCE=0; DEPLOY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VER="$2"; shift 2;;
    --code) CODE="$2"; shift 2;;
    --notes) NOTES="$2"; shift 2;;
    --abi) ABI="$2"; shift 2;;
    --url-abis) URL_ABIS="$2"; shift 2;;
    --force) FORCE=1; shift;;
    --no-deploy) DEPLOY=0; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    -*) echo "未知参数: $1"; exit 2;;
    *) APK="$1"; shift;;
  esac
done
[ -n "$APK" ] && [ -f "$APK" ] || { bad "用法：sh release-app.sh <APK路径> --version X.Y.Z --code N --notes \"...\""; exit 2; }
[ -n "$VER" ] || { bad "缺少 --version"; exit 2; }
[ -n "$CODE" ] || { bad "缺少 --code（必须是递增的整数，App 靠它比较新旧）"; exit 2; }
APP=$(resolve_app_dir) || { bad "找不到工作区"; exit 1; }

# ---------- ① 校验 APK ----------
c "1/4 校验 APK"
VG=/data/data/com.termux/files/home/.aether/skills/android-app-delivery/scripts/verify_apk.py
if [ -f "$VG" ]; then
  python3 "$VG" "$APK" | tail -12
  python3 "$VG" "$APK" | grep -q "包名            : cn.mcfuns.thj" || { bad "包名不是 cn.mcfuns.thj，拒绝发布"; exit 1; }
  python3 "$VG" "$APK" | grep -q "✅ 通过" || { bad "APK 校验未通过"; exit 1; }
  ok "APK 校验通过"
else
  warn "没找到 verify_apk.py，只做 zip 完整性检查"
  unzip -t "$APK" >/dev/null || { bad "APK 不是有效 zip"; exit 1; }
fi

# ---------- ② 上传 ----------
c "2/4 上传到生产 ($APP_REMOTE/public/static/app/)"
do_ssh "mkdir -p $APP_REMOTE/public/static/app"
do_scp "$APK" "$VPS_USER@$VPS_HOST:$APP_REMOTE/public/static/app/thj-app-$ABI.apk" || { bad "上传失败"; exit 1; }
if [ -n "$URL_ABIS" ]; then
  warn "多 ABI 请手工把其余 APK 传到同目录（命名 thj-app-<abi>.apk）"
fi
do_ssh "chown mcweb:mcweb $APP_REMOTE/public/static/app/thj-app-$ABI.apk; chmod 644 $APP_REMOTE/public/static/app/thj-app-$ABI.apk; ls -lh $APP_REMOTE/public/static/app/ | tail -4"
SZ=$(wc -c < "$APK" | tr -d ' ')
ok "已上传 thj-app-$ABI.apk（$SZ bytes）"

# ---------- ③ 改 version.json（本地，跟着部署走） ----------
c "3/4 更新清单 version.json"
NOTES_JSON=$(printf '%s' "$NOTES" | awk -F'|' '{ out=""; for(i=1;i<=NF;i++){ s=$i; gsub(/^[ \t]+|[ \t]+$/,"",s); gsub(/"/,"",s); if(s!="") out=out (out?", ":"") "\"" s "\"" } print out }')
FORCE_JSON=false; [ "$FORCE" = "1" ] && FORCE_JSON=true
mkdir -p "$APP/public/static/app"
cat > "$APP/public/static/app/version.json" <<JSON
{
  "version": "$VER",
  "versionCode": $CODE,
  "url": "/static/app/thj-app-$ABI.apk",
  "notes": [$NOTES_JSON],
  "force": $FORCE_JSON
}
JSON
cat "$APP/public/static/app/version.json"

if [ "$DEPLOY" = "1" ]; then
  sh "$DIR/deploy.sh" --app "$APP" || { bad "部署失败"; exit 1; }
else
  warn "已跳过部署（--no-deploy）：version.json 已改好，下次 deploy.sh 会生效"
  exit 0
fi

# ---------- ④ 实测更新链路 ----------
c "4/4 实测 App 看到的更新信息"
node -e '
const B = process.argv[1];
(async () => {
  const r = await fetch(B + "/api/app/version", { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  console.log("   服务端版本:", JSON.stringify(j.latest));
  const d = await fetch(j.latest.url, { headers: { Range: "bytes=0-255" }, signal: AbortSignal.timeout(30000) });
  console.log("   下载自测: HTTP", d.status, d.headers.get("content-range") || d.headers.get("content-length"));
  if (d.status !== 206 && d.status !== 200) process.exit(9);
})()' "$PUBLIC_BASE" || { bad "更新链路实测失败"; exit 1; }
ok "新版已发布。App 端最迟下次启动/检查更新时提示升级（也可在「我的 → 检查更新」手动触发）"
