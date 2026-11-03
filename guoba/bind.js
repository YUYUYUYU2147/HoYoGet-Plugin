(function () {
  const g = window.__GUOBA__ || {}
  const list = document.getElementById('hb-list')
  const stats = document.getElementById('hb-stats')
  const meta = document.getElementById('hb-meta')
  const qqEl = document.getElementById('hb-qq')
  const gameEl = document.getElementById('hb-game')
  const GAME = {
    gs: { name: '原神', cls: 'hb-gs' },
    sr: { name: '崩坏：星穹铁道', cls: 'hb-sr' },
    zzz: { name: '绝区零', cls: 'hb-zzz' },
    bh3: { name: '崩坏3', cls: 'hb-bh3' },
  }
  let ICONS = {}
  const iconUrl = game => ICONS[game] || (g.apiBase + '/game/icon?game=' + encodeURIComponent(game) + '&token=' + encodeURIComponent(g.token || ''))

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  const qqAvatar = qq => 'https://q1.qlogo.cn/g?b=qq&s=140&nk=' + encodeURIComponent(qq) + '.jpg'
  const PH = 'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22><rect width=%2240%22 height=%2240%22 fill=%22%23eef2f7%22/></svg>'

  function renderStats(allUsers) {
    let total = 0
    const byGame = { gs: 0, sr: 0, zzz: 0, bh3: 0 }
    allUsers.forEach(u => {
      total += u.total || 0
      Object.entries(u.byGame || {}).forEach(([k, n]) => { if (byGame[k] != null) byGame[k] += n })
    })
    const cells = [
      { cls: 'total', k: '绑定账号总数', v: total },
      { cls: 'gs', k: '原神', v: byGame.gs },
      { cls: 'sr', k: '星穹铁道', v: byGame.sr },
      { cls: 'zzz', k: '绝区零', v: byGame.zzz },
      { cls: 'bh3', k: '崩坏3', v: byGame.bh3 },
    ].filter(c => c.cls === 'total' || c.v > 0)
    stats.innerHTML = cells.map(c => '<div class="hb-stat ' + c.cls + '"><div class="k">' + c.k + '</div><div class="v">' + c.v + '</div></div>').join('')
  }

  async function load() {
    list.innerHTML = '<div class="hb-empty">加载中…</div>'
    try {
      const res = await fetch(g.apiBase + '/bindings', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      const json = await res.json()
      ICONS = json?.result?.icons || {}
      const allUsers = json?.result?.users || []
      renderStats(allUsers)
      let users = allUsers
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
          .map(([k, n]) => '<span class="hb-tag ' + esc(k) + '"><img class="hb-tag-icon" src="' + iconUrl(k) + '" alt="" /> ' + esc(GAME[k]?.name || k) + ' ' + n + '</span>')
          .join('')
        const rows = u.accounts.map(a => '<tr>'
          + '<td class="hb-game ' + esc(a.game) + '"><span class="hb-game-badge"><img class="hb-game-icon" src="' + iconUrl(a.game) + '" alt="" /> ' + esc(a.gameName) + '</span></td>'
          + '<td class="hb-mask">' + esc(a.uidMask) + '</td>'
          + '<td>' + esc(a.region) + '</td>'
          + '<td class="hb-mask">' + esc(a.stuidMask) + '</td>'
          + '</tr>').join('')
        return '<div class="hb-card">'
          + '<div class="hb-head"><img class="hb-avatar" src="' + qqAvatar(u.qq) + '" onerror="this.src=\'' + PH + '\'" />'
          + '<div class="hb-id"><span class="hb-qq">' + esc(u.qq) + '</span>'
          + '<span class="hb-qq-sub">共 ' + u.total + ' 个号</span></div>'
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
