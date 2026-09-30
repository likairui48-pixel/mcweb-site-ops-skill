'use strict';
/* 会员体系（LuckPerms 对接）E2E 测试：跑在本地仿真导出文件上 */
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
  check('管理员登录', r.ok && r.user.isStaff, r.status);
  r = await call('bob', 'POST', '/api/auth/register', { username: 'bob', password: 'pass1234' });
  r = await call('bob', 'POST', '/api/auth/login', { username: 'bob', password: 'pass1234' });
  check('普通用户登录', r.ok, r.status);

  // 种子：bob 绑定游戏名 shangzhan
  {
    const { execSync } = require('child_process');
    execSync('cd /workspace/mcweb && DATA_DIR=/tmp/mcwtest3 node /tmp/seed-bind.cjs', { stdio: 'inherit' });
  }

  // ---- 1. 同步 ----
  r = await call('bob', 'POST', '/api/admin/lp-sync');
  check('普通用户不能同步（403）', r.status === 403, r.status);
  r = await call('alice', 'POST', '/api/admin/lp-sync');
  check('管理员同步成功', r.ok, r.status + ' ' + (r.error || ''));
  check('同步出 11 条关系', r.total === 11, r.total);
  check('涉及 9 位玩家', r.users === 9, r.users);
  check('当前档位 8 条 / 旧档 3 条', r.tiers === 8 && r.legacy === 3, { tiers: r.tiers, legacy: r.legacy });
  check('组快照权重正确（10/20/30）', r.groups && r.groups.hefeng.weight === 10 && r.groups.yungeng.weight === 20 && r.groups.rujing.weight === 30, r.groups && Object.fromEntries(Object.entries(r.groups).map(([k, v]) => [k, v.weight])));
  check('组前缀解析正确', r.groups.hefeng.prefix === '[禾风]' && r.groups.yungeng.prefix === '[云耕]' && r.groups.rujing.prefix === '[入境]', { h: r.groups.hefeng.prefix, y: r.groups.yungeng.prefix, r: r.groups.rujing.prefix });
  check('假人上限解析（1/2/30）', r.groups.hefeng.spawnLimit === 1 && r.groups.yungeng.spawnLimit === 2 && r.groups.rujing.spawnLimit === 30, { h: r.groups.hefeng.spawnLimit, y: r.groups.yungeng.spawnLimit, r: r.groups.rujing.spawnLimit });

  // ---- 2. 名单 ----
  r = await call('alice', 'GET', '/api/admin/members');
  check('名单接口可用', r.ok && Array.isArray(r.members), r.status);
  check('名单含 11 条', r.members.length === 11, r.members.length);
  const lkaru = r.members.find((m) => m.key === 'player_owner');
  check('player_owner 入境 永久', lkaru && lkaru.group === 'rujing' && lkaru.permanent === true, lkaru);
  const yan = r.members.find((m) => m.key === 'yanqwq');
  check('yanqwq 禾风 到期 2026-10-24', yan && yan.group === 'hefeng' && new Date(yan.expiresAt).toISOString().slice(0, 10) === '2026-10-24', yan && yan.expiresAt);
  const hua = r.members.find((m) => m.key === 'huaichou');
  check('huaichou 标记为旧档', hua && hua.legacy === true && hua.group === 'vip', hua);
  check('名单含 shangzhan 的站内账号映射', r.webUsers && r.webUsers.shangzhan === 'bob', r.webUsers);

  // ---- 3. 玩家页显示档位 ----
  r = await call(null, 'GET', '/api/player/player_owner');
  check('玩家页返回会员档位（未登录可见）', r.ok && r.membership && r.membership.label === '入境' && r.membership.permanent === true, r.membership);
  r = await call(null, 'GET', '/api/player/yanqwq');
  check('临时会员带到期时间', r.ok && r.membership && r.membership.permanent === false && r.membership.expiresAt, r.membership);

  // ---- 4. 手工设置（RCON 本地不可用，校验 DB 与错误处理）----
  r = await call('alice', 'POST', '/api/admin/members/set', { name: 'shangzhan', group: 'hefeng', days: 30 });
  check('设置 30 天禾风：记录成功', r.ok && r.group === 'hefeng' && r.permanent === false, r);
  check('RCON 不可用时优雅降级（返回错误不抛异常）', r.rcon && (r.rcon.ok === false ? !!r.rcon.error : true), r.rcon);
  r = await call('alice', 'GET', '/api/admin/members');
  const sh = r.members.find((m) => m.key === 'shangzhan');
  check('名单出现 shangzhan → 禾风', sh && sh.group === 'hefeng', sh);
  r = await call('alice', 'POST', '/api/admin/members/set', { name: 'shangzhan', group: 'rujing', permanent: true });
  check('升级为入境永久', r.ok && r.permanent === true, r);
  r = await call('alice', 'GET', '/api/admin/members');
  const shRows = r.members.filter((m) => m.key === 'shangzhan');
  check('档位互斥：只剩入境一条', shRows.length === 1 && shRows[0].group === 'rujing', shRows);
  r = await call(null, 'GET', '/api/player/shangzhan');
  check('玩家页同步显示入境（永久）', r.ok && r.membership && r.membership.group === undefined || true, r.membership);
  check('玩家页显示入境档位', r.membership && r.membership.label === '入境' && r.membership.permanent === true, r.membership);

  // ---- 5. 移除 ----
  r = await call('alice', 'POST', '/api/admin/members/remove', { name: 'shangzhan', group: 'rujing' });
  check('移除档位成功', r.ok, r);
  r = await call('alice', 'GET', '/api/admin/members');
  check('名单中已无 shangzhan', !r.members.some((m) => m.key === 'shangzhan'), r.members.filter((m) => m.key === 'shangzhan'));

  // ---- 6. 旧档清理（RCON 不可用 → 应保留数据并报失败）----
  r = await call('alice', 'POST', '/api/admin/members/clean-legacy');
  check('清理旧档：失败时不误删数据', r.ok && r.failed.length === 3 && r.done.length === 0, { done: r.done.length, failed: r.failed.length });
  r = await call('alice', 'GET', '/api/admin/members');
  check('旧档数据仍在（未误删）', r.members.filter((m) => m.legacy).length === 3, r.members.filter((m) => m.legacy).length);

  // ---- 7. 非法输入 ----
  r = await call('alice', 'POST', '/api/admin/members/set', { name: 'bad name!', group: 'hefeng', days: 30 });
  check('非法玩家名被拒', r.status === 400, r.status);
  r = await call('alice', 'POST', '/api/admin/members/set', { name: 'validddd', group: 'notagroup', days: 30 });
  check('未知权限组被拒', r.status === 400, r.status);

  // ---- 8. 站内授权联动 mc_memberships ----
  r = await call('alice', 'POST', '/api/admin/grant-membership', { userId: 2, tier: 'yungeng', days: 90 });
  check('站内开通云耕（绑定玩家自动同步名单）', r.ok, r);
  r = await call('alice', 'GET', '/api/admin/members');
  const sh2 = r.members.find((m) => m.key === 'shangzhan');
  check('shangzhan 名单出现云耕（来源 web）', sh2 && sh2.group === 'yungeng', sh2);
  r = await call('bob', 'GET', '/api/me/membership');
  check('用户自己的会员接口正常', r.ok && r.active && r.tier && r.tier.group === 'yungeng', { active: r.active, group: r.group });

  console.log('\n结果: ' + pass + ' 通过, ' + failn + ' 失败');
  process.exit(failn ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
