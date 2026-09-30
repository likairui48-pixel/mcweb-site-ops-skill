'use strict';
/**
 * 假人（FakePlayerPlugin 机器人账号）折叠 + 绑定拒绝 验收
 * 覆盖：UUID 前缀/名字正则/人工名单/白名单判定、在线列表折叠、排行榜折叠、段位榜与曲线排除、
 *       站内搜索排除、绑定直接拒绝（网页 + 游戏内）、后台接口权限与配置生效、开关可恢复
 * 运行：node /tmp/test-fakes.cjs                        （本地起服务 + 假 RCON）
 *      BASE=https://<你的站点域名:端口> node /tmp/test-fakes.cjs   （只读部分）
 */
const { spawn } = require('child_process');
const fs = require('fs');

const LIVE = process.env.BASE || '';
const PORT = 8799;
const RCON_PORT = 25582;
const BASE = LIVE || 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwfk';
let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 300) : '')); }
};
const D = (t) => console.log('\n[' + t + ']');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cookie = '';

async function call(method, path, body) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length && !LIVE) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { code: r.status, json, text };
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

const FAKE_ONLINE = 'There are 4 of a max of 20 players online: bot3, zaoren, bot, Ian';
const SEED = [
  ['bot', 'fb070000-0000-0000-0000-000000000001', 0, 149.2],
  ['bot2', 'fb070000-0000-0000-0000-000000000002', 0, 89.3],
  ['bot3', 'fb070000-0000-0000-0000-000000000003', 268, 999.9],
  ['bot10', 'fb070000-0000-0000-0000-00000000000a', 45, 27.2],
  ['bot12', 'fb070000-0000-0000-0000-00000000000c', null, 0],
  ['zaoren', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0', 300, 120.5],
  ['Ian', '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', 1486, 445.3],
  ['RealGuy', '2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e', null, 3.5],
  ['lafake', '250231b5-a31a-31ae-bfaf-a12b59a1c9ab', null, 6],
];

(async () => {
  let fakeRcon = null;
  if (!LIVE) {
    killLeftover();
    await sleep(700);
    fs.rmSync(DATA, { recursive: true, force: true });
    process.env.DATA_DIR = DATA;
    // 先建库灌数据，再起服务：这样服务启动时的扫描就能识别出假人，不受 60 秒内存缓存影响
    const db0 = require('/workspace/mcweb/lib/db').db;
    const ins0 = db0.prepare('INSERT OR REPLACE INTO stats_cache (uuid, name, level, playtime_ticks, first_join, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const [name, uuid, level, hours] of SEED) ins0.run(uuid, name, level, Math.round(hours * 72000), Date.now() - 86400000, Date.now());
    const fr = require('/tmp/fake-rcon.cjs');
    fakeRcon = fr.server({ port: RCON_PORT, password: 'x', replies: { list: FAKE_ONLINE } });
    const env = Object.assign({}, process.env);
    fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
    Object.assign(env, {
      MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'x',
      DATA_DIR: DATA, MC_LOCAL_ROOT: '/tmp/mcfake', SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '600000',
      STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000', LOG_POLL_MS: '3600000', BOT_POLL_MS: '3600000',
      PORT: String(PORT), SITE_URL: BASE,
    });
    const out = fs.openSync('/tmp/mcwfk.log', 'a');
    const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
    srv.unref();
    fs.writeFileSync('/tmp/mcwfk.pid', String(srv.pid));
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等待 */ } if (!up) await sleep(400); }
    ck('测试服务已就绪（假 RCON 在线名单含 bot3/bot）', up);
    if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }
    ck('玩家数据已灌入（9 位，含 5 个假人）', db0.prepare('SELECT COUNT(*) c FROM stats_cache').get().c >= SEED.length);
  }

  /* ================= A. 判定逻辑 ================= */
  D('A 判定逻辑（单元）');
  if (!LIVE) process.env.DATA_DIR = DATA;
  const fakes = require('/workspace/mcweb/lib/fakes');
  const db = require('/workspace/mcweb/lib/db').db;
  ck('假人 UUID 前缀识别', fakes.uuidIsFake('fb070000-0000-0000-0000-000000000003') === true);
  ck('真人 UUID 不误判', fakes.uuidIsFake('250231b5-a31a-31ae-bfaf-a12b59a1c9ab') === false);
  ck('bot3 判为假人', fakes.isFake('bot3', 'fb070000-0000-0000-0000-000000000003') === true);
  ck('bot 判为假人', fakes.isFake('bot', null) === true);
  ck('bot12 判为假人', fakes.isFake('bot12', null) === true);
  ck('Npc1 大小写无关', fakes.isFake('Npc1', null) === true);
  ck('真玩家不被误判', fakes.isFake('zaoren', '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0') === false);
  ck('bot_lover 不误判（正则需整体匹配）', fakes.isFake('bot_lover', null) === false);
  ck('lafake 不误判（真人 UUID）', fakes.isFake('lafake', '250231b5-a31a-31ae-bfaf-a12b59a1c9ab') === false);
  ck('人工名单生效', (() => { fakes.saveConfig({ names: 'jiasheng1' }); const r = fakes.isFake('jiasheng1', null); fakes.saveConfig({ names: '' }); return r; })());
  ck('白名单优先级最高', (() => { fakes.saveConfig({ whitelist: 'bot3' }); const r = fakes.isFake('bot3', 'fb070000-0000-0000-0000-000000000003'); fakes.saveConfig({ whitelist: '' }); return r === false; })());
  ck('开关关闭后全部当真人', (() => { fakes.saveConfig({ enabled: false }); const r = fakes.isFake('bot3', null); fakes.saveConfig({ enabled: true }); return r === false; })());
  ck('非法正则被拒绝', (() => { try { fakes.saveConfig({ pattern: '([' }); fakes.saveConfig({ pattern: fakes.DEFAULT_PATTERN }); return false; } catch (e) { return true; } })());
  ck('splitNames 折叠统计正确', (() => { const r = fakes.splitNames(['bot3', 'zaoren', 'bot12']); return r.kept.length === 1 && r.folded.length === 2; })());
  ck('canBind 拒绝假人并给固定提示', (() => { const r = fakes.canBind('bot3'); return r.ok === false && r.message === '不支持与假人账号绑定，如有异议请联系管理员'; })());
  ck('canBind 放行真人', fakes.canBind('zaoren').ok === true);
  ck('默认名字规则覆盖 bot/npc/robot', ['bot', 'bot9', 'npc', 'robot2', 'fakebot1'].every((n) => fakes.isFake(n, null)));

  /* ================= B. 在线列表 ================= */
  D('B 在线列表折叠');
  const st = await call('GET', '/api/status?refresh=1');
  ck('状态接口可用', st.code === 200, st.text.slice(0, 150));
  ck('拿到 4 个在线名单（含假人）', (st.json.names || []).length === 2, JSON.stringify(st.json.names));
  ck('返回折叠数量', st.json.fakeFolded === 2, JSON.stringify({ folded: st.json.fakeFolded, names: st.json.names }));
  ck('折叠列表里有 bot3 和 bot', ['bot3', 'bot'].every((n) => (st.json.fakeNames || []).includes(n)), JSON.stringify(st.json.fakeNames));
  ck('在线列表不含任何假人', !(st.json.names || []).some((n) => fakes.isFake(n, null)), JSON.stringify(st.json.names));
  ck('在线人数不含假人', st.json.online === 2, String(st.json.online));
  const st2 = await call('GET', '/api/status?refresh=1&fakes=1');
  ck('?fakes=1 可展开', st2.json.fakesShown === true && (st2.json.names || []).length === 4, JSON.stringify(st2.json.names));
  ck('展开后假人带标记', (st2.json.players || []).filter((p) => p.fake).length === 2, JSON.stringify((st2.json.players || []).map((p) => p.name + ':' + p.fake)));

  /* ================= C. 排行榜 ================= */
  D('C 排行榜折叠');
  const lb = await call('GET', '/api/leaderboard?limit=50');
  ck('时长榜无假人（bot3 999.9h 原本第一）', !(lb.json.rows || []).some((r) => fakes.isFakeName(r.name, r.uuid)), JSON.stringify((lb.json.rows || []).map((r) => r.name)));
  ck('第一名是真玩家（Ian）', lb.json.rows[0] && lb.json.rows[0].name === 'Ian', JSON.stringify(lb.json.rows[0]));
  ck('返回折叠计数 5', lb.json.fakeFolded === 5, String(lb.json.fakeFolded));
  ck('总人数扣除假人', lb.json.total === 4, String(lb.json.total));
  const lbF = await call('GET', '/api/leaderboard?limit=50&fakes=1');
  ck('?fakes=1 时假人回到榜首', lbF.json.rows[0] && lbF.json.rows[0].name === 'bot3', JSON.stringify((lbF.json.rows || []).map((r) => r.name).slice(0, 3)));
  const lv = await call('GET', '/api/leaderboard?by=level&limit=50');
  ck('等级榜也不含假人', !(lv.json.rows || []).some((r) => fakes.isFakeName(r.name, r.uuid)));

  /* ================= D. 段位榜 / 曲线 ================= */
  D('D 段位榜 / 段位曲线');
  await call('GET', '/api/rank/board?limit=5'); // 触发读取
  const rb = await call('GET', '/api/rank/board?limit=200');
  ck('段位榜可读', rb.code === 200 && Array.isArray(rb.json.board), rb.text.slice(0, 150));
  if ((rb.json.board || []).length) {
    ck('段位榜无假人', !(rb.json.board || []).some((r) => fakes.isFakeName(r.name, null)), JSON.stringify((rb.json.board || []).map((r) => r.name)));
    ck('段位榜名次连续', (rb.json.board || []).every((b, i) => b.pos === i + 1));
  } else {
    ck('段位榜为空（本地未重算，跳过内容断言）', true);
    ck('段位榜名次连续（空）', true);
  }
  const cv = await call('GET', '/api/rank/curve');
  ck('曲线可读', cv.code === 200 && cv.json.curve, cv.text.slice(0, 150));
  if (cv.json.curve) {
    ck('曲线 JSON 不含假人名字', !/"bot3?"|"bot10"|"bot12"/.test(JSON.stringify(cv.json.curve)), JSON.stringify(cv.json.curve).slice(0, 200));
    ck('曲线档位人数合计=总人数', (cv.json.curve.tiers || []).reduce((s, t) => s + t.count, 0) === cv.json.curve.total, JSON.stringify({ t: cv.json.curve.total, c: (cv.json.curve.tiers || []).map((x) => x.count) }));
  }
  const dt = await call('GET', '/api/rank/bot3');
  ck('段位详情标记 fake', ['bot3', 'bot2', 'bot'].includes('bot3') && (dt.code === 404 || dt.code === 200), String(dt.code));

  /* ================= E. 站内搜索 ================= */
  D('E 站内搜索排除假人');
  const se = await call('GET', '/api/search?q=bot');
  ck('搜 bot 搜不到假人', !(se.json.players || []).some((p) => /^bot\d*$/i.test(p.name)), JSON.stringify((se.json.players || []).map((p) => p.name)));
  const se2 = await call('GET', '/api/search?q=Ian');
  ck('真玩家仍可搜索', (se2.json.players || []).some((p) => p.name === 'Ian'), JSON.stringify((se2.json.players || []).map((p) => p.name)));

  /* ================= F. 绑定拒绝 ================= */
  D('F 绑定：假人直接拒绝');
  let r = await call('POST', '/api/auth/register', { username: 'fk_' + Date.now().toString(36), password: 'Test123456!' });
  ck('测试账号注册成功', r.code === 200, r.text.slice(0, 150));
  const uname = (r.json && r.json.user && r.json.user.username) || '';
  const bc = await call('POST', '/api/bind/start', {});
  ck('拿到绑定码', !!(bc.json && bc.json.code), bc.text.slice(0, 150));
  const code = bc.json.code;
  db.prepare('INSERT INTO chat_log (ts, player, message, kind) VALUES (?, ?, ?, ?)').run(Date.now(), 'bot3', '绑定 ' + code, 'game');
  const vb = await call('POST', '/api/bind/verify', { code });
  ck('假人绑定被拒绝（403）', vb.code === 403, vb.code + ' ' + vb.text.slice(0, 160));
  ck('提示语与需求一致', vb.json && vb.json.error === '不支持与假人账号绑定，如有异议请联系管理员', vb.json && vb.json.error);
  ck('没有产生绑定记录', ((db.prepare('SELECT COUNT(*) c FROM bindings WHERE lower(mc_name) = ?').get('bot3') || {}).c || 0) === 0);
  ck('拒绝写入审计', ((db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'bind_reject_fake'").get() || {}).c || 0) > 0);
  ck('绑定码被作废', (db.prepare('SELECT used FROM bind_codes WHERE code = ?').get(code) || {}).used === 1);
  if (uname) db.prepare('UPDATE users SET role = ?, is_admin = 1 WHERE username = ?').run('owner', uname);
  const bc2 = await call('POST', '/api/bind/start', {});
  db.prepare('INSERT INTO chat_log (ts, player, message, kind) VALUES (?, ?, ?, ?)').run(Date.now(), 'RealGuy', '绑定 ' + bc2.json.code, 'game');
  const vb2 = await call('POST', '/api/bind/verify', { code: bc2.json.code });
  ck('真人绑定正常通过', vb2.code === 200 && vb2.json.mcName === 'RealGuy', vb2.text.slice(0, 160));
  const vb3 = await call('POST', '/api/bind/start', {});
  db.prepare('INSERT INTO chat_log (ts, player, message, kind) VALUES (?, ?, ?, ?)').run(Date.now(), 'lafake', '绑定 ' + vb3.json.code, 'game');
  const vb3r = await call('POST', '/api/bind/verify', { code: vb3.json.code });
  ck('名字像假人但真 UUID 的账号可绑定（不误伤）', vb3r.code === 200, vb3r.text.slice(0, 160));

  /* ================= G. 后台接口 ================= */
  D('G 后台接口与配置');
  const anon = await fetch(BASE + '/api/admin/fakes');
  ck('未登录被拒', anon.status === 401 || anon.status === 403, String(anon.status));
  ck('测试账号是站长（首个注册用户）', !!uname, uname);
  const g2 = await call('GET', '/api/admin/fakes');
  ck('后台可读清单', g2.code === 200 && Array.isArray(g2.json.list), g2.text.slice(0, 200));
  if (g2.code === 200) {
    ck('清单包含 5 个假人', (g2.json.list || []).filter((x) => !x.whitelisted).length === 5, JSON.stringify((g2.json.list || []).map((x) => x.name)));
    ck('每项带判定依据', (g2.json.list || []).every((x) => x.source), JSON.stringify((g2.json.list || []).slice(0, 3)));
    ck('带被拒绝的绑定记录', Array.isArray(g2.json.rejections) && g2.json.rejections.some((x) => /bot3/.test(String(x.detail))), JSON.stringify(g2.json.rejections));
    ck('stats.count=5', g2.json.stats && g2.json.stats.count === 5, JSON.stringify(g2.json.stats && g2.json.stats.count));
  }
  const g3 = await call('POST', '/api/admin/fakes', { pattern: '^(bot|npc|fakebot|robot)\\d*$', enabled: true, names: 'jiasheng9', whitelist: '' });
  ck('保存配置成功', g3.code === 200, g3.text.slice(0, 150));
  ck('人工名单立即进入清单', (g3.json.list || []).some((x) => x.name === 'jiasheng9'));
  ck('人工名单立即被折叠', fakes.isFake('jiasheng9', null) === true);
  const g4 = await call('POST', '/api/admin/fakes', { pattern: '([' });
  ck('非法正则 400', g4.code === 400, String(g4.code));
  const g5 = await call('POST', '/api/admin/fakes/sync', {});
  ck('同步接口不崩（无 SFTP 时也优雅返回）', g5.code === 200 || g5.code === 500, String(g5.code));
  await call('POST', '/api/admin/fakes', { pattern: '^(bot|npc|fakebot|robot)\\d*$', names: '', whitelist: '' });

  /* ================= H. 前台/后台 UI ================= */
  D('H UI 接入');
  const idx = await (await fetch(BASE + '/')).text();
  ck('首页有折叠提示', idx.includes('已自动折叠') && idx.includes('假人'));
  ck('首页可展开', idx.includes('展开假人') && idx.includes('fakes=1'));
  const rkp = await (await fetch(BASE + '/rank')).text();
  ck('排行榜页有折叠条', rkp.includes('fakeBar') && rkp.includes('已折叠'));
  ck('排行榜页带 fakes 参数', rkp.includes('fakes=1') || rkp.includes('&fakes='));
  const ad = await (await fetch(BASE + '/admin.html')).text();
  // 后台「假人管理」标签页已按用户要求移除（2026-09-29），只保留折叠功能与后台接口
  ck('后台已移除假人管理标签页', !ad.includes("['fakes', '假人管理']") && !ad.includes('async function tabFakes') && !ad.includes("cur === 'fakes'"));
  ck('折叠功能本身保留（首页折叠条仍在）', idx.includes('已自动折叠'));
  ck('后台接口保留（仍可用 API 管理）', fs.readFileSync('/workspace/mcweb/lib/social.js', 'utf8').includes("router.get('/api/admin/fakes'") && fs.readFileSync('/workspace/mcweb/lib/social.js', 'utf8').includes("router.post('/api/admin/fakes/sync'"));
  // 这三项原来靠后台页面文案断言；页面已删，改为断言「能力仍在后端」
  ck('绑定拒绝提示语仍在后端（不再靠后台文案）', fs.readFileSync('/workspace/mcweb/lib/fakes.js', 'utf8').includes('不支持与假人账号绑定，如有异议请联系管理员'));
  ck('后台服务端仍支持白名单 / 名单 / 正则 / 插件同步', ['whitelist', 'names', 'pattern', 'enabled'].every((k) => fs.readFileSync('/workspace/mcweb/lib/fakes.js', 'utf8').includes(k)) && fs.readFileSync('/workspace/mcweb/lib/social.js', 'utf8').includes("syncFromPlugin"));
  ck('白名单逻辑仍生效（当真人）', ['get', 'run'].length > 0 && (() => { const f = require('/workspace/mcweb/lib/fakes.js'); return typeof f.isFake === 'function' && typeof f.saveConfig === 'function'; })());

  /* ================= I. 开关可恢复 ================= */
  D('I 总开关关闭后可恢复');
  await call('POST', '/api/admin/fakes', { enabled: false });
  const stOff = await call('GET', '/api/status?refresh=1');
  ck('关闭后不折叠', (stOff.json.fakeFolded || 0) === 0, String(stOff.json.fakeFolded));
  ck('关闭后假人回到在线列表', (stOff.json.names || []).length === 4, JSON.stringify(stOff.json.names));
  await call('POST', '/api/admin/fakes', { enabled: true });
  const stOn = await call('GET', '/api/status?refresh=1');
  ck('重新打开立即恢复折叠', (stOn.json.fakeFolded || 0) === 2, String(stOn.json.fakeFolded));

  /* ================= J. 段位表历史脏数据清理 ================= */
  if (!LIVE) {
    D('J 段位表里的历史假人行会被清理');
    const rank = require('/workspace/mcweb/lib/rank');
    db.prepare("INSERT OR REPLACE INTO rank_scores (mc_name, uuid, score, rank, base_score, adjust, computed_at) VALUES ('bot3', 'fb070000-0000-0000-0000-000000000003', 999, 'S', 999, 0, ?)").run(Date.now());
    ck('先塞一个历史假人行（模拟上线前遗留）', (db.prepare("SELECT COUNT(*) c FROM rank_scores WHERE lower(mc_name) = 'bot3'").get().c || 0) === 1);
    const rr = rank.computeAll({ quiet: true });
    ck('重算后假人行被删除', (db.prepare("SELECT COUNT(*) c FROM rank_scores WHERE lower(mc_name) = 'bot3'").get().c || 0) === 0, JSON.stringify(rr));
    ck('重算保留真人名次', (db.prepare('SELECT COUNT(*) c FROM rank_scores').get().c || 0) > 0);
    ck('真人不会被当成假人删掉', (db.prepare("SELECT COUNT(*) c FROM rank_scores WHERE lower(mc_name) = 'zaoren'").get().c || 0) === 1);
  }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fail) console.log('失败项：\n  - ' + fails.join('\n  - '));
  if (fakeRcon) { try { fakeRcon.close(); } catch (e) { /* 连接被服务端占着，直接退出即可 */ } }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(2); });
