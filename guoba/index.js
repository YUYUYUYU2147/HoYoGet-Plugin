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
const HELP_THEME_ROOT = path.join(ROOT, 'resources', 'global_help', 'theme')

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
  <div class="pn-tip">「本插件面板图」放在 resources/hoyo_panel/images/panel/&lt;游戏&gt;/&lt;角色&gt;/，可上传、预览、删除；「咕咕牛图库」浏览宿主仓库 resources/CowCoos/ 的角色图库，只读预览，不做修改。</div>
  <div class="pn-bar">
    <select class="pn-input" id="pn-source">
      <option value="panel">本插件面板图</option>
      <option value="cowcoo">咕咕牛图库</option>
    </select>
    <select class="pn-input" id="pn-game"></select>
    <input class="pn-input" id="pn-search" placeholder="搜索角色"/><button class="pn-btn primary" id="pn-refresh">刷新</button>
    <span class="pn-meta" id="pn-meta"></span>
  </div>
  <div class="pn-upload" id="pn-upload">
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

function helpThemeNames() {
  try {
    return fs.readdirSync(HELP_THEME_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(HELP_THEME_ROOT, e.name, 'main.png')))
      .map(e => e.name)
  } catch {
    return ['default']
  }
}

let _iconCountCache = { mtime: 0, count: 360 }
/** 雪碧图实际有多少个非空图标（用于选择器只显示有效编号） */
async function helpIconCount() {
  const file = path.join(ROOT, 'resources', 'global_help', 'icon.png')
  try {
    const st = fs.statSync(file)
    if (_iconCountCache.mtime === st.mtimeMs) return _iconCountCache.count
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const cols = 10
    const cw = Math.round(info.width / cols)
    const rows = Math.floor(info.height / cw)
    let last = 0
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let hit = 0
        const x0 = c * cw
        const y0 = r * cw
        for (let y = y0; y < y0 + cw && y < info.height; y += 2) {
          for (let x = x0; x < x0 + cw && x < info.width; x += 2) {
            if (data[(y * info.width + x) * info.channels + 3] > 16) hit++
          }
        }
        if (hit > 50) last = r * cols + c + 1
      }
    }
    _iconCountCache = { mtime: st.mtimeMs, count: last || 360 }
    return _iconCountCache.count
  } catch {
    return 360
  }
}

function pickHelpTheme(helpCfg = {}) {
  const all = helpThemeNames()
  let names = all
  const rawTheme = helpCfg.theme
  const theme = Array.isArray(rawTheme)
    ? rawTheme
    : (typeof rawTheme === 'string' && rawTheme.includes(',')
      ? rawTheme.split(',').map(v => v.trim()).filter(Boolean)
      : rawTheme)
  const custom = Array.isArray(theme) && theme.length
  if (custom) names = all.filter(n => theme.includes(n))
  else if (theme && theme !== 'all') names = all.filter(n => n === String(theme))
  if (!custom) {
    const exclude = Array.isArray(helpCfg.themeExclude) ? helpCfg.themeExclude : []
    if (exclude.length) names = names.filter(n => !exclude.includes(n))
  }
  if (!names.length) names = all.filter(n => n !== 'default')
  if (!names.length) names = ['default']
  return names[Math.floor(Math.random() * names.length)]
}

const BGPAGE_HTML = `
<div class="hoyo-bg">
  <div class="bg-stats" id="bg-stats"></div>
  <div class="bg-tip">这里列出插件已保存的随机背景图（绝区零面板 / 帮助 / 图鉴 / 角色柜 / akasha 等会自动写入 data/zzz_panel/panel_bg.json）。可查看、复制链接或删除。</div>
  <div class="bg-bar">
    <select class="bg-input" id="bg-source">
      <option value="">全部来源</option>
      <option value="panel">面板</option>
      <option value="help">帮助</option>
      <option value="wiki">图鉴</option>
      <option value="hoyo_panel">角色柜</option>
      <option value="akasha">akasha</option>
      <option value="redis">redis 导入</option>
    </select>
    <input class="bg-input" id="bg-q" placeholder="按链接/消息ID筛选" />
    <button class="bg-btn primary" id="bg-refresh">刷新</button>
    <button class="bg-btn" id="bg-export">导出 JSON</button>
    <span class="bg-meta" id="bg-meta"></span>
  </div>
  <div class="bg-cards" id="bg-cards"><div class="bg-empty">加载中…</div></div>
</div>
`

const HELP_HTML = `
<div class="hoyo-help">
  <div class="hp-hero">
    <div class="hp-hero-copy">
      <div class="hp-hero-brand">
        <img class="hp-logo" id="hp-logo" alt="" />
        <span class="hp-kicker">HoYoGet · Global Help</span>
      </div>
      <h2 id="hp-title">全局帮助</h2>
      <p id="hp-sub">原神 / 星铁 / 绝区零 / 崩坏3 全部指令速查。点击任意卡片即可复制指令，也可以直接搜索关键词。</p>
      <div class="hp-hero-tags" id="hp-hero-tags"></div>
    </div>
    <div class="hp-hero-stat" id="hp-stats"></div>
  </div>
  <div class="hp-games" id="hp-games"></div>
  <div class="hp-toolbar">
    <label class="hp-search"><span>⌕</span><input id="hp-search" placeholder="搜索指令或说明，如：抽卡、签到、深渊、面板" /></label>
    <select id="hp-group"><option value="">全部板块</option></select>
    <button id="hp-refresh">刷新</button>
    <button id="hp-edit" class="hp-ghost">编辑</button>
    <span class="hp-meta" id="hp-meta"></span>
  </div>
  <div class="hp-groups" id="hp-groups"><div class="hp-empty">加载中…</div></div>
  <div class="hp-editor" id="hp-editor"></div>
  <div class="hp-icon-picker" id="hp-icon-picker"></div>
  <div class="hp-toast" id="hp-toast"></div>
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
      const icons = {}
      for (const gg of ['gs', 'sr', 'zzz', 'bh3']) {
        try { icons[gg] = 'data:image/webp;base64,' + fs.readFileSync(path.join(ROOT, 'resources', 'game_icons', gg + '.webp')).toString('base64') } catch (e) { }
      }
      res.json({ ok: true, code: 0, message: 'ok', result: { total: users.length, users, icons } })
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
      const store = await import('../system/panel_store.js')
      const q = req.query || {}
      const game = q.game || 'gs'
      let list
      if (q.source === 'cowcoo') {
        list = store.listCowCooPanels(game)
      } else {
        list = store.listPanels(game)
      }
      res.json({ ok: true, code: 0, message: 'ok', result: list.map(p => ({
        game: p.game, name: p.name, count: p.files.length, cover: p.files[0],
        splash: store.splashOf(p.game, p.name),
      })) })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取面板图列表失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/panel/files', async (req, res) => {
    try {
      const store = await import('../system/panel_store.js')
      const q = req.query || {}
      const files = q.source === 'cowcoo'
        ? store.listCowCooFiles(q.game, q.name)
        : store.listFiles(q.game, q.name)
      res.json({ ok: true, code: 0, message: 'ok', result: files })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/panel/img', async (req, res) => {
    try {
      const store = await import('../system/panel_store.js')
      const q = req.query || {}
      const abs = q.source === 'cowcoo'
        ? store.cowCooFilePath(q.game, q.name, q.file)
        : store.panelFilePath(q.game, q.name, q.file)
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

  ctx.registerApi('get', '/game/icon', async (req, res) => {
    try {
      const q = req.query || {}
      const game = ['gs', 'sr', 'zzz', 'bh3'].includes(q.game) ? q.game : null
      if (!game) return res.status(404).end()
      const abs = path.join(ROOT, 'resources', 'game_icons', `${game}.webp`)
      if (!fs.existsSync(abs)) return res.status(404).end()
      res.sendFile(abs)
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取游戏图标失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('get', '/panel/splash', async (req, res) => {
    try {
      const store = await import('../system/panel_store.js')
      const q = req.query || {}
      const rel = store.splashOf(q.game, q.name)
      if (!rel) return res.status(404).end()
      const abs = path.join(ROOT, 'resources', rel)
      if (!fs.existsSync(abs)) return res.status(404).end()
      res.sendFile(abs)
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取角色立绘失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('post', '/help/save', async (req, res) => {
    try {
      const body = req.body || {}
      const cfg = body.helpCfg && typeof body.helpCfg === 'object' ? JSON.parse(JSON.stringify(body.helpCfg)) : {}
      const list = Array.isArray(body.helpList) ? body.helpList : []
      const str = (v, max = 2000) => String(v == null ? '' : v).slice(0, max)
      const cleanCfg = {}
      for (const key of ['title', 'subTitle', 'theme', 'background', 'backgroundApi']) {
        if (cfg[key] != null) cleanCfg[key] = str(cfg[key], 500)
      }
      if (cfg.colCount != null) cleanCfg.colCount = Math.min(5, Math.max(2, Number(cfg.colCount) || 3))
      if (cfg.layout != null) cleanCfg.layout = ['app', 'web', 'classic'].includes(cfg.layout) ? cfg.layout : 'app'
      if (Array.isArray(cfg.themeExclude)) cleanCfg.themeExclude = cfg.themeExclude.map(v => str(v, 40)).slice(0, 60)
      if (typeof cfg.bgBlur === 'boolean') cleanCfg.bgBlur = cfg.bgBlur
      if (cfg.style && typeof cfg.style === 'object') {
        const colorKeys = ['fontColor', 'descColor', 'titleColor', 'subTitleColor', 'fontShadow', 'contBgColor', 'headerBgColor', 'rowBgColor1', 'rowBgColor2', 'tagRed', 'tagAmber', 'tagGreen', 'tagGray']
        const sizeKeys = ['titleSize', 'groupSize', 'itemSize', 'descSize', 'contBgBlur', 'pageDim', 'pageBlur']
        const style = {}
        for (const key of colorKeys) {
          const v = str(cfg.style[key], 120).trim()
          if (v && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v)) style[key] = v
        }
        for (const key of sizeKeys) {
          const n = Number(cfg.style[key])
          if (Number.isFinite(n) && n >= 0) style[key] = Math.min(key === 'contBgBlur' ? 20 : 120, n)
        }
        if (Object.keys(style).length) cleanCfg.style = style
      }
      const helpList = list.slice(0, 100).map(group => ({
        group: str(group?.group, 200) || '未分组',
        ...(group?.auth === 'master' ? { auth: 'master' } : {}),
        list: (Array.isArray(group?.list) ? group.list : []).slice(0, 500).map(item => ({
          icon: Math.max(0, Math.min(999, Number(item?.icon) || 0)),
          title: str(item?.title),
          desc: str(item?.desc),
          tag: str(item?.tag, 100),
        })).filter(item => item.title || item.desc),
      })).filter(group => group.list.length)
      if (!helpList.length) return res.json({ ok: false, code: -1, message: '至少保留一条帮助指令' })
      const text = '# 由锅巴「全局帮助」页保存，覆盖 system/default/global_help.yaml\n' + YAML.stringify({ helpCfg: cleanCfg, helpList })
      const dir = path.join(ROOT, 'config')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'global_help.yaml'), text, 'utf8')
      res.json({ ok: true, code: 0, message: `已保存 ${helpList.length} 个板块` })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 保存全局帮助失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err) })
    }
  })

  ctx.registerApi('post', '/help/reset', (req, res) => {
    try {
      fs.rmSync(path.join(ROOT, 'config', 'global_help.yaml'), { force: true })
      res.json({ ok: true, code: 0, message: '已恢复默认帮助' })
    } catch (err) {
      res.json({ ok: false, code: -1, message: err?.message || String(err) })
    }
  })

  ctx.registerApi('get', '/help/logo', (req, res) => {
    try {
      res.sendFile(path.join(ROOT, 'resources', 'Tl', 'imgs', '米哈游.png'))
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取帮助 Logo 失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('get', '/help/theme/thumb', async (req, res) => {
    try {
      const name = String(req.query?.name || '')
      if (!helpThemeNames().includes(name)) return res.status(404).end()
      // 主题差异主要在 main.png（背景图 37 套是同一张），缩略图必须用 main
      const src = [path.join(HELP_THEME_ROOT, name, 'main.png'), path.join(HELP_THEME_ROOT, name, 'bg.jpg')]
        .find(f => fs.existsSync(f))
      if (!src) return res.status(404).end()
      const st = fs.statSync(src)
      const key = `${name}:${st.mtimeMs}`
      if (!globalThis.__xhhThemeThumbCache) globalThis.__xhhThemeThumbCache = new Map()
      const cache = globalThis.__xhhThemeThumbCache
      if (!cache.has(key)) {
        const sharp = (await import('sharp')).default
        const base = await sharp(src).resize({ width: 320 }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
        const { data, info } = base
        const W = info.width
        const H = info.height
        const C = info.channels
        const bandH = Math.min(180, H)
        // 选细节最多的一段（主题的 main.png 是长图，顶部往往是纯色）
        let bestY = 0
        let bestVar = -1
        for (let y = 0; y <= H - bandH; y += 8) {
          let n = 0
          let sum = 0
          let sum2 = 0
          for (let yy = y; yy < y + bandH; yy += 4) {
            for (let xx = 0; xx < W; xx += 4) {
              const i = (yy * W + xx) * C
              const v = (data[i] + data[i + 1] + data[i + 2]) / 3
              sum += v
              sum2 += v * v
              n++
            }
          }
          const mean = sum / n
          const varr = sum2 / n - mean * mean
          if (varr > bestVar) { bestVar = varr; bestY = y }
        }
        const buf = await sharp(src)
          .resize({ width: 320 })
          .extract({ left: 0, top: bestY, width: W, height: bandH })
          .flatten({ background: '#0f172a' })
          .webp({ quality: 78 })
          .toBuffer()
        cache.set(key, buf)
        if (cache.size > 80) cache.delete(cache.keys().next().value)
      }
      res.type('image/webp').send(cache.get(key))
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取主题缩略图失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('get', '/help/theme', (req, res) => {
    try {
      const q = req.query || {}
      const name = String(q.name || 'default')
      const file = String(q.file || 'bg') === 'main' ? 'main.png' : 'bg.jpg'
      if (!helpThemeNames().includes(name)) return res.status(404).end()
      const abs = path.join(HELP_THEME_ROOT, name, file)
      if (!abs.startsWith(HELP_THEME_ROOT)) return res.status(404).end()
      res.sendFile(abs)
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取帮助主题失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('get', '/help/icon', (req, res) => {
    try {
      res.sendFile(path.join(ROOT, 'resources', 'global_help', 'icon.png'))
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 读取帮助图标失败：${err?.message || err}`)
      res.status(404).end()
    }
  })

  ctx.registerApi('get', '/help', async (req, res) => {
    try {
      // 优先自定义全局帮助，其次完整帮助
      const custom = path.join(ROOT, 'config', 'global_help.yaml')
      const customDefault = path.join(ROOT, 'system', 'default', 'global_help.yaml')
      const detail = path.join(ROOT, 'system', 'default', 'help-detail.yaml')
      const fallback = path.join(ROOT, 'system', 'default', 'help.yaml')
      let target = ''
      if (fs.existsSync(custom)) target = custom
      else if (fs.existsSync(customDefault)) target = customDefault
      else if (fs.existsSync(detail)) target = detail
      else target = fallback
      const raw = YAML.parse(fs.readFileSync(target, 'utf8')) || []
      const result = Array.isArray(raw) ? { helpList: raw } : raw
      result.theme = pickHelpTheme(result.helpCfg || {})
      result.themes = helpThemeNames()
      result.iconCount = await helpIconCount()
      result.background = {
        mode: result.helpCfg?.background || 'mix',
        api: result.helpCfg?.backgroundApi || 'https://api.yppp.net/pc.php',
      }
      try { result.version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '' } catch { result.version = '' }
      res.json({ ok: true, code: 0, message: 'ok', result })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取全局帮助失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: [] })
    }
  })

  ctx.registerApi('get', '/bg/list', async (req, res) => {
    try {
      const file = path.join(ROOT, 'data', 'zzz_panel', 'panel_bg.json')
      let db = { updatedAt: 0, count: 0, list: [] }
      try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { }
      if (!Array.isArray(db.list)) db.list = []
      res.json({ ok: true, code: 0, message: 'ok', result: { updatedAt: db.updatedAt, total: db.list.length, list: db.list } })
    } catch (err) {
      ctx.logger?.error?.(`[HoYoGet][guoba] 读取背景图记录失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: { total: 0, list: [] } })
    }
  })
  ctx.registerApi('post', '/bg/del', async (req, res) => {
    try {
      const file = path.join(ROOT, 'data', 'zzz_panel', 'panel_bg.json')
      const b = req.body || {}
      const key = String(b.msgId == null ? '' : b.msgId)
      if (!key) return res.json({ ok: false, code: -1, message: '缺少 msgId', result: false })
      let db = { updatedAt: 0, count: 0, list: [] }
      try { db = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { }
      if (!Array.isArray(db.list)) db.list = []
      const before = db.list.length
      db.list = db.list.filter(x => !x || String(x.msgId) !== key)
      db.updatedAt = Date.now()
      db.count = db.list.length
      fs.writeFileSync(file, JSON.stringify(db, null, 2))
      res.json({ ok: true, code: 0, message: before === db.list.length ? '未找到该记录' : '已删除', result: before - db.list.length })
    } catch (err) {
      ctx.logger?.warn?.(`[HoYoGet][guoba] 删除背景图记录失败：${err?.message || err}`)
      res.json({ ok: false, code: -1, message: err?.message || String(err), result: false })
    }
  })
  ctx.registerPage({
    id: 'hoyo-global-help',
    title: '全局帮助',
    icon: '📖',
    priority: 64,
    html: HELP_HTML,
    style: 'help.css',
    script: 'help.js',
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
  ctx.registerPage({
    id: 'hoyo-bg-history',
    title: '背景图管理',
    icon: '🎨',
    priority: 59,
    html: BGPAGE_HTML,
    style: 'bg.css',
    script: 'bg.js',
  })

}

export default { init }
