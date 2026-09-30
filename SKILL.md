---
name: mcweb-site-ops
description: >-
  「同禾境」Minecraft 社区网站（mcweb）的全生命周期运维：改代码、跑回归、部署上线、
  线上体检、回滚、发 App 新版。当用户要改网站/改样式/加功能/上线/部署/回滚/发新版 App，
  或网站出现 500 / 502 / EACCES / 接口 404 / 页面白屏，或任何涉及 /workspace/mcweb、
  /opt/mcweb、同禾境网站域名、mcweb 服务的操作时，必须使用本 skill。
  Triggers: 同禾境网站, mcweb, 网站部署, 上线, 发版, 回滚, 改样式, 加功能, 502, 500,
  EACCES, MODULE_NOT_FOUND, 更新 App, APK 更新接口.
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep
---

# 同禾境网站运维（改 → 测 → 部署 → 体检 → 回滚）

**一句话原则：永远不要单文件部署；改完必须先跑回归；部署后必须核对 md5。**
下面每一条都是从真实事故里换来的，不是"最佳实践"清单。

---

## 0. 三条铁律（都违反过，都付过代价）

| # | 铁律 | 违反的下场 |
|---|---|---|
| 1 | **禁止单文件 scp 部署**，一律走 `deploy.sh`（备份 → 全量同步 → preflight → 重启轮询健康 → 失败自动回滚） | 曾只传 `server.js` 漏传 `lib/fakes.js` → 线上 `MODULE_NOT_FOUND` → **整站 502** |
| 2 | **部署前后核对 md5**；本工作区可能与其他 Aether 会话共用，本地树才是"自洽版本" | 曾本地修好 `lib/social.js`（暗色背景预设）没上线 → 线上跑旧逻辑，用户选「墨松/暗夜」背景被**静默重置** |
| 3 | **前端只做增量**：`public/style.css` 旧类名与设计令牌**零删减**，新的追加在文件末尾 | 删旧类名会连带打断线上未改版的页面 |

---

## 1. 脚本速查（这就是本 skill 的主要价值）

所有脚本都在 `<skill_dir>/scripts/`，**POSIX sh**，手机沙箱（Alpine/BusyBox）直接能跑。

| 我要做什么 | 命令 |
|---|---|
| 改完代码，自测 | `sh scripts/site-test.sh` |
| 只跑了某个模块，跑对应套件 | `sh scripts/site-test.sh --suite test-shop,test-festival` |
| 看有哪些套件 | `sh scripts/site-test.sh --list` |
| 上线 | `sh scripts/deploy.sh` |
| 只改了前端，快上线 | `sh scripts/deploy.sh --only-public` |
| 部署后体检（**必做**） | `sh scripts/verify-live.sh` |
| 回滚 | `sh scripts/rollback.sh --list` → `sh scripts/rollback.sh upd-20260929-212641` |
| 发 App 新版 | `sh scripts/release-app.sh <apk> --version 1.1.0 --code 2 --notes "新增聊天室\|修闪退"` |

> `deploy.sh` / `verify-live.sh` 依赖 `/workspace/.secrets/vps.env` 里的 `SSHPASS`（或 `VPS_PASS`）。
> 密码只用于 `sshpass`，脚本永不打印它。

---

## 2. 标准流程：改一次代码的完整 5 步

```sh
# ① 定位影响面：改后端还是前端？改哪个模块？（→ 第 4 节测试矩阵）
# ② 改代码。前端注意铁律 3（只增量、零删减）。
# ③ 本地回归（必须 fresh，否则残留数据会造出假失败）
sh <skill>/scripts/site-test.sh                 # Tier 1，约 2~4 分钟，517 项
sh <skill>/scripts/site-test.sh --suite test-shop   # 改了商城再加跑对应套件
# ④ 先 dry-run：看「本地 vs 线上」差异，确认没有别的会话的在飞改动
sh <skill>/scripts/deploy.sh --dry-run
#    如果列表里出现"你没改过的文件" → 停下！那是另一个会话正在写的东西，
#    推上去可能上线半成品。等对方提交完再部署（或由对方部署）。
sh <skill>/scripts/deploy.sh          # 全量部署
# ⑤ 体检：看到「全部一致」才算成功
sh <skill>/scripts/verify-live.sh
```

**步骤 ⑤ 的验收标准**（缺一不可）：

- `文件一致性` → **全部一致**（本地 md5 == 线上 md5）
- `systemd: active active`（mcweb + nginx）
- `/api/health` → `"ok":true`，`rcon.connected:true`
- 8 个关键接口 200 且 `ok` 不为 false
- App 更新链路：`/api/app/version` 链接**带 `:8443`**，下载自测 HTTP 206

---

## 3. 环境地图（记不住就看这里）

| 项 | 值 |
|---|---|
| 本地代码 | `/workspace/mcweb`（server.js 1541 行 + `lib/` 29 个模块 9170 行 + `public/` 17 个页面） |
| 生产代码 | `/opt/mcweb`（VPS `<VPS_IP>`，root@22） |
| 服务 | systemd `mcweb`（`User=mcweb` + 沙箱 + `MemoryMax=1200M`）、nginx；日志 `/var/log/mcweb.log` |
| 端口 | 8787 仅内网（`BIND_HOST=127.0.0.1`）；**8443 = 公网 HTTPS**；8080 → 301 到 HTTPS |
| 公网地址 | `https://<SITE_HOST>`（LE 证书，certbot 是 **manual** → 到期要手动续） |
| 数据 | `data/mcweb.db`(SQLite) + `data/` 上传文件；日期统一用 `lib/db.js` 的 `dayCN()` |
| 游戏服 | RCON `<GAME_HOST>:28323`、SFTP `<GAME_HOST>:62022`（**同密码，待轮换**） |
| 管理员 | `player_owner`（id=1，owner）；角色 owner / admin / vip / user |
| 备份 | 每次部署前 `/opt/mcweb/backups/upd-<时间戳>/`（含 `server.js` + `lib/` + `.env`） |
| 测试实例 | 端口 8792，数据在 `/tmp/mcwtest`（site-test.sh 自动建/清） |

**关键 env**（生产 `/opt/mcweb/.env`）：`NODE_ENV=production`、`COOKIE_SECURE=1`、
`TRUST_PROXY=loopback`、`BIND_HOST=127.0.0.1`、`ALLOW_FIRST_OWNER=0`、`SESSION_DAYS=7`、
`LOGIN_MAX_FAILS=10`、`LOGIN_LOCK_MS=900000`、`METRICS_MAX_PATHS=500`、
**`PUBLIC_BASE_URL=https://<SITE_HOST>`**（少了它 App 更新链接会丢端口）。

---

## 4. 改了哪里 → 该跑什么测试

Tier 1（`site-test.sh` 默认 7 个套件，**每次改代码都跑**）：
`test-v2`（78 通用接口）·`test-ui3`（59）·`test-pages`（26 路由/页面）·
`test-ui4`（212 设计系统）·`test-feat2`（101 游戏内联动）·`test-appapi`（8 前端引用一致性）·
`test-sec-p0`（33 安全基线）

Tier 2（按模块挑）：完整映射表见 `reference/test-matrix.md`。常客：

| 改动模块 | 加跑 |
|---|---|
| 商城/充值/订单 | `test-shop` `test-payproof` |
| 节日/签到/活动 | `test-festival` |
| 照片/背景/头像 | `test-photos` `test-avatar` |
| 排行榜/段位/赛季 | `test-rank` |
| 私信/好友/空间/访客 | `test-social` `test-dmdup` `test-privacy` |
| 权限/角色/会员 | `test-role` `test-members` |
| 假人识别 | `test-fakes` `test-fakes-e2e` |
| QQ 机器人 | `test-bot-e2e` `test-bot-replay` |
| 封禁/处罚 | `test-banbulk` |
| 游戏内举报/日志 | `test-ingame` `test-feat2` |

套件同时存在于两处：**`/workspace/mcweb/test/`（新的，优先）** 与
`<skill>/tests/`（快照兜底，也是"工作区被清空后"的保险）。

---

## 5. 发 App 新版（同禾境安卓客户端）

App 的在线更新链路是：App 读 `GET /api/app/version` → 有新版就打开 `url` 下载安装。

```sh
# 出包用另一个 skill：android-app-delivery（沙箱编译不了 → GitHub Actions）
sh <skill>/scripts/release-app.sh /path/thj-app-arm64.apk \
   --version 1.1.0 --code 2 --notes "新增聊天室|修复闪退"
```

它做 4 件事：① 校验 APK（包名必须是 `cn.mcfuns.thj`、签名、Release AOT）
② 传到 `/opt/mcweb/public/static/app/thj-app-<abi>.apk`
③ 改本地 `public/static/app/version.json` 并全量部署
④ 实测 `/api/app/version` 与下载直链（Range 206）

### 5.1 同时发到 GitHub Release（给孩子/玩家"直接下载"，比网站入口好找）

**首选：打 tag，让 CI 自动发**（`.github/workflows/build-apk.yml` 里已有
`softprops/action-gh-release`，`on: push: tags: v*` 已配好）：

```sh
cd /workspace/thj-app
# 先把 pubspec.yaml 的 version: 1.1.0+2 改好并提交
git tag v1.1.0 && git push origin v1.1.0     # → 云端构建 + 自动挂到同名 Release
```

**兜底：手动传**（网络抖动时的断点重试上传器，也可用于补传/覆盖）：

```sh
python3 <skill>/scripts/gh_release_upload.py \
  --repo likairui48-pixel/thj-app --tag v1.0.1 \
  --name "同禾境 App v1.0.1" --notes-file notes.md \
  --asset /path/thj-app-arm64.apk --asset /path/thj-app-universal.apk
```

它做对了几件现成工具做错的事：**流式上传**（47MB 不撑爆内存）、失败重试、
已存在同名资产先删再传（半截上传会留 0 字节残留）、同名同大小自动跳过（可反复重跑）。
仓库**必须公开**，否则别人（和你手机上没登录 GitHub 时）点开是 404。

> ⚠️ 注意：CI 会**往已存在的同名 Release 里再挂一套** `thj-app-*.apk`（不带版本号）。
> 手动传时别用带版本号的名字，不然 release 页会同时出现两套包，很乱（见 pitfalls 13）。

规则：
- **`versionCode` 必须递增**（App 只靠它比大小，字符串 version 只用来显示）。
- 线上独有的 APK 不会被部署删掉（同步用 `scp -r` 且**没有** `--delete`），但
  `public/static/app/version.json` 是**跟着代码走**的，必须本地改。
- 改完记得 `public/static/app` 属主（新目录要先登记，见 pitfalls 第 1 条）。

---

## 6. 出了事怎么办（对症速查）

| 症状 | 先做什么 |
|---|---|
| 整站 502 / `MODULE_NOT_FOUND` | 十有八九是单文件部署漏了文件 → `sh scripts/rollback.sh` 立刻恢复，再全量 `deploy.sh` |
| 某接口 500 + 日志 `EACCES` | 目录属主被 root 化 → 见 `reference/pitfalls.md` 第 1 条（chown + 登记自愈） |
| 页面报 `xxx is not a function` / 白屏 | 跑了 `test-appapi` 吗？前端调了后端没定义的 `App.xxx` / `/api/xxx` |
| 本地全绿、线上不对 | `verify-live.sh` 看 md5 差异 → 就是没部署全 |
| 部署脚本跑完提示 `Terminated` | 只是脚本末尾的外网验证超时；手工跑 `verify-live.sh` 复核 |
| 游戏人数/榜单不对 | RCON 间歇 `ECONNREFUSED` 会自愈（历史日志 28 次）；持续 >10 分钟再查游戏服 |
| 证书过期告警 | certbot 是 `manual`，需**人工**续期（这是已知待办） |

---

## 7. 安全红线（别越线）

1. **不动** `.env` 里的 LLM provider / 模型 / key（Aether 管理，不属本站运维范畴）。
2. 本站**不做自动清算**：充值走「微信个人收款码 + 人工核对上账」（无牌照不能自动收款）。
3. 上传目录、`data/` 都必须是 `mcweb:mcweb`；**新加的写入目录必须同时登记到**
   `deploy-update.sh` 的 chown 和 systemd 的 `ExecStartPre` 自愈里。
4. 不建议装宝塔面板（与现有 nginx/systemd/降权体系冲突，且是额外攻击面）。
5. 改任何权限/登录/会话逻辑后，**必跑 `test-sec-p0`**（33 项 P0 基线，含降权、绑定、
   锁定、越权、CSRF）。

---

## 8. 目录里还有什么

- `reference/architecture.md` —— 站点结构、模块职责、数据流、nginx/systemd 细节
- `reference/pitfalls.md` —— 12 个真实事故的完整复盘（现象 → 根因 → 修法 → 防止再犯）
- `reference/test-matrix.md` —— 24 个测试套件的用途与"改什么跑哪个"
- `scripts/` —— 上面那 6 个脚本（含 `deploy-update.sh` 的兜底副本）
- `tests/` —— 24 个套件的快照（工作区 `test/` 被清空时的保险）
- `templates/fakemc/` —— 假 MC 服务器根目录（回归测试用，含 usercache/日志/统计/LuckPerms）

**相关 skill**：`android-app-delivery`（出 APK）、`create-extension`（改 Aether 本身）。
