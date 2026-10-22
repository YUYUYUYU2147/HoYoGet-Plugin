(function () {
  const g = window.__GUOBA__ || {}
  const cards = document.getElementById('ck-cards')
  const stats = document.getElementById('ck-stats')
  const meta = document.getElementById('ck-meta')
  const el = id => document.getElementById(id)
  const editor = el('ck-editor')
  let editing = null

  const GAME = {
    gs: { name: '原神', icon: '💠', cls: 'ck-g-gs' },
    sr: { name: '崩坏：星穹铁道', icon: '🌌', cls: 'ck-g-sr' },
    zzz: { name: '绝区零', icon: '⚡', cls: 'ck-g-zzz' },
    bh3: { name: '崩坏3', icon: '⚔️', cls: 'ck-g-bh3' },
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  function headers(json) {
    const h = { [g.tokenKey || 'guoba-access-token']: g.token || '' }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }
  async function api(path, opts) {
    const res = await fetch(g.apiBase + path, opts)
    return await res.json()
  }
  const qqAvatar = qq => 'https://q1.qlogo.cn/g?b=qq&s=140&nk=' + encodeURIComponent(qq) + '.jpg'
  const PH = 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22><rect width=%2252%22 height=%2252%22 fill=%22%23eef2f7%22/></svg>'

  let all = []

  function gameBadge(a) {
    const gm = GAME[a.game] || { name: '未知', icon: '❔', cls: '' }
    return '<span class="ck-game ' + gm.cls + '" title="' + esc(gm.name) + '">' + gm.icon + '</span>'
  }
  function statusPills(a) {
    const ck = a.hasCk ? '<span class="ck-pill ok">CK ✓</span>' : '<span class="ck-pill no">CK ✗</span>'
    const sk = a.hasSk ? '<span class="ck-pill ok">SK ✓</span>' : '<span class="ck-pill no">SK ✗</span>'
    return ck + sk
  }

  function renderStats(list) {
    const total = list.length
    const hasCk = list.filter(a => a.hasCk).length
    const hasSk = list.filter(a => a.hasSk).length
    const noCk = total - hasCk
    stats.innerHTML =
      '<div class="ck-stat total"><div class="k">账号总数</div><div class="v">' + total + '</div></div>'
      + '<div class="ck-stat ok"><div class="k">CK 可用</div><div class="v">' + hasCk + '</div></div>'
      + '<div class="ck-stat sk"><div class="k">SK 可用</div><div class="v">' + hasSk + '</div></div>'
      + '<div class="ck-stat nock"><div class="k">缺 CK</div><div class="v">' + noCk + '</div></div>'
  }

  async function load() {
    cards.innerHTML = '<div class="ck-empty">加载中…</div>'
    const p = new URLSearchParams()
    if (el('ck-qq').value.trim()) p.set('qq', el('ck-qq').value.trim())
    if (el('ck-game').value) p.set('game', el('ck-game').value)
    try {
      const json = await api('/ck/list?' + p.toString(), { headers: headers() })
      all = json?.result || []
      let list = all
      const st = el('ck-status').value
      if (st === 'ok') list = list.filter(a => a.hasCk)
      else if (st === 'nock') list = list.filter(a => !a.hasCk)
      meta.textContent = '共 ' + list.length + ' 个账号'
      renderStats(all)
      if (!list.length) {
        cards.innerHTML = '<div class="ck-empty">没有匹配的账号</div>'
        return
      }
      cards.innerHTML = list.map((a, i) => {
        return '<div class="ck-card">'
          + '<img class="ck-avatar" data-i="' + i + '" src="' + qqAvatar(a.qq) + '" title="点击修改" onerror="this.src=\'' + PH + '\'" />'
          + '<div class="ck-info">'
          + '<div class="ck-name">' + gameBadge(a) + '<span>' + esc(a.gameName) + ' · ' + esc(a.uid) + '</span></div>'
          + '<div class="ck-sub">' + esc(a.region || '未知区服') + ' · ' + esc(a.qq) + ' · 通行证 ' + esc(a.stuidMask) + '</div>'
          + '<div class="ck-status">' + statusPills(a) + '</div>'
          + '</div>'
          + '<div class="ck-ops">'
          + '<button class="ck-btn" data-act="edit" data-i="' + i + '">修改</button>'
          + '<button class="ck-btn danger" data-act="del" data-i="' + i + '">删除</button>'
          + '</div>'
          + '</div>'
      }).join('')
      cards.querySelectorAll('[data-act]').forEach(btn => {
        const a = list[Number(btn.dataset.i)]
        btn.addEventListener('click', () => {
          if (btn.dataset.act === 'edit') openEditor(a)
          else remove(a)
        })
      })
      cards.querySelectorAll('.ck-avatar').forEach(av => {
        const a = list[Number(av.dataset.i)]
        av.addEventListener('click', () => openEditor(a))
      })
    } catch (err) {
      cards.innerHTML = '<div class="ck-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  async function openEditor(a) {
    el('ck-msg').textContent = ''
    const json = await api('/ck/get?qq=' + encodeURIComponent(a.qq) + '&uid=' + encodeURIComponent(a.uid), { headers: headers() })
    if (!json?.ok) { el('ck-msg').textContent = json?.message || '读取失败'; return }
    const d = json.result
    editing = { qq: d.qq, uid: d.uid }
    el('ck-editor-title').textContent = '修改账号 · ' + d.gameName + ' · ' + d.uid
    el('ck-f-qq').value = d.qq
    el('ck-f-uid').value = d.uid
    el('ck-f-stuid').value = d.stuid || ''
    el('ck-f-mid').value = d.mid || ''
    el('ck-f-ck').value = d.ck_stoken || ''
    el('ck-f-sk').value = d.stoken || ''
    editor.classList.add('on')
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function save() {
    if (!editing) return
    const payload = {
      qq: editing.qq, uid: editing.uid,
      stuid: el('ck-f-stuid').value.trim(),
      mid: el('ck-f-mid').value.trim(),
      ck: el('ck-f-ck').value.trim(),
      stoken: el('ck-f-sk').value.trim(),
    }
    el('ck-msg').textContent = '保存中…'
    const json = await api('/ck/save', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) })
    el('ck-msg').textContent = json?.message || (json?.ok ? '已保存' : '保存失败')
    if (json?.ok) { editor.classList.remove('on'); editing = null; load() }
  }

  async function remove(a) {
    if (!confirm('确定删除 ' + a.gameName + ' UID ' + a.uid + ' 的绑定？删除后需要重新扫码或手动填 CK。')) return
    const json = await api('/ck/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ qq: a.qq, uid: a.uid }) })
    if (!json?.ok) alert(json?.message || '删除失败')
    load()
  }

  el('ck-refresh').addEventListener('click', load)
  el('ck-qq').addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  el('ck-game').addEventListener('change', load)
  el('ck-status').addEventListener('change', load)
  el('ck-save').addEventListener('click', save)
  el('ck-cancel').addEventListener('click', () => { editor.classList.remove('on'); editing = null })
  load()
})();
