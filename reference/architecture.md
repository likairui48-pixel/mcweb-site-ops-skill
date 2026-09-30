# 同禾境网站 · 架构地图

## 一、代码布局

```
/workspace/mcweb/                （本地；生产在 /opt/mcweb，同构）
├── server.js                   主服务：69 条显式路由 + Socket.IO + 定时任务（1649 行）
├── deploy-update.sh            全量部署脚本（备份→同步→preflight→重启→健康检查→自动回滚）
├── setup-named-tunnel.sh       Cloudflare 命名隧道安装/体检/加固（--check / --harden）
├── .env                        环境变量（生产值；本地回归会读它再覆盖测试项）
├── lib/                        30 个模块，共 9379 行
│   ├── db.js        (619)      SQLite 封装、setting/setSetting、audit、dayCN()（日期统一入口）
│   ├── social.js   (1703)      私信/好友/空间/访客/相册/背景（最大模块）
│   ├── shop.js      (875)      商城/订单/发货/节日商品联动
│   ├── mc.js        (614)      游戏服数据：SFTP 读 world/plugins、玩家列表
│   ├── rank.js      (572)      段位曲线、赛季、榜单计算
│   ├── bot.js       (561)      QQ 机器人（MiraiMC 方向）
│   ├── social2.js   (409)      社交扩展（动态/话题）
│   ├── festival.js  (406)      节日活动/签到/进度
│   ├── ai.js        (318)      举报 AI 初审（只给建议，不自动处罚）
│   ├── skin.js      (289)      皮肤渲染
│   ├── fakes.js     (282)      假人识别与折叠（pattern 只展示、不解析）
│   ├── extdata.js   (275)      外部数据源扩展（AdvancedBanZ 违规记录 / EternalEconomy）
│   ├── bans.js      (192)      游戏封禁管理：stat 指纹巡检 + RCON ban/tempban/unban + 异步回读校验
│   ├── lp.js        (263)      LuckPerms 组读取（组名走白名单）
│   ├── card.js      (256)      玩家名片 PNG 渲染
│   ├── tiers.js     (243)      段位定义 S/A/B/C
│   ├── metrics.js   (239)      性能指标（路径数上限 METRICS_MAX_PATHS）
│   ├── rcon.js      (203)      RCON 客户端（带重连）
│   ├── gamelog.js   (197)      游戏日志采集
│   ├── photos.js    (161)      照片/背景上传与白名单（isBgUrl / isPhotoUrl）
│   ├── ingame.js    (129)      游戏内指令联动
│   ├── logparse.js  (108)      日志解析（!report 举报命令）
│   ├── brand.js      (91)      站点品牌信息
│   ├── auth.js       (91)      登录/注册/会话（session_version 可撤销）
│   ├── sqlite.js     (61)      sqlite 原生绑定
│   ├── zone.js       (59)      时区
│   ├── notify.js     (47)      通知
│   ├── font.js / blockkeys.js / env.js
├── public/                     17 个页面 + app.js(1514) + style.css（v4 设计系统）
│   ├── index.html 首页 · rank.html 排行 · player.html 名片 · search.html 搜索
│   ├── me.html 我的 · profile.html 个人主页 · friends.html 好友 · feed.html 动态
│   ├── forum.html 论坛 · thread.html 帖子 · chat.html 聊天室
│   ├── shop.html 商城 · pay.html 充值 · festival.html 活动 · login.html 登录
│   ├── admin.html 后台 · 404.html
│   └── static/app/             App 分发目录（thj-app-*.apk + version.json）
├── test/                       24 个回归套件（见 test-matrix.md）
└── data/                       生产：SQLite + 上传文件（本地回归用 /tmp/mcwtest/data）
```

## 二、数据流

```
游戏服（<GAME_HOST>）
   ├── RCON :28323   ──→ lib/rcon.js ──→ 指令下发/查询（在线名单、封禁、广播）
   └── SFTP :62022   ──→ lib/mc.js   ──→ 读 world/playerdata、plugins/LuckPerms、日志
                                            ↓
                              lib/db.js（SQLite）→ server.js 路由 → public/ 前端
                                            ↓
                              Socket.IO 实时推送（status/chat/dm/notify/metrics…）
```

**设计原则：不往游戏服装插件。** 站点只通过 RCON + SFTP 只读/只指令交互，
这样游戏服升级/换端不会把站点一起拖死。

**实时推送**：浏览器与 App 都用 Socket.IO。服务端对已登录用户自动加入个人房间
`u:<userId>`；App 端（`socket.io-client-java`）需要用 `extraHeaders` 把同一份 Cookie 带过去。
C→S 只有 `watchAdmin`（需管理员）和 `dmTyping`；其余都是 S→C。

## 三、鉴权与会话

- 会话 Cookie 名 **`mcw_sid`**，HttpOnly + `COOKIE_SECURE=1`（生产）。
- 会话带 `session_version`：改密码/踢下线时版本 +1 → 旧会话立即失效。
- **CSRF**：中间件只拦「带了 `Origin` 且主机名≠`Host`」的写请求；**不带 `Origin` 直接放行**
  → 安卓 App（OkHttp 默认不发 Origin）天然兼容，无需额外配置。
- 登录失败锁定：`LOGIN_MAX_FAILS=10` / `LOGIN_LOCK_MS=900000`（15 分钟）。
- 首个 owner 注册由 `ALLOW_FIRST_OWNER=0` 关闭（防抢注）；owner 是 `player_owner`（id=1）。
- 审计日志**不记明文密码**。

## 四、部署与运行

```sh
# systemd 单元要点（/etc/systemd/system/mcweb.service）
User=mcweb
MemoryMax=1200M
ProtectSystem=strict
ExecStartPre=+/bin/mkdir -p /opt/mcweb/public/static/pay /opt/mcweb/public/static/app /opt/mcweb/data
ExecStartPre=+/bin/chown -R mcweb:mcweb /opt/mcweb/public/static/pay /opt/mcweb/public/static/app /opt/mcweb/data
ExecStartPre=+/usr/bin/find /opt/mcweb/data -maxdepth 1 -name "mcweb.db*" -exec chmod 600 {} +
```

- 生产只监听 `127.0.0.1:8787`，由 nginx 反代；**8443** 对公网 HTTPS。
- `mcweb-tunnel.service` 已停用（旧的临时隧道方案）。
- 日志：`journalctl -u mcweb` / `/var/log/mcweb.log`。

## 五、部署脚本做了什么（deploy-update.sh）

1. 生产备份 → `backups/upd-<时间戳>/`（`server.js` + `lib/` + `.env`）
2. 全量 `scp`：`server.js`、`lib/`、`public/`
   （`scp -r` **不会删**线上独有文件 → 线上独有的 APK 安全）
3. 修属主：`chown -R mcweb:mcweb server.js lib public/static/pay public/static/app data`
4. preflight：`node --check server.js` + 关键模块 `require` 齐全性
5. 重启 + 轮询 `/api/health`（最多 30 秒）
6. 失败 → 自动从本次备份恢复 `server.js` + `lib/` 并重启
7. 末尾外网验证（**可能因超时显示 Terminated，不代表部署失败** → 手工跑 `verify-live.sh`）

## 六、App 侧接口（预留/在用）

| 接口 | 作用 |
|---|---|
| `GET /api/app/version` | 最新版本清单（读 `public/static/app/version.json`，用 `PUBLIC_BASE_URL` 拼绝对下载地址，附 `size`） |
| `GET /api/app/config` | 远程配置：可动态改底部栏 Tab、开关功能（返回空对象 = App 用内置默认） |

发布新版：`sh scripts/release-app.sh`（见 SKILL.md 第 5 节）。

## 七、已知待办（非代码）

1. RCON / SFTP 换成两套不同的强口令（现在两处同密码，值见 `/workspace/.secrets/`）。
2. 轮换 VPS root 密码（旧密码已暴露）。
3. certbot 是 `manual` 模式 → 证书到期需**人工**续期（可考虑改 DNS 验证自动续）。
4. 每日自动备份 + 恢复演练。
5. Cloudflare 命名隧道接入（固定域名 + 免备案），等域名路线拍板。
