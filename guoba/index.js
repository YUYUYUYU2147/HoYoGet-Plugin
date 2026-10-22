/**
 * 锅巴自定义页面：米哈游签到记录。
 *
 * 锅巴启动时扫描各插件目录下的 guoba/index.js，调用 init(ctx)。
 * 页面挂到侧边栏「扩展页面」下，接口挂在 /api/custom/<插件>/…（自带登录鉴权）。
 * 数据来自 system/sign_history.js 落盘的 data/sign_history.json。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadHistory() {
  const { readSignRecords } = await import('../system/sign_history.js')
  return readSignRecords
}

const PAGE_HTML = `
<div class="hoyo-sign-hist">
  <div class="hsh-bar">
    <input class="hsh-input" id="hsh-qq" placeholder="按 QQ 过滤（可空）" />
    <select class="hsh-input" id="hsh-game">
      <option value="">全部游戏</option>
      <option value="原神">原神</option>
      <option value="崩坏：星穹铁道">崩坏：星穹铁道</option>
      <option value="绝区零">绝区零</option>
      <option value="崩坏3">崩坏3</option>
      <option value="米游社">米游社（社区）</option>
    </select>
    <select class="hsh-input" id="hsh-limit">
      <option value="100">最近 100 条</option>
      <option value="200" selected>最近 200 条</option>
      <option value="500">最近 500 条</option>
    </select>
    <button class="hsh-btn" id="hsh-refresh">刷新</button>
    <span class="hsh-meta" id="hsh-meta"></span>
  </div>
  <div class="hsh-table-wrap">
    <table class="hsh-table">
      <thead>
        <tr><th>时间</th><th>QQ</th><th>昵称</th><th>游戏</th><th>UID</th><th>结果</th></tr>
      </thead>
      <tbody id="hsh-body"><tr><td colspan="6" class="hsh-empty">加载中…</td></tr></tbody>
    </table>
  </div>
</div>
`

const PAGE_STYLE = `
.hoyo-sign-hist { padding: 4px 2px 10px; }
.hsh-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.hsh-input { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 13px; outline: none; }
.hsh-input:focus { border-color: #4c8bf5; }
.hsh-btn { height: 32px; padding: 0 16px; border-radius: 8px; border: none; background: #4c8bf5; color: #fff; font-size: 13px; cursor: pointer; }
.hsh-btn:hover { background: #3b78e0; }
.hsh-meta { font-size: 12px; color: var(--g-muted, #8a93a3); }
.hsh-table-wrap { border-radius: 10px; overflow: auto; border: 1px solid var(--g-border, #e3e8ef); }
.hsh-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.hsh-table th, .hsh-table td { padding: 8px 12px; text-align: left; white-space: nowrap; }
.hsh-table thead th { position: sticky; top: 0; background: var(--g-card, #f7f9fc); color: var(--g-muted, #6b7280); font-weight: 600; border-bottom: 1px solid var(--g-border, #e3e8ef); }
.hsh-table tbody tr:nth-child(even) { background: rgba(120, 150, 200, 0.05); }
.hsh-table tbody tr:hover { background: rgba(76, 139, 245, 0.08); }
.hsh-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; line-height: 18px; }
.hsh-ok { color: #1a7f37; background: rgba(35, 178, 90, 0.14); }
.hsh-signed { color: #4c6ef5; background: rgba(76, 110, 245, 0.14); }
.hsh-fail { color: #d43f3f; background: rgba(212, 63, 63, 0.14); }
.hsh-empty { text-align: center; color: var(--g-muted, #8a93a3); padding: 24px 0; }
`

const PAGE_SCRIPT = `
(function () {
  const g = window.__GUOBA__ || {}
  const body = document.getElementById('hsh-body')
  const meta = document.getElementById('hsh-meta')
  const qqEl = document.getElementById('hsh-qq')
  const gameEl = document.getElementById('hsh-game')
  const limitEl = document.getElementById('hsh-limit')

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  function fmt(at) {
    const d = new Date(Number(at) || 0)
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function badge(status) {
    if (status === 'ok') return '<span class="hsh-badge hsh-ok">成功</span>'
    if (status === 'signed') return '<span class="hsh-badge hsh-signed">已签</span>'
    return '<span class="hsh-badge hsh-fail">失败</span>'
  }

  async function load() {
    body.innerHTML = '<tr><td colspan="6" class="hsh-empty">加载中…</td></tr>'
    try {
      const params = new URLSearchParams()
      if (qqEl.value.trim()) params.set('qq', qqEl.value.trim())
      const game = gameEl.value
      if (game === '米游社') params.set('gamePrefix', '米游社')
      else if (game) params.set('game', game)
      params.set('limit', limitEl.value)
      const res = await fetch(g.apiBase + '/history?' + params.toString(), {
        headers: { [g.tokenKey || 'guoba-access-token']: g.token || '' },
      })
      const json = await res.json()
      const list = json?.result?.records || []
      const total = json?.result?.total || 0
      meta.textContent = '共 ' + total + ' 条' + (json?.result?.updatedAt ? ' · 更新于 ' + fmt(json.result.updatedAt) : '')
      if (!list.length) {
        body.innerHTML = '<tr><td colspan="6" class="hsh-empty">暂无记录（签到一次后就会出现）</td></tr>'
        return
      }
      body.innerHTML = list.map(r => '<tr>'
        + '<td>' + fmt(r.at) + '</td>'
        + '<td>' + esc(r.qq) + '</td>'
        + '<td>' + esc(r.name) + '</td>'
        + '<td>' + esc(r.game) + '</td>'
        + '<td>' + esc(r.uid) + '</td>'
        + '<td>' + badge(r.status) + ' <span style="color:var(--g-muted,#8a93a3)">' + esc(r.tip) + '</span></td>'
        + '</tr>').join('')
    } catch (err) {
      body.innerHTML = '<tr><td colspan="6" class="hsh-empty">加载失败：' + esc(err && err.message || err) + '</td></tr>'
    }
  }

  document.getElementById('hsh-refresh').addEventListener('click', load)
  qqEl.addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  gameEl.addEventListener('change', load)
  limitEl.addEventListener('change', load)
  load()
})();
`

export function init(ctx) {
  ctx.registerApi('get', '/history', async (req, res) => {
    try {
      const readSignRecords = await loadHistory()
      const q = req.query || {}
      const opts = {
        limit: q.limit,
        qq: q.qq,
        game: q.game,
        days: q.days,
      }
      let data = readSignRecords(opts)
      // 社区签到的 game 形如「米游社·原神」，用前缀过滤
      if (q.gamePrefix) {
        const prefix = String(q.gamePrefix)
        const all = readSignRecords({ ...opts, game: '' })
        const filtered = all.records.filter(r => String(r.game || '').startsWith(prefix))
        data = { updatedAt: all.updatedAt, total: filtered.length, records: filtered.slice(0, Number(opts.limit) || 200) }
      }
      res.json({ ok: true, code: 0, message: 'ok', result: data })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取签到记录失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: { total: 0, records: [] } })
    }
  })

  ctx.registerPage({
    id: 'hoyo-sign-history',
    title: '米哈游签到记录',
    icon: '📅',
    priority: 60,
    html: PAGE_HTML,
    style: PAGE_STYLE,
    script: PAGE_SCRIPT,
  })
}

export default { init }
