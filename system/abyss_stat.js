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
    physical: 'elem-phy', fire: 'elem-fire', ice: 'elm-ice', lightning: 'elem-elec',
    wind: 'elem-wind', quantum: 'elem-auantum', imaginary: 'elem-imaginary',
  }
  return map[element] ? `meta-sr/public/icons/${map[element]}.webp` : ''
}

/* ───────────── 原神 · 深境螺旋 ───────────── */

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
    battleNum: (raw.total_battle_times || 0),
    schedule: raw.schedule_id || '',
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

  // 战斗统计：最强一击 / 最高承伤 / 最多击破 / 战技 / 爆发
  const names = { dmg: '最强一击', takeDmg: '最高承伤', defeat: '最多击破', e: '元素战技', q: '元素爆发' }
  out.stat = Object.entries(names).map(([key, title]) => {
    const rank = raw[`${key === 'takeDmg' ? 'take_damage' : key === 'defeat' ? 'defeat' : key}_rank`] || {}
    const value = rank?.value
    if (value == null) return null
    return {
      title,
      id: rank.avatar_id || 0,
      value: ['dmg', 'takeDmg'].includes(key)
        ? `${(Number(value) / 10000).toFixed(1)} W`
        : `${value}次`,
    }
  }).filter(Boolean)

  return out
}

/* ───────────── 星铁 · 混沌 / 虚构 / 末日 / 王棋 ───────────── */

/** 星铁挑战通用：groups → floors */
function buildSrChallenge(raw = {}, cfg = {}) {
  const type = cfg.type
  let group
  if (type === 'story') group = raw?.groups?.[0] || raw?.groups?.find(Boolean)
  else if (type === 'boss') group = raw?.groups?.[0]
  else group = raw?.groups?.[0] || raw?.groups?.find(Boolean)

  const rawFloors = group?.floors || raw?.floors || []
  let floors = rawFloors.map((f, i) => ({
    index: f.index ?? (i + 1),
    name: f.name || `第${(f.index ?? i + 1)}层`,
    star: f.star || 0,
    extraStar: f.extra_star || 0,
    score: f.score || 0,
    roundNum: f.round_num || 0,
    isFast: !!f.is_fast,
    nodes: [f.node_1, f.node_2, f.node_3].filter(Boolean).map((n, idx) => ({
      index: idx + 1,
      avatars: (n.avatars || []).map(a => ({
        id: a.id,
        level: a.level,
        rarity: a.rarity,
        element: a.element,
        rank: a.rank,
      })),
    })),
  }))

  if (cfg.filterFloors) floors = cfg.filterFloors(floors)

  const totalStar = group?.star_num ?? raw?.star_num ?? floors.reduce((s, f) => s + f.star, 0)
  const extraStar = group?.extra_star_num ?? raw?.extra_star_num ?? 0
  return {
    type,
    title: cfg.title,
    group: group || {},
    floors,
    totalStar,
    extraStar,
    bestFloor: group?.name || floors[floors.length - 1]?.name || '',
    battleNum: group?.battle_num ?? raw?.battle_num ?? 0,
    hasData: floors.length > 0 || !!raw?.has_data,
  }
}

export const SR_CFG = {
  chaos: { type: 'chaos', title: '混沌回忆', api: 'getChallengeChaos', tpl: 'abyss-challenge' },
  story: { type: 'story', title: '虚构叙事', api: 'getChallengeStory', tpl: 'challenge-story' },
  boss: { type: 'boss', title: '末日幻影', api: 'getChallengeBoss', tpl: 'challenge-boss' },
  peak: { type: 'peak', title: '王棋（异相仲裁）', api: 'getChallengePeak', tpl: 'challenge-peak' },
}

export function buildSrChallengeData(raw, cfg) {
  const data = buildSrChallenge(raw, cfg)
  return data.hasData ? data : null
}
