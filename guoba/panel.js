(function () {
  const g = window.__GUOBA__ || {}
  const cards = document.getElementById('pn-cards')
  const stats = document.getElementById('pn-stats')
  const meta = document.getElementById('pn-meta')
  const el = id => document.getElementById(id)
  const uploadBox = el('pn-upload')

  const GAMES = {
    gs: { name: '原神', cls: 'pn-g-gs' },
    sr: { name: '崩坏：星穹铁道', cls: 'pn-g-sr' },
    zzz: { name: '绝区零', cls: 'pn-g-zzz' },
    waves: { name: '鸣潮', cls: 'pn-g-waves' },
  }
  const PANEL_GAMES = ['gs', 'sr', 'zzz']
  const COWCOO_GAMES = ['gs', 'sr', 'zzz', 'waves']
  const iconUrl = game => g.apiBase + '/game/icon?game=' + encodeURIComponent(game) + '&token=' + encodeURIComponent(g.token || '')

  let currentSource = 'panel'
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
  function imgUrl(file, game, source) {
    return g.apiBase + '/panel/img?source=' + encodeURIComponent(source) + '&game=' + encodeURIComponent(game) + '&name=' + encodeURIComponent(currentName) + '&file=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(g.token || '')
  }

  function fillGameSelect() {
    const games = currentSource === 'cowcoo' ? COWCOO_GAMES : PANEL_GAMES
    const sel = el('pn-game')
    sel.innerHTML = games.map(k => '<option value="' + k + '">' + esc(GAMES[k]?.name || k) + '</option>').join('')
    if (!games.includes(currentGame)) currentGame = games[0]
    sel.value = currentGame
  }

  function syncUploadVisibility() {
    uploadBox.style.display = currentSource === 'cowcoo' ? 'none' : 'flex'
  }

  function gameBadge(game) {
    const gm = GAMES[game] || { name: game, cls: '' }
    return '<img class="pn-game ' + gm.cls + '" src="' + iconUrl(game) + '" title="' + esc(gm.name) + '" alt="" onerror="this.style.display=\'none\'" />'
  }

  async function renderStats() {
    try {
      const [gs, sr, zzz] = await Promise.all([
        api('/panel/list?game=gs', { headers: headers() }),
        api('/panel/list?game=sr', { headers: headers() }),
        api('/panel/list?game=zzz', { headers: headers() }),
      ])
      const gsList = gs?.result || []
      const srList = sr?.result || []
      const zzzList = zzz?.result || []
      const gsImgs = gsList.reduce((n, p) => n + (p.count || 0), 0)
      const srImgs = srList.reduce((n, p) => n + (p.count || 0), 0)
      const zzzImgs = zzzList.reduce((n, p) => n + (p.count || 0), 0)
      const cells = [
        { cls: 'chars', k: '角色总数', v: gsList.length + srList.length + zzzList.length },
        { cls: 'imgs', k: '图片总数', v: gsImgs + srImgs + zzzImgs },
        { cls: 'gs', k: '原神', v: gsList.length },
        { cls: 'sr', k: '星穹铁道', v: srList.length },
        { cls: 'zzz', k: '绝区零', v: zzzList.length },
      ]
      stats.innerHTML = cells.map(c => '<div class="pn-stat ' + c.cls + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div></div>').join('')
    } catch (e) { stats.innerHTML = '' }
  }

  async function load() {
    cards.innerHTML = '<div class="pn-empty">加载中…</div>'
    if (currentSource === 'panel') renderStats()
    else stats.innerHTML = ''
    try {
      const json = await api('/panel/list?source=' + currentSource + '&game=' + currentGame, { headers: headers() })
      const list = json?.result || []
      meta.textContent = '共 ' + list.length + ' 个角色'
      if (!list.length) {
        cards.innerHTML = '<div class="pn-empty">' + (currentSource === 'cowcoo' ? '咕咕牛图库没有这个游戏的图库' : '还没有上传面板图，用「#米哈游上传&lt;角色&gt;面板图」上传') + '</div>'
        return
      }
      cards.innerHTML = list.map(p => '<div class="pn-card" data-name="' + esc(p.name) + '">'
        + '<img class="pn-cover" src="' + imgUrl(p.cover, currentGame, currentSource) + '" loading="lazy" />'
        + '<div class="pn-body"><div class="pn-name">' + gameBadge(currentGame) + '<span>' + esc(p.name) + '</span></div><div class="pn-count">' + p.count + ' 张</div></div>'
        + '</div>').join('')
      cards.querySelectorAll('.pn-card').forEach(c => c.addEventListener('click', () => open(c.dataset.name)))
    } catch (err) {
      cards.innerHTML = '<div class="pn-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  async function open(name) {
    currentName = name
    const json = await api('/panel/files?source=' + currentSource + '&game=' + currentGame + '&name=' + encodeURIComponent(name), { headers: headers() })
    const files = json?.result || []
    modal.querySelector('.pn-modal-title').textContent = name + ' · ' + files.length + ' 张'
    const wrap = modal.querySelector('.pn-imgs')
    const isReadonly = currentSource === 'cowcoo'
    wrap.innerHTML = files.map(f => '<div class="pn-img-wrap"><img class="pn-img" src="' + imgUrl(f, currentGame, currentSource) + '" loading="lazy" />'
      + (isReadonly ? '' : '<button class="pn-del" data-file="' + esc(f) + '">删除</button>')
      + '</div>').join('')
    if (!isReadonly) {
      wrap.querySelectorAll('.pn-del').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm('删除这张图？')) return
        const d = await api('/panel/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ game: currentGame, name, file: b.dataset.file }) })
        if (!d?.ok) { alert(d?.message || '删除失败'); return }
        open(name)
        load()
      }))
    }
    modal.classList.add('on')
  }

  el('pn-source').addEventListener('change', e => {
    currentSource = e.target.value
    fillGameSelect()
    syncUploadVisibility()
    load()
  })
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

  fillGameSelect()
  syncUploadVisibility()
  load()
})();
