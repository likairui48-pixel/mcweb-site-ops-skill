# 事故复盘（同禾境网站）

> 每一条都是真实发生过的。写下来的目的只有一个：**别再来第二次**。
> 格式：现象 → 根因 → 修法 → 如何不再犯。

---

## 1. 站长上传收款码 500（EACCES）—— 反复发生了 19 次

**现象**：站长在后台传收款码图片 → 500。日志里 `EACCES` 共 19 条。

**根因**：服务在 systemd 里降权成 `User=mcweb`，但上传目录 `/opt/mcweb/public/static/pay`
是 `root:root 755`（部署时以 root 身份 `scp -r` 造成的），降权进程没权限写。

**修法**：
```sh
chown -R mcweb:mcweb /opt/mcweb/public/static/pay
```
并且加**自愈**（否则下次部署又会 root 化）：
```
# /etc/systemd/system/mcweb.service
ExecStartPre=+/bin/mkdir -p /opt/mcweb/public/static/pay /opt/mcweb/public/static/app /opt/mcweb/data
ExecStartPre=+/bin/chown -R mcweb:mcweb /opt/mcweb/public/static/pay /opt/mcweb/public/static/app /opt/mcweb/data
```
（`+` 前缀 = 以 root 执行，因为主进程是降权的）
`server.js` 里也加了 `saveUpload(dir, name, buf)` 统一处理上传落盘。

**如何不再犯**：**每新增一个要被服务写入的目录，必须同时登记到两处**：
`deploy-update.sh` 的 `chown -R` 行 + systemd 的 `ExecStartPre`。只有一处 = 迟早复发。
> 2026-09-30 已按此规则把 `public/static/app` 登记进去。

---

## 2. 整站 502 / MODULE_NOT_FOUND —— 只传了一个文件

**现象**：改完 `server.js` 只 `scp` 了这一个文件，服务起不来：
`MODULE_NOT_FOUND: lib/fakes.js`，整站 502。日志里 9 条。

**根因**：`server.js` 里 `require('./lib/fakes')` 是别的会话新写的模块，
生产环境的 `lib/` 里没有 → 启动即崩。

**修法**：全量同步 `server.js` + `lib/` + `public/`，让「本地自洽版本」上线。

**如何不再犯**：**铁律 1** —— 一律 `deploy.sh`（它做全量 + preflight + 健康检查 + 自动回滚）。
`--only-public` 只允许在"确实只改了前端"时用。

---

## 3. 半同步 / 版本漂移 —— 本地修好了，线上还是旧的

**现象 A**：站点 UI 提供 13 个主页背景预设（`g1~g8` + `d1~d4` 墨松/暗夜/绛夜/石墨），
用户选暗色预设后背景被**静默重置**。
**根因**：线上 `lib/social.js` 的白名单是 `/^(?:g[1-8]|d[1-4])$/` 的旧版本之一
（只允许 `g[1-8]`），而前端 `app.js` 的 `App.BG_PRESETS` 已经给了 13 个选项。
按旧白名单会 `bg = ''`。
**修法**：全量部署本地版本（本地 = 修好的）。
**如何不再犯**：部署后 `verify-live.sh` 会逐个文件比 md5，一眼看出漂移。

**现象 B（同类）**：`lib/shop.js` 节日拍照提醒的时间窗，
旧版 `now() < at || now() > at + 150s`（窗口从提醒时刻才开始）→ 定时任务每分钟跑一次，
偶尔会**错过**提醒。新版改成 `now() < at - 60s || now() > at + 150s`（提前 1 分钟就开始）。

**如何不再犯**：**本工作区可能被其他 Aether 会话共用**。部署前 `deploy.sh` 会先打印
"本地与线上不同的文件"，看到自己没改过的文件时，先判断那是别人**在飞的半成品**
（那时**不要**部署）还是**已完成的修复**（那就部署）。

---

## 4. App 更新链接丢了端口 `:8443`

**现象**：`/api/app/version` 返回 `https://<SITE_HOST>/static/app/xxx.apk`
（没有 `:8443`），手机点下载 → `ECONNREFUSED 443`（本站 443 没开）。

**根因**：nginx 里 `proxy_set_header Host $host;` —— **`$host` 不含端口**，
所以 `req.get('host')` 拿不到 `:8443`。

**修法**：对外地址不要靠 Host 头拼，用配置项：
```js
const base = String(process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
```
生产 `.env`：`PUBLIC_BASE_URL=https://<SITE_HOST>`。

**如何不再犯**：`verify-live.sh` 第 4 步会**真的去下一段 256 字节**（Range 请求），
下载不通就是红的。以后换正式域名，**只改这一个 env**。

---

## 5. 用 `pkill -f "node server.js"` 把自己杀了

**现象**：跑完回归想清理服务，`pkill` 一执行，当前 agent 会话/进程也没了。

**根因**：agent 自己的进程命令行里也可能含 `node server.js` 字样，
`-f` 是全命令行匹配 → 连自己一起杀。

**修法**：用 pidfile；兜底扫描 `/proc/*/cmdline` 时**要求路径匹配本工作区绝对路径**：
```sh
for p in /proc/[0-9]*; do
  pid=${p#/proc/}; [ "$pid" = "$$" ] && continue
  [ -r "$p/cmdline" ] || continue
  cmd=$(tr '\0' ' ' 2>/dev/null < "$p/cmdline")
  case "$cmd" in *"/workspace/mcweb/server.js"*) kill "$pid";; esac
done
```

**如何不再犯**：`site-test.sh` 已内置这套逻辑（而且 `[ -r ... ]` 必须先判，
否则进程刚好退出时会刷 `can't open /proc/PID/cmdline`）。

---

## 6. 本地回归的假失败 / OOM

- **必须 fresh**：`site-test.sh` 每次 `rm -rf /tmp/mcwtest` 重建假 MC 根目录与数据库。
  带旧数据跑会出现"注册用户已存在""签到今天已签过"之类的假失败。
- **别并发跑多份**：11G 内存的沙箱里同时跑多个测试实例曾把机器打 OOM。
  `site-test.sh` 用固定端口 8792 + 独占工作目录，**一次只跑一个**。
- 需要另起一个隔离实例时（如 `test-sec-p0` 自己 spawn 服务），用**不同端口 + 不同 DATA_DIR**。

---

## 7. 测试自己造出假警报（会摧毁信任）

**现象**：`test-appapi` 报 `App.bindUploader` 被调用但未定义。
**真相**：`public/app.js:1400` 里那是一句**文档注释**——"然后 `App.bindUploader(el)`…"，
真正定义的是 `App.bindUploaders`（复数）。测试扫源码时把注释里的示例当成了真调用。

**修法**：扫描前先剥注释：
```js
src.replace(/\/\*[\s\S]*?\*\//g, '')                 // 块注释
   .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');        // 行注释（避开 http://）
```
（这个替换要求"`//` 前面不是冒号/引号/反斜杠"，否则会把 `https://` 后面的内容吃掉）

**教训**：**测试报错必须先确认真伪再改代码**。一条假警报会让人以后不再相信整套测试。
> 顺带：这个 bug 让"调用方法数"从 54 修正为 51，8 项全绿。

---

## 8. 沙箱（Alpine）里的工具差异

| 你以为有 | 实际 |
|---|---|
| `curl` / `wget` | **没有 curl**；`wget` 是 BusyBox 版（`wget -qO-` 可以） |
| `bash` | 没有。脚本必须 **POSIX sh**（无 `[[ ]]`、无 `<(...)` 进程替换、无数组） |
| `ls --time-style` / `grep --include` | BusyBox 不支持，报错 |
| `diff` 默认格式 | BusyBox `diff` 输出 **unified** 格式（`-`/`+`），不是 `</>`！解析时用 `^[+-]` 并排除 `---`/`+++` |
| 用 `node -e "fetch(...)"` | ✅ 外网探测/接口测试的正确姿势 |
| 编译 Java / Android | 沙箱里跑不了（proot+PaX：`Failed to mark memory page as executable`）→ 见 skill `android-app-delivery` |

---

## 9. RCON 间歇性抽风是正常的

`[job:log] No response from server` 在历史日志里出现 **28 次**，游戏服（`<GAME_HOST>`）
的 RCON/ SFTP 会间歇性连不上，**通常几分钟内自愈**。

- `/api/health` 里 `rcon.connected` 偶尔 `false`、`lastError: connect ECONNREFUSED ...`
  → 不用立刻处理，先看是否持续 >10 分钟。
- 真正的判断依据是"online 人数是否恢复"，以及游戏服那边是否重启。

---

## 10. 备份只覆盖后端，前端要单独想

`deploy-update.sh` 每次备份 `server.js` + `lib/` + `.env` 到 `backups/upd-<时间戳>/`，
**不备份 `public/`**（前端是只读静态层，且体积大）。

- 后端回滚：`sh scripts/rollback.sh <备份名>`（脚本会 cp + chown + 重启 + 健康检查）
- 前端回滚：找 `backups/ui/` 里的快照，或直接改回本地代码再部署
- **重要**：回滚后本地工作区与线上就**不一致**了；下次部署会把本地版本又推上去。
  那次改动若确认是错的，**先在本地改回来**再部署。

---

## 11. 生产备份 & 恢复演练（待办）

已知待办（用户确认后做）：每日自动备份 SQLite + 上传文件 + 配置，留 14 天，
可选异地 SFTP，并**当场做一次恢复演练**（没演练过的备份不算备份）。

---

## 12. 凭据暴露

`/workspace/.secrets/vps.env` 里的 VPS root 密码**曾经明文暴露在对话里**；
游戏服 RCON 与 SFTP **用的是同一个密码**（弱口令，值见 `/workspace/.secrets/`，**不写进 skill**）。

**待用户操作**：① 轮换 VPS root 密码 ② RCON/SFTP 换两套不同强口令 ③ 证书手动续期。
Agent 这边只做提醒，不擅自改服务器口令（避免把自己锁在外面）。

## 13. 用 Release 分发 APK 时踩的坑（2026-09-30）

**① 更新 Release 的说明文字必须用 release `id`，用 tag 会 404。**
`GET /repos/{o}/{r}/releases/tags/{tag}` ✅ 可以；
但 `PATCH /repos/{o}/{r}/releases/tags/{tag}` ❌ **404**。
更新/删除要走 `PATCH|DELETE /repos/{o}/{r}/releases/{release_id}`。
（先 GET by tag 拿到 `id`，再 PATCH by id。）

**② CI 重新构建的 APK 与本地包"同大小但不同 sha256"。**
zip 条目里带构建时间戳，同一份源码、同样大小，字节可以不一样。
→ **别把本地算的 sha256 写进 Release 说明**（会误导人以为下载坏了）。
GitHub 的资产 API 自带 `digest: "sha256:..."` 字段，用它，零下载成本：
```python
st, rel = api('GET', f'/repos/{R}/releases/tags/{tag}')
{n: a['digest'] for n, a in ((a['name'], a) for a in rel['assets'])}
```

**③ tag 推送会触发 CI，而 CI 会把产物挂进"已存在的同名 Release"。**
于是 release 页出现两套包（手动传的 `thj-app-v1.0.0-arm64.apk` + CI 的
`thj-app-arm64.apk`）。做法：**统一用 CI 的命名**（不带版本号，因为每个 Release
的下载路径 `/releases/download/<tag>/<name>` 已经隔离了版本），手传后把多余的那套删掉。

**④ 私有仓库的 Release 资产下载要登录**（未登录 = 404）；公开仓库才能"发个链接就能下"。
Actions 分钟数也是公开仓库免费。故 App 仓库保持 public。
