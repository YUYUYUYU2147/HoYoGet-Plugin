/**
 * 签到记录（游戏签到 + 米游社社区签到）。
 *
 * 目的：锅巴里能查看最近的签到结果，不用翻日志。
 * 存储：data/sign_history.json，按时间倒序，只保留最近 30 天 / 最多 4000 条。
 * 只记录 qq、昵称、游戏、UID、状态与一句提示，不含任何 cookie/stoken。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'data', 'sign_history.json')
const MAX_RECORDS = 4000
const KEEP_DAYS = 30

/** 状态归一：把各处的文案收成三种，方便前端上色 */
export function statusOf(tip = '') {
  const t = String(tip)
  if (/今日已签/.test(t)) return 'signed'
  if (/签到成功|成功/.test(t)) return 'ok'
  return 'fail'
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(raw?.records) ? raw : { records: [] }
  } catch {
    return { records: [] }
  }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data))
  } catch (err) {
    logger.debug?.(`[HoYoGet][sign_history] 写入失败：${err?.message || err}`)
  }
}

/**
 * 追加若干条记录。
 * @param {Array<{qq, name, game, uid, tip, at?}>} list
 */
export function appendSignRecords(list = []) {
  const rows = (Array.isArray(list) ? list : [list]).filter(Boolean)
  if (!rows.length) return
  const data = load()
  const now = Date.now()
  for (const r of rows) {
    const at = Number(r.at) || now
    data.records.push({
      at,
      day: dayKey(at),
      qq: String(r.qq || ''),
      name: String(r.name || ''),
      game: String(r.game || ''),
      uid: String(r.uid || ''),
      tip: String(r.tip || ''),
      status: r.status || statusOf(r.tip),
    })
  }
  // 时间倒序 + 裁剪
  data.records.sort((a, b) => b.at - a.at)
  const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000
  data.records = data.records.filter(r => r.at >= cutoff).slice(0, MAX_RECORDS)
  data.updatedAt = now
  save(data)
}

/**
 * 读取记录。
 * @param {{limit?:number, qq?:string, game?:string, day?:string, days?:number}} opts
 */
export function readSignRecords(opts = {}) {
  const data = load()
  let list = data.records
  if (opts.qq) list = list.filter(r => String(r.qq) === String(opts.qq))
  if (opts.game) list = list.filter(r => r.game === opts.game)
  if (opts.day) list = list.filter(r => r.day === opts.day)
  if (opts.days) {
    const cutoff = Date.now() - Number(opts.days) * 24 * 3600 * 1000
    list = list.filter(r => r.at >= cutoff)
  }
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, MAX_RECORDS))
  return {
    updatedAt: data.updatedAt || 0,
    total: list.length,
    records: list.slice(0, limit),
  }
}

export default { appendSignRecords, readSignRecords, statusOf }
