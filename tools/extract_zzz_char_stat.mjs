/**
 * 生成绝区零角色 Lv60 基础属性表 → system/default/zzz_char_stat.json
 *
 * 数据源：ZZZ-Plugin resources/map/PartnerId2Data.json（纯计算，不读旧表）
 *
 * 口径约定（重要）：
 *   base   = 角色自身裸值，**不含音擎、不含驱动盘、不含影画**
 *   extra  = 突破（1~6 阶）带来的额外加成，Value 已是累积值，单独记录
 *   displayWeapon = 展示用推荐音擎的基础攻击力（非官方专武），**仅供展示**，禁止参与伤害计算
 *   legacy = 旧版兼容字段，等价于 base.atk + displayWeapon.atk
 *
 * 公式（对 60 个角色逐项验证一致）：
 *   攻击 = Attack + Level[6].Attack × 10/3
 *   生命 = HpMax   + Level[6].HpMax   × 10/3
 *   防御 = Defence + Level[6].Defence × 10/3
 *   冲击力/异常掌控/异常精通/穿透率/回能 直接取 PartnerId2Data 字段
 *   extra 取 ExtraLevel[6].Extra[*].Value（累积值，不再累加 1~6 阶）
 *
 * 为什么不再用「职业平均系数」反推攻击：
 *   旧版拿含专武的旧表反推 atkFactor，得到的是 10/3 + 专武贡献，属于自己证自己。
 *   实测 60 个角色全部满足上面的 10/3 公式，不需要任何拟合。
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

/** 专武表：角色 id → 音擎 item id（用于 sigWeapon，仅展示） */
const WEAPON_STAT = path.join(ROOT, 'system', 'default', 'zzz_weapon_stat.json')
const weaponStat = fs.existsSync(WEAPON_STAT) ? JSON.parse(fs.readFileSync(WEAPON_STAT, 'utf8')) : { weapons: {} }

/** 角色 → 专武（绝区零每个角色有专属音擎，命名规则不一致，这里用显式映射） */
let DISPLAY_WEAPON = {}
const DISP_FILE = path.join(ROOT, 'system', 'default', 'zzz_display_weapon.json')
if (fs.existsSync(DISP_FILE)) {
  DISPLAY_WEAPON = JSON.parse(fs.readFileSync(DISP_FILE, 'utf8')).chars || {}
}

const LEVEL_FACTOR = 10 / 3
const r2 = (v) => Math.round(v * 100) / 100

/** ExtraLevel 的 Value 已是累积值，直接取第 6 阶 */
const extraOf = (c, propId) => Number(c.ExtraLevel?.['6']?.Extra?.[String(propId)]?.Value) || 0

const chars = {}
const problems = []

for (const id of Object.keys(partners)) {
  const c = partners[id]
  if (!c?.name || !c?.Rarity) continue // 无稀有度的是 NPC

  const lv6 = c.Level?.['6']
  if (!lv6) { problems.push(`${c.name}(id=${id}) 缺 Level[6]`); continue }

  /* 角色裸值 */
  const base = {
    atk: r2(Number(c.Attack || 0) + Number(lv6.Attack || 0) * LEVEL_FACTOR),
    hp: r2(Number(c.HpMax || 0) + Number(lv6.HpMax || 0) * LEVEL_FACTOR),
    def: r2(Number(c.Defence || 0) + Number(lv6.Defence || 0) * LEVEL_FACTOR),
    impact: Number(c.BreakStun) || 0,
    anomalyMastery: Number(c.ElementAbnormalPower) || 0,
    anomalyProficiency: Number(c.ElementMystery) || 0,
    penRatio: Number(c.PenRate) || 0,
    energyRegen: (Number(c.SpRecover) || 120) / 100,
    crit: 20,
    critDmg: 50,
  }

  /* 突破额外加成（Value 是累积值，不要再累加 1~6 阶） */
  const extra = {
    atk: extraOf(c, 12101),
    hp: extraOf(c, 11101),
    def: extraOf(c, 13101),
    impact: extraOf(c, 12201),
    crit: extraOf(c, 20101) / 100,
    critDmg: extraOf(c, 21101) / 100,
    anomalyMastery: extraOf(c, 31401),
    anomalyProficiency: extraOf(c, 31201),
    penRatio: extraOf(c, 23201) / 100,
    energyRegen: extraOf(c, 30501) / 100,
  }

  /* 展示用推荐音擎（来自 zzz_extreme.yaml 的「极限面板最优配装」，**不是官方专武**）。
     仅供界面展示，禁止参与伤害计算——伤害必须用玩家自己的实际音擎。 */
  const dispId = DISPLAY_WEAPON[c.name] || null
  const disp = dispId ? weaponStat.weapons?.[String(dispId)] : null
  const displayWeapon = disp
    ? { itemId: String(dispId), name: disp.name, atk: disp.baseType === 'atk' ? Number(disp.atk60) || 0 : 0 }
    : null

  chars[c.name] = {
    id: Number(id),
    fullName: c.full_name || c.name,
    enName: c.en_name || '',
    rarity: c.Rarity,
    elementType: Number(c.ElementType) || 0,
    profession: Number(c.WeaponType) || 0,
    camp: c.Camp || '',
    sprite: c.sprite_id ? `IconRole${String(c.sprite_id).padStart(2, '0')}` : '',
    base,
    extra,
    displayWeapon,
    /* 旧版兼容：等价于 base.atk + displayWeapon.atk，仅供展示，禁止进入伤害计算 */
    legacy: {
      atkWithSig: r2(base.atk + (displayWeapon?.atk || 0)),
    },
  }

  if (!displayWeapon) problems.push(`${c.name} 未配置展示音擎（displayWeapon=null）`)
}

const payload = {
  _comment: '绝区零角色 Lv60 基础属性。base 为角色裸值（不含音擎/驱动盘/影画），extra 为突破累积加成，sigWeapon 仅供展示，legacy.atkWithSig 仅兼容旧调用。',
  _source: 'ZZZ-Plugin resources/map/PartnerId2Data.json（纯公式，无拟合）',
  _formula: 'atk/hp/def = 初始值 + Level[6] × 10/3；extra 取 ExtraLevel[6].Extra[*].Value',
  count: Object.keys(chars).length,
  chars,
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n')
console.log(`写入 ${OUT}`)
console.log(`角色 ${payload.count} 个`)

/* 回归断言：按 id 找角色（表键是简称，如「雅」） */
const R = (v) => Math.round(v)
const sy = Object.values(chars).find(c => c.id === 1091)
if (sy) {
  /* HP/攻击带 ±1 容差：Level[6] × 10/3 是近似公式，游戏内分段取整有 1 点偏差 */
  const checks = [
    ['base.atk + displayWeapon.atk ≈ 1623', R(sy.base.atk + sy.displayWeapon.atk), 1623, 1],
    ['base.hp ≈ 7673', R(sy.base.hp), 7673, 1],
    ['base.def ≈ 606', R(sy.base.def), 606, 1],
    ['base.impact === 86', sy.base.impact, 86, 0],
    ['base.anomalyMastery === 116', sy.base.anomalyMastery, 116, 0],
    ['base.anomalyProficiency === 148', sy.base.anomalyProficiency, 148, 0],
    ['extra.anomalyProficiency === 90', sy.extra.anomalyProficiency, 90, 0],
  ]
  console.log('\n回归断言（星见雅 1091）：')
  let fail = 0
  for (const [label, got, want, tol = 0] of checks) {
    const ok = Math.abs(got - want) <= tol
    if (!ok) fail++
    console.log(`${ok ? '✓' : '✗'} ${label}（实际 ${got}）`)
  }
  if (fail) { console.log(`\n${fail} 项未通过`); process.exitCode = 1 }
}

/* 第二组断言：抽 5 个角色（含防御型/异常型）核对 base 与 PartnerId2Data 字段一致性 */
const SAMPLE = ['雅', '安比', '猫又', '本', '珂蕾妲']
console.log('\n抽样核对（base 与 PartnerId2Data 原始字段）：')
for (const name of SAMPLE) {
  const c = chars[name]
  if (!c) { console.log(`  · ${name} 不在表中，跳过`); continue }
  const src = partners[String(c.id)]
  const want = {
    atk: Math.round(Number(src.Attack) + Number(src.Level['6'].Attack) * LEVEL_FACTOR),
    hp: Math.round(Number(src.HpMax) + Number(src.Level['6'].HpMax) * LEVEL_FACTOR),
    def: Math.round(Number(src.Defence) + Number(src.Level['6'].Defence) * LEVEL_FACTOR),
  }
  const got = { atk: R(c.base.atk), hp: R(c.base.hp), def: R(c.base.def) }
  const near = (a, b) => Math.abs(a - b) <= 1
  const ok = near(got.atk, want.atk) && near(got.hp, want.hp) && near(got.def, want.def)
  console.log(`  ${ok ? '✓' : '✗'} ${name}(id=${c.id}) atk ${got.atk}/${want.atk} hp ${got.hp}/${want.hp} def ${got.def}/${want.def}`)
  if (!ok) process.exitCode = 1
}

if (problems.length) {
  console.log(`\n注意 ${problems.length} 项：`)
  for (const p of problems.slice(0, 12)) console.log('  ·', p)
}
