import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { pluginPriority, render } from "#HoYoGet"
import { buildSummaryView, extractUrlsFromMsg, requestJson, sleep } from "../sr/sr_gacha.js"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(__dirname, "../..")
const DATA_DIR = path.join(PLUGIN_ROOT, "data", "cross_record")
const UA = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
const WUWA_HOST = "https://gmserver-api.aki-game2.com/gacha_record/api/getGachaLog"
const KURO_WIKI = "https://api.kurobbs.com/wiki/core/catalogue/item/getPage"
const MIYOUSHE_GAME_LIST = "https://bbs-api.miyoushe.com/apihub/api/getGameList"
const WUWA_POOLS = [
  { type: 1, name: "角色活动唤取" },
  { type: 2, name: "武器活动唤取" },
  { type: 3, name: "角色常驻唤取" },
  { type: 4, name: "武器常驻唤取" },
  { type: 5, name: "新手唤取" },
  { type: 6, name: "角色联动唤取" },
  { type: 7, name: "武器联动唤取" },
  { type: 8, name: "角色新旅唤取" },
  { type: 9, name: "武器新旅唤取" },
]
function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
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

﻿
function pickWuwaLink(e) {
  for (const url of extractUrlsFromMsg(e)) {
    if (!/aki-gm-resources|kurogames|kuro\.ltd/i.test(url)) continue
    try {
      const params = Object.fromEntries(new URLSearchParams(url.slice(url.indexOf("?") + 1)))
      const playerId = String(params.player_id || "")
      const cardPoolId = String(params.record_id || "")
      const serverId = String(params.svr_id || "")
      if (!playerId || !cardPoolId || !serverId) continue
      return { playerId, cardPoolId, serverId }
    } catch {
      continue
    }
  }
  return null
}
async function fetchWuwaPool(ctx, type) {
  const body = {
    playerId: ctx.playerId,
    cardPoolId: ctx.cardPoolId,
    cardPoolType: type,
    languageCode: "zh-Hans",
    serverId: ctx.serverId,
  }
  const { data } = await requestJson(WUWA_HOST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  })
  if (Number(data?.code) !== 0) throw new Error(String(data?.message || "接口返回异常"))
  return Array.isArray(data?.data) ? data.data : []
}
function summarizeWuwa(ctx, pools) {
  const lines = [`鸣潮抽卡记录  player_id:${ctx.playerId}`]
  for (const pool of WUWA_POOLS) {
    const rows = pools[pool.type] || []
    if (!rows.length) continue
    const five = rows.filter(row => Number(row?.qualityLevel) === 5)
    const avg = five.length ? (rows.length / five.length).toFixed(1) : "0.0"
    lines.push(`【${pool.name}】${rows.length} 抽 / ${five.length} 金 / 平均 ${avg} 抽`)
    for (const row of five.slice(-5)) lines.push(`  ${row?.name || "未知"}  ${row?.time || ""}`)
  }
  if (lines.length === 1) lines.push("接口没有返回记录")
  return lines.join("\n")
}
async function fetchKuroWiki(catalogueId) {
  const body = new URLSearchParams({ catalogueId, page: "1", limit: "20" })
  const { data } = await requestJson(KURO_WIKI, {
    method: "POST",
    headers: { "wiki_type": "9", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
    body: body.toString(),
  })
  return data?.data?.results?.records || []
}
function pickRows(data) {
  if (Array.isArray(data)) return data
  const candidates = [data?.data?.list, data?.data?.records, data?.data?.items, data?.list, data?.data, data?.records]
  for (const item of candidates) if (Array.isArray(item)) return item
  return []
}
function rowText(row) {
  if (!row || typeof row !== "object") return String(row || "")
  const name = row.name || row.item_name || row.title || row.resource_name || row.goods_name || "未知"
  const rank = row.rank_type || row.qualityLevel || row.rarity || row.star || row.grade || ""
  const time = row.time || row.gacha_time || row.create_time || row.created_at || ""
  return `${name}  ${rank ? `${rank} 星` : ""}  ${time}`.trim()
}

﻿
/** 鸣潮出图：与星铁、绝区零、原神共用同一视图与模板，仅数据源不同 */
async function renderWuwa(e, ctx, pools) {
  const view = {}
  for (const pool of WUWA_POOLS) {
    const rows = pools[pool.type]
    if (!rows || !rows.length) continue
    const records = []
    let counter = 0
    for (const row of rows.slice().reverse()) {
      counter += 1
      if (Number(row?.qualityLevel) !== 5) continue
      const ts = Date.parse(String(row?.time || "").replace(/-/g, "/")) || Date.now()
      records.push({ id: String(ts), name: row?.name || "未知", item_type: row?.resourceType || "", is_up: false, gacha_count: counter, time: String(row?.time || ""), icon: "" })
      counter = 0
    }
    const key = "WuwaPool" + pool.type
    view[key] = { key, name: pool.name, totalPulls: rows.length, fiveNum: records.length, upNum: 0, pity: counter, avgPity: records.length ? (records.reduce((sum2, r) => sum2 + Number(r.gacha_count || 0), 0) / records.length).toFixed(1) : "0.0", fourNum: 0, fourLog: [], records }
  }
  if (!Object.keys(view).length) throw new Error("没有可渲染的鸣潮记录")
  const summary = buildSummaryView({ pools: view }, ctx.playerId || "", e, "grid", "ww")
  const buf = await render("sr_gacha/summary", summary, { e })
  if (Buffer.isBuffer(buf)) return e.reply(segment.image(buf))
  return e.reply(buf)
}

export class cross_record extends plugin {
  constructor() {
    super({
      name: "[米哈游]跨厂商接口",
      dsc: "鸣潮抽卡记录、库洛wiki目录、米游社游戏列表与三方接口抓取",
      event: "message",
      priority: pluginPriority("cross_record", Number.MIN_SAFE_INTEGER),
      rule: [
        { reg: "^#*米哈游鸣潮抽卡帮助$", fnc: "help" },
        { reg: "^#*米哈游鸣潮抽卡链接", fnc: "wuwaLink" },
        { reg: "^#*米哈游鸣潮抽卡记录$", fnc: "wuwaSummary" },
        { reg: "^#*米哈游米游社游戏列表$", fnc: "gameList" },
        { reg: "^#*米哈游库洛wiki(?:\\s+(\\S+))?$", fnc: "kuroWiki" },
        { reg: "^#*米哈游抽卡接口", fnc: "rawApi" },
      ],
    })
  }
  async help(e) {
    return e.reply([
      "跨厂商接口（新增模块）",
      "#米哈游鸣潮抽卡链接 <链接> —— 解析唤取记录链接并拉取全部分池",
      "#米哈游鸣潮抽卡记录 —— 查看最近一次拉取结果",
      "#米哈游库洛wiki <目录ID> —— 读取库洛wiki目录下的条目",
      "#米哈游米游社游戏列表 —— 读取米游社游戏列表",
      "#米哈游抽卡接口 <接口地址> —— 抓取三方抽卡接口并按通用字段格式化",
    ].join("\n"))
  }
  async wuwaLink(e) {
    const ctx = pickWuwaLink(e)
    if (!ctx) return e.reply("没有找到鸣潮抽卡链接。请在游戏内打开唤取记录，复制链接后发送【#米哈游鸣潮抽卡链接 <链接>】")
    await e.reply("正在获取鸣潮抽卡记录，请稍候……")
    const pools = {}
    const failed = []
    for (const pool of WUWA_POOLS) {
      try {
        const rows = await fetchWuwaPool(ctx, pool.type)
        if (rows.length) pools[pool.type] = rows
      } catch (error) {
        failed.push(`${pool.name}：${error?.message || error}`)
      }
      await sleep(300)
    }
    if (!Object.keys(pools).length) {
      return e.reply(failed.length ? `拉取失败：${failed.slice(0, 3).join("；")}` : "接口没有返回记录，可能链接已过期")
    }
    saveData(path.join(DATA_DIR, `wuwa_${ctx.playerId}.json`), { player: ctx, update_time: new Date().toLocaleString("zh-CN"), pools })
    try {
      await renderWuwa(e, ctx, pools)
      return true
    } catch (error) {
      await e.reply("（出图失败：" + (error?.message || error) + "）")
    }
    return e.reply(summarizeWuwa(ctx, pools))
  }
  async wuwaSummary(e) {
    ensureDir()
    const files = fs.readdirSync(DATA_DIR).filter(name => name.startsWith("wuwa_") && name.endsWith(".json"))
    if (!files.length) return e.reply("暂无鸣潮抽卡记录，请先发送【#米哈游鸣潮抽卡链接 <链接>】")
    files.sort((a, b) => fs.statSync(path.join(DATA_DIR, b)).mtimeMs - fs.statSync(path.join(DATA_DIR, a)).mtimeMs)
    const data = readData(path.join(DATA_DIR, files[0]))
    if (!data) return e.reply("本地记录读取失败")
    return e.reply(summarizeWuwa(data.player || {}, data.pools || {}))
  }
  async gameList(e) {
    try {
      const { data } = await requestJson(MIYOUSHE_GAME_LIST, { headers: { "User-Agent": UA } })
      const list = data?.data?.list || []
      if (!list.length) return e.reply("接口没有返回游戏列表")
      const lines = ["米游社游戏列表"]
      for (const item of list.slice(0, 40)) lines.push(`${item?.name || item?.game_name || item?.id || "未知"}`)
      return e.reply(lines.join("\n"))
    } catch (error) {
      return e.reply(`获取失败：${error?.message || error}`)
    }
  }
  async kuroWiki(e) {
    const arg = String(e.msg || "").match(/库洛[Ww]iki\\s*(\\S+)?/)?.[1] || "1100"
    try {
      const records = await fetchKuroWiki(arg)
      if (!records.length) return e.reply(`目录 ${arg} 没有返回条目`)
      const lines = [`库洛wiki 目录 ${arg}`]
      for (const item of records.slice(0, 20)) lines.push(`${item?.name || item?.title || "未知"}`)
      return e.reply(lines.join("\n"))
    } catch (error) {
      return e.reply(`获取失败：${error?.message || error}`)
    }
  }
  async rawApi(e) {
    const urls = extractUrlsFromMsg(e)
    if (!urls.length) return e.reply("请提供完整接口地址，例如【#米哈游抽卡接口 https://...】")
    const url = urls[0]
    try {
      const { data } = await requestJson(url, { headers: { "User-Agent": UA, Accept: "application/json" } })
      const rows = pickRows(data)
      if (!rows.length) {
        const preview = JSON.stringify(data).slice(0, 300)
        return e.reply(`接口返回里没有找到记录数组，原始内容前 300 字：\n${preview}`)
      }
      const lines = [`接口返回 ${rows.length} 条`]
      for (const row of rows.slice(0, 10)) lines.push(rowText(row))
      return e.reply(lines.join("\n"))
    } catch (error) {
      return e.reply(`请求失败：${error?.message || error}`)
    }
  }
}

