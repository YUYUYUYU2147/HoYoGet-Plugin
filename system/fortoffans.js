/**
 * fort off fans（https://hsr.fortoffans.com）星铁全球榜数据访问层。
 *
 * 该站是 SvelteKit 的 SSR 站点，没有公开 JSON API —— 榜单数据直接序列化
 * 在 leaderboard 页面的 HTML 里（SvelteKit 水合用的 data 对象）。所以这里
 * 抓 HTML，再用括号配对提取 `{type:"data",data:{...}}` 这段 JS 对象字面量，
 * `new Function` 求值拿到结构化数据。
 *
 * data 对象里关键字段：
 *   entries[]     榜单条目（每页 100 条）
 *   avatarMap{}   角色 id → { name, element }（完整角色表）
 *   page / pageSize / total   分页与总数
 *   charId / stat / setId / eidKey / elKey / pathKey   当前筛选条件
 *
 * 榜单条目字段（按 stat 排序，默认 stat_tcv = CRIT Value）：
 *   uid, nickname, avatar_id, char_name, char_element, char_path,
 *   char_level, eidolon, rank,
 *   stat_tcv, stat_crit_rate, stat_crit_dmg, stat_spd, stat_atk, stat_hp,
 *   stat_def, stat_break_effect, stat_effect_hit, stat_healing_boost,
 *   stat_crit_value, stat_elation, ...（还有 sub_* 副词条、wrqs 遗器分）
 *   lc_id, lc_name, lc_level, lc_superimpose,  relics[],  updated_at
 *
 * URL 参数（与页面筛选一一对应）：
 *   tab=characters  stat=<statKey>  page=N
 *   char=<avatarId>  eid=<eidKey>  el=<element>  path=<path>  set=<setId>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ORIGIN = 'https://hsr.fortoffans.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const CACHE_DIR = path.join(PLUGIN_ROOT, 'data', 'fortoffans')
const CACHE_TTL = 24 * 3600 * 1000 // 24 小时，全球榜变动不频繁

/** 可排序属性：key → 中文名（与页面「Stat」下拉对应） */
export const STAT_NAMES = {
  stat_tcv: 'CRIT 值',
  stat_crit_rate: '暴击率',
  stat_crit_dmg: '暴击伤害',
  stat_spd: '速度',
  stat_atk: '攻击力',
  stat_hp: '生命值',
  stat_def: '防御力',
  stat_break_effect: '击破特攻',
  stat_effect_hit: '效果命中',
  stat_healing_boost: '治疗加成',
  stat_elation: '欢愉',
  sub_cr: '副暴击率',
  sub_cd: '副暴击伤害',
  sub_spd: '副速度',
  sub_atk_pct: '副攻击%',
  sub_hp_pct: '副生命%',
  sub_def_pct: '副防御%',
  sub_break: '副击破',
  sub_ehr: '副效果命中',
  sub_count: '副词条数',
  wrqs: '遗器评分',
  opt_score: '最优化评分',
}

/** 默认按 CRIT 值排 */
export const DEFAULT_STAT = 'stat_tcv'

function cachePath(key) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  return path.join(CACHE_DIR, `${key}.json`)
}
function readCache(key) {
  try {
    const p = cachePath(key)
    if (Date.now() - fs.statSync(p).mtimeMs > CACHE_TTL) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}
function writeCache(key, val) {
  try { fs.writeFileSync(cachePath(key), JSON.stringify(val)) } catch { /* 缓存失败不影响主流程 */ }
}

/** 从 SSR HTML 里提取 SvelteKit 的 data 对象（JS 字面量求值） */
function extractData(html) {
  const marker = '{type:"data",data:'
  const start = html.indexOf(marker)
  if (start < 0) {
    // 有的构建里引号可能是单引号或类型字段位置不同，做个兜底
    const alt = html.indexOf('{type: "data", data:')
    if (alt < 0) throw new Error('fortoffans 页面未找到数据块')
    return extractDataAt(html, alt, '{type: "data", data:')
  }
  return extractDataAt(html, start, marker)
}

function extractDataAt(html, start, marker) {
  // 从 marker 起点开始括号配对，找到 data 对象的结束
  let depth = 0
  let i = start
  let instr = false
  let esc = false
  for (; i < html.length; i++) {
    const c = html[i]
    if (instr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') instr = false
      continue
    }
    if (c === '"') { instr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) { i++; break }
    }
  }
  if (depth !== 0) throw new Error('fortoffans 数据块括号不匹配')
  const objStr = html.slice(start, i)
  // eslint-disable-next-line no-new-func
  const wrapper = new Function(`return (${objStr})`)
  const wrapperObj = wrapper()
  return wrapperObj?.data || wrapperObj
}

/**
 * 拉取榜单。
 * @param {object} opts
 * @param {string} opts.stat  排序属性 key（默认 stat_tcv）
 * @param {string|null} opts.char  角色 avatar id（可选）
 * @param {string|null} opts.eid  命座（可选，'' / 'E0' / '6' 等）
 * @param {string|null} opts.el  元素（可选）
 * @param {string|null} opts.path 命途（可选）
 * @param {number} opts.page  页码
 */
export async function fetchLeaderboard(opts = {}) {
  const { stat = DEFAULT_STAT, char = null, eid = null, el = null, path: pathKey = null, page = 1 } = opts
  const qs = new URLSearchParams({ tab: 'characters', stat })
  if (char) qs.set('char', char)
  if (eid) qs.set('eid', eid)
  if (el) qs.set('el', el)
  if (pathKey) qs.set('path', pathKey)
  if (page > 1) qs.set('page', String(page))
  const url = `${ORIGIN}/leaderboard?${qs.toString()}`
  const ck = qs.toString()

  const cached = readCache(ck)
  if (cached) return cached

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`fortoffans HTTP ${res.status}`)
  const html = await res.text()
  const data = extractData(html)
  if (!data || !Array.isArray(data.entries)) throw new Error('fortoffans 返回格式错误')

  const out = {
    entries: data.entries,
    avatarMap: data.avatarMap || {},
    total: data.total || data.entries.length,
    page: data.page || page,
    pageSize: data.pageSize || 100,
    stat,
  }
  writeCache(ck, out)
  return out
}

/** 角色表：avatar id → 名称（从 avatarMap 归一化，key 为数字字符串） */
export async function fetchCharacterMap() {
  const cached = readCache('charMap')
  if (cached) return cached
  // 随便拉一页默认榜，avatarMap 里带全量角色
  const { avatarMap } = await fetchLeaderboard({ page: 1 })
  const map = {}
  for (const [id, v] of Object.entries(avatarMap || {})) {
    map[id] = { id, name: v?.name || `#${id}`, element: v?.element || '' }
  }
  writeCache('charMap', map)
  return map
}

/** 星魂档位归一化：0 → '0'，1-2 → '1-2'，3-5 → '3-5'，6 → '6' */
export function eidolonBracket(eidolon) {
  const n = Number(eidolon)
  if (!Number.isFinite(n) || n < 0) return null
  if (n === 0) return '0'
  if (n >= 1 && n <= 2) return '1-2'
  if (n >= 3 && n <= 5) return '3-5'
  if (n >= 6) return '6'
  return '0'
}

/**
 * 查某玩家（按昵称）某角色在某星魂档位下的全球名次与参榜数。
 *
 * 通过两个接口组合：
 *   /api/leaderboard/search?nickname=<昵称>&char=<avatar_id>&eid=<档位>
 *       → 该玩家该角色该档位的记录，含 searchRank（同角色同档位名次）
 *   /leaderboard?char=<avatar_id>&eid=<档位>  → total（该档位参榜数）
 *
 * @param {object} opts
 * @param {string} opts.nickname  玩家昵称（须与网站展柜昵称一致）
 * @param {string} opts.char  avatar id
 * @param {number} opts.eidolon  星魂 0-6
 * @returns {{rank:number, total:number, entry:object}|null}
 */
export async function fetchPersonalRank({ nickname, char, eidolon } = {}) {
  if (!nickname || !char) return null
  const ck = `pr:${nickname}:${char}:v3`
  const cached = readCache(ck)
  if (cached) return cached

  // 1) 先不带 eid 查，拿到记录的真实星魂。
  //    注意：不带 eid 时的 searchRank 是「全星魂档位」的名次，
  //    不能直接和某个档位的 total 比较（会出现第 645 / 共 524 这种）。
  const sqs = new URLSearchParams({ nickname, char })
  const sres = await fetch(`${ORIGIN}/api/leaderboard/search?${sqs.toString()}`, {
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!sres.ok) throw new Error(`fortoffans search HTTP ${sres.status}`)
  const list = await sres.json()
  let entry = (Array.isArray(list) ? list : []).find(r => String(r?.avatar_id) === String(char))
  if (!entry) return null // 该玩家没在这个角色上提交过展柜

  const bracket = eidolonBracket(entry.eidolon ?? eidolon)

  // 2) 再带真实档位查一次，拿「同档位」名次；拿不到才退回全档位名次
  let rank = entry.searchRank ?? null
  let scope = 'all'
  try {
    const sqs2 = new URLSearchParams({ nickname, char, eid: bracket })
    const sres2 = await fetch(`${ORIGIN}/api/leaderboard/search?${sqs2.toString()}`, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
    if (sres2.ok) {
      const list2 = await sres2.json()
      const e2 = (Array.isArray(list2) ? list2 : []).find(r => String(r?.avatar_id) === String(char))
      if (e2) {
        entry = e2
        rank = e2.searchRank ?? rank
        scope = 'bracket'
      }
    }
  } catch (_) { /* 档位查询失败就保留全档位名次 */ }

  // 3) 参榜数：同角色、同星魂档位
  let total = null
  try {
    total = (await fetchLeaderboard({ char, eid: bracket, page: 1 }))?.total ?? null
  } catch (_) { /* 总数失败不影响个人名次 */ }
  const out = {
    rank,
    total,
    entry,
    bracket,
    scope,
  }
  writeCache(ck, out)
  return out
}

/**
 * 在某个角色/星魂档位/属性榜里找某个 UID 的名次。
 * search 接口只对 opt_score 的 searchRank 生效，wrqs 等需要用排行榜逐页找。
 */
export async function fetchLeaderboardRank({ char, eid, stat = 'wrqs', uid, maxPages = 40 } = {}) {
  if (!char || !eid || !uid) return null
  const ck = `lr:${stat}:${char}:${eid}:${uid}:v1`
  const cached = readCache(ck)
  if (cached) return cached
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchLeaderboard({ char, eid, stat, page })
    const entries = res?.entries || []
    if (!entries.length) break
    const idx = entries.findIndex(e => String(e?.uid) === String(uid))
    if (idx >= 0) {
      const pageSize = Number(res.pageSize) || 100
      const out = {
        rank: entries[idx].rank ?? ((page - 1) * pageSize + idx + 1),
        total: res.total ?? null,
        stat,
      }
      writeCache(ck, out)
      return out
    }
    if (page * entries.length >= (res.total || 0)) break
  }
  return null
}

export default {
  fetchLeaderboard, fetchLeaderboardRank, fetchCharacterMap, fetchPersonalRank, eidolonBracket,
  STAT_NAMES, DEFAULT_STAT,
}
