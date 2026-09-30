'use strict';
/* v2 综合测试：段位 / 负载监控 / 品牌 Logo / 社交增强 */
const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const jars = {};
let pass = 0, fail = 0;
const ck = (n, c, extra) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  !! ' + n + (extra !== undefined ? ' | ' + JSON.stringify(extra).slice(0, 240) : '')); } };

async function call(who, method, path, body) {
  const init = { method, headers: { ...(jars[who] ? { Cookie: jars[who] } : {}) } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, init);
  const sc = r.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: r.status, raw: (await r.arrayBuffer()).byteLength, ct };
  return { status: r.status, ...(await r.json()) };
}

(async () => {
  console.log('=== 账号 ===');
  let r = await call('admin', 'POST', '/api/auth/register', { username: 'alice', password: 'pass1234' });
  r = await call('admin', 'POST', '/api/auth/login', { username: 'alice', password: 'pass1234' });
  ck('owner 登录', r.ok, r);
  r = await call('bob', 'POST', '/api/auth/register', { username: 'bob', password: 'pass1234' });
  r = await call('bob', 'POST', '/api/auth/login', { username: 'bob', password: 'pass1234' });
  ck('bob 登录', r.ok, r);
  r = await call('carol', 'POST', '/api/auth/register', { username: 'carol', password: 'pass1234' });
  r = await call('carol', 'POST', '/api/auth/login', { username: 'carol', password: 'pass1234' });
  ck('carol 登录', r.ok, r);

  console.log('\n=== 品牌 Logo（#3）===');
  r = await call('admin', 'GET', '/api/brand');
  ck('品牌公开接口', r.ok && !!r.brand.title && ['rounded', 'square', 'circle'].includes(r.brand.shape), r.brand);
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex').toString('base64');
  r = await call('bob', 'POST', '/api/admin/brand/logo', { kind: 'light', data: png });
  ck('普通用户不能上传 Logo（403）', r.status === 403, r.status);
  r = await call('admin', 'POST', '/api/admin/brand/logo', { kind: 'light', data: png, filename: 'logo.png' });
  ck('上传亮色 Logo', r.ok && r.brand.logoLight && r.brand.logoLight.startsWith('/brand/logo-light-'), r.brand);
  const lightUrl = r.brand.logoLight;
  r = await call('admin', 'POST', '/api/admin/brand/logo', { kind: 'dark', data: png });
  ck('上传暗色 Logo', r.ok && r.brand.logoDark, r.brand);
  r = await call('admin', 'GET', lightUrl);
  ck('Logo 可访问且为 PNG', r.status === 200 && r.ct.includes('image/png') && r.raw > 0, r);
  r = await call('admin', 'POST', '/api/admin/brand/logo', { kind: 'light', data: 'data:text/html;base64,PGI+' });
  ck('非法类型被拒', r.status === 400 && /不支持/.test(r.error), r.error);
  r = await call('admin', 'POST', '/api/admin/brand/logo', { kind: 'light', data: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>').toString('base64') });
  ck('SVG 带脚本被拒', r.status === 400 && /脚本/.test(r.error), r.error);
  r = await call('admin', 'POST', '/api/admin/brand/style', { shape: 'circle', size: 40, title: '同禾境 MC', sub: 'TONG HE JING' });
  ck('样式保存', r.ok && r.brand.shape === 'circle' && r.brand.size === 40 && r.brand.title === '同禾境 MC', r.brand);
  r = await call('admin', 'GET', '/brand/../server.js');
  ck('路径穿越被拒', r.status === 404, r.status);

  console.log('\n=== 负载监控（#3）===');
  r = await call('bob', 'GET', '/api/admin/metrics');
  ck('普通用户无权查看（403）', r.status === 403, r.status);
  r = await call('admin', 'GET', '/api/admin/metrics?hours=1');
  const m = r.metrics || {};
  ck('管理员可看负载', r.ok && !!m.process && !!m.system && !!m.http, Object.keys(m));
  ck('进程指标完整', typeof m.process.cpuPercent === 'number' && m.process.rssMb > 0 && m.process.loopLagP95 >= 0, m.process);
  ck('系统指标完整（4核/内存/负载）', m.system.cores >= 1 && m.system.memTotalMb > 0 && typeof m.system.load1 === 'number', m.system);
  ck('磁盘指标可用', !!m.disk && m.disk.percent >= 0, m.disk);
  ck('HTTP 指标（请求数/分位）', m.http.requests > 0 && m.http.p50 >= 0 && m.http.perMin >= 0, m.http);
  ck('告警列表存在', Array.isArray(r.alerts) && r.alerts.length >= 1, r.alerts);
  ck('历史数组存在', Array.isArray(r.history), r.history && r.history.length);
  r = await call('admin', 'POST', '/api/admin/metrics/rcon-test');
  ck('RCON 测试失败时优雅返回', r.status === 500 && /RCON/.test(r.error), r.error);

  console.log('\n=== 段位系统（#5）===');
  r = await call('bob', 'GET', '/api/rank/board?limit=5');
  ck('段位榜公开可读（含真实玩家）', r.ok && Array.isArray(r.board) && r.board.length >= 4 && r.tiers.length === 4, { n: r.board && r.board.length, tiers: r.tiers && r.tiers.map((t) => t.key) });
  ck('段位榜含分项分数与配置', r.board.every((b) => b.score >= 0 && b.tier && b.hours >= 0), r.board[0]);
  ck('段位档位顺序 S/A/B/C', r.tiers.map((t) => t.key).join('') === 'SABC', r.tiers && r.tiers.map((t) => t.key));
  r = await call('bob', 'GET', '/api/rank/notexist123');
  ck('不存在的玩家返回 404', r.status === 404, r.status);
  r = await call('bob', 'GET', '/api/me/rank');
  ck('未绑定玩家 /me/rank 返回 bound:false', r.ok && r.bound === false, r);
  r = await call('bob', 'POST', '/api/admin/rank/adjust', { name: 'shangzhan', delta: 20, reason: '测试' });
  ck('普通用户不能加减分（403）', r.status === 403, r.status);
  r = await call('admin', 'POST', '/api/admin/rank/adjust', { name: 'shangzhan', delta: 20, reason: '新人生存活动奖励' });
  ck('管理员加分段位生效', r.ok && r.detail && r.detail.adjust === 20, r.detail && { score: r.detail.score, adjust: r.detail.adjust });
  r = await call('admin', 'GET', '/api/rank/shangzhan');
  ck('玩家段位详情可读（含分项）', r.ok && r.rank.components && r.rank.components.parts && Object.keys(r.rank.components.parts).length >= 12, Object.keys(r.rank.components.parts || {}).length);
  ck('详情含段位与百分位', !!r.rank.tier.key && r.rank.percentile != null && r.rank.position >= 1, { t: r.rank.tier, p: r.rank.percentile });
  r = await call('admin', 'GET', '/api/admin/rank');
  ck('管理端段位页（含分布与权重）', r.ok && r.stats.weights && r.stats.tiers && r.stats.distribution, Object.keys(r.stats));
  r = await call('admin', 'POST', '/api/admin/rank/settings', { weights: { economy: 0 }, tiers: [{ key: 'S', label: 'S 段', min: 600, color: '#f59e0b' }, { key: 'A', label: 'A 段', min: 450, color: '#8b5cf6' }, { key: 'B', label: 'B 段', min: 250, color: '#3b82f6' }, { key: 'C', label: 'C 段', min: 0, color: '#94a3b8' }] });
  ck('段位参数可调', r.ok && r.settings.weights.economy === 0 && r.settings.tiers[0].min === 600, r.settings);
  r = await call('admin', 'POST', '/api/admin/rank/settings', { weights: { economy: 90 }, tiers: [{ key: 'S', label: 'S 段', min: 720, color: '#f59e0b' }, { key: 'A', label: 'A 段', min: 540, color: '#8b5cf6' }, { key: 'B', label: 'B 段', min: 340, color: '#3b82f6' }, { key: 'C', label: 'C 段', min: 0, color: '#94a3b8' }] });
  ck('恢复默认段位参数', r.ok && r.settings.tiers[0].min === 720, r.settings);
  r = await call('admin', 'POST', '/api/admin/rank/recompute');
  ck('手动重算成功', r.ok && r.result.total >= 1, r.result);
  r = await call('admin', 'POST', '/api/admin/rank/sync', { targets: ['punish', 'economy'] });
  ck('外部数据同步失败不崩（无 SFTP）', r.ok && r.synced.punish.ok === false && r.synced.economy.ok === false, r.synced);
  const adjId = (await call('admin', 'POST', '/api/admin/rank/adjust', { name: 'shangzhan', delta: -5, reason: '临时' })).detail.adjustments[0];
  r = await call('admin', 'POST', '/api/admin/rank/adjust/remove', { id: 1 });
  ck('可撤销加减分记录', r.ok && r.removed.delta === 20, r.removed);

  console.log('\n=== 社交增强（#4）===');
  r = await call('admin', 'POST', '/api/follow/bob');
  ck('关注成功', r.ok && r.following === true && r.followers === 1, r);
  r = await call('admin', 'GET', '/api/follow/bob');
  ck('关注状态可查', r.ok && r.isFollowing === true && r.followers === 1, r);
  r = await call('bob', 'GET', '/api/follow/alice');
  ck('可看到对方关注了我', r.ok && r.followsMe === true, r);
  r = await call('bob', 'POST', '/api/follow/bob');
  ck('不能关注自己', r.status === 400, r.error);
  r = await call('admin', 'POST', '/api/follow/bob');
  ck('再次点击取消关注', r.ok && r.following === false, r);
  await call('admin', 'POST', '/api/follow/bob');

  // 帖子 + 盖楼 + @提及 + 收藏
  r = await call('carol', 'POST', '/api/forum/threads', { board: 'general', title: '测试帖子 @alice', body: '你好 @alice 这是内容' });
  ck('发帖成功', r.ok && r.id, r);
  const tid = r.id;
  r = await call('bob', 'GET', '/api/forum/thread/' + tid);
  ck('帖子可读', r.ok, r.status);
  r = await call('bob', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '一层回复 @carol' });
  ck('盖楼回复成功', r.ok && r.id, r);
  const firstReply = r.id;
  r = await call('admin', 'POST', '/api/forum/thread/' + tid + '/reply2', { body: '楼中楼回复', replyTo: firstReply });
  ck('楼中楼（replyTo）成功', r.ok && r.replyTo === firstReply, r);
  r = await call('admin', 'GET', '/api/notifications/grouped');
  const allKinds = Object.values(r.groups || {}).flat().map((x) => x.kind);
  ck('@提及产生通知（发帖正文）', allKinds.includes('mention'), allKinds);
  r = await call('carol', 'GET', '/api/notifications/grouped');
  const carolKinds = Object.values(r.groups || {}).flat().map((x) => x.kind);
  ck('帖子回复产生通知（作者）', carolKinds.includes('forum_reply'), carolKinds);
  ck('楼中楼/回帖 @提及 通知', carolKinds.includes('mention'), carolKinds);
  ck('通知分类分组存在', !!(r.groups && r.groups.interaction && r.groups.system), Object.keys(r.groups || {}));
  r = await call('admin', 'POST', '/api/collect/thread/' + tid);
  ck('收藏帖子', r.ok && r.collected === true, r);
  r = await call('admin', 'GET', '/api/me/collections');
  ck('收藏列表可查', r.ok && r.items.length === 1 && r.items[0].title.includes('测试帖子'), r.items);
  r = await call('admin', 'POST', '/api/collect/thread/' + tid);
  ck('取消收藏', r.ok && r.collected === false, r);

  // 留言板
  r = await call('bob', 'POST', '/api/guestbook/carol', { body: '空间留言第一条' });
  ck('留言成功', r.ok && r.id, r);
  r = await call('admin', 'POST', '/api/guestbook/carol', { body: '回复 @bob 的留言', replyTo: 1 });
  ck('留言回复成功', r.ok, r);
  r = await call('bob', 'GET', '/api/guestbook/carol');
  ck('留言板可读（含作者信息）', r.ok && r.entries.length === 2 && r.total === 2 && r.entries[0].author.username, r.entries);
  r = await call('carol', 'DELETE', '/api/guestbook/1');
  ck('留言板主人可删留言', r.ok, r);
  r = await call('bob', 'GET', '/api/guestbook/carol');
  ck('删除后数量减少', r.ok && r.total === 1, r.total);

  // 动态流
  r = await call('bob', 'GET', '/api/feed?scope=mine');
  ck('动态流（我的）', r.ok && r.items.length >= 1 && r.items[0].link, r.items && r.items.length);
  r = await call('bob', 'GET', '/api/feed?scope=following');
  ck('动态流（关注+好友）', r.ok && Array.isArray(r.items), r.items && r.items.length);
  r = await call('bob', 'GET', '/api/feed?scope=all');
  ck('动态流（全站）', r.ok && r.items.length >= 2, r.items && r.items.length);

  // 空间聚合
  r = await call('bob', 'GET', '/api/space/carol');
  ck('空间聚合：访问量/关注/粉丝/留言/发帖', r.ok && r.views >= 1 && r.followers >= 0 && r.threads.length >= 1 && r.guestbookCount >= 1, { views: r.views, threads: r.threads.length, gb: r.guestbookCount });
  ck('空间含获赞数', typeof r.likesReceived === 'number', r.likesReceived);
  r = await call('bob', 'GET', '/api/space/carol');
  ck('再次访问访问量递增', r.views === 2, r.views);

  // 私信增强
  r = await call('admin', 'POST', '/api/dm/2', { text: '私信撤回测试' });
  ck('发私信', r.ok && r.message && r.message.id, r);
  const dmId = r.message.id;
  r = await call('admin', 'POST', '/api/dm/2/revoke', { messageId: dmId });
  ck('2 分钟内可撤回', r.ok && r.revoked, r);
  r = await call('bob', 'POST', '/api/dm/1/revoke', { messageId: dmId });
  ck('不能撤回他人消息', r.status === 403, r.error);
  r = await call('admin', 'POST', '/api/dm/2/pin', { value: true });
  ck('会话置顶', r.ok && r.pinned === true, r);
  r = await call('admin', 'POST', '/api/dm/2/mute', { value: true });
  ck('会话免打扰', r.ok && r.muted === true, r);
  r = await call('admin', 'GET', '/api/dm/2/meta');
  ck('会话元数据可读', r.ok && r.meta.pinned === true && r.meta.muted === true && !!r.peer, r.meta);
  r = await call('admin', 'POST', '/api/dm/2/read');
  ck('标记已读', r.ok, r);
  r = await call('bob', 'POST', '/api/dm/1/read');
  ck('对方标记已读（触发回执）', r.ok, r);

  // 通知已读
  r = await call('admin', 'POST', '/api/notifications/read-all');
  ck('全部已读', r.ok && r.marked >= 0, r);
  r = await call('admin', 'GET', '/api/notifications/grouped?unread=1');
  ck('未读筛选后为 0', r.ok && r.unread === 0, r.unread);

  // 好友增强
  r = await call('bob', 'POST', '/api/friends/request', { username: 'carol' });
  ck('好友申请', r.ok, r);
  r = await call('carol', 'GET', '/api/friends');
  const reqId = (r.incoming || [])[0] && r.incoming[0].id;
  r = await call('carol', 'POST', '/api/friends/accept', { userId: reqId });
  ck('接受好友', r.ok, r);
  const carolId = (await call('bob', 'GET', '/api/profile/carol')).user.id;
  r = await call('bob', 'POST', '/api/friends/' + carolId + '/meta', { remark: '阿卡', group: '现实朋友' });
  ck('好友备注/分组', r.ok && r.remark === '阿卡' && r.group === '现实朋友', r);
  r = await call('bob', 'GET', '/api/friends/enriched');
  ck('好友增强列表（备注/分组/在线）', r.ok && r.friends.length >= 1 && r.friends.some((f) => f.remark === '阿卡') && r.groups.includes('现实朋友'), r.friends);
  ck('好友列表含在线与最近上线字段', r.friends.every((f) => 'online' in f && 'lastSeen' in f), r.friends[0]);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试崩溃:', e); process.exit(2); });
