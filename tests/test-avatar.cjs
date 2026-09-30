#!/usr/bin/env node
/**
 * 自定义头像在各场景的展示回归（帖子 / 动态 / 留言板 / 私聊 / 好友 / 搜索 / 玩家空间 / 头像接口）
 *
 * 背景：线上反馈「部分场景仍然无法显示自定义头型【帖子等】」。根因：
 *   1) lib/social.js 论坛帖子的作者对象是「合成」出来的（只取了 username/role 等字段），
 *      传给 pubUser 时没有 avatar 字段 → 一直回落到 /api/avatar/<用户名> 的皮肤头；
 *   2) lib/social2.js 自己的 pubUser 与动态流 / 留言板 / 空间的 user 对象压根不带 avatar；
 *   3) 前端 feed.html / profile.html 只传用户名（字符串）→ 只能走 /api/avatar/<用户名>。
 * 修法：
 *   A. /api/avatar/:name 现在「自定义头像优先」（?skin=1 强制皮肤头）→ 兜住所有按名字取头像的场景；
 *   B. 论坛 / 动态 / 留言板 / 空间 / 关注 等接口全部下发真实 avatar 字段；
 *   C. 前端 App.avatarUrl 对「对象缺 avatar」「服务端兼容写法缺尺寸」都能正确兜底。
 *
 * 自带服务（8788）+ 自带数据目录，不碰生产。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 8788;
const DATA = '/tmp/mcwav';
const BASE = 'http://127.0.0.1:' + PORT;
const SECRET = 'test-avatar-secret-0123456789';
const AVATAR_DIR = path.join(DATA, 'uploads', 'avatars');
const LOCAL_ROOT = '/tmp/mcfake2';

let pass = 0, fail = 0; const fails = [];
function ck(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; fails.push(name); console.log('  !! ' + name + (extra !== undefined ? ' | ' + String(extra).slice(0, 200) : '')); }
}
const sec = (t) => console.log('\n=== ' + t + ' ===');

/* ---------------- 准备数据（必须在起服务之前，避免进程内缓存） ---------------- */
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(AVATAR_DIR, { recursive: true });
process.env.DATA_DIR = DATA;
process.env.SESSION_SECRET = SECRET;
process.env.DB_PATH = path.join(DATA, 'mcweb.db');

const { db } = require('/workspace/mcweb/lib/db');
const { hashPassword, signSession, COOKIE_NAME } = require('/workspace/mcweb/lib/auth');

const now = Date.now();
const insUser = db.prepare('INSERT INTO users (username, pass_hash, is_admin, role, created_at, session_version) VALUES (?, ?, ?, ?, ?, 0)');
const uAv = Number(insUser.run('av_user', hashPassword('x'.repeat(10)), 0, 'user', now).lastInsertRowid);
const uPlain = Number(insUser.run('plain_user', hashPassword('x'.repeat(10)), 0, 'user', now).lastInsertRowid);
const uBoss = Number(insUser.run('av_boss', hashPassword('x'.repeat(10)), 1, 'admin', now).lastInsertRowid);
const insBind = db.prepare('INSERT INTO bindings (user_id, mc_name, uuid, created_at) VALUES (?, ?, ?, ?)');
insBind.run(uAv, 'av_user', 'aaaaaaaa-0000-0000-0000-000000000001', now);
insBind.run(uPlain, 'plain_user', 'bbbbbbbb-0000-0000-0000-000000000002', now);
// stats_cache.updated_at NOT NULL
db.prepare('INSERT INTO stats_cache (uuid, name, level, playtime_ticks, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run('aaaaaaaa-0000-0000-0000-000000000001', 'av_user', 10, 72000, now);
db.prepare('INSERT INTO stats_cache (uuid, name, level, playtime_ticks, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run('bbbbbbbb-0000-0000-0000-000000000002', 'plain_user', 5, 36000, now);

// 自定义头像文件（一张真实的最小 PNG；服务端上传后也是 PNG）
const CUSTOM_PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),          // PNG 签名 + IHDR 长度/类型
  Buffer.from('000000010000000108060000001f15c489', 'hex'),          // 1x1 8bit RGBA
  Buffer.from('0000000d4944415478da63f8cfc000000301010018dd8db1', 'hex'), // IDAT
  Buffer.from('0000000049454e44ae426082', 'hex'),                    // IEND
]);
const AV_FILE = 'av_' + uAv + '_' + now + '.png';
fs.writeFileSync(path.join(AVATAR_DIR, AV_FILE), CUSTOM_PNG);
const AV_URL = '/static/uploads/avatars/' + AV_FILE;
db.prepare('UPDATE users SET avatar = ?, avatar_at = ? WHERE id = ?').run(AV_URL, now, uAv);

const jar = {};
for (const [k, id] of [['av', uAv], ['plain', uPlain], ['boss', uBoss]]) {
  jar[k] = COOKIE_NAME + '=' + signSession(id, 0);
}

/* ---------------- 起服务 ---------------- */
const env = Object.assign({}, process.env, {
  DATA_DIR: DATA, DB_PATH: process.env.DB_PATH, SESSION_SECRET: SECRET,
  MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1',
  MC_LOCAL_ROOT: LOCAL_ROOT, SCAN_ENABLED: '0', PORT: String(PORT),
  LOG_POLL_MS: '3600000', BOT_POLL_MS: '3600000', STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000',
  NODE_ENV: 'test',
});
const log = fs.openSync('/tmp/mcwav.log', 'a');
const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, stdio: ['ignore', log, log] });

const J = (r) => r.json().catch(() => ({}));
async function api(method, p, body, who) {
  const opt = { method, headers: {} };
  if (who) opt.headers.Cookie = jar[who];
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  return { code: r.status, body: await J(r), res: r };
}
async function raw(p, who) {
  const r = await fetch(BASE + p, { headers: who ? { Cookie: jar[who] } : {} });
  const buf = Buffer.from(await r.arrayBuffer());
  return { code: r.status, buf, ct: r.headers.get('content-type'), cache: r.headers.get('cache-control'), etag: r.headers.get('etag') };
}
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

(async () => {
  // 等健康
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(BASE + '/api/health'); up = true; break; } catch { await new Promise((s) => setTimeout(s, 250)); }
  }
  if (!up) { console.log('服务未起来，看 /tmp/mcwav.log'); process.exit(2); }

  sec('A 造数据');
  ck('三个账号已建好', uAv > 0 && uPlain > 0 && uBoss > 0, [uAv, uPlain, uBoss].join(','));
  ck('自定义头像文件已落盘', fs.existsSync(path.join(AVATAR_DIR, AV_FILE)));

  sec('B /api/avatar/:name 自定义头像优先（所有按名字取头像的场景都靠它兜底）');
  const av = await raw('/api/avatar/av_user');
  ck('/api/avatar/av_user 返回图片', av.code === 200 && /image\/png/.test(av.ct), av.code + ' ' + av.ct);
  ck('返回的就是用户上传的那张图（字节一致）', sha(av.buf) === sha(CUSTOM_PNG), sha(av.buf) + ' vs ' + sha(CUSTOM_PNG));
  ck('缓存策略可及时换头像（no-cache + ETag）', /no-cache/.test(av.cache || '') && !!av.etag, (av.cache || '') + ' / ' + (av.etag || ''));
  const av2 = await raw('/api/avatar/av_user?size=32');
  ck('带 size 参数也是自定义头像', sha(av2.buf) === sha(CUSTOM_PNG));
  const skin = await raw('/api/avatar/av_user?skin=1');
  ck('?skin=1 强制皮肤头（皮肤/游戏内场景用）', skin.code === 200 && /image\/png/.test(skin.ct) && sha(skin.buf) !== sha(CUSTOM_PNG), skin.code);
  const plain = await raw('/api/avatar/plain_user');
  const plainSkin = await raw('/api/avatar/plain_user?skin=1');
  ck('没设头像的用户仍是皮肤头', plain.code === 200 && /image\/png/.test(plain.ct) && sha(plain.buf) === sha(plainSkin.buf), plain.code);
  ck('大小写不敏感（AV_USER）', sha((await raw('/api/avatar/AV_USER')).buf) === sha(CUSTOM_PNG));
  const nobody = await raw('/api/avatar/nobody_here_xyz');
  ck('不存在的用户名不报错（回落默认头）', nobody.code === 200 && /image\/png/.test(nobody.ct), nobody.code);

  sec('C 论坛帖子：楼主与回复者都要带自定义头像');
  const mk = await api('POST', '/api/forum/threads', { board: 'general', title: '头像回归帖', body: '测试自定义头像' }, 'av');
  ck('发帖成功', mk.code === 200 || mk.code === 201, JSON.stringify(mk.body).slice(0, 120));
  const tid = mk.body.id || (mk.body.thread && mk.body.thread.id);
  const rep = await api('POST', '/api/forum/thread/' + tid + '/reply', { body: '没头像的人来回复' }, 'plain');
  ck('回帖成功', rep.code === 200 || rep.code === 201, JSON.stringify(rep.body).slice(0, 120));
  const tlist = await api('GET', '/api/forum/threads?board=general', undefined, 'av');
  const t0 = (tlist.body.threads || []).find((t) => t.id === tid);
  ck('帖子列表里楼主带的是自定义头像', t0 && t0.author.avatar === AV_URL, t0 && t0.author.avatar);
  const tdet = await api('GET', '/api/forum/thread/' + tid, undefined, 'av');
  ck('帖子详情楼主带的是自定义头像', tdet.body.thread && tdet.body.thread.author.avatar === AV_URL, tdet.body.thread && tdet.body.thread.author.avatar);
  const p1 = (tdet.body.posts || [])[0];
  ck('回复者（无自定义头像）给的是兜底地址', p1 && p1.author.avatar === '/api/avatar/plain_user', p1 && p1.author.avatar);
  ck('回复者兜底地址能取到图', (await raw('/api/avatar/plain_user')).code === 200);

  sec('D 动态流 / 留言板 / 空间');
  const gb = await api('POST', '/api/guestbook/plain_user', { body: '来踩踩' }, 'av');
  ck('留言成功', gb.code === 200 || gb.code === 201, JSON.stringify(gb.body).slice(0, 100));
  const feed = await api('GET', '/api/feed?scope=all&limit=50', undefined, 'av');
  const items = feed.body.items || [];
  const fi = items.find((i) => i.kind === 'thread' && i.id === tid);
  ck('动态流帖子条目带自定义头像', fi && fi.user.avatar === AV_URL, fi && JSON.stringify(fi.user));
  ck('动态流每条都有可用头像地址（无头像的走兜底）', items.every((i) => i.user && typeof i.user.avatar === 'string' && i.user.avatar.length > 0), JSON.stringify(items.map((i) => i.user && i.user.avatar)));
  const fg = items.find((i) => i.kind === 'guestbook');
  ck('动态流留言条目带头像', fg && fg.user.avatar === AV_URL, fg && JSON.stringify(fg.user));
  const gbr = await api('GET', '/api/guestbook/plain_user', undefined, 'plain');
  ck('留言板接口作者带头像', gbr.body.entries && gbr.body.entries[0].author.avatar === AV_URL, JSON.stringify(gbr.body.entries && gbr.body.entries[0]));
  const space = await api('GET', '/api/space/av_user', undefined, 'av');
  ck('玩家空间返回 avatar 字段', 'avatar' in space.body && space.body.avatar === AV_URL, space.body.avatar);
  const spaceP = await api('GET', '/api/space/plain_user', undefined, 'av');
  ck('没设头像的空间也给可用地址（不是 null/死链）', spaceP.body.avatar === '/api/avatar/plain_user', spaceP.body.avatar);

  sec('E 私聊 / 好友 / 关注 / 搜索');
  const fr = await api('POST', '/api/friends/request', { username: 'plain_user' }, 'av');
  ck('好友申请已发出', fr.code === 200, JSON.stringify(fr.body).slice(0, 100));
  const acc = await api('POST', '/api/friends/accept', { userId: uAv }, 'plain');
  ck('好友申请已通过', acc.code === 200, JSON.stringify(acc.body).slice(0, 100));
  const dm = await api('POST', '/api/dm/' + uPlain, { text: '你好' }, 'av');
  ck('私聊发送成功', dm.code === 200, JSON.stringify(dm.body).slice(0, 100));
  const conv = await api('GET', '/api/dm/conversations', undefined, 'av');
  const c0 = (conv.body.conversations || []).find((c) => c.user.username === 'plain_user');
  ck('私聊会话列表带 user.avatar', c0 && c0.user.avatar === '/api/avatar/plain_user', c0 && c0.user.avatar);
  const convP = await api('GET', '/api/dm/conversations', undefined, 'plain');
  const c1 = (convP.body.conversations || []).find((c) => c.user.username === 'av_user');
  ck('对方看到的会话里是我的自定义头像', c1 && c1.user.avatar === AV_URL, c1 && c1.user.avatar);
  const frd = await api('GET', '/api/friends/enriched', undefined, 'av');
  const f0 = (frd.body.friends || frd.body.list || [])[0];
  ck('好友列表带头像字段', f0 && typeof f0.avatar === 'string', f0 && f0.avatar);
  const fo = await api('POST', '/api/follow/plain_user', undefined, 'av');
  ck('关注成功', fo.code === 200, JSON.stringify(fo.body).slice(0, 80));
  const foInfo = await api('GET', '/api/follow/plain_user', undefined, 'av');
  ck('关注信息接口带 avatar', foInfo.body.avatar === '/api/avatar/plain_user', foInfo.body.avatar);
  const se = await api('GET', '/api/search?q=av_user', undefined, 'av');
  const se2 = await api('GET', '/api/search?q=av', undefined, 'av');
  const se3 = await api('GET', '/api/search?q=%25', undefined, 'av');
  const se4 = await api('GET', '/api/search?q=a_v', undefined, 'av');
  ck('搜索支持用户名里的下划线（av_user 能搜到）', (se.body.users || []).some((u) => u.username === 'av_user'), JSON.stringify(se.body.users || []));
  ck('搜索 % 不会当通配符把全站列出来', (se3.body.users || []).length === 0, JSON.stringify(se3.body.users || []));
  ck('下划线不会被当成通配符（a_v 搜不到 av_user）', !(se4.body.users || []).some((u) => u.username === 'av_user'), JSON.stringify((se4.body.users || []).map((u) => u.username)));
  ck('模糊搜索仍可用（av 能搜到 av_user）', (se2.body.users || []).some((u) => u.username === 'av_user'));
  const s0 = (se.body.users || [])[0];
  ck('搜索结果显示自定义头像', s0 && s0.avatar === AV_URL, JSON.stringify(se.body).slice(0, 200));

  sec('F 上传 / 删除 / 管理员撤回后，接口立刻跟着变');
  let hasCanvas = true;
  try { require('/workspace/mcweb/node_modules/@napi-rs/canvas'); } catch { hasCanvas = false; }
  if (hasCanvas) {
    const canvas = require('/workspace/mcweb/node_modules/@napi-rs/canvas');
    const c = canvas.createCanvas(64, 64); const g = c.getContext('2d');
    g.fillStyle = '#22c55e'; g.fillRect(0, 0, 64, 64);
    const dataUrl = 'data:image/png;base64,' + c.toBuffer('image/png').toString('base64');
    const up = await api('POST', '/api/me/avatar', { data: dataUrl }, 'plain');
    ck('上传头像成功', up.code === 200 && /^\/static\/uploads\/avatars\/av_/.test(up.body.avatar || ''), JSON.stringify(up.body).slice(0, 120));
    const newUrl = up.body.avatar;
    ck('/api/avatar/plain_user 立刻变成新头像', sha((await raw('/api/avatar/plain_user')).buf) === sha(fs.readFileSync(path.join(DATA, 'uploads', 'avatars', path.basename(newUrl)))));
    const tlist2 = await api('GET', '/api/forum/threads?board=general', undefined, 'av');
    const mine = (tlist2.body.threads || []).find((t) => t.id === tid);
    ck('帖子列表跟着变（还是原楼主的）', mine && mine.author.avatar === AV_URL);
    const tdet2 = await api('GET', '/api/forum/thread/' + tid, undefined, 'av');
    ck('回复者头像变成新上传的', tdet2.body.posts[0].author.avatar === newUrl, tdet2.body.posts[0].author.avatar);
    const del = await api('DELETE', '/api/me/avatar', undefined, 'plain');
    ck('删除头像成功', del.code === 200, JSON.stringify(del.body).slice(0, 80));
    ck('删除后文件已清理', !fs.existsSync(path.join(DATA, 'uploads', 'avatars', path.basename(newUrl))));
    ck('删除后 /api/avatar/plain_user 回到皮肤头', sha((await raw('/api/avatar/plain_user')).buf) === sha((await raw('/api/avatar/plain_user?skin=1')).buf));
    const rmv = await api('POST', '/api/admin/avatars/' + uAv + '/remove', { note: '测试撤回', lock: false }, 'boss');
    ck('管理员撤回头像成功', rmv.code === 200, JSON.stringify(rmv.body).slice(0, 100));
    ck('撤回后 /api/avatar/av_user 回到皮肤头', sha((await raw('/api/avatar/av_user')).buf) === sha((await raw('/api/avatar/av_user?skin=1')).buf));
    const tdet3 = await api('GET', '/api/forum/thread/' + tid, undefined, 'av');
    ck('撤回后帖子里的作者也回落（不是死链）', /^\/api\/avatar\//.test(tdet3.body.thread.author.avatar), tdet3.body.thread.author.avatar);
    ck('撤回后该地址仍能取到图（不是 404）', (await raw(tdet3.body.thread.author.avatar + (tdet3.body.thread.author.avatar.includes('?') ? '&' : '?'))).code === 200);
  } else {
    console.log('  (跳过：沙箱里没有 @napi-rs/canvas，上传相关分支由浏览器端验收)');
  }

  sec('G 前端与代码层防线（静态检查）');
  const appJs = fs.readFileSync('/workspace/mcweb/public/app.js', 'utf8');
  ck('app.js 头像地址支持对象/字符串/补尺寸', /if \(url\.indexOf\('\/api\/avatar\/'\) === 0 && url\.indexOf\('\?'\) < 0\)/.test(appJs));
  ck('feed.html 传的是对象（带 avatar）', fs.readFileSync('/workspace/mcweb/public/feed.html', 'utf8').includes('App.avatar(it.user, 40'));
  ck('profile.html 留言传的是对象', fs.readFileSync('/workspace/mcweb/public/profile.html', 'utf8').includes('App.avatar(e.author, 36'));
  const sj = fs.readFileSync('/workspace/mcweb/lib/social.js', 'utf8');
  ck('social.js 有 sendCustomAvatar 且在 /api/avatar 里优先调用', sj.includes('function sendCustomAvatar(res, name)') && /sendCustomAvatar\(res, name\)\) return;/.test(sj));
  ck('论坛列表查询带了 u.avatar', /SELECT t\.\*, u\.username, u\.role, u\.is_admin, u\.avatar, b\.mc_name/.test(sj));
  ck('论坛详情/回复查询带了 u.avatar', (sj.match(/p\.\*, u\.username, u\.role, u\.is_admin, u\.avatar/g) || []).length === 1);
  const s2 = fs.readFileSync('/workspace/mcweb/lib/social2.js', 'utf8');
  ck('social2 pubUser 带 avatar', /role: u\.is_admin \? 'admin' : \(u\.role \|\| 'user'\), avatar: u\.avatar \|\|/.test(s2));
  ck('动态流查询带 u.avatar（3 处）', (s2.match(/, u\.avatar,|u\.avatar,/g) || []).length >= 3);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  try { srv.kill('SIGTERM'); } catch { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})();
