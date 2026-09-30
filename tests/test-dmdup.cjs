'use strict';
/**
 * 验证「私聊消息重复」bug：
 *  1) 服务端是否把 dm 事件回推给发送者（重复的根因）
 *  2) 客户端去重逻辑（chat.html 的 appendMsg）能否把两条合成一条
 *  3) 世界频道同理
 */
const http = require('http');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { io } = require('/workspace/mcweb/node_modules/socket.io-client');

/* ---------- 假 RCON 服务端：只做握手 + 空响应，让网页发言链路能跑通 ---------- */
const RCON_PORT = 17001;
function pkt(id, type, body) {
  const payload = Buffer.from(body || '', 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeInt16LE(0, 12 + payload.length);
  return buf;
}
const rconCmds = [];
function startFakeRcon() {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 12) {
        const len = buf.readInt32LE(0);
        if (buf.length < len + 4) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.slice(12, len + 2).toString('utf8');
        buf = buf.slice(len + 4);
        if (type === 3) { sock.write(pkt(id, 2, '')); continue; } // auth
        rconCmds.push(body);
        // list 需要返回内容，其余命令返回空
        const out = body.trim() === 'list' ? 'There are 0 of a max of 48 players online:' : '';
        sock.write(pkt(id, 0, out));
      }
    });
    sock.on('error', () => {});
  });
  srv.listen(RCON_PORT, '127.0.0.1');
  return srv;
}

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = '/tmp/mcwdm';
const jars = {};
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log('  ✅ ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); } };

function req(who, p, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (jars[who]) headers['Cookie'] = jars[who];
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', headers }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) jars[who] = sc.map((c) => c.split(';')[0]).join('; ');
      const ch = [];
      res.on('data', (d) => ch.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(ch).toString('utf8');
        let j = null; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 120) }; }
        resolve({ code: res.statusCode, j });
      });
    });
    r.on('error', (e) => resolve({ code: 0, j: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 清理上次遗留的测试服务器（按 exe=node + cwd=/workspace/mcweb 精确匹配，跳过自身） */
function killLeftoverServers() {
  let killed = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (pid === process.pid || pid === process.ppid) continue;
    try {
      if (!fs.readlinkSync(`/proc/${d}/exe`).includes('node')) continue;
      if (fs.readlinkSync(`/proc/${d}/cwd`) !== '/workspace/mcweb') continue;
      const cl = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
      if (!cl.includes('server.js')) continue;
      process.kill(pid, 'SIGKILL');
      killed++;
    } catch {}
  }
  return killed;
}

function connect(who) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { transports: ['websocket'], extraHeaders: { Cookie: jars[who] } });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 6000);
  });
}

/* ---------- 复刻 chat.html 里的去重逻辑（与线上代码逐字一致） ---------- */
function makeBody() {
  const items = [];
  return {
    insertAdjacentHTML(_pos, h) { items.push(h); },
    get html() { return items.join(''); },
    has(id) { return new RegExp('#body .msg\\[data-mid="' + id + '"]').toString() && items.join('').includes('data-mid="' + id + '"'); },
    count() { return (items.join('').match(/class="msg/g) || []).length; },
  };
}
function makeApp(body) {
  return { $: (sel) => (String(sel).includes('.msg[data-mid=') ? (body.has(sel.match(/"(\d+)"/)[1]) ? {} : null) : body) };
}
function renderMsg(m, mine) {
  return `<div class="msg ${mine ? 'mine' : ''}"${m.id != null ? ` data-mid="${m.id}"` : ''}><div>${m.body || m.message}</div></div>`;
}
function appendMsg(App, body, html, id) {
  if (id != null && App.$('#body .msg[data-mid="' + id + '"]')) return false;
  body.insertAdjacentHTML('beforeend', html);
  return true;
}

(async () => {
  console.log('=== 准备两个账号（alice=发送者 bob=接收者） ===');
  const k = killLeftoverServers();
  if (k) console.log('  （清理了 ' + k + ' 个上次遗留的测试服务进程）');
  fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, DATA_DIR: DATA, MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: String(RCON_PORT), MC_RCON_PASSWORD: 'test', SCAN_ENABLED: '0', PORT: String(PORT) };
  const { spawn } = require('child_process');
  const fakeRcon = startFakeRcon();
  const srv = spawn(process.execPath, ['server.js'], { cwd: '/workspace/mcweb', env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  for (let i = 0; i < 40; i++) { await wait(400); const r = await req('x', '/api/health').catch(() => null); if (r && r.code === 200) break; }

  let r = await req('a', '/api/auth/register', 'POST', { username: 'alice', password: 'pass1234' });
  ok('注册 alice', r.code === 200, { id: r.j.user && r.j.user.id });
  const aliceId = r.j.user.id;
  r = await req('b', '/api/auth/register', 'POST', { username: 'bob', password: 'pass1234' });
  ok('注册 bob', r.code === 200, { id: r.j.user && r.j.user.id });
  const bobId = r.j.user.id;

  console.log('\n=== 互加好友（私聊前提：GET /api/dm 要求好友关系） ===');
  r = await req('a', '/api/friends/request', 'POST', { userId: bobId });
  ok('alice 向 bob 发起好友申请', r.code === 200, { code: r.code });
  r = await req('b', '/api/friends/accept', 'POST', { userId: aliceId });
  ok('bob 接受（userId=申请者 id）', r.code === 200, { code: r.code });
  r = await req('a', '/api/dm/' + bobId);
  ok('成为好友后 GET /api/dm 可读（修复前会 403）', r.code === 200, { code: r.code });

  console.log('\n=== socket 双端连接（带会话 cookie，自动进 u:<id> 房间） ===');
  const sAlice = await connect('a');
  const sBob = await connect('b');
  ok('alice socket 连接', sAlice.connected);
  ok('bob socket 连接', sBob.connected);
  await wait(300);

  const gotAlice = [], gotBob = [];
  sAlice.on('dm', (m) => gotAlice.push(m));
  sBob.on('dm', (m) => gotBob.push(m));

  console.log('\n=== ① 发送一条私信，看服务端推给谁 ===');
  r = await req('a', `/api/dm/${bobId}`, 'POST', { text: '第一条测试消息' });
  ok('POST /api/dm 成功', r.code === 200 && r.j.message, { id: r.j.message && r.j.message.id, mine: r.j.message && r.j.message.mine });
  await wait(700);
  ok('接收者 bob 收到 1 条 socket 推送', gotBob.length === 1, { 收到: gotBob.length });
  ok('发送者 alice 也收到 1 条 socket 回推（← 这就是重复的根因）', gotAlice.length === 1, { 收到: gotAlice.length });

  console.log('\n=== ② 客户端去重：POST 响应 + socket 回推 → 应该只有 1 条气泡 ===');
  {
    const body = makeBody();
    const App = makeApp(body);
    const post = { ...r.j.message, mine: true };
    const echo = gotAlice[0];
    appendMsg(App, body, renderMsg(post, true), post.id);
    appendMsg(App, body, renderMsg({ ...echo, mine: true }, true), echo.id);
    ok('先 POST 响应再 socket 回推 → 1 条', body.count() === 1, { 气泡数: body.count() });
  }
  {
    const body = makeBody();
    const App = makeApp(body);
    const echo = gotAlice[0];
    appendMsg(App, body, renderMsg({ ...echo, mine: true }, true), echo.id);
    appendMsg(App, body, renderMsg({ ...r.j.message, mine: true }, true), r.j.message.id);
    ok('顺序颠倒（socket 先到）→ 1 条', body.count() === 1, { 气泡数: body.count() });
  }
  {
    const body = makeBody();
    const App = makeApp(body);
    appendMsg(App, body, renderMsg({ ...r.j.message, mine: true }, true), r.j.message.id);
    // 对方回复（不同 id）必须正常显示
    const r2 = await req('b', `/api/dm/${aliceId}`, 'POST', { text: '对方回复' });
    await wait(600);
    const peerMsg = gotAlice.find((m) => m.from === bobId);
    appendMsg(App, body, renderMsg({ ...peerMsg, mine: false }, false), peerMsg.id);
    appendMsg(App, body, renderMsg({ ...peerMsg, mine: false }, false), peerMsg.id);
    ok('对方消息不误删且自身重复被去重 → 共 2 条', body.count() === 2, { 气泡数: body.count(), 第二次POST: r2.code });
  }

  console.log('\n=== ③ 世界频道（io.emit 也会回传给发送者） ===');
  // 直接给 alice 写入游戏绑定（免 RCON）
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA, 'mcweb.db'));
  db.prepare('INSERT OR REPLACE INTO bindings (user_id, mc_name, uuid, created_at) VALUES (?, ?, ?, ?)').run(aliceId, 'alice_mc', 'uuid-alice', Date.now());
  db.close();
  const gotChat = [];
  sAlice.on('chat', (m) => gotChat.push(m));
  r = await req('a', '/api/chat', 'POST', { text: '网页发言测试' });
  ok('POST /api/chat 成功（假 RCON 已连接）', r.code === 200 && r.j.message, { code: r.code, id: r.j.message && r.j.message.id });
  if (r.code === 200) {
    await wait(700);
    ok('发送者自己也收到 chat 广播（← 世界频道重复的根因）', gotChat.length === 1, { 收到: gotChat.length });
    ok('游戏内确实收到 tellraw（群发到游戏服）', rconCmds.some((c) => c.startsWith('tellraw @a ')), { 命令数: rconCmds.length });
    const body = makeBody();
    const App = makeApp(body);
    const m = r.j.message;
    appendMsg(App, body, renderMsg({ id: m.id, player: m.player, body: m.message }, true), m.id);
    appendMsg(App, body, renderMsg({ id: gotChat[0].id, player: gotChat[0].player, body: gotChat[0].message }, true), gotChat[0].id);
    ok('世界频道 POST + 广播 → 1 条', body.count() === 1, { 气泡数: body.count() });
  }

  console.log('\n=== ⑤ 回归：上一轮遗留消息不会重复渲染（重开页面/切换会话） ===');
  {
    r = await req('a', `/api/dm/${bobId}`);
    ok('GET /api/dm 返回历史消息', r.code === 200, { 条数: (r.j.messages || []).length });
    const ids = (r.j.messages || []).map((m) => m.id);
    ok('历史消息 id 无重复', new Set(ids).size === ids.length, { ids });
    const body = makeBody();
    const App = makeApp(body);
    for (const m of r.j.messages) appendMsg(App, body, renderMsg(m, m.mine), m.id);
    // 紧接着 socket 又推来最后一条（模拟刚发出的那条延迟到达）
    const last = r.j.messages[r.j.messages.length - 1];
    appendMsg(App, body, renderMsg(last, last.mine), last.id);
    ok('历史 + 延迟推送 → 不重复', body.count() === r.j.messages.length, { 期望: r.j.messages.length, 实际: body.count() });
  }

  console.log('\n=== ④ 静态检查：chat.html 的所有消息插入都走 appendMsg ===');
  const html = fs.readFileSync('/workspace/mcweb/public/chat.html', 'utf8');
  const rawInserts = (html.match(/insertAdjacentHTML\('beforeend',\s*(renderMsg|dmMsgHtml|`)/g) || []).length;
  ok('无「直接插入消息 HTML」的漏网之鱼', rawInserts === 0, { 漏网: rawInserts });
  ok('socket dm 事件走 appendMsg + dmMsgHtml（带 data-mid）', /on\('dm',[\s\S]{0,400}?appendMsg\(dmMsgHtml/.test(html));
  ok('socket chat 事件走 appendMsg', /on\('chat',[\s\S]{0,300}?appendMsg\(renderMsg/.test(html));
  ok('send() 私聊分支走 appendMsg', /await App\.api\('\/api\/dm\/' \+ cur[\s\S]{0,200}?appendMsg\(dmMsgHtml/.test(html));
  ok('send() 世界频道分支走 appendMsg', /await App\.api\('\/api\/chat'[\s\S]{0,300}?appendMsg\(renderMsg/.test(html));

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  sAlice.close(); sBob.close();
  try { fakeRcon.close(); } catch {}
  try { srv.kill('SIGTERM'); } catch {}
  await wait(300);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('测试异常:', e.stack); process.exit(1); });
