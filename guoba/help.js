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
    sr: { name: '崩坏：星穹铁道', color: '#6a7fd0' },
    zzz: { name: '绝区零', color: '#3aa6a0' },
    bh3: { name: '崩坏3', color: '#c26a9a' },
    common: { name: '通用', color: '#7de2ff' },
  }
  const GAME_ORDER = ['gs', 'sr', 'zzz', 'bh3', 'common']
  const STYLE_FIELDS = [
    { key: 'fontColor', label: '主文字颜色', ph: '#ceb78b' },
    { key: 'descColor', label: '说明文字颜色', ph: '#eeeeee' },
    { key: 'titleColor', label: '大标题颜色', ph: '#ffffff' },
    { key: 'subTitleColor', label: '副标题颜色', ph: '#ffffff' },
    { key: 'fontShadow', label: '文字阴影', ph: 'none / 1px 1px 2px #000' },
    { key: 'contBgColor', label: '面板底色', ph: 'rgba(6,21,31,.5)' },
    { key: 'headerBgColor', label: '板块标题底色', ph: 'rgba(6,21,31,.4)' },
    { key: 'rowBgColor1', label: '奇数行底色', ph: 'rgba(6,21,31,.2)' },
    { key: 'rowBgColor2', label: '偶数行底色', ph: 'rgba(6,21,31,.35)' },
    { key: 'tagRed', label: '标签颜色-红', ph: '#dc2626' },
    { key: 'tagAmber', label: '标签颜色-琥珀', ph: '#b45309' },
    { key: 'tagGreen', label: '标签颜色-绿', ph: '#15803d' },
    { key: 'tagGray', label: '标签颜色-灰', ph: '#6b7280' },
    { key: 'titleSize', label: '大标题字号(px)', ph: '50', size: true },
    { key: 'groupSize', label: '板块标题字号(px)', ph: '18', size: true },
    { key: 'itemSize', label: '指令标题字号(px)', ph: '16', size: true },
    { key: 'descSize', label: '说明字号(px)', ph: '13', size: true },
    { key: 'contBgBlur', label: '面板模糊(0-20)', ph: '3', size: true },
    { key: 'pageDim', label: '页面遮罩(0-100)', ph: '88', size: true },
    { key: 'pageBlur', label: '页面背景模糊(0-20)', ph: '18', size: true },
  ]
  const iconUrl = game => g.apiBase + '/game/icon?game=' + encodeURIComponent(game) + '&token=' + encodeURIComponent(g.token || '')

  let groups = []
  let themes = []
  let iconCount = 360
  let version = ''
  let gameFilter = ''
  let rawHelp = null
  let editing = false
  let draft = null
  let toastTimer = null
  const editorEl = document.getElementById('hp-editor')

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
          tag: String(item?.tag || ''),
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

  /** Hero 里的游戏前缀标签：复用 binding 页同一套 /game/icon */
  function renderHeroTags() {
    const box = el('hp-hero-tags')
    if (!box) return
    box.innerHTML = ['gs', 'sr', 'zzz', 'bh3'].map(game => {
      const meta = GAME_META[game]
      return '<span><img src="' + iconUrl(game) + '" alt="" onerror="this.style.display=\'none\'" />' + meta.name + '</span>'
    }).join('') + '<span><i class="hp-hero-plus">+</i>通用</span>'
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

  /** 状态标签：只显示配置里手写的 tag，不再从文案猜（避免把「扫码登录」标成需CK） */
  function tagsOf(item, group) {
    const tags = []
    if (group.auth === 'master') tags.push({ t: '主人', c: 'red' })
    const raw = String(item.tag || '').split(/[,，|｜]/).map(v => v.trim()).filter(Boolean)
    for (const t of raw) {
      let c = 'gray'
      if (/免CK|免费|无需|公开/i.test(t)) c = 'green'
      else if (/自动|推送|定时|每天/i.test(t)) c = 'green'
      else if (/需CK|需要CK|需扫码|需登录|需绑定|限时/i.test(t)) c = 'amber'
      else if (/主人|仅主人|失效|停用/i.test(t)) c = 'red'
      tags.push({ t, c })
    }
    return tags
  }

  function render() {
    const q = String(searchEl?.value || '').trim().toLowerCase()
    const only = groupSel?.value || ''
    const shown = groups.map(group => {
      if (only && group.group !== only) return { ...group, list: [] }
      let list = group.list
      if (gameFilter) list = list.filter(i => i.game === gameFilter)
      if (q) list = list.filter(i => (i.title + ' ' + i.desc + ' ' + (i.tag || '')).toLowerCase().includes(q))
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
      document.querySelector('.hoyo-help')?.style.setProperty('--hp-icon-url', 'url("' + spriteUrl + '")')
    } catch { /* 图标失败不影响文字 */ }
  }


  function iconPos(icon) {
    const n = Number(icon) || 0
    if (!n) return ''
    const x = (n - 1) % 10
    const y = (n - x - 1) / 10
    return `background-position:-${x * 100}px -${y * 100}px`
  }

  /* 图标选择器：360 个格子直接点，不用记编号 */
  async function openIconPicker(gi, ii) {
    await loadSprite()
    const box = el('hp-icon-picker')
    if (!box) return
    const current = Number(draft?.helpList?.[gi]?.list?.[ii]?.icon) || 0
    const cells = []
    for (let n = 1; n <= iconCount; n++) {
      cells.push('<button type="button" class="hic-cell' + (n === current ? ' on' : '') + '" data-icon="' + n + '">'
        + '<span class="hic-view"><i style="' + iconPos(n) + '"></i></span><b>' + n + '</b></button>')
    }
    box.innerHTML = '<div class="hic-panel">'
      + '<div class="hic-head"><div><div class="hic-title">选择图标</div>'
      + '<div class="hic-sub">共 ' + iconCount + ' 个可用图标，点击即可选中并回填编号</div></div>'
      + '<input class="hic-search" id="hic-search" placeholder="输入编号筛选" />'
      + '<button type="button" class="hic-close" data-close="1">关闭</button></div>'
      + '<div class="hic-grid" id="hic-grid">' + cells.join('') + '</div>'
      + '</div>'
    box.classList.add('on')
    const grid = box.querySelector('.hic-grid')
    const search = box.querySelector('#hic-search')
    const filter = () => {
      const q = String(search.value || '').trim()
      grid.querySelectorAll('.hic-cell').forEach(cell => {
        cell.style.display = !q || cell.dataset.icon.includes(q) ? '' : 'none'
      })
    }
    search?.addEventListener('input', filter)
    grid.querySelectorAll('.hic-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const n = Number(cell.dataset.icon) || 0
        const item = draft.helpList[gi].list[ii]
        item.icon = n
        const row = editorEl.querySelector('.he-group[data-g="' + gi + '"] .he-item[data-i="' + ii + '"]')
        if (row) {
          const input = row.querySelector('.he-icon')
          if (input) input.value = n
          const view = row.querySelector('.he-icon-view i')
          if (view) view.setAttribute('style', iconPos(n))
          const num = row.querySelector('.he-icon-num')
          if (num) num.textContent = n || '—'
        }
        closeIconPicker()
      })
    })
  }

  function closeIconPicker() {
    el('hp-icon-picker')?.classList.remove('on')
  }

  /* ───────── 编辑模式（保存到 config/global_help.yaml） ───────── */
  function clone(obj) { return JSON.parse(JSON.stringify(obj)) }

  function startEdit() {
    if (editing) return
    const cfg = rawHelp?.helpCfg || rawHelp || {}
    const source = rawHelp?.helpList || (rawHelp?.groups || groups.map(g => ({
      group: g.group,
      auth: g.auth,
      list: g.list.map(i => ({ icon: i.icon, title: i.title, desc: i.desc })),
    })))
    draft = {
      helpCfg: {
        ...clone(cfg),
        title: cfg.title || '全局帮助',
        subTitle: cfg.subTitle || '',
        colCount: cfg.colCount || 3,
        theme: Array.isArray(cfg.theme) ? cfg.theme.join(',') : (cfg.theme || 'all'),
        background: cfg.background || 'mix',
        backgroundApi: cfg.backgroundApi || 'https://api.yppp.net/pc.php',
        bgBlur: cfg.bgBlur !== false,
        layout: cfg.layout === 'classic' ? 'classic' : (cfg.layout === 'web' ? 'web' : 'app'),
      },
      helpList: clone(source || []).map(g => ({
        group: g.group || '未分组',
        auth: g.auth === 'master' ? 'master' : '',
        list: (g.list || []).map(i => ({ icon: i.icon || '', title: i.title || '', desc: i.desc || '', tag: i.tag || '' })),
      })),
    }
    editing = true
    groupsEl.style.display = 'none'
    el('hp-games').style.display = 'none'
    editorEl.classList.add('on')
    renderEditor()
  }

  function syncDraft() {
    if (!draft) return
    const val = id => el(id)?.value || ''
    draft.helpCfg.title = val('he-title')
    draft.helpCfg.subTitle = val('he-subtitle')
    draft.helpCfg.colCount = Number(val('he-cols')) || 3
    const themeRaw = val('he-theme') || 'all'
    draft.helpCfg.theme = themeRaw === 'all' ? 'all' : themeRaw.split(',').map(v => v.trim()).filter(Boolean)
    draft.helpCfg.themeExclude = el('he-theme-exclude')?.checked ? ['default'] : []
    draft.helpCfg.background = val('he-bg') || 'mix'
    draft.helpCfg.backgroundApi = val('he-bgapi')
    draft.helpCfg.layout = val('he-layout') === 'classic' ? 'classic' : (val('he-layout') === 'web' ? 'web' : 'app')
    draft.helpCfg.bgBlur = !!el('he-blur')?.checked
    const style = {}
    for (const f of STYLE_FIELDS) {
      const v = String(el('he-st-' + f.key)?.value || '').trim()
      if (!v) continue
      if (f.size) {
        const n = Number(v)
        if (Number.isFinite(n) && n >= 0) style[f.key] = n
      } else {
        style[f.key] = v
      }
    }
    draft.helpCfg.style = style
    editorEl.querySelectorAll('.he-group').forEach(row => {
      const g = draft.helpList[Number(row.dataset.g)]
      if (!g) return
      g.group = row.querySelector('.he-group-name')?.value || '未分组'
      g.auth = row.querySelector('.he-group-master')?.checked ? 'master' : ''
      row.querySelectorAll('.he-item').forEach(itemRow => {
        const item = g.list[Number(itemRow.dataset.i)]
        if (!item) return
        item.icon = Number(itemRow.querySelector('.he-icon')?.value) || 0
        item.title = itemRow.querySelector('.he-title')?.value || ''
        item.desc = itemRow.querySelector('.he-desc')?.value || ''
        item.tag = itemRow.querySelector('.he-tag')?.value || ''
      })
    })
  }

  function hexColor(v) {
    const s = String(v || '').trim()
    let m = s.match(/^#([0-9a-f]{3})$/i)
    if (m) return '#' + m[1].split('').map(c => c + c).join('')
    m = s.match(/^#([0-9a-f]{6})$/i)
    if (m) return s
    m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
    if (m) return '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('')
    return '#ffffff'
  }

  function styleFieldHtml(f, cfg) {
    const value = esc(cfg.style?.[f.key] ?? '')
    if (f.size) {
      return '<label>' + f.label + '<input id="he-st-' + f.key + '" value="' + value + '" placeholder="' + esc(f.ph) + '" /></label>'
    }
    return '<label>' + f.label
      + '<div class="he-color-row">'
      + '<input id="he-st-' + f.key + '" value="' + value + '" placeholder="' + esc(f.ph) + '" />'
      + '<span class="he-swatch" data-swatch="' + f.key + '" style="background:' + (value || 'transparent') + '"></span>'
      + '<input type="color" class="he-color-pick" data-for="he-st-' + f.key + '" value="' + hexColor(cfg.style?.[f.key]) + '" title="点击取色" />'
      + '</div></label>'
  }

  function bindStyleEditor() {
    STYLE_FIELDS.forEach(f => {
      const input = el('he-st-' + f.key)
      if (!input) return
      input.addEventListener('input', () => {
        if (!f.size) {
          const sw = editorEl.querySelector('[data-swatch="' + f.key + '"]')
          if (sw) sw.style.background = input.value || 'transparent'
        }
        updateStylePreview()
      })
      if (!f.size) {
        const pick = editorEl.querySelector('.he-color-pick[data-for="he-st-' + f.key + '"]')
        pick?.addEventListener('input', () => {
          input.value = pick.value
          const sw = editorEl.querySelector('[data-swatch="' + f.key + '"]')
          if (sw) sw.style.background = pick.value
          updateStylePreview()
        })
      }
    })
    el('he-title')?.addEventListener('input', updateStylePreview)
    el('he-subtitle')?.addEventListener('input', updateStylePreview)
    updateStylePreview()
  }

  function updateStylePreview() {
    const get = key => String(el('he-st-' + key)?.value || '').trim()
    const box = el('he-prev-box')
    if (!box) return
    const title = el('he-prev-title')
    const sub = el('he-prev-sub')
    const group = el('he-prev-group')
    const rows = [el('he-prev-row1'), el('he-prev-row2')]
    if (title) title.textContent = el('he-title')?.value || '帮助标题'
    if (sub) sub.textContent = el('he-subtitle')?.value || '副标题示例'
    const shadow = get('fontShadow') || 'none'
    const fontColor = get('fontColor') || '#ceb78b'
    const descColor = get('descColor') || '#eee'
    const titleColor = get('titleColor') || '#fff'
    const subColor = get('subTitleColor') || '#fff'
    box.style.backgroundColor = get('contBgColor') || 'rgba(6,21,31,.5)'
    const blur = Number(get('contBgBlur'))
    box.style.backdropFilter = Number.isFinite(blur) ? 'blur(' + Math.min(20, Math.max(0, blur)) + 'px)' : 'blur(3px)'
    if (title) {
      title.style.color = titleColor
      title.style.textShadow = shadow
      title.style.fontSize = (Number(get('titleSize')) ? Math.min(40, Number(get('titleSize'))) : 24) + 'px'
    }
    if (sub) sub.style.color = subColor
    if (group) {
      group.style.color = fontColor
      group.style.background = get('headerBgColor') || 'rgba(6,21,31,.4)'
      group.style.textShadow = shadow
      group.style.fontSize = (Number(get('groupSize')) || 14) + 'px'
    }
    if (rows[0]) rows[0].style.background = get('rowBgColor1') || 'rgba(6,21,31,.2)'
    const tag = el('he-prev-tag')
    if (tag) {
      const tc = get('tagAmber') || '#b45309'
      tag.style.color = tc
      tag.style.background = 'color-mix(in srgb, ' + tc + ' 12%, transparent)'
      tag.style.borderColor = 'color-mix(in srgb, ' + tc + ' 22%, transparent)'
    }
    if (rows[1]) rows[1].style.background = get('rowBgColor2') || 'rgba(6,21,31,.35)'
    rows.forEach(row => {
      if (!row) return
      const strong = row.querySelector('strong')
      const span = row.querySelector('span')
      if (strong) {
        strong.style.color = fontColor
        strong.style.textShadow = shadow
        strong.style.fontSize = (Number(get('itemSize')) || 14) + 'px'
      }
      if (span) {
        span.style.color = descColor
        span.style.fontSize = (Number(get('descSize')) || 12) + 'px'
      }
    })
  }

  function themeValue(theme) {
    if (Array.isArray(theme)) return theme.join(',') || 'all'
    if (!theme || theme === 'all') return 'all'
    const list = String(theme).split(',').map(v => v.trim()).filter(Boolean)
    return list.length ? list.join(',') : 'all'
  }

  const themeThumbCache = new Map()
  async function loadThemeThumb(name) {
    if (themeThumbCache.has(name)) return themeThumbCache.get(name)
    const p = fetch(g.apiBase + '/help/theme/thumb?name=' + encodeURIComponent(name), {
      headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
    }).then(async res => {
      if (!res.ok) throw new Error('thumb')
      return URL.createObjectURL(await res.blob())
    }).catch(() => '')
    themeThumbCache.set(name, p)
    return p
  }

  function bindThemePicker() {
    const grid = el('he-theme-grid')
    const hidden = el('he-theme')
    if (!grid || !hidden) return
    const list = (themes.length ? themes : ['default']).slice().sort((a, b) => {
      if (a === 'default') return 1
      if (b === 'default') return -1
      return Number(a) - Number(b)
    })
    grid.innerHTML = '<button type="button" class="he-theme-card he-theme-all" data-theme="__all__"><span>全部随机</span></button>'
      + list.map(name => '<button type="button" class="he-theme-card" data-theme="' + esc(name) + '">'
        + '<img data-img="' + esc(name) + '" alt="" />'
        + '<span>' + (name === 'default' ? '默认' : '主题 ' + name) + '</span></button>').join('')
    list.forEach(name => {
      loadThemeThumb(name).then(url => {
        if (!url) return
        const img = grid.querySelector('[data-img="' + name + '"]')
        if (img) img.src = url
      })
    })
    const update = () => {
      const isAll = hidden.value === 'all'
      const selected = isAll ? [] : hidden.value.split(',').filter(Boolean)
      grid.querySelectorAll('[data-theme]').forEach(card => {
        const t = card.dataset.theme
        card.classList.toggle('on', t === '__all__' ? isAll : (!isAll && selected.includes(t)))
      })
      const count = el('he-theme-count')
      if (count) count.textContent = isAll ? '全部随机' : '已选 ' + selected.length + ' 个'
    }
    grid.querySelectorAll('[data-theme]').forEach(card => {
      card.addEventListener('click', () => {
        const name = card.dataset.theme
        if (name === '__all__') hidden.value = 'all'
        else {
          const isAll = hidden.value === 'all'
          let selected = isAll ? [] : hidden.value.split(',').filter(Boolean)
          if (selected.includes(name)) selected = selected.filter(v => v !== name)
          else selected.push(name)
          hidden.value = selected.length ? selected.join(',') : 'all'
        }
        update()
      })
    })
    el('he-theme-exclude')?.addEventListener('change', update)
    update()
  }

  function renderEditor() {
    const cfg = draft.helpCfg
    const groupsHtml = draft.helpList.map((g, gi) => {
      const items = g.list.map((item, ii) => '<div class="he-item" data-i="' + ii + '">'
        + '<button type="button" class="he-icon-pick" data-act="icon-pick" title="点击选择图标">'
        + '<span class="he-icon-view"><i style="' + iconPos(item.icon) + '"></i></span>'
        + '<b class="he-icon-num">' + (Number(item.icon) || '—') + '</b>'
        + '</button>'
        + '<input class="he-icon" type="hidden" value="' + esc(item.icon) + '" />'
        + '<input class="he-title" value="' + esc(item.title) + '" placeholder="指令标题" />'
        + '<input class="he-desc" value="' + esc(item.desc) + '" placeholder="说明" />'
        + '<input class="he-tag" value="' + esc(item.tag) + '" placeholder="状态标签（可空）" />'
        + '<div class="he-item-ops">'
        + '<button type="button" data-act="item-up" title="上移">↑</button>'
        + '<button type="button" data-act="item-down" title="下移">↓</button>'
        + '<button type="button" class="danger" data-act="item-del" title="删除">×</button>'
        + '</div>'
        + '</div>').join('')
      return '<section class="he-group" data-g="' + gi + '">'
        + '<div class="he-group-head">'
        + '<input class="he-group-name" value="' + esc(g.group) + '" placeholder="板块名称" />'
        + '<label class="he-check"><input type="checkbox" class="he-group-master"' + (g.auth === 'master' ? ' checked' : '') + ' /> 主人专用</label>'
        + '<div class="he-group-ops">'
        + '<button type="button" data-act="group-up" title="上移">↑</button>'
        + '<button type="button" data-act="group-down" title="下移">↓</button>'
        + '<button type="button" class="danger" data-act="group-del">删除板块</button>'
        + '</div></div>'
        + '<div class="he-items">' + items + '</div>'
        + '<button type="button" class="he-add-item" data-act="item-add">+ 添加指令</button>'
        + '</section>'
    }).join('')
    editorEl.innerHTML = '<div class="he-panel">'
      + '<div class="he-head"><div><div class="he-title">编辑全局帮助</div>'
      + '<div class="he-sub">保存后写入 config/global_help.yaml，优先于内置默认；图标编号对应 help 图标表，0 表示不显示</div></div>'
      + '<div class="he-actions">'
      + '<button type="button" class="hp-primary" data-act="save">保存</button>'
      + '<button type="button" data-act="cancel">取消</button>'
      + '<button type="button" class="danger" data-act="reset">恢复默认</button>'
      + '</div></div>'
      + '<div class="he-cfg">'
      + '<label>标题<input id="he-title" value="' + esc(cfg.title) + '" /></label>'
      + '<label>副标题<input id="he-subtitle" value="' + esc(cfg.subTitle) + '" /></label>'
      + '<label>列数<input id="he-cols" type="number" min="2" max="5" value="' + esc(cfg.colCount) + '" /></label>'
      + '<input id="he-theme" type="hidden" value="' + esc(themeValue(cfg.theme)) + '" />'
      + '<label>页面风格<select id="he-layout"><option value="app"' + ((!cfg.layout || cfg.layout === 'app') ? ' selected' : '') + '>iOS 浅色</option><option value="web"' + (cfg.layout === 'web' ? ' selected' : '') + '>网页（深色）</option><option value="classic"' + (cfg.layout === 'classic' ? ' selected' : '') + '>经典（喵喵）</option></select></label>'
      + '<label>背景<select id="he-bg"><option value="theme"' + (cfg.background === 'theme' ? ' selected' : '') + '>本地主题</option><option value="api"' + (cfg.background === 'api' ? ' selected' : '') + '>随机 API</option><option value="mix"' + (cfg.background === 'mix' ? ' selected' : '') + '>混合</option></select></label>'
      + '<label>随机 API<input id="he-bgapi" value="' + esc(cfg.backgroundApi) + '" /></label>'
      + '<label class="he-check"><input id="he-blur" type="checkbox"' + (cfg.bgBlur ? ' checked' : '') + ' /> 背景毛玻璃</label>'
      + '</div>'
      + '<div class="he-themes">'
      + '<div class="he-themes-head"><span>帮助主题</span><span class="he-theme-count" id="he-theme-count"></span>'
      + '<label class="he-check"><input type="checkbox" id="he-theme-exclude"' + ((Array.isArray(cfg.themeExclude) && cfg.themeExclude.includes('default')) ? ' checked' : '') + ' /> 全部随机时排除 default</label>'
      + '<button type="button" data-act="theme-all">全部随机</button></div>'
      + '<div class="he-theme-grid" id="he-theme-grid"></div>'
      + '</div>'
      + '<div class="he-style">'
      + '<div class="he-style-head"><span>外观样式</span><button type="button" data-act="style-reset">恢复主题默认</button></div>'
      + '<div class="he-style-grid">'
      + STYLE_FIELDS.map(f => styleFieldHtml(f, cfg)).join('')
      + '</div>'
      + '<div class="he-preview"><div class="he-preview-label">效果预览</div>'
      + '<div class="he-prev-box" id="he-prev-box">'
      + '<div class="he-prev-title" id="he-prev-title">帮助标题</div>'
      + '<div class="he-prev-sub" id="he-prev-sub">副标题示例</div>'
      + '<div class="he-prev-group" id="he-prev-group">板块标题</div>'
      + '<div class="he-prev-row he-prev-odd" id="he-prev-row1"><strong>#示例指令</strong><span>说明文字效果</span><i class="he-prev-tag" id="he-prev-tag">需CK</i></div>'
      + '<div class="he-prev-row he-prev-even" id="he-prev-row2"><strong>%示例指令</strong><span>第二行效果</span></div>'
      + '</div></div>'
      + '</div>'
      + '<div class="he-groups">' + (groupsHtml || '<div class="hp-empty">还没有板块，点下面新增</div>') + '</div>'
      + '<button type="button" class="he-add-group" data-act="group-add">+ 新增板块</button>'
      + '<div class="he-msg" id="he-msg"></div>'
      + '</div>'
    bindStyleEditor()
    bindThemePicker()
    editorEl.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', onEditorAction)
    })
  }

  function onEditorAction(e) {
    const act = e.currentTarget.dataset.act
    if (!act) return
    if (act === 'save') return saveEdit()
    if (act === 'cancel') return cancelEdit()
    if (act === 'reset') return resetEdit()
    syncDraft()
    if (act === 'theme-all') {
      const hidden = el('he-theme')
      if (hidden) hidden.value = 'all'
      editorEl.querySelectorAll('#he-theme-grid [data-theme]').forEach(card => card.classList.toggle('on', card.dataset.theme === '__all__'))
      const count = el('he-theme-count')
      if (count) count.textContent = '全部随机'
      return
    }
    if (act === 'style-reset') {
      draft.helpCfg.style = {}
      renderEditor()
      return
    }
    if (act === 'icon-pick') {
      const gr = e.currentTarget.closest('.he-group')
      const ir = e.currentTarget.closest('.he-item')
      return openIconPicker(Number(gr?.dataset.g), Number(ir?.dataset.i))
    }
    const scroller = editorEl.closest('.g-content') || document.scrollingElement
    const scrollTop = scroller ? scroller.scrollTop : 0
    const groupRow = e.currentTarget.closest('.he-group')
    const gi = groupRow ? Number(groupRow.dataset.g) : -1
    const itemRow = e.currentTarget.closest('.he-item')
    const ii = itemRow ? Number(itemRow.dataset.i) : -1
    if (act === 'group-add') draft.helpList.push({ group: '新板块', auth: '', list: [{ icon: 0, title: '', desc: '', tag: '' }] })
    else if (act === 'group-del') draft.helpList.splice(gi, 1)
    else if (act === 'group-up' && gi > 0) [draft.helpList[gi - 1], draft.helpList[gi]] = [draft.helpList[gi], draft.helpList[gi - 1]]
    else if (act === 'group-down' && gi >= 0 && gi < draft.helpList.length - 1) [draft.helpList[gi + 1], draft.helpList[gi]] = [draft.helpList[gi], draft.helpList[gi + 1]]
    else if (act === 'item-add' && gi >= 0) draft.helpList[gi].list.push({ icon: 0, title: '', desc: '', tag: '' })
    else if (act === 'item-del' && gi >= 0) draft.helpList[gi].list.splice(ii, 1)
    else if (act === 'item-up' && gi >= 0 && ii > 0) { const l = draft.helpList[gi].list; [l[ii - 1], l[ii]] = [l[ii], l[ii - 1]] }
    else if (act === 'item-down' && gi >= 0) { const l = draft.helpList[gi].list; if (ii < l.length - 1) [l[ii + 1], l[ii]] = [l[ii], l[ii + 1]] }
    renderEditor()
    if (scroller) scroller.scrollTop = scrollTop
  }

  function cancelEdit() {
    editing = false
    editorEl.classList.remove('on')
    editorEl.innerHTML = ''
    groupsEl.style.display = ''
    el('hp-games').style.display = ''
    render()
  }

  async function saveEdit() {
    syncDraft()
    draft.helpList = draft.helpList.filter(g => g.list.length || g.group)
    const msg = el('he-msg')
    if (!draft.helpList.length) { if (msg) msg.textContent = '至少保留一个板块'; return }
    if (msg) msg.textContent = '保存中…'
    try {
      const res = await fetch(g.apiBase + '/help/save', {
        method: 'POST',
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '', 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const json = await res.json()
      if (!json?.ok) throw new Error(json?.message || '保存失败')
      editing = false
      editorEl.classList.remove('on')
      editorEl.innerHTML = ''
      groupsEl.style.display = ''
      el('hp-games').style.display = ''
      showToast(json.message || '已保存')
      await load()
    } catch (err) {
      if (msg) msg.textContent = '保存失败：' + (err && err.message || err)
    }
  }

  async function resetEdit() {
    if (!confirm('恢复默认会删除 config/global_help.yaml 的自定义内容，确定？')) return
    try {
      const res = await fetch(g.apiBase + '/help/reset', {
        method: 'POST',
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      const json = await res.json()
      if (!json?.ok) throw new Error(json?.message || '恢复失败')
      showToast('已恢复默认')
      editing = false
      editorEl.classList.remove('on')
      editorEl.innerHTML = ''
      groupsEl.style.display = ''
      el('hp-games').style.display = ''
      await load()
    } catch (err) {
      showToast('恢复失败：' + (err && err.message || err))
    }
  }

  /** 把外观样式里的标签颜色映射成 CSS 变量（只影响锅巴页标签） */
  function applyTagColors(style = {}) {
    const root = document.querySelector('.hoyo-help')
    if (!root) return
    const map = { tagRed: '--hp-tag-red', tagAmber: '--hp-tag-amber', tagGreen: '--hp-tag-green', tagGray: '--hp-tag-gray' }
    for (const [key, cssVar] of Object.entries(map)) {
      if (style[key]) root.style.setProperty(cssVar, style[key])
      else root.style.removeProperty(cssVar)
    }
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
      rawHelp = payload
      groups = normalize(payload)
      themes = Array.isArray(payload.themes) ? payload.themes : []
      iconCount = Number(payload.iconCount) || 360
      version = String(payload.version || '')
      applyTagColors(payload.helpCfg?.style || {})
      const cfg = payload.helpCfg || payload
      const titleEl = el('hp-title')
      const subEl = el('hp-sub')
      if (titleEl && cfg.title) titleEl.textContent = cfg.title
      if (subEl && (cfg.subTitle || cfg.subtitle)) subEl.textContent = cfg.subTitle || cfg.subtitle
      const kicker = document.querySelector('.hp-kicker')
      if (kicker && version) kicker.textContent = 'HoYoGet v' + version + ' · Global Help'
      await loadSprite()
      await loadBackground(payload, payload.theme || 'default')
      renderHeroTags()
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
  el('hp-edit')?.addEventListener('click', startEdit)
  el('hp-icon-picker')?.addEventListener('click', e => {
    if (e.target.id === 'hp-icon-picker' || e.target.dataset.close) closeIconPicker()
  })
  loadLogo()
  load()
})();
