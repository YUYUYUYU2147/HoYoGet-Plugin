const $ = id => document.getElementById(id)
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

async function request(endpoint, query = {}, raw = false) {
  if (!token) throw new Error('请从锅巴侧栏重新打开「HoYoGet 数据」以获取登录信息')
  const response = await fetch(`${api}/${endpoint}?${new URLSearchParams(query)}`, {
    cache: 'no-store',
    headers: { 'guoba-access-token': token },
  })
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

function renderCategories() {
  const nav = $('categories')
  nav.replaceChildren()
  const total = result.categories.reduce((sum, item) => sum + item.count, 0)
  const options = [{ id: 'all', title: '全部数据', count: total }, ...result.categories]
  for (const category of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.role = 'tab'
    button.setAttribute('aria-selected', String(filters.category === category.id))
    const title = document.createElement('span')
    title.textContent = category.title
    const count = document.createElement('span')
    count.className = 'tab-count'
    count.textContent = String(category.count ?? 0)
    button.append(title, count)
    button.addEventListener('click', () => run(() => loadFiles({ ...filters, category: category.id, page: 1 })))
    nav.append(button)
  }
}

function renderFiles() {
  const list = $('files')
  list.replaceChildren()
  for (const item of result.items) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'file-entry'
    button.setAttribute('aria-pressed', String(selected?.path === item.path))
    button.addEventListener('click', () => run(() => loadPreview(item)))

    const label = document.createElement('span')
    label.className = 'file-name'
    const title = document.createElement('span')
    title.className = 'file-labels'
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
      sensitive.textContent = '敏感数据'
      title.append(sensitive)
    }
    const pathText = document.createElement('code')
    pathText.textContent = `data/HoYoGet-Plugin/${item.path}`
    label.append(title, pathText)

    const fileSize = document.createElement('span')
    fileSize.className = 'size'
    fileSize.textContent = size(item.size)
    button.append(label, fileSize)
    list.append(button)
  }
  if (!result.items.length) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = filters.search ? '没有匹配的数据' : '该筛选下暂无数据'
    list.append(empty)
  }
  $('count').textContent = `${result.total} 项`
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
  if (result.items.length) await loadPreview(result.items[0])
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
  $('content-type').textContent = data.kind === 'sqlite' ? 'SQLite 数据库 · 下载原文件后使用本地工具查看' : data.kind === 'binary' ? '二进制数据 · 十六进制摘要' : data.kind === 'image' ? '图片文件' : '文本文件'
  if (data.kind === 'image') {
    const blob = await request('download', { path: item.path }, true)
    imageUrl = URL.createObjectURL(blob)
    $('image').src = imageUrl
  } else {
    $('content').textContent = data.content || (data.kind === 'sqlite' ? '此数据库以只读方式提供下载。' : '')
    if (data.truncated) $('content-type').textContent += ` · 仅预览前 ${size(256 * 1024)}`
  }
  for (const entry of document.querySelectorAll('.file-entry')) entry.setAttribute('aria-pressed', String(entry === document.activeElement || entry.querySelector('code')?.textContent.endsWith(item.path)))
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
  const games = fileResult.games || []
  $('game').replaceChildren(...games.map(game => {
    const option = document.createElement('option')
    option.value = game.id
    option.textContent = game.title
    return option
  }))
  renderCategories()
  renderFiles()
  status(`已加载 ${result.total} 项数据`)
  if (result.items.length) await loadPreview(result.items[0])
}

$('refresh').addEventListener('click', () => run(() => loadFiles({ ...filters })))
$('game').addEventListener('change', () => run(() => loadFiles({ ...filters, game: $('game').value, page: 1 })))
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => run(() => loadFiles({ ...filters, search: $('search').value.trim(), page: 1 })), 250)
})
$('previous').addEventListener('click', () => run(() => loadFiles({ ...filters, page: filters.page - 1 })))
$('next').addEventListener('click', () => run(() => loadFiles({ ...filters, page: filters.page + 1 })))
$('download').addEventListener('click', () => run(downloadSelected))

run(initialize)
