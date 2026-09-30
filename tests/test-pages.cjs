'use strict';
/* 页面渲染冒烟：所有页面 200 + 关键内容存在 */
const BASE = process.env.BASE || 'http://127.0.0.1:8793';
let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  !! ' + n + ' | ' + String(extra).slice(0, 160)); } };
const get = async (p) => {
  const r = await fetch(BASE + p);
  const body = await r.text();
  return { code: r.status, body, len: body.length };
};
(async () => {
  const pages = [
    ['/', ['同禾境', 'id="tierTopBox"', 'id="myTierCard"'], []],
    ['/feed', ['社区动态', 'feedTabs'], []],
    ['/rank', ['段位榜', 'loadTier', 'id="tierBar"'], []],
    ['/forum', [], []],
    ['/chat', ['dmTyping', 'btnPin'], []],
    ['/friends', ['data-meta'], []],
    ['/pay', [], []],
    ['/me', ['我的段位', 'rankCard', 'id="socialStats"'], []],
    ['/login', [], []],
    ['/p/player_owner', ['tierBadge', 'data.tier'], []],
    ['/u/bob', ['tierSlot', 'gbCard', 'followBtn'], []],
  ];
  console.log('=== 页面 ===');
  for (const [p, must] of pages) {
    const r = await get(p);
    const missing = must.filter((m) => !r.body.includes(m));
    ck(p + ' (' + r.len + 'B)', r.code === 200 && !missing.length, missing.length ? '缺少: ' + missing.join(', ') : 'HTTP ' + r.code);
  }
  console.log('=== 静态资源 ===');
  for (const [p, must] of [['/app.js', ['tierBadge', 'paintBrand', 'mentionHtml']], ['/style.css', ['.tier-badge', '.feed-item', '.gb-item', '.metric-card', '.logo-img']]]) {
    const r = await get(p);
    const missing = must.filter((m) => !r.body.includes(m));
    ck(p + ' (' + Math.round(r.len / 1024) + 'KB)', r.code === 200 && !missing.length, missing.join(', '));
  }
  console.log('=== 接口 ===');
  const apis = [
    ['/api/brand', 200], ['/api/rank/board?limit=3', 200], ['/api/rank/player_owner', 200],
    ['/api/health', 200], ['/api/tiers', 200], ['/api/pay/info', 200],
    ['/api/admin/metrics', 401], ['/api/admin/rank', 401], ['/api/admin/brand', 401],
    ['/api/feed?scope=all', 200], ['/api/space/bob', 0], ['/api/guestbook/bob', 0], // 0 = 本地夹具用户，生产 404 也视为通过
  ];
  for (const [p, code] of apis) {
    const r = await fetch(BASE + p);
    ck(p, code === 0 ? (r.status === 200 || r.status === 404) : r.status === code, 'HTTP ' + r.status + ' 期望 ' + code);
  }
  { const r = await fetch(BASE + '/api/collect/thread/1', { method: 'POST' }); ck('POST /api/collect/thread/1 未登录 401', r.status === 401, 'HTTP ' + r.status); }
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e); process.exit(2); });
