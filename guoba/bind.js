(function () {
  const g = window.__GUOBA__ || {}
  const list = document.getElementById('hb-list')
  const meta = document.getElementById('hb-meta')
  const qqEl = document.getElementById('hb-qq')
  const gameEl = document.getElementById('hb-game')
  const NAME = { gs: '原神', sr: '崩坏：星穹铁道', zzz: '绝区零', bh3: '崩坏3' }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  async function load() {
    list.innerHTML = '<div class="hb-empty">加载中…</div>'
    try {
      const res = await fetch(g.apiBase + '/bindings', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      const json = await res.json()
      let users = json?.result?.users || []
      const qq = qqEl.value.trim()
      if (qq) users = users.filter(u => u.qq.includes(qq))
      const game = gameEl.value
      if (game) {
        users = users
          .map(u => ({ ...u, accounts: u.accounts.filter(a => a.game === game) }))
          .filter(u => u.accounts.length)
      }
      meta.textContent = '共 ' + users.length + ' 个 QQ'
      if (!users.length) {
        list.innerHTML = '<div class="hb-empty">暂无绑定</div>'
        return
      }
      list.innerHTML = users.map(u => {
        const tags = Object.entries(u.byGame)
          .map(([k, n]) => '<span class="hb-tag">' + esc(NAME[k] || k) + ' ' + n + '</span>')
          .join('')
        const rows = u.accounts.map(a => '<tr>'
          + '<td class="hb-game hb-' + esc(a.game) + '">' + esc(a.gameName) + '</td>'
          + '<td>' + esc(a.uidMask) + '</td>'
          + '<td>' + esc(a.region) + '</td>'
          + '<td>' + esc(a.stuidMask) + '</td>'
          + '</tr>').join('')
        return '<div class="hb-card">'
          + '<div class="hb-head"><span class="hb-qq">' + esc(u.qq) + '</span>'
          + '<span class="hb-tag">共 ' + u.total + ' 个号</span>'
          + '<span class="hb-tags">' + tags + '</span></div>'
          + '<table class="hb-table"><thead><tr><th>游戏</th><th>UID</th><th>区服</th><th>通行证</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table></div>'
      }).join('')
    } catch (err) {
      list.innerHTML = '<div class="hb-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  document.getElementById('hb-refresh').addEventListener('click', load)
  qqEl.addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  gameEl.addEventListener('change', load)
  load()
})();
