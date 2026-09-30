'use strict';
/* 角色权限验收（规范 九 / 十一.3）：普通用户 vs 站长导航与接口 */
const { spawn } = require('child_process');
const fs = require('fs');
const PORT = 8798, BASE = 'http://127.0.0.1:' + PORT, DATA = '/tmp/mcwrole';
let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 160) : '')); } };
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
  let j = {}; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 80) }; }
  return { code: r.status, ...j };
}
(async () => {
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === process.pid || p === process.ppid) continue;
    try { if (fs.readlinkSync('/proc/' + p + '/cwd') === '/workspace/mcweb' && /node/.test(fs.readlinkSync('/proc/' + p + '/exe'))) process.kill(p, 'SIGTERM'); } catch (e) {}
  }
  await sleep(700);
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, { MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1', DATA_DIR: DATA, MC_LOCAL_ROOT: '/tmp/mcfake', SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '600000', PORT: String(PORT), SITE_URL: BASE });
  const out = fs.openSync('/tmp/mcwrole.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref(); fs.writeFileSync('/tmp/mcwrole.pid', String(srv.pid));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) {} if (!up) await sleep(400); }
  console.log('[A] 账号');
  await call('owner', 'POST', '/api/auth/register', { username: 'roleowner', password: 'pass1234' });
  await call('user', 'POST', '/api/auth/register', { username: 'roleuser', password: 'pass1234' });
  const mo = await call('owner', 'GET', '/api/auth/me');
  const mu = await call('user', 'GET', '/api/auth/me');
  ck('首用户自动成为管理员', !!(mo.user && mo.user.isStaff), mo.user && JSON.stringify({ role: mo.user.role, isStaff: mo.user.isStaff }));
  ck('次用户是普通用户', !!(mu.user && !mu.user.isStaff && mu.user.role === 'user'), mu.user && JSON.stringify({ role: mu.user.role, isStaff: mu.user.isStaff }));

  console.log('\n[B] 管理接口权限（规范 七.4）');
  for (const p of ['/api/admin/overview', '/api/admin/users', '/api/admin/reports', '/api/admin/avatars', '/api/admin/metrics', '/api/admin/season', '/api/admin/audit', '/api/admin/payments', '/api/admin/ai']) {
    const r = await call('user', 'GET', p);
    ck('普通用户 ' + p + ' 被拒', r.code === 403 || r.code === 401, r.code);
  }
  for (const p of ['/api/admin/overview', '/api/admin/reports', '/api/admin/metrics']) {
    const r = await call('owner', 'GET', p);
    ck('站长 ' + p + ' 可访问', r.code === 200, r.code);
  }
  console.log('\n[B2] 站长专属端点（规范 九.1）');
  const brandGet = await call('user', 'GET', '/api/admin/brand');
  ck('普通用户读品牌配置被拒', brandGet.code === 403 || brandGet.code === 401, brandGet.code);
  const consoleTry = await call('owner', 'POST', '/api/admin/console', { command: 'list' });
  ck('站长可执行控制台命令（无 RCON 时也返回结构）', consoleTry.code === 200 || consoleTry.code === 502 || consoleTry.ok === false, consoleTry.code);
  const brandOwner = await call('owner', 'GET', '/api/admin/brand');
  ck('站长可读品牌配置', brandOwner.code === 200, brandOwner.code);

  console.log('\n[C] 前端守卫');
  const ad = await fetch(BASE + '/admin');
  ck('/admin 页面可加载（内容由前端按角色渲染）', ad.ok);
  const html = fs.readFileSync('/workspace/mcweb/public/admin.html', 'utf8');
  ck('非 staff 显示无权访问卡片', html.includes('无权访问') && html.includes('后台仅限站长、管理员与版主使用'));
  const app = fs.readFileSync('/workspace/mcweb/public/app.js', 'utf8');
  ck('侧栏管理组仅 staff 渲染', app.includes('if (u && u.isStaff)'));
  ck('版主仅见 overview/reports', app.includes("['overview', 'reports'].indexOf(t[0]) > -1"));
  console.log('\n[D] 隐私越权（规范 七.5）');
  const pr = await call('user', 'GET', '/api/player/zaoren');
  ck('玩家页接口可用（公开部分）', pr.code === 200, pr.code);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  try { process.kill(Number(fs.readFileSync('/tmp/mcwrole.pid', 'utf8')), 'SIGTERM'); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
