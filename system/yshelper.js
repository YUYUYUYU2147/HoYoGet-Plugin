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

export const __test = { roleSelect, yshelperRankForChar, rowsOf }
