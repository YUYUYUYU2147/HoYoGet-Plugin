import {
  buildSummaryView,
  extractUrlsFromMsg,
  filterPools,
  formatNow,
  getPoolRecords,
  parseGachaUrl,
  readData,
  recountPool,
  requestJson,
  saveData,
  sleep,
  unionRecords
} from '../sr/sr_gacha.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mhy, render, pluginPriority, makeForwardMsg } from '#HoYoGet'
import { guardModuleByFile } from '../../system/modules.js'

// ESM 作用域没有 __dirname，按仓库既有写法（apps/custom_guide.js）从 import.meta 取
const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 插件根目录（apps 的上一级），数据路径不依赖进程 cwd */
const PLUGIN_ROOT = path.resolve(__dirname, '../..')

/**
 * 绝区零抽卡记录。
 *
 * 数据源两条：
 *   1. 官方跃迁记录链接（authkey）：全量逐抽含四星，但官方只保留近半年；
 *   2. 绝区零工坊云端（api.zzzmap.com）：保留长期历史，只有五星与统计，
 *      接口只校验 union_id 非空、不校验内容，未绑定时用占位值即可。
 *
 * 图标：官方物品配置接口（rpgsimulator/config?game=nap）会忽略 game 参数只返回星铁数据，
 * miao-plugin 无绝区零资源，图源站点（api.hakush.in / api.ambr.top）在本机 DNS 不可达，
 * 因此当前一律不拼图标，卡片走文字占位。后续拿到可用图源只需在 makeIcon 分支补一处。
 */

// 绝区零频段池编号（官方 getGachaLog 的 gacha_type）
const ZZZ_POOLS = [
  { type: '1', key: 'GachaType_CharacterUp', name: '独家频段', hint: '代理人', initLogType: '2001', baseType: '2' },
  { type: '2', key: 'GachaType_RerunCharacter', name: '独家重映', hint: '代理人', initLogType: '12001', baseType: '102' },
  { type: '3', key: 'GachaType_WeaponUp', name: '音擎频段', hint: '音擎', initLogType: '3001', baseType: '2' },
  { type: '4', key: 'GachaType_RerunWeapon', name: '音擎回响', hint: '音擎', initLogType: '13001', baseType: '103' },
  { type: '5', key: 'GachaType_Permanent', name: '常驻频段', hint: '代理人', initLogType: '1001', baseType: '2' },
  { type: '6', key: 'GachaType_Bangboo', name: '邦布频段', hint: '邦布', initLogType: '5001', baseType: '2' },
]

// 工坊云端池字段 -> 本插件卡池 key
const WORKSHOP_POOL_MAP = {
  role_up_card_result: { key: 'GachaType_CharacterUp', name: '独家频段' },
  role_up_rerun_card_result: { key: 'GachaType_RerunCharacter', name: '独家重映' },
  guang_up_card_result: { key: 'GachaType_WeaponUp', name: '音擎频段' },
  guang_up_rerun_card_result: { key: 'GachaType_RerunWeapon', name: '音擎回响' },
  common_card_result: { key: 'GachaType_Permanent', name: '常驻频段' },
  bangboo_card_result: { key: 'GachaType_Bangboo', name: '邦布频段' },
}

const GACHA_LOG_HOST_CN = 'https://public-operation-common.mihoyo.com'
const GACHA_LOG_HOST_OS = 'https://public-operation-common-sg.hoyoverse.com'
const GACHA_ID = '2c1f5692fdfbb733a08733f9eb69d32aed1d37'
const WORKSHOP_API = 'https://api.zzzmap.com/api/v2/game_user/get_sr_draw_v3'
// 云端只校验 union_id 非空、不校验内容，未绑定时用占位值兜底
const WORKSHOP_FALLBACK_UNION_ID = '1'

// 官方「调频记录」Cookie 接口：绝区零在 api-takumi-record 下另有逐条记录查询，
// 与 authkey 接口同源同数据，但只需已绑定的 Cookie 即可拉取，玩家不必再提供链接。
// 注意 gacha_type 用的是官方枚举名，与 authkey 接口的数字编号不是同一套。
const ZZZ_RECORD_API = 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/gacha_record'
const ZZZ_REGION_CN = 'prod_gf_cn'
const ZZZ_CK_POOL_TYPE = {
  GachaType_CharacterUp: 'GACHA_TYPE_CHARACTER_UP',
  GachaType_RerunCharacter: 'GACHA_TYPE_CHARACTER_RETURN',
  GachaType_WeaponUp: 'GACHA_TYPE_WEAPON_UP',
  GachaType_RerunWeapon: 'GACHA_TYPE_WEAPON_RETURN',
  GachaType_Permanent: 'GACHA_TYPE_PERMANENT',
  GachaType_Bangboo: 'GACHA_TYPE_BANGBOO',
}
// 官方返回英文枚举，需转成本插件内部口径：
// 星级按 rank_type 判定（5=五星、4=四星，与 authkey 接口一致），物品类型沿用 zzzItemType 认的中文
const ZZZ_CK_ITEM_TYPE = { ITEM_TYPE_AVATAR: '代理人', ITEM_TYPE_WEAPON: '音擎', ITEM_TYPE_BANGBOO: '邦布' }
const ZZZ_CK_RANK_TYPE = { S: '5', A: '4', B: '3' }

function getDataFile(uid, qq) {
  return `${PLUGIN_ROOT}/data/zzz_gacha/${qq}/${uid}/summary.json`
}

function getWorkshopBindFile(qq) {
  return `${PLUGIN_ROOT}/data/zzz_gacha/${qq}/workshop.json`
}

async function getUserAuth(e) {
  const qq = e.user_id
  const uid = e.user?.getUid?.('zzz')
  if (!uid) return { error: '请先用 genshin 侧绑定绝区零账号，再更新抽卡记录' }
  const cookies = [...new Set([e.cookie, e.user?.getMysUser?.('zzz')?.ck].map(v => String(v || '').trim()).filter(Boolean))]
  try {
    // 动态 import：genshin 版本较旧时可能没有 model/mys/mysInfo.js，
    // 静态 import 会让整个插件 ERR_MODULE_NOT_FOUND 而加载失败（见 sr_gacha.js 顶部说明）
    const { getGenshinMysInfo } = await import('../sr/sr_gacha.js')
    const MysInfoCls = await getGenshinMysInfo()
    if (MysInfoCls) {
      const mysInfo = new MysInfoCls(e)
      mysInfo.uid = uid
      cookies.push(await mysInfo.getCookie('zzz'))
    }
  } catch {}
  const list = [...new Set(cookies.filter(Boolean))]
  if (!list.length) return { error: '请先用 genshin 侧绑定绝区零账号，再更新抽卡记录' }
  return { qq, uid, cookies: list }
}

/** 绝区零跃迁记录分页；官方接口与星铁参数不同：需init_log_gacha_* 与 real_gacha_type */
async function fetchZzzPage(query, pool, size, endId, page = 1) {
  const region = query.region || 'prod_gf_cn'
  const host = /^prod_(gf|qd)_cn$/.test(region) ? GACHA_LOG_HOST_CN : GACHA_LOG_HOST_OS
  const gameBiz = /^nap_(cn|global)/.test(String(query.game_biz || '')) ? query.game_biz : 'nap_cn'
  const params = new URLSearchParams({
    authkey_ver: query.authkey_ver || '1',
    sign_type: '2',
    auth_appid: 'webview_gacha',
    init_log_gacha_type: pool.initLogType,
    init_log_gacha_base_type: pool.baseType,
    gacha_id: GACHA_ID,
    timestamp: String(Math.floor(Date.now() / 1000)),
    lang: query.lang || 'zh-cn',
    device_type: 'mobile',
    plat_type: 'ios',
    region,
    authkey: query.authkey,
    game_biz: gameBiz,
    gacha_type: pool.type,
    real_gacha_type: pool.baseType,
    page: String(page),
    size: String(size),
    end_id: String(endId || '0'),
  })
  const { res, data } = await requestJson(`${host}/common/gacha_record/api/getGachaLog?${params}`)
  if (!res.ok) throw new Error(`接口 HTTP ${res.status}`)
  if (data?.retcode !== 0) {
    const msg = String(data?.message || '')
    if ([-100, -101, -111].includes(Number(data.retcode)) || /timeout|expire|login/.test(msg)) {
      throw new Error('authkey 已过期或无效，请从游戏内重新打开【调频记录】并复制最新链接')
    }
    throw new Error(msg || '获取抽卡记录失败')
  }
  return data?.data || { list: [] }
}

async function fetchAllByAuthkeyZzz(query) {
  const region = query.region || 'prod_gf_cn'
  const pools = {}
  for (const pool of ZZZ_POOLS) {
    const rows = []
    const seenIds = new Set()
    let endId = '0'
    let page = 1
    // 绝区零该接口会把 size 强制压到 5（实测请求 20、返回 size=5），
    // 因此翻页结束不能按 list.length < size 判断，否则第一页就停、只能拿到最近 5 条
    const shortPage = list => list.length > 0 && list.length < (Number(data0Size) || list.length)
    let data0Size = 0
    while (true) {
      const data = await fetchZzzPage({ ...query, region }, pool, 20, endId, page)
      const list = data?.list || []
      if (!data0Size) data0Size = Number(data?.size) || list.length
      if (!list.length) break
      const before = rows.length
      for (const row of list) {
        const id = String(row?.id || '')
        if (id && seenIds.has(id)) continue
        if (id) seenIds.add(id)
        rows.push(row)
      }
      // 本页全是重复记录：说明end_id 已无法前进，避免死循环
      if (rows.length === before) break
      endId = rows[rows.length - 1]?.id || ''
      if (!endId || shortPage(list)) break
      page++
      // 官方半年内的记录约 3000 抽，按每页 5 条估算上限给足
      if (page > 1000) break
      await sleep(400)
    }
    await sleep(1000)
    pools[pool.key] = buildZzzPool(pool.type, pool, rows)
  }
  return { pools, region }
}

/** 绝区零的物品类型判定：邦布与音擎都不是角色，不能沿用星铁的「4位=角色」 */
function zzzItemType(row) {
  const type = String(row?.item_type || '')
  if (type === '代理人' || type === '角色') return '角色'
  if (type === '邦布') return '邦布'
  // 官方/工坊口径里音擎也叫「武器」，个别数据源用英文名
  if (type === '音擎' || type === '武器' || /weapon|wengine/i.test(type)) return '音擎'
  // 兜底：按 item_id 位数与前缀。绝区零：代理人 4 位，音擎 1xxxx，邦布 5xxxx。
  // 此前「5 位一律邦布」会把音擎误判成邦布，导致武器统计的常驻音擎被过滤掉
  const id = String(row?.item_id || '')
  if (id.length === 5) return id.startsWith('5') ? '邦布' : '音擎'
  return '角色'
}

/** 与 buildPoolFromRows 同构，但物品类型判定按绝区零规则 */
function buildZzzPool(type, pool, rows) {
  const base = {
    ...(pool || {}),
    type,
    key: pool?.key,
    name: pool?.name || type,
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
    const itemType = zzzItemType(row)
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

/**
 * 官方 Cookie 接口：绝区零的调频记录可直接用已绑定的 Cookie 查询，
 * 不必玩家从游戏内复制链接（authkey 有时效，过期就得重新抓）。
 */
function zzzServerOf(uid) {
  const s = String(uid || '')
  if (s.length < 10) return ZZZ_REGION_CN
  switch (s.slice(0, -8)) {
    case '10': return 'prod_gf_us'
    case '15': return 'prod_gf_eu'
    case '13': return 'prod_gf_jp'
    case '17': return 'prod_gf_sg'
    default: return ZZZ_REGION_CN
  }
}

/** 官方该接口把时间拆成字段返回，需拼回与 authkey 接口一致的 "YYYY-MM-DD HH:mm:ss" */
function zzzCkRowTime(date = {}) {
  if (!date || date.year === undefined) return ''
  const p = n => String(n ?? '').padStart(2, '0')
  return `${date.year}-${p(date.month)}-${p(date.day)} ${p(date.hour)}:${p(date.minute)}:${p(date.second)}`
}

/** 单个频段翻一页：end_id 取本页最后一条的 id，返回空即到底 */
async function fetchZzzRecordPage(e, ck, uid, pool, region, endId) {
  const query = new URLSearchParams({
    lang: 'zh-cn',
    uid: String(uid),
    region,
    gacha_type: pool.ckType,
    end_id: String(endId || '0'),
  }).toString()
  const headers = mhy.getHeaders(e, ck)
  // 该接口按「4x 盐 + query」校验 DS，与米游社其它记录接口同款；getHeaders 给的是默认 DS，需覆盖
  headers.DS = mhy.getDs2(query, '', 4)
  const { res, data } = await requestJson(`${ZZZ_RECORD_API}?${query}`, { method: 'GET', headers }, 2)
  if (!res.ok) throw new Error(`接口 HTTP ${res.status}`)
  if (Number(data?.retcode) !== 0) {
    const msg = String(data?.message || '')
    if ([1034, 10035, 10041].includes(Number(data.retcode))) throw new Error('触发米游社验证码，请稍后再试')
    if ([-100, -101, -111].includes(Number(data.retcode)) || /login|expire/i.test(msg)) {
      throw new Error('Cookie 已失效，请重新扫码绑定后再试')
    }
    throw new Error(msg || '官方调频记录接口返回异常')
  }
  const list = data?.data?.gacha_item_list || []
  return list.map(item => ({
    id: String(item?.id || ''),
    item_id: String(item?.item_id || ''),
    name: item?.item_name || '未知',
    item_type: ZZZ_CK_ITEM_TYPE[item?.item_type] || '',
    rank_type: ZZZ_CK_RANK_TYPE[item?.rarity] || '3',
    time: zzzCkRowTime(item?.date),
    icon: '',
  }))
}

/** 用已绑定的 Cookie 逐个频段拉官方记录；全部 Cookie 都失败才抛错 */
async function fetchAllByCookieZzz(e, cookies, uid) {
  const region = zzzServerOf(uid)
  if (region !== ZZZ_REGION_CN) throw new Error('官方 Cookie 接口当前只支持国服，请用抽卡链接或工坊记录')
  let lastErr = null
  for (const ck of cookies) {
    const pools = {}
    let total = 0
    try {
      for (const pool of ZZZ_POOLS) {
        const ckType = ZZZ_CK_POOL_TYPE[pool.key]
        if (!ckType) continue
        const rows = []
        const seenIds = new Set()
        let endId = '0'
        // 官方单页返回条数较小，翻页上限给足（半年约三千抽）
        for (let page = 0; page < 800; page++) {
          const list = await fetchZzzRecordPage(e, ck, uid, { ...pool, ckType }, region, endId)
          if (!list.length) break
          const before = rows.length
          for (const row of list) {
            const id = String(row?.id || '')
            if (id && seenIds.has(id)) continue
            if (id) seenIds.add(id)
            rows.push(row)
          }
          // 整页都是已见过的记录：end_id 无法再前进，避免死循环
          if (rows.length === before) break
          endId = rows[rows.length - 1]?.id || ''
          if (!endId) break
          await sleep(400)
        }
        pools[pool.key] = buildZzzPool(pool.type, pool, rows)
        total += rows.length
        await sleep(800)
      }
    } catch (err) {
      lastErr = err
      continue
    }
    // 单个 Cookie 一个池都没取到：换下一个 Cookie 再试，别直接判定失败
    if (!total) { lastErr = new Error('官方接口未返回任何调频记录'); continue }
    return { pools, region, total }
  }
  throw lastErr || new Error('没有可用的 Cookie')
}

/**
 * 绝区零图标索引（名称 -> Bwiki 图片 URL）。
 *
 * 来源：bilibili wiki 的「角色图鉴 / 音擎图鉴 / 邦布图鉴」三页，各页按 `role-box`
 * 分块、块内 `alt="角色头像-xxx.png"` 一类 img 即条目图标，一次性抓取成本196 条后落盘。
 * 抽卡接口响应与官方物品配置都拿不到图标（`rpgsimulator/config?game=nap` 的 game 参数
 * 被忽略、恒返回星铁数据），图源站点 api.hakush.in / api.ambr.top 在本机DNS 不可达，
 * 故走 Bwiki 这条可达的路径。
 *
 * 注意：Bwiki 限流很凶（567EdgeOne），故只在重建索引时请求，运行期只读本地文件。
 */
const ZZZ_ICON_DIR = `${PLUGIN_ROOT}/data/zzz_gacha`
const ZZZ_ICON_INDEX_FILE = `${ZZZ_ICON_DIR}/icon_index.json`
// 绝区零图标来源：bilibili wiki 图鉴页（官方接口无物品配置，图源站点在本机不可达）
const BWIKI_ZZZ_API = 'https://wiki.biligame.com/zzz/api.php'
/** 解码 wiki 常见的 HTML 实体（title 属性里的 &amp; &quot; 等） */
function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

let zzzIconIndex = null

function loadZzzIconIndex() {
  if (zzzIconIndex) return zzzIconIndex
  zzzIconIndex = new Map()
  try {
    if (fs.existsSync(ZZZ_ICON_INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ZZZ_ICON_INDEX_FILE, 'utf8'))
      for (const [ name, item ] of Object.entries(raw || {})) {
        const icon = item?.icon || item
        // wiki 的 title 属性会带 HTML 实体（如 奥菲丝&amp;「鬼火」），
        // 抽卡记录里是解码后的原文，须双向归一化才能匹配上
        const key = decodeHtmlEntities(name)
        if (key && typeof icon === 'string' && icon.startsWith('http')) zzzIconIndex.set(key, icon)
      }
    }
  } catch (err) {
    logger.warn(`[HoYoGet][zzz_gacha] 绝区零图标索引读取失败，卡片将无图标：${err?.message || err}`)
  }
  return zzzIconIndex
}

/** 给缺少图标的条目按名称补图标（不覆盖已有图标） */
function fillZzzIcons(pools) {
  const index = loadZzzIconIndex()
  if (!index.size) return pools
  let filled = 0
  for (const pool of Object.values(pools || {})) {
    for (const key of ['records', 'fourLog', 'recent']) {
      if (!Array.isArray(pool?.[key])) continue
      for (const row of pool[key]) {
        if (!row || row.icon) continue
        const icon = index.get(String(row.name || '').trim())
        if (icon) {
          row.icon = icon
          filled++
        }
      }
    }
  }
  if (filled) logger.mark(`[HoYoGet][zzz_gacha] 按名称补齐绝区零图标 ${filled} 处`)
  return pools
}

/**
 * 读取 ZZZ-Plugin 落盘的逐抽数据（`data/ZZZ-Plugin/gacha/{uid}.json`）。
 *
 * 这是目前唯一的四星逐抽来源：官方调频记录接口保留窗口只有几天，工坊云端只给四星数量，
 * 而 ZZZ-Plugin 靠自己反复刷新把历史逐抽攒了下来。
 * 该文件按中文池名分组，rank_type 为数字制：4=S(5星) 3=A(4星) 2=B(3星)。
 */
// 相对 cwd 不可靠：Yunzai 的 cwd 是 plugins/HoYoGet-Plugin，而数据在仓库根的 data/ 下，
// 故按 cwd 上溯到插件根目录再定位（插件自身运行时亦在仓库根启动，双路径都覆盖）
// ZZZ-Plugin 的数据在仓库根 data/ 下（插件自身在 plugins/xxx），故按插件根的上一级定位，
// 不依赖进程 cwd（Yunzai 启动时 cwd 是插件目录，会找不到）
// 优先读本插件迁移后的副本，ZZZ-Plugin 原目录仅作兜底
const ZZZ_PLUGIN_POOL_DIRS = [
  path.join(PLUGIN_ROOT, 'data', 'zzz_gacha', 'zzz_plugin'),
  path.join(process.cwd(), 'data', 'ZZZ-Plugin', 'gacha'),
  path.resolve(PLUGIN_ROOT, '../../data/ZZZ-Plugin/gacha'),
]
function zzzPluginPoolFile(uid) {
  for (const dir of ZZZ_PLUGIN_POOL_DIRS) {
    const file = path.join(dir, `${uid}.json`)
    if (fs.existsSync(file)) return file
  }
  return path.join(ZZZ_PLUGIN_POOL_DIRS[0], `${uid}.json`)
}
const ZZZ_PLUGIN_POOL_MAP = {
  独家频段: 'GachaType_CharacterUp',
  独家重映: 'GachaType_RerunCharacter',
  音擎频段: 'GachaType_WeaponUp',
  音擎回响: 'GachaType_RerunWeapon',
  常驻频段: 'GachaType_Permanent',
  邦布频段: 'GachaType_Bangboo',
}
// ZZZ-Plugin 数字制 rank_type -> 本插件制式（'5' 五星 / '4' 四星 / '3' 三星）
const ZZZ_PLUGIN_RANK_MAP = { 4: '5', 3: '4', 2: '3' }

function readZzzPluginRows(uid) {
  const file = zzzPluginPoolFile(uid)
  if (!fs.existsSync(file)) return null
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return data && typeof data === 'object' ? data : null
  } catch (err) {
    logger.warn(`[HoYoGet][zzz_gacha] 读取 ZZZ-Plugin 数据失败：${err?.message || err}`)
    return null
  }
}

/**
 * 把 ZZZ-Plugin 的逐抽记录并入工坊数据。
 *
 * 四星明细：直接按 id 去重后并入 fourLog（工坊没有四星明细，只补不缺）。
 * 五星：工坊的历史更长，仅在工坊缺失时补入；实测两者五星 id 完全重合，一般不会新增。
 * 抽数统计：沿用工坊的总抽数，不被逐抽条数覆盖（工坊覆盖三年，逐抽只有半年）。
 */
function mergeZzzPluginPools(pools, pluginData) {
  const result = { fourAdded: 0, fiveAdded: 0, seen: 0 }
  for (const [ poolName, key ] of Object.entries(ZZZ_PLUGIN_POOL_MAP)) {
    const rows = Array.isArray(pluginData?.[poolName]) ? pluginData[poolName] : []
    const pool = pools?.[key]
    if (!rows.length || !pool) continue
    // 按 id 升序遍历才能算出每个条目之前累计的抽数
    const sorted = [ ...rows ].sort((a, b) => {
      const ai = BigInt(String(a?.id || '0'))
      const bi = BigInt(String(b?.id || '0'))
      return ai < bi ? -1 : ai > bi ? 1 : 0
    })
    let pulls = 0
    let fourPulls = 0
    const fourRecs = []
    const fiveRecs = []
    for (const row of sorted) {
      pulls++
      fourPulls++
      result.seen++
      const rank = ZZZ_PLUGIN_RANK_MAP[String(row?.rank_type)]
      const base = {
        id: String(row?.id || ''),
        name: row?.name || '未知',
        item_type: zzzItemType(row),
        is_up: false,
        gacha_count: 0,
        time: row?.time || '',
        icon: '',
      }
      if (rank === '5') {
        fiveRecs.push({ ...base, gacha_count: pulls })
        pulls = 0
      } else if (rank === '4') {
        fourRecs.push({ ...base, gacha_count: fourPulls })
        fourPulls = 0
      }
      // 三星不入库：卡片统计只认四星与五星
    }
    const existIds = new Set((pool.fourLog || []).map(r => String(r.id)))
    const addFour = fourRecs.filter(r => r.id && !existIds.has(r.id))
    if (addFour.length) {
      pool.fourLog = [ ...(pool.fourLog || []), ...addFour ]
        .sort((a, b) => String(b.time).localeCompare(String(a.time)))
      pool.fourNum = pool.fourLog.length
      result.fourAdded += addFour.length
    }
    if (fourPulls > 0) pool.fourPity = fourPulls
    // 五星仅补缺（工坊历史更长，正常情况下不会命中）
    const fiveIds = new Set((pool.records || []).map(r => String(r.id)))
    const addFive = fiveRecs.filter(r => r.id && !fiveIds.has(r.id))
    if (addFive.length) {
      const byId = new Map((pool.records || []).map(r => [ String(r.id), r ]))
      for (const r of addFive) byId.set(String(r.id), r)
      pool.records = [ ...byId.values() ].sort((a, b) => String(b.id).localeCompare(String(a.id)))
      pool.fiveNum = pool.records.length
      result.fiveAdded += addFive.length
    }
  }
  return result
}

/** 工坊云端分析 -> 渲染所需 pools；云端只有五星与统计，四星仅继承本地 */
function convertWorkshopPools(analysis, nameHint) {
  const pools = {}
  for (const [field, def] of Object.entries(WORKSHOP_POOL_MAP)) {
    const p = analysis?.[field]
    if (!p) continue
    const records = (Array.isArray(p.five_cards) ? p.five_cards : []).map(c => {
      const time = c?.time || ''
      return {
        id: String(c?.id || ''),
        name: c?.name || nameHint.get(String(time).slice(0, 19)) || `【ID:${c?.item_id ?? '?'}】`,
        item_type: zzzItemType(c),
        is_up: c?.is_up === true,
        gacha_count: Number(c?.draw_total || 0),
        time,
        icon: '',
      }
    })
    const fiveNum = records.length
    const totalPulls = Number(p.draw_total || 0)
    // 云端可能存在没有五星记录的池（如音擎回响抽了但没出金），仍需建池以保留总抽数
    if (!fiveNum && !totalPulls) continue
    pools[def.key] = {
      key: def.key,
      type: ZZZ_POOLS.find(x => x.key === def.key)?.type || '1',
      name: def.name,
      records,
      fourLog: [],
      fourNum: (Number(p.four_role_total || 0) || 0) + (Number(p.four_guang_total || 0) || 0),
      fourPity: 0,
      pity: Number(p?.dian_card_infos?.draw_total || 0) || 0,
      totalPulls,
      fiveNum,
      upNum: records.filter(r => r.is_up).length,
      avgPity: fiveNum ? (totalPulls / fiveNum).toFixed(1) : '0.0',
      latest: records[0]?.time || '',
      nickname: p.avg_nick_name || '',
    }
  }
  return pools
}

/** 云端与本地按 id 合并：云端缺期次时保留本地独有记录，避免整组覆盖 */
function mergeWorkshopPools(oldPools, newPools) {
  for (const key of Object.keys(newPools || {})) {
    const old = oldPools?.[key]
    if (!old) continue
    newPools[key] = recountPool(newPools[key], unionRecords(getPoolRecords(old), getPoolRecords(newPools[key])))
    if (!newPools[key].fourLog?.length) newPools[key].fourLog = old.fourLog || []
    if (!newPools[key].fourNum) newPools[key].fourNum = old.fourNum || 0
    if (!newPools[key].fourPity) newPools[key].fourPity = old.fourPity || 0
  }
  for (const key of Object.keys(oldPools || {})) {
    if (!newPools[key]) newPools[key] = oldPools[key]
  }
  return newPools
}

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

async function fetchWorkshopCloud(uid, unionId) {
  const url = `${WORKSHOP_API}?uid=${encodeURIComponent(String(uid))}&union_id=${encodeURIComponent(String(unionId))}`
  const { data } = await requestJson(url, {
    headers: { accept: 'application/json, text/plain, */*' },
  })
  if (Number(data?.code) !== 0) throw new Error(data?.message || '工坊云端返回异常')
  const analysis = data?.data?.card_analysis_json
  if (!analysis) throw new Error('工坊云端未返回该 UID 的抽卡数据，请确认 UID 是否正确')
  return analysis
}

/** 解析绝区零调频记录链接：只认 game_biz 含 nap */
function parseZzzUrl(url) {
  const query = parseGachaUrl(url)
  if (!query) return null
  const gameBiz = String(query.game_biz || '')
  if (gameBiz && !gameBiz.includes('nap')) return null
  return { ...query, game_biz: /^nap_global/.test(gameBiz) ? 'nap_global' : 'nap_cn', region: query.region || 'prod_gf_cn' }
}

function findZzzAuthkeyUrl(e) {
  for (const url of extractUrlsFromMsg(e)) {
    if (/gacha/i.test(url) && /authkey=/.test(url)) return url
  }
  return ''
}

/**
 * 绝区零统计视图（工坊小程序风格）：
 * 顶部汇总大卡（总抽数/平均每金/S级总数 + 全账号五项指标 + 称号与连击标签），
 * S级头像网格（同名去重计数），以及各池的进度条列表。
 * 网格与分池区块只含所选池；五项汇总指标固定按全账号口径。
 */
function buildZzzStatView(data, uid, e, keys = [], itemFilter = null) {
  // 常驻频段（GachaType_Permanent）是混合池：角色/音擎/邦布混在一起。
  // 统计指令按「类型」拆分：itemFilter 为 角色/音擎/邦布 时，常驻池只保留对应类型的五星，
  // 其余池（独家频段=角色、音擎频段=音擎、邦布频段=邦布）天然同质，整池取即可。
  const srcPools = fillZzzIcons(data.pools || {})
  const pickByType = t => t === '音擎' || t === '邦布' ? t : '角色'
  // 计算该统计视图实际应包含的池 key（常驻池按 itemFilter 决定是否纳入）
  const wantedKeys = []
  for (const key of keys.length ? keys : Object.keys(srcPools)) {
    if (key === 'GachaType_Permanent' && itemFilter) {
      const perm = srcPools[key]
      const hasType = (perm?.records || []).some(r => pickByType(zzzItemType(r)) === itemFilter)
      if (hasType) wantedKeys.push(key)
      continue
    }
    wantedKeys.push(key)
  }

  const base = buildSummaryView(filterPools({ ...data, pools: srcPools }, wantedKeys), uid, e, 'grid', 'zzz')
  const pools = base.pools || []
  const sumOf = (list, field) => list.reduce((s, p) => s + (Number(p[field]) || 0), 0)
  const find = key => pools.find(p => p.key === key)

  // 常驻池按类型拆分：把五个五星按 item_type 过滤出本统计要的部分
  const permPool = find('GachaType_Permanent')
  if (permPool && itemFilter) {
    const keep = (permPool.fiveLog || []).filter(it => pickByType(it.item_type || '角色') === itemFilter)
    permPool.fiveLog = keep
    permPool.fiveNum = keep.length
  }

  const allNum = sumOf(pools, 'allNum')
  const sNum = sumOf(pools, 'fiveNum')
  const avgGold = sNum ? (allNum / sNum).toFixed(1) : '--'
  const title = avgGold === '--' ? '暂无记录' : avgGold <= 55 ? '欧气附体小欧皇' : avgGold <= 65 ? '天选打工人' : avgGold <= 78 ? '平平无奇小保底' : '水逆缠身大非酋'

  // 全账号五项指标（与工坊口径一致）：UP平均取 line[1][1]（UP平均列）
  // 第一项「保底不歪」按统计类型：角色→角色UP池、音擎→音擎UP池；邦布无 UP 概念，显示五星数
  const UP_KEYS_BY_TYPE = {
    角色: ['GachaType_CharacterUp', 'GachaType_RerunCharacter'],
    音擎: ['GachaType_WeaponUp', 'GachaType_RerunWeapon'],
  }
  let rateLable, rateNum
  if (itemFilter === '邦布') {
    rateLable = '邦布五星数'
    rateNum = String(find('GachaType_Bangboo')?.fiveNum || 0)
  } else {
    const ratePools = (UP_KEYS_BY_TYPE[itemFilter || '角色']).map(k => find(k)).filter(Boolean)
    const rateFive = sumOf(ratePools, 'fiveNum')
    const rateUp = sumOf(ratePools, 'upNum')
    rateLable = itemFilter === '音擎' ? '音擎保底不歪' : '角色保底不歪'
    rateNum = rateFive ? `${Math.round((rateUp / rateFive) * 1000) / 10}%` : '--'
  }
  // 「每UP角色需 / 每UP音擎需 / 常驻每金 / 每邦布需」属全账号口径，不受本次统计
  // 范围（keys）过滤影响——武器统计里没有角色池、邦布统计里没有角色/音擎池，
  // 从过滤后的 base.pools 取会恒为 '--'，故从全量池视图取值
  const allBase = buildSummaryView(filterPools({ ...data, pools: srcPools }, Object.keys(srcPools)), uid, e, 'grid', 'zzz')
  const allFind = key => allBase.pools.find(p => p.key === key)
  const metrics = [
    { num: rateNum, unit: '', lable: rateLable },
    { num: allFind('GachaType_CharacterUp')?.line?.[1]?.[1]?.num || '--', unit: '抽', lable: '每UP角色需' },
    { num: allFind('GachaType_WeaponUp')?.line?.[1]?.[1]?.num || '--', unit: '抽', lable: '每UP音擎需' },
    { num: allFind('GachaType_Permanent')?.avgPity || '--', unit: '抽', lable: '常驻每金' },
    { num: allFind('GachaType_Bangboo')?.avgPity || '--', unit: '抽', lable: '每邦布需' },
  ]

  // 连击标签：当前连UP / 最长连歪（按独家频段时间倒序的 fiveLog）
  const charLog = find('GachaType_CharacterUp')?.fiveLog || []
  let upStreak = 0
  for (const it of charLog) { if (it.isUp) upStreak++; else break }
  let worstStreak = 0
  let curStreak = 0
  for (const it of charLog) {
    if (it.isUp === false) { curStreak++; worstStreak = Math.max(worstStreak, curStreak) } else curStreak = 0
  }
  const chips = []
  if (upStreak > 1) chips.push(`代理${upStreak}连UP`)
  if (worstStreak > 1) chips.push(`代理${worstStreak}连歪`)

  // S级头像网格：同名去重计数（保持首次出现顺序）
  const gridMap = new Map()
  for (const pool of pools) {
    for (const it of pool.fiveLog || []) {
      const g = gridMap.get(it.name) || { name: it.name, icon: it.icon, count: 0 }
      g.count++
      if (!g.icon) g.icon = it.icon
      gridMap.set(it.name, g)
    }
  }

  // 网格标题按所选范围生成
  const hasChar = itemFilter === '角色' || itemFilter === null
  const hasCommon = itemFilter === null || wantedKeys.includes('GachaType_Permanent')
  const limitedNum = sumOf(pools.filter(p => p.key === 'GachaType_CharacterUp' || p.key === 'GachaType_RerunCharacter'), 'fiveNum')
  const commonNum = find('GachaType_Permanent')?.fiveNum || 0
  let gridTitle
  if (itemFilter) gridTitle = `共获得S级 ${sNum} 个，具体如下：`
  else if (hasChar && hasCommon) gridTitle = `共获得限定S级 ${limitedNum} 个，常驻S级 ${commonNum} 个，具体如下：`
  else if (hasChar) gridTitle = `共获得限定S级 ${limitedNum} 个，具体如下：`
  else gridTitle = `共获得S级 ${sNum} 个，具体如下：`

  // 分池进度条：长度按抽数相对 S 级保底 90 的比例（短=欧、长=非），颜色阈值 45/70 抽
  const UP_POOLS = new Set(['GachaType_CharacterUp', 'GachaType_RerunCharacter', 'GachaType_WeaponUp'])
  const pctOf = n => Math.min(100, Math.max(8, Math.round((Number(n) / 90) * 100)))
  const sections = pools.map(p => ({
    name: p.name,
    pity: p.pity || 0,
    pityPct: p.pity ? pctOf(p.pity) : 0,
    list: (p.fiveLog || []).map(it => ({
      icon: it.icon || '',
      num: it.num,
      pct: pctOf(it.num),
      wai: it.isUp === false && UP_POOLS.has(p.key),
      cls: it.num < 45 ? 'good' : it.num < 70 ? 'mid' : 'bad',
    })),
  }))

  // 右上角说明文字按池类型（各池 fiveLog 最新在前，取首个非空池的最新 S）
  const NOTE_BY_KEY = {
    GachaType_CharacterUp: '角色池最新S',
    GachaType_RerunCharacter: '角色池最新S',
    GachaType_WeaponUp: '音擎池最新S',
    GachaType_RerunWeapon: '音擎池最新S',
    GachaType_Permanent: '常驻池最新S',
    GachaType_Bangboo: '邦布池最新S',
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
      // 右上角头像与说明：取本次统计范围内最新一个 S（武器统计→音擎池最新S，以此类推）
      avatar: firstS?.first?.icon || '',
      avatarNote: firstS ? NOTE_BY_KEY[firstS.key] : '暂无S记录',
    },
    sections,
  }
}

export class zzz_gacha extends plugin {
  constructor () {
    super({
      name: '[米哈游]绝区零抽卡记录',
      dsc: '绝区零抽卡记录查询与更新',
      event: 'message',
      priority: pluginPriority('zzz_gacha', Number.MIN_SAFE_INTEGER),
      rule: [
        // 「绝区零」必须出现，否则 `(绝区零|zzz)?` 与 `(抽卡|调频)?` 都可空，
        // 会把「#米哈游帮助」这类总帮助也吃掉。
        // 抽卡/调频 不能是可选的：`^米哈游绝区零帮助$` 里的「绝区零」是**游戏名**，
        // 用户想看的是绝区零的游戏帮助，不是抽卡帮助。这条 rule 的 priority 比总帮助小，
        // 之前会把「#米哈游绝区零帮助」吞成抽卡帮助。现在要求必须带 抽卡/调频 字样。
        { reg: '^#*米哈游(绝区零|zzz)(抽卡|调频)帮助$', fnc: 'help' },
        { reg: '^#*米哈游(抽卡|调频)帮助$', fnc: 'help' },
        // 不带「米哈游」前缀的写法：#绝区零抽卡帮助 / 绝区零调频帮助 / %绝区零抽卡帮助
        // 必须带游戏名，否则会与总帮助、原神/星铁抽卡帮助撞车。
        { reg: '^[#*%％]?[ \t]*(?:绝区零|绝区|zzz|ZZZ)[ \t]*(抽卡|调频)帮助$', fnc: 'help' },
        { reg: '^#*米哈游(绝区零|zzz)?抽卡链接(\\s+.*)?$', fnc: 'gachaLink' },
        { reg: '^#*米哈游(绝区零|zzz)?(刷新|更新)抽卡记录$', fnc: 'refresh' },
        // 不带「米哈游」前缀的写法，同样由本插件接管
        { reg: '^[#*%％]?[ \t]*(?:绝区零|绝区|zzz|ZZZ)[ \t]*(刷新|更新)抽卡记录$', fnc: 'refresh' },
        { reg: '^#*米哈游(绝区零|zzz)?(抽卡|调频)(记录|统计|分析)$', fnc: 'summary' },
        { reg: '^#*米哈游(绝区零|zzz)?角色记录$', fnc: 'roleRecord' },
        { reg: '^#*米哈游(绝区零|zzz)?角色统计$', fnc: 'roleStat' },
        { reg: '^#*米哈游(绝区零|zzz)?(音擎|武器)记录$', fnc: 'weaponRecord' },
        { reg: '^#*米哈游(绝区零|zzz)?(音擎|武器)统计$', fnc: 'weaponStat' },
        { reg: '^#*米哈游(绝区零|zzz)?邦布记录$', fnc: 'bangbooRecord' },
        { reg: '^#*米哈游(绝区零|zzz)?邦布统计$', fnc: 'bangbooStat' },
        { reg: '^#*米哈游(绝区零|zzz)?全部统计$', fnc: 'allStat' },
        // 无 xhh/小花火 前缀的裸指令。`%角色记录` 会被框架 zzzReg 改写成
        // `#绝区零角色记录`，故这里也要认「绝区零」前缀，否则会被喵喵抢走。
        // 绝区零裸指令。三种前缀都直接认，不依赖框架的规范化结果：
        //   · %        框架 zzzReg 与 genshin dealPrefix 都会改写成 #绝区零，
        //               但两者对「前导空格」处理相反（框架无 \s*、dealPrefix 有），
        //               谁先跑取决于消息里有没有空格 —— 曾导致同一指令时而归本插件、
        //               时而落到 genshin。这里连原始写法一并匹配，消除该差异。
        //   · #绝区零   框架规范化后的形式
        //   · *绝区零   手写星号形式
        // 另：绝区零前缀不可省，*角色记录 这类裸指令归星铁，否则两模块会同时命中。
        //   · %        必须能单独成立（%角色统计 里 % 后直接就是「角色」），
        //               不能强制再跟一个「绝区零」，否则永远匹配不上。
        //   · #绝区零   框架规范化后的形式
        //   · 绝区零裸写 / *绝区零  手写形式
        // 前导空格一并容忍，抹平框架 zzzReg 与 dealPrefix 在该点上的差异。
        // 末尾允许追加 UID（%代理人记录 12915316），与其他裸指令保持一致
        { reg: '^[ \\t]*(?:#?[ \\t]*绝区零|[%％]|[ \\t]*(?:绝区|zzz|ZZZ))[ \\t]*(代理人|角色|音擎|武器|邦布|常驻|全部)(记录|统计)(?:\\s*\\d{5,})?$', fnc: 'bareStat' },
        { reg: '^[*][ \\t]*(?:绝区零|绝区|zzz|ZZZ)[ \\t]*(代理人|角色|音擎|武器|邦布|常驻|全部)(记录|统计)(?:\\s*\\d{5,})?$', fnc: 'bareStat' },
        { reg: '^#*米哈游(绝区零|zzz)?(更新|刷新|同步)?工坊(抽卡|调频)?(记录|数据)$', fnc: 'updateWorkshop' },
        { reg: '^#*米哈游(绝区零|zzz)?绑定工坊(\\s+\\S+)?$', fnc: 'bindWorkshop' },
        { reg: '^#*米哈游(绝区零|zzz)?(导入|合并)四星(\\s+\\S+)?$', fnc: 'importFourStar' },
        { reg: '^#*米哈游(绝区零|zzz)?导出(抽卡)?(记录|json)$', fnc: 'exportLog' },
        { reg: '^#*米哈游(绝区零|zzz)?(导入)(抽卡)?(记录|json)$', fnc: 'importLog' },
        { reg: '^#*米哈游(绝区零|zzz)?重建图标(索引)?$', fnc: 'rebuildIconIndex' },
      ],
    })
  }

  async help(e) {
    /* 改成合并转发，按「更新 / 查询 / 提示」分三节，避免一长串刷屏。
       连接器不支持合并转发时 makeForwardMsg 内部会退回纯文本。 */
    const nodes = [
      [
        '【#米哈游绝区零抽卡帮助】',
        '',
        '更新数据（建议按顺序跑前两条）',
        '#米哈游绝区零更新抽卡记录 —— 直连官方接口拉逐抽明细（含四星/常驻/邦布），无需链接',
        '#米哈游绝区零更新工坊记录 —— 从工坊云端补更早的历史（五星与统计）',
        '#米哈游绝区零导入四星 —— 从 ZZZ-Plugin 已存数据补四星明细（不发请求，可选）',
        '#米哈游绝区零导出记录 —— 导出 UIGF v2 JSON（可备份、可再导入）',
        '#米哈游绝区零导入记录 —— 发指令后把导出的 JSON 发回来，按 id 去重并入',
        '#米哈游绝区零抽卡链接 <链接> —— 官方接口取不到时的手动备选（需复制调频记录页网址）',
        '#米哈游绝区零绑定工坊 <id> —— 一般用不到，union_id 可选',
        '#米哈游绝区零重建图标索引 —— 绝区零出新角色后重建图标',
      ].join('\n'),
      [
        '查询',
        '#米哈游绝区零抽卡记录 —— 抽卡总览统计',
        '#米哈游绝区零角色记录 / #米哈游绝区零音擎记录 / #米哈游绝区零邦布记录 —— 各卡池进度',
        '#米哈游绝区零角色统计 / #米哈游绝区零音擎统计 / #米哈游绝区零邦布统计 / #米哈游绝区零全部统计 —— 工坊风格统计卡（汇总+网格+进度）',
      ].join('\n'),
      [
        '提示',
        '米哈游即可（不再用旧前缀），绝区零可写作 zzz，音擎可写作 武器。',
        '更新前需先在 genshin 侧绑定绝区零账号（官方接口用的是该账号的 Cookie）。',
      ].join('\n'),
    ]
    return e.reply(await makeForwardMsg(e, nodes, '绝区零抽卡帮助'))
  }

  async gachaLink(e) {
    if (!/抽卡链接/.test(String(e.msg || ''))) return false
    const url = findZzzAuthkeyUrl(e)
    if (!url) {
      return e.reply([
        '请把绝区零【调频记录】页面的链接发给我，格式类似：',
        '#米哈游绝区零抽卡链接 https://public-operation-common.mihoyo.com/common/gacha_record/api/getGachaLog?authkey=xxx&game_biz=nap_cn',
        '',
        '获取方法：游戏内打开【调频记录】→ 多翻几页 → 分享/网页复制地址栏（必须带 authkey=）',
      ].join('\n'))
    }
    const query = parseZzzUrl(url)
    if (!query?.authkey) return e.reply('链接里没有 authkey，请确认复制的是调频记录页面的完整网址')
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply('正在通过官方调频记录链接获取完整记录（含四星/常驻/邦布），可能需要一两分钟，请稍候……')
    try {
      const result = await fetchAllByAuthkeyZzz(query)
      const old = readData(getDataFile(auth.uid, auth.qq))
      const pools = old?.pools ? mergeWorkshopPools(old.pools, result.pools) : result.pools
      const data = { ...(old || {}), uid: String(auth.uid), pools, update_time: formatNow(), source: 'authkey' }
      saveData(getDataFile(auth.uid, auth.qq), data)
      saveData(getDataFile(auth.uid, auth.qq) + '.link.json', { authkey: query.authkey, game_biz: query.game_biz, region: result.region, update_time: formatNow() })
      const stats = Object.values(pools)
        .filter(p => p.fiveNum || p.totalPulls)
        .map(p => `【${p.name}】共${p.totalPulls}抽｜五星${p.fiveNum}｜四星${p.fourNum || 0}`)
        .join('\n')
      await e.reply(`调频记录链接解析成功！\n${stats}`)
      await this.render(e, [], 'grid')
      return e.reply('发送【#米哈游绝区零抽卡帮助】查看全部指令')
    } catch (err) {
      logger.error('[HoYoGet][zzz_gacha] gachaLink failed:', err)
      return e.reply(`调频记录链接解析失败：${err?.message || err}`)
    }
  }

  async refresh(e) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const link = readData(getDataFile(auth.uid, auth.qq) + '.link.json')
    await e.reply('正在通过官方调频记录接口获取，请稍候……')
    let result = null
    let officialErr = ''
    try {
      result = await fetchAllByCookieZzz(e, auth.cookies, auth.uid)
    } catch (err) {
      officialErr = err?.message || String(err)
      logger.warn(`[HoYoGet][zzz_gacha] 官方 Cookie 接口拉取失败: ${officialErr}`)
    }
    if (!result) {
      if (!link?.authkey) {
        return e.reply([
          `官方接口未取到记录：${officialErr || '无返回'}`,
          '也可以先发送【#米哈游绝区零抽卡链接 + 链接】手动缓存一份；',
          '若只需更新五星与统计数据，直接发送【#米哈游绝区零更新工坊记录】即可，无需链接。',
        ].join('\n'))
      }
      await e.reply(`官方接口未取到记录（${officialErr}），改用已缓存链接刷新……`)
      try {
        result = await fetchAllByAuthkeyZzz({ ...link, region: link.region })
      } catch (err) {
        logger.error('[HoYoGet][zzz_gacha] refresh failed:', err)
        return e.reply(`刷新失败：${err?.message || err}`)
      }
    }
    try {
      const old = readData(getDataFile(auth.uid, auth.qq))
      const pools = old?.pools ? mergeWorkshopPools(old.pools, result.pools) : result.pools
      saveData(getDataFile(auth.uid, auth.qq), { ...(old || {}), uid: String(auth.uid), pools: fillZzzIcons(pools), update_time: formatNow(), source: 'authkey' })
      const stats = Object.values(pools).filter(p => p.fiveNum || p.totalPulls).map(p => `【${p.name}】共${p.totalPulls}抽｜五星${p.fiveNum}`).join('\n')
      await e.reply(`刷新完成\n${stats}`)
      await this.render(e, [], 'grid')
    } catch (err) {
      logger.error('[HoYoGet][zzz_gacha] refresh failed:', err)
      return e.reply(`刷新失败：${err?.message || err}`)
    }
  }

  async updateWorkshop(e) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const bind = readData(getWorkshopBindFile(auth.qq))
    const unionId = bind?.union_id || WORKSHOP_FALLBACK_UNION_ID
    if (!bind?.union_id) logger.mark('[HoYoGet][zzz_gacha] 未绑定 union_id，改用占位值请求工坊云端（云端不校验该参数）')
    await e.reply(`正在从工坊云端获取抽卡记录，请稍候……${unionId === WORKSHOP_FALLBACK_UNION_ID ? '（未绑定 union_id，使用占位值）' : ''}`)
    try {
      const analysis = await fetchWorkshopCloud(auth.uid, unionId)
      const old = readData(getDataFile(auth.uid, auth.qq))
      const cloudPools = convertWorkshopPools(analysis, buildNameHint(old?.pools))
      const pools = old?.pools ? mergeWorkshopPools(old.pools, cloudPools) : cloudPools
      saveData(getDataFile(auth.uid, auth.qq), { ...(old || {}), uid: String(auth.uid), pools: fillZzzIcons(pools), update_time: formatNow(), source: 'workshop' })
      const stats = Object.values(pools).filter(p => p.fiveNum || p.totalPulls).map(p => `【${p.name}】共${p.totalPulls}抽｜五星${p.fiveNum}`).join('\n')
      await e.reply(`工坊云端记录同步完成！\n${stats}`)
      await this.render(e, [], 'grid')
      return e.reply('发送【#米哈游绝区零抽卡帮助】查看全部指令')
    } catch (err) {
      logger.error('[HoYoGet][zzz_gacha] updateWorkshop failed:', err)
      return e.reply(`工坊云端同步失败：${err?.message || err}`)
    }
  }

  /**
   * 重建绝区零图标索引：抓 Bwiki 三个图鉴页，解析出「名称 -> 图片 URL」落盘。
   * 仅在索引过期或新增角色时使用；Bwiki 限流很凶，页间强制等待且遇风控即中止。
   */
  async rebuildIconIndex(e) {
    const PAGES = { 角色: '角色图鉴', 音擎: '音擎图鉴', 邦布: '邦布图鉴' }
    const index = {}
    let failed = 0
    await e.reply('正在从 Bwiki 抓取绝区零图鉴以重建图标索引，请稍候……')
    for (const [ kind, page ] of Object.entries(PAGES)) {
      try {
        const url = `${BWIKI_ZZZ_API}?action=parse&page=${encodeURIComponent(page)}&prop=text&format=json&redirects=1`
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(25000) })
        if (!(res.headers.get('content-type') || '').includes('json')) {
          failed++
          await e.reply(`【${page}】被风控拦截（HTTP ${res.status}），请稍后再试`)
          break
        }
        const html = (await res.json())?.parse?.text?.['*'] || ''
        if (!html) {
          failed++
          await e.reply(`【${page}】返回空内容`)
          continue
        }
        let count = 0
        // 每张卡片截到下一张为止，避免跨卡片取到别人的图
        for (const block of String(html).split(/(?=<div[^>]*class="[^"]*role-box)/).slice(1)) {
          const name = decodeURIComponent((block.match(/title="([^"]+)"/) || [])[1] || '').trim()
          if (!name) continue
          const imgs = [ ...block.matchAll(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]+)"/g) ].map(m => ({ alt: m[1], src: m[2] }))
          // 排除阵营 Logo 与属性图标，优先取头像/立绘类
          const pick = imgs.find(i => /头像|立绘/.test(i.alt) && !/Logo|阵营/.test(i.alt))
            || imgs.find(i => !/Logo|阵营|图标-(强攻|击破|支援|异常|防护|命破|锋御)/.test(i.alt))
          if (!pick?.src?.startsWith('http')) continue
          index[name] = { icon: pick.src, kind, alt: pick.alt }
          count++
        }
        await e.reply(`【${page}】提取 ${count} 条`)
      } catch (err) {
        failed++
        logger.error(`[HoYoGet][zzz_gacha] 重建图标索引失败 ${page}：${err?.message || err}`)
        await e.reply(`【${page}】抓取失败：${err?.message || err}`)
      }
      // Bwiki 限流很凶，页间必须放慢
      await sleep(2500)
    }
    const names = Object.keys(index)
    if (!names.length) return e.reply('未能获取任何图标，请稍后重试')
    fs.mkdirSync(ZZZ_ICON_DIR, { recursive: true })
    fs.writeFileSync(ZZZ_ICON_INDEX_FILE, JSON.stringify(index, null, 1), 'utf8')
    zzzIconIndex = null // 让下次读取时重新加载
    const counts = Object.values(index).reduce((m, v) => ({ ...m, [v.kind]: (m[v.kind] || 0) + 1 }), {})
    await e.reply([
      `图标索引重建完成，共 ${names.length} 条`,
      ...Object.entries(counts).map(([ k, v ]) => `　${k}：${v} 条`),
      failed ? `注意：有 ${failed} 个页面抓取失败，索引可能不完整` : '',
      '',
      '已有记录需要重新同步一次才会带上图标（发【#米哈游绝区零更新工坊记录】即可）。',
    ].filter(Boolean).join('\n'))
  }

  /**
   * 导出抽卡记录（UIGF v2）。
   *
   * 格式沿用官方 UIGF：`{ info:{ uid, lang, uigf_version, ...}, list:[...] }`，
   * 逐抽逐条写出五星与四星明细，可直接被 UIGF 系工具读取，也能被本插件的
   * 「导入记录」原样导回。绝区零的 UIGF 里 list 元素用 `gacha_type` 表示卡池。
   */
  async exportLog(e) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const data = readData(getDataFile(auth.uid, auth.qq))
    if (!data?.pools) return e.reply('暂无绝区零抽卡记录，请先发送【#米哈游绝区零更新抽卡记录】')
    const list = []
    for (const meta of ZZZ_POOLS) {
      const pool = data.pools[meta.key]
      if (!pool) continue
      const fiveIds = new Set((pool.records || []).map(r => String(r?.id || '')))
      const seen = new Set()
      for (const row of [...(pool.records || []), ...(pool.fourLog || [])]) {
        const id = String(row?.id || '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        const isFive = fiveIds.has(id)
        list.push({
          uid: String(auth.uid),
          gacha_id: '2c1f5692fdfbb733a08733f9eb69d32aed1d37',
          gacha_type: meta.type,
          item_id: '',
          count: isFive ? String(Number(row.gacha_count) || 1) : '1',
          time: String(row.time || ''),
          name: String(row.name || '未知'),
          lang: 'zh-cn',
          item_type: String(row.item_type || meta.hint),
          rank_type: isFive ? '5' : '4',
          // UP 标记非 UIGF 标准字段：官方侧无此概念，但丢掉会导致导入后全部变歪，
          // 故原样带出并在导入时读回
          is_up: isFive ? !!row.is_up : false,
          id,
        })
      }
    }
    if (!list.length) return e.reply('本地没有可导出的逐抽记录')
    list.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
    const payload = {
      info: {
        uid: String(auth.uid),
        lang: 'zh-cn',
        uigf_version: 'v2.3',
        export_time: formatNow(),
        export_app: 'xhh',
      },
      list,
    }
    const dir = `${PLUGIN_ROOT}/data/zzz_gacha/${auth.qq}/${auth.uid}`
    const file = `${dir}/${auth.uid}.json`
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(payload, null, '\t'))
    await e.reply(`UID:${auth.uid} 导出成功：${auth.uid}.json，共 ${list.length} 条\n请接收文件`)
    const send = e.group?.sendFile || e.friend?.sendFile
    if (send) await send.call(e.group || e.friend, file)
    else await e.reply('导出失败：当前适配器不支持发送文件')
    fs.unlink(file, () => {})
    return true
  }

  /**
   * 导入抽卡记录（UIGF v2）。需先发指令，再发 JSON 文件或文件链接。
   * 与既有来源一致：按 id 去重并入，只补不缺，不覆盖本地已有记录。
   */
  async importLog(e) {
    if (!e.file && !/^\s*[{[]/.test(String(e.msg || '')) && !/https?:\/\//.test(String(e.msg || ''))) {
      this.setContext('importLogFile')
      return e.reply('请发送抽卡记录文件（UIGF v2 JSON，支持文件、文件链接，或直接把 JSON 文本贴出来）')
    }
    return this.importLogFile(e)
  }

  /**
   * 读取用户发来的文件内容。
   *
   * 各适配器给的字段差别很大：QQ/NTQQ 常只给文件名不给本地路径（file.path 为空），
   * 只认 path 必然回「未读取到文件内容」。这里按
   * 本地路径 -> http 链接 -> base64 data URI -> 直接贴在消息里的 JSON 逐级兜底。
   */
  async readIncomingContent(e) {
    const file = e.file
    if (file) {
      const p = file?.path || file?.file || file?.name
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8')
      let url = String(file?.url || '')
      // 群/好友文件只给文件名时，必须用 fid 换下载地址，否则永远读不到内容
      // （同 genshin ExportLog.getImportSource 的做法）
      if (!url.startsWith('http') && file?.fid) {
        if (e.group?.getFileUrl) url = await e.group.getFileUrl(file.fid)
        else if (e.friend?.getFileUrl) url = await e.friend.getFileUrl(file.fid)
      }
      if (url.startsWith('http')) {
        const res = await fetch(url, { method: 'GET', timeout: 30000 })
        return await res.text()
      }
      if (url.startsWith('data:')) return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8')
    }
    const text = String(e.msg || '').trim()
    if (text.startsWith('{') || text.startsWith('[')) return text
    const link = text.match(/https?:\/\/\S+/)?.[0]
    if (link) {
      const res = await fetch(link, { method: 'GET', timeout: 30000 })
      return await res.text()
    }
    return ''
  }

  async importLogFile(e) {
    this.finish('importLogFile')
    let text = ''
    try {
      text = await this.readIncomingContent(e)
    } catch (err) {
      return e.reply(`读取失败：${err?.message || err}`)
    }
    if (!text) return e.reply('未读取到文件内容，请直接把 JSON 文本或文件链接发过来')
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return e.reply('不是合法的 JSON 文件')
    }
    const list = json?.list || json?.gachaLog?.list || json?.hkrpg?.[0]?.list
    if (!Array.isArray(list) || !list.length) return e.reply('文件里没有可导入的抽卡记录（缺少 list）')
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const file = getDataFile(auth.uid, auth.qq)
    const old = readData(file)
    if (!old?.pools) return e.reply('尚无本插件的绝区零抽卡数据，请先发送【#米哈游绝区零更新抽卡记录】')
    // 卡池归属按 UIGF 的 gacha_type；认不出的一律跳过，不硬塞进某个池
    const grouped = {}
    for (const row of list) {
      const meta = ZZZ_POOLS.find(p => p.type === String(row?.gacha_type))
      if (!meta) continue
      if (!grouped[meta.key]) grouped[meta.key] = []
      grouped[meta.key].push(row)
    }
    const detail = []
    let added = 0
    for (const meta of ZZZ_POOLS) {
      const rows = grouped[meta.key]
      if (!rows?.length) continue
      const pool = old.pools[meta.key]
      if (!pool) continue
      // 四星条目一并并入 fourLog，否则导出的明细导回后会只剩五星
      const four = rows.filter(r => String(r.rank_type) !== '5')
      if (four.length) {
        const mergedFour = unionRecords(pool.fourLog || [], four.map(r => ({
          id: String(r.id || ''),
          name: r.name || '未知',
          item_type: r.item_type || meta.hint,
          gacha_count: 0,
          time: String(r.time || ''),
          icon: '',
        })))
        pool.fourLog = mergedFour.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
        pool.fourNum = mergedFour.length
      }
      const five = rows.filter(r => String(r.rank_type) === '5')
      if (!five.length) {
        detail.push(`【${meta.name}】四星+${four.length}`)
        continue
      }
      const merged = unionRecords(pool.records || [], five.map(r => ({
        id: String(r.id || ''),
        name: r.name || '未知',
        item_type: r.item_type || meta.hint,
        is_up: !!r.is_up,
        gacha_count: 0,
        time: String(r.time || ''),
        icon: '',
      })))
      const grow = merged.length - (pool.records || []).length
      if (grow > 0) added += grow
      // 只重排 gacha_count，不动 totalPulls：新记录的抽数无从得知（UIGF 不含逐抽序号），
      // 用 recountPool 会拿 countTotal 反推总抽数，把本地已有的工坊口径直接冲掉
      pool.records = merged.sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
      pool.fiveNum = pool.records.length
      detail.push(`【${meta.name}】五星+${grow}${four.length ? `，四星+${four.length}` : ''}`)
    }
    if (!added) return e.reply('没有新记录可导入（按 id 判重后已全部存在）')
    saveData(file, { ...old, pools: fillZzzIcons(old.pools), update_time: formatNow() })
    await e.reply(`UID:${auth.uid}\n导入完成：新增 ${added} 条五星\n${detail.filter(Boolean).join('，')}`)
    return true
  }

  /**
   * 从 ZZZ-Plugin 已落盘的逐抽记录补四星明细。
   * 不发任何请求，纯本地读 `data/ZZZ-Plugin/gacha/{uid}.json`。
   */
  async importFourStar(e) {
    const arg = String(e.msg || '').match(/导入四星\s*(\S+)?/)?.[1]
    const auth = await getUserAuth(e)
    if (auth.error && !arg) return e.reply(auth.error)
    const uid = arg || auth?.uid
    if (!uid) return e.reply('请先绑定绝区零账号，或使用【#米哈游绝区零导入四星 <UID>】指定 UID')
    const pluginData = readZzzPluginRows(uid)
    if (!pluginData) {
      return e.reply(`未找到逐抽记录（${zzzPluginPoolFile(uid)}）\n请先在 ZZZ-Plugin 里更新一次绝区零抽卡记录，或把记录放到 data/zzz_gacha/zzz_plugin/`)
    }
    const file = getDataFile(uid, auth?.qq || e.user_id)
    const old = readData(file)
    if (!old?.pools) return e.reply('尚无本插件的绝区零抽卡数据，请先发送【#米哈游绝区零更新工坊记录】')
    const result = mergeZzzPluginPools(old.pools, pluginData)
    if (!result.fourAdded && !result.fiveAdded) {
      await e.reply(`UID:${uid}\n没有新的四星明细可导入（四星明细 ${Object.values(old.pools).reduce((s, p) => s + (p.fourLog || []).length, 0)} 条）`)
      return true
    }
    saveData(file, { ...old, pools: fillZzzIcons(old.pools), update_time: formatNow() })
    const detail = Object.values(old.pools)
      .map(p => `【${p.name}】${(p.fourLog || []).length}条`)
      .join('，')
    await e.reply(`UID:${uid}\n导入完成：四星明细新增${result.fourAdded}条${result.fiveAdded ? `，五星补${result.fiveAdded}条` : ''}\n${detail}`)
    await this.render(e, [], 'grid')
    return true
  }

  async bindWorkshop(e) {
    const qq = e.user_id
    const arg = String(e.msg || '').match(/绑定工坊\s*(\S+)?/)?.[1] || ''
    const value = arg.match(/union_id=([A-Za-z0-9_-]+)/)?.[1] || arg
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(value)) {
      const cur = readData(getWorkshopBindFile(qq))
      return e.reply([
        '【工坊云端绑定】',
        cur?.union_id ? `当前已绑定 union_id：${cur.union_id}` : '尚未绑定 union_id（不影响同步）',
        '',
        '用法：#米哈游绝区零绑定工坊 <union_id>',
        '云端目前只校验该参数非空、不校验内容，未绑定时同步会自动使用占位值；',
        '此处绑定仅用于云端将来启用校验时无需改动。',
      ].join('\n'))
    }
    saveData(getWorkshopBindFile(qq), { union_id: value, update_time: formatNow() })
    return e.reply(`工坊 union_id 绑定成功：${value}\n发送【#米哈游绝区零更新工坊记录】拉取云端记录`)
  }

  async render(e, keys = [], layout = 'grid', itemFilter = null) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const data = readData(getDataFile(auth.uid, auth.qq))
    if (!data?.pools) return e.reply('暂无绝区零抽卡记录，请先发送【#米哈游绝区零抽卡链接 + 链接】')
    let src = { ...data, pools: fillZzzIcons(data.pools) }
    // 常驻频段是角色+音擎+邦布混合池：记录视图按 itemFilter 只保留对应类型，与统计视图一致
    if (itemFilter && src.pools?.GachaType_Permanent) {
      const pool = src.pools.GachaType_Permanent
      const keep = (Array.isArray(pool.records) ? pool.records : []).filter(r => (r.item_type || '角色') === itemFilter)
      src = { ...src, pools: { ...src.pools, GachaType_Permanent: { ...pool, records: keep, recent: keep, fiveNum: keep.length } } }
    }
    // 第 6 参 miaoModels 省略：buildSummaryView 有默认值（取 sr_gacha 模块内缓存），
    // 且绝区零 makeIcon 分支只用记录自带 icon、不查 miao 模型；此前直接传
    // miaoModelsCache 会因本文件未定义该变量抛 ReferenceError 导致渲染失败
    const view = buildSummaryView(filterPools(src, keys), auth.uid, e, layout, 'zzz')
    const template = layout === 'progress' ? 'sr_gacha/progress' : 'sr_gacha/summary'
    const buf = await render(template, view, { e })
    if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
    return e.reply(buf)
  }

  async summary(e) {
    return this.render(e, [], 'grid')
  }

  /** 裸指令分发：#绝区零角色记录 / *音擎统计 等 */
  async bareStat(e) {
    const msg = e.msg.replace(/(绝区零|zzz|ZZZ)/g, '')
    if (/代理人|角色/.test(msg)) return /统计/.test(msg) ? this.roleStat(e) : this.roleRecord(e)
    if (/音擎|武器/.test(msg)) return /统计/.test(msg) ? this.weaponStat(e) : this.weaponRecord(e)
    if (/邦布/.test(msg)) return /统计/.test(msg) ? this.bangbooStat(e) : this.bangbooRecord(e)
    // 「%全部统计」等同 #绝区零全部统计
    if (/全部/.test(msg)) return this.allStat(e)
    if (/常驻/.test(msg)) return /统计/.test(msg) ? this.allStat(e) : this.summary(e)
    return false
  }

  async roleRecord(e) {
    // 常驻频段是混合池，角色记录只保留其中 item_type 为「角色」的五星
    return this.render(e, ['GachaType_CharacterUp', 'GachaType_RerunCharacter', 'GachaType_Permanent'], 'progress', '角色')
  }

  async weaponRecord(e) {
    // 常驻频段是混合池，武器记录只保留其中 item_type 为「音擎」的五星
    return this.render(e, ['GachaType_WeaponUp', 'GachaType_RerunWeapon', 'GachaType_Permanent'], 'progress', '音擎')
  }

  async bangbooRecord(e) {
    return this.render(e, ['GachaType_Bangboo'], 'progress')
  }

  /** 统计视图：工坊风格（顶部汇总大卡 + S级网格 + 分池进度条），与抽卡记录的模板区分 */
  async renderStat(e, keys = [], itemFilter = null) {
    const auth = await getUserAuth(e)
    if (auth.error) return e.reply(auth.error)
    const data = readData(getDataFile(auth.uid, auth.qq))
    if (!data?.pools) return e.reply('暂无绝区零抽卡记录，请先发送【#米哈游绝区零更新工坊记录】')
    const view = buildZzzStatView(data, auth.uid, e, keys, itemFilter)
    // pct 压低 sys.scale 的 zoom：本卡内容行数多（30+ 条进度），
    // 全局 zoom 放大后总高会超出渲染后端截图上限被拦腰截断
    const buf = await render('zzz_gacha/stat', view, { e, pct: 1.5 })
    if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
    return e.reply(buf)
  }

  async roleStat(e) {
    // 常驻频段是混合池，角色统计只取其中 item_type 为「角色」的五星
    return this.renderStat(e, ['GachaType_CharacterUp', 'GachaType_RerunCharacter', 'GachaType_Permanent'], '角色')
  }

  async weaponStat(e) {
    // 常驻频段里的音擎归武器统计
    return this.renderStat(e, ['GachaType_WeaponUp', 'GachaType_RerunWeapon', 'GachaType_Permanent'], '音擎')
  }

  async bangbooStat(e) {
    // 常驻频段里的邦布归邦布统计
    return this.renderStat(e, ['GachaType_Bangboo', 'GachaType_Permanent'], '邦布')
  }

  async allStat(e) {
    return this.renderStat(e, [])
  }
}

// 模块开关：锅巴里关掉「zzz_gacha」后，本文件所有指令静默不响应
guardModuleByFile(zzz_gacha, 'zzz_gacha', 'zzz/zzz_gacha.js')
