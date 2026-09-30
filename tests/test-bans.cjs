'use strict';
/**
 * 游戏账号封禁管理（AdvancedBanZ）—— 管理面板「游戏封禁管理」回归
 *  运行：由 site-test.sh 调起，或 BASE 无关，自己 spawn 服务（端口 8793）
 *
 * 覆盖：
 *   - 读：解析插件 storage.db（含永久/临时封禁，排除禁言/已过期）
 *   - 实时：socket.io admins 房间收到 bans 事件（下发封禁立即推 + 定时巡检推）
 *   - 写：RCON 下发 ban / tempban / unban，指令串正确、理由被消毒、回读校验
 *   - 权限：非管理员 403；输入非法名/时长 400；审计留痕
 * 用「假 RCON」把指令真正写回 fixture 的 storage.db，从而离线验证整条链路。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('/workspace/mcweb/node_modules/socket.io-client');

const PORT = 8793;
const BASE = 'http://127.0.0.1:' + PORT;
const RCON_PORT = 17002;
const DATA = '/tmp/mcwbans';
const MC = '/tmp/mcwbans-mc';
const BANDB = MC + '/plugins/AdvancedBanZ/data/storage.db';

let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 300) : '')); }
};
const D = (t) => console.log('\n[' + t + ']');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待某个 socket 事件出现（推送是异步的，不能假设即时到达） */
async function waitEvent(events, pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}
const jar = {};

async function call(who, method, p, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  let j = {};
  try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t.slice(0, 200) }; }
  return { code: r.status, ctype: r.headers.get('content-type') || '', ...j };
}

/* ---------- 假 RCON：记录指令，并把封禁/解封写回插件库，模拟插件生效 ---------- */
function pkt(id, type, body) {
  const payload = Buffer.from(body || '', 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}
const rconCmds = [];
function banDb() { return new DatabaseSync(BANDB); }
function durToMs(s) {
  const m = /^(\d+)([smhdw])$/.exec(s || '');
  if (!m) return 0;
  const n = Number(m[1]);
  const mul = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2]];
  return n * mul;
}
function applyRcon(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const verb = (parts[0] || '').replace(/^\//, '').toLowerCase();
  const db = banDb();
  try {
    if (verb === 'ban' && parts[1]) {
      db.prepare('INSERT INTO Punishments (name, uuid, reason, operator, punishmentType, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(parts[1], null, parts.slice(2).join(' ') || null, 'Console', 'BAN', Date.now(), 0);
    } else if (verb === 'tempban' && parts[1]) {
      const ms = durToMs(parts[2]);
      db.prepare('INSERT INTO Punishments (name, uuid, reason, operator, punishmentType, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(parts[1], null, parts.slice(3).join(' ') || null, 'Console', 'TEMP_BAN', Date.now(), Date.now() + (ms || 3600000));
    } else if (verb === 'unban' && parts[1]) {
      db.prepare("DELETE FROM Punishments WHERE lower(name) = lower(?) AND punishmentType LIKE '%BAN%'").run(parts[1]);
    }
  } finally { db.close(); }
}
function startFakeRcon() {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 12) {
        const len = buf.readInt32LE(0);
        if (buf.length < len + 4) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.slice(12, len + 2).toString('utf8');
        buf = buf.slice(len + 4);
        if (type === 3) { sock.write(pkt(id, 2, '')); continue; }
        rconCmds.push(body);
        try { applyRcon(body); } catch { /* 指令解析失败不影响响应 */ }
        sock.write(pkt(id, 0, ''));
      }
    });
    sock.on('error', () => {});
  });
  srv.listen(RCON_PORT, '127.0.0.1');
  return srv;
}

function killLeftover() {
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === process.pid || p === process.ppid) continue;
    try {
      if (fs.readlinkSync('/proc/' + p + '/cwd') === '/workspace/mcweb' && /node/.test(fs.readlinkSync('/proc/' + p + '/exe'))) process.kill(p, 'SIGTERM');
    } catch (e) { /* 忽略 */ }
  }
}

function seedFixture() {
  fs.rmSync(MC, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(BANDB), { recursive: true });
  fs.writeFileSync(MC + '/usercache.json', JSON.stringify([
    { name: 'alice', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
    { name: 'bob', uuid: 'bbbbbbbb-0000-0000-0000-000000000002' },
    { name: 'eve', uuid: 'eeeeeeee-0000-0000-0000-000000000005' },
    { name: 'frank', uuid: 'ffffffff-0000-0000-0000-000000000006' },
  ]));
  const db = new DatabaseSync(BANDB);
  db.exec('CREATE TABLE Punishments (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, uuid TEXT, reason TEXT, operator TEXT, punishmentType TEXT, start INTEGER, end INTEGER)');
  db.exec('CREATE TABLE PunishmentHistory (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, uuid TEXT, reason TEXT, operator TEXT, punishmentType TEXT, start INTEGER, end INTEGER)');
  const ins = db.prepare('INSERT INTO Punishments (name, uuid, reason, operator, punishmentType, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  ins.run('alice', 'aaaaaaaa-0000-0000-0000-000000000001', '使用外挂', 'Console', 'BAN', now - 86400000, 0);            // 永久
  ins.run('bob', 'bbbbbbbb-0000-0000-0000-000000000002', '刷屏', 'Admin', 'TEMP_BAN', now - 3600000, now + 3 * 86400000); // 临时
  ins.run('carol', null, '骂人', 'Admin', 'MUTE', now - 3600000, now + 86400000);   // 禁言：不应出现
  ins.run('dave', null, '旧的', 'Admin', 'BAN', now - 10 * 86400000, now - 86400000); // 已过期：不应出现
  db.close();
}

(async () => {
  killLeftover();
  await sleep(700);
  fs.rmSync(DATA, { recursive: true, force: true });
  seedFixture();
  const rconSrv = startFakeRcon();

  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'test',
    MC_LOCAL_ROOT: MC, DATA_DIR: DATA, SCAN_ENABLED: '0', PORT: String(PORT),
    LOG_POLL_MS: '3600000', BOT_POLL_MS: '3600000', STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000',
    BANS_WATCH_MS: '1500',
  });
  const out = fs.openSync('/tmp/mcwbans.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }
  ck('测试服务已就绪', up);
  if (!up) { rconSrv.close(); console.log('结果: 0 通过, 1 失败'); process.exit(1); }

  process.env.DATA_DIR = DATA;
  const db = require('/workspace/mcweb/lib/db').db;

  D('A 造数据：站长 / 普通用户');
  let r = await call('owner', 'POST', '/api/auth/register', { username: 'bn_owner', password: 'pass1234' });
  ck('第一个注册用户是站长', r.user && r.user.role === 'owner', JSON.stringify(r.user));
  await call('u1', 'POST', '/api/auth/register', { username: 'bn_user', password: 'pass1234' });

  D('B 读取封禁列表（解析插件库）');
  r = await call('u1', 'GET', '/api/admin/bans');
  ck('普通用户读封禁列表 403', r.code === 403, 'code=' + r.code);
  r = await call('owner', 'GET', '/api/admin/bans?refresh=1');
  ck('站长读到列表 200', r.code === 200 && Array.isArray(r.bans), JSON.stringify(r).slice(0, 150));
  ck('只统计生效中的封禁 = 2（alice 永久 + bob 临时）', r.total === 2, 'total=' + r.total);
  const alice = (r.bans || []).find((b) => b.name === 'alice');
  const bob = (r.bans || []).find((b) => b.name === 'bob');
  ck('alice 是永久封禁', alice && alice.permanent === true && alice.type === 'BAN', JSON.stringify(alice));
  ck('alice 理由/处理人正确', alice && alice.reason === '使用外挂' && alice.operator === 'Console', JSON.stringify(alice));
  ck('bob 是临时封禁且未到期', bob && bob.permanent === false && bob.end > Date.now(), JSON.stringify(bob));
  ck('禁言 carol 不在列表', !(r.bans || []).some((b) => b.name === 'carol'));
  ck('已过期 dave 不在列表', !(r.bans || []).some((b) => b.name === 'dave'));
  ck('alice 解析到 uuid', alice && alice.uuid === 'aaaaaaaa-0000-0000-0000-000000000001', alice && alice.uuid);
  ck('permanent 计数 = 1', r.permanent === 1, 'permanent=' + r.permanent);
  ck('未绑定玩家 webUser 为 null', alice && alice.webUser === null, JSON.stringify(alice && alice.webUser));

  D('C 实时推送：socket.io admins 房间');
  const events = [];
  const sock = io(BASE, { transports: ['polling'], extraHeaders: { Cookie: jar.owner }, reconnection: false });
  await new Promise((resolve) => {
    sock.on('connect', () => { sock.emit('watchAdmin'); resolve(); });
    sock.on('connect_error', () => resolve());
    setTimeout(resolve, 4000);
  });
  sock.on('bans', (p) => events.push(p));
  await sleep(300); // 让服务端把 socket 加进 admins 房间

  D('D 下发封禁（RCON ban / tempban）');
  const tBan = Date.now();
  r = await call('owner', 'POST', '/api/admin/bans/ban', { name: 'eve', reason: '恶意破坏' });
  const banMs = Date.now() - tBan;
  ck('封禁接口秒回（< 1500ms，不再阻塞等 SFTP 回读）', banMs < 1500, banMs + 'ms');
  ck('永久封禁 eve 秒回（pending，不阻塞核验）', r.code === 200 && r.ok === true && r.pending === true, JSON.stringify(r));
  ck('RCON 收到 ban eve 指令', rconCmds.some((c) => /^ban eve(\s|$)/.test(c)), JSON.stringify(rconCmds));
  await sleep(300);
  ck('后台立即收到 bans 事件（列表先动起来）', events.length >= 1, 'events=' + events.length);
  const evBan = await waitEvent(events, (e) => e.reason === 'ban' && e.name === 'eve' && e.verified === true, 9000);
  ck('后台回读校验通过并推送 verified=true', !!evBan, JSON.stringify(events.slice(-3)));
  r = await call('owner', 'GET', '/api/admin/bans?refresh=1');
  ck('列表里出现 eve', (r.bans || []).some((b) => b.name === 'eve' && b.permanent), JSON.stringify(r.bans));

  const beforeCmd = rconCmds.length;
  r = await call('owner', 'POST', '/api/admin/bans/ban', { name: 'frank', duration: '1d', reason: '刷屏§c带颜色\n换行' });
  ck('临时封禁 frank 成功（pending）', r.code === 200 && r.pending === true && r.duration === '1d', JSON.stringify(r));
  const tempCmd = rconCmds.slice(beforeCmd).find((c) => /^tempban frank/.test(c)) || '';
  ck('RCON 指令形如 tempban frank 1d ...', /^tempban frank 1d /.test(tempCmd), tempCmd);
  ck('理由里的颜色符与换行已消毒（单行、无 §）', !/[\n\r\u00a7]/.test(tempCmd) && /刷屏/.test(tempCmd), JSON.stringify(tempCmd));
  await waitEvent(events, (e) => e.reason === 'ban' && e.name === 'frank' && e.verified === true, 9000);
  r = await call('owner', 'GET', '/api/admin/bans?refresh=1');
  const frank = (r.bans || []).find((b) => b.name === 'frank');
  ck('frank 到期时间约 1 天后', frank && frank.end - Date.now() > 23 * 3600000 && frank.end - Date.now() < 25 * 3600000, frank && frank.end);

  D('E 解封（RCON unban）');
  const tUnban = Date.now();
  r = await call('owner', 'POST', '/api/admin/bans/unban', { name: 'eve' });
  const unbanMs = Date.now() - tUnban;
  ck('解封接口秒回（< 1500ms）', unbanMs < 1500, unbanMs + 'ms');
  ck('解封 eve 秒回（pending）', r.code === 200 && r.pending === true, JSON.stringify(r));
  ck('RCON 收到 unban eve 指令', rconCmds.some((c) => /^unban eve(\s|$)/.test(c)), JSON.stringify(rconCmds));
  const evUnban = await waitEvent(events, (e) => e.reason === 'unban' && e.name === 'eve' && e.verified === true, 9000);
  ck('解封回读校验通过', !!evUnban, JSON.stringify(events.slice(-3)));
  r = await call('owner', 'GET', '/api/admin/bans?refresh=1');
  ck('列表里已无 eve', !(r.bans || []).some((b) => b.name === 'eve'));

  D('F 输入校验与权限');
  const cmdBefore = rconCmds.length;
  r = await call('u1', 'POST', '/api/admin/bans/ban', { name: 'eve', reason: 'x' });
  ck('普通用户不能下发封禁（403）', r.code === 403, 'code=' + r.code);
  for (const bad of ['', 'a b', 'a;b', 'a\nb', '名子', 'x'.repeat(17)]) {
    r = await call('owner', 'POST', '/api/admin/bans/ban', { name: bad, reason: 'x' });
    ck('非法玩家名 ' + JSON.stringify(bad) + ' → 400', r.code === 400, 'code=' + r.code + ' ' + JSON.stringify(r).slice(0, 120));
  }
  r = await call('owner', 'POST', '/api/admin/bans/ban', { name: 'eve', duration: '1y', reason: 'x' });
  ck('非法时长 1y → 400', r.code === 400, JSON.stringify(r));
  ck('非法输入没有发出任何 RCON 指令', rconCmds.length === cmdBefore, 'delta=' + (rconCmds.length - cmdBefore));
  r = await call('owner', 'POST', '/api/admin/bans/unban', { name: '../etc' });
  ck('非法解封名 → 400', r.code === 400, JSON.stringify(r));

  D('G 定时巡检实时推送（不点刷新也能变）');
  const evBefore = events.length;
  const wdb = banDb();
  wdb.prepare('INSERT INTO Punishments (name, uuid, reason, operator, punishmentType, start, end) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('gina', null, '巡检查到', 'Console', 'BAN', Date.now(), 0);
  wdb.close();
  const evWatch = await waitEvent(events, (e) => e.reason === 'watch', 12000);
  ck('插件库被外部改动后，巡检推送 bans 事件', !!evWatch, events.length + ' 条事件 / ' + JSON.stringify(events.slice(-3)));

  D('H 历史记录 + 审计');
  process.env.DATA_DIR = DATA;
  db.prepare('INSERT INTO punishments (ext_id, mc_name, kind, reason, operator, start_at, end_at, history, weight, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(999, 'oldman', 'BAN', '历史封禁', 'Admin', Date.now() - 5 * 86400000, 0, 1, 60, Date.now());
  r = await call('owner', 'GET', '/api/admin/bans?history=1&limit=50');
  ck('history=1 返回历史数组', Array.isArray(r.history), typeof r.history);
  ck('历史里含刚插入的 oldman', (r.history || []).some((h) => h.name === 'oldman' && h.kind === 'BAN'), JSON.stringify(r.history && r.history.slice(0, 3)));
  r = await call('owner', 'GET', '/api/admin/bans');
  ck('不带 history=1 时不返回历史（省流量）', r.history === undefined);
  const banAudit = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'admin_game_ban'").get().c;
  const unbanAudit = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'admin_game_unban'").get().c;
  ck('封禁动作写了审计', banAudit >= 2, 'ban=' + banAudit);
  ck('解封动作写了审计', unbanAudit >= 1, 'unban=' + unbanAudit);

  D('I 后台页面接入（静态）');
  const html = fs.readFileSync('/workspace/mcweb/public/admin.html', 'utf8');
  ck('后台注册了「游戏封禁管理」Tab', /\['bans', '游戏封禁管理'\]/.test(html));
  ck('后台封禁页引用了三个接口', html.includes('/api/admin/bans?history=1') && html.includes('/api/admin/bans/ban') && html.includes('/api/admin/bans/unban'));
  ck('后台订阅 bans 实时事件', /socket\.on\('bans'/.test(html));
  ck('后台挂载时就加入 admins 房间（watchAdmin）', /emit\('watchAdmin'\)/.test(html));

  try { sock.close(); } catch {}
  rconSrv.close();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(2); });
