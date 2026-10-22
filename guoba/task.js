(function () {
  const g = window.__GUOBA__ || {}
  const body = document.getElementById('hth-body')
  const cards = document.getElementById('hth-cards')
  const meta = document.getElementById('hth-meta')
  const el = id => document.getElementById(id)
  const STATUS = { ok: '成功', signed: '已完成', fail: '失败', skip: '跳过' }
  const SOURCE = { manual: '手动', cron: '定时', event: '事件' }
  const GAME = { gs: '💠', sr: '🌌', zzz: '⚡', bh3: '⚔️' }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  function fmt(at) {
    const d = new Date(Number(at) || 0)
    const p = n => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function headers() { return { [g.tokenKey || 'guoba-access-token']: g.token || '' } }
  function query() {
    const p = new URLSearchParams()
    if (el('hth-qq').value.trim()) p.set('qq', el('hth-qq').value.trim())
    if (el('hth-task').value) p.set('task', el('hth-task').value)
    if (el('hth-status').value) p.set('status', el('hth-status').value)
    p.set('days', el('hth-days').value)
    p.set('limit', el('hth-limit').value)
    return p.toString()
  }

  async function loadSummary() {
    try {
      const res = await fetch(g.apiBase + '/summary?days=' + el('hth-days').value, { headers: headers() })
      const json = await res.json()
      const list = json?.result || []
      if (!list.length) { cards.innerHTML = ''; return }
      cards.innerHTML = list.map(t => '<div class="hth-card">'
        + '<div class="k">' + esc(t.taskName) + '</div>'
        + '<div class="v">' + t.total + '</div>'
        + '<div class="s">'
        + '<span class="ok">成功 ' + t.ok + '</span> · '
        + '<span class="signed">已签 ' + t.signed + '</span> · '
        + '<span class="fail">失败 ' + t.fail + '</span>'
        + (t.skip ? ' · <span class="skip">跳过 ' + t.skip + '</span>' : '')
        + '</div></div>').join('')
    } catch (e) { cards.innerHTML = '' }
  }

  async function load() {
    body.innerHTML = '<tr><td colspan="9" class="hth-empty">加载中…</td></tr>'
    loadSummary()
    try {
      const res = await fetch(g.apiBase + '/history?' + query(), { headers: headers() })
      const json = await res.json()
      const list = json?.result?.records || []
      const total = json?.result?.total || 0
      meta.textContent = '共 ' + total + ' 条' + (json?.result?.updatedAt ? ' · 更新于 ' + fmt(json.result.updatedAt) : '')
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="9" class="hth-empty">暂无记录</td></tr>'
        return
      }
      body.innerHTML = list.map(r => '<tr>'
        + '<td>' + fmt(r.at) + '</td>'
        + '<td>' + esc(r.taskName) + '</td>'
        + '<td class="hth-src">' + esc(SOURCE[r.source] || r.source || '') + '</td>'
        + '<td>' + esc(r.qq) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + (GAME[r.game] || '') + ' ' + esc(r.game) + '</td>'
        + '<td>' + esc(r.uid) + '</td>'
        + '<td><span class="hth-badge hth-' + esc(r.status) + '">' + esc(STATUS[r.status] || r.status) + '</span></td>'
        + '<td class="hth-tip" title="' + esc(r.tip) + '">' + esc(r.tip) + '</td>'
        + '</tr>').join('')
    } catch (err) {
      body.innerHTML = '<tr><td colspan="9" class="hth-empty">加载失败：' + esc(err && err.message || err) + '</td></tr>'
    }
  }

  el('hth-refresh').addEventListener('click', load)
  el('hth-qq').addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  ;['hth-task', 'hth-status', 'hth-days', 'hth-limit'].forEach(id => el(id).addEventListener('change', load))
  load()
})();
