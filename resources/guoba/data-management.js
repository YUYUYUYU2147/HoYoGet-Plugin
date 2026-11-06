const $ = id => document.getElementById(id)

const ICONS = {
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/></svg>',
  'chevron-left': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 6-6 6 6 6"/></svg>',
  'chevron-right': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
}
for (const node of document.querySelectorAll('i[data-icon]')) {
  node.innerHTML = ICONS[node.dataset.icon] || ''
}

// 游戏短标识（无图标时兜底）
const GAME_ABBR = { gs: '原', sr: '穹', zzz: '绝', bh3: '崩', common: '常', all: '全' }
const gameAbbr = game => GAME_ABBR[game] || (String(game || '?')[0] || '?')
// 复用插件自带的游戏图标（由服务端 /hoyoget-data/icons/<game>.webp 提供）
const GAME_ICONS = new Set(['gs', 'sr', 'zzz', 'bh3'])
const gameIconUrl = game => (GAME_ICONS.has(game) ? `icons/${game}.webp` : '')

// 没有图片资源的分类用内联矢量图标，避免文字占位
const INLINE_GAME_ICON = {
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  common: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/></svg>',
}
const inlineGameIcon = game => INLINE_GAME_ICON[game] || INLINE_GAME_ICON.common
const api = location.pathname.replace(/hoyoget-data\/$/, 'api/hoyoget-data')
const tokenKey = `hoyoget-data-token:${location.pathname}`
let token = ''
try {
  token = decodeURIComponent(location.hash.slice(1)) || sessionStorage.getItem(tokenKey) || ''
  if (token) sessionStorage.setItem(tokenKey, token)
} catch {}
history.replaceState(null, '', location.pathname)

let filters = { category: 'all', game: 'all', search: '', page: 1 }
let result = { items: [], total: 0, page: 1, pageSize: 100, categories: [] }
let selected = null
let busy = false
let imageUrl = ''
let searchTimer

const size = value => {
  if (value == null) return '—'
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}
const date = value => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString()
}

async function request(endpoint, query = {}, raw = false, options = {}) {
  if (!token) throw new Error('请从锅巴侧栏重新打开「HoYoGet 数据」以获取登录信息')
  const init = {
    cache: 'no-store',
    headers: { 'guoba-access-token': token },
    method: options.method || 'GET',
  }
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${api}/${endpoint}?${new URLSearchParams(query)}`, init)
  if ([401, 403].includes(response.status)) throw new Error('锅巴登录已过期，请重新登录后打开数据管理页')
  if (raw && response.ok) return response.blob()
  const body = await response.json()
  if (!response.ok || body.code !== 0) throw new Error(body.message || '数据读取失败，请稍后重试')
  return body.result
}

function status(message, error = false) {
  $('status').textContent = message
  $('status').classList.toggle('error', error)
}

function setBusy(value) {
  busy = value
  document.querySelector('main').setAttribute('aria-busy', String(value))
  for (const control of document.querySelectorAll('button,input,select')) control.disabled = value
  updatePager()
}

function updatePager() {
  $('previous').disabled = busy || result.page <= 1
  $('next').disabled = busy || result.page * result.pageSize >= result.total
}

async function run(operation) {
  if (busy) return
  setBusy(true)
  status('正在读取本地数据…')
  try { await operation() }
  catch (error) { status(error.message || '数据读取失败', true) }
  finally { setBusy(false) }
}

function renderGamePills() {
  const box = $('game-pills')
  if (!box) return
  box.replaceChildren(...(result.games || []).map(game => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'game-pill'
    button.dataset.game = game.id
    button.setAttribute('aria-pressed', String(filters.game === game.id))
    const icon = document.createElement('span')
    icon.className = 'gicon'
    const iconUrl = gameIconUrl(game.id)
    if (iconUrl) {
      const img = document.createElement('img')
      img.src = iconUrl
      img.alt = ''
      img.loading = 'lazy'
      icon.append(img)
    } else {
      icon.classList.add('vector')
      icon.innerHTML = inlineGameIcon(game.id)
    }
    const label = document.createElement('span')
    label.textContent = game.title
    button.append(icon, label)
    button.addEventListener('click', () => run(() => loadFiles({ ...filters, game: game.id, page: 1 })))
    return button
  }))
}

function renderCategories() {
  const nav = $('categories')
  nav.replaceChildren()
  const total = result.categories.reduce((sum, item) => sum + item.count, 0)
  const options = [{ id: 'all', title: '全部数据', count: total }, ...result.categories]
  for (const category of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chip'
    button.role = 'tab'
    button.setAttribute('aria-selected', String(filters.category === category.id))
    const title = document.createElement('span')
    title.textContent = category.title
    const count = document.createElement('span')
    count.className = 'chip-count'
    count.textContent = String(category.count ?? 0)
    button.append(title, count)
    button.addEventListener('click', () => run(() => loadFiles({ ...filters, category: category.id, page: 1 })))
    nav.append(button)
  }
}

// 折叠状态：默认展开全部分组，用户收起后记住
const collapsedGroups = new Set()

function fileEntryNode(item) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'file-entry'
  button.dataset.path = item.path
  button.setAttribute('aria-pressed', String(selected?.path === item.path))
  button.addEventListener('click', () => run(() => loadPreview(item)))

  const icon = document.createElement('span')
  icon.className = `file-badge ${item.game || 'common'}`
  const badgeUrl = gameIconUrl(item.game)
  if (badgeUrl) {
    const img = document.createElement('img')
    img.src = badgeUrl
    img.alt = item.gameTitle || ''
    img.loading = 'lazy'
    icon.append(img)
  } else {
    icon.textContent = gameAbbr(item.game)
  }

  const body = document.createElement('span')
  body.className = 'file-body'
  const title = document.createElement('span')
  title.className = 'file-title'
  const strong = document.createElement('strong')
  strong.textContent = item.title
  title.append(strong)
  const badge = document.createElement('span')
  badge.className = `badge game-${item.game}`
  badge.textContent = item.gameTitle
  title.append(badge)
  if (item.sensitive) {
    const sensitive = document.createElement('span')
    sensitive.className = 'badge sensitive'
    sensitive.textContent = '敏感'
    title.append(sensitive)
  }
  const pathText = document.createElement('span')
  pathText.className = 'file-path'
  pathText.textContent = `data/HoYoGet-Plugin/${item.path}`
  body.append(title, pathText)

  const fileSize = document.createElement('span')
  fileSize.className = 'file-size'
  fileSize.textContent = size(item.size)
  button.append(icon, body, fileSize)
  return button
}

function renderFiles() {
  const list = $('files')
  list.replaceChildren()

  // 单分类视图直接平铺；全部分类时按分类分组折叠
  const grouped = filters.category === 'all'
  const meta = new Map((result.categories || []).map(item => [item.id, item]))

  if (!grouped) {
    for (const item of result.items) list.append(fileEntryNode(item))
  } else {
    const groups = new Map()
    for (const item of result.items) {
      if (!groups.has(item.category)) groups.set(item.category, [])
      groups.get(item.category).push(item)
    }
    const order = [...(result.categories || []).map(c => c.id)]
    const keys = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))
    for (const key of keys) {
      const info = meta.get(key) || { id: key, title: key, description: '', icon: '' }
      const items = groups.get(key)
      const collapsed = collapsedGroups.has(key)

      const group = document.createElement('section')
      group.className = `file-group${collapsed ? ' collapsed' : ''}`

      const head = document.createElement('button')
      head.type = 'button'
      head.className = 'group-head'
      head.setAttribute('aria-expanded', String(!collapsed))
      const caret = document.createElement('span')
      caret.className = 'group-caret'
      caret.textContent = '▾'
      const gIcon = document.createElement('span')
      gIcon.className = 'group-icon'
      gIcon.textContent = info.icon || '•'
      const gTitle = document.createElement('span')
      gTitle.className = 'group-title'
      gTitle.textContent = info.title
      const gCount = document.createElement('span')
      gCount.className = 'group-count'
      gCount.textContent = `${items.length} 项`
      head.append(caret, gIcon, gTitle, gCount)
      head.addEventListener('click', () => {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key)
        else collapsedGroups.add(key)
        renderFiles()
      })

      const desc = document.createElement('p')
      desc.className = 'group-desc'
      desc.textContent = info.description || ''

      const bodyEl = document.createElement('div')
      bodyEl.className = 'group-body'
      for (const item of items) bodyEl.append(fileEntryNode(item))

      group.append(head, desc, bodyEl)
      list.append(group)
    }
  }

  if (!result.items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = filters.search ? '没有匹配的数据' : '该筛选下暂无数据'
    list.append(empty)
  }
  $('count').textContent = `${result.total} 项`
  const statCount = $('stat-count')
  if (statCount) statCount.textContent = String(result.total)
  const statCategory = $('stat-category')
  if (statCategory) {
    const current = (result.categories || []).find(item => item.id === filters.category)
    statCategory.textContent = filters.category === 'all' ? '全部' : (current?.title || '—')
  }
  const statGame = $('stat-game')
  if (statGame) {
    const games = result.games || []
    const currentGame = games.find(item => item.id === filters.game)
    statGame.textContent = filters.game === 'all' ? '全部' : (currentGame?.title || '—')
  }
  $('page').textContent = `${result.page} / ${Math.max(1, Math.ceil(result.total / result.pageSize))}`
  updatePager()
}

async function loadFiles(nextFilters = filters) {
  filters = nextFilters
  selected = null
  clearPreview()
  result = await request('files', filters)
  renderCategories()
  renderFiles()
  const extra = result.truncated ? ' · 文件较多，仅扫描前 50000 项' : ''
  status(`已加载 ${result.total} 项数据${extra}`)
  if (result.items.length) {
    await loadPreview(result.items[0])
    for (const entry of document.querySelectorAll('.file-entry')) {
      entry.setAttribute('aria-pressed', String(entry.dataset.path === result.items[0].path))
    }
  }
}

function clearPreview() {
  if (imageUrl) URL.revokeObjectURL(imageUrl)
  imageUrl = ''
  $('preview').hidden = true
  $('empty').hidden = false
  $('download').hidden = true
  $('notice').hidden = true
  $('content').textContent = ''
  $('content').hidden = false
  $('image').hidden = true
  $('image').removeAttribute('src')
  $('preview-title').textContent = '数据内容'
  $('file-meta').textContent = ''
}

async function loadPreview(item) {
  selected = item
  if (imageUrl) URL.revokeObjectURL(imageUrl)
  imageUrl = ''
  $('image').removeAttribute('src')
  const data = await request('preview', { path: item.path })
  $('empty').hidden = true
  $('preview').hidden = false
  $('download').hidden = false
  $('preview-title').textContent = item.title
  $('file-meta').textContent = `data/HoYoGet-Plugin/${data.path} · ${size(data.size)} · ${date(data.modified)}`
  $('notice').hidden = !data.redacted
  $('notice').textContent = data.redacted ? '该文件包含账号凭据，预览已脱敏。下载原文件会包含完整敏感数据。' : ''
  $('content').hidden = data.kind === 'image' || data.kind === 'sqlite'
  $('image').hidden = data.kind !== 'image'
  const editBtn = $('edit')
  if (editBtn) editBtn.hidden = !(data.editable && data.kind === 'text')
  $('content-type').textContent = data.kind === 'sqlite' ? 'SQLite 数据库 · 下载原文件后使用本地工具查看' : data.kind === 'binary' ? '二进制数据 · 十六进制摘要' : data.kind === 'image' ? '图片文件' : '文本文件'
  if (data.kind === 'image') {
    const blob = await request('download', { path: item.path }, true)
    imageUrl = URL.createObjectURL(blob)
    $('image').src = imageUrl
  } else {
    $('content').textContent = data.content || (data.kind === 'sqlite' ? '此数据库以只读方式提供下载。' : '')
    if (data.truncated) $('content-type').textContent += ` · 仅预览前 ${size(256 * 1024)}`
  }
  for (const entry of document.querySelectorAll('.file-entry')) {
    entry.setAttribute('aria-pressed', String(entry.dataset.path === item.path))
  }
}

async function downloadSelected() {
  if (!selected) return
  const blob = await request('download', { path: selected.path }, true)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = selected.name
  link.click()
  URL.revokeObjectURL(url)
}

async function initialize() {
  if (!token) { status('请从锅巴侧栏重新打开本页面以获取登录信息', true); return }
  const [categoryResult, fileResult] = await Promise.all([
    request('categories'),
    request('files', filters),
  ])
  result = { ...fileResult, categories: categoryResult }
  result.games = fileResult.games || []
  renderGamePills()
  renderCategories()
  renderFiles()
  status(`已加载 ${result.total} 项数据`)
  if (result.items.length) await loadPreview(result.items[0])
}

// ---------- 在线编辑 ----------
let editing = null

function openEditor() {
  if (!selected || !$('preview')) return
  editing = selected
  $('editor-area').value = $('content').textContent || ''
  $('editor').hidden = false
  $('content').hidden = true
  $('editor-area').focus()
}

function closeEditor() {
  editing = null
  $('editor').hidden = true
  $('content').hidden = false
}

async function saveEditor() {
  if (!editing) return
  const content = $('editor-area').value
  $('editor-save').disabled = true
  try {
    await request('save', {}, false, { method: 'POST', body: { path: editing.path, content } })
    closeEditor()
    await loadPreview(editing)
    status('已保存')
  } catch (error) {
    status(error.message || '保存失败', true)
  } finally {
    $('editor-save').disabled = false
  }
}

$('edit')?.addEventListener('click', openEditor)
$('editor-cancel')?.addEventListener('click', closeEditor)
$('editor-save')?.addEventListener('click', saveEditor)

$('refresh').addEventListener('click', () => run(() => loadFiles({ ...filters })))

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => run(() => loadFiles({ ...filters, search: $('search').value.trim(), page: 1 })), 250)
})
$('previous').addEventListener('click', () => run(() => loadFiles({ ...filters, page: filters.page - 1 })))
$('next').addEventListener('click', () => run(() => loadFiles({ ...filters, page: filters.page + 1 })))
$('download').addEventListener('click', () => run(downloadSelected))

run(initialize)
