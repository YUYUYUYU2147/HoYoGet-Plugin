import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render, yaml, mys } from '#HoYoGet'
import { buildBasicProperties, calcDamage as calcPanelDamage, calcEquipScore as calcEquipScoreShared } from './zzz_panel_list.js'

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

/**
 * 驱动盘评分统一走 apps/zzz_panel_list.js 的 calcEquipScore。
 *
 * 这里曾经有一份完整复制（权重表、主词条池、评分公式全都各存一份），
 * 结果给星见雅加直伤权重时只改了面板那份，排名榜还是 anomaly 模板，
 * 同一个角色在两个入口算出不同分数。
 * 现在只保留「原始 data → 归一化参数」的适配层，公式与权重只有一处。
 */
function calcEquipScore(data) {
  const equip = data?.equip || []
  const a = data || {}

  /* 面板版要求的是已归一化的属性：基础值另取、词条用 {pid, count}。
     原始 data 里 properties 是 [{property_id, base, final}]、盘上是 [{property_id, level}]，
     在这里一次性转换，避免把面板侧也改造成兼容两种格式。 */
  const baseProps = {}
  const stats = {}
  for (const p of a.properties || []) {
    const pid = Number(p.property_id)
    const base = parseFloat(p.base) || 0
    const final = parseFloat(p.final) || 0
    if (pid === 1 || pid === 11102) baseProps.hpmax = { base: String(base || final) }
    if (pid === 2 || pid === 12101) baseProps.attack = { base: String(base || final) }
    if (pid === 3 || pid === 13102) baseProps.def = { base: String(base || final) }
    if (pid === 2 || pid === 12101) stats.atk = base || final
    if (pid === 5) stats.crit = (final || 0) / 100
    if (pid === 6) stats.critdmg = (final || 0) / 100
    if (pid === 7) stats.am = final || 0
    if (pid === 8) stats.ap = final || 0
  }

  const equipFinal = equip.map(eq => ({
    slot: eq.equipment_type ?? 0,
    level: eq.level ?? 0,
    rarity: eq.rarity || 'A',
    main_properties: (eq.main_properties || []).map(p => ({ pid: p.property_id })),
    properties: (eq.properties || []).map(p => ({ pid: p.property_id, count: p.level ?? 0 })),
  }))

  return calcEquipScoreShared(
    equipFinal,
    a.name_mi18n || a.full_name_mi18n || '',
    stats,
    a.avatar_profession,
    a.element_type,
    baseProps,
  )
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
      /* 必须高于 ZZZ-Plugin（-30000）。
         Yunzai 先把所有插件的 accept 按优先级跑一遍，命中即 return、事件就此结束，
         所以 accept 的执行顺序完全由 priority 决定。
         本插件在「范围=本群」时靠 accept 接管「%雅排名」；若优先级低于 ZZZ-Plugin，
         它会先把这个指令当成自己的面板排名接走，这里根本轮不到。
         zzz_workshop(5000) 仍然在最前面，范围=全部时由它接管，两边不冲突。 */
      priority: pluginPriority('zzz_panel_rank', -20000),
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
    /* 带范围修饰词的写法（%雅全服排名 / %星见雅本群排名 / %xx工坊排名）一律放行：
       这类是「临时指定范围」，由 apps/zzz_workshop.js 处理，见那边的 accept。
       顺带一提，SHORT_RANK_REG 的 (.+?) 会把修饰词吃进角色名
       （%雅全服排名 → 「雅全服」），所以这里也不能接。 */
    if (/(?:全服|本群|工坊)排名$/.test(msg)) return false
    /* 不带修饰词时按「%面板排名范围」的当前值决定榜单：
         本群 → 本地面板排名（就是本文件）
         全部 → 工坊练度榜（交给 zzz_workshop 的 accept）
       这是为了两个入口语义一致：设成全部时，%雅排名 和 %雅全服排名 看同一个榜。 */
    if (getRankScope(e) !== 'group') return false
    /* 已经是「xx面板排名」的不用再接：accept 内部会把消息改写成这个形态，
       若被再次分发到 accept，SHORT_RANK_REG 会把它取成「雅面板」，
       导致角色名多出两个字。 */
    if (/面板排名$/.test(msg)) return false
    const m = msg.match(SHORT_RANK_REG)
    if (!m) return false
    if (/(?:全服|本群|工坊)$/.test(m[1])) return false
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
    const current = scopeLabel(getRankScope(e))
    const next = setScopeShared(getRankScope(e) === 'group' ? 'all' : 'group', e)
    return e.reply(`面板排名范围已切换为「${scopeLabel(next)}」（原「${current}」）。\n本群范围只统计群里已绑定绝区零 UID 的成员；非群聊时按全部统计。\n该设置已保存，重启后仍然有效。`)
  }

  async rankHelp(e) {
    return e.reply([
      '===== 绝区零面板排名系统 =====',
      '',
      '指令说明：',
      '  %<角色名>面板排名  - 查看角色面板排名（跨用户）',
      '  例：%艾莲面板排名、%丽娜面板排名',
      `  %面板排名范围      - 切换「本群 / 全部」，当前：${scopeLabel(getRankScope(e))}`,
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
    let label = scopeLabel(getRankScope(e))
    if (getRankScope(e) === 'group') {
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
      /* 伤害算不出来时留下原因，否则榜上只会显示「-」，看不出是倍率缺失还是面板字段缺失 */
      if (!dmg.damage && dmg.error) {
        logger.warn?.(`[HoYoGet][zzz_rank] ${charName}(${r.uid}) 伤害缺失：${dmg.error}`)
      }
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