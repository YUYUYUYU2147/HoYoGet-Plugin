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
  <div class="ck-stats" id="ck-stats"></div>
  <div class="ck-tip">CK / SK 属于敏感凭证，页面只显示掩码；点击卡片上的头像或「修改」可查看/编辑原文，保存后立即写回 data/Stoken/&lt;QQ&gt;.yaml。</div>
  <div class="ck-bar">
    <input class="ck-input" id="ck-qq" placeholder="搜索 QQ" />
    <select class="ck-input" id="ck-game">
      <option value="">全部游戏</option>
      <option value="gs">原神</option>
      <option value="sr">崩坏：星穹铁道</option>
      <option value="zzz">绝区零</option>
      <option value="bh3">崩坏3</option>
    </select>
    <select class="ck-input" id="ck-status">
      <option value="">全部状态</option>
      <option value="ok">CK 可用</option>
      <option value="nock">缺 CK</option>
    </select>
    <button class="ck-btn primary" id="ck-refresh">刷新</button>
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

const PANEL_HTML = `
<div class="hoyo-panel">
  <div class="pn-stats" id="pn-stats"></div>
  <div class="pn-tip">管理本插件自定义面板图（resources/hoyo_panel/images/panel/&lt;游戏&gt;/&lt;角色&gt;/）。上传用命令「#米哈游上传&lt;角色&gt;面板图」，这里负责预览与删除。</div>
  <div class="pn-bar">
    <select class="pn-input" id="pn-game">
      <option value="gs">原神</option>
      <option value="sr">崩坏：星穹铁道</option>
    </select>
    <button class="pn-btn primary" id="pn-refresh">刷新</button>
    <span class="pn-meta" id="pn-meta"></span>
  </div>
  <div class="pn-upload">
    <input class="pn-input" id="pn-up-name" placeholder="角色名（如 雷电将军）" />
    <input type="file" id="pn-up-file" multiple accept="image/*" />
    <button class="pn-btn primary" id="pn-up-btn">上传</button>
    <span class="pn-up-msg" id="pn-up-msg"></span>
  </div>
  <div class="pn-cards" id="pn-cards"><div class="pn-empty">加载中…</div></div>
</div>
`

const BIND_HTML = `
<div class="hoyo-bind">
  <div class="hb-stats" id="hb-stats"></div>
  <div class="hb-bar">
    <input class="hb-input" id="hb-qq" placeholder="搜索 QQ" />
    <select class="hb-input" id="hb-game">
      <option value="">全部游戏</option>
      <option value="gs">原神</option>
      <option value="sr">崩坏：星穹铁道</option>
      <option value="zzz">绝区零</option>
      <option value="bh3">崩坏3</option>
    </select>
    <button class="hb-btn primary" id="hb-refresh">刷新</button>
    <span class="hb-meta" id="hb-meta"></span>
  </div>
  <div id="hb-list"><div class="hb-empty">加载中…</div></div>
</div>
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

  ctx.registerApi('get', '/panel/list', async (req, res) => {
    try {
      const { listPanels } = await import('../system/panel_store.js')
      const q = req.query || {}
      const list = listPanels(q.game || 'gs')
      res.json({ ok: true, code: 0, message: 'ok', result: list.map(p => ({ game: p.game, name: p.name, count: p.files.length, cover: p.files[0] })) })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取面板图列表失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/panel/files', async (req, res) => {
    try {
      const { listFiles } = await import('../system/panel_store.js')
      const q = req.query || {}
      res.json({ ok: true, code: 0, message: 'ok', result: listFiles(q.game, q.name) })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/panel/img', async (req, res) => {
    try {
      const { panelFilePath } = await import('../system/panel_store.js')
      const q = req.query || {}
      const abs = panelFilePath(q.game, q.name, q.file)
      if (!abs) return res.status(404).end()
      res.sendFile(abs)
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取面板图失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('post', '/panel/upload', async (req, res) => {
    try {
      const { saveUploadedFiles } = await import('../system/panel_store.js')
      const b = req.body || {}
      const r = saveUploadedFiles(b.game, b.name, req.files)
      res.json({ ok: true, code: 0, message: `已保存 ${r.saved.length} 张` + (r.skipped.length ? `，跳过 ${r.skipped.length} 张非图片` : ''), result: r })
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 上传面板图失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: null })
    }
  })

  ctx.registerApi('post', '/panel/delete', async (req, res) => {
    try {
      const { deletePanelFile } = await import('../system/panel_store.js')
      const b = req.body || {}
      const ok = deletePanelFile(b.game, b.name, b.file)
      res.json({ ok: true, code: 0, message: ok ? '已删除' : '文件不存在', result: ok })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: false })
    }
  })

  ctx.registerPage({
    id: 'hoyo-panel-art',
    title: '角色面板图管理',
    icon: '🖼',
    priority: 63,
    html: PANEL_HTML,
    style: 'panel.css',
    script: 'panel.js',
  })

  ctx.registerPage({
    id: 'hoyo-ck-manage',
    title: '米哈游 CK / SK 管理',
    icon: '🔑',
    priority: 62,
    html: CK_HTML,
    style: 'ck.css',
    script: 'ck.js',
  })

  ctx.registerPage({
    id: 'hoyo-bindings',
    title: '米哈游绑定总览',
    icon: '🔗',
    priority: 61,
    html: BIND_HTML,
    style: 'bind.css',
    script: 'bind.js',
  })

  ctx.registerPage({
    id: 'hoyo-task-history',
    title: '米哈游任务记录',
    icon: '🗂',
    priority: 60,
    html: PAGE_HTML,
    style: 'task.css',
    script: 'task.js',
  })
}

export default { init }
