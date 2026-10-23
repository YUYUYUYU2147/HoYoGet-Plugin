// 深渊 / 挑战战绩数据归一化（原神深境螺旋、幻想真境剧诗；星铁混沌回忆、虚构叙事、末日幻影、王棋）
//
// 数据来源：米游社 record 接口（通过内联的 miao MysApi 调用）
//   原神：spiralAbyss / role_combat / hard_challenge
//   星铁：spiralAbyss（混沌）/ challengeStory（虚构）/ challengeBoss（末日）/ challengePeak（王棋）
//
// 模板复用 miao 作者的 stat/*.html（已复制到 resources/abyss_stat/，
// 只把 {{_res_path}} 换成 {{ppath}}abyss_stat/、把 defaultLayout 展开成独立页面）。

import lodash from 'lodash'
import moment from 'moment'

/** {year,month,day,hour,minute} → YYYY-MM-DD HH:mm */
export function timeCalc(t) {
  if (!t) return ''
  const p = n => String(n || 0).padStart(2, '0')
  return `${t.year}-${p(t.month)}-${p(t.day)} ${p(t.hour)}:${p(t.minute)}`
}

/** 星铁元素图标（模板里 elemIcon 用） */
export function elemIcon(element) {
  const map = {
    physical: 'elem-phy', phy: 'elem-phy', 物理: 'elem-phy',
    fire: 'elem-fire', 火: 'elem-fire',
    ice: 'elm-ice', 冰: 'elm-ice',
    lightning: 'elem-elec', elec: 'elem-elec', 雷: 'elem-elec',
    wind: 'elem-wind', 风: 'elem-wind',
    quantum: 'elem-auantum', 量子: 'elem-auantum',
    imaginary: 'elem-imaginary', 虚数: 'elem-imaginary',
  }
  const key = String(element || '').trim().toLowerCase()
  return map[key] ? `meta-sr/public/icons/${map[key]}.webp` : ''
}

/* ───────────── 原神 · 深境螺旋 ───────────── */

function abyssSchedule(raw = {}) {
  const ts = Number(raw?.start_time)
  if (Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000
    return `${moment(new Date(ms)).format('M')}月`
  }
  const start = raw?.start_time ? moment(raw.start_time) : null
  return start?.isValid?.() ? `${start.format('M')}月` : ''
}

/**
 * @param {object} raw spiralAbyss 返回的 data
 * @param {object} ctx { avatarData, stat }
 */
export function buildGsAbyss(raw = {}, ctx = {}) {
  const floors = raw?.floors || []
  if (!floors.length) return null

  const levelNames = ['', '第一间', '第二间', '第三间']
  const out = {
    ...raw,
    floors: {},
    totalStar: raw.total_star || 0,
    maxFloor: raw.max_floor || '',
    battleNum: (raw.total_battle_times || raw.total || 0),
    /* 模板沿用 miao 的 Abyss 字段名：total = total_battle_times。
       之前只写了 battleNum，标题里的 {{abyss.total}} 就是空的。 */
    total: (raw.total_battle_times ?? raw.total ?? 0),
    schedule: abyssSchedule(raw),
  }
  let star = 0
  for (const f of floors) {
    const floor = {
      index: f.index,
      name: `第${f.index}层`,
      star: f.star || 0,
      levels: [],
    }
    star += floor.star
    for (const lv of (f.levels || [])) {
      const level = {
        index: lv.index,
        name: levelNames[lv.index] || `第${lv.index}间`,
        star: lv.star || 0,
        up: null,
        down: null,
      }
      for (const b of (lv.battles || [])) {
        const key = b.index === 1 ? 'up' : 'down'
        const t = b.timestamp ? moment(new Date(b.timestamp * 1000)) : null
        level[key] = {
          avatars: (b.avatars || []).map(a => a.id),
          time: t ? t.format('MM-DD HH:mm') : '',
          timestamp: b.timestamp || 0,
        }
      }
      floor.levels.push(level)
    }
    /* 模板的角色卡用 floor.display（三间里有一间有数据就拿来展示），
       对应 miao Abyss 类的 display = levels[3] || levels[2] || levels[1] */
    floor.display = floor.levels.find(l => l.index === 3)
      || floor.levels.find(l => l.index === 2)
      || floor.levels.find(l => l.index === 1)
      || null
    out.floors[f.index] = floor
  }
  out.star = star

  /* 战斗统计（字段名对齐米游社接口，和 miao 的 Abyss 类一致）：
       damage_rank / take_damage_rank / defeat_rank / normal_skill_rank / energy_skill_rank
     每项是数组，取第一条 { avatar_id, value } */
  const statKeys = [
    ['damage_rank', '最强一击', 'w'],
    ['take_damage_rank', '最高承伤', 'w'],
    ['defeat_rank', '最多击破', 'count'],
    ['normal_skill_rank', '元素战技', 'count'],
    ['energy_skill_rank', '元素爆发', 'count'],
  ]
  out.stat = statKeys.map(([field, title, unit]) => {
    const rank = Array.isArray(raw[field]) ? raw[field][0] : raw[field]
    const value = rank?.value
    if (value == null) return null
    const n = Number(value) || 0
    return {
      title,
      id: rank?.avatar_id || 0,
      value: unit === 'w' ? `${(n / 10000).toFixed(1)} W` : `${n}次`,
    }
  }).filter(Boolean)

  return out
}

/* ───────────── 星铁 · 混沌 / 虚构 / 末日 / 王棋 ───────────── */

/** 星铁挑战通用：groups → floors */
function buildSrChallenge(raw = {}, cfg = {}, period = 1) {
  const type = cfg.type
  /* 异相仲裁的数据结构完全不同：challenge_peak_records[] 里每条是
     { group, boss_info, boss_record, mob_records, battle_num, ... }，
     没有 all_floor_detail / node_1 那套。 */
  if (type === 'peak') return buildSrPeak(raw, period)
  /* 与 genshin 的 StarRail/model/abyss.js 同口径：
     虚构/末日/混沌的楼层都在 data.all_floor_detail，groups 只提供期数与时间，
     groups 既可能是数组也可能是 {0:..,1:..}（虚构/末日按 time 索引）。 */
  const groups = raw?.groups
  let group = {}
  if (Array.isArray(groups)) group = groups[period === 2 ? 1 : 0] || groups.find(Boolean) || {}
  else if (groups && typeof groups === 'object') {
    group = groups[String(period === 2 ? 1 : 0)] || Object.values(groups).find(Boolean) || {}
  }

  let rawFloors = Array.isArray(raw?.all_floor_detail) && raw.all_floor_detail.length
    ? raw.all_floor_detail
    : (group?.floors || raw?.floors || [])
  /* 只要节点上真有出战角色的楼层；快速通关层保留（虚构会单独标「快速通关」） */
  const hasAvatars = f => (f?.node_1?.avatars?.length || f?.node_2?.avatars?.length || f?.node_3?.avatars?.length)
  rawFloors = rawFloors.filter(f => hasAvatars(f) || f?.is_fast)
  const makeNode = (n, idx) => {
    if (!n) return null
    return {
      raw: n,
      index: idx + 1,
      score: Number(n.score) || 0,
      time: n.challenge_time ? timeCalc(n.challenge_time) : '',
      avatars: (n.avatars || []).map(a => ({
        id: a.id,
        level: a.level,
        rarity: a.rarity,
        element: a.element,
        rank: a.rank,
        name: a.name,
        abbr: a.abbr,
        icon: a.icon,
      })),
    }
  }
  let floors = rawFloors.map((f, i) => {
    const index = f.index ?? (i + 1)
    const node1 = makeNode(f.node_1, 0)
    const node2 = makeNode(f.node_2, 1)
    const node3 = makeNode(f.node_3, 2)
    const nodes = [node1, node2, node3].filter(Boolean)
    const extraStar = Number(f.extra_star_num) || 0
    /* 混沌/虚构/末日有时只给 star_num，有时给 node 级 star；优先楼层值 */
    const starNum = Number(f.star_num ?? nodes.reduce((sum, n) => sum + (Number(n.raw?.star_num) || 0), 0)) || 0
    const isFast = !!f.is_fast
    /* 虚构快速通关不计分数；其余按三个节点的积分求和（与 miao 同口径） */
    const score = isFast && type === 'story' ? 0 : nodes.reduce((sum, n) => sum + n.score, 0)
    return {
      index,
      name: f.name || cfg.title || `第${index}层`,
      star: Math.max(0, starNum - extraStar),
      extraStar,
      score,
      roundNum: isFast && type === 'story' ? 0 : (Number(f.round_num) || 0),
      isFast,
      node1,
      node2,
      node3,
      nodes,
    }
  })

  if (cfg.filterFloors) floors = cfg.filterFloors(floors)

  const sumStar = floors.reduce((s, f) => s + f.star, 0)
  const totalStar = Number(raw?.star_num ?? group?.star_num ?? 0) || sumStar
  const extraStar = Number(raw?.extra_star_num ?? group?.extra_star_num) || 0
  /* 期数名：混沌/虚构/末日接口在 group.name（如「来生洄渡其十二」），
     末日幻影有时只在 group 的 mem/name_mi18n 上；都没有就留空。 */
  const periodName = group?.name || group?.name_mi18n || raw?.name || ''
  const begin = Number(group?.begin_time || raw?.begin_time) || 0
  const end = Number(group?.end_time || raw?.end_time) || 0
  return {
    type,
    title: cfg.title,
    group: group || {},
    periodName,
    beginTime: begin,
    endTime: end,
    floors,
    totalStar,
    extraStar,
    bestFloor: raw?.max_floor ?? group?.name ?? floors[floors.length - 1]?.name ?? '',
    battleNum: raw?.battle_num ?? group?.battle_num ?? 0,
    /* 兼容 miao/genshin 的字段名 */
    total: raw?.battle_num ?? group?.battle_num ?? 0,
    /* 有楼层就算有数据；接口的 has_data 在各玩法上并不一致 */
    hasData: floors.length > 0 || !!raw?.has_data,
  }
}

/**
 * 异相仲裁（challenge_peak）→ 统一成 floors/nodes 结构。
 * 一条 record 里通常只有一个「首领本体」节点（boss_record.avatars）。
 */
function buildSrPeak(raw = {}, period = 1) {
  const records = Array.isArray(raw?.challenge_peak_records) ? raw.challenge_peak_records : []
  const list = records.filter(r => r && r.has_challenge_record !== false)
  const pick = period === 2 ? (list[1] || list[0]) : (list[0] || list[1])
  if (!pick) {
    return { type: 'peak', title: '王棋（异相仲裁）', group: {}, floors: [], totalStar: 0, extraStar: 0, bestFloor: '', battleNum: 0, hasData: false }
  }
  const group = pick.group || {}
  const boss = pick.boss_record || {}
  const avatars = (boss.avatars || []).map(a => ({
    id: a.id,
    level: a.level,
    rarity: a.rarity,
    element: a.element,
    rank: a.rank,
    name: a.name,
    abbr: a.abbr,
    icon: a.icon,
  }))
  const starNum = Number(pick.boss_stars || 0)
  const extraStar = Number(pick.mob_stars || 0)
  const floors = avatars.length ? [{
    index: 1,
    name: group.name_mi18n || '异相仲裁',
    star: Math.max(0, starNum - extraStar),
    extraStar,
    score: 0,
    roundNum: 0,
    isFast: false,
    nodes: [{ index: 1, score: 0, time: '', avatars, raw: {} }],
  }] : []
  const ts = t => (t && typeof t === 'object'
    ? new Date(`${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')} ${String(t.hour || 0).padStart(2, '0')}:${String(t.minute || 0).padStart(2, '0')}:00`).getTime()
    : 0)
  return {
    type: 'peak',
    title: '王棋（异相仲裁）',
    group,
    periodName: group.name_mi18n || '',
    beginTime: ts(group.begin_time),
    endTime: ts(group.end_time),
    floors,
    totalStar: starNum,
    extraStar,
    bestFloor: group.name_mi18n || '',
    battleNum: Number(pick.battle_num || 0),
    hasData: true,
  }
}

export const SR_CFG = {
  chaos: { type: 'chaos', title: '混沌回忆', api: 'getChallengeChaos', tpl: 'abyss-challenge' },
  story: { type: 'story', title: '虚构叙事', api: 'getChallengeStory', tpl: 'challenge-story' },
  boss: { type: 'boss', title: '末日幻影', api: 'getChallengeBoss', tpl: 'challenge-boss' },
  peak: { type: 'peak', title: '王棋（异相仲裁）', api: 'getChallengePeak', tpl: 'challenge-peak' },
}

export function buildSrChallengeData(raw, cfg, period = 1) {
  const data = buildSrChallenge(raw, cfg, period)
  return data.hasData ? data : null
}
