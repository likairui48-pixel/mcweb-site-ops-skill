'use strict';
/**
 * 图片能力端到端测试（帖子配图 + 主页背景 + 管理撤回）
 * 覆盖：上传接口（魔数校验/体积/限流/kind）、发帖带图、URL 白名单、九宫格数据、
 *      回复带图/纯图回复、feed 带图、删除回收文件、主页背景上传/更换/清除、
 *      管理后台「头像与主页背景」撤回与锁定、通知与审计
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8791;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwphotos';
const SECRET = 'test-secret-photos';
let pass = 0, fail = 0; const fails = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 240) : '')); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jar = {};
async function call(who, method, p, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  try { const j = JSON.parse(t); return { ...j, data: j, code: r.status, http: r.status }; } catch (e) { return { code: r.status, http: r.status, raw: t.slice(0, 200) }; }
}
async function raw(p, opts) { return fetch(BASE + p, opts); }
function killLeftover() {
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === process.pid || p === process.ppid) continue;
    try { if (fs.readlinkSync('/proc/' + p + '/cwd') === '/workspace/mcweb' && /node/.test(fs.readlinkSync('/proc/' + p + '/exe'))) process.kill(p, 'SIGTERM'); } catch (e) { /* 忽略 */ }
  }
}
const { createCanvas } = require('/workspace/mcweb/node_modules/@napi-rs/canvas');
function pngDataUrl(w, h, color) {
  const c = createCanvas(w, h); const x = c.getContext('2d');
  x.fillStyle = color || '#2e9e63'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#fff'; x.font = '10px sans-serif'; x.fillText('THJ', 4, 14);
  return 'data:image/png;base64,' + c.toBuffer('image/png').toString('base64');
}

(async () => {
  killLeftover();
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
  const LOGROOT = '/tmp/mcfake-photos';
  fs.rmSync(LOGROOT, { recursive: true, force: true });
  fs.mkdirSync(LOGROOT + '/logs', { recursive: true });
  fs.writeFileSync(LOGROOT + '/logs/latest.log', '');

  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1', MC_RCON_PASSWORD: 'pw',
    DATA_DIR: DATA, MC_LOCAL_ROOT: LOGROOT, SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '3600000',
    PORT: String(PORT), SITE_URL: BASE, SESSION_SECRET: SECRET,
    LOG_POLL_MS: '3600000', STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000', BOT_POLL_MS: '3600000',
  });
  process.env.DATA_DIR = DATA;
  process.env.SESSION_SECRET = SECRET;
  const { db } = require('/workspace/mcweb/lib/db');
  const { hashPassword, signSession, COOKIE_NAME } = require('/workspace/mcweb/lib/auth');
  const now = Date.now();
  const mk = (name, admin) => Number(db.prepare('INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES (?, ?, ?, ?, ?)')
    .run(name, hashPassword('x'.repeat(10)), now, admin ? 'admin' : 'user', admin ? 1 : 0).lastInsertRowid);
  const uMe = mk('photo_me', false);
  const uOther = mk('photo_other', false);
  const uBoss = mk('photo_boss', true);
  jar.me = COOKIE_NAME + '=' + signSession(uMe, 0);
  jar.other = COOKIE_NAME + '=' + signSession(uOther, 0);
  jar.boss = COOKIE_NAME + '=' + signSession(uBoss, 0);

  const out = fs.openSync('/tmp/mcwphotos.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await raw('/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }
  const PHOTO_DIR = path.join(DATA, 'uploads', 'forum');
  const BG_DIR = path.join(DATA, 'uploads', 'bg');

  sec('A 图片上传接口');
  ck('测试服务已就绪', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }
  let r = await call('anon', 'POST', '/api/upload/image', { data: pngDataUrl(40, 30) });
  ck('未登录上传 → 401', r.code === 401, r.code);
  r = await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(40, 30) });
  ck('登录后上传成功', r.code === 200 && /^\/static\/uploads\/forum\/[\w.-]+\.png$/.test(r.url), JSON.stringify(r).slice(0, 160));
  const img1 = r.url;
  ck('图片真的落盘', fs.existsSync(path.join(PHOTO_DIR, path.basename(img1))));
  let rr = await raw(img1);
  ck('图片可以静态访问（Content-Type 正确）', rr.status === 200 && /image\/png/.test(rr.headers.get('content-type') || ''), rr.status + ' ' + rr.headers.get('content-type'));
  r = await call('me', 'POST', '/api/upload/image', { data: 'data:image/png;base64,aGVsbG8=' });
  ck('伪装成 PNG 的垃圾数据被拒（魔数校验）', r.code === 400, r.code + ' ' + (r.error || ''));
  r = await call('me', 'POST', '/api/upload/image', { data: 'data:text/plain;base64,aGVsbG8=' });
  ck('非图片类型被拒', r.code === 400, r.code + ' ' + (r.error || ''));
  const hugeBuf = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(7 * 1024 * 1024, 1)]);
  const huge = 'data:image/png;base64,' + hugeBuf.toString('base64');
  r = await call('me', 'POST', '/api/upload/image', { data: huge });
  ck('超过 6MB 被拒', r.code === 400 && /6MB/.test(r.error || ''), r.code + ' ' + (r.error || ''));
  r = await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(1200, 900) });
  ck('大图会被压缩到 ≤1600（体积明显变小）', r.code === 200 && r.size < 400 * 1024, r.code + ' ' + r.size);
  r = await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(80, 60), kind: 'bg' });
  ck('kind=bg 落到背景目录且为 JPG', r.code === 200 && /^\/static\/uploads\/bg\/[\w.-]+\.jpg$/.test(r.url), JSON.stringify(r).slice(0, 140));
  const bgProbe = r.url;
  ck('背景文件真的落盘', fs.existsSync(path.join(BG_DIR, path.basename(bgProbe))));

  sec('B 发帖 / 回复带图（含白名单与上限）');
  const img2 = (await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(60, 60, '#c8912b') })).url;
  const img3 = (await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(70, 70, '#3b78d4') })).url;
  r = await call('anon', 'POST', '/api/forum/threads', { board: 'general', title: '游客发帖', body: 'x', images: [img1] });
  ck('未登录发帖 → 401', r.code === 401, r.code);
  r = await call('me', 'POST', '/api/forum/threads', { board: 'general', title: '带图的帖子', body: '看看我建的房子', images: [img1, img2] });
  ck('发帖带 2 张图成功', r.code === 200 && r.id, JSON.stringify(r).slice(0, 120));
  const tid = r.id;
  r = await call('me', 'GET', '/api/forum/thread/' + tid);
  ck('帖子详情返回 images 数组（2 张，顺序一致）', Array.isArray(r.thread.images) && r.thread.images.length === 2 && r.thread.images[0] === img1, JSON.stringify(r.thread.images));
  r = await call('me', 'GET', '/api/forum/threads?board=general&size=50');
  const row = (r.threads || []).find((t) => t.id === tid);
  ck('列表接口带 images 与 imageCount', row && row.images.length === 2 && row.imageCount === 2, JSON.stringify(row && row.images));
  r = await call('me', 'POST', '/api/forum/threads', { board: 'general', title: '外链应被过滤', body: '试试外链', images: ['https://evil.example.com/x.png', '/static/uploads/avatars/hack.png', '/etc/passwd', img3] });
  const tid2 = r.id;
  r = await call('me', 'GET', '/api/forum/thread/' + tid2);
  ck('外链 / 非 forum 目录 / 路径穿越都被过滤（只留合法那张）', r.thread.images.length === 1 && r.thread.images[0] === img3, JSON.stringify(r.thread.images));
  const many = [];
  for (let i = 0; i < 12; i++) many.push(img1, img2, img3);
  r = await call('me', 'POST', '/api/forum/threads', { board: 'general', title: '重复与超量', body: '上限 9 张且去重', images: many });
  r = await call('me', 'GET', '/api/forum/thread/' + r.id);
  ck('超量截断到 9 张 + 重复去重', r.thread.images.length === 3, JSON.stringify(r.thread.images.length));
  r = await call('other', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '好图，我也来一张', images: [img3] });
  ck('回复带图成功', r.code === 200 && (r.images || []).length === 1, JSON.stringify(r).slice(0, 140));
  const pid = r.id;
  r = await call('other', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '', images: [img3] });
  ck('纯图片回复（无文字）允许', r.code === 200, r.code + ' ' + (r.error || ''));
  r = await call('other', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '' });
  ck('既没文字也没图 → 400', r.code === 400 && /不能为空/.test(r.error || ''), r.code + ' ' + (r.error || ''));
  r = await call('other', 'POST', '/api/forum/thread/' + tid + '/reply', { body: '旧接口也带图', images: [img1] });
  ck('旧回复接口支持配图', r.code === 200, r.code + ' ' + (r.error || ''));
  r = await call('me', 'GET', '/api/forum/thread/' + tid);
  const withImg = (r.posts || []).filter((p) => (p.images || []).length);
  ck('回复详情里带 images', withImg.length >= 2, JSON.stringify((r.posts || []).map((p) => (p.images || []).length)));
  ck('纯图回复的正文为空字符串（不再塞占位文字）', (r.posts || []).some((p) => p.images.length === 1 && p.body === ''));
  r = await call('me', 'GET', '/api/feed?scope=all&limit=30');
  const fit = (r.items || []).find((x) => x.kind === 'thread' && x.id === tid);
  ck('动态流里帖子带 images', fit && (fit.images || []).length === 2, JSON.stringify(fit && fit.images));
  const frep = (r.items || []).find((x) => x.kind === 'reply' && x.id === pid);
  ck('动态流里回复带 images', frep && (frep.images || []).length === 1, JSON.stringify(frep && frep.images));

  sec('C 删除时回收图片文件');
  const up1 = async (c) => (await call('me', 'POST', '/api/upload/image', { data: pngDataUrl(55, 55, c) })).url;
  const imgDel = await up1('#d2473d');   // 只被一条回复引用
  const imgSolo = await up1('#8a6410');  // 被两处引用（用于验证不误删）
  const imgT = await up1('#1e7c4a');     // 只被一个帖子引用
  const delFile = path.join(PHOTO_DIR, path.basename(imgDel));
  const soloFile = path.join(PHOTO_DIR, path.basename(imgSolo));
  const tFile = path.join(PHOTO_DIR, path.basename(imgT));
  const rDel = await call('me', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '只在这里出现的图', images: [imgDel] });
  const pidDel = rDel.id;
  const rT = await call('me', 'POST', '/api/forum/threads', { board: 'general', title: '待删帖子（独占配图）', body: '等会儿删掉', images: [imgT] });
  const shareTid = (await call('me', 'POST', '/api/forum/threads', { board: 'general', title: '另一帖引用同一张', body: '共享图片', images: [imgSolo] })).id;
  await call('me', 'POST', '/api/forum/thread/' + tid2 + '/reply2', { body: '这里也引用了同一张图', images: [imgSolo] });
  ck('前置：三张图都落盘', fs.existsSync(delFile) && fs.existsSync(soloFile) && fs.existsSync(tFile));

  r = await call('boss', 'DELETE', '/api/forum/post/' + pidDel);
  ck('管理员删除回复成功', r.code === 200, r.code);
  await sleep(250);
  ck('被删回复独占的图片已从磁盘回收', !fs.existsSync(delFile), delFile);
  rr = await raw(imgDel);
  ck('回收后的图片地址不可访问（404）', rr.status === 404, rr.status);

  r = await call('boss', 'POST', '/api/forum/thread/' + shareTid + '/moderate', { action: 'delete' });
  ck('管理员删除共享帖成功', r.code === 200, r.code);
  await sleep(250);
  ck('仍有其他帖子引用时图片不误删', fs.existsSync(soloFile), soloFile);

  r = await call('boss', 'POST', '/api/forum/thread/' + tid2 + '/moderate', { action: 'delete' });
  await sleep(250);
  ck('最后一个引用被删后图片回收', !fs.existsSync(soloFile), soloFile);

  r = await call('boss', 'POST', '/api/forum/thread/' + rT.id + '/moderate', { action: 'delete' });
  ck('管理员删帖成功', r.code === 200, r.code);
  await sleep(250);
  ck('删帖回收该帖独占配图', !fs.existsSync(tFile), tFile);
  r = await call('me', 'GET', '/api/forum/thread/' + rT.id);
  ck('已删帖子不可再访问（404）', r.code === 404, r.code);

  sec('D 个人主页背景');
  r = await call('me', 'GET', '/api/me/bg');
  ck('初始没有背景且未锁定', r.code === 200 && !r.bg && r.locked === false, JSON.stringify(r).slice(0, 120));
  r = await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(900, 300, '#14476b') });
  ck('上传背景成功（1600×600 JPG）', r.code === 200 && r.width === 1600 && r.height === 600 && /^\/static\/uploads\/bg\/[\w.-]+\.jpg$/.test(r.url), JSON.stringify(r).slice(0, 160));
  const bg1 = r.url;
  ck('背景文件落盘', fs.existsSync(path.join(BG_DIR, path.basename(bg1))));
  const bgRow = db.prepare('SELECT profile_bg, profile_bg_at FROM users WHERE id = ?').get(uMe);
  ck('DB 记录 profile_bg 与时间', bgRow.profile_bg === bg1 && bgRow.profile_bg_at > 0, JSON.stringify(bgRow));
  r = await call('me', 'GET', '/api/me/bg');
  ck('再查能看到自己的背景', r.bg === bg1);
  rr = await raw(bg1);
  ck('背景图可静态访问', rr.status === 200, rr.status);
  const bg2 = (await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(800, 400, '#c2532c') })).url;
  await sleep(150);
  ck('换背景后旧文件被清理', !fs.existsSync(path.join(BG_DIR, path.basename(bg1))), bg1);
  r = await call('me', 'POST', '/api/me/bg', { data: 'data:image/png;base64,aGVsbG8=' });
  ck('背景上传也会校验魔数', r.code === 400, r.code + ' ' + (r.error || ''));
  r = await call('me', 'POST', '/api/profile', { bio: '你好', bg: 'https://evil.example.com/bg.png', tags: ['建筑'] });
  ck('资料接口不接受外部背景地址', r.code === 200 && r.bg === '', JSON.stringify(r).slice(0, 120));
  r = await call('me', 'POST', '/api/profile', { bio: '你好', bg: 'g3', tags: [] });
  ck('资料接口接受浅色/深色预设背景（g* / d*）', r.code === 200 && r.bg === 'g3', JSON.stringify(r).slice(0, 80));
  r = await call('me', 'POST', '/api/profile', { bio: '你好', bg: 'd2', tags: [] });
  ck('旧的深色预设不会被清掉（d2）', r.code === 200 && r.bg === 'd2', JSON.stringify(r).slice(0, 80));
  r = await call('me', 'POST', '/api/profile', { bio: '你好', bg: bg2, tags: ['建筑'] });
  ck('资料接口接受本站背景', r.code === 200 && r.bg === bg2, JSON.stringify(r).slice(0, 120));
  const meName = db.prepare('SELECT username FROM users WHERE id = ?').get(uMe).username;
  r = await call('anon', 'GET', '/api/profile/' + meName);
  ck('个人主页接口返回自定义背景', r.code === 200 && r.profile && r.profile.bg === bg2, JSON.stringify({ code: r.code, bg: r.profile && r.profile.bg }));
  r = await call('me', 'DELETE', '/api/me/bg');
  ck('清除背景成功', r.code === 200, r.code);
  await sleep(150);
  ck('清除后文件也被删除', !fs.existsSync(path.join(BG_DIR, path.basename(bg2))));
  ck('清除后 DB 为空', !db.prepare('SELECT profile_bg FROM users WHERE id = ?').get(uMe).profile_bg);

  sec('E 后台「头像与主页背景」撤回');
  const bg3 = (await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(700, 300, '#7c5cf0') })).url;
  r = await call('me', 'GET', '/api/admin/backgrounds');
  ck('普通用户访问后台背景列表 → 403', r.code === 403, r.code);
  r = await call('boss', 'GET', '/api/admin/backgrounds?limit=80');
  ck('管理员能看到背景列表', r.code === 200 && Array.isArray(r.backgrounds), r.code);
  const mine = (r.backgrounds || []).find((x) => x.id === uMe);
  ck('列表里有该用户的背景与上传时间', mine && mine.bg === bg3 && mine.at > 0, JSON.stringify(mine));
  ck('统计 total / locked 存在', typeof r.total === 'number' && typeof r.locked === 'number', JSON.stringify({ t: r.total, l: r.locked }));
  r = await call('boss', 'GET', '/api/admin/avatars?limit=80');
  ck('头像板块接口仍正常（同一板块两个数据源）', r.code === 200 && Array.isArray(r.avatars), r.code);
  r = await call('boss', 'POST', '/api/admin/backgrounds/' + uMe + '/remove', { note: '测试撤回' });
  ck('撤回背景成功', r.code === 200, r.code + ' ' + (r.error || ''));
  await sleep(150);
  ck('撤回后文件被删除', !fs.existsSync(path.join(BG_DIR, path.basename(bg3))));
  ck('撤回后 DB 清空 + 记录撤回时间', !db.prepare('SELECT profile_bg, profile_bg_removed_at FROM users WHERE id = ?').get(uMe).profile_bg && db.prepare('SELECT profile_bg_removed_at FROM users WHERE id = ?').get(uMe).profile_bg_removed_at > 0);
  const notif = db.prepare("SELECT title, body FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(uMe);
  ck('本人收到站内通知', notif && /主页背景已被管理员撤回/.test(notif.title), JSON.stringify(notif));
  const bg4 = (await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(640, 240, '#e56a9a') })).url;
  r = await call('boss', 'POST', '/api/admin/backgrounds/' + uMe + '/remove', { lock: true, note: '再犯' });
  ck('撤回并锁定成功', r.code === 200 && r.locked === true, JSON.stringify(r).slice(0, 120));
  r = await call('me', 'GET', '/api/me/bg');
  ck('本人能看到自己已被锁定', r.locked === true && !r.bg, JSON.stringify(r).slice(0, 120));
  r = await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(500, 200) });
  ck('锁定期上传 → 403（含申诉引导）', r.code === 403 && /举报与申诉/.test(r.error || ''), r.code + ' ' + (r.error || ''));
  ck('锁定期的旧文件也已删除', !fs.existsSync(path.join(BG_DIR, path.basename(bg4))));
  r = await call('boss', 'POST', '/api/admin/backgrounds/' + uMe + '/lock', { lock: false });
  ck('恢复上传权限成功', r.code === 200 && r.locked === false, JSON.stringify(r).slice(0, 120));
  r = await call('me', 'POST', '/api/me/bg', { data: pngDataUrl(500, 200, '#2b7cd3') });
  ck('恢复后能重新上传', r.code === 200, r.code + ' ' + (r.error || ''));
  r = await call('boss', 'POST', '/api/admin/backgrounds/999999/remove', {});
  ck('撤回不存在用户 → 404', r.code === 404, r.code);
  r = await call('boss', 'GET', '/api/admin/backgrounds');
  const mine2 = (r.backgrounds || []).find((x) => x.id === uMe);
  ck('重新上传后「上次撤回时间」被清除', mine2 && mine2.bg && !mine2.removedAt, JSON.stringify(mine2));
  const audits = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'bg.%'").all().map((x) => x.action);
  ck('审计日志有 bg.upload / bg.remove / bg.lock', ['bg.upload', 'bg.remove', 'bg.lock'].every((x) => audits.includes(x)), audits.join(','));
  r = await raw('/api/upload/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: pngDataUrl(30, 30) }) });
  ck('上传接口对游客也是 401（不是 HTML 500 页）', r.status === 401 && /application\/json/.test(r.headers.get('content-type') || ''), r.status);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('脚本异常: ' + (e && e.stack || e)); process.exit(1); });
