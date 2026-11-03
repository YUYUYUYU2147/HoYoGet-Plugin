/**
 * 任务执行记录（签到 / 体力推送 / 抽卡更新 / 面板生成 …）。
 *
 * 目的：锅巴里能查看各功能最近执行了什么、成功还是失败，不用翻日志。
 * 存储：data/task_history.json，按时间倒序，只保留最近 30 天 / 最多 6000 条。
 * 只记录任务名、QQ、昵称、目标（游戏/UID）、结果与一句提示，
 * **不含任何 cookie / stoken / 面板数据**。
 *
 * 记录结构：
 *   {
 *     at: 时间戳,
 *     day: 'YYYY-MM-DD',
 *     task: 'sign' | 'bbs_sign' | 'stamina' | 'gacha' | 'panel' | ...
 *     taskName: 中文名（锅巴筛选用）,
 *     source: 'manual' | 'cron' | 'event'（手动 / 定时 / 事件触发）,
 *     qq, name,
 *     game, uid,
 *     tip, status: 'ok' | 'signed' | 'fail' | 'skip'
 *   }
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = path.join(ROOT, 'data', 'task_history.json')
const MAX_RECORDS = 6000
const KEEP_DAYS = 30

/** 任务类型 → 中文名（锅巴下拉用） */
export const TASK_NAMES = {
  sign: '游戏签到',
  bbs_sign: '社区签到',
  stamina: '体力推送',
  gacha: '抽卡更新',
  panel: '面板生成',
  cron: '定时任务',
}

const STATUS_NAMES = { ok: '成功', signed: '已完成', fail: '失败', skip: '跳过' }
export { STATUS_NAMES }

/** 状态归一：把各处的文案收成四种，方便前端上色 */
export function statusOf(tip = '', fallback = 'fail') {
  const t = String(tip)
  if (/今日已签|已签到|已完成|今日已领/.test(t)) return 'signed'
  if (/跳过|未达阈值|无需/.test(t)) return 'skip'
  if (/成功|完成|已推送|已生成|已同步|更新 \d+ 条|更新\d+条/.test(t)) return 'ok'
  if (/失败|异常|错误|无效/.test(t)) return 'fail'
  return fallback
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
    logger.debug?.(`[HoYoGet][task_history] 写入失败：${err?.message || err}`)
  }
}

/**
 * 追加若干条记录。
 * @param {Array<{task, taskName?, source?, qq?, name?, game?, uid?, tip?, status?, at?}>} list
 */
export function appendTaskRecords(list = []) {
  const rows = (Array.isArray(list) ? list : [list]).filter(Boolean)
  if (!rows.length) return
  const data = load()
  const now = Date.now()
  for (const r of rows) {
    const at = Number(r.at) || now
    const task = String(r.task || 'other')
    data.records.push({
      at,
      day: dayKey(at),
      task,
      taskName: String(r.taskName || TASK_NAMES[task] || task),
      source: String(r.source || 'manual'),
      qq: String(r.qq || ''),
      name: String(r.name || ''),
      game: String(r.game || ''),
      uid: String(r.uid || ''),
      tip: String(r.tip || ''),
      status: r.status || statusOf(r.tip),
    })
  }
  data.records.sort((a, b) => b.at - a.at)
  const cutoff = now - KEEP_DAYS * 24 * 3600 * 1000
  data.records = data.records.filter(r => r.at >= cutoff).slice(0, MAX_RECORDS)
  data.updatedAt = now
  save(data)
}

/**
 * 读取记录。
 * @param {{limit?:number, qq?:string, game?:string, task?:string, taskPrefix?:string,
 *          day?:string, days?:number, status?:string}} opts
 */
export function readTaskRecords(opts = {}) {
  const data = load()
  let list = data.records
  const eq = (v, t) => String(v) === String(t)
  if (opts.qq) list = list.filter(r => eq(r.qq, opts.qq))
  if (opts.task) list = list.filter(r => eq(r.task, opts.task))
  if (opts.taskPrefix) list = list.filter(r => String(r.task).startsWith(String(opts.taskPrefix)))
  if (opts.game) list = list.filter(r => eq(r.game, opts.game))
  if (opts.status) list = list.filter(r => eq(r.status, opts.status))
  if (opts.day) list = list.filter(r => eq(r.day, opts.day))
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

/** 汇总：各任务今天/最近的成功失败数，锅巴顶部卡片用 */
export function summarizeTaskRecords({ days = 1 } = {}) {
  const { records } = readTaskRecords({ limit: MAX_RECORDS, days })
  const out = {}
  for (const r of records) {
    const k = r.task
    out[k] = out[k] || { task: k, taskName: r.taskName, ok: 0, signed: 0, fail: 0, skip: 0, total: 0 }
    out[k].total++
    if (out[k][r.status] != null) out[k][r.status]++
  }
  return Object.values(out).sort((a, b) => b.total - a.total)
}

/**
 * 包一层定时任务：记录开始/结束（含耗时与结果），异常原文入 tip。
 * 用法：
 *   await runCronTask('签到', () => scheduled_sign())
 * 返回 fn 的结果；异常会照常抛出（不吞掉既有错误处理）。
 *
 * @param {string} label 任务中文名（显示在记录里）
 * @param {Function} fn 实际执行体
 * @param {{qq?:string, game?:string, uid?:string}} [meta]
 */
export async function runCronTask(label, fn, meta = {}) {
  const started = Date.now()
  try {
    const ret = await fn()
    const ms = Date.now() - started
    // 返回 false 的定时任务通常是「条件不满足，跳过」，与失败区分开
    const skipped = ret === false || ret == null
    appendTaskRecords([{
      task: 'cron',
      taskName: `${label}`,
      source: 'cron',
      qq: meta.qq || '',
      game: meta.game || '',
      uid: meta.uid || '',
      tip: `${skipped ? '跳过（条件不满足）' : '执行完成'} · ${ms}ms`,
      status: skipped ? 'skip' : 'ok',
    }])
    return ret
  } catch (err) {
    appendTaskRecords([{
      task: 'cron',
      taskName: `${label}`,
      source: 'cron',
      qq: meta.qq || '',
      game: meta.game || '',
      uid: meta.uid || '',
      tip: `执行异常：${String(err?.message || err).slice(0, 160)}`,
      status: 'fail',
    }])
    throw err
  }
}

export default { appendTaskRecords, readTaskRecords, summarizeTaskRecords, statusOf, runCronTask, TASK_NAMES }
