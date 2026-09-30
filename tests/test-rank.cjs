'use strict';
/* 段位系统：公式校准 + 功能自测（用真实服务器数据量级） */
process.env.DATA_DIR = process.env.DATA_DIR || '/tmp/mcwrank';
const { db } = require('/workspace/mcweb/lib/db');
const rank = require('/workspace/mcweb/lib/rank');

let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  !! ' + n + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); } };

const now = Date.now();
const mk = (name, p) => db.prepare('INSERT OR REPLACE INTO stats_cache (uuid,name,playtime_ticks,level,blocks_placed,blocks_mined,blocks_crafted,items_used,advances,leave_count,deaths,mob_kills,player_kills,distance_cm,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(name, name, p.h * 72000, p.lv || 50, p.placed, p.mined, p.crafted, p.used || 0, p.adv || 60, p.sess, 5, 10, 1, 0, now);

mk('Ian', { h: 439, placed: 354835, mined: 2688720, crafted: 411603, sess: 447, lv: 1486, adv: 73 });
mk('zaoren', { h: 394, placed: 284110, mined: 242302, crafted: 510659, sess: 408, lv: 42, adv: 67 });
mk('leonnb', { h: 458, placed: 68940, mined: 95520, crafted: 116495, sess: 464, lv: 74, adv: 65 });
mk('huang_123', { h: 254, placed: 44325, mined: 52614, crafted: 170907, sess: 246, lv: 57, adv: 69 });
mk('xiaobai', { h: 3, placed: 120, mined: 80, crafted: 20, sess: 5, lv: 3, adv: 8 });
mk('griefer', { h: 120, placed: 20000, mined: 15000, crafted: 9000, sess: 90, lv: 20, adv: 30 });

const pun = db.prepare('INSERT INTO punishments (ext_id,mc_name,kind,reason,operator,start_at,end_at,history,weight,fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
for (const [k, w, d] of [['BAN', 60, 3], ['TEMP_BAN', 30, 10], ['WARNING', 6, 20], ['TEMP_WARNING', 6, 25]])
  pun.run(Math.floor(Math.random() * 1e9), 'griefer', k, '破坏地形', 'player_owner', now - d * 86400000, -1, 1, w, now);
for (let i = 0; i < 900; i++) pun.run(i, 'leonnb', 'KICK', '未登录', null, now - 1000 * i, -1, 1, 0, now);
for (let i = 0; i < 14; i++)
  db.prepare('INSERT OR REPLACE INTO play_days (mc_name,day,sessions,seconds,source,updated_at) VALUES (?,?,?,?,?,?)')
    .run(i < 12 ? 'Ian' : 'leonnb', new Date(now - i * 86400000).toISOString().slice(0, 10), 1, 3600, 'log', now);
for (const [n, b] of [['Ian', 89566506], ['zaoren', 3195059], ['leonnb', 500000], ['huang_123', 4138], ['xiaobai', 100]])
  db.prepare('INSERT OR REPLACE INTO economy (name,uuid,balance,fetched_at) VALUES (?,?,?,?)').run(n, null, b, now);
db.prepare("INSERT OR REPLACE INTO users (id,username,pass_hash,role,created_at) VALUES (1,'Ian','x','user',?)").run(now);
db.prepare("INSERT OR REPLACE INTO bindings (user_id,mc_name,created_at) VALUES (1,'Ian',?)").run(now);
for (let i = 0; i < 6; i++) db.prepare("INSERT INTO forum_threads (board,user_id,title,body,created_at) VALUES ('general',1,'t','b',?)").run(now);
for (let i = 0; i < 12; i++) db.prepare("INSERT INTO chat_log (ts,player,message,kind) VALUES (?,'Ian','hi','game')").run(now);

console.log('=== 全量重算 ===');
const r = rank.computeAll();
ck('重算覆盖全部玩家', r.total === 6, r);
ck('返回数据源可用标记', !!r.sources && r.sources.playDays === true, r.sources);

console.log('\n=== 分数分布（真实数据量级）===');
console.log('  名次 玩家        分数 段位 基础 违规扣  活跃/建造/社区/经济 分量');
for (const b of rank.board({ limit: 10 }).board) {
  const d = rank.detail(b.name);
  const p = d.components.parts;
  const sum = (ks) => Math.round(ks.reduce((a, k) => a + p[k].got, 0));
  console.log('   ' + String(b.pos).padStart(2) + '  ' + b.name.padEnd(12) + String(b.score).padStart(4) + '  ' + b.tier.key + '  ' + String(d.base).padStart(4) + '  ' + String(d.components.penalty).padStart(5) + '   ' +
    sum(['playtime', 'recency', 'sessions']) + '/' + sum(['placed', 'mined', 'crafted', 'advances']) + '/' + sum(['forum', 'likes', 'chat', 'friends']) + '/' + sum(['economy']));
}

console.log('\n=== 校验 ===');
const ian = rank.detail('Ian');
ck('Ian 排名第一', ian.position === 1, ian.position);
ck('Ian 百分位 100%', ian.percentile === 100, ian.percentile);
ck('击杀/挂机刷时长没有扭曲分数（Ian 1486 级未溢出）', ian.score <= 1000 && ian.base <= 1000, { s: ian.score, b: ian.base });
const leo = rank.detail('leonnb');
ck('900 条 KICK 不计违规', leo.components.penalty === 0, leo.components.penalty);
ck('违规扣分公式生效（griefer 被封禁）', rank.detail('griefer').components.penalty > 60, rank.detail('griefer').components.penalty);
ck('违规扣分有上限 ≤300', rank.detail('griefer').components.penalty <= 300, rank.detail('griefer').components.penalty);
const xb = rank.detail('xiaobai');
ck('新手段位最低', xb.tier.key === 'C', xb.tier);
ck('新手分数远低于老玩家', xb.score < rank.detail('huang_123').score, { xb: xb.score, h: rank.detail('huang_123').score });
ck('段位分层不塌陷（不同玩家段位有差异）', new Set(rank.board({ limit: 10 }).board.map((b) => b.tier.key)).size >= 2, rank.board({ limit: 10 }).board.map((b) => b.tier.key));

console.log('\n=== 管理加减分 ===');
const a1 = rank.adjust({ name: 'xiaobai', delta: 50, reason: '新人生存活动奖励', operatorName: 'player_owner' });
ck('加分写入并立即生效', a1.score === xb.score + 50, { before: xb.score, after: a1.score });
ck('调整历史可查', a1.adjustments.length === 1 && a1.adjustments[0].delta === 50, a1.adjustments);
const a2 = rank.adjust({ name: 'griefer', delta: -80, reason: '活动期间破坏他人建筑', operatorName: 'player_owner', kind: 'event' });
ck('扣分生效', a2.adjust === -80, a2.adjust);
const adjId = db.prepare('SELECT id FROM rank_adjust ORDER BY id DESC LIMIT 1').get().id;
rank.removeAdjust(adjId);
ck('撤销调整后分数回滚', rank.detail('griefer').adjust === 0, rank.detail('griefer').adjust);
let threw = false;
try { rank.adjust({ name: 'x', delta: 0 }); } catch { threw = true; }
ck('非法分差被拒绝', threw);
let threw2 = false;
try { rank.adjust({ name: 'x', delta: 9999 }); } catch { threw2 = true; }
ck('超限分差被拒绝', threw2);

console.log('\n=== 参数可调 ===');
const sp = rank.settingsPatch({ weights: { economy: 0, placed: 200 }, tiers: [{ key: 'S', label: 'S 段', min: 700 }, { key: 'A', label: 'A 段', min: 500 }, { key: 'B', label: 'B 段', min: 300 }, { key: 'C', label: 'C 段', min: 0 }] });
ck('权重修改生效', sp.weights.economy === 0 && sp.weights.placed === 200, sp.weights);
ck('段位阈值修改生效', sp.tiers[0].min === 700, sp.tiers);
const r2 = rank.computeAll();
ck('改权重重算不报错', r2.total === 6);
rank.settingsPatch({ weights: rank.DEFAULT_WEIGHTS, tiers: rank.DEFAULT_TIERS });
ck('恢复默认成功', rank.weights().placed === 160 && rank.tiers()[0].min === 720, null);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
