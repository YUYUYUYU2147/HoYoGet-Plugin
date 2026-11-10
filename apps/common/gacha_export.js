import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { pluginPriority } from '#HoYoGet'
import { getEventNoteUser } from '../../system/genshin_loader.js'

/**
 * HoYoGet 独立抽卡记录导出。
 *
 * 把本插件自己保存的抽卡数据导出成 UIGF v2.3 JSON（可直接再导入，也能给其它工具用）。
 * 按前缀区分游戏：`#`=原神、`*`=星铁、`%`=绝区零；崩三另提供兼容 Mys/APK 的双格式文件。
 *
 * 抽卡记录来自本地；崩三导出时会按需读取官方百科星级映射（失败时保留 0）。
 *   星铁  data/sr_gacha/sr_<uid>_full.json（小助手全量逐抽，含四星）
 *         data/sr_gacha/<uid>/<qq>/summary.json（工坊/在线统计，只有五星+四星）
 *   绝区零 data/zzz_gacha/zzz_plugin/<uid>.json（ZZZ-Plugin 全量逐抽）
 *         data/zzz_gacha/<qq>/<uid>/summary.json（在线统计）
 *   原神  data/gs_gacha/<uid>.json（只有五星记录与垫抽）
 *
 * 同一游戏有多个 UID 时：默认导出记录最多的那个；也可以 `#导出抽卡记录 123456789` 指定。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SR_DIR = path.join(ROOT, 'data/sr_gacha')
const ZZZ_DIR = path.join(ROOT, 'data/zzz_gacha')
const EXTERNAL_ZZZ_DIR = (() => {
  const dataRoot = path.resolve(ROOT, '../../data')
  try {
    const name = fs.readdirSync(dataRoot).find(item =>
      fs.existsSync(path.join(dataRoot, item, 'gachaJson/zzz')))
    if (name) return path.join(dataRoot, name, 'gachaJson/zzz')
  } catch {}
  return path.join(dataRoot, 'external/gachaJson/zzz')
})()
const GS_DIR = path.join(ROOT, 'data/gs_gacha')
const BH3_DIR = path.join(ROOT, 'data/bh3_gacha')
const TMP_DIR = path.join(ROOT, 'temp/gacha-export')
const BH3_WIKI_URL = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki/v1/home/content/list?app_sn=bh3_wiki'
let bh3RankMapCache = null

const GAMES = {
  '#': { key: 'gs', name: '原神', prefix: 'gs' },
  '*': { key: 'sr', name: '星铁', prefix: 'hsr' },
  '%': { key: 'zzz', name: '绝区零', prefix: 'zzz' },
}
const ZZZ_GACHA_ID = '2c1f5692fdfbb733a08733f9eb69d32aed1d37'
const ZZZ_PLUGIN_POOL_TYPES = {
  独家频段: '2', 独家重映: '102', 音擎频段: '3', 音擎回响: '103', 常驻频段: '1', 邦布频段: '5',
  独家频段导入: '2', 独家重映导入: '102', 音擎频段导入: '3', 音擎回响导入: '103', 常驻频段导入: '1', 邦布频段导入: '5',
}
let zzzItemIdMaps

function getZzzItemIdMaps() {
  if (zzzItemIdMaps) return zzzItemIdMaps
  const readMap = (file, fields) => {
    const data = readJson(path.join(ROOT, 'resources/zzz/map', file)) || {}
    const map = new Map()
    for (const [id, item] of Object.entries(data)) {
      for (const field of fields) if (item?.[field]) map.set(String(item[field]).trim(), String(id))
    }
    return map
  }
  zzzItemIdMaps = {
    role: readMap('PartnerId2Data.json', ['name', 'full_name']),
    weapon: readMap('WeaponId2Data.json', ['Name']),
    bangboo: readMap('BangbooId2Data.json', ['CHS']),
  }
  return zzzItemIdMaps
}

function zzzItemId(row = {}, fallback = {}) {
  const current = String(row.item_id || fallback.item_id || '')
  if (/^[1-9]\d*$/.test(current)) return current
  const name = String(row.name || fallback.name || '').trim()
  const type = String(row.item_type || fallback.item_type || '')
  const maps = getZzzItemIdMaps()
  const map = /邦布/.test(type) ? maps.bangboo : /音擎|武器/.test(type) ? maps.weapon : maps.role
  return map.get(name) || ''
}

function zzzUigfType(type) {
  const value = String(type || '')
  return ({
    1: '2', 2: '102', 3: '3', 4: '103', 5: '1', 6: '5',
    1001: '1', 2001: '2', 12001: '102', 12002: '102',
    3001: '3', 13001: '103', 13002: '103', 5001: '5',
  })[value] || value
}

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
const listFiles = dir => {
  try { return fs.readdirSync(dir) } catch { return [] }
}
const isUid = v => /^\d{6,12}$/.test(String(v || ''))
const isBh3Uid = v => /^\d{8,10}$/.test(String(v || ''))

function now () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 星铁全量文件（小助手）→ UIGF list */
function srFullToList (data) {
  const out = []
  for (const key of ['roleList', 'weaponList', 'normalList']) {
    for (const row of data?.[key] || []) {
      if (!row?.id) continue
      out.push({
        uid: String(row.uid || data.uid),
        gacha_id: String(row.gacha_id || ''),
        gacha_type: String(row.gacha_type),
        item_id: String(row.item_id || ''),
        count: String(row.count || '1'),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: row.lang || 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: String(row.rank_type || '3'),
        id: String(row.id),
      })
    }
  }
  return out
}

/** 星铁 summary.json（只有五星/四星）→ UIGF list */
/** summary 的池 key（GachaType_xxx / common）→ 数字 gacha_type */
/** summary 没存 gacha_id；导入目标工具要求记录带正整数 gacha_id，这里按池给一个占位值 */
const SR_POOL_GACHA_ID = { '11': '2001', '12': '3001', '21': '2001', '22': '3001', '1': '1001', '2': '1001' }

const SR_POOL_TYPE = {
  GachaType_AvatarUp: '11',
  GachaType_EquipmentUp: '12',
  GachaType_CollabAvatarUp: '21',
  GachaType_CollabEquipmentUp: '22',
  GachaType_Newbie: '2',
  GachaType_Standard: '1',
  GachaType_Normal: '1',
  common: '1'
}

function srSummaryToList (data, uid) {
  const out = []
  for (const [key, pool] of Object.entries(data?.pools || {})) {
    // summary 的 pool 本身没有 type 字段，类型只在 key 上；之前因此导出成空 gacha_type，
    // 导入时无法按池识别、甚至被当成原神。这里按 key 映射出数字类型。
    const gachaType = SR_POOL_TYPE[key] || SR_POOL_TYPE[pool?.key] || String(pool?.type || '').replace(/^GachaType_/, '') || ''
    const fiveIds = new Set((pool.records || []).map(r => String(r?.id || '')))
    for (const row of [...(pool.records || []), ...(pool.fourLog || [])]) {
      const id = String(row?.id || '')
      if (!id) continue
      const isFive = fiveIds.has(id)
      out.push({
        uid: String(uid),
        gacha_type: gachaType,
        gacha_id: SR_POOL_GACHA_ID[gachaType] || '1001',
        count: isFive ? String(Number(row.gacha_count) || 1) : '1',
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: isFive ? '5' : '4',
        is_up: isFive ? !!row.is_up : false,
        id,
      })
    }
  }
  return out
}

/** 绝区零 zzz_plugin 逐抽 → UIGF list（item 已带 gacha_type） */
function zzzFullToList (data, uid) {
  const out = []
  for (const [poolName, rows] of Object.entries(data || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.id) continue
      // ZZZ-Plugin 落盘的 rank_type 比官方 UIGF 少 1（它的 4=五星 S、3=四星 A、2=三星 B），
      // 导出要还原成 UIGF 的 5/4/3，否则五星会被当成四星。
      const rawRank = Number(row.rank_type)
      const rank = Number.isFinite(rawRank) && rawRank >= 2 && rawRank <= 4 ? rawRank + 1 : (rawRank || 3)
      out.push({
        uid: String(row.uid || uid),
        gacha_id: ZZZ_GACHA_ID,
        gacha_type: ZZZ_PLUGIN_POOL_TYPES[poolName] || zzzUigfType(row.gacha_type),
        item_id: zzzItemId(row),
        count: String(row.count || '1'),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: row.lang || 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: String(rank),
        id: String(row.id),
      })
    }
  }
  return out
}

/** HoYoGet 合并后的绝区零 summary（包含工坊统计和可补齐的逐抽明细）→ UIGF list */
function zzzSummaryToList (data, uid) {
  const out = []
  for (const pool of Object.values(data?.pools || {})) {
    const fiveIds = new Set((pool.records || []).map(r => String(r?.id || '')))
    const fourIds = new Set((pool.fourLog || []).map(r => String(r?.id || '')))
    for (const row of [...(pool.records || []), ...(pool.fourLog || []), ...(pool.threeLog || [])]) {
      const id = String(row?.id || '')
      if (!id) continue
      const isFive = fiveIds.has(id)
      const isFour = fourIds.has(id)
      out.push({
        uid: String(uid),
        gacha_id: ZZZ_GACHA_ID,
        gacha_type: zzzUigfType(pool.type),
        item_id: zzzItemId(row),
        count: isFive ? String(Number(row.gacha_count) || 1) : '1',
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: isFive ? '5' : (isFour ? '4' : '3'),
        is_up: isFive ? !!row.is_up : false,
        id,
      })
    }
  }
  return out
}

/** External archive contains full ZZZ pulls; Moonward computes pity from the pull sequence. */
function externalZzzFullToList (data, uid) {
  const list = data?.nap?.find?.(account => String(account?.uid || '') === String(uid))?.list
  if (!Array.isArray(list) || !list.length) return []
  return list.filter(row => row?.id).map(row => {
    const nativeRank = Number(row.rank_type)
    return {
      uid: String(uid),
      gacha_id: String(row.gacha_id || ZZZ_GACHA_ID),
      gacha_type: String(row.gacha_type || ''),
      item_id: zzzItemId(row),
      count: '1',
      time: String(row.time || ''),
      name: String(row.name || '未知'),
      lang: row.lang || 'zh-cn',
      item_type: String(row.item_type || ''),
      rank_type: ({ 4: '5', 3: '4', 2: '3' })[nativeRank] || String(row.rank_type || ''),
      id: String(row.id),
    }
  })
}

function readExternalZzzFull (uid) {
  return readJson(path.join(EXTERNAL_ZZZ_DIR, `${uid}.json`))
}

/** 原神 gs_gacha/<uid>.json（只有五星+垫抽）→ UIGF list */
function gsToList (data, uid) {
  const out = []
  const typeByKey = {
    GsGachaType_AvatarUp: '301',
    GsGachaType_WeaponUp: '302',
    GsGachaType_AvatarUp2: '301',
    GsGachaType_Collection: '500',
    GsGachaType_Permanent: '200',
  }
  for (const [key, pool] of Object.entries(data?.pools || {})) {
    const gachaType = typeByKey[key] || '200'
    for (const row of pool.records || []) {
      if (!row?.id) continue
      out.push({
        uid: String(uid),
        gacha_type: gachaType,
        count: String(Number(row.gacha_count) || 1),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: '5',
        is_up: !!row.is_up,
        id: String(row.id),
      })
    }
  }
  return out
}

function bh3ApkPoolType (name) {
  const pool = String(name || '').trim()
  const match = pool.match(/^(角色|装备)补给([A-Z])$/)
  if (match) {
    const base = match[1] === '角色' ? 1 : 3
    return String(base + (match[2] === 'B' ? 1 : 0))
  }
  if (/^协同(?:者)?补给$/.test(pool)) return '5'
  if (pool === '家园补给') return '6'
  // APK also accepts unknown BH3 pool labels as raw pool keys.
  return pool
}

function bh3ItemFields (content) {
  const match = String(content).match(/^\[([^\]]+)\](.*)$/s)
  if (!match) return { item_type: '', name: String(content) }
  const item_type = match[1]
  let name = match[2].trim() || String(content)
  // WishArchive resolves official images by the item type and title.  The
  // source API appends this UI-only suffix to character drops, while the
  // wiki title (and APK lookup key) does not contain it.
  if (/^角色$/.test(item_type)) name = name.replace(/角色卡$/, '').trim()
  return { item_type, name }
}

function bh3RankValue (value, itemType = '') {
  const text = String(value || '').trim().toUpperCase()
  if (/角色|女武神/.test(itemType)) {
    if (text === 'S' || text === '初始阶级/S') return '5'
    if (text === 'A' || text === 'SP' || /^初始阶级\/(?:A|SP)$/.test(text)) return '4'
    if (text === 'B' || text === '初始阶级/B') return '3'
  }
  const match = text.match(/(?:星级\/|武器星级\/)?([345])星?(?:武器)?$/)
  if (match) return match[1]
  if (/^[345]$/.test(text)) return text
  if (/(?:^|\/)(?:五星)(?:武器)?$/.test(text)) return '5'
  if (/(?:^|\/)(?:四星)(?:武器)?$/.test(text)) return '4'
  if (/(?:^|\/)(?:三星)(?:武器)?$/.test(text)) return '3'
  return ''
}

function bh3RankForItem (item, maps = {}) {
  const type = String(item.item_type || '')
  // APK treats companion drops as S-rarity.  Their wiki channel does not
  // expose a star filter consistently, so use the stable game rule.
  if (/协同者|协作者/.test(type)) return '5'
  const table = /角色/.test(type) ? maps.char : /武器/.test(type) ? maps.weapon : /圣痕/.test(type) ? maps.stigmata : null
  if (!table) return '0'
  const key = String(item.name || '').trim()
  const direct = table?.[key]
  if (direct != null) {
    const converted = bh3RankValue(direct, type)
    if (converted) return converted
  }
  return '0'
}

function parseBh3WikiFilters (item, key) {
  try {
    const ext = typeof item?.ext === 'string' ? JSON.parse(item.ext) : (item?.ext || {})
    const text = ext?.[`c_${key}`]?.filter?.text
    const values = typeof text === 'string' ? JSON.parse(text) : (Array.isArray(text) ? text : [])
    return values.map(value => String(value))
  } catch { return [] }
}

/** Fetch the small official BH3 title -> rarity maps used by WishArchive. */
async function getBh3RankMaps () {
  if (bh3RankMapCache && bh3RankMapCache.expires > Date.now()) return bh3RankMapCache.value
  const value = { char: Object.create(null), weapon: Object.create(null), stigmata: Object.create(null) }
  const fetcher = globalThis.fetch
  if (typeof fetcher !== 'function') return value
  const fetchChannel = async channel => {
    const url = `${BH3_WIKI_URL}&channel_id=${channel}`
    const response = await fetcher(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  try {
    const channels = await Promise.all([18, 19, 20].map(channel => fetchChannel(channel).catch(() => null)))
    for (const item of channels[0]?.data?.list?.[0]?.list || []) {
      const rank = parseBh3WikiFilters(item, 18).find(filter => /初始阶级\/(?:S|A|SP|B)/.test(filter))
      if (item?.title && rank) value.char[String(item.title).trim()] = rank
    }
    for (const item of channels[1]?.data?.list?.[0]?.list || []) {
      const rank = parseBh3WikiFilters(item, 19).find(filter => /圣痕星级\/(?:五星|四星|三星)/.test(filter))
      if (item?.title && rank) value.stigmata[String(item.title).trim()] = rank
    }
    for (const item of channels[2]?.data?.list?.[0]?.list || []) {
      const rank = parseBh3WikiFilters(item, 20).find(filter => /(?:星级\/|武器星级\/)?(?:[345]星|五星|四星|三星)(?:武器)?$/.test(filter))
      if (item?.title && rank) value.weapon[String(item.title).trim()] = rank
    }
  } catch (error) {
    globalThis.logger?.debug?.(`[HoYoGet][导出] 崩三百科星级映射不可用：${error?.message || error}`)
  }
  bh3RankMapCache = { value, expires: Date.now() + (Object.keys(value.char).length || Object.keys(value.weapon).length ? 86400000 : 60000) }
  return value
}

function bh3SyntheticId (uid, pool, row, occurrence) {
  const seed = JSON.stringify([String(uid), pool, row.time, row.content, occurrence])
  return (BigInt(`0x${createHash('sha256').update(seed).digest('hex').slice(0, 15)}`) + 1n).toString()
}

function bh3RecordMultiset (records) {
  return JSON.stringify(records.map(row => [String(row?.time || ''), String(row?.content || '')]).sort((a, b) =>
    a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])))
}

function bh3ExportPools (sourcePools) {
  const entries = Object.entries(sourcePools).filter(([name, records]) =>
    name !== '家园补给' && Array.isArray(records))
  const aliases = new Set(['武器', '礼包币记录'])
  const canonical = entries.filter(([name]) => !aliases.has(name))
  const aliasIsContained = ([, records]) => {
    const counts = new Map()
    for (const row of records) {
      const key = JSON.stringify([String(row?.time || ''), String(row?.content || '')])
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return canonical.some(([, otherRecords]) => {
      const otherCounts = new Map()
      for (const row of otherRecords) {
        const key = JSON.stringify([String(row?.time || ''), String(row?.content || '')])
        otherCounts.set(key, (otherCounts.get(key) || 0) + 1)
      }
      return [...counts].every(([key, count]) => (otherCounts.get(key) || 0) >= count)
    })
  }
  const filtered = entries.filter(([name]) => !aliases.has(name) || !aliasIsContained(entries.find(entry => entry[0] === name)))
  const weapon = filtered.find(([name]) => name === '武器')
  const currencyAlias = filtered.find(([name]) => name === '礼包币记录')
  if (weapon && currencyAlias && bh3RecordMultiset(weapon[1]) === bh3RecordMultiset(currencyAlias[1])) {
    return filtered.filter(([name]) => name !== '礼包币记录')
  }
  return filtered
}

/** Build one file understood by both supported import formats (pools and bh3). */
export function buildBh3Export (uid, data, metadata = {}) {
  const uidText = String(uid || '')
  if (!isBh3Uid(uidText)) throw new Error('崩三 UID 格式不正确（应为 8-10 位数字）')
  const sourcePools = data?.data
  if (!sourcePools || typeof sourcePools !== 'object' || Array.isArray(sourcePools)) {
    throw new Error('崩三抽卡记录文件格式不正确')
  }

  const pools = Object.create(null)
  const apkRows = []
  let total = 0
  for (const [poolNameRaw, records] of bh3ExportPools(sourcePools)) {
    const poolName = String(poolNameRaw).trim()
    if (!poolName) continue
    if (records.length > 200000) throw new Error(`${poolName} 记录超过兼容格式单池导入上限`)
    if (!records.length) continue

    const seen = new Map()
    const mysRows = records.map((raw, index) => {
      const time = String(raw?.time || '').replace('T', ' ')
      const content = typeof raw?.content === 'string' ? raw.content : ''
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) {
        throw new Error(`${poolName} 第 ${index + 1} 条记录时间格式不正确`)
      }
      const parsedTime = new Date(`${time.replace(' ', 'T')}Z`)
      if (Number.isNaN(parsedTime.getTime()) || parsedTime.toISOString().slice(0, 19).replace('T', ' ') !== time) {
        throw new Error(`${poolName} 第 ${index + 1} 条记录时间无效`)
      }
      if (!content.trim() || content.length > 500) {
        throw new Error(`${poolName} 第 ${index + 1} 条记录内容为空或过长`)
      }

      const row = { time, content }
      const key = JSON.stringify([time, content])
      const occurrence = (seen.get(key) || 0) + 1
      seen.set(key, occurrence)
      const item = bh3ItemFields(content)
      const apkType = bh3ApkPoolType(poolName)
      apkRows.push({
        uid: uidText,
        id: bh3SyntheticId(uidText, poolName, row, occurrence),
        gacha_type: apkType,
        uigf_gacha_type: apkType,
        item_id: '',
        name: item.name,
        item_type: item.item_type,
        rank_type: bh3RankForItem(item, metadata),
        time,
        count: '1',
        content,
        pool_name: poolName,
      })
      return row
    })
    pools[poolName] = { name: poolName, records: mysRows }
    total += mysRows.length
  }

  if (!total) throw new Error('没有可导出的崩三抽卡记录')
  apkRows.sort((a, b) => a.time.localeCompare(b.time) || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
  const timestamp = Math.floor(Date.now() / 1000)
  return {
    uid: uidText,
    game: 'bh3',
    updatedAt: data.data_time || '',
    pools,
    info: {
      uid: uidText,
      version: 'v4.2',
      export_timestamp: String(timestamp),
      export_app: 'HoYoGet',
      export_app_version: 'HoYoGet',
    },
    bh3: [{ uid: uidText, timezone: 8, lang: 'zh-cn', list: apkRows }],
  }
}

function collectBh3 () {
  const result = new Map()
  for (const uid of listFiles(BH3_DIR)) {
    if (!isBh3Uid(uid)) continue
    const data = readJson(path.join(BH3_DIR, uid, 'gacha_logs.json'))
    if (!data?.data || typeof data.data !== 'object') continue
    const count = bh3ExportPools(data.data).reduce((sum, [, records]) => sum + records.length, 0)
    if (count) result.set(uid, { data, count, source: 'HoYoGet 崩三逐抽记录' })
  }
  return result
}

/** 收集某个游戏本地有数据的 UID 及各自的 UIGF list */
function collect (game) {
  const result = new Map() // uid -> { list, source }
  if (game === 'sr') {
    for (const f of listFiles(SR_DIR)) {
      const m = /^sr_(\d{6,12})_full\.json$/.exec(f)
      if (m) {
        const data = readJson(path.join(SR_DIR, f))
        const list = srFullToList(data)
        if (list.length) result.set(m[1], { list, source: '小助手全量' })
      }
    }
    // summary: data/sr_gacha/<uid>/<qq>/summary.json
    for (const uidDir of listFiles(SR_DIR)) {
      if (!isUid(uidDir)) continue
      for (const qqDir of listFiles(path.join(SR_DIR, uidDir))) {
        const sum = readJson(path.join(SR_DIR, uidDir, qqDir, 'summary.json'))
        if (!sum) continue
        const list = srSummaryToList(sum, uidDir)
        if (!list.length) continue
        const prev = result.get(uidDir)
        // 全量优先；没有全量才用 summary
        if (!prev) result.set(uidDir, { list, source: '在线统计' })
      }
    }
  } else if (game === 'zzz') {
    const pluginDir = path.join(ZZZ_DIR, 'zzz_plugin')
    for (const f of listFiles(pluginDir)) {
      const m = /^(\d{6,12})\.json$/.exec(f)
      if (!m) continue
      const data = readJson(path.join(pluginDir, f))
      const list = zzzFullToList(data, m[1])
      if (list.length) result.set(m[1], { list, source: 'ZZZ-Plugin 逐抽' })
    }
    for (const qqDir of listFiles(ZZZ_DIR)) {
      if (!isUid(qqDir)) continue // qq 目录本身不是 uid；下面再进 uid
      for (const uidDir of listFiles(path.join(ZZZ_DIR, qqDir))) {
        if (!isUid(uidDir)) continue
        const sum = readJson(path.join(ZZZ_DIR, qqDir, uidDir, 'summary.json'))
        if (!sum) continue
        const list = zzzSummaryToList(sum, uidDir)
        if (list.length && !result.has(uidDir)) result.set(uidDir, { list, source: '在线统计' })
      }
    }
  } else if (game === 'gs') {
    for (const f of listFiles(GS_DIR)) {
      const m = /^(\d{6,12})\.json$/.exec(f)
      if (!m) continue
      const data = readJson(path.join(GS_DIR, f))
      const list = gsToList(data, m[1])
      if (list.length) result.set(m[1], { list, source: '本地五星' })
    }
  }
  return result
}

/** 统一的发文件：优先进群/好友的上传接口，其次文件消息，最后退化成链接/提示 */
async function sendFile (e, file, name) {
  const target = e.isGroup ? e.group : e.friend
  const tryList = []
  // 1) 适配器封装好的 sendFile（群/好友）
  if (target?.sendFile) tryList.push(() => target.sendFile(file, name))
  // 2) 群文件上传（优先放到群文件根）
  if (e.isGroup && e.group?.fs?.upload) tryList.push(() => e.group.fs.upload(file))
  // 3) 直接调 OneBot 上传接口（NapCat 支持 base64，最稳）
  tryList.push(async () => {
    const fs = await import('node:fs')
    const base64 = `base64://${fs.readFileSync(file).toString('base64')}`
    const bot = e.bot || globalThis.Bot?.bots?.[e.self_id] || globalThis.Bot
    if (!bot?.sendApi) throw new Error('无 sendApi')
    if (e.isGroup) {
      return await bot.sendApi('upload_group_file', { group_id: e.group_id, file: base64, name, folder: '' })
    }
    return await bot.sendApi('upload_private_file', { user_id: e.user_id, file: base64, name })
  })
  // 4) 文件消息段（少数适配器支持）
  tryList.push(() => {
    const segment = globalThis.segment
    if (!segment?.file) throw new Error('无 segment.file')
    return e.reply(segment.file(file, name))
  })

  for (const run of tryList) {
    try {
      const ret = await run()
      if (ret !== false && ret !== undefined) {
        logger.mark?.(`[HoYoGet][导出] 已发送文件 ${name}`)
        return true
      }
    } catch (err) {
      logger.debug?.(`[HoYoGet][导出] 发送文件尝试失败：${err?.message || err}`)
    }
  }
  logger.warn?.('[HoYoGet][导出] 所有发送方式都失败')
  return false
}

export class gacha_export extends plugin {
  constructor () {
    super({
      name: '[米哈游]抽卡记录导出',
      dsc: '导出 HoYoGet 独立保存的抽卡记录；崩三文件兼容两种导入格式',
      event: 'message',
      priority: pluginPriority('gacha_export', -900),
      rule: [
        {
          reg: '^[#!！]*(?:(?:崩三|崩坏3|崩坏三|BH3|bh3)[ \t]*(?:导出抽卡记录|抽卡记录导出)|导出(?:崩三|崩坏3|崩坏三|BH3|bh3)抽卡记录)(?:[ \t]+(\\d{8,10}))?[ \t]*$',
          fnc: 'exportBh3Log'
        },
        {
          reg: '^(?:%|％|#?绝区零)?[ \\t]*Moonward导出抽卡记录(?:[ \\t]+(\\d{6,12}))?[ \\t]*$',
          fnc: 'exportMoonwardLog'
        },
        {
          // 指令分发前框架会把星铁前缀 `*` 改写成 `#星铁`、绝区零 `%` 改写成 `#绝区零`，
          // 所以这里同时认原始前缀和改写后的形式。
          reg: '^(?:[#\\*%％]|#?(?:星铁|绝区零|绝区|原神))?[ \\t]*导出抽卡记录(?:[ \\t]+(\\d{6,12}))?[ \\t]*$',
          fnc: 'exportLog'
        },
      ],
    })
  }

  async exportMoonwardLog (e) {
    const msg = String(e.msg || '').trim()
    const m = msg.match(/^(?:%|％|#?绝区零)?[ \t]*Moonward导出抽卡记录(?:[ \t]+(\d{6,12}))?[ \t]*$/i)
    if (!m) return false
    const wantUid = m[1] || ''
    const found = collect('zzz')
    if (!found.size) {
      return e.reply('暂无绝区零抽卡记录，请先更新抽卡记录后再导出。')
    }

    let currentUid = ''
    try {
      const noteUser = await getEventNoteUser(e)
      const selected = String(noteUser?.getUid?.('zzz') || '')
      if (isUid(selected)) currentUid = selected
    } catch {}
    const uid = wantUid || currentUid
    if (!uid) {
      return e.reply(`未找到当前绑定的绝区零 UID。请指定 UID 导出。\n可选：${[...found.keys()].join(' / ')}\n用法：%Moonward导出抽卡记录 <UID>`)
    }

    const externalFullList = externalZzzFullToList(readExternalZzzFull(uid), uid)
    const fullList = found.get(uid)
    const summary = readJson(path.join(ZZZ_DIR, String(e.user_id || ''), uid, 'summary.json'))
    const userList = zzzSummaryToList(summary, uid)
    const hit = mysFullList.length
      ? { list: externalFullList, source: '外部完整逐抽记录' }
      : fullList?.source === 'ZZZ-Plugin 逐抽'
        ? fullList
        : userList.length
          ? { list: userList, source: 'HoYoGet 合并记录（仅摘要）' }
          : fullList
    if (!hit) {
      return e.reply(`没有 UID:${uid} 的绝区零记录。可选：${[...found.keys()].join(' / ')}\n用法：%Moonward导出抽卡记录 ${uid}`)
    }

    const seenIds = new Set()
    const list = hit.list.filter(row => {
      const id = String(row.id || '')
      if (!id || seenIds.has(id)) return false
      seenIds.add(id)
      return true
    }).sort((a, b) => {
      const aid = String(a.id || '')
      const bid = String(b.id || '')
      if (/^\d+$/.test(aid) && /^\d+$/.test(bid)) {
        const aa = BigInt(aid); const bb = BigInt(bid)
        return aa < bb ? 1 : aa > bb ? -1 : 0
      }
      return String(b.time || '').localeCompare(String(a.time || ''))
    }).map(row => ({
      ...row,
      // Moonward's ZZZ schema uses native ranks: S/A/B = 4/3/2.
      rank_type: ({ '5': '4', '4': '3', '3': '2' })[String(row.rank_type)] || String(row.rank_type || ''),
      // Moonward calculates pity from the complete per-pool pull sequence.
      count: '1',
    }))
    const payload = {
      info: {
        version: 'v4.2',
        export_timestamp: Math.floor(Date.now() / 1000),
        export_app: 'HoYoGet',
        export_app_version: 'HoYoGet',
      },
      nap: [{ uid: String(uid), timezone: 8, lang: 'zh-cn', list }],
    }

    fs.mkdirSync(TMP_DIR, { recursive: true })
    const fileName = `HoYoGet_nap_Moonward_${uid}_${Date.now()}.json`
    const file = path.join(TMP_DIR, fileName)
    fs.writeFileSync(file, JSON.stringify(payload, null, '\t'), 'utf8')

    const five = list.filter(row => row.rank_type === '4').length
    const head = `绝区零 UID:${uid} Moonward 抽卡记录导出\n来源：${hit.source}\n共 ${list.length} 条（S级 ${five} 条）`
    const sent = await sendFile(e, file, fileName)
    if (sent) {
      await e.reply(`✅ ${head}\n文件：${fileName}`)
      fs.unlink(file, () => {})
    } else {
      await e.reply(`⚠️ ${head}\n文件发送失败（适配器不支持或网络问题）。已保存在机器人：\n${file}`)
    }
    return true
  }

  async exportBh3Log (e, forcedUid = '') {
    const msg = String(e.msg || '').trim()
    const m = msg.match(/^[#*!%％！]*[ \t]*(?:(?:崩三|崩坏3|崩坏三|BH3|bh3)[ \t]*(?:导出抽卡记录|抽卡记录导出)|导出(?:崩三|崩坏3|崩坏三|BH3|bh3)抽卡记录|导出抽卡记录)(?:[ \t]+(\d{8,10}))?[ \t]*$/)
    if (!m && !forcedUid) return false
    const wantUid = forcedUid || m?.[1] || ''
    const found = collectBh3()
    if (!found.size) {
      return e.reply('暂无崩三抽卡记录，请先发送【#崩三更新抽卡记录】更新后再导出。')
    }

    let currentUid = ''
    try {
      const noteUser = await getEventNoteUser(e)
      const selected = String(noteUser?.getUid?.('bh3') || '')
      if (isBh3Uid(selected)) currentUid = selected
    } catch {}

    let uid = wantUid || (currentUid && found.has(currentUid) ? currentUid : '')
    if (!uid) {
      uid = [...found.entries()].sort((a, b) => b[1].count - a[1].count)[0][0]
    }
    const hit = found.get(uid)
    if (!hit) {
      const uids = [...found.keys()].join(' / ')
      return e.reply(`没有 UID:${uid} 的崩三记录。可选：${uids}\n用法：#崩三导出抽卡记录 ${uid}`)
    }

    let payload
    try {
      const rankMaps = await getBh3RankMaps()
      payload = buildBh3Export(uid, hit.data, rankMaps)
    } catch (err) {
      logger.warn?.(`[HoYoGet][导出] 崩三 UID:${uid} 记录校验失败：${err?.message || err}`)
      return e.reply(`崩三记录导出失败：${err?.message || err}`)
    }
    const list = payload.bh3[0].list
    logger.mark?.(`[HoYoGet][导出] 崩三 uid=${uid} pools=${Object.keys(payload.pools).length} rows=${list.length}`)
    fs.mkdirSync(TMP_DIR, { recursive: true })
    const fileName = `HoYoGet_bh3_${uid}_${Date.now()}.json`
    const file = path.join(TMP_DIR, fileName)
    fs.writeFileSync(file, JSON.stringify(payload, null, '\t'), 'utf8')

    const rankFilled = list.filter(row => Number(row.rank_type) > 0).length
    const head = `崩三 UID:${uid} 抽卡记录导出\n来源：HoYoGet 本地逐抽记录\n共 ${list.length} 抽，${Object.keys(payload.pools).length} 个卡池\n文件同时兼容两种导入格式。已按崩三百科补齐 ${rankFilled} 条星级；物品 ID 和 UP 标记未补造。`
    if (found.size > 1 && !wantUid) {
      const others = [...found.keys()].filter(key => key !== uid)
      if (others.length) e.reply(`（该账号有多个崩三 UID，已导出记录最多的 ${uid}；其它：${others.join(' / ')}，可加 UID 单独导出）`)
    }
    const sent = await sendFile(e, file, fileName)
    if (sent) {
      await e.reply(`✅ ${head}\n文件：${fileName}`)
      fs.unlink(file, () => {})
    } else {
      await e.reply(`⚠️ ${head}\n文件发送失败（适配器不支持或网络问题）。已保存在机器人：\n${file}`)
    }
    return true
  }

  async exportLog (e) {
    const msg = String(e.msg || '').trim()
    const m = msg.match(/^(?:([#\\*%％])|#?(星铁|绝区零|绝区|原神))?[ \t]*导出抽卡记录(?:[ \t]+(\d{6,12}))?[ \t]*$/)
    if (!m) return false
    const wantUid = m[3] || ''
    // 分发前 `*`/`%` 会被框架改写成 `#星铁`/`#绝区零`，所以游戏不能只看首字符：
    // 优先用 e.game（框架已标好），再看改写后的名称，最后才看原始前缀。
    const raw = m[1] || ''
    let prefix = raw.replace(/^#/, '')
    if (m[2] === '星铁') prefix = '*'
    else if (m[2] === '绝区零' || m[2] === '绝区') prefix = '%'
    else if (m[2] === '原神') prefix = '#'
    if (e?.game === 'bh3') prefix = 'bh3'
    else if (e?.game === 'sr') prefix = '*'
    else if (e?.game === 'zzz') prefix = '%'
    else if (prefix === '％') prefix = '%'
    if (prefix === 'bh3') return this.exportBh3Log(e, wantUid)
    if (!prefix) prefix = '#' // 无前缀 = 原神
    const game = GAMES[prefix] || GAMES['#']
    if (!game) return false

    if (game.key === 'gs' && !fs.existsSync(GS_DIR)) {
      return e.reply('暂无原神抽卡记录。请先发送【#刷新抽卡记录】更新后再导出。')
    }

    const found = collect(game.key)
    if (!found.size) {
      return e.reply(`暂无${game.name}抽卡记录。请先更新后再导出（${game.name}：${prefix}刷新抽卡记录）。`)
    }

    let uid = wantUid
    if (!uid) {
      // 默认选号规则：
      //   1) 优先有「全量逐抽」的号（summary 只有五星/四星，导出会少很多）；
      //   2) 其次按最近抽卡时间；
      //   3) 再次按记录条数。
      const latest = entry => entry.list.reduce((max, x) => (x.time > max ? x.time : max), '')
      const isFull = entry => !/统计/.test(entry.source)
      uid = [...found.entries()].sort((a, b) => {
        const fa = isFull(a[1]) ? 1 : 0; const fb = isFull(b[1]) ? 1 : 0
        if (fa !== fb) return fb - fa
        const ta = latest(a[1]); const tb = latest(b[1])
        if (ta !== tb) return tb > ta ? 1 : -1
        return b[1].list.length - a[1].list.length
      })[0][0]
    }
    const hit = found.get(uid)
    if (!hit) {
      const uids = [...found.keys()].join(' / ')
      return e.reply(`没有 UID:${uid} 的${game.name}记录。可选：${uids}\n用法：${prefix}导出抽卡记录 ${uid}`)
    }
    logger.mark?.(`[HoYoGet][导出] ${game.name} uid=${uid} source=${hit.source} list=${hit.list.length} all=${[...found.entries()].map(([k, v]) => `${k}:${v.list.length}(${v.source})`).join(',')}`)
    if (found.size > 1 && !wantUid) {
      // 提示一下还有别的 UID，避免以为漏了
      const others = [...found.keys()].filter(k => k !== uid)
      if (others.length) e.reply(`（该账号有多个${game.name} UID，已导出记录最多的 ${uid}；其它：${others.join(' / ')}，可加 UID 单独导出）`)
    }

    const seenIds = new Set()
    const uniqueRows = game.key === 'zzz'
      ? hit.list.filter(row => {
          const id = String(row.id || '')
          if (!id || seenIds.has(id)) return false
          seenIds.add(id)
          return true
        })
      : hit.list
    const list = [...uniqueRows].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
    const payload = {
      info: {
        uid: String(uid),
        lang: 'zh-cn',
        uigf_version: 'v2.3',
        export_time: now(),
        export_app: 'HoYoGet',
        export_app_version: 'HoYoGet',
        ...(game.key === 'zzz' ? { zzz_gacha_type_map: 'uigf-v4' } : {}),
      },
      list,
    }

    fs.mkdirSync(TMP_DIR, { recursive: true })
    const fileName = `HoYoGet_${game.prefix}_${uid}_${Date.now()}.json`
    const file = path.join(TMP_DIR, fileName)
    fs.writeFileSync(file, JSON.stringify(payload, null, '\t'), 'utf8')

    const five = list.filter(x => x.rank_type === '5').length
    // summary 只有五星/四星，缺 3 星逐抽；导入目标工具后会被当成「每金一抽」。给个明确警告。
    const partial = /统计/.test(hit.source) && !list.some(x => String(x.rank_type) === '3')
    const warn = partial
      ? `${'\n'}⚠️ 本次是「五星/四星统计」版，缺少三星逐抽，导入目标工具会显示异常（像每金一抽）。建议先更新全量记录再导出。`
      : ''
    const head = `${game.name} UID:${uid} 抽卡记录导出${'\n'}来源：HoYoGet（${hit.source}）${'\n'}共 ${list.length} 条（五星 ${five} 条）${warn}`
    // 先发文件，成功了再说「成功」；文件发不出去就把保存路径给出来，别让人以为发出去了。
    const sent = await sendFile(e, file, fileName)
    if (sent) {
      await e.reply(`✅ ${head}\n文件：${fileName}`)
      fs.unlink(file, () => {})
    } else {
      await e.reply(`⚠️ ${head}\n文件发送失败（适配器不支持或网络问题）。已保存在机器人：\n${file}`)
    }
    return true
  }
}
