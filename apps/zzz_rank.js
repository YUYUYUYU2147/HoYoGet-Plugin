import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render, yaml, mys } from '#HoYoGet'
import { buildBasicProperties, calcDamage as calcPanelDamage } from './zzz_panel_list.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RECORDS_DIR = path.join(PLUGIN_ROOT, 'data', 'zzz_panel', 'records')
const ZZZ_PANEL_DIR = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin', 'data', 'panel')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

const RANK_PREFIX = '^(?:%|％|#?zzz|#?ZZZ|#?绝区零|#?绝区)?\\s*'
const PANEL_RANK_REG = new RegExp(`${RANK_PREFIX}(.+?)面板排名$`)
const SHORT_RANK_REG = /^(?:[%％]|#?zzz|#?ZZZ|#?绝区零|#?绝区)\s*(.+?)排名$/
const RANK_HELP_REG = /^(面板排名|面板排行)$/
const RANK_DATA_CMD = /^(%|％)?(面板排名数据|排名数据)$/
const RANK_SCOPE_CMD = /^(?:%|％|#?zzz|#?ZZZ|#?绝区零|#?绝区)?\s*(?:面板排名范围|排名范围|面板排行范围)$/

/* 排名范围（本群 / 全部）由 system/rank_scope.js 统一持有，
   工坊练度排名也读同一份，切换后两边同步。 */
import { getRankScope, setRankScope as setScopeShared, scopeLabel } from '../system/rank_scope.js'

/**
 * 取群成员绑定的绝区零 UID。
 *
 * 走 Yunzai 的 sqlite（data/db/data.db）的 Users 表：games 字段是 JSON，
 * 群成员 → 该成员的 zzz.uid，返回 UID 集合。拿不到成员列表或数据库时返回 null，
 * 由调用方回落成全部范围（否则群里没人绑 UID 就会直接空榜）。
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
      db.all('select id, games from Users', (err, list) => {
        db.close(() => {})
        resolve(err ? [] : list || [])
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

const PROF_WEIGHT_NAME = { 1: '强攻', 2: '击破', 3: '异常', 4: '支援', 5: '防护', 6: '命破', 7: '锋御' }

const SCORE_PROP_ID = {
  '生命值百分比': 11102, '攻击力百分比': 12102, '防御力百分比': 13102, '冲击力': 12202,
  '暴击率': 20103, '暴击伤害': 21103, '穿透率': 23103, '穿透值': 23203,
  '能量自动回复': 30502, '异常精通': 31203, '异常掌控': 31402,
}
const ELEM_DMG_ID = { 200: 31503, 201: 31603, 202: 31703, 203: 31803, 204: 32303, 205: 31903 }
const BASE_VALUE = { 11102: 3, 11103: 112, 12102: 3, 12103: 19, 13102: 4.8, 13103: 15 }
const SUB_STAT_IDS = [11102, 11103, 12102, 12103, 13102, 13103, 20103, 21103, 31203, 31402, 23203]
const SCORE_MAIN_STATS = {
  4: [11102, 12102, 13102, 20103, 21103, 31203],
  5: [11102, 12102, 13102, 23103, 31503, 31603, 31703, 31803, 32303, 31903],
  6: [11102, 12102, 12202, 13102, 30502, 31402],
}
const SELF_SCORE_WEIGHTS = {
  strong:   { '攻击力百分比': .75, '暴击率': 1, '暴击伤害': 1, '穿透值': 1, '属性伤害加成': 1 },
  stun:     { '冲击力': 1, '攻击力百分比': .75, '暴击率': 1, '暴击伤害': .75, '穿透值': .5, '属性伤害加成': .75 },
  anomaly:  { '攻击力百分比': .75, '异常精通': 1, '异常掌控': 1, '穿透值': .75, '属性伤害加成': 1 },
  support:  { '攻击力百分比': .75, '暴击率': .75, '暴击伤害': .75, '能量自动回复': 1, '穿透值': .5, '属性伤害加成': .75 },
  rupture:  { '生命值百分比': .75, '攻击力百分比': .25, '暴击率': 1, '暴击伤害': 1, '属性伤害加成': 1, '冲击力': .5, '防御力百分比': .25 },
  defender: { '防御力百分比': 1, '暴击率': .75, '暴击伤害': .75, '穿透值': .75, '属性伤害加成': 1 },
}
const PROF_WEIGHT_KEY = { 1: 'strong', 2: 'stun', 3: 'anomaly', 4: 'support', 5: 'defender', 6: 'rupture', 7: 'defender' }

function getScoreWeight(profession, elementType, baseProps = {}) {
  const elemId = ELEM_DMG_ID[elementType]
  const key = PROF_WEIGHT_KEY[profession] || 'strong'
  const ruleName = `自研·${PROF_WEIGHT_NAME[profession] || '强攻'}`
  const named = { ...SELF_SCORE_WEIGHTS[key] }
  const weight = {}
  for (const nm in named) {
    const id = nm === '属性伤害加成' ? elemId : SCORE_PROP_ID[nm]
    if (id != null) weight[id] = named[nm]
  }
  for (const [small, big, keyName] of [[11103, 11102, 'hpmax'], [12103, 12102, 'attack'], [13103, 13102, 'def']]) {
    if (!weight[big]) continue
    const base = parseFloat(baseProps?.[keyName]?.base)
    if (!(base > 0)) continue
    weight[small] ??= BASE_VALUE[small] * 100 / (BASE_VALUE[big] * base) * weight[big]
  }
  return { ruleName, weight }
}

function calcEquipScore(data) {
  const equip = data?.equip || []
  const profession = data?.avatar_profession
  const elementType = data?.element_type
  const baseProps = {}
  for (const p of data?.properties || []) {
    const pid = Number(p.property_id)
    if (pid === 1 || pid === 11102 || pid === 11103) baseProps.hpmax = { base: p.base || '0' }
    if (pid === 2 || pid === 12101 || pid === 12102 || pid === 12103) baseProps.attack = { base: p.base || '0' }
    if (pid === 3 || pid === 13102 || pid === 13103) baseProps.def = { base: p.base || '0' }
  }
  const { weight } = getScoreWeight(profession, elementType, baseProps)

  const equipList = equip.map(eq => ({
    slot: eq.equipment_type ?? 0,
    level: eq.level ?? 0,
    rarity: eq.rarity || 'A',
    main_properties: (eq.main_properties || []).map(p => ({ pid: p.property_id })),
    properties: (eq.properties || []).map(p => ({ pid: p.property_id, count: p.level ?? 0 })),
  }))

  let total = 0
  for (const eq of equipList) {
    const slot = eq.slot || 0
    const levelMult = 0.25 + eq.level * 0.05
    const rarityMult = eq.rarity === 'S' ? 1 : eq.rarity === 'A' ? 2 / 3 : 1 / 3
    const mainId = eq.main_properties[0]?.pid || 0
    let actual = 0
    for (const p of eq.properties) {
      const w = weight[p.pid]
      if (w) actual += w * p.count
    }
    const cand = SUB_STAT_IDS.filter(id => id !== mainId && weight[id]).sort((a, b) => weight[b] - weight[a]).slice(0, 4)
    let score = 0
    if (cand.length) {
      let max = weight[cand[0]] * 6
      for (let i = 1; i < cand.length; i++) max += weight[cand[i]] || 0
      if (max > 0) {
        if (slot >= 1 && slot <= 3) {
          const minScore = 12 * levelMult * rarityMult
          score = actual === 0 ? minScore : Math.max(actual / max * levelMult * rarityMult * 55, minScore)
        } else {
          const ms = (SCORE_MAIN_STATS[slot] || []).filter(id => weight[id]).sort((a, b) => weight[b] - weight[a])[0]
          const mainScore = ms ? 12 * (weight[mainId] || 0) / weight[ms] : 12
          const subScore = actual / max * 43
          score = (mainScore + subScore) * levelMult * rarityMult
        }
      }
    }
    total += score
  }
  const rating = total >= 280 ? 'MAX' : total >= 220 ? 'ACE' : total >= 200 ? 'SSS' : total >= 180 ? 'SS' : total >= 160 ? 'S' : total >= 120 ? 'A' : total >= 80 ? 'B' : 'C'
  return { score: +total.toFixed(1), rating }
}

function formatDamage(num = 0) {
  num = Number(num || 0)
  if (!num) return '-'
  if (num >= 10000) return `${(num / 10000).toFixed(num >= 1000000 ? 1 : 2)}万`
  return String(Math.round(num))
}

function buildStatItems(data) {
  const props = data?.properties || []
  const getVal = name => {
    const p = props.find(v => v.property_name === name || String(v.property_name || '').includes(name))
    return p?.final ?? p?.add ?? p?.base ?? '-'
  }
  const items = []
  const add = (name, val) => { if (val !== undefined && val !== null && val !== '') items.push({ name, value: String(val) }) }
  add('攻击力', getVal('攻击力'))
  add('暴击率', getVal('暴击率'))
  add('暴击伤害', getVal('暴击伤害'))
  const dmgProp = props.find(v => /伤害加成/.test(v.property_name || ''))
  if (dmgProp) add('伤害加成', dmgProp.final || dmgProp.base || '')
  add('异常精通', getVal('异常精通'))
  add('冲击力', getVal('冲击力'))
  return items.slice(0, 5)
}

/** 技能等级：按 skill_type 排序，取前 6 个，与 ZZZ-Plugin 排名的技能块一致 */
function buildSkillLevels(data) {
  return (data?.skills || [])
    .slice()
    .sort((a, b) => Number(a.skill_type ?? 0) - Number(b.skill_type ?? 0))
    .map(s => Number(s.level || 0))
    .filter(Boolean)
    .slice(0, 6)
}

/** 驱动盘槽位：按 equipment_type 排序，编号 1-6 显示在图标右下角 */
function buildEquips(data) {
  return (data?.equip || [])
    .slice()
    .sort((a, b) => Number(a.equipment_type || 0) - Number(b.equipment_type || 0))
    .map(e => ({
      slot: Number(e.equipment_type || 0),
      name: e.name || '',
      icon: e.icon || '',
    }))
    .slice(0, 6)
}

/** 头像优先用游戏内角色方形头像，其次已解锁皮肤，最后玩家头像 */
function buildAvatar(data) {
  const unlockedSkin = (data?.skin_list || []).find(s => s.unlocked)
  return data?.role_square_url || data?.role_square_avatar_url || unlockedSkin?.skin_square_url || data?.avatar_icon || ''
}

/**
 * 期望伤害：复用面板详情的完整计算（倍率表 × 各乘区）。
 *
 * 不能读接口的 skills[].damage_percentage —— 米游社 avatar/info 根本不返回这个字段，
 * skills 里只有 level / skill_type / items，所以旧写法永远算出 0。
 * 这里与「米游社<角色>面板」用同一个 calcDamage，保证排名图和详情页数字一致。
 */
function calcDamage(data) {
  try {
    const bp = buildBasicProperties(data)
    const res = calcPanelDamage(bp, data?.level, data, data?.name_mi18n || data?.full_name_mi18n || '')
    if (!res.ok) return { damage: 0, skill: '', error: res.error }
    // 取期望伤害最高的一招（与详情页顶部「伤害最高那招」口径一致）
    return { damage: Number(res.top?.expect || 0), skill: res.top?.name || '' }
  } catch (err) {
    logger.debug?.(`[HoYoGet][zzz_rank] 伤害计算失败: ${err.message}`)
    return { damage: 0, skill: '', error: err.message }
  }
}

function loadAllRecords(groupUids = null) {
  const records = []
  const seen = new Set()

  for (const dir of [RECORDS_DIR, ZZZ_PANEL_DIR]) {
    if (!dir || !fs.existsSync(dir)) continue
    try {
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        // 文件名的 UID 段既可能是纯 UID，也可能是「UID_角色名」，统一按第一段比对
        const fileUid = file.replace(/\.json$/, '').split('_')[0]
        if (groupUids && !groupUids.has(fileUid)) continue
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
          if (Array.isArray(raw)) {
            for (const item of raw) {
              const uid = file.replace(/\.json$/, '')
              const charName = item?.name_mi18n || item?.full_name_mi18n || ''
              const key = `${uid}_${charName}`
              if (!charName || seen.has(key)) continue
              seen.add(key)
              records.push({ uid, data: item })
            }
          } else if (raw?.data) {
            const uid = raw.uid || file.replace(/\.json$/, '').split('_')[0]
            const item = raw.data
            const charName = item?.name_mi18n || item?.full_name_mi18n || ''
            const key = `${uid}_${charName}`
            if (!charName || seen.has(key)) continue
            seen.add(key)
            records.push({ uid, data: item, player: raw.player || null })
          }
        } catch {}
      }
    } catch {}
  }
  return records
}

export class zzz_panel_rank extends plugin {
  constructor() {
    super({
      name: '[米哈游]绝区层面板排名',
      dsc: '绝区零角色面板排名（跨用户，基于本地已保存面板数据）',
      event: 'message',
      priority: pluginPriority('zzz_panel_rank', -40000),
      rule: [
        { reg: PANEL_RANK_REG.source, fnc: 'panelRank' },
        { reg: RANK_SCOPE_CMD.source, fnc: 'toggleRankScope' },
        { reg: RANK_HELP_REG.source, fnc: 'rankHelp' },
        { reg: RANK_DATA_CMD.source, fnc: 'rankDataStatus' },
      ]
    })
  }

  /** accept 截胡纯 角色名排名（不带"面板"），避免被 ZZZ-Plugin 的 panelRankBridge 抢走 */
  async accept(e) {
    const msg = String(e?.msg || '').trim()
    const m = msg.match(SHORT_RANK_REG)
    if (!m) return false
    this.e = e
    if (/^[%％]/.test(m[0])) {
      e.msg = `%${m[1]}面板排名`
    } else {
      e.msg = `绝区零${m[1]}面板排名`
    }
    await this.panelRank(e)
    return 'return'
  }

  /** 切换排名范围：本群 ↔ 全部。群里只有一个“当前范围”，切一次后续都按新范围出图 */
  async toggleRankScope(e) {
    const current = scopeLabel()
    const next = setScopeShared(getRankScope() === 'group' ? 'all' : 'group')
    return e.reply(`面板排名范围已切换为「${scopeLabel(next)}」（原「${current}」）。\n本群范围只统计群里已绑定绝区零 UID 的成员；非群聊时按全部统计。`)
  }

  async rankHelp(e) {
    return e.reply([
      '===== 绝区零面板排名系统 =====',
      '',
      '指令说明：',
      '  %<角色名>面板排名  - 查看角色面板排名（跨用户）',
      '  例：%艾莲面板排名、%丽娜面板排名',
      `  %面板排名范围      - 切换「本群 / 全部」，当前：${scopeLabel()}`,
      '',
      '排序规则：',
      '  综合分 = 期望伤害占比×60 + 驱动盘评分占比×40',
      '  驱动盘评分：按职业权重自研算法（0~330 分制）',
      '',
      '数据来源：米哈游插件本地已保存面板记录',
      '  需先使用「米游社<名字>面板」查看详情后自动保存',
      '  兼容 ZZZ-Plugin 的 data/panel 数据',
    ].join('\n'))
  }

  async rankDataStatus(e) {
    const records = loadAllRecords()
    const uidSet = new Set()
    const charNames = new Set()
    for (const r of records) {
      uidSet.add(r.uid)
      charNames.add(r.data?.name_mi18n || r.data?.full_name_mi18n || '未知')
    }
    const dirs = []
    if (fs.existsSync(RECORDS_DIR)) dirs.push(`米哈游: ${RECORDS_DIR}`)
    if (fs.existsSync(ZZZ_PANEL_DIR)) dirs.push(`ZZZ-Plugin: ${ZZZ_PANEL_DIR}`)
    return e.reply([
      `面板排名数据状态：`,
      ...dirs.map(d => `  数据源：${d}`),
      `  共 ${records.length} 条面板记录`,
      `  来自 ${uidSet.size} 位玩家`,
      `  覆盖 ${charNames.size} 名角色`,
    ].join('\n'))
  }

  async panelRank(e) {
    const m = String(e.msg || '').match(PANEL_RANK_REG)
    const name = m?.[1]?.trim()
    if (!name) return false

    // 本群范围只在群聊成立；私聊或拿不到成员列表时回落成全部，避免空榜
    let groupUids = null
    let label = scopeLabel()
    if (getRankScope() === 'group') {
      groupUids = e?.isGroup ? await getGroupMemberUids(e) : null
      if (!groupUids) label = '全部'
    } else {
      groupUids = null
    }

    const allRecords = loadAllRecords(groupUids)
    if (!allRecords.length) {
      return e.reply(`暂无${label}面板排名数据。\n请先使用「米游社<名字>面板」查看角色详情（数据会自动保存），或使用 ZZZ-Plugin 更新面板。\n发送「%面板排名范围」可切换本群 / 全部。`)
    }

    const resolved = []
    for (const r of allRecords) {
      const charName = r.data?.name_mi18n || r.data?.full_name_mi18n || ''
      if (!charName) continue
      if (!charName.includes(name) && !name.includes(charName)) continue
      const dmg = calcDamage(r.data)
      const { score, rating } = calcEquipScore(r.data)
      resolved.push({
        uid: r.uid,
        data: r.data,
        charName,
        score,
        damage: dmg.damage,
        damageSkill: dmg.skill,
        rating,
        profession: PROF_WEIGHT_NAME[r.data?.avatar_profession] || '',
        rarity: r.data?.rarity || 'A',
        cons: r.data?.rank ?? 0,
        level: r.data?.level ?? 0,
        weapon: {
          name: r.data?.weapon?.name || '',
          icon: r.data?.weapon?.icon || '',
          level: r.data?.weapon?.level || '',
          star: r.data?.weapon?.star || '',
          rarity: r.data?.weapon?.rarity || '',
        },
        stats: buildStatItems(r.data),
        skills: buildSkillLevels(r.data),
        equips: buildEquips(r.data),
        icon: buildAvatar(r.data),
        nickname: r.player?.nickname || r.charName,
      })
    }

    if (!resolved.length) return e.reply(`未找到【${name}】的相关排名数据。`)

    const maxDamage = Math.max(...resolved.map(r => r.damage || 0), 0)
    const maxScore = Math.max(...resolved.map(r => r.score || 0), 0)
    const ranked = resolved.map(r => {
      const damageRatio = maxDamage ? (r.damage || 0) / maxDamage : 0
      const driveRatio = maxScore ? (r.score || 0) / maxScore : 0
      return { ...r, compositeScore: damageRatio * 60 + driveRatio * 40, damagePercent: maxDamage ? (damageRatio * 100).toFixed(1) : '0.0' }
    })
    ranked.sort((a, b) => b.compositeScore - a.compositeScore || b.damage - a.damage || b.score - a.score)

    const maxDisplay = 20
    const records = ranked.slice(0, maxDisplay).map((r, i) => ({
      rank: i + 1,
      uid: r.uid,
      charName: r.charName,
      nickname: r.nickname,
      icon: r.icon,
      score: r.score.toFixed(1),
      damage: formatDamage(r.damage),
      damagePercent: r.damagePercent,
      compositeScore: r.compositeScore.toFixed(2),
      damageSkill: r.damageSkill,
      rating: r.rating,
      profession: r.profession,
      rarity: r.rarity,
      cons: r.cons,
      level: r.level,
      weapon: r.weapon,
      stats: r.stats,
      skills: r.skills,
      equips: r.equips,
    }))

    const charName = records[0]?.charName || name
    try {
      const img = await render('zzz_panel/rank', {
        title: `${charName}面板排名`,
        count: ranked.length,
        scopeLabel: label,
        records,
        notes: [
          `范围：${label}（发送「%面板排名范围」切换本群 / 全部）`,
          '数据来源：米哈游插件本地面板记录 + ZZZ-Plugin 已有面板',
          '综合分=同角色最高期望伤害占比×60 + 驱动盘评分占比×40',
        ]
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_rank] 渲染排名失败: ${err.message}`)
      const lines = records.map(r => `#${r.rank} UID:${r.uid} ${r.charName} 综合:${r.compositeScore} 伤害:${r.damage} 评分:${r.score}`)
      return e.reply([
        `【${charName}】面板排名（共 ${ranked.length} 人参与）：`,
        ...lines,
      ].join('\n'))
    }
  }
}