import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, pluginPriority, render, yaml } from '#HoYoGet'
import { damageSkillsAt, getCharRates } from '../system/zzz_skill_rate.js'
import { getBuffAreas } from '../system/zzz_buff.js'

/**
 * 绝区零面板（xhh 自研）—— 第 2 步：归一化 + 自研渲染。
 *
 * 数据源：米游社 record 接口 avatar/basic（角色基础列表）。
 * 第 1 步探针已确认真实字段（见 HANDOFF_zzz_panel.md），本步据此写归一化与渲染，
 * 不复用 ZZZ-Plugin 的模板/算法，只借鉴产品形态。
 *
 * 单角色详情指令（米游社<名字>面板，如 米游社南宫羽面板）已实现：复用同一份基础列表取 id，
 * 再调 avatar/info 拿 专武/驱动盘/技能/影，自研模板 resources/zzz_panel/detail.html 出图。
 *
 * 入口指令：
 *   - `米游社更新面板`  → 列表面板（本插件）
 *   - `米游社<名字>面板`（如 米游社南宫羽面板）→ 单角色详情（本插件，旧「米游社面板 <名字>」仍兼容）
 *   都不带 # 前缀，靠有无 # 区分绝区零（本插件）/ 原神（miao-plugin 的 #米游社更新面板）。
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ZZZ_ROOT = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin')
const OUT_DIR = path.join(PLUGIN_ROOT, 'data', 'zzz_panel')

// 属性 / 职业 中文映射，与 system/mys.js 的 zzz_element_map / zzz_type_map 保持一致
//（属产品形态，非角色数值表，数值表一律现取、不搬）。
const ZZZ_ELEMENT_MAP = { 200: '物理', 201: '火', 202: '冰', 203: '电', 204: '风', 205: '以太', 300: '流明' }
const ZZZ_TYPE_MAP = { 1: '强攻', 2: '击破', 3: '异常', 4: '支援', 5: '防护', 6: '命破', 7: '锋御' }
// 卡片配色（展示用，对应属性主题色）
const ELEMENT_COLOR = { 物理: '#9aa4ad', 火: '#ff6b4a', 冰: '#5cc8ff', 电: '#ffd84d', 风: '#6fe3b0', 以太: '#b98bff', 流明: '#ffe9a8' }
const RARITY_COLOR = { S: '#ffcf5c', A: '#9b8cff' }

// 米游社属性 id → 模板字段键 / 精灵类名（图标在 resources/zzz_panel/images/panel_icons/ 下）
const ZPROP = {
  1: { k: 'hpmax', c: 'hpmax' }, 11102: { k: 'hpmax', c: 'hpmax' }, 11103: { k: 'hpmax', c: 'hpmax' },
  2: { k: 'attack', c: 'attack' }, 12101: { k: 'attack', c: 'attack' }, 12102: { k: 'attack', c: 'attack' }, 12103: { k: 'attack', c: 'attack' },
  3: { k: 'def', c: 'def' }, 13102: { k: 'def', c: 'def' }, 13103: { k: 'def', c: 'def' },
  4: { k: 'breakstun', c: 'breakstun' }, 12202: { k: 'breakstun', c: 'breakstun' },
  5: { k: 'crit', c: 'crit' }, 20103: { k: 'crit', c: 'crit' },
  6: { k: 'critdam', c: 'critdam' }, 21103: { k: 'critdam', c: 'critdam' },
  7: { k: 'elementabnormalpower', c: 'elementabnormalpower' }, 31402: { k: 'elementabnormalpower', c: 'elementabnormalpower' },
  8: { k: 'elementmystery', c: 'elementmystery' }, 31203: { k: 'elementmystery', c: 'elementmystery' },
  9: { k: 'penratio', c: 'penratio' }, 23103: { k: 'penratio', c: 'penratio' },
  11: { k: 'sprecover', c: 'sprecover' }, 30502: { k: 'sprecover', c: 'sprecover' },
  232: { k: 'penvalue', c: 'penvalue' }, 23203: { k: 'penvalue', c: 'penvalue' },
  319: { k: 'dmgbonus', c: 'dmgbonus' },
}
// 字段键 → 中文标签（属性行显示名）
const ZPROP_LABEL = {
  hpmax: '生命值', attack: '攻击力', def: '防御力', breakstun: '冲击力', crit: '暴击率',
  critdam: '暴击伤害', elementabnormalpower: '异常掌控', elementmystery: '异常精通',
  penratio: '穿透率', sprecover: '能量自动回复', penvalue: '穿透值', dmgbonus: '伤害加成',
}
// 元素 type → 精灵类名（element-icon 用；小写；以太用 ether）
const ZELEM = { 200: 'physical', 201: 'fire', 202: 'ice', 203: 'electric', 204: 'wind', 205: 'ether', 300: 'lumiflux' }
const ZELEM_STR = { 200: 'Physical', 201: 'Fire', 202: 'Ice', 203: 'Electric', 204: 'Wind', 205: 'Ether', 300: 'Lumiflux' }
// 技能类型 → 固定槽位顺序（模板按 skills[0..5] 取）
const SKILL_POS = [0, 1, 2, 3, 5, 6]

/** 把米游社一条基础列表角色，归一化为卡片所需的最小字段，不引入任何猜测字段 */
function normalizeAvatar(item) {
  const element = ZZZ_ELEMENT_MAP[item?.element_type] || `属性${item?.element_type ?? ''}`
  const type = ZZZ_TYPE_MAP[item?.avatar_profession] || `类型${item?.avatar_profession ?? ''}`
  const rarity = item?.rarity === 'S' ? 'S' : (item?.rarity || 'A')
  return {
    id: item?.id,
    name: item?.name_mi18n || item?.full_name_mi18n || `角色${item?.id}`,
    level: item?.level ?? 0,
    rarity,
    rarityColor: RARITY_COLOR[rarity] || '#9b8cff',
    element,
    elementColor: ELEMENT_COLOR[element] || '#888',
    type,
    camp: item?.camp_name_mi18n || '',
    rank: item?.rank ?? 0,
    icon: item?.role_square_url || item?.hollow_icon_path || item?.group_icon_path || '',
  }
}

/** 本地时间字符串，用于面板页脚时间戳 */
function formatNow() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 面板随机背景：默认用 yppp 的随机二次元图；配置成空字符串可恢复纯黑底
const DEFAULT_PANEL_BG = 'https://api.yppp.net/api.php'
function getPanelBg() {
  try { return String(config()?.zzz_panel_bg_url ?? DEFAULT_PANEL_BG).trim() } catch { return DEFAULT_PANEL_BG }
}

const SKILL_NAME = { 0: '普攻', 1: '特殊技', 2: '闪避', 3: '连携技', 5: '核心技', 6: '支援技' }
// 技能展示顺序（贴近米游社面板）：普攻/闪避/特殊技/支援技/连携/核心
const SKILL_ORDER = [0, 2, 1, 6, 3, 5]
// 技能等级上限：核心被动为 7，其余为 12（产品形态，非数值表）
const SKILL_MAX = { 0: 12, 1: 12, 2: 12, 3: 12, 5: 7, 6: 12 }
const RATING_MAP = { ER_SS: 'SS', ER_S_Plus: 'S+', ER_S: 'S', ER_A_Plus: 'A+', ER_A: 'A', ER_B_Plus: 'B+', ER_B: 'B', ER_C: 'C' }

/** 剥离米游社富文本标签（<color=...>、</color>、<IconMap:...>）并压平换行，纯展示用 */
function stripTags(s) {
  return String(s || '')
    .replace(/<color=[^>]*>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<IconMap:[^>]*>/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 百分比字符串 → 小数（"9.8%"→0.098；无数值→0） */
function toRatio(v) {
  const n = parseFloat(v)
  if (isNaN(n)) return 0
  return String(v).includes('%') ? n / 100 : n
}
/** 纯数值字符串 → 数字（无数值→0） */
function toNum(v) {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

/**
 * 伤害乘区（按公开公式实现：暴击 / 增伤 / 易伤 / 抗性 / 防御）。
 * 敌方面板默认：level=角色等级、1级基础防御力=50（敌防=等级基数）、抗性=-0.2（有弱点）。
 * 仅计算与技能无关的乘区；基础区=技能倍率×攻击力，倍率需角色数据（米游社接口不返回），故不展示。
 */
const hasSetBoost = extra => !!(extra?.applied || []).some(x => x.src === '套装' && x.type === '增伤')

function calcDamageAreas(bp, level, extra = {}) {
  const crit = Math.min(1, toRatio(bp.crit?.final) + (extra.critRateAdd || 0))
  const critdmg = Math.min(5, toRatio(bp.critdam?.final) + (extra.critdmgAdd || 0))
  const lv = level && level > 0 ? level : 1
  const getBase = l => Math.floor(0.1551 * Math.min(60, l) ** 2 + 3.141 * Math.min(60, l) + 47.2039)
  const base = getBase(lv)
  const DEF = (50 / 50) * getBase(lv)
  const penRatio = Math.min(2, toRatio(bp.penratio?.final) + (extra.penRatioAdd || 0))
  const pen = toNum(bp.penvalue?.final) + (extra.penValueAdd || 0)
  // 无视防御与穿透率分属两个乘数：DEF × (1-无视防御) × (1-穿透率) - 穿透值
  const defIgnore = Math.min(1, extra.defIgnoreAdd || 0)
  const effectiveDef = Math.max(0, DEF * (1 - defIgnore) * (1 - penRatio) - pen)
  return {
    critical: 1 + crit * critdmg,
    crit,
    critdmg,
    // 增伤区 = 1 + Σ 增益增伤（音擎主动 + 套装被动 + 额外能力 + 影画）
    //
    // 面板自带的 dmgbonus（属性伤害加成）**不能再乘一次**：绝区零的属性伤害加成
    // 只由驱动盘套装被动提供，它就是 sets 里 check:2/4 的那几条，重复计入会翻倍。
    // 所以只在「没有套装增伤被计入」时才用面板值兜底（例如套装数据未收录时）。
    // 同理 crit/critdmg/penratio/penvalue 里的增益项：音擎的暴击率与暴伤是常驻被动，
    // 接口给出的 final 已含（实测 final 的 add 项为 +0.0%），但核心被动的暴伤是
    // 按技能等级激活的、面板不含，所以核心被动的暴伤要额外计入。
    boost: hasSetBoost(extra)
      ? (extra.boost || 1)
      : (toRatio(bp.dmgbonus?.final) + (extra.boost || 1)),
    vulnerability: extra.vulnerability || 1,
    // 抗性区 = 1 - (敌人抗性 - 无视抗性)；默认敌人抗性 -0.2（有弱点）
    resistance: 1 - (-0.2 - (extra.resIgnoreAdd || 0)),
    defence: Math.min(1, Math.max(0, base / (effectiveDef + base))),
  }
}

/**
 * 逐技能伤害。
 *
 * 公式（绝区零）：
 *   基础区 = 技能倍率(该技能等级) × 面板攻击力
 *   期望伤害 = 基础区 × 暴击区 × 增伤区 × 易伤区 × 抗性区 × 防御区
 *   暴击伤害 = 基础区 × (1+暴伤) × 增伤区 × 易伤区 × 抗性区 × 防御区
 * 其中暴击区 = 1 + 暴击率×暴伤（期望），暴击伤害那列不含暴击率。
 *
 * 技能等级不能一律取满级：倍率表按级给出，且接口里每个技能组等级不同
 * （普攻常 12、闪避 8），所以按接口实际等级逐个代入。
 * 接口与倍率表靠**技能中文名**对齐（两边都形如「连携技：星落间章」）。
 */
// 接口与倍率表的前缀用词不一致（接口「普通攻击/强化特殊技」，表里「普攻/强E」），
// 只比核心技能名会撞车（普攻与强化普攻同名），所以「类别 + 核心名」一起匹配。
const SKILL_PREFIX_RE = /^(普通攻击|强化普攻|蓄力普攻|蓄力攻击|普攻|强化特殊技|特殊技|强E|闪避反击|冲刺攻击|闪避|连携技|终结技|核心被动|额外能力|快速支援|招架支援|支援突击|支援)\s*[：:]\s*/
const skillCore = (s) => String(s || '')
  .replace(SKILL_PREFIX_RE, '')
  .replace(/[\s·・（）()【】「」\[\]［］]/g, '')
  .toLowerCase()
function skillCat(text) {
  const t = String(text || '')
  if (/终结技/.test(t)) return 'RZ'
  if (/连携技/.test(t)) return 'RL'
  if (/强化特殊技|强E/.test(t)) return 'EQ'
  if (/特殊技/.test(t)) return 'E'
  if (/强化普攻/.test(t)) return 'AQ'
  if (/蓄力普攻|蓄力攻击|蓄力/.test(t)) return 'AX'
  if (/普通攻击|普攻/.test(t)) return 'AP'
  if (/闪避反击/.test(t)) return 'CF'
  if (/冲刺攻击/.test(t)) return 'CA'
  if (/闪避/.test(t)) return 'C'
  if (/核心被动|额外能力/.test(t)) return 'T'
  if (/快速支援|招架支援|支援突击|支援/.test(t)) return 'L'
  return ''
}
/**
 * 把一个技能的乘区拆成「计算过程」，供「XX伤害N」指令的详细计算页展示。
 *
 * 只给构成、不重新算一遍 —— 数值仍来自 calcDamageAreas，保证详细页与面板上的
 * 数字永远一致（同一公式写两遍迟早会对不上）。
 */
function buildCalcDetail(bp, level, one) {
  const r = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
  const a = one.areas
  const lv = level && level > 0 ? level : 1
  const enemyBase = Math.floor(0.1551 * Math.min(60, lv) ** 2 + 3.141 * Math.min(60, lv) + 47.2039)
  const atk = parseFloat(bp?.attack?.final) || 0
  const critRate = r(a.crit, 4)
  const critdmg = r(a.critdmg, 4)
  const penRatio = r(Math.min(2, toRatio(bp.penratio?.final) + (one.buff?.penRatioAdd || 0)), 4)
  const penValue = r(toNum(bp.penvalue?.final) + (one.buff?.penValueAdd || 0), 2)
  const defIgnore = r(Math.min(1, one.buff?.defIgnoreAdd || 0), 4)
  const resIgnore = r(one.buff?.resIgnoreAdd || 0, 4)
  // 与 calcDamageAreas 保持同一公式：先扣无视防御，再扣穿透率，最后减穿透值
  const effDef = Math.max(0, enemyBase * (1 - defIgnore) * (1 - penRatio) - penValue)
  return {
    atk,
    // 必须用 baseTotal（含多段追加），否则「等效倍率 × 攻击力」与基础区对不上
    rate: r(one.baseTotal / (atk || 1), 3),
    base: Math.round(one.baseTotal),
    critRate,
    critdmg,
    critArea: r(a.critical, 3),
    critFormula: `1 + ${critRate} × ${critdmg}`,
    boost: r(a.boost, 3),
    vulnerability: r(a.vulnerability, 3),
    resistance: r(a.resistance, 3),
    resFormula: resIgnore ? `1 − (−0.2 − ${resIgnore})` : '1 − (−0.2)',
    resIgnore,
    enemyBase,
    penRatio,
    penValue,
    defIgnore,
    effDef: Math.round(effDef),
    defArea: r(a.defence, 4),
    defFormula: `${enemyBase} ÷ (${Math.round(effDef)} + ${enemyBase})`,
    expect: Math.round(one.expect),
    crit: Math.round(one.crit),
  }
}

/**
 * 从接口原始角色数据拼出增益查询上下文。
 * 注意各字段的口径：weapon.star 是**精炼**（1~5），rarity 才是稀有度；
 * 影画数是 avatar.rank；驱动盘套装名在 equip[].equip_suit.name（同名多件即为件数）。
 */
function buildBuffContext(avatar, charName) {
  const w = avatar?.weapon || {}
  return {
    charName,
    charFull: avatar?.full_name_mi18n || '',
    element: ZELEM_STR[avatar?.element_type] || '',
    weapon: w?.name || '',
    refine: Number(w?.star) || 0,
    suits: (avatar?.equip || []).map(d => d?.equip_suit?.name).filter(Boolean),
    rank: Number.isFinite(Number(avatar?.rank)) ? Number(avatar.rank) : undefined,
    // 核心被动的档位值按「核心技等级」代入
    tLevel: Number(avatar?.skills?.find(s => Number(s?.skill_type) === 5)?.level) || 1,
  }
}

function calcDamage(bp, level, avatar, charName) {
  const atk = parseFloat(bp?.attack?.final) || 0
  if (!atk) return { ok: false, error: '面板攻击力为 0，无法计算' }

  const rates = damageSkillsAt(charName, 16)
  if (!rates.ok) return { ok: false, error: rates.error }

  // 增益乘区（音擎/套装/核心被动/额外能力/影画）与技能有关：range 按技能代号过滤，
  // 所以每个技能单独取一次，见下方循环。
  const buffBase = buildBuffContext(avatar, charName)
  const table = new Map()
  for (const s of rates.skills) {
    if (!s.name || s.isHide) continue
    // 以「名字里的类别」为准，而不是 key 前缀：个别角色的 key 与名字类别不一致
    //（如 AXP 对应的名字是「普攻：…」），按 key 分会漏配接口技能。
    // 隐藏子段不参与主技能匹配：它只应通过 ops.add 并入主段，否则同名时会顶掉主段。
    table.set(`${skillCat(s.name)}|${skillCore(s.name)}`, s)
  }

  // 技能键 → 倍率条目（含多段组合 ops），用于按 key 追加子段伤害
  const byKey = new Map(rates.skills.map(x => [x.key, x]))

  /**
   * 单个技能键的完整伤害。
   *
   * 多段技能（ops）按源表的 after 语义处理：
   *   {op:'add',key}  这一招的伤害**加上** key 那一招的完整伤害，
   *                    子段有自己的倍率**和自己的乘区**（子段的 range 可能落在
   *                    别的增益生效范围内，所以不能拿主段的增伤区去套）
   *   {op:'x',n}      整条伤害乘 n
   * 子段取自己的技能等级：按子段键的首字母反查技能类别
   * （A普攻 E特殊技 C闪避 R连携 T核心 L支援），等级从接口 skills[] 里取。
   */
  const typeOfBase = { A: 0, E: 1, C: 2, R: 3, T: 5, L: 6 }
  const levelOfType = {}
  for (const sk of avatar?.skills || []) levelOfType[Number(sk.skill_type)] = Number(sk.level) || 1
  const rateAt = (entry, lv) => {
    const idx = Math.max(1, Math.min(lv, entry.rates?.length || 16)) - 1
    return Number(entry.rates?.[idx])
  }
  const seen = new Set()
  const one = (key, depth = 0) => {
    const entry = byKey.get(key)
    if (!entry || depth > 3) return null
    // 子段可能被多个主段引用，缓存避免重复展开（并防止自引用死循环）
    if (seen.has(key)) return null
    seen.add(key)
    const lv = levelOfType[typeOfBase[String(key)[0].toUpperCase()]] || 1
    const rate = rateAt(entry, lv)
    if (!Number.isFinite(rate) || rate <= 0) {
      // 提前返回也要把 key 从 seen 里移除，否则后续同键子段会被误判成循环引用
      seen.delete(key)
      return null
    }
    const buff = getBuffAreas({ ...buffBase, key, dynLevel: buffBase.tLevel })
    const areas = calcDamageAreas(bp, level, buff)
    const base = rate * atk
    const mul = areas.boost * areas.vulnerability * areas.resistance * areas.defence
    // 期望列含暴击率（期望值），暴击列不含 —— 两列口径不同，别混用
    let expect = base * areas.critical * mul
    let crit = base * (1 + areas.critdmg) * mul
    const adds = []
    const parts = [{ key, name: entry.name, rate, base, expect, crit, areas, buff, dyn: depth > 0 }]
    let baseTotal = base
    for (const op of entry.ops || []) {
      if (op.op === 'add') {
        const sub = one(op.key, depth + 1)
        if (!sub) continue
        expect += sub.expect
        crit += sub.crit
        baseTotal += sub.baseTotal
        adds.push(op.key)
        parts.push(...sub.parts)
      } else if (op.op === 'x' && Number.isFinite(op.n)) {
        expect *= op.n
        crit *= op.n
        // 总倍率也要跟着乘，否则多段技能的「等效倍率」会少算 x 系数
        baseTotal *= op.n
        // 已经生成的段也要同步乘，否则「分段拆解」各段之和与总伤害对不上
        for (const p of parts) {
          p.rate *= op.n
          p.base *= op.n
          p.expect *= op.n
          p.crit *= op.n
        }
      }
    }
    seen.delete(key)
    return { key, name: entry.name, rate, base, baseTotal, areas, buff, expect, crit, adds, parts }
  }

  // 接口 skills[]：skill_type 0普攻 1特殊技 2闪避 3连携 5核心 6支援
  const out = []
  for (const sk of avatar?.skills || []) {
    const skLv = Number(sk.level) || 1
    for (const item of sk.items || []) {
      const title = String(item?.title || '').trim()
      if (!title) continue
      const hit = table.get(`${skillCat(title)}|${skillCore(title)}`)
      if (!hit) continue                      // 倍率表没有这个技能（如新角色未收录）
      if (hit.isHide) continue                // 隐藏子段（如回旋斩击）只作为主段的一部分，不单列
      const one1 = one(hit.key)
      if (!one1) continue
      out.push({
        name: title,
        skillType: Number(sk.skill_type),
        key: hit.key,
        level: skLv,
        rate: one1.rate,
        // 展示用的「等效倍率」= 这一招实际打出的总倍率（含追加段），否则
        // 多段技能只显示首段倍率会让人以为算错了
        totalRate: Math.round((one1.baseTotal / atk) * 1000) / 1000,
        base: Math.round(one1.baseTotal),
        boost: Math.round(one1.areas.boost * 1000) / 1000,
        expect: Math.round(one1.expect),
        crit: Math.round(one1.crit),
        adds: one1.adds,
        // 分段明细：多段技能要能看清「每一段各打多少、各自套了什么乘区」
        parts: one1.parts.map(pp => ({
          name: pp.name || pp.key,
          key: pp.key,
          dyn: !!pp.dyn,
          rate: Math.round(pp.rate * 1000) / 1000,
          base: Math.round(pp.base),
          expect: Math.round(pp.expect),
          crit: Math.round(pp.crit),
          boost: Math.round(pp.areas.boost * 1000) / 1000,
          critArea: Math.round(pp.areas.critical * 1000) / 1000,
          defArea: Math.round(pp.areas.defence * 10000) / 10000,
        })),
        // 计算过程用：把每个乘区连同它的构成一起给出，模板才能「算出数字」而不只是显示数字
        calc: buildCalcDetail(bp, level, one1),
        // 这一招实际生效的增益（含来源），详细计算页要按招展示 —— 不同招吃到的增益不一样
        buffList: one1.buff.applied.map(x => ({
          src: x.src,
          name: x.name,
          type: x.type,
          value: `${Math.round(x.value * 1000) / 10}%`,
        })),
        buffNames: one1.buff.applied.map(x => x.name),
        buffMiss: one1.buff.missing,
      })
    }
  }
  if (!out.length) return { ok: false, error: '接口技能与倍率表没有交集（该角色可能未收录倍率）' }

  // 按总伤害降序：面板上最痛的招式排前面；顶部乘区也要取这个技能，不能取接口顺序第一个
  out.sort((a, b) => (b.expect - a.expect))
  const topBuff = getBuffAreas({ ...buffBase, key: out[0].key, dynLevel: buffBase.tLevel })
  const areas = calcDamageAreas(bp, level, topBuff)
  const critdmg = areas.critdmg
  const r2 = (v) => Math.round(v * 1000) / 1000
  const buffRows = topBuff.applied.map(x => ({ src: x.src, name: x.name, type: x.type, value: `${r2(x.value * 100)}%` }))
  const buffMiss = [...new Set(out.flatMap(x => x.buffMiss || []))]
  return {
    ok: true,
    atk,
    areas,
    critdmg,
    buffRows,
    buffMiss,
    // 口径说明：写进面板，免得看到数字却不知道它算的是什么
    notes: [
      '期望＝1+暴击率×暴伤 的期望值；暴击列按必暴击计，不含暴击率。',
      '敌方面板按角色等级、1级基础防御50、抗性-0.2（有弱点）估算；未计失衡易伤。',
      '增伤区只计音擎、套装、核心被动、额外能力、影画；技能自身倍率型增伤（如对某目标增伤50%）未计。',
      '等效倍率含多段追加（如蓄力攻击＝蓄力段＋回旋斩击）；各段按各自技能等级代入，并分别套用各自生效的增益。',
      buffMiss.length ? `未收录：${buffMiss.join('、')}` : '',
    ].filter(Boolean),
    skills: out,
    top: out[0],
    areasTxt: `暴击${r2(areas.critical)} 增伤${r2(areas.boost)} 易伤${r2(areas.vulnerability)} 抗性${r2(areas.resistance)} 防御${r2(areas.defence)}（取倍率最高一招）`,
  }
}

// 咕咕牛的面板图在 ZZZ-Plugin/resources/images/panel；本插件自己的自定义图作为第二来源
const CUSTOM_PORTRAIT_DIRS = [
  './plugins/ZZZ-Plugin/resources/images/panel',
  path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel'),
]

/**
 * 读取自定义面板图，返回 data URI；无则返回 ''。
 * 每个角色目录取第一张 png/jpg/webp；名字同时尝试简称/全称和「」包裹形式。
 */
function loadCustomPortrait(names) {
  const variants = []
  for (const nm of names) {
    if (!nm) continue
    variants.push(nm, `「${nm}」`, String(nm).replace(/[「」]/g, ''))
  }
  for (const base of CUSTOM_PORTRAIT_DIRS) {
    for (const nm of variants) {
      const dir = path.join(base, nm)
      if (!fs.existsSync(dir)) continue
      let files = []
      try { files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() } catch { files = [] }
      if (!files.length) continue
      const file = files[0]
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'jpeg' : ext
      try {
        const buf = fs.readFileSync(path.join(dir, file))
        return `data:image/${mime};base64,${buf.toString('base64')}`
      } catch { /* 读取失败则试下一个 */ }
    }
  }
  return ''
}

let zzzPartnerMap = null
function getZzzSprite(avatar) {
  if (!zzzPartnerMap) {
    try {
      zzzPartnerMap = JSON.parse(fs.readFileSync('./plugins/ZZZ-Plugin/resources/map/PartnerId2Data.json', 'utf8'))
    } catch {
      zzzPartnerMap = {}
    }
  }
  const data = zzzPartnerMap || {}
  const id = String(avatar?.id || '')
  if (id && data[id]?.sprite_id) return String(data[id].sprite_id)
  const clean = s => String(s || '').replace(/[「」&·\s]/g, '')
  const names = [avatar?.name_mi18n, avatar?.full_name_mi18n].filter(Boolean).map(clean)
  for (const info of Object.values(data)) {
    const n = clean(info?.name), f = clean(info?.full_name)
    if (names.includes(n) || names.includes(f)) return String(info.sprite_id || '')
  }
  for (const info of Object.values(data)) {
    const n = clean(info?.name), f = clean(info?.full_name)
    if (names.some(x => x && (n.startsWith(x) || x.startsWith(n) || f.startsWith(x) || x.startsWith(f)))) {
      return String(info.sprite_id || '')
    }
  }
  return ''
}

function localImageDataUri(file) {
  try {
    const buf = fs.readFileSync(file)
    const ext = path.extname(file).slice(1).toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext
    return `data:image/${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 官方全身立绘。ZZZ-Plugin 面板用的就是这套 IconRole 全图；
 * 米游社 record 的 role_vertical_painting_url 实测是 684×356 的宽幅横幅，底边会被裁。
 */
function getZzzFullBody(avatar) {
  const sprite = getZzzSprite(avatar)
  if (!sprite) return null
  const local = `./plugins/ZZZ-Plugin/resources/images/nanoka/role/IconRole${sprite}_01.webp`
  const primary = fs.existsSync(local)
    ? localImageDataUri(local)
    : `http://lulush.microgg.cn/ZZZeroUID/resource/role/IconRole${sprite}.png`
  return {
    primary,
    // Lulu 镜像偶尔不可达时回落到 nanoka；再不行由 <img onerror> 回落到接口图
    fallback: `https://static.nanoka.cc/assets/zzz/IconRole${sprite}_01.webp`,
  }
}

/**
 * 驱动盘评分（自研权重：按职业优先级 + 固定词条折算）。
 * 依据角色名取预设规则→权重(按 property_id)，逐盘算分(1-3号位副词条55分制、4-6号位主12+副43)，
 * 乘以等级系数(0.25+等级*0.05)与品质系数(S=1/A=2/3/B=1/3)，六盘求和得 0~330 总分与段位。
 * 扁平词条(小攻击/生命/防御)未做动态等效映射，对结果影响很小。
 */
const SCORE_PROP_ID = {
  '生命值百分比': 11102, '攻击力百分比': 12102, '防御力百分比': 13102, '冲击力': 12202,
  '暴击率': 20103, '暴击伤害': 21103, '穿透率': 23103, '穿透值': 23203,
  '能量自动回复': 30502, '异常精通': 31203, '异常掌控': 31402,
}
const ELEM_DMG_ID = { 200: 31503, 201: 31603, 202: 31703, 203: 31803, 204: 32303, 205: 31903 }
// 单条副词条的基础值：用于把固定攻击/生命/防御换算成百分比等效权重
const BASE_VALUE = { 11102: 3, 11103: 112, 12102: 3, 12103: 19, 13102: 4.8, 13103: 15 }
// 可能的副词条 id（用于理论最大词条）
const SUB_STAT_IDS = [11102, 11103, 12102, 12103, 13102, 13103, 20103, 21103, 23203, 31203]
// 4/5/6 号位主词条候选
const SCORE_MAIN_STATS = {
  4: [11102, 12102, 13102, 20103, 21103, 31203],
  5: [11102, 12102, 13102, 23103, 31503, 31603, 31703, 31803, 32303, 31903],
  6: [11102, 12102, 12202, 13102, 30502, 31402],
}
// 自研评分权重：按职业给出主词条/副词条优先级，不复制第三方评分表。
// 取向：强攻双暴、击破冲击、异常精通/掌控、支援回能、命破生命、锋御防御。
const SELF_SCORE_WEIGHTS = {
  strong:   { '攻击力百分比': .75, '暴击率': 1, '暴击伤害': 1, '穿透率': .75, '穿透值': .25, '属性伤害加成': 1 },
  stun:     { '冲击力': 1, '攻击力百分比': .75, '暴击率': 1, '暴击伤害': .75, '穿透率': .5, '穿透值': .25, '属性伤害加成': .75 },
  anomaly:  { '攻击力百分比': .75, '异常精通': 1, '异常掌控': 1, '穿透率': .75, '穿透值': .25, '属性伤害加成': 1 },
  support:  { '攻击力百分比': .75, '暴击率': .75, '暴击伤害': .75, '能量自动回复': 1, '穿透率': .5, '穿透值': .25, '属性伤害加成': .75 },
  rupture:  { '生命值百分比': .75, '攻击力百分比': .25, '暴击率': 1, '暴击伤害': 1, '属性伤害加成': 1 },
  defender: { '防御力百分比': 1, '暴击率': .75, '暴击伤害': .75, '穿透率': .75, '穿透值': .25, '属性伤害加成': 1 },
}
const PROF_WEIGHT_KEY = { 1: 'strong', 2: 'stun', 3: 'anomaly', 4: 'support', 5: 'support', 6: 'rupture', 7: 'defender' }
const PROF_WEIGHT_NAME = { 1: '强攻', 2: '击破', 3: '异常', 4: '支援', 5: '防护', 6: '命破', 7: '锋御' }

/** 取评分权重（按 property_id） */
function getScoreWeight(charName, stats, profession, elementType, baseProps = {}) {
  const elemId = ELEM_DMG_ID[elementType]
  const key = PROF_WEIGHT_KEY[profession] || 'strong'
  const ruleName = `自研·${PROF_WEIGHT_NAME[profession] || '强攻'}`
  const named = { ...SELF_SCORE_WEIGHTS[key] }
  const weight = {}
  for (const nm in named) {
    const id = nm === '属性伤害加成' ? elemId : SCORE_PROP_ID[nm]
    if (id != null) weight[id] = named[nm]
  }
  // 固定攻击/生命/防御按角色基础值折算成百分比等效权重。
  for (const [small, big, keyName] of [[11103, 11102, 'hpmax'], [12103, 12102, 'attack'], [13103, 13102, 'def']]) {
    if (!weight[big]) continue
    const base = parseFloat(baseProps?.[keyName]?.base)
    if (!(base > 0)) continue
    weight[small] ??= BASE_VALUE[small] * 100 / (BASE_VALUE[big] * base) * weight[big]
  }
  return { ruleName, weight }
}
/** 单个驱动盘的段位：沿用 ZZZ-Plugin 的分界，保留 A/S/SS/SSS/ACE/MAX */
function discGrade(score) {
  if (score >= 48) return 'MAX'
  if (score >= 40) return 'ACE'
  if (score >= 36) return 'SSS'
  if (score >= 32) return 'SS'
  if (score >= 28) return 'S'
  return 'A'
}

/** 计算驱动盘总分与段位；另返回每个盘评分 discScores 与有益/有效词条数 */
function calcEquipScore(equip_final, charName, stats, profession, elementType, baseProps = {}) {
  const { ruleName, weight } = getScoreWeight(charName, stats, profession, elementType, baseProps)
  let total = 0
  const discScores = []
  let useful = 0
  let effective = 0
  for (const eq of (equip_final || [])) {
    const slot = eq.slot || 0
    const levelMult = 0.25 + (eq.level ?? 0) * 0.05
    const rarityMult = eq.rarity === 'S' ? 1 : eq.rarity === 'A' ? 2 / 3 : eq.rarity === 'B' ? 1 / 3 : 1
    const mainId = (eq.main_properties && eq.main_properties[0]) ? eq.main_properties[0].pid : 0
    let actual = 0
    for (const p of (eq.properties || [])) {
      const w = weight[p.pid]
      if (w) { actual += w * (p.count ?? 0); useful += (p.count ?? 0); effective += w * (p.count ?? 0) }
    }
    const cand = SUB_STAT_IDS.filter(id => id !== mainId && weight[id]).sort((a, b) => weight[b] - weight[a]).slice(0, 4)
    let score = 0
    if (cand.length) {
      let max = weight[cand[0]] * 6
      for (let i = 1; i < cand.length; i++) max += weight[cand[i]] || 0
      if (max > 0) {
        if (slot >= 1 && slot <= 3) {
          const minScore = 12 * levelMult * rarityMult
          score = actual === 0 ? minScore : Math.max(actual / max * levelMult * rarityMult * 55, minScore)
        } else {
          const ms = (SCORE_MAIN_STATS[slot] || []).filter(id => weight[id]).sort((a, b) => weight[b] - weight[a])[0]
          const mainScore = ms ? 12 * (weight[mainId] || 0) / weight[ms] : 12
          const subScore = actual / max * 43
          score = (mainScore + subScore) * levelMult * rarityMult
        }
      }
    }
    discScores.push(+score.toFixed(2))
    total += score
  }
  const rating = total >= 280 ? 'MAX' : total >= 220 ? 'ACE' : total >= 200 ? 'SSS' : total >= 180 ? 'SS' : total >= 160 ? 'S' : total >= 120 ? 'A' : total >= 80 ? 'B' : 'C'
  return { score: +total.toFixed(1), rating, ruleName, discScores, usefulCount: useful, effectiveCount: +effective.toFixed(2) }
}

/**
 * 把一条 avatar/info 详情归一化为面板模板所需的 charData。
 * 模板字段与 resources/zzz_panel/detail.html 对齐，
 * 不复用其算法（评分用接口分近似；伤害乘区公式取自其 Calculator.ts，按面板属性计算）。
 */
function normalizeDetail(a, uid) {
  const rarity = a?.rarity === 'S' ? 'S' : (a?.rarity || 'A')
  const subElement = ZELEM[a?.element_type] || 'physical'
  const elementStr = ZELEM_STR[a?.element_type] || 'Physical'
  const w = a?.weapon || {}

  // 武器
  const weapon = w?.name ? {
    name: w.name,
    rarity: w.rarity || rarity,
    level: w.level ?? 0,
    star: (w.rarity === 'S' ? 5 : 4),
    stars: Array.from({ length: w.rarity === 'S' ? 5 : 4 }, () => (w.rarity === 'S' ? 5 : 4)),
    refine: w.star ?? 0,
    square_icon: w.icon || '',
    talent_title: w.talent_title || '',
    talent: stripTags(w.talent_content || ''),
    main_properties: (w.main_properties || []).map(p => ({
      classname: (ZPROP[p.property_id] || {}).c || 'attack',
      property_name: p.property_name || '',
      base: p.base || '',
    })),
    properties: (w.properties || []).map(p => ({
      classname: (ZPROP[p.property_id] || {}).c || 'attack',
      property_name: p.property_name || '',
      base: p.base || '',
    })),
  } : null

  // 角色基础属性 → basic_properties（按字段键；伤害加成单独处理以挂元素图标）
  const basic_properties = {}
  for (const p of (a?.properties || [])) {
    const m = ZPROP[p.property_id]
    if (!m || m.k === 'dmgbonus') continue
    const base = p.base || ''
    const add = (p.add !== undefined && p.add !== '' && p.add !== '0') ? p.add : ''
    const final = (p.final !== undefined && p.final !== '') ? p.final : (base || '')
    basic_properties[m.k] = { base, add, final }
  }
  const dmg = (a?.properties || []).find(p => (ZPROP[p.property_id] || {}).k === 'dmgbonus')
  if (dmg) {
    const base = dmg.base || ''
    const add = (dmg.add !== undefined && dmg.add !== '' && dmg.add !== '0') ? dmg.add : ''
    const final = (dmg.final !== undefined && dmg.final !== '') ? dmg.final : (base || '')
    basic_properties.dmgbonus = { property_name: dmg.property_name || '伤害加成', property_id: dmg.property_id, base, add, final }
  }

  // 技能：按固定槽位顺序产出，模板按 skills[0..5] 取
  const skills = SKILL_POS.map(t => {
    const s = (a?.skills || []).find(x => x.skill_type === t)
    return { level: s?.level ?? 0 }
  })

  // 驱动盘
  const discsRaw = a?.equip || []
  const equip_final = discsRaw.map(d => {
    const suit = d.equip_suit || {}
    return {
      slot: d.equipment_type ?? 0,
      suit_icon: d.icon || '',
      level: d.level ?? 0,
      rarity: d.rarity || 'A',
      name: d.name || '',
      suit_name: suit.name || '',
      own: suit.own || 0,
      main_properties: (d.main_properties || []).map(p => ({
        pid: p.property_id,
        classname: (ZPROP[p.property_id] || {}).c || 'attack',
        short_name: p.property_name || '',
        base: p.base || '',
      })),
      properties: (d.properties || []).map(p => {
        const valid = !!p.valid
        return {
          pid: p.property_id,
          classname: (ZPROP[p.property_id] || {}).c || 'attack',
          property_name: p.property_name || '',
          base: p.base || '',
          count: p.level ?? 0,
          hit: Math.max(0, (p.level ?? 0) - 1),
          count_arr: Array.from({ length: Math.max(0, (p.level ?? 0) - 1) }, () => 0),
          base_score: valid ? 1 : 0,
        }
      }),
    }
  })

  // 词条统计：有效副词条按 property_id 聚合（区分百分比/固定值），显示 强化次数徽标+属性名+累计值
  const ZSHORT = { 11102: '生命', 11103: '生命', 12102: '攻击', 12103: '攻击', 13102: '防御', 13103: '防御', 20103: '暴击', 21103: '暴伤', 23203: '穿透', 31203: '精通', 12202: '冲击', 30502: '回能', 31402: '掌控', 23103: '穿透率' }
  const agg = {}
  for (const d of discsRaw) {
    for (const p of (d.properties || [])) {
      const pid = p.property_id
      const isPct = String(p.base).includes('%')
      if (!agg[pid]) agg[pid] = { name: ZSHORT[pid] || p.property_name || ('x' + pid), count: 0, value: 0, isPct }
      agg[pid].count += (p.level ?? 0)
      const num = parseFloat(p.base)
      if (!isNaN(num)) agg[pid].value += num
    }
  }
  const propertyStats = Object.values(agg)
    .map(s => ({ name: s.name, count: s.count, value: s.value.toFixed(1) + (s.isPct ? '%' : '') }))
    .sort((x, y) => y.count - x.count)

  // 评分：按自研权重计算（0~330 分制），替换接口分
  const scoreStats = {
    atk: parseFloat(basic_properties.attack?.final) || 0,
    crit: toRatio(basic_properties.crit?.final),
    critdmg: toRatio(basic_properties.critdam?.final),
    am: parseFloat(basic_properties.elementabnormalpower?.final) || 0,
    ap: parseFloat(basic_properties.elementmystery?.final) || 0,
  }
  const scoreRes = calcEquipScore(equip_final, a?.name_mi18n || '', scoreStats, a?.avatar_profession, a?.element_type, basic_properties)
  const rating = scoreRes.rating
  const equip_score = scoreRes.score
  equip_final.forEach((eq, i) => {
    eq.score = scoreRes.discScores[i] ?? 0
    eq.grade = discGrade(eq.score)
  })
  const validCount = a?.equip_plan_info?.valid_property_cnt
    ?? discsRaw.reduce((s, d) => s + (d.properties || []).filter(p => p.valid).length, 0)

  const damageAreas = calcDamageAreas(basic_properties, a?.level)
  // 逐技能伤害：倍率取自本地静态表，与接口技能按中文名对齐
  const damage = calcDamage(basic_properties, a?.level, a, a?.name_mi18n || a?.full_name_mi18n || '')
  const damageAvailable = damage.ok
  const rateCovered = (() => {
    try { return getCharRates(a?.name_mi18n || '').ok } catch (_) { return false }
  })()

  // 套装效果：按 suit_id 聚合，并收集该套装已装备盘图标作配图
  const setMap = {}
  for (const d of discsRaw) {
    const s = d.equip_suit
    if (!s || s.suit_id == null) continue
    if (!setMap[s.suit_id]) setMap[s.suit_id] = { name: s.name || '', own: s.own || 0, desc1: stripTags(s.desc1 || ''), desc2: stripTags(s.desc2 || ''), icons: [] }
    if (d.icon) setMap[s.suit_id].icons.push(d.icon)
  }
  const sets = Object.values(setMap)

  // 属性行（固定顺序，供模板 {{each}} 遍历；伤害加成用元素图标）
  const STAT_ORDER = [
    ['hpmax', '生命值'], ['attack', '攻击力'], ['def', '防御力'], ['breakstun', '冲击力'],
    ['crit', '暴击率'], ['critdam', '暴击伤害'], ['elementabnormalpower', '异常掌控'], ['elementmystery', '异常精通'],
    ['penratio', '穿透率'], ['sprecover', '能量自动回复'], ['dmgbonus', '伤害加成'], ['penvalue', '穿透值'],
  ]
  const stat_rows = []
  for (const [k, label] of STAT_ORDER) {
    const v = basic_properties[k]
    if (!v) continue
    if (k === 'dmgbonus') stat_rows.push({ label: v.property_name || label, icon: 'element', cls: elementStr, base: v.base, add: v.add, final: v.final })
    else stat_rows.push({ label, icon: 'prop', cls: k, base: v.base, add: v.add, final: v.final })
  }

  const apiPortrait = a?.role_vertical_painting_url || a?.role_square_url || ''
  const fullBody = getZzzFullBody(a)
  const customPortrait = loadCustomPortrait([a?.name_mi18n, a?.full_name_mi18n])
  const charData = {
    uid: uid || a?.id || '',
    // 优先自定义面板（咕咕牛 / 本插件），没有再回落官方全身图
    role_icon: customPortrait || fullBody?.primary || apiPortrait,
    role_fallback: fullBody?.fallback || apiPortrait,
    skills,
    rarity,
    sub_element_str: subElement,
    element_str: elementStr,
    element_cn: ZZZ_ELEMENT_MAP[a?.element_type] || `属性${a?.element_type ?? ''}`,
    profession: ZZZ_TYPE_MAP[a?.avatar_profession] || `类型${a?.avatar_profession ?? ''}`,
    full_name_mi18n: a?.full_name_mi18n || a?.name_mi18n || `角色${a?.id}`,
    level: a?.level ?? 0,
    rank: a?.rank ?? 0,
    basic_properties,
    weapon,
    equip_score,
    equip_comment: rating,
    weightRule: scoreRes.ruleName,
    usefulCount: scoreRes.usefulCount,
    effectiveCount: scoreRes.effectiveCount,
    propertyStats,
    equip_final,
    damageAreas,
    damage,
    damageAvailable,
    rateCovered,
    sets,
    stat_rows,
  }
  return { uid: charData.uid, charData }
}

// 前缀刻意收窄到「不带 #」：
//   「米游社更新面板」  → 绝区零（本插件）
//   「#米游社更新面板」 → 原神（miao-plugin，已有的约定）
// 带 % 会被绝区零前缀规则（zzzReg = /^#?(%|％|绝区零|zzz)+/）先一步吃掉，实测抢不到，
// 所以绝区零这边干脆不用任何前缀，用有无 # 来区分两个游戏。
const CMD_REG = /^\s*米游社\s*(更新|刷新)\s*(全部)?\s*面板$/
// 详情新格式：米游社<名字>面板（如 米游社南宫羽面板）；保留旧「米游社面板 <名字>」兼容。
// 负向预查 (?!更新|刷新) 避免与「米游社更新面板 / 米游社刷新面板」抢。
const DETAIL_REG = /^米游社(?!更新|刷新)(.+?)面板$/
// 米游社<角色>伤害[序号]：序号省略时默认取伤害最高那一招
const DAMAGE_REG = /^米游社(?!更新|刷新)(.+?)伤害\s*(\d*)$/
const DETAIL_REG_OLD = /^米游社面板\s+(.+)$/
const HELP_REG = /^米游社面板$/

export class zzz_panel_list extends plugin {
  constructor() {
    super({
      name: '[米哈游]绝区零面板列表',
      dsc: '绝区零面板列表（自研，网格卡片）',
      event: 'message',
      // 必须压过 miao-plugin 的米游社面板与 ZZZ-Plugin 面板，否则规则抢不过它们
      priority: pluginPriority('zzz_panel_list', -100),
      rule: [
        { reg: CMD_REG.source, fnc: 'panelList' },
        { reg: DAMAGE_REG.source, fnc: 'panelDamage' },
        { reg: DETAIL_REG.source, fnc: 'panelDetail' },
        { reg: DETAIL_REG_OLD.source, fnc: 'panelDetail' },
        { reg: HELP_REG.source, fnc: 'panelDetailHelp' },
      ],
    })
  }

  async panelList(e) {
    const uid = e.user?.getUid?.('zzz')
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    // 落盘原始响应，便于后续排查 / 字段再核对（按需，不影响出图）
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const basicFile = path.join(OUT_DIR, 'avatar_basic.json')
    fs.writeFileSync(basicFile, JSON.stringify({ uid, server, deviceFpApplied: !!raw.__fp, data: raw?.data }, null, 2))

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply(`已取到响应，但没识别出角色列表。原始数据已存到：\n${basicFile}\n请检查接口返回结构。`)
    }

    // 归一化后交模板渲染（自研，不复用 ZZZ-Plugin 模板）
    const cards = list.map(it => normalizeAvatar(it))
    try {
      const img = await render('zzz_panel/list', {
        cards,
        uid,
        server,
        count: cards.length,
        time: formatNow(),
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 渲染失败：${err?.message || err}`)
      // 渲染失败兜底：回退成文字列表，至少把数据给到
      const lines = cards.slice(0, 30).map(c => `${c.name} Lv${c.level} ${c.rarity} ${c.element}/${c.type} 影${c.rank}`)
      return e.reply([
        `面板渲染失败，文字兜底（共 ${cards.length} 名代理人）：`,
        ...lines,
        `原始数据：${basicFile}`,
      ])
    }
  }

  /** 单角色详情：米游社<名字>面板（如 米游社南宫羽面板；旧 米游社面板 <名字> 仍兼容） */
  async panelDetail(e) {
    const msg = String(e.msg || '')
    const m = msg.match(DETAIL_REG) || msg.match(DETAIL_REG_OLD)
    const arg = (m && m[1] ? m[1] : '').trim()
    if (!arg) return this.panelDetailHelp(e)

    const uid = e.user?.getUid?.('zzz')
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply('未能取到角色列表，请稍后再试')
    }

    // 解析目标：纯数字=序号（从 1 起）；否则按名字模糊匹配
    let target = null
    if (/^\d+$/.test(arg)) {
      target = list[parseInt(arg, 10) - 1]
    } else {
      const lower = arg.toLowerCase()
      target = list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.full_name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower.slice(0, 1)))
    }
    if (!target || target.id == null) {
      const names = list.slice(0, 12).map((it, i) => `${i + 1}.${it.name_mi18n || it.full_name_mi18n}`).join('  ')
      return e.reply(`没找到「${arg}」。可用序号或名字，例如：\n米游社南宫羽面板\n米游社3面板\n部分角色：${names}`)
    }

    const info = await this.fetchDetail(e, uid, ck, target.id)
    if (info?.__error) return e.reply(info.__error)

    const avatar = this.pickInfo(info?.data)
    if (!avatar) return e.reply('取到详情响应，但没识别到角色数据')

    const detail = normalizeDetail(avatar, uid)
    const charData = detail.charData
    const footer = 'from 米哈游'
    try {
      const img = await render('zzz_panel/detail', { ...detail, footer, bgImage: getPanelBg() }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 详情渲染失败：${err?.message || err}`)
      return e.reply([
        `【${charData.full_name_mi18n}】Lv${charData.level} ${charData.rarity} 影${charData.rank}`,
        charData.weapon ? `专武：${charData.weapon.name} Lv${charData.weapon.level}` : '（无专武数据）',
        `详情渲染失败：${err?.message || err}`,
      ])
    }
  }

  /** 详情指令无参时的用法提示 */
  async panelDetailHelp(e) {
    return e.reply([
      '绝区零·单角色面板',
      '用法：米游社<角色名或序号>面板',
      '示例：米游社南宫羽面板',
      '　　　米游社3面板',
      '（序号看「米游社更新面板」列表从左到右第几个）',
      '',
      '看某一招的详细计算：米游社<角色>伤害<招数>',
      '示例：米游社艾莲伤害3',
      '　　　米游社艾莲伤害（不带序号＝伤害最高那招）',
    ])
  }

  /**
   * 「米游社<角色>伤害[序号]」—— 某一招的详细计算过程。
   *
   * 序号对应伤害统计表里的行号（与面板上「伤害计算」表的排序一致：期望伤害降序），
   * 省略序号默认第一招（伤害最高的那招）。
   * 面板只能给结果，这个指令把「计算过程」逐项摊开：基础区 → 各乘区 → 最终值，
   * 多段技能还会拆出每一段各自的倍率与乘区。
   */
  async panelDamage(e) {
    const msg = String(e.msg || '')
    const m = msg.match(DAMAGE_REG)
    if (!m) return false
    const arg = (m[1] || '').trim()
    if (!arg) return this.panelDetailHelp(e)

    const uid = e.user?.getUid?.('zzz')
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply('未能取到角色列表，请稍后再试')
    }

    // 与面板指令同一套解析：纯数字=列表序号，否则按名字模糊匹配
    let target = null
    if (/^\d+$/.test(arg)) {
      target = list[parseInt(arg, 10) - 1]
    } else {
      const lower = arg.toLowerCase()
      target = list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.full_name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower.slice(0, 1)))
    }
    if (!target || target.id == null) {
      const names = list.slice(0, 12).map((it, i) => `${i + 1}.${it.name_mi18n || it.full_name_mi18n}`).join('  ')
      return e.reply(`没找到「${arg}」。可用序号或名字，例如：\n米游社南宫羽伤害3\n米游社3伤害\n部分角色：${names}`)
    }

    const info = await this.fetchDetail(e, uid, ck, target.id)
    if (info?.__error) return e.reply(info.__error)
    const avatar = this.pickInfo(info?.data)
    if (!avatar) return e.reply('取到详情响应，但没识别到角色数据')

    const detail = normalizeDetail(avatar, uid)
    const charData = detail.charData
    // normalizeDetail 返回 { uid, charData }，damage 挂在 charData 上，不在顶层
    const damage = charData.damage
    if (!damage?.ok) {
      return e.reply(`「${charData.full_name_mi18n || arg}」暂无伤害计算：${damage?.error || '未知原因'}`)
    }

    const skills = damage.skills
    let idx = m[2] ? parseInt(m[2], 10) - 1 : 0
    if (!(idx >= 0) || idx >= skills.length) {
      return e.reply([
        `序号超出范围，当前共 ${skills.length} 招。`,
        `可用序号：${skills.map((_, i) => i + 1).join('、')}`,
        `例如：米游社${charData.full_name_mi18n || arg}伤害${skills.length}`,
      ])
    }
    const cur = skills[idx]
    const footer = 'from 米哈游'
    try {
      return await render('zzz_panel/damage', {
        ...detail,
        skills,
        cur,
        curIndex: idx,
        uid,
        command: `米游社${charData.full_name_mi18n || arg}伤害${idx + 1}`,
        footer,
        bgImage: getPanelBg(),
      }, { e, ret: true })
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 伤害详情渲染失败：${err?.message || err}`)
      return e.reply(`「${cur.name}」详细计算渲染失败：${err?.message || err}`)
    }
  }

  /** 取单角色详情接口 avatar/info，原样返回 data（契约同 fetchRaw） */
  async fetchDetail(e, uid, ck, id) {
    try {
      const apiMod = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'mysapi.js'))
      const MysZZZApi = apiMod.default
      const api = new MysZZZApi(uid, ck, { handler: e?.runtime?.handler || {}, e })

      const fpFile = `./plugins/HoYoGet-Plugin/data/fp/${e.user_id}.yaml`
      let deviceFp
      if (fs.existsSync(fpFile)) {
        // fp 文件是 YAML（system/mhy.js 用 YAML.stringify 写盘），不能当 JSON 解析
        const fp = yaml.get(fpFile) || {}
        if (fp.fp) { api.device_fp = fp.fp; deviceFp = fp.fp }
        if (fp.device_id) { api._device = fp.device_id }
      } else {
        const hit = Object.values(ck).find(i => i?.ck && String(i.uid) === String(uid))
        if (hit?.ltuid) deviceFp = await redis.get(`ZZZ:DEVICE_FP:${hit.ltuid}:FP`)
      }

      const data = await api.getFinalData('zzzAvatarInfo', { deviceFp, query: { id_list: [id] } })
      if (data === null || data === undefined) {
        return { __error: '单角色详情返回 null。过码链已由插件内部触发，若仍失败请先发【#过码】等验证完成再试。' }
      }
      return { data }
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 详情取数失败：${err?.message || err}`)
      return { __error: `详情取数失败：${err?.message || err}` }
    }
  }

  /** 从详情响应里取首角色对象，兼容多种包裹结构 */
  pickInfo(data) {
    if (!data || typeof data !== 'object') return null
    if (Array.isArray(data.avatar_list) && data.avatar_list[0]) return data.avatar_list[0]
    if (Array.isArray(data.list) && data.list[0]) return data.list[0]
    if (Array.isArray(data)) return data[0]
    return null
  }

  /** 取 ck：复用 ZZZ-Plugin 的 getCk，它自行处理 stoken 前缀与 User 实例 */
  async getCk(e) {
    try {
      const { getCk } = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'common.js'))
      return await getCk(e)
    } catch (err) {
      logger.warn?.(`[HoYoGet][zzz_panel] 读取 ck 失败：${err?.message || err}`)
      return false
    }
  }

  /**
   * 判分区：ZZZ-Plugin 用的是 uid 尾号之外的信息，这里不照抄它的判定，
   * 只按「绑定信息里带不含渠道服标记」这一条最直接的依据取。
   * 还没用真实数据验证过 —— 若拿不到，见下方 TODO 注释里的兜底。
   */
  async pickServer(uid, ck) {
    const hit = Object.values(ck || {}).find(item => item?.ck && String(item.uid) === String(uid))
    if (hit?.server) return hit.server
    // TODO: 还没确认绑定信息里是否带 server 字段。若不带，再按 uid 所属渠道判断，
    // 或直接让用户在 config 里配。**不要**凭猜测写死。
    return 'prod_gf_cn'
  }

  /**
   * 打一次角色列表接口，原样返回 data 部分，不做归一化。
   *
   * 契约（ZZZ-Plugin/dist/lib/mysapi.js getFinalData，勿凭印象改）：
   *   1. 内部已调用 checkCode()，命中 1034/10035/10041 时会走 mys.req.err 过码链；
   *   2. 成功返回 **res.data**，不是整个响应 —— 拿不到 res.retcode；
   *   3. 失败（含过码未通过）返回 **null**。
   * 第一版把返回值当整个响应去读 res.retcode，于是永远拿到 undefined，
   * 误报「接口返回 retcode=undefined」。
   */
  async fetchRaw(e, uid, server, ck) {
    try {
      const apiMod = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'mysapi.js'))
      const MysZZZApi = apiMod.default
      const hit = Object.values(ck).find(i => i?.ck && String(i.uid) === String(uid))
      const ltuid = hit?.ltuid
      const api = new MysZZZApi(uid, ck, { handler: e?.runtime?.handler || {}, e })

      // 设备指纹：优先用 xhh 自己存的常用设备，能显著降低风控概率
      const fpFile = `./plugins/HoYoGet-Plugin/data/fp/${e.user_id}.yaml`
      let appliedFp = false
      let deviceFp
      if (fs.existsSync(fpFile)) {
        // fp 文件是 YAML（system/mhy.js 用 YAML.stringify 写盘），不能当 JSON 解析
        const fp = yaml.get(fpFile) || {}
        if (fp.fp) { api.device_fp = fp.fp; deviceFp = fp.fp; appliedFp = true }
        if (fp.device_id) { api._device = fp.device_id; appliedFp = true }
      } else if (ltuid) {
        const cached = await redis.get(`ZZZ:DEVICE_FP:${ltuid}:FP`)
        if (cached) { api.device_fp = cached; deviceFp = cached; appliedFp = true }
      }

      // getFinalData 只从入参 data.deviceFp 读指纹，设置 api.device_fp 不会生效
      const data = await api.getFinalData('zzzAvatarList', { deviceFp })
      if (data === null || data === undefined) {
        return { __error: '接口未返回数据。过码链已由插件内部触发，若仍失败请先发【#过码】等验证完成再试。' }
      }
      return { retcode: 0, data, __fp: appliedFp }
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 取数失败：${err?.message || err}`)
      return { __error: `取数失败：${err?.message || err}` }
    }
  }

  /** 只做「哪个数组像是角色列表」的定位，不做字段含义判断 */
  pickList(data) {
    if (Array.isArray(data)) return data
    if (!data || typeof data !== 'object') return null
    for (const key of [ 'list', 'avatars', 'avatar_list' ]) {
      if (Array.isArray(data[key])) return data[key]
    }
    // 兜底：找出第一个元素是对象的数组
    for (const val of Object.values(data)) {
      if (Array.isArray(val) && val.length && typeof val[0] === 'object') return val
    }
    return null
  }
}
