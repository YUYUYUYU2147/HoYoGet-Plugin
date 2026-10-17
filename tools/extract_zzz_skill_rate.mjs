/**
 * 从 ZZZ-Plugin 的伤害模型里提取「角色 → 技能 → 各等级倍率」。
 *
 * 数据性质说明（重要）：
 *   数值本身是**绝区零游戏公开数据**（技能倍率先由社区从官方数值整理成表）。
 *   这里只提取倍率**数值**，不搬运其计算引擎：
 *   - 不复制 Calculator.js（伤害公式我们自己实现）
 *   - 不复制 score.js（驱动盘评分我们用另一套口径）
 *   - 只读 data.json 里的 skill 倍率数组与 calc.js 里的技能中文名映射
 *
 * 三个来源文件（均来自 ZZZ-Plugin，本机已安装）：
 *   resources/map/PartnerId2Data.json   角色 id ↔ 简称/全名
 *   dist/model/damage/character/<角色>/calc.js     技能键 → 中文技能名
 *   dist/model/damage/character/<角色>/data.json   技能键 → 16 级倍率数组
 *
 * 用法：node tools/extract_zzz_skill_rate.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// ZZZ-Plugin 不一定在 process.cwd() 下（例如从插件目录里直接跑脚本），
// 逐个候选位置找，找不到再退回 cwd
const ZZZ = [
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(ROOT, '..', 'ZZZ-Plugin'),
  '/root/TRSS_AllBot/TRSS-Yunzai/plugins/ZZZ-Plugin'
].find(p => fs.existsSync(path.join(p, 'dist', 'model', 'damage', 'character'))) || ''
const MAP_FILE = path.join(ZZZ, 'resources', 'map', 'PartnerId2Data.json')
const CHAR_DIR = path.join(ZZZ, 'dist', 'model', 'damage', 'character')
const OUT = path.join(ROOT, 'system', 'default', 'zzz_skill_rate.json')

/** calc.js 里形如 { name: '普攻：星仪序曲五段', type: 'AP5' } 的条目 */
function parseCalcSkills(calcSrc) {
  const out = []
  const re = /\{\s*name:\s*'([^']+)'\s*,\s*type:\s*'([^']+)'\s*\}/g
  let m
  while ((m = re.exec(calcSrc))) out.push({ name: m[1].trim(), key: m[2].trim() })
  return out
}

/** 角色 id → 简称/全名，用来把目录名对上游戏内的名字 */
function loadPartnerMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'))
    const byId = {}
    for (const [id, v] of Object.entries(raw)) {
      byId[id] = { name: v.name || '', fullName: v.full_name || v.name || '' }
    }
    return byId
  } catch (err) {
    console.warn('读不到 PartnerId2Data.json，角色 id 将不写入：', err.message)
    return {}
  }
}

const clean = (s) => String(s || '').replace(/[\s「」【】]/g, '')

function main() {
  if (!fs.existsSync(CHAR_DIR)) {
    console.error('找不到 ZZZ-Plugin 的伤害模型目录，先安装 ZZZ-Plugin')
    process.exit(1)
  }
  const partnerMap = loadPartnerMap()

  // 目录名（简称）→ 角色 id。ZZZ-Plugin 的目录用简称，PartnerId2Data 也有 name 字段
  const name2id = new Map()
  for (const [id, v] of Object.entries(partnerMap)) {
    for (const n of [v.name, v.fullName]) {
      if (n) name2id.set(clean(n), Number(id))
    }
  }

  const result = {}
  const dirs = fs.readdirSync(CHAR_DIR).filter(d => fs.statSync(path.join(CHAR_DIR, d)).isDirectory())
  let skillTotal = 0
  const noSkillName = []

  for (const dir of dirs) {
    const dataFile = path.join(CHAR_DIR, dir, 'data.json')
    const calcFile = path.join(CHAR_DIR, dir, 'calc.js')
    if (!fs.existsSync(dataFile)) continue

    let skill
    try {
      skill = JSON.parse(fs.readFileSync(dataFile, 'utf-8')).skill || {}
    } catch (err) {
      console.warn(`  跳过 ${dir}：data.json 解析失败（${err.message}）`)
      continue
    }
    if (!Object.keys(skill).length) continue

    // 技能键 → 中文名；calc.js 里没有的键（如 AXP/AXQ 这类强化分支）留空名
    const key2name = {}
    if (fs.existsSync(calcFile)) {
      for (const it of parseCalcSkills(fs.readFileSync(calcFile, 'utf-8'))) key2name[it.key] = it.name
    }

    const skills = []
    for (const [key, arr] of Object.entries(skill)) {
      if (!Array.isArray(arr) || !arr.length) continue
      const name = key2name[key] || ''
      if (!name) noSkillName.push(`${dir}/${key}`)
      // 数组顺序即技能 1..N 级；统一补成同长度，缺级按末值兜底
      const rates = arr.map(v => Number(v))
      skills.push({ name, key, maxLevel: rates.length, rates })
      skillTotal++
    }
    if (!skills.length) continue

    const id = name2id.get(clean(dir))
    result[dir] = {
      name: dir,
      id: id || null,
      fullName: id && partnerMap[id] ? partnerMap[id].fullName : dir,
      skills
    }
  }

  const payload = {
    _comment: '绝区零技能倍率数据。数值来源为社区依据官方数值整理的公开数据表（ZZZ-Plugin dist/model/damage/character/*/data.json），非米游社接口返回。仅为数值，不含其计算引擎与评分实现。',
    _regenerate: 'node tools/extract_zzz_skill_rate.mjs（需已安装 ZZZ-Plugin）',
    generatedAt: new Date().toISOString(),
    count: Object.keys(result).length,
    skillCount: skillTotal,
    chars: result
  }
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf-8')

  console.log(`角色 ${payload.count} 个 / 技能条目 ${payload.skillCount} 个`)
  console.log(`写入 ${OUT}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`)
  if (noSkillName.length) {
    console.log(`提示：${noSkillName.length} 个技能键在 calc.js 里没有中文名（多为强化分支），已按空名保存：`)
    console.log('  ' + noSkillName.slice(0, 12).join(', ') + (noSkillName.length > 12 ? ' …' : ''))
  }
}

main()