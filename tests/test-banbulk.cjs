'use strict';
/**
 * 批量封禁/解封 + 路径参数守卫（/api/dm/null/pin 500 的回归）
 * 运行：node /tmp/test-banbulk.cjs   （自起服务，端口 8790，DATA_DIR=/tmp/mcwbb）
 */
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = 8790;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwbb';

let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 300) : '')); }
};
const D = (t) => console.log('\n[' + t + ']');
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
  let j = {};
  try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { raw: t.slice(0, 200) }; }
  return { code: r.status, ctype: r.headers.get('content-type') || '', ...j };
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
  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1',
    DATA_DIR: DATA, SCAN_ENABLED: '0', PORT: String(PORT),
    LOG_POLL_MS: '3600000', BOT_POLL_MS: '3600000', STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000',
  });
  const out = fs.openSync('/tmp/mcwbb.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }
  ck('测试服务已就绪', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }

  process.env.DATA_DIR = DATA;
  const db = require('/workspace/mcweb/lib/db').db;

  D('A 造数据：站长 / 管理员 / 普通用户');
  let r = await call('owner', 'POST', '/api/auth/register', { username: 'bb_owner', password: 'pass1234' });
  ck('第一个注册用户是站长', r.user && r.user.role === 'owner', JSON.stringify(r.user));
  await call('adm', 'POST', '/api/auth/register', { username: 'bb_admin', password: 'pass1234' });
  await call('u1', 'POST', '/api/auth/register', { username: 'bb_user1', password: 'pass1234' });
  await call('u2', 'POST', '/api/auth/register', { username: 'bb_user2', password: 'pass1234' });
  await call('u3', 'POST', '/api/auth/register', { username: 'bb_user3', password: 'pass1234' });
  // 把 bb_admin 提为管理员
  const admId = db.prepare("SELECT id FROM users WHERE username = 'bb_admin'").get().id;
  r = await call('owner', 'POST', '/api/admin/user/' + admId, { isAdmin: true });
  ck('站长可任命管理员', r.code === 200 && r.user.is_admin === 1, JSON.stringify(r));
  // 任免管理员会作废旧会话（这是设计如此），所以要重新登录拿新会话
  r = await call('adm', 'POST', '/api/auth/login', { username: 'bb_admin', password: 'pass1234' });
  ck('提权后需重新登录（旧会话已作废，符合预期）', r.code === 200 && r.user.isAdmin === true, JSON.stringify(r).slice(0, 140));

  D('B 路径参数守卫：/api/dm/null|undefined|abc 不能再 500');
  for (const bad of ['null', 'undefined', 'abc', 'NaN', '%20', '0', '-1', '1.5']) {
    const p = await call('u1', 'POST', '/api/dm/' + bad + '/pin', {});
    ck('POST /api/dm/' + bad + '/pin → 400/404（不是 500）', p.code === 400 || p.code === 404, 'code=' + p.code + ' ' + JSON.stringify(p).slice(0, 120));
  }
  for (const bad of ['null', 'undefined', 'abc']) {
    const m = await call('u1', 'POST', '/api/dm/' + bad + '/mute', {});
    const v = await call('u1', 'POST', '/api/dm/' + bad + '/read', {});
    const g = await call('u1', 'GET', '/api/dm/' + bad + '/meta');
    const d = await call('u1', 'DELETE', '/api/dm/' + bad);
    ck('mute/read/meta/delete ' + bad + ' 都不是 500', [m.code, v.code, g.code, d.code].every((c) => c !== 500), JSON.stringify([m.code, v.code, g.code, d.code]));
  }
  r = await call('u1', 'POST', '/api/dm/null/pin', {});
  ck('错误响应是 JSON 且带中文提示（不是 express 的 HTML 错误页）', r.ctype.includes('application/json') && !!r.error, JSON.stringify(r).slice(0, 200));

  D('C 权限：非管理员 / 管理员 / 站长');
  r = await call('u1', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_user2'] });
  ck('普通用户不能批量封禁（403）', r.code === 403, 'code=' + r.code);
  r = await call('adm', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_user2'] });
  ck('管理员可以封禁普通用户', r.code === 200 && r.changed === 1, JSON.stringify(r));
  ck('封禁后 DB banned=1', db.prepare("SELECT banned FROM users WHERE username = 'bb_user2'").get().banned === 1);
  r = await call('u2', 'POST', '/api/auth/login', { username: 'bb_user2', password: 'pass1234' });
  ck('被封禁账号无法登录（403 账号已被封禁）', r.code === 403 && /封禁/.test(r.error || ''), JSON.stringify(r));
  r = await call('adm', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_owner'] });
  ck('管理员不能封禁站长', r.code === 200 && r.changed === 0 && r.skipped.some((s) => /仅站长/.test(s.reason)), JSON.stringify(r));
  r = await call('adm', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_admin'] });
  ck('管理员不能封禁其他管理员', r.changed === 0 && r.skipped.some((s) => /仅站长/.test(s.reason)), JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_admin'] });
  ck('站长可以封禁管理员', r.changed === 1, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', names: ['bb_admin'] });
  ck('站长可以解封管理员', r.changed === 1, JSON.stringify(r));

  D('D 批量解封：多分隔符 / 大小写 / ID / 不存在 / 重复');
  db.prepare("UPDATE users SET banned = 1 WHERE username IN ('bb_user1','bb_user2','bb_user3')").run();
  const u1 = db.prepare("SELECT id FROM users WHERE username = 'bb_user1'").get().id;
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', names: 'BB_USER1, bb_user2\n' + u1 + '  bb_user3;bb_nobody' });
  ck('一次解封 3 个（大小写/ID/换行/逗号/分号混合）', r.changed === 3, JSON.stringify(r));
  ck('不存在的账号进 skipped', r.skipped.some((s) => s.name === 'bb_nobody' && /不存在/.test(s.reason)), JSON.stringify(r.skipped));
  ck('DB 里已无封禁账号', db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c === 0);
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', names: ['bb_user1'] });
  ck('重复解封会说明「本来就没被封禁」', r.changed === 0 && r.skipped.some((s) => /本来就没被封禁/.test(s.reason)), JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: [] });
  ck('空名单 → 400', r.code === 400, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'nope', names: ['bb_user1'] });
  ck('非法 mode → 400', r.code === 400, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_owner'] });
  ck('不能封禁自己', r.changed === 0 && r.skipped.some((s) => /不能封禁自己/.test(s.reason)), JSON.stringify(r));

  D('E 一键解封全部（all）');
  db.prepare("UPDATE users SET banned = 1 WHERE username IN ('bb_user1','bb_user2')").run();
  ck('先造 2 个封禁', db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c === 2);
  // 上一节封/解封过 bb_admin，会话又作废了，重新登录
  r = await call('adm', 'POST', '/api/auth/login', { username: 'bb_admin', password: 'pass1234' });
  ck('管理员重新登录成功', r.code === 200 && r.user.isAdmin === true, JSON.stringify(r).slice(0, 120));
  r = await call('adm', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', all: true });
  ck('all 模式仅站长可用（管理员 403）', r.code === 403, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', all: true });
  ck('站长一键解封全部 → changed=2', r.code === 200 && r.changed === 2, JSON.stringify(r));
  ck('DB 里 banned=1 归零', db.prepare('SELECT COUNT(*) c FROM users WHERE banned = 1').get().c === 0);
  r = await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'unban', all: true });
  ck('再点一次不会报错，changed=0', r.code === 200 && r.changed === 0, JSON.stringify(r));

  D('F 解封后可用性 + 会话作废 + 审计');
  r = await call('u2', 'POST', '/api/auth/login', { username: 'bb_user2', password: 'pass1234' });
  ck('解封后能重新登录', r.code === 200 && r.user, JSON.stringify(r).slice(0, 140));
  const before = db.prepare("SELECT session_version v FROM users WHERE username = 'bb_user2'").get().v;
  await call('owner', 'POST', '/api/admin/users/bulk-ban', { mode: 'ban', names: ['bb_user2'] });
  const after = db.prepare("SELECT session_version v FROM users WHERE username = 'bb_user2'").get().v;
  ck('封禁会作废旧会话（session_version +1）', after === before + 1, before + ' → ' + after);
  const aud = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action IN ('admin_user_bulk_ban','admin_user_bulk_unban')").get().c;
  ck('批量操作写了审计', aud >= 4, 'audit=' + aud);
  const per = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'admin_user_update' AND detail LIKE '%via=bulk%'").get().c;
  ck('每个账号都有单独留痕（via=bulk）', per >= 5, 'per=' + per);

  D('G 单个封禁接口同样可用（后台按钮走它）');
  const id3 = db.prepare("SELECT id FROM users WHERE username = 'bb_user3'").get().id;
  r = await call('owner', 'POST', '/api/admin/user/' + id3, { banned: true });
  ck('单个封禁 200', r.code === 200 && r.user.banned === 1, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/user/' + id3, { banned: false });
  ck('单个解封 200', r.code === 200 && r.user.banned === 0, JSON.stringify(r));

  D('H 未捕获异常不再返回 HTML 错误页');
  // 直接打一个会进 express 默认错误处理的路径：给 social2 路由塞非法参数已走 400；这里验证错误处理中间件本身存在
  const errPage = await fetch(BASE + '/api/dm/null/pin', { method: 'POST', headers: { Cookie: jar.u1 || '', 'Content-Type': 'application/json' }, body: '{}' });
  const txt = await errPage.text();
  ck('接口错误响应体不含 <!DOCTYPE html>', !/<!DOCTYPE html>/i.test(txt), txt.slice(0, 120));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(2); });
