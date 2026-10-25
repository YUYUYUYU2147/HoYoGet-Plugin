// 绝区零面板/挑战共用的随机背景图地址 + 背景图链接 JSON 留档
//
// 配置项 zzz_panel_bg_url：留空则用纯色底；非 http 地址（本地文件）原样返回。
// 随机图接口 URL 不变时 Chromium 会吃缓存，所以每次拼一个唯一参数强制重取。
//
// 留档文件：<HoYoGet-Plugin>/data/zzz_panel/panel_bg.json
// 结构：{ updatedAt, count, list: [{ msgId, url, time, group, user }] }

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '#HoYoGet'

const DEFAULT_PANEL_BG = 'https://api.yppp.net/api.php'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BG_DB_FILE = path.join(PLUGIN_ROOT, 'data', 'zzz_panel', 'panel_bg.json')
const BG_DB_MAX = 300

export function getPanelBg() {
  let url = DEFAULT_PANEL_BG
  try { url = String(config()?.zzz_panel_bg_url ?? DEFAULT_PANEL_BG).trim() } catch { /* 用默认 */ }
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export { DEFAULT_PANEL_BG }

function readBgDb() {
  try {
    const db = JSON.parse(fs.readFileSync(BG_DB_FILE, 'utf8'))
    if (!db || typeof db !== 'object' || !Array.isArray(db.list)) throw new Error('bad')
    return db
  } catch {
    return { updatedAt: 0, count: 0, list: [] }
  }
}

function writeBgDb(db) {
  try {
    fs.mkdirSync(path.dirname(BG_DB_FILE), { recursive: true })
    db.updatedAt = Date.now()
    db.count = db.list.length
    fs.writeFileSync(BG_DB_FILE, JSON.stringify(db, null, 2))
  } catch { /* 落盘失败不影响出图 */ }
}

// 记录「机器人面板消息 ID -> 该消息用的背景图(cdn 固定地址)」到 JSON
export function savePanelBg(msgId, url, e) {
  if (!msgId || !url) return
  const db = readBgDb()
  db.list = db.list.filter(x => x && x.msgId !== msgId)
  db.list.unshift({
    msgId,
    url,
    time: Date.now(),
    group: e?.group_id ? String(e.group_id) : '',
    user: e?.user_id != null ? String(e.user_id) : '',
  })
  db.list = db.list.slice(0, BG_DB_MAX)
  writeBgDb(db)
}

// 渲染后调用：落 JSON，另外保留 redis 快速缓存
export async function rememberPanelBg2Msg(sent, bgUrl, e) {
  const mid = sent?.message_id || sent?.data?.message_id
  if (!mid || !bgUrl) return
  savePanelBg(mid, bgUrl, e)
  if (typeof redis !== 'undefined') {
    redis.set('ZZZ:PANEL:BG:' + mid, bgUrl, { EX: 3600 * 24 * 30 }).catch(() => {})
  }
}

// 按消息 ID 查背景图（先 redis，miss 再查 JSON）
export async function lookupPanelBg(mid) {
  if (!mid) return ''
  if (typeof redis !== 'undefined') {
    const v = await redis.get('ZZZ:PANEL:BG:' + mid).catch(() => '')
    if (v) return v
  }
  const hit = readBgDb().list.find(x => x && String(x.msgId) === String(mid))
  return hit?.url || ''
}

// 列出 JSON 留档（最新在前）
// 通用：任何地方取到随机背景图都可调用，记入 JSON（这类没有消息ID，用唯一标识，不去重）
export function recordRandomBg(url, source = 'other', e = null) {
  if (!url || !/^https?:\/\//i.test(url)) return
  savePanelBg('bg:' + source + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 7), url, e)
}
export function listPanelBg(limit = 60) {
  return readBgDb().list.slice(0, limit)
}

// 跟随 302 取到 cdn 上的固定图片地址，并暂存到 e.__panelBg 供渲染后记录
export async function resolvePanelBg(e) {
  const url = getPanelBg()
  let final = url
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', Referer: 'https://api.yppp.net/' },
        signal: AbortSignal.timeout(8000),
      })
      res.body?.cancel?.()?.catch?.(() => {})
      final = /^https?:\/\//i.test(String(res.url || '')) ? res.url : url
    } catch {
      final = url
    }
  }
  if (e) e.__panelBg = final
  return final
}