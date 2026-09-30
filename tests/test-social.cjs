'use strict';
const http = require('http');
const PORT = 8790;
const jars = {};

function req(who, path, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (jars[who]) headers['Cookie'] = jars[who];
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: method || 'GET', headers }, (res) => {
      const sc = res.headers['set-cookie'];
      if (sc) jars[who] = sc.map((c) => c.split(';')[0]).join('; ');
      const ch = [];
      res.on('data', (d) => ch.push(d));
      res.on('end', () => {
        const txt = Buffer.concat(ch).toString('utf8');
        let j = null;
        try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 100) }; }
        resolve({ code: res.statusCode, j });
      });
    });
    r.on('error', (e) => resolve({ code: 0, j: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

const log = (label, r, extra) => {
  const good = r.j && r.j.ok !== false;
  console.log(`  ${good ? '✅' : '❌'} ${label.padEnd(38)} ${r.code} ${extra !== undefined ? JSON.stringify(extra).slice(0, 90) : (r.j && r.j.error ? r.j.error : '')}`);
  return r.j;
};

(async () => {
  console.log('=== 账号 ===');
  let r = await req('a', '/api/auth/register', 'POST', { username: 'alice', password: 'pass1234', qq: '111' });
  const alice = log('注册 alice（首个用户应为管理员）', r, { admin: r.j.user && r.j.user.isAdmin });
  if (!alice.user) return;
  r = await req('b', '/api/auth/register', 'POST', { username: 'bob', password: 'pass1234' });
  const bob = log('注册 bob', r, { admin: r.j.user && r.j.user.isAdmin });
  await req('a', '/api/auth/login', 'POST', { username: 'alice', password: 'pass1234' });
  await req('b', '/api/auth/login', 'POST', { username: 'bob', password: 'pass1234' });
  log('alice 登录', { j: { ok: true } });
  log('bob 登录', { j: { ok: true } });

  console.log('=== 个人资料 ===');
  r = await req('a', '/api/profile', 'POST', { bio: '我是服主 Alice，喜欢建筑', tags: ['建筑师', '服主'], bg: 'g1' });
  log('保存资料（签名/标签/背景）', r);
  r = await req('a', '/api/profile/alice');
  log('查看 alice 主页数据', r, { bio: (r.j.profile || {}).bio, tags: (r.j.profile || {}).tags });
  r = await req('a', '/api/profile/alice', 'POST', { bio: 'x' });
  log('未登录攻击：/api/profile 无鉴权被拒', r);

  console.log('=== 好友 ===');
  r = await req('a', '/api/friends/request', 'POST', { username: 'bob' });
  log('alice 加 bob 为好友', r, { status: r.j.status });
  r = await req('b', '/api/friends');
  log('bob 看到待处理申请', r, { incoming: (r.j.incoming || []).length });
  r = await req('b', '/api/friends/accept', 'POST', { userId: alice.user.id });
  log('bob 同意申请', r);
  r = await req('a', '/api/friends');
  log('alice 好友列表', r, { friends: (r.j.friends || []).map((f) => f.username) });
  r = await req('a', '/api/friends/request', 'POST', { userId: alice.user.id });
  log('加自己为好友应被拒', r);

  console.log('=== 私聊 ===');
  r = await req('a', '/api/dm/' + bob.user.id, 'POST', { text: '你好，欢迎来到同禾境！' });
  log('alice 私信 bob', r, { id: r.j.message && r.j.message.id });
  r = await req('b', '/api/dm/' + alice.user.id);
  log('bob 拉取会话', r, { count: (r.j.messages || []).length });
  r = await req('b', '/api/dm/conversations');
  log('bob 会话列表', r, { convs: (r.j.conversations || []).length, unread: r.j.totalUnread });
  r = await req('b', '/api/dm/' + bob.user.id, 'POST', { text: '自己发给自己' });
  log('非好友/自己发私信应被拒', r);

  console.log('=== 论坛 ===');
  r = await req('a', '/api/forum/boards');
  log('版块列表', r, { boards: (r.j.boards || []).length });
  r = await req('a', '/api/forum/threads', 'POST', { board: 'general', title: '欢迎来到同禾境！', body: '这里是我们的社区论坛，请大家友善发言。' });
  const tid = r.j.id;
  log('alice 发帖', r, { id: tid });
  r = await req('b', '/api/forum/thread/' + tid + '/reply', 'POST', { body: '前排支持！' });
  log('bob 回帖', r);
  r = await req('b', '/api/forum/like', 'POST', { kind: 'thread', id: tid });
  log('bob 点赞帖子', r, { liked: r.j.liked, likes: r.j.likes });
  r = await req('a', '/api/forum/thread/' + tid);
  log('读取帖子详情', r, { 标题: r.j.thread && r.j.thread.title, 回复数: (r.j.posts || []).length });
  r = await req('a', '/api/forum/threads?size=5');
  log('帖子列表', r, { 条数: (r.j.threads || []).length, 总数: r.j.total });

  console.log('=== 举报 + AI ===');
  r = await req('b', '/api/report/reasons');
  log('举报理由列表', r, { 数量: (r.j.reasons || []).length });
  r = await req('b', '/api/reports', 'POST', { targetType: 'thread', targetId: String(tid), reason: '刷屏 / 广告 / 拉人', detail: '测试举报' });
  const rid = r.j.id;
  log('bob 举报帖子', r, { id: rid });
  r = await req('a', '/api/admin/reports?status=open');
  log('管理员查看举报', r, { 条数: (r.j.reports || []).length, AI: r.j.ai });
  r = await req('a', '/api/admin/ai', 'POST', { enabled: true, auto: false, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', rules: '禁止广告', key: 'sk-test-key-1234567890' });
  log('保存 AI 配置', r, { enabled: r.j.ai.enabled, keyMasked: r.j.ai.keyMasked });
  r = await req('a', '/api/admin/ai/test', 'POST');
  log('AI 连通性测试（预期失败：假 key）', r);
  r = await req('a', '/api/admin/reports/' + rid + '/handle', 'POST', { status: 'resolved', action: 'none', note: '测试处理' });
  log('处理举报', r, { result: r.j.actionResult });
  r = await req('b', '/api/admin/reports');
  log('普通用户访问后台应被拒', r);

  console.log('=== 会员 ===');
  r = await req('a', '/api/tiers');
  log('档位列表', r, { 档位: (r.j.tiers || []).map((t) => t.label) });
  r = await req('a', '/api/admin/grant-membership', 'POST', { userId: bob.user.id, tier: 'hefeng', days: 30, note: '测试发放' });
  log('给 bob 发放禾风 VIP', r, { expires: r.j.expires ? new Date(r.j.expires).toLocaleDateString('zh-CN') : null, rcon: r.j.rcon });
  r = await req('b', '/api/me/membership');
  log('bob 查看自己的会员', r, { active: r.j.active, tier: r.j.tier && r.j.tier.label, daysLeft: r.j.daysLeft });
  r = await req('b', '/api/auth/me');
  log('bob 用户信息带会员标记', r, { membership: r.j.user && r.j.user.membership });

  console.log('=== 权限 ===');
  r = await req('a', '/api/admin/staff/' + bob.user.id + '/role', 'POST', { role: 'mod' });
  log('alice 把 bob 设为版主', r);
  r = await req('b', '/api/admin/reports');
  log('版主可访问举报管理', r, { 条数: (r.j.reports || []).length });
  r = await req('b', '/api/admin/staff');
  log('版主访问用户管理应被拒', r);
  r = await req('a', '/api/admin/settings', 'POST', { server_address: 'mc.example.com:25565', site_notice: '欢迎来到同禾境', contact_qq: '123456' });
  log('保存站点设置', r, r.j.saved);
  r = await req('a', '/api/auth/me');
  log('站点设置回显', r, { addr: r.j.server_address, notice: r.j.notice });

  console.log('=== 通知 ===');
  r = await req('b', '/api/notifications');
  log('bob 通知列表', r, { 数量: (r.j.notifications || []).length, 未读: r.j.unread, 好友申请: r.j.friendReq });
  r = await req('b', '/api/notifications/read', 'POST', {});
  log('全部已读', r);

  console.log('=== 头像/皮肤 ===');
  r = await req('a', '/api/avatar/bob');
  log('站内头像', { code: r.code, j: { ok: true } }, '返回图片');
})();
