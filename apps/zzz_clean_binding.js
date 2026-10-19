/**
 * 清理失效的绝区零绑定（仅主人）。
 *
 * 指令：%清理失效CK
 *
 * 「失效」的判定（三个条件同时满足才算，宁可漏删不可误删）：
 *   1. Users.games 里有 zzz.uid；
 *   2. 该 QQ 的 ltuids 里没有任何一个能在 MysUsers 表里找到非空 CK；
 *   3. 本插件 data/Stoken/<QQ>.yaml 不存在。
 *
 * 为什么不能只看 ltuids 为空：
 *   部分老数据 ltuids 没写，但 Stoken 文件里有 CK，删了会误伤还能用的用户。
 *
 * 删除动作只做一件事：把 Users.games 里的 zzz 字段清掉（uid 置空、data 清空），
 * 不动其他游戏的绑定。不做物理删除行 —— Yunzai 的 Users 表是公共表，
 * 其他插件可能还在用，留行更安全。
 */
import fs from 'node:fs'
import path from 'node:path'

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
const YUNZAI_DB = path.join(process.cwd(), 'data', 'db', 'data.db')
const STOKEN_DIR = path.join(PLUGIN_ROOT, 'data', 'Stoken')
const ZZZ_UID_RE = /^\d{8,9}$/

/** 扫描全部 zzz 绑定，返回 { valid: [...], invalid: [...] } */
export async function scanBindings() {
  if (!fs.existsSync(YUNZAI_DB)) return { error: '找不到 Yunzai 数据库' }
  const sqlite3 = (await import('sqlite3')).default
  const db = new sqlite3.Database(YUNZAI_DB, sqlite3.OPEN_READONLY)
  const run = (sql, p = []) => new Promise((resolve, reject) => {
    db.all(sql, p, (err, rows) => (err ? reject(err) : resolve(rows || [])))
  })
  try {
    const users = await run('select id, ltuids, games from Users')
    const mys = await run("select ltuid, ck from MysUsers where ck is not null and ck != ''")
    const validLt = new Set(mys.map(r => String(r.ltuid)))

    const valid = []
    const invalid = []
    for (const u of users) {
      let games = {}
      try { games = JSON.parse(u.games || '{}') } catch { continue }
      const uid = String(games?.zzz?.uid || '').trim()
      if (!ZZZ_UID_RE.test(uid)) continue

      const lts = String(u.ltuids || '').split(',').map(s => s.trim()).filter(Boolean)
      const byLtuid = lts.some(l => validLt.has(l))
      const hasStoken = fs.existsSync(path.join(STOKEN_DIR, `${u.id}.yaml`))
      const item = { qq: String(u.id), uid }
      if (byLtuid || hasStoken) valid.push({ ...item, byLtuid, hasStoken })
      else invalid.push(item)
    }
    return { valid, invalid }
  } finally {
    db.close(() => {})
  }
}

/**
 * 清掉指定 QQ 的 zzz 绑定（只改 games 里的 zzz 字段）。
 * 返回实际处理的条数；失败的 QQ 会出现在 errors 里。
 */
export async function removeZzzBindings(qqs) {
  if (!fs.existsSync(YUNZAI_DB)) return { error: '找不到 Yunzai 数据库' }
  const sqlite3 = (await import('sqlite3')).default
  const db = new sqlite3.Database(YUNZAI_DB)
  const get = (sql, p = []) => new Promise((resolve, reject) => {
    db.get(sql, p, (err, row) => (err ? reject(err) : resolve(row)))
  })
  const run = (sql, p = []) => new Promise((resolve, reject) => {
    db.run(sql, p, err => (err ? reject(err) : resolve()))
  })

  let done = 0
  const errors = []
  try {
    for (const qq of qqs) {
      try {
        const row = await get('select games from Users where id = ?', [qq])
        if (!row) { errors.push(`${qq}: 用户不存在`); continue }
        let games = {}
        try { games = JSON.parse(row.games || '{}') } catch { games = {} }
        if (!games?.zzz) { errors.push(`${qq}: 已无 zzz 绑定`); continue }
        /* 只清 zzz，保留 gs / sr / bh3 等其他游戏 */
        games.zzz = { uid: '', data: {} }
        await run('update Users set games = ?, updatedAt = datetime(\'now\') where id = ?', [JSON.stringify(games), qq])
        done++
      } catch (err) {
        errors.push(`${qq}: ${err?.message || err}`)
      }
    }
  } finally {
    db.close(() => {})
  }
  return { done, errors }
}
