import lodash from 'lodash'
import { calcAvatarBestDmg } from './sr_engine.js'

/**
 * 队伍伤害 —— 数据层
 *
 * 只做「面板/接口数据 → 渲染数据」的整理，不依赖 TRSS 运行时（可独立测试）。
 * 插件入口见 apps/common/team_dmg.js，绝区零入口见 apps/zzz/zzz_panel_list.js。
 *
 * 原神：`covTeyvat` 把 miao 的面板整理成提瓦特小助手 `role_data`（口径照抄
 *   genshin 插件 ProfileData.covTeyvatData），接口返回后用 `buildGsView` 整理视图。
 *   队友增益、循环轴、充能只有服务端算得对，本地不重算伤害。
 * 星铁：没有可用的队伍伤害接口，`buildSrView` 走 miao 本地伤害规则
 *   （与面板伤害表同源），按各角色自身面板的最优招式期望伤害汇总。
 */

/**
 * 原神队伍伤害的可用通道。两家「提瓦特小助手」是同一个接口、同一套算法：
 * 实测 api.lelaer.com 与 api.yshelper.com 返回的 DPS（94830）、总伤害（170.7W）、
 * 每人伤害（胡桃 115.6W / 夜兰 40W / 行秋 12.9W / 钟离 2.2W）逐项一致，可互为备份。
 *
 * 星铁 / 绝区零没有等价接口：
 *   lelaer 的 /sr/、/zzz/ 下同路由全部 404（api.yshelper.com 同样只有 /ys/）；
 *   星穹铁道工坊（api.lingyuan.design）与绝区零工坊（api.zzzmap.com）现有路由只有
 *   角色 / 光锥 / 遗器 / 毕业度 / 排行 / 深渊统计 / 队伍体系推荐（team/list、team_system/list），
 *   没有队伍伤害计算 —— 所以这两个游戏固定走本地口径。
 */
const GS_TEAM_APIS = [
  'https://api.lelaer.com/ys/getTeamResult.php',
  'https://api.yshelper.com/ys/getTeamResult.php',
]

/** 米游社服务器数字前缀 → 提瓦特小助手的服务器标识 */
const TEYVAT_SERVER = { 5: 'cn_qd01', 6: 'us', 7: 'eur', 8: 'asia', 9: 'hk' }
export const teyvatServer = (uid) => TEYVAT_SERVER[String(uid || '')[0]] || 'cn_gf01'

/** 圣遗物词条键 → 接口要的中文名 */
const ATTRS_KEYS = {
  def: '防御力', defPlus: '防御力', hpPlus: '生命值', hp: '生命值',
  atkPlus: '攻击力', atk: '攻击力', recharge: '元素充能效率', mastery: '元素精通',
  cpct: '暴击率', cdmg: '暴击伤害', heal: '治疗加成',
  pyro: '火', hydro: '水', cryo: '冰', electro: '雷', anemo: '风', geo: '岩', phy: '物理', dendro: '草',
}

/** 接口的元素伤害字段 → miao 的元素键 */
const DMG_KEYS = {
  fire_dmg: 'pyro', water_dmg: 'hydro', ice_dmg: 'cryo', thunder_dmg: 'electro',
  wind_dmg: 'anemo', rock_dmg: 'geo', physical_dmg: 'phy', grass_dmg: 'dendro',
}

const strip = (v) => String(v ?? '').replace(/,/g, '')
const fmtPct = (v) => `${Number(v || 0).toFixed(1)}%`

/** 数字 → 万/亿 的短写 */
export function bigNum(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(2).replace(/\.?0+$/, '')}亿`
  if (v >= 10000) return `${(v / 10000).toFixed(2).replace(/\.?0+$/, '')}W`
  return String(Math.round(v))
}

/** "115.6W" / "2.2万" / "9876" → 数字 */
export function parseDmgText(text) {
  const s = String(text || '').trim()
  if (!s) return 0
  const m = s.match(/^([\d.]+)\s*([Ww万Kk千]?)$/)
  if (!m) return 0
  const n = Number(m[1]) || 0
  const unit = m[2]
  if (unit === 'W' || unit === 'w' || unit === '万') return n * 10000
  if (unit === 'K' || unit === 'k' || unit === '千') return n * 1000
  return n
}

/** "你的队伍18秒内造成总伤害170.7W，DPS为:" → { tm, totalText, totalNum } */
export function parseTips(text) {
  const s = String(text || '').replace(/你的队伍|，DPS为[:：]?/g, '')
  const m = s.match(/([\d.]+)\s*秒内造成总伤害\s*([\d.]+[Ww万Kk]?)/)
  return {
    tm: m?.[1] || '',
    totalText: m?.[2] || '',
    totalNum: parseDmgText(m?.[2] || ''),
  }
}

/**
 * miao 面板 → 提瓦特小助手的 role_data。
 * 字段名与口径对齐 genshin 插件 ProfileData.covTeyvatData：接口拿这些数字
 * 重算面板并校验，少一个字段或格式不对（比如逗号、百分号）都会算错。
 */
export function covTeyvat(profile, Format) {
  const { name, base, attr, cons, level, weapon, talent, elem } = profile
  const num = (n) => Number(n) || 0
  /* Format.comma 带千分位（"25,772"），必须先去掉逗号再 parseInt：
     直接 parseInt("25,772") 只会得到 25，接口拿到错的面板会算出离谱的伤害。 */
  const intOf = (v, fix = 0) => Format.int(Format.comma(num(v), fix).replace(/,/g, ''))
  const out = {
    role: name,
    role_class: num(cons),
    level: num(level),
    weapon: weapon?.name || '',
    weapon_level: num(weapon?.level),
    weapon_class: `精炼${num(weapon?.affix) || 1}阶`,
    hp: intOf(attr.hp, 0),
    base_hp: intOf(base.hp, 0),
    attack: intOf(attr.atk, 1),
    base_attack: intOf(base.atk, 1),
    defend: intOf(attr.def, 1),
    base_defend: intOf(base.def, 1),
    element: intOf(attr.mastery, 1),
    crit: Format.pct(num(attr.cpct)),
    crit_dmg: Format.pct(num(attr.cdmg)),
    heal: Format.pct(num(attr.heal)),
    recharge: Format.pct(num(attr.recharge)),
    ability1: num(talent?.a?.level) || 1,
    ability2: num(talent?.e?.level) || 1,
    ability3: num(talent?.q?.level) || 1,
  }
  /* 接口按元素分字段，面板的 dmg 只对应角色自身元素 */
  for (const key in DMG_KEYS) out[key] = elem === DMG_KEYS[key] ? Format.pct(num(attr.dmg)) : Format.pct(0)
  out.physical_dmg = Format.pct(num(attr.phy))

  let artisDetail = {}
  try { artisDetail = profile.getArtisMark?.() || {} } catch (_) { artisDetail = {} }
  const sets = artisDetail.sets || {}
  out.artifacts = Object.keys(sets).map((k) => `${k}${sets[k]}`).join('+')
  const types = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']
  out.artifacts_detail = lodash.map(artisDetail.artis || [], (arti, idx) => {
    if (!arti) return null
    const detail = {
      artifacts_name: arti.name || '',
      artifacts_type: types[idx - 1] || '',
      level: num(arti.level),
      maintips: ATTRS_KEYS[arti?.main?.key] || '',
      mainvalue: strip(arti?.main?.value),
    }
    lodash.forEach(arti.attrs || [], (a, i) => {
      detail[`tips${i + 1}`] = `${ATTRS_KEYS[a.key] || a.key}+${strip(a?.value)}`
    })
    return detail
  }).filter(Boolean)
  return out
}

/** 接口的关键属性值是裸数字（生命 29660），加千分位便于阅读 */
function fmtKeyValue(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s) && s.length >= 5) return Number(s).toLocaleString('en-US')
  return s
}

/** 本地头像相对路径（渲染器按 ppath 拼成 file://） */
export function faceOf(avatar) {
  try {
    const imgs = avatar?.char?.getImgs?.(avatar?.costume) || {}
    return String(imgs.qFace || imgs.face || '').replace(/^[\\/]+/, '')
  } catch (_) {
    return ''
  }
}

/**
 * 请求提瓦特小助手的队伍伤害接口，按 GS_TEAM_APIS 顺序尝试，全部失败才抛错。
 * 返回 { result, source }，source 是实际命中的域名，出图时标在页脚。
 */
export async function fetchTeamDmg(reqData) {
  const errors = []
  for (const api of GS_TEAM_APIS) {
    const host = (() => { try { return new URL(api).host } catch (_) { return api } })()
    try {
      const res = await fetch(api, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
          Referer: 'https://www.yshelper.com/',
        },
        body: JSON.stringify(reqData),
        signal: AbortSignal.timeout(60000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json || Number(json.code) !== 200 || !json.result) {
        throw new Error(json?.tips || json?.message || `code=${json?.code ?? '-'}`)
      }
      return { result: json.result, source: host }
    } catch (err) {
      errors.push(`${host}（${err?.message || err}）`)
    }
  }
  throw new Error(errors.join('；'))
}

/**
 * 接口结果 → 渲染数据。
 * 伤害数字全部取自接口（chart_data / zdl_result），这里只做拆分与对齐，
 * 不重算 —— 重算就必然和提瓦特小助手的口径不一致。
 */
/** 环形图配色（接口没给颜色时按序取用） */
const PIE_PALETTE = ["#7fc4ff", "#ffd88a", "#8ef0c0", "#ff9db1", "#c9a7ff", "#ffb066"]

/** 整数补千分位，0/空值给 - */
const fmtInt = (v) => (Number(v) > 0 ? Math.round(Number(v)).toLocaleString("en-US") : "-")

/** 充能占比 → 环角度：50% 起步、100% 满圈，和提瓦特小助手的画法一致 */
const ringAngleOf = (rate) => {
  const v = Number(String(rate || "").replace(/[^\d.]/g, "")) || 0
  const ratio = Math.min(1, (50 + v / 2) / 100)
  return `${(ratio * 360).toFixed(1)}deg`
}

/** 评级 → 配色档（模板用 rank-{{rankTier}}） */
function rankTierOf(rank) {
  const r = String(rank || "").toUpperCase()
  if (r.includes("ACE")) return "ace"
  if (r.includes("S")) return "s"
  if (r.includes("A")) return "a"
  if (r.includes("B")) return "b"
  return "c"
}

const GS_ELEM_BG = ["pyro", "hydro", "anemo", "electro", "dendro", "cryo", "geo"]

/** 元素壁纸：resources/common/bg/bg-<elem>.webp，没有对应图就退回纯渐变 */
function gsWallpaper(elem) {
  const e = String(elem || "")
  return GS_ELEM_BG.includes(e) ? `common/bg/bg-${e}.webp` : ""
}

/** 伤害构成环：按占比拼 conic-gradient，末段补齐 360 度避免缝隙 */
function buildPie(list, total) {
  let acc = 0
  const stops = []
  list.forEach((m, i) => {
    if (!m.color) m.color = PIE_PALETTE[i % PIE_PALETTE.length]
    const from = acc * 360
    acc += total > 0 ? (m.dmg || 0) / total : 0
    const to = (i === list.length - 1 ? 1 : acc) * 360
    stops.push(`${m.color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`)
  })
  return stops.length
    ? `conic-gradient(${stops.join(",")})`
    : "conic-gradient(rgba(255,255,255,.12) 0deg 360deg)"
}

/** 圣遗物图标：优先 miao 的 imgs，退回 资源目录 artifact/imgs/<套装>/1.webp */
function artisIcon(game, name, imgs) {
  const hit = (imgs || []).find((v) => String(v).includes(name))
  if (hit) return String(hit).replace(/^\/+/, "")
  return `${game === "sr" ? "meta-sr" : "meta-gs"}/artifact/imgs/${name}/1.webp`
}

/** 充能明细："XXX共获取同色球12个，异色球3个，无色球..." */
function parseRecharge(text) {
  const tmp = String(text || "").split("共获取同色球")[1]
  if (!tmp) return null
  let [same, diff] = tmp.split("个，异色球")
  if (diff && diff.split("个，无色球").length === 2) diff = diff.split("个，无色球")[0]
  const num = (v) => Number(String(v || "").replace(/[^\d.]/g, "")) || 0
  return { same: num(same), diff: num(diff) }
}

/* 星铁元素 → 原神壁纸文件：miao/艺术会有 quantum、imaginary、physical 这些原神没有的键 */
const SR_ELEM_BG = { 火: "pyro", 冰: "cryo", 雷: "electro", 风: "anemo", 量子: "quantum", 虚数: "quantum", 物理: "" }

/** 星铁壁纸：映射到原神同色系壁纸，映射不到就用 bg-sr */
function srWallpaper(elem) {
  const key = String(elem || "").trim()
  const mapped = SR_ELEM_BG[key] || SR_ELEM_BG[key.toLowerCase()]
  return mapped ? `common/bg/bg-${mapped}.webp` : "common/bg/bg-sr.webp"
}

/** miao 角色 → 模板要的补充信息（武器/圣遗物/生命/天赋） */
function avatarExtras(av, game = "gs") {
  const out = { hp: 0, weaponIcon: "", weaponStar: 0, weaponLevel: 0, artisItems: [], talents: [] }
  try {
    out.hp = Number(av?.attr?.hp) || 0
    const w = av?.weapon
    if (w) {
      out.weaponIcon = String(w.imgs?.icon || w.imgs?.img || w.img || "").replace(/^\/+/, "")
      out.weaponStar = Number(w.star) || 0
      out.weaponLevel = Number(w.level) || 0
    }
    const mark = av?.getArtisMark?.(true) || {}
    const sets = mark.sets || {}
    out.artisItems = Object.keys(sets)
      .filter((k) => Number(sets[k]) >= 2)
      .map((k) => ({ name: k, count: Number(sets[k]) || 2, img: artisIcon(game, k, mark.imgs) }))
    const t = av?.talent || {}
    out.talents = ["a", "e", "q"].map((k, i) => ({
      label: (game === "sr" ? ["普攻", "战技", "终结技"] : ["普攻", "战技", "爆发"])[i],
      level: Number(t?.[k]?.original ?? t?.[k]?.level ?? t?.[k]) || 0,
    })).filter((v) => v.level > 0)
  } catch (_) { /* 字段缺失不影响出图 */ }
  return out
}

/**
 * 接口结果 → 渲染数据。
 * 伤害数字全部取自接口（chart_data / zdl_result），这里只做拆分与对齐，
 * 不重算 —— 重算就必然和提瓦特小助手的口径不一致。
 */
export function buildGsView(result, avatars = {}, opts = {}) {
  const roles = Array.isArray(result?.role_list) ? result.role_list : []
  const charts = Array.isArray(result?.chart_data) ? result.chart_data : []
  const rechargeList = Array.isArray(result?.recharge_info) ? result.recharge_info : []
  const buffList = Array.isArray(result?.buff) ? result.buff : []

  /* 每人伤害：chart_data 的 name 形如 "胡桃\n115.6W" */
  const dmgMap = {}
  for (const item of charts) {
    const [rawName, rawDmg] = String(item?.name || "").split("\n")
    const name = String(rawName || "").trim()
    if (!name) continue
    dmgMap[name] = {
      dmg: parseDmgText(rawDmg),
      text: String(rawDmg || "").trim() || "0",
      color: String(item?.label?.color || ""),
    }
  }
  const totalDmg = Object.values(dmgMap).reduce((sum, v) => sum + v.dmg, 0) || 0

  const members = roles.map((role) => {
    const name = String(role?.role || "").trim()
    const hit = dmgMap[name] || { dmg: 0, text: "0", color: "" }
    const av = avatars[name]
    const extra = avatarExtras(av, "gs")
    const [cr, cd] = String(role?.crit || "").split("/")
    const rechRaw = rechargeList.find((r) => String(r?.recharge || "").startsWith(name))
    const rech = rechRaw ? parseRecharge(rechRaw?.recharge) : null
    const rate = rechRaw ? String(rechRaw?.rate || "") : ""
    return {
      name,
      face: faceOf(av),
      elem: String(av?.elem || ""),
      cons: Number(role?.role_class) || 0,
      consText: Number(role?.role_class) ? `${Number(role.role_class)}命` : "",
      level: String(role?.role_level || av?.level || ""),
      star: Number(role?.role_star) || 0,
      weapon: String(role?.weapon || ""),
      weaponAffix: String(role?.weapon_class || ""),
      weaponIcon: extra.weaponIcon,
      weaponStar: extra.weaponStar,
      weaponLevel: extra.weaponLevel,
      ability: String(role?.ability || "").replace(/-/g, " / "),
      crit: cr ? `${String(cr).trim()}%` : "",
      critDmg: cd ? `${String(cd).trim()}%` : "",
      hpText: fmtInt(extra.hp),
      keyLabel: String(role?.key_ability || ""),
      keyValue: fmtKeyValue(role?.key_value),
      artifacts: String(role?.artifacts || ""),
      artisItems: extra.artisItems,
      talents: extra.talents,
      dmg: hit.dmg,
      dmgText: hit.text,
      pct: totalDmg > 0 ? Math.round(hit.dmg * 100 / totalDmg) : 0,
      color: hit.color,
      rechargeRate: rate,
      rechargeAngle: ringAngleOf(rate),
      sameText: rech ? String(rech.same) : "-",
      diffText: rech ? String(rech.diff) : "-",
    }
  })

  const { tm, totalText, totalNum } = parseTips(result?.zdl_tips0)

  const combo = String(result?.combo_intro || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)

  /* buff.content 形如 "10s 班尼特Q-攻击力+20%" */
  const buffs = buffList.map((b) => {
    const content = String(b?.content || "").trim()
    if (!content) return null
    const [t, ...restParts] = content.split(" ")
    const rest = restParts.join(" ")
    const [title, ...desc] = rest.split("-")
    return { time: t, title: title || rest, desc: desc.join("-") }
  }).filter(Boolean)

  /* advice.content 形如 "0.9s 钟离e爆发，暴击:2987,不暴击:1569,期望:2081"。
     一次循环动辄上百条，全画到图上会把图拉到几千 px，只取前 40 条并在表头注明。 */
  const adviceAll = (Array.isArray(result?.advice) ? result.advice : []).map((step) => {
    const content = String(step?.content || "").trim()
    if (!content) return null
    const [t, ...restParts] = content.split(" ")
    const body = restParts.join(" ")
    const [act, ...nums] = body.split("，")
    const tri = nums.join("，").split(",").map((v) => String(v).split(/[：:]/)[1] || "-")
    return { time: t, name: String(act || body), crit: tri[0] || "-", nocrit: tri[1] || "-", expect: tri[2] || "-" }
  }).filter(Boolean)
  const advices = adviceAll.slice(0, 40)

  const sorted = lodash.sortBy(members, (m) => -(m.dmg || 0))
  const pieGradient = buildPie(sorted, totalDmg)
  const rankText = String(result?.zdl_tips2 || "").trim()

  return {
    game: "gs",
    uid: String(result?.uid || ""),
    serverName: String(result?.server_name || ""),
    avatar: String(result?.avatar || ""),
    elem: sorted[0]?.elem || "",
    dps: Number(result?.zdl_result) || 0,
    dpsText: String(Math.round(Number(result?.zdl_result) || 0)),
    dpsLabel: "DPS",
    rank: rankText,
    rankText: rankText || "-",
    cell1Label: "伤害评级",
    cell1Value: rankText || "-",
    cell3Label: "输出轴长",
    cell3Value: tm ? `${tm}s` : "-",
    rankTier: rankTierOf(rankText),
    rankDesc: String(result?.zdl_tips3 || ""),
    tm,
    tmText: tm ? `${tm}s` : "-",
    totalText: totalText || "-",
    totalNum,
    members: sorted,
    pieGradient,
    wallpaper: gsWallpaper(sorted[0]?.elem),
    combo,
    buffs,
    advices,
    adviceTotal: adviceAll.length,
    /* 伤害过程只在指令显式要求时渲染 */
    showAdvices: !!opts.detail,
    /* 原神路径由接口直出，没有本地队友增益模型；模板要读这两个字段，必须兜底 */
    teamBuffs: Array.isArray(opts.teamBuffs) ? opts.teamBuffs : [],
    mainName: String(opts.mainName || ""),
    local: false,
  }
}

/**
 * 星铁（以及原神接口故障时的回落）：逐角色本地伤害。
 * 统一走工坊引擎（sr_engine.calcAvatarBestDmg）：
 *   公式与技能倍率 = 工坊引擎，面板 = miao 面板；
 *   取期望伤害（avg）最高的那一招代表该角色。
 *
 * opts.teamBuffs 非空时，加成只作用在 opts.mainName 这一名角色上（队伍主 C），
 * 其余角色仍是自身面板 —— 队友增益本来就只给站场输出位。
 */
/**
 * 星铁（以及原神接口故障时的回落）：逐角色本地伤害。
 * 统一走工坊引擎（sr_engine.calcAvatarBestDmg）：
 *   公式与技能倍率 = 工坊引擎，面板 = miao 面板；
 *   取期望伤害（avg）最高的那一招代表该角色。
 *
 * opts.teamBuffs 非空时，加成只作用在 opts.mainName 这一名角色上（队伍主 C），
 * 其余角色仍是自身面板 —— 队友增益本来就只给站场输出位。
 */
export async function buildSrView(avatars = [], opts = {}) {
  const { teamBuffs = [], mainName = "" } = opts
  const members = []
  for (const av of avatars) {
    let dmg = 0
    let dmgText = "-"
    let title = ""
    const isMain = !!(mainName && String(av?.name || "") === mainName)
    try {
      const calc = isMain
        ? await calcAvatarBestDmg(av, 80, teamBuffs)
        : await calcAvatarBestDmg(av, 80)
      const rows = (calc?.ret || []).filter((r) => Number.isFinite(Number(r?.avg)))
      const best = lodash.maxBy(rows, (r) => Number(r.avg) || 0)
      if (best) {
        dmg = Number(best.avg) || 0
        dmgText = bigNum(dmg)
        title = String(best.title || "")
      }
    } catch (_) { /* 没有伤害规则的角色按 0 计 */ }
    const attr = av?.attr || {}
    const extra = avatarExtras(av, "sr")
    const rate = fmtPct(attr.recharge)
    members.push({
      name: String(av?.name || ""),
      face: faceOf(av),
      elem: String(av?.elem || ""),
      cons: Number(av?.cons) || 0,
      consText: Number(av?.cons) ? `${Number(av.cons)}魂` : "",
      level: String(Number(av?.level) || 0),
      star: Number(av?.star) || 0,
      weapon: String(av?.weapon?.name || ""),
      weaponAffix: av?.weapon?.affix ? `叠影${av.weapon.affix}` : "",
      weaponIcon: extra.weaponIcon,
      weaponStar: extra.weaponStar,
      weaponLevel: extra.weaponLevel,
      ability: "",
      crit: fmtPct(attr.cpct),
      critDmg: fmtPct(attr.cdmg),
      hpText: fmtInt(extra.hp),
      keyLabel: "期望伤害",
      keyValue: title,
      artifacts: "",
      artisItems: extra.artisItems,
      talents: extra.talents,
      dmg,
      dmgText,
      pct: 0,
      color: "",
      rechargeRate: rate && rate !== "0.0%" ? rate : "-",
      rechargeAngle: ringAngleOf(rate),
      sameText: "-",
      diffText: "-",
    })
  }
  const total = members.reduce((sum, m) => sum + (m.dmg || 0), 0)
  for (const m of members) m.pct = total > 0 ? Math.round((m.dmg || 0) * 100 / total) : 0
  const sorted = lodash.sortBy(members, (m) => -(m.dmg || 0))
  const pieGradient = buildPie(sorted, total)
  return {
    game: "sr",
    uid: "",
    serverName: "",
    avatar: "",
    elem: sorted[0]?.elem || "",
    dps: Math.round(total),
    dpsText: bigNum(total),
    dpsLabel: "合计",
    rank: "",
    rankText: "-",
    rankTier: "sr",
    cell1Label: "计算口径",
    cell1Value: "本地",
    cell3Label: "队伍人数",
    cell3Value: `${sorted.length} 人`,
    rankDesc: "",
    tm: "",
    tmText: "-",
    totalText: bigNum(total),
    totalNum: total,
    members: sorted,
    pieGradient,
    combo: [],
    buffs: [],
    advices: [],
    adviceTotal: 0,
    /* 队伍增益：model 里列出叠加了哪些，模板渲染成区块 */
    teamBuffs: teamBuffs.map((b) => ({ src: b.src || "", title: b.title || "" })),
    mainName,
    local: true,
    wallpaper: srWallpaper(sorted[0]?.elem),
  }
}


/**
 * 工坊口径整场模拟结果 → 渲染数据。
 * groups 里除了角色，还包括忆灵等召唤物（死龙 1407002 / 小伊卡 1409002），
 * object_id 是「主人 id + 三位序号」，取前四位就能找回主人拿头像。
 */
export function buildSimView(sim, avatars = [], opts = {}) {
  const total = Number(sim?.totalDamage) || 0
  const cycles = Number(sim?.cycles) || 5
  const byId = {}
  for (const av of avatars) byId[String(av?.id || "")] = av
  const members = (sim?.groups || []).map((g) => {
    const oid = String(g.objectId || "")
    const ownerId = oid.length >= 4 ? oid.slice(0, 4) : oid
    const av = byId[oid] || byId[ownerId]
    const attr = av?.attr || {}
    return {
      name: g.name,
      face: av ? faceOf(av) : "",
      elem: String(av?.elem || ""),
      cons: av ? Number(av.cons) || 0 : 0,
      consText: av && Number(av.cons) ? Number(av.cons) + "魂" : "",
      level: av ? String(Number(av.level) || 0) : "",
      star: av ? Number(av.star) || 0 : 0,
      weapon: av ? String(av.weapon?.name || "") : "",
      weaponAffix: av?.weapon?.affix ? "叠影" + av.weapon.affix : "",
      weaponIcon: "",
      weaponStar: 0,
      weaponLevel: 0,
      ability: "",
      crit: av ? fmtPct(attr.cpct) : "-",
      critDmg: av ? fmtPct(attr.cdmg) : "-",
      hpText: av ? fmtInt(Number(attr.hp) || 0) : "-",
      keyLabel: "出手次数",
      keyValue: String(g.hits || 0),
      artifacts: "",
      artisItems: [],
      talents: [],
      dmg: g.value,
      dmgText: bigNum(g.value),
      pct: total > 0 ? Math.min(100, Math.round(g.value * 100 / total)) : 0,
      color: "",
      rechargeRate: av ? fmtPct(attr.recharge) : "-",
      rechargeAngle: ringAngleOf(av ? fmtPct(attr.recharge) : ""),
      sameText: "-",
      diffText: "-",
    }
  })
  const sorted = lodash.sortBy(members, (m) => -(m.dmg || 0))
  const pieGradient = buildPie(sorted, total)
  const teamDps = Math.round(Number(sim?.teamDps) || 0)
  return {
    game: "sr",
    uid: String(opts.uid || ""),
    serverName: "",
    avatar: "",
    elem: sorted[0]?.elem || "",
    dps: teamDps,
    dpsText: String(teamDps),
    dpsLabel: "DPS",
    rank: "",
    rankText: "-",
    rankTier: "sr",
    cell1Label: "计算口径",
    cell1Value: cycles + " 轮模拟",
    cell3Label: "伤害来源",
    cell3Value: sorted.length + " 项",
    rankDesc: "",
    tm: String(cycles),
    tmText: cycles + " 轮",
    totalText: bigNum(total),
    totalNum: total,
    members: sorted,
    pieGradient,
    wallpaper: srWallpaper(sorted[0]?.elem),
    combo: Array.isArray(sim?.actions) ? sim.actions : [],
    buffs: [],
    advices: [],
    adviceTotal: 0,
    showAdvices: false,
    teamBuffs: Array.isArray(opts.teamBuffs) ? opts.teamBuffs : [],
    mainName: String(opts.mainName || ""),
    footNote: "工坊引擎整场模拟：" + String(cycles) + " 轮 × 3 敌，含忆灵与遗器套装效果；行动记录为引擎实际出手顺序",
    local: true,
  }
}

export const __test = { covTeyvat, buildGsView, buildSrView, buildSimView, parseDmgText, parseTips, teyvatServer, bigNum, faceOf }
