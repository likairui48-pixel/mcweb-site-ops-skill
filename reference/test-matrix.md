# 测试矩阵：改了什么，就跑什么

运行方式统一是：

```sh
sh <skill>/scripts/site-test.sh                       # Tier 1（默认 7 个，517 项）
sh <skill>/scripts/site-test.sh --suite test-shop     # 指定套件，可逗号分隔
sh <skill>/scripts/site-test.sh --tier all            # 全部 24 个（较慢）
```

脚本会自动：建干净的假 MC 根目录 → 端口 8792 起站 → 逐套件跑 → 汇总 → 关服务。
**套件优先取 `/workspace/mcweb/test/`，没有才用 skill 里的快照。**

## Tier 1 —— 每次改代码都跑（517 项，约 2~4 分钟）

| 套件 | 项数 | 管什么 |
|---|---|---|
| `test-v2` | 78 | 综合接口：段位 / 负载监控 / 品牌 Logo / 社交增强 |
| `test-ui3` | 59 | v3 UI 挂点 + 新功能前端存在性 |
| `test-pages` | 26 | 全部页面渲染冒烟（200 + 关键内容） |
| `test-ui4` | 212 | v4/v5 设计系统与交互规范断言（含图片能力） |
| `test-feat2` | 101 | AI 限频/额度、游戏内联动等第二批功能 |
| `test-appapi` | 8 | **前端引用一致性**：页面用的 `App.xxx` / `/api/xxx` 后端是否真有（防白屏） |
| `test-sec-p0` | 33 | P0 安全基线：会话撤销、越权边界、登录锁定、组名白名单、Cookie 属性、降权、绑定 |

## Tier 2 —— 按模块挑

| 套件 | 自起服务？ | 管什么 / 什么时候跑 |
|---|---|---|
| `test-shop` | 自己 spawn（假 RCON） | 商城：商品、下单、库存限购、收货信息、订单状态机、自动开通（不降级）、卡密、发货、CSV、权限、活动播报 → **动 `lib/shop.js` 必跑** |
| `test-festival` | 自己 spawn | 节日专区：时间轴（含到点播报去重）、签到窗口/连签/里程碑、卡密、后台增删改 → 动 `lib/festival.js` |
| `test-payproof` | 自己 spawn | 付款凭证上传：落盘/落库/管理员可见 → 动充值相关 |
| `test-photos` | 需 BASE | 图片能力：上传魔数/体积/限流、发帖带图、URL 白名单、九宫格、管理撤回 → 动 `lib/photos.js`、`public/app.js` 图片部分 |
| `test-avatar` | 需 BASE | 自定义头像在帖子/动态/留言板/私聊/好友/搜索/空间/头像接口各处的展示 |
| `test-fakes` | 自起 + 假 RCON | 假人折叠与绑定拒绝：UUID 前缀/名字正则/人工名单/白名单、在线折叠、榜单与曲线排除 → 动 `lib/fakes.js` |
| `test-fakes-e2e` | 需 BASE | 假人绑定拒绝的端到端链路（日志 → 轮询 → 判定 → tellraw 拒绝 → 审计） |
| `test-rank` | 直接 require `lib/db`（DATA_DIR=/tmp/mcwrank） | 段位公式校准 + 功能自测（真实数据量级） → 动 `lib/rank.js`、`lib/tiers.js` |
| `test-social` | 自起（8790） | 社交基础链路 → 动 `lib/social.js` |
| `test-dmdup` | 需 BASE | 私聊消息重复 bug 回归（服务端是否把 `dm` 回推给发送者） → 动私信推送 |
| `test-privacy` | 需 BASE | 隐私开关：资料/统计/在线/好友/帖子/名片/搜索/私信/好友申请/留言板 |
| `test-members` | 自起（8790） | 会员体系（LuckPerms 仿真导出） → 动 `lib/lp.js`、会员逻辑 |
| `test-role` | 自己 spawn | 角色权限验收：普通用户 vs 站长的导航与接口边界 → 动权限 |
| `test-banbulk` | 自起（8790，DATA_DIR=/tmp/mcwbb） | 批量封禁/解封 + 路径参数守卫（`/api/dm/null/pin` 500 的回归） |
| `test-bans` | 自起（8793，假 RCON + 假 AdvancedBanZ 库） | 游戏封禁管理：解析插件库、RCON 下发 ban/tempban/unban 秒回（pending）+ 异步回读校验推送、stat 指纹巡检、输入消毒、审计、接口 <1500ms（48 项）→ **动 `lib/bans.js`/后台封禁页必跑** |
| `test-ingame` | 自起（8790） | 游戏内提醒双端互通（RCON 不可达场景） → 动 `lib/ingame.js` |
| `test-bot-e2e` | 需 BASE + 假 AI/RCON | 机器人端到端：日志聊天 → 判断 → 榜单直出/闲聊 → tellraw；含防注入、RCON 出口白名单 |
| `test-bot-replay` | 需 BASE | 机器人「重启重放」回归（部署重启后把旧日志当新消息重答一遍的老问题） → **每次改机器人/日志采集都要跑** |
| `test-feat2` | 需 BASE | 同 Tier 1 |

> 说明：标"需 BASE"的套件由 `site-test.sh` 自动注入 `BASE=http://127.0.0.1:8792`；
> 标"自起服务"的会自己 spawn 一个实例（多数在 8790），所以**必须串行跑**，
> 一次只跑一个套件（脚本已经串行）。

## 测试带来的两个硬性要求

1. **必须 fresh**：脚本每次重建 `/tmp/mcwtest`（假 MC 根 + SQLite）。
   带旧数据跑会出现"用户已存在""今天已签到"之类假失败。
2. **种子用户**：`alice` / `bob` / `carol`，密码 `pass1234`；管理员需自行 register+提权
   （部分套件自带处理）。

## 加/改测试的规矩

- 新功能 → 在 `/workspace/mcweb/test/` 加一个套件，并在本矩阵登记（哪一行、管什么）。
- 套件里判断用 `ck(name, cond, extra)` 风格，**失败要 `process.exit(非 0)`**，
  否则 CI/agent 看不出失败（历史上有过"结果 1 失败但退出码 0"）。
- **别扫注释**：静态检查前先剥 `/* */` 和 `//`。否则文档注释里的示例会被当成真调用，
  报出假警报 —— 假警报会摧毁整套测试的可信度（见 pitfalls 第 7 条）。
- 改测试本身也要跑一遍确认全绿：`sh scripts/site-test.sh --suite <改的那个>`。
