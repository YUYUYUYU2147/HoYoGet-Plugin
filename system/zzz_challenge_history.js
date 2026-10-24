/**
 * 绝区零挑战（式舆防卫战 / 危局强袭战）历史记录落盘与读取。
 *
 * 米游社 record 接口只返回当期 / 上一期（schedule_type 0/1），
 * 没有「所有历史期次」的接口。所以「往期」靠本插件每次查询时落盘累积：
 * 每次查询挑战，把归一化结果连同期次标识存进
 *   data/zzz_challenge/records/<uid>/<type>/<periodKey>.json
 * 往期命令再列出这些文件，按需读取。
 *
 * type：shiyu = 式舆防卫战，deadly = 危局强袭战。
 * periodKey：期次标识，优先用原始时间戳（hadal_begin_time），没有则用日期串。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.join(PLUGIN_ROOT, 'data', 'zzz_challenge', 'records')

/** 期次 key：时间戳优先，回退日期串 */
export function periodKeyOf(period) {
  return String(period || '').trim().replace(/[\\/:*?"<>|]/g, '_') || '未知期次'
}

function dirOf(uid, type) {
  const safe = String(uid || '').replace(/[^\d]/g, '')
  return path.join(ROOT, safe, type)
}

/** 落盘一份挑战记录（幂等：同 uid+type+期次覆盖） */
export function saveChallengeRecord(uid, type, period, data) {
  try {
    const dir = dirOf(uid, type)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${periodKeyOf(period)}.json`)
    fs.writeFileSync(file, JSON.stringify({
      uid, type, period,
      savedAt: new Date().toISOString(),
      data,
    }, null, 2))
    return true
  } catch (err) {
    logger?.warn?.(`[HoYoGet][zzz_challenge] 挑战记录落盘失败：${err?.message || err}`)
    return false
  }
}

/** 列出某 uid+type 的所有历史期次（按时间倒序） */
export function listChallengeRecords(uid, type) {
  try {
    const dir = dirOf(uid, type)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
          return { period: o.period, savedAt: o.savedAt, file: f }
        } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.period).localeCompare(String(a.period)))
  } catch {
    return []
  }
}

/** 列出某 type 下每个 uid 的最新一期记录（排行榜用） */
export function listLatestRecords(type) {
  const out = []
  try {
    if (!fs.existsSync(ROOT)) return out
    for (const uid of fs.readdirSync(ROOT)) {
      const dir = path.join(ROOT, uid, type)
      if (!fs.existsSync(dir)) continue
      let latest = null
      for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
        try {
          const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
          if (!o || !o.data) continue
          if (!latest || String(o.period).localeCompare(String(latest.period)) > 0) latest = o
        } catch { /* 单个文件坏了不影响整体 */ }
      }
      if (!latest) continue
      out.push({ uid: latest.uid || uid, period: latest.period, savedAt: latest.savedAt, data: latest.data })
    }
  } catch { /* 目录不可读时返回空列表 */ }
  return out
}

/** 读取某 uid+type 的某期记录（按列表下标） */
export function readChallengeRecord(uid, type, index) {
  const list = listChallengeRecords(uid, type)
  const item = list[Number(index)]
  if (!item) return null
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dirOf(uid, type), item.file), 'utf-8'))
    return o
  } catch {
    return null
  }
}

export default { saveChallengeRecord, listChallengeRecords, readChallengeRecord, periodKeyOf, listLatestRecords }
