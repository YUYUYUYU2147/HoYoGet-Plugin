/**
 * 原神角色图鉴的「持有率 / 平均命座 / 配装」统计。
 *
 * 数据源：
 *   持有率、命座分布、深渊样本：提瓦特小助手
 *     https://api.yshelper.com/ys/getAbyssRank.php?star=all&role=all&lang=zh-Hans
 *   平均练度、武器/圣遗物配装：提瓦特小助手（与 lelaer 同源）
 *     https://api.lelaer.com/ys/getRoleAvg.php?star=all&lang=zh-Hans
 *
 * 这两个接口都是全服统计，不含单个账号数据；缓存 6 小时，失败时回退旧缓存，
 * 没有数据显示为空（模板 {{if statistics}} 整块跳过），不会把缺数据当成 0。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { yshelperAbyssRank } from './yshelper.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(PLUGIN_ROOT, 'data', 'panel', 'wiki-statistics')
const BUILDS_FILE = path.join(CACHE_DIR, 'gs-builds.json')
const BUILDS_URL = 'https://api.lelaer.com/ys/getRoleAvg.php?star=all&lang=zh-Hans'
const TTL = 6 * 3600 * 1000

let buildsMem = { at: 0, data: null, stale: false }

const clean = value => String(value || '')
  .replace(/[\s·•・\-—_「」『』《》【】\[\]（）()]/g, '')
  .toLowerCase()

const num = (value, max = Infinity) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null
}

const pct = value => {
  const n = num(value, 100)
  return n == null ? null : `${n.toFixed(1)}%`
}

function readDisk() {
  try {
    const saved = JSON.parse(fs.readFileSync(BUILDS_FILE, 'utf8'))
    if (saved?.data && Array.isArray(saved.data.result)) return saved
  } catch { /* 首次运行没有缓存 */ }
  return null
}

function writeDisk(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(BUILDS_FILE, JSON.stringify({ at: Date.now(), data }), 'utf8')
  } catch (err) {
    globalThis.logger?.debug?.(`[HoYoGet][wiki_stats] 写入缓存失败：${err?.message || err}`)
  }
}

async function fetchBuilds() {
  const res = await fetch(BUILDS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Referer: 'https://www.lelaer.com/',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`提瓦特小助手 HTTP ${res.status}`)
  const json = await res.json()
  if (Number(json?.code) !== 200 || !Array.isArray(json?.result)) throw new Error('提瓦特小助手配装数据无效')
  return json
}

async function getBuilds(force = false) {
  if (!force && buildsMem.data && Date.now() - buildsMem.at < TTL) return buildsMem
  const disk = readDisk()
  if (!force && disk && Date.now() - Number(disk.at || 0) < TTL) {
    buildsMem = { at: Number(disk.at) || Date.now(), data: disk.data, stale: false }
    return buildsMem
  }
  try {
    const data = await fetchBuilds()
    buildsMem = { at: Date.now(), data, stale: false }
    writeDisk(data)
    return buildsMem
  } catch (err) {
    globalThis.logger?.warn?.(`[HoYoGet][wiki_stats] 配装统计获取失败，改用缓存：${err?.message || err}`)
    if (disk?.data) {
      buildsMem = { at: Number(disk.at) || 0, data: disk.data, stale: true }
      return buildsMem
    }
    return { at: 0, data: null, stale: true }
  }
}

function findRow(rows, name) {
  const target = clean(name)
  if (!target) return null
  const list = Array.isArray(rows) ? rows : []
  return list.find(row => clean(row?.role || row?.name) === target)
    || list.find(row => {
      const n = clean(row?.role || row?.name)
      return n && (n.includes(target) || target.includes(n))
    }) || null
}

function topItems(rows, nameKey = 'name', iconKey = 'avatar', limit = 5) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => row && row[nameKey] && !/^暂无/.test(String(row[nameKey])) && num(row.rate, 100) != null)
    .sort((a, b) => Number(b.rate) - Number(a.rate))
    .slice(0, limit)
    .map(row => ({
      name: String(row[nameKey]),
      rate: pct(row.rate),
      pct: Number(row.rate) || 0,
      icon: String(row[iconKey] || ''),
    }))
}

/**
 * @param {string} name 角色正式名
 * @returns {Promise<null|object>} 模板直接使用的 statistics 视图
 */
export async function getGsWikiStatistics(name) {
  if (!name) return null
  const [builds, abyss] = await Promise.all([
    getBuilds().catch(() => ({ data: null, stale: true })),
    yshelperAbyssRank({ schedule: 1 }).catch(() => null),
  ])

  const buildRow = findRow(builds.data?.result, name)
  const ownRow = findRow(abyss?.groups?.flatMap(group => group.list || []), name)
  if (!buildRow && !ownRow) return null

  const distribution = buildRow
    ? Array.from({ length: 7 }, (_, level) => ({
      level,
      label: ['零命', '一命', '二命', '三命', '四命', '五命', '满命'][level],
      rate: pct(buildRow[`c${level}`]),
      pct: num(buildRow[`c${level}`], 100) || 0,
    })).filter(row => row.rate)
    : []

  const weapons = topItems(buildRow?.weapon, 'name', 'avatar')
  const artifacts = (Array.isArray(buildRow?.artifacts_set) ? buildRow.artifacts_set : [])
    .filter(row => row?.name && !/^暂无/.test(String(row.name)) && num(row.rate, 100) != null)
    .sort((a, b) => Number(b.rate) - Number(a.rate))
    .slice(0, 5)
    .map(row => ({
      name: String(row.name),
      rate: pct(row.rate),
      pct: Number(row.rate) || 0,
      icon: String((row.avatars || [])[0] || ''),
    }))

  return {
    ownership: pct(ownRow?.ownRate),
    ownershipNote: ownRow
      ? `持有率：提瓦特小助手深渊样本 ${abyss.topOwn || '未知'} · ${abyss.lastUpdate || '更新日期未知'}${abyss.offline ? '（缓存）' : ''}`
      : '',
    avgCons: buildRow && num(buildRow.avg_class, 6) != null ? Number(buildRow.avg_class).toFixed(2) : null,
    avgLevel: buildRow && num(buildRow.avg_level, 100) != null ? Number(buildRow.avg_level).toFixed(1) : null,
    distribution,
    weapons,
    artifacts,
    buildNote: buildRow
      ? `命座与配装：提瓦特小助手 · ${builds.data?.last_update || '更新日期未知'} · 角色样本 ${buildRow.role_sum || '未知'}${builds.stale ? '（缓存）' : ''}`
      : '',
  }
}

export const __test = { findRow, topItems, clean }
