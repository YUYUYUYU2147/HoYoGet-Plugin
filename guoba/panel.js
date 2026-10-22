(function () {
  const g = window.__GUOBA__ || {}
  const cards = document.getElementById('pn-cards')
  const stats = document.getElementById('pn-stats')
  const meta = document.getElementById('pn-meta')
  const el = id => document.getElementById(id)
  const GAME = { gs: { name: '原神', cls: 'pn-g-gs' }, sr: { name: '崩坏：星穹铁道', cls: 'pn-g-sr' } }
  const iconUrl = game => g.apiBase + '/game/icon?game=' + encodeURIComponent(game) + '&token=' + encodeURIComponent(g.token || '')
  let currentGame = 'gs'
  let currentName = ''
  const modal = (() => {
    const m = document.createElement('div')
    m.className = 'pn-modal-mask'
    m.innerHTML = '<div class="pn-modal"><div class="pn-modal-head"><span class="pn-modal-title"></span><button class="pn-close">×</button></div><div class="pn-imgs"></div></div>'
    document.body.appendChild(m)
    m.querySelector('.pn-close').addEventListener('click', () => m.classList.remove('on'))
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('on') })
    return m
  })()

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
  function headers(json) { const h = { [g.tokenKey || 'guoba-access-token']: g.token || '' }; if (json) h['Content-Type'] = 'application/json'; return h }
  async function api(path, opts) { const r = await fetch(g.apiBase + path, opts); return await r.json() }
  function imgUrl(file) { return g.apiBase + '/panel/img?game=' + encodeURIComponent(currentGame) + '&name=' + encodeURIComponent(currentName) + '&file=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(g.token || '') }

  async function renderStats() {
    try {
      const [gs, sr] = await Promise.all([
        api('/panel/list?game=gs', { headers: headers() }),
        api('/panel/list?game=sr', { headers: headers() }),
      ])
      const gsList = gs?.result || []
      const srList = sr?.result || []
      const gsImgs = gsList.reduce((n, p) => n + (p.count || 0), 0)
      const srImgs = srList.reduce((n, p) => n + (p.count || 0), 0)
      const cells = [
        { cls: 'chars', k: '角色总数', v: gsList.length + srList.length },
        { cls: 'imgs', k: '图片总数', v: gsImgs + srImgs },
        { cls: 'gs', k: '原神', v: gsList.length },
        { cls: 'sr', k: '星穹铁道', v: srList.length },
      ]
      stats.innerHTML = cells.map(c => '<div class="pn-stat ' + c.cls + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div></div>').join('')
    } catch (e) { stats.innerHTML = '' }
  }

  async function load() {
    cards.innerHTML = '<div class="pn-empty">加载中…</div>'
    renderStats()
    try {
      const json = await api('/panel/list?game=' + currentGame, { headers: headers() })
      const list = json?.result || []
      meta.textContent = '共 ' + list.length + ' 个角色'
      if (!list.length) { cards.innerHTML = '<div class="pn-empty">还没有上传面板图，用「#米哈游上传&lt;角色&gt;面板图」上传</div>'; return }
      cards.innerHTML = list.map(p => '<div class="pn-card" data-name="' + esc(p.name) + '" data-cover="' + esc(p.cover) + '">'
        + '<img class="pn-cover" src="' + imgUrl(p.cover) + '" loading="lazy" />'
        + '<div class="pn-body"><div class="pn-name"><img class="pn-game ' + (GAME[currentGame]?.cls || '') + '" src="' + iconUrl(currentGame) + '" title="' + esc(GAME[currentGame]?.name || currentGame) + '" alt="" /><span>' + esc(p.name) + '</span></div><div class="pn-count">' + p.count + ' 张</div></div>'
        + '</div>').join('')
      cards.querySelectorAll('.pn-card').forEach(c => c.addEventListener('click', () => open(c.dataset.name)))
    } catch (err) {
      cards.innerHTML = '<div class="pn-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  async function open(name) {
    currentName = name
    const json = await api('/panel/files?game=' + currentGame + '&name=' + encodeURIComponent(name), { headers: headers() })
    const files = json?.result || []
    modal.querySelector('.pn-modal-title').textContent = name + ' · ' + files.length + ' 张'
    const wrap = modal.querySelector('.pn-imgs')
    wrap.innerHTML = files.map(f => '<div class="pn-img-wrap"><img class="pn-img" src="' + imgUrl(f) + '" loading="lazy" /><button class="pn-del" data-file="' + esc(f) + '">删除</button></div>').join('')
    wrap.querySelectorAll('.pn-del').forEach(b => b.addEventListener('click', async e => {
      e.stopPropagation()
      if (!confirm('删除这张图？')) return
      const d = await api('/panel/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ game: currentGame, name, file: b.dataset.file }) })
      if (!d?.ok) { alert(d?.message || '删除失败'); return }
      open(name)
      load()
    }))
    modal.classList.add('on')
  }

  el('pn-game').addEventListener('change', e => { currentGame = e.target.value; load() })
  el('pn-refresh').addEventListener('click', load)
  el('pn-up-btn').addEventListener('click', async () => {
    const name = el('pn-up-name').value.trim()
    const fileInput = el('pn-up-file')
    if (!name) { el('pn-up-msg').className = 'pn-up-msg err'; el('pn-up-msg').textContent = '请先填角色名'; return }
    if (!fileInput.files.length) { el('pn-up-msg').className = 'pn-up-msg err'; el('pn-up-msg').textContent = '请选择图片'; return }
    const fd = new FormData()
    fd.append('game', currentGame)
    fd.append('name', name)
    for (const f of fileInput.files) fd.append('files', f)
    el('pn-up-msg').className = 'pn-up-msg'; el('pn-up-msg').textContent = '上传中…'
    try {
      const res = await fetch(g.apiBase + '/panel/upload', { method: 'POST', headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' }, body: fd })
      const json = await res.json()
      el('pn-up-msg').className = 'pn-up-msg ' + (json?.ok ? 'ok' : 'err')
      el('pn-up-msg').textContent = json?.message || (json?.ok ? '上传成功' : '上传失败')
      if (json?.ok) { el('pn-up-name').value = ''; fileInput.value = ''; renderStats(); load() }
    } catch (err) {
      el('pn-up-msg').className = 'pn-up-msg err'
      el('pn-up-msg').textContent = '上传失败：' + (err && err.message || err)
    }
  })
  load()
})();
