/**
 * 提取绝区零增益（buff）静态数据 → system/default/zzz_buff.json
 *
 * 与 extract_zzz_skill_rate.mjs 同源同原则：
 *   只**提取公开的数值事实**（音擎/套装/额外能力的效果数值），
 *   不复制 ZZZ-Plugin 的 Calculator.js / BuffManager.js 计算引擎。
 * 运行时只做「查表 + 求和」，逻辑在本插件自己的 system/zzz_buff.js。
 *
 * 来源目录：../../ZZZ-Plugin/dist/model/damage/{weapon,set,character}
 * 运行：node tools/extract_zzz_buff.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// ZZZ-Plugin 不一定在 process.cwd() 下（例如从插件目录里直接跑脚本），逐个探测
const ZZZ_ROOTS = [
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(PLUGIN_ROOT, '..', 'ZZZ-Plugin'),
  '/root/TRSS_AllBot/TRSS-Yunzai/plugins/ZZZ-Plugin',
]
const ZZZ_ROOT = ZZZ_ROOTS.find(r => fs.existsSync(path.join(r, 'dist/model/damage')))
if (!ZZZ_ROOT) {
  console.error(`找不到 ZZZ-Plugin 的 dist/model/damage，已尝试：\n  ${ZZZ_ROOTS.join('\n  ')}`)
  process.exit(1)
}
const ZZZ_DAMAGE = path.join(ZZZ_ROOT, 'dist/model/damage')
const OUT = path.join(PLUGIN_ROOT, 'system/default/zzz_buff.json')

/**
 * 源文件里 value 可能是表达式/函数，直接 import 让 Node 求值，再规整成 JSON 可序列化形式。
 * 源目录里混着给开发者复制用的**模板文件**（`模板.js`、占位符 `type: ,`）本身不是合法 JS，
 * import 会抛 SyntaxError —— 捕获后跳过，不当成错误。
 */
async function loadBuffs(file) {
  const src = fs.readFileSync(file, 'utf8')
  if (/^\s*(type|value|element)\s*:\s*[,}]/m.test(src)) return { buffs: null, template: true }
  try {
    const mod = await import(pathToFileURL(file).href)
    return { buffs: Array.isArray(mod.buffs) ? mod.buffs : null, template: false }
  } catch (e) {
    return { buffs: null, template: true, error: String(e).split('\n')[0] }
  }
}

/**
 * buff.value 有五种形态，统一规整：
 *   number            固定值
 *   number[]          音擎精炼 1~5 档
 *   'T' / 'A' / ...   随该类技能等级变化的档位 → { dyn: 'T' }
 *   function          条件表达式，静态不可知 → null（记录到 skipped）
 *   其它              → null
 */
function normValue(v, skipped, where) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return { dyn: v }
  if (Array.isArray(v)) return v.every(x => typeof x === 'number') ? v.slice() : null
  skipped.push({ where, reason: typeof v === 'function' ? 'function' : typeof v, value: String(v).slice(0, 60) })
  return null
}

function normBuff(b, skipped, where) {
  const value = normValue(b.value, skipped, `${where}:${b.name || '?'}`)
  if (value === null) return null
  const out = { type: b.type, value }
  if (b.element) out.element = b.element
  if (b.range) out.range = Array.isArray(b.range) ? b.range.slice() : [b.range]
  if (typeof b.check === 'number') out.check = b.check
  if (typeof b.profession === 'string' || typeof b.profession === 'number') out.profession = b.profession
  return out
}

// ── 音擎 ────────────────────────────────────────────────────────────────
const weapons = {}
{
  const dir = path.join(ZZZ_DAMAGE, 'weapon')
  const skipped = []
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const name = path.basename(f, '.js')
    const { buffs, template } = await loadBuffs(path.join(dir, f))
    if (template) { console.log(`  跳过模板文件 音擎/${name}`); continue }
    const list = (buffs || []).map(b => normBuff(b, skipped, `音擎${name}`)).filter(Boolean)
    if (list.length) weapons[name] = list
  }
  if (skipped.length) console.warn('音擎跳过：', skipped)
}

// ── 驱动盘套装（文件名 = 套装基名，运行时按 2件/4件拼出「基名+件数」）────────
const sets = {}
{
  const dir = path.join(ZZZ_DAMAGE, 'set')
  const skipped = []
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const name = path.basename(f, '.js')
    const { buffs, template } = await loadBuffs(path.join(dir, f))
    if (template) { console.log(`  跳过模板文件 套装/${name}`); continue }
    const list = (buffs || []).map(b => normBuff(b, skipped, `套装${name}`)).filter(Boolean)
    if (list.length) sets[name] = list
  }
  if (skipped.length) console.warn('套装跳过：', skipped)
}

// ── 角色：核心被动 + 额外能力 + 影画（影画需持有几影，运行时按 rank 过滤）──────
const chars = {}
{
  const dir = path.join(ZZZ_DAMAGE, 'character')
  const skipped = []
  for (const d of fs.readdirSync(dir)) {
    const calcFile = path.join(dir, d, 'calc.js')
    if (!fs.existsSync(calcFile)) continue
    const { buffs: all } = await loadBuffs(calcFile)
    const illum = []
    const core = []
    const mindscape = []
    for (const b of all || []) {
      const src = /额外能力/.test(b.name || '') ? illum
        : /^\d影/.test(b.name || '') ? mindscape
          : /核心|天赋/.test(b.name || '') ? core : null
      if (!src) continue
      const nb = normBuff(b, skipped, `角色${d}:${b.name}`)
      if (!nb) continue
      if (src === core && !nb.range) continue // 无 range 的核心被动无法定位生效技能，跳过
      src.push({ name: b.name, ...nb })
    }
    // 档位值（如 核心被动 value:'T' → 随技能等级），从 data.json 取完整档位表
    const dataFile = path.join(dir, d, 'data.json')
    let levels = null
    if (fs.existsSync(dataFile)) {
      try { levels = JSON.parse(fs.readFileSync(dataFile, 'utf8')).buff || null } catch { /* 忽略 */ }
    }
    const dynUsed = [...illum, ...core, ...mindscape].filter(b => b.value && b.value.dyn).map(b => b.value.dyn)
    chars[d] = {
      core, illum, mindscape,
      levels: levels && dynUsed.length ? levels : null,
    }
  }
  if (skipped.length) console.warn('角色跳过：', skipped)
}

const out = {
  _comment: '绝区零增益数据。数值来源为社区依据官方数值整理的公开数据表（ZZZ-Plugin dist/model/damage/*），非米游社接口返回。仅为数值，不含其计算引擎。重生成：node tools/extract_zzz_buff.mjs',
  _valueKinds: {
    number: '固定值',
    array: '音擎精炼 1~5 档（下标 0 = 精炼 1）；角色核心被动为技能等级 1~7 档',
    dyn: '随技能等级变化的档位，数值见 chars[x].levels[类别]，等级由接口按实际技能等级代入',
  },
  _source: {
    weaponCount: Object.keys(weapons).length,
    setCount: Object.keys(sets).length,
    charCount: Object.keys(chars).length,
  },
  weapons, sets, chars,
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
const kb = (fs.statSync(OUT).size / 1024).toFixed(1)
console.log(`已写入 ${OUT}`)
console.log(`音擎 ${out._source.weaponCount} / 套装 ${out._source.setCount} / 角色 ${out._source.charCount}，${kb}KB`)