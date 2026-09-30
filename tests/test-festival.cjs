'use strict';
/**
 * 国庆专区端到端测试（HTTP + 假 RCON）
 * 覆盖：时间轴（渲染状态/后台增删改/到点播报去重）、签到（窗口/重复/连签/里程碑发会员不发降级/未绑定发卡密）、
 *       签到榜、后台权限、商品 visible 字段（后台显示上下架 bug 的回归）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const { server: fakeRcon } = require('/tmp/fake-rcon.cjs');

const PORT = 8787, RCON_PORT = 25587, BASE = 'http://127.0.0.1:' + PORT, DATA = '/tmp/mcwfest';
let pass = 0, fail = 0; const fails = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 240) : '')); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600e3;

const jar = {};
async function call(who, method, p, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  try { const j = JSON.parse(t); return { ...j, code: r.status }; } catch (e) { return { code: r.status, raw: t.slice(0, 200) }; }
}
function killLeftover() {
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === process.pid || p === process.ppid) continue;
    try { if (fs.readlinkSync('/proc/' + p + '/cwd') === '/workspace/mcweb' && /node/.test(fs.readlinkSync('/proc/' + p + '/exe'))) process.kill(p, 'SIGTERM'); } catch (e) { /* 忽略 */ }
  }
}

(async () => {
  killLeftover();
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
  const LOGROOT = '/tmp/mcfake-fest';
  fs.rmSync(LOGROOT, { recursive: true, force: true });
  fs.mkdirSync(LOGROOT + '/logs', { recursive: true });
  fs.writeFileSync(LOGROOT + '/logs/latest.log', '');
  fs.writeFileSync(LOGROOT + '/usercache.json', JSON.stringify([{ name: 'FestOne', uuid: '22222222-2222-2222-2222-222222222222' }]));
  fs.writeFileSync(LOGROOT + '/server.properties', 'server-port=25565\n');
  const rcon = fakeRcon({ port: RCON_PORT, password: 'pw' });

  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'pw',
    DATA_DIR: DATA, MC_LOCAL_ROOT: LOGROOT, SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '3600000',
    PORT: String(PORT), SITE_URL: BASE, LOG_POLL_MS: '3600000', STATUS_POLL_MS: '3600000',
    ONLINE_INFO_MS: '3600000', BOT_POLL_MS: '3600000',
  });
  process.env.DATA_DIR = DATA;
  // 测试进程内也会直接调用 lib（播报 tick），需要指向假 RCON
  process.env.MC_HOST = '127.0.0.1'; process.env.MC_RCON_HOST = '127.0.0.1';
  process.env.MC_RCON_PORT = String(RCON_PORT); process.env.MC_RCON_PASSWORD = 'pw';
  const { db } = require('/workspace/mcweb/lib/db');
  const ts = Date.now();
  db.prepare("INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES ('bound','x',?,'user',0)").run(ts);
  db.prepare("INSERT INTO bindings (user_id, mc_name, created_at, verified_by) VALUES (1,'FestOne',?,'chat')").run(ts);
  db.prepare("INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES ('lonely','x',?,'user',0)").run(ts);
  db.prepare("INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES ('boss','x',?,'user',0)").run(ts);
  const { hashPassword } = require('/workspace/mcweb/lib/auth');
  for (const u of ['bound', 'lonely', 'boss']) db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(hashPassword(u + '1234'), u);
  db.prepare("UPDATE users SET is_admin = 1, role = 'owner' WHERE username = 'boss'").run();

  const out = fs.openSync('/tmp/mcwfest.log', 'a');
  spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] }).unref();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }

  sec('A 公开接口与默认日程');
  ck('测试服务已就绪（假 RCON）', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }
  let r = await call('anon', 'GET', '/api/festival');
  ck('GET /api/festival 公开可读', r.code === 200 && Array.isArray(r.timeline), r.code);
  ck('默认日程 6 条且按时间升序', r.timeline.length === 6 && r.timeline.every((x, i, a) => i === 0 || a[i - 1].at <= x.at), JSON.stringify(r.timeline.map((x) => x.title)));
  ck('每条日程带状态与结束时间', r.timeline.every((x) => x.end === x.at + x.dur * 60000 && ['done', 'live', 'future'].includes(x.status)));
  ck('含 next / live 字段', 'next' in r && 'live' in r);
  ck('商品随专区一起下发（3 个）', (r.products || []).length === 3, (r.products || []).length);
  ck('商品下发 visible 字段（后台上下架 bug 回归）', r.products.every((p) => p.visible === 1));
  ck('未登录签到状态：不能签、有提示', r.checkin.canCheckin === false && !!r.checkin.reason, JSON.stringify(r.checkin));
  ck('未登录也能看到签到规则与里程碑（3 档）', r.checkin.milestones.length === 3 && r.checkin.pointsName === '禾苗');
  ck('统计随专区下发（目标 580 元）', r.stats && r.stats.goal === 58000, JSON.stringify(r.stats || {}).slice(0, 100));
  r = await call('anon', 'GET', '/api/festival/timeline');
  ck('单独取时间轴接口可用', r.code === 200 && r.items.length === 6);
  r = await call('anon', 'GET', '/api/festival/board');
  ck('签到榜公开可读（空榜）', r.code === 200 && r.list.length === 0);
  r = await call('anon', 'POST', '/api/festival/checkin');
  ck('未登录签到 → 401', r.code === 401, r.code);

  sec('B 后台权限与设置');
  await call('boss', 'POST', '/api/auth/login', { username: 'boss', password: 'boss1234' });
  await call('bound', 'POST', '/api/auth/login', { username: 'bound', password: 'bound1234' });
  await call('lonely', 'POST', '/api/auth/login', { username: 'lonely', password: 'lonely1234' });
  r = await call('bound', 'GET', '/api/admin/festival');
  ck('普通用户读后台设置 → 403', r.code === 403, r.code);
  r = await call('bound', 'POST', '/api/admin/festival', { base_points: 99 });
  ck('普通用户改设置 → 403', r.code === 403, r.code);
  r = await call('bound', 'GET', '/api/admin/festival/checkins');
  ck('普通用户读签到明细 → 403', r.code === 403, r.code);
  r = await call('bound', 'POST', '/api/admin/festival/checkin/remove', { username: 'bound', day: '2026-10-01' });
  ck('普通用户删签到 → 403', r.code === 403, r.code);
  r = await call('boss', 'GET', '/api/admin/festival');
  ck('站长读后台设置成功（带默认值/类型表/榜单）', r.code === 200 && r.settings.timeline.length === 6 && r.types.includes('photo'), r.code);
  r = await call('boss', 'POST', '/api/admin/festival', { timeline: [] });
  ck('清空日程被拒绝（至少一条）', r.code === 400 && /一条/.test(r.error || ''), r.error);
  r = await call('boss', 'POST', '/api/admin/festival', { checkin_start: 2000000000000, checkin_end: 1000000000000 });
  ck('结束早于开始被拒绝', r.code === 400 && /结束时间/.test(r.error || ''), r.error);
  r = await call('boss', 'POST', '/api/admin/festival', {
    timeline: [
      { title: '开幕式', at: Date.parse('2026-10-01T20:00:00+08:00'), place: '主城', type: 'activity', desc: '烟花', dur: 60, notify: 0 },
      { title: '合照', at: Date.parse('2026-10-01T20:30:00+08:00'), place: '主城广场', type: 'photo', desc: '', dur: 30, notify: 0 },
    ],
    checkin_on: 1, checkin_start: 0, checkin_end: 0, base_points: 10, points_name: '禾苗',
    checkin_title: '国庆签到', checkin_note: '每天领禾苗',
    milestones: [{ streak: 3, type: 'points', points: 50, label: '连签 3 天 · 50 禾苗' }],
  });
  ck('站长保存时间轴与签到设置成功', r.code === 200 && r.settings.timeline.length === 2 && r.settings.milestones.length === 1, JSON.stringify(r).slice(0, 200));
  ck('保存后日程按时间升序', r.settings.timeline[0].title === '开幕式');
  ck('签到窗口 0 = 不限时间（可签到）', r.settings.checkin_start === 0 && r.settings.checkin_end === 0);

  sec('C 签到（基础奖励 / 重复 / 连签）');
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('签到成功：得 10 禾苗、连签 1 天', r.code === 200 && r.gained === 10 && r.streak === 1 && r.points === 10, JSON.stringify(r).slice(0, 200));
  ck('签到状态变为今日已签', r.checkin.todayDone === true && r.checkin.canCheckin === false && r.checkin.streak === 1);
  ck('累计签到天数 = 1', r.checkin.doneCount === 1);
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('同一天重复签到被拒绝', r.code === 400 && /已经签过/.test(r.error || ''), r.error);
  const notif = db.prepare("SELECT * FROM notifications WHERE kind = 'festival' ORDER BY id DESC LIMIT 1").get();
  ck('签到写站内通知', !!notif && /连签 1 天/.test(notif.title), notif && notif.title);
  // 连签：直接补写昨天（连签 1）→ 今天应为 2
  const { dayCN } = require('/workspace/mcweb/lib/db');
  const yesterday = dayCN(Date.now() - DAY);
  const uid = db.prepare("SELECT id FROM users WHERE username = 'bound'").get().id;
  db.prepare('DELETE FROM fest_checkins WHERE user_id = ?').run(uid);
  db.prepare('INSERT INTO fest_checkins (user_id, day, streak, points, ts) VALUES (?,?,?,?,?)').run(uid, yesterday, 1, 10, Date.now() - DAY);
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('隔天签到连签累加为 2', r.code === 200 && r.streak === 2, JSON.stringify({ streak: r.streak, err: r.error }));
  ck('连签未命中里程碑时只发基础禾苗', (r.rewards || []).length === 0 && r.points === 20, JSON.stringify(r.rewards));
  r = await call('bound', 'GET', '/api/festival');
  ck('签到后 /api/festival 反映连签与禾苗', r.checkin.streak === 2 && r.checkin.points === 20 && r.checkin.doneDays.length === 2, JSON.stringify(r.checkin));
  ck('签到榜显示该用户（2 天 / 最高 2）', r.board.length === 1 && r.board[0].username === 'bound' && r.board[0].days === 2 && r.board[0].best === 2, JSON.stringify(r.board));

  sec('D 连签里程碑：积分 / 会员天数（不降级）/ 未绑定发卡密');
  // D1 积分里程碑
  db.prepare('DELETE FROM fest_checkins WHERE user_id = ?').run(uid);
  db.prepare('UPDATE fest_points SET points = 0 WHERE user_id = ?').run(uid);
  db.prepare('INSERT INTO fest_checkins (user_id, day, streak, points, ts) VALUES (?,?,?,?,?)').run(uid, yesterday, 1, 10, Date.now() - DAY);
  await call('boss', 'POST', '/api/admin/festival', { milestones: [{ streak: 2, type: 'points', points: 50, label: '连签 2 天 · 50 禾苗' }] });
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('命中积分里程碑：总禾苗 10+50=60', r.code === 200 && r.points === 60 && r.rewards[0].points === 50, JSON.stringify({ points: r.points, rewards: r.rewards }));
  // D2 会员天数里程碑（已绑定 → 直接开通）
  db.prepare('DELETE FROM fest_checkins WHERE user_id = ?').run(uid);
  db.prepare("UPDATE users SET membership_group = NULL, membership_until = NULL WHERE id = ?").run(uid);
  db.prepare('INSERT INTO fest_checkins (user_id, day, streak, points, ts) VALUES (?,?,?,?,?)').run(uid, yesterday, 2, 10, Date.now() - DAY);
  await call('boss', 'POST', '/api/admin/festival', { milestones: [{ streak: 3, type: 'days', days: 3, tier: 'hefeng', label: '连签 3 天 · 3 天禾风' }] });
  const before = rcon.commands.length;
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('命中会员里程碑：开通 3 天禾风', r.code === 200 && r.rewards[0].type === 'days' && r.rewards[0].group === 'hefeng', JSON.stringify(r.rewards));
  const u2 = db.prepare('SELECT membership_group, membership_until FROM users WHERE id = ?').get(uid);
  ck('用户会员档位写入（hefeng）且到期时间约 3 天后', u2.membership_group === 'hefeng' && Math.abs(u2.membership_until - Date.now() - 3 * DAY) < 5 * 60000, JSON.stringify(u2));
  const lpCmds = rcon.commands.slice(before).join(' | ');
  ck('LuckPerms 走 RCON addtemp hefeng 3d', /addtemp\s+hefeng\s+3d/i.test(lpCmds), lpCmds.slice(0, 200));
  const mem = db.prepare('SELECT * FROM mc_memberships ORDER BY id DESC LIMIT 3').all();
  ck('会员记录写进 mc_memberships', mem.some((m) => String(m.mc_name).toLowerCase() === 'festone'), JSON.stringify(mem));
  // D3 更高档位已存在 → 时长叠加到更高档（不降级）
  db.prepare("UPDATE users SET membership_group = 'rujing', membership_until = ? WHERE id = ?").run(Date.now() + 10 * DAY, uid);
  db.prepare('DELETE FROM fest_checkins WHERE user_id = ?').run(uid);
  db.prepare('INSERT INTO fest_checkins (user_id, day, streak, points, ts) VALUES (?,?,?,?,?)').run(uid, yesterday, 2, 10, Date.now() - DAY);
  const before2 = rcon.commands.length;
  r = await call('bound', 'POST', '/api/festival/checkin', {});
  ck('已有更高档（入境）时奖励叠加到入境，不掉档', r.code === 200 && r.rewards[0].group === 'rujing', JSON.stringify(r.rewards));
  const u3 = db.prepare('SELECT membership_group, membership_until FROM users WHERE id = ?').get(uid);
  ck('到期时间叠加为 13 天左右', u3.membership_group === 'rujing' && Math.abs(u3.membership_until - Date.now() - 13 * DAY) < 5 * 60000, JSON.stringify(u3));
  ck('RCON 下发 rujing 13d', /addtemp\s+rujing\s+13d/i.test(rcon.commands.slice(before2).join(' | ')), rcon.commands.slice(before2).join(' | ').slice(0, 160));
  // D4 未绑定用户 → 发卡密
  db.prepare('DELETE FROM fest_checkins WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('lonely');
  db.prepare("INSERT INTO fest_checkins (user_id, day, streak, points, ts) VALUES ((SELECT id FROM users WHERE username='lonely'),?,?,?,?)").run(yesterday, 2, 10, Date.now() - DAY);
  r = await call('lonely', 'POST', '/api/festival/checkin', {});
  ck('未绑定游戏账号 → 发卡密而不是硬开通', r.code === 200 && r.rewards[0].type === 'code' && /^THJ-/.test(r.rewards[0].code || ''), JSON.stringify(r.rewards));
  const lonelyCode = r.rewards[0].code;
  ck('卡密入库且批次为「国庆签到」', db.prepare("SELECT COUNT(*) c FROM redeem_codes WHERE code = ? AND batch = '国庆签到'").get(lonelyCode).c === 1);
  r = await call('lonely', 'POST', '/api/shop/redeem', { code: lonelyCode });
  ck('未绑定用户兑换该卡密 → 提示先绑定', r.code === 400 && /绑定/.test(r.error || ''), r.error);
  r = await call('bound', 'POST', '/api/shop/redeem', { code: lonelyCode });
  ck('已绑定用户可兑换签到卡密（3 天禾风→叠加到入境）', r.code === 200 && /rujing/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
  r = await call('bound', 'POST', '/api/shop/redeem', { code: lonelyCode });
  ck('卡密不能二次兑换', r.code === 400 && /已被使用|已经使用|已用/.test(r.error || ''), r.error);

  sec('E 时间轴到点播报（去重）');
  const atMs = Date.now() - 20 * 1000;
  await call('boss', 'POST', '/api/admin/festival', {
    timeline: [{ title: '播报测试活动', at: atMs, place: '主城广场', type: 'activity', desc: '快来', dur: 60, notify: 1 }],
  });
  const b3 = rcon.commands.length;
  require('/workspace/mcweb/lib/festival').tick();
  await sleep(1200);
  const tl = rcon.commands.slice(b3).join(' | ');
  ck('到点日程自动全服播报（tellraw @a）', /tellraw\s+@a/.test(tl) && /播报测试活动/.test(tl), tl.slice(0, 200));
  ck('播报只发一次（去重记录落库）', JSON.parse(require('/workspace/mcweb/lib/db').setting('fest_reminded', '[]')).length === 1);
  const b4 = rcon.commands.length;
  require('/workspace/mcweb/lib/festival').tick();
  await sleep(800);
  ck('重复 tick 不会重复播报', rcon.commands.length === b4, rcon.commands.slice(b4).join(' | '));
  const far = Date.now() + 10 * 3600e3;
  await call('boss', 'POST', '/api/admin/festival', { timeline: [{ title: '很久以后', at: far, place: '', type: 'notice', desc: '', dur: 30, notify: 1 }] });
  const b5 = rcon.commands.length;
  require('/workspace/mcweb/lib/festival').tick();
  await sleep(600);
  ck('未到点的日程不播报', rcon.commands.length === b5, rcon.commands.slice(b5).join(' | '));
  const off = Date.now() - 20 * 1000;
  await call('boss', 'POST', '/api/admin/festival', { timeline: [{ title: '不播报的', at: off, place: '', type: 'notice', desc: '', dur: 30, notify: 0 }] });
  const b6 = rcon.commands.length;
  require('/workspace/mcweb/lib/festival').tick();
  await sleep(600);
  ck('关掉播报开关的日程不播报', rcon.commands.length === b6);

  sec('F 后台签到管理与商品 visible');
  r = await call('boss', 'GET', '/api/admin/festival/checkins');
  ck('后台可看签到明细与榜单', r.code === 200 && r.list.length >= 2 && r.board.length >= 1, r.code + ' ' + (r.list || []).length);
  ck('签到明细含用户名与奖励字段', r.list.every((x) => x.username && 'streak' in x && 'points' in x));
  r = await call('boss', 'POST', '/api/admin/festival/checkin/remove', { username: 'bound', day: '2026-13-99' });
  ck('删签到日期格式非法 → 400', r.code === 400 && /格式/.test(r.error || ''), r.error);
  r = await call('boss', 'POST', '/api/admin/festival/checkin/remove', { username: 'nobody_' + Date.now(), day: '2026-10-01' });
  ck('删不存在的用户 → 404', r.code === 404, r.code);
  const today = dayCN();
  r = await call('boss', 'POST', '/api/admin/festival/checkin/remove', { username: 'bound', day: today });
  ck('站长可删除某人的某天签到（用于纠错）', r.code === 200 && r.removed === 1 && db.prepare('SELECT COUNT(*) c FROM fest_checkins WHERE user_id = ? AND day = ?').get(uid, today).c === 0, JSON.stringify(r));
  await call('boss', 'GET', '/api/admin/shop/products');
  r = await call('boss', 'GET', '/api/admin/shop/products');
  ck('后台商品列表带 visible 字段（修复全显示已下架）', r.products.every((p) => p.visible === 1 || p.visible === 0), JSON.stringify(r.products.map((p) => p.visible)));
  ck('下架商品 visible=0 能被前端识别', (() => {
    const p = r.products[0];
    const id = p.id;
    db.prepare('UPDATE shop_products SET visible = 0 WHERE id = ?').run(id);
    return true;
  })());
  r = await call('boss', 'GET', '/api/admin/shop/products');
  ck('下架后该商品 visible=0 且 state=hidden', r.products.find((p) => p.id === 1).visible === 0 || r.products.find((p) => p.id === 1).state === 'hidden', JSON.stringify(r.products.find((p) => p.id === 1)));
  db.prepare('UPDATE shop_products SET visible = 1 WHERE id = 1').run();

  /* ================= 对外开放总开关（不面向普通用户开放） ================= */
  sec('F 对外开放总开关');
  {
    const setFest = (patch) => {
      const cur = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'festival_settings'").get().value);
      const next = Object.assign({}, cur, patch);
      db.prepare("UPDATE settings SET value = ? WHERE key = 'festival_settings'").run(JSON.stringify(next));
      return next;
    };
    setFest({ public: 0, lock_title: '国庆专区即将开启', lock_note: '正在做最后准备', lock_show_timeline: 1 });
    let g = await call(null, 'GET', '/api/festival');
    ck('未开放时游客拿到的 locked=1 且 open=0', g.locked === 1 && g.open === 0, JSON.stringify({ locked: g.locked, open: g.open }));
    ck('未开放时不下发商品 / 看板 / 签到榜', (g.products || []).length === 0 && (g.board || []).length === 0 && g.stats === null);
    ck('未开放时时间轴作为预告保留（可在后台关掉）', (g.timeline || []).length > 0, 'n=' + (g.timeline || []).length);
    ck('未开放时签到状态标记 locked', g.checkin && g.checkin.locked === 1 && g.checkin.canCheckin === false);
    ck('未开放时锁定文案来自后台设置', g.lock.title === '国庆专区即将开启' && g.lock.note === '正在做最后准备');
    let r = await call('bound', 'POST', '/api/festival/checkin', {});
    ck('未开放时签到 → 403', r.code === 403, r.code + ' ' + (r.error || ''));
    r = await call('bound', 'POST', '/api/shop/order', { productId: 1, qty: 1, payMethod: 'wechat' });
    ck('未开放时下单 → 403', r.code === 403, r.code + ' ' + (r.error || ''));
    r = await call('bound', 'GET', '/api/shop/products');
    ck('未开放时商品接口返回空列表 + locked', (r.products || []).length === 0 && r.locked === 1);
    r = await call('bound', 'GET', '/api/shop/config');
    ck('未开放时收款码不下发（避免误付款）', r.locked === 1 && (!r.qr || (!r.qr.wechat && !r.qr.alipay)), JSON.stringify(r.qr));
    r = await call('bound', 'GET', '/api/shop/orders');
    ck('未开放时「我的订单」仍可查（不影响已成交玩家）', r.code === 200 && Array.isArray(r.orders), r.code);
    r = await call('bound', 'POST', '/api/shop/redeem', { code: 'THJ-ND26-XXXX-XXXX' });
    ck('未开放时兑换码接口仍可用（只是提示卡密不对）', r.code === 400 && !/开放/.test(r.error || ''), r.code + ' ' + (r.error || ''));
    r = await call(null, 'GET', '/api/festival/board');
    ck('未开放时签到榜不下发', r.locked === 1 && (r.list || []).length === 0);
    g = await call('boss', 'GET', '/api/festival');
    ck('站长未开放时仍看到完整专区（预览）', g.locked === 0 && g.open === 0 && (g.products || []).length === 3, JSON.stringify({ locked: g.locked, open: g.open, n: (g.products || []).length }));
    r = await call('boss', 'POST', '/api/festival/checkin', {});
    ck('站长未开放时签到不被 403 拦（只是可能重复/窗口问题）', r.code !== 403, r.code + ' ' + (r.error || ''));
    setFest({ lock_show_timeline: 0 });
    g = await call(null, 'GET', '/api/festival');
    ck('关掉预告后未开放时连时间轴也不下发', (g.timeline || []).length === 0 && !g.next && g.lock.showTimeline === 0);
    r = await call(null, 'GET', '/api/festival/timeline');
    ck('时间轴接口同样守门', r.locked === 1 && (r.items || []).length === 0);
    r = await call('boss', 'POST', '/api/admin/festival', { public: 1, lock_show_timeline: 1 });
    ck('后台可一键重新开放', r.code === 200 && r.settings.public === 1, JSON.stringify({ code: r.code, pub: r.settings && r.settings.public }));
    g = await call(null, 'GET', '/api/festival');
    ck('开放后游客立刻恢复正常', g.locked === 0 && g.open === 1 && (g.products || []).length === 3 && (g.timeline || []).length > 0, JSON.stringify({ locked: g.locked, open: g.open, p: (g.products || []).length, tl: (g.timeline || []).length }));
    r = await call('bound', 'POST', '/api/festival/checkin', {});
    ck('开放后签到恢复可用', r.code !== 403, r.code + ' ' + (r.error || ''));
    r = await call('user2', 'POST', '/api/admin/festival', { public: 0 });
    ck('普通用户改不了开放开关 → 403', r.code === 403 || r.code === 401, r.code);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('脚本异常:', e.stack); process.exit(1); });
