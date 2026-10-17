/**
 * 从现有面板记录生成绝区零极限面板预设。
 *
 * 只输出角色 ID、推荐音擎 ID、4~6 号位主词条，不包含任何 UID/QQ/Cookie。
 * 数据来源：ZZZ-Plugin 的 data/panel 与 HoYoGet 的 data/zzz_panel/records。
 * 没有记录的角色不会写入预设，运行时仍走自动兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ZZZ_ROOT = path.join(ROOT, '..', 'ZZZ-Plugin')
const OUT = path.join(ROOT, 'system', 'default', 'zzz_extreme.yaml')
const PARTNER = path.join(ZZZ_ROOT, 'resources', 'map', 'PartnerId2Data.json')

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()
const partners = readJson(PARTNER) || {}
const byId = new Map()
for (const [id, info] of Object.entries(partners)) {
  byId.set(Number(id), { id: Number(id), name: info?.name || info?.full_name || String(id), full: info?.full_name || '' })
}

const records = []
const addAvatar = (a, source) => {
  if (!a || !a.id || !Array.isArray(a.equip)) return
  records.push({ a, source })
}
try {
  for (const f of fs.readdirSync(path.join(ROOT, 'data', 'zzz_panel', 'records')).filter(f => f.endsWith('.json'))) {
    const obj = readJson(path.join(ROOT, 'data', 'zzz_panel', 'records', f))
    addAvatar(obj?.data || obj, 'local')
  }
} catch { /* 本地还没有记录 */ }
try {
  for (const f of fs.readdirSync(path.join(ZZZ_ROOT, 'data', 'panel')).filter(f => f.endsWith('.json'))) {
    const list = readJson(path.join(ZZZ_ROOT, 'data', 'panel', f))
    if (Array.isArray(list)) for (const a of list) addAvatar(a, 'zzz')
  }
} catch { /* 没装 ZZZ-Plugin 就只用本地 */ }

const rank = a => {
  const eq = a.equip || []
  const s15 = eq.filter(e => e?.rarity === 'S' && Number(e?.level) === 15).length
  const mainOk = eq.filter(e => e?.main_properties?.[0]?.property_id).length
  return Number(a.rank || 0) * 10000 + Number(a.level || 0) * 100 + Number(a.weapon?.star || 0) * 10 + s15 * 3 + mainOk
}
const best = new Map()
for (const { a } of records) {
  const id = Number(a.id)
  if (!byId.has(id)) continue
  const prev = best.get(id)
  if (!prev || rank(a) > rank(prev)) best.set(id, a)
}

const ELEM_MAIN = { 200: 31503, 201: 31603, 202: 31703, 203: 31803, 204: 32303, 205: 31903 }
// 按职业给 4/6 号位主词条；5 号位优先属性伤害，取不到再退回攻击力
const PROF_MAIN = {
  1: { 4: 21103, 6: 12102 }, // 强攻
  2: { 4: 21103, 6: 12202 }, // 击破
  3: { 4: 31203, 6: 31402 }, // 异常
  4: { 4: 21103, 6: 30502 }, // 支援
  5: { 4: 21103, 6: 13102 }, // 防护
  6: { 4: 21103, 6: 11102 }, // 命破
  7: { 4: 21103, 6: 13102 }, // 锋御
}
const presets = {}
for (const [id, a] of [...best.entries()].sort((x, y) => byId.get(x[0]).name.localeCompare(byId.get(y[0]).name, 'zh'))) {
  const info = byId.get(id)
  const prof = Number(a.avatar_profession || 1)
  const main = {
    4: PROF_MAIN[prof]?.[4] || 21103,
    5: ELEM_MAIN[Number(a.element_type)] || 12102,
    6: PROF_MAIN[prof]?.[6] || 12102,
  }
  presets[info.name] = {
    char_id: id,
    weapon_id: Number(a.weapon?.id || 0) || undefined,
    drive_main: main,
  }
}

const header = `# 绝区零极限面板预设（自动生成，可手工修正）\n# 只含角色 ID、推荐音擎 ID、4~6 号位主词条，不含 UID/QQ/Cookie。\n# 生成命令：node tools/gen_zzz_extreme_presets.mjs\n`
fs.writeFileSync(OUT, header + YAML.stringify(presets), 'utf8')
console.log(`写入 ${OUT}：${Object.keys(presets).length} 个角色`)
const missing = [...byId.values()].filter(v => !presets[v.name]).map(v => v.name)
if (missing.length) console.log('无面板记录，未生成预设：', missing.join('、'))
