(function () {
  const g = window.__GUOBA__ || {}
  const groupsEl = document.getElementById('hp-groups')
  const statsEl = document.getElementById('hp-stats')
  const metaEl = document.getElementById('hp-meta')
  const searchEl = document.getElementById('hp-search')
  const groupSel = document.getElementById('hp-group')
  const toastEl = document.getElementById('hp-toast')
  const el = id => document.getElementById(id)

  const ACCENTS = [
    { re: /原神|星铁|星穹|崩铁|绝区零/, color: '#f0b25a' },
    { re: /崩坏3|崩三|崩坏三|崩二|未定/, color: '#e879b9' },
    { re: /卡池|抽卡|调频|跃迁/, color: '#f59e0b' },
    { re: /图鉴|怪物|首领|敌人|材料/, color: '#34d399' },
    { re: /bilibili|B站/i, color: '#fb7185' },
    { re: /设备|账号|主人|设置/, color: '#60a5fa' },
  ]
  const accentOf = name => (ACCENTS.find(a => a.re.test(name)) || { color: '#7de2ff' }).color

  let groups = []
  let toastTimer = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : (raw?.helpList || raw?.groups || raw?.list || raw?.data || [])
    return list.map(group => ({
      group: String(group?.group || '未分组'),
      auth: group?.auth || '',
      list: (group?.list || []).map(item => {
        const icon = Number(item?.icon) || 0
        const x = icon ? ((icon - 1) % 10) : 0
        const y = icon ? ((icon - x - 1) / 10) : 0
        return {
          title: String(item?.title || ''),
          desc: String(item?.desc || ''),
          icon,
          x, y,
        }
      }).filter(i => i.title || i.desc),
    })).filter(g => g.list.length)
  }

  function commandOf(title) {
    const text = String(title || '').trim()
    const m = text.match(/[#*%!&]\S+/)
    return m ? m[0] : text.split(/[\s/／|｜]+/)[0] || text
  }

  function showToast(text) {
    if (!toastEl) return
    toastEl.textContent = text
    toastEl.classList.add('on')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1400)
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制：' + text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy'); showToast('已复制：' + text) } catch { showToast('复制失败') }
      ta.remove()
    }
  }

  function renderStats(shown) {
    const total = groups.reduce((n, g) => n + g.list.length, 0)
    const shownCount = shown.reduce((n, g) => n + g.list.length, 0)
    statsEl.innerHTML =
      '<div class="hp-stat"><div class="k">指令总数</div><div class="v">' + total + '</div></div>'
      + '<div class="hp-stat"><div class="k">板块</div><div class="v">' + groups.length + '</div></div>'
      + '<div class="hp-stat"><div class="k">当前显示</div><div class="v">' + shownCount + '</div></div>'
      + '<div class="hp-stat"><div class="k">前缀</div><div class="v"># * %</div></div>'
  }

  function render() {
    const q = String(searchEl?.value || '').trim().toLowerCase()
    const only = groupSel?.value || ''
    const shown = groups.map(group => {
      if (only && group.group !== only) return { ...group, list: [] }
      const list = q
        ? group.list.filter(i => (i.title + ' ' + i.desc).toLowerCase().includes(q))
        : group.list
      return { ...group, list }
    }).filter(group => group.list.length)

    renderStats(shown)
    metaEl.textContent = '共 ' + groups.length + ' 个板块 / '
      + groups.reduce((n, g) => n + g.list.length, 0) + ' 条指令'
      + (q || only ? ' · 已筛选' : '')

    if (!shown.length) {
      groupsEl.innerHTML = '<div class="hp-empty">没有匹配的指令，换个关键词试试</div>'
      return
    }

    groupsEl.innerHTML = shown.map(group => {
      const accent = accentOf(group.group)
      return '<section class="hp-group" style="--hp-accent:' + accent + '">'
        + '<div class="hp-group-head">'
        + '<i class="hp-group-dot"></i>'
        + '<span class="hp-group-title">' + esc(group.group) + '</span>'
        + '<span class="hp-group-count">' + group.list.length + '</span>'
        + (group.auth === 'master' ? '<span class="hp-group-master">主人专用</span>' : '')
        + '</div>'
        + '<div class="hp-cards">'
        + group.list.map(item => {
          const icon = item.icon
            ? '<span class="hp-icon"><i style="background-position:-' + item.x * 100 + 'px -' + item.y * 100 + 'px"></i></span>'
            : ''
          return '<div class="hp-card" data-cmd="' + esc(commandOf(item.title)) + '">'
            + '<div class="copy">复制</div>'
            + icon
            + '<div class="hp-card-main">'
            + '<div class="t">' + esc(item.title) + '</div>'
            + (item.desc ? '<div class="d">' + esc(item.desc) + '</div>' : '')
            + '</div>'
            + '</div>'
        }).join('')
        + '</div></section>'
    }).join('')

    groupsEl.querySelectorAll('.hp-card').forEach(card => {
      card.addEventListener('click', () => copy(card.dataset.cmd || ''))
    })
  }

  let spriteUrl = ''
  async function loadSprite() {
    if (spriteUrl) return
    try {
      const res = await fetch(g.apiBase + '/help/icon', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      if (!res.ok) return
      spriteUrl = URL.createObjectURL(await res.blob())
      groupsEl.style.setProperty('--hp-icon-url', 'url("' + spriteUrl + '")')
    } catch { /* 图标失败不影响文字 */ }
  }

  async function load() {
    groupsEl.innerHTML = '<div class="hp-empty">加载中…</div>'
    try {
      const res = await fetch(g.apiBase + '/help', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      const json = await res.json()
      if (!json?.ok) throw new Error(json?.message || '加载失败')
      const payload = json.result || {}
      groups = normalize(payload)
      const cfg = payload.helpCfg || payload
      const titleEl = el('hp-title')
      const subEl = el('hp-sub')
      if (titleEl && cfg.title) titleEl.textContent = cfg.title
      if (subEl && (cfg.subTitle || cfg.subtitle)) subEl.textContent = cfg.subTitle || cfg.subtitle
      await loadSprite()
      const options = groups.map(group => '<option value="' + esc(group.group) + '">' + esc(group.group) + '</option>').join('')
      groupSel.innerHTML = '<option value="">全部板块</option>' + options
      render()
    } catch (err) {
      groupsEl.innerHTML = '<div class="hp-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  searchEl?.addEventListener('input', render)
  groupSel?.addEventListener('change', render)
  el('hp-refresh')?.addEventListener('click', load)
  load()
})();
