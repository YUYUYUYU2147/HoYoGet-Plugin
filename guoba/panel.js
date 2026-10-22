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
    m.innerHTML = '<div class="pn-modal">'
      + '<div class="pn-modal-head"><span class="pn-modal-title"></span><span class="pn-modal-count"></span><button class="pn-close">×</button></div>'
      + '<div class="pn-viewer"><img class="pn-viewer-img" alt="" /><button class="pn-nav pn-prev">‹</button><button class="pn-nav pn-next">›</button></div>'
      + '<div class="pn-thumbs"></div>'
      + '</div>'
    document.body.appendChild(m)
    m.querySelector('.pn-close').addEventListener('click', () => m.classList.remove('on'))
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('on') })
    return m
  })()

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
  function headers(json) { const h = { [g.tokenKey || 'guoba-access-token']: g.token || '' }; if (json) h['Content-Type'] = 'application/json'; return h }
  async function api(path, opts) { const r = await fetch(g.apiBase + path, opts); return await r.json() }
  function imgUrl(file, game, source, name) {
    return g.apiBase + '/panel/img?source=' + encodeURIComponent(source) + '&game=' + encodeURIComponent(game) + '&name=' + encodeURIComponent(name || currentName) + '&file=' + encodeURIComponent(file) + '&token=' + encodeURIComponent(g.token || '')
  }
  function splashUrl(game, name) {
    return g.apiBase + '/panel/splash?game=' + encodeURIComponent(game) + '&name=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(g.token || '')
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
      cards.innerHTML = list.map(p => {
        const coverSrc = p.splash ? splashUrl(currentGame, p.name) : imgUrl(p.cover, currentGame, currentSource, p.name)
        const fallback = p.splash ? " onerror=\"this.onerror=null;this.src='" + imgUrl(p.cover, currentGame, currentSource, p.name) + "'\"" : ''
        return '<div class="pn-card" data-name="' + esc(p.name) + '">'
          + '<img class="pn-cover" src="' + coverSrc + '" loading="lazy"' + fallback + ' />'
          + '<div class="pn-body"><div class="pn-name">' + gameBadge(currentGame) + '<span>' + esc(p.name) + '</span></div><div class="pn-count">' + p.count + ' 张</div></div>'
          + '</div>'
      }).join('')
      cards.querySelectorAll('.pn-card').forEach(c => c.addEventListener('click', () => open(c.dataset.name)))
    } catch (err) {
      cards.innerHTML = '<div class="pn-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  let viewerFiles = []
  let viewerIndex = 0

  function renderViewer() {
    const f = viewerFiles[viewerIndex]
    if (!f) return
    const viewer = modal.querySelector('.pn-viewer-img')
    viewer.src = imgUrl(f, currentGame, currentSource)
    modal.querySelector('.pn-modal-count').textContent = (viewerIndex + 1) + ' / ' + viewerFiles.length
    const thumbs = modal.querySelectorAll('.pn-thumb')
    thumbs.forEach((t, i) => t.classList.toggle('on', i === viewerIndex))
    const on = modal.querySelector('.pn-thumb.on')
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' })
  }
  function viewerStep(d) {
    if (!viewerFiles.length) return
    viewerIndex = (viewerIndex + d + viewerFiles.length) % viewerFiles.length
    renderViewer()
  }

  async function open(name) {
    currentName = name
    const json = await api('/panel/files?source=' + currentSource + '&game=' + currentGame + '&name=' + encodeURIComponent(name), { headers: headers() })
    const files = json?.result || []
    viewerFiles = files
    viewerIndex = 0
    modal.querySelector('.pn-modal-title').textContent = name
    const isReadonly = currentSource === 'cowcoo'
    const thumbs = modal.querySelector('.pn-thumbs')
    thumbs.innerHTML = files.map((f, i) => '<div class="pn-thumb' + (i === 0 ? ' on' : '') + '" data-i="' + i + '">'
      + '<img src="' + imgUrl(f, currentGame, currentSource) + '" loading="lazy" />'
      + (isReadonly ? '' : '<button class="pn-del" data-file="' + esc(f) + '" title="删除">×</button>')
      + '</div>').join('')
    thumbs.querySelectorAll('.pn-thumb').forEach(t => {
      t.addEventListener('click', e => {
        if (e.target.classList.contains('pn-del')) return
        viewerIndex = Number(t.dataset.i)
        renderViewer()
      })
    })
    if (!isReadonly) {
      thumbs.querySelectorAll('.pn-del').forEach(b => b.addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm('删除这张图？')) return
        const d = await api('/panel/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ game: currentGame, name, file: b.dataset.file }) })
        if (!d?.ok) { alert(d?.message || '删除失败'); return }
        viewerFiles.splice(viewerFiles.indexOf(b.dataset.file), 1)
        if (viewerIndex >= viewerFiles.length) viewerIndex = Math.max(0, viewerFiles.length - 1)
        open(name)
        load()
      }))
    }
    modal.querySelector('.pn-prev').onclick = () => viewerStep(-1)
    modal.querySelector('.pn-next').onclick = () => viewerStep(1)
    renderViewer()
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
