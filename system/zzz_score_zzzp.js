// 绝区零驱动盘评分：规则与权重对齐 ZZZ-Plugin（ZZZure/ZZZ-Plugin）
// 线上数据：resources/map 下的 EquipScore 与 EquipBaseValue
// 6 小时缓存；请求失败用磁盘缓存；再失败返回 null，由调用方回落自研权重
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CACHE_DIR = path.join(PLUGIN_ROOT, "data", "zzz_panel", "zzzp_cache")
const TTL = 21600000
const TIMEOUT = 8000
const MAPS = ["EquipScore", "EquipBaseValue"]
const MIRRORS = [
  "https://cdn.jsdelivr.net/gh/ZZZure/ZZZ-Plugin@master/resources/map",
  "https://raw.githubusercontent.com/ZZZure/ZZZ-Plugin/master/resources/map",
]
const state = { data: {}, at: 0, task: null }
const cacheFile = (name) => path.join(CACHE_DIR, name + ".json")
const readCache = (name) => { try { return JSON.parse(fs.readFileSync(cacheFile(name), "utf8")) } catch (e) { return null } }
const writeCache = (name, data) => { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cacheFile(name), JSON.stringify(data)) } catch (e) { } }

async function fetchJson(name) {
  if (typeof fetch !== "function") return null
  for (const base of MIRRORS) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch (e) { } }, TIMEOUT)
    try {
      const res = await fetch(base + "/" + name + ".json", { signal: ctrl.signal, headers: { "user-agent": "HoYoGet-Plugin" } })
      if (res.ok) {
        const data = await res.json()
        if (data && typeof data === "object") return data
      }
    } catch (e) { } finally { clearTimeout(timer) }
  }
  return null
}

export function zzzpWarmup() {
  if (state.at && Date.now() - state.at < TTL) return Promise.resolve()
  if (state.task) return state.task
  if (!state.data.EquipScore) {
    for (const name of MAPS) {
      if (state.data[name]) continue
      const disk = readCache(name)
      if (disk) state.data[name] = disk
    }
    if (state.data.EquipScore) state.at = Date.now()
  }
  state.task = (async () => {
    const rows = await Promise.all(MAPS.map(async (name) => [name, await fetchJson(name)]))
    let changed = false
    for (const [name, data] of rows) {
      if (!data) continue
      state.data[name] = data
      writeCache(name, data)
      changed = true
    }
    if (changed) state.at = Date.now()
  })().catch(() => { }).then(() => { state.task = null })
  return state.task
}

const PROP_IDS = [11102, 12102, 13102, 12202, 20103, 21103, 23103, 23203, 30502, 31203, 31402]
const ELEM_IDS = [31503, 31603, 31703, 31803, 32303, 31903]
const RULE_WEIGHTS = {
  "主C·双爆": "0,.75,0,0,1,1,1,.25,0,0,0,1",
  "主C·异常": "0,.75,0,0,0,0,1,.25,0,1,1,1",
  "命破·双爆": ".5,.25,0,0,1,1,0,0,0,0,0,1",
  "锋御·双爆": "0,0,1,0,1,.75,1,.25,0,0,0,1",
  "辅助·双爆": "0,.75,0,0,1,1,.75,.25,1,0,0,1",
  "辅助·攻击": "0,1,0,0,1,.75,.75,.25,1,0,0,1",
  "辅助·异常": "0,.75,0,0,0,0,.75,.25,1,1,1,1",
  "冲击·双爆": "0,.75,0,1,1,1,.75,.25,1,0,0,1",
  "冲击·攻击": "0,1,0,1,1,.75,.75,.25,1,0,0,1",
  "冲击·异常": "0,.75,0,1,0,0,.75,.25,1,1,1,1",
}
const PROP_ID_BY_NAME = { "生命值百分比": 11102, "攻击力百分比": 12102, "防御力百分比": 13102, "冲击力": 12202, "暴击率": 20103, "暴击伤害": 21103, "穿透率": 23103, "穿透值": 23203, "能量自动回复": 30502, "异常精通": 31203, "异常掌控": 31402 }
const critSum = (p) => p.crit * 2 + p.critdmg
const RULE_TESTS = {
  "主C·双爆": (p) => p.atk > 2400 && critSum(p) >= 2.2 && p.am < 150 && p.ap < 200,
  "主C·异常": (p) => critSum(p) < 2 && p.atk >= 2400 && ((p.am >= 180 && p.ap >= 200) || (p.am >= 120 && p.ap >= 300) || (p.am >= 150 && p.ap >= 250)),
  "命破·双爆": () => true,
  "锋御·双爆": () => true,
  "辅助·双爆": (p) => critSum(p) >= 1.5 && p.ap < 200,
  "辅助·攻击": (p) => critSum(p) >= 1.5,
  "辅助·异常": (p) => critSum(p) < 2 && p.ap >= 200,
  "冲击·双爆": (p) => critSum(p) >= 1.5 && p.am < 150 && p.ap < 200,
  "冲击·攻击": (p) => p.atk > 2000 && critSum(p) >= 1 && p.am < 150 && p.ap < 200,
  "冲击·异常": (p) => critSum(p) < 2 && (p.am >= 150 || p.ap >= 200),
}

const DEFAULT_RULES = {
  1: ["主C·双爆"],
  2: ["冲击·双爆", "冲击·攻击", "冲击·异常"],
  3: ["主C·异常", "辅助·异常"],
  4: ["辅助·双爆", "辅助·异常"],
  5: ["辅助·双爆", "辅助·异常"],
  6: ["命破·双爆"],
  7: ["锋御·双爆"],
}
function parsedWeight(name, elemId) {
  const raw = RULE_WEIGHTS[name]
  if (!raw) return null
  const nums = raw.split(",").map(Number)
  const out = {}
  for (let i = 0; i < PROP_IDS.length; i++) {
    const v = nums[i]
    if (!v || !isFinite(v)) continue
    out[PROP_IDS[i]] = v
  }
  if (elemId && nums[11]) out[elemId] = nums[11]
  return Object.keys(out).length ? out : null
}
function pickRule(names, ctx, elemId) {
  let chosen = null
  if (names.length === 1) chosen = names[0]
  else {
    for (const n of names) { if (RULE_TESTS[n] && RULE_TESTS[n](ctx)) { chosen = n; break } }
    if (!chosen) { for (const n of names) { if (RULE_TESTS[n]) { chosen = n; break } } }
  }
  if (!chosen) return { name: "默认", weight: null }
  return { name: chosen, weight: parsedWeight(chosen, elemId) }
}
const normName = (s) => String(s || "").replace(/[·・\s「」『』]/g, "").toLowerCase()
function matchChar(table, name) {
  const key = normName(name)
  if (!key) return null
  const keys = Object.keys(table)
  const exact = keys.find((k) => normName(k) === key)
  if (exact) return table[exact]
  const fuzzy = keys.find((k) => { const n = normName(k); return n && (n.includes(key) || key.includes(n)) })
  return fuzzy ? table[fuzzy] : null
}
export function zzzpScoreWeight(opts) {
  const o = opts || {}
  try { zzzpWarmup() } catch (e) { }
  const table = state.data.EquipScore
  if (!table || !Object.keys(table).length) return null
  const st = o.stats || {}
  const ctx = { atk: Number(st.atk) || 0, crit: Number(st.crit) || 0, critdmg: Number(st.critdmg) || 0, am: Number(st.am) || 0, ap: Number(st.ap) || 0 }
  const elemId = ELEM_IDS[Number(o.elementType) - 200]
  const entry = matchChar(table, o.charName)
  const hasEntry = entry && (Array.isArray(entry) ? entry.length > 0 : Object.keys(entry).length > 0)
  const def = hasEntry ? entry : (DEFAULT_RULES[Number(o.profession)] || DEFAULT_RULES[1])
  let ruleName = "默认"
  let weight = null
  if (Array.isArray(def)) {
    const pk = pickRule(def, ctx, elemId)
    ruleName = pk.name
    weight = pk.weight
  } else if (def && Array.isArray(def.rules)) {
    const pk = pickRule(def.rules, ctx, elemId)
    ruleName = pk.name
    weight = Object.assign({}, pk.weight || {})
    const rest = Object.assign({}, def)
    delete rest.rules
    const keys = Object.keys(rest)
    if (keys.length) {
      ruleName = ruleName + "·改"
      for (const k of keys) {
        const id = k === "属性伤害加成" ? elemId : PROP_ID_BY_NAME[k]
        const v = Number(rest[k])
        if (id && v) weight[id] = v
      }
    }
  }
  if (!weight) return null
  const bv = state.data.EquipBaseValue
  if (bv) {
    const pairs = [[11103, 11102, "hpmax"], [12103, 12102, "attack"], [13103, 13102, "def"]]
    for (const it of pairs) {
      const small = it[0], big = it[1], key = it[2]
      if (!weight[big] || weight[small] != null) continue
      const bp = o.baseProps || {}
      const base = parseFloat(bp[key] && bp[key].base)
      if (!(base > 0)) continue
      const ratio = bv[small] * 100 / (bv[big] * base)
      if (ratio > 0) weight[small] = +(ratio * weight[big]).toFixed(2)
    }
  }
  if (!Object.keys(weight).length) return null
  return { ruleName: "ZZZ·" + ruleName, weight: weight }
}
export function zzzpSubStatIds() {
  const bv = state.data.EquipBaseValue
  if (!bv) return null
  const ids = Object.keys(bv).map(Number).filter((id) => id > 0)
  return ids.length ? ids : null
}
