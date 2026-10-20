// 绝区零面板属性「基础 / 加成」拆分
//
// 米游社 avatar/info 的 properties[] 只对生命/攻击/防御给了 base（角色自身+突破+音擎），
// 其它项（暴击率、穿透率、异常掌控…）只有 final，所以靠 nanoka 的角色静态数据反推：
//
//   基础 = 角色静态值（stats）+ 等级成长（*_growth）+ 突破（level[promo]）+ 音擎
//   加成 = 面板终值 − 基础（即驱动盘主/副词条 + 套装 + 影画等）
//
// 角色数据：<nanoka>/character/<id>.json
//   stats.crit = 500 → 5%（×100 存整数）
//   stats.hp_max/attack/defence = 1 级初始值，*_growth 为每级成长（÷10000）
//   level["6"].{hp_max,attack,defence} = 60 级突破加成
// 音擎主词条 / 副词条直接从面板数据里取（已经带百分比字符串）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* 插件根 / 仓库根：不依赖 process.cwd()（脚本里 cwd 可能是插件目录） */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')

/** 面板属性 id → nanoka 静态键 */
const STATIC_KEY = {
  4: { key: 'break_stun', scale: 1 },              // 冲击力
  5: { key: 'crit', scale: 100 },                  // 暴击率（×100）
  6: { key: 'crit_damage', scale: 100 },           // 暴击伤害
  7: { key: 'element_abnormal_power', scale: 1 },  // 异常掌控
  8: { key: 'element_mystery', scale: 1 },         // 异常精通
  9: { key: 'pen_rate', scale: 100 },              // 穿透率（×100）
  11: { key: 'sp_recover', scale: 100 },           // 能量自动回复
  232: { key: 'pen_delta', scale: 1 },             // 穿透值
}

/** 找 nanoka 角色数据目录（ZZZ-Plugin 优先，其次本插件） */
function characterDir() {
  const dirs = [
    // 本插件自带的副本优先（以后可以脱离 ZZZ-Plugin）
    path.join(PLUGIN_ROOT, 'resources', 'zzz_nanoka', 'character'),
    // 退回 ZZZ-Plugin 的数据
    path.join(REPO_ROOT, 'plugins', 'ZZZ-Plugin', 'resources', 'data', 'nanoka', 'character'),
    path.join(process.cwd(), 'plugins', 'ZZZ-Plugin', 'resources', 'data', 'nanoka', 'character'),
  ]
  for (const d of dirs) {
    try { if (fs.statSync(d).isDirectory()) return d } catch { /* 试下一个 */ }
  }
  return ''
}

const cache = new Map()

/** 取角色静态数据（按 id 缓存） */
function readCharacter(id) {
  const key = String(id || '')
  if (!key) return null
  if (cache.has(key)) return cache.get(key)
  let data = null
  const dir = characterDir()
  if (dir) {
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'))
    } catch { data = null }
  }
  cache.set(key, data)
  return data
}

/** 把 "30%" / "316" 解析成数字（百分比保留百分数） */
function num(v) {
  const n = parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** 角色静态值：静态 + 等级成长 + 突破 */
function charBase(char, level, promo) {
  const s = char?.stats || {}
  const p = char?.level?.[String(promo)] || {}
  const lv = Number(level) || 60
  return {
    hp: num(s.hp_max) + (lv - 1) * num(s.hp_growth) / 10000 + num(p.hp_max),
    attack: num(s.attack) + (lv - 1) * num(s.attack_growth) / 10000 + num(p.attack),
    defence: num(s.defence) + (lv - 1) * num(s.defence_growth) / 10000 + num(p.defence),
  }
}

/**
 * 计算某一项属性的「基础值」。
 *
 * @param {number} pid     米游社属性 id
 * @param {object} ctx     { char, level, promo, weapon, final }
 * @returns {number|null}  基础值；无法推导时返回 null
 */
export function baseOf(pid, ctx = {}) {
  const { level, promo, weapon, final } = ctx
  /* 允许直接传 charId（内部会读静态表），也允许传已读好的 char 对象 */
  const char = ctx.char || readCharacter(ctx.charId)
  if (!char) return null
  const cb = charBase(char, level, promo)

  // 生命/攻击/防御：接口已经给了 base，这里只在需要时作对照
  if (pid === 1) return cb.hp
  if (pid === 3) return cb.defence
  if (pid === 2) {
    /* 攻击力：角色自身 + 音擎基础攻击（音擎的「攻击力%」与驱动盘一起落在加成里） */
    const wMain = num((weapon?.main_properties || [])[0]?.base)
    return cb.attack + wMain
  }

  const spec = STATIC_KEY[pid]
  if (!spec) return null
  const raw = num(char.stats?.[spec.key])
  // 静态值按 scale 换算成面板单位（暴击率 500 → 5）
  let base = raw / spec.scale
  // 音擎副词条里同名的百分比/固定值也算基础
  for (const p of (weapon?.properties || [])) {
    if (nameOf(pid) && String(p?.property_name || '').includes(nameOf(pid))) base += num(p?.base)
  }
  // 基础不可能大于终值（数据源异常时兜底）
  if (Number.isFinite(final) && base > final) return null
  return base
}

const PROP_NAME = {
  1: '生命值', 2: '攻击力', 3: '防御力', 4: '冲击力', 5: '暴击率', 6: '暴击伤害',
  7: '异常掌控', 8: '异常精通', 9: '穿透率', 11: '能量自动回复', 232: '穿透值',
}
const nameOf = pid => PROP_NAME[pid] || ''

/**
 * 给面板属性行补上 base / add。
 *
 * @param {Array} rows   [{ pid, label, final, base, add }]
 * @param {object} ctx   { charId, level, promo, weapon }
 * @returns {Array} 原地补上 base/add（字符串，已格式化）
 */
export function fillBaseAdd(rows = [], ctx = {}) {
  const char = readCharacter(ctx.charId)
  if (!char) return rows
  for (const row of rows) {
    // 接口已经给了就不动
    if (row.base) continue
    const pid = Number(row.pid)
    const isPct = /%/.test(String(row.final))
    const finalN = num(row.final)
    const baseN = baseOf(pid, { char, level: ctx.level, promo: ctx.promo, weapon: ctx.weapon, final: finalN })
    if (baseN == null) continue
    row.base = fmt(baseN, isPct)
    // 模板里写的是 +{{r.add}}，这里不要重复加 +
    row.add = fmt(finalN - baseN, isPct)
  }
  return rows
}

/** 格式化：整数属性不带小数，百分比一位小数 */
function fmt(n, pct, signed = false) {
  const v = Number(n) || 0
  const text = pct ? `${v.toFixed(1)}%` : `${Math.round(v)}`
  return signed && v >= 0 ? `+${text}` : text
}
