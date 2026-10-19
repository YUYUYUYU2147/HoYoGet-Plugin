// 绝区零工坊榜单
//
// 数据源：https://api.zzzmap.com（绝区零工坊小程序后端）
// 接口来源：由小程序包 wx06433d7f9d17db8b 解包后从 app-service.js 提取，
//          签名算法与参数见 HANDOFF_2026-10-19.md 附二/附三。
// 接口：
//   GET /api/v1/love/ranking                      角色好感度 / 强度评分榜（官方标注每 2 小时更新）
//   GET /api/v1/role/grad_stat?item_id=&level=40   单角色全服配装（音擎 / 驱动盘使用率）
//   GET /api/v1/card_ranking/ranking_v5            抽卡欧非排行（分页，每页固定 50 条）
//   GET /api/v1/abyss/stats + /api/v1/abyss/result 式舆防卫战角色使用率（数据已停更，仅存档查询）
//   GET /api/v1/game_role/list、/api/v1/weapon/list、/api/v1/relic/list  名称映射用
//   POST /api/v1/user_role/ranking                 单玩家练度详情（需要签名头）
//
// 说明：接口随时可能调整或关闭，失败时只回提示，不抛出未捕获异常。

import { createHash } from 'node:crypto'

import fs from 'node:fs'
import path from 'node:path'
import { pluginPriority, render } from '#HoYoGet'
import {
  buildBasicProperties,
  calcDamage as calcPanelDamage,
} from './zzz_panel_list.js'
import { getRankScope } from '../system/rank_scope.js'

const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

/**
 * 取群成员绑定的绝区零 UID。
 * 与 apps/zzz_rank.js 同一套逻辑：读 Users.games 的 zzz.uid。
 * 拿不到成员列表或数据库时返回 null，由调用方回落成「不限范围」。
 */
async function getGroupMemberUids(e) {
  const memberSet = new Set()
  try {
    if (e?.group?.getMemberMap) {
      const map = await e.group.getMemberMap()
      for (const qq of map.keys()) memberSet.add(String(qq))
    } else if (e?.group?.members) {
      for (const qq of Object.keys(e.group.members)) memberSet.add(String(qq))
    }
  } catch (_) {}
  if (!memberSet.size || !fs.existsSync(YUNZAI_DB)) return null
  try {
    const sqlite3 = (await import('sqlite3')).default
    const rows = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve([]) : null))
      db.all('select id, games from Users', (err2, list) => {
        db.close(() => {})
        resolve(err2 ? [] : list || [])
      })
    })
    const result = new Set()
    for (const row of rows) {
      if (!memberSet.has(String(row.id))) continue
      try {
        const uid = String(JSON.parse(row.games || '{}')?.zzz?.uid || '').trim()
        if (/^\d{8,9}$/.test(uid)) result.add(uid)
      } catch (_) {}
    }
    return result
  } catch (_) {
    return null
  }
}

const API_HOST = 'https://api.zzzmap.com'
const REQUEST_TIMEOUT = 12000
const CACHE_TTL = 6 * 3600 * 1000

// POST 接口签名：小程序请求库把参数按 k=v 排序拼接后取 MD5，键尾固定追加该串
const SIGN_KEY = 'VW^)(^*^$$#*%(#)!@VIAI%'
const APP_VERSION = '100'

const CARD_TYPES = {
  综合: 'all',
  角色: 'role_avg_up',
  角色池: 'role_avg_up',
  音擎: 'guang_avg_up',
  音擎池: 'guang_avg_up',
  常驻: 'common',
  常驻池: 'common',
  up: 'up',
  连up: 'up',
  连歪: 'wai',
  wai: 'wai',
}
const CARD_SORTS = { 欧: 'ou', 非: 'fei', 氪: 'ke' }
const CARD_TYPE_LABEL = {
  all: '综合',
  role_avg_up: '角色池',
  guang_avg_up: '音擎池',
  common: '常驻池',
  up: '最多连 UP',
  wai: '最多连歪',
}
const CARD_SORT_LABEL = { ou: '欧', fei: '非', ke: '氪' }

// 指令正则：规则表与参数提取共用，避免两处写法不一致
const RE_LOVE = /^[#%]*(?:米哈游)?(?:绝区零|zzz)(?:角色)?(?:评分|好感)(?:榜|排行)(?:\s+(.+))?$/i
const RE_GRAD = /^[#%]*(?:米哈游)?(?:绝区零|zzz)(?:角色)?配装(?:统计)?(?:\s+(.+))?$/i
const RE_CARD = /^[#%]*(?:米哈游)?(?:绝区零|zzz)(?:抽卡|欧非)(?:榜|排行)(?:\s+(.+))?$/i
const RE_ABYSS = /^[#%]*(?:米哈游)?(?:绝区零|zzz)式舆(?:使用率|排名|排行)$/i
const RE_ROLE_RANK = /^[#%]*(?:米哈游)?(?:绝区零|zzz)(?:角色)?(?:练度)?排名(?:\s+(.+))?$/i
const RE_DETAIL = /^[#%]*(?:米哈游)?(?:绝区零|zzz)(?:查)?练度(?:\s+(.+))?$/i
const RE_HELP = /^[#%]*(?:米哈游)?(?:绝区零|zzz)榜单帮助$/i

// ===== 通用请求 =====

async function request(pathname, query = {}) {
  const url = new URL(API_HOST + pathname)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const run = async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (Number(json?.code) !== 0) throw new Error(json?.message || `接口返回 code=${json?.code}`)
    return json.data
  }
  try {
    return await run()
  } catch (err) {
    // 单次重试：工坊接口偶发抖动，重试一次可覆盖大部分瞬时失败
    if (err?.name === 'TimeoutError' || err?.name === 'TypeError' || /HTTP 5\d\d/.test(err?.message || '')) {
      return await run()
    }
    throw err
  }
}

/**
 * POST 接口需要签名头：sign = MD5(排序后的 "k=v" 串)，键尾追加 SIGN_KEY。
 * 规则来自小程序请求库：去掉 null、对象值 JSON.stringify、按整串排序。
 */
function signOf(params) {
  const merged = { ...params, key: SIGN_KEY }
  const pairs = Object.entries(merged).map(([key, value]) => {
    const text = typeof value === 'object' ? JSON.stringify(value) : value
    return `${key}=${text ?? ''}`
  })
  return createHash('md5').update(pairs.join('&').split('&').sort().join('&')).digest('hex')
}

async function signedPost(pathname, params) {
  const body = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) body[key] = value
  }
  const run = async () => {
    const res = await fetch(new URL(pathname, API_HOST), {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        version: APP_VERSION,
        platform: 'weixin',
        sign: signOf(params),
        time: String(Date.now()),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (Number(json?.code) !== 0) throw new Error(json?.message || `接口返回 code=${json?.code}`)
    return json.data
  }
  try {
    return await run()
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'TypeError' || /HTTP 5\d\d/.test(err?.message || '')) {
      return await run()
    }
    throw err
  }
}

// ===== 名称缓存 =====

const cache = { roles: null, rolesAt: 0, weapons: null, weaponsAt: 0, relics: null, relicsAt: 0 }

function fresh(at) {
  return at && Date.now() - at < CACHE_TTL
}

async function getRoles() {
  if (cache.roles && fresh(cache.rolesAt)) return cache.roles
  const data = await request('/api/v1/game_role/list')
  const rows = Array.isArray(data?.rows) ? data.rows : []
  cache.roles = rows
  cache.rolesAt = Date.now()
  return rows
}

async function getWeapons() {
  if (cache.weapons && fresh(cache.weaponsAt)) return cache.weapons
  const data = await request('/api/v1/weapon/list', { limit: 500 })
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const map = new Map()
  for (const row of rows) {
    const id = String(row?.weapon_id ?? row?.item_id ?? '')
    const name = row?.nick_name || row?.name || ''
    if (id && name) map.set(id, name)
    if (row?.item_id && name) map.set(String(row.item_id), name)
  }
  cache.weapons = map
  cache.weaponsAt = Date.now()
  return map
}

async function getRelics() {
  if (cache.relics && fresh(cache.relicsAt)) return cache.relics
  const data = await request('/api/v1/relic/list', { limit: 500 })
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const map = new Map()
  for (const row of rows) {
    const id = String(row?.set_id ?? '')
    const name = row?.name_simple || row?.name || ''
    if (id && name) map.set(id, name)
  }
  cache.relics = map
  cache.relicsAt = Date.now()
  return map
}

async function resolveRole(input) {
  const keyword = String(input || '').trim()
  if (!keyword) return null
  const rows = await getRoles()
  const exact = rows.find(r => (r?.nick_name || '') === keyword || (r?.short_name || '') === keyword)
  if (exact) return exact
  const fuzzy = rows.find(r => {
    const name = r?.nick_name || ''
    return name.includes(keyword) || (r?.short_name || '').includes(keyword) || (r?.en_name || '').toLowerCase() === keyword.toLowerCase()
  })
  return fuzzy || null
}

// ===== 输出格式 =====

const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/

function textWidth(text) {
  let used = 0
  for (const ch of String(text ?? '')) used += WIDE_CHAR.test(ch) ? 2 : 1
  return used
}

/** 按终端宽度补齐：中日韩字符按 2 列计算 */
function pad(text, width) {
  const value = String(text ?? '')
  return value + ' '.repeat(Math.max(0, width - textWidth(value)))
}

/** 超宽时截断并补省略号，保证多行输出仍然对齐 */
function fit(text, width) {
  const value = String(text ?? '')
  if (textWidth(value) <= width) return pad(value, width)
  let out = ''
  let used = 0
  for (const ch of value) {
    const w = WIDE_CHAR.test(ch) ? 2 : 1
    if (used + w > width - 1) break
    out += ch
    used += w
  }
  return out + '…' + ' '.repeat(Math.max(0, width - used - 1))
}

function percent(value, total) {
  if (!total) return '0.0%'
  return `${(Number(value) / Number(total) * 100).toFixed(1)}%`
}

function ratio(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0.0%'
  return `${(num * 100).toFixed(1)}%`
}

/** 伤害数字：>=1 万用「万」 */
function formatNum(v) {
  const n = Number(v) || 0
  if (!n) return '-'
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return String(Math.round(n))
}

function countText(value) {
  const num = Number(value) || 0
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`
  return String(num)
}

function limitOf(text, fallback = 10, max = 30) {
  const num = Number.parseInt(String(text || '').match(/\d+/)?.[0] || '', 10)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.min(num, max)
}

function formatTime(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad2 = num => String(num).padStart(2, '0')
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function logError(tag, err) {
  const message = `[ZZZRank][${tag}] ${err?.message || err}`
  try { if (typeof logger !== 'undefined') logger.mark(message) } catch { /* 忽略日志异常 */ }
}

// ===== 榜单实现 =====

async function buildLoveRank(arg) {
  const text = String(arg || '')
  const byStrength = /强度/.test(text)
  const count = limitOf(text, 10, 30)
  const data = await request('/api/v1/love/ranking')
  const list = Array.isArray(data?.datas) ? [...data.datas] : []
  if (!list.length) throw new Error('榜单暂无数据')
  const field = byStrength ? 'score_strength_avg' : 'score_love_avg'
  list.sort((a, b) => Number(b?.[field] || 0) - Number(a?.[field] || 0))
  const version = data?.version || '-'
  const lines = [
    `绝区零工坊 · 角色${byStrength ? '强度' : '好感'}评分榜`,
    `版本 ${version}｜官方标注每 2 小时更新｜显示前 ${Math.min(count, list.length)} 名`,
    '',
  ]
  list.slice(0, count).forEach((item, index) => {
    const name = item?.role?.nick_name || item?.role?.item_id || '未知'
    const love = Number(item?.score_love_avg || 0).toFixed(1)
    const strength = Number(item?.score_strength_avg || 0).toFixed(1)
    const votes = Number(item?.vote_count || 0)
    lines.push(`${String(index + 1).padStart(2, '0')}. ${fit(name, 16)}好感 ${love}  强度 ${strength}  ${votes} 票`)
  })
  lines.push('', '发送【%绝区零评分榜 强度】可切换为强度排序')
  return lines.join('\n')
}

async function buildGradStat(arg) {
  const keyword = String(arg || '').trim()
  if (!keyword) {
    return '用法：%绝区零角色配装 <角色名>\n例：%绝区零角色配装 星见雅'
  }
  const role = await resolveRole(keyword)
  if (!role) {
    return `未找到角色「${keyword}」，可先用【%绝区零评分榜】查看角色名。`
  }
  const [data, weapons, relics] = await Promise.all([
    request('/api/v1/role/grad_stat', { item_id: role.item_id, level: 40 }),
    getWeapons(),
    getRelics(),
  ])
  const weaponStat = Array.isArray(data?.weapon_stat) ? [...data.weapon_stat] : []
  const relicStat = Array.isArray(data?.relic_stat) ? [...data.relic_stat] : []
  if (!weaponStat.length && !relicStat.length) {
    throw new Error(`「${role.nick_name}」暂无配装样本`)
  }
  const weaponTotal = weaponStat.reduce((sum, item) => sum + Number(item?.weapon_count || 0), 0)
  const relicTotal = relicStat.reduce((sum, item) => sum + Number(item?.set_info_count || 0), 0)

  const lines = [`绝区零工坊 · ${role.nick_name} 全服配装（Lv40 样本）`, '']
  lines.push('音擎使用率：')
  weaponStat
    .sort((a, b) => Number(b?.weapon_count || 0) - Number(a?.weapon_count || 0))
    .slice(0, 5)
    .forEach((item, index) => {
      const weaponId = String(item?.weapon_id ?? '')
      const name = weaponId === 'other' ? '其他音擎' : (weapons.get(weaponId) || `音擎${weaponId}`)
      lines.push(`  ${index + 1}. ${fit(name, 18)}${countText(item?.weapon_count)}份（${percent(item?.weapon_count, weaponTotal)}）`)
    })

  const relicRows = relicStat
    .map(item => ({ raw: item, parts: parseSetInfo(item?.set_info), count: Number(item?.set_info_count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
  if (relicRows.length) {
    lines.push('', '驱动盘套装：')
    relicRows.forEach((row, index) => {
      const label = row.parts
        .filter(part => part.setId !== 'other')
        .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
        .join(' + ') || '其他散件'
      lines.push(`  ${index + 1}. ${fit(label, 30)}${countText(row.count)}份（${percent(row.count, relicTotal)}）`)
    })
  }
  lines.push('', '数据来源：绝区零工坊角色柜用户，样本为 40 级满级统计。')
  return lines.join('\n')
}

/** set_info 形如 "31000_2__32700_4"：前面是套装 ID，后面是件数 */
function parseSetInfo(raw) {
  const text = String(raw || '')
  if (!text) return []
  return text.split('__').map(part => {
    const [setId, count] = part.split('_')
    return { setId: String(setId || ''), count: Number(count) || 0 }
  }).filter(part => part.setId)
}

async function buildCardRank(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  let type = 'all'
  let sort = 'ou'
  let count = 10
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { count = limitOf(token, 10, 30); continue }
    if (CARD_SORTS[token]) { sort = CARD_SORTS[token]; continue }
    if (CARD_TYPES[token.toLowerCase()] || CARD_TYPES[token]) { type = CARD_TYPES[token] || CARD_TYPES[token.toLowerCase()]; continue }
  }
  // 分页固定 50 条，取一页足够覆盖默认显示条数
  const data = await request('/api/v1/card_ranking/ranking_v5', {
    limit: 50,
    offset: 0,
    ranking_type: type,
    sort,
  })
  const rows = Array.isArray(data?.rows) ? data.rows : []
  if (!rows.length) throw new Error('榜单暂无数据')
  const lines = [
    `绝区零工坊 · 抽卡欧非榜（${CARD_TYPE_LABEL[type] || type} / ${CARD_SORT_LABEL[sort] || sort}）`,
    `显示前 ${Math.min(count, rows.length)} 名｜UID 由工坊脱敏`,
    '',
  ]
  rows.slice(0, count).forEach((row, index) => {
    lines.push(
      `${String(index + 1).padStart(2, '0')}. ${pad(row?.uid || '未知', 12)}` +
      `抽数 ${pad(row?.draw_total ?? 0, 6)}五星 ${pad(row?.five_total ?? 0, 4)}` +
      `UP 平均 ${row?.xbd_avg ?? '-'}`
    )
  })
  lines.push('', '用法：%绝区零欧非榜 [综合|角色|音擎|常驻] [欧|非|氪] [数量]')
  return lines.join('\n')
}

/**
 * 角色练度排名：GET /api/v1/user_relic/ranking
 * 页面（pagesCase/relic-ranking）参数：
 *   type      relic / role / damage（对应不同榜单口径，综合榜为 role）
 *   role_id   角色 item_id
 *   role_level 60 / 50 / 40
 *   role_rank  影画 0-6，null 为不限
 *   part_index 驱动盘部位 0-5，null 为全部
 *   weapon_id  音擎 id，null 为不限
 * 返回 rows: [{ item_id, level, uid, relic_point, rank, user_case:{ nick_name } }]
 */
async function buildRoleRank(arg, opts = {}) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) {
    return '用法：%绝区零角色排名 <角色名> [60|50|40] [影画0-6] [数量]\n例：%绝区零角色排名 星见雅'
  }
  let roleName = ''
  let level = 60
  let rank = null
  let count = 10
  for (const token of tokens) {
    const levelHit = token.match(/^(60|50|40)级?$/)
    if (levelHit) { level = Number(levelHit[1]); continue }
    if (/影画|星魂/.test(token)) {
      const rankHit = token.match(/([0-6])/)
      if (rankHit) { rank = Number(rankHit[1]); continue }
    }
    if (/^\d+$/.test(token)) { count = limitOf(token, 10, 30); continue }
    if (!roleName) roleName = token
  }
  if (!roleName) return '请提供角色名，例：%绝区零角色排名 星见雅'

  const role = await resolveRole(roleName)
  if (!role) return `未找到角色「${roleName}」，可先用【%绝区零评分榜】查看角色名。`

  const subtitle = `${level}级 / ${rank === null ? '不限影画' : `${rank}影画`} / 按驱动盘总分排序`
  let data
  try {
    data = await request('/api/v1/user_relic/ranking', {
      limit: 50,
      offset: 0,
      type: 'role',
      role_id: role.item_id,
      role_level: level,
      role_rank: rank,
      part_index: null,
      weapon_id: null,
    })
  } catch (err) {
    // 工坊对部分筛选组合返回「数据统计中」，属于无数据而非接口故障
    if (/统计中/.test(err?.message || '')) {
      return `绝区零工坊 · ${role.nick_name} 练度排名\n${subtitle}\n\n${err.message}\n换用「不限影画 / 60级」再试。`
    }
    throw err
  }
  let rows = Array.isArray(data?.rows) ? data.rows : []
  if (!rows.length) {
    return { error: `暂无符合条件的记录（该角色可能未开放统计）。`, subtitle }
  }

  /* 本群范围：工坊返回的是完整 UID（不打码），所以能直接和群成员绑定 UID 求交集。
     交集为空时说明群里没人把这个角色上传到工坊角色柜，明确说明而不是显示空榜。 */
  const scope = opts.scope || 'all'
  const members = opts.memberUids
  let scopeText = '全服'
  if (scope === 'group') {
    if (!members || !members.size) {
      return {
        error: '本群统计需要群成员已绑定绝区零 UID，当前没读到任何成员绑定。\n可发送「%面板排名范围」切换到全服查看工坊总榜。',
        subtitle,
      }
    }
    rows = rows.filter(row => members.has(String(row?.uid ?? '')))
    scopeText = `本群（${members.size} 人有绑定）`
    if (!rows.length) {
      return {
        error: `本群没有成员把「${role.nick_name}」上传到工坊角色柜，因此没有本群排名。\n可发送「%面板排名范围」切换到全服查看工坊总榜。`,
        subtitle,
      }
    }
  }

  const list = rows.slice(0, count).map((row, index) => ({
    rank: index + 1,
    globalRank: Number(row?.rank ?? 0) || index + 1,
    uid: String(row?.uid ?? ''),
    nickname: row?.user_case?.nick_name || '',
    level: Number(row?.level ?? 0) || 0,
    point: Number(row?.relic_point || 0),
    pointText: Number(row?.relic_point || 0).toFixed(3),
    // 角色柜里没有玩家头像，统一用该角色立绘/头像占位
    avatar: role.avatar2 || role.long_avatar || '',
    damage: 0,
    damageText: '-',
    damageSkill: '',
  }))

  /* 伤害：排行接口只有驱动总分，要算伤害得逐人拉 /user_role/ranking 拿词条。
     一次请求 1~2 秒，为控制耗时只给前 10 名算，其余显示「-」。
     失败（未上传/接口异常）不影响整张榜单。 */
  const damageLimit = Math.min(list.length, 10)
  await Promise.all(list.slice(0, damageLimit).map(async row => {
    try {
      const params = { uid: row.uid, type: 'ranking', refresh: false, item_id: role.item_id }
      const detail = await signedPost('/api/v1/user_role/ranking', params)
      const target = (detail?.roles || []).find(r => String(r?.item_id) === String(role.item_id))
      if (!target) return
      /* role 是 buildRoleRank 里 resolveRole 得到的工坊角色对象，
         nick_name 才是中文名（target.name 是 null）。 */
      const panel = await calcWorkshopPanel(target, role.nick_name)
          if (!panel) return
      const bp = buildBasicProperties(panel)
      const dmg = calcPanelDamage(bp, panel.level, panel, role.nick_name)
      if (!dmg?.ok) return
      row.damage = Number(dmg.top?.expect) || 0
      row.damageSkill = dmg.top?.name || ''
    } catch (_) {
      /* 单个玩家失败不影响榜单 */
    }
  }))
  for (const row of list) row.damageText = row.damage ? formatNum(row.damage) : '-'

  return {
    character: role.nick_name,
    level,
    rankFilter: rank,
    subtitle,
    scope,
    scopeText,
    isGroup: scope === 'group',
    total: Number(data?.total) || rows.length,
    list,
  }
}

/* ───────────── 工坊数据 → 面板属性 → 伤害 ─────────────
 *
 * 工坊 /user_role/ranking 不返回面板数值（hp/attack/crit 全是 0），只给：
 *   · 驱动盘的 MainPropertyList / RandomPropertyList（PropertyValue 为「游戏内数值 ×1000」）
 *   · 音擎 Id / Level / BreakLevel / UpgradeLevel
 *   · SkillLevelList（各技能等级）
 * 所以伤害只能自己算：先按词条还原面板属性，再套本插件的倍率与乘区。
 *
 * PropertyValue 单位核对：
 *   12102(攻击%) 单条 300 → 3%（S 盘单条满档 5.8%），即 value/1000 得百分比
 *   21103(暴伤)  单条 480 → 4.8%（S 盘单条满档 6.2%）同上
 *   12103(小攻击) 19     → 19 点固定值（不除）
 */
const PCT_IDS = new Set([11102, 12102, 13102, 20103, 21103, 23103, 30502, 31402,
  31503, 31603, 31703, 31803, 31903, 32303])

/**
 * 展示形态 → 面板：直接取工坊算好的 final_val。
 */
/**
 * 旧通道（source_api=2025）→ 面板。
 *
 * 这一步是**可复现的**，公式已与展示形态对齐（星见雅 1091 实测）：
 *   角色裸攻 = Attack + Level[6].Attack × 10/3        → 880
 *   总攻击   = 角色裸攻 + 音擎满级基础攻击             → 880 + 743 = 1623  ✅
 *   生命     = HpMax + Level[6].HpMax × 10/3          → 7674（接口 7673，取整差 1）
 *   防御     = Defence + Level[6].Defence × 10/3      → 606  ✅
 *   冲击力/暴击/暴伤/异常掌控/异常精通 直接取 PartnerId2Data 字段
 *   驱动盘：主词条 ÷25、副词条 ÷100（工坊两种编码不同，见 workshopPropValue）
 *   音擎副词条同样 ÷100
 *
 * 音擎满级攻击来自 zzz_weapon_stat.json（Bwiki 抓取 + 缺失项按 Lv1×14.85 推导）。
 */
async function panelFromRaw(item, roleName, role) {
  const partner = await loadPartnerData()
  const weaponStat = await loadWeaponStat()
  const pid = String(role?.item_id || item?.Id || '')
  const p = partner?.[pid]
  if (!p) return null

  const lv6 = p.Level?.['6'] || {}
  const scale = 10 / 3
  /* Level[6] 已含突破，攻击/生命/防御直接用；
     但 ElementMystery / ElementAbnormalPower / BreakStun 等是**裸值**，
     突破加成在 ExtraLevel[6].Extra 里（Value 已是累积值，不是增量）。
     星见雅实测：148 + 90 = 238，再接驱动盘 18 → 256，与工坊 final 一致。 */
  const extra = p.ExtraLevel?.['6']?.Extra || {}
  const extraOf = (prop) => Number(extra?.[String(prop)]?.Value) || 0
  const charAtk = Number(p.Attack || 0) + Number(lv6.Attack || 0) * scale
  const charHp = Number(p.HpMax || 0) + Number(lv6.HpMax || 0) * scale
  const charDef = Number(p.Defence || 0) + Number(lv6.Defence || 0) * scale

  const acc = {
    hp: charHp,
    atk: charAtk,
    def: charDef,
    breakstun: (Number(p.BreakStun) || 93) + extraOf(12201),
    crit: ((Number(p.Crit) || 500) + extraOf(20101)) / 100,
    critdam: ((Number(p.CritDamage) || 5000) + extraOf(21101)) / 100,
    penratio: ((Number(p.PenRate) || 0) + extraOf(23201)) / 100,
    penvalue: extraOf(23203),
    mastery: (Number(p.ElementMystery) || 0) + extraOf(31201),
    abnormal: (Number(p.ElementAbnormalPower) || 0) + extraOf(31401),
    recharge: ((Number(p.SpRecover) || 120) + extraOf(30501)) / 100,
    dmgbonus: 0,
  }
  /* 百分比词条单独累计，最后乘到基础值上（只在生命/攻击/防御上生效） */
  const pct = { hp: 0, atk: 0, def: 0 }

  const addProp = (propertyId, val, isMain) => {
    const id = Number(propertyId)
    switch (id) {
      case 11102: pct.hp += val; break
      case 11103: acc.hp += val; break
      case 12102: pct.atk += val; break
      case 12103: acc.atk += val; break
      case 13102: pct.def += val; break
      case 13103: acc.def += val; break
      case 20103: acc.crit += val; break
      case 21103: acc.critdam += val; break
      case 23103: acc.penratio += val; break
      case 23203: acc.penvalue += val; break
      case 31203: acc.mastery += val; break
      case 30502: acc.recharge += val / 100; break
      case 12202: break
      default:
        /* 属性增伤（冰/火/电/物理/以太/风） */
        if (id >= 31503 && id <= 32303) acc.dmgbonus += val
    }
  }

  const equips = Array.isArray(item.EquippedList) ? item.EquippedList : []
  if (!equips.length) return null
  for (const eq of equips) {
    const e = eq?.Equipment || {}
    for (const pr of e.MainPropertyList || []) {
      addProp(pr.PropertyId, workshopPropValue(pr.PropertyId, pr.PropertyValue, true), true)
    }
    for (const pr of e.RandomPropertyList || []) {
      addProp(pr.PropertyId, workshopPropValue(pr.PropertyId, pr.PropertyValue, false), false)
    }
  }

  /* 音擎按 baseType 分流：
     atk 型 → 攻击 += atk60
     def 型 → 攻击 += 0，防御 += def60（猩红渴望/血髓秘匣/喵运当头/「月相」-弦）
     副词条两种情况都正常计入。 */
  const wqId = String(item.Weapon?.Id || '')
  const wq = weaponStat?.weapons?.[wqId] || null
  if (wq) {
    if (wq.baseType === 'def') {
      acc.def += Number(wq.def60) || 0
    } else {
      acc.atk += Number(wq.atk60) || 0
    }
    if (wq.sub60 != null) {
      const subPid = SUB_NAME_TO_PID[wq.subName]
      if (subPid) addProp(subPid, Number(String(wq.sub60).replace('%', '')) || 0, false)
    }
  }

  const final = {
    hp: acc.hp * (1 + pct.hp / 100),
    atk: acc.atk * (1 + pct.atk / 100),
    def: acc.def * (1 + pct.def / 100),
    breakstun: acc.breakstun,
    crit: acc.crit,
    critdam: acc.critdam,
    penratio: acc.penratio,
    penvalue: acc.penvalue,
    mastery: acc.mastery,
    recharge: acc.recharge,
    dmgbonus: acc.dmgbonus,
  }

  return {
    name_mi18n: roleName || p.name || '',
    level: Number(role?.level) || 60,
    rank: Number(item.TalentLevel) || 0,
    rarity: p.Rarity || 'S',
    equip: equips.map(eq => ({
      equipment_type: Number(eq?.Slot) || 0,
      level: Number(eq?.Equipment?.Level) || 0,
      rarity: eq?.Equipment?.Rarity || 'S',
      equip_suit: { name: '', own: Number(eq?.Equipment?.SuitNum) || 0 },
    })),
    weapon: {
      id: Number(item.Weapon?.Id) || 0,
      level: Number(item.Weapon?.Level) || 60,
      star: Number(item.Weapon?.UpgradeLevel) || 1,
      rarity: wq?.rarity || 'S',
    },
    skills: (item.SkillLevelList || []).map(sk => ({
      skill_type: Number(sk.Index),
      level: Number(sk.Level) || 0,
    })),
    properties: [
      { property_id: 1, base: String(Math.round(final.hp)), final: String(Math.round(final.hp)) },
      { property_id: 2, base: String(Math.round(final.atk)), final: String(Math.round(final.atk)) },
      { property_id: 3, base: String(Math.round(final.def)), final: String(Math.round(final.def)) },
      { property_id: 4, base: String(final.breakstun), final: String(final.breakstun) },
      { property_id: 5, base: `${final.crit.toFixed(1)}%`, final: `${final.crit.toFixed(1)}%` },
      { property_id: 6, base: `${final.critdam.toFixed(1)}%`, final: `${final.critdam.toFixed(1)}%` },
      { property_id: 9, base: `${final.penratio.toFixed(1)}%`, final: `${final.penratio.toFixed(1)}%` },
      { property_id: 232, base: String(final.penvalue), final: String(final.penvalue) },
      { property_id: 8, base: String(final.mastery), final: String(final.mastery) },
      { property_id: 11, base: String(final.recharge.toFixed(2)), final: String(final.recharge.toFixed(2)) },
      { property_id: 317, base: `${final.dmgbonus.toFixed(1)}%`, final: `${final.dmgbonus.toFixed(1)}%` },
    ],
  }
}

/** 音擎副属性中文名 → property_id（zzz_weapon_stat.json 里 subName 是中文） */
const SUB_NAME_TO_PID = {
  攻击力: 12102, 生命值: 11102, 防御力: 13102,
  暴击率: 20103, 暴击伤害: 21103, 穿透率: 23103, 穿透值: 23203,
  异常精通: 31203, 能量自动回复: 30502, 冲击力: 12202, 异常掌控: 31402,
}

async function panelFromFinal(item, roleName) {
  /* 工坊已经把面板算好了：item_json.properties 里每项都带 final/final_val，
     包含角色基础+突破、音擎主副词条、驱动盘主副词条，口径与工坊页面一致。
     不要再自己从词条拼，也不要再叠加套装（套装静态/触发由 zzz_buff.json 在伤害计算时处理）。 */
  const byId = new Map((item.properties || []).map(x => [Number(x.property_id), x]))
  const val = (id, fallback = 0) => {
    const hit = byId.get(Number(id))
    if (!hit) return fallback
    const n = Number(hit.final_val)
    return Number.isFinite(n) ? n : fallback
  }
  const text = (id, fallback = '0') => {
    const hit = byId.get(Number(id))
    return hit?.final ?? String(fallback)
  }

  const final = {
    hp: val(1),
    atk: val(2),
    def: val(3),
    breakstun: val(4, 93),
    crit: val(5, 5),
    critdam: val(6, 50),
    penratio: val(9, 0),
    penvalue: val(232, 0),
    mastery: val(8, 0),
    recharge: val(11, 1.2),
    dmgbonus: val(317, 0),
  }

  return {
    name_mi18n: roleName || item.name || '',
    level: Number(item.level) || 60,
    rank: Number(item.rank) || 0,
    rarity: item.rarity || 'S',
    equip: (item.equip || []).map(eq => ({
      equipment_type: Number(eq.equipment_type) || 0,
      level: Number(eq.level) || 0,
      rarity: eq.rarity || 'S',
      equip_suit: { name: eq.equip_suit?.name || '', own: Number(eq.equip_suit?.own) || 0 },
    })),
    weapon: {
      id: Number(item.weapon?.id) || 0,
      level: Number(item.weapon?.level) || 60,
      star: Number(item.weapon?.star) || 1,
      rarity: item.weapon?.rarity || 'S',
    },
    skills: (item.skills || []).map(sk => ({ skill_type: Number(sk.skill_type), level: Number(sk.level) || 0 })),
    properties: [
      { property_id: 1, base: text(1), final: text(1) },
      { property_id: 2, base: text(2), final: text(2) },
      { property_id: 3, base: text(3), final: text(3) },
      { property_id: 4, base: text(4), final: text(4) },
      { property_id: 5, base: text(5), final: text(5) },
      { property_id: 6, base: text(6), final: text(6) },
      { property_id: 9, base: text(9), final: text(9) },
      { property_id: 232, base: text(232), final: text(232) },
      { property_id: 8, base: text(8), final: text(8) },
      { property_id: 11, base: text(11), final: text(11) },
      { property_id: 317, base: text(317), final: text(317) },
    ],
  }
}

/**
 * 工坊词条 → 百分数（不是比值）。主词条与副词条的编码不同：
 *   主词条：满级 30% 记作 750 → 除以 25
 *   副词条：3% 记作 300、2.4% 记作 240、4.8% 记作 480 → 除以 100
 *   固定值（12103 小攻击、11103 小生命…）：原样返回
 */
function workshopPropValue(pid, raw, isMain) {
  const v = Number(raw) || 0
  if (!PCT_IDS.has(Number(pid))) return v
  return isMain ? v / 25 : v / 100
}

/**
 * 由「驱动盘词条 + 音擎」累加出面板终值。
 *
 * 工坊不返回面板数值，这里按游戏规则自己加：
 *   基础值（角色 Lv60 底值） + 百分比加成 × 基础值 + 固定值
 * 角色基础值取自本地的 zzz_char_stat.json（与极限面板同一份数据）。
 */
async function calcWorkshopPanel(role, roleName) {
  const item = role?.item_json || {}
  /* 工坊有两条上传通道，按 roles[].source_api 区分：
     ① 'mi'   新通道：item_json.properties[].final 已折算好角色基础+突破、
              音擎、驱动盘，直接取 final_val —— 与工坊页面同一口径。
     ② '2025' 旧通道：只有 EquippedList + Weapon.Id。
              用 PartnerId2Data 的角色成长值 + zzz_weapon_stat 的音擎满级攻击
              自己还原，公式已用星见雅 1091 对齐（攻击 880 + 776 = 1623）。 */
  const fromMi = String(role?.source_api || '') === 'mi'
    || (Array.isArray(item.properties) && item.properties.some(p => p.final != null))
  if (fromMi) return panelFromFinal(item, roleName)
  return panelFromRaw(item, roleName, role)
}

/** set_info "32700_2__32800_2" → 每件驱动盘补一个 equip_suit（供套装增益匹配） */
function buildEquipSets(role) {
  const parts = String(role?.set_info || '').split('__').map(x => {
    const [id, count] = x.split('_')
    return { id: String(id || ''), count: Number(count) || 0 }
  }).filter(p => p.id)
  const out = []
  let slot = 1
  for (const part of parts) {
    for (let i = 0; i < part.count; i++) {
      out.push({
        equipment_type: slot++,
        equip_suit: { suit_id: Number(part.id) || 0, name: SUIT_NAME[part.id] || '', own: part.count },
      })
    }
  }
  return out
}

/** 驱动盘套装 id → 名称（只收常用的，用于增益匹配；缺名字时增益会被跳过） */
const SUIT_NAME = {
  31000: '啄木鸟电音', 31100: '河豚电音', 31200: '炎狱重金属', 31300: '混沌重金属',
  31400: '激素朋克', 31500: '雷暴重金属', 31600: '摇摆爵士', 31700: '极地重金属',
  31800: '混沌爵士', 31900: '原始朋克', 32000: '自由蓝调', 32100: '灵魂摇滚',
  32200: '獠牙重金属', 32400: ' Thunder Metal', 32500: '极地重金属',
  32600: '獠牙重金属', 32700: '折枝剑歌', 32800: '静听嘉音', 32900: '如影相随',
  33000: '法厄同之歌', 33100: '云岿如我', 33200: '山大王', 33300: '拂晓生花',
  33400: '月光骑士颂', 33500: '沧浪行歌', 33600: '流光咏叹', 33700: '混沌重金属',
  33800: '炎狱重金属', 33900: '雷暴重金属', 34000: '法厄同之歌',
}

/** 角色 Lv60 基础值（与极限面板共用 zzz_char_stat.json） */
let WEAPON_STAT_CACHE = null
/** 音擎满级基础攻击与副词条（tools/build_zzz_weapon_stat.mjs 生成） */
async function loadWeaponStat() {
  if (WEAPON_STAT_CACHE) return WEAPON_STAT_CACHE
  try {
    const f = path.join(process.cwd(), 'plugins', 'HoYoGet-Plugin', 'system', 'default', 'zzz_weapon_stat.json')
    WEAPON_STAT_CACHE = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (_) {
    WEAPON_STAT_CACHE = {}
  }
  return WEAPON_STAT_CACHE
}

let PARTNER_DATA_CACHE = null
/** 角色成长数据（raw 形态还原面板用） */
async function loadPartnerData() {
  if (PARTNER_DATA_CACHE !== null) return PARTNER_DATA_CACHE
  try {
    const f = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin', 'resources', 'map', 'PartnerId2Data.json')
    PARTNER_DATA_CACHE = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (_) {
    PARTNER_DATA_CACHE = {}
  }
  return PARTNER_DATA_CACHE
}

let CHAR_STAT_CACHE = null
async function loadCharStat() {
  if (CHAR_STAT_CACHE) return CHAR_STAT_CACHE
  try {
    const f = path.join(process.cwd(), 'plugins', 'HoYoGet-Plugin', 'system', 'default', 'zzz_char_stat.json')
    CHAR_STAT_CACHE = JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch (_) {
    CHAR_STAT_CACHE = null
  }
  return CHAR_STAT_CACHE
}
/**
 * 按名字取角色 Lv60 基础值。
 * zzz_char_stat.json 的结构是 { chars: { 中文名: { id, fullName, enName, props } } }，
 * **没有 name 字段**，所以要先按键名精确匹配，再退到 fullName / enName / 简写。
 */
function statBase(table, name) {
  const chars = table?.chars || {}
  const key = String(name || '').trim()
  if (!key) return null
  if (chars[key]) return chars[key]
  const exact = Object.values(chars).find(c =>
    c?.fullName === key || c?.enName === key || String(c?.id) === key)
  if (exact) return exact
  return Object.values(chars).find(c =>
    String(c?.fullName || '').includes(key) || key.includes(String(c?.fullName || ''))) || null
}

/** 音擎主/副词条 */
let ITEM_TABLE_CACHE = null
async function loadWeapon(id) {
  if (!ITEM_TABLE_CACHE) {
    try {
      const f = path.join(process.cwd(), 'plugins', 'HoYoGet-Plugin', 'system', 'default', 'zzz_item_stat.json')
      ITEM_TABLE_CACHE = JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch (_) {
      ITEM_TABLE_CACHE = {}
    }
  }
  return ITEM_TABLE_CACHE?.weapons?.[String(id)] || null
}

/** 把工坊的 roles[0] 还原成本地面板记录的形状，供本插件已有计算链使用 */
async function workshopToPanel(role, roleName) {
  const item = role?.item_json || {}
  const equips = []
  for (const eq of item.EquippedList || []) {
    const e = eq?.Equipment || {}
    equips.push({
      equipment_type: Number(eq?.Slot) || 0,
      level: Number(e?.Level) || 0,
      rarity: 'S',
      main_properties: (e.MainPropertyList || []).map(p => ({
        property_id: Number(p.PropertyId),
        base: workshopPropValue(p.PropertyId, p.PropertyValue),
      })),
      properties: (e.RandomPropertyList || []).map(p => ({
        property_id: Number(p.PropertyId),
        base: workshopPropValue(p.PropertyId, p.PropertyValue),
        level: Number(p.PropertyLevel) || 0,
      })),
    })
  }
  const w = item.Weapon || {}
  return {
    name_mi18n: roleName,
    level: Number(role?.level) || 60,
    rank: Number(item.TalentLevel) || 0,
    rarity: 'S',
    equip: equips,
    weapon: {
      id: Number(w.Id) || 0,
      level: Number(w.Level) || 60,
      star: Number(w.UpgradeLevel) || 1,
      rarity: 'S',
    },
    skills: (item.SkillLevelList || []).map(s => ({
      skill_type: Number(s.Index),
      level: Number(s.Level) || 0,
    })),
  }
}

/**
 * 单玩家练度详情/**
 * 单玩家练度详情：POST /api/v1/user_role/ranking（需签名头）
 * 参数：{ uid, type:'ranking', item_id?, refresh:false }
 * 返回：{ uid, nick_name, level, roles:[{ item_id, level, relic_point, set_info, item_json, ... }] }
 * 说明：接口只给原始数据，面板数值（生命/攻击/暴击等）由工坊前端按权重计算，这里不做还原。
 */
async function buildDetail(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  const uid = tokens.find(token => /^\d{6,}$/.test(token))
  const nameToken = tokens.find(token => !/^\d{6,}$/.test(token))
  if (!uid || !nameToken) {
    return '用法：%绝区零练度 <UID> <角色名>\n例：%绝区零练度 14819792 星见雅\n\n该接口必须带角色，单独查玩家请先用【%绝区零角色排名 <角色>】找到 UID。'
  }

  const role = await resolveRole(nameToken)
  if (!role) {
    return `未找到角色「${nameToken}」，可先用【%绝区零评分榜】查看角色名。`
  }

  const params = { uid, type: 'ranking', refresh: false, item_id: role.item_id }
  const data = await signedPost('/api/v1/user_role/ranking', params)
  const roles = Array.isArray(data?.roles) ? data.roles : []
  if (!roles.length) {
    return `未查询到 UID ${uid} 的练度数据。\n该玩家可能未在绝区零工坊上传角色柜，或尚未达到纳入统计的条件。`
  }

  const nick = data?.nick_name || '未知玩家'
  const playerLevel = data?.level ? ` Lv.${data.level}` : ''
  const [, weapons, relics] = await Promise.all([getRoles(), getWeapons(), getRelics()])

  const row = roles[0]
  const level = row?.level || role.level || '-'
  const point = Number(row?.relic_point || 0).toFixed(1)
  const talent = row?.item_json?.TalentLevel ?? 0
  const weaponId = String(row?.weapon_id ?? '')
  const weaponName = weaponId && weaponId !== 'other' ? (weapons.get(weaponId) || `音擎${weaponId}`) : '未装备'
  const refine = row?.item_json?.Weapon?.UpgradeLevel
  const sets = parseSetInfo(row?.set_info)
    .filter(part => part.setId !== 'other')
    .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
    .join(' + ') || '未知'
  const updatedAt = formatTime(row?.updated_at)
  const updated = updatedAt ? `\n数据更新：${updatedAt}` : ''

  return [
    `绝区零工坊 · ${role.nick_name}`,
    `玩家 ${nick}（${uid}）${playerLevel}`,
    '',
    `等级：Lv.${level}　影画：${talent}`,
    `驱动总分：${point}`,
    `音擎：${weaponName}${refine ? `　精炼 ${refine}` : ''}`,
    `驱动盘：${sets}${updated}`,
    '',
    '面板属性与单件评分由工坊前端按权重计算，接口只返回原始数据。',
  ].join('\n')
}

/** 统计区间结束日期距今超过 90 天即视为停更 */
function isStale(period) {
  const dates = String(period || '').match(/\d{4}-\d{2}-\d{2}/g)
  if (!dates?.length) return false
  const last = new Date(`${dates[dates.length - 1]}T00:00:00`)
  if (Number.isNaN(last.getTime())) return false
  return Date.now() - last.getTime() > 90 * 24 * 3600 * 1000
}

async function buildAbyssRank() {
  const [stats, result] = await Promise.all([
    request('/api/v1/abyss/stats', { device_id: 'zzz-rank-plugin', user_union_id: 'zzz-rank-plugin' }),
    request('/api/v1/abyss/result'),
  ])
  const config = stats?.abyss_config || {}
  const roles = Array.isArray(result?.abyss_roles) ? [...result.abyss_roles] : []
  if (!roles.length) throw new Error('榜单暂无数据')
  // rank 字段是分档标记（同一档多条并列），按使用率排序更接近实际名次
  roles.sort((a, b) => Number(b?.use_rate || 0) - Number(a?.use_rate || 0))

  const descs = Array.isArray(config?.stat_open_descs) ? config.stat_open_descs.map(String) : []
  const period = descs.find(item => /统计时间/.test(item)) || ''
  const sample = descs.find(item => /有效样本/.test(item)) || ''
  const lines = ['绝区零工坊 · 式舆防卫战角色使用率']
  if (period) lines.push(period.replace(/^统计时间：/, '统计区间：'))
  if (sample) lines.push(`· ${sample.replace(/^数据说明：/, '')}`)
  if (isStale(period)) lines.push('提示：该榜已停止更新，数据仅作历史参考。')
  lines.push('')
  roles.slice(0, 12).forEach((item, index) => {
    lines.push(
      `${String(index + 1).padStart(2, '0')}. ${fit(item?.nick_name || '未知', 18)}` +
      `使用率 ${ratio(item?.use_rate)}  持有率 ${ratio(item?.owning_rate)}`
    )
  })
  lines.push('', '数据来源：绝区零工坊，样本为第七层 S 级通关且队伍满 3 人的记录。')
  return lines.join('\n')
}

const HELP_TEXT = [
  '绝区零工坊榜单（独立插件）',
  '%绝区零评分榜 [好感|强度] [数量]   角色好感度 / 强度评分榜',
  '%绝区零角色配装 <角色名>          全服音擎与驱动盘使用率',
  '%绝区零角色排名 <角色名> [等级] [影画]  练度排行（驱动盘总分）',
  '%绝区零练度 <UID> [角色名]        查询单个玩家 / 单个角色的练度详情',
  '%绝区零欧非榜 [综合|角色|音擎|常驻] [欧|非|氪] [数量]',
  '%绝区零式舆排名                   式舆防卫战角色使用率（数据已停更）',
  '',
  '数据均来自绝区零工坊公开接口，无需绑定账号。',
].join('\n')

export class zzz_workshop extends plugin {
  constructor() {
    super({
      name: '[米哈游]绝区零工坊榜单',
      dsc: '绝区零工坊角色评分 / 配装 / 练度排名 / 欧非 / 式舆',
      event: 'message',
      priority: pluginPriority('zzz_workshop', 5000),
      rule: [
        { reg: RE_LOVE, fnc: 'loveRank' },
        { reg: RE_GRAD, fnc: 'gradStat' },
        { reg: RE_CARD, fnc: 'cardRank' },
        { reg: RE_ROLE_RANK, fnc: 'roleRank' },
        { reg: RE_DETAIL, fnc: 'detail' },
        { reg: RE_ABYSS, fnc: 'abyssRank' },
        { reg: RE_HELP, fnc: 'help' },
      ],
    })
  }

  async loveRank(e) {
    try {
      return await e.reply(await buildLoveRank(RE_LOVE.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('loveRank', err)
      return await e.reply(`获取角色评分榜失败：${err?.message || err}`)
    }
  }

  async gradStat(e) {
    try {
      return await e.reply(await buildGradStat(RE_GRAD.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('gradStat', err)
      return await e.reply(`获取配装统计失败：${err?.message || err}`)
    }
  }

  async cardRank(e) {
    try {
      return await e.reply(await buildCardRank(RE_CARD.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('cardRank', err)
      return await e.reply(`获取欧非榜失败：${err?.message || err}`)
    }
  }

  async roleRank(e) {
    try {
      /* 范围跟随「%面板排名范围」的开关，与本地面板排名共用同一份状态。
         本群范围需要群成员绑定 UID，拿不到成员列表时回落全服。 */
      const wantGroup = getRankScope() === 'group'
      const memberUids = wantGroup ? await getGroupMemberUids(e) : null
      const scope = wantGroup && memberUids ? 'group' : 'all'
      const res = await buildRoleRank(RE_ROLE_RANK.exec(e.msg)?.[1] || '', { scope, memberUids })
      // 无数据/无本群样本时返回 { error }，直接回文字
      if (res?.error) return e.reply(res.error)
      try {
        return await render('zzz_panel/workshop_rank', res, { e, ret: true })
      } catch (err) {
        // 渲染失败降级成文字，至少把数据给到
        logError('roleRank-render', err)
        const lines = [`绝区零工坊 · ${res.character} 练度排名`, res.subtitle, `范围：${res.scopeText}`, '']
        res.list.forEach(r => lines.push(`${String(r.rank).padStart(2, '0')}. ${r.nickname || 'UID ' + r.uid}  ${r.pointText}  ${res.isGroup ? '第 ' + r.rank + ' 名' : '#' + r.globalRank}`))
        return e.reply(lines.join('\n'))
      }
    } catch (err) {
      logError('roleRank', err)
      return await e.reply(`获取练度排名失败：${err?.message || err}`)
    }
  }

  async detail(e) {
    try {
      return await e.reply(await buildDetail(RE_DETAIL.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('detail', err)
      return await e.reply(`查询练度失败：${err?.message || err}`)
    }
  }

  async abyssRank(e) {
    try {
      return await e.reply(await buildAbyssRank())
    } catch (err) {
      logError('abyssRank', err)
      return await e.reply(`获取式舆排名失败：${err?.message || err}`)
    }
  }

  async help(e) {
    return await e.reply(HELP_TEXT)
  }
}
