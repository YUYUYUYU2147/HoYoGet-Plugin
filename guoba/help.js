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

  const GAME_META = {
    gs: { name: '原神', color: '#e9a23b' },
    sr: { name: '星穹铁道', color: '#6a7fd0' },
    zzz: { name: '绝区零', color: '#3aa6a0' },
    bh3: { name: '崩坏3', color: '#c26a9a' },
    common: { name: '通用', color: '#7de2ff' },
  }
  const GAME_ORDER = ['gs', 'sr', 'zzz', 'bh3', 'common']
  const iconUrl = game => g.apiBase + '/game/icon?game=' + encodeURIComponent(game) + '&token=' + encodeURIComponent(g.token || '')

  let groups = []
  let themes = []
  let version = ''
  let gameFilter = ''
  let toastTimer = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }

  /** 从标题/说明里认游戏；同时提到多个游戏就算通用 */
  function gameOfItem(item = {}, groupName = '') {
    const text = `${item.title || ''} ${item.desc || ''} ${groupName || ''}`
    const hit = []
    if (/原神|提瓦特|原石|七圣|尘歌壶|深境螺旋|幻想真境|风神|岩神|雷神|草神/.test(text)) hit.push('gs')
    if (/星铁|星穹|崩铁|星琼|模拟宇宙|忘却之庭|虚构叙事|末日幻影|差分宇宙|货币战争|寰宇蝗灾|黄金与机械/.test(text)) hit.push('sr')
    if (/绝区零|ZZZ|%|菲林|邦布|音擎|驱动盘|调频|式舆|危局|临界推演|空洞/.test(text)) hit.push('zzz')
    if (/崩三|崩坏3|崩坏三|bbb|往世乐土|超弦空间|记忆战场|休伯利安|母带/.test(text)) hit.push('bh3')
    if (hit.length === 1) return hit[0]
    return 'common'
  }

  function normalize(raw) {
    const list = Array.isArray(raw) ? raw : (raw?.helpList || raw?.groups || raw?.list || raw?.data || [])
    return list.map(group => {
      const groupName = String(group?.group || '未分组')
      const groupItems = (group?.list || []).map(item => {
        const icon = Number(item?.icon) || 0
        const x = icon ? ((icon - 1) % 10) : 0
        const y = icon ? ((icon - x - 1) / 10) : 0
        return {
          title: String(item?.title || ''),
          desc: String(item?.desc || ''),
          icon,
          x, y,
          game: gameOfItem(item, groupName),
        }
      }).filter(i => i.title || i.desc)
      const counts = {}
      for (const item of groupItems) counts[item.game] = (counts[item.game] || 0) + 1
      const game = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'common'
      return {
        group: groupName,
        auth: group?.auth || '',
        game,
        list: groupItems,
      }
    }).filter(g => g.list.length)
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
      + '<div class="hp-stat"><div class="k">当前显示</div><div class="v">' + shownCount + '</div></div>'
      + '<div class="hp-stat"><div class="k">帮助主题</div><div class="v">' + (themes.length || 1) + '</div></div>'
      + '<div class="hp-stat"><div class="k">支持游戏</div><div class="v">4</div></div>'
  }

  /** 顶部游戏筛选：官方图标 + 该游戏指令数 */
  function renderGames() {
    const counts = { common: 0 }
    for (const group of groups) for (const item of group.list) counts[item.game] = (counts[item.game] || 0) + 1
    const chips = GAME_ORDER.map(game => {
      const meta = GAME_META[game]
      const count = counts[game] || 0
      const icon = game === 'common'
        ? '<span class="hp-game-dot" style="--hp-game:' + meta.color + '">✦</span>'
        : '<img src="' + iconUrl(game) + '" alt="" onerror="this.style.display=\'none\'" />'
      return '<button class="hp-game-chip' + (gameFilter === game ? ' on' : '') + (count ? '' : ' off') + '" data-game="' + game + '" style="--hp-game:' + meta.color + '"' + (count ? '' : ' disabled') + '>'
        + icon + '<span>' + meta.name + '</span><b>' + count + '</b></button>'
    }).join('')
    const all = '<button class="hp-game-chip' + (gameFilter === '' ? ' on' : '') + '" data-game="" style="--hp-game:#7de2ff"><span>全部</span><b>' + groups.reduce((n, g) => n + g.list.length, 0) + '</b></button>'
    const box = el('hp-games')
    if (!box) return
    box.innerHTML = all + chips
    box.querySelectorAll('.hp-game-chip').forEach(btn => {
      btn.addEventListener('click', () => { gameFilter = btn.dataset.game || ''; renderGames(); render() })
    })
  }

  /** 指令状态标签：只根据文案明确提到的内容给标签，不臆测 */
  function tagsOf(item, group) {
    const tags = []
    if (group.auth === 'master') tags.push({ t: '主人', c: 'red' })
    const text = item.title + ' ' + item.desc
    if (/扫码|CK|cookie|绑定|登录/i.test(text)) tags.push({ t: '需CK', c: 'amber' })
    if (/自动|推送|定时|每天/.test(text)) tags.push({ t: '自动', c: 'green' })
    return tags
  }

  function render() {
    const q = String(searchEl?.value || '').trim().toLowerCase()
    const only = groupSel?.value || ''
    const shown = groups.map(group => {
      if (only && group.group !== only) return { ...group, list: [] }
      let list = group.list
      if (gameFilter) list = list.filter(i => i.game === gameFilter)
      if (q) list = list.filter(i => (i.title + ' ' + i.desc).toLowerCase().includes(q))
      return { ...group, list }
    }).filter(group => group.list.length)

    renderStats(shown)
    metaEl.textContent = '共 ' + groups.length + ' 个板块 / '
      + groups.reduce((n, g) => n + g.list.length, 0) + ' 条指令'
      + (q || only ? ' · 已筛选' : '')
      + (metaEl.dataset.theme ? ' · 主题 ' + metaEl.dataset.theme : '')

    if (!shown.length) {
      groupsEl.innerHTML = '<div class="hp-empty">没有匹配的指令，换个关键词试试</div>'
      return
    }

    groupsEl.innerHTML = shown.map(group => {
      const accent = GAME_META[group.game]?.color || accentOf(group.group)
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
          const tags = tagsOf(item, group).map(t => '<span class="hp-tag ' + t.c + '">' + t.t + '</span>').join('')
          return '<div class="hp-card" data-cmd="' + esc(commandOf(item.title)) + '">'
            + '<div class="copy">复制</div>'
            + icon
            + '<div class="hp-card-main">'
            + '<div class="t">' + esc(item.title) + '</div>'
            + (item.desc ? '<div class="d">' + esc(item.desc) + '</div>' : '')
            + (tags ? '<div class="hp-tags">' + tags + '</div>' : '')
            + '</div>'
            + '</div>'
        }).join('')
        + '</div></section>'
    }).join('')

    groupsEl.querySelectorAll('.hp-card').forEach(card => {
      card.addEventListener('click', () => copy(card.dataset.cmd || ''))
    })
  }

  async function loadLogo() {
    try {
      const res = await fetch(g.apiBase + '/help/logo', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      if (!res.ok) return
      const img = el('hp-logo')
      if (img) img.src = URL.createObjectURL(await res.blob())
    } catch { /* Logo 失败不影响内容 */ }
  }

  let themeName = ''
  async function loadBackground(payload, name) {
    const root = document.querySelector('.hoyo-help')
    if (!root || !name) return
    themeName = name
    let themeUrl = ''
    try {
      const res = await fetch(g.apiBase + '/help/theme?name=' + encodeURIComponent(name) + '&file=bg', {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      if (res.ok) themeUrl = URL.createObjectURL(await res.blob())
    } catch { /* 主题图失败不影响内容 */ }

    const cfg = payload.helpCfg || payload || {}
    const mode = String(cfg.background || 'mix').toLowerCase()
    const api = String(cfg.backgroundApi || 'https://api.yppp.net/pc.php')
    const useApi = /^https?:\/\//i.test(api) && (mode === 'api' || (mode === 'mix' && Math.random() < 0.5))

    if (themeUrl) root.style.setProperty('--hp-bg-fallback', 'url("' + themeUrl + '")')
    // API 背景失败时由 CSS 的 fallback 层接住，不会露白
    if (useApi) {
      root.style.setProperty('--hp-bg', 'url("' + api.replace(/["'\\()]/g, '') + '")')
      metaEl.dataset.theme = '随机背景'
    } else {
      if (themeUrl) root.style.setProperty('--hp-bg', 'url("' + themeUrl + '")')
      metaEl.dataset.theme = name
    }
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
      themes = Array.isArray(payload.themes) ? payload.themes : []
      version = String(payload.version || '')
      const cfg = payload.helpCfg || payload
      const titleEl = el('hp-title')
      const subEl = el('hp-sub')
      if (titleEl && cfg.title) titleEl.textContent = cfg.title
      if (subEl && (cfg.subTitle || cfg.subtitle)) subEl.textContent = cfg.subTitle || cfg.subtitle
      const kicker = document.querySelector('.hp-kicker')
      if (kicker && version) kicker.textContent = 'HoYoGet v' + version + ' · Global Help'
      await loadSprite()
      await loadBackground(payload, payload.theme || 'default')
      renderGames()
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
  loadLogo()
  load()
})();
