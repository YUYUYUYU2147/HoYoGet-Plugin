/**
 * 批量更新群友的绝区零挑战记录（式舆防卫战 + 危局强袭战）。
 *
 * 指令：%更新群友挑战记录（仅主人）
 *
 * 与「%更新群友面板」的区别：
 *   · 面板刷新走 avatar/basic + avatar/info，产出角色配装数据；
 *   · 挑战记录走 hadal_info_v2 / hadal_mem_detail_v2，产出当期评分（S 评级、星数）。
 *   两者接口不同、落盘位置不同，所以分成两个模块，共用同一套限流与遍历策略。
 *
 * 为什么限流：式舆 + 危局 = 每人 2 次请求；50 人就是 100 次。
 *   米游社对 IP 有频次风控（表现为 10041/10035），必须串行 + 间隔。
 *
 * 复用 zzz_panel_list 的既有能力：
 *   getCk / pickServer / zzzRemindFetch / zzzRemindCheckUser
 *   —— 不重写取数逻辑，避免与提醒任务的口径漂移。
 */
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const OUT_DIR = path.join(PLUGIN_ROOT, 'data', 'zzz_challenge')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_MAX_USERS = 50
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

/** QQ → zzz uid 的绑定，来源与面板批量更新一致 */
async function loadBoundUsers() {
  if (!fs.existsSync(YUNZAI_DB)) return []
  const sqlite3 = (await import('sqlite3')).default
  const rows = await new Promise((resolve) => {
    const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve([]) : null))
    db.all('select id, games from Users', (err2, list) => {
      db.close(() => {})
      resolve(err2 ? [] : list || [])
    })
  })
  const out = []
  for (const row of rows) {
    let games = {}
    try { games = JSON.parse(row.games || '{}') } catch { games = {} }
    const uid = String(games?.zzz?.uid || '').trim()
    if (!/^\d{8,9}$/.test(uid)) continue
    out.push({ qq: String(row.id), uid })
  }
  return out
}

/**
 * 拉一个用户的挑战数据并落盘。
 *
 * 用 zzzRemindFetch 分别取 challenge（式舆）与 deadly（危局），
 * 各自单独 try —— 危局没打或未开放时不该拖累式舆的结果。
 */
async function refreshOne(handler, user) {
  const { qq, uid } = user
  const mock = { user_id: Number(qq), game: 'zzz', reply: () => {} }

  let ck
  try {
    ck = await handler.getCk(mock, uid)
  } catch (_) {
    return { ok: false, reason: '读取 CK 失败' }
  }
  if (!ck || !Object.values(ck).some(item => item?.ck)) {
    return { ok: false, reason: '无可用 CK' }
  }

  const result = { hadal: null, deadly: null, errors: [] }
  for (const [key, type] of [['hadal', 'challenge'], ['deadly', 'deadly']]) {
    try {
      const data = await handler.zzzRemindFetch(mock, uid, ck, type)
      result[key] = data || null
    } catch (err) {
      result.errors.push(`${type}: ${String(err?.message || err).slice(0, 50)}`)
    }
  }

  /* 两个都失败才算这个用户失败；只失败一个时仍落盘另一个 */
  if (!result.hadal && !result.deadly) {
    return { ok: false, reason: result.errors.join('; ') || '接口未返回数据' }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_DIR, `${uid}.json`),
    JSON.stringify({ qq, uid, updatedAt: new Date().toISOString(), ...result }, null, 2),
  )

  return {
    ok: true,
    hadal: !!result.hadal,
    deadly: !!result.deadly,
    partial: result.errors.length > 0,
  }
}

/**
 * 执行批量更新。
 * @param {object} handler zzz_panel_list 实例
 * @param {object} e       消息上下文
 * @param {object} [opts]  { intervalMs, maxUsers, deadlineMs }
 */
export async function updateGroupChallenges(handler, e, opts = {}) {
  const cfg = readConfig()
  const intervalMs = Math.max(1000, Number(opts.intervalMs ?? cfg.zzz_bulk_update_interval) || DEFAULT_INTERVAL_MS)
  const maxUsers = Math.max(1, Number(opts.maxUsers ?? cfg.zzz_bulk_update_max) || DEFAULT_MAX_USERS)
  const deadlineMs = Number(opts.deadlineMs) || DEFAULT_DEADLINE_MS

  const all = await loadBoundUsers()
  if (!all.length) return { error: '没有任何 QQ 绑定绝区零 UID，没东西可更新。' }

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
    scopeText = '本群已绑定成员'
    if (!targets.length) {
      return { error: '本群没有成员绑定绝区零 UID。\n可私聊发送该指令以更新全部绑定用户。' }
    }
  }

  /* 按 UID 去重：多个 QQ 绑同一个账号时只刷一次 */
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
      if (r.ok) ok.push({ uid: user.uid, hadal: r.hadal, deadly: r.deadly, partial: r.partial })
      else failed.push({ uid: user.uid, reason: r.reason })
    } catch (err) {
      failed.push({ uid: user.uid, reason: String(err?.message || err).slice(0, 60) })
    }
    if (i < targets.length - 1) await sleep(intervalMs)
  }

  return { scopeText, total: targets.length, truncated, ok, failed, elapsed: Date.now() - started }
}

export function formatResult(res) {
  if (res?.error) return res.error
  const both = res.ok.filter(x => x.hadal && x.deadly).length
  const partial = res.ok.filter(x => x.partial).length
  const lines = [
    `挑战记录更新完成（${res.scopeText}）`,
    `成功 ${res.ok.length} / ${res.total}（式舆+危局齐全 ${both}），耗时 ${Math.round(res.elapsed / 1000)} 秒`,
  ]
  if (res.truncated) lines.push('（已达单次上限，剩余部分请再次执行）')
  if (partial) lines.push(`${partial} 个只有部分数据（某项未开放/未挑战）`)
  if (res.failed.length) {
    lines.push('', '失败：')
    for (const f of res.failed.slice(0, 8)) lines.push(`  ${f.uid}：${f.reason}`)
    if (res.failed.length > 8) lines.push(`  ……另有 ${res.failed.length - 8} 个`)
  }
  return lines.join('\n')
}
