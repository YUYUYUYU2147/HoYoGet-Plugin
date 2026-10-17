/**
 * 绝区零增益（音擎 / 套装 / 核心被动 / 额外能力 / 影画）→ 伤害乘区。
 *
 * 与 zzz_skill_rate.js 同一原则：**只读本地静态表，零网络请求**。
 * 表由 tools/extract_zzz_buff.mjs 从公开数值表提取（见 system/default/zzz_buff.json
 * 头部说明），本文件只负责「查表 + 按条件过滤 + 求和」，不包含任何外部计算引擎。
 *
 * 乘区口径与 apps/zzz_panel_list.js 的 calcDamageAreas 对齐：
 *   暴击区 = 1 + (面板暴击率 + 增益暴击率) × (面板暴伤 + 增益暴伤)
 *   增伤区 = 1 + Σ 元素匹配的「增伤」
 *   易伤区 = 1 + Σ 元素匹配的「易伤」
 *   防御区 = 基础防御 / (基础防御 × (1 - 穿透率 - 增益穿透率) - 穿透值 - 增益穿透值)
 *
 * 未建模（面板不显示、避免给出「看着很准其实偏了」的数字）：
 *   技能自身的倍率类增益（如「对XX目标增伤50%」）、需要敌人状态触发的增益、
 *   value 为函数的增益（静态不可知）、失衡易伤、异常专属乘区。
 *   这些在返回值 notes 里说明，由面板显示。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_buff.json')

let TABLE = null
function loadTable() {
  if (TABLE) return TABLE
  try {
    TABLE = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    TABLE = null
  }
  return TABLE
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** 套装基名归一：运行时的「基名+件数」（如 极地重金属2）与表里的基名（极地重金属）对上 */
const setBase = name => String(name || '').replace(/\d+$/, '')

/** 角色名归一：接口给「席德」，表键是「「席德」」，直接按原串查会漏 */
const cleanName = name => String(name || '').replace(/[\s「」·・\-]/g, '')

/**
 * 生效范围匹配。
 * 源表用**技能代号前缀**表示生效招式（如 'CCXX' 表示蓄力攻击第四段、'A' 表示强化普攻类），
 * 所以判定方式是「技能代号是否以某个 range 码开头」。range 里含 '' 表示不限招式。
 */
function inRange(buff, key) {
  if (!buff.range || !buff.range.length) return true
  const k = String(key || '').toUpperCase()
  return buff.range.some(r => {
    const c = String(r || '').toUpperCase()
    return c === '' || (!!c && k.startsWith(c))
  })
}

/** 元素匹配：带 element 的增益只对同属性角色生效 */
function elementOk(buff, element) {
  if (!buff.element) return true
  if (!element) return false
  return String(buff.element).toLowerCase() === String(element).toLowerCase()
}

/**
 * 影画（几影解锁）过滤：表里 name 形如 '1影'/'6影'，持有影数达标才计入。
 * rank 未知（接口没给）时一律不计入，避免把没抽到的影画算进去。
 */
function rankOk(buff, rank) {
  if (buff.src !== '影画') return true
  const m = /^\s*(\d+)\s*影/.exec(buff.name || '')
  if (!m) return true
  if (!Number.isFinite(Number(rank))) return false
  return Number(rank) >= Number(m[1])
}

/**
 * 取增益数值。
 *   number  固定值
 *   array   音擎精炼档位（index 0 = 精炼 1）；角色核心被动的数组则是核心技等级档位
 *   {dyn}   随技能等级变化的档位，取 chars[角色].levels[类别][等级-1]
 */
function valueOf(buff, ctx) {
  const v = buff.value
  if (typeof v === 'number') return v
  if (Array.isArray(v)) {
    // 音擎数组是精炼 1~5；角色核心被动数组是核心技 1~7 级，不能拿精炼去索引
    const lv = buff.src === '音擎'
      ? (Number(ctx.refine) || 1)
      : (Number(ctx.dynLevel) || 1)
    const idx = Math.min(v.length, Math.max(1, lv))
    return num(v[idx - 1])
  }
  if (v && typeof v === 'object' && v.dyn) {
    const levels = ctx.charBuffLevels?.[v.dyn]
    if (!Array.isArray(levels)) return 0
    const lv = Math.min(levels.length, Math.max(1, Number(ctx.dynLevel) || 1))
    return num(levels[lv - 1])
  }
  return 0
}

/**
 * @param {object} ctx
 * @param {string} ctx.charName   角色简称（对应表里 chars 的键）
 * @param {string} [ctx.charFull] 角色全称，简称查不到时兜底
 * @param {string} [ctx.element]   角色属性英文名（'Ice'/'Fire'…），增益表里的 element 用这个写法
 * @param {string} [ctx.weapon]    音擎名（对应 weapons 的键）
 * @param {number} [ctx.refine]    音擎精炼 1~5
 * @param {string[]} [ctx.suits]   已装备的套装名（可重复，同套装多件只算件数）
 * @param {number} [ctx.rank]      影画数（0 = 无），接口没给就传 undefined
 * @param {string} [ctx.key]       当前技能代号（如 'AQ3'/'CCXX'/'RZ'），用于 range 过滤
 * @param {number} [ctx.dynLevel]  dyn 档位对应的技能等级
 * @returns {{boost:number, vulnerability:number, critRateAdd:number, critdmgAdd:number,
 *            penRatioAdd:number, penValueAdd:number, resIgnoreAdd:number, defIgnoreAdd:number,
 *            applied:object[], missing:string[]}}
 */
export function getBuffAreas(ctx = {}) {
  const zero = {
    boost: 1, vulnerability: 1, critRateAdd: 0, critdmgAdd: 0,
    penRatioAdd: 0, penValueAdd: 0, resIgnoreAdd: 0, defIgnoreAdd: 0,
    applied: [], missing: [],
  }
  const table = loadTable()
  if (!table) return { ...zero, missing: ['增益数据文件缺失（system/default/zzz_buff.json）'] }

  const chars = table.chars || {}
  const target = cleanName(ctx.charName || ctx.charFull)
  const char = chars[ctx.charName]
    || (ctx.charFull && chars[ctx.charFull])
    || Object.entries(chars).find(([k]) => cleanName(k) === target)?.[1]
    || Object.entries(chars).find(([k]) => target && (cleanName(k).includes(target) || target.includes(cleanName(k))))?.[1]
  if (!char) {
    return { ...zero, missing: [`该角色（${ctx.charName || '未知'}）未收录增益数据`] }
  }

  const full = { ...ctx, charBuffLevels: char.levels || {} }
  const candidates = []

  // 1) 额外能力：默认拥有，不需条件
  for (const b of char.illum || []) candidates.push({ ...b, src: '额外能力', name: b.name || '额外能力' })

  // 2) 音擎：按精炼档位取值
  let w = null
  if (ctx.weapon) {
    w = table.weapons?.[ctx.weapon] || null
    if (!w) {
      const want = cleanName(ctx.weapon)
      const wk = Object.keys(table.weapons || {}).find(k => cleanName(k) === want || cleanName(k).includes(want))
      if (wk) w = table.weapons[wk]
    }
    if (!w) zero.missing.push(`音擎「${ctx.weapon}」未收录增益数据`)
  }
  for (const b of w || []) candidates.push({ ...b, src: '音擎', name: b.name || ctx.weapon })

  // 3) 套装：同名套装多件才算件数，2件/4件分别解锁
  const count = {}
  for (const s of ctx.suits || []) {
    const b = setBase(s)
    if (b) count[b] = (count[b] || 0) + 1
  }
  for (const [base, n] of Object.entries(count)) {
    let list = table.sets?.[base]
    if (!list) {
      const want = cleanName(base)
      const sk = Object.keys(table.sets || {}).find(k => cleanName(k) === want)
      if (sk) list = table.sets[sk]
    }
    if (!list) { zero.missing.push(`套装「${base}」未收录增益数据`); continue }
    for (const b of list) {
      if (typeof b.check === 'number' && n < b.check) continue
      candidates.push({ ...b, src: '套装', name: `${base}${b.check ?? ''}` })
    }
  }

  // 4) 核心被动
  for (const b of char.core || []) candidates.push({ ...b, src: '核心被动' })

  // 5) 影画：按持有影数过滤（rank 未知时全部不计）
  for (const b of char.mindscape || []) candidates.push({ ...b, src: '影画' })

  const out = { ...zero }
  for (const b of candidates) {
    if (!rankOk(b, ctx.rank)) continue
    if (!inRange(b, ctx.key)) continue
    if (!elementOk(b, ctx.element)) continue
    const v = valueOf(b, full)
    if (!v) continue
    const item = { name: b.name || `${b.src}${b.type}`, src: b.src, type: b.type, value: v }
    let used = true
    switch (b.type) {
      case '增伤': out.boost += v; break
      case '易伤': out.vulnerability += v; break
      case '暴击率': out.critRateAdd += v; break
      case '暴击伤害': out.critdmgAdd += v; break
      case '穿透率': out.penRatioAdd += v; break
      case '穿透值': out.penValueAdd += v; break
      case '无视抗性': out.resIgnoreAdd += v; break
      case '无视防御': out.defIgnoreAdd += v; break
      // 其余增益类型（攻击力/异常增伤/失衡易伤/倍率等）不进伤害乘区，
      // 不要放进 applied —— 面板会把它显示成「已计入」，实际没算。
      default: used = false; break
    }
    if (used) out.applied.push(item)
  }
  out.missing = [...new Set(out.missing)]
  return out
}