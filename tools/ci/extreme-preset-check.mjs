/**
 * 校验极限面板预设（system/default/zzz_extreme.yaml）。
 *
 * 为什么要有这个：极限面板的「最优配装」是**人工策展**的知识，逐角色写在 YAML 里。
 * 人工数据最容易出的错是「漏一个角色」「主词条少一个号位」「副词条档数不是 9」，
 * 这些在运行时都不会报错，只会安静地给出一张少了两档词条的极限面板。
 *
 * 检查项：
 *   1. 角色表里的每个可用代理人都有预设（排除无稀有度/职业的 NPC）
 *   2. S 级角色的音擎必须是专武（CodeName 形如 Weapon_S_<char_id>）
 *   3. drive_main 必须有 4/5/6 三个号位，且是合法主词条 id
 *   4. sub_layout 的 other / main4 每盘合计必须为 9 档，且不含该盘主词条
 *   5. 预设里的角色名/id 与角色表一致
 *
 * 角色表与音擎表取自 ZZZ-Plugin 的 resources/map/（只读事实数据）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const PRESET_FILE = path.join(ROOT, 'system', 'default', 'zzz_extreme.yaml')

const ZZZ = [
  path.join(ROOT, 'resources', 'zzz', 'map'),
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(ROOT, '..', 'ZZZ-Plugin'),
  '/root/TRSS_AllBot/TRSS-Yunzai/plugins/ZZZ-Plugin',
].find(p => fs.existsSync(path.join(p, 'PartnerId2Data.json')))

if (!ZZZ) {
  console.error('找不到 resources/zzz/map，跳过极限面板预设检查')
  process.exit(0)
}

const partners = JSON.parse(fs.readFileSync(path.join(ZZZ, 'PartnerId2Data.json'), 'utf8'))
const weapons = JSON.parse(fs.readFileSync(path.join(ZZZ, 'WeaponId2Data.json'), 'utf8'))

// 专武：CodeName 形如 Weapon_S_<char_id>，属精确映射
const sigWeapon = new Map()
for (const wid of Object.keys(weapons)) {
  const m = /Weapon_S_(\d+)/.exec(weapons[wid].CodeName || '')
  if (m) sigWeapon.set(Number(m[1]), Number(wid))
}

// 可用代理人：有稀有度与职业的才算（哲/铃 这类 NPC 没有）
const agents = Object.keys(partners)
  .map(id => ({ id: Number(id), ...partners[id] }))
  .filter(c => c.Rarity && c.WeaponType)

// 合法主词条（与 apps/zzz_panel_list.js 的 MAIN_MAX_VALUE 同集合）
const MAIN_OK = new Set([11102, 12102, 13102, 12202, 20103, 21103, 23103, 30502, 31203, 31402,
  31503, 31603, 31703, 31803, 31903, 32303])
/**
 * 按号位区分的合法主词条（驱动盘的主词条池是分槽位的）：
 *   4 号：生命%/攻击%/防御%/暴击率/暴击伤害/异常精通
 *   5 号：生命%/攻击%/防御%/穿透率/各属性伤害加成
 *   6 号：生命%/攻击%/防御%/冲击力/能量自动回复/异常掌控
 * 只查全局 MAIN_OK 会放过「6 号盘写暴击伤害」这种游戏里出不来的配置。
 */
const MAIN_BY_SLOT = {
  // 1/2/3 号是唯一固定值：1 生命值、2 攻击力、3 防御力（不是百分比）
  1: new Set([11103]),
  2: new Set([12103]),
  3: new Set([13103]),
  4: new Set([11102, 12102, 13102, 20103, 21103, 31203]),
  5: new Set([11102, 12102, 13102, 23103, 31503, 31603, 31703, 31803, 32303, 31903]),
  6: new Set([11102, 12102, 12202, 13102, 30502, 31402]),
}
// 合法副词条（驱动盘上真的能出的）
const SUB_OK = new Set([11102, 11103, 12102, 12103, 13102, 13103, 20103, 21103, 23203, 31203, 31402])

const problems = []
const presetSrc = fs.readFileSync(PRESET_FILE, 'utf8')

// 极简 YAML 解析：只要顶层键与下面这几个字段的结构，不引第三方依赖
const presets = {}
{
  let cur = null
  for (const raw of presetSrc.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const top = /^([^\s#][^:]*):\s*$/.exec(line)
    if (top) { cur = top[1].trim(); presets[cur] = {}; continue }
    if (!cur) continue
    let m
    if ((m = /^\s{2}char_id:\s*(\d+)/.exec(line))) presets[cur].char_id = Number(m[1])
    else if ((m = /^\s{2}weapon_id:\s*(\d+)/.exec(line))) presets[cur].weapon_id = Number(m[1])
    else if ((m = /^\s{2}crit_sub:\s*([\d.]+)/.exec(line))) presets[cur].crit_sub = Number(m[1])
    else if (/^\s{2}drive_main:/.test(line)) {
      presets[cur].drive_main = {}
      for (const kv of line.matchAll(/"?(\d)"?:\s*(\d+)/g)) presets[cur].drive_main[Number(kv[1])] = Number(kv[2])
    } else if (/^\s{2}sub_layout:/.test(line)) presets[cur].sub_layout = {}
    else if ((m = /^\s{4}(other|main4):/.exec(line))) {
      const key = m[1]
      const list = []
      const tail = line.slice(m[0].length)
      // 同行写法：other: [[21103, 6], [12102, 1], ...]
      for (const it of tail.matchAll(/\[(\d+),\s*(\d+)\]/g)) list.push([Number(it[1]), Number(it[2])])
      // 竖排写法：
      //   other:
      //     - [21103, 6]
      presets[cur].sub_layout[key] = list
    } else if ((m = /^\s{6}-\s*\[(\d+),\s*(\d+)\]/.exec(line))) {
      const s = presets[cur].sub_layout || {}
      const keys = Object.keys(s)
      if (keys.length) s[keys[keys.length - 1]].push([Number(m[1]), Number(m[2])])
    }
  }
}

// 1) 每个可用代理人都有预设
const presetNames = new Set(Object.keys(presets))
for (const c of agents) {
  if (!presetNames.has(c.name)) problems.push(`缺少预设：${c.name}（id=${c.id}，${c.Rarity}）`)
}
// 2) 预设里没有多余角色 / id 对得上
for (const [name, p] of Object.entries(presets)) {
  const c = agents.find(x => x.name === name)
  if (!c) { problems.push(`预设里有未知角色：${name}（角色表里没有，或已被删除）`); continue }
  if (p.char_id !== c.id) problems.push(`${name}：char_id=${p.char_id} 与角色表的 ${c.id} 不一致`)
  // 3) S 级必须是专武
  if (c.Rarity === 'S') {
    const sw = sigWeapon.get(c.id)
    if (sw && p.weapon_id !== sw) {
      problems.push(`${name}：S 级应使用专武 ${sw}（${weapons[sw]?.Name || ''}），当前 ${p.weapon_id}`)
    }
  }
  if (!weapons[p.weapon_id]) problems.push(`${name}：音擎 id ${p.weapon_id} 在音擎表里不存在`)
  // 4) 主词条三个号位齐全且合法
  const dm = p.drive_main || {}
  for (const slot of [4, 5, 6]) {
    const v = dm[slot]
    if (!v) { problems.push(`${name}：drive_main 缺 ${slot} 号位主词条`); continue }
    if (!MAIN_OK.has(v)) problems.push(`${name}：${slot} 号位主词条 ${v} 不合法`)
    else if (!MAIN_BY_SLOT[slot]?.has(v)) problems.push(`${name}：${slot} 号位主词条 ${v} 不在该号位的可选池里`)
  }
  // 1/2/3 号位可以不写（自动取该号位的默认主词条），写了就必须合法
  for (const slot of [1, 2, 3]) {
    const v = dm[slot]
    if (v && !MAIN_BY_SLOT[slot]?.has(v)) problems.push(`${name}：${slot} 号位主词条 ${v} 不在该号位的可选池里`)
  }
  // 5) 副词条布局每盘 9 档，且不含该盘主词条
  const sl = p.sub_layout || {}
  if (!sl.other) problems.push(`${name}：sub_layout 缺 other`)
  for (const [key, mainSlot] of [['other', null], ['main4', 4]]) {
    const list = sl[key]
    if (!list || !list.length) continue
    const sum = list.reduce((a, [, n]) => a + n, 0)
    if (sum !== 9) problems.push(`${name}：sub_layout.${key} 合计 ${sum} 档，应为 9 档`)
    for (const [id, n] of list) {
      if (!SUB_OK.has(id)) problems.push(`${name}：sub_layout.${key} 的 ${id} 不是合法副词条`)
      if (n > 6) problems.push(`${name}：sub_layout.${key} 的 ${id} 给了 ${n} 档，单条上限 6 档`)
      if (mainSlot && id === dm[mainSlot]) problems.push(`${name}：sub_layout.${key} 含本盘主词条 ${id}（副词条不能与主词条重复）`)
    }
  }
}

console.log(`极限面板预设：${Object.keys(presets).length} 个角色 / 可用代理人 ${agents.length} 个`)
if (problems.length) {
  console.error(`\n极限面板预设检查未通过（${problems.length} 项）：`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log('极限面板预设检查通过：角色齐全、音擎为专武、主词条 4/5/6 完整、副词条每盘 9 档')