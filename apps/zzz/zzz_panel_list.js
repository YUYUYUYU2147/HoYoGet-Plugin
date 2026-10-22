import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, mhy, pluginPriority, render, yaml, makeForwardMsg, mys } from '#HoYoGet'
import { damageSkillsAt, getCharRates } from '../../system/zzz_skill_rate.js'
import { getBuffAreas } from '../../system/zzz_buff.js'
import { mhyFetch } from '../../system/mhy_fetch.js'
import { zzzPanelExtras } from '../../system/zzz_panel.js'
import { fillBaseAdd } from '../../system/zzz_attr_base.js'
import { getPanelBg } from '../../system/zzz_panel_bg.js'

/**
 * 绝区零面板（xhh 自研）—— 第 2 步：归一化 + 自研渲染。
 *
 * 数据源：米游社 record 接口 avatar/basic（角色基础列表）。
 * 第 1 步探针已确认真实字段（见 HANDOFF_zzz_panel.md），本步据此写归一化与渲染，
 * 不复用 ZZZ-Plugin 的模板/算法，只借鉴产品形态。
 *
 * 单角色详情指令（米游社<名字>面板，如 米游社南宫羽面板）已实现：复用同一份基础列表取 id，
 * 再调 avatar/info 拿 专武/驱动盘/技能/影，自研模板 resources/zzz_panel/detail.html 出图。
 *
 * 入口指令：
 *   - `米游社更新面板`  → 列表面板（本插件）
 *   - `米游社<名字>面板`（如 米游社南宫羽面板）→ 单角色详情（本插件，旧「米游社面板 <名字>」仍兼容）
 *   都不带 # 前缀，靠有无 # 区分绝区零（本插件）/ 原神（miao-plugin 的 #米游社更新面板）。
 */

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const ZZZ_ROOT = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin')
const OUT_DIR = path.join(PLUGIN_ROOT, 'data', 'zzz_panel')
const RECORDS_DIR = path.join(OUT_DIR, 'records')
const EXTREME_PRESET_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_extreme.yaml')

// 属性 / 职业 中文映射，与 system/mys.js 的 zzz_element_map / zzz_type_map 保持一致
//（属产品形态，非角色数值表，数值表一律现取、不搬）。
const ZZZ_ELEMENT_MAP = { 200: '物理', 201: '火', 202: '冰', 203: '电', 204: '风', 205: '以太', 300: '流明' }
const ZZZ_TYPE_MAP = { 1: '强攻', 2: '击破', 3: '异常', 4: '支援', 5: '防护', 6: '命破', 7: '锋御' }
// 卡片配色（展示用，对应属性主题色）
const ELEMENT_COLOR = { 物理: '#9aa4ad', 火: '#ff6b4a', 冰: '#5cc8ff', 电: '#ffd84d', 风: '#6fe3b0', 以太: '#b98bff', 流明: '#ffe9a8' }
const RARITY_COLOR = { S: '#ffcf5c', A: '#9b8cff' }

// 米游社属性 id → 模板字段键 / 精灵类名（图标在 resources/zzz_panel/images/panel_icons/ 下）
const ZPROP = {
  1: { k: 'hpmax', c: 'hpmax' }, 11102: { k: 'hpmax', c: 'hpmax' }, 11103: { k: 'hpmax', c: 'hpmax' },
  2: { k: 'attack', c: 'attack' }, 12101: { k: 'attack', c: 'attack' }, 12102: { k: 'attack', c: 'attack' }, 12103: { k: 'attack', c: 'attack' },
  3: { k: 'def', c: 'def' }, 13102: { k: 'def', c: 'def' }, 13103: { k: 'def', c: 'def' },
  4: { k: 'breakstun', c: 'breakstun' }, 12202: { k: 'breakstun', c: 'breakstun' },
  5: { k: 'crit', c: 'crit' }, 20103: { k: 'crit', c: 'crit' },
  6: { k: 'critdam', c: 'critdam' }, 21103: { k: 'critdam', c: 'critdam' },
  7: { k: 'elementabnormalpower', c: 'elementabnormalpower' }, 31402: { k: 'elementabnormalpower', c: 'elementabnormalpower' },
  8: { k: 'elementmystery', c: 'elementmystery' }, 31203: { k: 'elementmystery', c: 'elementmystery' },
  9: { k: 'penratio', c: 'penratio' }, 23103: { k: 'penratio', c: 'penratio' },
  11: { k: 'sprecover', c: 'sprecover' }, 30502: { k: 'sprecover', c: 'sprecover' },
  232: { k: 'penvalue', c: 'penvalue' }, 23203: { k: 'penvalue', c: 'penvalue' },
  315: { k: 'dmgbonus', c: 'dmgbonus' }, 316: { k: 'dmgbonus', c: 'dmgbonus' },
  317: { k: 'dmgbonus', c: 'dmgbonus' }, 318: { k: 'dmgbonus', c: 'dmgbonus' },
  319: { k: 'dmgbonus', c: 'dmgbonus' }, 323: { k: 'dmgbonus', c: 'dmgbonus' },
  // ZZZ-Plugin 的面板缓存里属性用的是短代码（111/121/131/201/211/…），
  // 米游社接口是长代码（11102/12102/…），两套都要认，否则读别人的面板会取不到攻击力。
  111: { k: 'hpmax', c: 'hpmax' },
  121: { k: 'attack', c: 'attack' },
  131: { k: 'def', c: 'def' },
  201: { k: 'crit', c: 'crit' },
  211: { k: 'critdam', c: 'critdam' },
  231: { k: 'penratio', c: 'penratio' },
  305: { k: 'sprecover', c: 'sprecover' },
  312: { k: 'elementmystery', c: 'elementmystery' },
  314: { k: 'elementabnormalpower', c: 'elementabnormalpower' },
}
// 字段键 → 中文标签（属性行显示名）
const ZPROP_LABEL = {
  hpmax: '生命值', attack: '攻击力', def: '防御力', breakstun: '冲击力', crit: '暴击率',
  critdam: '暴击伤害', elementabnormalpower: '异常掌控', elementmystery: '异常精通',
  penratio: '穿透率', sprecover: '能量自动回复', penvalue: '穿透值', dmgbonus: '伤害加成',
}
// 元素 type → 精灵类名（element-icon 用；小写；以太用 ether）
const ZELEM = { 200: 'physical', 201: 'fire', 202: 'ice', 203: 'electric', 204: 'wind', 205: 'ether', 300: 'lumiflux' }
const ZELEM_STR = { 200: 'Physical', 201: 'Fire', 202: 'Ice', 203: 'Electric', 204: 'Wind', 205: 'Ether', 300: 'Lumiflux' }
// 技能类型 → 固定槽位顺序（模板按 skills[0..5] 取）
const SKILL_POS = [0, 1, 2, 3, 5, 6]

/** 把米游社一条基础列表角色，归一化为卡片所需的最小字段，不引入任何猜测字段 */
function normalizeAvatar(item) {
  const element = ZZZ_ELEMENT_MAP[item?.element_type] || `属性${item?.element_type ?? ''}`
  const type = ZZZ_TYPE_MAP[item?.avatar_profession] || `类型${item?.avatar_profession ?? ''}`
  const rarity = item?.rarity === 'S' ? 'S' : (item?.rarity || 'A')
  return {
    id: item?.id,
    name: item?.name_mi18n || item?.full_name_mi18n || `角色${item?.id}`,
    level: item?.level ?? 0,
    rarity,
    rarityColor: RARITY_COLOR[rarity] || '#9b8cff',
    element,
    elementEn: ZELEM_STR[item?.element_type] || '',
    elementColor: ELEMENT_COLOR[element] || '#888',
    type,
    typeCn: ZZZ_TYPE_MAP[item?.avatar_profession] || '',
    camp: item?.camp_name_mi18n || '',
    rank: item?.rank ?? 0,
    icon: item?.role_square_url || item?.hollow_icon_path || item?.group_icon_path || '',
  }
}

/** 本地时间字符串，用于面板页脚时间戳 */
function formatNow() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 面板左上角：优先游戏内昵称/头像，拿不到再回落群名片/QQ 头像 */
function getPlayerBadge(e, gamePlayer = null) {
  const qq = e?.user_id || e?.sender?.user_id || ''
  const qqName = e?.sender?.card || e?.sender?.nickname || e?.friend?.nickname || e?.user?.nickname || (qq ? String(qq) : '')
  const qqAvatar = e?.sender?.avatar || (qq ? `https://q1.qlogo.cn/g?b=qq&s=100&nk=${qq}` : '')
  const gameName = gamePlayer?.nickname || gamePlayer?.game_name || ''
  const gameAvatar = gamePlayer?.avatar || gamePlayer?.game_avatar || gamePlayer?.gameAvatar || ''
  return { playerName: gameName || qqName, playerAvatar: gameAvatar || qqAvatar }
}

/** 多账号 CK 里挑出与当前 ZZZ UID 匹配的那条，避免拿到原神/别的账号的 cookie */
/**
 * 从 CK 表里挑出与目标 uid 对应的那一条。
 *
 * 不能「匹配不到就回落 list[0]」：CK 表是按 ltuid 存的，条目里的 uid 是
 * 该账号上次绑定/查询过的游戏 UID。换过号、从 ZZZ-Plugin 迁移过数据、
 * 或表里只记了账号 1 的 uid 时，回落会拿**别人的 cookie** 去请求目标 uid，
 * 结果不是 10041，就是返回另一个账号下同名角色的数据 —— 后者更危险，
 * 因为看起来「查成功了」。
 *
 * 因此策略是：
 *   1) uid 精确匹配 → 用它
 *   2) 只有一个账号 → 用它（单账号用户没有歧义）
 *   3) 多个账号但都对不上 → 返回 null，由调用方明确报错，不要瞎猜
 */
function pickCkItem(ck, uid = '') {
  const list = Object.values(ck || {}).filter(item => item?.ck)
  if (!list.length) return null
  const want = String(uid || '')
  if (want) {
    const hit = list.find(item => String(item.uid) === want)
    if (hit) return hit
  }
  if (list.length === 1) return list[0]
  /* 多个账号且无法定位目标 → 不猜 */
  return null
}

/** CK 对象 -> 字符串（mhy.getHeaders 只认字符串） */
function ckStringOf(ck, uid = '') {
  if (typeof ck === 'string') return ck
  return pickCkItem(ck, uid)?.ck || ''
}

/** 复用 ZZZ-Plugin 缓存的设备指纹：它查面板前会自动 getFp 并写 Redis，不必手动绑定设备 */
async function enrichCkDevice(ck) {
  if (!ck || typeof redis === 'undefined') return ck
  for (const item of Object.values(ck)) {
    if (!item?.ltuid) continue
    try {
      if (!item.fp) item.fp = (await redis.get(`ZZZ:DEVICE_FP:${item.ltuid}:FP`)) || ''
      if (!item.device_id) item.device_id = (await redis.get(`ZZZ:DEVICE_FP:${item.ltuid}:ID`)) || ''
    } catch { /* Redis 不可用就退回本地 fp 文件 */ }
  }
  return ck
}

/** 读 ZZZ-Plugin 的设备配置；没有就退回它 defSet 里的同款默认值 */
function zzzDeviceInfo() {
  const files = [
    path.join(ZZZ_ROOT, 'config', 'device.yaml'),
    path.join(ZZZ_ROOT, 'defSet', 'device.yaml'),
  ]
  let cfg = {}
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    try { cfg = yaml.get(f) || {}; break } catch { cfg = {} }
  }
  return {
    productName: cfg.productName || 'XQ-BC52_EEA',
    modelName: cfg.modelName || 'XQ-BC52',
    osVersion: String(cfg.osVersion || '13'),
    board: cfg.board || 'lahaina',
    deviceInfo: cfg.deviceInfo || 'Sony/XQ-BC52_EEA/XQ-BC52:13/61.2.A.0.472A/061002A0000472A0046651803:user/release-keys',
  }
}

/** 自动 getFp：和 ZZZ-Plugin 一样由插件申请设备指纹，用户不需要手动绑定设备 */
async function fetchZzzDeviceFp(ck, uid = '') {
  const { productName, modelName, osVersion, board, deviceInfo } = zzzDeviceInfo()
  const uuid = crypto.randomUUID()
  const brand = deviceInfo.split('/')[0]
  const display = deviceInfo.split('/')[3] || ''
  const ext = {
    proxyStatus: 1, isRoot: 0, romCapacity: '768', deviceName: modelName, productName,
    romRemain: '727', hostname: 'BuildHost', screenSize: '1096x2434', isTablet: 0,
    aaid: uuid, model: modelName, brand, hardware: 'qcom', deviceType: modelName,
    devId: 'REL', serialNumber: 'unknown', sdCapacity: 224845, buildTime: '1692775759000',
    buildUser: 'BuildUser', simState: 1, ramRemain: '218344', appUpdateTimeDiff: 1740498108042,
    deviceInfo, vaid: uuid, buildType: 'user', sdkVersion: '33',
    ui_mode: 'UI_MODE_TYPE_NORMAL', isMockLocation: 0, cpuType: 'arm64-v8a', isAirMode: 0,
    ringMode: 2, chargeStatus: 1, manufacturer: brand, emulatorStatus: 0, appMemory: '768',
    osVersion, vendor: 'unknown', accelerometer: '-1.588236x6.8404818x6.999604',
    sdRemain: 218214, buildTags: 'release-keys', packageName: 'com.mihoyo.hyperion',
    networkType: 'WiFi', oaid: uuid, debugStatus: 1, ramCapacity: '224845',
    magnetometer: '-47.04375x51.3375x137.96251', display,
    appInstallTimeDiff: 1740498108042, packageVersion: '2.35.0',
    gyroscope: '-0.22601996x-0.09453133x0.09040799', batteryStatus: 88, hasKeyboard: 0, board,
  }
  /* device_id 用完整 UUID：截成 16 位会被判异常设备（sign.js 里同款问题），
     64 位 oaid 也是形态不对。这里与 bbs_device_id 用同一个值，
     保证 getFp 申请的指纹和后续请求头是同一对。 */
  const body = {
    app_name: 'bbs_cn',
    bbs_device_id: uuid,
    device_fp: '38d805c20d53d',
    device_id: uuid,
    ext_fields: JSON.stringify(ext),
    platform: '2',
    seed_id: uuid,
    seed_time: String(Date.now()),
  }
  try {
    const res = await mhyFetch('https://public-data-api.mihoyo.com/device-fp/api/getFp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 miHoYoBBS/2.73.1',
        Cookie: ckStringOf(ck, uid),
      },
      body: JSON.stringify(body),
    }).then(r => r.json())
    const fp = res?.data?.device_fp || ''
    if (!fp) logger.warn?.(`[HoYoGet][zzz_panel] getFp 失败：retcode=${res?.retcode} ${res?.message || ''}`)
    /* 必须回传「申请指纹时用的那个 device_id」：body 里是 'cc57c40f763ae4cc'，
       原来返回的是随机 uuid，请求头与指纹对不上，一样 10041。 */
    return { fp, device_id: body.device_id }
  } catch (err) {
    logger.warn?.(`[HoYoGet][zzz_panel] getFp 异常：${err?.message || err}`)
    return { fp: '', device_id: uuid }
  }
}

/** 设备指纹优先级：本地绑定文件 → CK 自带 → ZZZ-Plugin 的 Redis 缓存 → 自动 getFp */
async function resolveZzzDevice(e, ck, uid = '') {
  const ckItem = pickCkItem(ck, uid)
  const fpFile = `./plugins/HoYoGet-Plugin/data/fp/${e?.user_id}.yaml`
  let file = {}
  if (fs.existsSync(fpFile)) {
    try { file = yaml.get(fpFile) || {} } catch { file = {} }
  }
  let deviceId = file.device_id || ckItem?.device_id || ''
  let fp = file.fp || ckItem?.fp || ''
  const ltuid = ckItem?.ltuid
  if (!fp && ltuid && typeof redis !== 'undefined') {
    try {
      fp = (await redis.get(`ZZZ:DEVICE_FP:${ltuid}:FP`)) || ''
      deviceId = deviceId || (await redis.get(`ZZZ:DEVICE_FP:${ltuid}:ID`)) || ''
    } catch { /* Redis 不可用就继续自动申请 */ }
  }
  if (fp) return { fp, device_id: deviceId || crypto.randomUUID() }
  const got = await fetchZzzDeviceFp(ck, uid)
  if (got.fp && ltuid && typeof redis !== 'undefined') {
    try {
      await redis.set(`ZZZ:DEVICE_FP:${ltuid}:FP`, got.fp, { EX: 86400 * 7 })
      await redis.set(`ZZZ:DEVICE_FP:${ltuid}:ID`, got.device_id, { EX: 86400 * 7 })
    } catch { /* 缓存失败不影响本次请求 */ }
  }
  return got
}

/** 按 ZZZ-Plugin 的口径生成 record 接口请求头（4x salt + query 参与 DS） */
function zzzHeaders(e, ck, query = '', dev = null, uid = '') {
  const fpFile = `./plugins/HoYoGet-Plugin/data/fp/${e?.user_id}.yaml`
  let fp = {}
  if (fs.existsSync(fpFile)) {
    try { fp = yaml.get(fpFile) || {} } catch { fp = {} }
  }
  const ckItem = pickCkItem(ck, uid)
  if (!fp.device_id && ckItem?.device_id) fp.device_id = ckItem.device_id
  if (!fp.fp && ckItem?.fp) fp.fp = ckItem.fp
  if (dev?.device_id) fp.device_id = dev.device_id
  if (dev?.fp) fp.fp = dev.fp
  /* 绑定过设备时，UA / 系统版本 / 机型必须和指纹里编码的那台机器一致。
     指纹是照着 OPPO PJB110、Android 14 申请的，请求却自称 XQ-AT52、Android 12，
     米游社一样判 10041「设备指纹未通过」——设备号对上还不够。 */
  const info = fp.device_info && typeof fp.device_info === 'object' ? fp.device_info : null
  const devModel = String(info?.deviceModel || '')
  const devName = String(info?.deviceName || '')
  const devVer = String(info?.androidVersion || '12')
  const devBuild = String(info?.deviceFingerprint || '').split('/')[3] || '58.2.A.7.93'
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const salt = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
  const DS = crypto.createHash('md5').update(`salt=${salt}&t=${t}&r=${r}&b=&q=${query}`).digest('hex')
  const headers = {
    'x-rpc-app_version': '2.73.1',
    'x-rpc-sys_version': devVer,
    'x-rpc-client_type': '2',
    'x-rpc-channel': 'mihoyo',
    'User-Agent': devModel
      ? `Mozilla/5.0 (Linux; Android ${devVer}; ${devModel} Build/${devBuild}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1`
      : 'Mozilla/5.0 (Linux; Android 12; XQ-AT52 Build/58.2.A.7.93; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/2.73.1',
    Origin: 'https://act.mihoyo.com',
    'X-Requested-With': 'com.mihoyo.hyperion',
    Referer: 'https://act.mihoyo.com/',
    Accept: 'application/json, text/plain, */*',
    DS: `${t},${r},${DS}`,
    Cookie: ckStringOf(ck, uid),
  }
  // 设备信息只在用户绑定过设备时带；随便生成一个 device_id 反而更容易触发风控
  if (fp.device_id) headers['x-rpc-device_id'] = String(fp.device_id)
  if (fp.fp) headers['x-rpc-device_fp'] = fp.fp
  if (devModel) {
    headers['x-rpc-device_model'] = devModel
    if (devName) headers['x-rpc-device_name'] = devName
  }
  return headers
}

/** 本地全自动过码服务：返回 challenge 后带 x-rpc-challenge 重试原接口 */
async function zzzAutoVerify(e, ck, uid = '') {
  const addr = String(config()?.auto_verify_addr ?? 'http://127.0.0.1:2149/solve').trim()
  if (!addr) return ''
  const dev = await resolveZzzDevice(e, ck, uid)
  const deviceId = dev.device_id || mhy.getDeviceGuid()
  const deviceFp = dev.fp || ''
  try {
    const res = await fetch(addr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: ckStringOf(ck, uid), deviceId, deviceFp, clientType: '2', challengeGame: '8' }),
      signal: AbortSignal.timeout(360000),
    }).then(r => r.json())
    if (res?.data?.result === 'ok' && res.data.challenge) {
      logger.mark('[HoYoGet][zzz_panel] 本地服务自动过码成功')
      return res.data.challenge
    }
    logger.warn(`[HoYoGet][zzz_panel] 本地服务未过码：${JSON.stringify(res).slice(0, 160)}`)
  } catch (err) {
    logger.warn(`[HoYoGet][zzz_panel] 本地过码服务不可用：${err?.message || err}`)
  }
  return ''
}

/** 直接请求 ZZZ record 接口：返回 data，失败抛带 retcode/message 的错误，便于面板显示真实原因 */
async function zzzGet(e, uid, ck, type, query, extraHeaders = {}, retried = false) {
  /* 先确认能定位到目标 uid 对应的 CK：pickCkItem 在「多账号但对不上」时返回 null，
     这里必须报错而不是带着空 Cookie 去请求（那样只会拿到 10041 或被当成未登录）。 */
  if (!pickCkItem(ck, uid)) {
    throw new Error(
      `找不到 UID ${uid} 对应的米游社账号 CK`
      + `（该 QQ 绑定了多个账号，但没有任何一个记录到这个 UID）。`
      + `请重新绑定该账号或确认 UID 是否正确。`,
    )
  }
  const base = type === 'user'
    ? 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie'
    : type === 'index'
      ? 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/index'
      : type === 'challenge'
        ? 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/hadal_info_v2'
        : type === 'deadly'
          ? 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/hadal_mem_detail_v2'
          : type === 'info'
        ? 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/avatar/info'
        : 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz/avatar/basic'
  const url = `${base}?${query}`
  const dev = await resolveZzzDevice(e, ck, uid)
  const headers = { ...zzzHeaders(e, ck, query, dev, uid), ...extraHeaders }
  const resp = await mhyFetch(url, { method: 'GET', headers })
  const text = await resp.text()
  let json
  try { json = JSON.parse(text) } catch {
    throw new Error(`接口返回非 JSON（HTTP ${resp.status}，可能被风控拦截）`)
  }
  if (Number(json?.retcode) !== 0) {
    const code = Number(json?.retcode)
    // 10041 不是滑块验证码，是设备指纹风控：必须带绑定过的 device_id/device_fp 才能过
    if (code === 10041) {
      const fpFile = `./plugins/HoYoGet-Plugin/data/fp/${e?.user_id}.yaml`
      const bound = fs.existsSync(fpFile)
      // 把实际发出去的设备三件套 + 用的是哪个账号的 CK 一起打出来，
      // 多账号时能立刻看出是不是「拿 A 账号的 CK 查 B 账号的角色」
      const picked = pickCkItem(ck, uid)
      logger.mark(`[HoYoGet][zzz_panel] 10041 诊断：type=${type}`
        + ` device_id=${headers['x-rpc-device_id'] || '(无)'}`
        + ` fp=${String(headers['x-rpc-device_fp'] || '(无)').slice(0, 12)}…`
        + ` model=${headers['x-rpc-device_model'] || '(无)'}`
        + ` sys=${headers['x-rpc-sys_version']}`
        + ` ltuid=${picked?.ltuid || '(无)'}`
        + ` ck_uid=${picked?.uid || '(无)'}`
        + ` req_uid=${uid}`
        + ` ua=${headers['User-Agent']}`)
      throw new Error(bound
        ? '米游社风控（10041）：设备指纹未通过，请重新绑定常用设备后再试（#绑定设备帮助）'
        : '米游社风控（10041）：尚未绑定设备指纹。请先发 #米哈游开启设备绑定，再按 #绑定设备帮助 绑定常用设备')
    }
    if ([1034, 10035].includes(code)) {
      if (!retried) {
        const challenge = await zzzAutoVerify(e, ck, uid)
        if (challenge) {
          // 过码成功后立刻重打有时仍是验证码（风控还没放行），按梯度等一会儿再试
          let lastErr = null
          for (const gap of [0, 3000, 8000, 15000]) {
            if (gap) await new Promise(r => setTimeout(r, gap))
            try {
              return await zzzGet(e, uid, ck, type, query, { ...extraHeaders, 'x-rpc-challenge': challenge, 'x-rpc-challenge_game': '8' }, true)
            } catch (err) {
              lastErr = err
              if (!/验证码|风控/.test(String(err?.message || err))) throw err
            }
          }
          if (lastErr) throw lastErr
        }
      }
      throw new Error(`米游社验证码（${code}），自动过码未通过，请稍后重试或手动完成验证`)
    }
    /* CK 过期：先试着自己用 Stoken 换一张新票再重试一次，
       换不出来才让用户重新扫码。retried 参数避免无限递归。 */
    if ([-100, -101, -111, 10001].includes(code) && !retried) {
      const fresh = await refreshCkByStoken(e?.user_id, uid)
      /* refreshCkByStoken 返回的是裸 CK 字符串，但 zzzGet 全程按「CK 对象表」处理
         （pickCkItem / ckStringOf 都要 { key: {ck, uid, ltuid} }），
         这里必须包成同样形状，否则下一轮会报「找不到 UID 对应的 CK」。 */
      if (fresh) {
        const freshTable = {
          default: {
            ck: fresh,
            uid: String(uid),
            ltuid: (String(fresh).match(/ltuid=(\d+)/) || [])[1]
              || (String(fresh).match(/stuid=(\d+)/) || [])[1] || '',
          },
        }
        return await zzzGet(e, uid, freshTable, type, query, extraHeaders, true)
      }
    }
    if ([-100, -101, -111, 10001].includes(code)) throw new Error(`CK 失效或未登录（${code}），请刷新 CK / 重新扫码`)
    throw new Error(`接口返回 ${code}：${json?.message || '未知错误'}`)
  }
  return json.data
}

/** 从本插件 Stoken 里找 ZZZ 条目：优先当前 UID，其次 nap_cn 条目，最后第一条带 ck 的 */
/**
 * 用 Stoken 换新的 cookie_token。
 *
 * 米游社的凭据分两种：stoken 长期有效、cookie_token 短期（约 1 天）过期。
 * 所以 CK 报 -100 时，只要本机还留着 stoken，就能把 cookie_token 重新换出来，
 * 不必让用户重新扫码。
 *
 * 返回新 CK 字符串；没有 stoken 或换取失败时返回 null。
 */
async function refreshCkByStoken(qq, uid = '') {
  const hit = findZzzStokenEntry(qq, uid)
  if (!hit) return null
  const entry = hit[1] || {}
  const raw = String(entry.ck_stoken || '')
  const stoken = (raw.match(/stoken=([^;]+)/) || [])[1]
  const stuid = (raw.match(/stuid=(\d+)/) || [])[1] || String(entry.stuid || '')
  if (!stoken || !stuid) return null
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0', Cookie: raw }
    const [cookieRes, ltokenRes] = await Promise.all([
      mhyFetch(`https://api-takumi.mihoyo.com/auth/api/getCookieAccountInfoBySToken?stoken=${encodeURIComponent(stoken)}&uid=${encodeURIComponent(stuid)}`, { headers }).then(r => r.json()),
      mhyFetch('https://passport-api.mihoyo.com/account/auth/api/getLTokenBySToken', { headers }).then(r => r.json()).catch(() => ({})),
    ])
    const cookieToken = cookieRes?.data?.cookie_token
    if (!cookieToken) return null
    const ltoken = ltokenRes?.data?.ltoken || entry.ltoken || ''
    const ck = ltoken
      ? `ltoken=${ltoken};ltuid=${stuid};cookie_token=${cookieToken};account_id=${stuid};`
      : `stuid=${stuid};stoken=${stoken};cookie_token=${cookieToken};account_id=${stuid};`
    /* 回写 MysUsers，下次就不用再换一次 */
    try {
      const sqlite3 = (await import('sqlite3')).default
      const db = new sqlite3.Database(YUNZAI_DB)
      await new Promise((resolve, reject) => {
        db.run('update MysUsers set ck = ?, updatedAt = datetime(\'now\') where ltuid = ?', [ck, String(stuid)], err => (err ? reject(err) : resolve()))
      })
      db.close(() => {})
    } catch (_) { /* 回写失败不影响本次使用 */ }
    logger.mark?.(`[HoYoGet][zzz_panel] 已用 Stoken 刷新 CK（ltuid=${stuid}）`)
    return ck
  } catch (err) {
    logger.debug?.(`[HoYoGet][zzz_panel] Stoken 刷新失败：${err?.message || err}`)
    return null
  }
}

function findZzzStokenEntry(qq, uid = '') {
  const file = `./plugins/HoYoGet-Plugin/data/Stoken/${qq}.yaml`
  if (!fs.existsSync(file)) return null
  try {
    const data = yaml.get(file) || {}
    if (uid && data[uid]?.ck_stoken) return [String(uid), data[uid]]
    const entries = Object.entries(data).filter(([, v]) => v?.ck_stoken)
    return entries.find(([, v]) => String(v?.game_biz || '').includes('nap'))
      || entries.find(([, v]) => /prod_|cn_/.test(String(v?.region || '')))
      || entries[0]
      || null
  } catch {
    return null
  }
}

// 详情长图用 deviceScaleFactor 代替 CSS zoom（见 system/render.js 注释）：
// 2.4 与原先 zoom 的像素密度一致，输出仍为 1400 x 2.4 = 3360 宽。
const ZZZ_PANEL_DSF = 3.2

/** 面板风格：dark（默认暗色霓虹）/ apple（深色玻璃，见 detail-apple.css） */
function panelAppleStyle() {
  try { return String(config()?.panel_style || 'dark').trim().toLowerCase() === 'apple' } catch { return false }
}



const SKILL_NAME = { 0: '普攻', 1: '特殊技', 2: '闪避', 3: '连携技', 5: '核心技', 6: '支援技' }
// 技能展示顺序（贴近米游社面板）：普攻/闪避/特殊技/支援技/连携/核心
const SKILL_ORDER = [0, 2, 1, 6, 3, 5]
// 技能等级上限：核心被动为 7，其余为 12（产品形态，非数值表）
const SKILL_MAX = { 0: 12, 1: 12, 2: 12, 3: 12, 5: 7, 6: 12 }
const RATING_MAP = { ER_SS: 'SS', ER_S_Plus: 'S+', ER_S: 'S', ER_A_Plus: 'A+', ER_A: 'A', ER_B_Plus: 'B+', ER_B: 'B', ER_C: 'C' }

/** 剥离米游社富文本标签（<color=...>、</color>、<IconMap:...>）并压平换行，纯展示用 */
function stripTags(s) {
  return String(s || '')
    .replace(/<color=[^>]*>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<IconMap:[^>]*>/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 百分比字符串 → 小数（"9.8%"→0.098；无数值→0） */
function toRatio(v) {
  const n = parseFloat(v)
  if (isNaN(n)) return 0
  return String(v).includes('%') ? n / 100 : n
}
/** 纯数值字符串 → 数字（无数值→0） */
function toNum(v) {
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

/**
 * 伤害乘区（按公开公式实现：暴击 / 增伤 / 易伤 / 抗性 / 防御）。
 * 敌方面板默认：level=角色等级、1级基础防御力=50（敌防=等级基数）、抗性=-0.2（有弱点）。
 * 仅计算与技能无关的乘区；基础区=技能倍率×攻击力，倍率需角色数据（米游社接口不返回），故不展示。
 */
const hasSetBoost = extra => !!(extra?.applied || []).some(x => x.src === '套装' && x.type === '增伤')

function calcDamageAreas(bp, level, extra = {}) {
  const crit = Math.min(1, toRatio(bp.crit?.final) + (extra.critRateAdd || 0))
  const critdmg = Math.min(5, toRatio(bp.critdam?.final) + (extra.critdmgAdd || 0))
  const lv = level && level > 0 ? level : 1
  const getBase = l => Math.floor(0.1551 * Math.min(60, l) ** 2 + 3.141 * Math.min(60, l) + 47.2039)
  const base = getBase(lv)
  const DEF = (50 / 50) * getBase(lv)
  const penRatio = Math.min(2, toRatio(bp.penratio?.final) + (extra.penRatioAdd || 0))
  const pen = toNum(bp.penvalue?.final) + (extra.penValueAdd || 0)
  // 无视防御与穿透率分属两个乘数：DEF × (1-无视防御) × (1-穿透率) - 穿透值
  const defIgnore = Math.min(1, extra.defIgnoreAdd || 0)
  const effectiveDef = Math.max(0, DEF * (1 - defIgnore) * (1 - penRatio) - pen)
  return {
    critical: 1 + crit * critdmg,
    crit,
    critdmg,
    // 增伤区 = 1 + Σ 增益增伤（音擎主动 + 套装被动 + 额外能力 + 影画）
    //
    // 面板自带的 dmgbonus（属性伤害加成）**不能再乘一次**：绝区零的属性伤害加成
    // 只由驱动盘套装被动提供，它就是 sets 里 check:2/4 的那几条，重复计入会翻倍。
    // 所以只在「没有套装增伤被计入」时才用面板值兜底（例如套装数据未收录时）。
    // 同理 crit/critdmg/penratio/penvalue 里的增益项：音擎的暴击率与暴伤是常驻被动，
    // 接口给出的 final 已含（实测 final 的 add 项为 +0.0%），但核心被动的暴伤是
    // 按技能等级激活的、面板不含，所以核心被动的暴伤要额外计入。
    boost: hasSetBoost(extra)
      ? (extra.boost || 1)
      : (toRatio(bp.dmgbonus?.final) + (extra.boost || 1)),
    vulnerability: extra.vulnerability || 1,
    /* 失衡易伤：打失衡目标时游戏内是 ×1.5（部分角色/条件 ×2）。
       默认按 1.5 计入 —— 目标是让数字贴近玩家在游戏里看到的值。
       静态面板（工坊 properties）不含这一乘区，所以它会让「面板 × 倍率」
       与最终伤害相差 1.5 倍，这是口径差不是算错；
       需要纯静态对比时传 stunVulnerability: 1 关掉。 */
    stun: Math.max(1, Number(extra.stunVulnerability ?? 1.5)),
    // 抗性区 = 1 - (敌人抗性 - 无视抗性)；默认敌人抗性 -0.2（有弱点）
    resistance: 1 - (-0.2 - (extra.resIgnoreAdd || 0)),
    defence: Math.min(1, Math.max(0, base / (effectiveDef + base))),
  }
}

/**
 * 逐技能伤害。
 *
 * 公式（绝区零）：
 *   基础区 = 技能倍率(该技能等级) × 面板攻击力
 *   期望伤害 = 基础区 × 暴击区 × 增伤区 × 易伤区 × 抗性区 × 防御区
 *   暴击伤害 = 基础区 × (1+暴伤) × 增伤区 × 易伤区 × 抗性区 × 防御区
 * 其中暴击区 = 1 + 暴击率×暴伤（期望），暴击伤害那列不含暴击率。
 *
 * 技能等级不能一律取满级：倍率表按级给出，且接口里每个技能组等级不同
 * （普攻常 12、闪避 8），所以按接口实际等级逐个代入。
 * 接口与倍率表靠**技能中文名**对齐（两边都形如「连携技：星落间章」）。
 */
// 接口与倍率表的前缀用词不一致（接口「普通攻击/强化特殊技」，表里「普攻/强E」），
// 只比核心技能名会撞车（普攻与强化普攻同名），所以「类别 + 核心名」一起匹配。
const SKILL_PREFIX_RE = /^(普通攻击|强化普攻|蓄力普攻|蓄力攻击|普攻|强化特殊技|特殊技|强E|闪避反击|冲刺攻击|闪避|连携技|终结技|核心被动|额外能力|快速支援|招架支援|支援突击|支援)\s*[：:]\s*/
const skillCore = (s) => String(s || '')
  .replace(SKILL_PREFIX_RE, '')
  .replace(/[\s·・（）()【】「」\[\]［］]/g, '')
  .toLowerCase()
function skillCat(text) {
  const t = String(text || '')
  if (/终结技/.test(t)) return 'RZ'
  if (/连携技/.test(t)) return 'RL'
  if (/强化特殊技|强E/.test(t)) return 'EQ'
  if (/特殊技/.test(t)) return 'E'
  if (/强化普攻/.test(t)) return 'AQ'
  if (/蓄力普攻|蓄力攻击|蓄力/.test(t)) return 'AX'
  if (/普通攻击|普攻/.test(t)) return 'AP'
  if (/闪避反击/.test(t)) return 'CF'
  if (/冲刺攻击/.test(t)) return 'CA'
  if (/闪避/.test(t)) return 'C'
  if (/核心被动|额外能力/.test(t)) return 'T'
  if (/快速支援|招架支援|支援突击|支援/.test(t)) return 'L'
  return ''
}
/**
 * 把一个技能的乘区拆成「计算过程」，供「XX伤害N」指令的详细计算页展示。
 *
 * 只给构成、不重新算一遍 —— 数值仍来自 calcDamageAreas，保证详细页与面板上的
 * 数字永远一致（同一公式写两遍迟早会对不上）。
 */
function buildCalcDetail(bp, level, one) {
  const r = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
  const a = one.areas
  const lv = level && level > 0 ? level : 1
  const enemyBase = Math.floor(0.1551 * Math.min(60, lv) ** 2 + 3.141 * Math.min(60, lv) + 47.2039)
  const atk = parseFloat(bp?.attack?.final) || 0
  const critRate = r(a.crit, 4)
  const critdmg = r(a.critdmg, 4)
  const penRatio = r(Math.min(2, toRatio(bp.penratio?.final) + (one.buff?.penRatioAdd || 0)), 4)
  const penValue = r(toNum(bp.penvalue?.final) + (one.buff?.penValueAdd || 0), 2)
  const defIgnore = r(Math.min(1, one.buff?.defIgnoreAdd || 0), 4)
  const resIgnore = r(one.buff?.resIgnoreAdd || 0, 4)
  // 与 calcDamageAreas 保持同一公式：先扣无视防御，再扣穿透率，最后减穿透值
  const effDef = Math.max(0, enemyBase * (1 - defIgnore) * (1 - penRatio) - penValue)
  return {
    atk,
    // 必须用 baseTotal（含多段追加），否则「等效倍率 × 攻击力」与基础区对不上
    rate: r(one.baseTotal / (atk || 1), 3),
    base: Math.round(one.baseTotal),
    critRate,
    critdmg,
    critArea: r(a.critical, 3),
    critFormula: `1 + ${critRate} × ${critdmg}`,
    boost: r(a.boost, 3),
    vulnerability: r(a.vulnerability, 3),
    resistance: r(a.resistance, 3),
    resFormula: resIgnore ? `1 − (−0.2 − ${resIgnore})` : '1 − (−0.2)',
    resIgnore,
    enemyBase,
    penRatio,
    penValue,
    defIgnore,
    effDef: Math.round(effDef),
    defArea: r(a.defence, 4),
    defFormula: `${enemyBase} ÷ (${Math.round(effDef)} + ${enemyBase})`,
    expect: Math.round(one.expect),
    crit: Math.round(one.crit),
  }
}

/**
 * 从接口原始角色数据拼出增益查询上下文。
 * 注意各字段的口径：weapon.star 是**精炼**（1~5），rarity 才是稀有度；
 * 影画数是 avatar.rank；驱动盘套装名在 equip[].equip_suit.name（同名多件即为件数）。
 */
function buildBuffContext(avatar, charName) {
  const w = avatar?.weapon || {}
  return {
    charName,
    charFull: avatar?.full_name_mi18n || '',
    element: ZELEM_STR[avatar?.element_type] || '',
    weapon: w?.name || '',
    refine: Number(w?.star) || 0,
    suits: (avatar?.equip || []).map(d => d?.equip_suit?.name).filter(Boolean),
    rank: Number.isFinite(Number(avatar?.rank)) ? Number(avatar.rank) : undefined,
    // 核心被动的档位值按「核心技等级」代入
    tLevel: Number(avatar?.skills?.find(s => Number(s?.skill_type) === 5)?.level) || 1,
  }
}

/**
 * 接口 properties[] → 伤害计算用的 basic_properties（按字段键索引）。
 * 伤害加成单独挂在 dmgbonus 下，方便模板取到具体元素名。
 * 面板详情与面板排名共用这一份，避免两处口径漂移。
 */
export function buildBasicProperties(a) {
  const basic_properties = {}
  for (const p of (a?.properties || [])) {
    const m = ZPROP[p.property_id]
    if (!m || m.k === 'dmgbonus') continue
    const base = p.base || ''
    const add = (p.add !== undefined && p.add !== '' && p.add !== '0') ? p.add : ''
    const final = (p.final !== undefined && p.final !== '') ? p.final : (base || '')
    basic_properties[m.k] = { base, add, final }
  }
  const dmg = (a?.properties || []).find(p => (ZPROP[p.property_id] || {}).k === 'dmgbonus')
  if (dmg) {
    const base = dmg.base || ''
    const add = (dmg.add !== undefined && dmg.add !== '' && dmg.add !== '0') ? dmg.add : ''
    const final = (dmg.final !== undefined && dmg.final !== '') ? dmg.final : (base || '')
    basic_properties.dmgbonus = { property_name: dmg.property_name || '伤害加成', property_id: dmg.property_id, base, add, final }
  }
  return basic_properties
}

export function calcDamage(bp, level, avatar, charName) {
  const atk = parseFloat(bp?.attack?.final) || 0
  if (!atk) return { ok: false, error: '面板攻击力为 0，无法计算' }

  const rates = damageSkillsAt(charName, 16)
  if (!rates.ok) return { ok: false, error: rates.error }

  // 增益乘区（音擎/套装/核心被动/额外能力/影画）与技能有关：range 按技能代号过滤，
  // 所以每个技能单独取一次，见下方循环。
  const buffBase = buildBuffContext(avatar, charName)
  const table = new Map()
  for (const s of rates.skills) {
    if (!s.name || s.isHide) continue
    // 以「名字里的类别」为准，而不是 key 前缀：个别角色的 key 与名字类别不一致
    //（如 AXP 对应的名字是「普攻：…」），按 key 分会漏配接口技能。
    // 隐藏子段不参与主技能匹配：它只应通过 ops.add 并入主段，否则同名时会顶掉主段。
    table.set(`${skillCat(s.name)}|${skillCore(s.name)}`, s)
  }

  // 技能键 → 倍率条目（含多段组合 ops），用于按 key 追加子段伤害
  const byKey = new Map(rates.skills.map(x => [x.key, x]))

  /**
   * 单个技能键的完整伤害。
   *
   * 多段技能（ops）按源表的 after 语义处理：
   *   {op:'add',key}  这一招的伤害**加上** key 那一招的完整伤害，
   *                    子段有自己的倍率**和自己的乘区**（子段的 range 可能落在
   *                    别的增益生效范围内，所以不能拿主段的增伤区去套）
   *   {op:'x',n}      整条伤害乘 n
   * 子段取自己的技能等级：按子段键的首字母反查技能类别
   * （A普攻 E特殊技 C闪避 R连携 T核心 L支援），等级从接口 skills[] 里取。
   */
  const typeOfBase = { A: 0, E: 1, C: 2, R: 3, T: 5, L: 6 }
  const levelOfType = {}
  for (const sk of avatar?.skills || []) levelOfType[Number(sk.skill_type)] = Number(sk.level) || 1
  const rateAt = (entry, lv) => {
    const idx = Math.max(1, Math.min(lv, entry.rates?.length || 16)) - 1
    return Number(entry.rates?.[idx])
  }
  const seen = new Set()
  const one = (key, depth = 0) => {
    const entry = byKey.get(key)
    if (!entry || depth > 3) return null
    // 子段可能被多个主段引用，缓存避免重复展开（并防止自引用死循环）
    if (seen.has(key)) return null
    seen.add(key)
    const lv = levelOfType[typeOfBase[String(key)[0].toUpperCase()]] || 1
    const rate = rateAt(entry, lv)
    if (!Number.isFinite(rate) || rate <= 0) {
      // 提前返回也要把 key 从 seen 里移除，否则后续同键子段会被误判成循环引用
      seen.delete(key)
      return null
    }
    const buff = getBuffAreas({ ...buffBase, key, dynLevel: buffBase.tLevel })
    const areas = calcDamageAreas(bp, level, buff)
    const base = rate * atk
    const mul = areas.boost * areas.vulnerability * areas.resistance * areas.defence * (areas.stun || 1)
    // 期望列含暴击率（期望值），暴击列不含 —— 两列口径不同，别混用
    let expect = base * areas.critical * mul
    let crit = base * (1 + areas.critdmg) * mul
    const adds = []
    const parts = [{ key, name: entry.name, rate, base, expect, crit, areas, buff, dyn: depth > 0 }]
    let baseTotal = base
    for (const op of entry.ops || []) {
      if (op.op === 'add') {
        /* ops.add 有两种语义，必须分辨，不能一刀切：
           ① 累计型（19 处）：本段 rates 已包含前置段，如星见雅
              AX3(50.616) ⊇ AX2(20.296) ⊇ AX1(10.757)。再加就重复。
           ② 拼接型（6 处）：本段 rates 只是自身，如简 AX(3.818) + AX0(7.118)。
              必须把子段加进来。
           判据：rates 不小于子段 rates → 累计型（跳过叠加）；否则拼接型（叠加）。 */
        const sub = one(op.key, depth + 1)
        if (!sub) continue
        const isCumulative = rate >= (sub.rate || 0)
        if (!isCumulative) {
          expect += sub.expect
          crit += sub.crit
          baseTotal += sub.baseTotal
        }
        adds.push(op.key)
        parts.push(...sub.parts)
      } else if (op.op === 'x' && Number.isFinite(op.n)) {
        expect *= op.n
        crit *= op.n
        // 总倍率也要跟着乘，否则多段技能的「等效倍率」会少算 x 系数
        baseTotal *= op.n
        // 已经生成的段也要同步乘，否则「分段拆解」各段之和与总伤害对不上
        for (const p of parts) {
          p.rate *= op.n
          p.base *= op.n
          p.expect *= op.n
          p.crit *= op.n
        }
      }
    }
    seen.delete(key)
    return { key, name: entry.name, rate, base, baseTotal, areas, buff, expect, crit, adds, parts }
  }

  // 接口 skills[]：skill_type 0普攻 1特殊技 2闪避 3连携 5核心 6支援
  // 接口 skills[].items 只在米游社详情接口有；ZZZ-Plugin 的缓存面板 items 是空数组。
  // 那种情况下按 skill_type 从倍率表里挑一个代表招式（同类别取倍率最高的非隐藏段），
  // 保证「别人的面板」也能算出伤害，而不是整行显示「-」。
  const CAT_OF_TYPE = { 0: ['AP', 'AQ', 'AX'], 1: ['EQ', 'E'], 2: ['C', 'CF', 'CA'], 3: ['RL', 'RZ'], 5: ['T'], 6: ['L'] }
  const bestOfType = (type) => {
    const cats = CAT_OF_TYPE[type]
    if (!cats) return null
    let best = null
    for (const s of rates.skills) {
      if (s.isHide || !cats.includes(skillCat(s.name))) continue
      if (!best || (s.rate || 0) > (best.rate || 0)) best = s
    }
    return best
  }

  const out = []
  for (const sk of avatar?.skills || []) {
    const skLv = Number(sk.level) || 1
    const items = (sk.items || []).filter(v => String(v?.title || '').trim())
    const fallback = items.length ? null : bestOfType(Number(sk.skill_type))
    for (const item of items.length ? items : (fallback ? [{ title: fallback.name }] : [])) {
      const title = String(item?.title || '').trim()
      if (!title) continue
      const hit = fallback || table.get(`${skillCat(title)}|${skillCore(title)}`)
      if (!hit) continue                      // 倍率表没有这个技能（如新角色未收录）
      if (hit.isHide) continue                // 隐藏子段（如回旋斩击）只作为主段的一部分，不单列
      const one1 = one(hit.key)
      if (!one1) continue
      out.push({
        name: title,
        skillType: Number(sk.skill_type),
        key: hit.key,
        level: skLv,
        rate: one1.rate,
        // 展示用的「等效倍率」= 这一招实际打出的总倍率（含追加段），否则
        // 多段技能只显示首段倍率会让人以为算错了
        totalRate: Math.round((one1.baseTotal / atk) * 1000) / 1000,
        base: Math.round(one1.baseTotal),
        boost: Math.round(one1.areas.boost * 1000) / 1000,
        expect: Math.round(one1.expect),
        crit: Math.round(one1.crit),
        adds: one1.adds,
        // 分段明细：多段技能要能看清「每一段各打多少、各自套了什么乘区」
        parts: one1.parts.map(pp => ({
          name: pp.name || pp.key,
          key: pp.key,
          dyn: !!pp.dyn,
          rate: Math.round(pp.rate * 1000) / 1000,
          base: Math.round(pp.base),
          expect: Math.round(pp.expect),
          crit: Math.round(pp.crit),
          boost: Math.round(pp.areas.boost * 1000) / 1000,
          critArea: Math.round(pp.areas.critical * 1000) / 1000,
          defArea: Math.round(pp.areas.defence * 10000) / 10000,
        })),
        // 计算过程用：把每个乘区连同它的构成一起给出，模板才能「算出数字」而不只是显示数字
        calc: buildCalcDetail(bp, level, one1),
        // 这一招实际生效的增益（含来源），详细计算页要按招展示 —— 不同招吃到的增益不一样
        buffList: one1.buff.applied.map(x => ({
          src: x.src,
          name: x.name,
          type: x.type,
          value: `${Math.round(x.value * 1000) / 10}%`,
        })),
        buffNames: one1.buff.applied.map(x => x.name),
        buffMiss: one1.buff.missing,
      })
    }
  }
  if (!out.length) return { ok: false, error: '接口技能与倍率表没有交集（该角色可能未收录倍率）' }

  // 按总伤害降序：面板上最痛的招式排前面；顶部乘区也要取这个技能，不能取接口顺序第一个
  out.sort((a, b) => (b.expect - a.expect))
  const topBuff = getBuffAreas({ ...buffBase, key: out[0].key, dynLevel: buffBase.tLevel })
  const areas = calcDamageAreas(bp, level, topBuff)
  const critdmg = areas.critdmg
  const r2 = (v) => Math.round(v * 1000) / 1000
  const buffRows = topBuff.applied.map(x => ({ src: x.src, name: x.name, type: x.type, value: `${r2(x.value * 100)}%` }))
  const buffMiss = [...new Set(out.flatMap(x => x.buffMiss || []))]
  return {
    ok: true,
    atk,
    areas,
    critdmg,
    buffRows,
    buffMiss,
    // 口径说明：写进面板，免得看到数字却不知道它算的是什么
    notes: [
      '期望＝1+暴击率×暴伤 的期望值；暴击列按必暴击计，不含暴击率。',
      '敌方面板按角色等级、1级基础防御50、抗性-0.2（有弱点）估算；已计失衡易伤 ×1.5。',
      '增伤区只计音擎、套装、核心被动、额外能力、影画；技能自身倍率型增伤（如对某目标增伤50%）未计。',
      '等效倍率含多段追加（如蓄力攻击＝蓄力段＋回旋斩击）；各段按各自技能等级代入，并分别套用各自生效的增益。',
      buffMiss.length ? `未收录：${buffMiss.join('、')}` : '',
    ].filter(Boolean),
    skills: out,
    top: out[0],
    areasTxt: `暴击${r2(areas.critical)} 增伤${r2(areas.boost)} 易伤${r2(areas.vulnerability)}`
      + `${(areas.stun || 1) !== 1 ? ` 失衡${r2(areas.stun)}` : ''}`
      + ` 抗性${r2(areas.resistance)} 防御${r2(areas.defence)}（取倍率最高一招）`,
  }
}

// 咕咕牛的面板图在 ZZZ-Plugin/resources/images/panel；本插件自己的自定义图作为第二来源
const CUSTOM_PORTRAIT_DIRS = [
  path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel'),
  './plugins/HoYoGet-Plugin/resources/zzz_panel/images/panel',
]

/* ───────────────────────── 极限面板：合成底稿（不依赖任何面板记录） ─────────────────────────
 *
 * 极限面板的定义是「理论最优」，它不该取决于「这个人抽没抽到这个角色」。
 * 所以这里完全用本地静态表凭空造一个满级角色：
 *   基础属性  ← system/default/zzz_char_stat.json（真实采集的 Lv60 基础值）
 *   音擎/套装 ← system/default/zzz_item_stat.json（音擎与套装公开事实）
 *   技能明细 ← system/default/zzz_skill_rate.json（技能中文名 + 各等级倍率）
 *   配装     ← system/default/zzz_extreme.yaml（逐角色策展的音擎/主词条/副词条布局）
 *
 * 为什么基础属性是「采集」而不是「算」：官方成长公式里攻击力那一项复刻不出来
 * （回归 54 个角色真实值，隐含系数在 1.0e-2~2.25e-2 离散，且与职司/突破/影数不相关），
 * 所以宁可存事实也不猜公式。详见 tools/extract_zzz_char_stat.mjs 的注释。
 */

/**
 * 练度分：与 ZZZ-Plugin 的 proficiency_score 同口径。
 *   base = 稀有度分（S=5 / A=4 / B=3）
 *   score = 驱动盘总分×2
 *         + Σ(技能等级 × base)
 *         + 角色等级×2
 *         + 影画 × base × 2
 *         + 音擎等级×2 + 精炼 × 2 × 音擎 base
 * 单列出来是为了「%练度」和排名页能用同一套算法，不各写一份。
 */
function calcProficiency(a, equipScore) {
  const base = a?.rarity === 'S' ? 5 : a?.rarity === 'A' ? 4 : 3
  let score = (Number(equipScore) || 0) * 2
  for (const sk of a?.skills || []) score += (Number(sk.level) || 0) * base
  score += (Number(a?.level) || 0) * 2
  score += (Number(a?.rank) || 0) * base * 2
  const w = a?.weapon
  if (w) {
    const wBase = w.rarity === 'S' ? 5 : w.rarity === 'A' ? 4 : 3
    score += (Number(w.level) || 0) * 2
    score += (Number(w.star) || 0) * 2 * wBase
  }
  return Math.round(score * 10) / 10
}

/** 4 件套按角色属性选、2 件套按职业选的兜底规则；预设里写了 set_id / set2_id 就用预设的 */
const EXTREME_SET_4PC = { 200: 32600, 201: 32200, 202: 32500, 203: 32400, 204: 33900, 205: 34000, 300: 32500 }
const EXTREME_SET_2PC_BY_PROF = { 1: 32700, 2: 33200, 3: 31300, 4: 33400, 5: 33100, 6: 33100, 7: 32700 }

let CHAR_STAT = null
let ITEM_STAT = null
const loadJsonCached = (file, slot) => {
  const box = slot === 'char' ? 'CHAR_STAT' : 'ITEM_STAT'
  if (box === 'CHAR_STAT' && CHAR_STAT) return CHAR_STAT
  if (box === 'ITEM_STAT' && ITEM_STAT) return ITEM_STAT
  let data = null
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { data = null }
  if (box === 'CHAR_STAT') CHAR_STAT = data
  else ITEM_STAT = data
  return data
}
const charStatTable = () => loadJsonCached(path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_char_stat.json'), 'char')
const itemStatTable = () => loadJsonCached(path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_item_stat.json'), 'item')

/** ZZZ-Plugin 本地图标目录（音擎/套装/立绘的图本体在那儿，未安装则返回 ''） */
const zzzAssetDir = kind => {
  for (const root of [path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'), path.join(PLUGIN_ROOT, '..', 'ZZZ-Plugin')]) {
    const dir = path.join(root, 'resources', 'images', kind)
    if (fs.existsSync(dir)) return dir
  }
  return ''
}
const zzzAssetDataUri = (kind, file) => {
  if (!file) return ''
  const dir = zzzAssetDir(kind)
  if (!dir) return ''
  for (const ext of ['.png', '.webp', '.jpg']) {
    const full = path.join(dir, file + ext)
    if (!fs.existsSync(full)) continue
    try {
      const buf = fs.readFileSync(full)
      const mime = ext === '.jpg' ? 'jpeg' : ext.slice(1)
      return `data:image/${mime};base64,${buf.toString('base64')}`
    } catch { return '' }
  }
  return ''
}

// 音擎满级副词条上限（与 applyExtremePanel 里的 WEAPON_SUB_MAX 同一份口径）
const WQ_SUB_MAX = { 111: [1, 0.3], 11102: [1, 0.3], 121: [2, 0.3], 12102: [2, 0.3], 131: [3, 0.48], 13102: [3, 0.48], 201: [5, 24], 20103: [5, 24], 211: [6, 48], 21103: [6, 48], 231: [9, 24], 23103: [9, 24] }

/**
 * 合成一个「满级 6 命」的极限底稿。返回 {ok, avatar} 或 {ok:false, error}。
 *
 * 关键点：properties 的 final 只放「Lv60 基础属性 + 满精音擎的主副词条」，
 * 驱动盘**一件都不放**（before=0），让 applyExtremePanel 去算「盘内增量」——
 * 这样 delta 语义和「拿真实记录改装备」时完全一致，两条路径不会分叉。
 */
function buildExtremeBase(role, preset) {
  const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()
  const want = norm(role)

  const statTable = charStatTable()
  const itemTable = itemStatTable()
  if (!statTable) return { ok: false, error: '缺少 system/default/zzz_char_stat.json（角色基础属性表）' }
  if (!itemTable) return { ok: false, error: '缺少 system/default/zzz_item_stat.json（音擎与套装表）' }

  const statKey = Object.keys(statTable.chars || {}).find(k => norm(k) === want)
  if (!statKey) {
    return { ok: false, error: `基础属性表里没有「${role}」（该角色的 Lv60 基础值尚未采集，见 tools/extract_zzz_char_stat.mjs）` }
  }
  const st = statTable.chars[statKey]

  const wq = itemTable.weapons?.[String(preset.weapon_id)]
  if (!wq) return { ok: false, error: `音擎表里没有 id=${preset.weapon_id}` }

  // 4+2 套装：预设优先，否则按属性/职业兜底
  const suit4 = String(preset.set_id || EXTREME_SET_4PC[st.elementType] || 32500)
  const suit2 = String(preset.set2_id || EXTREME_SET_2PC_BY_PROF[st.profession] || 32700)
  const suit4Info = itemTable.suits?.[suit4]
  const suit2Info = itemTable.suits?.[suit2]

  /* 面板属性：Lv60 基础值 + 满精音擎主副词条（驱动盘留空，交给 applyExtremePanel 算增量）。
     读的是 base（角色裸值，不含音擎与驱动盘）——下面会单独加音擎主词条，
     若这里读含专武的 legacy 就会重复计算。 */
  const props = {}
  const pidMap = {
    1: st.base?.hp, 2: st.base?.atk, 3: st.base?.def, 4: st.base?.impact,
    5: st.base?.crit, 6: st.base?.critDmg, 7: st.base?.anomalyMastery,
    8: st.base?.anomalyProficiency, 9: st.base?.penRatio, 11: st.base?.energyRegen,
  }
  for (const pid of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]) {
    const v = pidMap[pid]
    if (typeof v === 'number') props[pid] = v
  }
  if (!props[1] || !props[2]) return { ok: false, error: `「${role}」的基础属性不完整` }
  // 音擎副词条按满精上限计入终值（之后 applyExtremePanel 的 weaponSubDelta 就是 0，不会重复加）
  const subMax = WQ_SUB_MAX[wq.sub?.pid]
  if (subMax && wq.sub?.value) {
    const [pid] = subMax
    const subVal = [20103, 21103, 23203, 23103].includes(wq.sub.pid) ? wq.sub.value / 40
      : [11102, 12102, 13102].includes(wq.sub.pid) ? wq.sub.value / 4000
      : wq.sub.value / 100
    if (typeof subVal === 'number' && subVal > 1) props[pid] = (props[pid] || 0) + subVal
    else if (typeof subVal === 'number' && props[pid] != null) props[pid] = props[pid] * (1 + subVal)
  }
  // 音擎主词条若是基础攻击/防御/生命，会直接进面板终值（用满级值）
  // 满级基础攻击力 = Lv1 value × factor（S 级各档已验证）
  const WQ_ATK_MAX = { S_40: 594, S_46: 684, S_48: 713, S_50: 742, A_40: 594, A_42: 624, B_32: 475 }
  if (wq.main?.pid === 12101 && wq.main?.value) {
    const atkKey = `${wq.rarity}_${wq.main.value}`
    const atkMax = WQ_ATK_MAX[atkKey] || (wq.main.value * 14.85 | 0)
    props[2] = (props[2] || 0) + atkMax
  }
  if (wq.main?.pid === 13101 && wq.main?.value) props[3] = (props[3] || 0) + wq.main.value

  const properties = Object.entries(props).map(([pid, v]) => ({
    property_id: Number(pid),
    property_name: (MAIN_NAME[Number(pid)] || ''),
    base: String(Math.round(v * 100) / 100),
    add: '0',
    final: String(Math.round(v * 100) / 100),
  }))

  // 驱动盘：只放槽位与套装，词条全空 —— applyExtremePanel 会按预设布局重新发牌
  const suitsCycle = [suit4, suit4, suit4, suit4, suit2, suit2]
  const equip = suitsCycle.map((sid, i) => ({
    id: Number(sid) * 10 + i + 1,
    name: `${itemTable.suits?.[sid]?.name || sid}[${i + 1}]`,
    level: 15,
    rarity: 'S',
    equipment_type: i + 1,
    icon: zzzAssetDataUri('suit', itemTable.suits?.[sid]?.sprite),
    equip_suit: {
      suit_id: Number(sid),
      name: itemTable.suits?.[sid]?.name || '',
      own: sid === suit4 ? 4 : 2,
      desc1: itemTable.suits?.[sid]?.desc2 || '',
      desc2: itemTable.suits?.[sid]?.desc4 || '',
    },
    main_properties: [],
    properties: [],
  }))

  // 音擎：满级满精，被动文案取精炼 5 档
  const weapon = {
    id: Number(preset.weapon_id),
    name: wq.name,
    rarity: 'S',
    star: 5,
    level: 60,
    break_level: 5,
    profession: Number(st.profession),
    icon: zzzAssetDataUri('weapon', wq.sprite),
    talent_title: '',
    talent_content: wq.talents?.['5'] || wq.talents?.['1'] || '',
    main_properties: wq.main ? [{ property_id: wq.main.pid, property_name: wq.main.name, base: String(wq.main.pid === 12101 ? (WQ_ATK_MAX[`${wq.rarity}_${wq.main.value}`] || wq.main.value) : wq.main.value) }] : [],
    // 副词条：原始存储值（暴击/暴伤/穿透值是 ×40 的整数）需格式化输出
    properties: wq.sub ? [{
      property_id: wq.sub.pid,
      property_name: wq.sub.name,
      base: [20103, 21103, 23203, 23103].includes(wq.sub.pid)
        ? String(Math.round(wq.sub.value / 40)) + '%'
        : String(wq.sub.value),
    }] : [],
  }

  // 技能：中文名取倍率表（伤害计算靠它匹配），等级按极限口径（普通 16 / 核心 7）
  // getCharRates 返回 { ok, char }，技能在 char.skills 下（不是顶层 skills）
  const rateInfo = getCharRates(statKey)
  const itemsByType = new Map()
  if (rateInfo?.ok) {
    for (const sk of rateInfo.char?.skills || []) {
      if (!sk.name) continue
      // skillCat 的返回值 → 接口 skill_type：
      //   0 普攻 / 1 特殊技 / 2 闪避 / 3 连携（含终结技）/ 5 核心 / 6 支援
      // 连携技与终结技在接口里同属 skill_type 3（cat 分别是 RL 与 RZ），都要接住。
      // 分类为空的（倍率表里那种「无名强化分支」）直接跳过 —— 塞进普攻组会污染伤害计算。
      const cat = skillCat(sk.name)
      let t = null
      if (cat === 'T') t = 5
      else if (cat === 'L') t = 6
      else if (cat === 'R' || cat === 'RL' || cat === 'RZ') t = 3
      else if (cat === 'E' || cat === 'EQ') t = 1
      else if (cat === 'AP' || cat === 'AQ' || cat === 'AX') t = 0
      else if (cat === 'C' || cat === 'CF' || cat === 'CA') t = 2
      if (t == null) continue
      if (!itemsByType.has(t)) itemsByType.set(t, [])
      itemsByType.get(t).push({ title: sk.name, icon: '' })
    }
  }
  const skills = [0, 1, 2, 3, 5, 6].map(t => ({
    skill_type: t,
    level: t === 5 ? 7 : 16,
    items: itemsByType.get(t) || [],
  }))

  const roleIcon = zzzAssetDataUri('role', st.sprite)

  return {
    ok: true,
    avatar: {
      id: st.id,
      name_mi18n: statKey,
      full_name_mi18n: st.fullName || statKey,
      rarity: st.rarity,
      element_type: st.elementType,
      avatar_profession: st.profession,
      level: 60,
      rank: 6,
      camp_name_mi18n: st.camp || '',
      properties,
      equip,
      weapon,
      skills,
      role_icon: roleIcon,
      role_vertical_painting_url: '',
      role_square_url: '',
      // 合成标记：面板底部据此说明数据来源，避免让人以为是真实账号数据
      __synthetic: true,
    },
  }
}

/**
 * 读取自定义面板图，返回 data URI；无则返回 ''。
 * 每个角色目录随机取一张 png/jpg/webp；名字同时尝试简称/全称和「」包裹形式。
 */
function loadCustomPortrait(names) {
  const variants = []
  for (const nm of names) {
    if (!nm) continue
    variants.push(nm, `「${nm}」`, String(nm).replace(/[「」]/g, ''))
  }
  for (const base of CUSTOM_PORTRAIT_DIRS) {
    for (const nm of variants) {
      const dir = path.join(base, nm)
      if (!fs.existsSync(dir)) continue
      let files = []
      try { files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() } catch { files = [] }
      if (!files.length) continue
      const file = files[Math.floor(Math.random() * files.length)]
      const ext = path.extname(file).slice(1).toLowerCase()
      const mime = ext === 'jpg' ? 'jpeg' : ext
      try {
        const buf = fs.readFileSync(path.join(dir, file))
        return `data:image/${mime};base64,${buf.toString('base64')}`
      } catch { /* 读取失败则试下一个 */ }
    }
  }
  return ''
}

let zzzPartnerMap = null
function getZzzSprite(avatar) {
  if (!zzzPartnerMap) {
    try {
      zzzPartnerMap = JSON.parse(fs.readFileSync('./plugins/HoYoGet-Plugin/resources/zzz/map/PartnerId2Data.json', 'utf8'))
    } catch {
      zzzPartnerMap = {}
    }
  }
  const data = zzzPartnerMap || {}
  const id = String(avatar?.id || '')
  if (id && data[id]?.sprite_id) return String(data[id].sprite_id)
  const clean = s => String(s || '').replace(/[「」&·\s]/g, '')
  const names = [avatar?.name_mi18n, avatar?.full_name_mi18n].filter(Boolean).map(clean)
  for (const info of Object.values(data)) {
    const n = clean(info?.name), f = clean(info?.full_name)
    if (names.includes(n) || names.includes(f)) return String(info.sprite_id || '')
  }
  for (const info of Object.values(data)) {
    const n = clean(info?.name), f = clean(info?.full_name)
    if (names.some(x => x && (n.startsWith(x) || x.startsWith(n) || f.startsWith(x) || x.startsWith(f)))) {
      return String(info.sprite_id || '')
    }
  }
  return ''
}

function localImageDataUri(file) {
  try {
    const buf = fs.readFileSync(file)
    const ext = path.extname(file).slice(1).toLowerCase()
    const mime = ext === 'jpg' ? 'jpeg' : ext
    return `data:image/${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/**
 * 官方全身立绘。ZZZ-Plugin 面板用的就是这套 IconRole 全图；
 * 米游社 record 的 role_vertical_painting_url 实测是 684×356 的宽幅横幅，底边会被裁。
 */
function getZzzFullBody(avatar) {
  const sprite = getZzzSprite(avatar)
  if (!sprite) return null
  const local = `./plugins/ZZZ-Plugin/resources/images/nanoka/role/IconRole${sprite}_01.webp`
  const primary = fs.existsSync(local)
    ? localImageDataUri(local)
    : `http://lulush.microgg.cn/ZZZeroUID/resource/role/IconRole${sprite}.png`
  return {
    primary,
    // Lulu 镜像偶尔不可达时回落到 nanoka；再不行由 <img onerror> 回落到接口图
    fallback: `https://static.nanoka.cc/assets/zzz/IconRole${sprite}_01.webp`,
  }
}

/**
 * 驱动盘评分（自研权重：按职业优先级 + 固定词条折算）。
 * 依据角色名取预设规则→权重(按 property_id)，逐盘算分(1-3号位副词条55分制、4-6号位主12+副43)，
 * 乘以等级系数(0.25+等级*0.05)与品质系数(S=1/A=2/3/B=1/3)，六盘求和得 0~330 总分与段位。
 * 扁平词条(小攻击/生命/防御)未做动态等效映射，对结果影响很小。
 */
const SCORE_PROP_ID = {
  '生命值百分比': 11102, '攻击力百分比': 12102, '防御力百分比': 13102, '冲击力': 12202,
  '暴击率': 20103, '暴击伤害': 21103, '穿透率': 23103, '穿透值': 23203,
  '能量自动回复': 30502, '异常精通': 31203, '异常掌控': 31402,
}
const ELEM_DMG_ID = { 200: 31503, 201: 31603, 202: 31703, 203: 31803, 204: 32303, 205: 31903 }
// 左栏属性行 → 评分词条 id：面板上每条属性后面标出它在评分里的权重（同喵喵面板）。
// 伤害加成按角色元素取对应 id（见 ELEM_DMG_ID）。
const STAT_ROW_PID = {
  hpmax: 11102, attack: 12102, def: 13102, breakstun: 12202,
  crit: 20103, critdam: 21103, elementabnormalpower: 31402, elementmystery: 31203,
  penratio: 23103, sprecover: 30502, penvalue: 23203,
}
// 单条副词条的基础值：用于把固定攻击/生命/防御换算成百分比等效权重
const BASE_VALUE = { 11102: 3, 11103: 112, 12102: 3, 12103: 19, 13102: 4.8, 13103: 15 }
// 培养进度雷达的「推荐毕业值」（面板终值，百分比按百分数存）：达到即贴边
const RADAR_TARGET = {
  attack: 3000, hpmax: 15000, def: 2000, breakstun: 130,
  crit: 75, critdam: 150, elementabnormalpower: 150, elementmystery: 200,
  penratio: 24, sprecover: 1.8, dmgbonus: 46.4, penvalue: 36,
}
const SUB_BASE_VALUE = { ...BASE_VALUE, 20103: 2.4, 21103: 4.8, 23203: 9, 31203: 9 }
const MAIN_MAX_VALUE = {
  11102: '30%', 12102: '30%', 13102: '48%', 12202: '18%',
  20103: '24%', 21103: '48%', 23103: '24%', 23203: '24',
  30502: '60%', 31203: '92', 31402: '30%',
  31503: '30%', 31603: '30%', 31703: '30%', 31803: '30%', 31903: '30%', 32303: '30%',
  11103: '2200', 12103: '316', 13103: '225',
}
const MAIN_NAME = {
  11102: '生命值百分比', 11103: '生命值', 12102: '攻击力百分比', 12103: '攻击力',
  13102: '防御力百分比', 13103: '防御力', 12202: '冲击力', 20103: '暴击率',
  21103: '暴击伤害', 23103: '穿透率', 23203: '穿透值', 30502: '能量自动回复',
  31203: '异常精通', 31402: '异常掌控', 31503: '物理伤害加成', 31603: '火属性伤害加成',
  31703: '冰属性伤害加成', 31803: '电属性伤害加成', 31903: '以太伤害加成', 32303: '风属性伤害加成',
}
// 可能的副词条 id（用于理论最大词条）。31402 异常掌控可作副词条（异常职业），
// 31203/31402 排在 23203 前，保证异常职业补位时先取精通/掌控。
const SUB_STAT_IDS = [11102, 11103, 12102, 12103, 13102, 13103, 20103, 21103, 31203, 31402, 23203]
// 4/5/6 号位主词条候选（评分用：只列对评分有意义的那几项）
const SCORE_MAIN_STATS = {
  4: [11102, 12102, 13102, 20103, 21103, 31203],
  5: [11102, 12102, 13102, 23103, 31503, 31603, 31703, 31803, 32303, 31903],
  6: [11102, 12102, 12202, 13102, 30502, 31402],
}
// 极限面板/主词条校验用的**游戏实际**主词条池。
// 1/2/3 号位的主词条是唯一的固定值，玩家没有选择余地：
//   1 号 = 生命值固定值(11103)、2 号 = 攻击力固定值(12103)、3 号 = 防御力固定值(13103)。
// 核对依据：本地全部面板记录（本插件 + ZZZ-Plugin，1244 条盘）里，
// 1/2/3 号盘的 property_id 100% 分别是 11103 / 12103 / 13103，没有例外。
// 米游社的推荐配装也只有 part4/part5/part6，同样印证前三盘不需要选。
const MAIN_STAT_POOL = {
  1: [11103],
  2: [12103],
  3: [13103],
  ...SCORE_MAIN_STATS,
}
// 自研评分权重：按职业给出主词条/副词条优先级，不复制第三方评分表。
// 取向：强攻双暴、击破冲击、异常精通/掌控、支援回能、命破生命、锋御防御。
// 副词条只存在「穿透值(23203)」；「穿透率(23103)」只作 5 号位主词条。
// 强攻按需求把穿透率给到满权重 1（面板徽章 100），参与 5 号位主词条评分；
// 穿透值仍给 50：它是「小穿透」，裸值收益远低于双暴/属性伤，给满会让
// 只歪了几条穿透的盘评得过高（角色如有需要走 CHAR_WEIGHT_OVERRIDE 单独调）。
const SELF_SCORE_WEIGHTS = {
  strong:   { '攻击力百分比': .75, '暴击率': 1, '暴击伤害': 1, '穿透率': 1, '穿透值': .5, '属性伤害加成': 1 },
  stun:     { '冲击力': 1, '攻击力百分比': .75, '暴击率': 1, '暴击伤害': .75, '穿透值': .5, '属性伤害加成': .75 },
  anomaly:  { '攻击力百分比': .75, '异常精通': 1, '异常掌控': 1, '穿透值': .75, '属性伤害加成': 1 },
  support:  { '攻击力百分比': .75, '暴击率': .75, '暴击伤害': .75, '能量自动回复': 1, '穿透值': .5, '属性伤害加成': .75 },
  rupture:  { '生命值百分比': .75, '攻击力百分比': .25, '暴击率': 1, '暴击伤害': 1, '属性伤害加成': 1, '冲击力': .5, '防御力百分比': .25 },
  defender: { '防御力百分比': 1, '暴击率': .75, '暴击伤害': .75, '穿透值': .75, '属性伤害加成': 1 },
}
// prof5「防护」走 defender 权重：防护角色（凯撒/本/赛斯/潘引壶/照）主词条是防御%/生命%，
// 此前被映射到 support（暴击/攻击/能量）导致副词条优先级完全错位。
const PROF_WEIGHT_KEY = { 1: 'strong', 2: 'stun', 3: 'anomaly', 4: 'support', 5: 'defender', 6: 'rupture', 7: 'defender' }

/**
 * 角色级权重覆盖：职业权重只能给出「这一类角色通常怎么配」，
 * 但个别角色的实际收益会偏离职业模板，继续套职业权重会把好盘评成烂盘。
 *
 * 星见雅（雅）：职业是异常，但输出完全走直伤 —— 专武「霰落星殿」副词条是暴击率，
 * 核心被动按暴击伤害结算，6 影再给穿透。用 anomaly 权重（只认精通/掌控，
 * 双暴权重为 0）会把她的双暴盘全部判为无效词条，评分因此明显偏低。
 */
const CHAR_WEIGHT_OVERRIDE = {
  雅: { '攻击力百分比': 1, '暴击率': 1, '暴击伤害': 1, '穿透值': .75, '属性伤害加成': 1, '异常精通': .25 },
}
const PROF_WEIGHT_NAME = { 1: '强攻', 2: '击破', 3: '异常', 4: '支援', 5: '防护', 6: '命破', 7: '锋御' }

/** 取评分权重（按 property_id） */
function getScoreWeight(charName, stats, profession, elementType, baseProps = {}) {
  const elemId = ELEM_DMG_ID[elementType]
  /* 角色级覆盖优先：命中就直接用覆盖表，不再看职业 */
  const override = CHAR_WEIGHT_OVERRIDE[charName]
  const key = PROF_WEIGHT_KEY[profession] || 'strong'
  const ruleName = override
    ? `自研·${charName}（特化）`
    : `自研·${PROF_WEIGHT_NAME[profession] || '强攻'}`
  const named = { ...(override || SELF_SCORE_WEIGHTS[key]) }
  const weight = {}
  for (const nm in named) {
    const id = nm === '属性伤害加成' ? elemId : SCORE_PROP_ID[nm]
    if (id != null) weight[id] = named[nm]
  }
  // 固定攻击/生命/防御按角色基础值折算成百分比等效权重。
  for (const [small, big, keyName] of [[11103, 11102, 'hpmax'], [12103, 12102, 'attack'], [13103, 13102, 'def']]) {
    if (!weight[big]) continue
    const base = parseFloat(baseProps?.[keyName]?.base)
    if (!(base > 0)) continue
    weight[small] ??= BASE_VALUE[small] * 100 / (BASE_VALUE[big] * base) * weight[big]
  }
  return { ruleName, weight }
}
/** 单个驱动盘的段位：沿用 ZZZ-Plugin 的分界，保留 A/S/SS/SSS/ACE/MAX */
function discGrade(score) {
  if (score >= 48) return 'MAX'
  if (score >= 40) return 'ACE'
  if (score >= 36) return 'SSS'
  if (score >= 32) return 'SS'
  if (score >= 28) return 'S'
  return 'A'
}

/**
 * 计算驱动盘总分与段位；另返回每个盘评分 discScores 与有益/有效词条数。
 *
 * 导出给 apps/zzz_rank.js 复用 —— 排名榜与面板详情必须是同一套评分，
 * 曾经因为两处各写一份，星见雅的直伤权重只加在了这里，
 * 导致「%雅排名」与「%雅面板」算出两个不同的分数。
 * 以后调权重只改这一处。
 */
export function calcEquipScore(equip_final, charName, stats, profession, elementType, baseProps = {}) {
  const { ruleName, weight } = getScoreWeight(charName, stats, profession, elementType, baseProps)
  let total = 0
  const discScores = []
  let useful = 0
  let effective = 0
  for (const eq of (equip_final || [])) {
    const slot = eq.slot || 0
    const levelMult = 0.25 + (eq.level ?? 0) * 0.05
    const rarityMult = eq.rarity === 'S' ? 1 : eq.rarity === 'A' ? 2 / 3 : eq.rarity === 'B' ? 1 / 3 : 1
    const mainId = (eq.main_properties && eq.main_properties[0]) ? eq.main_properties[0].pid : 0
    let actual = 0
    for (const p of (eq.properties || [])) {
      const w = weight[p.pid]
      if (w) { actual += w * (p.count ?? 0); useful += (p.count ?? 0); effective += w * (p.count ?? 0) }
    }
    const cand = SUB_STAT_IDS.filter(id => id !== mainId && weight[id]).sort((a, b) => weight[b] - weight[a]).slice(0, 4)
    let score = 0
    if (cand.length) {
      let max = weight[cand[0]] * 6
      for (let i = 1; i < cand.length; i++) max += weight[cand[i]] || 0
      if (max > 0) {
        if (slot >= 1 && slot <= 3) {
          const minScore = 12 * levelMult * rarityMult
          score = actual === 0 ? minScore : Math.max(actual / max * levelMult * rarityMult * 55, minScore)
        } else {
          const ms = (SCORE_MAIN_STATS[slot] || []).filter(id => weight[id]).sort((a, b) => weight[b] - weight[a])[0]
          const mainScore = ms ? 12 * (weight[mainId] || 0) / weight[ms] : 12
          const subScore = actual / max * 43
          score = (mainScore + subScore) * levelMult * rarityMult
        }
      }
    }
    discScores.push(+score.toFixed(2))
    total += score
  }
  const rating = total >= 280 ? 'MAX' : total >= 220 ? 'ACE' : total >= 200 ? 'SSS' : total >= 180 ? 'SS' : total >= 160 ? 'S' : total >= 120 ? 'A' : total >= 80 ? 'B' : 'C'
  // weight 一并返回：面板属性行/词条统计要标权重，避免再算一遍（两处各算一份迟早会漂）
  return { score: +total.toFixed(1), rating, ruleName, weight, discScores, usefulCount: useful, effectiveCount: +effective.toFixed(2) }
}

/**
 * 培养进度雷达：取该角色「评分权重最高」的 6 项属性作轴，
 * 每轴按推荐毕业值归一化（贴边=达标），实线是当前、虚线是推荐。
 * 轴取自评分权重而不是固定六项，异常角色就不会被迫拿双爆去比。
 */
function buildZZZRadar(stat_rows) {
  const src = stat_rows
    .map(r => {
      const key = r.icon === 'element' ? 'dmgbonus' : r.cls
      const value = parseFloat(String(r.final).replace(/[^\d.]/g, ''))
      return { key, label: r.label, value, weight: Number(r.weight) || 0, target: RADAR_TARGET[key] }
    })
    .filter(r => r.target > 0 && Number.isFinite(r.value))
  // 有收益的词条优先；轴数不足 4 时再用基础属性补齐（够 4 轴就保持原样，
  // 免得拿「生命值」这种无关属性凑满六边形，看起来像没练生命）
  const picked = src.filter(r => r.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 6)
  if (picked.length < 4) {
    for (const key of ['attack', 'crit', 'critdam', 'hpmax', 'dmgbonus']) {
      if (picked.length >= 4) break
      const hit = src.find(r => r.key === key && !picked.includes(r))
      if (hit) picked.push(hit)
    }
  }
  if (picked.length < 4) return null
  // 轴顺序固定回面板属性顺序，避免权重排序让每张图的轴位漂移
  const order = src.filter(r => picked.includes(r))

  const cx = 92
  const cy = 92
  const r = 62
  const step = (Math.PI * 2) / order.length
  const angleAt = i => -Math.PI / 2 + i * step
  const at = (i, ratio) => [
    cx + Math.cos(angleAt(i)) * r * ratio,
    cy + Math.sin(angleAt(i)) * r * ratio,
  ]
  const poly = ratioOf => order.map((_, i) => {
    const [x, y] = at(i, ratioOf(i))
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')

  const ratios = order.map(o => {
    const raw = (o.value || 0) / o.target
    // 0 值也留一圈小凸起，否则雷达会塌成一条线看不出形状
    return Math.max(0.12, Math.min(1, raw))
  })
  const labels = order.map((o, i) => {
    const cos = Math.cos(angleAt(i))
    const [x, y] = at(i, 1)
    const lr = r + 15
    return {
      label: o.label,
      x: (cx + Math.cos(angleAt(i)) * lr).toFixed(1),
      y: (cy + Math.sin(angleAt(i)) * lr).toFixed(1),
      anchor: Math.abs(cos) < 0.2 ? 'middle' : (cos > 0 ? 'start' : 'end'),
      ratio: ratios[i],
      pct: Math.round(ratios[i] * 100),
    }
  })
  const spokes = order.map((_, i) => {
    const [x2, y2] = at(i, 1)
    return { x1: cx, y1: cy, x2: x2.toFixed(1), y2: y2.toFixed(1) }
  })
  const rings = [1, 0.66, 0.33].map(s => poly(() => s))
  return {
    cx, cy, r,
    grid: rings,
    spokes,
    labels,
    polygon: poly(i => ratios[i]),
    target: poly(() => 1),
    // 整体培养度：各轴归一化后取均值
    progress: Math.round(ratios.reduce((s, v) => s + v, 0) / ratios.length * 100),
  }
}

/**
 * 把一条 avatar/info 详情归一化为面板模板所需的 charData。
 * 模板字段与 resources/zzz_panel/detail.html 对齐，
 * 不复用其算法（评分用接口分近似；伤害乘区公式取自其 Calculator.ts，按面板属性计算）。
 */
function normalizeDetail(a, uid) {
  const rarity = a?.rarity === 'S' ? 'S' : (a?.rarity || 'A')
  const subElement = ZELEM[a?.element_type] || 'physical'
  const elementStr = ZELEM_STR[a?.element_type] || 'Physical'
  const w = a?.weapon || {}

  // 武器
  const weapon = w?.name ? {
    name: w.name,
    rarity: w.rarity || rarity,
    level: w.level ?? 0,
    star: (w.rarity === 'S' ? 5 : 4),
    stars: Array.from({ length: w.rarity === 'S' ? 5 : 4 }, () => (w.rarity === 'S' ? 5 : 4)),
    refine: w.star ?? 0,
    square_icon: w.icon || '',
    talent_title: w.talent_title || '',
    talent: stripTags(w.talent_content || ''),
    main_properties: (w.main_properties || []).map(p => ({
      classname: (ZPROP[p.property_id] || {}).c || 'attack',
      property_name: p.property_name || '',
      base: p.base || '',
    })),
    properties: (w.properties || []).map(p => ({
      classname: (ZPROP[p.property_id] || {}).c || 'attack',
      property_name: p.property_name || '',
      base: p.base || '',
    })),
  } : null

  // 角色基础属性 → basic_properties（按字段键；伤害加成单独处理以挂元素图标）
  const basic_properties = buildBasicProperties(a)

  // 技能：按固定槽位顺序产出，模板按 skills[0..5] 取
  const skills = SKILL_POS.map(t => {
    const s = (a?.skills || []).find(x => x.skill_type === t)
    return { level: s?.level ?? 0 }
  })

  // 驱动盘
  const discsRaw = a?.equip || []
  const equip_final = discsRaw.map(d => {
    const suit = d.equip_suit || {}
    return {
      slot: d.equipment_type ?? 0,
      suit_icon: d.icon || '',
      level: d.level ?? 0,
      rarity: d.rarity || 'A',
      name: d.name || '',
      suit_name: suit.name || '',
      own: suit.own || 0,
      main_properties: (d.main_properties || []).map(p => ({
        pid: p.property_id,
        classname: (ZPROP[p.property_id] || {}).c || 'attack',
        short_name: p.property_name || '',
        base: p.base || '',
      })),
      properties: (d.properties || []).map(p => {
        const valid = !!p.valid
        return {
          pid: p.property_id,
          classname: (ZPROP[p.property_id] || {}).c || 'attack',
          property_name: p.property_name || '',
          base: p.base || '',
          count: p.level ?? 0,
          hit: Math.max(0, (p.level ?? 0) - 1),
          count_arr: Array.from({ length: Math.max(0, (p.level ?? 0) - 1) }, () => 0),
          base_score: valid ? 1 : 0,
        }
      }),
    }
  })

  // 词条统计：有效副词条按 property_id 聚合（区分百分比/固定值），显示 强化次数徽标+属性名+累计值
  const ZSHORT = { 11102: '生命', 11103: '生命', 12102: '攻击', 12103: '攻击', 13102: '防御', 13103: '防御', 20103: '暴击', 21103: '暴伤', 23203: '穿透', 31203: '精通', 12202: '冲击', 30502: '回能', 31402: '掌控', 23103: '穿透率' }
  const agg = {}
  for (const d of discsRaw) {
    for (const p of (d.properties || [])) {
      const pid = p.property_id
      const isPct = String(p.base).includes('%')
      if (!agg[pid]) agg[pid] = { pid, name: ZSHORT[pid] || p.property_name || ('x' + pid), count: 0, value: 0, isPct }
      agg[pid].count += (p.level ?? 0)
      const num = parseFloat(p.base)
      if (!isNaN(num)) agg[pid].value += num
    }
  }
  // 评分：按自研权重计算（0~330 分制），替换接口分。
  // 先算，后面的词条统计与属性行都要用 scoreRes.weight 标权重。
  const scoreStats = {
    atk: parseFloat(basic_properties.attack?.final) || 0,
    crit: toRatio(basic_properties.crit?.final),
    critdmg: toRatio(basic_properties.critdam?.final),
    am: parseFloat(basic_properties.elementabnormalpower?.final) || 0,
    ap: parseFloat(basic_properties.elementmystery?.final) || 0,
  }
  const scoreRes = calcEquipScore(equip_final, a?.name_mi18n || '', scoreStats, a?.avatar_profession, a?.element_type, basic_properties)
  const statWeight = pid => Math.round((scoreRes.weight?.[Number(pid)] || 0) * 100)

  const propertyStats = Object.values(agg)
    // weight：该词条在评分里的权重（0~100，0 表示不计分），模板里跟在词条名后面
    .map(s => ({ name: s.name, count: s.count, value: s.value.toFixed(1) + (s.isPct ? '%' : ''), weight: statWeight(s.pid) }))
    .sort((x, y) => y.count - x.count)

  const rating = scoreRes.rating
  const equip_score = scoreRes.score
  equip_final.forEach((eq, i) => {
    eq.score = scoreRes.discScores[i] ?? 0
    eq.grade = discGrade(eq.score)
  })
  const validCount = a?.equip_plan_info?.valid_property_cnt
    ?? discsRaw.reduce((s, d) => s + (d.properties || []).filter(p => p.valid).length, 0)

  const damageAreas = calcDamageAreas(basic_properties, a?.level)
  // 逐技能伤害：倍率取自本地静态表，与接口技能按中文名对齐
  const damage = calcDamage(basic_properties, a?.level, a, a?.name_mi18n || a?.full_name_mi18n || '')
  const damageAvailable = damage.ok
  const rateCovered = (() => {
    try { return getCharRates(a?.name_mi18n || '').ok } catch (_) { return false }
  })()

  // 套装效果：按 suit_id 聚合，并收集该套装已装备盘图标作配图
  const setMap = {}
  for (const d of discsRaw) {
    const s = d.equip_suit
    if (!s || s.suit_id == null) continue
    if (!setMap[s.suit_id]) setMap[s.suit_id] = { name: s.name || '', own: s.own || 0, desc1: stripTags(s.desc1 || ''), desc2: stripTags(s.desc2 || ''), icons: [] }
    if (d.icon) setMap[s.suit_id].icons.push(d.icon)
  }
  const sets = Object.values(setMap)

  // 属性行（固定顺序，供模板 {{each}} 遍历；伤害加成用元素图标）
  const STAT_ORDER = [
    ['hpmax', '生命值'], ['attack', '攻击力'], ['def', '防御力'], ['breakstun', '冲击力'],
    ['crit', '暴击率'], ['critdam', '暴击伤害'], ['elementabnormalpower', '异常掌控'], ['elementmystery', '异常精通'],
    ['penratio', '穿透率'], ['sprecover', '能量自动回复'], ['dmgbonus', '伤害加成'], ['penvalue', '穿透值'],
  ]
  const stat_rows = []
  for (const [k, label] of STAT_ORDER) {
    const v = basic_properties[k]
    if (!v) continue
    // 权重：这一条属性在评分里值多少分（0~100），模板里作为小徽章跟在属性名后面
    const weight = statWeight(k === 'dmgbonus' ? ELEM_DMG_ID[a?.element_type] : STAT_ROW_PID[k])
    // 伤害加成的属性名带元素前缀（冰属性伤害加成），太长会把权重徽章挤掉；
    // 元素已由图标颜色区分，标签统一用「伤害加成」（与喵喵面板一致）
    const row = { pid: k === 'dmgbonus' ? ELEM_DMG_ID[a?.element_type] : STAT_ROW_PID[k], label, weight, base: v.base, add: v.add, final: v.final }
    if (k === 'dmgbonus') stat_rows.push({ ...row, icon: 'element', cls: elementStr })
    else stat_rows.push({ ...row, icon: 'prop', cls: k })
  }
  /* 接口只给生命/攻击/防御的 base，其余项用角色静态数据补出「基础 + 加成」，
     这样穿透率 0% 也能显示成「0.0% + 24.0%」（主词条/副词条都在加成里） */
  try {
    fillBaseAdd(stat_rows, {
      charId: a?.id,
      level: a?.level,
      promo: a?.promote_level ?? a?.promotion_level ?? 6,
      weapon: w,
    })
  } catch (err) {
    logger.debug?.(`[HoYoGet][zzz_panel] 属性基础值推算失败：${err?.message || err}`)
  }

  const apiPortrait = a?.role_vertical_painting_url || a?.role_square_url || ''
  const fullBody = getZzzFullBody(a)
  const customPortrait = loadCustomPortrait([a?.name_mi18n, a?.full_name_mi18n])
  const charData = {
    uid: uid || a?.id || '',
    // 优先自定义面板（咕咕牛 / 本插件），没有再回落官方全身图
    role_icon: customPortrait || fullBody?.primary || apiPortrait,
    role_fallback: fullBody?.fallback || apiPortrait,
    skills,
    rarity,
    sub_element_str: subElement,
    element_str: elementStr,
    element_cn: ZZZ_ELEMENT_MAP[a?.element_type] || `属性${a?.element_type ?? ''}`,
    profession: ZZZ_TYPE_MAP[a?.avatar_profession] || `类型${a?.avatar_profession ?? ''}`,
    full_name_mi18n: a?.full_name_mi18n || a?.name_mi18n || `角色${a?.id}`,
    level: a?.level ?? 0,
    rank: a?.rank ?? 0,
    basic_properties,
    weapon,
    equip_score,
    equip_comment: rating,
    weightRule: scoreRes.ruleName,
    usefulCount: scoreRes.usefulCount,
    effectiveCount: scoreRes.effectiveCount,
    propertyStats,
    equip_final,
    damageAreas,
    damage,
    damageAvailable,
    rateCovered,
    sets,
    stat_rows,
    radar: buildZZZRadar(stat_rows),
  }
  return { uid: charData.uid, charData }
}

// 前缀刻意收窄到「不带 #」：
//   「米游社更新面板」  → 绝区零（本插件）
//   「#米游社更新面板」 → 原神（miao-plugin，已有的约定）
// 带 % 会被绝区零前缀规则（zzzReg = /^#?(%|％|绝区零|zzz)+/）先一步吃掉，实测抢不到，
// 所以绝区零这边干脆不用任何前缀，用有无 # 来区分两个游戏。
const CMD_REG = /^(?:米游社|%|#?绝区零)?\s*米游社\s*(更新|刷新)\s*(全部)?\s*面板$/
// 详情新格式：米游社<名字>面板（如 米游社南宫羽面板）；保留旧「米游社面板 <名字>」兼容。
// 负向预查 (?!更新|刷新) 避免与「米游社更新面板 / 米游社刷新面板」抢。
// 也接受绝区零常用的 % 前缀；%zzz/%绝区零 仍留给 ZZZ-Plugin，避免把它的指令吃掉
const PREFIX_REG = '^(?:米游社|%|#?绝区零)(?!zzz|ZZZ|绝区零)'
const DETAIL_REG = new RegExp(`${PREFIX_REG}(?!更新|刷新)(.+?)面板$`)
// 米游社<角色>伤害[序号]：序号省略时默认取伤害最高那一招
const DAMAGE_REG = new RegExp(`${PREFIX_REG}(?!更新|刷新)(.+?)伤害\\s*(\\d*)$`)
const DETAIL_REG_OLD = /^(?:米游社|%|#?绝区零)面板\s+(.+)$/
const HELP_REG = /^米游社面板$/
const ORIGINAL_REG = /^(?:米游社|#?绝区零)原图$/
const PANEL_UPLOAD_REG = /^(?:米游社|%|#?绝区零)?(?:上传|添加)(.+?)(?:角色|面板)图$/
const PANEL_IMAGES_REG = /^(?:米游社|%|#?绝区零)?(?:获取|查看)(.+?)(?:角色|面板)图\s*(\d*)$/
const PANEL_DELETE_IMG_REG = /^(?:米游社|%|#?绝区零)?删除(.+?)(?:角色|面板)图(.+)$/
const EXTREME_REG = /^(?:米游社|%|#?绝区零)?(.+?)极限面板$/
// 主人专用：批量更新群友（私聊则全部绑定用户）的面板
const BULK_UPDATE_REG = /^(?:米游社|%|#?绝区零)?(?:批量)?更新群友面板$/
// 主人专用：批量更新群友的挑战记录（式舆 + 危局）
const BULK_CHALLENGE_REG = /^(?:米游社|%|#?绝区零)?(?:批量)?更新群友挑战(记录|数据)$/
// 主人专用：清理失效的绝区零绑定（无任何可用 CK 的）
const CLEAN_BINDING_REG = /^(?:米游社|%|#?绝区零)?清理失效(ck|CK|绑定)$/
// 练度统计：%练度 / 米游社练度 / 绝区零练度统计（对齐 ZZZ-Plugin 的 %zzz练度）
const PROFICIENCY_REG = /^(?:米游社|%|#?绝区零)?练度(统计)?$/
const REMIND_PREFIX = '^(?:米游社|%|#?绝区零)?'
const REMIND_ON_REG = new RegExp(`${REMIND_PREFIX}(开启|关闭)挑战提醒$`)
const REMIND_GLOBAL_ON_REG = new RegExp(`${REMIND_PREFIX}(开启|启用|关闭|禁用)全局挑战提醒$`)
const REMIND_ABYSS_REG = new RegExp(`${REMIND_PREFIX}设置(全局)?(?:式舆防卫战|式舆|深渊|防卫战|防卫)阈值\\s*(\\d+)$`)
const REMIND_DEADLY_REG = new RegExp(`${REMIND_PREFIX}设置(全局)?(?:危局强袭战|危局|强袭|强袭战)阈值\\s*(\\d+)$`)
const REMIND_STATUS_REG = new RegExp(`${REMIND_PREFIX}查询挑战状态$`)
const REMIND_MY_TIME_REG = new RegExp(`${REMIND_PREFIX}设置个人提醒时间\\s*(每日\\d+时(?:(\\d+)分)?|每周.\\d+时(?:(\\d+)分)?)$`)
const REMIND_MY_VIEW_REG = new RegExp(`${REMIND_PREFIX}个人提醒(状态|时间)$`)
const REMIND_MY_DEL_REG = new RegExp(`${REMIND_PREFIX}(重置|删除|取消)个人提醒时间$`)
const REMIND_GLOBAL_TIME_REG = new RegExp(`${REMIND_PREFIX}设置全局提醒时间\\s*(每日\\d+时(?:(\\d+)分)?|每周.\\d+时(?:(\\d+)分)?)$`)
const REMIND_GLOBAL_VIEW_REG = new RegExp(`${REMIND_PREFIX}全局提醒时间$`)

export class zzz_panel_list extends plugin {
  constructor() {
    super({
      name: '[米哈游]绝区零面板列表',
      dsc: '绝区零面板列表（自研，网格卡片）',
      event: 'message',
      // 必须压过 miao-plugin 的米游社面板与 ZZZ-Plugin 面板，否则规则抢不过它们
      priority: pluginPriority('zzz_panel_list', -100),
      rule: [
        // EXTREME 必须排在 DETAIL 之前：「米游社X极限面板」同时命中两者，
        // DETAIL 是超集匹配，放行后会被 detail 抢答成普通面板
        { reg: EXTREME_REG.source, fnc: 'panelExtreme' },
        { reg: PROFICIENCY_REG.source, fnc: 'panelProficiency' },
        // 必须排在 CMD_REG 之前：'更新群友面板' 不会命中 CMD_REG，
        // 但放前面能避免以后有人把 CMD_REG 放宽时被抢走
        { reg: BULK_UPDATE_REG.source, fnc: 'panelBulkUpdate' },
        { reg: BULK_CHALLENGE_REG.source, fnc: 'panelBulkChallenge' },
        { reg: CLEAN_BINDING_REG.source, fnc: 'panelCleanBinding' },
        { reg: CMD_REG.source, fnc: 'panelList' },
        { reg: DAMAGE_REG.source, fnc: 'panelDamage' },
        { reg: DETAIL_REG.source, fnc: 'panelDetail' },
        { reg: DETAIL_REG_OLD.source, fnc: 'panelDetail' },
        { reg: HELP_REG.source, fnc: 'panelDetailHelp' },
        { reg: ORIGINAL_REG.source, fnc: 'panelOriginal' },
        { reg: PANEL_UPLOAD_REG.source, fnc: 'panelUploadImages' },
        { reg: PANEL_IMAGES_REG.source, fnc: 'panelImageList' },
        { reg: PANEL_DELETE_IMG_REG.source, fnc: 'panelDeleteImages' },
        { reg: REMIND_ON_REG.source, fnc: 'zzzRemindToggle' },
        { reg: REMIND_GLOBAL_ON_REG.source, fnc: 'zzzRemindGlobalToggle' },
        { reg: REMIND_ABYSS_REG.source, fnc: 'zzzRemindAbyssThreshold' },
        { reg: REMIND_DEADLY_REG.source, fnc: 'zzzRemindDeadlyThreshold' },
        { reg: REMIND_STATUS_REG.source, fnc: 'zzzRemindStatus' },
        { reg: REMIND_MY_TIME_REG.source, fnc: 'zzzRemindSetMyTime' },
        { reg: REMIND_MY_VIEW_REG.source, fnc: 'zzzRemindViewMyTime' },
        { reg: REMIND_MY_DEL_REG.source, fnc: 'zzzRemindDeleteMyTime' },
        { reg: REMIND_GLOBAL_TIME_REG.source, fnc: 'zzzRemindSetGlobalTime' },
        { reg: REMIND_GLOBAL_VIEW_REG.source, fnc: 'zzzRemindViewGlobalTime' },
      ],
    })
    const remind = config()
    if (remind.zzz_remind_enable) {
      this.task = {
        name: 'HoYoGet绝区零挑战提醒',
        cron: '0 */10 * * * ?',
        fnc: () => this.runZzzRemindTask(),
      }
    }
  }

  /**
   * accept 早于所有规则执行。ZZZ-Plugin 的极限面板桥接也是 accept（priority -30000），
   * 只靠 rule priority 永远抢不过，所以这里在更早的 -40000 直接截胡极限面板。
   */
  async accept(e) {
    const msg = String(e?.msg || '')
    if (!EXTREME_REG.test(msg)) return false
    // 只要命中极限面板就截胡，不因 resolvePanelRole 解析不出角色而放行
    //（放行会被 DETAIL_REG 的首字模糊匹配抢答成普通面板）
    this.e = e
    await this.panelExtreme(e)
    return 'return'
  }

  /**
   * 主人专用：批量更新群友面板。
   * 群聊只刷本群已绑定成员，私聊刷全部绑定用户；串行 + 间隔，避免触发频次风控。
   */
  async panelBulkUpdate(e) {
    if (!e.isMaster) return e.reply('仅主人可操作')
    const { updateGroupMembers, formatResult } = await import('./lib/zzz_bulk_update.js')
    await e.reply('开始批量更新面板，请求会限速串行执行，请稍候…')
    try {
      const res = await updateGroupMembers(this, e)
      return e.reply(formatResult(res))
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 批量更新失败：${err?.message || err}`)
      return e.reply(`批量更新失败：${err?.message || err}`)
    }
  }

  /**
   * 主人专用：批量更新群友挑战记录（式舆防卫战 + 危局强袭战）。
   * 群聊只刷本群已绑定成员，私聊刷全部绑定用户。
   */
  async panelBulkChallenge(e) {
    if (!e.isMaster) return e.reply('仅主人可操作')
    const { updateGroupChallenges, formatResult } = await import('./lib/zzz_bulk_challenge.js')
    await e.reply('开始批量更新挑战记录（式舆 + 危局），请求会限速串行执行，请稍候…')
    try {
      const res = await updateGroupChallenges(this, e)
      return e.reply(formatResult(res))
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 批量更新挑战失败：${err?.message || err}`)
      return e.reply(`批量更新挑战失败：${err?.message || err}`)
    }
  }

  /**
   * 主人专用：清理失效的绝区零绑定。
   * 判定见 apps/zzz_clean_binding.js —— ltuids 无有效 CK 且没有 Stoken 文件才算失效，
   * 避免误删「ltuids 没写但 Stoken 还能用」的老用户。
   */
  async panelCleanBinding(e) {
    if (!e.isMaster) return e.reply('仅主人可操作')
    const { scanBindings, removeZzzBindings } = await import('./lib/zzz_clean_binding.js')
    try {
      const scan = await scanBindings()
      if (scan.error) return e.reply(scan.error)
      if (!scan.invalid.length) {
        return e.reply(`检查完成：共 ${scan.valid.length} 个有效绑定，没有失效的。`)
      }
      const preview = scan.invalid.slice(0, 10)
        .map(x => `  ${x.qq} → ${x.uid}`).join('\n')
      const more = scan.invalid.length > 10 ? `\n  ……另有 ${scan.invalid.length - 10} 个` : ''
      await e.reply([
        `发现 ${scan.invalid.length} 个失效绑定（无任何可用 CK）：`,
        preview + more,
        '',
        '正在清理…',
      ].join('\n'))

      const res = await removeZzzBindings(scan.invalid.map(x => x.qq))
      if (res.error) return e.reply(res.error)
      const lines = [`清理完成：已解除 ${res.done} 个失效绑定。`]
      if (res.errors.length) {
        lines.push('', '未处理：')
        for (const err of res.errors.slice(0, 6)) lines.push(`  ${err}`)
      }
      lines.push('', `剩余有效绑定：${scan.valid.length} 个`)
      return e.reply(lines.join('\n'))
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 清理失效 CK 失败：${err?.message || err}`)
      return e.reply(`清理失败：${err?.message || err}`)
    }
  }

  async panelList(e) {
    const uid = this.getZzzUid(e)
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    // 落盘原始响应，便于后续排查 / 字段再核对（按需，不影响出图）
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const basicFile = path.join(OUT_DIR, 'avatar_basic.json')
    fs.writeFileSync(basicFile, JSON.stringify({ uid, server, deviceFpApplied: !!raw.__fp, data: raw?.data }, null, 2))

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply(`已取到响应，但没识别出角色列表。原始数据已存到：\n${basicFile}\n请检查接口返回结构。`)
    }

    // 合并历史落盘角色：米游社 avatar/basic 只返回「展示柜」里的角色，
    // 玩家没勾选的老角色不会出现在响应里。这里把本地历次落盘的全量列表
    // （data/zzz_panel/avatar_basic_<uid>.json 与 records/ 详情）补进来，
    // 按 id 去重，避免「更新面板」后老角色消失。
    let mergedList = [...list]
    try {
      const seen = new Set(mergedList.map(a => String(a?.id)))
      const addFrom = (arr) => {
        if (!Array.isArray(arr)) return
        for (const a of arr) {
          const id = String(a?.id ?? a?.data?.id ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          mergedList.push(a?.data || a)
        }
      }
      // 1) 本 uid 的历史全量列表（批量更新落盘）
      const histFile = path.join(OUT_DIR, `avatar_basic_${uid}.json`)
      if (fs.existsSync(histFile)) {
        try {
          const hist = JSON.parse(fs.readFileSync(histFile, 'utf8'))
          addFrom(hist?.data?.avatar_list || hist?.data || hist?.avatar_list)
        } catch { /* 忽略损坏 */ }
      }
      // 2) 本 uid 的单角色详情记录（米游社<角色>面板落盘）
      try {
        for (const f of fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'))) {
          if (!f.startsWith(`${uid}_`) && !f.startsWith(`${uid}.`)) continue
          try {
            const obj = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), 'utf8'))
            if (obj?.data) addFrom([obj.data])
          } catch { /* 忽略损坏 */ }
        }
      } catch { /* records 目录不存在 */ }
    } catch (err) {
      logger.debug?.(`[HoYoGet][zzz_panel] 合并历史角色失败：${err?.message || err}`)
    }

    // 归一化后交模板渲染（自研，不复用 ZZZ-Plugin 模板）
    let cards = mergedList.map(it => normalizeAvatar(it))

    // 从本插件 records + ZZZ-Plugin 已落盘数据加载评分，用于排序与展示
    const uidRecords = new Map()
    const scoreOne = (a) => {
      const name = a?.name_mi18n || a?.full_name_mi18n || ''
      if (!name) return
      const equip = (a?.equip || []).map(d => ({
        slot: d.equipment_type ?? 0,
        level: d.level ?? 0,
        rarity: d.rarity || 'A',
        main_properties: (d.main_properties || []).map(p => ({ pid: p.property_id })),
        properties: (d.properties || []).map(p => ({
          pid: p.property_id,
          count: p.level ?? 0,
        })),
      }))
      const hasProps = equip.some(e => (e.properties || []).length > 0)
      // 已有记录：只有「新数据带完整副词条、旧数据没有」时才覆盖，
      // 避免补全后的完整数据被后续读到的裁剪数据盖回去。
      const prev = uidRecords.get(name)
      if (prev && !(hasProps && prev.hasProps === false)) return
      const basic_properties = {}
      for (const p of (a?.properties || [])) {
        const m = ZPROP[p.property_id]
        if (m && m.k !== 'dmgbonus') {
          const final = (p.final !== undefined && p.final !== '' && p.final !== '0') ? p.final : p.base
          basic_properties[m.k] = { base: p.base || '', final }
        }
      }
      const scoreStats = {
        atk: parseFloat(basic_properties.attack?.final) || 0,
        crit: toRatio(basic_properties.crit?.final),
        critdmg: toRatio(basic_properties.critdam?.final),
        am: parseFloat(basic_properties.elementabnormalpower?.final) || 0,
        ap: parseFloat(basic_properties.elementmystery?.final) || 0,
      }
      const scoreRes = calcEquipScore(equip, name, scoreStats, a?.avatar_profession, a?.element_type, basic_properties)
      uidRecords.set(name, { score: scoreRes.score, rating: scoreRes.rating, ruleName: scoreRes.ruleName, hasProps })
    }
    // 1) 本插件自己的 records（单角色详情落盘，优先）
    try {
      if (fs.existsSync(RECORDS_DIR)) {
        for (const f of fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'))) {
          try {
            const obj = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, f), 'utf8'))
            scoreOne(obj?.data || obj)
          } catch { /* 跳过损坏文件 */ }
        }
      }
    } catch { /* records 目录不存在 */ }
    // 2) ZZZ-Plugin 旧落盘（数组格式，回退兼容）
    try {
      const zzzPanelDir = path.join(ZZZ_ROOT, 'data', 'panel')
      if (fs.existsSync(zzzPanelDir)) {
        for (const f of fs.readdirSync(zzzPanelDir).filter(f => f.endsWith('.json'))) {
          try {
            const list = JSON.parse(fs.readFileSync(path.join(zzzPanelDir, f), 'utf8'))
            if (!Array.isArray(list)) continue
            for (const a of list) scoreOne(a)
          } catch { /* 跳过损坏文件 */ }
        }
      }
    } catch { /* panel 目录不存在 */ }

    // 给每个卡片注入评分（有记录则显示，无记录标记暂无）
    cards = cards.map(c => {
      const rec = uidRecords.get(c.name)
      return { ...c, equip_score: rec?.score ?? null, equip_rating: rec?.rating ?? null }
    })

    // 补全缺失评分：两类都要重拉 ——
    //   ① records 里完全没有详情的角色（equip_score == null）
    //   ② 有记录但驱动盘副词条被裁掉的角色（hasProps=false，need_wiki=false 的旧数据）
    // 并发调 avatar/info（need_wiki=true）拿完整驱动盘，算评分并落盘。
    const missing = cards.filter(c => {
      if (c.id == null) return false
      if (c.equip_score == null) return true
      const rec = uidRecords.get(c.name)
      return rec && rec.hasProps === false
    })
    if (missing.length) {
      await e.reply(`检测到 ${missing.length} 个角色评分数据不完整，正在并发补全，请稍候…`, true, { recallMsg: 0 })
      let gamePlayer = null
      try { gamePlayer = await this.fetchPlayer(e, uid, ck) } catch {}
      const concurrency = 4
      const intervalMs = 400
      let idx = 0
      const worker = async () => {
        while (idx < missing.length) {
          const c = missing[idx++]
          try {
            const info = await this.fetchDetail(e, uid, ck, c.id)
            if (!info?.__error) {
              const avatar = this.pickInfo(info?.data)
              if (avatar) {
                scoreOne(avatar)
                // 落盘详情，供下次列表/排名/极限面板复用
                try {
                  fs.mkdirSync(RECORDS_DIR, { recursive: true })
                  const recRole = String(avatar?.name_mi18n || c.name || 'unknown').replace(/[\\/:*?"<>|\s·・]/g, '') || 'unknown'
                  fs.writeFileSync(path.join(RECORDS_DIR, `${uid}_${recRole}.json`), JSON.stringify({
                    uid, data: avatar, player: gamePlayer || null, updatedAt: Date.now(),
                  }))
                } catch { /* 落盘失败不影响本次 */ }
              }
            }
          } catch (err) {
            logger.debug?.(`[HoYoGet][zzz_panel] 补评分失败 ${c.name}：${err?.message || err}`)
          }
          await new Promise(resolve => setTimeout(resolve, intervalMs))
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, () => worker()))
      // 重新注入评分
      cards = cards.map(c => {
        const rec = uidRecords.get(c.name)
        return { ...c, equip_score: rec?.score ?? null, equip_rating: rec?.rating ?? null }
      })
    }

    // 获取全角色上线时间排序表
    let ordMap = null
    try {
      const allRoles = await mys.zzz_data('', 'js')
      if (Array.isArray(allRoles)) {
        ordMap = new Map()
        for (const r of allRoles) {
          if (r.name && r._ord != null) ordMap.set(r.name, r._ord)
        }
      }
    } catch { /* 拿不到排序表退化成稀有度+评分排序 */ }

    // 按稀有度(S→A)分组，同组内按上线时间从新到旧（_ord升序），
    // 无上线时间记录的按评分降序兜底
    cards.sort((a, b) => {
      // 稀有度排序：S 在前，A 在后
      if (a.rarity !== b.rarity) return a.rarity === 'S' ? -1 : 1
      // 同稀有度：有 _ord 的按 _ord 升序（值越小越新）
      const oa = ordMap?.get(a.name)
      const ob = ordMap?.get(b.name)
      if (oa != null && ob != null) return oa - ob
      if (oa != null) return -1
      if (ob != null) return 1
      // 都无 _ord，按评分降序兜底
      if (a.equip_score != null && b.equip_score != null) return b.equip_score - a.equip_score
      if (a.equip_score != null) return -1
      if (b.equip_score != null) return 1
      return 0
    })

    // 不再注入排名序号，等以后有群排名数据再加
    // 统计有评分的角色数
    const scoredCount = cards.filter(c => c.equip_score != null).length
    let gamePlayer = null
    try { gamePlayer = await this.fetchPlayer(e, uid, ck) } catch {}
    try {
      const img = await render('zzz_panel/list', {
        cards,
        uid,
        server,
        count: cards.length,
        time: formatNow(),
        bgImage: getPanelBg(),
        ...getPlayerBadge(e, gamePlayer),
      }, { e, ret: true, dsf: ZZZ_PANEL_DSF })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 渲染失败：${err?.message || err}`)
      // 渲染失败兜底：回退成文字列表，至少把数据给到
      const lines = cards.slice(0, 30).map(c => `${c.name} Lv${c.level} ${c.rarity} ${c.element}/${c.type} 影${c.rank}${c.equip_score != null ? ` ${c.equip_score.toFixed(1)}分` : ' 暂无评分'}`)
      return e.reply([
        `面板渲染失败，文字兜底（共 ${cards.length} 名代理人）：`,
        ...lines,
        `原始数据：${basicFile}`,
      ])
    }
  }

  /** 单角色详情：米游社<名字>面板（如 米游社南宫羽面板；旧 米游社面板 <名字> 仍兼容） */
  async panelDetail(e) {
    const msg = String(e.msg || '')
    const m = msg.match(DETAIL_REG) || msg.match(DETAIL_REG_OLD)
    const arg = (m && m[1] ? m[1] : '').trim()
    if (!arg) return this.panelDetailHelp(e)

    const uid = this.getZzzUid(e)
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply('未能取到角色列表，请稍后再试')
    }

    // 解析目标：纯数字=序号（从 1 起）；否则按名字模糊匹配
    let target = null
    if (/^\d+$/.test(arg)) {
      target = list[parseInt(arg, 10) - 1]
    } else {
      const lower = arg.toLowerCase()
      target = list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.full_name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower.slice(0, 1)))
    }
    if (!target || target.id == null) {
      const names = list.slice(0, 12).map((it, i) => `${i + 1}.${it.name_mi18n || it.full_name_mi18n}`).join('  ')
      return e.reply(`没找到「${arg}」。可用序号或名字，例如：\n米游社南宫羽面板\n米游社3面板\n部分角色：${names}`)
    }

    const info = await this.fetchDetail(e, uid, ck, target.id)
    if (info?.__error) return e.reply(info.__error)

    const avatar = this.pickInfo(info?.data)
    if (!avatar) return e.reply('取到详情响应，但没识别到角色数据')

    const detail = normalizeDetail(avatar, uid)
    const charData = detail.charData
    const footer = 'from 米哈游'
    try {
      let gamePlayer = null
      try { gamePlayer = await this.fetchPlayer(e, uid, ck) } catch { /* 取不到游戏昵称就回落 QQ */ }
      /* 右栏配队/排名：工坊接口慢或挂掉时最多等 6 秒，拿不到就不渲染这一块，
         不能让它把整张面板拖到超时 */
      const zzzWorkshop = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 6000)
        zzzPanelExtras({ name: charData.full_name_mi18n || charData.name || avatar?.name_mi18n, uid, level: avatar?.level })
          .then(data => { clearTimeout(timer); resolve(data) })
          .catch(() => { clearTimeout(timer); resolve(null) })
      })
      // 落盘原始面板，供极限面板/排名复用（不依赖 ZZZ-Plugin 的 data/panel）
      try {
        fs.mkdirSync(RECORDS_DIR, { recursive: true })
        // 每角色一个记录文件（<uid>_<角色名>.json）：查新角色不再覆盖旧角色记录，
        // findExtremeRecord 会遍历目录按 name_mi18n 匹配，天然兼容
        const recRole = String(avatar?.name_mi18n || target?.name_mi18n || 'unknown').replace(/[\\/:*?"<>|\s·・]/g, '') || 'unknown'
        fs.writeFileSync(path.join(RECORDS_DIR, `${uid}_${recRole}.json`), JSON.stringify({
          uid,
          data: avatar,
          player: gamePlayer || null,
          updatedAt: Date.now(),
        }))
      } catch (err) {
        logger.debug?.(`[HoYoGet][zzz_panel] 面板记录落盘失败：${err?.message || err}`)
      }
      const img = await render('zzz_panel/detail', { ...detail, footer, zzzWorkshop, appleStyle: panelAppleStyle(), bgImage: getPanelBg(), ...getPlayerBadge(e, gamePlayer) }, { e, ret: true, dsf: ZZZ_PANEL_DSF })
      const sent = img // render(ret:true) 已自动 e.reply 发送，此处仅保留引用供下方缓存使用
      // 缓存面板用的角色原图，供「%原图」直接取回
      const roleIcon = detail.charData?.role_icon
      if (roleIcon) {
        const mid = sent?.message_id || sent?.data?.message_id || sent?.message_id
        if (mid && typeof redis !== 'undefined') {
          redis.set(`ZZZ:PANEL:IMAGE:${mid}`, roleIcon, { EX: 3600 * 3 }).catch(() => {})
        }
        if (typeof redis !== 'undefined') {
          const key = e.group_id
            ? `ZZZ:PANEL:IMAGE:GROUP:${e.group_id}:USER:${e.user_id}`
            : `ZZZ:PANEL:IMAGE:USER:${e.user_id}`
          redis.set(key, roleIcon, { EX: 3600 * 3 }).catch(() => {})
        }
      }
      return sent
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 详情渲染失败：${err?.message || err}`)
      return e.reply([
        `【${charData.full_name_mi18n}】Lv${charData.level} ${charData.rarity} 影${charData.rank}`,
        charData.weapon ? `专武：${charData.weapon.name} Lv${charData.weapon.level}` : '（无专武数据）',
        `详情渲染失败：${err?.message || err}`,
      ])
    }
  }

  /** 把别名/本名解析成资源目录里的正式角色名 */
  resolvePanelRole(raw = '') {
    const clean = String(raw || '').replace(/[「」]/g, '').trim()
    if (!clean) return ''
    const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()
    const localBase = path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel')
    const hasDir = name => CUSTOM_PORTRAIT_DIRS.some(base => fs.existsSync(path.join(base, name)))
    if (hasDir(clean)) return clean
    try {
      const names = yaml.get(path.join(PLUGIN_ROOT, 'system', 'default', 'zzz_js_names.yaml')) || {}
      for (const [formal, aliases] of Object.entries(names)) {
        if (norm(formal) === norm(clean) || (Array.isArray(aliases) && aliases.some(a => norm(a) === norm(clean)))) {
          return formal
        }
      }
    } catch { /* 别名表读不到就只认本名 */ }
    return ''
  }

  async collectPanelImages(e) {
    const images = []
    const push = arr => {
      for (const val of (Array.isArray(arr) ? arr : [])) {
        if (val?.type === 'image') images.push(val)
      }
    }
    push(e.message)
    if (!images.length) {
      try {
        const src = e.getReply ? await e.getReply() : null
        push(src?.message)
      } catch { /* 引用取不到就只认当前消息 */ }
    }
    return images
  }

  /** 上传自定义角色面板图：%上传艾莲面板图（可带图或引用图片） */
  async panelUploadImages(e) {
    if (!e.isMaster) return e.reply('只有主人才能上传面板图')
    const m = String(e.msg || '').match(PANEL_UPLOAD_REG)
    const role = this.resolvePanelRole(m?.[1] || '')
    if (!role) return e.reply('未找到对应角色')
    const images = await this.collectPanelImages(e)
    if (!images.length) return e.reply('消息中未找到图片，请把图片和指令一起发，或引用要添加的图片')
    const dir = path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel', role)
    fs.mkdirSync(dir, { recursive: true })
    let ok = 0, fail = 0
    for (const img of images) {
      try {
        const url = img.url || img.file || ''
        let buf
        if (/^https?:/i.test(url)) {
          const resp = await mhyFetch(url)
          buf = Buffer.from(await resp.arrayBuffer())
        } else {
          const file = String(url).replace(/^file:\/\//, '')
          buf = fs.readFileSync(file)
        }
        const rawName = path.basename(String(img.file || url || '').split('?')[0])
        let ext = (path.extname(rawName) || '.png').toLowerCase()
        if (!/\.(png|jpe?g|webp)$/.test(ext)) ext = '.png'
        let base = path.basename(rawName, path.extname(rawName)) || String(Date.now())
        let target = path.join(dir, `${base}${ext}`)
        if (fs.existsSync(target)) target = path.join(dir, `${base}_${Date.now()}${ext}`)
        fs.writeFileSync(target, buf)
        ok++
      } catch (err) {
        logger.warn?.(`[HoYoGet][zzz_panel] 上传面板图失败：${err?.message || err}`)
        fail++
      }
    }
    return e.reply(`成功上传${ok}张图片，失败${fail}张图片。`)
  }

  /** 查看某角色已上传的面板图，带 ID 便于删除 */
  async panelImageList(e) {
    const m = String(e.msg || '').match(PANEL_IMAGES_REG)
    const role = this.resolvePanelRole(m?.[1] || '')
    if (!role) return e.reply('未找到对应角色')
    const dir = path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel', role)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() } catch { files = [] }
    if (!files.length) return e.reply(`【${role}】还没有上传过面板图`)
    const pageSize = 5
    let page = Number(m?.[2]) || 1
    if (page < 1) page = 1
    const total = Math.ceil(files.length / pageSize)
    if (page > total) return e.reply('哪有这么多图片')
    const slice = files.slice((page - 1) * pageSize, page * pageSize)
    const msg = [`当前页数：${page}，总页数：${total}，查询指定页数请在指令后面加上页码。`]
    slice.forEach((file, i) => {
      const id = (page - 1) * pageSize + i + 1
      msg.push([`ID：${id}`, segment.image(path.join(dir, file))])
    })
    msg.push('删除或添加后会重新排序 ID，删除前请重新查看列表。')
    return e.reply(await makeForwardMsg(e, msg))
  }

  /** 删除自定义面板图：%删除艾莲面板图1,2 */
  async panelDeleteImages(e) {
    if (!e.isMaster) return e.reply('只有主人才能删除面板图')
    const m = String(e.msg || '').match(PANEL_DELETE_IMG_REG)
    const role = this.resolvePanelRole(m?.[1] || '')
    if (!role) return e.reply('未找到对应角色')
    const dir = path.join(PLUGIN_ROOT, 'resources', 'zzz_panel', 'images', 'panel', role)
    let files = []
    try { files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() } catch { files = [] }
    const ids = String(m?.[2] || '').split(/[,，、\s]+/).filter(Boolean)
    const ok = [], fail = []
    for (const id of ids) {
      const idx = Number(id) - 1
      if (!Number.isInteger(idx) || idx < 0 || idx >= files.length) { fail.push(id); continue }
      try { fs.unlinkSync(path.join(dir, files[idx])); ok.push(id) } catch { fail.push(id) }
    }
    return e.reply([`成功删除ID为${ok.join(',') || '无'}的图片`, fail.length ? `删除失败ID为${fail.join(',')}` : '无失败ID'].join('\n'))
  }

  /**
   * 取某角色的极限面板预设。**没有预设就返回 null，由调用方明确报「未配置」**。
   *
   * 以前这里是「找不到就用职业默认值兜底」，但极限面板的语义是理论最优：
   * 兜底出来的是一张「看着完整、实则每盘少两档词条」的面板，比明确报错更糟。
   * 漏配的角色由 tools/ci/extreme-preset-check.mjs 在 CI 里报出来。
   */
  loadExtremePreset(role) {
    try {
      const data = yaml.get(EXTREME_PRESET_FILE) || {}
      const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()
      const want = norm(role)
      for (const [name, preset] of Object.entries(data)) {
        if (norm(name) === want) return preset
      }
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 读极限面板预设失败：${err?.message || err}`)
    }
    return null
  }

  /** ZZZ-Plugin data/panel 的角色属性是 111/121/...，转成本插件 API 的 1/2/... */
  normalizeRecordProps(a) {
    const map = { 111: 1, 121: 2, 131: 3, 122: 4, 201: 5, 211: 6, 314: 7, 312: 8, 231: 9, 305: 11, 232: 232 }
    if (!a || !Array.isArray(a.properties)) return a
    a.properties = a.properties.map(p => {
      const id = Number(p.property_id)
      return map[id] ? { ...p, property_id: map[id] } : p
    })
    return a
  }

  /** 找一份该角色的面板记录：本地优先，过渡期兼容 ZZZ-Plugin 的 data/panel */
  findExtremeRecord(e, role) {
    const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase()
    const want = norm(role)
    const match = a => a && (norm(a.name_mi18n) === want || norm(a.full_name_mi18n) === want)
    const readRecord = file => {
      try {
        const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
        const a = obj?.data || obj
        return match(a) ? this.normalizeRecordProps(a) : null
      } catch { return null }
    }
    const uid = this.getZzzUid(e)
    if (uid) {
      const own = readRecord(path.join(RECORDS_DIR, `${uid}.json`))
      if (own) return own
    }
    try {
      for (const f of fs.readdirSync(RECORDS_DIR).filter(f => f.endsWith('.json'))) {
        const a = readRecord(path.join(RECORDS_DIR, f))
        if (a) return a
      }
    } catch { /* 本地还没有记录 */ }
    try {
      for (const f of fs.readdirSync('./plugins/ZZZ-Plugin/data/panel').filter(f => f.endsWith('.json'))) {
        try {
          const list = JSON.parse(fs.readFileSync(path.join('./plugins/ZZZ-Plugin/data/panel', f), 'utf8'))
          if (Array.isArray(list)) {
            const a = list.find(match)
            if (a) return this.normalizeRecordProps(a)
          }
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 没装 ZZZ-Plugin 就只认本地 */ }
    return null
  }

  /** 理论极限：6 命、技能 16/核心 7、音擎满精满突破、六盘满级 S 且副词条满强化 */
  applyExtremePanel(a, preset = null) {
    const out = JSON.parse(JSON.stringify(a || {}))
    const baseProps = {}
    for (const p of out.properties || []) {
      const m = ZPROP[p.property_id]
      if (m) baseProps[m.k] = { base: p.base }
    }
    const { weight } = getScoreWeight(
      out.name_mi18n || out.full_name_mi18n || '',
      {},
      out.avatar_profession,
      out.element_type,
      baseProps,
    )
    const num = v => {
      const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
      return m ? Number(m[0]) : 0
    }
    const PCT_IDS = [11102, 12102, 13102, 12202, 20103, 21103, 23103]
    const pct = id => [5, 6, 7, 8, 9].includes(Number(id)) || PCT_IDS.includes(Number(id))
      || (Number(id) >= 315 && Number(id) <= 323) || (Number(id) >= 31503 && Number(id) <= 32303)
    const fmt = (id, value) => pct(id) ? `${value.toFixed(1)}%` : (Number(id) === 11 ? value.toFixed(2) : `${Math.round(value)}`)
    const toChar = id => {
      id = Number(id)
      if (id === 11102 || id === 11103) return 1
      if (id === 12102 || id === 12103) return 2
      if (id === 13102 || id === 13103) return 3
      if (id === 12202) return 4
      if (id === 20103) return 5
      if (id === 21103) return 6
      if (id === 31402) return 7
      if (id === 31203) return 8
      if (id === 23103) return 9
      if (id === 23203) return 232
      if (id === 30502) return 11
      if (id >= 31503 && id <= 32303) return Math.trunc(id / 100)
      return null
    }
    const totals = equips => {
      const map = {}
      const add = (id, value) => { if (id != null) map[id] = (map[id] || 0) + value }
      for (const eq of equips || []) {
        // 副词条数组若重复列出主词条会导致预算基数虚高（暴击溢出），按主词条 id 去重
        const mainPid = Number(eq.main_properties?.[0]?.property_id || 0)
        for (const p of [
          ...(eq.main_properties || []),
          ...(eq.properties || []).filter(x => Number(x.property_id) !== mainPid),
        ]) {
          const id = Number(p.property_id), value = num(p.base)
          if (!value) continue
          const cid = toChar(id)
          if (cid == null) continue
          if (id === 11102) add(cid, num(baseProps.hpmax?.base) * value / 100)
          else if (id === 12102) add(cid, num(baseProps.attack?.base) * value / 100)
          else if (id === 13102) add(cid, num(baseProps.def?.base) * value / 100)
          else if (id === 12202) add(cid, num(baseProps.breakstun?.base) * value / 100)
          else if (id === 31402) add(cid, num(baseProps.elementabnormalpower?.base) * value / 100)
          else add(cid, value)
        }
      }
      return map
    }
    const before = totals(out.equip)
    const oldEquip = out.equip || []
    out.level = 60
    out.rank = 6
    if (Array.isArray(out.ranks)) out.ranks = out.ranks.map(v => ({ ...v, is_unlocked: true }))
    if (Array.isArray(out.skills)) {
      out.skills = out.skills.map(v => ({ ...v, level: Number(v.skill_type) === 5 ? 7 : 16 }))
    }
    if (out.weapon) out.weapon = { ...out.weapon, level: 60, star: 5, break_level: 5, rarity: 'S' }
    /* —— 音擎满级的副词条增量 ——
       面板终值里的音擎副词条是按记录当时的武器等级算的（如艾莲深海访客 L50 暴击 15.4%，
       武器副词条本身已加载在面板终值上，不能再整条重复加）。极限面板把音擎顶到 5★ L60，
       满级与记录值之差必须补进面板属性：艾莲 15.4→24 = +8.6 → 非盘暴击恰为 52.0，
       暴击预算 = 48 = 20 档整，正好 100%——即「100−40−12」手算模型的正确落地。 */
    const WEAPON_SUB_MAX = {
      111: 30, 11102: 30,   // 生命值%
      121: 30, 12102: 30,   // 攻击力%
      131: 48, 13102: 48,   // 防御力%
      201: 24, 20103: 24,   // 暴击率
      211: 48, 21103: 48,   // 暴击伤害
      231: 24, 23103: 24,   // 穿透率
    }
    const WEAPON_SUB_CHAR = {
      111: 1, 11102: 1, 121: 2, 12102: 2, 131: 3, 13102: 3,
      201: 5, 20103: 5, 211: 6, 21103: 6, 231: 9, 23103: 9,
    }
    const weaponSubDelta = {}
    for (const p of out.weapon?.properties || []) {
      const pid = Number(p.property_id)
      const max = WEAPON_SUB_MAX[pid]
      if (!max) continue
      const cur = num(p.base ?? p.final ?? p.value)
      if (cur > 0 && max > cur) weaponSubDelta[WEAPON_SUB_CHAR[pid]] = max - cur
    }
    /* —— 双爆全局预算 ——
       先算「去掉旧盘贡献后的暴击率」+ 新主词条暴击，得出到 100% 的缺口，
       暴击率副词条只补缺口（≤6 档/盘），剩余档位全部投给暴伤等词条。
       铁律（用户定）：盘内暴击总额 ≤ 48%——4 号位暴击主 24 时副词条暴击 ≤ 24%（10 档），
       与「补到 100」的缺口取小。 */
    const critProp = (out.properties || []).find(p => (ZPROP[p.property_id] || {}).k === 'crit')
    // before：旧六盘的词条贡献和（键为 toChar 后的属性代号，暴击率 = 5）
    // 非盘暴击 = 面板终值 − 旧盘贡献 + 音擎满级副词条增量（武器副词条已含在终值里，只补成长量）
    const critNoDisc = critProp
      ? num(critProp.final) - Number(before[5] || 0) + Number(weaponSubDelta[5] || 0)
      : Number(weaponSubDelta[5] || 0)
    const mainIds = oldEquip.map(eq => {
      const slot = Number(eq.equipment_type || oldEquip.indexOf(eq) + 1)
      const oldMain = Number(eq.main_properties?.[0]?.property_id || 0)
      /* 1/2/3 号盘的主词条是唯一固定值（1 生命 / 2 攻击 / 3 防御），池里只有一项，
         不存在「按权重挑」的余地；也不能按权重过滤，那会把强攻角色的空盘留下。
         4/5/6 号盘按权重挑最优，权重为 0 的项不参与。 */
      const pool = MAIN_STAT_POOL[slot] || []
      const allowed = slot < 4 ? pool.slice() : pool.filter(id => Number(weight[id] || 0) > 0)
      allowed.sort((x, y) => Number(weight[y] || 0) - Number(weight[x] || 0))
      const presetMain = Number(preset?.drive_main?.[slot] ?? preset?.drive_main?.[String(slot)] ?? 0)
      // 主词条 = 预设（理论最优，人工策展）> 权重自动 > 当前装备。
      // 极限面板的定义就是理论最优：玩家当前戴的主词条再差也不该抄进来
      // （如玩家 5 号位用了穿透，但该角色 4pc冰伤套下理论最优是冰伤主）。
      // 预设 drive_main 就是这套「最优知识」的载体，auto 权重只在预设缺条目时兜底。
      // 但预设必须先过「该槽位合法主词条」校验：6 号盘只有生命/攻击/防御/冲击/回能/异常掌控，
      // 写个暴击伤害上去（21103）游戏里根本出不来，直接采信会凭空多出一条不存在的词条。
      // 1/2/3 号盘的主词条池见 MAIN_STAT_POOL（固定是生命/攻击/防御，分百分比与固定值两版），
      // 叶瞬光这类「补固定值」的预设要保留。
      const presetMainValid = MAIN_STAT_POOL[slot]?.includes(presetMain) ? presetMain : 0
      let mainId = presetMainValid || allowed[0] || oldMain
      // 双爆防溢出：非盘暴击（基础+被动+影画+武器副词条）加暴击主词条已破 100% 时，
      // 4 号位改用暴伤主词条，暴击率缺口留给副词条按预算补。
      // 例：非盘暴击 79.4% + 暴击主 24% = 103.4% 溢出 → 改暴伤主 48%，副词条补暴击到 ~100%。
      if (mainId === 20103 && critNoDisc + 24 > 100
        && allowed.includes(21103) && Number(weight[21103] || 0) > 0) {
        mainId = 21103
      }
      return mainId
    })
    // 暴击副词条预算（档）：
    // 预设 crit_sub（该角色盘内暴击副词条上限 %）优先——面板常驻暴击达标时盘内只补少量暴击、
    // 其余全暴伤（艾莲：武器 24 + 突破 15 + 初始 5 ≈ 49 面板，盘内只给 4.8% = 2 档）。
    // 无该预设时回落通用规则：min(补到 100 的缺口, 盘内总额 48% − 主词条暴击)。
    const presetCritSub = Number(preset?.crit_sub || 0)
    const mainCritTotal = (mainIds || []).filter(id => id === 20103).length * 24
    let critLeft = Number(weight[20103] || 0) > 0
      ? (presetCritSub > 0
          ? Math.floor(presetCritSub / 2.4 + 1e-6)
          : Math.min(
              Math.max(0, Math.floor((100 - critNoDisc - mainCritTotal) / 2.4 + 1e-6)),
              Math.max(0, Math.floor((48 - mainCritTotal) / 2.4 + 1e-6)),
            ))
      : 0
    out.equip = oldEquip.map((eq, idx) => {
      const oldMain = Number(eq.main_properties?.[0]?.property_id || 0)
      const mainId = mainIds[idx] || oldMain
      const mainBase = MAIN_MAX_VALUE[mainId]
        || eq.main_properties?.[0]?.base
        || `${SUB_BASE_VALUE[mainId] || 0}`
      /* 副词条分配（游戏规则：满级 S 盘必有 4 条副词条、共 9 档 = 4 初始 + 5 强化、单条至多 6 档）：
         ① 暴击率只按全局预算拿档（≤6，铺到 100% 即止，绝不超预算）
         ② 先凑满 4 条副词条：暴伤 + 权重最高词条各 1 档起底，权重词条不足 4 条时用其余副词条补位
         ③ 剩余档位「有效词条全中暴伤」（暴伤至多 6 档），满后按档少者优先补
         副词条不与主词条重复（同游戏规则）。 */
      const taken = []
      let left = 9
      const w = id => Number(weight[id] || 0)
      const grab = (id, n) => {
        const k = Math.min(n, left)
        if (k <= 0) return 0
        const t = taken.find(v => v.id === id)
        if (t) t.count += k
        else taken.push({ id, count: k })
        left -= k
        return k
      }
      // 预设 crit_sub 模式：暴击副词条只落在暴伤主盘（4 号位），其余盘零暴击副词、全中暴伤；
      // 通用模式：除暴击主盘外各盘按预算拿档。
      const critOnThisDisc = presetCritSub > 0 ? mainId === 21103 : mainId !== 20103
      /* 预设 sub_layout：角色策展的副词条布局，精确到每盘每条几个档（用户定稿）。
         other = 1/2/3/5/6 号盘；main4 = 4 号（暴伤主）盘，未单列 main4 时回落 other。
         例·艾莲：other = 暴伤×6 + 大攻击 + 小攻击 + 穿透率；main4 = 暴击×2 + 大攻击×2 + 小攻击×2 + 穿透率×3。
         有布局时完全按布局发牌，不再走下面的权重自动分配；没发满的档走通用「全中暴伤」循环。 */
      const layoutKey = mainId === 21103 ? 'main4' : 'other'
      // 只认预设里的逐角色布局。职业兜底（PROF_SUB_LAYOUT）已移除：极限面板的定义是
      // 理论最优，职业级规则只能给「大致合理」的副词条，与其出一张看着完整、
      // 实则每盘少两档的面板，不如明确报「该角色未配置」。
      const rawLayout = preset?.sub_layout?.[layoutKey]
        || (layoutKey === 'main4' ? preset?.sub_layout?.other : null)
      const layout = Array.isArray(rawLayout)
        ? rawLayout.map(it => [
            Number(Array.isArray(it) ? it[0] : it?.id),
            Number(Array.isArray(it) ? it[1] : it?.rolls) || 0,
          ]).filter(([id, n]) => id > 0 && n > 0 && id !== mainId)
        : []
      if (layout.length) {
        for (const [id, n] of layout) {
          if (left <= 0) break
          grab(id, n)
        }
      } else {
      if (critOnThisDisc && critLeft > 0 && w(20103) > 0) {
        critLeft -= grab(20103, Math.min(critLeft, 6))
      }
      if (mainId !== 21103 && w(21103) > 0) grab(21103, 1)
      // 补位顺序：先权重 > 0 的有益词条；不足 4 条时按 攻击力>生命%>防御%>生命 兜底。
      // 20103（暴击率）一律排除——它只允许从上面 ① 的全局预算拿档，
      // 否则预算耗尽后这里会当普通词条再塞档，暴击率重新溢出（103.4% 事故根因）。
      const FILLER_ORDER = [12103, 11102, 13103, 11103]
      for (const ids of [SUB_STAT_IDS, FILLER_ORDER]) {
        for (const id of ids) {
          if (taken.length >= 4 || left <= 0) break
          if (id === mainId || id === 20103 || taken.some(t => t.id === id)) continue
          if (ids === SUB_STAT_IDS && w(id) <= 0) continue
          grab(id, 1)
        }
        if (taken.length >= 4 || left <= 0) break
      }
      }
      // 保 4 条副词条：布局/权重分配后不足 4 条（如 2 号盘主词条是攻击力、布局里的
      // 小攻击与主词条重复被规则跳过）时按权重池补齐。
      // 布局模式放行暴击率兜底（布局无预算概念，量 ≤1 档 2.4%，且是强攻盘的第 2 优有益词条）；
      // 通用模式仍排除 20103——暴击只走 ① 的预算步骤，防 103.4% 溢出回归。
      while (taken.length < 4 && left > 0) {
        const cand = SUB_STAT_IDS.find(id => id !== mainId
          && !taken.some(t => t.id === id) && w(id) > 0
          && (id !== 20103 || layout.length > 0))
        if (!cand) break
        grab(cand, 1)
      }
      while (left > 0) {
        const cd = taken.find(t => t.id === 21103)
        if (mainId !== 21103 && w(21103) > 0 && (!cd || cd.count < 6)) {
          grab(21103, 1)
          continue
        }
        const pool = SUB_STAT_IDS.filter(id => id !== mainId && id !== 20103 && w(id) > 0)
        if (!pool.length) break
        pool.sort((x, y) => ((taken.find(t => t.id === x)?.count || 0) - (taken.find(t => t.id === y)?.count || 0)) || x - y)
        grab(pool[0], 1)
      }
      const props = taken.map(({ id, count }) => ({
        property_name: MAIN_NAME[id] || String(id),
        property_id: id,
        base: fmt(id, (SUB_BASE_VALUE[id] || 0) * count),
        level: count,
        valid: true,
        system_id: Math.trunc(id / 100),
        add: count - 1,
      })).sort((a, b) => {
        // 百分比类（02 结尾 / 战斗属性 03 结尾）排在前，固定值小词条（11103/12103/13103）排在后
        const aPct = a.property_id % 10 === 2 || [20103, 21103, 23103, 23203].includes(a.property_id)
        const bPct = b.property_id % 10 === 2 || [20103, 21103, 23103, 23203].includes(b.property_id)
        if (aPct !== bPct) return aPct ? -1 : 1
        return a.property_id - b.property_id
      })
      return {
        ...eq,
        level: 15,
        rarity: 'S',
        main_properties: [{
          property_name: MAIN_NAME[mainId] || String(mainId),
          property_id: mainId,
          base: mainBase,
          classname: (ZPROP[mainId] || {}).c || 'attack',
          short_name: MAIN_NAME[mainId] || String(mainId),
          level: 1,
          valid: false,
          system_id: 0,
          add: 0,
        }],
        properties: props.length ? props : (eq.properties || []),
        invalid_property_cnt: 0,
        all_hit: true,
      }
    })
    const after = totals(out.equip)
    const delta = {}
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      delta[key] = Number(after[key] || 0) - Number(before[key] || 0)
    }
    out.properties = (out.properties || []).map(p => {
      const id = Number(p.property_id)
      // 总增量 = 盘内新旧差 + 音擎满级副词条成长量（暴击等属性同样走这里）
      const d = Number(delta[id] || 0) + Number(weaponSubDelta[id] || 0)
      if (!d) return p
      const final = num(p.final) + d
      const add = num(p.add) + d
      return { ...p, add: fmt(id, add), final: fmt(id, final) }
    })
    return out
  }

  /** 「%艾莲极限面板」：理论最高值面板 */
  async panelExtreme(e) {
    const m = String(e.msg || '').match(EXTREME_REG)
    // resolvePanelRole 依赖立绘目录/别名表，解析不出时回退用指令原始名查记录
    //（findExtremeRecord 按 name_mi18n 全等匹配，面板详情落盘过即可命中）
    const role = this.resolvePanelRole(m?.[1] || '') || (m?.[1] || '')
    if (!role) return e.reply('未找到对应角色')
    const preset = this.loadExtremePreset(role)
    if (!preset) {
      return e.reply([
        `【${role}】未配置极限面板预设。`,
        '极限面板是逐角色人工策展的（system/default/zzz_extreme.yaml），不再按职业自动推导。',
        '补完该角色条目后即可使用：需要 char_id / weapon_id / drive_main(4,5,6) / sub_layout。',
      ])
    }
    // 完全独立：不读任何面板记录，用本地静态表凭空合成满级底稿。
    // 因此「这个角色我没抽到」也能出图 —— 极限面板要的是理论最优，不是账号现状。
    const built = buildExtremeBase(role, preset)
    if (!built.ok) {
      return e.reply([
        `【${role}】无法生成极限面板：${built.error}`,
        '极限面板完全由本地静态表合成，不再依赖面板记录。',
      ])
    }
    try {
      const raw = this.applyExtremePanel(built.avatar, preset)
      const detail = normalizeDetail(raw, '100000000')
      const img = await render('zzz_panel/detail', {
        ...detail,
        footer: 'from 米哈游 · 理论极限',
        appleStyle: panelAppleStyle(),
        bgImage: getPanelBg(),
        playerName: '理论极限',
        playerAvatar: '',
      }, { e, ret: true, dsf: ZZZ_PANEL_DSF })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 极限面板渲染失败：${err?.message || err}`)
      return e.reply(`极限面板生成失败：${err?.message || err}`)
    }
  }

  /**
   * 「%练度」：当前账号全部代理人的练度统计。
   * 拉一次 avatar/basic 列表，逐角色用本地静态表算驱动盘评分，再按练度分降序。
   * 口径与 ZZZ-Plugin 的 %zzz练度 一致（见 calcProficiency）。
   */
  async panelProficiency(e) {
    const uid = this.getZzzUid(e)
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) return e.reply('没取到代理人列表，请稍后重试或先执行「米游社更新面板」')

    // 逐角色算驱动盘评分 → 练度分
    const rows = list.map(it => {
      const bp = buildBasicProperties(it)
      const equip = (it.equip || []).map(d => ({
        slot: d.equipment_type ?? 0,
        level: d.level ?? 0,
        rarity: d.rarity || 'A',
        main_properties: (d.main_properties || []).map(p => ({ pid: p.property_id })),
        properties: (d.properties || []).map(p => ({ pid: p.property_id, count: p.level ?? 0 })),
      }))
      const scoreStats = {
        atk: parseFloat(bp.attack?.final) || 0,
        crit: toRatio(bp.crit?.final),
        critdmg: toRatio(bp.critdam?.final),
        am: parseFloat(bp.elementabnormalpower?.final) || 0,
        ap: parseFloat(bp.elementmystery?.final) || 0,
      }
      const scoreRes = calcEquipScore(equip, it.name_mi18n || '', scoreStats, it.avatar_profession, it.element_type, bp)
      return {
        name: it.name_mi18n || it.full_name_mi18n || '',
        icon: it.role_square_url || it.role_square_avatar_url || it.skin_list?.find(s2 => s2.unlocked)?.skin_square_url || '',
        rarity: it.rarity || 'A',
        level: it.level ?? 0,
        rank: it.rank ?? 0,
        skills: buildSkillLevels(it),
        weapon: {
          name: it.weapon?.name || '',
          icon: it.weapon?.icon || '',
          rarity: it.weapon?.rarity || '',
          level: it.weapon?.level ?? 0,
          star: it.weapon?.star ?? 0,
        },
        hasWeapon: !!it.weapon,
        equipScore: scoreRes.score,
        equipRating: scoreRes.rating,
        proficiency: calcProficiency(it, scoreRes.score),
        sssDiscs: (scoreRes.discScores || []).filter(v => ['SSS', 'ACE', 'MAX'].includes(discGrade(v))).length,
      }
    })

    rows.sort((a, b) => b.proficiency - a.proficiency)
    rows.forEach((r, i) => { r.rankIndex = i + 1 })

    const weaponCount = rows.filter(r => r.hasWeapon).length
    const sWeaponCount = rows.filter(r => r.hasWeapon && r.weapon.rarity === 'S').length
    const general = {
      total: rows.length,
      SCount: rows.filter(r => r.rarity === 'S').length,
      SWeaponRate: weaponCount ? (sWeaponCount / weaponCount) * 100 : 0,
      highRank: rows.filter(r => r.rank > 4).length,
      sssDiscs: rows.reduce((acc, r) => acc + r.sssDiscs, 0),
    }

    let playerName = ''
    let playerAvatar = ''
    try {
      const p = await this.fetchPlayer(e, uid, ck)
      playerName = p?.nickname || ''
      playerAvatar = p?.avatar || ''
    } catch { /* 玩家信息拿不到不影响出图 */ }

    try {
      const img = await render('zzz_panel/proficiency', {
        uid,
        general,
        rows,
        bgImage: getPanelBg(),
        playerName,
        playerAvatar,
      }, { e, ret: true, dsf: ZZZ_PANEL_DSF })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 练度统计渲染失败：${err?.message || err}`)
      const lines = rows.slice(0, 30).map(r => `#${r.rankIndex} ${r.name} 练度 ${r.proficiency} 驱动 ${r.equipRating} ${r.equipScore.toFixed(1)}分`)
      return e.reply(['练度统计（渲染失败，文字兜底）：', ...lines].join('\n'))
    }
  }

  /** 「%原图」：取回面板实际使用的角色原图（data URI），不是截图 */
  async panelOriginal(e) {
    if (config().zzz_panel_allow_original === false) return e.reply('已禁止获取绝区零面板原图')
    if (!e.isMaster) return e.reply('仅限主人获取绝区零面板原图')
    let id = e.source?.message_id || e.source?.id || ''
    try {
      const src = e.getReply ? await e.getReply() : null
      id = src?.message_id || src?.data?.message_id || id
    } catch { /* 取不到引用就试最近一次 */ }
    let image = ''
    if (id && typeof redis !== 'undefined') image = (await redis.get(`ZZZ:PANEL:IMAGE:${id}`)) || ''
    if (!image && typeof redis !== 'undefined') {
      const key = e.group_id
        ? `ZZZ:PANEL:IMAGE:GROUP:${e.group_id}:USER:${e.user_id}`
        : `ZZZ:PANEL:IMAGE:USER:${e.user_id}`
      image = (await redis.get(key)) || ''
    }
    if (!image) return e.reply('未找到原图，请引用要查看的面板图片')
    return e.reply(segment.image(image))
  }

  /** 详情指令无参时的用法提示 */
  async panelDetailHelp(e) {
    return e.reply([
      '绝区零·单角色面板',
      '用法：%<角色名或序号>面板 或 米游社<角色名或序号>面板',
      '示例：%南宫羽面板 或 米游社南宫羽面板',
      '　　　米游社3面板',
      '（序号看「米游社更新面板」列表从左到右第几个）',
      '',
      '理论极限面板：%艾莲极限面板（6命满精、驱动盘满词条）',
      '取回面板角色原图：%原图（引用面板消息）',
      '上传/查看/删除面板图：%上传艾莲面板图 / %查看艾莲面板图 / %删除艾莲面板图1,2',
      '看某一招的详细计算：米游社<角色>伤害<招数>',
      '示例：米游社艾莲伤害3',
      '　　　米游社艾莲伤害（不带序号＝伤害最高那招）',
    ])
  }

  /**
   * 「米游社<角色>伤害[序号]」—— 某一招的详细计算过程。
   *
   * 序号对应伤害统计表里的行号（与面板上「伤害计算」表的排序一致：期望伤害降序），
   * 省略序号默认第一招（伤害最高的那招）。
   * 面板只能给结果，这个指令把「计算过程」逐项摊开：基础区 → 各乘区 → 最终值，
   * 多段技能还会拆出每一段各自的倍率与乘区。
   */
  async panelDamage(e) {
    const msg = String(e.msg || '')
    const m = msg.match(DAMAGE_REG)
    if (!m) return false
    const arg = (m[1] || '').trim()
    if (!arg) return this.panelDetailHelp(e)

    const uid = this.getZzzUid(e)
    if (!uid) return e.reply('请先绑定绝区零账号')

    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return e.reply('尚未绑定 cookie，请先绑定 cookie 或 #扫码登录')
    }
    const server = await this.pickServer(uid, ck)
    if (!server) return e.reply('未能判断服务器分区（官服 prod_gf_cn / 渠道 prod_qd_cn），请确认绑定信息')

    const raw = await this.fetchRaw(e, uid, server, ck)
    if (raw?.__error) return e.reply(raw.__error)

    const list = this.pickList(raw?.data)
    if (!Array.isArray(list) || !list.length) {
      return e.reply('未能取到角色列表，请稍后再试')
    }

    // 与面板指令同一套解析：纯数字=列表序号，否则按名字模糊匹配
    let target = null
    if (/^\d+$/.test(arg)) {
      target = list[parseInt(arg, 10) - 1]
    } else {
      const lower = arg.toLowerCase()
      target = list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.full_name_mi18n || '').toLowerCase().includes(lower))
        || list.find(it => (it.name_mi18n || '').toLowerCase().includes(lower.slice(0, 1)))
    }
    if (!target || target.id == null) {
      const names = list.slice(0, 12).map((it, i) => `${i + 1}.${it.name_mi18n || it.full_name_mi18n}`).join('  ')
      return e.reply(`没找到「${arg}」。可用序号或名字，例如：\n米游社南宫羽伤害3\n米游社3伤害\n部分角色：${names}`)
    }

    const info = await this.fetchDetail(e, uid, ck, target.id)
    if (info?.__error) return e.reply(info.__error)
    const avatar = this.pickInfo(info?.data)
    if (!avatar) return e.reply('取到详情响应，但没识别到角色数据')

    const detail = normalizeDetail(avatar, uid)
    const charData = detail.charData
    // normalizeDetail 返回 { uid, charData }，damage 挂在 charData 上，不在顶层
    const damage = charData.damage
    if (!damage?.ok) {
      return e.reply(`「${charData.full_name_mi18n || arg}」暂无伤害计算：${damage?.error || '未知原因'}`)
    }

    const skills = damage.skills
    let idx = m[2] ? parseInt(m[2], 10) - 1 : 0
    if (!(idx >= 0) || idx >= skills.length) {
      return e.reply([
        `序号超出范围，当前共 ${skills.length} 招。`,
        `可用序号：${skills.map((_, i) => i + 1).join('、')}`,
        `例如：米游社${charData.full_name_mi18n || arg}伤害${skills.length}`,
      ])
    }
    const cur = skills[idx]
    const footer = 'from 米哈游'
    try {
      const img = await render('zzz_panel/damage', {
        ...detail,
        skills,
        cur,
        curIndex: idx,
        uid,
        command: `米游社${charData.full_name_mi18n || arg}伤害${idx + 1}`,
        footer,
        bgImage: getPanelBg(),
      }, { e, ret: true, dsf: ZZZ_PANEL_DSF })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 伤害详情渲染失败：${err?.message || err}`)
      return e.reply(`「${cur.name}」详细计算渲染失败：${err?.message || err}`)
    }
  }

  /** 取游戏内玩家昵称/头像；接口失败时回落迁移过来的本地 player 数据 */
  async fetchPlayer(e, uid, ck) {
    const server = mhy.getServer(uid, 'zzz')
    // 本地 NoteData 的 role_info 带游戏内头像，优先读，避免多打一次 index 触发风控
    try {
      const note = JSON.parse(fs.readFileSync(`./data/NoteData/zzz/${uid}.json`, 'utf8'))
      for (const year of Object.values(note || {})) {
        for (const month of Object.values(year || {})) {
          const role = month?.role_info
          if (role?.nickname) return { nickname: role.nickname, avatar: role.avatar || '' }
        }
      }
    } catch { /* 没有 NoteData 就继续走接口 */ }
    // index 的 role 也带游戏内头像；getUserGameRolesByCookie 只有昵称
    try {
      let data
      try {
        data = await zzzGet(e, uid, ck, 'index', `lang=zh-cn&role_id=${uid}&server=${server}`)
      } catch (err) {
        /* CK 过期（-100）时用 Stoken 换一个新的再试一次：
           多数用户本机留着 data/Stoken/<QQ>.yaml，不必重新扫码。 */
        if (!/-100|CK 失效/.test(String(err?.message || ''))) throw err
        const fresh = await refreshCkByStoken(e?.user_id, uid)
        if (!fresh) throw err
        data = await zzzGet(e, uid, fresh, 'index', `lang=zh-cn&role_id=${uid}&server=${server}`)
      }
      /* 实测 index 返回的字段：
           data.cur_head_icon_url  玩家当前头像（顶层，不在 role 里）
           data.stats              含 nickname 等基础信息？—— 昵称优先从 role 取
         之前只读 data.role.avatar，实际 role 不存在/无该字段，导致头像恒为空。 */
      /* index 只稳定提供头像（data.cur_head_icon_url），
         实测没有昵称（stats 里是活跃天数/绳网等级之类）。
         昵称改由后面的「绑定角色列表」接口补，两者拼一起返回。 */
      const headIcon = data?.cur_head_icon_url || ''
      const role = data?.role || data?.role_basic_info || {}
      const nickname = role.nickname || data?.nickname || ''
      /* 头像与昵称来自不同接口：
           index → cur_head_icon_url（头像）
           user  → nickname（昵称）
         缺哪个补哪个，两个都没有才继续往下回落。 */
      let finalNick = nickname
      if (!finalNick) {
        try {
          const q = `game_biz=nap_cn&region=${server}&game_uid=${uid}`
          const u = await zzzGet(e, uid, ck, 'user', q)
          const pl = u?.list?.find(p => String(p.game_uid) === String(uid)) || u?.list?.[0]
          if (pl?.nickname) finalNick = pl.nickname
        } catch (_) { /* 补昵称失败不影响头像 */ }
      }
      if (finalNick || headIcon) {
        return {
          nickname: finalNick || '',
          avatar: headIcon || role.avatar || role.avatar_url || role.icon || '',
        }
      }
    } catch (err) {
      logger.debug?.(`[HoYoGet][zzz_panel] index 玩家信息获取失败：${err?.message || err}`)
    }
    try {
      const query = `game_biz=nap_cn&region=${server}&game_uid=${uid}`
      const data = await zzzGet(e, uid, ck, 'user', query)
      const player = data?.list?.find(p => String(p.game_uid) === String(uid)) || data?.list?.[0]
      if (player?.nickname) return player
    } catch (err) {
      logger.debug?.(`[HoYoGet][zzz_panel] 游戏玩家信息获取失败，回落本地/QQ：${err?.message || err}`)
    }
    for (const file of [
      `./plugins/HoYoGet-Plugin/data/zzz_gacha/zzz_plugin/player/${uid}.json`,
      `./plugins/ZZZ-Plugin/data/player/${uid}.json`,
    ]) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (j?.nickname) return { nickname: j.nickname, avatar: j.gameAvatar || j.avatar || '' }
      } catch { /* 试下一个 */ }
    }
    return null
  }

  /** 取单角色详情接口 avatar/info，原样返回 data（契约同 fetchRaw） */
  async fetchDetail(e, uid, ck, id) {
    try {
      const server = mhy.getServer(uid, 'zzz')
      /* need_wiki 必须为 true：实测 need_wiki=false 时米游社只返回驱动盘基础信息，
         equip 的 properties/main_properties 全为空（invalid_property_cnt 却仍有值），
         评分因此缺副词条、明显偏低。改成 true 才会返回完整主/副词条。 */
      const query = `lang=zh-cn&role_id=${uid}&server=${server}&need_wiki=true&id_list[]=${id}`
      const data = await zzzGet(e, uid, ck, 'info', query)
      if (!data) return { __error: '单角色详情为空，请稍后重试' }
      return { data }
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 详情取数失败：${err?.message || err}`)
      return { __error: `详情取数失败：${err?.message || err}` }
    }
  }

  /** 从详情响应里取首角色对象，兼容多种包裹结构 */
  pickInfo(data) {
    if (!data || typeof data !== 'object') return null
    if (Array.isArray(data.avatar_list) && data.avatar_list[0]) return data.avatar_list[0]
    if (Array.isArray(data.list) && data.list[0]) return data.list[0]
    if (Array.isArray(data)) return data[0]
    return null
  }

  /** UID：优先 genshin User，缺失时从本插件 Stoken 兜底 */
  zzzRemindDefaults() {
    const cfg = config() || {}
    return {
      enable: cfg.zzz_remind_enable !== false,
      globalRemindTime: cfg.zzz_remind_time || '每日20时',
      abyssCheckLevel: Number(cfg.zzz_remind_abyss_level ?? 5),
      deadlyStars: Number(cfg.zzz_remind_deadly_stars ?? 6),
    }
  }

  async zzzRemindUserConfig(userId) {
    try {
      const raw = await redis.hGet('ZZZ:REMIND:USER_CONFIGS', String(userId))
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  async zzzRemindSaveUserConfig(userId, value) {
    try { await redis.hSet('ZZZ:REMIND:USER_CONFIGS', String(userId), JSON.stringify(value)) } catch { /* Redis 不可用就只影响本次 */ }
  }

  zzzRemindParseTime(message = '') {
    const m = String(message).match(/提醒时间\s*(每日\d+时(?:(\d+)分)?|每周.\d+时(?:(\d+)分)?)/)
    if (!m) return { remindTime: '', error: '时间格式错误' }
    const remindTime = m[1]
    const minute = Number(m[2]) || Number(m[3]) || 0
    if (!(minute % 10 === 0 && minute >= 0 && minute < 60)) return { remindTime: '', error: '分钟必须为整十分钟' }
    return { remindTime, error: '' }
  }

  zzzRemindTimeMatch(remindTime, date = new Date()) {
    if (!remindTime) return false
    const hour = date.getHours(), minute = date.getMinutes()
    if (remindTime.includes('每日')) {
      const m = remindTime.match(/每日(\d+)时(?:(\d+)分)?/)
      return !!m && hour === Number(m[1]) && minute === (m[2] ? Number(m[2]) : 0)
    }
    if (remindTime.includes('每周')) {
      const dayMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
      const m = remindTime.match(/每周(.)(\d+)时(?:(\d+)分)?/)
      return !!m && date.getDay() === dayMap[m[1]] && hour === Number(m[2]) && minute === (m[3] ? Number(m[3]) : 0)
    }
    return false
  }

  zzzRemindRemaining({ year, month, day, hour = 0, minute = 0, second = 0 }) {
    const target = new Date(year, month - 1, day, hour, minute, second)
    const diff = target.getTime() - Date.now()
    if (diff <= 0) return { days: 0, hours: 0 }
    const total = Math.floor(diff / 3600000)
    return { days: Math.floor(total / 24), hours: total % 24 }
  }

  /**
   * 直接取挑战接口原始响应（式舆 / 危局，含往期）。
   * zzzGet 是模块内函数，这里包一层的目的是给 zzz_challenge 复用，
   * 免得把取数逻辑抄第二遍。
   */
  async zzzGetRaw(e, uid, ck, type, query) {
    return zzzGet(e, uid, ck, type, query)
  }

  async zzzRemindFetch(e, uid, ck, type) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    if (type === 'challenge') {
      return zzzGet(e, uid, ck, 'challenge', `lang=zh-cn&role_id=${uid}&server=${server}&schedule_type=1`)
    }
    return zzzGet(e, uid, ck, 'deadly', `lang=zh-cn&uid=${uid}&region=${server}&schedule_type=1`)
  }

  async zzzRemindCheckUser(userId, userConfig, showAll = false, contextE = null) {
    const def = this.zzzRemindDefaults()
    let abyssCheckLevel = Number(userConfig?.abyssCheckLevel ?? def.abyssCheckLevel)
    if (abyssCheckLevel > 6) abyssCheckLevel = 5
    const deadlyStars = Number(userConfig?.deadlyStars ?? def.deadlyStars)
    if (abyssCheckLevel === 0 && deadlyStars === 0 && !showAll) return []
    const e = contextE || this.e
    const uid = this.getZzzUid(e)
    if (!uid) return ['未绑定绝区零账号']
    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) return ['尚未绑定 cookie']
    const messages = []
    if (showAll || abyssCheckLevel > 0) {
      try {
        const raw = await this.zzzRemindFetch(e, uid, ck, 'challenge')
        const data = raw?.hadal_info_v2
        if (!data) {
          messages.push('式舆防卫战S评级: 0/5')
        } else {
          const fifth = data.brief?.rating || ''
          const floors = ['first', 'second', 'third', 'fourth']
          let sCount = fifth.startsWith('S') ? 1 : 0
          for (const floor of floors) if (data[`${floor}_layer_detail`]?.rating === 'S') sCount++
          if (abyssCheckLevel === 0) {
            if (showAll) {
              messages.push(`式舆防卫战S评级: ${sCount}/5`)
              messages.push(`第五层评价: ${fifth || '无'}`)
            }
          } else if (abyssCheckLevel < 6) {
            const ok = sCount >= abyssCheckLevel ? ' ✓' : ''
            if (showAll || sCount < abyssCheckLevel) {
              messages.push(`式舆防卫战S评级: ${sCount}/5${ok}`)
              if (fifth) messages.push(`第五层评价: ${fifth}`)
            }
          } else {
            const ok = fifth === 'S+' ? ' ✓' : ''
            if (showAll || sCount < 5 || fifth !== 'S+') {
              messages.push(`式舆防卫战S评级: ${sCount}/5${ok}`)
              messages.push(`第五层评价: ${fifth || '无'}${ok}`)
            }
          }
          if (data.hadal_begin_time && data.hadal_end_time) {
            const b = data.hadal_begin_time, en = data.hadal_end_time
            const left = this.zzzRemindRemaining(en)
            messages.push(`统计周期：${b.year}/${b.month}/${b.day} - ${en.year}/${en.month}/${en.day}`)
            messages.push(`刷新剩余: ${left.days}天${left.hours}小时`)
          }
        }
      } catch (err) {
        messages.push(`式舆防卫战查询失败: ${err?.message || err}`)
      }
    }
    if (showAll || deadlyStars > 0) {
      try {
        const raw = await this.zzzRemindFetch(e, uid, ck, 'deadly')
        if (!raw || !raw.has_data) {
          messages.push('危局强袭战星数: 0/9')
        } else {
          const total = Number(raw.total_star || 0)
          const ok = total >= deadlyStars ? ' ✓' : ''
          if (showAll || (deadlyStars > 0 && total < deadlyStars)) {
            messages.push(`危局强袭战星数: ${total}/9${deadlyStars > 0 ? ok : ''}`)
          }
          if (raw.start_time && raw.end_time) {
            const s = raw.start_time, en = raw.end_time
            const left = this.zzzRemindRemaining(en)
            messages.push(`统计周期：${s.year}/${s.month}/${s.day} - ${en.year}/${en.month}/${en.day}`)
            messages.push(`刷新剩余: ${left.days}天${left.hours}小时`)
          }
        }
      } catch (err) {
        messages.push(`危局强袭战查询失败: ${err?.message || err}`)
      }
    }
    return messages
  }

  async zzzRemindToggle(e) {
    const def = this.zzzRemindDefaults()
    if (!def.enable) return e.reply('当前未启用挑战提醒功能')
    if (typeof Bot !== 'undefined' && Bot.fl && !Bot.fl.get(e.user_id)) return e.reply('请先添加 Bot 好友后重试')
    const enable = /开启挑战提醒$/.test(e.msg)
    const uid = this.getZzzUid(e)
    if (enable && !uid) return e.reply('未绑定绝区零账号，请先绑定')
    let cfg = await this.zzzRemindUserConfig(e.user_id)
    if (!cfg) cfg = { enable: false, abyssCheckLevel: def.abyssCheckLevel, deadlyStars: def.deadlyStars }
    if (cfg.enable === enable) return e.reply(enable ? '提醒已开启，请勿重复操作' : '提醒功能尚未开启')
    cfg.enable = enable
    await this.zzzRemindSaveUserConfig(e.user_id, cfg)
    const abyss = cfg.abyssCheckLevel === 0 ? '式舆不提醒' : `防卫战S层数<${Math.min(5, cfg.abyssCheckLevel)}${cfg.abyssCheckLevel === 6 ? '或第五层<S+' : ''}`
    const deadly = cfg.deadlyStars === 0 ? '危局不提醒' : `危局<${cfg.deadlyStars}星`
    return e.reply(`提醒功能已${enable ? '开启' : '关闭'}${enable ? `，将在${cfg.remindTime || def.globalRemindTime}提醒：${abyss}，${deadly}` : ''}`)
  }

  async zzzRemindGlobalToggle(e) {
    if (!e.isMaster) return e.reply('仅限主人设置')
    const enable = /(开启|启用)全局挑战提醒$/.test(e.msg)
    yaml.setValue('./plugins/HoYoGet-Plugin/config/config.yaml', 'zzz_remind_enable', enable)
    return e.reply(`全局挑战提醒已${enable ? '启用' : '禁用'}${enable ? '（定时任务需重启后注册）' : '（重启后完全停止）'}`)
  }

  async zzzRemindAbyssThreshold(e) {
    const isGlobal = String(e.msg).includes('全局')
    if (isGlobal && !e.isMaster) return e.reply('仅限主人设置')
    const m = String(e.msg).match(REMIND_ABYSS_REG)
    const n = Number(m?.[2])
    if (!Number.isInteger(n) || n < 0 || n > 6) return e.reply('防卫战阈值必须在 0~6 之间，0 为不提醒')
    if (isGlobal) {
      yaml.setValue('./plugins/HoYoGet-Plugin/config/config.yaml', 'zzz_remind_abyss_level', n)
    } else {
      const def = this.zzzRemindDefaults()
      let cfg = await this.zzzRemindUserConfig(e.user_id) || { enable: false, abyssCheckLevel: def.abyssCheckLevel, deadlyStars: def.deadlyStars }
      cfg.abyssCheckLevel = n
      await this.zzzRemindSaveUserConfig(e.user_id, cfg)
    }
    return e.reply(`${isGlobal ? '全局默认' : ''}式舆提醒${n === 0 ? '已关闭' : `阈值设为 S 层数<${Math.min(5, n)}${n === 6 ? '或第五层<S+' : ''}`}`)
  }

  async zzzRemindDeadlyThreshold(e) {
    const isGlobal = String(e.msg).includes('全局')
    if (isGlobal && !e.isMaster) return e.reply('仅限主人设置')
    const m = String(e.msg).match(REMIND_DEADLY_REG)
    const n = Number(m?.[2])
    if (!Number.isInteger(n) || n < 0 || n > 9) return e.reply('危局阈值必须在 0~9 之间，0 为不提醒')
    if (isGlobal) {
      yaml.setValue('./plugins/HoYoGet-Plugin/config/config.yaml', 'zzz_remind_deadly_stars', n)
    } else {
      const def = this.zzzRemindDefaults()
      let cfg = await this.zzzRemindUserConfig(e.user_id) || { enable: false, abyssCheckLevel: def.abyssCheckLevel, deadlyStars: def.deadlyStars }
      cfg.deadlyStars = n
      await this.zzzRemindSaveUserConfig(e.user_id, cfg)
    }
    return e.reply(`${isGlobal ? '全局默认' : ''}危局提醒${n === 0 ? '已关闭' : `阈值设为 <${n} 星`}`)
  }

  async zzzRemindStatus(e) {
    const uid = this.getZzzUid(e)
    if (!uid) return e.reply('未绑定绝区零账号')
    const def = this.zzzRemindDefaults()
    const cfg = await this.zzzRemindUserConfig(e.user_id) || { enable: false, abyssCheckLevel: def.abyssCheckLevel, deadlyStars: def.deadlyStars }
    await e.reply('正在查询，请稍候...')
    const messages = await this.zzzRemindCheckUser(e.user_id, cfg, true, e)
    return e.reply(messages.length ? messages.join('\n') : '查询失败，请稍后再试')
  }

  async zzzRemindSetMyTime(e) {
    const { remindTime, error } = this.zzzRemindParseTime(e.msg)
    if (!remindTime) return e.reply(error || '时间格式错误')
    const def = this.zzzRemindDefaults()
    let cfg = await this.zzzRemindUserConfig(e.user_id) || { enable: false, abyssCheckLevel: def.abyssCheckLevel, deadlyStars: def.deadlyStars }
    cfg.remindTime = remindTime
    await this.zzzRemindSaveUserConfig(e.user_id, cfg)
    return e.reply(`个人提醒时间已设为：${remindTime}`)
  }

  async zzzRemindViewMyTime(e) {
    const cfg = await this.zzzRemindUserConfig(e.user_id)
    const def = this.zzzRemindDefaults()
    if (!cfg?.remindTime) return e.reply(`未设置个人提醒时间，使用全局默认：${def.globalRemindTime}`)
    return e.reply(`个人提醒时间：${cfg.remindTime}`)
  }

  async zzzRemindDeleteMyTime(e) {
    const cfg = await this.zzzRemindUserConfig(e.user_id)
    if (!cfg?.remindTime) return e.reply('未设置个人提醒时间')
    delete cfg.remindTime
    await this.zzzRemindSaveUserConfig(e.user_id, cfg)
    return e.reply('已恢复使用全局提醒时间')
  }

  async zzzRemindSetGlobalTime(e) {
    if (!e.isMaster) return e.reply('仅限主人设置')
    const { remindTime, error } = this.zzzRemindParseTime(e.msg)
    if (!remindTime) return e.reply(error || '时间格式错误')
    yaml.setValue('./plugins/HoYoGet-Plugin/config/config.yaml', 'zzz_remind_time', remindTime)
    return e.reply(`全局提醒时间已设为：${remindTime}`)
  }

  async zzzRemindViewGlobalTime(e) {
    return e.reply(`全局提醒时间：${this.zzzRemindDefaults().globalRemindTime}`)
  }

  async runZzzRemindTask() {
    const def = this.zzzRemindDefaults()
    if (!def.enable) return
    let configs = {}
    try { configs = await redis.hGetAll('ZZZ:REMIND:USER_CONFIGS') } catch { return }
    if (!configs || !Object.keys(configs).length) return
    const now = new Date()
    for (const [userId, raw] of Object.entries(configs)) {
      let cfg
      try { cfg = JSON.parse(raw) } catch { continue }
      if (!cfg?.enable) continue
      if (typeof Bot === 'undefined' || !Bot.fl?.get(Number(userId))) continue
      const remindTime = cfg.remindTime || def.globalRemindTime
      if (!this.zzzRemindTimeMatch(remindTime, now)) continue
      const mock = { user_id: Number(userId), game: 'zzz', reply: () => {} }
      const messages = await this.zzzRemindCheckUser(userId, cfg, false, mock)
      if (!messages.length) continue
      await Bot.pickFriend(Number(userId)).sendMsg(`【式舆/危局挑战提醒】\n${messages.join('\n')}`).catch(err => {
        logger.error?.(`[HoYoGet][zzz_remind] 推送失败：${err?.message || err}`)
      })
    }
  }

  getZzzUid(e) {
    const uid = e.user?.getUid?.('zzz')
    if (uid) return uid
    const hit = findZzzStokenEntry(e.user_id)
    return hit ? (hit[1]?.uid || hit[0]) : null
  }

  /**
   * 取 ck：ZZZ-Plugin -> 本插件 Stoken -> genshin NoteUser，依次兜底。
   * 这样即使 ZZZ-Plugin 被删除，面板仍能用迁移过来的 CK 取数。
   */
  async getCk(e, uid = this.getZzzUid(e)) {
    // 1) ZZZ-Plugin（完整 CK 最稳）
    try {
      const { getCk } = await import(path.join(ZZZ_ROOT, 'dist', 'lib', 'common.js'))
      const ck = await getCk(e)
      if (ck && Object.values(ck).some(item => item?.ck)) return enrichCkDevice(ck)
    } catch { /* 没装 ZZZ-Plugin 就继续 */ }

    // 2) 本插件 data/Stoken（迁移过来的 CK）
    const hit = findZzzStokenEntry(e.user_id, uid)
    const stokenCk = hit ? (() => {
      const [key, entry] = hit
      return {
        default: {
          ck: entry.ck_stoken,
          uid: String(entry.uid || key),
          ltuid: String(entry.stuid || ''),
          device_id: entry.device_id || entry.device || '',
        },
      }
    })() : null
    // 完整 cookie 优先；只有 stoken 的条目先留给 genshin，失败后再兜底
    if (stokenCk && /cookie_token=/.test(stokenCk.default.ck)) return enrichCkDevice(stokenCk)

    // 3) genshin NoteUser
    try {
      const { loadGenshinModule } = await import('../../system/genshin_loader.js')
      const NoteUser = await loadGenshinModule('model/mys/NoteUser.js', ['model/mys/NoteUser.js'])
      const user = await NoteUser?.create?.(e)
      const mys = user?.getMysUser?.('zzz')
      if (mys?.ck) {
        return enrichCkDevice({
          default: {
            ck: mys.ck,
            uid: String(uid || mys.uid || ''),
            ltuid: String(mys.ltuid || ''),
            device_id: mys.device || '',
          },
        })
      }
    } catch (err) {
      logger.debug?.(`[HoYoGet][zzz_panel] genshin NoteUser 兜底失败：${err?.message || err}`)
    }

    // 4) 最后再用 Stoken（可能只有 stuid/stoken）
    if (stokenCk) return enrichCkDevice(stokenCk)
    logger.warn?.('[HoYoGet][zzz_panel] 没有可用 CK（ZZZ-Plugin / Stoken / genshin 均失败）')
    return false
  }

  /**
   * 判分区：ZZZ-Plugin 用的是 uid 尾号之外的信息，这里不照抄它的判定，
   * 只按「绑定信息里带不含渠道服标记」这一条最直接的依据取。
   * 还没用真实数据验证过 —— 若拿不到，见下方 TODO 注释里的兜底。
   */
  async pickServer(uid, ck) {
    const hit = Object.values(ck || {}).find(item => item?.ck && String(item.uid) === String(uid))
    if (hit?.server) return hit.server
    // TODO: 还没确认绑定信息里是否带 server 字段。若不带，再按 uid 所属渠道判断，
    // 或直接让用户在 config 里配。**不要**凭猜测写死。
    return 'prod_gf_cn'
  }

  /**
   * 打一次角色列表接口，原样返回 data 部分，不做归一化。
   *
   * 契约（本插件 system/api.js 的 ZZZ record 接口）：
   *   1. api() 内部会处理 1034/10035 过码链；
   *   2. 成功返回 **res.data**；
   *   3. 失败返回错误字符串或空数据，由调用方转成 __error。
   */
  async fetchRaw(e, uid, server, ck) {
    try {
      const query = `lang=zh-cn&role_id=${uid}&server=${server}`
      const data = await zzzGet(e, uid, ck, 'list', query)
      if (!data) return { __error: '接口未返回数据，请稍后重试' }
      return { retcode: 0, data, __fp: true }
    } catch (err) {
      logger.error?.(`[HoYoGet][zzz_panel] 取数失败：${err?.message || err}`)
      return { __error: `取数失败：${err?.message || err}` }
    }
  }

  /** 只做「哪个数组像是角色列表」的定位，不做字段含义判断 */
  pickList(data) {
    if (Array.isArray(data)) return data
    if (!data || typeof data !== 'object') return null
    for (const key of [ 'list', 'avatars', 'avatar_list' ]) {
      if (Array.isArray(data[key])) return data[key]
    }
    // 兜底：找出第一个元素是对象的数组
    for (const val of Object.values(data)) {
      if (Array.isArray(val) && val.length && typeof val[0] === 'object') return val
    }
    return null
  }
}
