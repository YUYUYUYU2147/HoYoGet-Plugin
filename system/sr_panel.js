// 星铁面板右栏用的工坊数据（遗器排名 / 队伍配队）
//
// Akasha 只有原神榜单，星铁面板右侧原本空着。这里直接取星穹铁道工坊的公开接口：
//   GET /api/v1/game_role/list      角色表（中文名 → item_id）
//   GET /api/v1/user_relic/ranking  单角色遗器总分排行（type=role）
//   GET /api/v1/team_system/list    队伍体系推荐（按成员名筛出含该角色的队伍）
// 接口失败一律返回 null / 空数组，面板本体不受影响。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SR_HOST, request } from './workshop_api.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIAO_ROOTS = [
  path.join(PLUGIN_ROOT, 'resources'),
  path.join(PLUGIN_ROOT, '..', 'miao-plugin', 'resources'),
]
const CACHE_TTL = 6 * 3600 * 1000

const cache = { roles: null, rolesAt: 0, teams: null, teamsAt: 0 }

const fresh = at => at && Date.now() - at < CACHE_TTL

async function srRoles() {
  if (cache.roles && fresh(cache.rolesAt)) return cache.roles
  const data = await request('/api/v1/game_role/list', { limit: 500 }, SR_HOST)
  cache.roles = Array.isArray(data?.rows) ? data.rows : []
  cache.rolesAt = Date.now()
  return cache.roles
}

async function srTeams() {
  if (cache.teams && fresh(cache.teamsAt)) return cache.teams
  const data = await request('/api/v1/team_system/list', {}, SR_HOST)
  cache.teams = Array.isArray(data?.rows) ? data.rows : []
  cache.teamsAt = Date.now()
  return cache.teams
}

/** 角色头像：meta-sr 里按角色名存放，返回相对 _miao_path 的路径 */
let _faceDirs = null
function faceDirMap() {
  if (_faceDirs) return _faceDirs
  const map = new Map()
  for (const root of MIAO_ROOTS) {
    try {
      for (const dir of fs.readdirSync(path.join(root, 'meta-sr', 'character'))) {
        map.set(dir.replace(/[·•・\s「」『』]/g, ''), dir)
      }
    } catch (_) { /* 继续下一个根 */ }
  }
  _faceDirs = map
  return map
}
function srFace(name) {
  const clean = String(name || '').trim()
  if (!clean) return ''
  /* 工坊写「开拓者·记忆」，miao 按性别分成「星·记忆 / 穹·记忆」 */
  const candidates = [clean, clean.replace(/^开拓者/, '星'), clean.replace(/^开拓者/, '穹')]
  if (/记忆主|开拓者/.test(clean)) candidates.push('星·记忆', '穹·记忆')
  const norm = s => s.replace(/[·•・\s「」『』]/g, '')
  for (const candidate of candidates) {
    const dir = faceDirMap().get(norm(candidate)) || candidate
    const rel = `meta-sr/character/${dir}/imgs/face.webp`
    for (const root of MIAO_ROOTS) {
      try {
        if (fs.existsSync(path.join(root, rel))) return rel
      } catch (_) { /* 继续 */ }
    }
  }
  return ''
}

function starText(level) {
  const num = Math.max(0, Math.min(5, Number(level) || 0))
  return '★'.repeat(num)
}

/** 排行榜只给昵称，UID 打码后仅用于区分同名玩家 */
function maskUid(uid) {
  const text = String(uid || '')
  if (text.length < 5) return text
  return `${text.slice(0, 2)}${'*'.repeat(text.length - 3)}${text.slice(-1)}`
}

/**
 * 面板右栏数据。
 * @param {object} opts
 * @param {string} opts.name   角色中文名（与工坊 nick_name 一致）
 * @param {number} opts.level  角色等级，用于选 80 / 70 / 60 档榜单
 * @returns {Promise<null|{rank: object|null, teams: object[]}>}
 */
export async function srPanelExtras({ name, level = 0 } = {}) {
  try {
    const keyword = String(name || '').trim()
    if (!keyword) return null
    const rows = await srRoles()
    const role = rows.find(row => row?.nick_name === keyword)
      || rows.find(row => (row?.nick_name || '').includes(keyword))
    if (!role?.item_id) return null

    const lv = Number(level) >= 80 ? 80 : Number(level) >= 70 ? 70 : 60
    const [rankData, teams] = await Promise.all([
      request('/api/v1/user_relic/ranking', {
        limit: 50,
        offset: 0,
        type: 'role',
        role_id: role.item_id,
        role_level: lv,
        /* 星铁「不限星魂」必须是空串，传 -1 或省略都返回 0 条 */
        role_rank: '',
        part_index: null,
        weapon_id: null,
      }, SR_HOST).catch(() => null),
      srTeams().catch(() => []),
    ])

    const rankRows = (Array.isArray(rankData?.rows) ? rankData.rows : [])
      .slice(0, 5)
      .map((row, index) => {
        const uid = String(row?.uid || '')
        return {
          rank: index + 1,
          nickname: row?.user_case?.nick_name || maskUid(uid) || '未知',
          consText: row?.rank != null ? `${row.rank}魂` : '',
          pointText: (Number(row?.relic_point) || 0).toFixed(1),
        }
      })

    const teamRows = (Array.isArray(teams) ? teams : [])
      .filter(row => {
        const names = String(row?.team_member_names || '').split(',')
        return names.includes(role.nick_name)
      })
      .sort((a, b) => (Number(b?.level) || 0) - (Number(a?.level) || 0))
      .slice(0, 3)
      .map(row => ({
        name: row?.team_name || '未命名队伍',
        stars: starText(row?.level),
        members: String(row?.team_member_names || '')
          .split(',')
          .filter(Boolean)
          .map(member => ({
            name: member,
            face: srFace(member),
            on: member === role.nick_name,
          })),
      }))
      .filter(row => row.members.length)

    if (!rankRows.length && !teamRows.length) return null
    return {
      rank: rankRows.length ? { level: lv, rows: rankRows } : null,
      teams: teamRows,
    }
  } catch (err) {
    try {
      if (typeof logger !== 'undefined') logger.debug?.(`[HoYoGet][hoyo_panel] 星铁工坊数据获取失败：${err?.message || err}`)
    } catch (_) { /* 忽略日志异常 */ }
    return null
  }
}
