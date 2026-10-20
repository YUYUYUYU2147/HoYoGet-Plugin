import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, pluginPriority, render } from '#HoYoGet'
import { listCategories, fetchLeaderboard, getUserCalculations, getDamageDistribution } from '../system/akasha.js'
import { getRoleProfile } from '../system/roleProfile.js'
import { srPanelExtras } from '../system/sr_panel.js'

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

/*
 * 面板指令。游戏名可省略：
 *   #米哈游原神面板 / #米哈游星铁面板        —— 总览
 *   #米哈游雷神面板                        —— 游戏名省略时按原神处理
 *   #米哈游原神面板 雷电将军 / #米哈游雷神面板 雷电将军  —— 单角色详情
 * 但「米哈游」必须有：不加的话会和 miao 的 #雷神面板 抢，也会误吃各种「xx面板」。
 */
const GAME_WORD = '(?:(原神|星铁|崩铁|gs|sr)\\s*)?'
const PANEL_REG = new RegExp(`^#?米哈游\\s*${GAME_WORD}面板(?:\\s+(\\d{9}))?$`, 'i')
const PANEL_LIST_REG = new RegExp(`^#?米哈游\\s*${GAME_WORD}面板列表$`, 'i')
/* 带角色名 = 单角色详情图：#米哈游原神面板 桑多涅 / #米哈游雷神面板 */
const PANEL_CHAR_REG = new RegExp(`^#?米哈游\\s*${GAME_WORD}面板\\s+(\\S+)$`, 'i')
/* 「#米哈游雷神面板」这种：面板前面直接跟角色名，没有游戏名 */
const PANEL_SHORT_CHAR_REG = /^#?米哈游\s*([^\s]+?)\s*面板$/i
/* 更新面板：#米哈游原神更新面板 / #米哈游星铁更新面板 [UID] */
const PANEL_REFRESH_REG = new RegExp(`^#?米哈游\\s*${GAME_WORD}(?:更新|刷新)(?:全部)?面板(?:\\s+(\\d{9}))?$`, 'i')

/*
 * 不带「米哈游」的写法（#原神面板 / #星铁面板 / #原神面板 桑多涅 …）。
 * 这几条在 miao-plugin 里也是面板指令，本插件优先级更高（-42000），
 * 所以会盖掉 miao 的同名指令；accept() 里统一补回「米哈游」前缀再走原逻辑。
 * 注意只认带了游戏名的：裸 #雷神面板 / #面板 仍留给 miao。
 */
const NO_PREFIX_GAME = '(原神|星铁|崩铁|gs|sr)'
const NO_PREFIX_PANEL_REG = new RegExp(`^#?\\s*${NO_PREFIX_GAME}\\s*面板(?:\\s+(\\d{9}))?$`, 'i')
const NO_PREFIX_LIST_REG = new RegExp(`^#?\\s*${NO_PREFIX_GAME}\\s*面板列表$`, 'i')
const NO_PREFIX_CHAR_REG = new RegExp(`^#?\\s*${NO_PREFIX_GAME}\\s*面板\\s+(\\S+)$`, 'i')
const NO_PREFIX_REFRESH_REG = new RegExp(`^#?\\s*${NO_PREFIX_GAME}\\s*(?:更新|刷新)(?:全部)?面板(?:\\s+(\\d{9}))?$`, 'i')

/** 把「#原神面板」补成「#米哈游原神面板」；不匹配返回空串 */
function withMhyPrefix(msg) {
  const m = msg.match(NO_PREFIX_REFRESH_REG) || msg.match(NO_PREFIX_LIST_REG)
    || msg.match(NO_PREFIX_PANEL_REG) || msg.match(NO_PREFIX_CHAR_REG)
  if (!m) return ''
  return msg.replace(/^(#?\s*)/, '$1米哈游')
}

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
    let ProfileRank = null
    try {
      // 群排名的核心逻辑在 models/ProfileRank.js（zset 按群 + 角色排名）
      ProfileRank = (await import('../../miao-plugin/models/ProfileRank.js')).default
    } catch (_) { /* 老版本 miao 没有这个模块，排名角标直接跳过 */ }
    return {
      Player: mod.Player,
      Character: mod.Character,
      MysApi: mod.MysApi,
      ProfileRank,
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

  /* 圣遗物 / 遗器的总评分与段位。
     ⚠ profile.artis 上只有原始单件，markClass / _mark 要等 ArtisMark 算过才有值
     （面板总览这条路径不会自动算），所以主动调 getArtisMark(true)。
     _mark 已经是 0-100 的分数，不要再乘 10。 */
  let artisMark = artis?.markClass || ''
  let artisScore = artis?._mark != null ? Math.round(Number(artis._mark) * 10) / 10 : ''
  if (!artisMark || !artisScore) {
    try {
      const detail = profile?.getArtisMark?.(true)
      if (detail?.markClass) artisMark = detail.markClass
      if (detail?._mark != null) artisScore = Math.round(Number(detail._mark) * 10) / 10
    } catch (_) { /* 算不出就留空，不影响其它字段 */ }
  }

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
  heal: '治疗加成', shield: '护盾强效', dmg: '伤害加成', atkBase: '基础攻击力',
  hpp: '生命值', atkp: '攻击力', defp: '防御力',
  /* miao 的圣遗物词条键：atk/hp/def 是大词条（百分比），*Plus 是小词条（固定值） */
  hpPlus: '生命值', atkPlus: '攻击力', defPlus: '防御力', phy: '物理伤害加成',
  pyro: '火元素伤害', hydro: '水元素伤害', cryo: '冰元素伤害', electro: '雷元素伤害',
  anemo: '风元素伤害', geo: '岩元素伤害', dendro: '草元素伤害', phys: '物理伤害',
}
/* 星铁的键与 miao 的 AttrData 一致：speed / stance / effPct / effDef；
   旧写法 spd / mastery / effect / resist 保留为别名，兼容历史缓存数据。 */
const SR_STAT_CN = {
  hp: '生命值', atk: '攻击力', def: '防御力',
  speed: '速度', spd: '速度',
  stance: '击破特攻', mastery: '击破特攻',
  cpct: '暴击率', cdmg: '暴击伤害', recharge: '能量恢复效率',
  effPct: '效果命中', effect: '效果命中',
  effDef: '效果抵抗', resist: '效果抵抗',
  heal: '治疗加成', shield: '护盾强效', dmg: '伤害加成', atkBase: '基础攻击力',
  hpPlus: '生命值', atkPlus: '攻击力', defPlus: '防御力',
}
/** 需要带 % 的键；其余按整数处理 */
const PCT_KEYS = new Set([
  'cpct', 'cdmg', 'recharge', 'heal', 'shield', 'dmg', 'hpp', 'atkp', 'defp',
  'pyro', 'hydro', 'cryo', 'electro', 'anemo', 'geo', 'dendro', 'phys',
  'effect', 'resist', 'stance', 'effPct', 'effDef', 'elation',
])
/* 星铁元素（miao 用小写英文）→ 中文，用于「量子属性伤害加成」这类标签 */
const SR_ELEM_CN = {
  physical: '物理', fire: '火', ice: '冰', lightning: '雷',
  wind: '风', quantum: '量子', imaginary: '虚数',
}
/* 星铁增伤词条的图标：miao 只有原神七元素 + 量子，火/冰/雷/风借用对应元素图，
   虚数没有素材就不显示图标（模板里 aicon-wrap 会占位，不会错位） */
const SR_ELEM_ICON = {
  physical: { icon: 'Physical.png', iconMiao: false },
  fire: { icon: 'common/bg/talent-pyro.webp', iconMiao: true },
  ice: { icon: 'common/bg/talent-cryo.webp', iconMiao: true },
  lightning: { icon: 'common/bg/talent-electro.webp', iconMiao: true },
  wind: { icon: 'common/bg/talent-anemo.webp', iconMiao: true },
  quantum: { icon: 'common/bg/talent-quantum.webp', iconMiao: true },
  imaginary: { icon: '', iconMiao: false },
}
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
  atkBase: 'IconAttack.png',
  hpPlus: 'IconHpMax.png',
  atkPlus: 'IconAttack.png',
  def: 'IconDef.png',
  defPlus: 'IconDef.png',
  defp: 'IconDef.png',
  mastery: 'IconElementMystery.png',
  cpct: 'IconCrit.png',
  cdmg: 'IconCritDam.png',
  recharge: 'IconSpRecover.png',
  phys: 'Physical.png',
  phy: 'Physical.png',
}
/* 元素伤害杯：miao 的主词条 key 统一是 dmg，靠 name（「雷元素伤害加成」）还原元素图标 */
const ELEM_NAME_ICON = {
  火: 'pyro', 水: 'hydro', 冰: 'cryo', 雷: 'electro',
  风: 'anemo', 岩: 'geo', 草: 'dendro', 物理: 'phys',
}

/**
 * 元素伤害图标改用 miao 自带的 `resources/common/bg/talent-<元素>.webp`，
 * 七个元素齐全（含借图标里没有的水/岩/草），与面板立绘同一套素材；
 * 找不到 miao 资源时 `iconMiao` 项会因 onerror 隐藏，不影响排版。
 */
const ELEM_ICON = {
  pyro: 'common/bg/talent-pyro.webp',
  hydro: 'common/bg/talent-hydro.webp',
  cryo: 'common/bg/talent-cryo.webp',
  electro: 'common/bg/talent-electro.webp',
  anemo: 'common/bg/talent-anemo.webp',
  geo: 'common/bg/talent-geo.webp',
  dendro: 'common/bg/talent-dendro.webp',
}

function propIcon(p) {
  const key = propKey(p)
  if (PROP_ICON[key]) return { icon: PROP_ICON[key], iconMiao: false }
  if (key === 'dmg') {
    const elem = Object.keys(ELEM_NAME_ICON).find(k => String(p?.name || '').includes(k))
    if (elem === '物理') return { icon: 'Physical.png', iconMiao: false }
    if (elem && ELEM_ICON[ELEM_NAME_ICON[elem]]) return { icon: ELEM_ICON[ELEM_NAME_ICON[elem]], iconMiao: true }
  }
  if (ELEM_ICON[key]) return { icon: ELEM_ICON[key], iconMiao: true }
  return { icon: '', iconMiao: false }
}

/**
 * 圣遗物 / 遗器：取「带评级」的详情。
 *
 * miao 的 Avatar.artis 是个 Artis 实例，真正的单件放在 `artis.artis` 里、
 * 而且是 **对象**（部位 1..5 → 单件），单件上**没有** mark / markClass。
 * 评级与单件分数只有 `avatar.getArtisMark(true)` 才会算出来（内部走 ArtisMark），
 * 所以这里优先用它；拿不到时再退回原始对象，至少能显示名字/主副词条。
 */
function artisList(profile) {
  try {
    const detail = profile?.getArtisMark?.(true)
    const items = detail?.artis
    if (items && typeof items === 'object') {
      const arr = Object.keys(items)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => items[k])
        .filter(Boolean)
      if (arr.length) {
        /* 把总评挂在数组上，flattenCharDetail 取总分时直接读这里。
           charWeight 是 miao 按角色/武器/套装算出的副词条权重（0-100），
           classTitle 形如「绫华-通用」，评分与词条统计都要乘这张表。 */
        arr.markClass = detail.markClass || ''
        arr.totalMark = Number(detail._mark) || 0
        arr.charWeight = detail.charWeight || {}
        arr.classTitle = detail.classTitle || ''
        return arr
      }
    }
  } catch (_) { /* 计算失败时走下面的兜底 */ }

  const a = profile?.artis
  if (Array.isArray(a)) return a
  if (Array.isArray(a?.artis)) return a.artis
  if (a?.artis && typeof a.artis === 'object') {
    return Object.keys(a.artis)
      .sort((x, y) => Number(x) - Number(y))
      .map(k => a.artis[k])
      .filter(item => item && (item.name || item.id))
  }
  if (Array.isArray(a?.list)) return a.list
  return []
}

function flattenArtis(list, game, weights = {}) {
  const slots = game === 'sr' ? SR_SLOTS : GS_SLOTS
  /* 有 miao 的权重表就以它为准（权重 0 的词条视为无效），没有才退回键名白名单 */
  const hasWeights = Object.keys(weights).length > 0
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
      /* markClass 原样保留给卡片描边用；markKey/tier 供徽章配色与显示。
         miao 的 _mark 是 0-100 的分数（getArtisMark 已对齐），不要再乘 10。 */
      markClass: item?.markClass || '',
      markKey: markKeyOf(item?.markClass),
      mark: markTierOf(item?.markClass, item?._mark),
      score: item?._mark != null ? (Math.round(item._mark * 10) / 10).toFixed(1) : '',
      main: mains.slice(0, 1).map(p => ({ key: propKey(p), label: propLabel(p, game), value: propText(p), ...propIcon(p) })).filter(x => x.label && x.value),
      subs: subs.slice(0, 4).map(p => {
        const key = propKey(p)
        const roll = subRoll(p, game)
        /* 评分直接抄 miao：单条副词条的 `_mark` 就是它按角色权重算出的加权分。
           命中次数用 `upNum`：miao 解析面板时按「每次强化一条 attrId」展开，
           upNum 含初始那一次（词条出现时自带一档），所以强化命中次数 = upNum - 1，
           单个词条最多 5 次。`eff` 是「数值 ÷ 单档最大值 ÷ 0.85」的等效词条数，
           只在 upNum 缺失时兜底。 */
        const weight = Number(weights?.[weightKeyOf(key)]) || 0
        const markNum = Number(p?._mark)
        const upNum = Number(p?.upNum) || 0
        const hit = upNum > 0 ? Math.max(0, upNum - 1) : 0
        const miaoEff = Number(String(p?.eff ?? '').replace(/,/g, ''))
        const rolls = upNum > 0 ? hit : (Number.isFinite(miaoEff) && miaoEff > 0 ? miaoEff : (roll?.num || 0))
        return {
          key,
          label: propLabel(p, game),
          value: propText(p),
          ...propIcon(p),
          /* 命中次数（词条数）与进度条宽度；词条不在有效集合里时只淡化显示 */
          roll: upNum > 0 ? String(hit) : (rolls ? rolls.toFixed(1) : ''),
          bar: Math.min(100, Math.round((rolls / 5) * 100)),
          valid: hasWeights ? weight > 0 : roll?.valid === true,
          weight,
          useful: weight > 0,
          eff: Number.isFinite(markNum) ? markNum / 100 : 0,
        }
      }).filter(x => x.label && x.value),
    }
  })
}

/**
 * 属性行：原神 8 项、星铁 12 项，缺值自动跳过。
 *
 * 星铁的属性键与 miao 的 AttrData 一致：speed / stance / effPct / effDef；
 * 之前写成了 spd / mastery / effect / resist，导致速度、击破、命中、抵抗全部取不到。
 * 双爆/命中/抵抗这类「天生就有基础值」的项一直显示；击破/治疗/增伤在 0 时隐藏，
 * 避免整列都是 0.0%。
 */
function detailAttrRows(profile, game, weights = {}) {
  const a = profile?.attr || {}
  const b = profile?.base || {}
  const isSr = game === 'sr'
  /* 伤害加成：物理杯时 miao 把 phy 当主增伤，取大的那个 */
  const dmgKey = !isSr && Number(a.phy) > Number(a.dmg) ? 'phy' : 'dmg'
  const spec = isSr
    ? [['hp', '生命值', true], ['atk', '攻击力', true], ['def', '防御力', true],
      ['speed', '速度', true], ['cpct', '暴击率', true], ['cdmg', '暴击伤害', true],
      ['dmg', '伤害加成', false], ['stance', '击破特攻', false],
      /* 命中/抵抗/治疗即使为 0 也列出来：游戏内属性页就是这么显示的，
         也让「这个词条面板有」一目了然 */
      ['effPct', '效果命中', true], ['effDef', '效果抵抗', true],
      ['heal', '治疗加成', true], ['recharge', '能量恢复效率', true]]
    : [['hp', '生命值上限', true], ['atk', '攻击力', true], ['def', '防御力', true],
      ['mastery', '元素精通', true], ['cpct', '暴击率', true], ['cdmg', '暴击伤害', true],
      ['recharge', '元素充能效率', true], ['dmg', '伤害加成', true]]
  const pctKeys = new Set([
    'cpct', 'cdmg', 'recharge', 'heal', 'dmg', 'phy', 'stance', 'effPct', 'effDef', 'elation',
  ])
  /* 生命值不保留小数，其余数值与 miao 一致保留 1 位 */
  const fmt = (n, pct, int) => {
    const v = Number(n)
    if (!Number.isFinite(v)) return ''
    if (pct) return `${v.toFixed(1)}%`
    return v.toLocaleString('en-US', { minimumFractionDigits: int ? 0 : 1, maximumFractionDigits: int ? 0 : 1 })
  }
  const elem = String(profile?.char?.elem || '')
  const elemCn = isSr
    ? SR_ELEM_CN[elem] || ''
    : Object.keys(ELEM_NAME_ICON).find(k => ELEM_NAME_ICON[k] === elem)
  return spec.map(([k, label, always]) => {
    const key = k === 'dmg' ? dmgKey : k
    const v = a[key]
    if (v == null || v === '') return null
    let n = Number(v)
    if (!Number.isFinite(n)) return null
    /* 星铁 attr.recharge 只是「额外充能」（如 24.4），面板上的终值要加 100 */
    if (isSr && key === 'recharge') n += 100
    if (!always && Math.abs(n) < 0.05) return null
    /* miao 的 attr 百分比字段已经是「百分数」（暴击率 59.44 表示 59.44%），
       直接拼 % 即可；旧代码再乘 100 会变成 5944%。 */
    const pct = pctKeys.has(key)
    const int = key === 'hp'
    const baseN = Number(b[key])
    /* 充能是「100 + 额外」，基础值没有意义；其余项基础为 0 时不显示副行 */
    const hasBase = key !== 'recharge' && Number.isFinite(baseN) && baseN > 0
    const plusN = n - (hasBase ? baseN : 0)
    /* 权重来自 miao 的 charWeight（0-100）：双爆 100、攻击 75 这种；
       0 或缺失就不显示徽章，避免满屏 0 */
    const weight = Number(weights[key] ?? weights[k]) || 0
    const dmgName = key === 'phy'
      ? '物理伤害加成'
      : (elemCn ? `${elemCn}${isSr ? '属性' : '元素'}伤害加成` : '')
    return {
      key: k,
      label: key === 'dmg' && dmgName ? dmgName : label,
      value: fmt(n, pct, int),
      base: hasBase ? fmt(baseN, pct, int) : '',
      plus: hasBase ? `${plusN >= 0 ? '+' : ''}${fmt(plusN, pct, int)}` : '',
      weight,
      ...(isSr && key === 'dmg' && SR_ELEM_ICON[elem]
        ? SR_ELEM_ICON[elem]
        : propIcon({ key, name: key === 'dmg' || key === 'phy' ? dmgName : '' })),
    }
  }).filter(Boolean)
}

/**
 * 六轴雷达图：按常见毕业线归一化，超出即贴边。
 * 只做「相对强弱」示意，不代表官方评分。
 */
function buildRadar(profile, game) {
  const a = profile?.attr || {}
  /* miao 的 attr 里 cpct/cdmg/recharge 已经是百分数（41.5 表示 41.5%），
     不能再 ×100，否则双爆永远贴边。星铁的速度键是 speed（不是 spd）。 */
  const axes = game === 'sr'
    ? [['生命值', a.hp, 8000], ['攻击力', a.atk, 3000], ['防御力', a.def, 1200],
      ['暴击率', a.cpct, 100], ['暴击伤害', a.cdmg, 250], ['速度', a.speed, 160]]
    : [['生命值', a.hp, 35000], ['攻击力', a.atk, 2600], ['防御力', a.def, 1800],
      ['暴击率', a.cpct, 100], ['暴击伤害', a.cdmg, 250], ['元素充能', a.recharge, 200]]
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
 * 圣遗物总评：总分取 miao 的 `artis._mark`。
 * 词条统计按「词条数 × 角色权重」折算，权重来自 `getArtisMark(true).charWeight`
 * （miao 按角色/武器/套装算出的 0-100 表，暴击率/暴伤 100、攻击% 75 …），
 * 所以有效词条分与喵喵面板同口径；这里仍不搬 miao 的评分代码。
 */
const VALID_SUB_KEYS = new Set([
  'cpct', 'cdmg', 'atk', 'hp', 'def', 'atkp', 'hpp', 'defp', 'recharge', 'mastery',
  /* 星铁特有的副词条（miao 的键名） */
  'speed', 'stance', 'effPct', 'effDef',
])

/**
 * 副词条「命中次数」：词条数值 ÷ 单词条平均档位。
 * 平均档位取 5★ 圣遗物 / 遗器各词条档位的均值（暴击率 3.3%、暴击伤害 6.6% …），
 * 与社区常用的「词条数」口径一致；角色权重在 flattenArtis 里再乘上。
 */
const GS_SUB_AVG = {
  hp: 239.4, atk: 15.56, def: 18.5,
  hpp: 4.96, atkp: 4.96, defp: 6.2,
  cpct: 3.3, cdmg: 6.6, recharge: 5.5, mastery: 19.75,
  hpPlus: 239.4, atkPlus: 15.56, defPlus: 18.5, phy: 6.2,
}
const SR_SUB_AVG = {
  hp: 38, atk: 19, def: 19,
  hpp: 3.89, atkp: 3.89, defp: 4.86,
  /* miao 的键名；后面几个旧别名只为兼容 */
  speed: 2.3, spd: 2.3,
  cpct: 2.83, cdmg: 5.67,
  stance: 5.83, mastery: 5.83,
  effPct: 3.46, effect: 3.46,
  effDef: 3.46, resist: 3.46,
  hpPlus: 38, atkPlus: 19, defPlus: 19,
}

/* miao 的权重表用 dmg/phy 归并元素伤害加成，这里把具体元素键映射过去 */
const WEIGHT_KEY_ALIAS = {
  pyro: 'dmg', hydro: 'dmg', cryo: 'dmg', electro: 'dmg', anemo: 'dmg',
  geo: 'dmg', dendro: 'dmg', quantum: 'dmg', phys: 'phy',
}
const weightKeyOf = k => WEIGHT_KEY_ALIAS[k] || k

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
    num: rolls,
    /* 单词条最多约 5 档（4 词条起手 + 5 次强化），进度条按 5 档封顶 */
    bar: Math.min(100, Math.round((rolls / 5) * 100)),
    valid: VALID_SUB_KEYS.has(key),
  }
}

function buildArtisOverall(artis, score, markClass, opts = {}) {
  if (!artis.length) return null
  let valid = 0
  const stat = new Map()
  const rows = artis.map(a => {
    let own = 0
    for (const s of (a.subs || [])) {
      /* 有效 = 该词条对本角色权重 > 0；词条分再按权重折算，不再只数条数 */
      if (!s.useful) continue
      own++
      valid++
      const cur = stat.get(s.key) || {
        key: s.key, label: s.label, rolls: 0, eff: 0, num: 0,
        pct: PCT_KEYS.has(s.key), ...propIcon({ key: s.key }),
      }
      cur.rolls += Number(s.roll) || 0
      cur.eff += s.eff || 0
      cur.num += Number(String(s.value).replace(/%/g, '')) || 0
      stat.set(s.key, cur)
    }
    return {
      slot: a.slot,
      score: a.score || '-',
      valid: own,
      markClass: a.markClass || '',
    }
  })
  const stats = [...stat.values()]
    .sort((x, y) => y.eff - x.eff)
    .map(x => ({
      ...x,
      rolls: Number.isInteger(x.rolls) ? String(x.rolls) : x.rolls.toFixed(1),
      eff: x.eff.toFixed(1),
      value: x.pct ? `${x.num.toFixed(1)}%` : String(Math.round(x.num)),
    }))
  return {
    score: score || '-',
    grade: markKeyOf(markClass),
    mark: markTierOf(markClass, score),
    valid,
    total: artis.length * 4,
    rows,
    stats,
    classTitle: opts.classTitle || '',
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
  const charWeight = artis.charWeight || {}
  const equip = flattenArtis(artis, game, charWeight)
  const weapon = profile?.weapon || {}
  const weaponIcon = stripSlash(weapon?.imgs?.icon || weapon?.icon || weapon?.img || '')
  /* 武器主/副词条与被动都从 miao 的 getWeaponDetail() 拿：
     `attrs` 形如 { atkBase: '674', cdmg: '44.1%' }，`desc` 是 { name, desc }（已按精炼替换数值） */
  const wDetail = (() => {
    try {
      return typeof profile?.getWeaponDetail === 'function' ? (profile.getWeaponDetail() || {}) : {}
    } catch {
      return {}
    }
  })()
  const wAttrs = wDetail?.attrs && typeof wDetail.attrs === 'object' ? wDetail.attrs : {}
  const wMain = Object.entries(wAttrs)
    .map(([key, value]) => ({ key, label: propLabel({ key }, game), value: String(value), ...propIcon({ key }) }))
    .filter(x => x.label && x.value && x.value !== 'NaN')
  const wPassive = wDetail?.desc && typeof wDetail.desc === 'object' ? wDetail.desc : {}
  /* 被动描述带 <nobr>/<span> 等标签，图片里用不到，统一压成纯文本 */
  const wPassiveDesc = String(wPassive?.desc || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const attrs = detailAttrRows(profile, game, charWeight)
  const score = (() => {
    const total = Number(artis.totalMark)
    if (Number.isFinite(total) && total > 0) return (Math.round(total * 10) / 10).toFixed(1)
    const raw = profile?.artis?._mark
    return raw != null ? (Math.round(Number(raw) * 10) / 10).toFixed(1) : ''
  })()

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

  /* 命座图标：miao 的 char.imgs 里存的是 cons1~cons6（1 对应第 1 命），
     点亮的个数与 profile.cons 一致，未点亮由 CSS 灰度处理 */
  const consCount = Number(profile?.cons) || 0
  const consIcons = Array.from({ length: 6 }, (_, i) => ({
    file: stripSlash(imgs[`cons${i + 1}`] || ''),
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
    elemKey: elemKeyOf(char?.elem),
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
      passiveName: wPassive?.name || '',
      passiveDesc: wPassiveDesc,
    } : null,
    artis: equip,
    sets: setSummary(equip),
    talents: detailTalents(profile, game, imgs),
    artisOverall: buildArtisOverall(equip, score, artis.markClass || profile?.artis?.markClass || '', {
      classTitle: artis.classTitle || '',
    }),
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

/* ───────────── 伤害条目中文化 ─────────────
 * akasha 的条目名是社区英文（Soumetsu Cutting、Hyouka、Prism Shot），接口没有中文。
 * 这里不依赖外部词表，而是用 miao 的中文天赋数据做对照：
 *   · type 是 E / Q 时，先查该角色的 E / Q 天赋中文名（如「神里流·霜灭」）
 *   · 再用英文里的关键词匹配 miao 的「技能表项」名（切割伤害 / 绽放伤害）
 *   · 匹配不到就退回「天赋名 · 类型」，仍然比「技能3」可读
 * 其余通用词（Normal Attack / Avg DMG / Vape 等）走 DMG_TERMS 逐词替换。
 */
const DMG_TABLE_HINT = [
  // [英文关键词, 表项名里应出现的中文]
  [/cutting|slash|sweep/i, '切割'],
  [/bloom/i, '绽放'],
  [/press/i, '点按'],
  [/hold/i, '长按'],
  [/low\s*hp|low-hp/i, '低血量'],
  [/heal/i, '治疗'],
  [/continuous|tick/i, '持续'],
  [/entry|enter|field/i, '领域'],
  [/explosion|burst/i, '爆发'],
]

/**
 * 取某角色某类型（a/e/q）的中文天赋名与表项名。
 * miao 的角色目录按中文名存放，读不到就返回 null（不影响出图）。
 */
const TALENT_CN_CACHE = new Map()
function talentCn(charName, slot) {
  const key = `${charName}|${slot}`
  if (TALENT_CN_CACHE.has(key)) return TALENT_CN_CACHE.get(key)
  let out = null
  try {
    const file = path.join(PLUGIN_ROOT, '..', 'miao-plugin', 'resources', 'meta-gs', 'character', String(charName || ''), 'data.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const talent = data?.talent?.[slot]
    if (talent?.name) {
      out = {
        name: talent.name,
        tables: (talent.tables || []).map(t => String(t?.name || '')).filter(Boolean),
      }
    }
  } catch (_) {
    out = null
  }
  TALENT_CN_CACHE.set(key, out)
  return out
}

/** 把 akasha 的英文条目名映射成「天赋名 · 表项名」 */
function cnDmgEntry(raw, type, charName) {
  const text = String(raw || '')
  const code = String(type || '').toUpperCase()
  /* 反应 / 元素类条目（Overloaded DMG、Vape Pyro Swirl DMG）没有对应天赋，
     交给下面的通用词替换，别硬套「风压剑」这类天赋名。 */
  if (/Overloaded|Swirl|Vape|Vaporize|Aggravate|Spread|Hyperbloom|Burgeon|Superconduct|Electro-Charged|Shatter|Frozen|Lunar-Charged|Lunar-Bloom|Lunar-Crystallize/i.test(text)) return ''
  const slot = code.startsWith('N') || code === 'A' || code === 'CA' ? 'a'
    : code.startsWith('E') || code === 'SSC' || code === 'LC' || code === 'LB' || code === 'LCR' ? 'e'
      : code.startsWith('Q') ? 'q'
        : ''
  const talent = slot ? talentCn(charName, slot) : null
  if (!talent) return ''
  /* 表项：按关键词找最贴近的一项（切割/绽放/持续…） */
  const hint = DMG_TABLE_HINT.find(([re]) => re.test(text))
  let table = ''
  if (hint) table = talent.tables.find(name => name.includes(hint[1])) || ''
  if (!table) table = talent.tables.find(name => /伤害|治疗/.test(name)) || ''
  if (!table) return talent.name
  /* 「技能伤害 / 爆发伤害」这类通用表项不额外拼接，只留天赋名 */
  if (/^(技能|普攻|重击|下坠|爆发|领域)伤害$/.test(table)) return talent.name
  /* 普攻要区分段数：只有明确写了 N2/N3 才算具体段数，默认不拼「一段」 */
  if (slot === 'a') {
    if (!/^N[2-9]/.test(code)) return talent.name
  }
  /* 表项名自带「伤害」时压掉，避免「霜灭 · 切割伤害」读起来啰嗦 */
  const short = table.replace(/伤害$/, '').replace(/治疗量$/, '')
  return short && short !== talent.name ? `${talent.name} · ${short}` : talent.name
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
  /* 反应类条目：akasha 直接给反应名，没有技能前缀 */
  [/\bVape\b/gi, '蒸发'],
  [/\bVaporize\b/gi, '蒸发'],
  [/\bOverloaded\b/gi, '超载'],
  [/\bSwirl\b/gi, '扩散'],
  [/\bAggravate\b/gi, '激化'],
  [/\bSpread\b/gi, '蔓激化'],
  [/\bHyperbloom\b/gi, '超绽放'],
  [/\bBurgeon\b/gi, '烈绽放'],
  [/\bBloom\b/gi, '绽放'],
  [/\bSuperconduct\b/gi, '超导'],
  [/\bElectro-Charged\b/gi, '感电'],
  [/\bShatter\b/gi, '碎冰'],
  [/\bFreeze\b/gi, '冻结'],
  [/\bPyro\b/gi, '火'],
  [/\bHydro\b/gi, '水'],
  [/\bCryo\b/gi, '冰'],
  [/\bElectro\b/gi, '雷'],
  [/\bAnemo\b/gi, '风'],
  [/\bGeo\b/gi, '岩'],
  [/\bDendro\b/gi, '草'],
]
const cnDmgName = s => DMG_TERMS.reduce((text, [re, to]) => text.replace(re, to), String(s || ''))

/**
 * 伤害条目名：akasha 只给社区配的英文技能名（如 Sweeping Fire、Prism Shot），
 * 无法逐条翻译。能翻成纯中文的（元素战技释放、月感电…）保留，仍然带英文的
 * 退回「技能N」占位，避免表格里出现看不懂的单词。
 * 括号内是配装/Buff 备注（TTDS & VV up、30%），与条目本身无关，一并去掉。
 */
function cleanDmgName(raw, index, type = '', charName = '') {
  const mapped = cnDmgEntry(raw, type, charName)
  if (mapped) return mapped
  const text = cnDmgName(raw)
    .replace(/\([^)]*\)/g, '')
    .replace(/期望伤害|伤害|治疗|连招|队伍/g, '')
    .replace(/[,，、:：%]/g, '')
    .replace(/\s+/g, '')
    .trim()
  /* 仍有英文说明是专有技能名（如 Gravity Interference），
     用「类型 + 序号」兜底，比裸的「技能N」更能说明是哪一类。 */
  if (/[A-Za-z]/.test(text) || !text) {
    const tag = dmgTypeTag(type)
    return tag && tag !== '伤害' ? `${tag} · 第 ${index + 1} 项` : `技能${index + 1}`
  }
  return text
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
  [/^O$/, '超载'],
  [/^S$/, '扩散'],
  [/^B$/, '绽放'],
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
/* ───────────── 喵喵伤害计算 ─────────────
 *
 * 与 `#<角色>伤害` 同源：直接调 miao 的 Avatar.calcDmg({ mode: 'profile' })，
 * 拿到该配装下所有招式的暴击 / 期望伤害。和 Akasha 那份的区别是：
 * Akasha 只有榜首配装的一条汇总，喵喵这份按招式逐条列出，且就是本地面板算的。
 * 失败（老版本 miao 没有 calcDmg、角色没有 calc 规则）一律返回 null，不影响出图。
 */
/* 元素键归一：原神 meta 是英文键（pyro/hydro/…），星铁是中文（火/冰/雷/量子/虚数/物理），
   统一成 `elem-<key>` 类名挂到 body 上，命座点亮色等元素相关样式都吃这一个变量。 */
const ELEM_KEY_ALIAS = {
  pyro: 'pyro', hydro: 'hydro', electro: 'electro', cryo: 'cryo', anemo: 'anemo', geo: 'geo', dendro: 'dendro',
  火: 'pyro', 水: 'hydro', 雷: 'electro', 冰: 'cryo', 风: 'anemo', 岩: 'geo', 草: 'dendro',
  量子: 'quantum', 虚数: 'imaginary', 物理: 'physical',
}
const elemKeyOf = (elem) => ELEM_KEY_ALIAS[String(elem || '').trim().toLowerCase()] || ''

const commaNum = (n) => {
  const v = Number(n)
  if (!Number.isFinite(v)) return ''
  return Math.round(v).toLocaleString('en-US')
}

async function miaoDmgTable(av) {
  if (typeof av?.calcDmg !== 'function') return null
  try {
    const calc = await av.calcDmg({ mode: 'profile' })
    const rows = (calc?.ret || [])
      .filter((r) => r && r.type !== 'text' && Number.isFinite(Number(r.dmg)) && Number.isFinite(Number(r.avg)))
      .map((r) => ({
        title: String(r.title || '').trim(),
        dmg: commaNum(r.dmg),
        avg: commaNum(r.avg),
      }))
      .filter((r) => r.title)
    if (!rows.length) return null
    return {
      rows,
      enemyLv: Number(calc.enemyLv) || 103,
      enemyName: String(calc.enemyName || '').trim(),
      createdBy: String(calc.createdBy || '').trim(),
    }
  } catch (err) {
    logger.debug?.(`[HoYoGet][hoyo_panel] 喵喵伤害计算失败：${err?.message || err}`)
    return null
  }
}

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

/* akasha 的服务器码 → 国旗（flagcdn 的两位码）。
   CN=国服、NA=美服、EU=欧服；ASIA 是亚服（日韩东南亚共用），没有统一国旗。 */
const REGION_FLAG = { CN: 'cn', NA: 'us', EU: 'eu', TW: 'tw' }

async function akashaForChar(charId, uid, charName = '') {
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
      /* ⚠ akasha 的 owner.region 是「服务器」不是国家码：CN / NA / EU / ASIA。
         以前直接拿两位码拼国旗，NA 会命中纳米比亚（ Namibia ），ASIA 又不是两位码
         直接被丢掉 —— 榜单里就出现「有的行有旗、有的行没有」。
         这里显式映射到代表性国旗；ASIA 跨多国没有统一国旗，交给模板画地球图标。 */
      const region = String(e?.owner?.region || '').toUpperCase()
      const flagCode = REGION_FLAG[region] || ''
      const cons = Number(e?.constellation) || 0
      return {
        rank: i + 1,
        uid: String(e?.uid || ''),
        nickname: e?.owner?.nickname || '',
        region,
        flag: flagCode ? `https://flagcdn.com/w20/${flagCode}.png` : '',
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

    /* 分技能明细：`getCalculationsForUser` 的 fit 只有总分，明细要去
       `/api/damageDistribution/<calculationId>/<uid>/<md5>` 拿（站点伤害页同款），
       再按 calculationId 对上本人的那一项。失败就隐藏表格，不影响其他模块。 */
    let additional = Array.isArray(fit?.calculation?.additional) ? fit.calculation.additional : null
    if (!additional && fit?.calculationId && fit?.md5) {
      try {
        const dist = await getDamageDistribution(fit.calculationId, uid, fit.md5)
        const hit = dist.find(x => String(x?.id) === String(fit.calculationId))
          || dist.find(x => Math.abs(Number(x?.result) - Number(fit.result)) < 1)
        if (Array.isArray(hit?.additional)) additional = hit.additional
      } catch (err) {
        logger.debug?.(`[HoYoGet][hoyo_panel] akasha 伤害明细获取失败：${err?.message || err}`)
      }
    }

    /* `value` 是单次命中期望伤害，`quantity` 是一轮循环的次数，
       表格右侧展示 value×quantity 的整轮期望，次数单独占一列。 */
    const detail = (additional || []).slice(0, 6).map((d, i) => {
      const qty = Number(d?.quantity) || 1
      const name = cleanDmgName(d?.name, i, d?.type, charName)
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

/* 供自测脚本调用（不改运行行为） */
export const __test = { cnDmgEntry, cleanDmgName, talentCn, miaoDmgTable, commaNum }

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
        /* 免「米哈游」前缀的同义写法（会先被 accept 改写，规则表里留着保持一致） */
        { reg: NO_PREFIX_REFRESH_REG.source, fnc: 'refreshPanel' },
        { reg: NO_PREFIX_PANEL_REG.source, fnc: 'panel' },
        { reg: NO_PREFIX_CHAR_REG.source, fnc: 'panel' },
        { reg: NO_PREFIX_LIST_REG.source, fnc: 'panel' },
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
    /* 免「米哈游」前缀：#原神面板 / #星铁面板 桑多涅 ……
       优先级低于 miao 就会先被它接走，所以先把 e.msg 补回前缀，后面全走同一套逻辑 */
    const prefixed = withMhyPrefix(msg)
    if (prefixed) e.msg = prefixed
    const text = String(e.msg || '')
    if (!PANEL_REG.test(text) && !PANEL_CHAR_REG.test(text) && !PANEL_REFRESH_REG.test(text)
      && !PANEL_LIST_REG.test(text) && !PANEL_SHORT_CHAR_REG.test(text)) return
    this.e = e
    if (PANEL_REFRESH_REG.test(text)) await this.refreshPanel(e)
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
      /* ⚠ 不能用返回值判断成功。
         miao 的 ProfileAvatar.refreshProfile 成功时返回 player._update.length，
         走 MiniGG / enka 这类第三方面板服务时可能返回 undefined（实测 10.4 秒后
         数据已写盘，但返回值仍是 undefined）。之前按返回值判断会直接静默 return，
         用户看到的就是「发了没反应」。改为以「重新读盘后有没有面板」为准。 */
      const fresh = new miao.Player(uid, game)
      const avatarCount = Object.keys(fresh._avatars || {}).length
      if (!fresh.hasProfile) {
        logger.warn?.(`[HoYoGet][hoyo_panel] ${uid} 刷新后仍无面板数据（refreshProfile=${refreshed}，avatars=${avatarCount}）`)
        return e.reply([
          `没能更新到 ${uid} 的面板数据。`,
          '可能原因：米游社 / 第三方面板服务都未返回可用数据，或该账号未在游戏内公开角色详情。',
          '可以先用 miao 自带的「#更新面板」确认数据源是否正常，稍后再试。',
        ].join('\n'))
      }
      logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 刷新完成，开始渲染（avatars=${avatarCount}，refreshProfile=${refreshed}）`)
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
    /* #米哈游雷神面板：没有游戏名，按原神处理（角色名足够区分；
       真要查星铁请写 #米哈游星铁面板 流萤）。 */
    const short = (m || cm) ? null : msg.match(PANEL_SHORT_CHAR_REG)
    if (!m && !cm && !short) return false
    const key = String((m || cm)?.[1] || '').toLowerCase()
    let game = ['星铁', '崩铁', 'sr'].includes(key) ? 'sr' : 'gs'
    let charName = cm ? String(cm[2] || '').trim() : ''
    if (short) charName = String(short[1] || '').trim()
    /* 游戏名也可能写在角色名里：
         #米哈游星铁遐蝶面板 / #米哈游面板 星铁遐蝶
       把开头的「星铁 / 崩铁 / sr / 原神」剥掉并按它定游戏，
       否则会被当成原神角色名，报「角色柜里没有找到「星铁遐蝶」」。 */
    const alias = charName.match(/^(原神|星铁|崩铁|gs|sr)\s*/i)
    if (alias) {
      /* 显式写了游戏名时以它为准，这里只负责把前缀从角色名里剥掉 */
      if (!key) game = ['星铁', '崩铁', 'sr'].includes(alias[1].toLowerCase()) ? 'sr' : 'gs'
      charName = charName.slice(alias[0].length).trim()
    }
    e.isSr = game === 'sr'

    const miao = await loadMiao()
    if (!miao) {
      return e.reply('需要先安装 miao-plugin 才能读取面板数据（本功能复用它抓取的面板）。')
    }

    /* 没写游戏名时，若原神角色表里没有、星铁里有，就切到星铁 */
    if (!key && charName) {
      try {
        const inGs = miao.Character?.get?.(charName, 'gs')
        const inSr = miao.Character?.get?.(charName, 'sr')
        if (!inGs && inSr) { game = 'sr'; e.isSr = true }
      } catch (_) { /* 查不到就按原神处理 */ }
    }
    const conf = GAME_CONF[game]

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

      /* Akasha 只有原神有榜；随机背景与它并行请求，两者失败都不影响面板。
         玩家头像/昵称与「原石统计」同源（roleProfile 的 index 接口），
         它内部已兜底，取不到就只是不显示这个角标。 */
      /* Akasha 只有原神榜；星铁右栏改取星穹铁道工坊的遗器排名与队伍配队。 */
      const [akasha, srWorkshop, randomBg, miaoDmg, roleInfo] = await Promise.all([
        game === 'gs' && hit?.char?.id ? akashaForChar(hit.char.id, uid, hit?.char?.name || '') : Promise.resolve(null),
        game === 'sr' ? srPanelExtras({ name: data.name, level: data.level }).catch(() => null) : Promise.resolve(null),
        randomBgUrl(),
        miaoDmgTable(hit),
        getRoleProfile(e, uid, game).catch(() => ({})),
      ])

      /* panel_style: dark（默认暗色霓虹）/ apple（深色玻璃，见 detail-apple.css） */
      const style = String(config()?.panel_style || 'dark').trim().toLowerCase()

      return await render('hoyo_panel/detail', {
        ...data,
        gameCn: conf.cn,
        _miao_path: miaoResPath,
        avatarId: hitId,
        /* 头像昵称优先用 index 接口的，取不到再退回 miao 的 player info */
        nickname: roleInfo?.nickname || info.nickname || info.name || '',
        ownerAvatar: roleInfo?.avatar || '',
        akasha,
        srWorkshop,
        miaoDmg,
        randomBg,
        appleStyle: style === 'apple',
      }, { e, ret: true })
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 角色面板渲染失败: ${err?.message || err}`)
      return e.reply(`角色面板生成失败：${err?.message || err}`)
    }
  }

  /**
   * 计算群内排名角标。
   *
   * 数据与 miao 的 #面板列表 完全一致：用它的 ProfileRank（按群 + 角色存 zset），
   * getRank 返回 { rank, rankType }，rankType 为 dmg 表示伤害第一、mark 表示评分第一。
   * 只在群聊里做（私聊没有群号），并且 miao 未启用群排名时直接跳过。
   */
  async buildGroupRank(e, game, miao, uid, pairs) {
    const groupId = e?.group_id
    if (!groupId || !miao?.ProfileRank) return null
    /* miao 的 ProfileRank 依赖框架注入的全局 redis / Cfg；
       在非完整运行环境（或它内部报错）时直接跳过，不能拖垮整张图。 */
    if (typeof redis === 'undefined') return null
    try {
      const rank = await miao.ProfileRank.create({ groupId, uid, qq: e.user_id }, game)
      const cfg = await miao.ProfileRank.getGroupCfg(groupId, game)
      if (!rank?.allowRank || cfg?.status === 1) return null
      const limit = Number(cfg?.number) || 15
      let counted = 0
      for (const { item, av } of pairs) {
        try {
          const profile = av.getProfile?.() || av
          if (!profile?.hasData) continue
          const info = await rank.getRank(profile)
          if (!info) continue
          item.groupRank = {
            rank: Number(info.rank) || 0,
            type: info.rankType || 'mark',
            /* 前三名留真实名次，其余只要「上榜」就显示名次（与 miao 的 1/2/3/4 分档一致） */
            level: Number(info.rank) <= 3 ? Number(info.rank) : (Number(info.rank) < limit ? 4 : 10),
          }
          counted++
        } catch (_) { /* 单个角色排名失败不影响其它 */ }
      }
      logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 群排名角标：${counted}/${pairs.length}`)
      return counted ? { limit } : null
    } catch (err) {
      logger.debug?.(`[HoYoGet][hoyo_panel] 群排名计算失败：${err?.message || err}`)
      return null
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
      const pairs = []
      let skipped = 0
      const ids = Object.keys(player._avatars || {})
      for (const id of ids) {
        try {
          const av = player.getAvatar(id)
          if (!av?.isProfile) continue
          const item = flattenProfile(av, miao.Character)
          if (item.name) { chars.push(item); pairs.push({ item, av }) }
        } catch (err) {
          skipped++
          logger.debug?.(`[HoYoGet][hoyo_panel] 跳过角色 ${id}：${err?.message || err}`)
        }
      }
      if (skipped) logger.mark?.(`[HoYoGet][hoyo_panel] ${uid} 有 ${skipped} 个角色数据异常，已跳过`)

      if (!chars.length) return e.reply(`没有读到 ${uid} 的角色面板数据。`)

      /* 群内排名角标：复用 miao 的 ProfileRank（内部按群 + 角色维护 zset），
         给每个角色标「最强」（期望伤害第一）/「最高分」（圣遗物分第一）/ 名次。
         私聊或 miao 没有该模块时整块跳过，不影响出图。 */
      const [groupRank, randomBg] = await Promise.all([
        this.buildGroupRank(e, game, miao, uid, pairs),
        randomBgUrl(),
      ])

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
        groupRank,
        rankLimit: groupRank?.limit || 15,
        randomBg,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][hoyo_panel] 面板渲染失败: ${err?.message || err}`)
      return e.reply(`面板获取失败：${err?.message || err}`)
    }
  }
}
