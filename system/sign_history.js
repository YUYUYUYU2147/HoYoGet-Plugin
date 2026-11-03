/**
 * 签到记录（游戏签到 + 米游社社区签到）。
 *
 * 早期实现单独存 data/sign_history.json；现在统一由 system/task_history.js
 * 管理（data/task_history.json），这里保留原来的函数名做薄封装，避免各处
 * 调用点与锅巴接口跟着改。
 */
import { appendTaskRecords, readTaskRecords, statusOf } from './task_history.js'

export { statusOf }

/**
 * 追加签到记录。
 * @param {Array<{qq, name, game, uid, tip, task?, source?, at?}>} list
 */
export function appendSignRecords(list = []) {
  const rows = (Array.isArray(list) ? list : [list]).filter(Boolean)
  if (!rows.length) return
  appendTaskRecords(rows.map(r => ({
    ...r,
    // 社区签到的 game 形如「米游社·原神」，归到 bbs_sign；其余算游戏签到
    task: r.task || (/^米游社/.test(String(r.game || '')) ? 'bbs_sign' : 'sign'),
  })))
}

/**
 * 读取签到记录（只含 sign / bbs_sign 两类）。
 * @param {{limit?, qq?, game?, day?, days?, task?}} opts
 */
export function readSignRecords(opts = {}) {
  if (opts.task) return readTaskRecords(opts)
  const all = readTaskRecords({ ...opts, task: '' })
  const list = all.records.filter(r => r.task === 'sign' || r.task === 'bbs_sign')
  const game = String(opts.game || '')
  const filtered = game ? list.filter(r => r.game === game) : list
  const limit = Math.max(1, Math.min(Number(opts.limit) || 200, 6000))
  return {
    updatedAt: all.updatedAt,
    total: filtered.length,
    records: filtered.slice(0, limit),
  }
}

export default { appendSignRecords, readSignRecords, statusOf }
