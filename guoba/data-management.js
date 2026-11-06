const frame = document.getElementById('data-frame')
const query = new URLSearchParams(location.search)
const token = query.get('token') || window.__GUOBA__?.token || ''
// 锅巴挂载前缀：优先用父页面注入的地址，其次从当前路径反推（/guoba/hoyoget-data/ → /guoba）。
const rawBase = query.get('__webBase') || window.__GUOBA__?.webBase || ''
const pathBase = location.pathname.replace(/\/hoyoget-data\/?$/, '')
const base = String(rawBase || pathBase || '').replace(/\/$/, '')
// CK/SK 管理是本插件的拓展页面，点击后在当前数据页区域直接加载，
// 不再新开锅巴首页（锅巴是 SPA，直链会 404 或跳首页）。
const ckLink = document.getElementById('ck-link')
if (base) {
  ckLink.href = `${base}/custom/hoyo-ck-manage`
  const target = `${base}/custom/hoyo-ck-manage`
  ckLink.addEventListener('click', ev => {
    ev.preventDefault()
    // 数据页运行在锅巴的 iframe 内：让父窗口（锅巴 SPA）切到该路由，
    // 而不是新开一个完整面板标签页。
    try {
      const parent = window.parent
      if (parent && parent !== window && parent.location.origin === location.origin) {
        parent.location.href = target
        return
      }
    } catch { /* 跨域时忽略 */ }
    window.open(target, '_blank', 'noreferrer')
  })
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
