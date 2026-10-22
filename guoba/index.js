/**
 * 锅巴自定义页面：米哈游任务记录。
 *
 * 锅巴启动时扫描各插件目录下的 guoba/index.js，调用 init(ctx)。
 * 页面挂到侧边栏「扩展页面」下，接口挂在 /api/custom/<插件>/…（自带登录鉴权）。
 * 数据来自 system/task_history.js 落盘的 data/task_history.json，
 * 覆盖 游戏签到 / 社区签到 / 体力推送 / 抽卡更新。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadTaskHistory() {
  const mod = await import('../system/task_history.js')
  return mod
}

const PAGE_HTML = `
<div class="hoyo-task-hist">
  <div class="hth-cards" id="hth-cards"></div>
  <div class="hth-bar">
    <input class="hth-input" id="hth-qq" placeholder="按 QQ 过滤（可空）" />
    <select class="hth-input" id="hth-task">
      <option value="">全部任务</option>
      <option value="sign">游戏签到</option>
      <option value="bbs_sign">社区签到</option>
      <option value="stamina">体力推送</option>
      <option value="gacha">抽卡更新</option>
      <option value="cron">定时任务</option>
    </select>
    <select class="hth-input" id="hth-status">
      <option value="">全部状态</option>
      <option value="ok">成功</option>
      <option value="signed">已完成</option>
      <option value="fail">失败</option>
      <option value="skip">跳过</option>
    </select>
    <select class="hth-input" id="hth-days">
      <option value="1">近 1 天</option>
      <option value="3" selected>近 3 天</option>
      <option value="7">近 7 天</option>
      <option value="30">近 30 天</option>
    </select>
    <select class="hth-input" id="hth-limit">
      <option value="100">最近 100 条</option>
      <option value="200" selected>最近 200 条</option>
      <option value="500">最近 500 条</option>
    </select>
    <button class="hth-btn" id="hth-refresh">刷新</button>
    <span class="hth-meta" id="hth-meta"></span>
  </div>
  <div class="hth-table-wrap">
    <table class="hth-table">
      <thead>
        <tr><th>时间</th><th>任务</th><th>来源</th><th>QQ</th><th>昵称</th><th>游戏</th><th>UID</th><th>状态</th><th>说明</th></tr>
      </thead>
      <tbody id="hth-body"><tr><td colspan="9" class="hth-empty">加载中…</td></tr></tbody>
    </table>
  </div>
</div>
`

const PAGE_STYLE = `
.hoyo-task-hist { padding: 4px 2px 10px; }
.hth-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-bottom: 14px; }
.hth-card { padding: 12px 14px; border-radius: 12px; border: 1px solid var(--g-border, #e3e8ef); background: var(--g-card, #fff); }
.hth-card .k { font-size: 12px; color: var(--g-muted, #8a93a3); }
.hth-card .v { margin-top: 6px; font-size: 22px; font-weight: 600; color: var(--g-text, #333); }
.hth-card .s { margin-top: 4px; font-size: 12px; }
.hth-card .s .ok { color: #1a7f37; }
.hth-card .s .fail { color: #d43f3f; }
.hth-card .s .signed { color: #4c6ef5; }
.hth-card .s .skip { color: #8a93a3; }
.hth-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.hth-input { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 13px; outline: none; }
.hth-input:focus { border-color: #4c8bf5; }
.hth-btn { height: 32px; padding: 0 16px; border-radius: 8px; border: none; background: #4c8bf5; color: #fff; font-size: 13px; cursor: pointer; }
.hth-btn:hover { background: #3b78e0; }
.hth-meta { font-size: 12px; color: var(--g-muted, #8a93a3); }
.hth-table-wrap { border-radius: 10px; overflow: auto; border: 1px solid var(--g-border, #e3e8ef); }
.hth-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.hth-table th, .hth-table td { padding: 8px 12px; text-align: left; white-space: nowrap; }
.hth-table thead th { position: sticky; top: 0; background: var(--g-card, #f7f9fc); color: var(--g-muted, #6b7280); font-weight: 600; border-bottom: 1px solid var(--g-border, #e3e8ef); }
.hth-table tbody tr:nth-child(even) { background: rgba(120, 150, 200, 0.05); }
.hth-table tbody tr:hover { background: rgba(76, 139, 245, 0.08); }
.hth-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; line-height: 18px; }
.hth-ok { color: #1a7f37; background: rgba(35, 178, 90, 0.14); }
.hth-signed { color: #4c6ef5; background: rgba(76, 110, 245, 0.14); }
.hth-fail { color: #d43f3f; background: rgba(212, 63, 63, 0.14); }
.hth-skip { color: #6b7280; background: rgba(107, 114, 128, 0.14); }
.hth-src { font-size: 12px; color: var(--g-muted, #8a93a3); }
.hth-tip { color: var(--g-muted, #8a93a3); max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
.hth-empty { text-align: center; color: var(--g-muted, #8a93a3); padding: 24px 0; }
`

const PAGE_SCRIPT = `
(function () {
  const g = window.__GUOBA__ || {}
  const body = document.getElementById('hth-body')
  const cards = document.getElementById('hth-cards')
  const meta = document.getElementById('hth-meta')
  const el = id => document.getElementById(id)
  const STATUS = { ok: '成功', signed: '已完成', fail: '失败', skip: '跳过' }
  const SOURCE = { manual: '手动', cron: '定时', event: '事件' }

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
        + '<td>' + esc(r.game) + '</td>'
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
`

export function init(ctx) {
  ctx.registerApi('get', '/history', async (req, res) => {
    try {
      const { readTaskRecords } = await loadTaskHistory()
      const q = req.query || {}
      const data = readTaskRecords({
        limit: q.limit,
        qq: q.qq,
        task: q.task,
        game: q.game,
        status: q.status,
        day: q.day,
        days: q.days,
      })
      res.json({ ok: true, code: 0, message: 'ok', result: data })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取任务记录失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: { total: 0, records: [] } })
    }
  })

  ctx.registerApi('get', '/summary', async (req, res) => {
    try {
      const { summarizeTaskRecords } = await loadTaskHistory()
      const q = req.query || {}
      res.json({ ok: true, code: 0, message: 'ok', result: summarizeTaskRecords({ days: q.days || 1 }) })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 汇总任务记录失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerPage({
    id: 'hoyo-task-history',
    title: '米哈游任务记录',
    icon: '🗂',
    priority: 60,
    html: PAGE_HTML,
    style: PAGE_STYLE,
    script: PAGE_SCRIPT,
  })
}

export default { init }
