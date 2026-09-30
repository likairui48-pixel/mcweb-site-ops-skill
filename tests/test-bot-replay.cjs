'use strict';
/**
 * 机器人「重启重放」回归：
 * 现象：线上每次部署重启后，机器人会把日志尾巴（默认 64KB，可能是几十分钟前的聊天）当成新消息又回答一遍，
 *      玩家莫名收到一堆旧回复，同时白吃每日 AI 额度、并且被 perMinute 限流刷出一批 ok=0。
 * 原因：botLastSize 只在内存里，重启后从 0 开始 → 首次轮询读到整段日志尾巴 → 全部当新消息处理。
 * 修法：进程启动时先探测一次日志大小当基准（探测失败则首次拿到日志只定位不回复）。
 * 本测试：先在日志里放 3 条「会触发机器人」的旧消息 → 起服务 → 启用机器人 → 等若干轮轮询 → 必须一条都没回；
 *        随后再写一条新消息 → 必须正常回复（证明只是不重放，不是把机器人弄瘸了）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const { server: fakeRcon, fakeAI } = require('/tmp/fake-rcon.cjs');

const PORT = 8786;
const RCON_PORT = 25581;
const AI_PORT = 25584;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA = '/tmp/mcwreplay';
const LOGROOT = '/tmp/mcfake-replay';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const fails = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 240) : '')); } };
const sec = (t) => console.log('\n=== ' + t + ' ===');

const jar = {};
async function call(who, method, p, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar[who]) headers.Cookie = jar[who];
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) jar[who] = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text();
  try { return { code: r.status, ...JSON.parse(t) }; } catch (e) { return { code: r.status, raw: t.slice(0, 160) }; }
}
function killLeftover() {
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    const p = Number(pid);
    if (p === process.pid || p === process.ppid) continue;
    try { if (fs.readlinkSync('/proc/' + p + '/cwd') === '/workspace/mcweb' && /node/.test(fs.readlinkSync('/proc/' + p + '/exe'))) process.kill(p, 'SIGTERM'); } catch (e) { /* 忽略 */ }
  }
}
const chatLine = (who, text) => '[12:00:00] [Async Chat Thread - #0/INFO]: <' + who + '> ' + text + '\n';

// 旧消息（重启前就躺在日志里，内容与后面新发的消息刻意区分，便于断言「旧消息有没有被重放」）
const OLD = [
  chatLine('TesterA', '禾小助 服务器怎么进服'),      // 命中关键词（不走 AI）
  chatLine('TesterB', '禾小助 你在忙什么'),          // 闲聊（走 AI）
  chatLine('TesterA', '禾小助 等级榜第一是谁'),      // 榜单直出（不走 AI）
];
const OLD_TEXTS = ['禾小助 服务器怎么进服', '禾小助 你在忙什么', '禾小助 等级榜第一是谁'];

(async () => {
  killLeftover();
  await sleep(600);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(LOGROOT, { recursive: true, force: true });
  fs.mkdirSync(LOGROOT + '/logs', { recursive: true });
  // 关键：旧聊天在服务启动之前就躺在日志里
  fs.writeFileSync(LOGROOT + '/logs/latest.log', OLD.join(''));
  fs.writeFileSync(LOGROOT + '/usercache.json', JSON.stringify([
    { name: 'TesterA', uuid: '33333333-3333-3333-3333-333333333333' },
    { name: 'TesterB', uuid: '44444444-4444-4444-4444-444444444444' },
  ]));
  fs.writeFileSync(LOGROOT + '/server.properties', 'server-port=25565\n');

  const rcon = fakeRcon({ port: RCON_PORT, password: 'pw' });
  const aiSrv = fakeAI({ port: AI_PORT, reply: '哈，我在呢。' });

  const env = Object.assign({}, process.env);
  fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2]; });
  Object.assign(env, {
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'pw',
    DATA_DIR: DATA, MC_LOCAL_ROOT: LOGROOT, SCAN_ENABLED: '0', SCAN_START_DELAY_MS: '3600000',
    PORT: String(PORT), SITE_URL: BASE, BOT_POLL_MS: '1000',
    LOG_POLL_MS: '3600000', STATUS_POLL_MS: '3600000', ONLINE_INFO_MS: '3600000',
  });
  process.env.DATA_DIR = DATA;
  const { db } = require('/workspace/mcweb/lib/db');
  db.prepare(`INSERT INTO stats_cache (uuid, name, playtime_ticks, level, updated_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(uuid) DO UPDATE SET playtime_ticks = excluded.playtime_ticks`)
    .run('33333333-3333-3333-3333-333333333333', 'TesterA', 900 * 72000, 88, Date.now());
  db.prepare(`INSERT INTO rank_scores (mc_name, uuid, score, rank, base_score, adjust, computed_at) VALUES (?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(mc_name) DO UPDATE SET score = excluded.score, rank = excluded.rank`)
    .run('TesterA', '33333333-3333-3333-3333-333333333333', 800, 'S', 800, Date.now());

  const out = fs.openSync('/tmp/mcwreplay.log', 'a');
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, detached: true, stdio: ['ignore', out, out] });
  srv.unref();
  fs.writeFileSync('/tmp/mcwreplay.pid', String(srv.pid));

  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch (e) { /* 等 */ } if (!up) await sleep(400); }

  sec('A 服务启动 + 记录日志基准');
  ck('测试服务已就绪（假 RCON + 假 AI）', up);
  if (!up) { console.log('结果: ' + pass + ' 通过, ' + (fail + 1) + ' 失败'); process.exit(1); }
  await sleep(1500);
  const bootLog = fs.readFileSync('/tmp/mcwreplay.log', 'utf8');
  ck('启动时记录了日志基准位置', /\[bot\] 日志基准 \d+ 字节/.test(bootLog), bootLog.split('\n').filter((l) => /\[bot\]/.test(l)).slice(-3).join(' | '));
  ck('启动时把日志里已有的历史消息预先登记了（关键修复点）', /预登记历史消息 3 条/.test(bootLog), (bootLog.match(/\[bot\] 日志基准[^\n]*/) || [''])[0]);

  sec('B 启用机器人（配置文件里躺着 3 条旧消息）');
  await call('owner', 'POST', '/api/auth/register', { username: 'rpowner', password: 'pass1234' });
  let r = await call('owner', 'POST', '/api/admin/ai', { enabled: true, baseUrl: 'http://127.0.0.1:' + AI_PORT + '/v1', key: 'k', model: 'fake', limits: { perMinute: 60, perDay: 500, minGapMs: 0 } });
  ck('AI 配置保存成功', r.code === 200, r.code);
  r = await call('owner', 'POST', '/api/admin/bot', {
    enabled: true, name: '禾小助', persona: '友好简短', trigger: 'smart', replyChance: 0,
    cooldownMs: 0, perMinute: 60, maxLen: 400, target: 'all', boards: true, profile: true, status: true,
    boardAi: false, keywords: '怎么进服',
  });
  ck('机器人已启用', r.code === 200 && r.bot && r.bot.enabled === true, r.code);

  sec('C 等 10 轮轮询（约 12 秒）：旧消息一条都不能回');
  await sleep(12000);
  const logs1 = await call('owner', 'GET', '/api/admin/bot/logs?limit=50');
  ck('没有任何机器人回复记录（旧消息没被重放）', (logs1.logs || []).length === 0, JSON.stringify((logs1.logs || []).map((x) => x.player + ':' + x.message).slice(0, 5)));
  const tell1 = rcon.commands.filter((c) => /tellraw/.test(c));
  ck('假 RCON 也没收到任何 tellraw', tell1.length === 0, JSON.stringify(tell1.slice(0, 3)));
  ck('假 AI 一次都没被调用', aiSrv.got.length === 0, String(aiSrv.got.length));

  sec('D 来一条新消息：只回这一条（旧消息不能被顺带重放）');
  aiSrv.got.length = 0;
  rcon.commands.length = 0;
  const t = Date.now();
  fs.appendFileSync(LOGROOT + '/logs/latest.log', chatLine('TesterA', '禾小助 你叫什么名字'));
  let hit = null;
  for (let i = 0; i < 30 && !hit; i++) {
    await sleep(500);
    const j = await call('owner', 'GET', '/api/admin/bot/logs?limit=20');
    hit = (j.logs || []).find((x) => x.player === 'TesterA' && x.ts >= t - 2000);
  }
  ck('新消息被正常回复', !!hit, JSON.stringify((logs1.logs || []).length));
  if (hit) ck('回复内容来自（假）AI/模板且非空', String(hit.reply || '').length > 0, String(hit.reply || '').slice(0, 80));
  ck('回复发到了世界频道（tellraw @a）', rcon.commands.some((c) => /tellraw @a/.test(c)), JSON.stringify(rcon.commands.slice(-2)));

  sec('E 再追加一条榜单查询：也不能被当成重放');
  rcon.commands.length = 0;
  fs.appendFileSync(LOGROOT + '/logs/latest.log', chatLine('TesterA', '禾小助 段位榜前十是谁'));
  let hit2 = null;
  for (let i = 0; i < 30 && !hit2; i++) {
    await sleep(500);
    const j = await call('owner', 'GET', '/api/admin/bot/logs?limit=20');
    hit2 = (j.logs || []).find((x) => x.player === 'TesterA' && x.kind === 'board' && x.ts >= t);
  }
  ck('新榜单查询也正常回复', !!hit2, JSON.stringify((hit2 || {}).kind));

  sec('F 总账：机器人的回复里不允许出现任何一条「旧消息」');
  const fin = await call('owner', 'GET', '/api/admin/bot/logs?limit=50');
  const msgs = (fin.logs || []).map((x) => x.message);
  const replayed = msgs.filter((m) => OLD_TEXTS.includes(m));
  ck('没有一条旧消息被回复', replayed.length === 0, JSON.stringify(replayed));
  ck('回复条数 = 新消息条数（2 条，不多不少）', msgs.length === 2, JSON.stringify(msgs));
  ck('AI 只被调用了新消息的次数（≤2，旧消息没吃额度）', aiSrv.got.length <= 2, String(aiSrv.got.length));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  try { process.kill(srv.pid, 'SIGTERM'); } catch (e) { /* 忽略 */ }
  try { rcon.close(); } catch (e) { /* 忽略 */ }
  try { aiSrv.close(); } catch (e) { /* 忽略 */ }
  process.exit(fail ? 1 : 0);
})();
