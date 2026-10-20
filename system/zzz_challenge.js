// 绝区零挑战数据归一化（式舆防卫战 / 危局强袭战）
//
// 模板直接复用 ZZZ-Plugin 仓库里作者自己写的两套页面（已复制到
// resources/zzz_challenge/，只改了资源路径前缀）：
//   式舆：challenge.html   ← ZZZero/html/challenge/challenge.html
//   危局：deadly.html      ← ZZZero/html/memDetail/memDetail.html
// 所以这里的字段名必须和它们的模板对齐，不要随意改名。
//
// 数据来源：米游社 record 接口
//   式舆：/api/zzz/hadal_info_v2       → hadal_info_v2
//   危局：/api/zzz/hadal_mem_detail_v2 → has_data / list / total_star …

/** 元素英文键 → 本地图标文件名（resources/zzz_challenge/element/ 下） */
const ELEM_ICON = {
  physical: 'Physical', fire: 'Fire', ice: 'Ice', electric: 'Electric',
  lightning: 'Electric', ether: 'Ether', wind: 'Wind',
  quantum: 'Quantum', imaginary: 'Imaginary',
}
const ELEM_CN = {
  physical: '物理', fire: '火', ice: '冰', electric: '电', lightning: '电',
  ether: '以太', wind: '风', quantum: '量子', imaginary: '虚数',
}

/** 弱点/抗性 → 模板的 tag 结构。模板写的是 {{ppath}}{{tag.icon}}，所以给插件相对路径 */
export function toElementTags(list = []) {
  return (Array.isArray(list) ? list : String(list || '').split(/[/、,]/))
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .map(name => {
      const icon = ELEM_ICON[name.toLowerCase()] || ''
      return { name: ELEM_CN[name.toLowerCase()] || name, icon: icon ? `zzz_challenge/element/${icon}.png` : '' }
    })
}

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
const fmtDate = o => (o ? `${o.year}.${pad(o.month)}.${pad(o.day)}` : '')
const fmtDateTime = o => (o ? `${fmtDate(o)} ${pad(o.hour)}:${pad(o.minute)}` : '')

/** 距离 end 还有多久 */
function remainingText(end) {
  if (!end) return ''
  const t = new Date(end.year, (end.month || 1) - 1, end.day || 1, end.hour || 0, end.minute || 0)
  const ms = t - new Date()
  if (!Number.isFinite(ms) || ms <= 0) return '已结束'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor((ms % 3600000) / 60000)} 分钟`
}

/** 挑战用时（秒）→ 「1 分 35 秒」 */
function formatSeconds(v) {
  const n = Number(v) || 0
  if (n <= 0) return ''
  const m = Math.floor(n / 60)
  const s = n % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

const LAYER_KEYS = [
  ['first', '一'], ['second', '二'], ['third', '三'], ['fourth', '四'], ['fitfh', '五'],
]

/** 式舆里每层的评级图片名：S→s.png / A→a.png / B→b.png */
const ratingPic = r => {
  const k = String(r || '').toUpperCase()
  return k === 'S' ? 's' : k === 'A' ? 'a' : 'b'
}

/**
 * 式舆防卫战 → challenge.html 的模板数据
 * @param {object} raw hadal_info_v2 节点
 */
export function normalizeShiyu(raw = {}, meta = {}) {
  const data = raw?.hadal_info_v2 || raw || {}

  const grade = { S: 0, A: 0, B: 0 }
  const layers = []
  for (const [key, zh] of LAYER_KEYS) {
    const d = data[`${key}_layer_detail`]
    if (!d || !Array.isArray(d.layer_challenge_info_list)) continue
    const items = d.layer_challenge_info_list.map(item => {
      const rating = String(item?.rating || '').toUpperCase()
      if (grade[rating] !== undefined) grade[rating]++
      const boss = pickBoss(item)
      return {
        ...item,
        // 模板用它拼图片、也直接显示
        rating: ratingPic(rating),
        // 模板用 item.rating 显示；真实评级放到 challenge_time 旁边不现实，这里保持图片即可
        challenge_time_fmt: item?.challenge_time ? formatSeconds(item.challenge_time) : '',
        avatars: (item?.avatars || item?.avatar_list || []).map(a => ({
          name: a?.name || '',
          role_square_url: a?.icon || a?.avatar || a?.role_square_url || '',
          rank: Number(a?.rank ?? a?.rarity ?? 0) || 0,
          rarity: a?.rarity || '',
        })).filter(a => a.name),
        buffer: item?.buffer?.text ? { text: stripTags(item.buffer.text) } : null,
        /* 立绘直接用接口的 monster_pic（米游社 CDN 完整 URL）；
           不要写成 boss?.pic || ''，取不到 boss 时会把原字段清空，导致没图 */
        monster_pic: boss?.pic || item?.monster_pic || '',
        monster_name: boss?.name || item?.monster_name || '',
        monster_weakness_tags: toElementTags(boss?.weakness?.length ? boss.weakness : item?.monster_weakness),
        monster_resistance_tags: toElementTags(boss?.resist?.length ? boss.resist : item?.monster_resistance),
      }
    })
    layers.push({
      name: key,
      zh,
      data: {
        ...d,
        layer_challenge_info_list: items,
        challenge_time: d.challenge_time ? { ...d.challenge_time, fmt: fmtDateTime(d.challenge_time) } : null,
      },
    })
  }

  const brief = data?.brief || {}
  return {
    type: 'shiyu',
    uid: meta.uid || '',
    nickname: meta.nickname || '',
    avatar_icon: meta.avatar || '',
    level: meta.level || '',
    period: data.hadal_begin_time
      ? `${fmtDate(data.hadal_begin_time)} - ${fmtDate(data.hadal_end_time)}`
      : '',
    remain: remainingText(data.hadal_end_time),
    brief,
    // 模板用 {{brief_rating}}.png：S+ → SP
    brief_rating: String(brief?.rating || '').replace('+', 'P').toUpperCase(),
    rank_percent: brief?.rank_percent != null ? (Number(brief.rank_percent) / 100).toFixed(2) : '',
    grade,
    layers,
    empty: !layers.length,
  }
}

/** 从节点里抠 BOSS 信息（不同版本字段位置不一样，全都兜一遍） */
function pickBoss(item = {}) {
  const pic = item.monster_pic || item.boss_pic || item.boss?.monster_pic || item.boss?.pic || ''
  const name = item.monster_name || item.boss_name || item.boss?.name || ''
  const weakness = item.monster_weakness || item.boss?.weakness || item.weakness || []
  const resist = item.monster_resistance || item.boss?.resistance || item.resistance || []
  if (!pic && !name && !weakness.length && !resist.length) return null
  return { pic, name, weakness, resist }
}

/** BOSS 背景序号：接口给 boss_bg_3 这种文件名，取数字；没有就按序号循环 */
function bossBgNum(boss = {}, idx = 0) {
  const m = String(boss?.bg_icon || boss?.icon || '').match(/boss_bg_?(\d)/)
  if (m) return m[1]
  return String((idx % 4) + 1)
}

/**
 * 危局强袭战 → deadly.html 的模板数据
 * @param {object} raw hadal_mem_detail_v2 的 data 节点
 */
export function normalizeDeadly(raw = {}, meta = {}) {
  const list = (raw?.list || []).map((v, idx) => {
    const boss = v?.boss?.[0] || {}
    const buff = v?.buffer?.[0] || {}
    return {
      score: v?.score ?? '',
      star: Number(v?.star) || 0,
      total_star: Number(v?.total_star) || 0,
      challenge_time: v?.challenge_time ? fmtDateTime(v.challenge_time) : '',
      boss: {
        ...boss,
        bg_num: bossBgNum(boss, idx),
        icon: boss?.monster_pic || boss?.boss_pic || boss?.image || boss?.pic || '',
        name: boss?.name || boss?.monster_name || '',
        race_icon: boss?.race_icon || '',
        monster_weakness_tags: toElementTags(boss?.weakness || boss?.monster_weakness),
        monster_resistance_tags: toElementTags(boss?.resistance || boss?.monster_resistance),
      },
      buffer: {
        icon: buff?.icon || '',
        name: buff?.name || '',
        desc: buff?.desc ? stripTags(buff.desc) : '',
      },
      avatars: (v?.avatar_list || []).map(a => ({
        name: a?.name || '',
        role_square_url: a?.icon || a?.avatar || a?.role_square_url || '',
        rank: Number(a?.rank ?? a?.rarity ?? 0) || 0,
        rarity: a?.rarity || '',
      })).filter(a => a.name),
      buddy: {
        bangboo_rectangle_url: v?.buddy?.bangboo_rectangle_url || v?.buddy?.icon || '',
        rarity: v?.buddy?.rarity || '',
      },
    }
  })

  return {
    type: 'deadly',
    uid: meta.uid || '',
    nickname: raw?.nick_name || meta.nickname || '',
    avatar_icon: raw?.avatar_icon || meta.avatar || '',
    period: raw?.start_time ? `${fmtDate(raw.start_time)} - ${fmtDate(raw.end_time)}` : '',
    remain: remainingText(raw?.end_time),
    total_star: Number(raw?.total_star) || 0,
    total_score: raw?.total_score ?? '',
    rank_percent: raw?.rank_percent != null ? (Number(raw.rank_percent) / 100).toFixed(2) : '',
    list,
    hard_list: (raw?.hard_list || []).map((v, idx) => ({
      score: v?.score ?? '',
      star: Number(v?.star) || 0,
      total_star: Number(v?.total_star) || 0,
      boss: { ...(v?.boss?.[0] || {}), bg_num: bossBgNum(v?.boss?.[0], idx) },
    })),
    empty: !raw?.has_data || !list.length,
  }
}
