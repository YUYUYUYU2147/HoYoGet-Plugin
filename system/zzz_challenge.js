// 绝区零挑战数据归一化（式舆防卫战 / 危局强袭战）
//
// 模板直接复用 ZZZ-Plugin 仓库里作者自己写的两套页面（已复制到
// resources/zzz_challenge/，只改了资源路径前缀）：
//   式舆：challenge.html   ← ZZZero/html/challenge/challenge.html
//   危局：deadly.html      ← ZZZero/html/memDetail/memDetail.html
// 所以这里的字段名必须和它们的模板对齐，不要随意改名。
//
// 数据来源：米游社 record 接口
//   式舆：/api/zzz/hadal_info_v2       → hadal_info_v2
//   危局：/api/zzz/hadal_mem_detail_v2 → has_data / list / total_star …

/** 元素英文键 → 本地图标文件名（resources/zzz_challenge/element/ 下） */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOSS_DIR = path.join(PLUGIN_ROOT, 'system', 'default')

/** 读一次 BOSS 名称/弱点映射（来源：米游社接口不返回，靠图片 hash 查本地表） */
let _bossMap = null
function bossMap() {
  if (_bossMap) return _bossMap
  const read = f => {
    try { return YAML.parse(fs.readFileSync(path.join(BOSS_DIR, f), 'utf8')) || {} } catch { return {} }
  }
  _bossMap = { name: read('zzz_boss_name.yaml'), meta: read('zzz_boss_meta.yaml') }
  return _bossMap
}

/** 从图片 URL 里取 hash（米游社 CDN 是 .../item_icon_u8d5de/<32位hash>.png） */
function hashOf(url = '') {
  return String(url).match(/[a-f0-9]{32}/i)?.[0]?.toLowerCase()
    || String(url).split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() || ''
}

/**
 * BOSS 名称 / 弱点 / 抗性。
 * 接口只给立绘地址，名称与弱点抗性查本地表（key 是图片 hash），查不到就留空。
 */
function bossMetaOf(boss = {}) {
  const url = boss?.icon || boss?.monster_pic || boss?.boss_pic || boss?.image || boss?.pic || ''
  const h = hashOf(url)
  if (!h) return { name: '', weakness: '', resistance: '' }
  const { name: names, meta } = bossMap()
  const rawName = names?.[h]
  const rawMeta = meta?.[h]
  const pick = v => (v && typeof v === 'object' ? (v.name || v.weakness || '') : v)
  return {
    name: String(pick(rawName) || '').trim(),
    weakness: rawMeta?.weakness || '',
    resistance: rawMeta?.resistance || '',
  }
}

const ELEM_ICON = {
  physical: 'Physical', fire: 'Fire', ice: 'Ice', electric: 'Electric',
  lightning: 'Electric', ether: 'Ether', wind: 'Wind',
  quantum: 'Quantum', imaginary: 'Imaginary',
}
const ELEM_CN = {
  physical: '物理', fire: '火', ice: '冰', electric: '电', lightning: '电',
  ether: '以太', wind: '风', quantum: '量子', imaginary: '虚数',
}
/* 中文名 → 图标文件名（nanoka 给的是中文，直接按英文键查会拿不到图标）。
   后三个是绝区零的特殊属性，素材文件名见 resources/zzz_challenge/element/。 */
const ELEM_CN_ICON = {
  物理: 'Physical', 火: 'Fire', 冰: 'Ice', 电: 'Electric', 雷: 'Electric',
  以太: 'Ether', 风: 'Wind', 量子: 'Quantum', 虚数: 'Imaginary',
  凛刃: 'HonedEdge', 烈霜: 'Frost', 玄墨: 'AuricInk', 流明: 'Lumiflux',
}

/**
 * 代理人列表归一化。
 * 接口字段是 role_square_url / rarity / rank，**没有 name** ——
 * 早先按 name 过滤会把整队人都丢掉（强袭战代理人消失就是这个原因）。
 */
function normalizeAvatars(list = []) {
  return (list || []).map(a => ({
    id: a?.id ?? 0,
    role_square_url: a?.role_square_url || a?.icon || a?.avatar || '',
    rarity: a?.rarity || '',
    rank: Number(a?.rank) || 0,
    level: Number(a?.level) || 0,
    element_type: a?.element_type ?? 0,
    avatar_profession: a?.avatar_profession ?? 0,
  })).filter(a => a.role_square_url)
}

/**
 * 元素抗性百分比。
 * 游戏里没有按 BOSS 逐个给数值，只有「弱点 / 普通 / 抗性」三档：
 *   弱点 -20%（负抗性 = 增伤）、普通 0%、抗性 +20%
 * ZZZ-Plugin 的伤害计算也用 resistance: -0.2 作为弱点基准。
 */
const RES_WEAK = -20
const RES_RESIST = 20

/**
 * 弱点/抗性 → 模板的 tag 结构。
 * @param {Array|string} list 元素列表
 * @param {'weak'|'resist'} kind 决定抗性正负号
 * 模板写的是 {{ppath}}{{tag.icon}}，所以 icon 给插件相对路径。
 */
export function toElementTags(list = [], kind = 'weak') {
  const res = kind === 'resist' ? RES_RESIST : RES_WEAK
  return (Array.isArray(list) ? list : String(list || '').split(/[/、,]/))
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .map(raw => {
      const key = String(raw || '').trim()
      // 英文键（physical/fire…）与中文名（物理/火…）两种来源都要认
      const lower = key.toLowerCase()
      const cn = ELEM_CN[lower] || key
      const icon = ELEM_ICON[lower] || ELEM_CN_ICON[key] || ELEM_CN_ICON[cn] || ''
      return {
        name: cn,
        icon: icon ? `zzz_challenge/element/${icon}.png` : '',
        // 带上符号：弱点显示 -20%，抗性显示 +20%
        resText: `${res > 0 ? '+' : ''}${res}%`,
      }
    })
}

/**
 * 怪物面板数值 → 模板用的中文条目。
 * nanoka 字段：hp / attack / defence / stun（失衡值） / attribute_infliction（异常掌控）
 */
function formatMonsterStats(stats = {}) {
  const s = stats || {}
  const fmt = n => {
    const v = Number(n)
    if (!Number.isFinite(v)) return ''
    // 生命值很大，取整加千分位；其余保留一位小数内的整数
    return Math.round(v).toLocaleString('en-US')
  }
  const rows = [
    ['生命', s.hp],
    ['攻击', s.attack],
    ['防御', s.defence],
    ['失衡值', s.stun],
    ['异常掌控', s.attribute_infliction],
  ]
  const out = rows
    .map(([label, v]) => ({ label, value: fmt(v) }))
    .filter(r => r.value !== '')
  // 分成两行：前三个（生命/攻击/防御）一行，剩下的另一行，和游戏内面板一致
  return { top: out.slice(0, 3), bottom: out.slice(3) }
}

const stripTags = (s = '') => String(s)
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|li)>/gi, '\n')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  /* 接口里的换行是「字面量 \n」（反斜杠 + n 两个字符），不是真换行，
     不转义的话会原样显示成「\n· 代理人的…」 */
  .replace(/\\n/g, '\n')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const pad = n => String(n || 0).padStart(2, '0')
const fmtDate = o => (o ? `${o.year}.${pad(o.month)}.${pad(o.day)}` : '')
const fmtDateTime = o => (o ? `${fmtDate(o)} ${pad(o.hour)}:${pad(o.minute)}` : '')

/** 距离 end 还有多久 */
function remainingText(end) {
  if (!end) return ''
  const t = new Date(end.year, (end.month || 1) - 1, end.day || 1, end.hour || 0, end.minute || 0)
  const ms = t - new Date()
  if (!Number.isFinite(ms) || ms <= 0) return '已结束'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时 ${Math.floor((ms % 3600000) / 60000)} 分钟`
}

/** 挑战用时（秒）→ 「1 分 35 秒」 */
function formatSeconds(v) {
  const n = Number(v) || 0
  if (n <= 0) return ''
  const m = Math.floor(n / 60)
  const s = n % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

const LAYER_KEYS = [
  ['first', '一'], ['second', '二'], ['third', '三'], ['fourth', '四'], ['fitfh', '五'],
]

/** 式舆里每层的评级图片名：S→s.png / A→a.png / B→b.png */
const ratingPic = r => {
  const k = String(r || '').toUpperCase()
  return k === 'S' ? 's' : k === 'A' ? 'a' : 'b'
}

/**
 * 式舆防卫战 → challenge.html 的模板数据
 * @param {object} raw hadal_info_v2 节点
 */
export async function normalizeShiyu(raw = {}, meta = {}) {
  const data = raw?.hadal_info_v2 || raw || {}
  /* 接口只给 BOSS 立绘的图片 hash，名称/弱点/抗性从 nanoka 当期数据取
     （本地 hash 表只覆盖少数 BOSS，覆盖不到就没有弱点） */
  const nanokaByLine = await nanokaShiyuBosses(meta.periodOffset || 0).catch(() => null)

  const grade = { S: 0, A: 0, B: 0 }
  const layers = []
  for (const [key, zh] of LAYER_KEYS) {
    const d = data[`${key}_layer_detail`]
    if (!d || !Array.isArray(d.layer_challenge_info_list)) continue
    const lineBosses = nanokaByLine?.[CN_NUM[zh]] || null
    const items = d.layer_challenge_info_list.map((item, roomIdx) => {
      const rating = String(item?.rating || '').toUpperCase()
      if (grade[rating] !== undefined) grade[rating]++
      const boss = pickBoss(item)
      // 同防线内按房间顺序对位；nanoka 缺数据时留空
      const nb = lineBosses?.[roomIdx] || null
      const bm = bossMetaOf({ icon: boss?.pic || item?.monster_pic || '' })
      return {
        ...item,
        // 模板用它拼图片、也直接显示
        rating: ratingPic(rating),
        // 模板用 item.rating 显示；真实评级放到 challenge_time 旁边不现实，这里保持图片即可
        challenge_time_fmt: item?.challenge_time ? formatSeconds(item.challenge_time) : '',
        avatars: normalizeAvatars(item?.avatars || item?.avatar_list),
        buffer: item?.buffer?.text ? { text: stripTags(item.buffer.text) } : null,
        /* 立绘直接用接口的 monster_pic（米游社 CDN 完整 URL）；
           不要写成 boss?.pic || ''，取不到 boss 时会把原字段清空，导致没图 */
        monster_pic: boss?.pic || item?.monster_pic || '',
        monster_name: boss?.name || item?.monster_name || nb?.name || bm.name || '',
        monster_stats: formatMonsterStats(nb?.stats),
        monster_weakness_tags: toElementTags(
          boss?.weakness?.length ? boss.weakness
            : (item?.monster_weakness || nb?.weakness || bm.weakness), 'weak'),
        monster_resistance_tags: toElementTags(
          boss?.resist?.length ? boss.resist
            : (item?.monster_resistance || nb?.resistance || bm.resistance), 'resist'),
      }
    })
    layers.push({
      name: key,
      zh,
      data: {
        ...d,
        layer_challenge_info_list: items,
        challenge_time: d.challenge_time ? { ...d.challenge_time, fmt: fmtDateTime(d.challenge_time) } : null,
      },
    })
  }

  const brief = data?.brief || {}
  return {
    type: 'shiyu',
    uid: meta.uid || '',
    nickname: meta.nickname || '',
    avatar_icon: meta.avatar || '',
    level: meta.level || '',
    period: data.hadal_begin_time
      ? `${fmtDate(data.hadal_begin_time)} - ${fmtDate(data.hadal_end_time)}`
      : '',
    remain: remainingText(data.hadal_end_time),
    brief,
    // 模板用 {{brief_rating}}.png：S+ → SP
    brief_rating: String(brief?.rating || '').replace('+', 'P').toUpperCase(),
    rank_percent: brief?.rank_percent != null ? (Number(brief.rank_percent) / 100).toFixed(2) : '',
    grade,
    layers,
    empty: !layers.length,
  }
}

/** 从节点里抠 BOSS 信息（不同版本字段位置不一样，全都兜一遍） */
function pickBoss(item = {}) {
  const pic = item.monster_pic || item.boss_pic || item.boss?.monster_pic || item.boss?.pic || ''
  const name = item.monster_name || item.boss_name || item.boss?.name || ''
  const weakness = item.monster_weakness || item.boss?.weakness || item.weakness || []
  const resist = item.monster_resistance || item.boss?.resistance || item.resistance || []
  if (!pic && !name && !weakness.length && !resist.length) return null
  return { pic, name, weakness, resist }
}

/**
 * 把远程图片转成 data URI。
 *
 * 米游社的 BOSS 立绘有防盗链，直接写进 <img src> 会加载失败（浏览器里是空白），
 * ZZZ-Plugin 的 Bos.get_assets() 也是先下载再转 base64 才渲染的。
 * 取不到就原样返回，最多是没图，不影响其它内容。
 */
async function fetchAsset(url) {
  if (!url || !/^https?:/i.test(url)) return url || ''
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.miyoushe.com/' } })
    if (!resp.ok) return url
    const buf = Buffer.from(await resp.arrayBuffer())
    const type = resp.headers.get('content-type') || 'image/png'
    return `data:${type};base64,${buf.toString('base64')}`
  } catch {
    return url
  }
}

/* ───── nanoka 的 BOSS 弱点/抗性（危局用） ─────
 * 米游社接口只给立绘，弱点抗性要另找数据：nanoka 的当期 boss.json 里每个房间的
 * monster_list[].element 用 1 表示弱点、-1 表示抗性。
 * 取不到就静默跳过，只是少显示两行，不影响出图。 */
const NANOKA = 'https://static.nanoka.cc'
const NANOKA_ELEM_CN = {
  physical: '物理', fire: '火', ice: '冰', electric: '电', ether: '以太', wind: '风',
}

async function fetchJson(url, timeout = 8000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) return null
    return await resp.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const pickBySign = (element = {}, sign) => Object.entries(element || {})
  .filter(([, v]) => Number(v) === sign)
  .map(([k]) => NANOKA_ELEM_CN[k])
  .filter(Boolean)

let _nanokaBossCache = { at: 0, bosses: null }
const NANOKA_TTL = 30 * 60 * 1000

/**
 * 当期危局每关的 BOSS 信息（按房间顺序）。
 * @param {number} periodOffset 0=当期，-1=上期
 * @returns {Promise<Array<{name,weakness,resistance}>|null>}
 */
async function nanokaDeadlyBosses(periodOffset = 0) {
  if (!periodOffset && _nanokaBossCache.bosses && Date.now() - _nanokaBossCache.at < NANOKA_TTL) {
    return _nanokaBossCache.bosses
  }
  const manifest = await fetchJson(`${NANOKA}/manifest.json`, 6000)
  const nv = manifest?.zzz?.latest
  if (!nv) return null
  const list = await fetchJson(`${NANOKA}/zzz/${nv}/boss.json`)
  const items = Object.entries(list || {})
    .map(([k, v]) => ({ id: Number(k), ...v }))
    .filter(v => Number.isFinite(v.id) && v.live_begin && v.live_end)
    .sort((a, b) => a.id - b.id)
  if (!items.length) return null

  const now = new Date()
  let idx = items.findIndex(v => now >= new Date(v.live_begin) && now <= new Date(v.live_end))
  if (idx < 0) idx = items.length - 1
  idx += periodOffset
  idx = Math.max(0, Math.min(items.length - 1, idx))

  const detail = await fetchJson(`${NANOKA}/zzz/${nv}/zh/boss/${items[idx].id}.json`, 10000)
  if (!detail?.modes) return null
  /* 按名字建索引，不依赖房间顺序：
     nanoka 的 modes 里既有普通（3 关）也有困难（1 关），zone 顺序还与接口不一致，
     用名字对齐最稳。 */
  const byName = new Map()
  for (const mode of Object.values(detail.modes)) {
    for (const zone of Object.values(mode?.zone || {})) {
      for (const room of Object.values(zone?.layer_room || {})) {
        const entries = Object.entries(room?.monster_list || {}).sort(([a], [b]) => Number(a) - Number(b))
        const mon = entries.length ? entries[entries.length - 1][1] : null
        if (!mon?.name || byName.has(mon.name)) continue
        byName.set(mon.name, {
          name: mon.name,
          weakness: pickBySign(mon.element, 1).join(' / '),
          resistance: pickBySign(mon.element, -1).join(' / '),
          stats: mon.stats || {},
        })
      }
    }
  }
  const ret = byName.size ? [...byName.values()] : null
  if (ret && !periodOffset) _nanokaBossCache = { at: Date.now(), bosses: ret }
  return ret
}

/* ───── nanoka 式舆 BOSS（名称/弱点/抗性） ─────
 * 接口只给 monster_pic（图片 hash），本地映射表覆盖不全；
 * nanoka 的 shiyu.json → zh/shiyu/<id>.json 有每个房间 BOSS 的 element
 * （1=弱点，-1=抗性），按 zone.name 归到第 1~5 防线。
 * 第 5 防线常被拆成「房间一/二/三」，也归到第 5 防线。 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function lineFromZoneName(name = '') {
  const t = String(name || '')
  if (!t) return 0
  const m = t.match(/第([一二三四五六七八九十]+)防线/)
  if (m) return CN_NUM[m[1]] || 0
  if (/房间/.test(t)) return 5
  return 0
}

let _shiyuBossCache = { at: 0, byLine: null }

/** 当期式舆每道防线的 BOSS 列表：{ 1: [{name,weakness,resistance}], ... } */
async function nanokaShiyuBosses(periodOffset = 0) {
  if (!periodOffset && _shiyuBossCache.byLine && Date.now() - _shiyuBossCache.at < NANOKA_TTL) {
    return _shiyuBossCache.byLine
  }
  const manifest = await fetchJson(`${NANOKA}/manifest.json`, 6000)
  const nv = manifest?.zzz?.latest
  if (!nv) return null
  const list = await fetchJson(`${NANOKA}/zzz/${nv}/shiyu.json`)
  const items = Object.entries(list || {})
    .map(([k, v]) => ({ id: Number(k), ...v }))
    .filter(v => Number.isFinite(v.id) && (v.live_begin || v.begin) && (v.live_end || v.end))
    .sort((a, b) => a.id - b.id)
  if (!items.length) return null

  const now = new Date()
  let idx = items.findIndex(v => now >= new Date(v.live_begin || v.begin) && now <= new Date(v.live_end || v.end))
  if (idx < 0) idx = items.length - 1
  idx = Math.max(0, Math.min(items.length - 1, idx + periodOffset))

  const detail = await fetchJson(`${NANOKA}/zzz/${nv}/zh/shiyu/${items[idx].id}.json`, 10000)
  if (!detail?.zone) return null

  const byLine = {}
  for (const z of Object.values(detail.zone)) {
    const line = lineFromZoneName(z?.name)
    if (!line) continue
    const rooms = Object.entries(z.layer_room || {}).sort(([a], [b]) => Number(a) - Number(b))
    for (const [, room] of rooms) {
      const entries = Object.entries(room?.monster_list || {}).sort(([a], [b]) => Number(a) - Number(b))
      const mon = entries.length ? entries[entries.length - 1][1] : null
      if (!mon?.name) continue
      ;(byLine[line] = byLine[line] || []).push({
        name: mon.name,
        weakness: pickBySign(mon.element, 1).join(' / '),
        resistance: pickBySign(mon.element, -1).join(' / '),
        // 怪物面板数值，模板里按中文标签展示
        stats: mon.stats || {},
      })
    }
  }
  const ret = Object.keys(byLine).length ? byLine : null
  if (ret && !periodOffset) _shiyuBossCache = { at: Date.now(), byLine: ret }
  return ret
}

/** BOSS 背景序号：接口给 boss_bg_3 这种文件名，取数字；没有就按序号循环 */
function bossBgNum(boss = {}, idx = 0) {
  // 只看 bg_icon：boss.icon 是立绘地址，误匹配会把背景换成错的
  const m = String(boss?.bg_icon || '').match(/boss_bg_?(\d)/)
  if (m) return m[1]
  return String((idx % 4) + 1)
}

/**
 * 危局强袭战 → deadly.html 的模板数据
 * @param {object} raw hadal_mem_detail_v2 的 data 节点
 */
export async function normalizeDeadly(raw = {}, meta = {}) {
  /* 先并行把每关 BOSS 立绘转成 data URI（详见 fetchAsset 注释） */
  /* 弱点/抗性：nanoka 当期数据按房间顺序对齐（接口本身不给） */
  const nanokaBosses = await nanokaDeadlyBosses(0).catch(() => null)
  const assets = await Promise.all((raw?.list || []).map(v => {
    const boss = v?.boss?.[0] || {}
    return fetchAsset(boss?.icon || boss?.monster_pic || boss?.boss_pic || boss?.image || boss?.pic || '')
  }))
  const list = (raw?.list || []).map((v, idx) => {
    const boss = v?.boss?.[0] || {}
    const buff = v?.buffer?.[0] || {}
    // 接口只给立绘地址；名称/弱点/抗性依次取：接口 → nanoka → 本地映射表
    const bm = bossMetaOf(boss)
    // nanoka 数据按名字对齐（顺序不可靠）
    const bossName = boss?.name || boss?.monster_name || ''
    const nb = bossName ? (nanokaBosses || []).find(b => b.name === bossName) || null : null
    return {
      score: v?.score ?? '',
      star: Number(v?.star) || 0,
      total_star: Number(v?.total_star) || 0,
      challenge_time: v?.challenge_time ? fmtDateTime(v.challenge_time) : '',
      boss: {
        /* 先铺开接口原始字段（boss.icon / race_icon / bg_icon 都是接口给的），
           只在缺失时补默认值——直接赋值会把已有的立绘地址覆盖成空 */
        ...boss,
        bg_num: bossBgNum(boss, idx),
        // assets[idx] 是下载好的 base64；下载失败会回落到原始 URL
        icon: assets[idx] || boss?.icon || boss?.monster_pic || boss?.boss_pic || boss?.image || boss?.pic || '',
        // 名称优先用接口的，接口没有就查本地表
        name: boss?.name || boss?.monster_name || nb?.name || bm.name || '',
        race_icon: boss?.race_icon || '',
        monster_weakness_tags: toElementTags(boss?.weakness || boss?.monster_weakness || nb?.weakness || bm.weakness, 'weak'),
        monster_resistance_tags: toElementTags(boss?.resistance || boss?.monster_resistance || nb?.resistance || bm.resistance, 'resist'),
      },
      monster_stats: formatMonsterStats(nb?.stats),
      buffer: {
        icon: buff?.icon || '',
        name: buff?.name || '',
        desc: buff?.desc ? stripTags(buff.desc) : '',
      },
      avatars: normalizeAvatars(v?.avatar_list),
      buddy: {
        bangboo_rectangle_url: v?.buddy?.bangboo_rectangle_url || v?.buddy?.icon || '',
        rarity: v?.buddy?.rarity || '',
      },
    }
  })

  return {
    type: 'deadly',
    uid: meta.uid || '',
    nickname: raw?.nick_name || meta.nickname || '',
    avatar_icon: raw?.avatar_icon || meta.avatar || '',
    period: raw?.start_time ? `${fmtDate(raw.start_time)} - ${fmtDate(raw.end_time)}` : '',
    remain: remainingText(raw?.end_time),
    total_star: Number(raw?.total_star) || 0,
    total_score: raw?.total_score ?? '',
    rank_percent: raw?.rank_percent != null ? (Number(raw.rank_percent) / 100).toFixed(2) : '',
    list,
    hard_list: (raw?.hard_list || []).map((v, idx) => ({
      score: v?.score ?? '',
      star: Number(v?.star) || 0,
      total_star: Number(v?.total_star) || 0,
      boss: { ...(v?.boss?.[0] || {}), bg_num: bossBgNum(v?.boss?.[0], idx) },
    })),
    empty: !raw?.has_data || !list.length,
  }
}
