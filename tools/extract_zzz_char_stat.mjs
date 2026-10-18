/**
 * 采集绝区零角色的「Lv60 满级基础属性」→ system/default/zzz_char_stat.json
 *
 * ## 为什么需要这张表
 *
 * 极限面板要完全独立（不依赖「用户是否抽到该角色」的落盘记录），就得能凭空
 * 造出一个满级角色的面板。而面板属性、生命/攻击/防御这些基础值，历来是
 * 米游社 avatar/info 接口直接给的 —— 本地没有任何一张「Lv60 基础属性表」。
 *
 * ## 为什么是采集而不是算
 *
 * 试过复刻官方成长公式（Main + Growth × f(等级)），用 54 个角色的真实值回归：
 *   - 生命值 f ≈ 8.428e-3，54 个角色**完全一致** → 能算
 *   - 防御力 f ≈ 8.420e-3，同样一致 → 能算
 *   - **攻击力 f 在 1.0e-2 ~ 2.25e-2 之间离散**，且与职司、突破阶段、影数都不相关
 *     （按职司分组后每组内部照样横跨 1.7~2.25e-2）→ 算不出来
 * 所以攻击力这类只能取真实值。**事实优于推导**：采集的是接口原始数据，
 * 没有任何猜测成分。
 *
 * ## 数据来源
 *
 * ① 角色基础常量（Main/Growth/元素/职业/稀有度/sprite_id）← ZZZ-Plugin
 *    resources/map/PartnerId2Data.json（只读事实表）
 * ② 各角色的 Lv60 基础属性真实值 ← 本地已落盘的面板记录
 *    （本插件 data/zzz_panel/records + ZZZ-Plugin data/panel）
 *
 * 只取数值，**不写入 UID/QQ/Cookie**，输出可安全入库。
 *
 * 用法：node tools/extract_zzz_char_stat.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'system', 'default', 'zzz_char_stat.json')
const YUNZAI = path.resolve(ROOT, '..', '..')

const ZZZ = [
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(ROOT, '..', 'ZZZ-Plugin'),
].find(p => fs.existsSync(path.join(p, 'resources', 'map', 'PartnerId2Data.json')))
if (!ZZZ) {
  console.error('找不到 ZZZ-Plugin 的 resources/map/PartnerId2Data.json')
  process.exit(1)
}

const partners = JSON.parse(fs.readFileSync(path.join(ZZZ, 'resources/map/PartnerId2Data.json'), 'utf8'))

// 基础属性 → 接口 property_id（ZPROP 的 k 与其对应）
const PID = { hpmax: 1, attack: 2, def: 3, breakstun: 4, crit: 5, critdam: 6, elementabnormalpower: 7, elementmystery: 8, penratio: 9, sprecover: 11 }
// 这几项在接口里 base/add 是空字符串、只有 final，而 final 含驱动盘与音擎贡献，
// **不能拿 final 当基础值**。它们另有出处：
//   冲击/异常掌控/异常精通 → 角色表里的定值（不随等级成长）
//   暴击率 20% = 初始 5% + 六次突破（面板代码里的既有口径）
//   暴击伤害 50% = 初始值
//   穿透率 → 不给基础值，绝区零里它只来自驱动盘与音擎
const FROM_CHAR_TABLE = { 4: 'BreakStun', 7: 'ElementAbnormalPower', 8: 'ElementMystery' }
const UNIVERSAL_BASE = { 5: 20, 6: 50, 9: 0 }

const num = v => {
  const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : 0
}

// ── 扫描所有可用面板记录，收集每个角色 Lv60 的真实基础值 ──────────────────
const found = new Map()
const collect = a => {
  if (!a || Number(a.level) !== 60) return
  const name = a.name_mi18n
  if (!name || found.has(name)) return
  const props = {}
  for (const p of a.properties || []) {
    const id = Number(p.property_id)
    const key = Object.keys(PID).find(k => PID[k] === id)
    if (key && props[key] === undefined) props[key] = num(p.base)
  }
  // 至少要有生命与攻击，否则这份记录不可用
  if (!(props.hpmax > 0 && props.attack > 0)) return
  found.set(name, { props })
}

const dirs = [
  path.join(ROOT, 'data', 'zzz_panel', 'records'),
  path.join(YUNZAI, 'plugins', 'ZZZ-Plugin', 'data', 'panel'),
]
for (const dir of dirs) {
  if (!fs.existsSync(dir)) continue
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      if (Array.isArray(d)) d.forEach(collect)
      else {
        // 本插件记录：{ uid, data: <单个角色> }
        if (d?.data && d.data.level) collect(d.data)
        // ZZZ-Plugin 记录：对象数组
        for (const v of Object.values(d)) if (v && typeof v === 'object') collect(v)
      }
    } catch { /* 跳过坏文件 */ }
  }
}

// ── 组装 ──────────────────────────────────────────────────────────────────
const chars = {}
const missing = []
for (const id of Object.keys(partners)) {
  const c = partners[id]
  if (!c?.name || !c?.Rarity) continue          // 无稀有度的是 NPC（哲/铃），不是代理人
  const hit = found.get(c.name)
  if (!hit) { missing.push(c.name); continue }
  const props = {}
  // ① 生命/攻击/防御：接口 base 就是纯等级基础值，直接采
  for (const [pid, key] of [[1, 'hpmax'], [2, 'attack'], [3, 'def']]) {
    props[pid] = hit.props[key] > 0 ? hit.props[key] : null
  }
  // ② 定值属性：取角色表（不随等级成长）
  for (const [pid, field] of Object.entries(FROM_CHAR_TABLE)) props[pid] = Number(c[field]) || 0
  // ③ 通用常量：暴击率 20%（初始 5% + 六次突破）、暴伤 50%、穿透率 0
  for (const [pid, v] of Object.entries(UNIVERSAL_BASE)) if (v !== null) props[pid] = v
  // ④ 回能：角色表 SpRecover 是整数（120），面板上是 1.20
  props[11] = Math.round(Number(c.SpRecover) || 0) / 100
  for (const pid of Object.keys(props)) {
    if (typeof props[pid] === 'number') props[pid] = Math.round(props[pid] * 100) / 100
  }
  chars[c.name] = {
    id: Number(id),
    fullName: c.full_name || c.name,
    enName: c.en_name || '',
    rarity: c.Rarity,
    elementType: Number(c.ElementType),
    profession: Number(c.WeaponType),
    camp: c.Camp || '',
    // 本地立绘文件名（ZZZ-Plugin resources/images/role/IconRole<NN>.png）
    // sprite_id 取自角色表 —— avatar/info 不返回这个字段，记录里也没有
    sprite: c.sprite_id != null ? `IconRole${String(c.sprite_id).padStart(2, '0')}` : '',
    // Lv60 满级基础属性，键是接口 property_id
    props,
  }
}

const payload = {
  _comment: '绝区零角色 Lv60 满级基础属性（真实采集值，非公式推导）。为让极限面板脱离面板记录独立出图而存在。攻击等属性无法用成长公式还原（回归 54 个角色后攻击力系数离散且与职司/突破/影数不相关），故取接口原值。重生成：node tools/extract_zzz_char_stat.mjs',
  _source: 'Main/Growth/元素/职业 ← ZZZ-Plugin resources/map/PartnerId2Data.json；Lv60 基础属性 ← 本地已落盘面板记录（仅取数值，不含 UID/QQ/Cookie）',
  count: Object.keys(chars).length,
  chars,
}
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf-8')
console.log(`写入 ${OUT}：${payload.count} 个角色，${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`)
if (missing.length) console.log(`缺基础属性的角色（${missing.length}）：${missing.join(' ')}`)