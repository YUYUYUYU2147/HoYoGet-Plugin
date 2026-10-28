/**
 * 内置的 NoteUser 兼容实现。
 *
 * 背景：genshin 插件的 model/mys/NoteUser.js 长期是本插件的跨插件依赖，
 * 未安装 genshin 时，所有依赖用户绑定的功能（便笺、签到、札记、抽卡记录）
 * 都会因模块缺失而不可用。
 *
 * 这里按实际调用面最小实现同一套接口：
 *   NoteUser.create(qq | e) -> 实例
 *   实例：getUid(game) / getUidList(game) / getMysUser(game) / mysUsers / hasCk
 *
 * 数据来源均为本机数据，不依赖任何插件进程：
 *   1. 本插件 data/Stoken/<QQ>.yaml —— 扫码登录写入，主来源；
 *   2. 框架 sqlite data/db/data.db 的 MysUsers 表 —— 历史绑定数据，
 *      存在时作为补充，不存在或读取失败则跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getAccount, listAccounts, gameOfEntry } from '../../../../ck_store.js'

const GAMES = ['gs', 'sr', 'zzz', 'bh3']

/** 从 cookie 串取某个键的值 */
function cookieValue(ck, key) {
  const m = String(ck || '').match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`))
  return m ? m[1] : ''
}

/** UID 合法性：原神/星铁/绝区零/崩三都是 6~12 位数字 */
function isUid(uid) {
  return /^\d{6,12}$/.test(String(uid || ''))
}

function pickQq(arg) {
  if (!arg) return ''
  if (typeof arg === 'object') {
    return String(arg.user_id || arg.sender?.user_id || arg.userId || arg.qq || '')
  }
  return String(arg).replace(/[^\d]/g, '')
}

/**
 * 米游社账号（一个 ltuid 对应一份 Cookie）。
 * uids 按游戏分组，形如 { gs: ['100000000'], sr: [] }。
 */
export class MysUser {
  constructor({ ltuid = '', ck = '', uids = {}, stuid = '', stoken = '' } = {}) {
    this.ltuid = String(ltuid || stuid || '')
    this.stuid = String(stuid || ltuid || '')
    this.ck = String(ck || '')
    this.stoken = String(stoken || '')
    this.uids = {}
    for (const game of GAMES) {
      const list = Array.isArray(uids?.[game]) ? uids[game] : []
      this.uids[game] = list.map(v => String(v)).filter(Boolean)
    }
  }

  getUidList(game) {
    return this.uids[game] || []
  }

  getUid(game) {
    return this.getUidList(game)[0] || ''
  }

  get hasCk() {
    return /ltoken=|cookie_token=/.test(this.ck)
  }
}

/** 读取本插件 data/Stoken/<QQ>.yaml，返回账号条目 */
function loadFromStoken(qq) {
  const out = []
  let rows = []
  try {
    rows = listAccounts({ qq })
  } catch {
    return out
  }
  for (const row of rows) {
    if (String(row.qq) !== String(qq)) continue
    const acc = getAccount(qq, row.uid)
    if (!acc) continue
    const game = acc.game || gameOfEntry(acc)
    if (!game || !isUid(acc.uid)) continue
    out.push({
      ltuid: acc.stuid || cookieValue(acc.ck_stoken, 'ltuid') || cookieValue(acc.ck_stoken, 'stuid'),
      stoken: acc.stoken,
      ck: acc.ck_stoken,
      game,
      uid: String(acc.uid),
    })
  }
  return out
}

/** 读取框架 sqlite 的历史 MysUsers 表（存在才读，失败静默） */
async function loadFromSqlite() {
  const file = path.resolve(process.cwd(), 'data/db/data.db')
  if (!fs.existsSync(file)) return []
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare('select ltuid, ck, uids from MysUsers').all()
    return rows.map(r => {
      let uids = {}
      try {
        uids = JSON.parse(r.uids || '{}')
      } catch {
        uids = {}
      }
      return { ltuid: String(r.ltuid || ''), ck: String(r.ck || ''), uids }
    })
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* 只读连接关闭失败不影响结果 */
    }
  }
}

export default class NoteUser {
  constructor(qq, data = {}) {
    this.qq = String(qq || '')
    /** 游戏 -> UID 列表 */
    this.uid = {}
    for (const game of GAMES) {
      const list = Array.isArray(data.uid?.[game]) ? data.uid[game] : []
      this.uid[game] = list.map(v => String(v)).filter(Boolean)
    }
    /** ltuid -> MysUser */
    this.mysUsers = {}
    for (const [ltuid, mu] of Object.entries(data.mysUsers || {})) {
      if (!ltuid) continue
      this.mysUsers[ltuid] = mu instanceof MysUser ? mu : new MysUser({ ltuid, ...mu })
    }
  }

  /**
   * 按 QQ 或事件对象构建。
   * 传入事件对象时与上游行为一致：把实例挂到 e.user，调用方可自行还原。
   */
  static async create(arg) {
    const qq = pickQq(arg)
    if (!qq) return null

    const uidMap = {}
    for (const game of GAMES) uidMap[game] = []
    const mysUsers = {}

    const attach = (ltuid, ck, game, uid, stoken = '') => {
      const key = String(ltuid || '')
      if (!key) return
      if (!mysUsers[key]) mysUsers[key] = new MysUser({ ltuid: key, ck, stoken })
      const mu = mysUsers[key]
      if (!mu.ck && ck) mu.ck = String(ck)
      if (!mu.stoken && stoken) mu.stoken = String(stoken)
      if (!game || !isUid(uid)) return
      const id = String(uid)
      if (!mu.uids[game]) mu.uids[game] = []
      if (!mu.uids[game].includes(id)) mu.uids[game].push(id)
      if (!uidMap[game].includes(id)) uidMap[game].push(id)
    }

    for (const row of loadFromStoken(qq)) {
      attach(row.ltuid, row.ck, row.game, row.uid, row.stoken)
    }

    for (const row of await loadFromSqlite()) {
      for (const game of GAMES) {
        const list = Array.isArray(row.uids?.[game]) ? row.uids[game] : []
        for (const uid of list) attach(row.ltuid, row.ck, game, uid)
      }
    }

    const user = new NoteUser(qq, { uid: uidMap, mysUsers })
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      try {
        arg.user = user
      } catch {
        /* 只读事件对象保持原样 */
      }
    }
    return user
  }

  /** 该游戏的主 UID（第一个绑定的） */
  getUid(game = 'gs') {
    return this.getUidList(game)[0] || ''
  }

  /** 该游戏的全部 UID */
  getUidList(game = 'gs') {
    return this.uid[game] || []
  }

  /** 该游戏对应的米游社账号；多账号时取第一个持有该游戏 UID 的 */
  getMysUser(game = 'gs') {
    for (const mu of Object.values(this.mysUsers)) {
      if (mu && mu.getUidList(game).length) return mu
    }
    if (this.getUidList(game).length) {
      // 有条目但账号分组缺失时，退回第一个带 Cookie 的账号
      return Object.values(this.mysUsers).find(mu => mu?.ck)
    }
    return undefined
  }

  /** 是否任一账号持有可用 Cookie */
  get hasCk() {
    return Object.values(this.mysUsers).some(mu => mu?.hasCk)
  }

  /** 遍历所有已绑定 QQ（排行等场景），回调参数为实例与 QQ */
  static async forEach(fn) {
    const dir = path.resolve(process.cwd(), 'plugins/HoYoGet-Plugin/data/Stoken')
    let files = []
    try {
      files = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const file of files) {
      if (!file.endsWith('.yaml')) continue
      const qq = file.replace(/\.yaml$/, '')
      const user = await NoteUser.create(qq)
      if (user) await fn(user, qq)
    }
  }
}
