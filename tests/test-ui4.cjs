'use strict';
const fs = require('fs');
/* v5 交互规范（《THJMC 站点 UI 交互规范 v1.0》）验收检查
   用法：BASE=http://127.0.0.1:8795 node /tmp/test-ui4.cjs */
const BASE = process.env.BASE || 'http://127.0.0.1:8795';
let pass = 0, fail = 0;
const fails = [];
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  OK  ' + n); }
  else { fail++; fails.push(n); console.log('  !!  ' + n + (extra !== undefined ? ' | ' + String(extra).slice(0, 200) : '')); }
};
const get = async (p) => { const r = await fetch(BASE + p); return { code: r.status, body: await r.text() }; };

(async () => {
  console.log('=== 二.响应式 / 四.手机端骨架 ===');
  const css = await get('/style.css');
  ck('style.css 200', css.code === 200, css.code);
  for (const cls of ['.bottom-tabs', '.bt-item', '.bt-ico', '.bt-txt', 'body.rail', '.rail-toggle', '.crumbs', '.g-search', '.search-drop', '.sd-group', '.sd-item', '.sd-all',
    '.fab', '.ptr-bar', '.offline-bar', '.manage-bar', '.pager', '.pg-num', '.pg-info', '.skl-wrap', '.skl-card', '.skl-ava', '.empty.err', '.lp-menu',
    '.confirm-impact', '.f-err', '.btn.danger', '.btn.loading', '.sheet-grip', '.collapse', '.slider-row', '.table.cards', '.hscroll-x', '.up-bar', '.task-bar', '.copy-btn', '.notif-tabs', '.hide-m']) {
    ck('组件 ' + cls, css.body.includes(cls));
  }
  ck('安全区适配（env safe-area）', css.body.includes('env(safe-area-inset-bottom'));
  ck('手机触控目标 ≥44px', css.body.includes('min-height: 44px') || css.body.includes('min-height:44px'));
  ck('断点 767/1023 齐备', css.body.includes('max-width: 767px') && css.body.includes('max-width: 1023px'));
  ck('宽屏内容上限', /--maxw/.test(css.body));
  ck('减少动效支持', css.body.includes('prefers-reduced-motion: reduce'));
  ck('焦点环', css.body.includes(':focus-visible'));

  console.log('\n=== app.js：外壳与交互能力 ===');
  const app = await get('/app.js');
  ck('app.js 200', app.code === 200, app.code);
  const need = [
    ['导航分组（主站/社区/个人/管理）', /sec: '主站'/.test(app.body) && /sec: '社区'/.test(app.body) && /'<div class="nav-sec">个人<\/div>'/.test(app.body) && /'<div class="nav-sec">管理<\/div>'/.test(app.body)],
    ['管理组按角色过滤', app.body.includes('u.isStaff') && app.body.includes('OWNER_ONLY') && app.body.includes('isOwner ? true : isAdm')],
    ['底部标签栏 5 项', app.body.includes('bottom-tabs') && /'私聊', 'message-circle'/.test(app.body) && app.body.includes("'/me', 'me', '我的'")],
    ['私聊未读红点', app.body.includes('dmDotTab') && app.body.includes('dmDotTop')],
    ['顶部全局搜索 + 防抖', app.body.includes('runGlobalSearch') && app.body.includes('runGlobalSearch(q), 280)')],
    ['搜索结果分组', app.body.includes('sd-group') && app.body.includes('sd-item') && app.body.includes('/forum/thread/')],
    ['回车进搜索页', app.body.includes('/search.html?q=')],
    ['面包屑（最多三级）', app.body.includes('crumbsHtml') && app.body.includes('slice(0, 3)')],
    ['侧栏折叠 + 记忆', app.body.includes("localStorage.setItem('mcw_rail'") && app.body.includes("classList.toggle('rail'")],
    ['快捷键 / 聚焦搜索', /e\.key === '\/'/.test(app.body) && app.body.includes("App.openSearch('')")],
    ['快捷键 G+H / G+R', app.body.includes("if (k === 'h')") && app.body.includes("if (k === 'r')")],
    ['快捷键 Ctrl+Enter 事件', app.body.includes("app:ctrlenter")],
    ['Esc 关闭浮层', app.body.includes("app:esc") && app.body.includes("e.key === 'Escape'")],
    ['断线横幅', app.body.includes('offline-bar') && app.body.includes('实时连接已断开，正在重连')],
    ['重连自动刷新未读', /on\('connect'[\s\S]{0,160}refreshNotif\(\)/.test(app.body)],
    ['Toast 最多 3 条', app.body.includes('box.children.length >= 3')],
    ['Toast 可手动关闭', app.body.includes("class=\"t-x\"") || app.body.includes('t-x')],
    ['危险操作确认 + 必填理由', app.body.includes('confirmDanger') && app.body.includes('requireReason') && app.body.includes('理由至少 2 个字')],
    ['焦点陷阱', app.body.includes('function focusTrap')],
    ['长按支持', app.body.includes('function longPress')],
    ['下拉刷新', app.body.includes('function initPTR') && app.body.includes('ptr-bar')],
    ['URL 状态工具', app.body.includes('urlState') && app.body.includes('history.replaceState')],
    ['分页组件', app.body.includes('paginationHtml') && app.body.includes('pg-num')],
    ['骨架屏/空态/错误态', app.body.includes('function skeleton') && app.body.includes('function emptyState') && app.body.includes('function errorState')],
    ['网络与服务器错误区分', app.body.includes('errText') && app.body.includes('网络已断开')],
    ['管理视图标识', app.body.includes('App.manageView') && app.body.includes('管理视图')],
    ['复制按钮委托 + Toast', app.body.includes("closest('[data-copy]')")],
    ['通知中心分组 + 全部已读', app.body.includes('notif-tabs') && app.body.includes('notifReadAll')],
        ['时间：列表相对 / 悬停完整', app.body.includes('function timeTag') && app.body.includes('esc(timeStr(ts))')],
    ['FAB 浮动按钮', app.body.includes('App.fab')],
    ['图标按钮 aria 名称', app.body.includes('aria-label="打开菜单"') && app.body.includes('aria-label="通知"')],
    ['按钮加载禁用态', css.body.includes('.btn.loading')],
  ];
  for (const n of need) ck(n[0], n[1]);
  ck('零 emoji（功能图标）', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(app.body), (app.body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).join(''));

  console.log('\n=== 搜索页（新增页面） ===');
  const sp = await get('/search.html?q=zaoren');
  ck('/search.html 200', sp.code === 200, sp.code);
  ck('分组结果渲染', sp.body.includes('sBody') && sp.body.includes("App.emptyState('search'") && sp.body.includes('data-kind'));
  ck('写入 URL 状态', sp.body.includes('App.urlState.set'));

  console.log('\n=== 404 / 权限页（规范 八.17） ===');
  const nf = await get('/404');
  ck('/404 200', nf.code === 200, nf.code);
  ck('返回首页按钮', nf.body.includes('回到首页'));
  ck('返回上一页按钮', nf.body.includes('btnBack') && nf.body.includes('history.back()'));
  ck('权限问题不提示存在性', nf.body.includes("denied ? '无权访问'") && nf.body.includes('联系管理员'));
  const r404 = await get('/no-such-page-xyz');
  ck('未知路径返回 404 状态', r404.code === 404, r404.code);

  console.log('\n=== 搜索接口（玩家/用户/主题） ===');
  const s1 = await get('/api/search?q=zzz');
  ck('/api/search 返回 threads 字段', s1.code === 200 && s1.body.includes('"threads"'), s1.code);
  const s2 = await get('/api/users/search?q=zzz');
  ck('/api/users/search 存在（未登录 401）', s2.code === 200 || s2.code === 401, s2.code);

  console.log('\n=== 既有页面回归（外壳注入后可访问） ===');
  for (const p of ['/', '/rank', '/feed', '/forum', '/chat', '/friends', '/me', '/pay', '/login', '/admin']) {
    const r = await get(p);
    ck('页面 ' + p, r.code === 200, r.code);
  }

  console.log('\n=== 页面：段位榜（URL 状态 / 骨架） ===');
  const rk = await get('/rank');
  ck('URL 状态写入（tier/page）', rk.body.includes('App.urlState.set') && rk.body.includes("tier"));
  ck('使用分页组件', rk.body.includes('App.paginationHtml') || rk.body.includes('App.wirePager'));

  console.log('\n=== 页面：动态流（乐观点赞 / 新动态提示 / FAB / 下拉刷新） ===');
  const fd = await get('/feed');
  ck('乐观点赞 + 失败回滚', fd.body.includes('likeOptim') || (fd.body.includes('回滚') && fd.body.includes('/api/forum/like')));
  ck('新动态提示条', fd.body.includes('newTip') || fd.body.includes('有 ') && fd.body.includes('条新动态'));
  ck('FAB 发帖', fd.body.includes('App.fab'));
  ck('下拉刷新', fd.body.includes('App.initPTR'));

  console.log('\n=== 页面：私聊（长按菜单 / 已读 / 撤回） ===');
  const ct = await get('/chat');
  ck('长按菜单（长按/右键 → 复制/撤回/举报）', ct.body.includes('App.bindContext') && ct.body.includes('复制内容') && ct.body.includes('撤回消息'));
  ck('撤回文案', ct.body.includes('撤回了一条消息'));
  ck('已读回执', ct.body.includes('已读'));
  ck('Ctrl+Enter 发送', ct.body.includes('app:ctrlenter'));

  console.log('\n=== 页面：后台（深链 / 面包屑 / 危险确认理由 / 监控暂停） ===');
  const ad = await get('/admin');
  ck('tab 深链（?tab=）', ad.body.includes("urlState.get('tab'") || ad.body.includes('const initialTab'));
  ck('面包屑设置', ad.body.includes('App.crumb'));
  ck('危险操作填写理由', ad.body.includes('confirmDanger') && ad.body.includes('requireReason'));
  ck('监控自动刷新可暂停', ad.body.includes('暂停') || ad.body.includes('pause'));
  ck('表格手机转卡片', ad.body.includes('App.tableCards') || ad.body.includes('table.cards'));

  console.log('\n=== 页面：我的（隐私立即保存 / 解绑确认） ===');
  const me = await get('/me');
  ck('隐私保存 Toast', me.body.includes('/api/settings/privacy') && me.body.includes('Toast') || me.body.includes('App.toast'));
  ck('解绑二次确认', me.body.includes('App.confirm') || me.body.includes('确认解绑'));

  
/* ===== 事件对象误用检查：await 之后再访问 currentTarget（浏览器会置空 → TypeError） ===== */
{
  const pages = fs.readdirSync('/workspace/mcweb/public').filter((f) => f.endsWith('.html'));
  const bad = [];
  for (const f of pages) {
    const src = fs.readFileSync('/workspace/mcweb/public/' + f, 'utf8');
    for (const m of src.matchAll(/\b(ev|e)\.currentTarget/g)) {
      const start = src.lastIndexOf('addEventListener', m.index);
      if (start < 0) continue;
      const head = src.slice(start, m.index);
      const hasAwait = /await\b/.test(head);
      const captured = new RegExp('(btn|b|el|button)\\s*=\\s*' + m[1] + '\\.currentTarget').test(head);
      if (hasAwait && !captured) bad.push(f);
    }
  }
  ck('没有「await 之后再访问 currentTarget」的写法', bad.length === 0, bad.join(','));
}

/* ===== 回归检查：私聊工具栏 / 批量封禁（线上 /api/dm/null/pin 500 的根因） ===== */
{
  const chat = fs.readFileSync('/workspace/mcweb/public/chat.html', 'utf8');
  const admin = fs.readFileSync('/workspace/mcweb/public/admin.html', 'utf8');
  ck('回到世界频道会清掉私聊工具栏', /async function loadWorld\(\)\s*\{[\s\S]{0,200}?peerHead\(\)/.test(chat), 'loadWorld 未调用 peerHead');
  ck('离开会话会清掉私聊工具栏', (chat.match(/peerHead\(\);/g) || []).length >= 4, 'peerHead 调用次数=' + (chat.match(/peerHead\(\);/g) || []).length);
  ck('置顶/静音点击前先校验会话', (chat.match(/if \(!cur\) return App\.toast\('请先选择一个会话'/g) || []).length === 2);
  ck('openDm 校验会话对象', /let openDm = async function \(uid\) \{\s*if \(!Number\.isInteger\(uid\)/.test(chat));
  ck('admin.html 接了批量封禁接口', admin.includes('/api/admin/users/bulk-ban') && admin.includes('bulkUnbanAll'));
  ck('admin.html 每行有封禁/解封按钮', admin.includes('data-ban="${u.id}"'));
  const social2 = fs.readFileSync('/workspace/mcweb/lib/social2.js', 'utf8');
  ck('DM 路由都过了 intParam 守卫', (social2.match(/intParam\(req, res, 'userId'\)/g) || []).length === 6 && social2.includes('function intParam'));
  const srv = fs.readFileSync('/workspace/mcweb/server.js', 'utf8');
  ck('未捕获异常返回 JSON 而不是 HTML', srv.includes('[unhandled]') && srv.includes('服务器内部错误'));
  ck('批量封禁接口有权限分级', srv.includes('批量解封全部仅站长可用') && srv.includes('仅站长可操作管理员账号'));
}

/* ===== 国庆专区（前台 festival + 后台 tabShop + 签到/时间轴）：静态回归 ===== */
{
  const fest = fs.readFileSync('/workspace/mcweb/public/festival.html', 'utf8');
  const shopRedir = fs.readFileSync('/workspace/mcweb/public/shop.html', 'utf8');
  const admin = fs.readFileSync('/workspace/mcweb/public/admin.html', 'utf8');
  const lib = fs.readFileSync('/workspace/mcweb/lib/shop.js', 'utf8');
  const flib = fs.readFileSync('/workspace/mcweb/lib/festival.js', 'utf8');
  const srv2 = fs.readFileSync('/workspace/mcweb/server.js', 'utf8');
  const appjs = fs.readFileSync('/workspace/mcweb/public/app.js', 'utf8');
  ck('国庆专区页接了商品/下单/兑换/订单接口', ['/api/festival', '/api/shop/order', '/api/shop/redeem', '/api/shop/orders'].every((x) => fest.includes(x)));
  ck('国庆专区页一次拉专区聚合接口', fest.includes("'/api/festival'") && fest.includes('loadFest'));
  ck('专区页有活动日历时间轴（.tl-item 渲染）', fest.includes('renderTimeline') && fest.includes('tl-item') && fest.includes('活动日程'));
  ck('专区页有国庆签到卡片与签到榜', fest.includes('ciBox') && fest.includes('连签奖励') && fest.includes('签到榜'));
  ck('专区页签到走 /api/festival/checkin', fest.includes("'/api/festival/checkin'"));
  ck('专区页有交付方式二选一（立即开通 / 卡密）', fest.includes('立即开通到我的游戏账号') && fest.includes('给我一张卡密'));
  ck('专区页有实体收货信息表单', ['#rName', '#rPhone', '#rAddr'].every((x) => fest.includes(x)));
  ck('专区页有付款凭证上传与预览', fest.includes('proofData') && fest.includes('2.5 * 1024 * 1024'));
  ck('专区页有兑换码入口与我的订单', fest.includes('redeemBtn') && fest.includes('我的订单'));
  ck('旧的 /shop 页跳转到国庆专区', shopRedir.includes("location.replace('/festival#shop')") || shopRedir.includes('url=/festival#shop'));
  ck('导航栏国庆专区入口（/festival）', /'\/festival', 'festival', '国庆专区'/.test(appjs));
  ck('后台侧栏含国庆专区与商城订单', appjs.includes("['shop', '国庆专区'") && appjs.includes("['shoporders', '商城订单'"));
  ck('后台标签页含 国庆专区/商城订单', admin.includes("['shop', '国庆专区']") && admin.includes("['shoporders', '商城订单']"));
  ck('后台有看板 + 时间轴编辑器 + 签到设置', admin.includes('国庆看板') && admin.includes('活动日历（时间轴）') && admin.includes('保存签到设置') && admin.includes('新增日程'));
  ck('后台商品编辑走弹层（新增商品 modal）', admin.includes('function openGoodsEditor') && admin.includes("'/api/admin/shop/product'"));
  ck('后台商品行用 visible 判断上下架（bug 修复）', admin.includes("p.visible === 1 ? '上架中' : '已下架'") && admin.includes('data-gvis'));
  ck('后端 pubProduct 下发 visible 与 hasMembership（bug 修复）', lib.includes('visible: p.visible === 1 ? 1 : 0') && lib.includes('hasMembership: hasMembership(p)'));
  ck('后台订单页有确认收款/发货/导出/退款', admin.includes('确认收款并交付') && admin.includes('导出待发货 CSV') && admin.includes("act === 'refund'"));
  ck('后台订单页显示打码提示', admin.includes('仅站长可见完整信息'));
  ck('后端：开通会员不降级（grantSmart）', lib.includes('function grantSmart') && lib.includes('已有更高档 → 时长叠加到更高档'));
  ck('后端：确认收款走 requireAdmin、导出走 requireOwner', lib.includes("'/api/admin/shop/export.csv', requireOwner") && lib.includes("'/api/admin/shop/orders', requireAdmin"));
  ck('后端：待付款 30 分钟占位超时关闭', lib.includes('PAY_TTL_MS') && lib.includes('closeExpired'));
  ck('后端：合照到点播报（tellraw @a）', lib.includes('ingame.tellraw') && lib.includes('event_reminded'));
  ck('后端：日程到点播报 + 去重', flib.includes('async function remindTick') && flib.includes('fest_reminded'));
  ck('后端：签到达成里程碑发会员/卡密', flib.includes('async function doCheckin') && flib.includes('shop.grantSmart') && flib.includes('shop.createCodes'));
  ck('后端：签到与时间轴写审计日志', flib.includes("'festival_checkin'") && flib.includes("'festival_settings'"));
  ck('后端：签到/日程表建表语句', require('fs').readFileSync('/workspace/mcweb/lib/db.js', 'utf8').includes('CREATE TABLE IF NOT EXISTS fest_checkins') && require('fs').readFileSync('/workspace/mcweb/lib/db.js', 'utf8').includes('CREATE TABLE IF NOT EXISTS fest_points'));
  ck('server.js 挂了专区路由 + tick + 播种', srv2.includes('festival.createFestival(') && srv2.includes("festival.tick(), 'festival-tick'") && srv2.includes('festival.seedFest()'));
  const dbj = fs.readFileSync('/workspace/mcweb/lib/db.js', 'utf8');
  ck('订单表有 submitted_at（区分待付款/待审核）', dbj.includes('submitted_at INTEGER') && dbj.includes("ensureColumn('shop_orders', 'submitted_at'"));
  ck('后端有「提交付款信息 → 送审」接口', lib.includes("router.post('/api/shop/order/:id/submit'") );
  ck('送审会写入提交时间并延长核对期到 24 小时', lib.includes('REVIEW_TTL_MS') && lib.includes('submitted_at = ?, pay_deadline = ?') && lib.includes('ts + REVIEW_TTL_MS'));
  ck('下单时带了付款信息就算已送审', lib.includes('const submitted = !!(proofUrl || ref4)') && lib.includes('submitted ? ts : null'));
  ck('送审必须至少有截图或单号后 4 位', lib.includes('请上传付款截图，或填写付款单号后 4 位'));
  ck('送审只允许本人（或管理员）操作', lib.includes("if (o.user_id !== req.user.id && !req.user.is_admin) return fail(res, 403, '无权操作该订单')"));
  ck('只有 pending 能送审（已处理的不重复提交）', lib.includes('该订单已处理，无法再提交付款信息'));
  ck('送审不受专区关闭影响（已下单的能完成订单）', /router\.post\('\/api\/shop\/order\/:id\/submit'[\s\S]{0,600}?rateLimit/.test(lib));
  ck('订单对象下发 submittedAt 与 needsReview', lib.includes('submittedAt: o.submitted_at || null') && lib.includes("needsReview: o.status === 'pending' && !!o.submitted_at"));
  ck('超时自动关闭区分「未付款」与「未核对」', lib.includes('超时未核对，自动关闭') && lib.includes('超时未付款自动关闭'));
  ck('后台支持待审核筛选（pending 只剩未送审的）', lib.includes("status === 'review'") && lib.includes("AND status = 'pending' AND submitted_at IS NULL"));
  ck('看板统计出待审核数量与金额', lib.includes('pendingReview: g(') && lib.includes('reviewAmount: g('));
  ck('导出 CSV 支持待审核', /export\.csv[\s\S]{0,400}?status === 'review'/.test(lib));
  ck('前台弹层内置收款码区块（不用去页面别处找）', fest.includes('function qrBlockHtml') && fest.includes('.pay-in'));
  ck('前台主按钮文案为「提交订单并送审」', fest.includes("'提交订单并送审'") && fest.includes('提交审核'));
  ck('前台有「提交 / 补交付款信息」弹层', fest.includes('function openSubmit') && fest.includes("'/api/shop/order/' + o.id + '/submit'"));
  ck('「我的订单」有待付款 → 送审入口与待审核状态', fest.includes('data-submitord') && fest.includes("'待审核 · 已提交'") && fest.includes('提交付款信息'));
  ck('后台订单列表标出待审核与买家已提交', admin.includes('待审核') && admin.includes('提交付款信息') && admin.includes("o.status === 'pending' && o.submittedAt"));
  ck('未开放时已下单买家仍能完成订单（锁定页保留我的订单区）', fest.includes('专区未开放，已下的订单仍可继续') && /if \(LOCKED\)[\s\S]{0,900}?loadOrders\(\)/.test(fest));
  ck('未开放时收款码只发给有未处理订单的买家', lib.includes('hasPendingOrder') && lib.includes('qr: pending ? { wechat') && lib.includes('hasPendingOrder: pending > 0'));
  ck('开放时 config 也带 locked=0（客户端判定更稳）', lib.includes('locked: 0,\n      event: {') || /ok\(res, \{\n      locked: 0,/.test(lib));
  const phSocial = fs.readFileSync('/workspace/mcweb/lib/social.js', 'utf8');
  /* ===== 照片能力（帖子配图 / 主页背景 / 合并板块）===== */
  const phLib = fs.readFileSync('/workspace/mcweb/lib/photos.js', 'utf8');
  const phApp = fs.readFileSync('/workspace/mcweb/public/app.js', 'utf8');
  const phMe = fs.readFileSync('/workspace/mcweb/public/me.html', 'utf8');
  const phTh = fs.readFileSync('/workspace/mcweb/public/thread.html', 'utf8');
  const phForum = fs.readFileSync('/workspace/mcweb/public/forum.html', 'utf8');
  const phFeed = fs.readFileSync('/workspace/mcweb/public/feed.html', 'utf8');
  const phS2 = fs.readFileSync('/workspace/mcweb/lib/social2.js', 'utf8');
  ck('照片能力：独立图片模块（魔数校验 + 重编码 + 白名单）', phLib.includes('function sniff') && phLib.includes('async function shrink') && phLib.includes('PHOTO_URL_RE'));
  ck('照片能力：只接受本站上传目录的图片（防外链跟踪）', phLib.includes('function isPhotoUrl') && phLib.includes('function pickImages') && phLib.includes("isPhotoUrl(u)"));
  ck('照片能力：上传接口要登录 + 限流', /router\.post\('\/api\/upload\/image', requireAuth[\s\S]{0,220}?rateLimit/.test(phLib));
  ck('照片能力：帖子/回复/背景三处字段都有迁移', dbj.includes("ensureColumn('forum_threads', 'images'") && dbj.includes("ensureColumn('forum_posts', 'images'") && dbj.includes("ensureColumn('users', 'profile_bg_locked'"));
  ck('照片能力：发帖/回复都写入 images', phSocial.includes('INSERT INTO forum_threads (board, user_id, title, body, images') && phSocial.includes('INSERT INTO forum_posts (thread_id, user_id, body, images'));
  ck('照片能力：列表/详情下发 images 与 imageCount', phSocial.includes('imageCount: safeJson(t.images') && phSocial.includes('images: safeJson(t.images, [])') && phSocial.includes('images: safeJson(p.images, [])'));
  ck('照片能力：删帖/删回复回收配图（仍被引用则保留）', phSocial.includes('function dropPhotos') && phSocial.includes('images LIKE ?') && phSocial.includes('UPDATE forum_posts SET deleted = 1 WHERE thread_id = ?'));
  ck('照片能力：背景上传即裁剪 1600×600 并转 JPG', phSocial.includes('crop: true') && phSocial.includes('photos.saveBgFile') && phSocial.includes("rateLimit('bg:'"));
  ck('照片能力：背景锁定后拒绝上传并给申诉指引', phSocial.includes('你的主页背景上传权限已被管理员关闭') && phSocial.includes('举报与申诉'));
  ck('照片能力：后台有背景撤回 + 锁定接口', phSocial.includes("router.get('/api/admin/backgrounds'") && phSocial.includes("router.post('/api/admin/backgrounds/:uid/remove'") && phSocial.includes("router.post('/api/admin/backgrounds/:uid/lock'"));
  ck('照片能力：撤回背景通知本人并写审计', phSocial.includes("notify(uid, 'system', '你的主页背景已被管理员撤回'") && phSocial.includes("audit(req.user.id, req.user.username, 'bg.remove'"));
  ck('照片能力：资料接口挡掉外部背景地址', phSocial.includes('/^(?:g[1-8]|d[1-4])$/.test(bg)') && phSocial.includes('photos.isBgUrl(bg)'));
  ck('照片能力：动态流（feed）也带图', phS2.includes('images: safeJson(r.images, [])') && phFeed.includes('App.gallery(it.images'));
  ck('照片能力：前端九宫格 / 大图 / 上传器三件套', phApp.includes('App.gallery = function') && phApp.includes('App.lightbox = function') && phApp.includes('App.bindUploaders = function') && phApp.includes('App.shrinkImage'));
  ck('照片能力：大图支持 Esc 关闭与左右切换', phApp.includes("e.key === 'Escape'") && phApp.includes('ArrowLeft') && phApp.includes("lbEl.className = 'lightbox'"));
  ck('照片能力：上传器支持多选/粘贴/拖拽/删除/后插入绑定', phApp.includes('data-upx') && phApp.includes("addEventListener('paste'") && phApp.includes("addEventListener('drop'") && phApp.includes('MutationObserver'));
  ck('照片能力：发帖弹层 + 回复框都挂了图片选择器', /data-up data-kind="forum" data-max="9"/.test(phForum) && /data-up data-kind="forum"/.test(phTh));
  ck('照片能力：帖子页正文与回复都渲染成九宫格', phTh.includes('App.gallery(t.images)') && phTh.includes('App.gallery(p.images)'));
  ck('照片能力：/me 有背景预览、锁定提示与恢复默认', phMe.includes('id="bgPreview"') && phMe.includes('id="bgLocked"') && phMe.includes('id="bgClear"') && phMe.includes('data-kind="bg"'));
  ck('合并板块：后台一个「头像与主页背景」页（分段切换）', admin.includes("['avatars', '头像与主页背景']") && admin.includes('data-mk="bg"') && admin.includes("tabAvatars(App.urlState.get('mk'))"));
  ck('合并板块：背景卡片有撤回/撤回并锁定/关闭上传', admin.includes('data-bgrm') && admin.includes('data-bgrmlock') && admin.includes('data-bglock'));
  const zlib = fs.readFileSync('/workspace/mcweb/lib/zone.js', 'utf8');
  ck('独立模块 lib/zone.js 管开放开关（避免循环依赖）', zlib.includes('function lockOf') && zlib.includes("require('./db')"));
  ck('只有真管理员（is_admin）能预览未开放的专区', zlib.includes('return !!(u && u.is_admin);'));
  ck('后端：专区与商城都挂了开放守门', flib.includes('zone.lockOf(req)') && lib.includes('zone.lockOf(req)'));
  ck('后端：未开放时签到/下单返回 403', flib.includes("if (lk) return fail(res, 403, lk.title") && lib.includes("if (lk) return fail(res, 403, lk.title"));
  ck('后端：未开放时商品与收款码不下发', lib.includes('{ products: [], event: getEvent(), locked: 1, lock: lk }') && lib.includes("payNotice: pending ? e0.pay_notice : null") && lib.includes('hasPendingOrder'));
  ck('后端：我的订单与兑换码不受关闭影响', lib.includes("router.get('/api/shop/orders', requireAuth") && lib.includes("router.post('/api/shop/redeem', requireAuth"));
  ck('后端：setting 里保存 public / lock_* 字段', flib.includes("for (const k of ['checkin_on', 'board_on', 'public', 'lock_show_timeline'])") && flib.includes('zone.bust()'));
  ck('接口下发 open 标记（便于前端提示预览）', flib.includes('open: zone.pubOn() ? 1 : 0') && flib.includes('open: 0,'));
  ck('页面注入 window.__festOpen 给外壳判断', /lib\/zone/.test(fs.readFileSync('/workspace/mcweb/server.js', 'utf8')) && fs.readFileSync('/workspace/mcweb/server.js', 'utf8').includes('zone.injectFlag(html, req)'));
  ck('app.js：未开放时普通用户导航里没有国庆专区', appjs.includes('applyZoneGate') && appjs.includes("it[1] !== 'festival'") && appjs.includes('App.user.isAdmin'));
  ck('前台有「即将开启」锁定视图与倒计时', fest.includes('function lockHtml') && fest.includes('nd-lock') && fest.includes('function lockCountdown'));
  ck('前台锁定页保留活动预告时间轴（预热）', fest.includes('lk.showTimeline') && fest.includes('活动预告'));
  ck('站长预览未开放专区时有醒目提示', fest.includes('function previewHtml') && fest.includes('预览模式：国庆专区当前未对外开放'));
  ck('后台有「对外开放」卡片与保存按钮', admin.includes('id="zfSave"') && admin.includes('暂不对外开放') && admin.includes('未开放时页面标题'));
  ck('后台卡片说明了关闭后的影响', admin.includes('顶部导航入口自动隐藏') && admin.includes('已发出的兑换码'));
  const cp = (t) => [...t].some((ch) => { const c = ch.codePointAt(0); return c >= 0x1F300 || (c >= 0x2600 && c <= 0x27BF); });
  ck('国庆代码零 emoji', !cp(fest + lib + flib + admin));
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})();
