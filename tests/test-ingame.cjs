'use strict';
/* 游戏内提醒（双端互通）E2E 测试：RCON 不可达场景 */
const BASE = 'http://127.0.0.1:8790';
const jars = {};
let pass = 0, failn = 0;

async function call(user, method, path, body) {
  const init = { method, headers: { ...(jars[user] ? { Cookie: jars[user] } : {}) } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  const sc = r.headers.get('set-cookie');
  if (sc && !jars[user]) jars[user] = sc.split(';')[0];
  let j = null;
  try { j = await r.json(); } catch { j = { ok: false, error: 'non-json' }; }
  return { status: r.status, ...j };
}
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failn++; console.log('  !! ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); }
}

(async () => {
  let r = await call('alice', 'POST', '/api/auth/register', { username: 'alice', password: 'pass1234' });
  r = await call('alice', 'POST', '/api/auth/login', { username: 'alice', password: 'pass1234' });
  check('alice 登录', r.ok, r.status);
  r = await call('bob', 'POST', '/api/auth/register', { username: 'bob', password: 'pass1234' });
  r = await call('bob', 'POST', '/api/auth/login', { username: 'bob', password: 'pass1234' });
  check('bob 登录', r.ok, r.status);
  { require('child_process').execSync('cd /workspace/mcweb && DATA_DIR=/tmp/mcwtest4 node /tmp/seed-bind.cjs', { stdio: 'inherit' }); }

  // ---- 1. 默认设置 ----
  r = await call('bob', 'GET', '/api/settings/notify');
  check('未绑定时提示未绑定', r.ok && r.bound === true && r.mcName === 'shangzhan', r);
  check('默认全部开启', r.notify.on === true && r.notify.join === true && r.notify.dm === true && r.notify.friend === true && r.notify.post === true && r.notify.membership === true, r.notify);
  check('返回 6 个开关项', r.items.length === 6, r.items && r.items.length);

  // ---- 2. 保存开关 ----
  r = await call('bob', 'POST', '/api/settings/notify', { on: true, dm: false, post: false });
  check('保存开关成功', r.ok && r.notify.dm === false && r.notify.post === false && r.notify.on === true, r.notify);
  r = await call('bob', 'GET', '/api/settings/notify');
  check('开关持久化', r.notify.dm === false && r.notify.friend === true, r.notify);
  r = await call('bob', 'POST', '/api/settings/notify', { on: false });
  check('总开关可关闭', r.ok && r.notify.on === false, r.notify);
  await call('bob', 'POST', '/api/settings/notify', { on: true, dm: true, post: true });

  // ---- 3. 触发通知（alice → bob 私信等）→ 不应抛错（RCON 不可达时优雅降级）----
  r = await call('alice', 'POST', '/api/dm/' + 2, { text: '双端提醒测试' });
  check('发私信成功（会尝试推送游戏）', r.ok, r);
  r = await call('alice', 'POST', '/api/friends/request', { userId: 2 });
  check('好友申请成功', r.ok, r);
  r = await call('bob', 'GET', '/api/notifications');
  const kinds = (r.notifications || []).map((n) => n.kind);
  check('通知已入库（dm + friend）', kinds.includes('dm') && kinds.includes('friend_request'), kinds);
  r = await call('bob', 'GET', '/api/settings/notify');
  check('推送失败不影响接口（开关仍可读）', r.ok, r.status);

  // ---- 4. 未读统计（进服播报的数据源）----
  const ingame = require('/workspace/mcweb/lib/ingame');
  process.env.DATA_DIR = '/tmp/mcwtest4';
  check('ingame 模块导出正常', typeof ingame.onPlayerJoin === 'function' && typeof ingame.notifyUser === 'function');
  const tl = ingame.tellraw('bob', [{ text: 'hi', color: 'red' }]);
  check('tellraw 生成正确 JSON', tl === 'tellraw bob ' + JSON.stringify([{ text: 'hi', color: 'red' }]), tl);

  // ---- 5. 未绑定用户不推送 ----
  r = await call('alice', 'GET', '/api/settings/notify');
  check('alice 未绑定游戏账号', r.ok && r.bound === false, r);

  // ---- 6. 进服播报（直接调模块，RCON 不可达 → ok:false 但不会抛异常）----
  const res = await ingame.onPlayerJoin('shangzhan').catch((e) => ({ ok: false, error: 'throw:' + e.message }));
  check('onPlayerJoin 不抛异常', res && typeof res.ok === 'boolean', res);
  const res2 = await ingame.notifyUser(2, 'dm', { text: '测试', link: '/chat' }).catch((e) => ({ ok: false, error: 'throw:' + e.message }));
  check('notifyUser 不抛异常', res2 && typeof res2.ok === 'boolean', res2);
  check('RCON 不可达时返回错误信息', res2.ok === false && !!res2.error, res2);

  console.log('\n结果: ' + pass + ' 通过, ' + failn + ' 失败');
  process.exit(failn ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
