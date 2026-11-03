/**
 * 批量更新群友的绝区零面板。
 *
 * 指令：%更新群友面板（仅主人）
 *
 * 为什么单独一个模块而不是塞进 zzz_panel_list.js：
 *   zzz_panel_list.js 有 3000 行，面板列表、详情、评分、提醒全在里面。
 *   批量刷新的关注点完全不同 —— 它要处理的是「遍历一批 QQ/UID、
 *   控制节奏、汇报进度、失败不中断」，和单用户出图是两套逻辑。
 *
 * 为什么必须限流：
 *   每个用户至少 2 次请求（avatar/basic + 若干 avatar/info）。
 *   一个 50 人群就能上百次，而米游社对 IP 有频次风控，
 *   打完就是一串 10041（现在虽然会走代理，但代理同样有配额）。
 *   所以默认串行、默认 2 秒间隔，并且总时长有上限，避免指令悬着不返回。
 *
 * 为什么不复用 panelList：
 *   那个函数要 e（当前消息上下文）来出图，批量场景下只需要落盘数据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { mhyFetch } from '../../../system/mhy_fetch.js'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '../../..')
const OUT_DIR = path.join(PLUGIN_ROOT, 'data', 'zzz_panel')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

/** 默认节奏：串行 + 2s 间隔。可通过 config 覆盖，但不要低于 1s。 */
const DEFAULT_INTERVAL_MS = 2000
/** 单次批量操作的硬上限：再多就不该用指令做了 */
const DEFAULT_MAX_USERS = 50
/** 整体超时（毫秒）：超时就停下并汇报已完成部分 */
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000

const sleep = ms => new Promise(r => setTimeout(r, ms))

function readConfig() {
  try {
    const { config } = globalThis
    const cfg = typeof config === 'function' ? config() : {}
    return cfg || {}
  } catch (_) {
    return {}
  }
}

/** 从 yunzai 数据库取全部 QQ → zzz uid 的绑定 */
async function loadBoundUsers() {
  if (!fs.existsSync(YUNZAI_DB)) return []
  const sqlite3 = (await import('sqlite3')).default
  const rows = await new Promise((resolve) => {
    const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve([]) : null))
    db.all('select id, ltuids, games from Users', (err2, list) => {
      db.close(() => {})
      resolve(err2 ? [] : list || [])
    })
  })
  const out = []
  for (const row of rows) {
    let games = {}
    try { games = JSON.parse(row.games || '{}') } catch { games = {} }
    const raw = games?.zzz?.uid
    const uid = String(raw || '').trim()
    /* 只认 8~9 位纯数字：历史数据里有空串、'0'、甚至 uid 存成对象的情况 */
    if (!/^\d{8,9}$/.test(uid)) continue
    out.push({
      qq: String(row.id),
      uid,
      ltuids: String(row.ltuids || '').split(',').map(s => s.trim()).filter(Boolean),
    })
  }
  return out
}

/** 取某个 QQ 名下、对应该 uid 的 CK（走插件已有的解析顺序，不再造新规则） */
async function resolveCkFor(handler, qq, uid) {
  /* 构造最小上下文：getCk 内部会用到 e.user_id，其余分支都有兜底。
     reply 给个空实现，避免内部误调用时抛错。 */
  const mock = { user_id: Number(qq), game: 'zzz', reply: () => {} }
  try {
    return await handler.getCk(mock, uid)
  } catch (_) {
    return false
  }
}

/**
 * 拉一个用户的面板原始数据并落盘。
 * 不渲染图片、不排序评分 —— 批量更新的产出就是
 * data/zzz_panel/avatar_basic_<uid>.json 与 records/<uid>_<角色>.json 的刷新。
 */
async function refreshOne(handler, user) {
  const { qq, uid } = user
  const ck = await resolveCkFor(handler, qq, uid)
  if (!ck || !Object.values(ck).some(item => item?.ck)) {
    return { ok: false, reason: '无可用 CK' }
  }
  let server = 'prod_gf_cn'
  try {
    server = (await handler.pickServer(uid, ck)) || server
  } catch (_) { /* 取不到就用默认 */ }

  const mock = { user_id: Number(qq), game: 'zzz', reply: () => {} }
  const raw = await handler.fetchRaw(mock, uid, server, ck)
  if (raw?.__error) return { ok: false, reason: String(raw.__error).slice(0, 60) }

  const list = handler.pickList(raw?.data)
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, reason: '接口未返回角色列表' }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_DIR, `avatar_basic_${uid}.json`),
    JSON.stringify({ qq, uid, server, updatedAt: new Date().toISOString(), data: raw?.data }, null, 2),
  )
  return { ok: true, count: list.length }
}

/**
 * 执行批量更新。
 *
 * @param {object} handler  zzz_panel_list 实例（借用它的 getCk / pickServer / fetchRaw / pickList）
 * @param {object} e        消息上下文，用于分组过滤与进度回复
 * @param {object} [opts]   { intervalMs, maxUsers, deadlineMs }
 */
export async function updateGroupMembers(handler, e, opts = {}) {
  const cfg = readConfig()
  const intervalMs = Math.max(1000, Number(opts.intervalMs ?? cfg.zzz_bulk_update_interval) || DEFAULT_INTERVAL_MS)
  const maxUsers = Math.max(1, Number(opts.maxUsers ?? cfg.zzz_bulk_update_max) || DEFAULT_MAX_USERS)
  const deadlineMs = Number(opts.deadlineMs) || DEFAULT_DEADLINE_MS

  const all = await loadBoundUsers()
  if (!all.length) return { error: '没有任何 QQ 绑定绝区零 UID，没东西可更新。' }

  /* 群聊时只更新本群成员；私聊/无群信息时更新全部绑定用户 */
  let targets = all
  let scopeText = '全部绑定用户'
  if (e?.isGroup) {
    let memberSet = new Set()
    try {
      if (e?.group?.getMemberMap) {
        for (const qq of (await e.group.getMemberMap()).keys()) memberSet.add(String(qq))
      } else if (e?.group?.members) {
        for (const qq of Object.keys(e.group.members)) memberSet.add(String(qq))
      }
    } catch (_) { memberSet = new Set() }
    if (!memberSet.size) return { error: '本群成员列表获取失败，无法确定更新范围。' }
    targets = all.filter(u => memberSet.has(u.qq))
    scopeText = `本群已绑定成员`
    if (!targets.length) {
      return { error: '本群没有成员绑定绝区零 UID。\n可私聊发送该指令以更新全部绑定用户。' }
    }
  }

  /* 按 UID 去重：一个 QQ 可能绑定多个账号，但同一 UID 只刷一次 */
  const seen = new Set()
  targets = targets.filter(u => (seen.has(u.uid) ? false : (seen.add(u.uid), true)))

  const truncated = targets.length > maxUsers
  if (truncated) targets = targets.slice(0, maxUsers)

  const started = Date.now()
  const ok = []
  const failed = []

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - started > deadlineMs) {
      failed.push(...targets.slice(i).map(u => ({ uid: u.uid, reason: '超时未处理' })))
      break
    }
    const user = targets[i]
    try {
      const r = await refreshOne(handler, user)
      if (r.ok) ok.push({ uid: user.uid, count: r.count })
      else failed.push({ uid: user.uid, reason: r.reason })
    } catch (err) {
      failed.push({ uid: user.uid, reason: String(err?.message || err).slice(0, 60) })
    }
    if (i < targets.length - 1) await sleep(intervalMs)
  }

  return {
    scopeText,
    total: targets.length,
    truncated,
    ok,
    failed,
    elapsed: Date.now() - started,
  }
}

/** 把结果整理成一条适合直接发送的文字 */
export function formatResult(res) {
  if (res?.error) return res.error
  const lines = [
    `批量更新完成（${res.scopeText}）`,
    `成功 ${res.ok.length} / ${res.total}，耗时 ${Math.round(res.elapsed / 1000)} 秒`,
  ]
  if (res.truncated) lines.push('（已达单次上限，剩余部分请再次执行）')
  if (res.failed.length) {
    lines.push('', '失败：')
    for (const f of res.failed.slice(0, 8)) lines.push(`  ${f.uid}：${f.reason}`)
    if (res.failed.length > 8) lines.push(`  ……另有 ${res.failed.length - 8} 个`)
  }
  return lines.join('\n')
}
