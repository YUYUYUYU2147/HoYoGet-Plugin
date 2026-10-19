/**
 * 面板排名的「范围」共享状态。
 *
 * 两个模块都要用它：
 *   · apps/zzz_rank.js    本地面板排名（本群 / 全部已保存记录）
 *   · apps/zzz_workshop.js 工坊练度排名（本群 / 工坊全服）
 * 抽成独立模块避免各存一份、切换后两边不同步。
 *
 * 注意：内存变量，重启回到默认的「本群」，与之前行为一致。
 */
let scope = 'group'

export function setRankScope(next) {
  scope = next === 'all' ? 'all' : 'group'
  return scope
}

export function getRankScope() {
  return scope
}

export function scopeLabel(value = scope) {
  return value === 'all' ? '全部' : '本群'
}

export default { setRankScope, getRankScope, scopeLabel }
