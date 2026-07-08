const rawBase = process.env.BASE_URL || process.argv[2] || '';
if (!rawBase) {
  console.error('用法：BASE_URL=https://你的项目.pages.dev ADMIN_TOKEN=... npm run smoke');
  process.exit(2);
}
const base = rawBase.replace(/\/$/, '');
const token = process.env.ADMIN_TOKEN || '';

async function call(path, options = {}, withAdmin = false) {
  const headers = new Headers(options.headers || {});
  headers.set('accept', 'application/json');
  if (options.body) headers.set('content-type', 'application/json');
  if (withAdmin && token) headers.set('authorization', `Bearer ${token}`);
  const response = await fetch(base + path, { ...options, headers, redirect: 'manual' });
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch {}
  return { response, payload, text };
}
function assert(condition, message) { if (!condition) throw new Error(message); }

try {
  const health = await call('/api/health');
  assert(health.response.ok && health.payload.ok, `health 失败：${health.response.status} ${health.text}`);
  assert(health.payload.privateMode === true, '后端模式不正确');
  assert(health.payload.dbReady === true, 'D1 尚未绑定或不可用');
  console.log('✓ 健康检查');

  const index = await fetch(base + '/', { redirect: 'manual' });
  assert(index.ok, `首页失败：HTTP ${index.status}`);
  const html = await index.text();
  assert(html.includes('<title>Cactus TV</title>') && html.includes('/js/app.js'), '首页内容不完整');
  assert(!html.includes('loginForm'), '首页仍包含登录表单');
  console.log('✓ 首页');

  const publicHome = await call('/api/home');
  assert(publicHome.response.ok, `首页 API 失败：${publicHome.response.status} ${publicHome.text}`);
  console.log('✓ 前台 API');

  const denied = await call('/api/admin/settings');
  assert(denied.response.status === 401 || denied.response.status === 503, `后台未鉴权：HTTP ${denied.response.status}`);
  console.log('✓ 后台拒绝无密钥请求');

  if (token) {
    const settings = await call('/api/admin/settings', {}, true);
    assert(settings.response.ok && settings.payload.settings, `管理密钥检查失败：${settings.response.status} ${settings.text}`);
    console.log('✓ ADMIN_TOKEN 管理后台');
  } else {
    console.log('• 未提供 ADMIN_TOKEN，跳过后台成功请求检查');
  }
  console.log('Cactus TV 部署检查通过。');
} catch (error) {
  console.error(`Cactus TV 烟雾测试失败：${error.message}`);
  process.exit(1);
}
