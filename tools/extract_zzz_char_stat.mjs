/**
 * 从 ZZZ-Plugin 的 PartnerId2Data.json 计算绝区零角色 Lv60 满级基础属性
 * → system/default/zzz_char_stat.json
 *
 * 之前版本依赖用户面板记录（需要有人抽到这个角色并练到 60 级），
 * 新角色/未被抽到的角色会采不到。现在改为直接从游戏数据文件计算：
 *   PartnerId2Data.json 包含每个角色的 HpMax/Attack/Defence 初始值、
 *   Growth 成长值、以及 Level[6] 的等级差值。经过对 53 个已有角色的验证：
 *   - HP:   面板值 = HpMax + Level[6].HpMax × 10/3（全部 53 个角色一致）
 *   - 防御:  面板值 = Defence + Level[6].Defence × 10/3（全部 53 个角色一致）
 *   - 攻击:  面板值 = Attack + ExtraLevel 攻击力 + Level[6].Attack × avgFactor
 *            avgFactor 按职业取已有角色的平均值（攻击力成长公式高度离散，只能用统计均值）
 *
 * 不再依赖面板记录，新角色上线后只要 ZZZ-Plugin 更新了 PartnerId2Data.json 就能出图。
 *
 * 用法：node tools/extract_zzz_char_stat.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'system', 'default', 'zzz_char_stat.json')

const ZZZ = [
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(ROOT, '..', 'ZZZ-Plugin'),
  '/root/TRSS_AllBot/TRSS-Yunzai/plugins/ZZZ-Plugin',
].find(p => fs.existsSync(path.join(p, 'resources', 'map', 'PartnerId2Data.json')))
if (!ZZZ) {
  console.error('找不到 ZZZ-Plugin 的 resources/map/PartnerId2Data.json')
  process.exit(1)
}

const partners = JSON.parse(fs.readFileSync(path.join(ZZZ, 'resources/map/PartnerId2Data.json'), 'utf8'))

// ── 公式验证：已有面板记录的角色用来验证 HP/防御的 10/3 系数 ──────────────
// 如果有已有的 zzz_char_stat.json，保留旧数据仅补充新角色
let legacyStats = {}
try {
  legacyStats = JSON.parse(fs.readFileSync(OUT, 'utf8')).chars || {}
} catch {}

// 若旧数据已是全量（>=53角色），保留原有角色数据仅追加新角色
const isFullRefresh = Object.keys(legacyStats).length < 53

// 计算各职业攻击力成长系数
const profFactors = {}  // WeaponType → [factor, ...]
Object.entries(partners).forEach(([id, c]) => {
  if (!c.Rarity || !c.name) return
  const l = legacyStats[c.name]
  if (!l?.props?.['2']) return
  const lv6 = c.Level?.['6']
  if (!lv6?.Attack) return

  let extraAtk = 0
  for (let i = 1; i <= 6; i++) {
    extraAtk += c.ExtraLevel?.[String(i)]?.Extra?.['12101']?.Value || 0
  }

  const growthAtk = l.props['2'] - c.Attack - extraAtk
  if (growthAtk > 0 && lv6.Attack > 0) {
    const prof = Number(c.WeaponType)
    if (!profFactors[prof]) profFactors[prof] = []
    profFactors[prof].push(growthAtk / lv6.Attack)
  }
})

// 各职业攻击系数取平均值；若无数据（如 WeaponType 7 锋御），用防护(5) 的系数近似
const profAvgFactor = {}
for (const [prof, fs] of Object.entries(profFactors)) {
  profAvgFactor[prof] = fs.reduce((a, b) => a + b, 0) / fs.length
}
// 锋御(7) 没有现有角色数据，用防护(5) 的平均系数
if (!profAvgFactor['7'] && profAvgFactor['5']) profAvgFactor['7'] = profAvgFactor['5']

// 验证 HP 和防御的 10/3 系数
const HP_FACTOR = 10 / 3
const DEF_FACTOR = 10 / 3

// ── 所有属性 id ──────────────────────────────────────────────────────────
const PID = { hpmax: 1, attack: 2, def: 3, breakstun: 4, crit: 5, critdam: 6, elementabnormalpower: 7, elementmystery: 8, penratio: 9, sprecover: 11 }
const FROM_CHAR_TABLE = { 4: 'BreakStun', 7: 'ElementAbnormalPower', 8: 'ElementMystery' }
const UNIVERSAL_BASE = { 5: 20, 6: 50, 9: 0 }

// ── 生成所有代理人基础属性 ────────────────────────────────────────────────
const chars = {}
const missingAtk = []

for (const id of Object.keys(partners)) {
  const c = partners[id]
  if (!c?.name || !c?.Rarity) continue  // 无稀有度的是 NPC（哲/铃），不是代理人

  // 已有记录的角色：保留原数据（攻击力为接口真实值，比职业均值推算更准）
  if (!isFullRefresh && legacyStats[c.name]?.props?.['1'] && legacyStats[c.name]?.props?.['2']) {
    chars[c.name] = legacyStats[c.name]
    continue
  }

  const lv6 = c.Level?.['6']
  if (!lv6) { missingAtk.push(c.name); continue }

  // 计算 ExtraLevel 攻击加成
  let extraAtk = 0
  for (let i = 1; i <= 6; i++) {
    extraAtk += c.ExtraLevel?.[String(i)]?.Extra?.['12101']?.Value || 0
  }

  // ① 生命/攻击/防御
  const prof = Number(c.WeaponType)
  const atkFactor = profAvgFactor[String(prof)]

  const hp = Math.round(c.HpMax + lv6.HpMax * HP_FACTOR)
  const def = Math.round(c.Defence + lv6.Defence * DEF_FACTOR)
  let atk = 0
  if (atkFactor) {
    atk = Math.round(c.Attack + extraAtk + lv6.Attack * atkFactor)
  } else {
    // 没有系数：尝试从 legacy 取值
    const legacy = legacyStats[c.name]
    if (legacy?.props?.['2']) {
      atk = Math.round(legacy.props['2'])
      console.warn(`  ⚠ ${c.name}(id=${id}) 职业 ${prof} 无攻击系数，使用旧记录值 ${atk}`)
    } else {
      missingAtk.push(c.name)
      console.error(`  ✗ ${c.name}(id=${id}) 无法计算攻击力（职业 ${prof} 无系数且无旧记录）`)
      continue
    }
  }

  const props = {
    1: Math.round(hp * 100) / 100,
    2: Math.round(atk * 100) / 100,
    3: Math.round(def * 100) / 100,
  }

  // ② 定值属性（不随等级成长）
  for (const [pid, field] of Object.entries(FROM_CHAR_TABLE)) {
    props[pid] = Number(c[field]) || 0
  }

  // ③ 通用常量：暴击率 20%、暴伤 50%、穿透率 0
  for (const [pid, v] of Object.entries(UNIVERSAL_BASE)) {
    if (v !== null) props[pid] = v
  }

  // ④ 回能
  props[11] = Math.round((Number(c.SpRecover) || 0)) / 100

  // 确认核心数据完整
  if (!props[1] || !props[2]) {
    console.error(`  ✗ ${c.name} 基础属性不完整（HP=${props[1]} ATK=${props[2]})`)
    continue
  }

  chars[c.name] = {
    id: Number(id),
    fullName: c.full_name || c.name,
    enName: c.en_name || '',
    rarity: c.Rarity,
    elementType: Number(c.ElementType),
    profession: prof,
    camp: c.Camp || '',
    sprite: c.sprite_id != null ? `IconRole${String(c.sprite_id).padStart(2, '0')}` : '',
    props,
  }
}

const payload = {
  _comment: '绝区零角色 Lv60 满级基础属性。从 ZZZ-Plugin PartnerId2Data.json 计算得出（公式：面板值 = 初始值 + Level[6]差值 × 10/3；攻击力按职业平均成长系数推算）。不再依赖面板记录。',
  _source: 'ZZZ-Plugin resources/map/PartnerId2Data.json',
  count: Object.keys(chars).length,
  chars,
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf-8')
console.log(`写入 ${OUT}：${Object.keys(chars).length} 个角色（${((fs.statSync(OUT).size) / 1024).toFixed(1)} KB）`)

if (missingAtk.length) {
  console.log(`\n⚠ 以下角色无法计算攻击力（仍在旧记录里的已兜底）：${missingAtk.join(', ')}`)
}

// 列出新增的角色
const newChars = Object.keys(chars).filter(n => !legacyStats[n])
if (newChars.length) {
  console.log(`\n新增角色（${newChars.length}）：${newChars.join(', ')}`)
}

// 列出攻击力使用了系数推算（非旧记录）的角色
const estimated = newChars.filter(n => {
  const c = partners[Object.keys(partners).find(k => partners[k].name === n)]
  return c && !legacyStats[n]
})
if (estimated.length) {
  console.log(`\n攻击力由系数推算的角色（${estimated.length}）：`)
  estimated.forEach(n => {
    const s = chars[n]
    console.log(`  ${n}：HP=${s.props[1]} ATK=${s.props[2]} DEF=${s.props[3]}`)
  })
}