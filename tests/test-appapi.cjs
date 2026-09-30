'use strict';
/* =====================================================================
   前端 API 一致性测试（防「半成品」：页面调了 App.xxx 或 /api/xxx，
   但 app.js / server.js 里根本没定义 → 线上直接报 xxx is not a function）
   用法：node test/test-appapi.cjs     （纯静态检查，不需要起服务器）
   ===================================================================== */
const fs = require('fs');
const path = require('path');

// 支持从任意目录运行：优先用 MCWEB_DIR 指向站点根
const ROOT = process.env.MCWEB_DIR ? path.resolve(process.env.MCWEB_DIR) : path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');
let pass = 0, fail = 0;
const ck = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  !! ' + n + (extra ? ' | ' + String(extra).slice(0, 300) : '')); }
};

/* ---------- 工具：按大括号配对截取一段代码 ---------- */
function sliceBlock(src, startIdx) {
  let i = src.indexOf('{', startIdx);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}

const appJs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const htmlFiles = fs.readdirSync(PUB).filter((f) => f.endsWith('.html'));
const jsFiles = fs.readdirSync(PUB).filter((f) => f.endsWith('.js'));
const frontFiles = [...htmlFiles, ...jsFiles];

/* =============== 1) App.xxx 调用 vs 定义 =============== */
// ★ 必须先剥掉注释：文档注释里会写「然后 App.bindUploader(el)」这种示例，
//   否则会把注释里的示例当成真调用 → 每次跑都报假失败，久了就没人信这套测试了。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 块注释
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');   // 行注释（避开 http:// 这种）
}
const literal = sliceBlock(appJs, appJs.indexOf('const App = {'));
const defined = new Set();
for (const m of literal.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*[:(]/gm)) defined.add(m[1]);
for (const m of appJs.matchAll(/App\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

const called = new Map(); // name -> [位置]
for (const f of frontFiles) {
  const src = stripComments(fs.readFileSync(path.join(PUB, f), 'utf8'));
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/App\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!called.has(m[1])) called.set(m[1], []);
      const at = called.get(m[1]);
      if (at.length < 3) at.push(f + ':' + (i + 1));
    }
  });
}

const missingApp = [...called.keys()].filter((n) => !defined.has(n));
ck('所有 App.xxx( 调用都有定义（共检查 ' + called.size + ' 个方法）',
  missingApp.length === 0,
  missingApp.map((n) => n + ' ← ' + called.get(n).join(', ')).join(' ; '));

/* =============== 2) App.qs 行为验证 =============== */
const qsStart = appJs.indexOf('function qs(');
ck('app.js 定义了 qs() 且已挂到 App 上', qsStart > 0 && /App\.qs\s*=\s*qs/.test(appJs));
if (qsStart > 0) {
  const block = sliceBlock(appJs, qsStart);
  const src = appJs.slice(qsStart, appJs.indexOf(block, qsStart)) + block; // 完整函数文本（含参数列表）
  const make = (search) => new Function('location', src + '\nreturn qs;')({ search });
  const qs = make('?fakes=1');
  ck("App.qs('fakes') 在 ?fakes=1 时返回 '1'", qs('fakes') === '1', qs('fakes'));
  ck("App.qs('fakes') 在无参数时返回 null", make('')('fakes') === null);
  ck("App.qs('a', 'd') 缺省值生效", make('')('a', 'd') === 'd');
  ck("App.qs('a') 空值时返回空串（不是 null）", make('?a=')('a') === '');
}

/* =============== 3) 前端调用的 /api 路径 vs 后端路由 =============== */
const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const routes = [];
for (const m of serverJs.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
  routes.push({ method: m[1].toUpperCase(), path: m[2] });
}
const toRe = (p) => new RegExp('^' + p.replace(/:[A-Za-z_]\w*/g, '[^/]+').replace(/\*/g, '.*') + '$');
const routeRes = routes.map((r) => ({ ...r, re: toRe(r.path) }));

const apiPaths = new Set();
for (const f of frontFiles) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  for (const m of src.matchAll(/['"`](\/api\/[a-zA-Z0-9/_:.-]*)['"`]/g)) apiPaths.add(m[1].split('?')[0]);
  for (const m of src.matchAll(/App\.api\(\s*['"`](\/api\/[a-zA-Z0-9/_:.-]*)/g)) apiPaths.add(m[1].split('?')[0]);
}

const deadApi = [];
for (const p of apiPaths) {
  const hit = routeRes.some((r) => r.re.test(p) || (r.path.endsWith('*') && p.startsWith(r.path.slice(0, -1))));
  if (!hit) deadApi.push(p);
}
ck('前端引用的 /api 路径后端都有路由（共检查 ' + apiPaths.size + ' 个）',
  deadApi.length === 0, deadApi.join(' , '));

/* =============== 4) 页面引用的静态资源存在 =============== */
const assets = new Set();
for (const f of htmlFiles) {
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  for (const m of src.matchAll(/(?:src|href)="(\/(?:static|assets)\/[^"]+)"/g)) assets.add(m[1].split('?')[0]);
}
const missingAssets = [...assets].filter((a) => {
  if (a.includes('/uploads/') || a.includes('/pay/')) return false; // 运行时生成
  return !fs.existsSync(path.join(PUB, a.replace(/^\//, '')));
});
ck('页面引用的静态资源都存在（共检查 ' + assets.size + ' 个）',
  missingAssets.length === 0, missingAssets.join(' , '));

console.log('\n  ── App 方法：定义 ' + defined.size + ' 个 / 调用 ' + called.size + ' 个；后端路由 ' + routes.length + ' 条');
console.log('\n  结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
