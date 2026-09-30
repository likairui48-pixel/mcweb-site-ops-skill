'use strict';
/**
 * 假人绑定拒绝（游戏内通道）端到端验收
 * 链路：日志里出现「绑定 <码>」→ 站内轮询解析 → 判定假人 → tellraw 拒绝提示 + 绑定码作废 + 审计记录
 * 同时验证真人走同一条链路可以正常绑定（不误伤）
 * 运行：node /tmp/test-fakes-e2e.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const fakeRcon = require('/tmp/fake-rcon.cjs').server;

const PORT = 8781;
const RCON_PORT = 25583;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwfke2e';
const LOGROOT = '/tmp/mcfakefk';
const DENY = '不支持与假人账号绑定，如有异议请联系管理员';
const ONLINE = 'There are 3 of a max of 20 players online: bot3, RealGuy, zaoren';

let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 300) : '')); }
};
const D = (t) => console.log('\n[' + t + ']');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chatLine = (who, text) => '[12:00:00] [Async Chat Thread - #0/INFO]: <' + who + '> ' + text + '\n';
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
  try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { raw: t.slice(0, 160) }; }
  return { code: r.status, ...j };
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

(async () => {
  killLeftover();
  await sleep(700);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(LOGROOT, { recursive: true, force: true });
  fs.mkdirSync(LOGROOT + '/logs', { recursive: true });
  fs.writeFileSync(LOGROOT + '/logs/latest.log', '');
  fs.writeFileSync(LOGROOT + '/usercache.json', JSON.stringify([
    { name: 'bot3', uuid: 'fb070000-0000-0000-0000-000000000003' },
    { name: 'RealGuy', uuid: '2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e' },
  ]));

  const rcon = fakeRcon({ port: RCON_PORT, password: 'pw', replies: { list: ONLINE } });
  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'pw',
    DATA_DIR: DATA, MC_LOCAL_ROOT: LOGROOT, SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '3600000',
    PORT: String(PORT), SITE_URL: BASE, LOG_POLL_MS: '1000', BOT_POLL_MS: '3600000',
    STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000',
  });
  const out = fs.openSync('/tmp/mcwfke2e.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  fs.writeFileSync('/tmp/mcwfke2e.pid', String(srv.pid));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等待 */ } if (!up) await sleep(400); }
  ck('测试服务已就绪（假 RCON + 日志轮询 1s）', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }

  process.env.DATA_DIR = DATA;
  const db = require('/workspace/mcweb/lib/db').db;

  async function waitCmd(pred, tries = 40) {
    for (let i = 0; i < tries; i++) {
      const hit = rcon.commands.find(pred);
      if (hit) return hit;
      await sleep(400);
    }
    return null;
  }
  const say = (who, text) => fs.appendFileSync(LOGROOT + '/logs/latest.log', chatLine(who, text));

  await call('a', 'POST', '/api/auth/register', { username: 'fke2e', password: 'pass1234' });

  D('A 假人在游戏里发绑定码 → 直接拒绝');
  rcon.commands.length = 0;
  const c1 = await call('a', 'POST', '/api/bind/start', {});
  ck('拿到绑定码', !!c1.code, JSON.stringify(c1));
  say('bot3', '绑定 ' + c1.code);
  const cmd = await waitCmd((c) => c.startsWith('tellraw bot3 '));
  ck('游戏里收到了 tellraw（只发给该玩家）', !!cmd, JSON.stringify(rcon.commands).slice(0, 240));
  let payload = null;
  try { payload = JSON.parse(String(cmd).replace(/^tellraw bot3 /, '')); } catch (e) {}
  ck('提示内容与需求逐字一致', payload && payload.text === DENY, JSON.stringify(payload));
  ck('没有任何附带指令（eg 提权/给物品）', !rcon.commands.some((c) => /^\s*(op|deop|lp|give|tp|ban|kick|execute|sudo)\b/i.test(c)), JSON.stringify(rcon.commands).slice(0, 240));
  await sleep(600);
  ck('没有产生绑定记录', (db.prepare("SELECT COUNT(*) c FROM bindings WHERE lower(mc_name) = 'bot3'").get().c || 0) === 0);
  ck('绑定码被作废', (db.prepare('SELECT used FROM bind_codes WHERE code = ?').get(c1.code) || {}).used === 1);
  ck('写入了拒绝审计', (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'bind_reject_fake'").get().c || 0) > 0);

  D('B 真人走同一条链路 → 正常绑定');
  rcon.commands.length = 0;
  const c2 = await call('a', 'POST', '/api/bind/start', {});
  say('RealGuy', '绑定 ' + c2.code);
  const cmd2 = await waitCmd((c) => c.startsWith('tellraw RealGuy '));
  ck('真人收到 tellraw', !!cmd2, JSON.stringify(rcon.commands).slice(0, 240));
  await sleep(800);
  const b = db.prepare("SELECT mc_name FROM bindings WHERE lower(mc_name) = 'realguy'").get();
  ck('真人绑定成功入库', !!b, JSON.stringify(b));

  D('C 在线列表折叠（同一实例）');
  const st = await call('a', 'GET', '/api/status?refresh=1');
  ck('在线名单不含 bot3', !(st.names || []).includes('bot3'), JSON.stringify(st.names));
  ck('折叠数 ≥1', (st.fakeFolded || 0) >= 1, String(st.fakeFolded));
  ck('折叠名单含 bot3', (st.fakeNames || []).includes('bot3'), JSON.stringify(st.fakeNames));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(2); });
