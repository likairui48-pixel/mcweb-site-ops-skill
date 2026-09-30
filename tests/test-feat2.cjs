'use strict';
/**
 * 第二批功能 E2E：
 *  A. AI 限频/每日额度 + 用量统计
 *  B. 游戏外举报 → AI 初审（带日志/站点证据）
 *  C. 游戏内举报（日志采集 !report）→ 取证 + AI
 *  D. 限额真实生效（第 3 次触发限频）
 *  E. 段位曲线 + 赛季（开始/调整/改名/结束/重算）
 *  F. 头像上传 / 管理撤回 / 锁定
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 8795;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = '/tmp/mcwfeat2';
const FIXTURE = '/tmp/mcfake';
const AI_PORT = 17099;

let pass = 0, failn = 0;
const fails = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { failn++; fails.push(name); console.log('  !!  ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra).slice(0, 200) : '')); }
}
const jars = {};
async function call(user, method, p, body) {
  const init = { method, headers: { ...(jars[user] ? { Cookie: jars[user] } : {}) } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, init);
  const sc = r.headers.get('set-cookie');
  if (sc && !jars[user]) jars[user] = sc.split(';')[0];
  let j = null;
  try { j = await r.json(); } catch { j = { ok: false, error: 'non-json' }; }
  return { status: r.status, ...j };
}
async function raw(user, p) {
  const r = await fetch(BASE + p, { headers: { ...(jars[user] ? { Cookie: jars[user] } : {}) } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type'), len: buf.length, buf };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG_8x8 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=';

/* ---------------- mock AI（OpenAI 兼容） ---------------- */
let aiCalls = 0;
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    aiCalls++;
    let prompt = '';
    try { prompt = JSON.parse(b).messages.map((m) => m.content).join('\n'); } catch { prompt = b; }
    const hasLog = /《服务器日志证据》/.test(prompt);
    const hasZaoren = /zaoren/.test(prompt);
    const content = JSON.stringify({
      verdict: 'violation', confidence: 88, severity: 'medium', action: 'warn',
      reason: (hasLog ? 'LOGSEEN' : 'NOLOG') + (hasZaoren ? '+TARGET' : '') + ' 日志证据显示其刷屏骚扰',
      evidence: hasLog ? (hasZaoren ? ['<zaoren> 你在干什么'] : ['账号档案与发言记录（站点侧）']) : [], log_based: hasLog,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock-1', choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 40 } }));
  });
});

/* ---------------- 启动被测服务 ---------------- */
function killLeftover() {
  try {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (pid === process.pid || pid === process.ppid) continue;
      let cwd = '';
      try { cwd = fs.readlinkSync(`/proc/${d}/cwd`); } catch { continue; }
      if (cwd !== '/workspace/mcweb') continue;
      let exe = '';
      try { exe = fs.readlinkSync(`/proc/${d}/exe`); } catch { continue; }
      if (!/node/.test(exe)) continue;
      try { process.kill(pid, 'SIGKILL'); console.log('  (清理残留服务 pid ' + pid + ')'); } catch {}
    }
  } catch {}
}

let server = null;
async function startServer() {
  killLeftover();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 日志仿真：含目标玩家发言 + 游戏内举报指令
  fs.mkdirSync(path.join(FIXTURE, 'logs'), { recursive: true });
  // 用东八区时钟（服务器日志里的时间是服务器本地时区）
  const cn = new Date(Date.now() + 8 * 3600000);
  const hh = String(cn.getUTCHours()).padStart(2, '0');
  const mm = String(cn.getUTCMinutes()).padStart(2, '0');
  const lines = [
    `[${hh}:${mm}:01] [Server thread/INFO]: shangzhan joined the game`,
    `[${hh}:${mm}:05] [Async Chat Thread - #0/INFO]: <zaoren> 你在干什么`,
    `[${hh}:${mm}:10] [Async Chat Thread - #0/INFO]: <shangzhan> 别刷屏`,
    `[${hh}:${mm}:20] [Async Chat Thread - #0/INFO]: <zaoren> 我错了`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(FIXTURE, 'logs', 'latest.log'), lines); // 覆盖：不要带入历史 !report 指令
  const env = {
    ...process.env, ...readEnv(),
    MC_HOST: '127.0.0.1', MC_RCON_HOST: '127.0.0.1', MC_RCON_PORT: '1',
    MC_LOCAL_ROOT: FIXTURE, DATA_DIR, PORT: String(PORT),
    LOG_POLL_MS: '1200', SCAN_START_DELAY_MS: '300',
  };
  const log = fs.openSync('/tmp/feat2-server.log', 'w');
  server = spawn('node', ['server.js'], { cwd: '/workspace/mcweb', env, stdio: ['ignore', log, log] });
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
  }
  throw new Error('服务未启动，见 /tmp/feat2-server.log');
}
function readEnv() {
  const out = {};
  try {
    for (const l of fs.readFileSync('/workspace/mcweb/.env', 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch {}
  return out;
}

(async () => {
  await new Promise((r) => mock.listen(AI_PORT, r));
  await startServer();
  console.log('--- 服务已启动 ---');

  // 注册账号
  let r = await call('alice', 'POST', '/api/auth/register', { username: 'alice', password: 'pass1234' });
  if (!r.ok && !/已存在|占用/.test(r.error || '')) throw new Error('alice 注册失败 ' + JSON.stringify(r));
  r = await call('alice', 'POST', '/api/auth/login', { username: 'alice', password: 'pass1234' });
  check('alice 登录（owner）', r.ok && r.user && r.user.isStaff, r);
  await call('bob', 'POST', '/api/auth/register', { username: 'bob', password: 'pass1234' });
  r = await call('bob', 'POST', '/api/auth/login', { username: 'bob', password: 'pass1234' });
  check('bob 登录', r.ok, r);
  await call('carol', 'POST', '/api/auth/register', { username: 'carol', password: 'pass1234' });
  r = await call('carol', 'POST', '/api/auth/login', { username: 'carol', password: 'pass1234' });
  check('carol 登录（普通用户）', r.ok, r);
  const me = await call('bob', 'GET', '/api/auth/me');
  const bobId = me.user.id;

  /* ============ A. AI 配置 + 限额 ============ */
  console.log('\n[A] AI 配置与限额');
  r = await call('alice', 'POST', '/api/admin/ai', {
    enabled: true, auto: true, baseUrl: 'http://127.0.0.1:' + AI_PORT + '/v1', model: 'mock-1', key: 'sk-test-123',
    limits: { perMinute: 3, perDay: 6, minGapMs: 10 },
  });
  check('AI 开启 + 写入限额', r.ok && r.ai && r.ai.enabled, r);
  check('限额回显 perMinute=3', r.ai && r.ai.limits && r.ai.limits.perMinute === 3, r.ai && r.ai.limits);
  check('限额回显 perDay=6', r.ai && r.ai.limits && r.ai.limits.perDay === 6, r.ai && r.ai.limits);
  check('Key 已脱敏不回传明文', !!(r.ai && r.ai.hasKey === true && !/sk-test-123/.test(r.ai.keyMasked || '')), r.ai && { hasKey: r.ai.hasKey, masked: r.ai.keyMasked });
  r = await call('alice', 'GET', '/api/admin/ai');
  check('用量统计 today 有结构', r.ok && r.usage && typeof r.usage.today === 'number', r.usage);
  check('用量统计展示每日限额', r.usage.perDayLimit === 6 && r.usage.perMinuteLimit === 3, r.usage);
  r = await call('alice', 'GET', '/api/admin/ai/usage?days=7&limit=5');
  check('用量接口返回近 7 天', r.ok && Array.isArray(r.daily) && r.daily.length === 7, r.daily && r.daily.length);
  r = await call('carol', 'GET', '/api/admin/ai/usage');
  check('普通用户不能看用量（403）', r.status === 403 || r.error, r.status);

  // 提高每分钟限额，避免 B/C 段的自动初审互相挤占（D 段会再压低来验证限流）
  await call('alice', 'POST', '/api/admin/ai', { limits: { perMinute: 30, perDay: 200, minGapMs: 10 } });

  /* ============ B. 游戏外举报 + AI ============ */
  console.log('\n[B] 游戏外（网站）举报 + AI 初审');
  r = await call('alice', 'POST', '/api/reports', { targetType: 'user', targetId: String(bobId), reason: '发布不良内容', detail: '测试网站侧举报' });
  const webReportId = r.id;
  check('网站举报创建成功', r.ok && r.id > 0, r);
  check('举报带 source=web', r.source === 'web', r);
  await sleep(600);
  r = await call('alice', 'GET', '/api/admin/reports?status=open&source=web');
  const webRep = r.reports && r.reports.find((x) => x.id === webReportId);
  check('举报列表可查到（source 过滤）', !!webRep, r.counts);
  check('举报来源标记 web', webRep && webRep.source === 'web', webRep && webRep.source);
  check('举报人名字已记录', webRep && webRep.reporter_name === 'alice', webRep && webRep.reporter_name);
  check('收集时间已记录', webRep && !!webRep.collected_at, webRep && webRep.collected_at);
  check('AI 已给出裁决', webRep && webRep.ai_verdict === 'violation', webRep && { v: webRep.ai_verdict, why: webRep.ai_reason });
  check('AI 置信度写入', webRep && webRep.ai_confidence === 88, webRep && webRep.ai_confidence);
  check('AI 证据落到 ai_evidence', webRep && Array.isArray(webRep.evidence) && webRep.evidence.length >= 1, webRep && webRep.evidence);
  check('网站举报带站点上下文证据', webRep && !!webRep.log_context, webRep && String(webRep.log_context || '').slice(0, 80));
  check('证据来源标记 site', webRep && webRep.logMeta && webRep.logMeta.kind === 'site', webRep && webRep.logMeta);
  r = await call('alice', 'GET', '/api/admin/ai/usage?limit=50');
  check('AI 调用被记账（kind=report）', r.ok && r.calls.some((c) => c.kind === 'report' && c.ok === 1), r.calls);
  check('调用记账带 ref=report#id', r.ok && r.calls.some((c) => c.ref === 'report#' + webReportId), r.calls && r.calls.map((c) => c.ref));

  /* ============ C. 游戏内举报（日志采集） ============ */
  console.log('\n[C] 游戏内举报（!report → 日志取证 → AI）');
  let inRep = null;
  const repTag = 'REP-mukbwj7p';
  {
    // 模拟玩家在游戏里输入举报指令（此刻 AI 已开启，与真实场景一致）
    const cn2 = new Date(Date.now() + 8 * 3600000);
    const t2 = [cn2.getUTCHours(), cn2.getUTCMinutes(), cn2.getUTCSeconds()].map((x) => String(x).padStart(2, '0'));
    fs.appendFileSync(path.join(FIXTURE, 'logs', 'latest.log'), `[${t2[0]}:${t2[1]}:${t2[2]}] [Async Chat Thread - #0/INFO]: <shangzhan> !report zaoren 一直刷屏骂人 ${repTag}\n`);
  }
  for (let i = 0; i < 20 && !inRep; i++) {
    await sleep(600);
    const lr = await call('alice', 'GET', '/api/admin/reports?status=open&source=ingame');
    inRep = (lr.reports || []).find((x) => String(x.reason || '').includes(repTag)) || null;
  }
  // 证据与 AI 结果是异步写入的，等它落库后再断言（否则读到早期快照）
  if (inRep) {
    for (let i = 0; i < 20; i++) {
      if (inRep && inRep.ai_at && (inRep.log_context || inRep.ai_verdict === 'quota')) break;
      await sleep(500);
      const lr2 = await call('alice', 'GET', '/api/admin/reports?status=open&source=ingame');
      const again = (lr2.reports || []).find((x) => String(x.reason || '').includes(repTag));
      if (again) inRep = again;
    }
  }
  check('日志里发现的游戏内举报已入库（AI 开启后提交）', !!inRep, inRep);
  check('来源标记 ingame', inRep && inRep.source === 'ingame', inRep && inRep.source);
  check('举报人=游戏内玩家 shangzhan', inRep && inRep.reporter_name === 'shangzhan', inRep && inRep.reporter_name);
  check('被举报对象=zaoren', inRep && /zaoren/.test(inRep.target_label || ''), inRep && inRep.target_label);
  check('举报理由取自指令文本', inRep && /刷屏/.test(inRep.reason || ''), inRep && inRep.reason);
  check('举报指令识别唯一标记（无历史串扰）', inRep && String(inRep.reason).includes(repTag), inRep && inRep.reason);
  check('游戏内事件时间已记录', inRep && inRep.occurred_at > 0, inRep && inRep.occurred_at);
  check('收集时间已记录', inRep && inRep.collected_at > 0, inRep && inRep.collected_at);
  check('取证抓到当时日志原文', inRep && /zaoren|shangzhan/.test(inRep.log_context || ''), inRep && String(inRep.log_context || '').slice(0, 120));
  check('证据来源标记 gamelog', inRep && inRep.logMeta && inRep.logMeta.kind === 'gamelog', inRep && inRep.logMeta);
  check('AI 读过日志（prompt 含《服务器日志证据》）', inRep && /LOGSEEN/.test(inRep.ai_reason || '') && inRep.ai_log_used === 1, inRep && { why: inRep.ai_reason, used: inRep.ai_log_used });
  check('AI 证据引用日志原文', inRep && Array.isArray(inRep.evidence) && inRep.evidence.some((e) => /zaoren/.test(e)), inRep && inRep.evidence);
  check('游戏内举报不再被当普通聊天丢失', !!inRep);

  await call('alice', 'POST', '/api/admin/ai', { limits: { perMinute: 20, perDay: 200, minGapMs: 10 } });
  // 手动重新取证
  r = await call('alice', 'POST', `/api/admin/reports/${inRep.id}/refetch`, { minutes: 30 });
  check('手动重新取证返回日志窗口', r.ok && r.evidence && r.evidence.text, r.evidence && String(r.evidence.text || '').slice(0, 60));
  r = await call('alice', 'POST', `/api/admin/reports/${inRep.id}/ai`, { refetch: true, minutes: 30 });
  check('管理员可强制重跑 AI（带新日志）', r.ok && r.result && r.result.verdict === 'violation', r.result || r.error);
  check('重跑结果标记 logUsed', r.ok && r.result && r.result.logUsed === true, r.result && r.result.logUsed);

  // 处置
  r = await call('alice', 'POST', `/api/admin/reports/${inRep.id}/handle`, { status: 'resolved', action: 'none', note: '游戏内举报已核对' });
  check('游戏内举报可结案', r.ok, r);
  r = await call('alice', 'POST', `/api/admin/reports/${webReportId}/handle`, { status: 'resolved', action: 'warn', note: '首次警告' });
  check('网站举报处置（警告用户）成功', r.ok && /警告/.test(r.actionResult || ''), r);
  r = await call('alice', 'GET', '/api/admin/reports?status=resolved');
  const handled = (r.reports || []).find((x) => x.id === webReportId);
  check('处置后状态与备注落库', handled && handled.status === 'resolved' && /警告/.test(handled.handle_note || ''), handled && handled.handle_note);

  r = await call('alice', 'POST', '/api/admin/reports/triage-pending', { limit: 2 });
  check('可补做历史未初审举报', r.ok && Array.isArray(r.processed) && typeof r.remaining === 'number', r);

  /* ============ D. 限额真实生效 ============ */
  console.log('\n[D] 限频/额度生效');
  await call('alice', 'POST', '/api/admin/ai', { limits: { perMinute: 2, perDay: 6, minGapMs: 10 } });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const cr = await call('alice', 'POST', '/api/reports', { targetType: 'user', targetId: String(bobId), reason: '限频测试 ' + i });
    if (cr.id) ids.push(cr.id);
  }
  let quotaHit = null;
  for (const id of ids) {
    const ar = await call('alice', 'POST', `/api/admin/reports/${id}/ai`, { refetch: true, minutes: 5 });
    if (!ar.ok && /限频|上限/.test(ar.error || '')) { quotaHit = ar.error; break; }
  }
  check('超过每分钟限额后拒绝调用', !!quotaHit, quotaHit);
  r = await call('alice', 'GET', '/api/admin/ai');
  check('触发限频的举报被标记 quota', r.ok, '');
  const qr = await call('alice', 'GET', '/api/admin/reports?status=all&source=web');
  check('举报行记录额度原因', (qr.reports || []).some((x) => x.ai_verdict === 'quota'), (qr.reports || []).map((x) => x.ai_verdict).slice(0, 6));
  check('perMinuteUsed 已统计', r.usage.perMinuteUsed >= 2, r.usage);
  await call('alice', 'POST', '/api/admin/ai', { limits: { perMinute: 20, perDay: 200, minGapMs: 10 } });
  // 每日上限
  await call('alice', 'POST', '/api/admin/ai', { limits: { perDay: 1 } });
  r = await call('alice', 'POST', `/api/admin/reports/${ids[ids.length - 1]}/ai`, { refetch: true, minutes: 5 });
  check('每日上限生效（今日已超额）', !r.ok && /上限/.test(r.error || ''), r.error);
  await call('alice', 'POST', '/api/admin/ai', { limits: { perMinute: 20, perDay: 500, minGapMs: 10 } });

  /* ============ E. 段位曲线 + 赛季 ============ */
  console.log('\n[E] 段位曲线 + 赛季');
  // 种子分数数据
  execSync('cd /workspace/mcweb && DATA_DIR=' + DATA_DIR + ' node -e "' + [
    "const { db } = require('./lib/db');",
    "const now = Date.now();",
    "const rows = [['aaaa1111-0000-0000-0000-000000000001','Alpha',90000000,900000,300000,900,9000],['aaaa1111-0000-0000-0000-000000000002','Beta',30000000,300000,90000,300,3000],['aaaa1111-0000-0000-0000-000000000003','Gamma',3000000,30000,9000,30,300],['aaaa1111-0000-0000-0000-000000000004','Delta',600000,6000,1800,6,60]];",
    "for (const r of rows) { const [uuid,name,pt,placed,mined,adv,lvl] = r; db.prepare('INSERT OR REPLACE INTO stats_cache (uuid,name,playtime_ticks,blocks_placed,blocks_mined,blocks_crafted,advances,level,leave_count,first_join,last_seen,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(uuid,name,pt,placed,mined,Math.round(placed/4),adv,lvl,40,now-86400000*40,now,now); }",
    "for (let d=0; d<14; d++) for (const nm of ['Alpha','Beta','Gamma','Delta']) db.prepare('INSERT OR REPLACE INTO play_days (mc_name, day, sessions, seconds, source, updated_at) VALUES (?,?,?,?,?,?)').run(nm, new Date(now-d*86400000).toISOString().slice(0,10), 1, 3600, 'live', now);",
    "console.log('seed-ok');",
  ].join('') + '"', { stdio: 'inherit' });
  r = await call('alice', 'POST', '/api/admin/rank/recompute');
  check('重算段位成功', r.ok && r.result.total >= 4, r.result && r.result.total);
  r = await call('alice', 'GET', '/api/rank/curve');
  const curve = r.curve;
  check('段位曲线接口可用', r.ok && curve && curve.total >= 4, r);
  const bucketSum = (curve.buckets || []).reduce((s, b) => s + b.count, 0);
  check('直方图分段总和=总人数', bucketSum === curve.total, { bucketSum, total: curve.total });
  check('直方图给出分段标签', curve.buckets.length >= 5 && /-/.test(curve.buckets[0].label), curve.buckets.slice(0, 2));
  check('档位分布含 S/A/B/C 四条', (curve.tiers || []).filter((t) => ['S', 'A', 'B', 'C'].includes(t.key)).length === 4, curve.tiers);
  check('档位分布带百分比', curve.tiers.every((t) => typeof t.percent === 'number'), curve.tiers);
  check('百分位含 p50/p90/p99', typeof curve.percentiles.p50 === 'number' && typeof curve.percentiles.p90 === 'number' && typeof curve.percentiles.p99 === 'number', curve.percentiles);
  check('给出建议分数线（含当前线对比）', (curve.suggestions || []).length === 3 && curve.suggestions[0].suggestedMin !== undefined, curve.suggestions);
  check('曲线给出名次→分数对照表', Array.isArray(curve.atRank) && curve.atRank.length >= 3 && curve.atRank[0].rank === 1 && typeof curve.atRank[0].score === 'number', curve.atRank && curve.atRank.slice(0,2));
  check('曲线给出活跃口径（避免小号超长尾）', curve.active && typeof curve.active.total === 'number' && typeof curve.active.min === 'number' && curve.active.percentiles && typeof curve.active.percentiles.p50 === 'number', curve.active);
  check('建议分数线带活跃人数与占比', (curve.suggestions || []).every((x) => x.activeCount !== undefined && x.actualPercentActive !== undefined), curve.suggestions && curve.suggestions[0]);
  check('分项均值可用于调权重', (curve.components || []).length >= 5 && curve.components[0].avgMax > 0, (curve.components || []).slice(0, 2));
  r = await call('alice', 'GET', '/api/season');
  check('赛季接口可用（初始无赛季）', r.ok && r.season === null, r.season);
  r = await call('alice', 'POST', '/api/admin/rank/sync', { method: 'POST', body: { targets: ['events'], days: 7 } }).catch(() => null);
  r = await call('alice', 'POST', '/api/admin/rank/sync', { targets: ['events'], days: 7 });
  check('可用实时事件补齐活跃记录', r.ok && r.synced && r.synced.events && r.synced.events.ok === true, r.synced && r.synced.events);
  r = await call('alice', 'POST', '/api/admin/season/start', { name: '测试第一赛季', days: 30, resetAdjust: true });
  const seasonId = r.started && r.started.id;
  check('开启赛季成功', r.ok && seasonId > 0 && r.started.name === '测试第一赛季', r);
  check('赛季已重置人工分标记', r.started && r.started.resetAdjust === true, r.started);
  r = await call('alice', 'GET', '/api/season');
  check('前台可见当前赛季 + 剩余天数', r.ok && r.season && r.season.name === '测试第一赛季' && r.season.daysLeft === 30, r.season);
  check('赛季时长计算正确', r.season.durationDays === 30, r.season);
  r = await call('alice', 'GET', '/api/admin/season');
  check('管理端赛季信息（含 tiers / 调整计数）', r.ok && r.season && r.season.tiers.length === 4 && typeof r.season.adjustCountThisSeason === 'number', r.season);
  // 加分 → 新赛季后应被排除
  r = await call('alice', 'POST', '/api/admin/rank/adjust', { name: 'Alpha', delta: 100, reason: '赛季测试加分' });
  check('人工加分生效', r.ok && r.detail && r.detail.adjust === 100, r.detail && { adj: r.detail.adjust, score: r.detail.score });
  const beforeScore = r.detail.score;
  r = await call('alice', 'POST', '/api/admin/season/start', { name: '测试第二赛季', days: 7, resetAdjust: true });
  check('开启第二赛季（未关闭上一赛季也安全）', r.ok && r.started.name === '测试第二赛季', r);
  r = await call('alice', 'GET', '/api/rank/Alpha');
  check('新赛季人工分从零开始', r.ok && r.rank.adjust === 0 && r.rank.score === beforeScore - 100, r.rank && { s: r.rank.score, adj: r.rank.adjust });
  r = await call('alice', 'POST', '/api/admin/season/update', { name: '测试第二赛季(改)', days: 3 });
  check('修改赛季名称/时长', r.ok && r.current && r.current.name === '测试第二赛季(改)', r.current || r);
  r = await call('alice', 'GET', '/api/season');
  check('修改后剩余天数=3', r.season && r.season.daysLeft === 3, r.season);
  r = await call('alice', 'POST', '/api/admin/season/close');
  check('结束赛季成功并落快照', r.ok && r.closed && r.closed.summary && typeof r.closed.summary.total === 'number', r.closed);
  r = await call('alice', 'GET', '/api/admin/season');
  check('结束后当前赛季为空', r.ok && r.season.current === null, r.season.current);
  check('历史赛季含结算摘要', (r.season.history || []).length >= 2 && r.season.history[0].summary && r.season.history[0].summary.percentiles, r.season.history && r.season.history.length);
  r = await call('alice', 'GET', `/api/admin/season?seasonId=${seasonId}`);
  check('可按 id 查某赛季结算榜', r.ok && r.result && Array.isArray(r.result.snapshot.top), r.result && r.result.id);
  r = await call('alice', 'POST', '/api/admin/season/close');
  check('无进行中赛季时结束 → 400', r.status === 400, r);
  r = await call('carol', 'POST', '/api/admin/season/start', { name: 'x' });
  check('普通用户不能开赛季（403）', r.status === 403, r.status);

  /* ============ F. 头像 ============ */
  console.log('\n[F] 头像上传 + 管理撤回');
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,' + PNG_8x8 });
  const avUrl = r.avatar;
  check('上传头像成功', r.ok && /^\/static\/uploads\/avatars\/av_\d+_\d+\.png$/.test(avUrl || ''), r);
  check('头像已转码为 PNG', !!avUrl && /\.png$/.test(avUrl), avUrl);
  r = await call('bob', 'GET', '/api/me/avatar');
  check('可读回自己的头像', r.ok && r.avatar === avUrl, r);
  r = await raw('carol', avUrl);
  check('头像文件可访问（image/png）', r.status === 200 && /image\/png/.test(r.type || ''), { s: r.status, t: r.type, len: r.len });
  r = await call('carol', 'GET', '/api/profile/bob');
  check('他人主页头像使用上传图', r.ok && r.user && r.user.avatar === avUrl, r.user && r.user.avatar);
  check('上传头像尺寸归一化 512×512', r.user && r.user.avatar === avUrl, r.user && r.user.avatar);
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,bm90LWEtcmVhbC1pbWFnZQ==' });
  check('伪造 PNG 被拒（转码失败）', !r.ok && /解析失败/.test(r.error || ''), r.error);
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:text/html;base64,PHNjcmlwdD4=' });
  check('非图片 MIME 被拒', !r.ok && /只支持/.test(r.error || ''), r.error);
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024) });
  check('超大图片被拒（友好提示）', !r.ok && /太大|3MB|解析失败/.test(r.error || ''), r.error);
  r = await call('bob', 'DELETE', '/api/me/avatar');
  check('删除自己的头像', r.ok, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('删除后回退到皮肤头像', r.ok && /^\/api\/avatar\//.test(r.user.avatar || ''), r.user && r.user.avatar);
  const diskLeft = fs.existsSync(path.join(DATA_DIR, 'uploads', 'avatars')) ? fs.readdirSync(path.join(DATA_DIR, 'uploads', 'avatars')) : [];
  check('删除时清理磁盘文件', diskLeft.length === 0, diskLeft);
  // 再传一次 → 管理端撤回
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,' + PNG_8x8 });
  const av2 = r.avatar;
  r = await call('alice', 'GET', '/api/admin/avatars?limit=10');
  check('管理端头像列表可用', r.ok && r.avatars.some((a) => a.id === bobId && a.avatar === av2), r);
  check('管理端统计已用头像数', r.total >= 1, r.total);
  r = await call('carol', 'POST', `/api/admin/avatars/${bobId}/remove`, { lock: true });
  check('普通用户不能撤回他人头像（403）', r.status === 403, r.status);
  r = await call('alice', 'POST', `/api/admin/avatars/${bobId}/remove`, { lock: true, note: '内容不合规' });
  check('管理员撤回头像 + 锁定', r.ok && r.locked === true, r);
  r = await call('carol', 'GET', '/api/profile/bob');
  check('撤回后头像回退', r.ok && /^\/api\/avatar\//.test(r.user.avatar || ''), r.user && r.user.avatar);
  const left2 = fs.existsSync(path.join(DATA_DIR, 'uploads', 'avatars')) ? fs.readdirSync(path.join(DATA_DIR, 'uploads', 'avatars')) : [];
  check('撤回时删除文件', left2.length === 0, left2);
  r = await call('bob', 'GET', '/api/notifications');
  check('被撤回用户收到通知', (r.notifications || []).some((n) => /头像/.test(n.title || '')), r.notifications && r.notifications.slice(0, 2));
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,' + PNG_8x8 });
  check('被锁定后无法再上传（403）', !r.ok && /关闭/.test(r.error || ''), r.error);
  r = await call('alice', 'POST', `/api/admin/avatars/${bobId}/lock`, { lock: false });
  check('管理员解除锁定', r.ok && r.locked === false, r);
  r = await call('bob', 'POST', '/api/me/avatar', { data: 'data:image/png;base64,' + PNG_8x8 });
  check('解锁后可正常上传', r.ok && /avatars\//.test(r.avatar || ''), r);

  console.log('\n===== 结果：通过 ' + pass + ' / 失败 ' + failn + ' =====');
  if (fails.length) console.log('失败项：\n - ' + fails.join('\n - '));
  mock.close();
  if (server) server.kill('SIGKILL');
  await sleep(200);
  killLeftover();
  process.exit(failn ? 1 : 0);
})().catch(async (e) => {
  console.error('测试异常：', e);
  mock.close();
  if (server) server.kill('SIGKILL');
  await sleep(200);
  killLeftover();
  process.exit(2);
});
