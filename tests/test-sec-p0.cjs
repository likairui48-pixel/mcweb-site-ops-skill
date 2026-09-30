'use strict';
/**
 * P0 安全加固回归测试（自起一个独立实例，互不干扰）
 * 覆盖：会话撤销 / 管理员越权边界 / 登录锁定 / 会员组白名单 / Cookie 安全属性
 *       / 同源校验(CSRF) / 安全响应头 / 静态配置断言
 * 用法：node test/test-sec-p0.cjs
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// 支持从任意目录运行：优先用 MCWEB_DIR 指向站点根
const ROOT = process.env.MCWEB_DIR ? path.resolve(process.env.MCWEB_DIR) : path.join(__dirname, '..');
const PORT = Number(process.env.SEC_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = process.env.SEC_DATA || '/tmp/mcsec-p0';

let pass = 0, fail = 0;
const ck = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  !! ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); }
};

const jars = {};
async function call(who, method, p, body, extraHeaders) {
  const headers = { ...(jars[who] ? { Cookie: jars[who] } : {}), ...(extraHeaders || {}) };
  const init = { method, headers };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, init);
  const sc = r.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, ct, setCookie: sc };
  return { status: r.status, setCookie: sc, ...(await r.json()) };
}

function waitReady(ms) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(BASE + '/api/health');
        if (r.ok) return resolve(true);
      } catch {}
      if (Date.now() - t0 > ms) return reject(new Error('服务未就绪'));
      setTimeout(tick, 400);
    };
    tick();
  });
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: DATA,
      MC_HOST: '127.0.0.1',
      MC_RCON_HOST: '127.0.0.1',
      MC_RCON_PORT: '1',
      SCAN_ENABLED: '0',
      LOG_POLL_MS: '600000',
      COOKIE_SECURE: '1',
      SESSION_DAYS: '7',
      LOGIN_MAX_FAILS: '3',
      LOGIN_FAIL_WINDOW_MS: '60000',
      LOGIN_LOCK_MS: '60000',
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const stop = () => { try { child.kill('SIGKILL'); } catch {} };

  try {
    await waitReady(30000);

    console.log('=== Cookie 安全属性 ===');
    let r = await call('owner', 'POST', '/api/auth/register', { username: 'sec_owner', password: 'pass1234' });
    ck('首个注册用户成为站长', r.ok && r.user.role === 'owner', r.user && r.user.role);
    const sc = r.setCookie || '';
    ck('Cookie 含 HttpOnly', /HttpOnly/i.test(sc), sc);
    ck('Cookie 含 Secure', /Secure/i.test(sc), sc);
    ck('Cookie 含 SameSite=Lax', /SameSite=Lax/i.test(sc), sc);

    console.log('\n=== 安全响应头 ===');
    const hr = await fetch(BASE + '/api/health');
    ck('X-Content-Type-Options: nosniff', hr.headers.get('x-content-type-options') === 'nosniff', hr.headers.get('x-content-type-options'));
    ck('X-Frame-Options: DENY', hr.headers.get('x-frame-options') === 'DENY', hr.headers.get('x-frame-options'));
    ck('Referrer-Policy 已设置', !!hr.headers.get('referrer-policy'), hr.headers.get('referrer-policy'));

    console.log('\n=== 同源校验（CSRF）===');
    r = await call('csrf', 'POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' });
    ck('跨源写请求被拒（403）', r.status === 403, r.status);
    r = await call('csrf', 'POST', '/api/auth/logout', {}, { Origin: BASE });
    ck('同源写请求放行', r.ok === true || r.status === 200, r.status);

    console.log('\n=== 管理员越权边界 ===');
    await call('u1', 'POST', '/api/auth/register', { username: 'sec_u1', password: 'pass1234' });
    await call('u2', 'POST', '/api/auth/register', { username: 'sec_u2', password: 'pass1234' });
    const ownerId = 1;
    let users = await call('owner', 'GET', '/api/admin/users');
    const u1 = (users.users || []).find((x) => x.username === 'sec_u1');
    const u2 = (users.users || []).find((x) => x.username === 'sec_u2');
    ck('管理端用户列表可读', !!u1 && !!u2, users.users && users.users.length);

    r = await call('owner', 'POST', `/api/admin/user/${u1.id}`, { isAdmin: true });
    ck('站长可任命管理员', r.ok && r.user.is_admin === 1, r.user);
    await call('u1', 'POST', '/api/auth/login', { username: 'sec_u1', password: 'pass1234' });

    r = await call('u1', 'POST', `/api/admin/user/${u2.id}`, { isAdmin: true });
    ck('管理员不能任命管理员（403）', r.status === 403, r.error);
    r = await call('u1', 'POST', `/api/admin/user/${ownerId}`, { resetPassword: 'hacked123' });
    ck('管理员不能重置站长密码（403）', r.status === 403, r.error);
    r = await call('u1', 'POST', `/api/admin/user/${ownerId}`, { banned: true });
    ck('管理员不能封禁站长（403）', r.status === 403, r.error);
    r = await call('u1', 'POST', `/api/admin/staff/${u2.id}/role`, { role: 'admin' });
    ck('管理员不能经 staff 接口提权（403）', r.status === 403, r.error);
    r = await call('owner', 'POST', `/api/admin/user/${ownerId}`, { isAdmin: false });
    ck('任何人不改自己的管理员位（403）', r.status === 403, r.error);

    console.log('\n=== 会话撤销（改密/重置密码）===');
    const oldU2 = jars.u2;
    r = await call('owner', 'POST', `/api/admin/user/${u2.id}`, { resetPassword: 'newpass123' });
    ck('站长可重置普通用户密码', r.ok === true, r);
    const stale = await fetch(BASE + '/api/auth/me', { headers: { Cookie: oldU2 } });
    const staleJson = await stale.json();
    ck('被重置密码的用户旧会话失效', staleJson.user === null, staleJson.user);

    await call('u3', 'POST', '/api/auth/register', { username: 'sec_u3', password: 'pass1234' });
    const oldU3 = jars.u3;
    r = await call('u3', 'POST', '/api/auth/password', { oldPassword: 'pass1234', newPassword: 'pass5678' });
    ck('用户可自行改密', r.ok === true, r);
    const stale3 = await fetch(BASE + '/api/auth/me', { headers: { Cookie: oldU3 } });
    ck('改密后旧会话失效', (await stale3.json()).user === null);
    r = await call('u3', 'GET', '/api/auth/me');
    ck('改密后当前设备仍可用（换发新 Cookie）', r.ok && r.user && r.user.username === 'sec_u3', r.user && r.user.username);

    console.log('\n=== 登录失败锁定 ===');
    for (let i = 0; i < 3; i++) await call('x', 'POST', '/api/auth/login', { username: 'sec_u1', password: 'wrongpass' });
    r = await call('x', 'POST', '/api/auth/login', { username: 'sec_u1', password: 'pass1234' });
    ck('连续失败后锁定（正确密码也拒绝 429）', r.status === 429, { s: r.status, e: r.error });
    r = await call('x', 'POST', '/api/auth/login', { username: 'sec_nobody', password: 'whatever' });
    ck('不存在的用户不泄露存在性（401）', r.status === 401 && !/不存在/.test(String(r.error)), r.error);

    console.log('\n=== 会员组白名单（防 RCON 注入）===');
    users = await call('owner', 'GET', '/api/admin/users');
    const u3 = (users.users || []).find((x) => x.username === 'sec_u3');
    ck('可查到测试用户', !!u3, users.users && users.users.length);
    r = await call('owner', 'POST', `/api/admin/membership/${u3.id}`, { days: 30, group: 'vip; op sec_owner' });
    ck('非白名单组被拒（400）', r.status === 400, r.error);
    const legalGroup = ['hefeng', 'yungeng', 'rujing', 'vip', 'svip', 'mvp'][0];
    r = await call('owner', 'POST', `/api/admin/membership/${u3.id}`, { days: 30, group: legalGroup });
    ck('白名单组正常开通', r.ok === true && r.group === legalGroup, { s: r.status, g: r.group, e: r.error });

    console.log('\n=== 静态配置断言 ===');
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ck('信任代理仅回环（不可伪造来源 IP）', /trust proxy', process\.env\.TRUST_PROXY \|\| 'loopback'/.test(src));
    ck('监听默认绑定 127.0.0.1', /server\.listen\(PORT, process\.env\.BIND_HOST \|\| '127\.0\.0\.1'/.test(src));
    ck('首个用户成站长可关闭（ALLOW_FIRST_OWNER）', /ALLOW_FIRST_OWNER/.test(src));
    ck('审计日志不写明文密码', /resetPassword=\*\*\*/.test(src) && !/JSON\.stringify\(req\.body\)\.slice\(0, 200\)/.test(src));
    const authSrc = fs.readFileSync(path.join(ROOT, 'lib', 'auth.js'), 'utf8');
    ck('Cookie 支持 Secure 且随 NODE_ENV 自动开启', /secure: COOKIE_SECURE/.test(authSrc) && /NODE_ENV === 'production'/.test(authSrc));
    const mSrc = fs.readFileSync(path.join(ROOT, 'lib', 'metrics.js'), 'utf8');
    ck('监控路径统计有上限（防 OOM）', /MAX_PATHS/.test(mSrc));
    const sSrc = fs.readFileSync(path.join(ROOT, 'lib', 'social.js'), 'utf8');
    ck('身份变更后作废旧会话', /session_version = session_version \+ 1/.test(sSrc));
  } catch (e) {
    fail++;
    console.log('  !! 测试异常: ' + e.message);
    console.log(log.split('\n').slice(-15).join('\n'));
  } finally {
    stop();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
