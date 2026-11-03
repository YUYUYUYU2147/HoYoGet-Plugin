/**
 * 原神角色总览与练度
 *
 * 数据来自米游社战绩接口（character/list 与 character/detail）。
 * 凭证、设备指纹、DS 签名全部走插件已有通道：
 *   CK      ck_store 里当前 QQ 绑定的账号（ck_stoken 是完整 cookie），
 *           其次 genshin 插件的 MysUsers，最后是 ck_store 里任意原神账号。
 *           查询他人 UID 时读的是公开战绩，任意有效 CK 都可以。
 *   headers mhy.getHeaders 会按 QQ 读 data/fp/<qq>.yaml 带设备指纹，
 *           DS 取默认 DS1 —— 实测 character/list 与 character/detail 接受 DS1。
 *
 * 接口开销：列表一次请求，详情按 20 个一批。列表缓存 10 分钟、详情缓存 1 小时，
 * 避免每次 #练度 都把全部角色重新拉一遍。
 */

import fs from 'node:fs'
import { getGenshinCks, mhy, mhyFetch, pluginPriority, render } from '#HoYoGet'
import { ArtifactSet, Character, Weapon } from '#hoyo.miao.models'
import { miaoPath } from '#hoyo.miao.path'
import { getAccount, listAccounts } from '../../system/ck_store.js'
import { getRoleProfile } from '../../system/roleProfile.js'

const HOST = 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api/'
const LIST_TTL = 10 * 60
const DETAIL_TTL = 60 * 60
const BATCH_SIZE = 20
const TIMEOUT = 15000
/* 这些 retcode 说明是 CK 侧的问题，换下一个 CK 重试；其余按业务错误直接回报 */
const CK_RETRY_CODES = [-100, -101, 10001, 5003, 1034]

const ELEMENT_CN = {
  Pyro: '火', Hydro: '水', Dendro: '草', Electro: '雷', Cryo: '冰', Anemo: '风', Geo: '岩',
}
const ELEMENT_KEY = {
  Pyro: 'pyro', Hydro: 'hydro', Dendro: 'dendro', Electro: 'electro', Cryo: 'cryo', Anemo: 'anemo', Geo: 'geo',
}

/** 取消息归属的 QQ：支持 #角色 @某人 */
function qqOf(e) {
  const at = String(e?.at || '').match(/\d{5,}/)
  if (at) return at[0]
  return String(e?.user_id || e?.sender?.user_id || '')
}

/** 从存档条目拼出可用 cookie；ck_stoken 已是完整串时直接使用 */
function cookieOf(acc) {
  if (!acc) return ''
  const ck = String(acc.ck_stoken || '')
  if (/ltoken=/.test(ck) && /cookie_token=/.test(ck)) return ck
  const parts = []
  if (acc.stuid) parts.push(`ltuid=${acc.stuid}`)
  if (acc.ltoken) parts.push(`ltoken=${acc.ltoken}`)
  if (ck) parts.push(ck)
  return parts.join('; ')
}

/**
 * 组装候选 CK，按优先级去重。
 * 目标 UID 对应的账号排最前：查自己时用本人的 CK，查他人时本人 CK 也能读公开战绩。
 */
async function collectCks(e, uid) {
  const qq = qqOf(e)
  const list = []
  const push = ck => {
    const val = String(ck || '').trim()
    if (!val || list.includes(val)) return
    list.push(val)
  }

  push(cookieOf(getAccount(qq, uid)))
  try {
    for (const row of await getGenshinCks()) push(row?.ck)
  } catch { /* 未安装 genshin 插件时忽略 */ }
  try {
    for (const row of listAccounts({ game: 'gs' })) {
      if (row.uid === String(uid)) push(cookieOf(getAccount(row.qq, row.uid)))
    }
    for (const row of listAccounts({ game: 'gs' })) push(cookieOf(getAccount(row.qq, row.uid)))
  } catch { /* 存档读取失败时只用前面的候选 */ }
  return list
}

/** 解析目标 UID：消息内显式数字 → 当前 QQ 绑定的原神账号 → e.uid */
function resolveUid(e) {
  const msg = String(e?.msg || '')
  const explicit = msg.match(/\b([1-9]\d{8,9})\b/)
  if (explicit) return explicit[1]
  const qq = qqOf(e)
  const rows = listAccounts({ game: 'gs', qq })
  const own = rows.find(row => row.qq === qq)
  if (own) return own.uid
  const byE = String(e?.uid || '').trim()
  if (/^[1-9]\d{8,9}$/.test(byE)) return byE
  return ''
}

function serverOf(uid) {
  try {
    const server = mhy.getServer(String(uid), 'gs')
    if (server) return server
  } catch { /* 号段兜底 */ }
  return String(uid).startsWith('5') ? 'cn_qd01' : 'cn_gf01'
}

async function postOnce(e, ck, apiName, payload) {
  const body = JSON.stringify(payload)
  const headers = mhy.getHeaders(e, ck)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const resp = await mhyFetch(HOST + apiName, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    const text = await resp.text()
    try {
      return JSON.parse(text)
    } catch {
      return { retcode: -500, message: `接口返回非 JSON（HTTP ${resp.status}）` }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 依次尝试候选 CK；只有 CK 类错误才继续下一个 */
async function requestRecord(e, cks, apiName, payload) {
  let last = null
  for (const ck of cks) {
    let res = null
    try {
      res = await postOnce(e, ck, apiName, payload)
    } catch (err) {
      last = { retcode: -1, message: `请求失败：${err?.message || err}` }
      continue
    }
    if (Number(res?.retcode) === 0) return { data: res.data }
    last = res
    if (!CK_RETRY_CODES.includes(Number(res?.retcode))) break
  }
  const code = Number(last?.retcode)
  if (code === -501002) return { error: '米游社未公开该账号的游戏数据，请到米游社-我的-设置里开启「游戏数据公开」' }
  if (code === 10041) return { error: '设备指纹未通过（10041），请发送「#设备绑定」后再试' }
  if (code === 1034 || code === 10035) return { error: '米游社要求验证码，请稍后重试或先发送「#设备帮助」绑定常用设备' }
  if (CK_RETRY_CODES.includes(code)) return { error: 'Cookie 已失效，请发送「#刷新ck」或「#扫码登录」后重试' }
  const reason = last?.message ? `${last.message}（${last.retcode}）` : '米游社接口没有返回数据'
  return { error: reason }
}

const cacheKey = (name, uid) => `HoYoGet:gs:role:${name}:${uid}`

async function cacheGet(key) {
  try {
    const raw = await redis.get(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

async function cacheSet(key, data, ttl) {
  try {
    await redis.set(key, JSON.stringify(data), { EX: ttl })
  } catch { /* 缓存不可用不影响查询 */ }
}

async function fetchRoleList(e, cks, uid) {
  const key = cacheKey('list', uid)
  const hit = await cacheGet(key)
  if (hit?.list?.length) return hit
  const { data, error } = await requestRecord(e, cks, 'character/list', {
    role_id: String(uid),
    server: serverOf(uid),
  })
  if (error) return { error }
  if (!data?.list?.length) return { error: '接口没有返回角色，请确认该 UID 已开启战绩公开' }
  const out = { list: data.list, at: Date.now() }
  await cacheSet(key, out, LIST_TTL)
  return out
}

async function fetchRoleDetails(e, cks, uid, ids) {
  const key = cacheKey('detail', uid)
  const hit = await cacheGet(key)
  const map = hit?.map || {}
  const missing = ids.filter(id => !map[id])
  if (missing.length) {
    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const slice = missing.slice(i, i + BATCH_SIZE)
      const { data } = await requestRecord(e, cks, 'character/detail', {
        role_id: String(uid),
        server: serverOf(uid),
        character_ids: slice,
      })
      for (const item of data?.list || []) {
        if (item?.base?.id) map[item.base.id] = item
      }
    }
    await cacheSet(key, { map, at: Date.now() }, DETAIL_TTL)
  }
  return map
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI']

/** 数字展示：缺失显示 -，zeroAsDash 时 0 也显示 -（神瞳/宝箱 0 就是没有） */
function statText(v, zeroAsDash) {
  if (v === undefined || v === null || v === '') return '-'
  if (zeroAsDash && Number(v) === 0) return '-'
  return String(v)
}

/** 米游社战绩页的那组数据，全部来自 index 的 data.stats */
function buildBoard(stats) {
  const s = stats || {}
  if (!Object.keys(s).length) return null
  const rc = s.role_combat || {}
  const hc = s.hard_challenge || {}
  return {
    top: [
      { label: '活跃天数', value: statText(s.active_day_number) },
      { label: '深境螺旋', value: statText(s.spiral_abyss) },
      { label: '幻想真境剧诗', value: rc.has_data ? statText(rc.max_round_id) : '-' },
    ],
    grid: [
      { label: '获得角色数', value: statText(s.avatar_number) },
      { label: '满好感角色数', value: statText(s.full_fetter_avatar_num) },
      { label: '成就达成数', value: statText(s.achievement_number) },
      { label: '幽境危战', value: hc.has_data ? (ROMAN[Number(hc.difficulty)] || statText(hc.difficulty)) : '-' },
      { label: '解锁传送点', value: statText(s.way_point_number) },
      { label: '解锁秘境', value: statText(s.domain_number) },
      { label: '冰神瞳', value: statText(s.iceculus_number, true) },
      { label: '月神瞳', value: statText(s.moonoculus_number, true) },
      { label: '风神瞳', value: statText(s.anemoculus_number, true) },
      { label: '岩神瞳', value: statText(s.geoculus_number, true) },
      { label: '雷神瞳', value: statText(s.electroculus_number, true) },
      { label: '草神瞳', value: statText(s.dendroculus_number, true) },
      { label: '水神瞳', value: statText(s.hydroculus_number, true) },
      { label: '火神瞳', value: statText(s.pyroculus_number, true) },
      { label: '华丽宝箱数', value: statText(s.luxurious_chest_number, true) },
      { label: '珍贵宝箱数', value: statText(s.precious_chest_number, true) },
      { label: '精致宝箱数', value: statText(s.exquisite_chest_number, true) },
      { label: '普通宝箱数', value: statText(s.common_chest_number, true) },
      { label: '奇馈宝箱数', value: statText(s.magic_chest_number, true) },
    ],
  }
}

/** #更新面板 的缓存：data/PlayerData/gs/<uid>.json（miao Player 模型落盘） */
function readPanelPlayer(uid) {
  try {
    const file = process.cwd() + '/data/PlayerData/gs/' + uid + '.json'
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))
    const charId = d?.face || Object.keys(d?.avatars || {})[0] || ''
    let avatar = ''
    if (charId) {
      try {
        const char = Character.get(Number(charId)) || Character.get(String(charId))
        if (char?.imgs?.face) avatar = localIcon(char.imgs.face)
      } catch { /* 图鉴异常时留空 */ }
    }
    return { nickname: String(d?.name || ''), avatar }
  } catch {
    return null
  }
}

/**
 * 玩家头像/昵称/服务器。
 * 头像优先走 system/roleProfile.js（index 接口，带设备指纹与 CK 升级，拿到的是
 * 米游社账号里真正设置的头像）；失败再退回 #更新面板 缓存里的角色头像。
 * 结果缓存 10 分钟，避免每次出图都打一遍 index。
 */
async function fetchPlayerInfo(e, cks, uid) {
  const panel = readPanelPlayer(uid) || { nickname: '', avatar: '' }
  let prof = { nickname: '', avatar: '', serverName: '', stats: {} }
  const key = cacheKey('profile', uid)
  const cached = await cacheGet(key)
  if (cached) {
    prof = cached
  } else {
    try {
      const r = await getRoleProfile(e, String(uid), 'gs')
      prof = {
        nickname: String(r?.nickname || ''),
        avatar: String(r?.avatar || ''),
        serverName: String(r?.serverName || ''),
        stats: r?.stats || {},
      }
      if (prof.nickname || prof.avatar) await cacheSet(key, prof, LIST_TTL)
    } catch { /* 资料接口失败不影响出图 */ }
  }
  return {
    nickname: prof.nickname || panel.nickname || '',
    avatar: prof.avatar || panel.avatar || '',
    region: prof.serverName || '',
    stats: prof.stats || {},
  }
}
/* ---------------- 展示数据 ---------------- */

/** 角色头像优先用本地图鉴（file://），缺失时退回接口给的 CDN 地址 */
function faceOf(id, fallback) {
  try {
    const char = Character.get(Number(id))
    if (char?.face) {
      const rel = String(char.face).replace(/^\/+/, '')
      for (const base of [miaoPath, `${process.cwd()}/plugins/miao-plugin`]) {
        const file = `${String(base).replace(/\/+$/, '')}/resources/${rel}`
        if (fs.existsSync(file)) return `file://${file}`
      }
    }
  } catch { /* 图鉴异常时用接口地址 */ }
  return String(fallback || '')
}

/** 卡片立绘（半身）：gacha 抽卡立绘最好用，其次 splash、card、face（都要先确认文件存在） */
function cardOf(id) {
  try {
    const char = Character.get(Number(id))
    const imgs = char?.imgs || {}
    for (const key of ['gacha', 'splash', 'card', 'face']) {
      const hit = imgs[key] ? localIcon(imgs[key]) : ''
      if (hit) return hit
    }
    return localIcon(char?.face) || ''
  } catch {
    return ''
  }
}

/** 本地角色图鉴（125 个角色的 talentCons 等静态信息），按 mtime 缓存 */
const META_CHAR_FILE = `${String(miaoPath).replace(/\/+$/, '')}/resources/meta-gs/character/data.json`
let metaCache = { at: 0, data: {} }
function readCharMeta() {
  try {
    const stat = fs.statSync(META_CHAR_FILE)
    if (metaCache.at === stat.mtimeMs) return metaCache.data
    const data = JSON.parse(fs.readFileSync(META_CHAR_FILE, 'utf8')) || {}
    metaCache = { at: stat.mtimeMs, data }
    return data
  } catch {
    return metaCache.data || {}
  }
}

/**
 * 三项天赋等级。
 * 接口 skills 里 skill_type=1 是主动技能，顺序为 普攻 / 元素战技 / [冲刺] / 元素爆发，
 * 带冲刺的角色有 4 项、不带的有 3 项。任务1 实测：两账号共 150 个角色里，
 * 顺序法与本地 talentId 映射法只差旅行者一个（meta 未收录它的 skill_id），顺序法全对。
 */
function talentOf(detail) {
  const actives = (detail?.skills || []).filter(skill => Number(skill?.type ?? skill?.skill_type) === 1)
  const levels = actives.map(skill => Number(skill?.level) || 0)
  if (!levels.length) return { a: 0, e: 0, q: 0 }
  const a = levels[0] || 0
  const e = levels[1] || 0
  const q = levels.length >= 4 ? levels[3] || 0 : levels[2] || 0
  return { a, e, q }
}

/**
 * 命座加成后的天赋上限。
 * meta.talentCons 给的是「第几命 +3」，例如 {e:5, q:3} 表示 5 命加战技、3 命加爆发；
 * 普攻不吃命座加成，固定 10 级。
 */
function talentCap(metaItem, cons) {
  const cap = { a: 10, e: 10, q: 10 }
  const eAt = Number(metaItem?.talentCons?.e) || 0
  const qAt = Number(metaItem?.talentCons?.q) || 0
  if (eAt && cons >= eAt) cap.e += 3
  if (qAt && cons >= qAt) cap.q += 3
  return cap
}

const fmtTalent = talent => (talent.a || talent.e || talent.q ? `${talent.a}/${talent.e}/${talent.q}` : '—')

/** 本地图鉴图片统一转 file://；找不到就返回空串，模板按空处理 */
const iconCache = new Map()
function localIcon(rel) {
  const raw = String(rel || '').replace(/^\/+/, '')
  if (!raw) return ''
  if (iconCache.has(raw)) return iconCache.get(raw)
  let out = ''
  for (const base of [miaoPath, `${process.cwd()}/plugins/miao-plugin`]) {
    const file = `${String(base).replace(/\/+$/, '')}/resources/${raw}`
    if (fs.existsSync(file)) {
      out = `file://${file}`
      break
    }
  }
  iconCache.set(raw, out)
  return out
}

/** 武器图标：接口给 id 与名称，两种都能被 Weapon.get 接住 */
function weaponIconOf(weapon) {
  if (!weapon?.name) return ''
  try {
    const hit = Weapon.get(Number(weapon.id)) || Weapon.get(String(weapon.name))
    return localIcon(hit?.img)
  } catch {
    return ''
  }
}

/** 套装图标：ArtifactSet.get(套装名).img 是字符串属性（任务是实测过的取值方式） */
function setIconOf(setName) {
  if (!setName) return ''
  try {
    const set = ArtifactSet.get(String(setName))
    return localIcon(set?.img)
  } catch {
    return ''
  }
}

function artifactOf(relics) {
  const list = Array.isArray(relics) ? relics.filter(item => item?.set?.name) : []
  if (!list.length) return { text: '未装备', avg: 0, full: 0, count: 0, top: '' }
  const count = new Map()
  for (const item of list) {
    const name = String(item.set.name)
    count.set(name, (count.get(name) || 0) + 1)
  }
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1])
  const pieces = sorted.map(([name, num]) => `${name}${num > 1 ? `×${num}` : ''}`)
  const levels = list.map(item => Number(item.level) || 0)
  const avg = Math.round(levels.reduce((sum, v) => sum + v, 0) / levels.length)
  return { text: pieces.join(' + '), avg, full: levels.filter(v => v >= 20).length, count: list.length, top: sorted[0]?.[0] || '' }
}

function normalizeRoles(list, details) {
  const roles = []
  for (const item of list || []) {
    const id = Number(item?.id)
    if (!id) continue
    const detail = details?.[id] || null
    const base = detail?.base || item
    const elemRaw = String(base.element || item.element || '')
    const elemKey = ELEMENT_KEY[elemRaw] || elemRaw.toLowerCase()
    const weapon = detail?.weapon || base.weapon || item.weapon || {}
    const talent = talentOf(detail)
    const artifact = artifactOf(detail?.relics)
    const level = Number(base.level) || 0
    const cons = Number(base.actived_constellation_num) || 0
    const cap = talentCap(readCharMeta()[String(id)], cons)
    roles.push({
      id,
      name: String(base.name || item.name || ''),
      face: faceOf(id, base.image || item.image),
      art: cardOf(id) || faceOf(id, base.image || item.image),
      star: Number(base.rarity || item.rarity) >= 5 ? 5 : 4,
      level,
      levelText: `Lv.${level}`,
      fetter: Number(base.fetter) || 0,
      cons,
      elemKey,
      elemCn: ELEMENT_CN[elemRaw] || '',
      a: talent.a,
      e: talent.e,
      q: talent.q,
      aMax: cap.a,
      eMax: cap.e,
      qMax: cap.q,
      talentText: fmtTalent(talent),
      /* 三项都到上限（普攻 10，战技/爆发按命座 +3）才算满 */
      talentFull: !!detail && talent.a > 0 && talent.a >= cap.a && talent.e >= cap.e && talent.q >= cap.q,
      weaponName: String(weapon?.name || '未装备'),
      weaponAffix: Number(weapon?.affix_level) || 0,
      weaponLevel: Number(weapon?.level) || 0,
      weaponText: weapon?.name
        ? `${weapon.name}${weapon.affix_level ? ` 精${weapon.affix_level}` : ''}`
        : '未装备',
      weaponStar: Number(weapon?.rarity) >= 5 ? 5 : 4,
      weaponIcon: weaponIconOf(weapon),
      artifactText: detail ? artifact.text : '—',
      artifactAvg: artifact.avg,
      artifactFull: artifact.full,
      artifactIcon: detail ? setIconOf(artifact.top) : '',
      hasDetail: !!detail,
    })
  }
  roles.sort((x, y) => (y.star - x.star) || (y.level - x.level) || (y.fetter - x.fetter) || (x.id - y.id))
  return roles
}

function buildStat(roles) {
  const total = roles.length
  const star5 = roles.filter(item => item.star === 5).length
  const maxLevel = roles.filter(item => item.level >= 90).length
  const talentDone = roles.filter(item => item.talentFull).length
  const artifactDone = roles.filter(item => item.artifactFull >= 5).length
  const avgLevel = total ? Math.round(roles.reduce((sum, item) => sum + item.level, 0) / total) : 0
  return { total, star5, star4: total - star5, maxLevel, talentDone, artifactDone, avgLevel }
}

function nowText() {
  const d = new Date()
  const p = v => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ---------------- 插件 ---------------- */

export class gs_role extends plugin {
  constructor() {
    super({
      name: '[米哈游]原神角色与练度',
      dsc: '原神角色总览、角色列表、练度与练度统计',
      event: 'message',
      // 数值压到 -100 以抢在自带 #角色 的插件之前，可用配置覆盖
      priority: pluginPriority('gs_role', -100),
      rule: [
        { reg: '^#?(?:原神)?\\s*(?:我的)?\\s*角色列表$', fnc: 'roleTextList' },
        { reg: '^#?(?:原神)?\\s*(?:我的)?\\s*练度统计$', fnc: 'proficiencyStat' },
        { reg: '^#?(?:原神)?\\s*(?:我的)?\\s*练度$', fnc: 'proficiency' },
        { reg: '^#?(?:原神)?\\s*(?:我的)?\\s*角色$', fnc: 'roleIndex' },
      ],
    })
  }

  /** 取数：UID → CK → 角色列表（可选详情） */
  async load(e, withDetail = false) {
    const uid = resolveUid(e)
    if (!uid) return { error: '没有找到原神 UID：请先绑定，或直接发送「#角色 123456789」' }
    const cks = await collectCks(e, uid)
    if (!cks.length) return { error: '没有可用的米游社 Cookie，请先发送「#扫码登录」绑定账号' }
    const listRes = await fetchRoleList(e, cks, uid)
    if (listRes.error) return { error: `角色列表获取失败：${listRes.error}` }
    const list = listRes.list || []
    const ids = list.map(item => Number(item.id)).filter(Boolean)
    let details = {}
    if (withDetail && ids.length) {
      try {
        details = await fetchRoleDetails(e, cks, uid, ids)
      } catch {
        details = {}
      }
    }
    const roles = normalizeRoles(list, details)
    const player = await fetchPlayerInfo(e, cks, uid)
    return { uid, roles, nickname: player.nickname, avatarUrl: player.avatar, region: player.region, stats: player.stats || {} }
  }

  payload(base, extra = {}) {
    return {
      uid: base.uid,
      nickname: base.nickname,
      avatarUrl: base.avatarUrl,
      region: base.region,
      board: buildBoard(base.stats),
      time: nowText(),
      roles: base.roles,
      stat: buildStat(base.roles),
      ...extra,
    }
  }

  /** #角色：全角色总览 */
  async roleIndex(e) {
    const base = await this.load(e, true)
    if (base.error) return e.reply(base.error)
    if (!base.roles.length) return e.reply('该账号没有角色数据，请确认战绩已公开')
    try {
      return await render('gs_role/roleIndex', this.payload(base), { e, ret: true, dsf: 1.5 })
    } catch (err) {
      logger.error(`[HoYoGet][gs_role] 角色总览渲染失败：${err?.message || err}`)
      return e.reply(this.textList(base))
    }
  }

  /** #练度：逐角色练度表 */
  async proficiency(e) {
    const base = await this.load(e, true)
    if (base.error) return e.reply(base.error)
    if (!base.roles.length) return e.reply('该账号没有角色数据，请确认战绩已公开')
    try {
      return await render('gs_role/roleList', this.payload(base), { e, ret: true, dsf: 1.5 })
    } catch (err) {
      logger.error(`[HoYoGet][gs_role] 练度表渲染失败：${err?.message || err}`)
      return e.reply(this.textList(base))
    }
  }

  /** #练度统计：练度表 + 汇总 */
  async proficiencyStat(e) {
    const base = await this.load(e, true)
    if (base.error) return e.reply(base.error)
    if (!base.roles.length) return e.reply('该账号没有角色数据，请确认战绩已公开')
    try {
      return await render('gs_role/roleList', this.payload(base, { showStat: true }), { e, ret: true, dsf: 1.5 })
    } catch (err) {
      logger.error(`[HoYoGet][gs_role] 练度统计渲染失败：${err?.message || err}`)
      return e.reply(this.statText(base))
    }
  }

  /** #角色列表：文字版 */
  async roleTextList(e) {
    return this.roleIndex(e)
  }

  textList(base) {
    const stat = buildStat(base.roles)
    const lines = [`【原神角色】UID ${base.uid} 共 ${stat.total} 名（5★${stat.star5} / 4★${stat.star4}）`]
    for (const star of [5, 4]) {
      const group = base.roles.filter(item => item.star === star)
      if (!group.length) continue
      lines.push(`—— ${star}★ ——`)
      lines.push(group.map(item => `${item.name} ${item.levelText} ${item.cons ? `命${item.cons}` : '命0'}`).join('、'))
    }
    return lines.join('\n')
  }

  statText(base) {
    const stat = buildStat(base.roles)
    return [
      `【原神练度统计】UID ${base.uid}`,
      `角色总数：${stat.total}（5★${stat.star5} / 4★${stat.star4}）`,
      `满级 90 级：${stat.maxLevel}`,
      `三项天赋满级（含命座加成）：${stat.talentDone}`,
      `圣遗物五件满级：${stat.artifactDone}`,
      `平均等级：${stat.avgLevel}`,
    ].join('\n')
  }
}
