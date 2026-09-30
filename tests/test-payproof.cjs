'use strict';
/* 付款凭证上传（新增功能）端到端：注册 → 登录 → 提交带凭证的订单 → 校验落盘 / 落库 / 管理员可见 */
const { spawn } = require('child_process');
const fs = require('fs');

const PORT = 8797;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwpay';
let pass = 0, fail = 0;
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 200) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killLeftoverServers() {
  const me = process.pid, pp = process.ppid;
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === me || p === pp) continue;
    try {
      const cwd = fs.readlinkSync('/proc/' + p + '/cwd');
      const exe = fs.readlinkSync('/proc/' + p + '/exe');
      if (cwd === '/workspace/mcweb' && /node/.test(exe)) { try { process.kill(p, 'SIGTERM'); console.log('  (清理遗留服务 pid ' + p + ')'); } catch (e) {} }
    } catch (e) { /* 忽略 */ }
  }
}

const jar = {};
async function call(who, method, p, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setC = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (setC.length) jar[who] = setC.map((c) => c.split(';')[0]).join('; ');
  let t = '';
  try { t = await r.text(); } catch (e) {}
  let j = {};
  try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { raw: t.slice(0, 100) }; }
  return { code: r.status, ...j };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';

(async () => {
  killLeftoverServers();
  await sleep(700);
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1',
    DATA_DIR: DATA, MC_LOCAL_ROOT: '/tmp/mcfake', SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '600000',
    PORT: String(PORT), SITE_URL: BASE,
  });
  const out = fs.openSync('/tmp/mcwpay.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  fs.writeFileSync('/tmp/mcwpay.pid', String(srv.pid));
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (e) { /* 等待 */ }
    if (!up) await sleep(400);
  }
  ck('本地测试服务已就绪', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }

  console.log('\n[A] 账号与服务');
  let r = await call('u', 'POST', '/api/auth/register', { username: 'paytest', password: 'pass1234' });
  ck('注册成功', r.ok === true || r.user != null, r);
  r = await call('u', 'GET', '/api/pay/info');
  ck('支付信息可取（含档位）', r.ok && Array.isArray(r.packages) && r.packages.length >= 3, r.code);
  const pkg = (r.packages || []).find((p) => p.price > 0);

  console.log('\n[B] 备注必填（规范 六.3 / 八.10）');
  r = await call('u', 'POST', '/api/pay/submit', { packageId: pkg.id, method: 'wechat', ref4: '1234', note: '' });
  ck('空备注被拒绝', r.ok === false && /备注/.test(r.error || ''), r);
  r = await call('u', 'POST', '/api/pay/submit', { packageId: pkg.id, method: 'wechat', ref4: '', note: '测试备注' });
  ck('缺单号后 4 位被拒绝', r.ok === false && /单号/.test(r.error || ''), r);

  console.log('\n[C] 凭证格式与大小校验');
  r = await call('u', 'POST', '/api/pay/submit', { packageId: pkg.id, method: 'wechat', ref4: '1234', note: '凭证格式测试', proof: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' });
  ck('非 png/jpg/webp 凭证被拒绝', r.ok === false && /凭证/.test(r.error || ''), r.error);
  const big = 'data:image/png;base64,' + 'A'.repeat(3.7 * 1024 * 1024); // 解码后约 2.8MB：大于 2.5MB 限额、小于请求体 4MB 上限
  r = await call('u', 'POST', '/api/pay/submit', { packageId: pkg.id, method: 'wechat', ref4: '1234', note: '超大凭证测试', proof: big });
  ck('超过 2.5MB 的凭证被拒绝', r.ok === false && /2.5MB/.test(r.error || ''), r.error);

  console.log('\n[D] 正常提交（带凭证）');
  r = await call('u', 'POST', '/api/pay/submit', { packageId: pkg.id, method: 'wechat', ref4: '5678', note: 'paytest 开通一个月', proof: PNG });
  ck('提交成功并进入待审核', r.ok === true && r.status === 'pending', r);
  const rid = r.id;
  r = await call('u', 'GET', '/api/me/payments');
  const mine = (r.payments || []).find((p) => p.id === rid);
  ck('我的订单可见', !!mine, r.code);
  ck('订单记录了凭证地址', !!(mine && mine.proof && mine.proof.startsWith('/static/uploads/pay/')), mine && mine.proof);
  ck('订单记录了备注', !!(mine && /开通一个月/.test(mine.note || '')), mine && mine.note);
  const file = mine && mine.proof ? DATA + mine.proof.replace('/static/uploads', '/uploads') : null;
  ck('凭证文件已落盘', !!(file && fs.existsSync(file) && fs.statSync(file).size > 50), file);
  const img = await fetch(BASE + mine.proof);
  ck('凭证可通过静态地址访问', img.ok, img.status);
  ck('凭证响应为图片', /image\//.test(img.headers.get('content-type') || ''), img.headers.get('content-type'));

  console.log('\n[E] 权限：非管理员看不到审核接口');
  r = await call('u', 'GET', '/api/admin/payments');
  ck('首个注册用户即站长，可访问审核接口', r.code === 200, r.code);
  let r2 = await call('u2', 'POST', '/api/auth/register', { username: 'payuser2', password: 'pass1234' });
  ck('第二个注册用户为普通用户', r2.ok === true || r2.user != null, r2);
  r2 = await call('u2', 'GET', '/api/admin/payments');
  ck('普通用户访问审核接口被拒（403）', r2.code === 403, r2.code);
  r2 = await call('u2', 'GET', '/api/admin/avatars');
  ck('普通用户访问头像审核被拒（403）', r2.code === 403, r2.code);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  try { process.kill(Number(fs.readFileSync('/tmp/mcwpay.pid', 'utf8')), 'SIGTERM'); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
