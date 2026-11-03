import fs from 'node:fs'
import YAML from 'yaml'
import yaml from './yaml.js'

const CACHE_PATH = './plugins/HoYoGet-Plugin/data/GroupName.yaml'

const getCache = () => {
  try {
    if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, '{}\n')
    return yaml.get(CACHE_PATH) || {}
  } catch (_) {
    return {}
  }
}

/* 缓存是扁平的「群号 -> 群名」表，没有注释要保留，直接整份写盘；
   插件封装里的 yaml.set 是 (path, key, value) 三参数，不能拿来写整表。 */
const saveCache = (data) => {
  try {
    fs.writeFileSync(CACHE_PATH, YAML.stringify(data || {}), 'utf-8')
  } catch (_) {}
}

const pickId = (item = {}) =>
  Number(item.group_id ?? item.groupId ?? item.id ?? item.gid ?? item.group ?? 0) || 0

const pickName = (item = {}) =>
  String(item.group_name ?? item.groupName ?? item.name ?? '').trim()

const toArray = (groups) => {
  if (!groups) return []
  if (typeof groups.values === 'function') return Array.from(groups.values())
  if (Array.isArray(groups)) return groups
  if (typeof groups === 'object') return Object.values(groups)
  return []
}

/* 取机器人连接：Bot 自身 + Bot.bots 里的每个实例。
   bots 在部分框架是 Map、在 TRSS 是普通对象，两种都要能取到值。 */
function collectBots() {
  const root = globalThis.Bot
  if (!root) return []
  const bots = root.bots
  const values = !bots
    ? []
    : (typeof bots.values === 'function' ? [...bots.values()] : toArray(bots))
  return [root, ...values].filter(Boolean)
}

/* 单次查询的兜底超时：适配器不回包时不能让锅巴一直转圈 */
const withTimeout = (p, ms) => Promise.race([
  Promise.resolve(p).catch(() => null),
  new Promise(resolve => setTimeout(() => resolve(null), ms)),
])

/* 适配器的返回可能是 { group_name }、{ data: { group_name } } 或字符串 */
const pickNameDeep = (res) => {
  if (!res) return ''
  if (typeof res === 'string') return res.trim()
  const data = res.data ?? res
  return pickName(data || {}) || pickName(res || {})
}

async function fetchGroupName(client, id) {
  /* 1) 内存里的群列表：机器人在群里时这里直接有名字，不需要发请求 */
  const memory = client?.gl?.get?.(id) ?? client?.gl?.[id]
  const fromMemory = pickName(memory || {})
  if (fromMemory) return fromMemory
  /* 2) 群对象自带的 info / getInfo() */
  try {
    const group = client?.pickGroup?.(id)
    const info = group?.getInfo ? group.getInfo() : group?.info
    const name = pickName(await withTimeout(info, 1200) || {})
    if (name) return name
  } catch (_) {}
  /* 3) 适配器方法：oicq 系是 get_group_info，少数 fork 是 getGroupInfo */
  for (const method of ['get_group_info', 'getGroupInfo']) {
    const fn = client?.[method]
    if (typeof fn !== 'function') continue
    try {
      const name = pickNameDeep(await withTimeout(fn.call(client, id, true), 2500))
      if (name) return name
    } catch (_) {}
  }
  /* 4) TRSS 风格的 sendApi */
  if (typeof client?.sendApi === 'function') {
    try {
      const name = pickNameDeep(await withTimeout(client.sendApi('get_group_info', { group_id: id, no_cache: true }), 2500))
      if (name) return name
    } catch (_) {}
  }
  return ''
}

// 同步取当前已知群名：Bot 内存中的群信息 + 本地缓存
function getGroupNameMap() {
  const map = new Map()
  for (const [key, value] of Object.entries(getCache())) map.set(String(key), String(value))

  for (const bot of collectBots()) {
    for (const item of toArray(bot?.gl)) {
      const id = pickId(item)
      const name = pickName(item)
      if (id && name) map.set(String(id), name)
    }
  }
  return map
}

// 把当前所有群（群号 + 群名）落盘，供锅巴启动时读取
function cacheGroupList() {
  const names = getGroupNameMap()
  const before = getCache()
  let changed = false
  for (const [id, name] of names) {
    if (name && before[String(id)] !== name) changed = true
  }
  if (changed) saveCache(Object.fromEntries(names))
  return names
}

// 对缺失群名的群号调用适配器接口补齐，结果落盘缓存
async function refreshGroupNames(groupIds = []) {
  const map = getGroupNameMap()
  const clients = collectBots().filter(item => item && (item.gl || item.pickGroup || item.get_group_info || item.getGroupInfo || item.sendApi))
  const targets = [...new Set((groupIds || []).map(id => Number(id)))]
    .filter(id => id && !map.get(String(id)))
  const changed = {}
  /* 每批 4 个并发：适配器限流时不至于把整页拖死 */
  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4)
    const results = await Promise.all(batch.map(async id => {
      for (const client of clients) {
        const name = await fetchGroupName(client, id)
        if (name) return [id, name]
      }
      return null
    }))
    for (const item of results) {
      if (!item) continue
      changed[String(item[0])] = item[1]
      map.set(String(item[0]), item[1])
    }
  }
  if (Object.keys(changed).length) saveCache({ ...getCache(), ...changed })
  return map
}

export { getGroupNameMap, refreshGroupNames, cacheGroupList }
