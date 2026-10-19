/**
 * 校验绝区零角色基础属性表 → system/default/zzz_char_stat.json
 *
 * 基准来源（不依赖 PartnerId2Data 反推）：
 *   工坊详情接口 source_api='mi' 的玩家，item_json.properties 里：
 *     base = 角色裸值 + 该玩家音擎的攻击/防御
 *   因此：裸攻 = base.atk − 音擎 atk60（音擎 baseType='def' 时减 0）
 *   同一角色、同一等级、同一音擎的多个玩家，反解值应恒定（容差 ±1）。
 *
 * 边界条件：
 *   · base.atk = 0 或没有音擎 → 跳过，不产出负值
 *   · 音擎 baseType='def' → 不减攻击（血髓秘匣、喵运当头等）
 *   · 等级不是 60 → 按等级表先取基础，再做差（本轮只校验 Lv60）
 *
 * 接口有限流，必须串行 + 间隔，不要并发。
 *
 * 用法：node tools/verify_char_stat.mjs [角色id ...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'system/default/zzz_char_stat.json'), 'utf8'))
const WEAPON = JSON.parse(fs.readFileSync(path.join(ROOT, 'system/default/zzz_weapon_stat.json'), 'utf8')).weapons

globalThis.logger = { mark(){}, debug(){}, info(){}, warn(){}, error(){} }

/* 直接复用插件的 http 实现：两套代码容易出现签名/头不一致，且接口有限流，
   行为不同会让人误判成公式错误。 */
const PLUGIN_APP = path.join(ROOT, 'apps', 'zzz_workshop.js')
async function loadPluginIO() {
  const panelList = await import(new URL('../apps/zzz_panel_list.js', import.meta.url))
  let src = fs.readFileSync(PLUGIN_APP, 'utf8')
    .replace(/^import[\s\S]*?from '[^']*'$/gm, '')
    .replace(/export class[\s\S]*$/, '')
  const Factory = new Function(
    'pluginPriority', 'getRankScope', 'fs', 'path', 'buildBasicProperties', 'calcPanelDamage', 'createHash',
    src + ';return { signedPost, request }',
  )
  return Factory(() => 5000, () => 'group', fs, path, panelList.buildBasicProperties, panelList.calcDamage, createHash)
}

const API_HOST = 'https://api.zzzmap.com'
const APP_VERSION = '100'
const SIGN_KEY = 'VW^)(^*^$$#*%(#)!@VIAI%'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
const GAP = 2500
const TOL = 1

const sleep = ms => new Promise(r => setTimeout(r, ms))

const IO = await loadPluginIO()
const post = IO.signedPost
const get = IO.request

/** 反解单个玩家的角色裸攻；返回 null 表示该样本不可用 */
function reverseBare(roleJson, roleId) {
  const ij = roleJson?.item_json || {}
  const props = ij.properties
  if (!Array.isArray(props)) return null            // source_api=2025，无面板
  const atkProp = props.find(x => Number(x.property_id) === 2)
  const baseAtk = Number(atkProp?.base)
  if (!baseAtk) return null                          // base=0，跳过
  const wqId = String(ij.weapon?.id || '')
  const w = WEAPON[wqId]
  if (!w) return null                                // 音擎未知，跳过
  const sigAtk = w.baseType === 'def' ? 0 : Number(w.atk60) || 0
  return { bare: baseAtk - sigAtk, baseAtk, weapon: w.name, sigAtk, level: Number(ij.level) || 60 }
}

const targets = process.argv.slice(2).map(Number).filter(Boolean)
const ids = targets.length ? targets : [1091, 1011]

let exitCode = 0

for (const roleId of ids) {
  const entry = Object.values(STAT.chars).find(c => c.id === roleId)
  if (!entry) { console.log(`✗ ${roleId} 不在角色表里`); exitCode = 1; continue }

  console.log(`\n=== ${entry.fullName}（${roleId}）===`)
  console.log(`  表内 base.atk = ${entry.base.atk}`)

  let rows
  try {
    rows = (await get('/api/v1/user_relic/ranking', {
      limit: 20, offset: 0, type: 'role', role_id: roleId,
      role_level: 60, role_rank: null, part_index: null, weapon_id: null,
    }))?.rows || []
  } catch (err) {
    console.log(`  ✗ 取榜单失败：${err.message}`)
    exitCode = 1
    continue
  }

  if (process.env.VERBOSE) console.log(`  榜单 ${rows.length} 条，开始反解…`)
  const samples = []
  for (const row of rows.slice(0, 10)) {
    await sleep(GAP)
    try {
      const data = await post('/api/v1/user_role/ranking', {
        uid: row.uid, type: 'ranking', refresh: false, item_id: roleId,
      })
      const t = (data?.roles || []).find(r => String(r.item_id) === String(roleId))
      const rev = reverseBare(t, roleId)
      if (rev && rev.level === 60) samples.push({ uid: row.uid, ...rev })
    } catch (err) {
      if (process.env.VERBOSE) console.log(`    · ${row.uid} 跳过：${err.message}`)
    }
  }

  if (!samples.length) {
    console.log('  · 无可反解样本（全部为旧通道或限流），跳过')
    continue
  }

  /* 按音擎分组统计，组内反解值必须恒定 */
  const byWeapon = new Map()
  for (const s of samples) {
    if (!byWeapon.has(s.weapon)) byWeapon.set(s.weapon, [])
    byWeapon.get(s.weapon).push(s)
  }
  for (const [weapon, list] of byWeapon) {
    const bares = list.map(x => x.bare)
    const min = Math.min(...bares), max = Math.max(...bares)
    const ok = max - min <= TOL
    if (!ok) exitCode = 1
    console.log(`  ${ok ? '✓' : '✗'} 音擎「${weapon}」(${list[0].sigAtk}) 反解裸攻 ${bares.join('/')} 波动 ${max - min}`)
  }

  /* 主音擎反解值 vs 表内 base.atk（容差 ±1） */
  const main = [...byWeapon.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  if (main) {
    const avg = main[1].reduce((a, x) => a + x.bare, 0) / main[1].length
    const diff = Math.abs(avg - entry.base.atk)
    const ok = diff <= TOL
    if (!ok) exitCode = 1
    console.log(`  ${ok ? '✓' : '✗'} 表内 base.atk ${entry.base.atk} vs 反解 ${avg.toFixed(1)}（差 ${diff.toFixed(1)}）`)
  }
}

/* PartnerId2Data 交叉检查（±2 容差，仅提示不阻断） */
console.log('\n=== PartnerId2Data 交叉检查（±2 容差，仅提示）===')
try {
  const ZZZ = [
    path.join(ROOT, '..', 'ZZZ-Plugin'),
    path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
    '/root/TRSS_AllBot/TRSS-Yunzai/plugins/ZZZ-Plugin',
  ].find(p => fs.existsSync(path.join(p, 'resources/map/PartnerId2Data.json')))
  if (ZZZ) {
    const partners = JSON.parse(fs.readFileSync(path.join(ZZZ, 'resources/map/PartnerId2Data.json'), 'utf8'))
    let bad = 0
    for (const c of Object.values(STAT.chars)) {
      const src = partners[String(c.id)]
      if (!src?.Level?.['6']) continue
      const want = Number(src.Attack) + Number(src.Level['6'].Attack) * (10 / 3)
      if (Math.abs(want - c.base.atk) > 2) { bad++; if (bad <= 5) console.log(`  · ${c.fullName} 差 ${(c.base.atk - want).toFixed(1)}`) }
    }
    console.log(`  ${bad ? '注意' : '✓'} ${bad} 个角色超出 ±2`)
  } else {
    console.log('  · 未找到 PartnerId2Data.json，跳过')
  }
} catch (err) {
  console.log(`  · 交叉检查失败：${err.message}`)
}

process.exitCode = exitCode
