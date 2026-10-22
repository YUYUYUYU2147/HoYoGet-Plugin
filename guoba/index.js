/**
 * 锅巴自定义页面：米哈游任务记录。
 *
 * 锅巴启动时扫描各插件目录下的 guoba/index.js，调用 init(ctx)。
 * 页面挂到侧边栏「扩展页面」下，接口挂在 /api/custom/<插件>/…（自带登录鉴权）。
 * 数据来自 system/task_history.js 落盘的 data/task_history.json，
 * 覆盖 游戏签到 / 社区签到 / 体力推送 / 抽卡更新。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STOKEN_DIR = path.join(ROOT, 'data', 'Stoken')

/** 通行证脱敏：只留后 4 位，面板里不该出现完整 stuid */
function maskStuid(stuid) {
  const s = String(stuid || '').trim()
  if (!s) return '默认'
  return s.length <= 4 ? s : `****${s.slice(-4)}`
}

/** UID 也做半掩码：前 2 后 4，够核对、不暴露完整号 */
function maskUid(uid) {
  const s = String(uid || '').trim()
  if (s.length <= 6) return s
  return `${s.slice(0, 2)}****${s.slice(-4)}`
}

/**
 * 扫描 data/Stoken/<QQ>.yaml，聚合成「QQ → 账号 → 游戏」的绑定总览。
 * 只读本地文件，不发任何请求；不含 stoken/cookie 原文。
 */
/* 游戏判定与 system/sign.js 的 gameOfEntry 保持同一口径，但这里不 import
   那个模块 —— 它顶部会读 config，在锅巴侧加载没必要，还会把异常带进来。 */
const GAME_BIZ = { hk4e_cn: 'gs', hkrpg_cn: 'sr', nap_cn: 'zzz', bh3_cn: 'bh3' }
const REGION_NAME = { 天空岛: 'gs', 世界树: 'gs', 星穹列车: 'sr', 新艾利都: 'zzz' }
const BH3_REGIONS = new Set(['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'])

function gameOfEntry(entry) {
  const byBiz = GAME_BIZ[String(entry?.game_biz || '')]
  if (byBiz) return byBiz
  const byName = REGION_NAME[String(entry?.region_name || '')]
  if (byName) return byName
  return BH3_REGIONS.has(String(entry?.region || '')) ? 'bh3' : ''
}

async function collectBindings() {
  let files = []
  try {
    files = fs.readdirSync(STOKEN_DIR).filter(f => f.endsWith('.yaml'))
  } catch {
    return []
  }
  const users = []
  for (const file of files) {
    const qq = file.replace(/\.yaml$/, '')
    let data = {}
    try {
      data = YAML.parse(fs.readFileSync(path.join(STOKEN_DIR, file), 'utf8')) || {}
    } catch {
      continue
    }
    const accounts = []
    for (const entry of Object.values(data)) {
      if (!entry || typeof entry !== 'object') continue
      // uid 为 "0" / 纯占位的不算有效绑定
      if (!entry.uid || !/^\d+(\.\d+)?$/.test(String(entry.uid)) || Number(entry.uid) <= 0) continue
      const game = gameOfEntry(entry)
      accounts.push({
        uid: String(entry.uid),
        uidMask: maskUid(entry.uid),
        stuidMask: maskStuid(entry.stuid),
        game,
        gameName: { gs: '原神', sr: '崩坏：星穹铁道', zzz: '绝区零', bh3: '崩坏3' }[game] || '未知',
        region: String(entry.region_name || entry.region || ''),
      })
    }
    if (!accounts.length) continue
    users.push({
      qq,
      total: accounts.length,
      // 去重统计每个游戏有几个号
      byGame: accounts.reduce((m, a) => {
        m[a.game] = (m[a.game] || 0) + 1
        return m
      }, {}),
      accounts,
    })
  }
  users.sort((a, b) => b.total - a.total)
  return users
}

async function loadTaskHistory() {
  const mod = await import('../system/task_history.js')
  return mod
}



const CK_HTML = `
<div class="hoyo-ck">
  <div class="ck-tip">CK / SK 属于敏感凭证，页面只显示掩码；点击卡片上的头像或「修改」可查看/编辑原文，保存后立即写回 data/Stoken/&lt;QQ&gt;.yaml。</div>
  <div class="ck-bar">
    <input class="ck-input" id="ck-qq" placeholder="按 QQ 过滤（可空）" />
    <select class="ck-input" id="ck-game">
      <option value="">全部游戏</option>
      <option value="gs">原神</option>
      <option value="sr">崩坏：星穹铁道</option>
      <option value="zzz">绝区零</option>
      <option value="bh3">崩坏3</option>
    </select>
    <button class="ck-btn" id="ck-refresh">刷新</button>
    <span class="ck-meta" id="ck-meta"></span>
  </div>

  <div class="ck-editor" id="ck-editor">
    <div class="ck-editor-title" id="ck-editor-title">修改账号</div>
    <div class="ck-grid">
      <label>QQ<input class="ck-input" id="ck-f-qq" readonly /></label>
      <label>UID<input class="ck-input" id="ck-f-uid" readonly /></label>
      <label>通行证 stuid<input class="ck-input" id="ck-f-stuid" placeholder="米游社通行证 id" /></label>
      <label>mid<input class="ck-input" id="ck-f-mid" placeholder="可空" /></label>
    </div>
    <label class="ck-block">CK（完整 cookie 串，或只粘贴 cookie_token）
      <textarea class="ck-area" id="ck-f-ck" rows="4" placeholder="stuid=...;stoken=...;ltoken=...;cookie_token=...;mid=..."></textarea>
    </label>
    <label class="ck-block">SK（stoken，用于刷新 CK）
      <textarea class="ck-area" id="ck-f-sk" rows="2" placeholder="v2_..."></textarea>
    </label>
    <div class="ck-actions">
      <button class="ck-btn primary" id="ck-save">保存</button>
      <button class="ck-btn" id="ck-cancel">取消</button>
      <span class="ck-msg" id="ck-msg"></span>
    </div>
  </div>

  <div class="ck-cards" id="ck-cards"><div class="ck-empty">加载中…</div></div>
</div>
`

const CK_STYLE = `
.hoyo-ck { padding: 4px 2px 10px; }
.ck-tip { margin-bottom: 12px; padding: 9px 12px; border-radius: 10px; font-size: 12px; line-height: 1.6; color: var(--g-muted, #8a93a3); background: rgba(255, 196, 92, 0.12); border-left: 3px solid rgba(240, 170, 60, 0.6); }
.ck-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.ck-input { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 13px; outline: none; }
.ck-input:focus { border-color: #4c8bf5; }
.ck-btn { height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 13px; cursor: pointer; }
.ck-btn:hover { border-color: #4c8bf5; color: #3b78e0; }
.ck-btn.primary { background: #4c8bf5; border-color: #4c8bf5; color: #fff; }
.ck-btn.primary:hover { background: #3b78e0; color: #fff; }
.ck-btn.danger { color: #d43f3f; }
.ck-btn.danger:hover { border-color: #d43f3f; }
.ck-meta { font-size: 12px; color: var(--g-muted, #8a93a3); }
.ck-editor { display: none; margin-bottom: 14px; padding: 14px; border-radius: 12px; border: 1px solid var(--g-border, #e3e8ef); background: var(--g-card, #fff); }
.ck-editor.on { display: block; }
.ck-editor-title { margin-bottom: 10px; font-size: 14px; font-weight: 600; color: var(--g-text, #333); }
.ck-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 10px; }
.ck-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--g-muted, #8a93a3); }
.ck-block { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; font-size: 12px; color: var(--g-muted, #8a93a3); }
.ck-area { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; resize: vertical; outline: none; }
.ck-area:focus { border-color: #4c8bf5; }
.ck-actions { display: flex; gap: 8px; align-items: center; }
.ck-msg { font-size: 12px; color: var(--g-muted, #8a93a3); }

.ck-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.ck-card { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--g-border, #e3e8ef); background: var(--g-card, #fff); }
.ck-card:hover { border-color: #4c8bf5; box-shadow: 0 2px 10px rgba(76, 139, 245, 0.12); }
.ck-avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; flex: none; background: #eef2f7; cursor: pointer; box-shadow: 0 0 0 2px #fff, 0 3px 8px rgba(96, 140, 200, 0.2); }
.ck-avatar:hover { opacity: 0.85; }
.ck-info { flex: 1; min-width: 0; }
.ck-name { font-size: 14px; font-weight: 600; color: var(--g-text, #333); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck-sub { margin-top: 2px; font-size: 12px; color: var(--g-muted, #8a93a3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ck-status { margin-top: 3px; font-size: 12px; }
.ck-status .ok { color: #1a7f37; }
.ck-status .no { color: #d43f3f; }
.ck-ops { display: flex; flex-direction: column; gap: 6px; }
.ck-ops .ck-btn { height: 26px; padding: 0 10px; font-size: 12px; }
.ck-empty { text-align: center; color: var(--g-muted, #8a93a3); padding: 28px 0; grid-column: 1 / -1; }
`

const CK_SCRIPT = `
(function () {
  const g = window.__GUOBA__ || {}
  const cards = document.getElementById('ck-cards')
  const meta = document.getElementById('ck-meta')
  const el = id => document.getElementById(id)
  const editor = el('ck-editor')
  let editing = null

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
  }
  function headers(json) {
    const h = { [g.tokenKey || 'guoba-access-token']: g.token || '' }
    if (json) h['Content-Type'] = 'application/json'
    return h
  }
  async function api(path, opts) {
    const res = await fetch(g.apiBase + path, opts)
    return await res.json()
  }
  const qqAvatar = qq => 'https://q1.qlogo.cn/g?b=qq&s=140&nk=' + encodeURIComponent(qq) + '.jpg'

  async function load() {
    cards.innerHTML = '<div class="ck-empty">加载中…</div>'
    const p = new URLSearchParams()
    if (el('ck-qq').value.trim()) p.set('qq', el('ck-qq').value.trim())
    if (el('ck-game').value) p.set('game', el('ck-game').value)
    try {
      const json = await api('/ck/list?' + p.toString(), { headers: headers() })
      const list = json?.result || []
      meta.textContent = '共 ' + list.length + ' 个账号'
      if (!list.length) {
        cards.innerHTML = '<div class="ck-empty">没有匹配的账号</div>'
        return
      }
      cards.innerHTML = list.map((a, i) => {
        const ck = a.hasCk ? '<span class="ok">CK 有</span>' : '<span class="no">CK 无</span>'
        const sk = a.hasSk ? '<span class="ok">SK 有</span>' : '<span class="no">SK 无</span>'
        return '<div class="ck-card">'
          + '<img class="ck-avatar" data-i="' + i + '" src="' + qqAvatar(a.qq) + '" title="点击修改" '
          + 'onerror="this.src=\'data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2252%22 height=%2252%22><rect width=%2252%22 height=%2252%22 fill=%22%23eef2f7%22/></svg>\'" />'
          + '<div class="ck-info">'
          + '<div class="ck-name">' + esc(a.gameName) + ' · ' + esc(a.uid) + '</div>'
          + '<div class="ck-sub">' + esc(a.region || '未知区服') + ' · 通行证 ' + esc(a.stuidMask) + '</div>'
          + '<div class="ck-status">' + ck + ' · ' + sk + '</div>'
          + '</div>'
          + '<div class="ck-ops">'
          + '<button class="ck-btn" data-act="edit" data-i="' + i + '">修改</button>'
          + '<button class="ck-btn danger" data-act="del" data-i="' + i + '">删除</button>'
          + '</div>'
          + '</div>'
      }).join('')
      cards.querySelectorAll('[data-act]').forEach(btn => {
        const a = list[Number(btn.dataset.i)]
        btn.addEventListener('click', () => {
          if (btn.dataset.act === 'edit') openEditor(a)
          else remove(a)
        })
      })
      cards.querySelectorAll('.ck-avatar').forEach(av => {
        const a = list[Number(av.dataset.i)]
        av.addEventListener('click', () => openEditor(a))
      })
    } catch (err) {
      cards.innerHTML = '<div class="ck-empty">加载失败：' + esc(err && err.message || err) + '</div>'
    }
  }

  async function openEditor(a) {
    el('ck-msg').textContent = ''
    const json = await api('/ck/get?qq=' + encodeURIComponent(a.qq) + '&uid=' + encodeURIComponent(a.uid), { headers: headers() })
    if (!json?.ok) { el('ck-msg').textContent = json?.message || '读取失败'; return }
    const d = json.result
    editing = { qq: d.qq, uid: d.uid }
    el('ck-editor-title').textContent = '修改账号 · ' + d.gameName + ' · ' + d.uid
    el('ck-f-qq').value = d.qq
    el('ck-f-uid').value = d.uid
    el('ck-f-stuid').value = d.stuid || ''
    el('ck-f-mid').value = d.mid || ''
    el('ck-f-ck').value = d.ck_stoken || ''
    el('ck-f-sk').value = d.stoken || ''
    editor.classList.add('on')
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  async function save() {
    if (!editing) return
    const payload = {
      qq: editing.qq, uid: editing.uid,
      stuid: el('ck-f-stuid').value.trim(),
      mid: el('ck-f-mid').value.trim(),
      ck: el('ck-f-ck').value.trim(),
      stoken: el('ck-f-sk').value.trim(),
    }
    el('ck-msg').textContent = '保存中…'
    const json = await api('/ck/save', { method: 'POST', headers: headers(true), body: JSON.stringify(payload) })
    el('ck-msg').textContent = json?.message || (json?.ok ? '已保存' : '保存失败')
    if (json?.ok) { editor.classList.remove('on'); editing = null; load() }
  }

  async function remove(a) {
    if (!confirm('确定删除 ' + a.gameName + ' UID ' + a.uid + ' 的绑定？删除后需要重新扫码或手动填 CK。')) return
    const json = await api('/ck/delete', { method: 'POST', headers: headers(true), body: JSON.stringify({ qq: a.qq, uid: a.uid }) })
    if (!json?.ok) alert(json?.message || '删除失败')
    load()
  }

  el('ck-refresh').addEventListener('click', load)
  el('ck-qq').addEventListener('keydown', e => { if (e.key === 'Enter') load() })
  el('ck-game').addEventListener('change', load)
  el('ck-save').addEventListener('click', save)
  el('ck-cancel').addEventListener('click', () => { editor.classList.remove('on'); editing = null })
  load()
})();
`

const BIND_HTML = `
<div class="hoyo-bind">
  <div class="hb-bar">
    <input class="hb-input" id="hb-qq" placeholder="按 QQ 过滤（可空）" />
    <select class="hb-input" id="hb-game">
      <option value="">全部游戏</option>
      <option value="gs">原神</option>
      <option value="sr">崩坏：星穹铁道</option>
      <option value="zzz">绝区零</option>
      <option value="bh3">崩坏3</option>
    </select>
    <button class="hb-btn" id="hb-refresh">刷新</button>
    <span class="hb-meta" id="hb-meta"></span>
  </div>
  <div id="hb-list"><div class="hb-empty">加载中…</div></div>
</div>
`

const BIND_STYLE = `
.hoyo-bind { padding: 4px 2px 10px; }
.hb-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 14px; }
.hb-input { height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--g-border, #d8dde6); background: var(--g-card, #fff); color: var(--g-text, #333); font-size: 13px; outline: none; }
.hb-input:focus { border-color: #4c8bf5; }
.hb-btn { height: 32px; padding: 0 16px; border-radius: 8px; border: none; background: #4c8bf5; color: #fff; font-size: 13px; cursor: pointer; }
.hb-btn:hover { background: #3b78e0; }
.hb-meta { font-size: 12px; color: var(--g-muted, #8a93a3); }
.hb-card { border: 1px solid var(--g-border, #e3e8ef); border-radius: 12px; margin-bottom: 12px; overflow: hidden; background: var(--g-card, #fff); }
.hb-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: rgba(120, 150, 200, 0.06); border-bottom: 1px solid var(--g-border, #e3e8ef); }
.hb-qq { font-size: 15px; font-weight: 600; color: var(--g-text, #333); }
.hb-tags { display: flex; gap: 6px; margin-left: auto; }
.hb-tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: rgba(76, 139, 245, 0.12); color: #3b78e0; }
.hb-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.hb-table th, .hb-table td { padding: 8px 14px; text-align: left; white-space: nowrap; }
.hb-table thead th { color: var(--g-muted, #6b7280); font-weight: 600; border-bottom: 1px solid var(--g-border, #e3e8ef); }
.hb-table tbody tr:hover { background: rgba(76, 139, 245, 0.06); }
.hb-game { font-weight: 600; }
.hb-gs { color: #c0893c; }
.hb-sr { color: #5b7ec9; }
.hb-zzz { color: #4a9a8f; }
.hb-bh3 { color: #b06a9a; }
.hb-empty { text-align: center; color: var(--g-muted, #8a93a3); padding: 28px 0; }
`

const BIND_SCRIPT = `
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
`

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

  ctx.registerApi('get', '/bindings', async (req, res) => {
    try {
      const users = await collectBindings()
      res.json({ ok: true, code: 0, message: 'ok', result: { total: users.length, users } })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取绑定失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: { total: 0, users: [] } })
    }
  })

  ctx.registerApi('get', '/ck/list', async (req, res) => {
    try {
      const { listAccounts } = await import('../system/ck_store.js')
      const q = req.query || {}
      res.json({ ok: true, code: 0, message: 'ok', result: listAccounts({ qq: q.qq, game: q.game }) })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取 CK 列表失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/ck/get', async (req, res) => {
    try {
      const { getAccount } = await import('../system/ck_store.js')
      const q = req.query || {}
      const acc = getAccount(q.qq, q.uid)
      if (!acc) return res.json({ ok: false, code: -1, message: '没有这个账号', result: null })
      res.json({ ok: true, code: 0, message: 'ok', result: acc })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: null })
    }
  })

  ctx.registerApi('post', '/ck/save', async (req, res) => {
    try {
      const { saveAccount } = await import('../system/ck_store.js')
      const b = req.body || {}
      const r = saveAccount(b.qq, b.uid, b)
      res.json({ ok: true, code: 0, message: r.changed ? '已保存' : '内容没有变化', result: r.account })
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 保存 CK 失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: null })
    }
  })

  ctx.registerApi('post', '/ck/delete', async (req, res) => {
    try {
      const { deleteAccount } = await import('../system/ck_store.js')
      const b = req.body || {}
      const ok = deleteAccount(b.qq, b.uid)
      res.json({ ok: true, code: 0, message: ok ? '已删除' : '条目不存在', result: ok })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: false })
    }
  })

  ctx.registerPage({
    id: 'hoyo-ck-manage',
    title: '米哈游 CK / SK 管理',
    icon: '🔑',
    priority: 62,
    html: CK_HTML,
    style: CK_STYLE,
    script: CK_SCRIPT,
  })

  ctx.registerPage({
    id: 'hoyo-bindings',
    title: '米哈游绑定总览',
    icon: '🔗',
    priority: 61,
    html: BIND_HTML,
    style: BIND_STYLE,
    script: BIND_SCRIPT,
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
