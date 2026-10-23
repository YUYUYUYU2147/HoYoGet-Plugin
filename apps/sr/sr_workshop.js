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
//   · 伤害榜的数值字段不固定：终结技在 skill3、强化战技在 skill2，按 skill1..skill4
//     取第一个非零；口径名称在 type=role 的响应里（skill_name），type=damage 不返回。
//   · 榜单行只有昵称与 UID，没有头像；角色头像用 miao 的本地图，缺失则退回首字。
//
// 说明：接口随时可能调整或关闭，失败时只回提示，不抛出未捕获异常。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render } from '#HoYoGet'
import { SR_HOST, request, signedPost, parseSetInfo } from '../../system/workshop_api.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NAMES_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'sr_workshop_names.json')
/* 图标资源根：miao 卸载后指向本插件 resources（meta-sr 内角色/光锥图标齐全） */
const MIAO_RES = '../../../../../plugins/HoYoGet-Plugin/resources'
const CACHE_TTL = 6 * 3600 * 1000

// 指令正则：规则表与参数提取共用，避免两处写法不一致
//
// 星铁前缀有一堆等价写法，框架（lib/plugins/loader.js 的 srReg）会在 accept 之前
// 把它们统一改写成「#星铁」：
//   *遗器排名 / 崩铁遗器排名 / 星穹遗器排名 / 星轨遗器排名 / 铁道遗器排名 → #星铁遗器排名
// 所以线上看到的基本都是 #星铁；但 * 开头本身就是星铁标记（不带游戏名），
// 单测或直接调用处理函数时拿到的是原文，两种形态都必须认。
const SR_PREFIX = '(?:米哈游)?(?:星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道|sr|hsr)'

/**
 * 星铁指令的三种写法，都能命中同一条规则：
 *   ① *遗器排名 流萤            —— `*` 是星铁标记，后面可省游戏名，也可直接跟角色名
 *   ② *流萤遗器排名 / *流萤 遗器排名
 *   ③ 星铁遗器排名 流萤 / 崩铁伤害排名 流萤 / sr配队 流萤
 *
 * ①③ 由框架改写后最终都是「#星铁…」；②只有 `*` 能表达（`星铁流萤遗器排名` 不像人话）。
 * 参数捕获 groups 依次为：starRole（`*` 后角色名，可能为空）、starRest（`*` 后剩余）、tail（游戏名后的参数）。
 */
const SR_ARG = String.raw`(?:\s+(.+))?`
/* 两种前缀形态，各自独立成完整正则的分支（不用外层 (?:…|…) 包，避免拼接时括号对不上） */
const srReg = (body, { avoid = '' } = {}) => {
  const head = String.raw`[#%]*\s*` + SR_PREFIX + String.raw`\s*`
  const star = String.raw`[#%]*[\*＊]\s*(?:` + SR_PREFIX + String.raw`\s*)?`
  /* avoid：`*` 分支的角色名里不能出现这些词，否则「*流萤伤害排名」会被遗器规则
     当成角色名「流萤伤害」接走（`*` 分支允许任意角色名，必须显式排除）。
     同时排除别的游戏标记：`*绝区零配装` 之类是绝区零的写法，不能算星铁。 */
  const blocked = ['绝区零', 'zzz', '原神', '崩坏3', '崩坏三', avoid].filter(Boolean).join('|')
  const lead = String.raw`(?:(?!` + blocked + String.raw`).)*?`
  /* 三个分支：
       ① 游戏名 + 榜单词      星铁遗器排名 流萤 / #星铁配装 黄泉
       ② 游戏名 + 角色名 + 榜单词  #星铁流萤遗器排名（喵喵的 profileRank 也吃这种，必须抢在前面）
       ③ * + 角色名? + 榜单词   *流萤遗器排名 / *遗器排名 流萤 */
  return new RegExp(
    `^(?:${head}(?:${body})${SR_ARG}` +
    `|${head}(${lead})(?:${body})${SR_ARG}` +
    `|${star}(${lead})(?:${body})${SR_ARG})$`,
    'i',
  )
}

const RE_SR_RANK = srReg(String.raw`(?:遗器)?(?:练度)?排名`, { avoid: '伤害|全球|世界|阿卡夏|akasha|幽境' })
const RE_SR_DMG = srReg(String.raw`伤害(?:排名|排行)`)
const RE_SR_GRAD = srReg(String.raw`(?:角色)?配装(?:统计)?`)
const RE_SR_CARD = srReg(String.raw`(?:抽卡|欧非)(?:榜|排行)?`)
const RE_SR_TEAM = srReg(String.raw`(?:队伍)?(?:体系)?(?:推荐|配队)`)
const RE_SR_DETAIL = srReg(String.raw`(?:查)?练度`)
const RE_SR_HELP = srReg(String.raw`榜单帮助`)

/**
 * 从命中结果里取参数：`*` 分支的角色名在 group 1、参数在 group 2，
 * 游戏名分支参数在 group 1。统一成「角色名 + 其余参数」。
 */
function srArgs(reg, msg) {
  const hit = reg?.exec(String(msg || ''))
  if (!hit) return ''
  /* 三个分支的捕获组在结果里的位置并不固定（取决于前面的分支是否参与匹配），
     统一按「最后一个有定义的组是参数，前面那个是角色名」处理：
       ① 游戏名 + 榜单词          → 只有一组（参数）
       ② 游戏名 + 角色名 + 榜单词  → 角色名、参数
       ③ * 标记                   → 角色名、参数（角色名可为空） */
  const defined = []
  for (let i = 1; i < hit.length; i++) {
    if (hit[i] !== undefined) defined.push(i)
  }
  if (!defined.length) return ''
  const argIndex = defined[defined.length - 1]
  const roleIndex = defined.length > 1 ? defined[defined.length - 2] : -1
  const role = roleIndex > 0 ? String(hit[roleIndex] || '').trim() : ''
  const rest = String(hit[argIndex] || '').trim()
  return [role, rest].filter(Boolean).join(' ')
}

/**
 * 练度指令的参数顺序：`*练度 <UID> <角色>` 与 `*流萤练度 <UID>` 两种写法。
 * 后者经 srArgs 拼出来是「角色名 UID」，这里把 UID 提前，统一成 buildSrDetail 认识的形式。
 */
/**
 * 角色名前置写法（`*流萤配装` / `*流萤配队` / `*流萤伤害排名`）会把角色名拼到参数最前，
 * 若用户又写了一遍（`*流萤配队 流萤`），去掉重复的那个。
 */
function dedupeRole(args, role) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean)
  if (!role) return tokens.join(' ')
  const seen = new Set()
  const out = []
  for (const token of tokens) {
    if (token === role) {
      if (seen.has('role')) continue
      seen.add('role')
    }
    out.push(token)
  }
  return out.join(' ')
}

function orderDetailArgs(args) {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean)
  const uid = tokens.find(t => /^\d{6,}$/.test(t))
  const name = tokens.find(t => !/^\d{6,}$/.test(t))
  return [uid, name].filter(Boolean).join(' ')
}

/** 消息是否以星铁前缀开头（accept 用，只做粗筛，最终由具体规则判定） */
const SR_PREFIX_RE = new RegExp(`^(?:[#%]*\\s*${SR_PREFIX}|[#%]*[\\*＊])`, 'i')

// ===== 本地名称表（角色 / 光锥）=====

/**
 * 角色与光锥的中文名来自 miao-plugin 的 meta-sr，已导出为本文件的 JSON 快照
 * （system/default/sr_workshop_names.json）。用快照而不是实时读 miao 目录，
 * 是为了在没装 miao 或它改结构时仍能出图；表里没有的新角色回退用工坊返回的名字。
 */
let NAMES = null
function localNames() {
  if (NAMES) return NAMES
  try {
    NAMES = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'))
  } catch (_) {
    NAMES = { chars: {}, weapons: {} }
  }
  return NAMES
}

/** 读本地 PlayerData 的游戏昵称（不依赖工坊返回的 nick_name） */
function localPlayerName(uid) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'PlayerData', 'sr', `${uid}.json`), 'utf8'))
    return String(d?.name || '').trim()
  } catch (_) { return '' }
}

/** 本地角色头像：按角色名找 meta-sr/character/<名>/imgs/face.webp；
 *  工坊名可能写成「阮梅 / 阮•梅 / 「大黑塔」」，这里规范化后再匹配目录。 */
let _faceDirMap = null
function faceDirMap() {
  if (_faceDirMap) return _faceDirMap
  const map = new Map()
  try {
    const root = path.join(PLUGIN_ROOT, 'resources', 'meta-sr', 'character')
    for (const dir of fs.readdirSync(root)) {
      map.set(dir.replace(/[·•・\s「」『』]/g, ''), dir)
    }
  } catch (_) { /* ignore */ }
  _faceDirMap = map
  return map
}
function localFace(name) {
  const clean = String(name || '').trim()
  if (!clean) return ''
  const norm = clean.replace(/[·•・\s「」『』]/g, '')
  const dirs = [clean, norm, faceDirMap().get(norm)].filter(Boolean)
  for (const dir of new Set(dirs)) {
    try {
      const file = path.join(PLUGIN_ROOT, 'resources', 'meta-sr', 'character', dir, 'imgs', 'face.webp')
      if (fs.existsSync(file)) return `${MIAO_RES}/meta-sr/character/${dir}/imgs/face.webp`
    } catch (_) { /* ignore */ }
  }
  return ''
}

// ===== 名称缓存（接口）=====

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
  if (exact) return enrichRole(exact)
  return enrichRole(
    rows.find(row => (row?.nick_name || '').includes(keyword) || keyword.includes(row?.nick_name || '')) || null,
  )
}

/**
 * 星级与属性：工坊 /api/v1/game_role/list 只返回 item_id + nick_name，
 * 这两项从本地快照补齐（miao 的 meta-sr），用于图上的标签与底色。
 */
function enrichRole(role) {
  if (!role) return role
  const local = localNames().chars?.[String(role.item_id)] || {}
  return {
    ...role,
    star: Number(role.star) || local.star || 0,
    elem: role.elem || local.elem || '',
    path: role.path || local.path || '',
  }
}

/** 光锥 id → 中文名：工坊表优先，其次本地快照 */
function weaponName(id) {
  const key = String(id ?? '')
  if (!key) return ''
  return cache.guangs?.get(key) || localNames().weapons?.[key]?.name || `光锥${key}`
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

/** 伤害榜的数值字段不固定：单体技能落在 skill1，强化战技落在 skill2，终结技在 skill3 */
function damageOf(row) {
  for (let index = 1; index <= 4; index++) {
    const value = Number(row?.[`skill${index}`])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

function damageText(value) {
  const num = Number(value) || 0
  if (!num) return '-'
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

/** 把面板拆成键值对，图里按三列铺开 */
function panelBoard(values) {
  const num = key => Number(values?.[key]) || 0
  const num1 = key => num(key).toFixed(1)
  const pct = key => `${(num(key) * 100).toFixed(1)}%`
  /* 生命/攻击/防御可能上万，超过 10000 用「万」缩写，避免数字撑破格子 */
  const big = key => {
    const n = num(key)
    return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(Math.round(n))
  }
  const items = [
    { label: '生命', value: big('hpFinal') },
    { label: '攻击', value: big('attackFinal') },
    { label: '防御', value: big('defenseFinal') },
    { label: '速度', value: num1('speedFinal') },
    { label: '暴击率', value: pct('criticalChance') },
    { label: '暴击伤害', value: pct('criticalDamage') },
  ]
  if (num('stanceBreakRatio')) items.push({ label: '击破特攻', value: pct('stanceBreakRatio') })
  if (num('statusProbability')) items.push({ label: '效果命中', value: pct('statusProbability') })
  if (num('statusResistance')) items.push({ label: '效果抵抗', value: pct('statusResistance') })
  if (num('healRatio')) items.push({ label: '治疗加成', value: pct('healRatio') })
  if (num('speedFinal') === 0 && num('hpFinal') === 0) return []
  return items
}

// ===== 榜单实现 =====

/**
 * 把榜单接口的原始行整理成渲染/文本共用的结构。
 * 接口行只有 { uid, relic_point, skill1..4, user_case:{ nick_name, level } }，
 * 没有名次字段（rank 是星魂档位，不是名次），名次按接口返回顺序。
 */
function rankRows(rows, { isDamage, offset = 0 }) {
  return rows.map((row, index) => {
    const uid = String(row?.uid ?? '')
    return {
      rank: offset + index + 1,
      uid,
      uidText: uid ? `${uid.slice(0, 2)}${'*'.repeat(Math.max(0, uid.length - 3))}${uid.slice(-1)}` : '未知',
      nickname: row?.user_case?.nick_name || `UID ${uid || '?'}`,
      level: Number(row?.user_case?.level) || 0,
      point: Number(row?.relic_point) || 0,
      pointText: Number(row?.relic_point || 0).toFixed(1),
      damage: isDamage ? damageOf(row) : 0,
      damageText: isDamage ? damageText(damageOf(row)) : '',
    }
  })
}

/**
 * 遗器 / 伤害排名：GET /api/v1/user_relic/ranking
 *   type       role（遗器总分）/ damage（伤害数值）
 *   role_id    角色 item_id
 *   role_level 80 / 70 / 60
 *   role_rank  星魂 0-6，空串表示不限
 */
async function buildSrRank(arg, mode) {
  const isDamage = mode === 'damage'
  const label = isDamage ? '伤害' : '遗器'
  const usage =
    `用法：*${label}排名 <角色名> [80|70|60] [星魂0-6] [数量]\n` +
    `例：*${label}排名 流萤`
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
  if (!role) return `未找到角色「${keyword}」，可先用【*榜单帮助】查看用法。`

  const subtitle = [
    `${level} 级`,
    rank === null ? '不限星魂' : `${rank} 星魂`,
    isDamage ? '伤害数值' : '按遗器总分排序',
  ]

  /* 口径名（「终结技伤害」「强化战技超击破」）只在 type=role 的响应里，
     单独查伤害榜时拿不到，所以这里顺带取一次 role 榜，只为读 skill_name。
     失败不影响主流程。 */
  const wantsSkillName = isDamage
  let skillName = ''
  if (wantsSkillName) {
    try {
      const probe = await request('/api/v1/user_relic/ranking', {
        limit: 1, offset: 0, type: 'role', role_id: role.item_id,
        role_level: level, role_rank: rank === null ? '' : rank,
      }, SR_HOST)
      skillName = probe?.skill_name || ''
    } catch (_) { /* 仅用于显示口径，取不到就空着 */ }
  }
  if (isDamage && skillName) subtitle[2] = skillName

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
      return `星穹铁道工坊 · ${role.nick_name} ${label}排名\n${[...subtitle.slice(0, 2), isDamage ? '伤害数值' : subtitle[2]].join(' / ')}\n\n${err.message}\n过几分钟再试。`
    }
    throw err
  }

  const raw = Array.isArray(data?.rows) ? data.rows : []
  const rows = rankRows(raw, { isDamage })
  if (!rows.length) {
    return `星穹铁道工坊 · ${role.nick_name} ${label}排名\n${subtitle.join(' / ')}\n\n暂无符合条件的记录（该角色可能未开放统计）。`
  }

  const face = localFace(role.nick_name)
  return {
    mode: isDamage ? 'damage' : 'relic',
    title: role.nick_name,
    label,
    caption: subtitle.join(' · '),
    skillName: isDamage ? (skillName || '伤害') : '遗器总分',
    level,
    star: rank,
    levelText: `${level} 级`,
    rankText: rank === null ? '不限星魂' : `${rank} 星魂`,
    face,
    initial: String(role.nick_name || '?').slice(0, 1),
    rows: rows.slice(0, count),
    total: raw.length,
    count: Math.min(count, rows.length),
    isDamage,
  }
}

/** 榜单图渲染失败时的文字兜底（与 zzz_workshop 同一策略：至少把数据给到） */
function rankText(view) {
  if (typeof view === 'string') return view
  const lines = [`星穹铁道工坊 · ${view.title} ${view.label}排名`, view.caption, '']
  for (const row of view.rows) {
    const value = view.isDamage ? row.damageText : row.pointText
    lines.push(`${String(row.rank).padStart(2, '0')}. ${fit(row.nickname, 20)}${value}`)
  }
  lines.push('', `共 ${view.total} 条（接口单页 50 条），展示前 ${view.count} 名。`)
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
  if (!tokens.length) return '用法：*配装 <角色名> [70级]\n例：*配装 黄泉'

  let level = -1
  const names = []
  for (const token of tokens) {
    const levelHit = token.match(/^(80|70|60)级?$/)
    if (levelHit) { level = Number(levelHit[1]); continue }
    names.push(token)
  }
  const keyword = names.join('')
  if (!keyword) return '请提供角色名，例：*配装 黄泉'

  const role = await resolveSrRole(keyword)
  if (!role) return `未找到角色「${keyword}」，可先用【*遗器排名】确认角色名。`

  let data = await request('/api/v1/role/grad_stat', { item_id: role.item_id, level, rank: -1 }, SR_HOST)
  let note = ''
  if (!data && level !== -1) {
    level = -1
    note = '该等级无统计样本，已回退为不限等级。'
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

  const weaponRows = weaponStat
    .sort((a, b) => Number(b?.weapon_count || 0) - Number(a?.weapon_count || 0))
    .slice(0, 5)
    .map((item, index) => {
      const weaponId = String(item?.weapon_id ?? '')
      const name = weaponId === 'other' ? '其他光锥' : (guangs.get(weaponId) || weaponName(weaponId))
      const n = Number(item?.weapon_count || 0)
      return {
        no: index + 1,
        name,
        count: n,
        countText: `${countText(n)}份`,
        text: percent(n, weaponTotal),
        width: weaponTotal ? n / weaponTotal * 100 : 0,
      }
    })

  const relicRows = relicStat
    .map(item => ({ parts: parseSetInfo(item?.set_info), count: Number(item?.set_info_count || 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((row, index) => {
      const name = row.parts
        .filter(part => part.setId !== 'other')
        .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
        .join(' + ') || '其他散件'
      return {
        no: index + 1,
        name,
        count: row.count,
        text: percent(row.count, relicTotal),
        width: relicTotal ? row.count / relicTotal * 100 : 0,
      }
    })

  const rankRows = rankTotal
    ? rankStat
      .sort((a, b) => Number(b?.rank_count || 0) - Number(a?.rank_count || 0))
      .slice(0, 4)
      .map(item => ({
        rank: item.rank,
        text: percent(item.rank_count, rankTotal),
        width: rankTotal ? Number(item.rank_count || 0) / rankTotal * 100 : 0,
      }))
    : []

  return {
    view: 'grad',
    title: role.nick_name,
    subtitle: `${data?.position ? `定位 ${data.position}｜` : ''}${level === -1 ? '不限等级' : `${level} 级`}｜样本 ${countText(weaponTotal)} 份`,
    note,
    face: localFace(role.nick_name),
    initial: String(role.nick_name || '?').slice(0, 1),
    weapons: weaponRows,
    relics: relicRows,
    ranks: rankRows,
    stars: role.star ? '★'.repeat(Number(role.star)) : '',
    elem: role.elem || '',
    path: role.path || '',
  }
}

/** 配装图渲染失败时的文字兜底 */
function gradText(view) {
  if (typeof view === 'string') return view
  const lines = [`星穹铁道工坊 · ${view.title} 全服配装`, view.subtitle, '']
  lines.push('光锥使用率：')
  view.weapons.forEach(item => lines.push(`  ${item.no}. ${fit(item.name, 20)}${item.text}  ${item.countText}`))
  if (view.relics.length) {
    lines.push('', '遗器套装：')
    view.relics.forEach(item => lines.push(`  ${item.no}. ${fit(item.name, 34)}${item.text}`))
  }
  if (view.ranks.length) {
    lines.push('', `星魂分布：${view.ranks.map(i => `${i.rank}魂 ${i.text}`).join('｜')}`)
  }
  lines.push('', '数据来源：星穹铁道工坊角色柜用户，按高练度玩家统计。')
  if (view.note) lines.push(view.note)
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
    return '用法：*练度 <UID> <角色名>\n例：*练度 <9位UID> 流萤\n\n该接口必须带角色，单独查玩家请先用【*遗器排名 <角色>】找到 UID。'
  }

  const role = await resolveSrRole(nameToken)
  if (!role) return `未找到角色「${nameToken}」，可先用【*榜单帮助】查看用法。`

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
  const weaponLabel = weaponId ? (guangs.get(weaponId) || weaponName(weaponId)) : '未装备'
  const refine = itemJson?.weapon?.rankLevel
  const sets = parseSetInfo(row?.set_info)
    .filter(part => part.setId !== 'other')
    .map(part => `${relics.get(part.setId) || `套装${part.setId}`}${part.count}件`)
    .join(' + ') || '未知'
  const updatedAt = formatTime(row?.updated_at)
  const panel = panelBoard(itemJson?.combatValues)
  const rawPanel = itemJson?.combatValues || {}

  // 全球排名（fort off fans）：靠玩家昵称 + 角色 id + 星魂档位匹配。
  // 工坊 item_id 与 fort off fans 的 avatar_id 是同一套 id，可直接复用。
  let globalRank = null
  try {
    const { fetchPersonalRank, fetchLeaderboardRank } = await import(`../../system/fortoffans.js?t=${Date.now()}`)
    const localNick = localPlayerName(uid)
    let pr = null
    for (const nm of [...new Set([nick, localNick].filter(Boolean))]) {
      pr = await fetchPersonalRank({
        nickname: nm,
        char: String(role.item_id),
        eidolon: itemJson?.rank ?? 0,
      })
      if (pr && pr.rank != null) break
    }
    if (pr && pr.rank != null) {
      // 优先用遗器评分（wrqs）名次；search 的 searchRank 只对 opt_score 生效，
      // wrqs 必须去排行榜逐页找 UID。
      let wrqsRank = null
      if (pr.entry?.uid) {
        try {
          wrqsRank = await fetchLeaderboardRank({
            char: String(role.item_id),
            eid: pr.bracket,
            stat: 'wrqs',
            uid: pr.entry.uid,
            maxPages: 40,
          })
        } catch (_) { /* 失败回退 CRIT */ }
      }
      // 网站配装是否比工坊旧：早于工坊更新时间则提示可能未同步
      const siteAt = pr.entry?.updated_at ? new Date(pr.entry.updated_at).getTime() : 0
      const workAt = row?.updated_at ? new Date(row.updated_at).getTime() : 0
      globalRank = {
        rank: wrqsRank?.rank ?? pr.rank,
        total: wrqsRank?.total ?? pr.total ?? null,
        rankStat: wrqsRank ? 'wrqs' : 'tcv',
        bracket: pr.bracket || '',
        wrqs: pr.entry?.wrqs != null ? Number(pr.entry.wrqs).toFixed(2) : '',
        statTcv: pr.entry?.stat_tcv != null ? Number(pr.entry.stat_tcv).toFixed(1) : '',
        statCritRate: pr.entry?.stat_crit_rate != null ? (Number(pr.entry.stat_crit_rate) * 100).toFixed(1) + '%' : '',
        statCritDmg: pr.entry?.stat_crit_dmg != null ? (Number(pr.entry.stat_crit_dmg) * 100).toFixed(1) + '%' : '',
        statSpd: pr.entry?.stat_spd != null ? Number(pr.entry.stat_spd).toFixed(0) : '',
        stale: workAt > siteAt && siteAt > 0,
      }
    }
  } catch (_) { /* 全球排名查询失败不影响面板主流程 */ }

  // 记录匹配结果供模板提示（matched=匹配到 / miss=未匹配 / error=接口失败）
  const globalRankMiss = globalRank ? false : (nick && nick !== '未知玩家')

  return {
    view: 'detail',
    title: role.nick_name,
    face: localFace(role.nick_name),
    initial: String(role.nick_name || '?').slice(0, 1),
    stars: role.star ? '★'.repeat(Number(role.star)) : '',
    nick,
    level: row?.level || role.level || '-',
    rank: itemJson?.rank ?? 0,
    pointText: Number(row?.relic_point || 0).toFixed(1),
    weapon: weaponLabel,
    refine: refine || '',
    sets,
    panel,
    rawPanel,
    updatedAt,
    elem: role.elem || '',
    path: role.path || '',
    globalRank,
    globalRankMiss,
  }
}

/** 练度图渲染失败时的文字兜底 */
function detailText(view) {
  if (typeof view === 'string') return view
  const lines = [
    `星穹铁道工坊 · ${view.title}`,
    `玩家 ${view.nick}`,
    '',
    `角色：Lv.${view.level}　星魂 ${view.rank}　遗器总分 ${view.pointText}`,
    `光锥：${view.weapon}${view.refine ? `　叠影 ${view.refine}` : ''}`,
    `遗器：${view.sets}`,
    '',
    ...(view.globalRank
      ? [
        `全球练度榜（fort off fans，${view.globalRank.bracket} 星魂）：第 ${view.globalRank.rank} 名${view.globalRank.total ? ` / 共 ${view.globalRank.total} 人` : ''}`,
        ...(view.globalRank.stale ? ['⚠ 网站配装可能未同步，名次对应旧面板'] : []),
        '',
      ]
      : []),
    '面板：',
    ...panelText(view.rawPanel || {}),
  ]
  if (view.updatedAt) lines.push('', `数据更新：${view.updatedAt}`)
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

  const usage = '用法：*欧非榜 [综合|角色|光锥|常驻|连UP|连歪] [欧|氪] [数量]\n例：*欧非榜 综合 欧 10'
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

  const isStreak = type === 'up' || type === 'wai'
  const list = rows.slice(0, count).map((row, index) => {
    const uid = maskUid(row?.uid)
    if (isStreak) {
      const valueKey = type === 'up' ? 'max_role_keep_up' : 'max_role_keep_no_up'
      return {
        rank: index + 1,
        uid,
        streak: row?.[valueKey] ?? '-',
        draw: row?.draw_total ?? 0,
      }
    }
    if (effectiveSort === 'ke') {
      return {
        rank: index + 1,
        uid,
        draw: row?.draw_total ?? 0,
        five: row?.five_total ?? 0,
        avg: row?.xbd_avg ?? '-',
      }
    }
    const avgField = { all: 'all_avg_total', role: 'role_avg_total', guang: 'guang_avg_total', common: 'common_avg_total' }[type] || 'all_avg_total'
    const drawField = { all: 'all_draw_total', role: 'role_draw_total', guang: 'guang_draw_total', common: 'common_draw_total' }[type] || 'all_draw_total'
    const fiveField = { all: 'all_five_total', role: 'role_five_total', guang: 'guang_five_total', common: 'common_five_total' }[type] || 'all_five_total'
    return {
      rank: index + 1,
      uid,
      draw: row?.[drawField] ?? 0,
      five: row?.[fiveField] ?? 0,
      avg: row?.[avgField] ?? '-',
    }
  })

  return {
    view: 'card',
    type,
    sort: effectiveSort,
    isStreak,
    streakLabel: type === 'up' ? '连 UP' : '连歪',
    title: `抽卡欧非榜 · ${SR_CARD_TYPE_LABEL[type] || type}`,
    subtitle: `${SR_CARD_TYPE_LABEL[type] || type} / ${SR_CARD_SORT_LABEL[effectiveSort] || effectiveSort}`,
    total: rows.length,
    rows: list,
    usage,
  }
}

/** 欧非榜图渲染失败时的文字兜底 */
function cardText(view) {
  if (typeof view === 'string') return view
  const lines = [`星穹铁道工坊 · ${view.title}`, `显示前 ${view.rows.length} 名｜UID 由工坊脱敏`, '']
  view.rows.forEach(row => {
    const no = String(row.rank).padStart(2, '0')
    if (view.isStreak) {
      lines.push(`${no}. ${pad(row.uid, 13)}${view.streakLabel} ${pad(row.streak, 3)}次　总抽 ${row.draw}`)
      return
    }
    lines.push(`${no}. ${pad(row.uid, 13)}抽数 ${pad(row.draw, 6)}五星 ${pad(row.five, 4)}平均 ${row.avg}`)
  })
  lines.push('', view.usage)
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
  let matchedRole = null
  if (keyword) {
    const role = await resolveSrRole(keyword)
    matchedRole = role
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
    return `星穹铁道工坊 · 队伍体系推荐\n\n没有找到包含「${keyword}」的队伍，换个角色或直接发【*配队】看全部。`
  }

  const nameOf = token => {
    const text = String(token ?? '')
    const hit = roles.find(role => String(role?.item_id) === text || role?.nick_name === text)
    return hit?.nick_name || text
  }
  const sorted = [...rows].sort((a, b) => (Number(b?.level) || 0) - (Number(a?.level) || 0))

  const list = sorted.slice(0, count).map(row => {
    const lowers = Array.isArray(row?.more_config?.lowers) ? row.more_config.lowers : []
    const memberIds = String(row?.team_members || '').split(',').filter(Boolean)
    const memberNames = String(row?.team_member_names || '').split(',').filter(Boolean)
    const members = memberNames.map((n, i) => {
      const id = memberIds[i] || ''
      const role = roles.find(r => String(r?.item_id) === id) || roles.find(r => r?.nick_name === n)
      const cnName = localNames()?.chars?.[id]?.name || role?.nick_name || n
      return { name: cnName, face: localFace(cnName) || localFace(role?.nick_name) || localFace(n) || '' }
    })
    return {
      name: row?.team_name || '未命名队伍',
      system: systems.get(String(row?.team_system || '')) || row?.team_system || '其他',
      stars: starText(row?.level),
      starNum: Number(row?.level) || 0,
      members,
      swaps: lowers
        .map(item => {
          const main = nameOf(item?.item_id)
          const others = (item?.other_ids || []).map(nameOf).filter(Boolean)
          if (!main) return ''
          return `${item?.name || '替换'} ${main}${others.length ? `→${others.join('/')}` : ''}`
        })
        .filter(Boolean),
    }
  })

  return {
    view: 'team',
    title,
    keyword,
    matched: matchedRole?.nick_name || keyword,
    face: matchedRole ? localFace(matchedRole.nick_name) : '',
    initial: String(matchedRole?.nick_name || keyword || '?').slice(0, 1),
    total: rows.length,
    count: list.length,
    rows: list,
  }
}

/** 配队图渲染失败时的文字兜底 */
function teamText(view) {
  if (typeof view === 'string') return view
  const lines = [`星穹铁道工坊 · ${view.title}`, `按推荐星级排序，显示前 ${view.count} 套`, '']
  for (const row of view.rows) {
    lines.push(`${row.stars} ${row.name}  [${row.system}]`)
    lines.push(`  ${row.members.join(' / ')}`)
    if (row.swaps.length) lines.push(`  可换：${row.swaps.join(' ｜ ')}`)
    lines.push('')
  }
  lines.push('数据来源：星穹铁道工坊队伍体系推荐；发送【*配队 <角色名>】可按角色筛选。')
  return lines.join('\n')
}

const HELP_TEXT = [
  '星穹铁道工坊榜单（前缀 * 或 星铁 都可，如 *遗器排名 流萤）',
  '角色名放前面也可以：*流萤遗器排名 / *流萤伤害排名 / *流萤配队',
  '*遗器排名 <角色名> [80|70|60] [星魂0-6] [数量]   遗器练度排行',
  '*伤害排名 <角色名> [80|70|60] [星魂0-6] [数量]   伤害排行（口径由工坊给出）',
  '*配装 <角色名> [70级]                           全服光锥与遗器套装使用率',
  '*配队 [角色名] [数量]                           队伍体系推荐（含星级与可替换位）',
  '*欧非榜 [综合|角色|光锥|常驻|连UP|连歪] [欧|氪] [数量]   抽卡欧非排行',
  '*练度 <UID> <角色名>                            玩家面板 / 光锥 / 遗器',
  '',
  '数据均来自星穹铁道工坊公开接口，无需绑定账号。',
  '前缀等价写法：* / 星铁 / 崩铁 / 星穹 / 星轨 / 穹轨 / 铁道 / sr / hsr。',
  '绝区零侧见「绝区零榜单帮助」（前缀 % 或 绝区零）。',
].join('\n')

/** 统一出图；渲染失败降级为文字，至少把数据给到 */
async function sendView(e, view, template, textFn) {
  if (typeof view === 'string') return e.reply(view)
  try {
    return await render(`sr_workshop/${template}`, view, { e, ret: true })
  } catch (err) {
    logError(`${template}-render`, err)
    return e.reply(textFn(view))
  }
}

export class sr_workshop extends plugin {
  constructor() {
    super({
      name: '[米哈游]星铁工坊榜单',
      dsc: '星穹铁道工坊遗器 / 伤害排名、配装统计、队伍推荐、欧非榜、玩家练度',
      event: 'message',
      /* ⚠ 数值越小越先执行（框架用 lodash.orderBy asc 排序）。
         必须比这些更小（更负），否则会被它们先接走：
           miao-plugin profileRank   50      #星铁流萤遗器排名 会被当成群面板排名
           ZZZ-Plugin                -30000  %星铁练度排名 会被当成绝区零面板排名
           zzz_workshop              -36000  绝区零工坊短式规则
         取 -37000，留出余量；可用配置 sr_workshop_priority 覆盖。 */
      priority: pluginPriority('sr_workshop', -37000),
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
   * ⚠ 只接星铁前缀开头的消息。星铁有多个等价前缀，框架的 srReg
   * （lib/plugins/loader.js）会在 accept 之前统一改写成「#星铁」：
   *   *遗器排名 流萤 / 崩铁遗器排名 流萤 / 星穹遗器排名 流萤
   *   → #星铁遗器排名 流萤
   * 所以线上绝大多数情况这里是「#星铁…」；但 `*` 本身就是星铁标记（可省游戏名），
   * 且单测 / 直接调用处理函数时看到的是原文，因此两种形态都要认。
   */
  async accept(e) {
    const msg = String(e?.msg || '').trim()
    /* 框架已把 * / 崩铁 / 星穹 等改写成 #星铁；* 开头是星铁标记（不带游戏名），
       两种形态都要认，见文件顶部 SR_PREFIX 的说明。 */
    if (!SR_PREFIX_RE.test(msg)) return false
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
      const view = await buildSrRank(srArgs(RE_SR_RANK, e.msg), 'relic')
      return await sendView(e, view, 'rank', rankText)
    } catch (err) {
      logError('srRank', err)
      return await e.reply(`获取星铁遗器排名失败：${err?.message || err}`)
    }
  }

  async srDamageRank(e) {
    try {
      const view = await buildSrRank(srArgs(RE_SR_DMG, e.msg), 'damage')
      return await sendView(e, view, 'rank', rankText)
    } catch (err) {
      logError('srDamageRank', err)
      return await e.reply(`获取星铁伤害排名失败：${err?.message || err}`)
    }
  }

  async srGradStat(e) {
    try {
      const view = await buildSrGradStat(srArgs(RE_SR_GRAD, e.msg))
      return await sendView(e, view, 'grad', gradText)
    } catch (err) {
      logError('srGradStat', err)
      return await e.reply(`获取星铁配装统计失败：${err?.message || err}`)
    }
  }

  async srCardRank(e) {
    try {
      const view = await buildSrCardRank(srArgs(RE_SR_CARD, e.msg))
      return await sendView(e, view, 'card', cardText)
    } catch (err) {
      logError('srCardRank', err)
      return await e.reply(`获取星铁欧非榜失败：${err?.message || err}`)
    }
  }

  async srTeam(e) {
    try {
      const view = await buildSrTeam(srArgs(RE_SR_TEAM, e.msg))
      return await sendView(e, view, 'team', teamText)
    } catch (err) {
      logError('srTeam', err)
      return await e.reply(`获取队伍推荐失败：${err?.message || err}`)
    }
  }

  async srDetail(e) {
    try {
      const view = await buildSrDetail(orderDetailArgs(srArgs(RE_SR_DETAIL, e.msg)))
      return await sendView(e, view, 'detail', detailText)
    } catch (err) {
      logError('srDetail', err)
      return await e.reply(`查询星铁练度失败：${err?.message || err}`)
    }
  }

  async help(e) {
    return await e.reply(HELP_TEXT)
  }
}
