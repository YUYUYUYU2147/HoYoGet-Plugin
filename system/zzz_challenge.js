// 绝区零挑战数据（式舆防卫战 / 危局强袭战）归一化
//
// 数据来自米游社 record 接口（apps/zzz_panel_list.js 的 zzzRemindFetch）：
//   式舆：/api/zzz/hadal_info_v2     → { hadal_info_v2: { brief, first~fitfh_layer_detail } }
//   危局：/api/zzz/hadal_mem_detail_v2 → { has_data, total_star, total_score, list[] }
// 这里只做「原始响应 → 模板扁平结构」，排版在 resources/zzz_challenge/ 里自己做，
// 不复用 ZZZ-Plugin 的模板。

/** 去掉富文本标签，保留换行 */
const stripTags = (s = '') => String(s)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const pad = n => String(n || 0).padStart(2, '0')

/** {year,month,day,hour,minute} → YYYY.MM.DD */
function fmtDate(o) {
  if (!o) return ''
  return `${o.year}.${pad(o.month)}.${pad(o.day)}`
}

/** {year,month,day,hour,minute} → YYYY.MM.DD HH:mm */
function fmtDateTime(o) {
  if (!o) return ''
  return `${fmtDate(o)} ${pad(o.hour)}:${pad(o.minute)}`
}

/** 距离 end_time 还有多久（用于「刷新剩余」） */
function remainingText(end) {
  if (!end) return ''
  const t = new Date(end.year, (end.month || 1) - 1, end.day || 1, end.hour || 0, end.minute || 0)
  const ms = t - new Date()
  if (!Number.isFinite(ms) || ms <= 0) return '已结束'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor((ms % 3600000) / 60000)} 分钟`
}

/** 元素英文键 → 中文（挑战里怪物弱点是英文键） */
const ELEM_CN = {
  physical: '物理', fire: '火', ice: '冰', electric: '电', lightning: '电',
  wind: '风', ether: '以太', quantum: '量子', imaginary: '虚数',
}
const elemCn = e => ELEM_CN[String(e || '').toLowerCase()] || String(e || '')

/** 评级排序权重，用于统计 S/A/B 数量 */
const RATINGS = ['S', 'A', 'B']

const LAYERS = [
  ['first', '一'], ['second', '二'], ['third', '三'], ['fourth', '四'], ['fitfh', '五'],
]

/**
 * 式舆防卫战 → 模板数据
 * @param {object} raw 接口返回的 hadal_info_v2 节点
 */
export function normalizeShiyu(raw = {}, meta = {}) {
  const data = raw?.hadal_info_v2 || raw || {}
  const layers = []
  let total = 0
  const grade = { S: 0, A: 0, B: 0 }

  for (const [key, zh] of LAYERS) {
    const d = data[`${key}_layer_detail`]
    if (!d) continue
    const nodes = (d.layer_challenge_info_list || []).map((item, idx) => {
      const rating = String(item?.rating || '').toUpperCase().replace('+', '')
      if (grade[rating] !== undefined) grade[rating]++
      total++
      return {
        index: idx + 1,
        rating: item?.rating || '',
        ratingKey: String(item?.rating || '').toUpperCase().replace(/[^SAB]/g, '').slice(0, 1),
        // 挑战用时只给秒数
        timeText: Number(item?.challenge_time) > 0 ? formatSeconds(item.challenge_time) : '',
        // 节点名/队伍：接口给的是 avatars，取名字
        avatars: (item?.avatars || []).map(a => ({
          name: a?.name || '',
          icon: a?.icon || a?.avatar || '',
          rarity: a?.rarity || '',
          level: a?.level || '',
        })).filter(a => a.name),
        // 每层的 buff（剧变节点增益）
        buff: item?.buffer?.text ? stripTags(item.buffer.text) : '',
      }
    })
    // 第五层的怪物信息（弱点/抗性）只在部分数据里有
    const boss = extractBoss(d)
    layers.push({
      key,
      zh,
      rating: d?.rating || '',
      ratingKey: String(d?.rating || '').toUpperCase().replace(/[^SAB]/g, '').slice(0, 1),
      score: d?.score ?? '',
      timeText: fmtDateTime(d?.challenge_time),
      nodes,
      boss,
    })
  }

  const brief = data?.brief || {}
  return {
    type: 'shiyu',
    title: '式舆防卫战',
    period: data.hadal_begin_time ? `${fmtDate(data.hadal_begin_time)} - ${fmtDate(data.hadal_end_time)}` : '',
    remain: remainingText(data.hadal_end_time),
    score: brief.score ?? '',
    rating: brief.rating || '',
    /* CSS 类名只能用 S/A/B（'+' 不能当类名），原文另存一份用于展示 */
    ratingKey: String(brief.rating || '').toUpperCase().replace(/[^SAB]/g, '').slice(0, 1),
    rankPercent: brief.rank_percent != null ? (Number(brief.rank_percent) / 100).toFixed(2) : '',
    grade,
    total,
    layers,
    uid: meta.uid || '',
    nickname: meta.nickname || '',
    avatar: meta.avatar || '',
    level: meta.level || '',
    empty: !layers.length,
  }
}

/** 挑战用时（秒）→ m 分 s 秒 */
function formatSeconds(v) {
  const n = Number(v) || 0
  if (n <= 0) return ''
  const m = Math.floor(n / 60)
  const s = n % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

/** 从层数据里尽量抠出 BOSS 名字与弱点（不同版本字段不稳定，全都做可选） */
function extractBoss(layerData) {
  const list = layerData?.layer_challenge_info_list || []
  for (const item of list) {
    const pic = item?.monster_pic || item?.boss_pic || item?.boss?.monster_pic || ''
    const name = item?.monster_name || item?.boss_name || item?.boss?.name || ''
    if (!pic && !name) continue
    const weakness = item?.monster_weakness || item?.boss?.weakness || item?.weakness || []
    const resist = item?.monster_resistance || item?.boss?.resistance || item?.resistance || []
    return {
      name,
      pic,
      weakness: (Array.isArray(weakness) ? weakness : String(weakness || '').split(/[/、,]/)).map(elemCn).filter(Boolean),
      resist: (Array.isArray(resist) ? resist : String(resist || '').split(/[/、,]/)).map(elemCn).filter(Boolean),
    }
  }
  return null
}

/**
 * 危局强袭战 → 模板数据
 * @param {object} raw hadal_mem_detail_v2 的 data 节点
 */
export function normalizeDeadly(raw = {}, meta = {}) {
  const hasData = !!raw?.has_data
  const rooms = (raw?.list || []).map((v, idx) => {
    const boss = v?.boss?.[0] || {}
    const buff = v?.buffer?.[0] || {}
    const weakness = boss?.weakness || boss?.monster_weakness || []
    const resist = boss?.resistance || boss?.monster_resistance || []
    return {
      index: idx + 1,
      score: v?.score ?? '',
      star: Number(v?.star) || 0,
      totalStar: Number(v?.total_star) || 0,
      bossName: boss?.name || boss?.monster_name || '',
      bossPic: boss?.monster_pic || boss?.boss_pic || boss?.image || boss?.pic || '',
      weakness: (Array.isArray(weakness) ? weakness : String(weakness || '').split(/[/、,]/)).map(elemCn).filter(Boolean),
      resist: (Array.isArray(resist) ? resist : String(resist || '').split(/[/、,]/)).map(elemCn).filter(Boolean),
      buffName: buff?.name || '',
      buffDesc: buff?.desc ? stripTags(buff.desc) : '',
      avatars: (v?.avatar_list || []).map(a => ({
        name: a?.name || '',
        icon: a?.icon || a?.avatar || '',
        rarity: a?.rarity || '',
        level: a?.level || '',
      })).filter(a => a.name),
    }
  })

  // 强袭战的「困难」模式（部分版本有）
  const hardRooms = (raw?.hard_list || []).map((v, idx) => ({
    index: idx + 1,
    score: v?.score ?? '',
    star: Number(v?.star) || 0,
    totalStar: Number(v?.total_star) || 0,
    bossName: v?.boss?.[0]?.name || '',
  }))

  return {
    type: 'deadly',
    title: '危局强袭战',
    period: raw?.start_time ? `${fmtDate(raw.start_time)} - ${fmtDate(raw.end_time)}` : '',
    remain: remainingText(raw?.end_time),
    totalStar: Number(raw?.total_star) || 0,
    totalScore: raw?.total_score ?? '',
    rankPercent: raw?.rank_percent != null ? (Number(raw.rank_percent) / 100).toFixed(2) : '',
    rooms,
    hardRooms,
    hardRankPercent: raw?.hard_rank_percent != null ? (Number(raw.hard_rank_percent) / 100).toFixed(2) : '',
    uid: meta.uid || '',
    nickname: raw?.nick_name || meta.nickname || '',
    avatar: raw?.avatar_icon || meta.avatar || '',
    level: meta.level || '',
    empty: !hasData || !rooms.length,
  }
}
