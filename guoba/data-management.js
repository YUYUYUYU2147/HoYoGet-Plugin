const frame = document.getElementById('data-frame')
const query = new URLSearchParams(location.search)
const token = query.get('token') || window.__GUOBA__?.token || ''
const base = (query.get('__webBase') || '').replace(/\/$/, '')
document.getElementById('ck-link').href = `${base}/custom/hoyo-ck-manage`
if (!token) {
  frame.replaceWith(Object.assign(document.createElement('p'), {
    className: 'login-note',
    textContent: '没有取得锅巴登录凭证，请重新登录并从“拓展页面”打开此页。',
  }))
} else {
  frame.src = `${base}/hoyoget-data/#${encodeURIComponent(token)}`
}
