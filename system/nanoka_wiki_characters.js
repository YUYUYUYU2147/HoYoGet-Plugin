/**
 * Nanoka 角色资料（原神 / 星铁 / 绝区零）在线补全 + 本地缓存。
 *
 * 数据流（与 Nanoka 静态站一致）：
 *   manifest.json → {gi|hsr|zzz}/{版本}/character.json → {gi|hsr|zzz}/{版本}/zh/character/{id}.json
 *
 * 为什么要本地缓存：
 *   - 角色详情 100KB 左右，图鉴/面板/日历多处会用，重复请求又慢又容易被 Cloudflare 限。
 *   - 本地 miao meta（resources/meta-{gs,sr}/character/<名>/data.json）或绝区零本地快照
 *     （resources/zzz_nanoka/character/<id>.json）字段不全时
 *     （新角色常见 cncv / jpcv / 称号 / 命座缺失），用在线详情补空。
 *   - 缓存落在 data/panel/wiki-characters，卸载重装不用重新拉。
 *
 * 缓存结构：
 *   data/panel/wiki-characters/manifest.json
 *   data/panel/wiki-characters/{gi|hsr|zzz}/{版本}/character.json
 *   data/panel/wiki-characters/{gi|hsr|zzz}/{版本}/zh/character/{id}.json
 *
 * 所有缓存文件都是 { at, data }，读取失败/过期时优先返回旧数据（stale），
 * 不因为一次网络抖动让图鉴直接缺块。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES_ROOT = path.join(PLUGIN_ROOT, 'resources')
const CACHE_ROOT = path.join(PLUGIN_ROOT, 'data', 'panel', 'wiki-characters')
const BASE = 'https://static.nanoka.cc'

const SITE = { gs: 'gi', sr: 'hsr', zzz: 'zzz' }
const GAME_NAME = { gs: '原神', sr: '星铁', zzz: '绝区零' }
const TTL = {
  manifest: 6 * 3600 * 1000,
  catalog: 24 * 3600 * 1000,
  detail: 24 * 3600 * 1000,
}

const ELEM_CN = {
  pyro: '火', hydro: '水', cryo: '冰', electro: '雷',
  anemo: '风', geo: '岩', dendro: '草', physical: '物理',
}

const PLACEHOLDER = /^(?:[?？\s]+|[-—–]{1,}|0-0|测试角色|TestKey_PlaceHolder|未知|暂无)$/i

/** 值是否算「有内容」；占位符、空串、空数组/对象都算缺失 */
export function meaningful(value) {
  if (value == null) return false
  if (typeof value === 'string') return !PLACEHOLDER.test(value.trim()) && value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'object') return Object.keys(value).length > 0
  return Boolean(value)
}

const cleanName = value => String(value || '')
  .replace(/^(?:\(Test\d+\)\s*)+/i, '')
  .replace(/[\s·•・\-—_「」『』《》【】\[\]（）()]/g, '')
  .toLowerCase()

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeJsonFile(file, payload) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
  } catch (err) {
    globalThis.logger?.debug?.(`[HoYoGet][nanoka] 写入缓存失败 ${file}: ${err?.message || err}`)
  }
}

async function fetchJson(url, timeout = 15000) {
  let lastErr = null
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 350 * attempt))
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://static.nanoka.cc/' },
        signal: AbortSignal.timeout(timeout),
      })
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`)
        err.status = res.status
        throw err
      }
      const text = await res.text()
      if (!/^\s*[[{]/.test(text)) throw new Error('返回的不是 JSON')
      return JSON.parse(text)
    } catch (err) {
      lastErr = err
      if (err?.status === 404) break
    }
  }
  throw lastErr || new Error('nanoka 请求失败')
}

/** 读缓存 → 过期则在线拉 → 失败时回退旧缓存 */
async function readThrough(file, url, ttl, validate = () => true) {
  const saved = readJsonFile(file)
  if (saved?.data && Date.now() - Number(saved.at || 0) < ttl) {
    try {
      validate(saved.data)
      return { data: saved.data, at: Number(saved.at) || 0, stale: false }
    } catch { /* 缓存内容不合法，重新拉 */ }
  }
  try {
    const data = await fetchJson(url)
    if (!data || typeof data !== 'object') throw new Error('无效数据')
    validate(data)
    const at = Date.now()
    writeJsonFile(file, { at, data })
    return { data, at, stale: false }
  } catch (err) {
    if (saved?.data) {
      try {
        validate(saved.data)
        globalThis.logger?.warn?.(`[HoYoGet][nanoka] ${url} 请求失败，使用缓存：${err?.message || err}`)
        return { data: saved.data, at: Number(saved.at) || 0, stale: true }
      } catch { /* 旧缓存也不可用 */ }
    }
    throw err
  }
}

export async function nanokaManifest() {
  return readThrough(
    path.join(CACHE_ROOT, 'manifest.json'),
    `${BASE}/manifest.json`,
    TTL.manifest,
    data => !!data && typeof data === 'object' && Object.keys(data).length > 0,
  )
}

function versionsOf(manifest, game) {
  const info = manifest?.[SITE[game]] || {}
  return [...new Set([info.latest, info.live].filter(Boolean).map(String))]
}

async function nanokaVersions(game) {
  const { data, stale } = await nanokaManifest()
  const versions = versionsOf(data, game)
  if (!versions.length) throw new Error(`nanoka manifest 里没有 ${GAME_NAME[game] || game} 的版本号`)
  return { versions, stale }
}

export async function nanokaCatalog(game, version) {
  const site = SITE[game]
  if (!site || !version) throw new Error('无效的 nanoka 游戏/版本')
  return readThrough(
    path.join(CACHE_ROOT, site, version, 'character.json'),
    `${BASE}/${site}/${version}/character.json`,
    TTL.catalog,
    data => !!data && typeof data === 'object' && Object.keys(data).length > 0,
  )
}

export async function nanokaCharacterDetail(game, version, id) {
  const site = SITE[game]
  if (!site || !version || id == null) throw new Error('无效的 nanoka 角色参数')
  return readThrough(
    path.join(CACHE_ROOT, site, version, 'zh', 'character', `${id}.json`),
    `${BASE}/${site}/${version}/zh/character/${id}.json`,
    TTL.detail,
    data => !!data && !!data.name,
  )
}

/* ───────────── 本地 miao meta ───────────── */

function localIndex(game) {
  return readJsonFile(path.join(RES_ROOT, `meta-${game}`, 'character', 'data.json')) || {}
}

function findLocalIndexEntry(index, { id, name }) {
  const rows = Object.entries(index || {})
  if (id != null) {
    const hit = rows.find(([key, row]) => String(key) === String(id) || String(row?.id) === String(id))
    if (hit) return { key: hit[0], row: hit[1] }
  }
  const target = cleanName(name)
  if (!target) return null
  let hit = rows.find(([, row]) => cleanName(row?.name) === target || cleanName(row?.abbr) === target)
  if (!hit) {
    hit = rows.find(([, row]) => {
      const n = cleanName(row?.name)
      return n && (n.includes(target) || target.includes(n))
    })
  }
  return hit ? { key: hit[0], row: hit[1] } : null
}

/* 绝区零本地资料：resources/zzz_nanoka/character/<id>.json（Nanoka 详情快照）。
   文件名是编号，没有索引；首次按名字查找时读一遍目录并缓存，之后 O(1)。 */
let zzzLocalIndexCache = null

function zzzLocalDir() {
  return path.join(RES_ROOT, 'zzz_nanoka', 'character')
}

function zzzLocalIndex() {
  if (zzzLocalIndexCache) return zzzLocalIndexCache
  const index = new Map()
  const dir = zzzLocalDir()
  let files = []
  try { files = fs.readdirSync(dir).filter(name => name.endsWith('.json')) } catch { files = [] }
  for (const file of files) {
    const id = file.replace(/\.json$/i, '')
    const data = readJsonFile(path.join(dir, file))
    if (!data) continue
    const row = { id: String(data.id ?? id), name: data.partner_info?.full_name || data.name || '', data, file: path.join(dir, file) }
    for (const key of [row.id, row.name, data.name, data.code_name]) {
      const k = cleanName(key)
      if (k && !index.has(k)) index.set(k, row)
    }
  }
  zzzLocalIndexCache = { index, rows: [...index.values()] }
  return zzzLocalIndexCache
}

function readLocalZzz(query = {}) {
  const { index, rows } = zzzLocalIndex()
  if (query.id != null) {
    const hit = index.get(cleanName(query.id)) || rows.find(row => String(row.id) === String(query.id))
    if (hit) return hit
    // 编号文件存在但尚未建索引（目录里新增了文件）时直接读一次
    const file = path.join(zzzLocalDir(), `${query.id}.json`)
    const data = readJsonFile(file)
    if (data) return { id: String(data.id ?? query.id), name: data.name || '', data, file }
  }
  const key = cleanName(query.name)
  if (!key) return null
  const direct = index.get(key)
  if (direct) return direct
  const hit = rows.find(row => {
    const n = cleanName(row.name)
    return n && (n.includes(key) || key.includes(n))
  })
  return hit || null
}

/**
 * 读取本地角色资料（resources/meta-{gs,sr}/character/<名>/data.json）。
 * 支持按 id / 正式名 / 简称查；旅行者这类主目录下再分元素子目录的，
 * 优先用主 data.json，没有则取第一个子目录。
 */
export function readLocalCharacter(game, query = {}) {
  if (game === 'zzz') return readLocalZzz(query)
  if (!['gs', 'sr'].includes(game)) return null
  const index = localIndex(game)
  const hit = findLocalIndexEntry(index, query)
  const root = path.join(RES_ROOT, `meta-${game}`, 'character')
  const names = []
  if (hit?.row?.name) names.push(hit.row.name)
  if (query.name) names.push(String(query.name))
  if (hit?.row?.abbr) names.push(hit.row.abbr)

  for (const name of [...new Set(names.filter(Boolean))]) {
    const dir = path.join(root, name)
    const main = path.join(dir, 'data.json')
    const data = readJsonFile(main)
    if (data) return { id: String(data.id ?? hit?.row?.id ?? hit?.key ?? ''), name: data.name || name, data, file: main }
    try {
      const sub = fs.readdirSync(dir, { withFileTypes: true }).find(e => e.isDirectory())
      if (sub) {
        const file = path.join(dir, sub.name, 'data.json')
        const subData = readJsonFile(file)
        if (subData) return { id: String(subData.id ?? hit?.row?.id ?? hit?.key ?? ''), name: subData.name || name, data: subData, file }
      }
    } catch { /* 目录不存在 */ }
  }
  return null
}

/** 本地资料缺失的字段（用于决定是否需要在线补全） */
export function missingLocalFields(game, local) {
  const data = local?.data || local
  if (!data) return ['*']
  const missing = []
  const check = (key, value = data[key]) => { if (!meaningful(value)) missing.push(key) }
  if (game === 'zzz') {
    for (const key of ['name', 'rarity', 'element_type', 'weapon_type', 'camp', 'skill', 'talent', 'passive', 'level', 'stats', 'partner_info', 'icon']) {
      check(key)
    }
    return missing
  }
  for (const key of ['name', 'title', 'elem', 'weapon', 'birth', 'astro', 'desc', 'cncv', 'jpcv', 'materials', 'talent', 'cons', 'attr']) {
    check(key)
  }
  if (game === 'gs') {
    if (!meaningful(data.allegiance)) missing.push('allegiance')
    if (!Array.isArray(data.passive) || !data.passive.some(x => meaningful(x?.name))) missing.push('passive')
  }
  return missing
}

export function needsOnlineCharacter(game, local) {
  return missingLocalFields(game, local).length > 0
}

/* ───────────── 在线查询与合并 ───────────── */

function catalogEntry(catalog, { id, name }) {
  const rows = Object.entries(catalog || {})
  if (id != null) {
    const hit = rows.find(([key, row]) => String(key) === String(id) || String(row?.id) === String(id))
      || rows.find(([key]) => String(key).split('-')[0] === String(id).split('-')[0])
    if (hit) return { id: String(hit[0]), row: hit[1] }
  }
  const target = cleanName(name)
  if (!target) return null
  const hit = rows.find(([, row]) => {
    const idText = String(row?.id || '')
    return [row?.zh, row?.en, idText].some(v => cleanName(v) === target)
  }) || rows.find(([, row]) => {
    const n = cleanName(row?.zh)
    return n && (n.includes(target) || target.includes(n))
  })
  if (!hit) return null
  return { id: String(hit[0]).split('-')[0], row: hit[1] }
}

/**
 * 按 id 或名字从 Nanoka 拉角色详情（带缓存）。
 * @returns {Promise<{id:string, version:string, data:object, stale:boolean}>}
 */
export async function getNanokaCharacter(game, query = {}) {
  if (!SITE[game]) throw new Error(`不支持的游戏：${game}`)
  const local = query.local ?? readLocalCharacter(game, query)
  const id = query.id != null ? String(query.id) : (local?.id ? String(local.id) : '')
  let versions = []
  if (query.version) versions = [String(query.version)]
  else versions = (await nanokaVersions(game)).versions

  let lastErr = null
  for (const version of versions) {
    let catalog = null
    try {
      if (id) {
        try {
          const detail = await nanokaCharacterDetail(game, version, id)
          return { id: String(id), version, data: detail.data, row: null, stale: detail.stale }
        } catch (err) {
          if (Number(err?.status) !== 404) throw err
          /* 本地 id 与 Nanoka 不一致（旅行者/奇偶等多形态）时，按目录再匹配一次 */
          catalog = await nanokaCatalog(game, version)
          const entry = catalogEntry(catalog.data, { id, name: query.name || local?.name })
          if (entry) {
            const detail = await nanokaCharacterDetail(game, version, entry.id)
            return { id: String(entry.id), version, data: detail.data, row: entry.row, stale: detail.stale }
          }
          lastErr = err
          continue
        }
      }
      catalog ||= await nanokaCatalog(game, version)
      const entry = catalogEntry(catalog.data, query)
      if (!entry) continue
      const detail = await nanokaCharacterDetail(game, version, entry.id)
      return { id: String(entry.id), version, data: detail.data, row: entry.row, stale: detail.stale }
    } catch (err) {
      lastErr = err
      if (Number(err?.status) !== 404) break
    }
  }
  throw lastErr || new Error(`Nanoka 未收录「${query.name || query.id || ''}」`)
}

/**
 * 在线详情 + 本地资料合并。
 *
 * 在线详情作为完整骨架（技能/命座/材料都在里面），本地 miao 资料覆盖自己
 * 有值的字段；本地为空或占位符时保留在线值。这样新角色本地只有半套数据时，
 * 图鉴仍然能显示完整内容。
 */
export function enrichNanokaCharacter(game, id, detail, localInput) {
  if (!detail) return detail
  const local = localInput ?? readLocalCharacter(game, { id, name: detail.name })
  if (!local?.data) return detail
  const d = local.data
  const out = { ...detail }
  out.chara_info = { ...(detail.chara_info || {}) }
  out.chara_info.va = { ...(out.chara_info.va || {}) }

  const set = (obj, key, value) => { if (meaningful(value)) obj[key] = value }
  const textOf = value => Array.isArray(value) ? value.join('\n') : String(value ?? '')
  out.name = String(d.name || out.name || '').replace(/^(?:\(Test\d+\)\s*)+/i, '').trim()
  set(out, 'name', out.name)
  set(out, 'desc', d.desc)
  set(out, 'rarity', meaningful(detail.rarity) ? undefined : d.star)
  set(out.chara_info, 'title', d.title)
  set(out.chara_info, 'native', d.allegiance)
  set(out.chara_info, 'constellation', d.astro)
  set(out.chara_info, 'detail', d.desc)
  set(out.chara_info.va, 'chinese', d.cncv)
  set(out.chara_info.va, 'japanese', d.jpcv)
  if (!meaningful(out.chara_info.vision) && ELEM_CN[d.elem]) out.chara_info.vision = ELEM_CN[d.elem]

  if (!meaningful(out.chara_info.birth) && meaningful(d.birth)) {
    const m = String(d.birth).match(/^(\d{1,2})[-/月](\d{1,2})/)
    if (m) out.chara_info.birth = [Number(m[1]), Number(m[2])]
  }

  /* 基础属性：本地 attr 有 90 级完整表，在线缺值时补上 */
  const attr90 = d.attr?.details?.['90']
  const attr100 = d.attr?.details?.['100']
  if (Array.isArray(attr90)) {
    if (!meaningful(out.base_hp)) out.base_hp = attr90[0]
    if (!meaningful(out.base_atk)) out.base_atk = attr90[1]
    if (!meaningful(out.base_def)) out.base_def = attr90[2]
    if (!meaningful(out.crit_dmg)) {
      const idx = Array.isArray(d.attr?.keys) ? d.attr.keys.indexOf('cdmg') : -1
      const grow = idx >= 0 ? Number(attr90[idx]) : 0
      out.crit_dmg = `${(50 + (Number.isFinite(grow) ? grow : 0)).toFixed(1).replace(/\.0$/, '')}%`
    }
  } else if (d.baseAttr) {
    if (!meaningful(out.base_hp)) out.base_hp = d.baseAttr.hp
    if (!meaningful(out.base_atk)) out.base_atk = d.baseAttr.atk
    if (!meaningful(out.base_def)) out.base_def = d.baseAttr.def
  }
  if (!meaningful(out.crit_rate)) out.crit_rate = '5%'
  if (Array.isArray(attr100) && !meaningful(out.stamina_recovery)) {
    /* 暂无可用的体力回复字段，不硬编 */
  }

  /* 命座/天赋：在线缺条目时用本地补齐，名称/描述只补空位 */
  const cons = Array.isArray(out.constellations) ? out.constellations.slice() : []
  for (let i = 1; i <= 6; i++) {
    const lc = d.cons?.[String(i)] || d.cons?.[i]
    if (!lc) continue
    const cur = cons[i - 1]
    if (!cur) {
      cons[i - 1] = { name: lc.name || '', desc: textOf(lc.desc), param_list: [] }
    } else {
      if (!meaningful(cur.name)) cur.name = lc.name || ''
      if (!meaningful(cur.desc)) cur.desc = textOf(lc.desc)
    }
  }
  if (cons.length) out.constellations = cons.filter((x, i) => x && (meaningful(x.name) || i < 6))

  const passives = Array.isArray(out.passives) ? out.passives.slice() : []
  const known = new Set(passives.map(p => cleanName(p?.name)).filter(Boolean))
  for (const p of (Array.isArray(d.passive) ? d.passive : [])) {
    const key = cleanName(p?.name)
    if (!key || known.has(key)) continue
    passives.push({ name: p.name, desc: textOf(p.desc), unlock: '' })
  }
  if (passives.length) out.passives = passives

  return out
}

function looksTestCharacter(data) {
  if (!data) return false
  try {
    return /\(Test\d+\)/i.test(JSON.stringify({
      skill: data.skill,
      talent: data.talent,
      passive: data.passive,
    }).slice(0, 200000))
  } catch {
    return false
  }
}

/**
 * 图鉴/面板统一入口：本地优先，缺字段时在线补全。
 *
 * @returns {Promise<{game,id,name,local,online,detail,version,source,missing}>}
 */
export async function getWikiCharacter(game, query = {}) {
  const local = query.local ?? readLocalCharacter(game, query)
  const missing = local ? missingLocalFields(game, local) : ['*']
  /* 绝区零本地快照就是 Nanoka 详情的同构数据，字段齐全时可直接渲染，不联网。 */
  if (game === 'zzz' && local?.data && !missing.length) {
    return {
      game,
      id: local.id,
      name: local.name || local.data.name || '',
      local: local.data,
      online: null,
      detail: local.data,
      version: '',
      source: '本地资料',
      missing,
      unreleased: looksTestCharacter(local.data),
    }
  }
  const online = await getNanokaCharacter(game, { ...query, local })
  const detail = enrichNanokaCharacter(game, online.id, online.data, local)
  return {
    game,
    id: online.id,
    name: detail.name || local?.name || query.name || '',
    local: local?.data || null,
    online: online.data,
    detail,
    version: online.version,
    source: `Nanoka · ${online.version}${online.stale ? '（缓存）' : ''}`,
    missing,
    unreleased: looksTestCharacter(detail),
  }
}

export const __test = { cleanName, catalogEntry, versionsOf, CACHE_ROOT }
