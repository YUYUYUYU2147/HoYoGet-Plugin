// 绝区零面板右栏用的工坊数据（配队推荐 / 驱动盘排名）
//
// 数据源 https://api.zzzmap.com（绝区零工坊），与 apps/zzz_workshop.js 同一套接口：
//   GET /api/v1/game_role/list      角色表：中文名 → item_id，并带 yituliu_json.team_recommends
//   GET /api/v1/user_relic/ranking  单角色驱动盘总分排行（type=role，60/50/40 级三档）
// 配队直接用角色表里的推荐队伍，不用额外请求；排名失败只影响这一块，面板本体照常出图。

import { ZZZ_HOST, request } from './workshop_api.js'

const CACHE_TTL = 6 * 3600 * 1000
const cache = { roles: null, rolesAt: 0 }

const fresh = at => at && Date.now() - at < CACHE_TTL

async function zzzRoles() {
  if (cache.roles && fresh(cache.rolesAt)) return cache.roles
  const data = await request('/api/v1/game_role/list', {}, ZZZ_HOST)
  cache.roles = Array.isArray(data?.rows) ? data.rows : []
  cache.rolesAt = Date.now()
  return cache.roles
}

/** 角色头像：工坊角色表的 avatar 是方形小图，直接当队伍成员图标 */
function faceOf(row) {
  return row?.avatar || row?.avatar2 || ''
}

/**
 * 推荐配队：工坊给每个角色 3~4 套队伍，成员只写名字，
 * 这里按名字回角色表取头像，取不到的只显示文字。
 */
function buildTeams(role, rows) {
  const byName = new Map()
  for (const row of rows) {
    if (row?.nick_name) byName.set(row.nick_name, row)
    if (row?.short_name) byName.set(row.short_name, row)
  }
  const teams = Array.isArray(role?.yituliu_json?.team_recommends) ? role.yituliu_json.team_recommends : []
  return teams
    .slice(0, 3)
    .map(team => ({
      title: team?.title || '推荐配队',
      members: (Array.isArray(team?.role) ? team.role : [])
        .map(member => {
          const name = String(member?.name || '').trim()
          const row = byName.get(name)
          return { name, icon: faceOf(row), on: name === role?.nick_name }
        })
        .filter(member => member.name),
      bangboo: (Array.isArray(team?.bangboo) ? team.bangboo : [])
        .map(item => String(item?.name || '').trim())
        .filter(Boolean)
        .join(' / '),
    }))
    .filter(team => team.members.length)
}

/**
 * 面板右栏数据。
 * @param {object} opts
 * @param {string} opts.name  角色中文名（与工坊 nick_name 一致）
 * @param {string} opts.uid   当前查询的 UID，用于标出「我」的名次
 * @param {number} opts.level 角色等级，用于选 60 / 50 / 40 级榜单
 * @returns {Promise<null|{rank: object|null, teams: object[]}>}
 */
export async function zzzPanelExtras({ name, uid = '', level = 0 } = {}) {
  try {
    const keyword = String(name || '').trim()
    if (!keyword) return null
    const rows = await zzzRoles()
    const role = rows.find(row => row?.nick_name === keyword)
      || rows.find(row => (row?.nick_name || '').includes(keyword))
    if (!role?.item_id) return null

    const lv = Number(level) >= 55 ? 60 : Number(level) >= 45 ? 50 : 40
    const [rankData, teams] = await Promise.all([
      request('/api/v1/user_relic/ranking', {
        limit: 50,
        offset: 0,
        type: 'role',
        role_id: role.item_id,
        role_level: lv,
        role_rank: null,
        part_index: null,
        weapon_id: null,
      }, ZZZ_HOST).catch(() => null),
      Promise.resolve(buildTeams(role, rows)),
    ])

    const allRows = Array.isArray(rankData?.rows) ? rankData.rows : []
    const myIndex = uid ? allRows.findIndex(row => String(row?.uid ?? '') === String(uid)) : -1
    const rankRows = allRows.slice(0, 3).map((row, index) => ({
      rank: index + 1,
      nickname: row?.user_case?.nick_name || String(row?.uid ?? '') || '未知',
      consText: Number(row?.rank) ? `影画${Number(row.rank)}` : '',
      pointText: (Number(row?.relic_point) || 0).toFixed(1),
      mine: String(row?.uid ?? '') === String(uid),
    }))
    const mine = myIndex >= 0
      ? { rank: myIndex + 1, pointText: (Number(allRows[myIndex]?.relic_point) || 0).toFixed(1) }
      : null

    if (!rankRows.length && !teams.length) return null
    return {
      rank: rankRows.length ? { level: lv, rows: rankRows, mine, scanned: allRows.length } : null,
      teams,
    }
  } catch (err) {
    try {
      if (typeof logger !== 'undefined') logger.debug?.(`[HoYoGet][zzz_panel] 绝区零工坊数据获取失败：${err?.message || err}`)
    } catch (_) { /* 忽略日志异常 */ }
    return null
  }
}
