import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render } from '#HoYoGet'
import { listCategories, fetchLeaderboard, getUserCalculations } from '../system/akasha.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')

/**
 * 原神 / 星铁 角色面板总览（自研版式，数据复用 miao-plugin 的模型）
 *
 * 为什么复用 miao 的数据层：米游社面板抓取、圣遗物/遗器评分、天赋与武器换算
 * 都在 miao-plugin 里实现得足够完整，重写一遍既慢又容易出错。
 * 这里只做「取数 → 整理成扁平结构 → 用自己的模板渲染」。
 *
 * miao-plugin 的 UI 与代码本身是开放的（作者 yoimiya-kokomi 明确说明可任意使用，
 * 备注来源即可），本模板版式参考其 profile-list 的网格布局，但样式与结构独立实现。
 *
 * 指令：
 *   #米哈游原神面板 / 米哈游原神面板
 *   #米哈游星铁面板 / 米哈游星铁面板
 *   #米哈游原神面板 123456789   （指定 UID）
 */

const GAME_CONF = {
  gs: { aliases: ['原神', 'gs'], cn: '原神', bind: '#', prefix: '#绑定' },
  sr: { aliases: ['星铁', '崩铁', 'sr'], cn: '星穹铁道', bind: '*', prefix: '*绑定' },
}

const PANEL_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*面板(?:\s+(\d{9}))?$/i
const PANEL_LIST_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*面板列表$/i
/* 带角色名 = 单角色详情图：#米哈游原神面板 桑多涅 */
const PANEL_CHAR_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*面板\s+(\S+)$/i
/* 更新面板：#米哈游原神更新面板 / #米哈游星铁更新面板 [UID] */
const PANEL_REFRESH_REG = /^#?(?:米哈游)?\s*(原神|星铁|崩铁|gs|sr)\s*(?:更新|刷新)(?:全部)?面板(?:\s+(\d{9}))?$/i

/** 从 Users 表读该用户的某个游戏 UID */
async function readBoundUid(e, game) {
  const qq = String(e?.user_id || e?.sender?.user_id || '').trim()
  if (!qq) return ''
  if (!fs.existsSync(YUNZAI_DB)) return ''
  try {
    const sqlite3 = (await import('sqlite3')).default
    const row = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve(null) : null))
      db.get('select games from Users where id = ?', [qq], (err2, r) => {
        db.close(() => {})
        resolve(err2 ? null : r)
      })
    })
    if (!row?.games) return ''
    const uid = String(JSON.parse(row.games)?.[game]?.uid || '').trim()
    if (/^[1-9]\d{8}$/.test(uid)) return uid
  } catch (_) {
    /* 回落下面的 MysUsers */
  }
  return ''
}

/**
 * 从 genshin 的 MysUsers 表读「当前生效 UID」。
 *
 * 为什么优先用它：`#uid 2` 这类切换只会重排 MysUsers.uids[game] 的顺序，
 * **不会改 Users.games.<game>.uid**。只读后者的话，用户切了 UID 这里仍拿旧的。
 * 所以先看 MysUsers（uid 列表第一项即当前生效），拿不到再回落 Users。
 */
async function readMysMainUid(e, game) {
  const qq = String(e?.user_id || e?.sender?.user_id || '').trim()
  if (!qq) return ''
  if (!fs.existsSync(YUNZAI_DB)) return ''
  try {
    const sqlite3 = (await import('sqlite3')).default
    const rows = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve([]) : null))
      db.all('select uids from MysUsers', (err2, list) => {
        db.close(() => {})
        resolve(err2 ? [] : list || [])
      })
    })
    // MysUsers 按 ltuid 存，需要再通过 Users.games 里的 ck 归属筛选出该 QQ 的账号；
    // 简单做法：取该 QQ 在 Users 里记过的所有 uid 作为候选，匹配到哪个 ltuid 就用它的 uids[0]
    const own = new Set()
    const userRow = await new Promise(resolve => {
      const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY, err => (err ? resolve(null) : null))
      db.get('select games from Users where id = ?', [qq], (err2, r) => {
        db.close(() => {})
        resolve(err2 ? null : r)
      })
    })
    try {
      const games = JSON.parse(userRow?.games || '{}')
      for (const uid of Object.keys(games?.[game]?.data || {})) own.add(String(uid))
      if (games?.[game]?.uid) own.add(String(games[game].uid))
    } catch (_) { /* ignore */ }
    if (!own.size) return ''
    for (const row of rows) {
      let uids = {}
      try { uids = JSON.parse(row.uids || '{}') } catch (_) { continue }
      const list = uids?.[game] || []
      if (list.some(u => own.has(String(u)))) {
        const main = String(list.find(u => own.has(String(u))) || list[0] || '')
        if (/^[1-9]\d{8}$/.test(main)) return main
      }
    }
  } catch (_) {
    /* 回落 */
  }
  return ''
}

/** 动态加载 miao 的模型；缺失时返回 null，让调用方给出可读提示 */
async function loadMiao() {
  try {
    const mod = await import('../../miao-plugin/models/index.js')
    return {
      Player: mod.Player,
      Character: mod.Character,
      MysApi: mod.MysApi,
    }
  } catch (_) {
    return null
  }
}

/**
 * 把一个 miao 的 profile（Avatar 实例）压成模板用的扁平结构。
 * 只取展示需要的字段，避免模板直接依赖 miao 的内部结构。
 */
function flattenProfile(profile, Character) {
  const char = profile.char
  const imgs = char?.imgs || {}
  const artis = profile.artis
  const weapon = profile.weapon
  const talent = profile.talent || {}

  // 圣遗物 / 遗器的总评分与段位（miao 的 ArtisMark 已经算好）
  const artisMark = artis?.markClass || ''
  const artisScore = artis?._mark != null ? Math.round(artis._mark * 10) / 10 : ''

  return {
    id: char?.id || '',
    name: char?.name || '',
    abbr: char?.abbr || char?.name || '',
    star: char?.star || 4,
    elem: char?.elem || '',
    level: profile.level || 1,
    cons: profile.cons || 0,
    // 立绘/头像：优先竖版脸图，退回方图
    // miao 的图片路径以 / 开头（相对 miao 的 resources），模板里要拼 _miao_path，去掉前导斜杠避免双斜杠
    face: String(imgs.qFace || imgs.face || '').replace(/^\//, ''),
    splash: imgs.splash || '',
    artisMark,
    artisScore,
    /* 总览卡右上角的评级徽章：档位与详情页同一套 */
    artisGrade: markTierOf(artisMark, artisScore),
    talent: Object.values(talent)
      .map(t => Number(t?.original ?? t?.level) || 0)
      .filter(Boolean)
      .sort((a, b) => b - a),
    weapon: weapon ? {
      name: weapon.name || '',
      star: weapon.star || 0,
      level: weapon.level || 0,
      refine: weapon.affix || 0,
      icon: String(weapon.imgs?.icon || '').replace(/^\//, ''),
    } : null,
    // 关键属性（模板里展示三四个就够）
    attrs: pickAttrs(profile),
  }
}

/** 从 profile 的属性里挑几个展示用 */
function pickAttrs(profile) {
  const a = profile.attr || {}
  const pct = v => (v == null || v === '') ? '' : `${(Number(v) * 100).toFixed(1)}%`
  const num = v => (v == null || v === '') ? '' : String(Math.round(Number(v)))
  return [
    { k: '生命', v: num(a.hp) },
    { k: '攻击', v: num(a.atk) },
    { k: '防御', v: num(a.def) },
    { k: '暴击', v: pct(a.cpct) },
    { k: '暴伤', v: pct(a.cdmg) },
    { k: '充能', v: pct(a.recharge) },
    { k: '精通', v: num(a.mastery) },
  ].filter(x => x.v)
}

/* ───────────── 单角色面板详情 ─────────────
 *
 * 数据仍来自 miao 的 Avatar 实例，但字段在新旧版本间有过调整，
 * 因此这里**全部按防御式取值**：拿不到就留空，由模板隐藏该项，
 * 而不是让整张图渲染失败。
 */

/** miao 属性键 → 中文名（原神；星铁另有自己的键，见 SR_STAT_CN） */
const GS_STAT_CN = {
  hp: '生命值', atk: '攻击力', def: '防御力', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '元素充能效率',
  heal: '治疗加成', shield: '护盾强效', dmg: '伤害加成',
  hpp: '生命值', atkp: '攻击力', defp: '防御力',
  pyro: '火元素伤害', hydro: '水元素伤害', cryo: '冰元素伤害', electro: '雷元素伤害',
  anemo: '风元素伤害', geo: '岩元素伤害', dendro: '草元素伤害', phys: '物理伤害',
}
const SR_STAT_CN = {
  hp: '生命值', atk: '攻击力', def: '防御力', spd: '速度', mastery: '击破特攻',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '能量恢复效率',
  effect: '效果命中', resist: '效果抵抗', heal: '治疗量加成', dmg: '伤害加成',
}
/** 需要带 % 的键；其余按整数处理 */
const PCT_KEYS = new Set([
  'cpct', 'cdmg', 'recharge', 'heal', 'shield', 'dmg', 'hpp', 'atkp', 'defp',
  'pyro', 'hydro', 'cryo', 'electro', 'anemo', 'geo', 'dendro', 'phys',
  'effect', 'resist',
])
/** 原神圣遗物部位（miao 的 artis 数组按此顺序） */
const GS_SLOTS = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']
const SR_SLOTS = ['头部', '手部', '躯干', '脚部', '位面球', '连结绳']

const stripSlash = p => String(p || '').replace(/^\//, '')

/**
 * miao 的 ArtisMark 类名有两种写法（ace / mark-ace），这里统一成不带前缀的小写关键字，
 * 模板据此加 class 配色、CSS 负责转大写显示（ACE / SSS / SS / S）。
 */
const markKeyOf = v => String(v || '').replace(/^mark-/i, '').toLowerCase()

/**
 * 圣遗物评级徽章的档位表，顺序与 miao 的 ArtisMark.getMarkClass 一致：
 *   D(7) < C(14) < B(21) < A(28) < S(35) < SS(42) < SSS(49) < ACE(56) < MAX(70)
 * 每档给一个 tier（0-8），模板据此上色，CSS 只认 tier，不再逐个写 class。
 */
const MARK_TIERS = ['d', 'c', 'b', 'a', 's', 'ss', 'sss', 'ace', 'max']
const MARK_TIER_LABEL = {
  d: 'D', c: 'C', b: 'B', a: 'A', s: 'S', ss: 'SS', sss: 'SSS', ace: 'ACE', max: 'MAX',
}
/** 评分 → 档位：与 miao 的阈值同一套，用于没有 markClass 时的兜底推算 */
function markTierOf(markClass, score) {
  let key = markKeyOf(markClass)
  if (!MARK_TIERS.includes(key)) {
    const pct = Number(score)
    const scoreMap = [['d', 7], ['c', 14], ['b', 21], ['a', 28], ['s', 35], ['ss', 42], ['sss', 49], ['ace', 56], ['max', 70]]
    key = scoreMap.find(([, limit]) => Number.isFinite(pct) && pct < limit)?.[0] || ''
  }
  const tier = MARK_TIERS.indexOf(key)
  return {
    key,
    tier: tier < 0 ? 0 : tier,
    label: tier < 0 ? '' : MARK_TIER_LABEL[key],
    hasBadge: tier >= 0,
  }
}

/** 取词条的键：miao 是 key，部分版本用 prop/type */
const propKey = p => String(p?.key || p?.prop || p?.type || p?.name || '')
/** 取词条值：可能叫 value / val / v */
const propRaw = p => (p?.value ?? p?.val ?? p?.v ?? '')

function propLabel(p, game) {
  if (!p) return ''
  const table = game === 'sr' ? SR_STAT_CN : GS_STAT_CN
  return p?.name || table[propKey(p)] || propKey(p)
}

/** 词条数值：值为数字时按键决定是否补 %；值本身带 % 或已格式化时不重复处理 */
function propText(p) {
  const raw = propRaw(p)
  if (raw === '' || raw == null) return ''
  const text = String(raw)
  if (/%/.test(text)) return text
  const n = Number(text)
  if (!Number.isFinite(n)) return text
  const isPct = PCT_KEYS.has(propKey(p)) || String(p?.isPct || '') === 'true'
  if (isPct) return `${(Math.abs(n) <= 1 ? n * 100 : n).toFixed(1)}%`
  return String(Math.round(n * 100) / 100)
}

/**
 * 词条图标：直接复用插件自带的属性图标（`resources/zzz_panel/images/panel_icons`），
 * 这些是白色线条符号，与游戏无关，原神/星铁都能用；没有对应图标的词条隐藏图标。
 */
const PROP_ICON = {
  hp: 'IconHpMax.png',
  hpp: 'IconHpMax.png',
  atk: 'IconAttack.png',
  atkp: 'IconAttack.png',
  def: 'IconDef.png',
  defp: 'IconDef.png',
  mastery: 'IconElementMystery.png',
  cpct: 'IconCrit.png',
  cdmg: 'IconCritDam.png',
  recharge: 'IconSpRecover.png',
  phys: 'Physical.png',
}

/**
 * 元素伤害图标改用 miao 自带的 `resources/common/bg/talent-<元素>.webp`，
 * 七个元素齐全（含借图标里没有的水/岩/草），与面板立绘同一套素材；
 * 找不到 miao 资源时 `iconMiao` 项会因 onerror 隐藏，不影响排版。
 */
const ELEM_ICON = {
  pyro: 'talent-pyro.webp',
  hydro: 'talent-hydro.webp',
  cryo: 'talent-cryo.webp',
  electro: 'talent-electro.webp',
  anemo: 'talent-anemo.webp',
  geo: 'talent-geo.webp',
  dendro: 'talent-dendro.webp',
}

function propIcon(p) {
  const key = propKey(p)
  if (PROP_ICON[key]) return { icon: PROP_ICON[key], iconMiao: false }
  if (ELEM_ICON[key]) return { icon: ELEM_ICON[key], iconMiao: true }
  return { icon: '', iconMiao: false }
}

/** 圣遗物 / 遗器：miao 的 Artis 实例里真正的数组在 .artis，少数版本直接是数组 */
function artisList(profile) {
  const a = profile?.artis
  if (Array.isArray(a)) return a
  if (Array.isArray(a?.artis)) return a.artis
  if (Array.isArray(a?.list)) return a.list
  return []
}

function flattenArtis(list, game) {
  const slots = game === 'sr' ? SR_SLOTS : GS_SLOTS
  return list.map((item, i) => {
    const mains = Array.isArray(item?.main) ? item.main : (item?.main ? [item.main] : [])
    const subs = Array.isArray(item?.attrs) ? item.attrs : (Array.isArray(item?.subs) ? item.subs : [])
    return {
      slot: item?.slot || slots[i] || '',
      name: item?.name || '',
      level: item?.level ?? 0,
      star: item?.star || 5,
      /* 模板里逐个渲染星形，不用「5★」这种文字 */
      stars: Array.from({ length: Math.min(5, Number(item?.star) || 5) }, () => 0),
      set: item?.set?.name || item?.setName || (typeof item?.set === 'string' ? item.set : ''),
      icon: stripSlash(item?.img || item?.imgs?.icon || item?.set?.imgs?.icon || ''),
      /* markClass 原样保留给卡片描边用；markKey/tier 供徽章配色与显示 */
      markClass: item?.markClass || '',
      markKey: markKeyOf(item?.markClass),
      mark: markTierOf(item?.markClass, item?._mark != null ? item._mark * 10 : null),
      score: item?._mark != null ? (Math.round(item._mark * 10) / 10).toFixed(1) : '',
      main: mains.slice(0, 1).map(p => ({ key: propKey(p), label: propLabel(p, game), value: propText(p), ...propIcon(p) })).filter(x => x.label && x.value),
      subs: subs.slice(0, 4).map(p => {
        const roll = subRoll(p, game)
        return {
          key: propKey(p),
          label: propLabel(p, game),
          value: propText(p),
          ...propIcon(p),
          /* 命中次数（词条数）与进度条宽度；词条不在有效集合里时只淡化显示 */
          roll: roll?.text || '',
          bar: roll?.bar || 0,
          valid: roll?.valid === true,
        }
      }).filter(x => x.label && x.value),
    }
  })
}

/** 属性行：原神 7 项、星铁 9 项，缺值自动跳过 */
function detailAttrRows(profile, game) {
  const a = profile?.attr || {}
  const spec = game === 'sr'
    ? [['hp', '生命值'], ['atk', '攻击力'], ['def', '防御力'], ['spd', '速度'],
      ['cpct', '暴击率'], ['cdmg', '暴击伤害'], ['mastery', '击破特攻'],
      ['effect', '效果命中'], ['resist', '效果抵抗']]
    : [['hp', '生命值上限'], ['atk', '攻击力'], ['def', '防御力'], ['mastery', '元素精通'],
      ['cpct', '暴击率'], ['cdmg', '暴击伤害'], ['recharge', '元素充能效率']]
  const pctKeys = new Set(['cpct', 'cdmg', 'recharge', 'effect', 'resist'])
  return spec.map(([k, label]) => {
    const v = a[k]
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    const text = pctKeys.has(k) ? `${(n * 100).toFixed(1)}%` : String(Math.round(n))
    return { key: k, label, value: text, ...propIcon({ key: k }) }
  }).filter(Boolean)
}

/**
 * 六轴雷达图：按常见毕业线归一化，超出即贴边。
 * 只做「相对强弱」示意，不代表官方评分。
 */
function buildRadar(profile, game) {
  const a = profile?.attr || {}
  const axes = game === 'sr'
    ? [['生命值', a.hp, 8000], ['攻击力', a.atk, 3000], ['防御力', a.def, 1200],
      ['暴击率', Number(a.cpct) * 100, 100], ['暴击伤害', Number(a.cdmg) * 100, 250], ['速度', a.spd, 160]]
    : [['生命值', a.hp, 35000], ['攻击力', a.atk, 2600], ['防御力', a.def, 1800],
      ['暴击率', Number(a.cpct) * 100, 100], ['暴击伤害', Number(a.cdmg) * 100, 250], ['元素充能', Number(a.recharge) * 100, 200]]
  const cx = 92
  const cy = 92
  const r = 62
  const points = []
  const labels = []
  const spokes = []
  axes.forEach(([label, value, full], i) => {
    const ratio = Math.max(0.14, Math.min(1, (Number(value) || 0) / full))
    const angle = -Math.PI / 2 + i * (Math.PI / 3)
    const x = cx + Math.cos(angle) * r * ratio
    const y = cy + Math.sin(angle) * r * ratio
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    const ex = cx + Math.cos(angle) * r
    const ey = cy + Math.sin(angle) * r
    spokes.push({ x1: cx, y1: cy, x2: ex.toFixed(1), y2: ey.toFixed(1) })
    const lx = cx + Math.cos(angle) * (r + 15)
    const ly = cy + Math.sin(angle) * (r + 15)
    labels.push({
      label,
      x: lx.toFixed(1),
      y: ly.toFixed(1),
      anchor: Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : (Math.cos(angle) > 0 ? 'start' : 'end'),
    })
  })
  /* 三层参考环：由外到内 1 / 0.66 / 0.33，模板里逐层输出 */
  const ring = scale => axes.map((_, i) => {
    const angle = -Math.PI / 2 + i * (Math.PI / 3)
    return `${(cx + Math.cos(angle) * r * scale).toFixed(1)},${(cy + Math.sin(angle) * r * scale).toFixed(1)}`
  }).join(' ')
  const grid = [1, 0.66, 0.33].map(ring)
  return { polygon: points.join(' '), labels, spokes, grid, cx, cy, r }
}

/** 天赋 / 行迹：{a,e,q} 或数组，统一成 [{label, level}] */
function detailTalents(profile, game, imgs = {}) {
  const t = profile?.talent || {}
  const names = game === 'sr'
    ? ['普攻', '战技', '终结技', '天赋', '秘技']
    : ['普攻', '战技', '爆发']
  const keys = game === 'sr' ? ['a', 'e', 'q', 't', 'z'] : ['a', 'e', 'q']
  const out = []
  /* 天赋图标与命座同源：miao 的 char.imgs 里以 a/e/q/t/z 为键存文件名 */
  const push = (label, item, key) => {
    const lv = Number(item?.original ?? item?.level ?? item) || 0
    if (lv > 0) {
      out.push({
        label,
        level: lv,
        icon: stripSlash(imgs?.[key] || imgs?.[`talent${key}`] || ''),
      })
    }
  }
  if (Array.isArray(t)) {
    t.slice(0, names.length).forEach((item, i) => push(names[i] || `天赋${i + 1}`, item, keys[i]))
  } else {
    keys.forEach((k, i) => push(names[i], t[k], k))
  }
  return out
}

/**
 * 圣遗物总评：总分取 miao 的 `artis._mark`，
 * 「有效词条」按暴击/暴伤/攻击%/生命%/防御%/充能/精通的副词条条数近似统计
 * （miao 的权重表未对外暴露，这里只是本插件口径，不是工坊/akasha 的绝对值）。
 */
const VALID_SUB_KEYS = new Set(['cpct', 'cdmg', 'atkp', 'hpp', 'defp', 'recharge', 'mastery'])

/**
 * 副词条「命中次数」：词条数值 ÷ 单词条平均档位。
 * 平均档位取 5★ 圣遗物 / 遗器各词条档位的均值（暴击率 3.3%、暴击伤害 6.6% …），
 * 与社区常用的「词条数」口径一致；miao 的逐角色权重表未对外暴露，
 * 因此这里只做数值折算，不乘角色权重。
 */
const GS_SUB_AVG = {
  hp: 239.4, atk: 15.56, def: 18.5,
  hpp: 4.96, atkp: 4.96, defp: 6.2,
  cpct: 3.3, cdmg: 6.6, recharge: 5.5, mastery: 19.75,
}
const SR_SUB_AVG = {
  hp: 38, atk: 19, def: 19,
  hpp: 3.89, atkp: 3.89, defp: 4.86, spd: 2.3,
  cpct: 2.83, cdmg: 5.67, effect: 3.46, resist: 3.46, mastery: 5.83,
}

function subRoll(p, game) {
  const key = propKey(p)
  const avg = (game === 'sr' ? SR_SUB_AVG : GS_SUB_AVG)[key]
  if (!avg) return null
  const n = Number(String(propRaw(p)).replace(/%/g, ''))
  if (!Number.isFinite(n)) return null
  const isPct = PCT_KEYS.has(key) || String(p?.isPct || '') === 'true'
  const value = isPct ? (Math.abs(n) <= 1 ? n * 100 : n) : n
  const rolls = Math.max(0, value / avg)
  return {
    text: rolls.toFixed(1),
    /* 单词条最多约 5 档（4 词条起手 + 5 次强化），进度条按 5 档封顶 */
    bar: Math.min(100, Math.round((rolls / 5) * 100)),
    valid: VALID_SUB_KEYS.has(key),
  }
}

function buildArtisOverall(artis, score, markClass) {
  if (!artis.length) return null
  let valid = 0
  const rows = artis.map(a => {
    let own = 0
    for (const s of (a.subs || [])) {
      if (VALID_SUB_KEYS.has(s.key)) own++
    }
    valid += own
    return { slot: a.slot, score: a.score || '-', valid: own, markClass: a.markClass || '' }
  })
  return {
    score: score || '-',
    grade: markKeyOf(markClass),
    mark: markTierOf(markClass, score),
    valid,
    total: artis.length * 4,
    rows,
    avg: score ? (Number(score) / artis.length).toFixed(1) : '',
  }
}

/** 套装：按件数统计，例如「影中沉凝的幻灭 ×4」 */
function setSummary(artis) {
  const stat = new Map()
  for (const a of artis) {
    if (!a.set) continue
    stat.set(a.set, (stat.get(a.set) || 0) + 1)
  }
  return [...stat.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([name, count]) => ({ name, count }))
}

/** 单角色详情 → 模板数据 */
function flattenCharDetail(profile, Character, game, meta = {}) {
  const char = profile?.char || {}
  const imgs = char?.imgs || {}
  const artis = artisList(profile)
  const equip = flattenArtis(artis, game)
  const weapon = profile?.weapon || {}
  const weaponIcon = stripSlash(weapon?.imgs?.icon || weapon?.icon || weapon?.img || '')
  const weaponMains = Array.isArray(weapon?.attrs) ? weapon.attrs : []
  const wMain = weaponMains.slice(0, 2).map(p => ({ label: propLabel(p, game), value: propText(p) })).filter(x => x.label && x.value)

  const attrs = detailAttrRows(profile, game)
  const score = profile?.artis?._mark != null ? (Math.round(profile.artis._mark * 10) / 10).toFixed(1) : ''

  /* 面板背景：优先角色专属图 `profile/normal-character/<角色名>.webp`，
     没有则退到元素背景 `common/bg/bg-<元素>.webp`；星铁统一 bg-sr。
     两张都按 <img> 加载，404 时由 onerror 隐藏，互不影响。 */
  const miaoPath = meta.miaoPath || ''
  const bgElem = game === 'sr' ? 'sr' : String(char?.elem || '').toLowerCase()
  const bgElemImage = (miaoPath && ['pyro', 'hydro', 'electro', 'cryo', 'anemo', 'geo', 'dendro', 'quantum', 'sr'].includes(bgElem))
    ? `${miaoPath}common/bg/bg-${bgElem}.webp`
    : ''
  const bgCharImage = (miaoPath && game === 'gs' && char?.name)
    ? `${miaoPath}profile/normal-character/${char.name}.webp`
    : ''

  /* 命座图标：miao 的 char.imgs 里存 cons0~cons5 的文件名（部分版本从 cons1 起），
     点亮的个数与 profile.cons 一致，未点亮由 CSS 灰度处理 */
  const consCount = Number(profile?.cons) || 0
  const consIcons = Array.from({ length: 6 }, (_, i) => ({
    file: stripSlash(imgs[`cons${i}`] || imgs[`cons${i + 1}`] || ''),
    active: i < consCount,
    index: i + 1,
  }))

  return {
    game,
    bgElemImage,
    bgCharImage,
    consIcons,
    uid: meta.uid || '',
    nickname: meta.nickname || '',
    name: char?.name || '',
    abbr: char?.abbr || char?.name || '',
    star: char?.star || 5,
    elem: char?.elem || '',
    elemName: (game === 'sr' ? (char?.damageType || '') : '') || '',
    level: Number(profile?.level) || 0,
    cons: Number(profile?.cons) || 0,
    face: stripSlash(imgs.qFace || imgs.face || ''),
    splash: stripSlash(imgs.splash || imgs.gacha || ''),
    attrs,
    radar: buildRadar(profile, game),
    weapon: weapon?.name ? {
      name: weapon.name || '',
      star: weapon.star || 5,
      stars: Array.from({ length: Math.min(5, Number(weapon.star) || 5) }, () => 0),
      level: weapon.level || 0,
      refine: weapon.affix || 0,
      icon: weaponIcon,
      props: wMain,
    } : null,
    artis: equip,
    sets: setSummary(equip),
    talents: detailTalents(profile, game, imgs),
    artisOverall: buildArtisOverall(equip, score, profile?.artis?.markClass || ''),
    score,
    scoreClass: profile?.artis?.markClass || '',
  }
}

/* ───────────── Akasha 排名与理论伤害 ─────────────
 *
 * akasha.cv 的公开榜单：分类表里每个角色有 characterId（与米游社角色 id 一致，
 * 如神里绫华 10000002、桑多涅 10000133），按它对齐即可，不需要中英名映射。
 *
 * 取三段：
 *   · fetchLeaderboard      角色当前方案的前 10 名（uid / 昵称 / 命座 / 武器 / 理论伤害）
 *   · getUserCalculations   本人该角色的名次与伤害（不受「榜单只返回前 50」限制）
 *   · calculation.additional 分技能伤害明细（参考图里的伤害表）
 * 任何一步失败都不影响面板本体，只是隐藏对应模块。
 */
const AKASHA_TTL = 6 * 3600 * 1000
let AKASHA_CATS = null
let AKASHA_CATS_AT = 0

async function akashaCategories() {
  if (AKASHA_CATS && Date.now() - AKASHA_CATS_AT < AKASHA_TTL) return AKASHA_CATS
  const all = await listCategories()
  AKASHA_CATS = Array.isArray(all) ? all : []
  AKASHA_CATS_AT = Date.now()
  return AKASHA_CATS
}

/** 大数字缩写：1.81亿 / 4435.86万 */
function bigNum(v) {
  const n = Number(v) || 0
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return String(Math.round(n))
}

/** 伤害条目英文 → 中文（akasha 只给英文） */
const DMG_TERMS = [
  [/\bNormal Attack\b/g, '普通攻击'],
  [/\bCharged Attack\b/g, '重击'],
  [/\bPlunging Attack\b/g, '下落攻击'],
  [/\bElemental Skill Cast\b/g, '元素战技释放'],
  [/\bElemental Skill\b/g, '元素战技'],
  [/\bElemental Burst\b/g, '元素爆发'],
  [/\bLunar-Charged\b/g, '月感电'],
  [/\bLunar-Bloom\b/g, '月绽放'],
  [/\bLunar-Crystallize\b/g, '月结晶'],
  [/\bAvg DMG\b/g, '期望伤害'],
  [/\bContinuous\b/g, '持续'],
  [/\bCast\b/g, '释放'],
  [/\bDMG\b/g, '伤害'],
  [/\bHealing\b/g, '治疗'],
  [/\bCombo\b/gi, '连招'],
  [/\bTeam\b/gi, '队伍'],
]
const cnDmgName = s => DMG_TERMS.reduce((text, [re, to]) => text.replace(re, to), String(s || ''))

/**
 * 伤害条目名：akasha 只给社区配的英文技能名（如 Sweeping Fire、Prism Shot），
 * 无法逐条翻译。能翻成纯中文的（元素战技释放、月感电…）保留，仍然带英文的
 * 退回「技能N」占位，避免表格里出现看不懂的单词。
 * 括号内是配装/Buff 备注（TTDS & VV up、30%），与条目本身无关，一并去掉。
 */
function cleanDmgName(raw, index) {
  const text = cnDmgName(raw)
    .replace(/\([^)]*\)/g, '')
    .replace(/期望伤害|伤害|治疗|连招|队伍/g, '')
    .replace(/[,，、:：%]/g, '')
    .replace(/\s+/g, '')
    .trim()
  return /[A-Za-z]/.test(text) || !text ? `技能${index + 1}` : text
}

/**
 * 技能类型编码 → 左侧分类标签。akasha 的 `additional[].type` 形如
 * `A` / `N1-Infused` / `CA` / `E0` / `Q` / `SSC` / `LC` / `LB` / `LCR`，
 * 直接显示编码看不懂，折算成游戏内的说法。
 */
const DMG_TAG = [
  [/^N\d/i, '普攻'],
  [/^N/i, '普攻'],
  [/^A$/i, '普攻'],
  [/^CA/i, '重击'],
  [/^E/i, '战技'],
  [/^Q/i, '爆发'],
  [/^SSC$/i, '特殊'],
  [/^LCR$/i, '月结晶'],
  [/^LC$/i, '月感电'],
  [/^LB$/i, '月绽放'],
  [/^C\d/, '命座'],
]
function dmgTypeTag(type) {
  const code = String(type || '').trim()
  const hit = DMG_TAG.find(([re]) => re.test(code))
  return hit ? hit[1] : '伤害'
}

/* ───────────── 队伍配队 ─────────────
 * akasha 的 `weapons[].teammates` 给出该方案的四名成员（含角色本体），
 * 但成员名是英文（Yae Miko / Qiqi），用 system/default/gsalias.json 的别名表
 * 反查中文名，查不到的保留英文原名。
 */
let GS_ALIAS_MAP = null

function gsAliasMap() {
  if (GS_ALIAS_MAP) return GS_ALIAS_MAP
  const map = new Map()
  try {
    const file = path.join(PLUGIN_ROOT, 'system/default/gsalias.json')
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [cn, list] of Object.entries(json)) {
      if (!cn) continue
      map.set(cn.toLowerCase(), cn)
      for (const a of list || []) {
        const key = String(a || '').trim().toLowerCase()
        if (key) map.set(key, cn)
      }
    }
  } catch (err) {
    logger.debug?.(`[HoYoGet][hoyo_panel] 读取角色别名表失败：${err?.message || err}`)
  }
  GS_ALIAS_MAP = map
  return map
}

function buildTeam(cat) {
  const mates = cat?.weapons?.[0]?.teammates
  if (!Array.isArray(mates)) return []
  const alias = gsAliasMap()
  return mates.slice(0, 4).map(t => {
    const c = t?.character || {}
    const en = String(c.name || '').trim()
    const cons = Number(c.constellation)
    return {
      name: alias.get(en.toLowerCase()) || en,
      element: String(c.element || '').toLowerCase(),
      icon: String(c.icon || ''),
      /* 0 命是默认值，不占版面；6 命显示「满命」与榜单列保持同一口径 */
      consText: Number.isFinite(cons) && cons > 0 ? (cons >= 6 ? '满命' : `${cons}命`) : '',
    }
  }).filter(t => t.name)
}

/* ───────────── 随机背景图 ─────────────
 *
 * `https://api.yppp.net/pc.php` 会 302 到 `cdn.yppp.net` 的随机图。
 * 这里用 redirect: 'manual' 只取 Location，不下载图片本身，
 * 再把 CDN 地址交给模板的 <img> 加载；接口异常时返回空串，模板自动跳过该层。
 */
const RANDOM_BG_API = 'https://api.yppp.net/pc.php'

async function randomBgUrl() {
  try {
    const res = await fetch(RANDOM_BG_API, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(5000),
    })
    const location = res.headers?.get?.('location')
    if (location) return new URL(location, RANDOM_BG_API).href
    return RANDOM_BG_API
  } catch (err) {
    logger.debug?.(`[HoYoGet][hoyo_panel] 随机背景获取失败：${err?.message || err}`)
    return ''
  }
}

async function akashaForChar(charId, uid) {
  try {
    const all = await akashaCategories()
    const cats = all.filter(c => String(c?.characterId) === String(charId))
    if (!cats.length) return null
    // 优先取有武器档位（有 calculationId）的方案，榜单才拉得到
    const cat = cats.find(c => Array.isArray(c?.weapons) && c.weapons.length) || cats[0]

    const [{ list }, calcs] = await Promise.all([
      fetchLeaderboard(cat, { size: 10 }),
      getUserCalculations(uid).catch(() => []),
    ])

    const rows = (list || []).map((e, i) => {
      /* akasha 的 owner.region 是两位国家码（CN / US / JP…），用它拼国旗 */
      const region = String(e?.owner?.region || '').toUpperCase()
      const validRegion = /^[A-Z]{2}$/.test(region)
      const cons = Number(e?.constellation) || 0
      return {
        rank: i + 1,
        uid: String(e?.uid || ''),
        nickname: e?.owner?.nickname || '',
        region: validRegion ? region : '',
        flag: validRegion ? `https://flagcdn.com/w20/${region.toLowerCase()}.png` : '',
        cons,
        /* 武器名是英文专有名词，榜单里改显示中文的命座，避免整列看不懂 */
        consText: cons >= 6 ? '满命' : (cons > 0 ? `${cons}命` : '0命'),
        weapon: e?.weapon?.name || '',
        dmg: Number(e?.calculation?.result) || 0,
        dmgText: bigNum(e?.calculation?.result),
      }
    })

    const mine = (calcs || []).find(r => String(r?.characterId) === String(charId))
    const fit = mine?.calculations?.fit || null
    /* 分技能明细：`value` 是单次命中期望伤害，`quantity` 是一轮循环的次数，
       表格右侧展示 value×quantity 的整轮期望，次数单独占一列。 */
    const detail = (fit?.calculation?.additional || []).slice(0, 6).map((d, i) => {
      const qty = Number(d?.quantity) || 1
      const name = cleanDmgName(d?.name, i)
      /* 普攻段数（type 形如 N3-Infused）比「技能3」更能说明是哪一招 */
      const seg = /^N(\d)/i.exec(String(d?.type || ''))
      return {
        tag: dmgTypeTag(d?.type),
        name: seg && /^技能\d+$/.test(name) ? `第 ${seg[1]} 段` : name,
        qtyText: `×${qty}`,
        valueText: bigNum((Number(d?.value) || 0) * qty),
      }
    })

    /* 方案名（如 Stellar-Conduct Basic Team）翻译不全，含英文时干脆不显示 */
    const planName = cnDmgName(cat?.name || '')
    return {
      planName: /[A-Za-z]{3,}/.test(planName) ? '' : planName,
      total: Number(cat?.count) || 0,
      team: buildTeam(cat),
      rows,
      detail,
      mine: fit ? {
        rank: Number(fit.ranking) || 0,
        outOf: Number(fit.outOf) || 0,
        dmgText: bigNum(fit.result),
        beat: fit.outOf ? ((1 - Number(fit.ranking) / Number(fit.outOf)) * 100).toFixed(1) : '',
      } : null,
    }
  } catch (err) {
    logger.debug?.(`[HoYoGet][hoyo_panel] akasha 数据获取失败：${err?.message || err}`)
    return null
  }
}

export class hoyo_panel extends plugin {
  constructor() {
    super({
      name: '[米哈游]原神/星铁面板',
      dsc: '原神与星铁的角色面板总览（自研版式，数据复用 miao-plugin）',
      event: 'message',
      priority: pluginPriority('hoyo_panel', -42000),
      rule: [
        { reg: PANEL_REFRESH_REG.source, fnc: 'refreshPanel' },
        { reg: PANEL_REG.source, fnc: 'panel' },
        { reg: PANEL_CHAR_REG.source, fnc: 'panel' },
        { reg: PANEL_LIST_REG.source, fnc: 'panel' },
      ],
    })
  }

  /**
   * accept 早于所有 rule 执行。
   *
   * 必须在这里截胡，不能只靠 rule：本插件的 meme 模块在 init() 里把
   * 1392 个表情包关键词各扩成一条正则（其中就有 `^#米哈游`），
   * 而 `#米哈游原神面板` 正好以它开头，会被表情包抢走 ——
   * 日志里能看到 `[#米哈游原神面板 113440] → [米哈游]Meme表情包(memes)`。
   */
  async accept(e) {
    const msg = String(e?.msg || '')
    if (!PANEL_REG.test(msg) && !PANEL_CHAR_REG.test(msg) && !PANEL_REFRESH_REG.test(msg) && !PANEL_LIST_REG.test(msg)) return
    this.e = e
    if (PANEL_REFRESH_REG.test(msg)) await this.refreshPanel(e)
    else await this.panel(e)
    // 'return' 表示已处理完毕，不再继续匹配后面的插件
    return 'return'
  }

  /** 「#米哈游原神更新面板」：拉取最新面板后直接出总览图 */
  async refreshPanel(e) {
    const m = String(e.msg || '').match(PANEL_REFRESH_REG)
    if (!m) return false
    const key = String(m[1] || '').toLowerCase()
    const game = ['星铁', '崩铁', 'sr'].includes(key) ? 'sr' : 'gs'
    const conf = GAME_CONF[game]
    e.isSr = game === 'sr'

    const miao = await loadMiao()
    if (!miao) {
      return e.reply('需要先安装 miao-plugin 才能更新面板（本功能复用它抓取的面板）。')
    }

    let uid = m[2] || ''
    if (!uid) uid = await readMysMainUid(e, game)
    if (!uid) uid = await readBoundUid(e, game)
    if (!uid) {
      return e.reply([
        `没能确定要更新的${conf.cn} UID。`,
        `可以这样用：#米哈游${conf.cn}更新面板 123456789`,
        `或先绑定：${conf.prefix}123456789`,
      ].join('\n'))
    }

    try {
      /* 静默更新：miao 内部会自己发「开始获取uid…」和失败提示，
         这里再发一条「正在更新…」就会变成连发多条。
         用一个空 reply 占位，miao 看到 e._isReplyed 就不会重复提示。 */
      e._isReplyed = true

      /* 关键：**不能**强制走米游社。
         Serv.getServ(uid, game, fromMys) 里 fromMys=true 会直接返回 mysPanel，
         米游社一旦风控就彻底失败、没有降级；fromMys=false 才会按配置选
         enka / mgg / 等第三方面板服务 —— 喵喵自己的 #更新面板 能出图，
         正是因为它走的是后者（日志里「账号异常」之后仍然出了图）。
         所以这里保持 isfromMys=false，让 miao 自己挑服务。 */
      const player = new miao.Player(uid, game)
      player.e = e
      e.uid = uid
      e.game = game
      e.isfromMys = false
      /* miao 的 ProfileReq 会在 2 秒后无条件 e.reply 一条「开始获取uid…」，
         不检查 _isReplyed。这里临时把 e.reply 静音，只收集真正需要的消息，
         更新结束后一次性汇报，避免一条指令刷出四五条消息。 */
      const mys = await miao.MysApi.init(e, 'cookie')
      if (!mys) {
        return e.reply([
          `更新 ${uid} 的面板需要米游社 Cookie。`,
          '请先发送 #米哈游扫码绑定 绑定账号，或 #刷新ck 刷新失效的 Cookie。',
        ].join('\n'))
      }
      // 只有刷新这一段静音，避免 miao 的「开始获取uid…」等中间提示
      const realReply = e.reply.bind(e)
      let refreshed
      try {
        e.reply = async () => true
        refreshed = await player.refreshProfile(2, false)
      } finally {
        e.reply = realReply
      }
      if (refreshed === false || refreshed === undefined) {
        logger.warn?.(`[HoYoGet][hoyo_panel] ${uid} 面板未刷新（返回 ${refreshed}）`)
        return
      }
      // refreshProfile 会把数据写盘，重新读一次拿最新的
      const fresh = new miao.Player(uid, game)
      if (!fresh.hasProfile) {
        logger.warn?.(`[HoYoGet][hoyo_panel] ${uid} 刷新后仍无面板数据`)
        return
      }
      logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 刷新完成，开始渲染（avatars=${Object.keys(fresh._avatars || {}).length}）`)
      return this.renderPanel(e, game, uid, miao, true, fresh)
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 更新面板失败: ${err?.message || err}`)
      return e.reply(`更新面板失败：${err?.message || err}`)
    }
  }

  async panel(e) {
    const msg = String(e.msg || '')
    const m = msg.match(PANEL_REG) || msg.match(PANEL_LIST_REG)
    // 带角色名时 PANEL_REG 不成立（它只认 9 位 UID），所以单独再匹配一次
    const cm = m ? null : msg.match(PANEL_CHAR_REG)
    if (!m && !cm) return false
    const key = String((m || cm)[1] || '').toLowerCase()
    const game = ['星铁', '崩铁', 'sr'].includes(key) ? 'sr' : 'gs'
    const conf = GAME_CONF[game]
    const charName = cm ? String(cm[2] || '').trim() : ''
    e.isSr = game === 'sr'

    const miao = await loadMiao()
    if (!miao) {
      return e.reply('需要先安装 miao-plugin 才能读取面板数据（本功能复用它抓取的面板）。')
    }

    // UID：指令里带的优先，其次绑定
    let uid = m ? (m[2] || '') : ''
    if (!uid) uid = await readMysMainUid(e, game)
    if (!uid) uid = await readBoundUid(e, game)
    if (!uid) {
      return e.reply([
        `没能确定要查询的${conf.cn} UID。`,
        '可以这样用：',
        `  #米哈游${conf.cn}面板 123456789   （直接带 UID）`,
        `  #米哈游${conf.cn}面板 角色名      （单角色详情图）`,
        `  或先绑定：${conf.prefix}123456789`,
      ].join('\n'))
    }

    try {
      const player = new miao.Player(uid, game)
      if (!player.hasProfile) {
        // 本地没有面板缓存，尝试刷新一次（保持 isfromMys=false 走第三方服务，
        // 理由见 refreshPanel 里的注释）
        player.e = e
        e.uid = uid
        e.game = game
        e.isfromMys = false
        const mys = await miao.MysApi.init(e, 'cookie')
        if (mys) await player.refreshProfile(2, false)
      }
      if (!player.hasProfile) {
        logger.warn?.(`[HoYoGet][hoyo_panel] ${uid} 本地无面板：avatars=${Object.keys(player._avatars || {}).length}，文件=${player._file}`)
        return e.reply([
          `本地暂无 ${uid} 的${conf.cn}面板数据。`,
          '请先在游戏内把角色放进「角色展柜」并开启显示详情，然后：',
          `  #米哈游${conf.cn}更新面板`,
        ].join('\n'))
      }
      if (charName) return this.renderCharPanel(e, game, uid, miao, charName, player)
      return this.renderPanel(e, game, uid, miao, false, player)
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 面板渲染失败: ${err?.message || err}`)
      return e.reply(`面板获取失败：${err?.message || err}`)
    }
  }

  /**
   * 单角色面板详情图（`#米哈游原神面板 桑多涅`）。
   *
   * 角色按 名字 → 简称 → 双向包含 依次匹配；命中后把 miao 的 Avatar 实例
   * 压成扁平结构交给模板，模板与总览图共用同一套 miao 资源路径。
   */
  async renderCharPanel(e, game, uid, miao, charName, prePlayer = null) {
    const conf = GAME_CONF[game]
    try {
      const player = prePlayer || new miao.Player(uid, game)
      const ids = Object.keys(player._avatars || {})
      let hit = null
      let hitId = ''
      for (const id of ids) {
        try {
          const av = player.getAvatar(id)
          const name = String(av?.char?.name || '')
          const abbr = String(av?.char?.abbr || '')
          if (!name) continue
          const exact = name === charName || abbr === charName
          const fuzzy = name.includes(charName) || (abbr && (abbr.includes(charName) || charName.includes(abbr)))
          if (!exact && !fuzzy) continue
          // 同角色可能有多份残缺记录，优先带面板的
          if (!hit || (!hit.isProfile && av.isProfile)) { hit = av; hitId = id }
          if (exact && av.isProfile) break
        } catch (_) {
          /* 单条坏数据跳过 */
        }
      }

      if (!hit) {
        return e.reply(`UID ${uid} 的角色柜里没有找到「${charName}」。\n可以发送「#米哈游${conf.cn}面板」查看已展示的角色。`)
      }

      const info = player.getInfo?.() || {}
      const miaoResPath = '../../../../..' + '/plugins/miao-plugin/resources/'
      const data = flattenCharDetail(hit, miao.Character, game, {
        uid,
        nickname: info.nickname || info.name || '',
        miaoPath: miaoResPath,
      })

      /* 关键数据全空时不要出空白图：通常是 miao 版本差异导致字段名不同 */
      if (!data.attrs.length && !data.artis.length) {
        logger.mark?.(`[HoYoGet][hoyo_panel] ${charName} 面板字段为空：avatar 键=${Object.keys(hit || {}).join(',')}`)
        return e.reply(`读到了「${data.name || charName}」，但面板字段为空（可能是 miao-plugin 版本差异）。\n可先发「#米哈游${conf.cn}更新面板」后再试。`)
      }

      /* Akasha 只有原神有榜；随机背景与它并行请求，两者失败都不影响面板 */
      const [akasha, randomBg] = await Promise.all([
        game === 'gs' && hit?.char?.id ? akashaForChar(hit.char.id, uid) : Promise.resolve(null),
        randomBgUrl(),
      ])

      return await render('hoyo_panel/detail', {
        ...data,
        gameCn: conf.cn,
        _miao_path: miaoResPath,
        avatarId: hitId,
        akasha,
        randomBg,
      }, { e, ret: true })
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 角色面板渲染失败: ${err?.message || err}`)
      return e.reply(`角色面板生成失败：${err?.message || err}`)
    }
  }

  /** 把 player 的面板渲染成总览图（panel 与 refreshPanel 共用） */
  async renderPanel(e, game, uid, miao, isRefresh, prePlayer = null) {
    const conf = GAME_CONF[game]
    try {
      const player = prePlayer || new miao.Player(uid, game)
      /* 逐角色取，单个坏数据不能拖垮整张面板：
         miao 的 Player.getProfiles() 内部会对每个 avatar 调 setAvatar，
         某些残缺记录（如 artis 结构缺字段）会抛错并中断整个遍历。 */
      const chars = []
      let skipped = 0
      const ids = Object.keys(player._avatars || {})
      for (const id of ids) {
        try {
          const av = player.getAvatar(id)
          if (!av?.isProfile) continue
          const item = flattenProfile(av, miao.Character)
          if (item.name) chars.push(item)
        } catch (err) {
          skipped++
          logger.debug?.(`[HoYoGet][hoyo_panel] 跳过角色 ${id}：${err?.message || err}`)
        }
      }
      if (skipped) logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 有 ${skipped} 个角色数据异常，已跳过`)

      if (!chars.length) return e.reply(`没有读到 ${uid} 的角色面板数据。`)

      // 排序：五星优先 → 等级 → 评分
      chars.sort((a, b) => (b.star - a.star) || (b.level - a.level) || ((b.artisScore || 0) - (a.artisScore || 0)))

      const avgScore = (() => {
        const valid = chars.map(c => c.artisScore).filter(v => typeof v === 'number')
        return valid.length ? (valid.reduce((s, v) => s + v, 0) / valid.length).toFixed(1) : ''
      })()
      const maxScore = Math.max(...chars.map(c => c.artisScore || 0), 0)

      const info = player.getInfo?.() || {}
      /* _miao_path 由框架只给 miao-plugin 自身提供，本插件拿不到；
         这里按渲染器的实际落盘深度自己算：模板存于
         temp/html/米哈游/hoyo_panel/list/，回退到项目根要 5 层。 */
      const miaoResPath = '../../../../..' + '/plugins/miao-plugin/resources/'
      const img = await render('hoyo_panel/list', {
        game,
        gameCn: conf.cn,
        uid,
        _miao_path: miaoResPath,
        nickname: info.nickname || info.name || '',
        level: info.level || '',
        chars,
        total: chars.length,
        avgScore,
        maxScore: maxScore ? maxScore.toFixed(1) : '',
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 面板渲染失败: ${err?.message || err}`)
      return e.reply(`面板获取失败：${err?.message || err}`)
    }
  }
}
