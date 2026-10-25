(function () {
  const g = window.__GUOBA__ || {}
  const el = id => document.getElementById(id)
  const cards = el('bg-cards')
  if (!cards) return
  const stats = el('bg-stats')
  const meta = el('bg-meta')
  let all = []
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
  function headers(json) { const h = {}; h[g.tokenKey || 'guoba-access-token'] = g.token || ''; if (json) h['Content-Type'] = 'application/json'; return h }
  async function api(path, opts) { const r = await fetch(g.apiBase + path, opts); return await r.json() }
  function fmtTime(t) { if (!t) return '-'; const d = new Date(Number(t)); return isNaN(d.getTime()) ? '-' : d.toLocaleString() }
  async function load() {
    const json = await api('/bg/list', { headers: headers() })
    if (!json.ok) { cards.innerHTML = '<div class="bg-empty">读取失败：' + esc(json.message) + '</div>'; return }
    all = (json.result && json.result.list) || []
    render()
  }
  function render() {
    const src = el('bg-source') ? el('bg-source').value : ''
    const q = el('bg-q') ? el('bg-q').value.trim().toLowerCase() : ''
    let list = all.slice()
    if (src) list = list.filter(x => (x.from || 'panel') === src)
    if (q) list = list.filter(x => String(x.url || '').toLowerCase().includes(q) || String(x.msgId || '').includes(q))
    const byFrom = {}
    for (const x of all) { const k = x.from || 'panel'; byFrom[k] = (byFrom[k] || 0) + 1 }
    if (stats) stats.innerHTML = '<div class="bg-stat"><div class="k">总记录</div><div class="v">' + all.length + '</div></div>'
      + '<div class="bg-stat"><div class="k">来源种类</div><div class="v">' + Object.keys(byFrom).length + '</div></div>'
      + '<div class="bg-stat"><div class="k">当前筛选</div><div class="v">' + list.length + '</div></div>'
    if (meta) meta.textContent = '共 ' + all.length + ' 条，显示 ' + list.length + ' 条'
    if (!list.length) { cards.innerHTML = '<div class="bg-empty">没有记录（渲染一次面板后会自动生成）</div>'; return }
    cards.innerHTML = list.map(x => cardHtml(x)).join('')
    cards.querySelectorAll('.bg-thumb img').forEach(im => im.addEventListener('error', () => { const p = im.parentNode; if (p) p.classList.add('bg-noimg') }))
  }
  function cardHtml(x) {
    const url = esc(x.url)
    return '<div class="bg-card">'
      + '<a class="bg-thumb" href="' + url + '" target="_blank" rel="noopener"><img loading="lazy" src="' + url + '" alt="" /></a>'
      + '<div class="bg-body">'
      + '<div class="bg-url" title="' + url + '">' + url + '</div>'
      + '<div class="bg-sub"><span class="bg-tag">' + esc(x.from || 'panel') + '</span><span>ID ' + esc(x.msgId) + '</span><span>' + esc(fmtTime(x.time)) + '</span></div>'
      + '<div class="bg-ops"><button class="bg-btn bg-copy" data-url="' + url + '">复制链接</button><button class="bg-btn danger bg-del" data-msgid="' + esc(x.msgId) + '">删除</button></div>'
      + '</div></div>'
  }
  async function del(msgId) {
    if (msgId == null || msgId === '') return
    if (!confirm('确定删除该背景图记录？')) return
    const json = await api('/bg/del', { method: 'POST', headers: headers(true), body: JSON.stringify({ msgId }) })
    if (json.ok) { load() } else { alert('删除失败：' + json.message) }
  }
  cards.addEventListener('click', e => {
    const cp = e.target.closest('.bg-copy')
    if (cp) { const u = cp.dataset.url || ''; if (navigator.clipboard) navigator.clipboard.writeText(u).then(() => { cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制链接' }, 1200) }).catch(() => {}); return }
    const dl = e.target.closest('.bg-del')
    if (dl) del(dl.dataset.msgid)
  })
  if (el('bg-refresh')) el('bg-refresh').addEventListener('click', load)
  if (el('bg-source')) el('bg-source').addEventListener('change', render)
  if (el('bg-q')) el('bg-q').addEventListener('input', render)
  if (el('bg-export')) el('bg-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'panel_bg.json'; a.click()
  })
  load()
})()
