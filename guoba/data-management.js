const frame = document.getElementById('data-frame')
const query = new URLSearchParams(location.search)
const token = query.get('token') || window.__GUOBA__?.token || ''
// 锅巴挂载前缀：优先用父页面注入的地址，其次从当前路径反推（/guoba/hoyoget-data/ → /guoba）。
const rawBase = query.get('__webBase') || window.__GUOBA__?.webBase || ''
const pathBase = location.pathname.replace(/\/hoyoget-data\/?$/, '')
const base = String(rawBase || pathBase || '').replace(/\/$/, '')
// CK/SK 管理是本插件的拓展页面（锅巴自定义页面 /custom/:id）。
const ckLink = document.getElementById('ck-link')
if (base) {
  ckLink.href = `${base}/custom/hoyo-ck-manage`
} else {
  ckLink.hidden = true
}
if (!token) {
  frame.replaceWith(Object.assign(document.createElement('p'), {
    className: 'login-note',
    textContent: '没有取得锅巴登录凭证，请重新登录并从“拓展页面”打开此页。',
  }))
} else {
  frame.src = `${base}/hoyoget-data/#${encodeURIComponent(token)}`
}
