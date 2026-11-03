import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority } from '#HoYoGet'

/**
 * HoYoGet 独立抽卡记录导出。
 *
 * 把本插件自己保存的抽卡数据导出成 UIGF v2.3 JSON（可直接再导入，也能给其它工具用）。
 * 按前缀区分游戏：`#`=原神、`*`=星铁、`%`=绝区零。
 *
 * 数据来源（纯本地，不发任何请求）：
 *   星铁  data/sr_gacha/sr_<uid>_full.json（小助手全量逐抽，含四星）
 *         data/sr_gacha/<uid>/<qq>/summary.json（工坊/在线统计，只有五星+四星）
 *   绝区零 data/zzz_gacha/zzz_plugin/<uid>.json（ZZZ-Plugin 全量逐抽）
 *         data/zzz_gacha/<qq>/<uid>/summary.json（在线统计）
 *   原神  data/gs_gacha/<uid>.json（只有五星记录与垫抽）
 *
 * 同一游戏有多个 UID 时：默认导出记录最多的那个；也可以 `#导出抽卡记录 123456789` 指定。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const SR_DIR = path.join(ROOT, 'data/sr_gacha')
const ZZZ_DIR = path.join(ROOT, 'data/zzz_gacha')
const GS_DIR = path.join(ROOT, 'data/gs_gacha')
const TMP_DIR = path.join(ROOT, 'temp/gacha-export')

const GAMES = {
  '#': { key: 'gs', name: '原神', prefix: 'gs' },
  '*': { key: 'sr', name: '星铁', prefix: 'hsr' },
  '%': { key: 'zzz', name: '绝区零', prefix: 'zzz' },
}

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
const listFiles = dir => {
  try { return fs.readdirSync(dir) } catch { return [] }
}
const isUid = v => /^\d{6,12}$/.test(String(v || ''))

function now () {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 星铁全量文件（小助手）→ UIGF list */
function srFullToList (data) {
  const out = []
  for (const key of ['roleList', 'weaponList', 'normalList']) {
    for (const row of data?.[key] || []) {
      if (!row?.id) continue
      out.push({
        uid: String(row.uid || data.uid),
        gacha_id: String(row.gacha_id || ''),
        gacha_type: String(row.gacha_type),
        item_id: String(row.item_id || ''),
        count: String(row.count || '1'),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: row.lang || 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: String(row.rank_type || '3'),
        id: String(row.id),
      })
    }
  }
  return out
}

/** 星铁 summary.json（只有五星/四星）→ UIGF list */
/** summary 的池 key（GachaType_xxx / common）→ 数字 gacha_type */
/** summary 没存 gacha_id；Mys 导入要求记录带正整数 gacha_id，这里按池给一个占位值 */
const SR_POOL_GACHA_ID = { '11': '2001', '12': '3001', '21': '2001', '22': '3001', '1': '1001', '2': '1001' }

const SR_POOL_TYPE = {
  GachaType_AvatarUp: '11',
  GachaType_EquipmentUp: '12',
  GachaType_CollabAvatarUp: '21',
  GachaType_CollabEquipmentUp: '22',
  GachaType_Newbie: '2',
  GachaType_Standard: '1',
  GachaType_Normal: '1',
  common: '1'
}

function srSummaryToList (data, uid) {
  const out = []
  for (const [key, pool] of Object.entries(data?.pools || {})) {
    // summary 的 pool 本身没有 type 字段，类型只在 key 上；之前因此导出成空 gacha_type，
    // 导入时无法按池识别、甚至被当成原神。这里按 key 映射出数字类型。
    const gachaType = SR_POOL_TYPE[key] || SR_POOL_TYPE[pool?.key] || String(pool?.type || '').replace(/^GachaType_/, '') || ''
    const fiveIds = new Set((pool.records || []).map(r => String(r?.id || '')))
    for (const row of [...(pool.records || []), ...(pool.fourLog || [])]) {
      const id = String(row?.id || '')
      if (!id) continue
      const isFive = fiveIds.has(id)
      out.push({
        uid: String(uid),
        gacha_type: gachaType,
        gacha_id: SR_POOL_GACHA_ID[gachaType] || '1001',
        count: isFive ? String(Number(row.gacha_count) || 1) : '1',
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: isFive ? '5' : '4',
        is_up: isFive ? !!row.is_up : false,
        id,
      })
    }
  }
  return out
}

/** 绝区零 zzz_plugin 逐抽 → UIGF list（item 已带 gacha_type） */
function zzzFullToList (data, uid) {
  const out = []
  for (const rows of Object.values(data || {})) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row?.id) continue
      // ZZZ-Plugin 落盘的 rank_type 比官方 UIGF 少 1（它的 4=五星 S、3=四星 A、2=三星 B），
      // 导出要还原成 UIGF 的 5/4/3，否则五星会被当成四星。
      const rawRank = Number(row.rank_type)
      const rank = Number.isFinite(rawRank) && rawRank >= 2 && rawRank <= 4 ? rawRank + 1 : (rawRank || 3)
      out.push({
        uid: String(row.uid || uid),
        gacha_id: String(row.gacha_id || ''),
        gacha_type: String(row.gacha_type || ''),
        item_id: String(row.item_id || ''),
        count: String(row.count || '1'),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: row.lang || 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: String(rank),
        id: String(row.id),
      })
    }
  }
  return out
}

/** 原神 gs_gacha/<uid>.json（只有五星+垫抽）→ UIGF list */
function gsToList (data, uid) {
  const out = []
  const typeByKey = {
    GsGachaType_AvatarUp: '301',
    GsGachaType_WeaponUp: '302',
    GsGachaType_AvatarUp2: '301',
    GsGachaType_Collection: '500',
    GsGachaType_Permanent: '200',
  }
  for (const [key, pool] of Object.entries(data?.pools || {})) {
    const gachaType = typeByKey[key] || '200'
    for (const row of pool.records || []) {
      if (!row?.id) continue
      out.push({
        uid: String(uid),
        gacha_type: gachaType,
        count: String(Number(row.gacha_count) || 1),
        time: String(row.time || ''),
        name: String(row.name || '未知'),
        lang: 'zh-cn',
        item_type: String(row.item_type || ''),
        rank_type: '5',
        is_up: !!row.is_up,
        id: String(row.id),
      })
    }
  }
  return out
}

/** 收集某个游戏本地有数据的 UID 及各自的 UIGF list */
function collect (game) {
  const result = new Map() // uid -> { list, source }
  if (game === 'sr') {
    for (const f of listFiles(SR_DIR)) {
      const m = /^sr_(\d{6,12})_full\.json$/.exec(f)
      if (m) {
        const data = readJson(path.join(SR_DIR, f))
        const list = srFullToList(data)
        if (list.length) result.set(m[1], { list, source: '小助手全量' })
      }
    }
    // summary: data/sr_gacha/<uid>/<qq>/summary.json
    for (const uidDir of listFiles(SR_DIR)) {
      if (!isUid(uidDir)) continue
      for (const qqDir of listFiles(path.join(SR_DIR, uidDir))) {
        const sum = readJson(path.join(SR_DIR, uidDir, qqDir, 'summary.json'))
        if (!sum) continue
        const list = srSummaryToList(sum, uidDir)
        if (!list.length) continue
        const prev = result.get(uidDir)
        // 全量优先；没有全量才用 summary
        if (!prev) result.set(uidDir, { list, source: '在线统计' })
      }
    }
  } else if (game === 'zzz') {
    const pluginDir = path.join(ZZZ_DIR, 'zzz_plugin')
    for (const f of listFiles(pluginDir)) {
      const m = /^(\d{6,12})\.json$/.exec(f)
      if (!m) continue
      const data = readJson(path.join(pluginDir, f))
      const list = zzzFullToList(data, m[1])
      if (list.length) result.set(m[1], { list, source: 'ZZZ-Plugin 逐抽' })
    }
    for (const qqDir of listFiles(ZZZ_DIR)) {
      if (!isUid(qqDir)) continue // qq 目录本身不是 uid；下面再进 uid
      for (const uidDir of listFiles(path.join(ZZZ_DIR, qqDir))) {
        if (!isUid(uidDir)) continue
        const sum = readJson(path.join(ZZZ_DIR, qqDir, uidDir, 'summary.json'))
        if (!sum) continue
        const list = []
        for (const pool of Object.values(sum.pools || {})) {
          const fiveIds = new Set((pool.records || []).map(r => String(r?.id || '')))
          for (const row of [...(pool.records || []), ...(pool.fourLog || [])]) {
            const id = String(row?.id || '')
            if (!id) continue
            const isFive = fiveIds.has(id)
            list.push({
              uid: String(uidDir),
              gacha_type: String(pool.type || ''),
              count: isFive ? String(Number(row.gacha_count) || 1) : '1',
              time: String(row.time || ''),
              name: String(row.name || '未知'),
              lang: 'zh-cn',
              item_type: String(row.item_type || ''),
              rank_type: isFive ? '5' : '4',
              is_up: isFive ? !!row.is_up : false,
              id,
            })
          }
        }
        if (list.length && !result.has(uidDir)) result.set(uidDir, { list, source: '在线统计' })
      }
    }
  } else if (game === 'gs') {
    for (const f of listFiles(GS_DIR)) {
      const m = /^(\d{6,12})\.json$/.exec(f)
      if (!m) continue
      const data = readJson(path.join(GS_DIR, f))
      const list = gsToList(data, m[1])
      if (list.length) result.set(m[1], { list, source: '本地五星' })
    }
  }
  return result
}

/** 统一的发文件：优先进群/好友的上传接口，其次文件消息，最后退化成链接/提示 */
async function sendFile (e, file, name) {
  const target = e.isGroup ? e.group : e.friend
  const tryList = []
  // 1) 适配器封装好的 sendFile（群/好友）
  if (target?.sendFile) tryList.push(() => target.sendFile(file, name))
  // 2) 群文件上传（优先放到群文件根）
  if (e.isGroup && e.group?.fs?.upload) tryList.push(() => e.group.fs.upload(file))
  // 3) 直接调 OneBot 上传接口（NapCat 支持 base64，最稳）
  tryList.push(async () => {
    const fs = await import('node:fs')
    const base64 = `base64://${fs.readFileSync(file).toString('base64')}`
    const bot = e.bot || globalThis.Bot?.bots?.[e.self_id] || globalThis.Bot
    if (!bot?.sendApi) throw new Error('无 sendApi')
    if (e.isGroup) {
      return await bot.sendApi('upload_group_file', { group_id: e.group_id, file: base64, name, folder: '' })
    }
    return await bot.sendApi('upload_private_file', { user_id: e.user_id, file: base64, name })
  })
  // 4) 文件消息段（少数适配器支持）
  tryList.push(() => {
    const segment = globalThis.segment
    if (!segment?.file) throw new Error('无 segment.file')
    return e.reply(segment.file(file, name))
  })

  for (const run of tryList) {
    try {
      const ret = await run()
      if (ret !== false && ret !== undefined) {
        logger.mark?.(`[HoYoGet][导出] 已发送文件 ${name}`)
        return true
      }
    } catch (err) {
      logger.debug?.(`[HoYoGet][导出] 发送文件尝试失败：${err?.message || err}`)
    }
  }
  logger.warn?.('[HoYoGet][导出] 所有发送方式都失败')
  return false
}

export class gacha_export extends plugin {
  constructor () {
    super({
      name: '[米哈游]抽卡记录导出',
      dsc: '导出 HoYoGet 独立保存的原神/星铁/绝区零抽卡记录（UIGF JSON）',
      event: 'message',
      priority: pluginPriority('gacha_export', -900),
      rule: [
        {
          // 指令分发前框架会把星铁前缀 `*` 改写成 `#星铁`、绝区零 `%` 改写成 `#绝区零`，
          // 所以这里同时认原始前缀和改写后的形式。
          reg: '^(?:[#\\*%％]|#?(?:星铁|绝区零|绝区|原神))?[ \\t]*导出抽卡记录(?:[ \\t]+(\\d{6,12}))?[ \\t]*$',
          fnc: 'exportLog'
        },
      ],
    })
  }

  async exportLog (e) {
    const msg = String(e.msg || '').trim()
    const m = msg.match(/^(?:([#\\*%％])|#?(星铁|绝区零|绝区|原神))?[ \t]*导出抽卡记录(?:[ \t]+(\d{6,12}))?[ \t]*$/)
    if (!m) return false
    const wantUid = m[3] || ''
    // 分发前 `*`/`%` 会被框架改写成 `#星铁`/`#绝区零`，所以游戏不能只看首字符：
    // 优先用 e.game（框架已标好），再看改写后的名称，最后才看原始前缀。
    const raw = m[1] || ''
    let prefix = raw.replace(/^#/, '')
    if (m[2] === '星铁') prefix = '*'
    else if (m[2] === '绝区零' || m[2] === '绝区') prefix = '%'
    else if (m[2] === '原神') prefix = '#'
    if (e?.game === 'sr') prefix = '*'
    else if (e?.game === 'zzz') prefix = '%'
    else if (prefix === '％') prefix = '%'
    if (!prefix) prefix = '#' // 无前缀 = 原神
    const game = GAMES[prefix] || GAMES['#']
    if (!game) return false

    if (game.key === 'gs' && !fs.existsSync(GS_DIR)) {
      return e.reply('暂无原神抽卡记录。请先发送【#刷新抽卡记录】更新后再导出。')
    }

    const found = collect(game.key)
    if (!found.size) {
      return e.reply(`暂无${game.name}抽卡记录。请先更新后再导出（${game.name}：${prefix}刷新抽卡记录）。`)
    }

    let uid = wantUid
    if (!uid) {
      // 默认选号规则：
      //   1) 优先有「全量逐抽」的号（summary 只有五星/四星，导出会少很多）；
      //   2) 其次按最近抽卡时间；
      //   3) 再次按记录条数。
      const latest = entry => entry.list.reduce((max, x) => (x.time > max ? x.time : max), '')
      const isFull = entry => !/统计/.test(entry.source)
      uid = [...found.entries()].sort((a, b) => {
        const fa = isFull(a[1]) ? 1 : 0; const fb = isFull(b[1]) ? 1 : 0
        if (fa !== fb) return fb - fa
        const ta = latest(a[1]); const tb = latest(b[1])
        if (ta !== tb) return tb > ta ? 1 : -1
        return b[1].list.length - a[1].list.length
      })[0][0]
    }
    const hit = found.get(uid)
    if (!hit) {
      const uids = [...found.keys()].join(' / ')
      return e.reply(`没有 UID:${uid} 的${game.name}记录。可选：${uids}\n用法：${prefix}导出抽卡记录 ${uid}`)
    }
    logger.mark?.(`[HoYoGet][导出] ${game.name} uid=${uid} source=${hit.source} list=${hit.list.length} all=${[...found.entries()].map(([k, v]) => `${k}:${v.list.length}(${v.source})`).join(',')}`)
    if (found.size > 1 && !wantUid) {
      // 提示一下还有别的 UID，避免以为漏了
      const others = [...found.keys()].filter(k => k !== uid)
      if (others.length) e.reply(`（该账号有多个${game.name} UID，已导出记录最多的 ${uid}；其它：${others.join(' / ')}，可加 UID 单独导出）`)
    }

    const list = [...hit.list].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))
    const payload = {
      info: {
        uid: String(uid),
        lang: 'zh-cn',
        uigf_version: 'v2.3',
        export_time: now(),
        export_app: 'HoYoGet',
        export_app_version: 'HoYoGet',
      },
      list,
    }

    fs.mkdirSync(TMP_DIR, { recursive: true })
    const fileName = `HoYoGet_${game.prefix}_${uid}_${Date.now()}.json`
    const file = path.join(TMP_DIR, fileName)
    fs.writeFileSync(file, JSON.stringify(payload, null, '\t'), 'utf8')

    const five = list.filter(x => x.rank_type === '5').length
    // summary 只有五星/四星，缺 3 星逐抽；导入 Mys 后会被当成「每金一抽」。给个明确警告。
    const partial = /统计/.test(hit.source)
    const warn = partial
      ? `${'\n'}⚠️ 本次是「五星/四星统计」版，缺少三星逐抽，导入 Mys 会显示异常（像每金一抽）。建议先更新全量记录再导出。`
      : ''
    const head = `${game.name} UID:${uid} 抽卡记录导出${'\n'}来源：HoYoGet（${hit.source}）${'\n'}共 ${list.length} 条（五星 ${five} 条）${warn}`
    // 先发文件，成功了再说「成功」；文件发不出去就把保存路径给出来，别让人以为发出去了。
    const sent = await sendFile(e, file, fileName)
    if (sent) {
      await e.reply(`✅ ${head}\n文件：${fileName}`)
      fs.unlink(file, () => {})
    } else {
      await e.reply(`⚠️ ${head}\n文件发送失败（适配器不支持或网络问题）。已保存在机器人：\n${file}`)
    }
    return true
  }
}
