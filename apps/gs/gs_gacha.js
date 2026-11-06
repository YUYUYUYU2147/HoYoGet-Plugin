import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeForwardMsg, mhy, pluginPriority, render, yaml } from "#HoYoGet"
import { buildSummaryView, extractUrlsFromMsg, requestJson, sleep } from "../sr/sr_gacha.js"
import { makeGenshinLoader } from "../../system/genshin_loader.js"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, "../..")
const DATA_DIR = path.join(PLUGIN_ROOT, "data", "gs_gacha")
const STOKEN_DIR = path.join(PLUGIN_ROOT, "data", "Stoken")
const HOST_CN = "https://public-operation-hk4e.mihoyo.com/gacha_info/api"
const HOST_OS = "https://public-operation-hk4e-sg.hoyoverse.com/gacha_info/api"
const GEN_AUTHKEY_URL = "https://api-takumi.mihoyo.com/binding/api/genAuthKey"
/* 提瓦特小助手（lelaer）
   - 回传：POST https://www.lelaer.com/uigf.php（UIGF v2.3 multipart + 祈愿链接），Mys 用的是同一接口
   - 拉取：官方未开放单 UID 逐抽 HTTP 接口（getWishHistory/getWishDetail 只给卡池图鉴），
     所以「补回」只能读用户自己在小助手导出的 UIGF/SRGF 文件（导入），或粘贴链接拉官方接口。
   小助手只收原神记录。 */
const LELAER_UPLOAD_URL = "https://www.lelaer.com/uigf.php"
const getNoteUser = makeGenshinLoader("model/mys/NoteUser.js", ["model/mys/NoteUser.js"])
const GS_POOLS = [
  { key: "GsGachaType_AvatarUp", type: "301", name: "角色活动祈愿" },
  { key: "GsGachaType_WeaponUp", type: "302", name: "武器活动祈愿" },
  { key: "GsGachaType_AvatarUp2", type: "500", name: "角色活动祈愿其二" },
  { key: "GsGachaType_Collection", type: "400", name: "集录祈愿" },
  { key: "GsGachaType_Permanent", type: "200", name: "常驻祈愿" },
]
function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}
function dataFile(uid) {
  return path.join(DATA_DIR, `${uid}.json`)
}
function readData(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
function saveData(file, data) {
  ensureDir()
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}
function stokenTable(qq) {
  const file = path.join(STOKEN_DIR, `${qq}.yaml`)
  if (!fs.existsSync(file)) return {}
  try {
    return yaml.get(file) || {}
  } catch {
    return {}
  }
}

﻿
/** 取本次更新要用的账号信息：uid、区服、stoken Cookie。缺失时返回 error 字段而不是抛异常 */
async function getAuth(e) {
  const qq = String(e.user_id || e.sender?.user_id || "")
  const table = stokenTable(qq)
  let uid = ""
  try {
    const NoteUser = await getNoteUser()
    const user = NoteUser ? await NoteUser.create(qq) : null
    uid = user?.getUid?.("gs") || ""
  } catch {}
  // NoteUser 不可用或未读取到切换值时，回退读 HoYoGet 自己的当前 UID 键，
  // 避免多账号时用错账号去换 authkey。
  if (!uid && typeof redis !== "undefined") {
    try { uid = String((await redis.get(`HoYoGet:cur_uid:gs:${qq}`)) || "") } catch {}
  }
  let region = ""
  if (uid) {
    try {
      region = mhy.getServer(uid, "gs") || ""
    } catch {}
  }
  if (!uid) return { error: "还没有绑定原神账号。请先在面板绑定，或改用【#米哈游原神抽卡链接 <链接>】" }
  if (!region) region = "cn_gf01"
  // 不要在当前 UID 缺少凭证时退回第一份 Stoken，否则多账号时会用错账号取数。
  const entry = table[uid] || null
  // genAuthKey 只认 v2 stoken（stoken=v2_...）；ck_stoken 里是老式 ltoken，
  // 用它换 authkey 会稳定返回 -100「登录状态失效」。所以 v2 优先、ck_stoken 兜底。
  const v2Cookie = entry?.stuid && entry?.stoken
    ? `stuid=${entry.stuid};stoken=${entry.stoken};${entry.mid ? `mid=${entry.mid};` : ""}`
    : ""
  const stokenCookie = v2Cookie || entry?.ck_stoken || ""
  if (!stokenCookie) {
    return { error: "没有找到 stoken，无法自动换取 authkey。请先在面板扫码绑定米游社账号，或改用【#米哈游原神抽卡链接 <链接>】" }
  }
  return { qq, uid, region, stokenCookie }
}
/** 用 stoken 换抽卡用的 authkey（auth_appid=webview_gacha，与游戏内抽卡记录同源） */
async function getAuthKey(uid, region, stokenCookie) {
  const bodyStr = JSON.stringify({ auth_appid: "webview_gacha", game_biz: "hk4e_cn", game_uid: String(uid), region })
  const { data } = await requestJson(GEN_AUTHKEY_URL, {
    method: "POST",
    headers: {
      Cookie: stokenCookie,
      DS: mhy.getDs2("", bodyStr, 4),
      "Content-Type": "application/json",
      "User-Agent": "okhttp/4.8.0",
      "x-rpc-app_version": "2.73.1",
      "x-rpc-sys_version": "12",
      "x-rpc-client_type": "5",
      "x-rpc-channel": "mihoyo",
      "x-rpc-device_id": mhy.getDeviceGuid().replace(/-/g, ""),
      "x-rpc-device_name": "Mi 10",
      "x-rpc-device_model": "Mi 10",
      Referer: "https://app.mihoyo.com",
      Host: "api-takumi.mihoyo.com",
    },
    body: bodyStr,
  })
  if (Number(data?.retcode) !== 0) {
    throw new Error(`authkey 获取失败：${data?.message || data?.retcode}（stoken 可能已失效，重新扫码绑定即可）`)
  }
  const authkey = String(data?.data?.authkey || "")
  if (!authkey) throw new Error("authkey 获取失败：接口没有返回 authkey")
  return authkey
}
/** 从消息里的官方链接取 authkey 与区服；没有链接返回 null */
function parseLink(e) {
  for (const url of extractUrlsFromMsg(e)) {
    if (!/authkey=/.test(url) || !/hk4e/i.test(url)) continue
    try {
      const params = Object.fromEntries(new URLSearchParams(url.slice(url.indexOf("?") + 1)))
      const authkey = String(params.authkey || "").replace(/(#\/log|#\/|#).*$/, "")
      if (!authkey) continue
      return {
        authkey,
        region: params.region || "cn_gf01",
        gameBiz: /^hk4e_(cn|global)/.test(String(params.game_biz)) ? params.game_biz : "hk4e_cn",
        beyond: /getBeyondGachaLog/i.test(url),
      }
    } catch {
      continue
    }
  }
  return null
}

﻿
async function fetchPage(ctx, type, endId, page) {
  const base = /^cn/.test(ctx.region) ? HOST_CN : HOST_OS
  const endpoint = ctx.beyond ? "getBeyondGachaLog" : "getGachaLog"
  const params = new URLSearchParams({
    authkey_ver: "1",
    sign_type: "2",
    auth_appid: "webview_gacha",
    init_type: type,
    gacha_id: "0",
    timestamp: String(Math.floor(Date.now() / 1000)),
    lang: "zh-cn",
    device_type: "mobile",
    plat_type: "ios",
    region: ctx.region,
    authkey: ctx.authkey,
    game_biz: ctx.gameBiz || "hk4e_cn",
    gacha_type: type,
    page: String(page),
    size: "20",
    end_id: String(endId || "0"),
  })
  const { data } = await requestJson(`${base}/${endpoint}?${params}`)
  if (Number(data?.retcode) !== 0) {
    const message = String(data?.message || "")
    if ([-100, -101, -111].includes(Number(data?.retcode)) || /timeout|expire|login/i.test(message)) {
      throw new Error("authkey 已过期或无效，请重新执行【#更新抽卡记录】或重新复制抽卡链接")
    }
    throw new Error(message || "接口返回异常")
  }
  return data?.data || { list: [] }
}
/** 单个池全量翻页，返回按时间正序（旧到新）的记录 */
async function fetchPool(ctx, pool) {
  const rows = []
  const seen = new Set()
  let endId = "0"
  let page = 1
  while (page <= 80) {
    const data = await fetchPage(ctx, pool.type, endId, page)
    const list = Array.isArray(data?.list) ? data.list : []
    if (!list.length) break
    let added = 0
    for (const row of list) {
      const id = String(row?.id || "")
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      rows.push(row)
      added += 1
    }
    const next = String(list[list.length - 1]?.id || "")
    if (!added || next === endId) break
    endId = next
    page += 1
    await sleep(250)
  }
  return rows.reverse()
}
/** 原始记录转成视图层要的池结构：五星带「距上一个五星的抽数」，末位剩余抽数记为垫抽 */
function buildPool(pool, rows) {
  const records = []
  let counter = 0
  for (const row of rows) {
    counter += 1
    if (String(row?.rank_type) !== "5") continue
    records.push({
      id: String(row?.id || ""),
      name: row?.name || "未知",
      item_type: row?.item_type || "",
      is_up: row?.is_up === true,
      gacha_count: counter,
      time: String(row?.time || ""),
      icon: "",
    })
    counter = 0
  }
  const fiveNum = records.length
  const totalPulls = rows.length
  const avg = fiveNum ? (records.reduce((sum2, r) => sum2 + Number(r.gacha_count || 0), 0) / fiveNum).toFixed(1) : "0.0"
  return {
    ...pool,
    name: pool.name,
    totalPulls,
    fiveNum,
    upNum: 0,
    pity: counter,
    avgPity: avg,
    fourNum: 0,
    fourLog: [],
    records,
  }
}
function summarize(pools, uid) {
  const lines = [`原神抽卡记录  UID:${uid}`]
  for (const pool of GS_POOLS) {
    const data = pools[pool.key]
    if (!data) continue
    lines.push(`【${pool.name}】${data.totalPulls} 抽 / ${data.fiveNum} 金 / 平均 ${data.avgPity} 抽 / 垫 ${data.pity} 抽`)
  }
  if (lines.length === 1) lines.push("暂无记录")
  return lines.join("\n")
}

﻿
/** 出图：与星铁、绝区零共用同一套视图与模板，保证三游戏渲染逻辑完全一致 */
async function renderImage(e, data) {
  const view = buildSummaryView({ pools: data.pools }, data.uid, e, "grid", "gs")
  const buf = await render("sr_gacha/summary", view, { e })
  if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
  return e.reply(buf)
}
export class gs_gacha extends plugin {
  constructor() {
    super({
      name: "[米哈游]原神抽卡记录",
      dsc: "原神抽卡记录更新与渲染（CK 直接更新、链接更新）",
      event: "message",
      priority: pluginPriority("gs_gacha", Number.MIN_SAFE_INTEGER),
      rule: [
        { reg: "^#[ \\t]*(刷新|更新)抽卡记录$", fnc: "updateByCookie" },
        { reg: "^#(抽卡记录|抽卡统计)$", fnc: "summary" },
        { reg: "^#*米哈游原神(刷新|更新)抽卡记录$", fnc: "updateByCookie" },
        { reg: "^#*米哈游原神(抽卡记录|抽卡统计)$", fnc: "summary" },
        { reg: "^#*米哈游原神抽卡链接", fnc: "updateByLink" },
        { reg: "^#*米哈游原神超越抽卡", fnc: "updateByLink" },
        { reg: "^#*米哈游原神抽卡帮助$", fnc: "help" },
        // 回传提瓦特小助手（带米哈游前缀，避免抢 genshin/Mys 的同类指令）
        { reg: "^#*米哈游原神(抽卡|祈愿)?(记录|数据)?回传(提瓦特)?小助手$", fnc: "uploadLelaer" },
        { reg: "^#*米哈游原神(更新|刷新|同步|获取|导入|补全|补回)小助手(抽卡|祈愿)?(记录|数据)$", fnc: "helperHelp" },
        // 省略游戏名前缀：#更新小助手抽卡记录 / #更新提瓦特小助手记录（原神为默认游戏）
        { reg: "^#?[ \\t]*(更新|刷新|同步|获取|导入|补全|补回)(提瓦特)?小助手(抽卡|祈愿)?(记录|数据)$", fnc: "helperHelp" },
        { reg: "^#*米哈游原神导入小助手(抽卡|祈愿)?(记录|数据)(\\s+\\S+)?$", fnc: "importLelaer" },
        // 不带游戏名的通用写法 #抽卡帮助 → 三个游戏的总帮助图
        { reg: "^#?[ \\t]*抽卡(记录)?帮助$", fnc: "gachaHelpAll" },
        // 带游戏名但不带米哈游前缀：#原神抽卡帮助 / 原神抽卡帮助
        { reg: "^[#*%％]?[ \\t]*(?:原神|genshin|gs|GS)[ \\t]*抽卡(记录)?帮助$", fnc: "help" },
      ],
    })
  }
  /** #抽卡帮助：三个游戏的抽卡指令总览，渲染成一张图 */
  async gachaHelpAll(e) {
    const sections = [
      {
        key: 'gs', index: '01', title: '原神', desc: 'Genshin Impact',
        groups: [
          {
            title: '更新记录',
            items: [
              { cmd: '#米哈游原神更新抽卡记录', note: '用已绑定的 stoken/CK 自动换 authkey' },
              { cmd: '#米哈游原神抽卡链接 <链接>', note: '自动更新失败时贴小程序链接' },
              { cmd: '#米哈游原神超越抽卡 <链接>', note: '千星奇域记录' },
            ],
          },
          {
            title: '查询与导出',
            items: [
              { cmd: '#米哈游原神抽卡记录', note: '抽卡总览统计' },
              { cmd: '#米哈游原神当前卡池', note: '本期卡池与剩余时间' },
              { cmd: '#导出抽卡记录', note: '导出 UIGF 标准 JSON' },
            ],
          },
          {
            title: '提瓦特小助手',
            items: [
              { cmd: '#米哈游原神更新小助手记录', note: '拉小助手全量逐抽（含三星四星）' },
              { cmd: '#米哈游原神回传小助手', note: '把本地记录上传到小助手' },
              { cmd: '#米哈游原神导入小助手记录 <文件>', note: '导入导出的 UIGF/SRGF JSON' },
            ],
          },
        ],
      },
      {
        key: 'sr', index: '02', title: '星铁', desc: 'Honkai: Star Rail',
        groups: [
          {
            title: '更新记录',
            items: [
              { cmd: '#米哈游星铁更新抽卡记录', note: '免链接：临时登录一次游戏客户端换 authkey' },
              { cmd: '#米哈游星铁抽卡链接 <链接>', note: '粘贴游戏内跃迁记录链接' },
              { cmd: '#米哈游更新小助手抽卡记录', note: '从小助手云端拉全量（需 mysql2）' },
              { cmd: '#米哈游星铁更新星穹工坊记录', note: '星穹工坊云端补历史五星' },
            ],
            note: '免链接方式会让同账号在线游戏客户端掉线，仅支持国服官服本人账号。',
          },
          {
            title: '查询',
            items: [
              { cmd: '#米哈游星铁抽卡记录', note: '抽卡总览统计' },
              { cmd: '#米哈游星铁角色记录', note: '角色池进度' },
              { cmd: '#米哈游星铁武器记录', note: '光锥池进度' },
              { cmd: '#米哈游星铁常驻记录', note: '常驻池统计' },
            ],
          },
        ],
      },
      {
        key: 'zzz', index: '03', title: '绝区零', desc: 'Zenless Zone Zero',
        groups: [
          {
            title: '更新记录',
            items: [
              { cmd: '#米哈游绝区零更新抽卡记录', note: '通过绑定信息更新调频记录' },
              { cmd: '#米哈游绝区零抽卡链接 <链接>', note: '粘贴调频历史链接' },
              { cmd: '#米哈游云绝区零更新抽卡记录', note: '读 Windows 客户端或浏览器扫码' },
            ],
            note: '云绝区零在 Linux 走 SDK 二维码登录，无需浏览器。',
          },
          {
            title: '查询与导出',
            items: [
              { cmd: '#米哈游绝区零抽卡记录', note: '调频总览统计' },
              { cmd: '#米哈游绝区零全部记录', note: '各频段汇总' },
              { cmd: '#导出抽卡记录', note: '导出 UIGF 标准 JSON' },
            ],
          },
        ],
      },
    ]

    let sent = false
    try {
      // ret: true 由 render 统一发送图片，避免和调用方重复发送
      sent = await render('sr_gacha/gacha-help', { sections }, { e, ret: true })
    } catch (error) {
      logger.error(`[HoYoGet][抽卡帮助] 渲染失败：${error?.message || error}`)
    }
    if (sent) return true
    // 渲染失败退化成文本，保证一定能看到内容
    const lines = ['【抽卡帮助】']
    for (const section of sections) {
      lines.push('', `— ${section.title} —`)
      for (const group of section.groups) {
        for (const item of group.items) lines.push(`${item.cmd}  ${item.note || ''}`)
      }
    }
    return e.reply(lines.join('\n'))
  }

  async help(e) {
    /* 行数较多，改成合并转发；连接器不支持时 makeForwardMsg 会退回纯文本。 */
    const nodes = [
      [
        '【#米哈游原神抽卡帮助】',
        '',
        '更新数据',
        '#米哈游原神更新抽卡记录 —— 用已绑定的 stoken/CK 自动换 authkey 更新（无需链接）',
        '#米哈游原神抽卡链接 <链接> —— 自动更新失败时，粘贴游戏内复制的小程序链接更新',
        '#米哈游原神超越抽卡 <链接> —— 千星奇域记录，走新版 getBeyondGachaLog 接口',
      ].join('\n'),
      [
        '查询',
        '#米哈游原神抽卡记录 —— 抽卡总览统计（角色/武器分池）',
        '#米哈游原神抽卡统计 —— 同上，输出统计图',
        '#米哈游原神当前卡池 —— 本期卡池与剩余时间',
        '#米哈游原神卡池时间 —— 卡池剩余时间',
      ].join('\n'),
      [
        '提瓦特小助手',
        '#米哈游原神更新小助手记录 —— 从提瓦特小助手拉全量逐抽（含三星四星），自动去重合并',
        '#米哈游原神回传小助手 —— 把本地记录上传到提瓦特小助手（UIGF v2.3）',
        '#米哈游原神导入小助手记录 <文件> —— 导入小助手导出的 UIGF/SRGF JSON 补回历史',
      ].join('\n'),
      [
        '导出 / 其他',
        '#导出抽卡记录 —— 导出 UIGF 标准 JSON（可指名 UID）',
        '#米哈游原神角色列表 —— 已绑定角色一览',
        '#米哈游原神练度统计 —— 角色练度概览',
      ].join('\n'),
      [
        '提示',
        '米哈游前缀可省略：#更新抽卡记录、#抽卡记录、#抽卡帮助 默认按原神处理。',
        '若提示 authkey 获取失败，多为账号侧 CK 失效，重新扫码绑定或改用链接更新即可。',
        '千星奇域与常规卡池接口不同，需要使用「超越抽卡」指令。',
      ].join('\n'),
    ]
    return e.reply(await makeForwardMsg(e, nodes, '原神抽卡帮助'))
  }

  /** 本地 gs_gacha 数据 → UIGF v2.3 list（小助手只认 v2.3） */
  buildUigfList(uid) {
    const data = readData(dataFile(uid))
    if (!data?.pools) return []
    const typeByKey = Object.fromEntries(GS_POOLS.map(pool => [pool.key, pool.type]))
    const list = []
    for (const [key, pool] of Object.entries(data.pools)) {
      const gachaType = typeByKey[key] || pool.type || '200'
      for (const row of pool.records || []) {
        if (!row?.id) continue
        list.push({
          uid: String(uid),
          gacha_type: String(gachaType),
          uigf_gacha_type: String(gachaType),
          item_id: String(row.item_id || ''),
          count: String(Number(row.gacha_count) || 1),
          time: String(row.time || ''),
          name: String(row.name || '未知'),
          lang: 'zh-cn',
          item_type: String(row.item_type || ''),
          rank_type: String(row.rank_type || '5'),
          id: String(row.id),
        })
      }
    }
    list.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
    return list
  }

  /** 回传提瓦特小助手：UIGF v2.3 multipart + 官方祈愿链接（与 Mys 同一接口） */
  async uploadLelaer(e) {
    if (e.at || !e.user_id) return e.reply('只能回传自己的抽卡记录')
    const auth = await getAuth(e)
    if (auth.error) return e.reply(auth.error)
    const list = this.buildUigfList(auth.uid)
    if (!list.length) return e.reply(`UID:${auth.uid} 暂无可回传的本地原神抽卡记录，请先【#米哈游原神更新抽卡记录】`)
    let authkey = ''
    try {
      authkey = await getAuthKey(auth.uid, auth.region, auth.stokenCookie)
    } catch (error) {
      return e.reply(`回传失败：${error?.message || error}`)
    }
    const domestic = ['cn_gf01', 'cn_qd01'].includes(auth.region)
    const host = domestic ? 'https://public-operation-hk4e.mihoyo.com' : 'https://public-operation-hk4e-sg.hoyoverse.com'
    const query = new URLSearchParams({
      authkey_ver: '1',
      sign_type: '2',
      auth_appid: 'webview_gacha',
      lang: 'zh-cn',
      game_biz: domestic ? 'hk4e_cn' : 'hk4e_global',
      region: auth.region,
      authkey,
      gacha_type: '301',
      page: '1',
      size: '5',
      end_id: '0',
    })
    const gachaurl = `${host}/gacha_info/api/getGachaLog?${query}`
    const payload = {
      info: {
        uid: String(auth.uid),
        lang: 'zh-cn',
        uigf_version: 'v2.3',
        export_time: new Date().toISOString(),
        export_app: 'HoYoGet',
        export_app_version: 'HoYoGet',
      },
      list,
    }
    await e.reply(`正在把 UID:${auth.uid} 的 ${list.length} 条记录回传提瓦特小助手…`)
    try {
      const form = new FormData()
      form.set('upload', new File([JSON.stringify(payload)], 'data.json', { type: 'application/json' }))
      form.set('importType', 'uigf')
      form.set('gachaurl', gachaurl)
      const response = await fetch(LELAER_UPLOAD_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
      const text = await response.text()
      if (!response.ok || !text.includes('导入成功')) throw new Error('小助手未确认导入成功，请检查祈愿链接是否有效后重试')
      return e.reply(`✅ UID:${auth.uid} 已回传提瓦特小助手，请前往小程序查看`)
    } catch (error) {
      logger.warn(`[HoYoGet][gs_gacha] UID:${auth.uid} 小助手回传失败：${error?.message || error}`)
      return e.reply(`UID:${auth.uid} 回传失败：${error?.message || error}\n本地记录已保留，可稍后重试。`)
    }
  }

  /**
   * 更新小助手记录：调用提瓦特小助手 outputGacha.php 拉全量逐抽。
   * 入参是小助手认的「官方祈愿链接」，所以先用 stoken 换 authkey 自己拼一条。
   * 返回 { list } 或抛错。
   */
  async fetchLelaerGacha(uid, region, authkey) {
    const domestic = ['cn_gf01', 'cn_qd01'].includes(region)
    const host = domestic ? 'https://public-operation-hk4e.mihoyo.com' : 'https://public-operation-hk4e-sg.hoyoverse.com'
    const gachaURL = encodeURIComponent(
      `${host}/gacha_info/api/getGachaLog?authkey_ver=1&sign_type=2&auth_appid=webview_gacha`
      + `&init_type=301&gacha_id=fecafa7b6560db5f3182222395d88aaa6aaac1bc&timestamp=${Math.floor(Date.now() / 1000)}`
      + `&lang=zh-cn&device_type=mobile&plat_type=ios&region=${region}`
      + `&authkey=${encodeURIComponent(authkey)}&game_biz=${domestic ? 'hk4e_cn' : 'hk4e_global'}`
      + `&gacha_type=301&page=1&size=5&end_id=0`
    )
    const res = await fetch('https://www.lelaer.com/outputGacha.php', {
      method: 'POST',
      headers: { Host: 'www.lelaer.com', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `uid=${uid}&gachaurl=${gachaURL}&lang=zh-Hans`,
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`小助手接口 HTTP ${res.status}`)
    const json = await res.json().catch(() => null)
    if (!json) throw new Error('小助手返回内容无法解析')
    if (!Array.isArray(json.list)) throw new Error(json.result || '小助手未返回记录列表')
    return json.list
  }

  /** 把拉到的逐抽按池写入本地 gs_gacha（合并去重） */
  mergeLelaerRows(uid, rows) {
    const target = dataFile(uid)
    const data = readData(target) || { uid, pools: {} }
    const typeByKey = Object.fromEntries(GS_POOLS.map(pool => [pool.type, pool.key]))
    const stats = { added: 0, byType: {} }
    for (const row of rows) {
      const gachaType = String(row.uigf_gacha_type || row.gacha_type || '200')
      const key = typeByKey[gachaType]
      if (!key) continue
      const meta = GS_POOLS.find(pool => pool.key === key) || {}
      const pool = data.pools[key] ||= { key, type: gachaType, name: meta.name, records: [] }
      pool.records ||= []
      const id = String(row.id || '')
      if (!id || pool.records.some(r => String(r.id) === id)) continue
      const rank = String(row.rank_type || '')
      pool.records.push({
        id,
        name: String(row.name || '未知'),
        item_type: String(row.item_type || ''),
        is_up: !!row.is_up,
        gacha_count: Number(row.count) || 1,
        time: String(row.time || ''),
        rank_type: rank,
      })
      stats.added++
      stats.byType[gachaType] = (stats.byType[gachaType] || 0) + 1
    }
    if (!stats.added) return { stats, keep: false }
    for (const pool of Object.values(data.pools)) {
      pool.records.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
      pool.totalPulls = pool.records.length
      pool.fiveNum = pool.records.filter(r => String(r.rank_type || '5') === '5').length
      pool.fourNum = pool.records.filter(r => String(r.rank_type) === '4').length
    }
    data.update_time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    saveData(target, data)
    return { stats, keep: true }
  }

  /** 更新小助手记录：从提瓦特小助手拉全量逐抽并合并到本地 */
  async helperHelp(e) {
    if (e.at || !e.user_id) return e.reply('只能更新自己的抽卡记录')
    const auth = await getAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply(`正在从提瓦特小助手拉取 UID:${auth.uid} 的逐抽记录，请稍候……`)
    let authkey = ''
    try {
      authkey = await getAuthKey(auth.uid, auth.region, auth.stokenCookie)
    } catch (error) {
      return e.reply(`拉取失败：${error?.message || error}`)
    }
    let rows = []
    try {
      rows = await this.fetchLelaerGacha(auth.uid, auth.region, authkey)
    } catch (error) {
      return e.reply(`拉取失败：${error?.message || error}`)
    }
    if (!rows.length) return e.reply(`UID:${auth.uid} 小助手没有返回抽卡记录（说明该 UID 没在小助手同步过）`)
    const { stats } = this.mergeLelaerRows(auth.uid, rows)
    const names = { 301: '角色', 302: '武器', 500: '集录', 400: '集录', 200: '常驻' }
    const detail = Object.entries(stats.byType)
      .map(([type, count]) => `${names[type] || type}：新增 ${count}`)
      .join('，')
    return e.reply(`✅ UID:${auth.uid} 已从提瓦特小助手拉取 ${rows.length} 条，${detail || '无新增'}（自动去重）`)
  }
  /** 导入小助手导出的 UIGF/SRGF 文件（补回历史） */
  async importLelaer(e) {
    if (e.at || !e.user_id) return e.reply('只能导入自己的抽卡记录')
    // 取文件：优先消息里的文件，其次路径参数
    const fileInfo = e.file || (Array.isArray(e.message) ? e.message.find(m => m?.type === 'file')?.data : null)
    let raw = ''
    if (fileInfo?.url) {
      try {
        const res = await fetch(fileInfo.url, { signal: AbortSignal.timeout(30000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        raw = await res.text()
      } catch (error) {
        return e.reply(`下载文件失败：${error?.message || error}`)
      }
    } else {
      const arg = String(e.msg || '').replace(/^#\*米哈游原神导入小助手(抽卡|祈愿)?(记录|数据)/, '').trim()
      if (!arg) {
        return e.reply('请直接发送小助手导出的 JSON 文件，或在指令后附上机器人上的文件路径，例如：\n#米哈游原神导入小助手记录 data/HoYoGet-Plugin/import/uigf.json')
      }
      const target = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg)
      if (!fs.existsSync(target)) return e.reply(`找不到文件：${arg}`)
      raw = fs.readFileSync(target, 'utf8')
    }

    let json
    try { json = JSON.parse(raw) } catch { return e.reply('文件不是合法 JSON') }
    // 兼容 UIGF v2/v4、SRGF 三种结构
    const list = Array.isArray(json?.list) ? json.list
      : Array.isArray(json?.hk4e?.[0]?.list) ? json.hk4e[0].list
      : null
    if (!list?.length) return e.reply('文件里没有识别到抽卡记录（需要 UIGF 或 SRGF 格式）')

    const uid = String(json?.info?.uid || json?.hk4e?.[0]?.uid || list[0]?.uid || '')
    if (!/^\d{6,12}$/.test(uid)) return e.reply('文件里缺少有效的 UID')
    const target = dataFile(uid)
    const existing = readData(target) || { uid, pools: {} }
    const typeByKey = Object.fromEntries(GS_POOLS.map(pool => [pool.type, pool.key]))
    let added = 0
    for (const row of list) {
      const gachaType = String(row.gacha_type || row.uigf_gacha_type || '200')
      const key = typeByKey[gachaType]
      if (!key) continue
      const pool = existing.pools[key] ||= { key, type: gachaType, name: (GS_POOLS.find(p => p.key === key) || {}).name, records: [] }
      pool.records ||= []
      const id = String(row.id || '')
      if (!id || pool.records.some(r => String(r.id) === id)) continue
      pool.records.push({
        id,
        name: String(row.name || '未知'),
        item_type: String(row.item_type || (gachaType === '302' ? '武器' : '角色')),
        is_up: !!row.is_up,
        gacha_count: Number(row.count) || 1,
        time: String(row.time || ''),
        rank_type: String(row.rank_type || '5'),
        icon: '',
      })
      added++
    }
    if (!added) return e.reply(`UID:${uid} 没有新增记录（可能已全部存在）`)
    for (const pool of Object.values(existing.pools)) {
      pool.records.sort((a, b) => String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
      pool.totalPulls = pool.records.length
      pool.fiveNum = pool.records.filter(r => String(r.rank_type || '5') === '5').length
      pool.fourNum = pool.records.filter(r => String(r.rank_type) === '4').length
    }
    existing.update_time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    saveData(target, existing)
    return e.reply(`✅ 已导入 UID:${uid} 共 ${added} 条记录（来自小助手导出文件）`)
  }

  async updateByCookie(e) {
    const auth = await getAuth(e)
    if (auth.error) return e.reply(auth.error)
    await e.reply(`正在为 UID:${auth.uid} 获取原神抽卡记录，请稍候……`)
    let authkey = ""
    try {
      authkey = await getAuthKey(auth.uid, auth.region, auth.stokenCookie)
    } catch (error) {
      return e.reply(`更新失败：${error?.message || error}`)
    }
    return this.pull(e, { authkey, region: auth.region, gameBiz: "hk4e_cn", beyond: false }, auth.uid)
  }
  async updateByLink(e) {
    const ctx = parseLink(e)
    if (!ctx) return e.reply("没有找到原神抽卡链接。请在游戏内打开抽卡记录，复制链接后发送【#米哈游原神抽卡链接 <链接>】")
    await e.reply("正在获取原神抽卡记录，请稍候……")
    return this.pull(e, ctx, "")
  }
  async pull(e, ctx, uidHint) {
    const pools = {}
    let uid = uidHint || ""
    const failed = []
    for (const pool of GS_POOLS) {
      try {
        const rows = await fetchPool(ctx, pool)
        if (rows.length) {
          pools[pool.key] = buildPool(pool, rows)
          uid = uid || String(rows[0]?.uid || "")
        }
      } catch (error) {
        failed.push(`${pool.name}：${error?.message || error}`)
      }
    }
    if (!Object.keys(pools).length) {
      return e.reply(failed.length ? `更新失败：${failed[0]}` : "接口没有返回记录，可能链接已过期，或该账号近期没有抽卡")
    }
    const data = { uid: uid || uidHint || "未知", update_time: new Date().toLocaleString("zh-CN"), pools }
    if (data.uid !== "未知") saveData(dataFile(data.uid), data)
    try {
      await renderImage(e, data)
    } catch (error) {
      await e.reply(`${summarize(pools, data.uid)}\n（出图失败：${error?.message || error}）`)
      return true
    }
    if (failed.length) await e.reply(`部分卡池未取到：${failed.slice(0, 2).join("；")}`)
    return true
  }
  async summary(e) {
    ensureDir()
    const files = fs.readdirSync(DATA_DIR).filter(name => name.endsWith(".json"))
    if (!files.length) return e.reply("暂无原神抽卡记录，请先发送【#更新抽卡记录】")
    let uid = ""
    try {
      const NoteUser = await getNoteUser()
      const user = NoteUser ? await NoteUser.create(String(e.user_id || e.sender?.user_id || "")) : null
      uid = user?.getUid?.("gs") || ""
    } catch {}
    let file = uid ? path.join(DATA_DIR, `${uid}.json`) : ""
    if (!file || !fs.existsSync(file)) {
      files.sort((a, b) => fs.statSync(path.join(DATA_DIR, b)).mtimeMs - fs.statSync(path.join(DATA_DIR, a)).mtimeMs)
      file = path.join(DATA_DIR, files[0])
    }
    const data = readData(file)
    if (!data?.pools) return e.reply("本地记录读取失败，请重新执行【#更新抽卡记录】")
    try {
      return await renderImage(e, data)
    } catch (error) {
      return e.reply(`${summarize(data.pools, data.uid)}\n（出图失败：${error?.message || error}）`)
    }
  }
}

