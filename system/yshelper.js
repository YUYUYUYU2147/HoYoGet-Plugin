import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://api.yshelper.com/ys/'
const CACHE_DIR = path.join(PLUGIN_ROOT, 'data', 'yshelper')
const SELECT_CACHE = path.join(CACHE_DIR, 'roles.json')
const TTL = 6 * 3600 * 1000

let SELECT = null
let SELECT_AT = 0
const RANK_MEM = new Map()
const INFLIGHT = new Map()

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return null
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  } catch (err) {
    globalThis.logger?.debug?.(`[HoYoGet][yshelper] 写入缓存失败：${err?.message || err}`)
  }
}

async function request(route, { method = 'GET', body } = {}) {
  const url = new URL(route, ORIGIN)
  if (method === 'GET' && body) {
    for (const [k, v] of Object.entries(body)) url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    method,
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Referer: 'https://www.yshelper.com/',
      Accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {}),
  })
  if (!res.ok) throw new Error(`提瓦特小助手 HTTP ${res.status}`)
  const json = await res.json()
  if (json?.code !== 200) throw new Error(`提瓦特小助手返回异常：${json?.result || json?.code || '未知'}`)
  return json
}

function norm(v) {
  return String(v || '').replace(/\s+/g, '').toLowerCase()
}

async function roleSelect() {
  if (SELECT && Date.now() - SELECT_AT < TTL) return SELECT
  const cached = readJson(SELECT_CACHE)
  if (cached?.data && Date.now() - Number(cached.at || 0) < TTL) {
    SELECT = cached.data
    SELECT_AT = Number(cached.at) || Date.now()
    return SELECT
  }
  try {
    const json = await request('getRankSelectList.php', { body: { type: 'role', lang: 'zh-Hans' } })
    const list = Array.isArray(json?.result) ? json.result : []
    if (list.length) {
      SELECT = list
      SELECT_AT = Date.now()
      writeJson(SELECT_CACHE, { at: SELECT_AT, data: list })
      return SELECT
    }
  } catch (err) {
    globalThis.logger?.mark?.(`[HoYoGet][yshelper] 角色列表获取失败，改用缓存：${err?.message || err}`)
  }
  SELECT = Array.isArray(cached?.data) ? cached.data : []
  SELECT_AT = Number(cached?.at) || Date.now()
  return SELECT
}

function maskUid(row) {
  if (row?.uid_str) return String(row.uid_str)
  const uid = String(row?.uid || '')
  return uid.length > 6 ? `${uid.slice(0, 5)}***${uid.slice(-1)}` : uid
}

function bigNum(v) {
  const n = Number(v) || 0
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return String(Math.round(n))
}

function consText(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n >= 6 ? '满命' : `${n}命`
}

function rowsOf(list, limit) {
  return (Array.isArray(list) ? list : []).slice(0, limit).map((r) => ({
    rank: Number(r?.no) || 0,
    uid: maskUid(r),
    consText: consText(r?.role_class),
    artifact: Number(r?.artifacts) || 0,
    damageText: bigNum(r?.damage),
  }))
}

async function postRank(role, type) {
  const json = await request('getRoleRank.php?lang=zh-Hans', {
    method: 'POST',
    body: {
      p: 1,
      type,
      role: role.val,
      role_class: '不限命座',
      artifacts: role.select?.[0] || '全部圣遗物',
      weapon: '全部武器',
      weapon_class: '精炼等阶',
    },
  })
  return Array.isArray(json?.result) ? json.result : []
}

async function fetchRank(name, limit) {
  const all = await roleSelect()
  const key = norm(name)
  const role = all.find(r => [r?.chn_name, r?.tit, r?.val].some(v => norm(v) === key))
  if (!role) return null

  const [damage, artifacts] = await Promise.allSettled([
    postRank(role, 'damage'),
    postRank(role, 'artifacts'),
  ])
  const damageRows = rowsOf(damage.status === 'fulfilled' ? damage.value : [], limit)
  const artifactRows = rowsOf(artifacts.status === 'fulfilled' ? artifacts.value : [], limit)
  if (!damageRows.length && !artifactRows.length) {
    const err = damage.status === 'rejected' ? damage.reason : artifacts.reason
    throw err || new Error('提瓦特小助手排行榜为空')
  }
  return {
    name: role.chn_name || role.tit || name,
    avatar: role.avatar || '',
    damage: damageRows,
    artifacts: artifactRows,
    at: Date.now(),
  }
}

export async function yshelperRankForChar(name, { limit = 5 } = {}) {
  const charName = String(name || '').trim()
  if (!charName) return null
  const key = `${charName}|${limit}`
  const mem = RANK_MEM.get(key)
  if (mem && Date.now() - mem.at < TTL) return mem.data

  const file = path.join(CACHE_DIR, `role-${encodeURIComponent(charName)}-${limit}.json`)
  const cached = readJson(file)
  if (cached?.data && Date.now() - Number(cached.at || 0) < TTL) {
    RANK_MEM.set(key, { at: Number(cached.at) || Date.now(), data: cached.data })
    return cached.data
  }

  if (INFLIGHT.has(key)) return INFLIGHT.get(key)
  const task = (async () => {
    try {
      const data = await fetchRank(charName, limit)
      if (!data) return null
      RANK_MEM.set(key, { at: data.at, data })
      writeJson(file, { at: data.at, data })
      return data
    } catch (err) {
      globalThis.logger?.mark?.(`[HoYoGet][yshelper] ${charName} 排行获取失败，改用缓存：${err?.message || err}`)
      if (cached?.data) return { ...cached.data, offline: true }
      return null
    } finally {
      INFLIGHT.delete(key)
    }
  })()
  INFLIGHT.set(key, task)
  return task
}

const ABYSS_MEM = new Map()

/**
 * 原神深渊（深境螺旋）角色使用率统计。
 * 数据源：提瓦特小助手 getAbyssRank.php。
 * 返回按 S+/S/A/B/C 分级的角色使用率榜（头像 / 使用率 / 持有率 / 命座分布）。
 * @param {object} opts
 * @param {number} opts.schedule 1=本期 2=上期
 */
async function fetchAbyssRank({ schedule = 1 } = {}) {
  const json = await request('getAbyssRank.php', {
    body: { lang: 'zh-Hans', schedule: String(schedule) },
  })
  const rawResult = json?.result
  // result 是 PHP 关联数组序列化：每个元素是 {0:{rank_name,list},1:{...}}，
  // 真正分组在 Object.values 里，需展平一层。
  const flat = []
  if (Array.isArray(rawResult)) {
    for (const item of rawResult) {
      if (item && typeof item === 'object') flat.push(...Object.values(item))
      else if (item?.rank_name) flat.push(item)
    }
  } else if (rawResult && typeof rawResult === 'object') {
    flat.push(...Object.values(rawResult))
  }
  if (!flat.length) throw new Error('深渊使用率数据为空')
  const groups = flat.map(g => ({
    rankName: g?.rank_name || '',
    rankClass: g?.rank_class || '',
    list: (g?.list || []).map(r => ({
      name: r?.name || '',
      ename: r?.ename || '',
      star: Number(r?.star) || 0,
      useRate: Number(r?.use_rate) || 0,
      ownRate: Number(r?.own_rate) || 0,
      use: Number(r?.use) || 0,
      avatar: r?.avatar || '',
      c0Rate: Number(r?.c0_rate) || 0,
      c6Rate: Number(r?.c6_rate) || 0,
    })),
  })).filter(g => g.list.length)
  return {
    title: json?.title || '',
    version: json?.version || '',
    lastUpdate: json?.last_update || '',
    topOwn: Number(json?.top_own) || 0,
    star36Rate: Number(json?.star36_rate) || 0,
    groups,
    historyList: Array.isArray(json?.history_list) ? json.history_list : [],
    at: Date.now(),
  }
}

export async function yshelperAbyssRank({ schedule = 1, force = false } = {}) {
  const key = `abyss:${schedule}`
  const mem = ABYSS_MEM.get(key)
  if (!force && mem && Date.now() - mem.at < TTL) return mem.data

  const file = path.join(CACHE_DIR, `abyss-${schedule}.json`)
  const cached = readJson(file)
  if (!force && cached?.data && Date.now() - Number(cached.at || 0) < TTL) {
    ABYSS_MEM.set(key, { at: Number(cached.at) || Date.now(), data: cached.data })
    return cached.data
  }

  if (INFLIGHT.has(key)) return INFLIGHT.get(key)
  const task = (async () => {
    try {
      const data = await fetchAbyssRank({ schedule })
      ABYSS_MEM.set(key, { at: data.at, data })
      writeJson(file, { at: data.at, data })
      return data
    } catch (err) {
      globalThis.logger?.mark?.(`[HoYoGet][yshelper] 深渊使用率获取失败，改用缓存：${err?.message || err}`)
      if (cached?.data) return { ...cached.data, offline: true }
      return null
    } finally {
      INFLIGHT.delete(key)
    }
  })()
  INFLIGHT.set(key, task)
  return task
}

export const __test = { roleSelect, yshelperRankForChar, rowsOf, yshelperAbyssRank }
