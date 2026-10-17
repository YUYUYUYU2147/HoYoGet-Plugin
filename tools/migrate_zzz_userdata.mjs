/**
 * 把 ZZZ-Plugin 的用户数据迁移到 HoYoGet-Plugin（一次性脚本）。
 *
 * 迁移内容：
 *   1. data/Stoken/<QQ>.yaml —— 从 genshin SQLite 的 Users/MysUsers 里补 ZZZ 的 UID/CK
 *   2. data/zzz_gacha/zzz_plugin/<UID>.json —— 原样复制 ZZZ-Plugin 的逐抽记录
 *   3. data/CurrencyLedger/zzz/<QQ>.json —— 把 ZZZ-Plugin 的菲林月报合并进账本
 *
 * 不打印任何 UID / QQ / Cookie，只输出数量统计。
 * 运行：在 Yunzai 根目录执行 node plugins/HoYoGet-Plugin/tools/migrate_zzz_userdata.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import YAML from 'yaml'

const require = createRequire(import.meta.url)
const sqlite3 = require('sqlite3')

const YZ = process.cwd()
const HOYO = path.join(YZ, 'plugins', 'HoYoGet-Plugin')
const ZZZ = path.join(YZ, 'plugins', 'ZZZ-Plugin')
const DB_FILE = path.join(YZ, 'data', 'db', 'data.db')
const STOKEN_DIR = path.join(HOYO, 'data', 'Stoken')
const GACHA_OUT = path.join(HOYO, 'data', 'zzz_gacha', 'zzz_plugin')
const LEDGER_DIR = path.join(HOYO, 'data', 'CurrencyLedger', 'zzz')

const ZZZ_ACTION_NAME = {
  event_rewards: '活动奖励',
  daily_activity_rewards: '日常活跃奖励',
  shiyu_rewards: '式舆防卫战&危局强袭战奖励',
  mail_rewards: '邮件奖励',
  growth_rewards: '成长奖励',
  hollow_rewards: '零号空洞奖励',
  other_rewards: '其他奖励',
}

const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => err ? reject(err) : resolve(rows)))
const safeJson = (v, fallback = {}) => {
  try { return JSON.parse(v) } catch { return fallback }
}

async function buildAuthMap() {
  if (!fs.existsSync(DB_FILE)) return { byUid: new Map(), ltToQq: new Map() }
  const db = new sqlite3.Database(DB_FILE)
  const users = await all(db, 'SELECT id,ltuids,games FROM Users')
  const mys = await all(db, 'SELECT ltuid,ck,uids FROM MysUsers')
  db.close()

  const ltToQq = new Map()
  for (const u of users) {
    for (const lt of String(u.ltuids || '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (!ltToQq.has(lt)) ltToQq.set(lt, String(u.id))
    }
  }

  const byUid = new Map()
  // 先按 MysUsers.uids.zzz 建立 UID -> CK
  for (const m of mys) {
    const qq = ltToQq.get(String(m.ltuid))
    if (!qq || !m.ck) continue
    const uids = safeJson(m.uids, {})
    for (const uid of Object.keys(uids.zzz || {})) {
      if (!byUid.has(String(uid))) {
        byUid.set(String(uid), { qq, ltuid: String(m.ltuid), ck: String(m.ck) })
      }
    }
  }
  // 再用 Users.games.zzz.uid 兜底（有些账号的 MysUsers.uids 没写 zzz）
  for (const u of users) {
    const qq = String(u.id)
    const g = safeJson(u.games, {})
    const uid = g.zzz?.uid
    if (!uid || byUid.has(String(uid))) continue
    const lts = String(u.ltuids || '').split(',').map(s => s.trim()).filter(Boolean)
    const hit = mys.find(m => lts.includes(String(m.ltuid)) && m.ck)
    if (hit) byUid.set(String(uid), { qq, ltuid: String(hit.ltuid), ck: String(hit.ck) })
  }
  return { byUid, ltToQq }
}

function writeStoken(uid, auth) {
  const file = path.join(STOKEN_DIR, `${auth.qq}.yaml`)
  let data = {}
  try { data = YAML.parse(fs.readFileSync(file, 'utf8')) || {} } catch { data = {} }
  const old = data[uid] || {}
  data[uid] = {
    uid: String(uid),
    stuid: String(auth.ltuid),
    ck_stoken: old.ck_stoken || auth.ck,
    mid: old.mid || '',
    game_biz: 'nap_cn',
    region_name: old.region_name || '官服',
    region: old.region || 'prod_gf_cn',
  }
  fs.mkdirSync(STOKEN_DIR, { recursive: true })
  fs.writeFileSync(file, YAML.stringify(data), 'utf8')
  return !old.ck_stoken
}

function migrateGacha() {
  const dir = path.join(ZZZ, 'data', 'gacha')
  if (!fs.existsSync(dir)) return { copied: 0, total: 0 }
  fs.mkdirSync(GACHA_OUT, { recursive: true })
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  for (const f of files) fs.copyFileSync(path.join(dir, f), path.join(GACHA_OUT, f))
  return { copied: files.length, total: files.length }
}

function migrateMonthly(authByUid) {
  const dir = path.join(ZZZ, 'data', 'monthly')
  if (!fs.existsSync(dir)) return { months: 0, uids: 0, skipped: 0 }
  let months = 0, uids = 0, skipped = 0
  fs.mkdirSync(LEDGER_DIR, { recursive: true })
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const uid = f.replace(/\.json$/, '')
    const auth = authByUid.get(uid)
    if (!auth) { skipped++; continue }
    let rows = []
    try { rows = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { skipped++; continue }
    if (!Array.isArray(rows)) rows = [rows]
    const file = path.join(LEDGER_DIR, `${auth.qq}.json`)
    let ledger = {}
    try { ledger = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { ledger = {} }
    let changed = false
    for (const row of rows) {
      const ym = String(row?.data_month || row?.current_month || '')
      if (!/^\d{6}$/.test(ym)) continue
      if (ledger[ym] && Number(ledger[ym].monthTotal || 0) > 0) continue
      const md = row?.month_data || {}
      const list = Array.isArray(md.list) ? md.list : []
      const total = Number(list.find(i => i.data_type === 'PolychromesData')?.count || 0)
      const components = Array.isArray(md.income_components) ? md.income_components : []
      ledger[ym] = {
        monthTotal: total,
        lastMonth: 0,
        gacha: 0,
        list: components.map(i => ({
          name: ZZZ_ACTION_NAME[i.action] || i.action || '其他奖励',
          num: Number(i.num || 0),
          icon: '',
        })),
        nickname: row?.role_info?.nickname || ledger[ym]?.nickname || '',
        avatar: row?.role_info?.avatar || ledger[ym]?.avatar || '',
        serverName: '',
        uid: String(row?.uid || uid),
        saveTime: new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'),
      }
      months++
      changed = true
    }
    if (changed) {
      fs.writeFileSync(file, JSON.stringify(ledger, null, '\t'), 'utf8')
      uids++
    }
  }
  return { months, uids, skipped }
}

const { byUid } = await buildAuthMap()
let stokenNew = 0, stokenUpdated = 0, noAuth = 0
for (const uid of byUid.keys()) {
  const auth = byUid.get(uid)
  const isNew = writeStoken(uid, auth)
  if (isNew) stokenNew++
  else stokenUpdated++
}
const gacha = migrateGacha()
const monthly = migrateMonthly(byUid)
for (const f of fs.existsSync(path.join(ZZZ, 'data', 'gacha')) ? fs.readdirSync(path.join(ZZZ, 'data', 'gacha')) : []) {
  if (!f.endsWith('.json')) continue
  if (!byUid.has(f.replace(/\.json$/, ''))) noAuth++
}

console.log('迁移完成：')
console.log(`  Stoken：新增 ${stokenNew} 条，更新 ${stokenUpdated} 条`)
console.log(`  逐抽记录：复制 ${gacha.copied}/${gacha.total} 个文件`)
console.log(`  菲林月报：合并 ${monthly.months} 个月份，涉及 ${monthly.uids} 个账号，跳过 ${monthly.skipped} 个`)
console.log(`  没有可用 CK 的抽卡 UID：${noAuth} 个（只复制了记录，未写入 Stoken）`)
