// 星穹铁道工坊榜单
//
// 数据源：https://api.lingyuan.design（星穹铁道工坊小程序后端）
// 接口来源：小程序包 wx9660a6f443d341bb 解包后从 app-service.js 提取；
//          与绝区零工坊同一开发方，请求 / 签名实现在 system/workshop_api.js。
//
// 接口：
//   GET  /api/v1/game_role/list?limit=500       角色表
//   GET  /api/v1/guang/list?limit=500           光锥表
//   GET  /api/v1/relic/public?limit=500         遗器套装表
//   GET  /api/v1/user_relic/ranking             遗器 / 伤害排名（type=role|damage）
//   GET  /api/v1/role/grad_stat                 全服配装统计（level=-1&rank=-1 表示不限）
//   GET  /api/v1/team_system/list               队伍体系推荐
//   GET  /api/v1/card_ranking/ranking_v4        抽卡欧非榜
//   GET  /api/v1/config/system_data_v2          体系名称字典（game_dict_team_system）
//   POST /api/v1/user_role/ranking              单玩家练度（需要签名头）
//
// 踩坑：
//   · 星铁「不限星魂」必须传 role_rank=（空串），传 -1 或省略都返回 0 条；
//     所以 system/workshop_api.js 的 request 只跳过 undefined / null。
//   · api.lingyuan.design 有 3 个 A 记录，其中 1 个证书已过期，重试由请求层负责。
//   · 「数据统计中」是工坊重算统计时的正常返回，按无数据提示，不做自动重试。
//
// 说明：接口随时可能调整或关闭，失败时只回提示，不抛出未捕获异常。

import { pluginPriority } from '#HoYoGet'
import { SR_HOST, request, signedPost, parseSetInfo } from '../system/workshop_api.js'

const CACHE_TTL = 6 * 3600 * 1000

// 指令正则：规则表与参数提取共用，避免两处写法不一致
const RE_SR_RANK = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)(?:遗器)?(?:练度)?排名(?:\s+(.+))?$/i
const RE_SR_DMG = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)伤害(?:排名|排行)(?:\s+(.+))?$/i
const RE_SR_GRAD = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)(?:角色)?配装(?:统计)?(?:\s+(.+))?$/i
const RE_SR_CARD = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)(?:抽卡|欧非)(?:榜|排行)?(?:\s+(.+))?$/i
const RE_SR_TEAM = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)(?:队伍)?(?:体系)?(?:推荐|配队)(?:\s+(.+))?$/i
const RE_SR_DETAIL = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)(?:查)?练度(?:\s+(.+))?$/i
const RE_SR_HELP = /^[#%]*(?:米哈游)?(?:星铁|星穹铁道|sr|hsr)榜单帮助$/i

// ===== 名称缓存 =====

const cache = { roles: null, rolesAt: 0, guangs: null, guangsAt: 0, relics: null, relicsAt: 0 }

function fresh(at) {
  return at && Date.now() - at < CACHE_TTL
}

async function srRoles() {
  if (cache.roles && fresh(cache.rolesAt)) return cache.roles
  const data = await request('/api/v1/game_role/list', { limit: 500 }, SR_HOST)
  const rows = Array.isArray(data?.rows) ? data.rows : []
  cache.roles = rows
  cache.rolesAt = Date.now()
  return rows
}

async function srGuangs() {
  if (cache.guangs && fresh(cache.guangsAt)) return cache.guangs
  const data = await request('/api/v1/guang/list', { limit: 500 }, SR_HOST)
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const map = new Map()
  for (const row of rows) {
    const id = String(row?.item_id ?? '')
    const name = row?.nick_name || ''
    if (id && name) map.set(id, name)
  }
  cache.guangs = map
  cache.guangsAt = Date.now()
  return map
}

async function srRelics() {
  if (cache.relics && fresh(cache.relicsAt)) return cache.relics
  const data = await request('/api/v1/relic/public', { limit: 500 }, SR_HOST)
  const rows = Array.isArray(data?.rows) ? data.rows : []
  const map = new Map()
  for (const row of rows) {
    const id = String(row?.set_id ?? '')
    const name = row?.name_simple || row?.short_name || row?.name || ''
    if (id && name) map.set(id, name)
  }
  cache.relics = map
  cache.relicsAt = Date.now()
  return map
}

async function resolveSrRole(input) {
  const keyword = String(input || '').trim()
  if (!keyword) return null
  const rows = await srRoles()
  const exact = rows.find(row => (row?.nick_name || '') === keyword)
  if (exact) return exact
  return rows.find(row => (row?.nick_name || '').includes(keyword) || keyword.includes(row?.nick_name || '')) || null
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
  const message = `[HoYoGet][sr_workshop][${tag}] ${err?.message || err}`
  try { if (typeof logger !== 'undefined') logger.mark(message) } catch { /* 忽略日志异常 */ }
}

/** 伤害榜的数值字段不固定：单体技能落在 skill1，强化战技落在 skill2 */
function damageOf(row) {
  for (let index = 1; index <= 4; index++) {
    const value = Number(row?.[`skill${index}`])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function damageText(value) {
  const num = Number(value) || 0
  if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`
  return String(Math.round(num))
}

/** 面板数值：combatValues 已是算好的终值，百分比字段是小数 */
function panelText(values) {
  const num = key => Number(values?.[key]) || 0
  const int = key => String(Math.round(num(key)))
  const pct = key => `${(num(key) * 100).toFixed(1)}%`
  const lines = [
    `生命 ${int('hpFinal')}　攻击 ${int('attackFinal')}　防御 ${int('defenseFinal')}`,
    `速度 ${num('speedFinal').toFixed(1)}　暴击 ${pct('criticalChance')}　爆伤 ${pct('criticalDamage')}`,
  ]
  const extra = []
  if (num('stanceBreakRatio')) extra.push(`击破特攻 ${pct('stanceBreakRatio')}`)
  if (num('statusProbability')) extra.push(`效果命中 ${pct('statusProbability')}`)
  if (num('statusResistance')) extra.push(`效果抵抗 ${pct('statusResistance')}`)
  if (num('healRatio')) extra.push(`治疗加成 ${pct('healRatio')}`)
  if (extra.length) lines.push(extra.join('　'))
  return lines
}

// ===== 榜单实现 =====

/**
 * 遗器 / 伤害排名：GET /api/v1/user_relic/ranking
 *   type       role（遗器总分）/ damage（伤害数值）
 *   role_id    角色 item_id
 *   role_level 80 / 70 / 60
 *   role_rank  星魂 0-6，空串表示不限
 * 返回 rows: [{ item_id, level, uid, relic_point, skill1..skill4, user_case:{ nick_name } }]
 */
async function buildSrRank(arg, mode) {
  const isDamage = mode === 'damage'
  const label = isDamage ? '伤害' : '遗器'
  const usage =
    `用法：%星铁${label}排名 <角色名> [80|70|60] [星魂0-6] [数量]\n` +
    `例：%星铁${label}排名 流萤`
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return usage

  let keyword = ''
  let level = 80
  let rank = null
  let count = 10
  for (const token of tokens) {
    const levelHit = token.match(/^(80|70|60)级?$/)
    if (levelHit) { level = Number(levelHit[1]); continue }
    if (/星魂|影画/.test(token)) {
      const rankHit = token.match(/([0-6])/)
      if (rankHit) { rank = Number(rankHit[1]); continue }
    }
    if (/^\d+$/.test(token)) { count = limitOf(token, 10, 30); continue }
    if (!keyword) keyword = token
  }
  if (!keyword) return usage

  const role = await resolveSrRole(keyword)
  if (!role) return `未找到角色「${keyword}」，可先用【%星铁榜单帮助】查看用法。`

  const subtitle = [
    `${level} 级`,
    rank === null ? '不限星魂' : `${rank} 星魂`,
    isDamage ? '伤害数值' : '按遗器总分排序',
  ]
  let data
  try {
    data = await request('/api/v1/user_relic/ranking', {
      limit: 50,
      offset: 0,
      type: isDamage ? 'damage' : 'role',
      role_id: role.item_id,
      role_level: level,
      role_rank: rank === null ? '' : rank,
      part_index: null,
      weapon_id: null,
    }, SR_HOST)
  } catch (err) {
    // 工坊在重算统计时会返回「数据统计中」，属于暂时无数据而非接口故障
    if (/统计中/.test(err?.message || '')) {
      return `星穹铁道工坊 · ${role.nick_name} ${label}排名\n${subtitle.join(' / ')}\n\n${err.message}\n过几分钟再试。`
    }
    throw err
  }

  const rows = Array.isArray(data?.rows) ? data.rows : []
  const skillName = data?.skill_name || ''
  if (isDamage && skillName) subtitle[2] = skillName
  const caption = subtitle.join(' / ')
  if (!rows.length) {
    return `星穹铁道工坊 · ${role.nick_name} ${label}排名\n${caption}\n\n暂无符合条件的记录（该角色可能未开放统计）。`
  }

  const lines = [`星穹铁道工坊 · ${role.nick_name} ${label}排名`, caption, '']
  rows.slice(0, count).forEach((row, index) => {
    const name = row?.user_case?.nick_name || `UID ${row?.uid ?? '?'}`
    const value = isDamage ? damageText(damageOf(row)) : Number(row?.relic_point || 0).toFixed(1)
    lines.push(`${String(index + 1).padStart(2, '0')}. ${fit(name, 20)}${value}`)
  })
  lines.push('', `共 ${rows.length} 条（接口单页 50 条），展示前 ${Math.min(count, rows.length)} 名。`)
  lines.push('数据来源：星穹铁道工坊角色柜用户。')
  return lines.join('\n')
}

/**
 * 全服配装统计：GET /api/v1/role/grad_stat
 * 返回 position、rank_stat（星魂分布）、weapon_stat（光锥）、relic_stat（遗器套装）。
 * 实测指定等级会返回空数据，此时回退为不限等级并加注说明。
 */
async function buildSrGradStat(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return '用法：%星铁配装 <角色名> [70级]\n例：%星铁配装 黄泉'

  let level = -1
  const names = []
  for (const token of tokens) {
    const levelHit = token.match(/^(80|70|60)级?$/)
    if (levelHit) { level = Number(levelHit[1]); continue }
    names.push(token)
  }
  const keyword = names.join('')
  if (!keyword) return '请提供角色名，例：%星铁配装 黄泉'

  const role = await resolveSrRole(keyword)
  if (!role) return `未找到角色「${keyword}」，可先用【%星铁遗器排名】确认角色名。`

  let data = await request('/api/v1/role/grad_stat', { item_id: role.item_id, level, rank: -1 }, SR_HOST)
  let note = ''
  if (!data && level !== -1) {
    level = -1
    note = '\n注：该等级无统计样本，已回退为不限等级。'
    data = await request('/api/v1/role/grad_stat', { item_id: role.item_id, level: -1, rank: -1 }, SR_HOST)
  }
  const weaponStat = Array.isArray(data?.weapon_stat) ? [...data.weapon_stat] : []
  const relicStat = Array.isArray(data?.relic_stat) ? [...data.relic_stat] : []
  if (!weaponStat.length && !relicStat.length) {
    return `星穹铁道工坊 · ${role.nick_name} 全服配装\n\n该角色暂未开放配装统计（工坊侧显示「尚未开放」）。`
  }

  const [guangs, relics] = await Promise.all([srGuangs(), srRelics()])
  const weaponTotal = weaponStat.reduce((sum, item) => sum + Number(item?.weapon_count || 0), 0)
  const relicTotal = relicStat.reduce((sum, item) => sum + Number(item?.set_info_count || 0), 0)
  const rankStat = Array.isArray(data?.rank_stat) ? [...data.rank_stat] : []
  const rankTotal = rankStat.reduce((sum, item) => sum + Number(item?.rank_count || 0), 0)

  const lines = [
    `星穹铁道工坊 · ${role.nick_name} 全服配装`,
    `${data?.position ? `定位 ${data.position}｜` : ''}${level === -1 ? '不限等级' : `${level} 级`}｜样本 ${countText(weaponTotal)}份`,
    '',
  ]
  lines.push('光锥使用率：')
  weaponStat
    .sort((a, b) => Number(b?.weapon_count || 0) - Number(a?.weapon_count || 0))
    .slice(0, 5)
    .forEach((item, index) => {
      const weaponId = String(item?.weapon_id ?? '')
      const name = weaponId === 'other' ? '其他光锥' : (guangs.get(weaponId) || `光锥${weaponId}`)
      lines.push(`  ${index + 1}. ${fit(name, 20)}${percent(item?.weapon_count, weaponTotal)}  ${countText(item?.weapon_count)}份`)
    })

  const relicRows = relicStat
    .map(item => ({ parts: parseSetInfo(item?.set_info), count: Number(item?.set_info_count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
  if (relicRows.length) {
    lines.push('', '遗器套装：')
    relicRows.forEach((row, index) => {
      const label = row.parts
        .filter(part => part.setId !== 'other')
        .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
        .join(' + ') || '其他散件'
      lines.push(`  ${index + 1}. ${fit(label, 34)}${percent(row.count, relicTotal)}`)
    })
  }

  if (rankTotal) {
    const topRanks = rankStat
      .sort((a, b) => Number(b?.rank_count || 0) - Number(a?.rank_count || 0))
      .slice(0, 3)
      .map(item => `${item.rank}魂 ${percent(item.rank_count, rankTotal)}`)
    lines.push('', `星魂分布：${topRanks.join('｜')}`)
  }
  lines.push('', '数据来源：星穹铁道工坊角色柜用户，按高练度玩家统计。' + note)
  return lines.join('\n')
}

/**
 * 单玩家练度：POST /api/v1/user_role/ranking（需签名头）
 * item_json.combatValues 是算好的面板终值，遗器与光锥为原始 ID。
 */
async function buildSrDetail(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  const uid = tokens.find(token => /^\d{6,}$/.test(token))
  const nameToken = tokens.find(token => !/^\d{6,}$/.test(token))
  if (!uid || !nameToken) {
    return '用法：%星铁练度 <UID> <角色名>\n例：%星铁练度 <9位UID> 流萤\n\n该接口必须带角色，单独查玩家请先用【%星铁遗器排名 <角色>】找到 UID。'
  }

  const role = await resolveSrRole(nameToken)
  if (!role) return `未找到角色「${nameToken}」，可先用【%星铁榜单帮助】查看用法。`

  const data = await signedPost('/api/v1/user_role/ranking', {
    uid,
    type: 'ranking',
    refresh: false,
    item_id: role.item_id,
  }, SR_HOST)
  const roles = Array.isArray(data?.roles) ? data.roles : []
  if (!roles.length) {
    return `未查询到该 UID 的练度数据。\n该玩家可能未在星穹铁道工坊上传角色柜，或尚未达到纳入统计的条件。`
  }

  const row = roles[0]
  const itemJson = row?.item_json || {}
  const [guangs, relics] = await Promise.all([srGuangs(), srRelics()])
  const nick = data?.nick_name || '未知玩家'
  const playerLevel = data?.level ? ` Lv.${data.level}` : ''
  const weaponId = String(itemJson?.weapon?.id ?? row?.weapon_id ?? '')
  const weaponName = weaponId ? (guangs.get(weaponId) || `光锥${weaponId}`) : '未装备'
  const refine = itemJson?.weapon?.rankLevel
  const sets = parseSetInfo(row?.set_info)
    .filter(part => part.setId !== 'other')
    .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
    .join(' + ') || '未知'
  const updatedAt = formatTime(row?.updated_at)

  const lines = [
    `星穹铁道工坊 · ${role.nick_name}`,
    `玩家 ${nick}${playerLevel}`,
    '',
    `角色：Lv.${row?.level || role.level || '-'}　星魂 ${itemJson?.rank ?? 0}　遗器总分 ${Number(row?.relic_point || 0).toFixed(1)}`,
    `光锥：${weaponName}${refine ? `　叠影 ${refine}` : ''}`,
    `遗器：${sets}`,
    '',
    '面板：',
    ...panelText(itemJson?.combatValues),
  ]
  if (updatedAt) lines.push('', `数据更新：${updatedAt}`)
  lines.push('', '数据来自玩家上传至工坊的角色柜，仅供参考。')
  return lines.join('\n')
}

// 欧非榜口径：type 对应小程序页签，sort 只有欧 / 氪可用（非的口径服务端 SQL 报错）
const SR_CARD_TYPES = {
  综合: 'all', 全部: 'all', all: 'all',
  角色: 'role', 角色池: 'role', role: 'role',
  光锥: 'guang', 光锥池: 'guang', guang: 'guang',
  常驻: 'common', 常驻池: 'common', common: 'common',
  连up: 'up', up: 'up',
  连歪: 'wai', wai: 'wai',
}
const SR_CARD_SORTS = { 欧: 'ou', ou: 'ou', 非: 'fei', fei: 'fei', 氪: 'ke', ke: 'ke' }
const SR_CARD_TYPE_LABEL = {
  all: '综合', role: '角色池', guang: '光锥池', common: '常驻池', up: '最多连 UP', wai: '最多连歪',
}
const SR_CARD_SORT_LABEL = { ou: '欧', fei: '非', ke: '氪' }

/** 工坊对外只给脱敏 UID，这里按小程序规则遮住中间位 */
function maskUid(uid) {
  const text = String(uid ?? '')
  return text.length > 6 ? `${text.slice(0, 2)}****${text.slice(6)}` : text
}

/**
 * 抽卡欧非榜：GET /api/v1/card_ranking/ranking_v4
 * 注意：sort=fei 服务端报错；up / wai 仅在 sort=ke 下返回有效字段。
 */
async function buildSrCardRank(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  let type = 'all'
  let sort = 'ou'
  let count = 10
  for (const token of tokens) {
    const key = token.toLowerCase()
    if (/^\d+$/.test(token)) { count = limitOf(token, 10, 30); continue }
    if (SR_CARD_SORTS[token] || SR_CARD_SORTS[key]) { sort = SR_CARD_SORTS[token] || SR_CARD_SORTS[key]; continue }
    if (SR_CARD_TYPES[token] || SR_CARD_TYPES[key]) { type = SR_CARD_TYPES[token] || SR_CARD_TYPES[key]; continue }
  }

  const usage = '用法：%星铁欧非榜 [综合|角色|光锥|常驻|连UP|连歪] [欧|氪] [数量]\n例：%星铁欧非榜 综合 欧 10'
  if (sort === 'fei') {
    return `${usage}\n\n「非」这个排序工坊接口当前会报错（服务端 SQL 异常），暂时只支持欧 / 氪。`
  }
  const effectiveSort = type === 'up' || type === 'wai' ? 'ke' : sort

  const data = await request('/api/v1/card_ranking/ranking_v4', {
    limit: 50,
    offset: 0,
    ranking_type: type,
    sort: effectiveSort,
  }, SR_HOST)
  const rows = Array.isArray(data?.rows) ? data.rows : []
  if (!rows.length) throw new Error('榜单暂无数据')

  const lines = [
    `星穹铁道工坊 · 抽卡欧非榜（${SR_CARD_TYPE_LABEL[type] || type} / ${SR_CARD_SORT_LABEL[effectiveSort] || effectiveSort}）`,
    `显示前 ${Math.min(count, rows.length)} 名｜UID 由工坊脱敏`,
    '',
  ]
  rows.slice(0, count).forEach((row, index) => {
    const no = String(index + 1).padStart(2, '0')
    const uid = maskUid(row?.uid)
    if (type === 'up' || type === 'wai') {
      const valueKey = type === 'up' ? 'max_role_keep_up' : 'max_role_keep_no_up'
      const label = type === 'up' ? '连 UP' : '连歪'
      lines.push(`${no}. ${pad(uid, 13)}${label} ${pad(row?.[valueKey] ?? '-', 3)}次　总抽 ${row?.draw_total ?? 0}`)
      return
    }
    if (effectiveSort === 'ke') {
      lines.push(
        `${no}. ${pad(uid, 13)}总抽 ${pad(row?.draw_total ?? 0, 6)}五星 ${pad(row?.five_total ?? 0, 4)}` +
        `UP 平均 ${row?.xbd_avg ?? '-'}`
      )
      return
    }
    const avgField = { all: 'all_avg_total', role: 'role_avg_total', guang: 'guang_avg_total', common: 'common_avg_total' }[type] || 'all_avg_total'
    const drawField = { all: 'all_draw_total', role: 'role_draw_total', guang: 'guang_draw_total', common: 'common_draw_total' }[type] || 'all_draw_total'
    const fiveField = { all: 'all_five_total', role: 'role_five_total', guang: 'guang_five_total', common: 'common_five_total' }[type] || 'all_five_total'
    lines.push(
      `${no}. ${pad(uid, 13)}抽数 ${pad(row?.[drawField] ?? 0, 6)}五星 ${pad(row?.[fiveField] ?? 0, 4)}` +
      `平均 ${row?.[avgField] ?? '-'}`
    )
  })
  lines.push('', usage)
  return lines.join('\n')
}

// 体系字典：/api/v1/config/system_data_v2 内的 game_dict_team_system（整包约 230 KB）。
let srSystemDict = null
let srSystemDictAt = 0
const SR_FALLBACK_SYSTEMS = { zhuiji: '追击队', zhishang: '直伤队', jipo: '击破队', dot: 'DOT队' }

async function srTeamSystems() {
  if (srSystemDict && fresh(srSystemDictAt)) return srSystemDict
  const map = new Map(Object.entries(SR_FALLBACK_SYSTEMS))
  try {
    const data = await request('/api/v1/config/system_data_v2', {}, SR_HOST)
    const config = (data?.system_config || []).find(item => item?.config_key === 'game_dict_team_system')
    for (const item of config?.config_json || []) {
      if (item?.value && item?.name) map.set(String(item.value), String(item.name))
    }
  } catch (err) {
    logError('srTeamSystems', err)
  }
  srSystemDict = map
  srSystemDictAt = Date.now()
  return map
}

function starText(level) {
  const num = Math.max(0, Math.min(5, Number(level) || 0))
  return '★'.repeat(num) + '☆'.repeat(5 - num)
}

/**
 * 队伍体系推荐：GET /api/v1/team_system/list
 * 返回 31 套固定队伍：team_name、team_members、team_member_names、team_system、
 * level（推荐星级 1-5）、more_config.lowers（可替换位）。筛选按成员 ID 或成员名命中。
 */
async function buildSrTeam(arg) {
  const tokens = String(arg || '').trim().split(/\s+/).filter(Boolean)
  let keyword = ''
  let count = 10
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { count = limitOf(token, 10, 30); continue }
    if (!keyword) keyword = token
  }

  const [data, systems, roles] = await Promise.all([
    request('/api/v1/team_system/list', {}, SR_HOST),
    srTeamSystems(),
    srRoles(),
  ])
  const all = Array.isArray(data?.rows) ? data.rows : []
  if (!all.length) throw new Error('队伍推荐暂无数据')

  let rows = all
  let title = `队伍体系推荐（共 ${all.length} 套）`
  if (keyword) {
    const role = await resolveSrRole(keyword)
    const match = (row) => {
      const ids = String(row?.team_members || '').split(',')
      const names = String(row?.team_member_names || '').split(',')
      if (role && (ids.includes(String(role.item_id)) || names.includes(role.nick_name))) return true
      return names.some(name => name.includes(keyword))
    }
    rows = all.filter(match)
    title = `含「${role?.nick_name || keyword}」的队伍（${rows.length} 套）`
  }
  if (!rows.length) {
    return `星穹铁道工坊 · 队伍体系推荐\n\n没有找到包含「${keyword}」的队伍，换个角色或直接发【%星铁配队】看全部。`
  }

  const nameOf = token => {
    const text = String(token ?? '')
    const hit = roles.find(role => String(role?.item_id) === text || role?.nick_name === text)
    return hit?.nick_name || text
  }
  const sorted = [...rows].sort((a, b) => (Number(b?.level) || 0) - (Number(a?.level) || 0))

  const lines = [`星穹铁道工坊 · ${title}`, `按推荐星级排序，显示前 ${Math.min(count, sorted.length)} 套`, '']
  sorted.slice(0, count).forEach(row => {
    const systemName = systems.get(String(row?.team_system || '')) || row?.team_system || '其他'
    const members = String(row?.team_member_names || '').split(',').filter(Boolean).map(nameOf)
    lines.push(`${starText(row?.level)} ${row?.team_name || '未命名队伍'}  [${systemName}]`)
    lines.push(`  ${members.join(' / ')}`)
    const lowers = Array.isArray(row?.more_config?.lowers) ? row.more_config.lowers : []
    const swap = lowers
      .map(item => {
        const main = nameOf(item?.item_id)
        const others = (item?.other_ids || []).map(nameOf).filter(Boolean)
        if (!main) return ''
        return `${item?.name || '替换'} ${main}${others.length ? `→${others.join('/')}` : ''}`
      })
      .filter(Boolean)
    if (swap.length) lines.push(`  可换：${swap.join(' ｜ ')}`)
    lines.push('')
  })
  lines.push('数据来源：星穹铁道工坊队伍体系推荐；发送【%星铁配队 <角色名>】可按角色筛选。')
  return lines.join('\n')
}

const HELP_TEXT = [
  '星穹铁道工坊榜单',
  '%星铁遗器排名 <角色名> [80|70|60] [星魂0-6] [数量]   遗器练度排行',
  '%星铁伤害排名 <角色名> [80|70|60] [星魂0-6] [数量]   伤害排行（口径由工坊给出）',
  '%星铁配装 <角色名> [70级]                           全服光锥与遗器套装使用率',
  '%星铁配队 [角色名] [数量]                           队伍体系推荐（含星级与可替换位）',
  '%星铁欧非榜 [综合|角色|光锥|常驻|连UP|连歪] [欧|氪] [数量]   抽卡欧非排行',
  '%星铁练度 <UID> <角色名>                            玩家面板 / 光锥 / 遗器',
  '',
  '数据均来自星穹铁道工坊公开接口，无需绑定账号。',
  '绝区零侧见「绝区零榜单帮助」，两者前缀可混用（星铁 / 星穹铁道 / sr / hsr）。',
].join('\n')

export class sr_workshop extends plugin {
  constructor() {
    super({
      name: '[米哈游]星铁工坊榜单',
      dsc: '星穹铁道工坊遗器 / 伤害排名、配装统计、队伍推荐、欧非榜、玩家练度',
      event: 'message',
      /* ⚠ 数值越小越先执行（框架用 lodash.orderBy asc 排序）。
         比绝区零工坊(-36000) 再小 1：星铁入口语义独立，但同样要抢在
         ZZZ-Plugin(-30000) 之前，否则「%星铁练度排名」会被它当成绝区零面板排名。 */
      priority: pluginPriority('sr_workshop', -36001),
      rule: [
        // 练度排名必须排在练度详情之前，否则「%星铁练度排名」会被详情规则截走
        { reg: RE_SR_RANK, fnc: 'srRank' },
        { reg: RE_SR_DMG, fnc: 'srDamageRank' },
        { reg: RE_SR_GRAD, fnc: 'srGradStat' },
        { reg: RE_SR_CARD, fnc: 'srCardRank' },
        { reg: RE_SR_TEAM, fnc: 'srTeam' },
        { reg: RE_SR_DETAIL, fnc: 'srDetail' },
        { reg: RE_SR_HELP, fnc: 'help' },
      ],
    })
  }

  /**
   * 在 accept 阶段先接住星铁指令。
   *
   * 原因与 zzz_workshop 相同：accept 先于所有 rule 执行，命中即结束事件。
   * ZZZ-Plugin 的 accept 会把「%星铁练度排名」当成绝区零面板排名接走，
   * 所以星铁消息必须在这里显式接管并 return。
   *
   * ⚠ 只接「星铁 / 星穹铁道 / sr / hsr」开头的消息：
   *   %星铁X / %星穹铁道X / %srX / %hsrX
   * 框架可能已把 % 改写成 #绝区零，但那只会作用于 zzzReg（%|绝区零|绝区）开头，
   * 「%星铁…」不变形，因此这里直接匹配原文即可。
   */
  async accept(e) {
    const msg = String(e?.msg || '').trim()
    const stripped = msg.replace(/^[#%]+\s*/, '').replace(/^米哈游\s*/i, '')
    if (!/^(?:星铁|星穹铁道|sr|hsr)/i.test(stripped)) return false
    for (const [reg, fnc] of [
      [RE_SR_RANK, 'srRank'],
      [RE_SR_DMG, 'srDamageRank'],
      [RE_SR_GRAD, 'srGradStat'],
      [RE_SR_CARD, 'srCardRank'],
      [RE_SR_TEAM, 'srTeam'],
      [RE_SR_DETAIL, 'srDetail'],
      [RE_SR_HELP, 'help'],
    ]) {
      if (!reg.test(msg)) continue
      await this[fnc](e)
      return 'return'
    }
    return false
  }

  async srRank(e) {
    try {
      return await e.reply(await buildSrRank(RE_SR_RANK.exec(e.msg)?.[1] || '', 'relic'))
    } catch (err) {
      logError('srRank', err)
      return await e.reply(`获取星铁遗器排名失败：${err?.message || err}`)
    }
  }

  async srDamageRank(e) {
    try {
      return await e.reply(await buildSrRank(RE_SR_DMG.exec(e.msg)?.[1] || '', 'damage'))
    } catch (err) {
      logError('srDamageRank', err)
      return await e.reply(`获取星铁伤害排名失败：${err?.message || err}`)
    }
  }

  async srGradStat(e) {
    try {
      return await e.reply(await buildSrGradStat(RE_SR_GRAD.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('srGradStat', err)
      return await e.reply(`获取星铁配装统计失败：${err?.message || err}`)
    }
  }

  async srCardRank(e) {
    try {
      return await e.reply(await buildSrCardRank(RE_SR_CARD.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('srCardRank', err)
      return await e.reply(`获取星铁欧非榜失败：${err?.message || err}`)
    }
  }

  async srTeam(e) {
    try {
      return await e.reply(await buildSrTeam(RE_SR_TEAM.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('srTeam', err)
      return await e.reply(`获取队伍推荐失败：${err?.message || err}`)
    }
  }

  async srDetail(e) {
    try {
      return await e.reply(await buildSrDetail(RE_SR_DETAIL.exec(e.msg)?.[1] || ''))
    } catch (err) {
      logError('srDetail', err)
      return await e.reply(`查询星铁练度失败：${err?.message || err}`)
    }
  }

  async help(e) {
    return await e.reply(HELP_TEXT)
  }
}
