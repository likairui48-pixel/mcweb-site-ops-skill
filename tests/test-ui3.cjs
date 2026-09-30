'use strict';
/* v3 UI + 新功能前端挂点检查（跑在本地或生产 BASE 上） */
const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => { if (c) { pass++; console.log('  OK  ' + n); } else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 180) : '')); } };
const get = async (p) => { const r = await fetch(BASE + p); return { code: r.status, body: await r.text() }; };

(async () => {
  console.log('=== v3 设计系统（style.css） ===');
  const css = await get('/style.css');
  ck('style.css 200', css.code === 200, css.code);
  for (const tok of ['--line:', '--brand-grad', '--gold:', '--r-lg:', '--fs-md:', '--sh-2:', '--ring:']) {
    ck('令牌 ' + tok, css.body.includes(tok));
  }
  for (const cls of ['.avatar-up', '.curve-bars', '.curve-bar', '.season-top', '.season-bar', '.evi-b', '.src-tag.ingame', '.quota-bar', '.chip', '.table-scroll', 'label.switch', ':focus-visible', 'prefers-reduced-motion']) {
    ck('组件 ' + cls, css.body.includes(cls));
  }
  ck('暗色主题令牌齐全', /html\[data-theme="dark"\]/.test(css.body) && css.body.includes('--surface-3'));
  ck('旧类名未被删（side-link/thread-row/chat-body）', ['.side-link', '.thread-row', '.chat-body', '.tier-badge', '.metric-card', '.feed-item', '.gb-item'].every((x) => css.body.includes(x)));

  console.log('\n=== app.js ===');
  const app = await get('/app.js');
  for (const icon of ["unlock:", "'gamepad-2':", "quote:", "'file-text':", "'trash-2':", "'alert-triangle':", "calendar:"]) {
    ck('图标 ' + icon, app.body.includes(icon));
  }
  ck('头像优先使用上传图', /else if \(user\.avatar\) url = user\.avatar;/.test(app.body));
  ck('头像地址兼容（字符串/对象/未知）', /typeof user === 'string'/.test(app.body) && /else if \(user\.username\) url/.test(app.body) && /\/api\/avatar\/unknown\?size=/.test(app.body));
  ck('服务端下发的头像地址缺尺寸会自动补上', /url\.indexOf\('\/api\/avatar\/'\) === 0 && url\.indexOf\('\?'\) < 0/.test(app.body));

  console.log('\n=== 我的头像（me.html） ===');
  const me = await get('/me');
  ck('/me 200', me.code === 200, me.code);
  ck('头像卡存在', me.body.includes('id="avatarCard"'));
  ck('上传交互存在', me.body.includes('function initAvatar') && me.body.includes('/api/me/avatar'));
  ck('支持删除头像', me.body.includes("method: 'DELETE'") || me.body.includes('method: "DELETE"'));
  ck('锁定态提示', me.body.includes('上传已被管理员关闭'));

  console.log('\n=== 段位曲线 + 赛季（rank.html） ===');
  const rk = await get('/rank');
  ck('/rank 200', rk.code === 200, rk.code);
  ck('曲线容器存在', rk.body.includes('id="rankInsight"'));
  ck('调用 /api/rank/curve', rk.body.includes('/api/rank/curve'));
  ck('绘制直方图与分项均值', rk.body.includes('curve-bars') && rk.body.includes('compName'));
  ck('赛季信息调用 /api/season', rk.body.includes('/api/season'));
  ck('百分位展示', rk.body.includes('p99'));

  console.log('\n=== 后台（admin.html） ===');
  const ad = await get('/admin');
  ck('/admin 200', ad.code === 200, ad.code);
  ck('头像与主页背景合并 tab', ad.body.includes("['avatars', '头像与主页背景']") && ad.body.includes('async function tabAvatars') && ad.body.includes('/api/admin/backgrounds') && ad.body.includes('data-bgrm'));
  ck('举报来源筛选', ad.body.includes('data-src') && ad.body.includes('repSource'));
  ck('举报证据块', ad.body.includes('evidenceBlock') && ad.body.includes('evi-b'));
  ck('取证时间窗口可调', ad.body.includes('data-min') && ad.body.includes('/refetch'));
  ck('AI 额度卡', ad.body.includes('aiQuotaHtml') && ad.body.includes('id="aiPerMin"') && ad.body.includes('id="aiPerDay"'));
  ck('AI 调用记录表', ad.body.includes('最近调用记录') && ad.body.includes('prompt_tokens'));
  ck('赛季设置卡', ad.body.includes('seasonCardHtml') && ad.body.includes('wireSeason(tabRanks)') && ad.body.includes('/api/admin/season/start'));
  ck('段位 tab 含赛季', ad.body.includes('${seasonCardHtml(sj && sj.season)}'));

  console.log('\n=== 举报入口提示 ===');
  const chat = await get('/chat');
  ck('/chat 含游戏内举报说明', chat.code === 200 && chat.body.includes('!report 玩家名 原因'));
  const fo = await get('/forum');
  ck('/forum 含举报说明', fo.code === 200 && fo.body.includes('!report 玩家名 原因'));

  console.log('\n=== 关键接口 ===');
  const curve = await get('/api/rank/curve');
  ck('/api/rank/curve 200 且含 buckets/tiers', curve.code === 200 && curve.body.includes('"buckets"') && curve.body.includes('"percentiles"'), curve.code);
  const sea = await get('/api/season');
  ck('/api/season 200', sea.code === 200 && sea.body.includes('"season"'), sea.code);
  const av = await get('/api/admin/avatars');
  ck('/api/admin/avatars 未登录 401', av.code === 401, av.code);
  const ai = await get('/api/admin/ai/usage');
  ck('/api/admin/ai/usage 未登录 401', ai.code === 401, ai.code);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
