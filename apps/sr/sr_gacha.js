import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { render, mhy, pluginPriority, makeForwardMsg } from '#HoYoGet'
import { appendTaskRecords } from '../../system/task_history.js'
import { buildIsUP } from '../../system/join_isup.mjs'
// === 跨插件依赖：genshin 插件 ===
//
// 这几个模块（gachaLog / srGachaSummary）是 genshin 较新版本才有的，
// 不同用户的 genshin 版本不一：若用静态 import，遇到没有该文件的版本会直接
// ERR_MODULE_NOT_FOUND，导致**整个 HoYoGet 插件加载失败**（用户反馈在
// Windows 上出现过「插件加载完毕」卡住不继续的问题）。
//
// 因此改为运行时按需加载，且给出多个候选路径；全都找不到时把对应功能标记为
// 不可用并给出提示，而不是让整个插件起不来。
// 只在真正要用到该功能时才 import，代价可以忽略。

const GENSHIN_ROOTS = [
  '../../system/vendor/genshin/',
  '../../../genshin/',
  '../../genshin/',
  '../genshin/',
]

/** 在多个候选根下找到第一个存在的相对模块路径 */
function resolveGenshinModule(relPaths) {
  const bases = GENSHIN_ROOTS.map(root => new URL(root, import.meta.url).href)
  const found = []
  for (const base of bases) {
    for (const rel of relPaths) {
      const url = new URL(rel, base).href
      if (found.includes(url)) continue
      found.push(url)
    }
  }
  return found
}

const missingGenshinModules = new Set()

/**
 * 按需加载 genshin 的一个模块，取其 default 或指定的具名导出。
 * @param {string} tag 功能标记，用于错误提示与去重
 * @param {string[]} relPaths 相对 genshin 插件根的候选路径
 * @param {string|null} named 需要取的具名导出；传 '*' 返回整个模块命名空间；不传则为 default
 */
async function loadGenshinModule(tag, relPaths, named = null) {
  const candidates = resolveGenshinModule(relPaths)
  let lastErr
  for (const url of candidates) {
    try {
      const mod = await import(url)
      if (named === '*') return { ok: true, value: mod }
      if (named) return { ok: true, value: mod[named] }
      return { ok: true, value: mod.default }
    } catch (err) {
      lastErr = err
    }
  }
  if (!missingGenshinModules.has(tag)) {
    missingGenshinModules.add(tag)
    logger.error(
      `[HoYoGet][sr_gacha] 未能在 genshin 插件中找到 ${tag}（已尝试 ${candidates.length} 个路径，` +
      `最后错误：${lastErr?.message || lastErr}）。该功能将不可用。`
    )
  }
  return { ok: false, value: null }
}

/** 懒加载 genshin 的 MysInfo（取 ck 用）。供本文件与 zzz_gacha.js 复用。 */
export async function getGenshinMysInfo() {
  const r = await loadGenshinModule('model/mys/mysInfo.js', ['model/mys/mysInfo.js', 'model/mys/mysInfo.mjs'], null)
  return r.ok ? r.value : null
}

/** 懒加载 srGachaSummary 模块的具名导出 */
async function getGenshinSrSummary() {
  const r = await loadGenshinModule(
    'model/gachaLog/srGachaSummary.js',
    ['model/gachaLog/srGachaSummary.js', 'model/gachaLog/srGachaSummary.mjs'],
    '*'
  )
  return r.ok ? r.value : null
}

/** 取 srGachaSummary 模块里的某个具名函数 */
async function getSrSummaryFn(name) {
  const mod = await getGenshinSrSummary()
  return mod?.[name] || null
}

/**
 * 取 SrGachaSummary 类本身。
 *
 * 注意：getGenshinSrSummary() 返回的是**模块命名空间对象**，不是类。
 * 直接 `new (await getGenshinSrSummary())()` 会抛
 * "SrGachaSummaryCls is not a constructor"——SrGachaSummary 是具名导出，
 * 必须从命名空间里取出来才能 new。
 */
async function getSrSummaryClass() {
  return await getSrSummaryFn('SrGachaSummary')
}

// === 跨插件依赖：miao-plugin ===
//
// 与 genshin 同理，miao-plugin 也可能缺失或版本不同（静态 import 缺失会让整个
// 插件 ERR_MODULE_NOT_FOUND）。这里按需加载：拿不到就跳过图标补全，
// 后面还有「按约定路径取本地头像」的兜底，不会因为缺 miao 就出不来图。

/* 优先用本插件内置的数据模型（system/vendor/miao），没有才退回外部 miao-plugin */
const MIAO_ROOTS = [
  '../../../miao-plugin/',
  '../../miao-plugin/',
  '../miao-plugin/',
]

let miaoModelsCache = null

async function getMiaoModels() {
  if (miaoModelsCache) return miaoModelsCache
  try {
    const mod = await import('#hoyo.miao.models')
    miaoModelsCache = { Character: mod.Character, Weapon: mod.Weapon }
    return miaoModelsCache
  } catch (_) { /* 内置模型异常时再试外部插件 */ }
  const bases = MIAO_ROOTS.map(root => new URL(root, import.meta.url).href)
  let lastErr
  for (const base of bases) {
    try {
      const mod = await import(new URL('models/index.js', base).href)
      miaoModelsCache = { Character: mod.Character, Weapon: mod.Weapon }
      return miaoModelsCache
    } catch (err) {
      lastErr = err
    }
  }
  if (!missingGenshinModules.has('miao-plugin/models')) {
    missingGenshinModules.add('miao-plugin/models')
    /* 内部已内置 models（#hoyo.miao.models），只有连内置都失败才会走到这里。
       miao-plugin 被卸载属于正常部署，记 debug 而不是 error，避免刷屏。 */
    logger.debug?.(`[HoYoGet][sr_gacha] 外部 miao-plugin 不可用（${lastErr?.message || lastErr}），`
      + '改用本地约定路径取图标。')
  }
  miaoModelsCache = { Character: null, Weapon: null }
  return miaoModelsCache
}

// 模块加载即开始预热。buildSummaryView / buildSrStatView 是同步导出，无法内部
// await，因此统一读同步缓存 miaoModelsCache；预热与首次渲染几乎同 tick 时可能
// 尚未就绪，此时 makeIcon 走「本地约定路径」兜底（见下方），不影响出图。
getMiaoModels()
import { fileURLToPath } from 'node:url'
import { guardModuleByFile } from '../../system/modules.js'

// ESM 作用域没有 __dirname，按仓库既有写法（apps/custom_guide.js）从 import.meta 取。
// 数据路径一律相对插件根，不依赖进程 cwd（Yunzai 启动时 cwd 即插件目录）。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '../..')

const API_URL = 'https://act-api-takumi.mihoyo.com/event/rpg_gacha_record/five_star_list'
const BADGE_API_URL = 'https://api-takumi.mihoyo.com/common/badge/v1/login/account'
const POOLS = [
  { type: 'GachaType_AvatarUp', key: 'char', name: '角色活动跃迁', hint: '角色' },
  { type: 'GachaType_EquipmentUp', key: 'weapon', name: '光锥活动跃迁', hint: '光锥' },
  { type: 'GachaType_CollabAvatarUp', key: 'collabChar', name: '联动角色跃迁', hint: '联动角色' },
  { type: 'GachaType_CollabEquipmentUp', key: 'collabWeapon', name: '联动光锥跃迁', hint: '联动光锥' },
  { type: 'GachaType_Newbie', key: 'newbie', name: '新手跃迁', hint: '新手' },
]

// 渲染排列顺序：角色类一组、光锥类一组，方便左右对齐
const POOL_ORDER = [
  'GachaType_AvatarUp',
  'GachaType_CollabAvatarUp',
  'GachaType_EquipmentUp',
  'GachaType_CollabEquipmentUp',
  'GachaType_Newbie',
  'common',
]

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function setCookieValue(headers, name) {
  const raw = headers?.getSetCookie?.() || headers?.raw?.()?.['set-cookie'] || []
  for (const item of raw) {
    const match = String(item).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`))
    if (match?.[1]) return match[1]
  }
  const one = headers?.get?.('set-cookie') || ''
  const match = String(one).match(new RegExp(`(?:^|,\\s*)${name}=([^;,]*)`))
  return match?.[1] || ''
}

/**
 * 星铁「可歪池」角色名单 —— 这些角色进入常驻池后也能在限定池被抽到（歪），
 * 小助手 / 星穹工坊统计「每UP角色花费」时把它们计入常驻而非限定，
 * 所以「每UP角色花费」的分母只算限定五星的个数。
 *
 * 名单依据：小助手角色页「常驻角色」分组。
 * 注意：同一角色可能先是限定、后进常驻（如希儿 1.0 限定、3.0 后可歪）。
 * 本表按「当前是否已可歪」判定，与小助手一致。
 * 新角色进常驻时需同步补充，否则分母偏大、算出的花费偏低。
 */
const SR_WAI_POOL_ROLES = new Set([
  // 自 1.0 起即为常驻、始终可歪的角色
  '姬子', '布洛妮娅', '白露', '彦卿', '克拉拉', '杰帕德', '瓦尔特',
])

/**
 * 后来才转入常驻的角色 —— 这些角色早期是限定（能出 UP），
 * 进入常驻池后才变成可歪，需按抽卡时间区分：
 *   · 转入常驻之前抽到的：算限定
 *   · 转入常驻之后抽到的：算常驻，剔除出「每UP花费」分母
 *
 * 静态名单无法表达这种时间维度，若一律剔除会让分母偏小、算出的花费偏高。
 */
const SR_LATER_COMMON_ROLES = new Set(['希儿', '银狼', '符玄', '云璃', '银枝', '刃'])

/** 这些角色转入常驻的时间点（YYYY-MM），此前抽到的仍算限定。
 *  各角色转入时间不同，不能用同一个全局值：
 *   · 希儿 / 银狼 / 符玄 / 刃 / 银枝 —— 3.0 版本（2025-01-15）起加入群星跃迁
 *   · 云璃 —— 2025-09 起加入常驻（游戏内「可歪角色」名单可见）
 *  若共用 2025-09，会把 2025-01 ~ 2025-08 抽到的前五者误判成限定
 *  （实测某账号 2025-11 抽到的刃被算成限定 UP，实际已是常驻歪） */
const SR_LATER_COMMON_SINCE = {
  '希儿': '2025-01',
  '银狼': '2025-01',
  '符玄': '2025-01',
  '刃': '2025-01',
  '银枝': '2025-01',
  '云璃': '2025-09',
}

/** 判断一条五星记录是否应算作「常驻」（不计入每UP花费的分母） */
function isSrWaiPoolRecord(rec) {
  const name = String(rec?.name || '')
  if (SR_WAI_POOL_ROLES.has(name)) return true
  if (!SR_LATER_COMMON_ROLES.has(name)) return false
  // time 形如「2025-11-05 12:00:00」，截到月即可比较。
  // 工坊 / ck 来源的记录 time 常为空串（ck 的 five_star_list 恒为空），此时用
  // id 前 13 位毫秒时间戳反推日期——与 buildSummaryView 日程表查询的
  // 「time → timeFromId」兜底一致。若两者都拿不到时间，按「转入前=限定」处理：
  // 宁可少判一个歪，也不能把历史 UP 误杀成常驻。
  const month = (String(rec?.time || '') || timeFromId(rec?.id)).slice(0, 7)
  return month ? month >= SR_LATER_COMMON_SINCE[name] : false
}

/**
 * 星铁「可歪池」光锥名单 —— 常驻角色的专武。
 * 角色进常驻后，其专武同样能在光锥限定池被抽到（歪），小助手统计
 * 「每UP光锥花费」时把专武计入常驻，不计入分母。
 *
 * 名单依据：小助手光锥页的「常驻专武」分组。
 */
const SR_WAI_POOL_LIGHTCONES = new Set([
  '银河铁道之夜', '无可取代的东西', '但战斗还未结束', '以世界之名',
  '制胜的瞬间', '如泥酣眠', '时节不居',
])

/**
 * 绝区零「可歪池」名单 —— 常规频段的常驻 S 级，在独家/重映/音擎/音擎回响频段
 * 抽到均算「歪」。
 * 角色（9）：
 *   · 开服常驻 6 人：格莉丝、丽娜、珂蕾妲、猫又、11号、莱卡恩
 *     （官方「常驻频段累计 300 抽自选招募」名单）
 *   · 3.1 二周年（2026-07-29）老限定进歪池 3 人：月城柳、凯撒、朱鸢
 * 音擎（9）：对应专武 —— 硫磺石、拘缚者、嵌合编译器、啜泣摇篮、燃狱齿轮、
 *   猫爪肉垫（开服 6 把）+ 时流贤者（柳）、奔袭獠牙（凯撒）、防爆者VI型（朱鸢）
 * 依据：官方 3.1 福利公告「限定S级代理人月城柳、凯撒、朱鸢及其音擎将加入定制调频」。
 * 3.1 新增的三人有转入时间（此前是纯限定，抽到即 UP），按抽卡月份判定，
 * 避免把 2026-07 前他们当 UP 抽到的历史记录误判成歪。
 * 此前 is_up 重算只用星铁名单，绝区零常驻角色永远匹配不上，被 !isWai 强制
 * 标成 UP —— 表现为小保底不歪率恒 100.0%、歪的常驻也带 UP 角标。
 */
const ZZZ_WAI_POOL_ROLES = new Set([
  '格莉丝', '丽娜', '珂蕾妲', '猫又', '11号', '莱卡恩',
  '月城柳', '凯撒', '朱鸢',
])
const ZZZ_WAI_POOL_LIGHTCONES = new Set([
  '硫磺石', '拘缚者', '嵌合编译器', '啜泣摇篮', '燃狱齿轮', '猫爪肉垫',
  '时流贤者', '奔袭獠牙', '防爆者VI型',
])
/** 3.1（2026-07-29）起转入常驻的角色/音擎，此前抽到的仍算限定 */
const ZZZ_LATER_COMMON_SINCE = {
  '月城柳': '2026-07', '凯撒': '2026-07', '朱鸢': '2026-07',
  '时流贤者': '2026-07', '奔袭獠牙': '2026-07', '防爆者VI型': '2026-07',
}

/** 绝区零记录是否为「可歪」：命中名单，且转入期前的历史记录不算 */
function isZzzWaiPoolRecord(rec) {
  const name = String(rec?.name || '')
  if (!ZZZ_WAI_POOL_ROLES.has(name) && !ZZZ_WAI_POOL_LIGHTCONES.has(name)) return false
  const since = ZZZ_LATER_COMMON_SINCE[name]
  if (!since) return true
  // time 形如「2026-08-04 10:56:29」，截到月即可比较
  const month = String(rec?.time || '').slice(0, 7)
  return month ? month >= since : false
}

export function sum(arr, field) {
  return arr.reduce((n, v) => n + Number(v?.[field] || 0), 0)
}

function buildGroupStats(pools, keys, title) {
  const list = pools.filter(pool => keys.includes(pool.key))
  const totalFive = sum(list, 'fiveNum')
  const totalPulls = sum(list, 'totalPulls')
  const totalUp = sum(list, 'upNum')
  const totalPity = sum(list, 'pity')
  const avgPity = totalFive ? (totalPulls / totalFive).toFixed(1) : '0.0'
  // UP平均与单池口径一致：分子扣掉当前未出五星的垫抽（大小保底总数）
  const upAvg = totalUp ? ((totalPulls - totalPity) / totalUp).toFixed(1) : '0.0'
  const upYs = Number(upAvg) ? (Number(upAvg) * 160).toFixed(0) : '0'
  const maxPity = list.length ? Math.max(...list.map(v => Number(v.maxPity || 0))) : 0
  const minPity = list.length ? Math.min(...list.map(v => Number(v.minPity || 0)).filter(v => v > 0)) || 0 : 0
  return {
    title,
    totalFive,
    totalPulls,
    avgPity,
    upAvg,
    upYs: Number(upYs) >= 10000 ? `${(Number(upYs) / 10000).toFixed(2)}w` : upYs,
    maxPity,
    minPity,
    totalUp,
    upRate: totalFive ? pct(totalUp, totalFive) + '%' : '0.0%',
  }
}

function buildPoolStats(pool) {
  return {
    title: pool?.name || '',
    fiveNum: Number(pool?.fiveNum || 0),
    avgPity: pool?.avgPity || '0.0',
    maxPity: Number(pool?.maxPity || 0),
    minPity: Number(pool?.minPity || 0),
  }
}

// 会歪池 key（存在 50/50 小保底）：星铁角色/光锥/联动，绝区零代理人/音擎（含重映）。
// 新手池、常驻池、邦布池不存在 50/50，不歪率无意义。
const WAI_POOL_KEYS = new Set([
  'GachaType_AvatarUp', 'GachaType_CollabAvatarUp',
  'GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp',
  'GachaType_CharacterUp', 'GachaType_RerunCharacter',
  'GachaType_WeaponUp', 'GachaType_RerunWeapon',
])

/**
 * 算「小保底不歪率」（净不歪率）：
 *
 *   不歪率 = (总五星 − 2×歪的次数) / (总五星 − 歪的次数)
 *
 * 其中：
 *   总五星   = 本池五星总数 N
 *   歪的次数 = 小保底歪（抽到常驻）的次数
 * 等价地，分母 = N − 歪 = 小保底总场数（不歪 + 歪，含歪后大保底必得的 UP），
 * 分子 = N − 2×歪 = 小保底总场数 − 2×歪 = 净不歪（赢的场扣掉输的场）。
 * 即「净不歪率 = 净不歪 / 小保底总场数」。
 * 分母为 0（全是歪）时无意义，置 '--'。
 *
 * 必得（歪之后大保底强制出的 UP）不再从分子分母中扣除：按用户口径，
 * 例：3 五星 = 刃(歪) + 79(刃后大保底 UP) + 75(小保底 UP)，
 * 不歪率 = (3 − 2×1) / (3 − 1) = 1/2 = 50%（若扣必得会变成 0/1 = 0%，
 * 与预期不符）。
 *
 * 入参为某会歪池的五星记录（含 is_up 字段，需先经 ck/工坊/可歪池名单校准）。
 * 处理时按抽卡时间（id 升序，旧→新）遍历，用 guaranteed 标记维护大保底状态：
 *   · 上一张歪了常驻 → 下一张必得 UP（大保底，记一次必得，不改变歪/总场计数）
 *   · 否则 is_up=true 即小保底直接赢（不歪），is_up=false 即小保底歪（常驻，记一次歪）
 * 该遍历不依赖「大保底次数=歪的次数」的恒等式，能兼容记录开头即是大保底、
 * 或末尾一次歪尚未补偿的残缺情况。
 *
 * @returns {{fiveNum:number,wai:number,bigPity:number,smallPity:number,notWai:number,noWaiNum:number,noWaiDen:number,rate:number}}
 */
function calcNoWaiRate(records) {
  const ordered = [...records].sort((a, b) => cmpRecordId(a, b))
  let wai = 0
  let bigPity = 0
  let notWai = 0
  let guaranteed = false
  for (const rec of ordered) {
    if (guaranteed) {
      bigPity++
      guaranteed = false
      continue
    }
    if (rec.is_up === true) notWai++
    else {
      wai++
      guaranteed = true
    }
  }
  const total = records.length
  // 不歪率 = (总五星 − 2×歪) / (总五星 − 歪) = 净不歪 / 小保底总场数。
  // 必得（大保底 UP）不单独扣除：例 3 五星含 1 歪 1 必得 → (3−2)/(3−1) = 50%。
  const noWaiNum = total - 2 * wai
  const noWaiDen = total - wai
  const smallPity = notWai + wai
  return {
    fiveNum: total, wai, bigPity, smallPity, notWai,
    noWaiNum, noWaiDen,
    rate: noWaiDen > 0 ? (noWaiNum / noWaiDen) * 100 : 0,
  }
}

export function pct(a, b) {
  if (!b) return '0.0'
  return ((a / b) * 100).toFixed(1)
}

export function formatNow() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function timeFromId(id) {
  const ms = Number(String(id || '').slice(0, 13))
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 各游戏的卡池定义差异较大（星铁与绝区零编号、命名、货币都不同），
// 视图层按 game 取对应配置，避免把绝区零的编号写进星铁分支
const GAME_VIEW_CONF = {
  // 鸣潮：唤取池。键名 WuwaPool<cardPoolType>，与接口的分池编号一一对应。
  ww: {
    poolOrder: ["WuwaPool1", "WuwaPool2", "WuwaPool3", "WuwaPool4", "WuwaPool5", "WuwaPool6", "WuwaPool7", "WuwaPool8", "WuwaPool9"],
    currency: "星声",
    typeMap: {
      WuwaPool1: "1", WuwaPool2: "2", WuwaPool3: "3",
      WuwaPool4: "4", WuwaPool5: "5", WuwaPool6: "6",
      WuwaPool7: "7", WuwaPool8: "8", WuwaPool9: "9",
    },
    labelClassMap: {
      WuwaPool1: "char", WuwaPool2: "weapon", WuwaPool3: "common",
      WuwaPool4: "common", WuwaPool5: "newbie", WuwaPool6: "collabChar",
      WuwaPool7: "collabWeapon", WuwaPool8: "char", WuwaPool9: "weapon",
    },
  },
  // 原神：五类祈愿。键名统一加 Gs 前缀，避免与星铁同名的 301/302 池串味。
  gs: {
    poolOrder: ["GsGachaType_AvatarUp", "GsGachaType_WeaponUp", "GsGachaType_AvatarUp2", "GsGachaType_Collection", "GsGachaType_Permanent"],
    currency: "原石",
    typeMap: {
      GsGachaType_AvatarUp: "301",
      GsGachaType_WeaponUp: "302",
      GsGachaType_AvatarUp2: "500",
      GsGachaType_Collection: "400",
      GsGachaType_Permanent: "200",
    },
    labelClassMap: {
      GsGachaType_AvatarUp: "char",
      GsGachaType_WeaponUp: "weapon",
      GsGachaType_AvatarUp2: "char",
      GsGachaType_Collection: "collabChar",
      GsGachaType_Permanent: "common",
    },
  },
  sr: {
    poolOrder: POOL_ORDER,
    currency: '星琼',
    typeMap: {
      GachaType_AvatarUp: '301',
      GachaType_EquipmentUp: '302',
      GachaType_CollabAvatarUp: '303',
      GachaType_CollabEquipmentUp: '304',
      GachaType_Newbie: '1001',
      common: '200',
    },
    labelClassMap: {
      GachaType_AvatarUp: 'char',
      GachaType_EquipmentUp: 'weapon',
      GachaType_CollabAvatarUp: 'collabChar',
      GachaType_CollabEquipmentUp: 'collabWeapon',
      GachaType_Newbie: 'newbie',
      common: 'common',
    },
  },
  // 绝区零：频段池；暂无可靠图源，图标一律留空（见 zzz_gacha.js 顶部说明）
  zzz: {
    poolOrder: [
      'GachaType_CharacterUp',
      'GachaType_RerunCharacter',
      'GachaType_WeaponUp',
      'GachaType_RerunWeapon',
      'GachaType_Permanent',
      'GachaType_Bangboo',
    ],
    currency: '菲林',
    typeMap: {
      GachaType_CharacterUp: '1',
      GachaType_RerunCharacter: '2',
      GachaType_WeaponUp: '3',
      GachaType_RerunWeapon: '4',
      GachaType_Permanent: '5',
      GachaType_Bangboo: '6',
    },
    labelClassMap: {
      GachaType_CharacterUp: 'char',
      GachaType_RerunCharacter: 'collabChar',
      GachaType_WeaponUp: 'weapon',
      GachaType_RerunWeapon: 'collabWeapon',
      GachaType_Permanent: 'common',
      GachaType_Bangboo: 'newbie',
    },
  },
}
// 空占位池按游戏取各自的常驻池。此前写死成绝区零的「常驻频段」：
// 星铁数据里永远不会有 GachaType_Permanent 这个 key，「是否已有该池」的判定恒不成立，
// 于是每张星铁总览图末尾都会被补上一张空的「常驻频段」卡（--抽 / 暂无记录）
const DEFAULT_POOL_BY_GAME = {
  sr: { key: 'common', name: '常驻跃迁' },
  zzz: { key: 'GachaType_Permanent', name: '常驻频段' },
}

// 用卡池日程表独立重算 is_up（缓存，避免每次渲染重读 yaml）
let _isUPSr = null
let _isUPZzz = null
function getIsUP(g) {
  // 原神不参与星铁与绝区零的 is_up 重算，直接采用抽卡数据自身字段
  if (g === "gs") return null
  if (g === 'zzz') return _isUPZzz || (_isUPZzz = buildIsUP('zzz'))
  return _isUPSr || (_isUPSr = buildIsUP('sr'))
}

export function buildSummaryView(data, uid, e, layout = 'grid', game = 'sr', miaoModels = miaoModelsCache) {
  const conf = GAME_VIEW_CONF[game] || GAME_VIEW_CONF.sr
  const defPool = DEFAULT_POOL_BY_GAME[game] || DEFAULT_POOL_BY_GAME.sr
  // 星铁视图兜底：即使调用方漏了清洗，也不把混入的绝区零频段池画进星铁卡
  const viewPools = game === 'sr' ? cleanSrPools(data?.pools) : data?.pools
  // 用卡池日程表独立重算 is_up（缓存，避免每次渲染重读 yaml）。
  // 修正外部 mergeIsUp 在「占位开始时间（x.x版本更新后）」「伴随者写法（托帕&账账）」
  // 下漏判 UP 的 bug —— 表现为流萤之后的角色在渲染图里没有 UP 角标、且不歪率虚高。
  const _isup = getIsUP(game)
  const pools = Object.entries(viewPools || {}).map(([key, pool]) => {
    const recent = Array.isArray(pool.records) ? pool.records : (Array.isArray(pool.recent) ? pool.recent : [])
    // 重算 is_up：只覆盖会歪池（角色/光锥/联动/复刻）；标准/新手池 is_up 保持原值。
    // recent 本身就是五星记录，不按 rank_type 过滤（部分数据源不带该字段，
    // 一旦过滤会把整次重算跳空，表现为修复"不生效"）
    if (_isup && WAI_POOL_KEYS.has(key)) {
      const poolRole = (key === 'GachaType_EquipmentUp' || key === 'GachaType_CollabEquipmentUp' ||
        key === 'GachaType_WeaponUp' || key === 'GachaType_RerunWeapon') ? 'weapon' : 'role'
      for (const v of recent) {
        const name = String(v?.name || '')
        const tv = v.time ? String(v.time).replace(/-/g, '/') : (v.id ? timeFromId(v.id) : '')
        const t = tv ? new Date(tv).getTime() : 0
        const u = _isup(name, t, poolRole)
        // 可歪判定按游戏取各自名单：星铁用静态名单+转常驻时间判定，绝区零用常驻名单+3.1 转入时间
        const isWai = game === 'zzz'
          ? isZzzWaiPoolRecord(v)
          : (poolRole === 'weapon'
            ? SR_WAI_POOL_LIGHTCONES.has(name)
            : isSrWaiPoolRecord(v))
        // 日程表缺期（u===null，复刻未收录、联动1.0 的「长期」兜底期）不再跳过沿用
        // 旧存储值——残缺数据会把转常驻角色（如刃，历史上当过期 UP 被 ck/继承
        // 错标 is_up=true）一直错标下去。规则：
        //   · 名单外五星强制 UP（限定五星不可能 off-banner 掉落，缺期也成立）
        //   · 名单内（星铁：希儿/刃等按抽卡时间区分转入前后；绝区零：格莉丝/莱卡恩等
        //     开服常驻）仅当日程表明确判 UP（复刻期收录）才判 UP，否则一律按「歪」兜底
        v.is_up = u === true || !isWai
      }
    } else if (!WAI_POOL_KEYS.has(key)) {
      // 常驻 / 新手池不存在 UP 概念，任何来源带来的 is_up 一律视作无效，
      // 避免常驻池误标 UP（如标准光锥被标成 UP）
      for (const v of recent) v.is_up = false
    }
    const fiveNum = Number(pool?.fiveNum) || recent.length
    // 联动跃迁（'21'/'22'）与普通跃迁一样存在小保底歪，is_up 一律按数据真实值；
    // authkey/小助手不返回 is_up，拉取时先置 false，由 ck 校准（mergeIsUp）与工坊同步补齐
    const isUpRec = v => v.is_up === true
    const upNum = recent.filter(isUpRec).length
    const pity = Number(typeof pool.pity === 'object' ? pool.pity?.gacha_count : pool.pity || 0) || 0
    const totalPulls = Number(pool?.totalPulls) || (sum(recent, 'gacha_count') + pity) || 0
    const pullValues = recent.map(v => Number(v.gacha_count || 0)).filter(v => v > 0)
    const fiveAvg = fiveNum ? (sum(recent, 'gacha_count') / fiveNum).toFixed(1) : '--'
    // UP平均 = 大小保底总数 ÷ UP 总数（与用户口径/工坊一致）。
    //   分子「大小保底总数」= 已出五星累计消耗抽数（含歪掉的），即总抽数扣除当前
    //   未出五星的垫抽 pity——例：77(歪) + 79(大保底UP) + 75(UP) = 231，
    //   2 个 UP → 231 ÷ 2 = 115.5；当前垫的 39 抽还没出五星，不计入。
    // 工坊风格统计视图（buildSrStatView）的「每UP角色花费」也复用这里的
    // line 数据，因此两个视图口径统一。
    //
    // 不能只对 is_up 的记录取 gacha_count 求平均：gacha_count 是「距上一个五星」
    // 的抽数，歪一次就重置。例：77 抽歪了，第 88 抽出 UP —— 那个 UP 记录的
    // gacha_count 只有 11，不含前面垫掉的 77，按记录均值算会低估一半以上。
    // 分母用 UP（is_up）个数：可歪池角色（星铁：已进常驻的刃、云璃、姬子、布洛妮娅等；
    // 绝区零：格莉丝、莱卡恩、月城柳、凯撒、朱鸢等）在限定池抽到算歪，不计入分母；歪掉的那次抽数计入分子。
    // 光锥/音擎：常驻角色的专武可歪，剔除即可歪的专武
    // 星铁角色：静态常驻名单 + 后来转常驻的角色（按抽卡时间判定）
    // 绝区零：常驻名单 + 3.1 转入的月城柳/凯撒/朱鸢（按抽卡月份判定），见 isZzzWaiPoolRecord
    const isLightconePool = key === 'GachaType_EquipmentUp' || key === 'GachaType_CollabEquipmentUp' ||
      key === 'GachaType_WeaponUp' || key === 'GachaType_RerunWeapon'
    const limitedRecords = game === 'zzz'
      ? recent.filter(r => !isZzzWaiPoolRecord(r))
      : (isLightconePool
        ? recent.filter(r => !SR_WAI_POOL_LIGHTCONES.has(String(r?.name || '')))
        : recent.filter(r => !isSrWaiPoolRecord(r)))
    const limitedNum = limitedRecords.length
    // 「每UP花费」只对存在 50/50 小保底的池有意义；常驻/新手池没有 UP，
    // 显示数值会误导（实测常驻池 243 抽 ÷ 3 = 81 被当成「UP平均」展示）
    const upPool = WAI_POOL_KEYS.has(key)
    // 五星累计消耗 = 总抽数 − 当前垫抽；工坊来源的 totalPulls 含三星逐抽，口径一致
    const waiSpent = Math.max(0, totalPulls - pity)
    const upAvg = upPool && upNum ? (waiSpent / upNum).toFixed(1) : '--'
    let upYs = upPool && upNum ? String(Math.round(Number(upAvg) * 160)) : '--'
    if (upPool && upNum && Number(upYs) >= 10000) upYs = `${(Number(upYs) / 10000).toFixed(2)}w`
    const maxPity = pullValues.length ? Math.max(...pullValues) : 0
    const minPity = pullValues.length ? Math.min(...pullValues) : 0
    // 小保底不歪率（净不歪率）：= (总五星−2×歪)/(总五星−歪)，见 calcNoWaiRate。
    // 分母=小保底总场数，分子=净不歪（总场数扣掉输的场）；必得（大保底 UP）不单独扣。
    // 新手池 / 常驻池无 50/50，不歪率无意义，置 '--'。
    let upRate = '--'
    let noWai = null
    if (WAI_POOL_KEYS.has(key) && recent.length) {
      noWai = calcNoWaiRate(recent)
      // 不歪率 = (总五星−2×歪)/(总五星−歪)；分子为净不歪，可能为负，
      // 显示钳到 0 避免负百分比；分母为小保底总场数，为 0（全歪）时置 '--'
      upRate = noWai.noWaiDen > 0 ? pct(Math.max(0, noWai.noWaiNum), noWai.noWaiDen) : '--'
    }
    /* 图标资源根：原来指向 plugins/miao-plugin/resources，miao 卸载后
       Character/Weapon 查到的相对路径全部 404（常驻池等没有自带 icon 的记录
       就完全没有图标）。改用本插件 resources，meta-sr 里 face/icon 都在。 */
    const MIAO_RES = '../../../../../plugins/HoYoGet-Plugin/resources'
    const miaoGame = game === 'zzz' ? 'zzz' : 'sr'
    // 绝区零：官方物品配置接口忽略 game 参数只返回星铁数据，miao-plugin 也无绝区零资源，
    // 且图源站点在本机不可达，因此这里只认记录自带的 icon，不做任何猜测性拼接
    const makeIcon = item => {
      if (game === 'zzz') return item?.icon || ''
      // 记录自带图标优先：星穹工坊云端同步时按 item_id 从官方物品配置反查得到，官方 CDN 可达。
      // 此前这里直接丢弃 item.icon 改用 miao 查表，而 miao 的星铁 data.json 不提供
      // imgs.face（98 个角色全为空），于是星铁卡片从来没有头像
      if (item?.icon) return item.icon
      try {
        const { Character, Weapon } = miaoModels || {}
        if (item.item_type === '角色' && Character) {
          const char = Character.get(item.name, miaoGame)
          const face = char?.imgs?.face || char?.face || ''
          if (face) return `${MIAO_RES}${face}`
        }
        if (item.item_type === '光锥' && Weapon) {
          const weapon = Weapon.get(item.name, miaoGame)
          const img = weapon?.getData?.('img')?.img || weapon?.img || ''
          if (img) return `${MIAO_RES}/${String(img).replace(/^\//, '')}`
        }
      } catch {}
      // miao 星铁角色的 imgs 目录里有 face.webp，只是 data.json 未引用，按约定路径兜底
      const name = String(item?.name || '')
      if (game === 'sr' && item?.item_type === '角色' && name) {
        const local = `meta-sr/character/${name}/imgs/face.webp`
        try {
          if (fs.existsSync(path.join(process.cwd(), 'plugins/HoYoGet-Plugin/resources', local))) {
            return `${MIAO_RES}/${local}`
          }
        } catch {}
      }
      return ''
    }
    // 五星历史：按时间倒序，供卡片网格使用
    const fiveLog = recent.map(item => {
      const pulls = Number(item.gacha_count || 0)
      const time = item.time || timeFromId(item.id)
      const full = String(time || '').slice(0, 10)
      return {
        name: item.name || '未知',
        id: String(item.id || ''),
        item_type: item.item_type || '',
        icon: makeIcon(item),
        num: pulls,
        isUp: isUpRec(item),
        isNull: false,
        year: full.slice(0, 4) || '----',
        fullDate: full || '--',
        monthDay: full.slice(5) || '--',
      }
    }).sort((a, b) => {
      const ai = BigInt(String(a.id || '0'))
      const bi = BigInt(String(b.id || '0'))
      if (ai === bi) return String(b.fullDate).localeCompare(String(a.fullDate))
      return ai > bi ? -1 : 1
    })
    // 按年份分组（年份倒序，组内保持时间倒序）
    const yearGroups = []
    for (const item of fiveLog) {
      let group = yearGroups.find(g => g.year === item.year)
      if (!group) {
        group = { year: item.year, list: [] }
        yearGroups.push(group)
      }
      group.list.push(item)
    }
    // 数据总览：两行 x 四列
    const fourPity = Number(pool.fourPity || 0) || 0
    const line = [
      [
        { num: fiveNum ? pity : '--', unit: '', lable: '未出五星' },
        { num: fiveAvg, unit: '', lable: '五星平均' },
        { num: upRate, unit: upRate === '--' ? '' : '%', lable: '小保底不歪率' },
        { num: maxPity || '--', unit: '', lable: '最非' },
      ],
      [
        { num: fourPity || '--', unit: '', lable: '未出四星' },
        { num: upAvg, unit: '', lable: 'UP平均' },
        { num: upYs, unit: '', lable: `UP花费${conf.currency}` },
        { num: minPity || '--', unit: '', lable: '最欧' },
      ],
    ]
    return {
      ...pool,
      key,
      type: conf.typeMap[key] || pool.type || conf.typeMap[defPool.key] || '',
      labelClass: conf.labelClassMap[key] || conf.labelClassMap[defPool.key] || 'common',
      name: pool.name || '未知',
      allNum: totalPulls,
      fiveNum,
      upNum,
      pity,
      maxPity,
      minPity,
      upRate: `${upRate}%`,
      noWai,
      fiveLog,
      yearGroups,
      line,
      fiveAvg,
      firstTime: fiveLog.length ? fiveLog[fiveLog.length - 1].fullDate : '--',
      lastTime: fiveLog.length ? fiveLog[0].fullDate : '--',
      /* 总览表用的精简字段：模板不直接索引 line[1][1]，避免数据不全时炸模板 */
      upAvgText: upAvg,
      fourPityText: fourPity || '--',
      allNumText: totalPulls || 0,
      fiveNumText: fiveNum || 0,
      pityText: pity || 0,
    }
  }).sort((a, b) => {
    const ia = conf.poolOrder.indexOf(a.key)
    const ib = conf.poolOrder.indexOf(b.key)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  // progress 进度条布局：每个卡池生成一个进度区块
  if (layout === 'progress') {
    const nickname = data?.nickname || e?.nickname || e?.user?.nickname || (game === 'zzz' ? '绳匠' : '开拓者')
    const sections = []
    for (const pool of pools) {
      if (!pool.fiveNum && !pool.pity) continue
      const maxBar = Math.max(pool.maxPity || 0, pool.pity || 0, 80)
      const list = []
      if (pool.pity > 0) {
        list.push({
          isCurrent: true,
          date: formatNow().slice(5),
          name: '已抽',
          icon: '',
          num: pool.pity,
          isUp: false,
          pct: Math.min(100, Math.round((pool.pity / maxBar) * 100)),
          barClass: 'current',
        })
      }
      for (const item of pool.fiveLog || []) {
        const cls = item.num <= 10 ? 'gold' : (item.num < maxBar * 0.5 ? 'good' : (item.num < maxBar * 0.83 ? 'normal' : 'bad'))
        list.push({
          isCurrent: false,
          date: item.monthDay,
          name: item.name,
          icon: item.icon,
          num: item.num,
          isUp: item.isUp,
          pct: Math.min(100, Math.round((item.num / maxBar) * 100)),
          barClass: cls,
        })
      }
      sections.push({
        title: pool.name,
        labelClass: pool.labelClass,
        allNum: pool.allNum,
        fiveNum: pool.fiveNum,
        avgPity: pool.fiveAvg,
        upAvg: pool.line?.[1]?.[1]?.num || '--',
        upYs: pool.line?.[1]?.[2]?.num || '--',
        // 进度模板里货币文案写死过「星琼」，绝区零应为「菲林」；模板按该标记分支
        isZzz: game === 'zzz',
        list,
      })
    }
    return {
      uid,
      nickname,
      avatar: e?.user?.avatar || '',
      // 顶部指令提示与空状态文案按游戏区分（绝区零用菲林与绝区零指令）
      isZzz: game === 'zzz',
      sections,
    }
  }
  if (!pools.some(pool => pool.key === defPool.key)) {
    pools.push({
      key: defPool.key,
      type: conf.typeMap[defPool.key] || '',
      labelClass: conf.labelClassMap[defPool.key] || 'common',
      name: defPool.name,
      allNum: 0,
      fiveNum: 0,
      upNum: 0,
      pity: 0,
      maxPity: 0,
      minPity: 0,
      upRate: '--',
      fiveLog: [],
      yearGroups: [],
      line: [
        [{ num: '--', unit: '', lable: '未出五星' }, { num: '--', unit: '', lable: '五星平均' }, { num: '--', unit: '%', lable: '小保底不歪率' }, { num: '--', unit: '', lable: '最非' }],
        [{ num: '--', unit: '', lable: '未出四星' }, { num: '--', unit: '', lable: 'UP平均' }, { num: '--', unit: '', lable: `UP花费${conf.currency}` }, { num: '--', unit: '', lable: '最欧' }],
      ],
      firstTime: '--',
      lastTime: '--',
    })
  }
  return {
    uid,
    update_time: data?.update_time || '未知',
    pools,
  }
}

export function filterPools(data, keys = []) {
  if (!data?.pools) return data
  if (!keys.length) return data
  const pools = {}
  for (const [key, value] of Object.entries(data.pools)) {
    if (keys.includes(key)) pools[key] = value
  }
  return { ...data, pools }
}

/**
 * 星铁统计视图（工坊小程序风格）：顶部汇总大卡 + 五星头像网格 + 各池进度条，
 * 与「记录」（buildSummaryView progress 布局）模板区分。
 * 常驻跃迁是角色+光锥混合池，按 commonType（角色/光锥）拆分；网格与分池只含所选池。
 */
// 星铁合法池 key 白名单：剔除混入星铁数据里的绝区零池
// （如 GachaType_Permanent「常驻频段」、GachaType_Bangboo「邦布频段」）
const SR_POOL_KEYS = new Set([
  'GachaType_AvatarUp', 'GachaType_CollabAvatarUp',
  'GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp',
  'GachaType_Newbie', 'common',
])

// 绝区零的频段名。数据文件里的脏池 key 可能撞上星铁合法键（如 common），
// 所以除按 key 白名单外，再按名称剔一次，两条判据任一命中即丢弃
const ZZZ_POOL_NAMES = new Set(['独家频段', '独家重映', '音擎频段', '音擎回响', '常驻频段', '邦布频段'])

function cleanSrPools(pools) {
  const out = {}
  for (const [key, pool] of Object.entries(pools || {})) {
    if (!SR_POOL_KEYS.has(key)) continue
    if (ZZZ_POOL_NAMES.has(String(pool?.name || ''))) continue
    out[key] = pool
  }
  return out
}

export function buildSrStatView(data, uid, e, keys = [], commonType = null) {
  const pickByType = t => (t === '光锥' ? '光锥' : '角色')
  const cleanPools = cleanSrPools(data?.pools)
  // 常驻跃迁按类型决定是否纳入
  const wantedKeys = []
  for (const key of keys.length ? keys : Object.keys(cleanPools)) {
    if (key === 'common' && commonType) {
      const hasType = getPoolRecords(cleanPools[key]).some(r => pickByType(r.item_type) === commonType)
      if (hasType) wantedKeys.push(key)
      continue
    }
    wantedKeys.push(key)
  }

  const base = buildSummaryView(filterPools({ ...data, pools: cleanPools }, wantedKeys), uid, e, 'grid', 'sr')
  const pools = base.pools || []
  const sumOf = (list, field) => list.reduce((s, p) => s + (Number(p[field]) || 0), 0)
  const find = key => pools.find(p => p.key === key)

  // 常驻跃迁按类型拆分五星（fiveLog 已带 item_type）
  const commonPool = find('common')
  if (commonPool && commonType) {
    const keep = (commonPool.fiveLog || []).filter(it => pickByType(it.item_type) === commonType)
    commonPool.fiveLog = keep
    commonPool.fiveNum = keep.length
  }

  const allNum = sumOf(pools, 'allNum')
  const sNum = sumOf(pools, 'fiveNum')
  const avgGold = sNum ? (allNum / sNum).toFixed(1) : '--'
  // 称号：53.7 抽 → 「欧气满满大欧皇」（对齐工坊），其余沿用现有分级
  const title = avgGold === '--' ? '暂无记录' : avgGold <= 55 ? '欧气满满大欧皇' : avgGold <= 65 ? '天选打工人' : avgGold <= 78 ? '平平无奇小保底' : '水逆缠身大非酋'

  // 四项指标（工坊口径）：小保底不歪（按统计类型）、五星数、角色UP平均、武器UP平均
  // 「角色UP平均 / 武器UP平均」与另一类型的不歪率属全账号口径，
  // 不受本次统计范围（keys）过滤影响，故从全量池视图取值
  const allBase = buildSummaryView(filterPools({ ...data, pools: cleanPools }, Object.keys(cleanPools)), uid, e, 'grid', 'sr')
  const allFind = key => allBase.pools.find(p => p.key === key)
  const allChar = allFind('GachaType_AvatarUp')
  const allWeapon = allFind('GachaType_EquipmentUp')
  const ratePool = commonType === '光锥' ? allWeapon : allChar
  // 池存在但一个五星都没有时 upRate 是 '--%'，统一显示为 '--'
  const rateNum = ratePool && ratePool.fiveNum ? ratePool.upRate : '--'
  const metrics = [
    { num: rateNum, unit: '', lable: '小保底不歪' },
    { num: sNum, unit: '金', lable: '五星数' },
    // 文案取「角色UP平均 / 武器UP平均」：原「每UP角色需 / 每UP光锥需」在指标栏宽度下
    // 会折成三行，把 85.2 这类数值与标签错开
    { num: allChar?.line?.[1]?.[1]?.num ?? '--', unit: '抽', lable: '角色UP平均' },
    { num: allWeapon?.line?.[1]?.[1]?.num ?? '--', unit: '抽', lable: '武器UP平均' },
  ]

  // 连击标签：角色/光锥的当前连UP与最长连歪（全账号口径，用 allChar/allWeapon）
  const chips = []
  for (const [pool, label] of [[allChar, '角色'], [allWeapon, '光锥']]) {
    const log = pool?.fiveLog || []
    let upStreak = 0
    for (const it of log) { if (it.isUp) upStreak++; else break }
    let worstStreak = 0
    let curStreak = 0
    for (const it of log) {
      if (it.isUp === false) { curStreak++; worstStreak = Math.max(worstStreak, curStreak) } else curStreak = 0
    }
    if (upStreak > 1) chips.push(`${label}${upStreak}连UP`)
    if (worstStreak > 1) chips.push(`${label}${worstStreak}连歪`)
  }

  // 五星头像网格：同名去重计数（保持首次出现顺序）
  const gridMap = new Map()
  for (const pool of pools) {
    for (const it of pool.fiveLog || []) {
      const g = gridMap.get(it.name) || { name: it.name, icon: it.icon, count: 0 }
      g.count++
      if (!g.icon) g.icon = it.icon
      gridMap.set(it.name, g)
    }
  }

  // 网格标题：限定（UP 池）与常驻（常驻/新手池）分开计数
  const limitedNum = sumOf(pools.filter(p => p.key !== 'common' && p.key !== 'GachaType_Newbie'), 'fiveNum')
  const commonNum = (find('common')?.fiveNum || 0) + (find('GachaType_Newbie')?.fiveNum || 0)
  const gridTitle = commonType || !commonNum
    ? `共获得五星 ${sNum} 个，具体如下：`
    : `共获得限定五星 ${limitedNum} 个，常驻五星 ${commonNum} 个，具体如下：`

  // 分池进度条：长度按抽数相对保底的比例（角色池 90、光锥池 80），颜色阈值同比例
  // 会歪的池：普通 UP 池与联动跃迁（联动同样存在小保底歪，工坊不标注、本卡标注）
  const UP_POOLS = new Set(['GachaType_AvatarUp', 'GachaType_EquipmentUp', 'GachaType_CollabAvatarUp', 'GachaType_CollabEquipmentUp'])
  const pityBaseOf = p => (p.key === 'GachaType_EquipmentUp' || p.key === 'GachaType_CollabEquipmentUp' ? 80 : 90)
  const pctOf = (n, base) => Math.min(100, Math.max(8, Math.round((Number(n) / base) * 100)))
  const clsOf = (n, base) => (n < base * 0.5 ? 'good' : n < base * 0.78 ? 'mid' : 'bad')
  const sections = pools.map(p => {
    const base = pityBaseOf(p)
    return {
      name: p.name,
      pity: p.pity || 0,
      pityPct: p.pity ? pctOf(p.pity, base) : 0,
      list: (p.fiveLog || []).map(it => {
        // 常驻跃迁混合池：光锥按 80 保底、角色按 90
        const itemBase = p.key === 'common' ? (pickByType(it.item_type) === '光锥' ? 80 : 90) : base
        return {
          icon: it.icon || '',
          num: it.num,
          pct: pctOf(it.num, itemBase),
          wai: it.isUp === false && UP_POOLS.has(p.key),
          cls: clsOf(it.num, itemBase),
        }
      }),
    }
  }).filter(sec => sec.pity > 0 || sec.list.length)

  // 右上角：本次统计范围最新一个五星 + 「XX池N出」（对齐工坊「新手池50出」）
  const NOTE_BY_KEY = {
    GachaType_AvatarUp: '角色池',
    GachaType_CollabAvatarUp: '联动角色池',
    GachaType_EquipmentUp: '光锥池',
    GachaType_CollabEquipmentUp: '联动光锥池',
    GachaType_Newbie: '新手池',
    common: '常驻池',
  }
  const firstS = pools.map(p => ({ key: p.key, first: (p.fiveLog || [])[0] })).find(x => x.first)

  return {
    uid,
    total: {
      uid,
      title,
      allNum,
      avgGold,
      sNum,
      chips,
      metrics,
      grid: [...gridMap.values()],
      gridTitle,
      avatar: firstS?.first?.icon || '',
      avatarNote: firstS ? `${NOTE_BY_KEY[firstS.key]}${firstS.first.num}出` : '暂无五星',
    },
    sections,
  }
}

export async function requestJson(url, options = {}, retry = 3) {
  let last
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, options)
      const data = await res.json()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { res, data }
    } catch (e) {
      last = e
      if (i < retry - 1) await sleep(600 * (i + 1))
    }
  }
  throw last
}

function normalizeRecordsByPool(list = []) {
  const pools = {}
  for (const pool of POOLS) {
    pools[pool.key] = { ...pool, records: [], pity: 0, totalPulls: 0, fiveNum: 0, upNum: 0, avgPity: 0 }
  }
  for (const row of list) {
    if (row?.got_item !== true || row?.item?.rarity !== 5) continue
    const pool = POOLS.find(v => v.type === row.gacha_type || row?.gacha_type === v.type)
    if (!pool) continue
    const itemType = row.item.item_type === 'ItemType_Avatar' ? '角色' : '光锥'
    const rec = {
      id: String(row.id || row.uuid || ''),
      name: row.item.name || '未知',
      item_type: itemType,
      is_up: row.is_up === true,
      gacha_count: Number(row.gacha_count) >= 0 ? Number(row.gacha_count) : null,
      time: row.time || '',
      icon: row.item.icon || row.item.image || '',
    }
    pools[pool.key].records.push(rec)
  }

  for (const pool of Object.values(pools)) {
    pool.records.sort((a, b) => String(b.time).localeCompare(String(a.time)))
    pool.fiveNum = pool.records.length
    pool.upNum = pool.records.filter(v => v.is_up).length
    pool.totalPulls = sum(pool.records, 'gacha_count') + (pool.pity || 0)
    pool.avgPity = pool.fiveNum ? (sum(pool.records, 'gacha_count') / pool.fiveNum).toFixed(1) : '0.0'
    pool.latest = pool.records[0]?.time || ''
    pool.records = pool.records.slice(0, 8)
  }

  return { pools }
}

async function getUserAuth(e) {
  const qq = e.user_id
  const uid = e.user?.getUid?.('sr')
  if (!uid) return { error: '请先用 genshin 侧绑定星铁账号，再更新抽卡记录' }

  const getCookieFile = await getSrSummaryFn('getSrGachaCookieFile')
  const readCookie = await getSrSummaryFn('readSrGachaCookie')
  const cookieFile = getCookieFile ? getCookieFile(qq) : `./data/srGachaSummary/${uid}.json`
  const candidates = [
    readCookie ? readCookie(cookieFile) : null,
    e.cookie,
  ]
  try {
    const MysInfoCls = await getGenshinMysInfo()
    if (!MysInfoCls) return { error: '未找到 genshin 的 mysInfo 模块，请更新 genshin 插件' }
    const mysInfo = new MysInfoCls(e)
    mysInfo.uid = uid
    candidates.push(await mysInfo.getCookie('sr'))
  } catch {}
  try {
    candidates.push(e.user?.getMysUser?.('sr')?.ck)
  } catch {}

  const cookies = [...new Set(candidates.map(v => String(v || '').trim()).filter(Boolean))]
  if (!cookies.length) return { error: '请先用 genshin 侧绑定星铁账号，再更新抽卡记录' }
  return { qq, uid, cookies, cookieFile }
}

async function refreshBadgeCookie(uid, ck, region) {
  const { res, data } = await requestJson(BADGE_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: 'https://act.mihoyo.com',
      referer: 'https://act.mihoyo.com/',
      Cookie: ck,
    },
    body: JSON.stringify({ uid, region, game_biz: 'hkrpg_cn', lang: 'zh-cn' }),
  })
  if (data?.retcode !== 0) throw new Error(data?.message || '换取徽章会话失败')
  const token = setCookieValue(res.headers, 'e_hkrpg_token')
  if (!token) throw new Error('未获取到 e_hkrpg_token')
  return `${ck};e_hkrpg_token=${token}`
}

/**
 * 用 ck 直接拉取常驻池（gacha_type=1）。
 *
 * 原来这里绕道 genshin 的 GachaLog.getGcLogData()，导致 HoYoGet 必须依赖
 * genshin 里有 model/gachaLog/gachaLog.js（较新版本才有），
 * 缺失时整个插件 ERR_MODULE_NOT_FOUND 而无法加载。
 *
 * 现改用本文件已有的 fetchPool() + buildPoolFromRows()——两者是本插件自己
 * 实现的同一套徽章接口翻页逻辑（fetchPool 此前无调用者，正是为 authkey 之外
 * 的 ck 路径预留的），因此常驻池不再依赖任何 genshin 模块。
 *
 * 注意：srGachaSummary 的 SR_GACHA_POOLS 只有 5 个池，不含常驻，
 * 所以 ck 更新时必须在这里单独补 type 1，否则常驻会被旧数据顶掉。
 */
async function fetchCommonPoolByCk(uid, region, ck) {
  const rows = await fetchPool(uid, region, ck, '1')
  if (!rows?.length) return null
  const pool = buildPoolFromRows('1', { key: 'common', name: '常驻跃迁' }, rows)
  return pool?.records?.length || pool?.totalPulls ? pool : null
}

async function fetchPool(uid, region, ck, gachaType) {
  let versionId = ''
  let maxId = ''
  const rows = []
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      game_biz: 'hkrpg_cn',
      region,
      uid: String(uid),
      badge_region: region,
      badge_uid: String(uid),
      gacha_type: gachaType,
    })
    if (versionId) params.set('version_id', versionId)
    if (maxId) params.set('max_id', maxId)
    const { data } = await requestJson(`${API_URL}?${params}`, {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://act.mihoyo.com',
        referer: 'https://act.mihoyo.com/',
        'x-rpc-platform': 'android',
        'x-rpc-jump_source': '2',
        Cookie: ck,
      },
    })
    if (data?.retcode !== 0) throw new Error(data?.message || '获取跃迁记录失败')
    const list = data?.data?.list || []
    rows.push(...list)
    if (!data?.data?.has_more) break
    versionId = data?.data?.version_id || ''
    maxId = data?.data?.next_max_id || ''
    if (!versionId || !maxId) break
  }
  return rows
}

function getDataFile(uid, qq) {
  return `${PLUGIN_ROOT}/data/sr_gacha/${qq}/${uid}/summary.json`
}

// ===== 官方抽卡链接（authkey）全量拉取 =====
// 官方网页版跃迁记录链接带 authkey，权限高于小程序 ck，
// 可获取全部卡池（含常驻/新手）与全部星级（含四星）记录
// 新版跃迁记录接口（与官方网页版一致）：gacha_type 数字 → 池定义
const NEW_POOLS = [
  { type: '11', key: 'GachaType_AvatarUp', name: '角色活动跃迁', hint: '角色' },
  { type: '12', key: 'GachaType_EquipmentUp', name: '光锥活动跃迁', hint: '光锥' },
  { type: '21', key: 'GachaType_CollabAvatarUp', name: '联动角色跃迁', hint: '联动角色' },
  { type: '22', key: 'GachaType_CollabEquipmentUp', name: '联动光锥跃迁', hint: '联动光锥' },
  { type: '2', key: 'GachaType_Newbie', name: '新手跃迁', hint: '新手' },
  { type: '1', key: 'common', name: '常驻跃迁', hint: '常驻' },
]
const GACHA_LOG_HOST_CN = 'https://public-operation-hkrpg.mihoyo.com'
const GACHA_LOG_HOST_OS = 'https://public-operation-hkrpg-sg.hoyoverse.com'

export function parseGachaUrl(url) {
  try {
    const u = String(url).trim().replace(/〈=/g, '&=')
    // 依次尝试从 getGachaLog? / getLdGachaLog? / index.html? / 最后一个 ? 后取参数
    let query = ''
    for (const mark of ['getLdGachaLog?', 'getGachaLog?', 'index.html?', '?']) {
      const idx = u.indexOf(mark)
      if (idx >= 0) {
        query = u.slice(idx + mark.length)
        break
      }
    }
    if (!query.includes('authkey')) return null
    const params = Object.fromEntries(new URLSearchParams(query))
    const authkey = String(params.authkey || '').replace(/(#\/log|#\/|#).*$/, '')
    if (!authkey) return null
    // 归属校验：game_biz 必须含 hkrpg，否则视为其他游戏链接
    const gameBiz = String(params.game_biz || '')
    if (gameBiz && !gameBiz.includes('hkrpg')) return null
    // game_biz 规范化：链接里可能是截断的 hkrpg_，补齐为国服
    const normalizedBiz = /^hkrpg_cn$/.test(gameBiz) || gameBiz.startsWith('hkrpg_global') ? gameBiz : 'hkrpg_cn'
    return {
      ...params,
      authkey,
      game_biz: normalizedBiz,
      region: params.region || 'prod_gf_cn',
    }
  } catch {
    return null
  }
}

/** 从消息中收集所有可能的链接：覆盖文本段、share/json/xml 卡片、CQ 码 raw_message，去重保序 */
export function extractUrlsFromMsg(e) {
  const urls = new Set()
  const add = str => {
    if (!str) return
    const list = String(str).match(/https?:\/\/[^\s"'<>，。、；;）)】\]》]+/g) || []
    for (let u of list) {
      u = u.replace(/[.,，。、；;:：)>】\]》"']+$/, '')
      if (u.length > 20) urls.add(u)
    }
  }
  add(e.msg)
  if (Array.isArray(e.message))
    for (const s of e.message) {
      if (s?.type === 'text') add(s.text)
      else if (s?.data) for (const k of Object.keys(s.data)) add(s.data[k])
    }
  // CQ 码原始消息：share/json/xml 卡片里的链接全在里头
  add(e.raw_message)
  return [...urls]
}

/** 从消息中找出含 authkey 的星铁跃迁链接（遍历所有候选链接，不依赖第一个） */
function findSrAuthkeyUrl(e) {
  for (const url of extractUrlsFromMsg(e)) {
    const query = parseGachaUrl(url)
    const isSr = /hkrpg/i.test(url) || /hkrpg/i.test(String(query?.game_biz || ''))
    if (query?.authkey && isSr) return url
  }
  return ''
}

// 新版 getGachaLog：page 恒为 1，靠 end_id 游标翻页；联动池走 getLdGachaLog
async function fetchGachaLogPage(query, gachaType, size, endId, page = 1) {
  const region = query.region || 'prod_gf_cn'
  const host = /^prod_(gf|qd)_cn$/.test(region) ? GACHA_LOG_HOST_CN : GACHA_LOG_HOST_OS
  const ep = (gachaType === '21' || gachaType === '22') ? 'getLdGachaLog' : 'getGachaLog'
  const gameBiz = /^hkrpg_(cn|global)/.test(String(query.game_biz || '')) ? query.game_biz : 'hkrpg_cn'
  // 尽量保留原始链接里的全部参数，和 genshin 的 logApi 保持一致。
  const params = new URLSearchParams({
    ...query,
    authkey_ver: query.authkey_ver || '1',
    lang: query.lang || 'zh-cn',
    game_biz: gameBiz,
    region,
    authkey: query.authkey,
    gacha_type: gachaType,
    page: String(page),
    size: String(size),
    end_id: String(endId || '0'),
  })
  // 新接口路径 gacha_record（authkey_ver=4 新版链接仅兼容此接口）；裸请求，不设置任何特殊头
  const { res, data } = await requestJson(`${host}/common/gacha_record/api/${ep}?${params}`)
  if (!res.ok) throw new Error(`接口 HTTP ${res.status}`)
  if (data?.retcode !== 0) {
    const msg = String(data?.message || '')
    if ([-100, -101, -111].includes(Number(data.retcode)) || /timeout|expire|login/.test(msg)) {
      throw new Error('authkey 已过期或无效，请从游戏内重新打开【跃迁记录】并复制最新链接')
    }
    throw new Error(msg || '获取抽卡记录失败')
  }
  return data?.data || { list: [] }
}

async function resolveAuthkeyRegion(query) {
  const candidates = []
  if (query?.region) candidates.push(query.region)
  candidates.push('prod_gf_cn', 'prod_qd_cn')
  const seen = new Set()
  for (const region of candidates) {
    if (!region || seen.has(region)) continue
    seen.add(region)
    try {
      const probe = await fetchGachaLogPage({ ...query, region }, '11', 1, '0')
      if (Array.isArray(probe?.list) && probe.list.length > 0) return region
    } catch {}
  }
  return query?.region || 'prod_gf_cn'
}

// 把某个卡池的全量记录统计成渲染所需结构（含四星保底）
export function buildPoolFromRows(gachaType, pool, rows) {
  const base = {
    ...(pool || {}),
    type: gachaType,
    key: pool?.key,
    name: pool?.name || gachaType,
    records: [],
    fourLog: [],
    pity: 0,
    fourPity: 0,
    totalPulls: 0,
    fiveNum: 0,
    upNum: 0,
    avgPity: '0.0',
    recent: [],
  }
  if (!rows?.length) return base
  // 按 id 升序（旧→新），比 time 更稳定，能保留同秒多抽的真实顺序
  rows.sort((a, b) => {
    const ai = BigInt(String(a.id || '0'))
    const bi = BigInt(String(b.id || '0'))
    if (ai === bi) return String(a.time).localeCompare(String(b.time))
    return ai < bi ? -1 : 1
  })
  let pulls = 0
  let fourPulls = 0
  let fourNum = 0
  const fiveRecs = []
  const fourRecs = []
  for (const row of rows) {
    pulls++
    fourPulls++
    const rank = String(row.rank_type || row.gacha_rank_type || '')
    const itemType = row.item_type === '角色' || row.item_type === '光锥' ? row.item_type : (String(row.item_id || '').length === 5 ? '角色' : '光锥')
    if (rank === '5') {
      fiveRecs.push({
        id: String(row.id || ''),
        name: row.name || '未知',
        item_type: itemType,
        // 联动跃迁同样存在小保底歪；authkey 接口不返回 is_up，先置 false 由 ck/工坊校准
        is_up: false,
        gacha_count: pulls,
        time: row.time || '',
        icon: row.icon || '',
      })
      pulls = 0
    } else if (rank === '4') {
      fourNum++
      if (fourRecs.length < 10) {
        fourRecs.push({
          id: String(row.id || ''),
          name: row.name || '未知',
          item_type: itemType,
          is_up: false,
          gacha_count: fourPulls,
          time: row.time || '',
          icon: row.icon || '',
        })
      }
      fourPulls = 0
    }
  }
  fourRecs.sort((a, b) => String(b.time).localeCompare(String(a.time)))
  const fiveNum = fiveRecs.length
  return {
    ...base,
    records: fiveRecs.slice().reverse(),
    fourLog: fourRecs,
    fourNum,
    pity: pulls,
    fourPity: fourPulls,
    totalPulls: rows.length,
    fiveNum,
    avgPity: fiveNum ? (rows.length / fiveNum).toFixed(1) : '0.0',
  }
}

export async function fetchAllByAuthkey(query) {
  const region = await resolveAuthkeyRegion(query)
  const resolvedQuery = { ...query, region }
  const pools = {}
  for (const pool of NEW_POOLS) {
    const rows = []
    const seenIds = new Set()
    let endId = '0'
    let page = 1
    const size = 20
    let pageCount = 0
    while (pageCount < 120) {
      const data = await fetchGachaLogPage(resolvedQuery, pool.type, size, endId, page)
      const list = data?.list || []
      if (!list.length) break
      // 按 id 去重：网页接口偶发重复返回最近几条记录，不去重会导致垫抽/总抽数虚高
      const before = rows.length
      for (const row of list) {
        const id = String(row?.id || '')
        if (id && seenIds.has(id)) continue
        if (id) seenIds.add(id)
        rows.push(row)
      }
      if (rows.length === before) break // 本页全部是重复记录，避免死循环
      endId = rows[rows.length - 1]?.id || ''
      if (!endId || list.length < size) break
      page++
      pageCount++
      // 控制请求节奏，避免触发官方限流（visit too frequently）
      await sleep(500)
    }
    // 卡池之间拉开间隔，防止连续请求触发限流
    await sleep(1000)
    pools[pool.key] = buildPoolFromRows(pool.type, pool, rows)
  }
  return { pools, region }
}

/* ===== 星铁小助手（lelaer）全量文件导入 =====
   小助手把导入过的记录存进自家 gachabackup 表，可经小程序「同步云端 → 导出 JSON」拿到
   四个池的逐抽全量（含四星），比官方 authkey 的半年窗口长得多；lelaer 无可用在线接口，
   故数据来自本机已导出的 data/sr_gacha/sr_{UID}_full.json，由 importHelperFull 读取。
   与星穹工坊的分工（实测某账号）：
     · 小助手：2925 条逐抽全量，但**没有 is_up 字段**
     · 星穹工坊（api.lingyuan.design）：仅五星与统计，但**带 is_up**
   工坊返回的 id 体系与本机小助手/ck 记录不同，按 id 并集会在同一池叠加出重复五星
   （抽卡重叠），因此本模块对「小助手有的池」采取整池覆盖（见 mergeSrHelperFull），
   仅继承旧记录的 is_up 标记，不按 id 并集。 */

const SR_HELPER_POOL_KEYS = {
  roleList: null, // 角色池，池内还混有联动角色（gacha_type 21），按条目字段拆
  weaponList: null,
  normalList: null,
  newbieList: null,
}
const SR_GACHA_TYPE_MAP = {
  '11': { key: 'GachaType_AvatarUp', name: '角色活动跃迁' },
  '21': { key: 'GachaType_CollabAvatarUp', name: '联动角色跃迁' },
  '12': { key: 'GachaType_EquipmentUp', name: '光锥活动跃迁' },
  '22': { key: 'GachaType_CollabEquipmentUp', name: '联动光锥跃迁' },
  '1': { key: 'common', name: '常驻跃迁' },
  '2': { key: 'GachaType_Newbie', name: '新手跃迁' },
}

/** 读取本地的小助手全量导出文件（data/sr_gacha/sr_{uid}_full.json） */
export function readSrHelperFullFile(uid) {
  const file = `${PLUGIN_ROOT}/data/sr_gacha/sr_${uid}_full.json`
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch (err) {
    logger.warn(`[HoYoGet][sr_gacha] 小助手全量文件解析失败：${err?.message || err}`)
    return null
  }
}

/* ===== 星铁小助手（lelaer）数据库直连 =====
   lelaer 的 HTTP 接口（getWishHistory.php / getWishDetail.php / getWishAuthkey.php /
   getGachaRank.php）实测拿不到单 UID 的逐抽详情（getWishHistory 忽略 uid 返回公共
   样例、getWishDetail 500、getWishAuthkey 参数错误、getGachaRank 只是排行榜），
   数据只存在其 MySQL 的 gachabackup 表（gachaData longtext 存四池全量逐抽）。
   因此「更新小助手抽卡记录」只能直连该库读取（凭据来自小助手 conn_aliyun.php 明文）。
   需要：插件装 mysql2 依赖、且服务器 IP 在该 RDS 白名单内。 */
const LELAER_DB = {
  host: 'rm-wz9q977u3l08hbowtno.mysql.rds.aliyuncs.com',
  user: 'zzpro',
  password: 'aaaaaa89',
  database: 'starrail',
}

async function fetchLelaerGachaData(uid) {
  let mysql
  try { mysql = await import('mysql2/promise') } catch {
    throw new Error('插件缺少 mysql2 依赖，请在 plugins/HoYoGet-Plugin 目录执行 `pnpm i mysql2` 后重试')
  }
  const conn = await mysql.createConnection({ ...LELAER_DB, connectTimeout: 10000 })
  try {
    const [rows] = await conn.query('SELECT gachaData FROM gachabackup WHERE uid = ? ORDER BY id DESC LIMIT 1', [String(uid)])
    if (!rows?.length || !rows[0].gachaData) {
      throw new Error(`小助手云端没有 UID:${uid} 的抽卡记录（可能未在小助手同步过云端）`)
    }
    let obj
    try { obj = JSON.parse(rows[0].gachaData) } catch { throw new Error('小助手云端数据解析失败') }
    return obj
  } finally {
    await conn.end()
  }
}

/** 逐抽记录 -> 渲染所需 pool（按 id 升序遍历才能算出每个条目之前的累计抽数） */
function buildPoolFromPulls(gachaType, rows) {
  const def = SR_GACHA_TYPE_MAP[gachaType]
  const sorted = [ ...rows ].sort((a, b) => {
    const ai = BigInt(String(a?.id || '0'))
    const bi = BigInt(String(b?.id || '0'))
    if (ai === bi) return String(a?.time || '').localeCompare(String(b?.time || ''))
    return ai < bi ? -1 : 1
  })
  let pulls = 0
  let fourPulls = 0
  const five = []
  const four = []
  for (const row of sorted) {
    pulls++
    fourPulls++
    const rank = String(row?.rank_type || '')
    const base = {
      id: String(row?.id || ''),
      name: row?.name || '未知',
      item_type: row?.item_type === '光锥' ? '光锥' : '角色',
      // 联动跃迁同样存在小保底歪；authkey 接口不返回 is_up，先置 false 由 ck/工坊校准
      is_up: false,
      gacha_count: 0,
      time: row?.time || '',
      icon: '',
    }
    if (rank === '5') {
      five.push({ ...base, gacha_count: pulls })
      pulls = 0
    } else if (rank === '4') {
      four.push({ ...base, gacha_count: fourPulls })
      fourPulls = 0
    }
    // 三星不入库：卡片统计只认四星与五星
  }
  five.reverse()
  four.sort((a, b) => String(b.time).localeCompare(String(a.time)))
  return {
    key: def.key,
    type: gachaType,
    name: def.name,
    records: five,
    fourLog: four,
    fourNum: four.length,
    pity: pulls,
    fourPity: fourPulls,
    totalPulls: rows.length,
    fiveNum: five.length,
    upNum: 0,
    avgPity: five.length ? (rows.length / five.length).toFixed(1) : '0.0',
  }
}

/**
 * 把小助手全量并入现有 pools。
 * 逐抽明细以小助手为准（它是超集），旧记录里已有的 is_up 标记继承下来——
 * 小助手导出没有该字段，若直接覆盖会把星穹工坊辛苦算出的 UP 标记弄丢。
 */
export function mergeSrHelperFull(pools, full) {
  const grouped = new Map()
  // 小助手导出的逐抽可能含重复行（多次云端同步时尾部记录偶发重复），按 id 全局去重，
  // 否则同一五星会在同一卡池出现两份、总抽数虚高（即「角色跃迁重复」）。
  // 与 fetchAllByAuthkey 的 seenIds 逻辑一致：跨四个池统一判重，同一 id 只保留首次出现。
  const seenIds = new Set()
  for (const list of Object.keys(SR_HELPER_POOL_KEYS)) {
    for (const row of Array.isArray(full?.[list]) ? full[list] : []) {
      const gachaType = String(row?.gacha_type || '')
      if (!SR_GACHA_TYPE_MAP[gachaType]) continue
      const rid = String(row?.id || '')
      if (rid && seenIds.has(rid)) continue
      if (rid) seenIds.add(rid)
      if (!grouped.has(gachaType)) grouped.set(gachaType, [])
      grouped.get(gachaType).push(row)
    }
  }
  const result = { addedFive: 0, addedFour: 0, pools: [] }
  for (const [ gachaType, rows ] of grouped) {
    const incoming = buildPoolFromPulls(gachaType, rows)
    const old = pools?.[incoming.key]
    if (!old) {
      result.pools.push(incoming)
      result.addedFive += incoming.fiveNum
      result.addedFour += incoming.fourNum
      continue
    }
    // 谁抽数多谁更准：小助手可能只是最近才导入链接、数据偏少，整池覆盖会
    // 把更全的旧数据（授权链接 / authkey）顶掉（实测刃 77 抽被算成 33）。
    // 故不再无条件以整池覆盖小助手，而是与 authkey/ck 合并一致——
    // 取记录更多（抽数更多）的一方整池保留；id 体系不同无法安全并集。
    const oldRecords = getPoolRecords(old)
    const newRecords = getPoolRecords(incoming)
    if (pickFullerRecords(oldRecords, newRecords) === newRecords) {
      // 小助手数据更多 → 以小助手为准（五星/四星明细取自它），
      // 仅按「名称+抽数」「名称+时间」继承旧记录的 is_up 标记（小助手导出无该字段）
      const oldUp = new Map()
      for (const r of oldRecords) {
        if (r?.is_up === true) {
          oldUp.set(`${r.name}|${r.gacha_count}`, true)
          oldUp.set(`${r.name}|${r.time}`, true)
        }
      }
      const records = incoming.records.map(rec => {
        const up = oldUp.get(`${rec.name}|${rec.gacha_count}`) || oldUp.get(`${rec.name}|${rec.time}`)
        return up ? { ...rec, is_up: true } : rec
      })
      result.addedFive += records.length
      result.addedFour += incoming.fourNum
      result.pools.push(recountPool({
        ...old,
        records,
        fourLog: incoming.fourLog,
        totalPulls: incoming.totalPulls,
        fourNum: incoming.fourNum,
        fourPity: incoming.fourPity,
        // pity 必须一并覆盖：...old 会带入旧池的垫抽数，recountPool 按
        // countTotal(records) + pity 重算总抽数，旧值会把 totalPulls 抬高
        // （实测角色活动跃迁 226 抽被显示成 270 抽、五星平均 75.3 变 90.0）
        pity: incoming.pity,
      }, records))
    } else {
      // 旧数据更多 → 保留更全的旧池，不被稀疏的小助手覆盖
      result.pools.push(old)
    }
  }
  return result
}

// 从旧数据继承五星 is_up 标记（authkey 接口不返回 UP 标记）
export function inheritIsUp(oldPools, newPools) {
  for (const key of Object.keys(newPools)) {
    const old = oldPools?.[key]
    if (!old?.records?.length) continue
    const oldMap = new Map()
    for (const r of old.records) oldMap.set(`${r.name}|${r.time}`, !!r.is_up)
    for (const r of newPools[key].records || []) {
      if (oldMap.get(`${r.name}|${r.time}`)) r.is_up = true
    }
  }
  return newPools
}

/**
 * 把 ck（five_star_list）的 is_up 盖到合并后的记录上。
 *
 * 与 mergeIsUp 的区别：这里**只按「名称 + 抽数」匹配**，不用 time。
 * 原因是 ck 侧 five_star_list 返回的 time 恒为空字符串，而 authkey/小助手
 * 侧才有精确时间，两边 time 永远对不上；`name|time` 那个 key 等于失效。
 * 抽数则两边一致（都是官方口径），且同一池内 name+gacha_count 唯一 ——
 * 同一角色在池内重复出现时抽数各不相同（如某联动角色池里某角色出现 3 次，
 * 抽数分别为 78 / 77 / 4），不会误配。
 *
 * 只写 true 不写 false：ck 是唯一带 is_up 的源，但若某池 ck 没覆盖到
 * （如 authkey 才有的更早期记录），不该被当成「非 UP」写死。
 */
function applyCkIsUp(ckPools, pools) {
  if (!ckPools) return pools
  const up = new Set()
  for (const pool of Object.values(ckPools)) {
    for (const r of getPoolRecords(pool)) {
      if (r?.is_up === true) up.add(`${r.name}|${r.gacha_count}`)
    }
  }
  if (!up.size) return pools
  for (const pool of Object.values(pools || {})) {
    for (const r of pool?.records || []) {
      if (up.has(`${r.name}|${r.gacha_count}`)) r.is_up = true
    }
  }
  return pools
}

/**
 * 按可歪池名单补齐 is_up —— 常驻角色（含专武）在限定池被抽到**必然是歪**，
 * 这是无需任何接口即可确定的强约束，可用来给缺失标记的记录兜底。
 *
 * 反过来不成立：限定角色抽到也可能是歪（歪到另一个限定），所以不能推断 true。
 * 因此本函数只写 false，不写 true。
 *
 * 典型场景：小助手 / 星穹工坊返回的记录缺 is_up，导入时统一填了 false，
 * 其中「其实是 UP」的无法判断（保持现状等 ck 校准），但「确实是歪」的
 * 这些常驻角色本就该是 false，本函数让它们与推断出的歪保持一致。
 */
function applyWaiPoolIsUp(pools) {
  for (const [key, pool] of Object.entries(pools || {})) {
    const isLightconePool = key === 'GachaType_EquipmentUp' || key === 'GachaType_CollabEquipmentUp'
    const list = pool?.records || []
    const waiOf = rec => isLightconePool
      ? SR_WAI_POOL_LIGHTCONES.has(String(rec?.name || ''))
      : isSrWaiPoolRecord(rec)
    // 先把可歪池记录一律标为歪
    for (const r of list) if (waiOf(r)) r.is_up = false

    // 再补 UP：可歪池记录必然是歪，它之后按id 顺序紧邻的下一个五星
    // 即为当期 UP —— 歪到常驻角色不会把保底让出去，下一发出的五星才是UP。
    // 依据：某账号角色池 8 处「常驻歪 → 下一五星」中 7 处被数据源标为 UP，
    // 无一例外（唯一未标的那条托帕同为限定角色，判断为漏标而非规则失效）。
    const ordered = [...list].sort((a, b) => cmpRecordId(a, b))
    for (let i = 0; i < ordered.length - 1; i++) {
      if (waiOf(ordered[i]) && ordered[i + 1]?.is_up !== true) ordered[i + 1].is_up = true
    }
  }
  return pools
}

/** 按 id 升序比较（id 为大整数字符串，需用 BigInt 避免精度丢失） */
function cmpRecordId(a, b) {
  const x = BigInt(String(a?.id || '0') || '0')
  const y = BigInt(String(b?.id || '0') || '0')
  return x === y ? String(a?.time || '').localeCompare(String(b?.time || '')) : (x < y ? -1 : 1)
}

// 用 ck（five_star_list 接口，返回准确 UP 标记）校准 authkey 结果的 is_up：
// authkey 全量接口不带 is_up，新五星只能靠 ck 数据补全，否则会被全部当成非UP
export function mergeIsUp(summaryPools, newPools) {
  if (!summaryPools) return newPools
  const map = new Map()
  for (const pool of Object.values(summaryPools)) {
    const list = pool?.records || pool?.recent || pool?.fiveLog || []
    for (const r of list) {
      const name = r.name || ''
      if (!name) continue
      map.set(`${name}|${r.time}`, !!r.is_up)
      map.set(`${name}|${r.gacha_count ?? r.num}`, !!r.is_up)
    }
  }
  for (const pool of Object.values(newPools || {})) {
    for (const r of pool?.records || []) {
      const up = map.get(`${r.name}|${r.time}`) ?? map.get(`${r.name}|${r.gacha_count}`)
      if (up !== undefined) r.is_up = up
    }
  }
  return newPools
}

// ---- 两条数据源合并策略 ----
// 数据源特性：
//   ck（#米哈游星铁更新抽卡记录 / five_star_list）：五星历史全（小程序保留一年），但不含四星/逐抽/常驻
//   authkey（#米哈游星铁抽卡链接 / getGachaLog）：全量逐抽含四星，但网页只保留近半年，超过半年的
//     五星拉不到、或 gacha_count 被截断算小（如刃从完整 77 被算成 33）
// 因此合并原则：
//   1. 五星记录：整份保留"更全"的一方（数量多者；数量相同取 gacha_count 总和更大者），
//      不做逐条匹配——ck 与 authkey 的字段（id/time/num）并不一致，逐条去重会误删
//   2. 四星/常驻：authkey 有 ck 无，ck 更新时从旧数据继承
//   3. 垫抽/统计：由本次拉取的数据源（最新）提供，并按选定的五星历史重算 totalPulls

// 兼容 records/recent/fiveLog 三种字段、gacha_count/num 两种抽数字段
export function getPoolRecords(pool) {
  if (Array.isArray(pool?.records)) return pool.records
  if (Array.isArray(pool?.recent)) return pool.recent
  return Array.isArray(pool?.fiveLog) ? pool.fiveLog : []
}

export function countTotal(records) {
  return (records || []).reduce((s, r) => s + Number(r?.gacha_count ?? r?.num ?? 0), 0)
}

// 两份五星记录中挑"更完整"的一份
// 云端与本地记录按 id 合并，而不是整组二选一。
// 云端（api.lingyuan.design）并非总能覆盖全部期次——实测某账号的限定角色池
// 云端只有 15 个五星且整段缺 2025，而本地 ck/徽章侧有 2025 的记录；
// 若按「取更全的一组」替换，本地独有记录会被云端整段顶掉。
// 同id 时以新记录（云端）字段优先，用于补名称、图标与抽数。
export function unionRecords(oldRecords, newRecords) {
  const byId = new Map()
  for (const row of oldRecords || []) {
    if (row?.id) byId.set(String(row.id), { ...row })
  }
  for (const row of newRecords || []) {
    const id = String(row?.id || '')
    if (!id) continue
    const exist = byId.get(id)
    if (!exist) {
      byId.set(id, { ...row })
      continue
    }
    const merged = { ...exist }
    for (const [ key, value ] of Object.entries(row)) {
      if (value !== '' && value !== null && value !== undefined) merged[key] = value
    }
    byId.set(id, merged)
  }
  return [ ...byId.values() ].sort((a, b) => String(b.id).localeCompare(String(a.id)))
}

function pickFullerRecords(oldRecords, newRecords) {
  const o = oldRecords || []
  const n = newRecords || []
  if (!o.length) return n
  if (!n.length) return o
  if (o.length !== n.length) return o.length > n.length ? o : n
  return countTotal(o) >= countTotal(n) ? o : n
}

// 按选定的五星记录重算统计值；pity 兼容数字或 { gacha_count } 两种格式
export function recountPool(pool, records) {
  const pity = Number(typeof pool?.pity === 'object' ? pool.pity?.gacha_count : pool.pity || 0) || 0
  const fiveNum = records.length
  const totalPulls = countTotal(records) + pity
  return {
    ...pool,
    records,
    fiveNum,
    totalPulls: totalPulls || pool?.totalPulls || 0,
    avgPity: fiveNum ? (totalPulls / fiveNum).toFixed(1) : '0.0',
  }
}

// 发链接（authkey）后调用：五星历史取更全一份，四星/垫抽用本次 authkey 数据
function mergePoolsForAuthkey(oldPools, newPools) {
  for (const key of Object.keys(newPools || {})) {
    const oldPool = oldPools?.[key]
    const newPool = newPools[key]
    if (!oldPool) continue
    newPools[key] = recountPool(newPool, pickFullerRecords(getPoolRecords(oldPool), getPoolRecords(newPool)))
  }
  // authkey 接口不返回常驻池，保留旧数据里的常驻记录
  if (oldPools?.common && !newPools?.common) newPools.common = oldPools.common
  return newPools
}

// ck 更新后调用：五星历史取更全一份，四星/常驻从旧数据（authkey）继承，避免 ck 覆盖丢四星
function mergePoolsForCk(oldPools, newPools) {
  for (const key of Object.keys(newPools || {})) {
    const oldPool = oldPools?.[key]
    const newPool = newPools[key]
    if (!oldPool) continue
    if (!newPool?.fourLog?.length) newPool.fourLog = oldPool.fourLog || []
    if (!newPool?.fourNum) newPool.fourNum = oldPool.fourNum || 0
    if (!newPool?.fourPity) newPool.fourPity = oldPool.fourPity || 0
    newPools[key] = recountPool(newPool, pickFullerRecords(getPoolRecords(oldPool), getPoolRecords(newPool)))
  }
  // ck 接口不返回常驻池，保留旧数据里的常驻记录
  if (oldPools?.common && !newPools?.common) newPools.common = oldPools.common
  return newPools
}

function getSrRegion(uid) {
  return /^5/.test(String(uid || '')) ? 'prod_qd_cn' : 'prod_gf_cn'
}

function md5Hex(str) {
  return createHash('md5').update(str, 'utf8').digest('hex')
}

// 米游社 DS 签名，算法与 genshin 插件一致（国服 salt）
function getDs(query = '', body = '') {
  const salt = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const ds = md5Hex(`salt=${salt}&t=${t}&r=${r}&b=${body}&q=${query}`)
  return `${t},${r},${ds}`
}

// 通过 genshin 绑定的崩铁 ck 获取游戏内昵称/头像
// 崩铁 index 接口要求 DS 签名（裸请求会被拒绝），故改用与 genshin 插件相同的 record 域名 + DS 头
async function fetchSrUserInfo(uid, ck) {
  const query = `role_id=${String(uid)}&server=${getSrRegion(uid)}`
  const { data } = await requestJson(
    `https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api/index?${query}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://act.mihoyo.com',
        referer: 'https://act.mihoyo.com/',
        'x-rpc-app_version': '2.40.1',
        'x-rpc-client_type': '5',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Mobile Safari/537.36',
        DS: getDs(query),
        Cookie: ck,
      },
    }
  )
  if (data?.retcode !== 0) throw new Error(data?.message || '获取角色信息失败')
  return data?.data || {}
}

// 米游社名片接口：免 DS，直接返回昵称/米游社头像
async function fetchGameRecordCard(uid, ck) {
  const { data } = await requestJson(
    `https://api-takumi.mihoyo.com/game_record/card/wapi/getGameRecordCard?uid=${String(uid)}`,
    {
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: 'https://api-takumi.mihoyo.com',
        referer: 'https://webstatic.mihoyo.com/',
        'x-rpc-client_type': '5',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Mobile Safari/537.36',
        Cookie: ck,
      },
    }
  )
  if (data?.retcode !== 0) throw new Error(data?.message || '获取用户信息失败')
  const list = data?.data?.list || []
  const mine = list.find(item => String(item.uid) === String(uid)) || list[0]
  return {
    nickname: mine?.nickname || '',
    avatar: mine?.avatar_url || '',
  }
}

export function readData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ===== 星穹工坊云端记录（api.lingyuan.design）=====
// 星穹工坊把导入过的记录存在自家云端（api.lingyuan.design），保留约三年，
// 比官方 ck（约一年）与 authkey 网页版（半年）都久，可补齐更早的五星记录。
// 接口带 union_id 参数（云端只校验非空、不校验内容，未绑定时用占位值兜底）；
// 绑定入口见 #米哈游绑定小助手，保留以防云端将来启用校验。
// 接口带 union_id 参数，但云端只校验该参数非空、不校验内容（实测传任意非空值
// 都返回该 UID 的完整记录），因此未绑定时用占位值兜底即可。
// 保留 #米哈游绑定小助手 入口是为了云端将来启用校验时无需改逻辑。
const HELPER_FALLBACK_UNION_ID = '1'
const HELPER_API = 'https://api.lingyuan.design/api/v2/game_user/get_sr_draw_v3'
const HELPER_POOL_MAP = {
  role_up_card_result: { key: 'GachaType_AvatarUp', type: '11', name: '角色活动跃迁' },
  guang_up_card_result: { key: 'GachaType_EquipmentUp', type: '12', name: '光锥活动跃迁' },
  common_card_result: { key: 'common', type: '1', name: '常驻跃迁' },
  init_card_result: { key: 'GachaType_Newbie', type: '2', name: '新手跃迁' },
}
// 集录跃迁（rd_card_*_result）是独立机制，不并入常规卡池，避免污染保底统计
function getHelperFile(qq) {
  return `${PLUGIN_ROOT}/data/sr_gacha/${qq}/helper.json`
}

function readHelperBind(qq) {
  return readData(getHelperFile(qq))
}

function saveHelperBind(qq, data) {
  saveData(getHelperFile(qq), data)
}

// union_id 允许直接给纯字符串，也允许粘贴含 union_id 的网址/分享文本后自动提取
function parseUnionId(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const fromUrl = raw.match(/union_id=([A-Za-z0-9_-]+)/)
  if (fromUrl) return fromUrl[1]
  return /^[A-Za-z0-9_-]{6,64}$/.test(raw) ? raw : ''
}

// 自动识别 union_id：扫描本机微信 PC 的 webview HTTP 缓存，
// 星穹工坊请求过云端后会留下形如 .../get_sr_draw_v3?...&union_id=XXX 的 URL。
// 仅在本机装有微信 PC 时有效；识别不到时回落到手动绑定。
function detectHelperUnionId() {
  try {
    const appData = process.env?.APPDATA
    if (!appData) return ''
    const profilesRoot = path.join(appData, 'Tencent', 'xwechat', 'radium', 'web', 'profiles')
    if (!fs.existsSync(profilesRoot)) return ''
    const profiles = fs.readdirSync(profilesRoot).filter(n => String(n).startsWith('webview_'))
    for (const p of profiles) {
      const cacheDir = path.join(profilesRoot, p, 'Cache', 'Cache_Data')
      if (!fs.existsSync(cacheDir)) continue
      let files = []
      try { files = fs.readdirSync(cacheDir) } catch { continue }
      for (const f of files) {
        if (!f.startsWith('data_')) continue
        let txt = ''
        try { txt = fs.readFileSync(path.join(cacheDir, f), 'latin1') } catch { continue }
        if (!txt.includes('lingyuan.design')) continue
        const m = txt.match(/union_id=([A-Za-z0-9_-]{6,64})/)
        if (m?.[1]) return m[1]
      }
    }
    return ''
  } catch (err) {
    logger.mark(`[HoYoGet][sr_gacha] 自动识别星穹工坊 union_id 失败：${err?.message || err}`)
    return ''
  }
}

// 用已有记录的时间→名称给星穹工坊缺失名称的五星补名（同一次抽卡时间一致）
function buildNameHint(pools) {
  const map = new Map()
  for (const pool of Object.values(pools || {})) {
    for (const r of getPoolRecords(pool)) {
      const t = String(r?.time || '').slice(0, 19)
      if (t && r?.name) map.set(t, r.name)
    }
  }
  return map
}

// 官方物品配置索引：item_id -> { name, icon }，另附名称 -> icon 兜底。
// 云端记录只给 item_id，且多数条目连 name 都没有（渲染会退化成【ID:xxxx】），
// 故按 item_id 反查名称与图标，名称查不到时再退回按名称查。
// 结果缓存到 redis，避免每次同步都拉一遍。
const ITEM_CONFIG_API = 'https://api-takumi.mihoyo.com/event/rpgsimulator/config?game=hkrpg'
const ITEM_CONFIG_CACHE_KEY = 'sr_gacha_helper_item_index'

function buildSrItemIndex(data) {
  const byId = new Map()
  const iconByName = new Map()
  for (const item of [...(data?.avatar || []), ...(data?.equipment || [])]) {
    const name = item?.item_name || item?.name || ''
    const icon = item?.icon_url || item?.new_icon_url || ''
    if (item?.item_id) byId.set(String(item.item_id), { name, icon })
    if (name && icon) iconByName.set(String(name), icon)
  }
  return { byId, iconByName }
}

async function loadSrItemIndex() {
  try {
    const cached = await redis.get(ITEM_CONFIG_CACHE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      return { byId: new Map(parsed.byId), iconByName: new Map(parsed.iconByName) }
    }
  } catch (err) {
    logger.mark(`[HoYoGet][sr_gacha] 读取物品配置缓存失败：${err?.message || err}`)
  }
  let index = { byId: new Map(), iconByName: new Map() }
  try {
    const { data } = await requestJson(ITEM_CONFIG_API)
    index = buildSrItemIndex(data?.data)
    if (index.byId.size) {
      try {
        await redis.set(
          ITEM_CONFIG_CACHE_KEY,
          JSON.stringify({ byId: [...index.byId], iconByName: [...index.iconByName] }),
          'EX',
          7 * 24 * 3600
        )
      } catch (err) {
        logger.mark(`[HoYoGet][sr_gacha] 写入物品配置缓存失败：${err?.message || err}`)
      }
    }
  } catch (err) {
    logger.mark(`[HoYoGet][sr_gacha] 物品配置获取失败，云端记录可能显示为ID 且无图标：${err?.message || err}`)
  }
  return index
}

async function fetchHelperCloud(uid, unionId) {
  const url = `${HELPER_API}?uid=${encodeURIComponent(String(uid))}&union_id=${encodeURIComponent(String(unionId))}`
  const { data } = await requestJson(url, {
    headers: {
      accept: 'application/json, text/plain, */*',
      referer: 'https://starrail.lelaer.com/',
      origin: 'https://starrail.lelaer.com',
    },
  })
  if (Number(data?.code) !== 0) throw new Error(data?.message || '星穹工坊云端返回异常')
  const analysis = data?.data?.card_analysis_json
  if (!analysis) throw new Error('星穹工坊云端未返回该 UID 的抽卡数据，请确认 UID 是否正确')
  return analysis
}

// 星穹工坊云端分析 → 插件渲染所需的 pools 结构
function convertHelperPools(analysis, nameHint, itemIndex) {
  const pools = {}
  for (const [field, def] of Object.entries(HELPER_POOL_MAP)) {
    const p = analysis?.[field]
    if (!p) continue
    const records = (Array.isArray(p.five_cards) ? p.five_cards : []).map(c => {
      const time = c?.time || ''
      // 云端多数条目不带 name，先按 item_id 从官方配置取名，再退回云端名/本地同时间记录
      const meta = itemIndex?.byId?.get(String(c?.item_id ?? ''))
      const name = meta?.name || c?.name || nameHint.get(String(time).slice(0, 19)) || `【ID:${c?.item_id ?? '?'}】`
      return {
        id: String(c?.id || ''),
        name,
        item_type: c?.item_type === '光锥' ? '光锥' : '角色',
        is_up: c?.is_up === true,
        gacha_count: Number(c?.draw_total || 0),
        time,
        // 云端不返回图标：先按 item_id 取，再按名称兜底；都没有则留空由模板跳过
        icon: meta?.icon || itemIndex?.iconByName?.get(name) || '',
      }
    })
    const fiveNum = records.length
    const totalPulls = Number(p.draw_total || 0)
    const avg = Number(p.xbd_avg || 0)
    pools[def.key] = {
      key: def.key,
      type: def.type,
      name: def.name,
      records,
      fourLog: [],
      fourNum: (Number(p.four_role_total || 0) || 0) + (Number(p.four_guang_total || 0) || 0),
      fourPity: 0,
      pity: Number(p?.dian_card_infos?.draw_total || 0) || 0,
      totalPulls,
      fiveNum,
      upNum: records.filter(r => r.is_up).length,
      avgPity: avg > 0 ? String(avg) : (fiveNum ? (totalPulls / fiveNum).toFixed(1) : '0.0'),
      latest: records[0]?.time || '',
      nickname: p.avg_nick_name || '',
    }
  }
  return pools
}

// 合并后回填缺失图标：pickFullerRecords 是整组二选一，可能继续沿用旧记录，
// 而旧记录是早期云端同步写入的（当时 icon 为空），故按名称统一补一次。
function fillMissingIcons(pools, itemIndex) {
  for (const pool of Object.values(pools || {})) {
    for (const key of ['records', 'fiveLog', 'recent']) {
      if (!Array.isArray(pool?.[key])) continue
      for (const row of pool[key]) {
        if (!row || row.icon) continue
        const icon = itemIndex?.iconByName?.get(String(row.name || '')) || ''
        if (icon) row.icon = icon
      }
    }
  }
  return pools
}

// 云端只存五星与统计，四星/常驻明细仍以本地既有数据（ck/authkey）为准：
// 五星取更全的一份，四星与垫抽从旧数据继承
function mergeHelperPools(oldPools, newPools) {
  for (const key of Object.keys(newPools || {})) {
    const old = oldPools?.[key]
    if (!old) continue
    const oldRecs = getPoolRecords(old) || []
    const newRecs = getPoolRecords(newPools[key]) || []
    // 原则：来源与本地「谁五星记录多（抽数更多）谁更准」。小助手 / 工坊两个云端任一
    // 更全即以它为准，避免稀疏来源把更全数据顶掉，也避免旧写法以本地为主追加工坊独有
    // 五星、在工坊含更多不同名五星时把常驻数量算多（与 mergeSrHelperFull 一致）。
    // 工坊仅返回五星汇总 + is_up（无四星逐抽），当选中工坊为更全方时，四星 / 垫抽
    // 仍从旧数据继承，避免本地四星被丢弃。
    const chosen = pickFullerRecords(oldRecs, newRecs)
    let merged
    if (chosen === newRecs) {
      // 工坊更全：以工坊五星为准（is_up 由工坊提供），仅按 id / 名称+时间把本地
      // 同名记录的图标等补充字段并入（不覆盖工坊已有字段）
      const oldById = new Map()
      for (const r of oldRecs) if (r?.id) oldById.set(String(r.id), r)
      const oldByNameTime = new Map()
      for (const r of oldRecs) {
        const t = String(r?.time || '').slice(0, 19)
        if (t) oldByNameTime.set(`${r.name}|${t}`, r)
      }
      merged = newRecs.map(w => {
        const id = String(w?.id || '')
        let hit = id ? oldById.get(id) : null
        if (!hit) {
          const t = String(w?.time || '').slice(0, 19)
          if (t) hit = oldByNameTime.get(`${w.name}|${t}`)
        }
        if (!hit) return { ...w }
        const rec = { ...w }
        for (const [k, v] of Object.entries(hit)) {
          if (v !== '' && v !== null && v !== undefined && rec[k] === undefined) rec[k] = v
        }
        return rec
      })
    } else {
      // 本地更全（或数量持平）：以本地为主、按 id / 名称+时间补全工坊字段，
      // 工坊独有五星（本地缺的期次）才追加；本地记录绝不因合并而翻倍。
      const newById = new Map()
      for (const r of newRecs) if (r?.id) newById.set(String(r.id), r)
      const newByNameTime = new Map()
      for (const r of newRecs) {
        const t = String(r?.time || '').slice(0, 19)
        if (t) newByNameTime.set(`${r.name}|${t}`, r)
      }
      const usedNew = new Set()
      merged = []
      for (const r of oldRecs) {
        const id = String(r?.id || '')
        let hit = id ? newById.get(id) : null
        if (!hit) {
          const t = String(r?.time || '').slice(0, 19)
          if (t) hit = newByNameTime.get(`${r.name}|${t}`) || null
        }
        if (hit) {
          usedNew.add(hit)
          const rec = { ...r }
          for (const [k, v] of Object.entries(hit)) {
            if (v !== '' && v !== null && v !== undefined) rec[k] = v
          }
          merged.push(rec)
        } else {
          merged.push(r)
        }
      }
      // 工坊独有五星（本地缺的期次）：仅当本地无同名记录时才追加，
      // 避免时间格式不一致导致同名记录被误叠加
      for (const w of newRecs) {
        if (usedNew.has(w)) continue
        if (oldRecs.some(r => r?.name === w?.name)) continue
        merged.push({ ...w })
      }
    }
    newPools[key] = recountPool(newPools[key], merged)
    if (!newPools[key].fourLog?.length) newPools[key].fourLog = old.fourLog || []
    if (!newPools[key].fourNum) newPools[key].fourNum = old.fourNum || 0
    if (!newPools[key].fourPity) newPools[key].fourPity = old.fourPity || 0
  }
  // 云端没有的卡池（例如尚未解锁的新手池）保留旧数据
  for (const key of Object.keys(oldPools || {})) {
    if (!newPools[key]) newPools[key] = oldPools[key]
  }
  return newPools
}

export class sr_gacha extends plugin {
  constructor() {
    super({
      name: '[米哈游]星铁抽卡记录',
      dsc: '星铁抽卡记录查询与更新',
      event: 'message',
      priority: pluginPriority('sr_gacha', Number.MIN_SAFE_INTEGER),
      rule: [
        // 强制前缀模式：星铁抽卡链接必须带 #米哈游星铁抽卡链接 前缀才处理。
        // 不再兜底自动识别链接，原神/星铁等链接默认交给 genshin 插件，避免抢链接冲突
        { reg: '^#*米哈游(星铁|崩铁)?抽卡帮助$', fnc: 'help' },
        // 不带「米哈游」前缀：#星铁抽卡帮助 / 星铁抽卡帮助 / %星铁抽卡帮助
        // 必须带游戏名，否则会吃掉「抽卡帮助」这类无归属写法与绝区零的规则。
        { reg: '^[#*%％]?[ \t]*(?:星铁|崩铁|星穹铁道|sr|SR)[ \t]*抽卡帮助$', fnc: 'help' },
        { reg: '^#*米哈游(星铁|崩铁)?抽卡链接', fnc: 'gachaLink' },
        { reg: '^#*米哈游(星铁|崩铁)?(刷新|更新)抽卡记录$', fnc: 'refresh' },
        // 不带「米哈游」前缀：星铁更新抽卡记录 / #星铁更新抽卡记录 / *更新抽卡记录
        // 不接管的话会落到 genshin 的 sr_update，它出图依赖已被卸载的 miao。
        { reg: '^[#*%％]?[ \t]*(?:星铁|崩铁|星穹铁道|sr|SR)[ \t]*(刷新|更新)抽卡记录$', fnc: 'refresh' },
        { reg: '^[#*%％][ \t]*(刷新|更新)抽卡记录$', fnc: 'refresh' },
        { reg: '^#*米哈游(星铁|崩铁)?(抽卡记录|抽卡统计)$', fnc: 'summary' },
        { reg: '^#*米哈游(星铁|崩铁)?角色记录$', fnc: 'roleRecord' },
        { reg: '^#*米哈游(星铁|崩铁)?武器记录$', fnc: 'weaponRecord' },
        { reg: '^#*米哈游(星铁|崩铁)?角色统计$', fnc: 'roleStat' },
        { reg: '^#*米哈游(星铁|崩铁)?武器统计$', fnc: 'weaponStat' },
        { reg: '^#*米哈游(星铁|崩铁)?联动角色记录$', fnc: 'collabRoleRecord' },
        { reg: '^#*米哈游(星铁|崩铁)?联动武器记录$', fnc: 'collabWeaponRecord' },
        // 无 HoYoGet/小花火 前缀的裸指令（*角色记录、*角色统计 等）。
        // 喵喵的 `^#*(星铁)?(角色|武器|光锥)…(记录|统计)$` 里前缀全部可选，会把这些
        // 一并吃掉（实测 *角色记录 7 次、*角色统计 5 次落到喵喵）。本插件优先级 1
        // 比喵喵的 50 小、按框架升序本该先跑，但规则要求 米哈游 根本匹配不上，
        // 故补上裸指令形式。限定 * 前缀，不抢 genshin 侧的 # 指令；
        // 联动形式必须排在普通形式之前，否则会被抢。
        { reg: '^[\\*][ \\t]*(?:星铁|崩铁)?联动(角色|武器)(记录|统计)$', fnc: 'collabRoleOrWeapon' },
        { reg: '^[\\*][ \\t]*(?:星铁|崩铁)?(角色|武器)(记录|统计)$', fnc: 'roleOrWeapon' },
        { reg: '^#*米哈游(星铁|崩铁)?绑定小助手(\\s+\\S+)?$', fnc: 'bindHelper' },
        { reg: // 前缀必须带：本插件所有指令均需 #米哈游/ #小花火，否则会抢走
        // genshin 侧「#更新小助手抽卡记录」（原神·小助手）与「*更新小助手抽卡记录」（星铁·工坊别名）。
        // 小助手（lelaer）与星穹工坊（lingyuan）是两个不同云端，不可混用：
        //   · #米哈游(星铁)(更新|刷新|同步)小助手(抽卡)?(记录|数据) —— fnc: importHelperLive，
        //     直连小助手（lelaer）MySQL gachabackup 表拉全量（lelaer HTTP 接口拿不到单 UID，只能直连 DB）；
        //   · #米哈游(星铁)导入/合并小助手记录 <UID> —— fnc: importHelperFull，
        //     读取小助手（lelaer）云端导出的全量文件 data/sr_gacha/sr_<UID>_full.json（离线兜底）；
        //   · #米哈游(星铁)更新星穹工坊记录 / 更新工坊(抽卡)?记录 —— 同 updateHelper，
        //     走工坊（api.lingyuan.design）云端，仅五星汇总 + is_up。
        '^#*米哈游(星铁|崩铁)?(更新|刷新|同步)小助手(抽卡|跃迁)?(记录|数据)$', fnc: 'importHelperLive' },
        { reg: '^#*米哈游(星铁|崩铁)?(更新|刷新|同步)?星穹工坊(记录|数据)$', fnc: 'updateHelper' },
        { reg: '^#*米哈游(星铁|崩铁)?(更新|刷新|同步)?工坊(抽卡|跃迁)?(记录|数据)$', fnc: 'updateHelper' },
        { reg: '^#*米哈游(星铁|崩铁)?(导入|合并)小助手(记录|数据)?(\\s+\\S+)?$', fnc: 'importHelperFull' },
        { reg: '^#*米哈游(星铁|崩铁)?常驻(记录|统计)?$', fnc: 'common' },
      ],
    })
  }

  async refresh(e) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply('正在获取星铁抽卡记录，请稍候……')
    let lastError
    try {
      let result
      for (const cookie of auth.cookies) {
        try {
          const SrGachaSummaryCls = await getSrSummaryClass()
          if (typeof SrGachaSummaryCls !== 'function') {
            throw new Error('genshin 插件缺少 SrGachaSummary 类，请更新 genshin 插件')
          }
          const saveCookie = await getSrSummaryFn('saveSrGachaCookie')
          const summary = new SrGachaSummaryCls({ uid: auth.uid, cookie, file: `./data/srGachaSummary/${auth.uid}.json` })
          result = await summary.update()
          saveCookie?.(auth.cookieFile, cookie)
          break
        } catch (err) {
          lastError = err
          logger.mark(`[HoYoGet][sr_gacha] Cookie 候选失败：${err?.message || err}`)
        }
      }
      if (!result) throw lastError || new Error('没有可用的崩铁 Cookie')
      // 常驻池：srGachaSummary 的 SR_GACHA_POOLS 不含常驻，需用同一 ck 单独拉
      // type 1。彻底移除对 genshin 的 GachaLog 依赖。
      const oldFile = getDataFile(auth.qq, auth.uid)
      const old = readData(oldFile)
      for (const ck of auth.cookies) {
        try {
          const common = await fetchCommonPoolByCk(auth.uid, getSrRegion(auth.uid), ck)
          if (common?.records?.length) {
            result.pools.common = common
            break
          }
        } catch (error) {
          logger.mark(`[HoYoGet][sr_gacha] 常驻池拉取失败（ck 候选）：${error?.message || error}`)
        }
      }
      // 拉取失败时保留本地已有的常驻池，避免把 authkey/小助手导入的常驻覆盖成空
      if (!result.pools?.common || !getPoolRecords(result.pools.common).length) {
        const localCommon = old?.pools?.common
        if (getPoolRecords(localCommon).length) result.pools.common = localCommon
      }
      // ck 返回的 pools 深拷贝快照。mergePoolsForCk 会**原地**替换 newPools 里
      // 各池的 records（pickFullerRecords 整组二选一），只留引用的话快照也跟着
      // 被改，原始 is_up 就找不回来了，必须深拷贝。
      const ckPools = JSON.parse(JSON.stringify(result.pools || {}))
      result.update_time = formatNow()
      // 与已有数据合并（可能是 authkey 全量逐抽），避免 ck 更新覆盖丢四星/常驻；
      // ck 只负责补全更早的五星（小程序保留一年）与 UP 标记
      if (old?.pools) {
        result.pools = mergePoolsForCk(old.pools, result.pools)
        // 把 ck 的 is_up 盖到合并结果上（ck 是唯一带 is_up 的源，优先级最高）。
        //
        // 顺序很关键，必须在 mergePoolsForCk 之后：
        // 它内部 pickFullerRecords 是「整组二选一」，条数相同时按抽数总和取大的一边，
        // 联动角色池这类旧数据与 ck 条数一致的池子会选中旧的那组 ——
        // 而旧记录的 is_up 来自 authkey / 小助手（这两个源都不返回该字段，
        // 拉取时统一置 false），于是 ck 里正确的标记被整组丢弃。
        //
        // 症状：官方 five_star_list 对联动跃迁是有 is_up 的，
        // 但卡片显示 0.0% 小保底不歪率、UP 平均与 UP 花费均为 --，且无 UP 角标。
        result.pools = applyCkIsUp(ckPools, result.pools)
        result.pools = inheritIsUp(old.pools, result.pools)
      }
      saveData(getDataFile(auth.qq, auth.uid), result)
      const text = POOLS.map(pool => {
        const updated = result.addedByPool?.[pool.type] || 0
        return `【${pool.name}】记录获取成功，更新${updated}条`
      }).join('\n')
      const commonText = result.pools?.common?.recent?.length ? `\n【常驻跃迁】记录获取成功，更新${result.pools.common.recent.length}条` : ''
      try {
        const updated = Object.values(result.addedByPool || {}).reduce((a, b) => a + (Number(b) || 0), 0)
        appendTaskRecords([{ task: 'gacha', qq: e.user_id, name: e.sender?.card || e.sender?.nickname || '', game: '崩坏：星穹铁道', uid: auth.uid, tip: `更新 ${updated} 条`, source: e?.msg ? 'manual' : 'cron' }])
      } catch (err) { logger.debug?.(`[HoYoGet][sr_gacha] 写抽卡记录失败：${err?.message || err}`) }
      await e.reply(`${text}${commonText}\n抽卡记录更新完成`)
      // 更新完成后自动输出抽卡记录总览图
      await this.renderSummary(e, [], 'grid')
      return e.reply('发送【#米哈游星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[HoYoGet][sr_gacha] refresh failed:', err)
      if (String(err?.message || err).includes('请从游戏内打开参与活动')) {
        return e.reply('当前账号还没在游戏内打开过跃迁活动页。\n请先进《星穹铁道》里点开一次活动跃迁页面，再发送【#米哈游星铁更新抽卡记录】重试。')
      }
      const formatFailure = await getSrSummaryFn('formatSrGachaFailure')
      return e.reply(formatFailure ? formatFailure(err) : `更新失败：${err?.message || err}`)
    }
  }

  async renderSummary(e, keys = [], layout = 'grid', commonType = null) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const local = readData(getDataFile(auth.qq, auth.uid))
    const readSummary = await getSrSummaryFn('readSummary')
    let data = local || (readSummary ? readSummary(`./data/srGachaSummary/${auth.uid}.json`) : null)
    if (!data?.pools) return e.reply('暂无星铁抽卡记录，请先发送【#米哈游星铁更新抽卡记录】')
    // 剔除混入星铁数据的绝区零池（如 GachaType_Permanent「常驻频段」）；
    // 有剔除时顺手写回本插件的数据文件，把脏数据永久清掉，不必等下次更新覆盖
    const cleaned = cleanSrPools(data.pools)
    const dropped = Object.keys(data.pools).filter(k => !cleaned[k])
    if (dropped.length) {
      logger.mark(`[HoYoGet][sr_gacha] 已剔除混入星铁数据的池：${dropped.map(k => `${k}(${data.pools[k]?.name || '?'})`).join('、')}`)
      data = { ...data, pools: cleaned }
      if (local) {
        try { saveData(getDataFile(auth.qq, auth.uid), data) } catch (err) { logger.warn(`[HoYoGet][sr_gacha] 脏池写回失败：${err?.message || err}`) }
      }
    }
    // 常驻跃迁是角色+光锥混合池：按 commonType 只保留对应类型，避免角色记录混入光锥
    if (commonType && data?.pools?.common) {
      const pool = data.pools.common
      const filtered = getPoolRecords(pool).filter(r => (r.item_type || '角色') === commonType)
      data = { ...data, pools: { ...data.pools, common: { ...pool, records: filtered, recent: filtered, fiveNum: filtered.length } } }
    }
    // 可歪池角色在限定池必然是歪：渲染前统一补齐，避免缺标记时统计偏差
    applyWaiPoolIsUp(data.pools)
    const view = buildSummaryView(filterPools(data, keys), auth.uid, e, layout, 'sr', miaoModelsCache)
    if (layout === 'progress') {
      let avatar = ''
      try {
        // 头像优先读取 genshin 插件 [*uid][用户绑定(showUid)] 缓存的头像，与 *uid 卡片保持一致
        try {
          avatar = await redis.get(`Yz:genshin:uidFaceUrl:sr:${auth.uid}`)
        } catch (err) {
          logger.mark(`[HoYoGet][sr_gacha] 读取绑定头像缓存失败：${err?.message || err}`)
        }
        const info = await fetchSrUserInfo(auth.uid, auth.cookies[0])
        // 昵称在 role 字段中
        if (info?.role?.nickname) view.nickname = info.role.nickname
        if (!avatar) {
          // 缓存为空：从 index API 取头像 URL（role.AvatarUrl 为游戏内头像），并写入绑定缓存
          avatar = info?.role?.AvatarUrl || info?.avatar?.icon || ''
          if (avatar) {
            try {
              await redis.set(`Yz:genshin:uidFaceUrl:sr:${auth.uid}`, avatar, 'EX', 12 * 60 * 60)
            } catch (err) {
              logger.mark(`[HoYoGet][sr_gacha] 写入绑定头像缓存失败：${err?.message || err}`)
            }
          }
        }
        if (avatar) view.avatar = avatar
      } catch (error) {
        logger.mark(`[HoYoGet][sr_gacha] 获取星铁角色信息失败：${error?.message || error}`)
        // 兜底：先试免 DS 的米游社名片接口；仍失败则头像用小花火、昵称保持 QQ 昵称
        try {
          const card = await fetchGameRecordCard(auth.uid, auth.cookies[0])
          if (card?.nickname) view.nickname = card.nickname
          if (!view.avatar && card?.avatar) view.avatar = card.avatar
        } catch (err) {
          logger.mark(`[HoYoGet][sr_gacha] 名片接口兜底获取用户信息失败：${err?.message || err}`)
          logger.mark(`[HoYoGet][sr_gacha] 头像改用立绘，昵称使用 QQ 昵称`)
        }
      }
    }
    const template = layout === 'progress' ? 'sr_gacha/progress' : 'sr_gacha/summary'
    const buf = await render(template, view, { e })
    if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
    return e.reply(buf)
  }

  async summary(e) {
    return this.renderSummary(e, [], 'grid')
  }

  async roleRecord(e) {
    // 常驻跃迁是角色+光锥混合池，角色记录只保留角色（过滤光锥）
    return this.renderSummary(e, ['GachaType_AvatarUp', 'GachaType_CollabAvatarUp', 'common'], 'progress', '角色')
  }

  async weaponRecord(e) {
    // 常驻跃迁是角色+光锥混合池，武器记录只保留光锥
    return this.renderSummary(e, ['GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp', 'common'], 'progress', '光锥')
  }

  /** 统计视图：工坊风格（顶部汇总大卡 + 五星网格 + 分池进度条），与「记录」模板区分 */
  async renderSrStat(e, keys = [], commonType = null) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const readSummary = await getSrSummaryFn('readSummary')
    const data = readData(getDataFile(auth.qq, auth.uid))
      || (readSummary ? readSummary(`./data/srGachaSummary/${auth.uid}.json`) : null)
    if (!data?.pools) return e.reply('暂无星铁抽卡记录，请先发送【#米哈游星铁更新抽卡记录】')
    applyWaiPoolIsUp(data.pools)
    const view = buildSrStatView(data, auth.uid, e, keys, commonType)
    // pct 压低 sys.scale 的 zoom：统计卡内容行数多，避免渲染后端截图高度上限截断
    const buf = await render('sr_gacha/stat', view, { e, pct: 1.5 })
    if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
    return e.reply(buf)
  }

  async roleStat(e) {
    // 常驻跃迁只取角色
    return this.renderSrStat(e, ['GachaType_AvatarUp', 'GachaType_CollabAvatarUp', 'common'], '角色')
  }

  async weaponStat(e) {
    // 常驻跃迁只取光锥
    return this.renderSrStat(e, ['GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp', 'common'], '光锥')
  }

  async collabRoleRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabAvatarUp'], 'progress')
  }

  async collabWeaponRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabEquipmentUp'], 'progress')
  }

  /** 裸指令分发：*角色记录 / *武器记录 / *角色统计 / *武器统计 */
  async roleOrWeapon(e) {
    const msg = e.msg.replace(/(星铁|崩铁)/g, '')
    if (/角色/.test(msg)) return /统计/.test(msg) ? this.roleStat(e) : this.roleRecord(e)
    if (/武器/.test(msg)) return /统计/.test(msg) ? this.weaponStat(e) : this.weaponRecord(e)
    return false
  }

  /** 联动裸指令分发：*联动角色记录 等。联动池不含常驻，故不传 commonType */
  async collabRoleOrWeapon(e) {
    const msg = e.msg.replace(/(星铁|崩铁)/g, '')
    if (/角色/.test(msg)) {
      return /统计/.test(msg)
        ? this.renderSrStat(e, ['GachaType_CollabAvatarUp'])
        : this.collabRoleRecord(e)
    }
    if (/武器/.test(msg)) {
      return /统计/.test(msg)
        ? this.renderSrStat(e, ['GachaType_CollabEquipmentUp'])
        : this.collabWeaponRecord(e)
    }
    return false
  }

  async common(e) {
    return this.summary(e)
  }

  /** 兜底监听（强制前缀模式下已停用，规则已移除）：原实现为监听所有消息识别星铁链接 */
  async autoGachaLink(e) {
    try {
      const url = findSrAuthkeyUrl(e)
      if (!url) return false
      logger.mark(`[HoYoGet][sr_gacha] 兜底识别到星铁链接: ${url.slice(0, 150)}...`)
      return this.gachaLink(e, url)
    } catch (err) {
      logger.error(`[HoYoGet][sr_gacha] autoGachaLink 异常: ${err}`)
      return false
    }
  }

  async gachaLink(e, preUrl = '') {
    // 强制前缀模式：消息必须带 #米哈游星铁抽卡链接 前缀才处理。
    // 不带前缀的链接（原神/星铁/绝区零等）一律 return false 放行，交给 genshin 插件正常处理
    const isCmd = /^#*米哈游(星铁|崩铁)?抽卡链接/.test(String(e.msg || ''))
    if (!isCmd) return false
    // 从原始消息段提取链接：兼容纯文本、QQ 分享卡片（share/data.url）、json/xml 卡片、断行等情况
    const fullMsg = [e.msg, ...(Array.isArray(e.message) ? e.message.map(s => (s?.type === 'text' ? s.text : (s?.data?.url || ''))) : [])].filter(Boolean).join('\n')
    const url = preUrl || findSrAuthkeyUrl(e) || (fullMsg.match(/https?:\/\/[^\s,，。、；;）)】\]》"']+/)?.[0] || '')
    logger.mark(`[HoYoGet][sr_gacha] 收到链接消息: ${String(e.msg || '').slice(0, 200)}`)
    if (!url) {
      // 命令带链接：无链接时提示用法
      return e.reply(
        '请把崩铁官方【跃迁记录】页面的链接发给我，例如：\n' +
        '#米哈游星铁抽卡链接 https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?authkey=xxx&game_biz=hkrpg_cn\n\n' +
        '获取方法：游戏内打开【跃迁记录】→ 右上角【分享/网页】用浏览器打开 → 复制地址栏完整网址（必须带 authkey=）'
      )
    }
    const query = parseGachaUrl(url)
    // 非星铁链接（原神/绝区零等）主动放行，交给 genshin 插件正常处理
    const isSr = /hkrpg/i.test(url) || /hkrpg/i.test(String(query?.game_biz || ''))
    if (!query?.authkey || !isSr) return false
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply('正在通过官方抽卡链接获取完整记录（含四星/常驻/新手池），可能需要一两分钟，请稍候……')
    try {
      const result = await fetchAllByAuthkey(query)
      // authkey 接口不返回 is_up，用 ck（five_star_list 接口）校准新五星 UP 标记，
      // 否则刚发链接拉取的新五星会被全部当成非UP，导致角色池统计不准确
      for (const cookie of auth.cookies) {
        try {
          const SrGachaSummaryCls = await getSrSummaryClass()
          if (typeof SrGachaSummaryCls !== 'function') {
            throw new Error('genshin 插件缺少 SrGachaSummary 类，请更新 genshin 插件')
          }
          const summary = new SrGachaSummaryCls({ uid: auth.uid, cookie, file: `./data/srGachaSummary/${auth.uid}.json` })
          const sr = await summary.update()
          if (sr?.pools) {
            result.pools = mergeIsUp(sr.pools, result.pools)
            const saveCookie2 = await getSrSummaryFn('saveSrGachaCookie')
            saveCookie2?.(auth.cookieFile, cookie)
            break
          }
        } catch (err) {
          logger.mark(`[HoYoGet][sr_gacha] ck 校准 UP 标记失败：${err?.message || err}`)
        }
      }
      result.update_time = formatNow()
      result.uid = auth.uid
      result.source = 'authkey'
      saveData(getDataFile(auth.qq, auth.uid), result)
      const stats = Object.values(result.pools).map(p =>
        `【${p.name}】共${p.totalPulls}抽｜五星${p.fiveNum}｜四星${p.fourNum || 0}｜当前距五星${p.pity}抽`
      ).join('\n')
      await e.reply(`抽卡链接解析成功！\n${stats}`)
      // 自动输出抽卡记录总览图
      await this.renderSummary(e, [], 'grid')
      return e.reply('下一步必须发送#米哈游星铁更新抽卡记录来保证五星数据的准确性；发送【#米哈游星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[HoYoGet][sr_gacha] gachaLink failed:', err)
      return e.reply(`抽卡链接解析失败：${err?.message || err}`)
    }
  }

  // 绑定星穹工坊 union_id（按 QQ 存储）。指令名沿用「小助手」前缀以与原神侧保持一致
  async bindHelper(e) {
    const qq = e.user_id
    const arg = String(e.msg || '').match(/绑定小助手\s*(\S+)/)?.[1] || ''
    const unionId = parseUnionId(arg)
    if (!unionId) {
      // 未绑定且无参数时，先尝试从本机微信缓存自动识别
      if (!readHelperBind(qq)?.union_id) {
        const detected = detectHelperUnionId()
        if (detected) {
          saveHelperBind(qq, { union_id: detected, update_time: formatNow(), auto: true })
          return e.reply(`已从本机微信缓存自动识别并绑定 union_id：${detected}\n发送【#米哈游更新小助手抽卡记录】拉取云端记录`)
        }
      }
      const cur = readHelperBind(qq)
      return e.reply([
        '【小助手云端绑定】',
        cur?.union_id ? `当前已绑定 union_id：${cur.union_id}` : '尚未绑定 union_id（不影响同步）',
        '',
        '用法：#米哈游绑定小助手 <union_id>',
        'union_id 为小助手对应微信账号的身份标识，可选。',
        '云端目前只校验该参数非空、不校验内容，未绑定时同步会自动使用占位值；',
        '此处绑定仅用于云端将来启用校验时无需改动。',
        '',
        '发送【#米哈游更新小助手抽卡记录】可从小助手云端拉取约三年历史五星记录，',
        '补齐官方 ck（约一年）拿不到的更早数据。',
      ].join('\n'))
    }
    saveHelperBind(qq, { union_id: unionId, update_time: formatNow() })
    return e.reply(`小助手 union_id 绑定成功：${unionId}\n发送【#米哈游更新小助手抽卡记录】拉取云端记录`)
  }

  // 从星穹工坊云端同步抽卡记录（云端保留约三年，比 ck 更全）
  /**
   * 导入星铁小助手（lelaer）云端全量记录。
   *
   * 读本地的 `data/sr_gacha/sr_{UID}_full.json`（从小助手导出的四池逐抽全量，含四星），
   * 按 id 并入现有记录并保留旧有的 is_up 标记；不发任何网络请求。
   * 不带参数时用绑定账号的星铁 UID。
   */
  async importHelperFull(e) {
    const arg = String(e.msg || '').match(/小助手(?:记录|数据)?\s+(\d{5,})/)?.[1]
    const auth = await getUserAuth(e)
    if (auth.error && !arg) return e.reply(auth.error)
    const uid = arg || auth?.uid
    if (!uid) return e.reply('请先绑定星铁账号，或使用【#米哈游星铁导入小助手记录 <UID>】指定 UID')
    const full = readSrHelperFullFile(uid)
    if (!full) {
      return e.reply([
        `未找到 UID:${uid} 的小助手全量文件`,
        `期望路径：plugins/HoYoGet-Plugin/data/sr_gacha/sr_${uid}_full.json`,
        '请先在小助手同步云端记录并导出 JSON，再放到该路径。',
      ].join('\n'))
    }
    const file = getDataFile(auth?.qq || e.user_id, uid)
    let old = readData(file)
    if (!old?.pools) old = { uid, pools: {} }
    const result = mergeSrHelperFull(old.pools, full)
    if (!result.pools.length) return e.reply('小助手文件里没有识别到可用的卡池数据')
    for (const pool of result.pools) old.pools[pool.key] = pool
    saveData(file, { ...old, update_time: formatNow(), source: `${old.source || ''}+lelaer-full`.replace(/^\+/, '') })
    const detail = result.pools
      .map(p => `【${p.name}】${p.totalPulls}抽/五星${p.fiveNum}/四星${p.fourNum ?? 0}`)
      .join('\n')
    const total = result.pools.reduce((s, p) => s + Number(p.totalPulls || 0), 0)
    const five = result.pools.reduce((s, p) => s + Number(p.fiveNum || 0), 0)
    await e.reply([
      `UID:${uid} 小助手全量导入完成`,
      detail,
      '',
      `合计 ${total} 抽 / ${five} 个五星`,
      `本次新增：五星 ${result.addedFive} 条、四星 ${result.addedFour} 条`,
      '提示：小助手数据不含 is_up，UP 标记需再发【#米哈游星铁更新星穹工坊记录】补齐。',
    ].join('\n'))
    await this.renderSummary(e, [], 'grid')
    return true
  }

  /**
   * 直连小助手（lelaer）云端数据库拉全量（lelaer HTTP 接口拿不到单 UID，只能直连 DB）。
   * 返回结构同 readSrHelperFullFile：{ roleList, weaponList, normalList, newbieList }。
   */
  async importHelperLive(e) {
    const arg = String(e.msg || '').match(/小助手(?:抽卡|记录|数据)?\s+(\d{5,})/)?.[1]
    const auth = await getUserAuth(e)
    if (auth.error && !arg) return e.reply(auth.error)
    const uid = arg || auth?.uid
    if (!uid) return e.reply('请先绑定星铁账号，或使用【#米哈游星铁导入小助手记录 <UID>】指定 UID')
    await e.reply(`正在直连小助手云端拉取 UID:${uid} 的全量记录，请稍候……`)
    let full
    try { full = await fetchLelaerGachaData(uid) } catch (err) { return e.reply(`小助手云端拉取失败：${err?.message || err}`) }
    // getDataFile 全项目约定第一参为 qq、第二参为 uid（路径 sr_gacha/<uid>/<qq>/summary.json），
    // 与 summary 渲染 / authkey / 工坊同步读写同一份；此前传反成 (uid, qq)，
    // 小助手合并结果被写进孤立文件 sr_gacha/<qq>/<uid>/，摘要卡永远看不到（常驻停在 243 抽）。
    const file = getDataFile(auth?.qq || e.user_id, uid)
    let old = readData(file)
    if (!old?.pools) old = { uid, pools: {} }
    const result = mergeSrHelperFull(old.pools, full)
    if (!result.pools.length) return e.reply('小助手云端没有识别到可用的卡池数据')
    for (const pool of result.pools) old.pools[pool.key] = pool
    saveData(file, { ...old, update_time: formatNow(), source: `${old.source || ''}+lelaer-db`.replace(/^\+/, '') })
    const detail = result.pools
      .map(p => `【${p.name}】${p.totalPulls}抽/五星${p.fiveNum}/四星${p.fourNum ?? 0}`)
      .join('\n')
    const total = result.pools.reduce((s, p) => s + Number(p.totalPulls || 0), 0)
    const five = result.pools.reduce((s, p) => s + Number(p.fiveNum || 0), 0)
    await e.reply([
      `UID:${uid} 小助手云端全量同步完成`,
      detail,
      '',
      `合计 ${total} 抽 / ${five} 个五星`,
      `本次新增：五星 ${result.addedFive} 条、四星 ${result.addedFour} 条`,
      '提示：小助手数据不含 is_up，UP 标记需再发【#米哈游星铁更新星穹工坊记录】补齐。',
    ].join('\n'))
    await this.renderSummary(e, [], 'grid')
    return true
  }

  async updateHelper(e) {
    const qq = e.user_id
    const uid = e.user?.getUid?.('sr')
    if (!uid) return e.reply('请先用 genshin 侧绑定星铁账号，再更新抽卡记录')
    let bind = readHelperBind(qq)
    if (!bind?.union_id) {
      // 未绑定时先尝试从本机微信缓存自动识别，避免让用户手工去挖union_id
      const detected = detectHelperUnionId()
      if (detected) {
        saveHelperBind(qq, { union_id: detected, update_time: formatNow(), auto: true })
        bind = readHelperBind(qq)
        logger.mark(`[HoYoGet][sr_gacha] 已从本机微信缓存自动识别星穹工坊 union_id：${detected}`)
      }
    }
    // union_id 为可选：云端不校验内容，未绑定时用占位值兜底；
    // 已绑定或从本机微信缓存识别到时优先使用真实值。
    const unionId = bind?.union_id || HELPER_FALLBACK_UNION_ID
    if (!bind?.union_id) {
      logger.mark('[HoYoGet][sr_gacha] 未绑定 union_id，改用占位值请求云端（云端不校验该参数）')
    }
    await e.reply(`正在从云端同步抽卡记录，请稍候……${unionId === HELPER_FALLBACK_UNION_ID ? '（未绑定 union_id，使用占位值）' : ''}`)
    try {
      const analysis = await fetchHelperCloud(uid, unionId)
      const old = readData(getDataFile(qq, uid))
      const itemIndex = await loadSrItemIndex()
      const cloudPools = convertHelperPools(analysis, buildNameHint(old?.pools), itemIndex)
      const pools = fillMissingIcons(old?.pools ? mergeHelperPools(old.pools, cloudPools) : cloudPools, itemIndex)
      const result = { ...(old || {}), uid: String(uid), pools, update_time: formatNow(), source: 'helper' }
      saveData(getDataFile(qq, uid), result)
      const stats = Object.values(pools)
        .filter(p => p.fiveNum || p.totalPulls)
        .map(p => `【${p.name}】共${p.totalPulls || p.allNum || 0}抽｜五星${p.fiveNum || 0}`)
        .join('\n')
      await e.reply(`小助手云端记录同步完成！\n${stats}`)
      await this.renderSummary(e, [], 'grid')
      return e.reply('发送【#米哈游星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[HoYoGet][sr_gacha] updateHelper failed:', err)
      return e.reply(`小助手云端同步失败：${err?.message || err}`)
    }
  }

  async help(e) {
    /* 太多行，直接刷屏；改成合并转发，按「更新 / 查询 / 提示」分三节。
       连接器不支持合并转发时 makeForwardMsg 会内部退回纯文本，不会发不出去。 */
    const nodes = [
      [
        '【#米哈游星铁抽卡帮助】',
        '',
        '更新数据',
        '#米哈游星铁更新抽卡记录 —— 用 ck 刷新抽卡数据',
        '#米哈游星铁抽卡链接 <链接> —— 官方链接拉最近几天的逐抽记录',
        '#米哈游更新小助手抽卡记录 —— 小助手（lelaer）云端全量：直连其 gachabackup 库（含四星逐抽；需装 mysql2 且服务器 IP 在 RDS 白名单）',
        '#米哈游星铁导入小助手记录 <UID> —— 小助手全量离线导入：读本机 data/sr_gacha/sr_<UID>_full.json',
        '#米哈游更新工坊抽卡记录 / #米哈游星铁更新星穹工坊记录 —— 星穹工坊（lingyuan）云端，补历史五星与 is_up（与小助手非同一后端）',
        '#米哈游绑定小助手 <id> —— 一般用不到，union_id 可选、不绑定也能同步',
      ].join('\n'),
      [
        '查询',
        '#米哈游星铁抽卡记录 —— 抽卡总览统计',
        '#米哈游星铁角色记录 / #米哈游星铁武器记录 —— 角色、光锥卡池进度',
        '#米哈游星铁角色统计 / #米哈游星铁武器统计 —— 工坊风格统计卡',
        '#米哈游星铁联动角色记录 / #米哈游星铁联动武器记录 —— 联动卡池进度',
        '#米哈游星铁常驻记录 —— 常驻卡池统计',
      ].join('\n'),
      [
        '提示',
        '米哈游即可（不再用旧前缀），星铁可写作 崩铁。',
        '不带米哈游前缀的跃迁记录链接由 genshin 插件处理，互不冲突。',
        '小助手（lelaer）云端全量含四星逐抽见 #米哈游星铁导入小助手记录（需先导出 data/sr_gacha/sr_<UID>_full.json）；工坊（lingyuan）在线同步见 #米哈游更新小助手抽卡记录 / #米哈游星铁更新星穹工坊记录。',
      ].join('\n'),
    ]
    return e.reply(await makeForwardMsg(e, nodes, '星铁抽卡帮助'))
  }
}

// 模块开关：锅巴里关掉「sr_gacha」后，本文件所有指令静默不响应
guardModuleByFile(sr_gacha, 'sr_gacha', 'sr/sr_gacha.js')
