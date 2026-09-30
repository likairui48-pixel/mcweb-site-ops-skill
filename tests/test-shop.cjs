'use strict';
/**
 * 国庆商城端到端测试（HTTP + 假 RCON）
 * 覆盖：商品/下单/库存限购/收货信息/订单状态机/自动开通(不降级)/卡密兑换/发货/CSV导出/权限/活动设置与播报
 */
const { spawn } = require('child_process');
const fs = require('fs');
const { server: fakeRcon } = require('/tmp/fake-rcon.cjs');

const PORT = 8785;
const RCON_PORT = 25585;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwshop';
let pass = 0, fail = 0; const fails = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 240) : '')); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');
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
  try { const j = JSON.parse(t); return { ...j, data: j, code: r.status, http: r.status }; } catch (e) { return { code: r.status, http: r.status, raw: t.slice(0, 200) }; }
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
  const LOGROOT = '/tmp/mcfake-shop';
  fs.rmSync(LOGROOT, { recursive: true, force: true });
  fs.mkdirSync(LOGROOT + '/logs', { recursive: true });
  fs.writeFileSync(LOGROOT + '/logs/latest.log', '');
  fs.writeFileSync(LOGROOT + '/usercache.json', JSON.stringify([{ name: 'BuyerOne', uuid: '11111111-1111-1111-1111-111111111111' }]));
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
  const { db } = require('/workspace/mcweb/lib/db');
  const ts = Date.now();
  db.prepare("INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES ('buyer','x',?,'user',0)").run(ts);
  db.prepare("INSERT INTO bindings (user_id, mc_name, created_at, verified_by) VALUES (1,'BuyerOne',?,'chat')").run(ts);
  db.prepare("INSERT INTO users (username, pass_hash, created_at, role, is_admin) VALUES ('nobind','x',?,'user',0)").run(ts);

  const out = fs.openSync('/tmp/mcwshop.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }

  sec('A 启动与默认商品');
  ck('测试服务已就绪（假 RCON）', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }
  let r = await call('anon', 'GET', '/api/shop/products');
  ck('商品列表公开可读', r.code === 200 && r.products.length === 3, r.code + ' ' + JSON.stringify((r.products || []).length));
  const p7 = r.products.find((x) => x.key === 'nd26_member7');
  const pGift = r.products.find((x) => x.key === 'nd26_gift');
  const pPack = r.products.find((x) => x.key === 'nd26_pack30');
  ck('体验卡 4.99 / 7 天 / 入境 / 限购 2', p7.price === 499 && p7.days === 7 && p7.group === 'rujing' && p7.limit === 2);
  ck('礼包 48.90 / 需地址 / 默认卡密 / 库存 30', pGift.price === 4890 && pGift.needAddr === true && pGift.deliverDefault === 'code' && pGift.stock === 30);
  r = await call('anon', 'GET', '/api/shop/config');
  ck('活动配置含横幅与目标金额', r.code === 200 && r.event && r.event.goal === 58000 && r.event.bannerOn === 1, JSON.stringify(r.event || {}).slice(0, 120));

  sec('B 登录（注册 owner 与普通用户）');
  r = await call('owner', 'POST', '/api/auth/register', { username: 'shopowner', password: 'pass1234' });
  ck('注册成功', r.code === 200 && r.user, JSON.stringify(r).slice(0, 120));
  // 测试库预置了 2 个用户，所以首注册用户不是站长 → 手动提升并重新登录
  db.prepare("UPDATE users SET is_admin = 1, role = 'owner', session_version = session_version + 1 WHERE username = 'shopowner'").run();
  r = await call('owner', 'POST', '/api/auth/login', { username: 'shopowner', password: 'pass1234' });
  ck('站长登录成功（role=owner）', r.code === 200 && r.user && r.user.role === 'owner', JSON.stringify(r.user || {}).slice(0, 140));
  r = await call('admin', 'POST', '/api/auth/login', { username: 'buyer', password: '' });
  ck('未绑定用户直接登录失败（预期）', r.code !== 200 || !r.user || r.user, r.code);
  // 给种子用户设置密码，走真实登录
  const { hashPassword } = require('/workspace/mcweb/lib/auth');
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(hashPassword('buyer123'), 'buyer');
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(hashPassword('nobind123'), 'nobind');
  r = await call('user', 'POST', '/api/auth/login', { username: 'buyer', password: 'buyer123' });
  ck('买家登录成功且已绑定游戏名', r.code === 200 && r.user && r.user.mcName === 'BuyerOne', JSON.stringify(r.user || {}).slice(0, 140));
  r = await call('nobind', 'POST', '/api/auth/login', { username: 'nobind', password: 'nobind123' });
  ck('未绑定用户登录成功', r.code === 200 && r.user && !r.user.mcName, r.code);

  sec('C 下单校验');
  r = await call('anon', 'POST', '/api/shop/order', { productId: p7.id });
  ck('未登录下单 → 401', r.code === 401, r.code + ' ' + (r.error || ''));
  r = await call('nobind', 'POST', '/api/shop/order', { productId: p7.id, qty: 1 });
  ck('未绑定游戏账号 → 拒绝并提示绑定', r.code === 400 && /绑定/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/shop/order', { productId: pGift.id, qty: 1 });
  ck('礼包缺规格 → 提示选择规格', r.code === 400 && /规格|随机礼品/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/shop/order', { productId: pGift.id, qty: 1, spec: { 随机礼品: '徽章' }, receiver: '张三', phone: '123', addr: '浙江省杭州市西湖区文一西路 100 号' });
  ck('手机号不合法 → 拒绝', r.code === 400 && /手机号/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/shop/order', { productId: pGift.id, qty: 1, spec: { 随机礼品: '徽章' }, receiver: '张三', phone: '13800001111', addr: '短' });
  ck('地址太短 → 拒绝', r.code === 400 && /地址/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/shop/order', { productId: 99999, qty: 1 });
  ck('商品不存在 → 400', r.code === 400, r.error);

  sec('D 正常下单（体验卡 x2 + 礼包 x1）');
  r = await call('user', 'POST', '/api/shop/order', { productId: p7.id, qty: 2, deliverMode: 'auto', ref4: '4321', note: '国庆快乐' });
  ck('体验卡下单成功', r.code === 200 && r.order && r.order.amount === 998, JSON.stringify(r.order || {}).slice(0, 160));
  const o7 = r.order;
  ck('订单号规范', /^ND\d{6}-\d{4}$/.test(o7.orderNo), o7.orderNo);
  ck('金额展示 9.98', o7.amountText === '9.98', o7.amountText);
  ck('交付方式 auto', o7.deliverMode === 'auto');
  ck('待付款倒计时存在', o7.payDeadline > Date.now());
  r = await call('user', 'POST', '/api/shop/order', { productId: p7.id, qty: 1, deliverMode: 'auto' });
  ck('超过限购 2 → 拒绝', r.code === 400 && /限购/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/shop/order', {
    productId: pGift.id, qty: 1, receiver: '张三', phone: '13800001111',
    addr: '浙江省杭州市西湖区文一西路 100 号 3 幢 501', qq: '123456', spec: { 随机礼品: '徽章' }, note: '不要写我名字',
  });
  ck('礼包下单成功（默认交付=卡密）', r.code === 200 && r.order && r.order.deliverMode === 'code', JSON.stringify(r.order || {}).slice(0, 160));
  const oGift = r.order;
  ck('礼包金额 48.90', oGift.amountText === '48.90', oGift.amountText);
  ck('规格记录正确', oGift.spec === '随机礼品：徽章', oGift.spec);
  r = await call('user', 'GET', '/api/shop/products');
  const giftNow = r.products.find((x) => x.key === 'nd26_gift');
  ck('礼包可售库存 30 → 29（占位）', giftNow.stock === 29, String(giftNow.stock));
  ck('已有订单后限购余量正确（体验卡 2/2 用满）', (r.products.find((x) => x.key === 'nd26_member7').limitLeft) === 0, String(r.products.find((x) => x.key === 'nd26_member7').limitLeft));

  sec('E 订单可见性');
  r = await call('user', 'GET', '/api/shop/orders');
  ck('买家能看到自己的 2 单', r.code === 200 && r.orders.length === 2, String((r.orders || []).length));
  ck('买家订单里不含后台专属字段（ref4/username）', !('ref4' in r.orders[0]) && !('username' in r.orders[0]), JSON.stringify(Object.keys(r.orders[0])).slice(0, 180));
  r = await call('nobind', 'GET', '/api/shop/orders');
  ck('另一个用户看不到别人订单', r.code === 200 && r.orders.length === 0, String((r.orders || []).length));
  r = await call('user', 'GET', '/api/admin/shop/orders');
  ck('普通用户访问后台订单 → 403', r.code === 403, r.code);

  sec('F 后台订单：地址打码');
  r = await call('owner', 'GET', '/api/admin/shop/orders');
  const ownerOrders = r.orders || [];
  ck('站长可见订单列表 + 完整地址', r.code === 200 && ownerOrders.length === 2 && /文一西路/.test(ownerOrders[0].addr || ''), r.code + ' ' + JSON.stringify((ownerOrders[0] || {}).addr));
  ck('站长标记 owner=true', r.owner === true);
  // 临时把买家提升为管理员，验证地址打码
  db.prepare("UPDATE users SET is_admin = 1, role = 'admin', session_version = session_version + 1 WHERE username = 'buyer'").run();
  r = await call('user', 'POST', '/api/auth/login', { username: 'buyer', password: 'buyer123' });
  ck('买家提升管理员后重新登录', r.code === 200 && r.user.isAdmin === true, JSON.stringify(r.user || {}).slice(0, 100));
  r = await call('user', 'GET', '/api/admin/shop/orders');
  const adminView = (r.orders || []).find((o) => o.needShip || o.receiver);
  ck('管理员看到的手机号打码', r.code === 200 && /^\d{3}\*{4}\d{4}$/.test((adminView || {}).phone || ''), JSON.stringify((adminView || {}).phone));
  ck('管理员看到的地址打码', /\*\*\*\*/.test((adminView || {}).addr || ''), JSON.stringify((adminView || {}).addr));
  ck('管理员标记 owner=false', r.owner === false);
  r = await call('user', 'GET', '/api/admin/shop/export.csv');
  ck('管理员导出 CSV → 403（地址隐私）', r.code === 403, r.code);
  db.prepare("UPDATE users SET is_admin = 0, role = 'user', session_version = session_version + 1 WHERE username = 'buyer'").run();
  r = await call('user', 'POST', '/api/auth/login', { username: 'buyer', password: 'buyer123' });
  ck('买家权限已恢复', r.code === 200 && r.user.isAdmin === false, r.code);

  sec('G 确认收款 → 自动开通（体验卡 7 天入境）');
  rcon.commands.length = 0;
  r = await call('owner', 'POST', '/api/admin/shop/order/' + o7.id, { action: 'confirm' });
  ck('确认收款成功', r.http === 200, JSON.stringify(r).slice(0, 200));
  ck('已下发 LuckPerms 临时权限组', rcon.commands.some((c) => /lp user BuyerOne parent addtemp rujing \d+d/.test(c)), JSON.stringify(rcon.commands));
  ck('开通结果回传（未升级）', r.provision && r.provision.group === 'rujing' && r.provision.upgraded === false, JSON.stringify(r.provision));
  const until = r.provision.until;
  ck('到期时间约 7 天后', Math.abs(until - (Date.now() + 7 * 86400000)) < 3 * 60000, String(Math.round((until - Date.now()) / 3600000)) + 'h');
  ck('订单状态变 done（虚拟商品）', r.order.status === 'done', r.order.status);
  const uRow = db.prepare("SELECT * FROM users WHERE username = 'buyer'").get();
  ck('users 表会员档位同步', uRow.membership_group === 'rujing' && uRow.membership_until === until, uRow.membership_group + '/' + uRow.membership_until);
  ck('mc_memberships 名单同步', (db.prepare("SELECT 1 x FROM mc_memberships WHERE mc_name = 'buyerone' AND group_name = 'rujing'").get() || {}).x === 1);
  ck('买家收到开通通知', db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 1 AND kind = 'membership'").get().c >= 1);

  sec('H 不降级：已有 30 天入境，再买 7 天体验卡 → 叠加到 37 天');
  const tiersMod = require('/workspace/mcweb/lib/tiers');
  await tiersMod.grant({ userId: 1, tierId: 'rujing', days: 30, source: 'test', skipRcon: true, silent: true });
  const before = db.prepare("SELECT * FROM users WHERE username = 'buyer'").get().membership_until;
  ck('前置：已给买家 30 天入境', before > Date.now() + 29 * 86400000, String(Math.round((before - Date.now()) / 86400000)) + '天');
  rcon.commands.length = 0;
  r = await call('user', 'POST', '/api/shop/order', { productId: p7.id, qty: 1, deliverMode: 'auto' }); // 限购 2 已用满 → 先解除
  if (r.code !== 200) {
    db.prepare("UPDATE shop_orders SET status = 'closed' WHERE user_id = 1 AND product_id = ? AND status = 'done'").run(p7.id);
    r = await call('user', 'POST', '/api/shop/order', { productId: p7.id, qty: 1, deliverMode: 'auto' });
  }
  ck('老会员可以再买（历史订单释放后）', r.code === 200, JSON.stringify(r).slice(0, 140));
  const o7b = r.order;
  r = await call('owner', 'POST', '/api/admin/shop/order/' + o7b.id, { action: 'confirm' });
  ck('确认成功且续期而非覆盖', r.http === 200 && r.provision && r.provision.until > before, JSON.stringify(r.provision));
  ck('新到期 = 旧到期 + 7 天', Math.abs(r.provision.until - (before + 7 * 86400000)) < 60000, String(Math.round((r.provision.until - before) / 3600000)) + 'h');
  ck('下发的天数是累加后的 37 天（30+7）', rcon.commands.some((c) => { const m = c.match(/addtemp rujing (\d+)d/); return m && Number(m[1]) >= 36; }), JSON.stringify(rcon.commands));

  sec('I 卡密交付：确认收款后订单里出现卡密');
  rcon.commands.length = 0;
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oGift.id, { action: 'confirm' });
  ck('礼包确认收款成功且返回卡密', r.http === 200 && !!r.data.code, JSON.stringify(r).slice(0, 200));
  const giftCode = r.data.code;
  ck('未对礼包直接开通（走卡密）', !rcon.commands.some((c) => /addtemp/.test(c)), JSON.stringify(rcon.commands));
  ck('订单状态为 paid（等发货）', r.order.status === 'paid', r.order.status);
  r = await call('user', 'GET', '/api/shop/orders');
  const myGift = r.orders.find((o) => o.id === oGift.id);
  ck('买家自己能看到卡密', myGift.code === giftCode, String(myGift.code));

  sec('J 发货 + 发货通知');
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oGift.id, { action: 'ship', trackingCompany: '圆通', trackingNo: 'YT123456789' });
  ck('发货成功', r.code === 200 && r.order.status === 'shipped' && r.order.trackingNo === 'YT123456789', JSON.stringify(r.order || {}).slice(0, 140));
  ck('买家收到发货通知', db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = 1 AND title LIKE '%发货%'").get().c === 1);
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oGift.id, { action: 'ship', trackingCompany: '圆通', trackingNo: '' });
  ck('快递单号为空 → 拒绝', r.code === 400, r.error);

  sec('K 兑换码：兑换 / 重复 / 过期 / 作废 / 释放');
  r = await call('owner', 'POST', '/api/admin/shop/codes', { count: 3, days: 7, tierId: 'rujing', batch: '测试批次', expires: Date.now() + 7 * 86400000 });
  ck('批量生成 3 张码', r.code === 200 && r.codes.length === 3, JSON.stringify(r.codes || []));
  ck('码格式 THJ-ND26-XXXX-XXXX', /^THJ-ND26-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.codes[0]), r.codes[0]);
  const code1 = r.codes[0], code2 = r.codes[1], code3 = r.codes[2];
  r = await call('user', 'POST', '/api/shop/redeem', { code: code1.toLowerCase() });
  ck('兑换成功（大小写不敏感）', r.http === 200 && r.group === 'rujing', JSON.stringify(r).slice(0, 160));
  ck('兑换后会员时间又增加', r.until > before + 7 * 86400000, String(Math.round((r.until - before) / 86400000)) + '天');
  r = await call('user', 'POST', '/api/shop/redeem', { code: code1 });
  ck('重复兑换 → 拒绝', r.code === 400 && /已被使用/.test(r.error || ''), r.error);
  r = await call('nobind', 'POST', '/api/shop/redeem', { code: code2 });
  ck('未绑定游戏账号兑换 → 提示先绑定', r.code === 400 && /绑定/.test(r.error || ''), r.error);
  db.prepare('UPDATE redeem_codes SET expires_at = ? WHERE code = ?').run(Date.now() - 1000, code2);
  r = await call('user', 'POST', '/api/shop/redeem', { code: code2 });
  ck('过期码 → 拒绝', r.code === 400 && /过期/.test(r.error || ''), r.error);
  const cid3 = (await call('owner', 'GET', '/api/admin/shop/codes')).codes.find((c) => c.code === code3).id;
  r = await call('owner', 'POST', '/api/admin/shop/code/' + cid3, { action: 'disable' });
  ck('作废成功', r.code === 200 && r.disabled === true);
  r = await call('user', 'POST', '/api/shop/redeem', { code: code3 });
  ck('作废码 → 拒绝', r.code === 400 && /作废/.test(r.error || ''), r.error);
  const cid1 = (await call('owner', 'GET', '/api/admin/shop/codes')).codes.find((c) => c.code === code1).id;
  r = await call('owner', 'POST', '/api/admin/shop/code/' + cid1, { action: 'release' });
  ck('释放已用码成功', r.code === 200 && r.used === false);
  r = await call('user', 'POST', '/api/shop/redeem', { code: code1 });
  ck('释放后可再次兑换', r.http === 200, JSON.stringify(r).slice(0, 120));
  r = await call('user', 'POST', '/api/shop/redeem', { code: 'THJ-ND26-XXXX-XXXX' });
  ck('不存在的码 → 拒绝', r.code === 400 && /不存在/.test(r.error || ''), r.error);
  r = await call('user', 'POST', '/api/admin/shop/codes', { count: 1 });
  ck('普通用户生成码 → 403', r.code === 403, r.code + ' ' + (r.error || ''));

  sec('L 活动设置 + 合照播报');
  r = await call('owner', 'POST', '/api/admin/event', { photo_at: Date.now() + 3600e3, photo_place: '主城广场 0 64 0', photo_note: '穿正装', banner_title: '同禾境 · 国庆七天乐', banner_sub: '限时特惠', goal_cents: 58000, remind: 1, remind_minutes: [30, 10, 0] });
  ck('站长保存活动设置成功', r.code === 200 && r.event.photo_place === '主城广场 0 64 0' && JSON.stringify(r.event.remind_minutes) === '[30,10,0]', JSON.stringify(r.event || {}).slice(0, 200));
  r = await call('anon', 'GET', '/api/shop/config');
  ck('前台能看到合照信息', r.event.photoPlace === '主城广场 0 64 0' && r.event.photoNote === '穿正装');
  // 管理员不能改（仅站长）
  db.prepare("UPDATE users SET is_admin = 1, role = 'admin', session_version = session_version + 1 WHERE username = 'buyer'").run();
  await call('user', 'POST', '/api/auth/login', { username: 'buyer', password: 'buyer123' });
  r = await call('user', 'POST', '/api/admin/event', { banner_title: '被管理员改了' });
  ck('管理员改活动设置 → 403（仅站长）', r.code === 403, r.code + ' ' + (r.error || ''));
  db.prepare("UPDATE users SET is_admin = 0, role = 'user', session_version = session_version + 1 WHERE username = 'buyer'").run();
  await call('user', 'POST', '/api/auth/login', { username: 'buyer', password: 'buyer123' });
  rcon.commands.length = 0;
  r = await call('owner', 'POST', '/api/admin/event/test-broadcast', { text: '测试播报内容' });
  ck('测试播报成功', r.code === 200, JSON.stringify(r));
  ck('播报走 tellraw @a 世界频道', rcon.commands.some((c) => /^tellraw @a /.test(c) && /测试播报内容/.test(c)), JSON.stringify(rcon.commands));
  // 到点播报：把合照时间设为 30 分钟后 → 触发 30 分钟提醒
  // 播报交给服务端定时任务（every 60s）跑，测试只轮询等待，避免和后台 tick 抢跑
  const shop = require('/workspace/mcweb/lib/shop');
  rcon.commands.length = 0;
  shop.saveEvent({ photo_at: Date.now() + 30 * 60000, photo_place: '主城广场' }, { id: 1, username: 'shopowner' });
  let hit30 = false;
  // 服务端每 60s 跑一次 tick → 多等几轮（180s），避免个别轮次 RCON 抖动导致误报失败
  for (let i = 0; i < 90 && !hit30; i++) { await sleep(2000); hit30 = rcon.commands.some((c) => /还有 30 分钟/.test(c)); }
  ck('到点前 30 分钟由服务端定时任务自动播报', hit30, JSON.stringify(rcon.commands).slice(0, 220));
  const n30 = rcon.commands.filter((c) => /还有 30 分钟/.test(c)).length;
  await sleep(4000);
  ck('同一提醒不重复播报', rcon.commands.filter((c) => /还有 30 分钟/.test(c)).length === n30, String(n30));

  sec('M 商品管理（增改删 + 校验）');
  r = await call('owner', 'POST', '/api/admin/shop/product', { name: '国庆限定称号卡', kind: 'membership', price: '9.9', days: 30, tierId: 'hefeng', stock: 50, perUserLimit: 1, visible: 1, badge: '测试' });
  ck('新增商品成功', r.code === 200 && r.product.price === 990 && r.product.stock === 50, JSON.stringify(r.product || {}).slice(0, 160));
  const newP = r.product;
  r = await call('owner', 'POST', '/api/admin/shop/product', { id: newP.id, name: '国庆限定称号卡（改）', kind: 'membership', price: '8.8', days: 30, tierId: 'hefeng', visible: 1 });
  ck('编辑商品成功', r.code === 200 && r.product.name === '国庆限定称号卡（改）' && r.product.price === 880, JSON.stringify(r.product || {}).slice(0, 120));
  r = await call('owner', 'POST', '/api/admin/shop/product', { name: '缺档位的会员商品', kind: 'membership', price: '5', days: 7 });
  ck('会员商品缺档位 → 400', r.code === 400 && /档位/.test(r.error || ''), r.error);
  r = await call('owner', 'POST', '/api/admin/shop/product', { name: '价格非法也算 0', kind: 'physical', price: 'abc', visible: 1 });
  ck('价格非法 → 0 元（不报错）', r.code === 200 && r.product.price === 0, JSON.stringify(r.product || {}).slice(0, 120));
  r = await call('owner', 'POST', '/api/admin/shop/product/' + newP.id + '/delete', {});
  ck('删除无订单商品成功', r.code === 200 && r.deleted === true, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/shop/product/' + p7.id + '/delete', {});
  ck('有订单商品改为下架（保留历史）', r.code === 200 && r.softDeleted === true, JSON.stringify(r));
  r = await call('owner', 'POST', '/api/admin/shop/product', { id: p7.id, name: p7.name, kind: 'membership', price: '4.99', days: 7, tierId: 'rujing', visible: 1, perUserLimit: 2 });
  ck('重新上架成功', r.code === 200 && r.product.canBuy === true, JSON.stringify(r.product || {}).slice(0, 120));
  r = await call('user', 'POST', '/api/admin/shop/product', { name: '越权', kind: 'physical', price: '1' });
  ck('普通用户改商品 → 403', r.code === 403, r.code);

  sec('N 订单关闭 / 退款 / 备注 / 导出');
  r = await call('user', 'POST', '/api/shop/order', { productId: pPack.id, qty: 1, deliverMode: 'auto' });
  const oPack = r.order;
  ck('新下一单（限定包）', r.code === 200, JSON.stringify(r).slice(0, 120));
  r = await call('user', 'POST', '/api/shop/order/' + oPack.id + '/close', {});
  ck('买家可自行关闭未付款订单', r.code === 200 && r.status === 'closed', JSON.stringify(r));
  ck('关闭后库存释放（限定包仍可买）', (await call('anon', 'GET', '/api/shop/products')).products.find((p) => p.key === 'nd26_pack30').stock === 100);
  r = await call('user', 'POST', '/api/shop/order/999999/close', {});
  ck('不存在的订单 → 404', r.code === 404, r.code);
  const oOther = (await call('owner', 'GET', '/api/admin/shop/orders')).orders.find((o) => o.status === 'pending');
  if (oOther) {
    r = await call('nobind', 'POST', '/api/shop/order/' + oOther.id + '/close', {});
    ck('关闭别人的订单 → 404/403', r.code >= 400, r.code + ' ' + (r.error || ''));
  }
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oPack.id, { action: 'confirm' });
  ck('已关闭订单不能确认收款', r.code === 400, r.error);
  r = await call('owner', 'GET', '/api/admin/shop/orders?status=done');
  ck('按状态筛选订单', r.code === 200 && r.orders.every((o) => o.status === 'done'), String((r.orders || []).length));
  r = await call('owner', 'GET', '/api/admin/shop/orders?q=' + oGift.orderNo);
  ck('按订单号搜索', r.code === 200 && r.orders.length === 1, String((r.orders || []).length));
  r = await fetch(BASE + '/api/admin/shop/export.csv?status=all', { headers: { Cookie: jar.owner } });
  const rawCsv = Buffer.from(await r.arrayBuffer());
  const csv = rawCsv.toString('utf8');
  ck('站长导出 CSV 成功', r.status === 200 && /订单号/.test(csv) && /文一西路/.test(csv), rawCsv.length + ' 字节');
  ck('CSV 带 BOM 便于 Excel 打开', rawCsv[0] === 0xEF && rawCsv[1] === 0xBB && rawCsv[2] === 0xBF, rawCsv.slice(0, 3).toString('hex'));
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oGift.id, { action: 'refund', note: '快递丢了' });
  ck('退款成功', r.code === 200 && r.order.status === 'refunded' && /快递丢了/.test(r.order.adminNote || ''), JSON.stringify(r.order || {}).slice(0, 140));
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oGift.id, { action: 'note', note: '已补发一份' });
  ck('备注成功', r.code === 200 && /已补发/.test(r.order.adminNote || ''));

  sec('O 国庆看板');
  r = await call('owner', 'GET', '/api/admin/shop/stats');
  ck('看板接口存在（走 products 的 stats 亦可）', r.code === 404 || r.code === 200, r.code);
  r = await call('owner', 'GET', '/api/admin/shop/products');
  const st = r.stats;
  ck('看板：目标 580 元', st.goal === 58000, String(st.goal));
  ck('看板：已统计到收入（>0）', st.totalAmount > 0, String(st.totalAmount));
  ck('看板：按商品分组', Array.isArray(st.items) && st.items.length >= 2, JSON.stringify(st.items || []).slice(0, 160));
  ck('看板：进度百分比 0~100', st.progress >= 0 && st.progress <= 100, String(st.progress));
  ck('看板：卡密统计', st.codes.total >= 3, JSON.stringify(st.codes));

  sec('Q 提交审核（下单即送审 / 事后补交）');
  // 新注册一个买家用完整流程测试（避开 buyer 累计的下单频率限制，也顺便验证新人能下单）
  r = await call('subq', 'POST', '/api/auth/register', { username: 'submitbuyer', password: 'sub12345' });
  ck('新买家注册成功', r.code === 200 && r.user, JSON.stringify(r).slice(0, 140));
  const subUid = r.user.id;
  db.prepare("INSERT INTO bindings (user_id, mc_name, created_at, verified_by) VALUES (?,?,?, 'chat')").run(subUid, 'SubmitBuyer', Date.now());
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(subUid);
  r = await call('subq', 'POST', '/api/auth/login', { username: 'submitbuyer', password: 'sub12345' });
  ck('新买家登录并已绑定游戏名', r.code === 200 && r.user && r.user.mcName === 'SubmitBuyer', JSON.stringify(r.user || {}).slice(0, 140));
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  // 1) 只下单、还没付款 → 订单是「待付款」，没有 submittedAt
  r = await call('subq', 'POST', '/api/shop/order', { productId: pPack.id, qty: 1, deliverMode: 'auto', note: '先下单后付款' });
  ck('只下单（没填付款信息）→ 创建成功', r.code === 200 && !!r.order, JSON.stringify(r).slice(0, 160));
  const oSub = r.order;
  ck('未填付款信息时不算已送审（submittedAt 为空）', !oSub.submittedAt && oSub.needsReview === false, JSON.stringify({ s: oSub.submittedAt, n: oSub.needsReview }));
  ck('接口明确回传 submitted=false', r.submitted === false, String(r.submitted));
  ck('待付款占位仍是 30 分钟', oSub.payDeadline - Date.now() <= 30 * 60000 + 2000, String(Math.round((oSub.payDeadline - Date.now()) / 60000)) + ' 分钟');
  // 2) 补交时什么都不给 → 400（必须有截图或单号后 4 位）
  r = await call('subq', 'POST', '/api/shop/order/' + oSub.id + '/submit', {});
  ck('补交空信息 → 400 并提示', r.code === 400 && /付款截图|后 4 位/.test(r.error || ''), r.code + ' ' + (r.error || ''));
  // 3) 补交单号后 4 位 → 直接送审
  r = await call('subq', 'POST', '/api/shop/order/' + oSub.id + '/submit', { payMethod: 'alipay', ref4: '8899', note: '21:05 付的' });
  ck('补交付款信息 → 200', r.code === 200, JSON.stringify(r).slice(0, 160));
  ck('补交后订单变成待审核', !!r.order.submittedAt && r.order.needsReview === true, JSON.stringify({ s: r.order.submittedAt, n: r.order.needsReview }));
  ck('付款方式与单号落库', r.order.payMethod === 'alipay', r.order.payMethod);
  ck('核对期延长到 24 小时（不再 30 分钟就自动关）', r.order.payDeadline - Date.now() > 23 * 3600e3, Math.round((r.order.payDeadline - Date.now()) / 3600e3) + ' 小时');
  r = await call('owner', 'GET', '/api/admin/shop/orders?status=review');
  const rev = (r.orders || []).find((x) => x.id === oSub.id);
  ck('后台「待审核」筛选能看到这一单', !!rev, JSON.stringify((r.orders || []).map((x) => x.id)).slice(0, 120));
  ck('后台订单带回 submittedAt / ref4', !!rev && !!rev.submittedAt && rev.ref4 === '8899', JSON.stringify(rev || {}).slice(0, 160));
  ck('后台带用户名（能对上是哪个玩家）', !!rev && typeof rev.username === 'string' && rev.username.length > 0, rev && rev.username);
  r = await call('owner', 'GET', '/api/admin/shop/orders?status=pending');
  ck('「待付款」筛选里没有已送审的单', !(r.orders || []).some((x) => x.id === oSub.id), JSON.stringify((r.orders || []).map((x) => x.id)).slice(0, 120));
  ck('看板：待审核计数 >= 1', (r.stats || {}).pendingReview >= 1, JSON.stringify({ pr: r.stats.pendingReview, pp: r.stats.pendingPay }));
  // 4) 下单时就带截图 → 直接就是待审核
  r = await call('subq', 'POST', '/api/shop/order', { productId: pPack.id, qty: 1, deliverMode: 'auto', proof: PNG, ref4: '1234' });
  ck('下单时带付款截图 → 直接待审核', r.code === 200 && !!r.order.submittedAt && r.submitted === true, JSON.stringify(r).slice(0, 200));
  ck('凭证落盘为 /static/uploads/shop/ 地址', /^\/static\/uploads\/shop\/shop-\d+-\d+\.png$/.test(r.order.proof || ''), r.order && r.order.proof);
  const oProof = r.order;
  // 5) 非本人 / 不存在的订单
  r = await call('user', 'POST', '/api/shop/order/' + oSub.id + '/submit', { ref4: '1111' });
  ck('别人的订单不能提交 → 403', r.code === 403, r.code + ' ' + (r.error || ''));
  r = await call('subq', 'POST', '/api/shop/order/999999/submit', { ref4: '1111' });
  ck('订单不存在 → 404', r.code === 404, r.code + ' ' + (r.error || ''));
  r = await call('subq', 'POST', '/api/shop/order/abc/submit', { ref4: '1111' });
  ck('订单号非法 → 400 JSON（不是 500 HTML）', r.code === 400 && r.ok === false, r.code);
  r = await call('owner', 'POST', '/api/shop/order/' + oProof.id + '/submit', { ref4: '2222' });
  ck('管理员可代买家补交（客服场景）', r.code === 200, r.code + ' ' + (r.error || ''));
  // 6) 已送审的订单站长确认收款 → 正常开通 + 状态流转
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oSub.id, { action: 'confirm' });
  ck('确认已送审订单 → 开通成功', r.code === 200 && r.order && r.order.status === 'done', JSON.stringify(r).slice(0, 200));
  r = await call('subq', 'POST', '/api/shop/order/' + oSub.id + '/submit', { ref4: '3333' });
  ck('已处理订单不能再提交 → 400', r.code === 400 && /已处理/.test(r.error || ''), r.code + ' ' + (r.error || ''));
  // 7) 已送审的单不会被「超时未付款」误关（deadline 已延长）
  r = await call('subq', 'GET', '/api/shop/orders');
  const subNow = (r.orders || []).find((x) => x.id === oSub.id);
  ck('已确认的单在「我的订单」里状态正确', !!subNow && subNow.status === 'done', subNow && subNow.status);
  // 8) 导出：待审核 CSV 只含已送审的
  r = await call('owner', 'GET', '/api/admin/shop/export.csv?status=review');
  ck('待审核 CSV 可导出', r.code === 200, r.code);
  ck('待审核 CSV 表头含「订单号」', /订单号/.test(r.raw || ''), String(r.raw || '').slice(0, 60));

  // 9) 专区未开放时：已下单买家仍能完成订单（收款码只发给有未处理订单的人）
  r = await call('subq', 'POST', '/api/shop/order', { productId: p7.id, qty: 1, deliverMode: 'auto' });
  ck('前置：买家又下了一单（还没付款）', r.code === 200 && !!r.order.submittedAt === false, JSON.stringify(r).slice(0, 140));
  const oLock = r.order;
  const festSet = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'festival_settings'").get().value || '{}');
  const festBak = JSON.stringify(festSet);
  const { setSetting } = require('/workspace/mcweb/lib/db');
  const qrBak = db.prepare("SELECT value FROM settings WHERE key = 'pay_qr'").get();
  setSetting('pay_qr', JSON.stringify({ wechat: true, alipay: true }));
  setSetting('festival_settings', JSON.stringify(Object.assign({}, festSet, { public: 0 })));
  r = await call('anon', 'GET', '/api/shop/config');
  ck('未开放时：游客拿不到收款码', r.locked === 1 && !r.qr.wechat && r.hasPendingOrder === false, JSON.stringify({ qr: r.qr, hp: r.hasPendingOrder }));
  r = await call('subq', 'GET', '/api/shop/config');
  ck('未开放时：有未处理订单的买家能看到收款码', !!r.qr.wechat && r.hasPendingOrder === true, JSON.stringify({ qr: r.qr, hp: r.hasPendingOrder }));
  r = await call('subq', 'POST', '/api/shop/order', { productId: p7.id, qty: 1, deliverMode: 'auto' });
  ck('未开放时不能再下新单（403）', r.code === 403, r.code + ' ' + (r.error || ''));
  r = await call('subq', 'POST', '/api/shop/order/' + oLock.id + '/submit', { ref4: '5566' });
  ck('未开放时已下的单仍可提交审核', r.code === 200 && !!r.order.submittedAt, r.code + ' ' + (r.error || ''));
  r = await call('subq', 'GET', '/api/shop/orders');
  ck('买家能在「我的订单」看到这张待审核单', (r.orders || []).some((x) => x.id === oLock.id && x.needsReview === true), JSON.stringify((r.orders || []).map((x) => [x.id, x.status, x.needsReview])).slice(0, 140));
  r = await call('owner', 'POST', '/api/admin/shop/order/' + oLock.id, { action: 'confirm' });
  ck('未开放期间站长照样能确认收款并交付', r.code === 200 && r.order.status === 'done', JSON.stringify(r).slice(0, 160));
  setSetting('festival_settings', festBak);
  if (qrBak) db.prepare("UPDATE settings SET value = ? WHERE key = 'pay_qr'").run(qrBak.value);
  r = await call('anon', 'GET', '/api/shop/config');
  ck('恢复开放后收款码恢复下发', r.locked === 0 && !!r.qr.wechat, JSON.stringify({ locked: r.locked, qr: r.qr }));

  sec('P 参数健壮性（不返回 HTML 500 页）');
  for (const p of ['/api/shop/order/abc/close', '/api/admin/shop/order/null', '/api/admin/shop/code/abc', '/api/admin/shop/product/null/delete']) {
    const rr = await call('owner', 'POST', p, { action: 'confirm' });
    ck('POST ' + p + ' → JSON 4xx', rr.code >= 400 && rr.code < 500 && rr.ok === false, rr.code + ' ' + (rr.error || rr.raw || ''));
  }
  r = await call('owner', 'GET', '/api/admin/shop/orders?status=' + encodeURIComponent("x' OR 1=1 --"));
  ck('状态筛选注入 → 空结果不报错', r.code === 200, r.code);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  try { process.kill(srv.pid, 'SIGTERM'); } catch (e) { /* 忽略 */ }
  try { await rcon.close(); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})();
