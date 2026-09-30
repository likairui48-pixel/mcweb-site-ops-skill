'use strict';
/* 隐私功能 E2E 测试 */
const BASE = process.env.BASE || 'http://127.0.0.1:8792';
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
  else { failn++; console.log('  !! ' + name + (extra ? ' | ' + JSON.stringify(extra).slice(0, 140) : '')); }
}

(async () => {
  // ---- 注册三个账号：alice(owner 自动)、bob、carol ----
  let r = await call('alice', 'POST', '/api/auth/register', { username: 'alice', password: 'pass1234' });
  if (!r.ok && !/已存在|占用/.test(r.error)) throw new Error('alice 注册失败: ' + JSON.stringify(r));
  r = await call('alice', 'POST', '/api/auth/login', { username: 'alice', password: 'pass1234' });
  check('alice 登录(owner)', r.ok && r.user && r.user.isStaff, r);
  r = await call('bob', 'POST', '/api/auth/register', { username: 'bob', password: 'pass1234' });
  r = await call('bob', 'POST', '/api/auth/login', { username: 'bob', password: 'pass1234' });
  check('bob 登录', r.ok, r);
  r = await call('carol', 'POST', '/api/auth/register', { username: 'carol', password: 'pass1234' });
  r = await call('carol', 'POST', '/api/auth/login', { username: 'carol', password: 'pass1234' });
  check('carol 登录(普通用户)', r.ok, r);


  // ---- 种子：给 bob 绑定一个仿真玩家（此时用户已存在）----
  {
    const { execSync } = require('child_process');
    execSync('cd /workspace/mcweb && DATA_DIR=/tmp/mcwtest2 node -e "' + [
      'const { db } = require(\'./lib/db\');',
      'const now = Date.now();',
      'const U = \'11111111-2222-3333-4444-555555555555\';',
      'db.prepare(\'DELETE FROM bindings WHERE user_id = (SELECT id FROM users WHERE username = ?)\').run(\'bob\');',
      'db.prepare(\'INSERT INTO bindings (user_id, mc_name, uuid, created_at, verified_by) SELECT id, ?, ?, ?, ? FROM users WHERE username = ?\').run(\'shangzhan\', U, now, \'chat\', \'bob\');',
      'db.prepare(\'INSERT OR REPLACE INTO stats_cache (uuid, name, playtime_ticks, level, first_join, last_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)\').run(U, \'shangzhan\', 720000, 12, now - 2592000000, now, now);',
      'console.log(\'seed-ok\');',
    ].join('') + '"', { stdio: 'inherit' });
  }

  const bobId = (await call('carol', 'GET', '/api/search?q=bob')).users.find((u) => u.username === 'bob').id;

  // ---- 默认全部公开 ----
  r = await call('carol', 'GET', '/api/profile/bob');
  check('默认: carol 可看 bob 主页', r.ok && !r.restricted && r.user.username === 'bob', r);

  // ---- 1. 主页仅好友 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { profile: 'friends' });
  check('bob 设置主页仅好友', r.ok && r.privacy.profile === 'friends', r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('carol 看 bob 主页 → restricted', r.ok && r.restricted === true && r.reason === 'friends', r);
  check('restricted 响应带 canFriendRequest', r.canFriendRequest === true, r);
  check('restricted 响应不含游戏数据/帖子', r.player === undefined && r.threads === undefined, r);
  r = await call('alice', 'GET', '/api/profile/bob');
  check('管理员 alice 仍可看(restricted=false)', r.ok && !r.restricted, r);
  r = await call('bob', 'GET', '/api/profile/bob');
  check('bob 自己可见', r.ok && !r.restricted, r);

  // ---- 2. 加好友→解锁 ----
  r = await call('carol', 'POST', '/api/friends/request', { userId: bobId });
  check('carol 发好友申请', r.ok, r);
  r = await call('bob', 'POST', '/api/friends/accept', { userId: (await call('bob', 'GET', '/api/friends')).incoming[0].id });
  check('bob 同意', r.ok, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('好友后 carol 可看 bob 主页', r.ok && !r.restricted, r);

  // ---- 3. 游戏数据细分 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { stats: 'self' });
  check('bob 设置游戏数据仅自己', r.ok, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('carol 看 bob: hidden.stats=true, player=null', r.ok && r.hidden.stats === true && r.player === null, r);
  r = await call('carol', 'GET', '/api/leaderboard?by=playtime&limit=100');
  const lbHasBob = (r.rows || []).some((x) => x.name === 'shangzhan');
  check('排行榜对 carol 隐藏 shangzhan', !lbHasBob, { rows: (r.rows || []).length });
  r = await call('bob', 'GET', '/api/leaderboard?by=playtime&limit=100');
  check('排行榜对 bob 自己仍显示', (r.rows || []).some((x) => x.name === 'shangzhan'), r.rows);
  r = await call('alice', 'GET', '/api/leaderboard?by=playtime&limit=100');
  check('管理员排行榜仍显示', (r.rows || []).some((x) => x.name === 'shangzhan'), r.rows);
  r = await call('carol', 'GET', '/api/player/shangzhan');
  check('carol /api/player/shangzhan → 403', r.status === 403, r);
  r = await call('bob', 'GET', '/api/player/shangzhan');
  check('bob 自己 /api/player 正常', r.ok && r.player && r.player.found, r);

  // ---- 4. 名片 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { card: 'self', stats: 'all' });
  check('bob 名片仅自己', r.ok && r.privacy.card === 'self', r);
  r = await call('carol', 'GET', '/api/card/shangzhan.png');
  check('非好友? 不,好友但 card=self → 404', r.status === 404, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('profile hidden.card=true', r.ok && r.hidden.card === true, r);
  r = await call('bob', 'POST', '/api/settings/privacy', { card: 'friends' });
  r = await call('carol', 'GET', '/api/card/shangzhan.png');
  check('card=friends 且 carol 是好友 → 200 PNG', r.status === 200, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('profile hidden.card=false', r.ok && r.hidden.card === false, r);

  // ---- 5. 私信策略 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { dm: 'none' });
  r = await call('carol', 'POST', '/api/dm/' + bobId, { text: 'hi' });
  check('dm=none: 好友也发不了私信', r.status === 403 && /不接受私信/.test(r.error), r);
  r = await call('bob', 'POST', '/api/settings/privacy', { dm: 'friends' });
  r = await call('carol', 'POST', '/api/dm/' + bobId, { text: 'hi' });
  check('dm=friends: 好友可发', r.ok, r);
  r = await call('bob', 'POST', '/api/settings/privacy', { dm: 'all' });
  r = await call('alice', 'POST', '/api/dm/' + bobId, { text: 'yo' });
  check('dm=all: 陌生人也能发(仍受屏蔽限制)', r.ok, r);

  // ---- 6. 好友申请策略 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { friendreq: 'none' });
  r = await call('alice', 'POST', '/api/friends/request', { userId: bobId });
  check('friendreq=none: 拒绝申请', r.status === 403 && /不接受好友申请/.test(r.error), r);

  // ---- 7. 被搜索 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { search: 'self', friendreq: 'all' });
  r = await call('carol', 'GET', '/api/users/search?q=bob');
  check('users/search 对 carol 隐藏 bob', !(r.users || []).some((u) => u.username === 'bob'), r.users);
  r = await call('carol', 'GET', '/api/search?q=bob');
  check('全站搜索隐藏 bob(用户)', !(r.users || []).some((u) => u.username === 'bob'), r.users);
  r = await call('carol', 'GET', '/api/search?q=shangzhan');
  check('全站搜索隐藏 bob(绑定的玩家)', !(r.players || []).some((p) => p.name === 'shangzhan'), r.players);
  r = await call('alice', 'GET', '/api/users/search?q=bob');
  check('管理员搜索仍可见', (r.users || []).some((u) => u.username === 'bob'), r.users);

  // ---- 8. 非法值校验 ----
  r = await call('bob', 'POST', '/api/settings/privacy', { profile: 'everyone' });
  check('非法选项被拒绝', r.status === 400, r);
  r = await call('bob', 'GET', '/api/settings/privacy');
  check('GET 设置项完整(9 项)', r.ok && Object.keys(r.items).length === 9 && r.privacy.profile === 'friends', r);

  // ---- 恢复公开 ----
  await call('bob', 'POST', '/api/settings/privacy', { profile: 'all', stats: 'all', card: 'all', search: 'all', dm: 'all' });
  r = await call('carol', 'GET', '/api/profile/bob');
  check('恢复公开: carol 全量可见', r.ok && !r.restricted && r.player && r.threads !== undefined && r.hidden.stats === false, r);

  console.log('\n结果: ' + pass + ' 通过, ' + failn + ' 失败');
  process.exit(failn ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
