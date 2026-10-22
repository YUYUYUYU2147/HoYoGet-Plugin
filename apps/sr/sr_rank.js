import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render } from '#HoYoGet'
import { fetchLeaderboard, fetchCharacterMap, STAT_NAMES, DEFAULT_STAT } from '../../system/fortoffans.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NAMES_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'sr_workshop_names.json')

/* 星铁前缀等价写法（与 sr_workshop 一致，框架会把 * / 崩铁 / 星穹 统一改写为 #星铁） */
const SR_PREFIX = '(?:米哈游)?(?:星铁|星轨|穹轨|星穹|崩铁|星穹铁道|崩坏星穹铁道|铁道|sr|hsr)'
const SR_PREFIX_RE = new RegExp(`^[#%＊*]*\\s*(${SR_PREFIX})`, 'i')

/* 「全球排名」关键词：全球榜/全球排名/世界排名/世界榜 */
const RANK_WORD = '(?:全球|世界)(?:角色)?(?:练度|属性|词条)?(?:排名|排行|榜)'
const RE_RANK = new RegExp(
  `^[#%＊*]*\\s*(?:${SR_PREFIX}\\s*)?\\s*${RANK_WORD}(?:\\s+(.+))?$`,
  'i',
)

/* 属性别名 → stat key */
const STAT_ALIAS = {
  'crit值': 'stat_tcv', '双暴': 'stat_tcv', '词条': 'stat_tcv', '练度': 'stat_tcv',
  '暴击率': 'stat_crit_rate', '暴率': 'stat_crit_rate', '会心': 'stat_crit_rate',
  '暴击伤害': 'stat_crit_dmg', '暴伤': 'stat_crit_dmg', '爆伤': 'stat_crit_dmg',
  '速度': 'stat_spd', '攻击': 'stat_atk', '攻击力': 'stat_atk', '生命': 'stat_hp',
  '生命值': 'stat_hp', '防御': 'stat_def', '防御力': 'stat_def',
  '击破特攻': 'stat_break_effect', '击破': 'stat_break_effect',
  '效果命中': 'stat_effect_hit', '治疗加成': 'stat_healing_boost',
  '遗器评分': 'wrqs', '遗器分': 'wrqs', '最优化': 'opt_score',
}

/** 读取中文角色表：id → {name, star, elem, path} */
function loadCharNames() {
  try {
    const d = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf-8'))
    return d?.chars || {}
  } catch {
    return {}
  }
}
/** 中文名（或英文名）→ 角色 id */
function resolveChar(input) {
  const chars = loadCharNames()
  const q = String(input || '').trim().toLowerCase()
  if (!q) return null
  // 直接是数字 id
  if (/^\d+$/.test(q) && chars[q]) return { id: q, ...chars[q] }
  // 中文名精确/包含匹配
  for (const [id, c] of Object.entries(chars)) {
    if ((c.name || '').toLowerCase() === q) return { id, ...c }
  }
  for (const [id, c] of Object.entries(chars)) {
    if ((c.name || '').toLowerCase().includes(q)) return { id, ...c }
  }
  return null
}

function resolveStat(input) {
  const q = String(input || '').trim()
  if (!q) return DEFAULT_STAT
  // 直接是 stat key
  if (STAT_NAMES[q]) return q
  // 中文别名
  if (STAT_ALIAS[q]) return STAT_ALIAS[q]
  const lower = q.toLowerCase()
  if (STAT_ALIAS[lower]) return STAT_ALIAS[lower]
  return null
}

/* 属性数值格式化：百分比类 / 大数值类分开 */
function fmtStat(stat, v) {
  if (v == null || Number.isNaN(Number(v))) return '—'
  const pctKeys = ['stat_crit_rate', 'stat_crit_dmg', 'stat_break_effect', 'stat_effect_hit', 'stat_healing_boost', 'sub_cr', 'sub_cd', 'sub_atk_pct', 'sub_hp_pct', 'sub_def_pct', 'sub_break', 'sub_ehr']
  if (pctKeys.includes(stat)) return (Number(v) * 100).toFixed(1) + '%'
  if (stat === 'stat_tcv' || stat === 'stat_crit_value') return Number(v).toFixed(1)
  if (['stat_spd', 'stat_atk', 'stat_hp', 'stat_def', 'sub_spd', 'sub_count', 'wrqs', 'opt_score'].includes(stat)) return Number(v).toFixed(stat === 'sub_count' ? 0 : 1)
  return Number(v).toFixed(1)
}

const ELEM_CN = { Physical: '物理', Fire: '火', Ice: '冰', Thunder: '雷', Wind: '风', Quantum: '量子', Imaginary: '虚数' }
const ELEM_COLOR = { Physical: '#c9c3b6', Fire: '#e8786a', Ice: '#7fb6e6', Thunder: '#c39bf0', Wind: '#7ed6b2', Quantum: '#8a8fce', Imaginary: '#e6cf7f' }
function elemColorOf(elem) {
  // ch.elem 是中文（火/冰/雷…），映射回英文色
  const rev = { '物理': 'Physical', '火': 'Fire', '冰': 'Ice', '雷': 'Thunder', '风': 'Wind', '量子': 'Quantum', '虚数': 'Imaginary' }
  return ELEM_COLOR[rev[elem] || elem] || '#e7ebf3'
}

export class sr_global_rank extends plugin {
  constructor() {
    super({
      name: '[米哈游]星铁全球排名',
      dsc: '星铁角色全球练度排名（fort off fans）',
      event: 'message',
      priority: pluginPriority('sr_global_rank', -40500),
      rule: [
        { reg: RE_RANK.source, fnc: 'rank' },
      ],
    })
  }

  async accept(e) {
    const msg = String(e?.msg || '').trim()
    if (!SR_PREFIX_RE.test(msg)) return false
    if (RE_RANK.test(msg)) { await this.rank(e); return 'return' }
    return false
  }

  async rank(e) {
    const raw = String(e.msg || '')
    const m = raw.match(RE_RANK)
    const arg = String(m?.[1] || '').trim()

    if (!arg) {
      return e.reply([
        '星铁全球练度榜 · fort off fans',
        '',
        '用法：',
        '  星铁全球排名 <角色>            该角色全球 CRIT 值榜',
        '  星铁全球排名 <角色> <属性>     按指定属性排序',
        '  星铁全球排名 角色列表          查看收录角色',
        '',
        '属性：暴击率 / 暴击伤害 / 速度 / 攻击 / 生命 / 防御 / 击破 / 遗器评分 …',
        '数据来自 hsr.fortoffans.com（全球玩家上传面板，默认按 CRIT 值排序）。',
      ].join('\n'))
    }

    if (/^(角色列表|列表|list|角色)$/i.test(arg)) return this.listRoles(e)

    // 解析「角色 [属性]」
    const parts = arg.split(/\s+/)
    const charRaw = parts[0]
    const statRaw = parts.slice(1).join('')
    const stat = statRaw ? resolveStat(statRaw) : DEFAULT_STAT
    if (statRaw && !stat) {
      return e.reply(`没认出来属性「${statRaw}」。\n可选：暴击率 / 暴击伤害 / 速度 / 攻击 / 生命 / 防御 / 击破 / 遗器评分 …`)
    }

    let ch = resolveChar(charRaw)
    if (!ch) {
      // 中文名没匹配到，再试 fort off fans 的英文名（Acheron / Firefly / Seele …）
      try {
        const charMap = await fetchCharacterMap()
        const lower = charRaw.toLowerCase()
        const hit = Object.values(charMap).find(c => (c.name || '').toLowerCase() === lower)
          || Object.values(charMap).find(c => (c.name || '').toLowerCase().includes(lower))
        if (hit) {
          const cn = loadCharNames()[hit.id]
          ch = { id: hit.id, name: cn?.name || hit.name, star: cn?.star || 5, elem: cn?.elem || '', path: cn?.path || '' }
        }
      } catch (_) { /* 英文名匹配失败就按未找到处理 */ }
    }
    if (!ch) {
      return e.reply(`没找到角色「${charRaw}」。\n可发「星铁全球排名 角色列表」查看收录范围，或用英文名（如 黄泉=Acheron）。`)
    }

    try {
      const { entries, total } = await fetchLeaderboard({ char: ch.id, stat })
      if (!entries.length) return e.reply(`「${ch.name}」暂无全球榜数据。`)

      const statName = STAT_NAMES[stat] || stat
      const rows = entries.slice(0, 20).map((r, i) => ({
        rank: r.rank ?? i + 1,
        nickname: r.nickname || '',
        eidolon: r.eidolon ?? 0,
        charLevel: r.char_level ?? 80,
        main: fmtStat(stat, r[stat]),
        critRate: fmtStat('stat_crit_rate', r.stat_crit_rate),
        critDmg: fmtStat('stat_crit_dmg', r.stat_crit_dmg),
        spd: r.stat_spd != null ? Number(r.stat_spd).toFixed(0) : '—',
        lcName: r.lc_name || '',
        lcLevel: r.lc_level ?? 0,
        lcSuper: r.lc_superimpose ?? 0,
        updated: fmtTime(r.updated_at),
      }))

      const img = await render('sr_rank/rank', {
        roleName: ch.name,
        roleEn: '',
        elemCn: ch.elem || '',
        elemColor: elemColorOf(ch.elem),
        pathCn: ch.path || '',
        star: ch.star || 5,
        starStr: '★'.repeat(ch.star || 5),
        statName,
        statKey: stat,
        total,
        rows,
      }, { e, ret: true, dsf: 3.2 })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][sr_rank] 查询失败：${err?.message || err}`)
      return e.reply(`星铁全球排名查询失败：${err?.message || err}`)
    }
  }

  async listRoles(e) {
    const chars = loadCharNames()
    const list = Object.entries(chars)
      .sort((a, b) => b[1].star - a[1].star || a[0].localeCompare(b[0]))
    const five = list.filter(([, c]) => c.star === 5)
    const four = list.filter(([, c]) => c.star === 4)
    const line = ([id, c]) => `${c.name}`
    const lines = [
      `星铁全球榜收录角色（共 ${list.length}）`,
      '',
      `★5：${five.map(line).join('、')}`,
      '',
      `★4：${four.map(line).join('、')}`,
      '',
      '用法：星铁全球排名 <角色> [属性]',
    ]
    return e.reply(lines.join('\n'))
  }
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = Date.now()
  const diff = now - d.getTime()
  const day = 24 * 3600 * 1000
  if (diff < 3600 * 1000) return Math.max(1, Math.round(diff / 60000)) + ' 分钟前'
  if (diff < day) return Math.round(diff / 3600000) + ' 小时前'
  if (diff < 30 * day) return Math.round(diff / day) + ' 天前'
  return `${d.getMonth() + 1}-${d.getDate()}`
}
