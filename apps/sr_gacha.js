import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { render, mhy, pluginPriority } from '#xhh'
import GachaLog from '../../genshin/model/gachaLog/gachaLog.js'
import { SrGachaSummary, readSummary, getSrGachaCookieFile, readSrGachaCookie, saveSrGachaCookie, extractSrGachaCookie, formatSrGachaFailure } from '../../genshin/model/gachaLog/srGachaSummary.js'
import { Character, Weapon } from '../../miao-plugin/models/index.js'
import MysInfo from '../../genshin/model/mys/mysInfo.js'
import { fileURLToPath } from 'node:url'

// ESM 作用域没有 __dirname，按仓库既有写法（apps/custom_guide.js）从 import.meta 取。
// 数据路径一律相对插件根，不依赖进程 cwd（Yunzai 启动时 cwd 即插件目录）。
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, '..')

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

export function sum(arr, field) {
  return arr.reduce((n, v) => n + Number(v?.[field] || 0), 0)
}

function buildGroupStats(pools, keys, title) {
  const list = pools.filter(pool => keys.includes(pool.key))
  const totalFive = sum(list, 'fiveNum')
  const totalPulls = sum(list, 'totalPulls')
  const totalUp = sum(list, 'upNum')
  const avgPity = totalFive ? (totalPulls / totalFive).toFixed(1) : '0.0'
  const upAvg = totalUp ? (totalPulls / totalUp).toFixed(1) : '0.0'
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
const DEFAULT_POOL_CONF = {
  key: 'GachaType_Permanent',
  type: '5',
  labelClass: 'common',
  name: '常驻频段',
}

export function buildSummaryView(data, uid, e, layout = 'grid', game = 'sr') {
  const conf = GAME_VIEW_CONF[game] || GAME_VIEW_CONF.sr
  const pools = Object.entries(data?.pools || {}).map(([key, pool]) => {
    const recent = Array.isArray(pool.records) ? pool.records : (Array.isArray(pool.recent) ? pool.recent : [])
    const fiveNum = Number(pool?.fiveNum) || recent.length
    const upNum = recent.filter(v => v.is_up).length
    const pity = Number(typeof pool.pity === 'object' ? pool.pity?.gacha_count : pool.pity || 0) || 0
    const totalPulls = Number(pool?.totalPulls) || (sum(recent, 'gacha_count') + pity) || 0
    const pullValues = recent.map(v => Number(v.gacha_count || 0)).filter(v => v > 0)
    const upValues = recent.filter(v => v.is_up).map(v => Number(v.gacha_count || 0)).filter(v => v > 0)
    const fiveAvg = fiveNum ? (sum(recent, 'gacha_count') / fiveNum).toFixed(1) : '--'
    const upAvg = upValues.length ? (sum(recent.filter(v => v.is_up), 'gacha_count') / upValues.length).toFixed(1) : '--'
    let upYs = upValues.length ? String(Math.round(Number(upAvg) * 160)) : '--'
    if (upValues.length && Number(upYs) >= 10000) upYs = `${(Number(upYs) / 10000).toFixed(2)}w`
    const maxPity = pullValues.length ? Math.max(...pullValues) : 0
    const minPity = pullValues.length ? Math.min(...pullValues) : 0
    const upRate = fiveNum ? pct(upNum, fiveNum) : '--'
    const MIAO_RES = '../../../../../plugins/miao-plugin/resources'
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
        if (item.item_type === '角色') {
          const char = Character.get(item.name, miaoGame)
          const face = char?.imgs?.face || char?.face || ''
          if (face) return `${MIAO_RES}${face}`
        }
        if (item.item_type === '光锥') {
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
          if (fs.existsSync(path.join(process.cwd(), 'plugins/miao-plugin/resources', local))) {
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
        icon: makeIcon(item),
        num: pulls,
        isUp: item.is_up === true,
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
        { num: upRate, unit: '%', lable: '小保底不歪率' },
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
      type: conf.typeMap[key] || pool.type || conf.typeMap[DEFAULT_POOL_CONF.key],
      labelClass: conf.labelClassMap[key] || DEFAULT_POOL_CONF.labelClass,
      name: pool.name || '未知',
      allNum: totalPulls,
      fiveNum,
      upNum,
      pity,
      maxPity,
      minPity,
      upRate: `${upRate}%`,
      fiveLog,
      yearGroups,
      line,
      fiveAvg,
      firstTime: fiveLog.length ? fiveLog[fiveLog.length - 1].fullDate : '--',
      lastTime: fiveLog.length ? fiveLog[0].fullDate : '--',
    }
  }).sort((a, b) => {
    const ia = conf.poolOrder.indexOf(a.key)
    const ib = conf.poolOrder.indexOf(b.key)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  // progress 进度条布局：每个卡池生成一个进度区块
  if (layout === 'progress') {
    const nickname = data?.nickname || e?.nickname || e?.user?.nickname || '开拓者'
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
        list,
      })
    }
    return {
      uid,
      nickname,
      avatar: e?.user?.avatar || '',
      sections,
    }
  }
  if (!pools.some(pool => pool.key === DEFAULT_POOL_CONF.key)) {
    pools.push({
      key: DEFAULT_POOL_CONF.key,
      type: conf.typeMap[DEFAULT_POOL_CONF.key] || DEFAULT_POOL_CONF.type,
      labelClass: DEFAULT_POOL_CONF.labelClass,
      name: DEFAULT_POOL_CONF.name,
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

  const cookieFile = getSrGachaCookieFile(qq)
  const candidates = [
    readSrGachaCookie(cookieFile),
    e.cookie,
  ]
  try {
    const mysInfo = new MysInfo(e)
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

function buildCommonPoolView(data) {
  const recent = Array.isArray(data?.fiveLog) ? data.fiveLog : []
  return {
    key: 'common',
    type: '1',
    name: '常驻跃迁',
    recent: recent.map(item => ({
      id: String(item.id || `${item.time}-${item.name}`),
      name: item.name || '未知',
      item_type: item.item_type || '角色',
      is_up: !!item.isUp,
      gacha_count: Number(item.num || 0),
      time: item.time || '',
      icon: item.icon || '',
    })),
    pity: Number(data?.noFiveNum || 0),
    totalPulls: Number(data?.allNum || 0),
    fiveNum: Number(data?.fiveNum || 0),
    upNum: 0,
    upRate: '0.0',
    avgPity: Number(data?.fiveAvg || 0).toFixed?.(1) || String(data?.fiveAvg || 0),
    maxPity: Math.max(...recent.map(v => Number(v.num || 0)).filter(Boolean), 0),
    minPity: Math.min(...recent.map(v => Number(v.num || 0)).filter(Boolean), 0) || 0,
    upAvg: '0.0',
    upYs: '0',
  }
}

async function fetchCommonPool(e, uid) {
  const fakeEvent = {
    ...e,
    isSr: true,
    msg: '#星铁常驻',
    raw_message: '#星铁常驻',
    original_msg: '#星铁常驻',
    isAll: false,
    reply: async () => {},
  }
  const data = await new GachaLog(fakeEvent).getGcLogData()
  if (!data?.fiveLog) return null
  return buildCommonPoolView(data)
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

/* ===== 星铁小助手（lelaer）云端全量导入 =====
   小助手把导入过的记录存进自家 gachabackup 表，可通过导出的 JSON 拿到
   四个池的逐抽全量（含四星），比官方 authkey 的半年窗口长得多。
   与星穹工坊的分工（实测 uid 104359511）：
     · 小助手：2925 条逐抽全量，但**没有 is_up 字段**
     · 星穹工坊：仅五星与统计，但**带 is_up**
   两者 id 同源（工坊的 25 条五星有 24 条能按 id 在小助手里找到），可安全按 id 并集。 */

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
    logger.warn(`[xhh][sr_gacha] 小助手全量文件解析失败：${err?.message || err}`)
    return null
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

/** 「【ID:123】」这类占位名，来自云端没解析出名称的条目 */
function isPlaceholderName(name) {
  return /^【ID:.*】$/.test(String(name || ''))
}

/**
 * 把小助手全量并入现有 pools。
 * 逐抽明细以小助手为准（它是超集），旧记录里已有的 is_up 标记继承下来——
 * 小助手导出没有该字段，若直接覆盖会把星穹工坊辛苦算出的 UP 标记弄丢。
 */
export function mergeSrHelperFull(pools, full) {
  const grouped = new Map()
  for (const list of Object.keys(SR_HELPER_POOL_KEYS)) {
    for (const row of Array.isArray(full?.[list]) ? full[list] : []) {
      const gachaType = String(row?.gacha_type || '')
      if (!SR_GACHA_TYPE_MAP[gachaType]) continue
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
    // 五星按 id 并集；旧记录有真实名称时不被新条目的「【ID:x】」占位名覆盖
    const byId = new Map((old.records || []).map(r => [ String(r.id), { ...r } ]))
    for (const row of incoming.records) {
      const exist = byId.get(row.id)
      if (!exist) {
        byId.set(row.id, row)
        result.addedFive++
      } else {
        if (isPlaceholderName(exist.name) && !isPlaceholderName(row.name)) exist.name = row.name
        if (exist.gacha_count == null && row.gacha_count) exist.gacha_count = row.gacha_count
      }
    }
    const records = [ ...byId.values() ].sort((a, b) => String(b.id).localeCompare(String(a.id)))
    // 四星明细：小助手独有，直接并入
    const fourIds = new Set((old.fourLog || []).map(r => String(r.id)))
    const addFour = incoming.fourLog.filter(r => !fourIds.has(r.id))
    result.addedFour += addFour.length
    result.pools.push(recountPool({
      ...old,
      records,
      fourLog: [ ...(old.fourLog || []), ...addFour ].sort((a, b) => String(b.time).localeCompare(String(a.time))),
      totalPulls: incoming.totalPulls || old.totalPulls,
      fourNum: (old.fourLog || []).length + addFour.length,
      fourPity: incoming.fourPity,
    }, records))
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
//   ck（#xhh星铁更新抽卡记录 / five_star_list）：五星历史全（小程序保留一年），但不含四星/逐抽/常驻
//   authkey（#xhh星铁抽卡链接 / getGachaLog）：全量逐抽含四星，但网页只保留近半年，超过半年的
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
// 云端（api.lingyuan.design）并非总能覆盖全部期次——实测 104359511 的限定角色池
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
// 绑定入口见 #xhh绑定小助手，保留以防云端将来启用校验。
// 接口带 union_id 参数，但云端只校验该参数非空、不校验内容（实测传任意非空值
// 都返回该 UID 的完整记录），因此未绑定时用占位值兜底即可。
// 保留 #xhh绑定小助手 入口是为了云端将来启用校验时无需改逻辑。
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
    logger.mark(`[xhh][sr_gacha] 自动识别星穹工坊 union_id 失败：${err?.message || err}`)
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
    logger.mark(`[xhh][sr_gacha] 读取物品配置缓存失败：${err?.message || err}`)
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
        logger.mark(`[xhh][sr_gacha] 写入物品配置缓存失败：${err?.message || err}`)
      }
    }
  } catch (err) {
    logger.mark(`[xhh][sr_gacha] 物品配置获取失败，云端记录可能显示为ID 且无图标：${err?.message || err}`)
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
    newPools[key] = recountPool(newPools[key], unionRecords(getPoolRecords(old), getPoolRecords(newPools[key])))
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
      name: '[小花火]星铁抽卡记录',
      dsc: '星铁抽卡记录查询与更新',
      event: 'message',
      priority: pluginPriority('sr_gacha', 1),
      rule: [
        // 强制前缀模式：星铁抽卡链接必须带 #xhh星铁抽卡链接 前缀才处理。
        // 不再兜底自动识别链接，原神/星铁等链接默认交给 genshin 插件，避免抢链接冲突
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?抽卡帮助$', fnc: 'help' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?抽卡链接', fnc: 'gachaLink' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(刷新|更新)抽卡记录$', fnc: 'refresh' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(抽卡记录|抽卡统计)$', fnc: 'summary' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?角色记录$', fnc: 'roleRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?武器记录$', fnc: 'weaponRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?联动角色记录$', fnc: 'collabRoleRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?联动武器记录$', fnc: 'collabWeaponRecord' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?绑定小助手(\\s+\\S+)?$', fnc: 'bindHelper' },
        { reg: // 前缀必须带：本插件所有指令均需 #xhh/ #小花火，否则会抢走
        // genshin 侧「#更新小助手抽卡记录」（原神·小助手）与「*更新小助手抽卡记录」（星铁·星穹工坊）
        '^#*(xhh|小花火)(星铁|崩铁)?(更新|刷新|同步)?小助手(抽卡|跃迁)?(记录|数据)$', fnc: 'updateHelper' },
        // 语义更正后的别名：updateHelper 接的其实是星穹工坊（api.lingyuan.design），
        // 旧名「更新小助手抽卡记录」保留兼容，新名避免与真正的小助手混淆
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(更新|刷新|同步)?星穹工坊(记录|数据)$', fnc: 'updateHelper' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?(导入|合并)小助手(记录|数据)?(\\s+\\S+)?$', fnc: 'importHelperFull' },
        { reg: '^#*(xhh|小花火)(星铁|崩铁)?常驻(记录|统计)?$', fnc: 'common' },
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
          const summary = new SrGachaSummary({ uid: auth.uid, cookie, file: `./data/srGachaSummary/${auth.uid}.json` })
          result = await summary.update()
          saveSrGachaCookie(auth.cookieFile, cookie)
          break
        } catch (err) {
          lastError = err
          logger.mark(`[xhh][sr_gacha] Cookie 候选失败：${err?.message || err}`)
        }
      }
      if (!result) throw lastError || new Error('没有可用的崩铁 Cookie')
      try {
        const common = await fetchCommonPool(e, auth.uid)
        if (common?.recent?.length) {
          result.pools.common = common
        }
      } catch (error) {
        logger.mark(`[xhh][sr_gacha] 常驻同步失败：${error?.message || error}`)
      }
      result.update_time = formatNow()
      // 与已有数据合并（可能是 authkey 全量逐抽），避免 ck 更新覆盖丢四星/常驻；
      // ck 只负责补全更早的五星（小程序保留一年）与 UP 标记
      const old = readData(getDataFile(auth.qq, auth.uid))
      if (old?.pools) {
        result.pools = mergePoolsForCk(old.pools, result.pools)
        result.pools = inheritIsUp(old.pools, result.pools)
      }
      saveData(getDataFile(auth.qq, auth.uid), result)
      const text = POOLS.map(pool => {
        const updated = result.addedByPool?.[pool.type] || 0
        return `【${pool.name}】记录获取成功，更新${updated}条`
      }).join('\n')
      const commonText = result.pools?.common?.recent?.length ? `\n【常驻跃迁】记录获取成功，更新${result.pools.common.recent.length}条` : ''
      await e.reply(`${text}${commonText}\n抽卡记录更新完成`)
      // 更新完成后自动输出抽卡记录总览图
      await this.renderSummary(e, [], 'grid')
      return e.reply('发送【#xhh星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[xhh][sr_gacha] refresh failed:', err)
      if (String(err?.message || err).includes('请从游戏内打开参与活动')) {
        return e.reply('当前账号还没在游戏内打开过跃迁活动页。\n请先进《星穹铁道》里点开一次活动跃迁页面，再发送【#xhh星铁更新抽卡记录】重试。')
      }
      return e.reply(formatSrGachaFailure(err))
    }
  }

  async renderSummary(e, keys = [], layout = 'grid') {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const data = readData(getDataFile(auth.qq, auth.uid)) || readSummary(`./data/srGachaSummary/${auth.uid}.json`)
    if (!data?.pools) return e.reply('暂无星铁抽卡记录，请先发送【#xhh星铁更新抽卡记录】')
    const view = buildSummaryView(filterPools(data, keys), auth.uid, e, layout)
    if (layout === 'progress') {
      let avatar = ''
      try {
        // 头像优先读取 genshin 插件 [*uid][用户绑定(showUid)] 缓存的头像，与 *uid 卡片保持一致
        try {
          avatar = await redis.get(`Yz:genshin:uidFaceUrl:sr:${auth.uid}`)
        } catch (err) {
          logger.mark(`[xhh][sr_gacha] 读取绑定头像缓存失败：${err?.message || err}`)
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
              logger.mark(`[xhh][sr_gacha] 写入绑定头像缓存失败：${err?.message || err}`)
            }
          }
        }
        if (avatar) view.avatar = avatar
      } catch (error) {
        logger.mark(`[xhh][sr_gacha] 获取星铁角色信息失败：${error?.message || error}`)
        // 兜底：先试免 DS 的米游社名片接口；仍失败则头像用小花火、昵称保持 QQ 昵称
        try {
          const card = await fetchGameRecordCard(auth.uid, auth.cookies[0])
          if (card?.nickname) view.nickname = card.nickname
          if (!view.avatar && card?.avatar) view.avatar = card.avatar
        } catch (err) {
          logger.mark(`[xhh][sr_gacha] 名片接口兜底获取用户信息失败：${err?.message || err}`)
          logger.mark(`[xhh][sr_gacha] 头像改用小花火，昵称使用 QQ 昵称`)
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
    return this.renderSummary(e, ['GachaType_AvatarUp', 'GachaType_CollabAvatarUp', 'common'], 'progress')
  }

  async weaponRecord(e) {
    return this.renderSummary(e, ['GachaType_EquipmentUp', 'GachaType_CollabEquipmentUp'], 'progress')
  }

  async collabRoleRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabAvatarUp'], 'progress')
  }

  async collabWeaponRecord(e) {
    return this.renderSummary(e, ['GachaType_CollabEquipmentUp'], 'progress')
  }

  async common(e) {
    return this.summary(e)
  }

  /** 兜底监听（强制前缀模式下已停用，规则已移除）：原实现为监听所有消息识别星铁链接 */
  async autoGachaLink(e) {
    try {
      const url = findSrAuthkeyUrl(e)
      if (!url) return false
      logger.mark(`[xhh][sr_gacha] 兜底识别到星铁链接: ${url.slice(0, 150)}...`)
      return this.gachaLink(e, url)
    } catch (err) {
      logger.error(`[xhh][sr_gacha] autoGachaLink 异常: ${err}`)
      return false
    }
  }

  async gachaLink(e, preUrl = '') {
    // 强制前缀模式：消息必须带 #xhh星铁抽卡链接 前缀才处理。
    // 不带前缀的链接（原神/星铁/绝区零等）一律 return false 放行，交给 genshin 插件正常处理
    const isCmd = /^#*(xhh|小花火)(星铁|崩铁)?抽卡链接/.test(String(e.msg || ''))
    if (!isCmd) return false
    // 从原始消息段提取链接：兼容纯文本、QQ 分享卡片（share/data.url）、json/xml 卡片、断行等情况
    const fullMsg = [e.msg, ...(Array.isArray(e.message) ? e.message.map(s => (s?.type === 'text' ? s.text : (s?.data?.url || ''))) : [])].filter(Boolean).join('\n')
    const url = preUrl || findSrAuthkeyUrl(e) || (fullMsg.match(/https?:\/\/[^\s,，。、；;）)】\]》"']+/)?.[0] || '')
    logger.mark(`[xhh][sr_gacha] 收到链接消息: ${String(e.msg || '').slice(0, 200)}`)
    if (!url) {
      // 命令带链接：无链接时提示用法
      return e.reply(
        '请把崩铁官方【跃迁记录】页面的链接发给我，例如：\n' +
        '#xhh星铁抽卡链接 https://public-operation-hkrpg.mihoyo.com/common/gacha_record/api/getGachaLog?authkey=xxx&game_biz=hkrpg_cn\n\n' +
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
          const summary = new SrGachaSummary({ uid: auth.uid, cookie, file: `./data/srGachaSummary/${auth.uid}.json` })
          const sr = await summary.update()
          if (sr?.pools) {
            result.pools = mergeIsUp(sr.pools, result.pools)
            saveSrGachaCookie(auth.cookieFile, cookie)
            break
          }
        } catch (err) {
          logger.mark(`[xhh][sr_gacha] ck 校准 UP 标记失败：${err?.message || err}`)
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
      return e.reply('下一步必须发送#xhh星铁更新抽卡记录来保证五星数据的准确性；发送【#xhh星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[xhh][sr_gacha] gachaLink failed:', err)
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
          return e.reply(`已从本机微信缓存自动识别并绑定 union_id：${detected}\n发送【#xhh更新小助手抽卡记录】拉取云端记录`)
        }
      }
      const cur = readHelperBind(qq)
      return e.reply([
        '【星穹工坊云端绑定】',
        cur?.union_id ? `当前已绑定 union_id：${cur.union_id}` : '尚未绑定 union_id（不影响同步）',
        '',
        '用法：#xhh绑定小助手 <union_id>',
        'union_id 为星穹工坊小程序对应微信账号的身份标识，可选。',
        '云端目前只校验该参数非空、不校验内容，未绑定时同步会自动使用占位值；',
        '此处绑定仅用于云端将来启用校验时无需改动。',
        '',
        '发送【#xhh更新小助手抽卡记录】可从小助手云端拉取约三年历史五星记录，',
        '补齐官方 ck（约一年）拿不到的更早数据。',
      ].join('\n'))
    }
    saveHelperBind(qq, { union_id: unionId, update_time: formatNow() })
    return e.reply(`小助手 union_id 绑定成功：${unionId}\n发送【#xhh更新小助手抽卡记录】拉取云端记录`)
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
    if (!uid) return e.reply('请先绑定星铁账号，或使用【#xhh星铁导入小助手记录 <UID>】指定 UID')
    const full = readSrHelperFullFile(uid)
    if (!full) {
      return e.reply([
        `未找到 UID:${uid} 的小助手全量文件`,
        `期望路径：plugins/xhh/data/sr_gacha/sr_${uid}_full.json`,
        '请先在小助手同步云端记录并导出 JSON，再放到该路径。',
      ].join('\n'))
    }
    const file = getDataFile(uid, auth?.qq || e.user_id)
    const old = readData(file)
    if (!old?.pools) return e.reply('尚无本插件的星铁抽卡数据，请先发送【#xhh更新抽卡记录】或【#xhh更新小助手抽卡记录】')
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
      '提示：小助手数据不含 is_up，UP 标记需再发【#xhh星铁更新星穹工坊记录】补齐。',
    ].join('\n'))
    await this.renderSummary(e, [], 'grid')
    return true
  }

  async updateHelper(e) {
    const qq = e.user_id
    const uid = e.user?.getUid?.('sr')
    if (!uid) return e.reply('请先用 genshin 侧绑定星铁账号，再更新小助手抽卡记录')
    let bind = readHelperBind(qq)
    if (!bind?.union_id) {
      // 未绑定时先尝试从本机微信缓存自动识别，避免让用户手工去挖union_id
      const detected = detectHelperUnionId()
      if (detected) {
        saveHelperBind(qq, { union_id: detected, update_time: formatNow(), auto: true })
        bind = readHelperBind(qq)
        logger.mark(`[xhh][sr_gacha] 已从本机微信缓存自动识别星穹工坊 union_id：${detected}`)
      }
    }
    // union_id 为可选：云端不校验内容，未绑定时用占位值兜底；
    // 已绑定或从本机微信缓存识别到时优先使用真实值。
    const unionId = bind?.union_id || HELPER_FALLBACK_UNION_ID
    if (!bind?.union_id) {
      logger.mark('[xhh][sr_gacha] 未绑定 union_id，改用占位值请求星穹工坊云端（云端不校验该参数）')
    }
    await e.reply(`正在从星穹工坊云端获取抽卡记录，请稍候……${unionId === HELPER_FALLBACK_UNION_ID ? '（未绑定 union_id，使用占位值）' : ''}`)
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
      await e.reply(`星穹工坊云端记录同步完成！\n${stats}`)
      await this.renderSummary(e, [], 'grid')
      return e.reply('发送【#xhh星铁抽卡帮助】查看全部抽卡指令')
    } catch (err) {
      logger.error('[xhh][sr_gacha] updateHelper failed:', err)
      return e.reply(`星穹工坊云端同步失败：${err?.message || err}`)
    }
  }

  async help(e) {
    // 全角空格对齐在不同字体下会错位，改为「指令 —— 说明」单行式，同类指令用 / 合并
    return e.reply([
      '【#xhh星铁抽卡帮助】',
      '',
      '更新数据',
      '#xhh星铁更新抽卡记录 —— 用 ck 刷新抽卡数据',
      '#xhh星铁抽卡链接 <链接> —— 官方链接拉最近几天的逐抽记录',
      '#xhh星铁导入小助手记录 —— 导入小助手云端全量（含四星，建议先跑）',
      '#xhh星铁更新星穹工坊记录 —— 补历史五星与 is_up（UP）标记',
      '#xhh绑定小助手 <id> —— 一般用不到，union_id 可选、不绑定也能同步',
      '',
      '查询',
      '#xhh星铁抽卡记录 —— 抽卡总览统计',
      '#xhh星铁角色记录 / #xhh星铁武器记录 —— 角色、光锥卡池进度',
      '#xhh星铁联动角色记录 / #xhh星铁联动武器记录 —— 联动卡池进度',
      '#xhh星铁常驻记录 —— 常驻卡池统计',
      '',
      '提示：xhh 可写作 小花火，星铁可写作 崩铁。',
      '不带 xhh 前缀的跃迁记录链接由 genshin 插件处理，互不冲突。',
      '小助手全量数据不含 is_up，建议导入后再发一次星穹工坊记录补 UP 标记。',
      '#xhh更新小助手抽卡记录 是星穹工坊的旧名，仍可用。',
    ].join('\n'))
  }
}
