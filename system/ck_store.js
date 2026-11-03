/**
 * 米游社 CK / SK 管理（锅巴用）。
 *
 * 数据就是 data/Stoken/<QQ>.yaml，结构：
 *   账号条目（key 为游戏 UID，值为以下字段；均为脱敏示例）：
 *     uid       游戏 UID
 *     stuid     米游社通行证 id（敏感）
 *     stoken    刷新用凭证（敏感）
 *     ck_stoken 实际请求用的 cookie 串
 *     ltoken / mid / game_biz / region_name / region
 *
 * 这里只做读写，不发网络请求。写盘用 parseDocument 保留原有排版与注释。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, 'data', 'Stoken')

const GAME_BIZ = { hk4e_cn: 'gs', hkrpg_cn: 'sr', nap_cn: 'zzz', bh3_cn: 'bh3' }
const REGION_NAME = { 天空岛: 'gs', 世界树: 'gs', 星穹列车: 'sr', 新艾利都: 'zzz' }
const BH3_REGIONS = new Set(['android01', 'ios01', 'pc01', 'bb01', 'yyb01', 'hun01', 'hun02'])
export const GAME_NAMES = { gs: '原神', sr: '崩坏：星穹铁道', zzz: '绝区零', bh3: '崩坏3' }

export function gameOfEntry(entry) {
  const byBiz = GAME_BIZ[String(entry?.game_biz || '')]
  if (byBiz) return byBiz
  const byName = REGION_NAME[String(entry?.region_name || '')]
  if (byName) return byName
  return BH3_REGIONS.has(String(entry?.region || '')) ? 'bh3' : ''
}

function fileOf(qq) {
  const q = String(qq || '').replace(/[^\d]/g, '')
  if (!q) return ''
  return path.join(DIR, `${q}.yaml`)
}

function readDoc(qq) {
  const file = fileOf(qq)
  if (!file) return null
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { file, doc: YAML.parseDocument('{}'), raw: '', exists: false }
  }
  let doc
  try {
    doc = YAML.parseDocument(raw)
  } catch {
    return { file, doc: YAML.parseDocument('{}'), raw, exists: true, broken: true }
  }
  return { file, doc, raw, exists: true }
}

function writeDoc(file, doc, raw) {
  const out = doc.toString()
  if (out === raw) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, out, 'utf8')
  return true
}

/** 掩码：只留尾部，够核对不泄露 */
function mask(v, keep = 4) {
  const s = String(v || '')
  if (!s) return ''
  if (s.length <= keep) return s
  return `${'*'.repeat(Math.min(8, s.length - keep))}${s.slice(-keep)}`
}

/** 从 cookie 串里取某个键 */
function cookieValue(ck, key) {
  const m = String(ck || '').match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`))
  return m ? m[1] : ''
}

function summarize(qq, uid, entry) {
  const game = gameOfEntry(entry)
  const ck = String(entry?.ck_stoken || '')
  const hasCk = /cookie_token=/.test(ck) && /ltoken=/.test(ck)
  const hasSk = !!String(entry?.stoken || '')
  return {
    qq: String(qq),
    uid: String(uid),
    game,
    gameName: GAME_NAMES[game] || '未知',
    region: String(entry?.region_name || entry?.region || ''),
    stuidMask: mask(entry?.stuid, 4),
    midMask: mask(entry?.mid, 4),
    hasCk,
    hasSk,
    hasLtoken: !!String(entry?.ltoken || ''),
    // ck 只回掩码，完整值走 /ck/get
    ckMask: hasCk ? mask(cookieValue(ck, 'cookie_token'), 4) : '',
    skMask: hasSk ? mask(entry?.stoken, 4) : '',
  }
}

/**
 * 列出绑定。
 * @param {{qq?:string, game?:string}} opts
 */
export function listAccounts(opts = {}) {
  let files = []
  try {
    files = fs.readdirSync(DIR).filter(f => f.endsWith('.yaml'))
  } catch {
    return []
  }
  const qqFilter = String(opts.qq || '').trim()
  const gameFilter = String(opts.game || '').trim()
  const out = []
  for (const f of files) {
    const qq = f.replace(/\.yaml$/, '')
    if (qqFilter && !qq.includes(qqFilter)) continue
    let data = {}
    try {
      data = YAML.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) || {}
    } catch {
      continue
    }
    for (const [uid, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== 'object') continue
      if (!/^\d+$/.test(String(uid)) || Number(uid) <= 0) continue
      const s = summarize(qq, uid, entry)
      if (gameFilter && s.game !== gameFilter) continue
      out.push(s)
    }
  }
  out.sort((a, b) => (a.qq === b.qq ? a.uid.localeCompare(b.uid) : a.qq.localeCompare(b.qq)))
  return out
}

/** 取完整条目（含 ck/stoken 原文），锅巴里点「显示」时才调用 */
export function getAccount(qq, uid) {
  const r = readDoc(qq)
  if (!r) return null
  const entry = r.doc.get(String(uid))
  if (!entry) return null
  const v = typeof entry?.toJSON === 'function' ? entry.toJSON() : entry
  return {
    qq: String(qq),
    uid: String(uid),
    game: gameOfEntry(v),
    gameName: GAME_NAMES[gameOfEntry(v)] || '未知',
    region: String(v?.region_name || v?.region || ''),
    stuid: String(v?.stuid || ''),
    mid: String(v?.mid || ''),
    ltoken: String(v?.ltoken || ''),
    stoken: String(v?.stoken || ''),
    ck_stoken: String(v?.ck_stoken || ''),
    game_biz: String(v?.game_biz || ''),
    region_name: String(v?.region_name || ''),
  }
}

/**
 * 保存/更新一个账号。
 * @param {string} qq
 * @param {string} uid
 * @param {{ck?:string, stoken?:string, ltoken?:string, mid?:string, stuid?:string,
 *          game_biz?:string, region_name?:string, region?:string}} patch
 */
export function saveAccount(qq, uid, patch = {}) {
  const r = readDoc(qq)
  if (!r) throw new Error('QQ 不合法')
  const key = String(uid || '').trim()
  if (!/^\d+$/.test(key) || Number(key) <= 0) throw new Error('UID 不合法')

  const prev = r.doc.get(key)
  const prevObj = typeof prev?.toJSON === 'function' ? prev.toJSON() : (prev || {})
  const next = { ...prevObj, uid: key }

  const setIf = (k, v) => {
    if (v === undefined || v === null) return
    const s = String(v).trim()
    if (!s) return
    next[k] = s
  }

  // ck 支持三种写法：完整 cookie / 只给 cookie_token / 只给 ltoken
  const ckRaw = String(patch.ck || '').trim()
  if (ckRaw) {
    if (ckRaw.includes('=')) {
      // 已经是完整 cookie 串：补齐 stuid/mid（若原条目有而新串没有）
      let ck = ckRaw.replace(/\s+/g, '')
      const stuid = cookieValue(ck, 'stuid') || prevObj.stuid || ''
      const mid = cookieValue(ck, 'mid') || prevObj.mid || ''
      if (stuid && !cookieValue(ck, 'stuid')) ck += `${ck.endsWith(';') ? '' : ';'}stuid=${stuid};`
      if (mid && !cookieValue(ck, 'mid')) ck += `${ck.endsWith(';') ? '' : ';'}mid=${mid};`
      next.ck_stoken = ck
      if (stuid) next.stuid = String(stuid)
      if (mid) next.mid = String(mid)
      const ct = cookieValue(ck, 'cookie_token')
      if (ct) next.cookie_token = ct
      const lt = cookieValue(ck, 'ltoken')
      if (lt) next.ltoken = lt
    } else {
      // 当成 cookie_token 值
      const stuid = prevObj.stuid || ''
      const mid = prevObj.mid || ''
      next.cookie_token = ckRaw
      const parts = []
      if (stuid) parts.push(`stuid=${stuid}`)
      if (mid) parts.push(`mid=${mid}`)
      parts.push(`cookie_token=${ckRaw}`)
      if (prevObj.ltoken) parts.push(`ltoken=${prevObj.ltoken}`)
      next.ck_stoken = `${parts.join(';')};`
    }
  }

  setIf('stoken', patch.stoken)
  setIf('ltoken', patch.ltoken)
  setIf('mid', patch.mid)
  setIf('stuid', patch.stuid)
  setIf('game_biz', patch.game_biz)
  setIf('region_name', patch.region_name)
  setIf('region', patch.region)

  // 有 stoken 却没有 ck_stoken 时，至少拼一个 stoken 版 cookie
  if (next.stoken && !next.ck_stoken) {
    const parts = []
    if (next.stuid) parts.push(`stuid=${next.stuid}`)
    parts.push(`stoken=${next.stoken}`)
    if (next.mid) parts.push(`mid=${next.mid}`)
    next.ck_stoken = `${parts.join(';')};`
  }

  r.doc.set(key, next)
  const changed = writeDoc(r.file, r.doc, r.raw)
  return { changed, account: summarize(qq, key, next) }
}

/** 删除一个账号 */
export function deleteAccount(qq, uid) {
  const r = readDoc(qq)
  if (!r) throw new Error('QQ 不合法')
  const key = String(uid)
  if (!r.doc.has(key)) return false
  r.doc.delete(key)
  writeDoc(r.file, r.doc, r.raw)
  return true
}

export default { listAccounts, getAccount, saveAccount, deleteAccount, GAME_NAMES }
