import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 绝区零技能倍率查询（数据源：本地静态表 system/default/zzz_skill_rate.json）。
 *
 * 倍率数据的来龙去脉见 HANDOFF_2026-10-17.md 第八节，简述：
 *   - 米游社 record 接口**不含**技能倍率（已实测确认）
 *   - 官方情报站接口做 TLS 指纹识别，纯 HTTP 客户端拿不到（已废弃该路线）
 *   - 最终采用社区依据官方数值整理的公开数据表，由
 *     tools/extract_zzz_skill_rate.mjs 一次性提取成本地 JSON。
 *     **只取倍率数值**，不含其计算引擎与评分实现。
 *
 * 运行时只读本地文件：零网络请求、零反爬风险、离线可用。
 * 游戏更新后重跑提取脚本即可刷新。
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_skill_rate.json')

let cache = null

/** 读本地倍率表（进程内缓存一次） */
export function loadSkillRateTable() {
  if (cache) return cache
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) || { chars: {} }
  } catch (err) {
    logger.warn?.('[HoYoGet][zzz_skill_rate] 读本地倍率表失败：', err?.message || err)
    cache = { chars: {} }
  }
  return cache
}

const clean = (s) => String(s || '').replace(/[\s「」·\-]/g, '')

/**
 * 按角色名取倍率。
 * 传入的可能是简称（爱丽丝）、全名（爱丽丝·泰姆菲尔德）或角色 id（1401）。
 * @returns {{ok:boolean, char?:object, error?:string}}
 */
export function getCharRates(charNameOrId) {
  const table = loadSkillRateTable()
  const chars = table.chars || {}
  const key = String(charNameOrId ?? '').trim()
  if (!key) return { ok: false, error: '角色名为空' }

  if (chars[key]) return { ok: true, char: chars[key] }

  // 角色 id 直接命中
  if (/^\d+$/.test(key)) {
    const hit = Object.values(chars).find(c => String(c.id) === key)
    if (hit) return { ok: true, char: hit }
  }

  // 名称模糊：忽略「·」与空格后比较，再退化为包含匹配
  const target = clean(key)
  let hit = Object.values(chars).find(c => clean(c.name) === target || clean(c.fullName) === target)
  if (!hit) {
    hit = Object.values(chars).find(c => clean(c.name).includes(target) || target.includes(clean(c.name)))
  }
  if (hit) return { ok: true, char: hit }
  return { ok: false, error: `本地倍率表里没有「${key}」（现有 ${Object.keys(chars).length} 个角色）` }
}

/** 该角色可选技能的最大等级（倍率表里各技能一致时返回统一值） */
export function maxLevelOf(charData) {
  const lv = (charData?.skills || []).map(s => s.maxLevel || 0).filter(Boolean)
  return lv.length ? Math.max(...lv) : 0
}

/**
 * 取某角色在指定技能等级下、按类型分组的技能与倍率。
 * @param {string|number} charNameOrId
 * @param {number} skillLevel 面板上的实际技能等级
 */
export function damageSkillsAt(charNameOrId, skillLevel = 16) {
  const r = getCharRates(charNameOrId)
  if (!r.ok) return { ok: false, error: r.error }
  const char = r.char
  const lv = Math.max(1, Math.min(Number(skillLevel) || 1, maxLevelOf(char) || 16))
  const skills = (char.skills || [])
    .filter(s => s.rates?.length)
    .map(s => ({
      name: s.name || '',
      key: s.key,
      // 下标 0 = 1 级，超出则夹到末级
      rate: Number(s.rates[Math.min(lv, s.rates.length) - 1]),
      // 同时带出整张表，便于调用方按各自等级再取一次
      rates: s.rates,
      rateList: s.rates
    }))
  return { ok: true, char, skillLevel: lv, skills }
}

/** 人工核对用 */
export function summarize(charNameOrId, skillLevel = 16) {
  const r = damageSkillsAt(charNameOrId, skillLevel)
  if (!r.ok) return r.error
  const lines = [`${r.char.fullName || r.char.name}（id=${r.char.id}） Lv${r.skillLevel}`]
  for (const s of r.skills) lines.push(`  ${(s.name || `(无名/${s.key})`).padEnd(24)} 倍率=${s.rate}`)
  return lines.join('\n')
}
