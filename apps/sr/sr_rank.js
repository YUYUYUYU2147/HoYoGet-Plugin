import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render } from '#HoYoGet'
import { fetchLeaderboard, fetchCharacterMap, STAT_NAMES, DEFAULT_STAT } from '../../system/fortoffans.js'
import { metaResRel } from '#hoyo.miao.path'
import { getRoleProfile } from '../../system/roleProfile.js'

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
/* *我的全球排名 [UID]：查自己每个角色的 fort off fans 名次 */
const RE_MY_RANK = new RegExp(
  `^[#%＊*]*\\s*(?:${SR_PREFIX}\\s*)?我的\\s*${RANK_WORD}(?:\\s+(\\d{9}))?(?:\\s+(.+))?$`,
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
        { reg: RE_MY_RANK.source, fnc: 'myRank' },
        { reg: RE_RANK.source, fnc: 'rank' },
      ],
    })
  }

  async accept(e) {
    const msg = String(e?.msg || '').trim()
    if (!SR_PREFIX_RE.test(msg)) return false
    if (RE_MY_RANK.test(msg)) { await this.myRank(e); return 'return' }
    if (RE_RANK.test(msg)) { await this.rank(e); return 'return' }
    return false
  }

  /** 远程头像转 data URI：渲染器可能不等远程 img 加载完就截图，头像会空 */
  async inlineAvatar(url) {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return ''
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(6000) })
      if (!res.ok) return ''
      const type = String(res.headers.get('content-type') || '')
      if (!/^image\//i.test(type)) return ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length || buf.length > 2 * 1024 * 1024) return ''
      return `data:${type};base64,${buf.toString('base64')}`
    } catch (_) {
      return ''
    }
  }

  async myRank(e) {
    const m = String(e.msg || '').match(RE_MY_RANK)
    let uid = m?.[1] || ''
    const nicknameOverride = String(m?.[2] || '').replace(/^昵称[:：]\s*/, '').trim()
    if (!uid) {
      try {
        const { readBoundUid } = await import('../common/hoyo_panel.js')
        uid = await readBoundUid(e, 'sr')
      } catch (_) { /* ignore */ }
    }
    if (!uid) {
      return e.reply('没有找到你的星铁 UID。\n用法：*我的全球排名 123456789\n或先绑定：*绑定 123456789')
    }
    const file = path.join(process.cwd(), 'data', 'PlayerData', 'sr', `${uid}.json`)
    let data = {}
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (_) { /* ignore */ }
    const roleProfile = await getRoleProfile(e, uid, 'sr').catch(() => ({}))
    const nickname = nicknameOverride || roleProfile?.nickname || String(data?.name || '').trim()
    if (!nickname) {
      return e.reply(`还没读到 UID ${uid} 的面板数据。\n请先发「*更新面板」或「*米游社更新面板」，把角色放进游戏内展柜后再试。`)
    }
    const avatars = Object.entries(data?.avatars || {})
      .filter(([, a]) => a && (a.artis || a._source))
      .slice(0, 60)
    if (!avatars.length) return e.reply(`UID ${uid} 暂无可查询的角色面板。`)
    await e.reply(`正在查询 ${nickname}（UID ${uid}）的星铁全球排名，请稍候…`, true, { recallMsg: 60 })
    const chars = loadCharNames()
    let Character = null
    try { ({ Character } = await import('#hoyo.miao.models')) } catch (_) { /* ignore */ }
    // system/ 下的模块被静态 import 时热重载不会替换，这里带版本号动态加载
    const { fetchPersonalRank, fetchLeaderboardRank } = await import(`../../system/fortoffans.js?t=${Date.now()}`)
    const results = []
    let errors = 0
    for (let i = 0; i < avatars.length; i += 6) {
      const chunk = avatars.slice(i, i + 6)
      const part = await Promise.all(chunk.map(async ([id, a]) => {
        try {
          const pr = await fetchPersonalRank({ nickname, char: id, eidolon: a.cons ?? a.rank ?? 0 })
          if (!pr || pr.rank == null) return null
          const e = pr.entry || {}
          // 优先用遗器评分（wrqs）榜；searchRank 对 wrqs 不生效，需要逐页找
          let wrqs = null
          if (e.uid) {
            try { wrqs = await fetchLeaderboardRank({ char: id, eid: pr.bracket, stat: 'wrqs', uid: e.uid, maxPages: 40 }) } catch (_) {}
          }
          const rank = wrqs?.rank ?? pr.rank
          const total = wrqs?.total ?? pr.total
          const eidolon = Number(e.eidolon ?? a.cons ?? a.rank ?? 0) || 0
          const pct = total ? Math.max(0, Math.min(100, (1 - rank / total) * 100)) : 0
          return {
            name: chars[id]?.name || e.char_name || a.name || id,
            face: Character?.get?.(id)?.imgs?.face || '',
            rank,
            total,
            rankKind: wrqs ? '遗器评分' : 'CRIT',
            eidolon,
            beatPercent: pct.toFixed(1),
            critValue: e.stat_tcv != null ? Number(e.stat_tcv).toFixed(1) : '—',
            critRate: e.stat_crit_rate != null ? (Number(e.stat_crit_rate) * 100).toFixed(1) + '%' : '—',
            critDmg: e.stat_crit_dmg != null ? (Number(e.stat_crit_dmg) * 100).toFixed(1) + '%' : '—',
            spd: e.stat_spd != null ? Number(e.stat_spd).toFixed(0) : '—',
          }
        } catch (_) { return null }
      }))
      results.push(...part.filter(Boolean))
    }
    if (!results.length) {
      return e.reply([
        `没有在 fort off fans 查到 ${nickname} 的星铁角色排名。`,
        `已查询 ${avatars.length} 个角色，异常 ${errors} 个。`,
        '这个站只收录玩家主动提交的展柜，且昵称必须与网站显示一致。',
        '可先在 hsr.fortoffans.com 搜索你的昵称确认；如果游戏昵称不同，可以这样指定：',
        '*我的全球排名 <UID> 昵称:网站上显示的昵称',
      ].join('\n'))
    }
    results.sort((a, b) => a.rank - b.rank)
    try {
      const miaoResPath = '../../../../..' + '/' + metaResRel()
      const img = await render('sr_rank/my', {
        nickname,
        uid,
        ownerAvatar: await this.inlineAvatar(roleProfile?.avatar),
        level: roleProfile?.userLevel || data?.level || '',
        signature: roleProfile?.signature || data?.sign || '',
        region: roleProfile?.serverName || '',
        queried: avatars.length,
        rows: results.slice(0, 20),
        _miao_path: miaoResPath,
      }, { e, ret: true, dsf: 2.5 })
      if (img) return img
    } catch (err) {
      logger.error?.(`[HoYoGet][sr_rank] 个人排名出图失败：${err?.message || err}`)
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.name}：第 ${r.rank} / 共 ${r.total ?? '?'}${r.eidolon ? `（${r.eidolon}魂）` : ''}`)
    return e.reply([`星铁全球排名 · ${nickname}（UID ${uid}）`, ...lines].join('\n'))
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
