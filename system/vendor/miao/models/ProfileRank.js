import lodash from "lodash"
import moment from "moment"
import { Cfg, Data, Version } from "#hoyo.miao"

/**
 * redis 键前缀：原先用 miao:rank:*，本插件内置后改 hoyo:rank:*。
 * 迁移期保留双前缀：写入用新前缀，扫描/解析同时认旧的。
 */
const RANK_PREFIX = 'hoyo:rank:'
const LEGACY_PREFIX = 'miao:rank:'
/* 把任意 rank key 归一成逻辑键（去掉任一前缀），用于解析角色 id */
const stripPrefix = (k) => String(k || '').replace(/^(?:hoyo|miao):rank:/, '')

class ProfileRank {
  constructor(data, game = "gs") {
    this.groupId = data.groupId || data.groupId || ""
    if (!this.groupId || this.groupId === "undefined") return false
    this.qq = data.qq
    this.uid = data.uid + ""
    this.game = game
    this.allowRank = false
  }

  static async create(data, game = "gs") {
    let rank = new ProfileRank(data, game)
    rank.allowRank = await ProfileRank.checkRankLimit(rank.uid, game)
    return rank
  }

  static getCharacterFromKey(key, game = "gs") {
    if (game === "gs") {
      // 原神的角色id都是8位
      return /^[\w-]+:(?:mark|dmg|crit|valid):(\d{8})$/.exec(stripPrefix(key))
    } else {
      // 星铁的角色id都是4位
      return /^[\w-]+:(?:mark|dmg|crit|valid):(\d{4})$/.exec(stripPrefix(key))
    }
  }

  /**
   * 获取群排行UID
   * @param groupId
   * @param charId
   * @param type
   * @returns {Promise<string|boolean>}
   */
  static async getGroupMaxUid(groupId, charId, type = "mark") {
    let uids = await redis.zRange(`${RANK_PREFIX}${groupId}:${type}:${charId}`, -1, -1)
    if (!uids?.length) {
      uids = await redis.zRange(`${LEGACY_PREFIX}${groupId}:${type}:${charId}`, -1, -1)
    }
    return uids ? uids[0] : false
  }

  static async getGroupMaxUidList(groupId, type = "mark", game = "gs") {
    let keys = [ ...await redis.keys(`${RANK_PREFIX}${groupId}:${type}:*`), ...await redis.keys(`${LEGACY_PREFIX}${groupId}:${type}:*`) ]
    /* 新旧前缀都会扫到同一个角色，按 charId 去重，避免列表里出现两条一样的 */
    let charIds = [ ...new Set(keys
      .map(key => ProfileRank.getCharacterFromKey(key, game))
      .filter(ret => ret && ret[1])
      .map(ret => ret[1])) ]
    if (!charIds.length) return []
    // 管道批量取每个角色排行榜末位(最高分)UID，避免逐个往返
    let pipe = redis.multi()
    for (let charId of charIds) pipe.zRange(`${RANK_PREFIX}${groupId}:${type}:${charId}`, -1, -1)
    let results = await pipe.exec()
    let ret = []
    charIds.forEach((charId, idx) => {
      let uid = results[idx]?.[0]
      if (uid) ret.push({ uid, charId })
    })
    return ret
  }

  /**
   * 获取排行榜
   * @param groupId
   * @param charId
   * @param type
   * @returns {Promise<ConvertArgumentType<ZMember, string>[]|boolean>}
   */
  static async getGroupUidList(groupId, charId, type = "mark") {
    let number = Cfg.get("rankNumber", 15)
    // 特殊处理开拓者的情况
    let charIdMap = {
      8002: 8001,
      8004: 8003,
      8006: 8005,
      8008: 8007,
      8009: 8010
    }
    let uids = charIdMap[charId] ? await redis.zRangeWithScores(`${RANK_PREFIX}${groupId}:${type}:${charIdMap[charId]}`, -`${number}`, -1) : await redis.zRangeWithScores(`${RANK_PREFIX}${groupId}:${type}:${charId}`, -`${number}`, -1)
    return uids ? uids.reverse() : false
  }

  /**
   * 重置群排行
   * @param groupId
   * @param charId
   * @param game
   * @returns {Promise<void>}
   */
  static async resetRank(groupId, charId = "", game = "gs") {
    let keys = [ ...await redis.keys(`${RANK_PREFIX}${groupId}:*`), ...await redis.keys(`${LEGACY_PREFIX}${groupId}:*`) ]
    let delKeys = []
    for (let key of keys) {
      let charRet = await ProfileRank.getCharacterFromKey(key, game)
      if (charRet) {
        if (charId === "" || charId * 1 === charRet[1] * 1) delKeys.push(key)
      }
    }
    if (charId === "") delKeys.push(`${RANK_PREFIX}${groupId}:cfg`)
    if (delKeys.length) await redis.del(delKeys)
  }

  static async getGroupCfg(groupId, game = "gs") {
    const rankLimitTxt = {
      1: "无限制",
      2: "绑定有CK的用户",
      3: "绑定CK，或列表有16个角色数据",
      4: `绑定CK，或列表有${game == "gs" ? "安柏&凯亚&丽莎" : "丹恒&三月七"}的数据`,
      5: `绑定CK，或列表有16个角色数据且包含${game == "gs" ? "安柏&凯亚&丽莎" : "丹恒&三月七"}`
    }
    let rankLimit = Cfg.get("groupRankLimit") * 1 || 1
    let ret = await Data.redisGet(`${RANK_PREFIX}${groupId}:cfg`, {
      timestamp: (new Date()) * 1,
      status: 0
    })
    await Data.redisSet(`${RANK_PREFIX}${groupId}:cfg`, ret, 3600 * 24 * 365)
    ret.limitTxt = rankLimitTxt[rankLimit]
    ret.time = moment(new Date(ret.timestamp)).format("MM-DD HH:mm")
    ret.number = Cfg.get("rankNumber", 15)
    return ret
  }

  /**
   * 设置群开关状态
   * @param groupId
   * @param status：0开启，1关闭
   * @param status
   * @returns {Promise<void>}
   */
  static async setGroupStatus(groupId, status = 0) {
    let cfg = await Data.redisGet(`${RANK_PREFIX}${groupId}:cfg`, {
      timestamp: (new Date()) * 1,
      status
    })
    cfg.status = status
    await Data.redisSet(`${RANK_PREFIX}${groupId}:cfg`, cfg, 3600 * 24 * 365)
  }

  static async setUidInfo({ uid, qq, profiles, uidType = "bind" }, game = "gs") {
    if (!uid) return false

    let basicCount = game == "sr" ? 1 : 0
    let totalCount = 0
    for (let charId in profiles) {
      let profile = profiles[charId]
      if (!profile || !profile.hasData) continue
      let name = profile.name
      if ([ "安柏", "凯亚", "丽莎", "丹恒", "三月七", "三月七·巡猎" ].includes(name)) basicCount++
      totalCount++
    }
    let data = {}
    try {
      let uData = await redis.get(`${RANK_PREFIX}uid-info:${game}:${uid}`)
      if (!uData) uData = await redis.get(`${LEGACY_PREFIX}uid-info:${game}:${uid}`)
      if (uData) data = JSON.parse(uData)
    } catch (e) {
      data = {}
    }
    data.totalCount = totalCount
    data.basicCount = basicCount
    if (data.isSelfUid) {
      delete data.isSelfUid
      data.uidType = "ck"
    }

    if (uidType === "ck") {
      data.uidType = "ck"
      data.qq = qq || data.qq || ""
    } else {
      data.uidType = data.uidType || "bind"
      if (data.uidType === "bind") {
        data.qq = data.qq || qq || ""
      } else {
        data.qq = qq || data.qq || ""
      }
    }
    await redis.set(`${RANK_PREFIX}uid-info:${game}:${uid}`, JSON.stringify(data), { EX: 3600 * 24 * 365 })
  }

  static async delUidInfo(uid, game = "gs") {
    uid = uid + ""
    if (!/\d{9,10}/.test(uid)) return false
    let keys = [ ...await redis.keys(`${RANK_PREFIX}*`), ...await redis.keys(`${LEGACY_PREFIX}*`) ]
    let pipe = redis.multi()
    let hit = false
    for (let key of keys) {
      let charRet = await ProfileRank.getCharacterFromKey(key, game)
      if (charRet) {
        pipe.zRem(key, uid)
        hit = true
      }
    }
    if (hit) await pipe.exec()
  }

  static async getUidInfo(uid, game = "gs") {
    try {
      let data = await redis.get(`${RANK_PREFIX}uid-info:${game}:${uid}`)
        || await redis.get(`${LEGACY_PREFIX}uid-info:${game}:${uid}`)
      return JSON.parse(data)
    } catch (e) {
      logger.error(`${this.e?.logFnc} 解析 UID 信息失败：${e}`)
    }
    return false
  }

  static async getUserUidMap(e, game = "gs") {
    let rn = e.runtime
    let groupMemMap = await e.group?.getMemberMap() || []
    let users = {}
    for (let [ qq ] of groupMemMap) {
      users[qq] = true
    }

    let uidMap = {}
    let qqMap = {}
    let add = (qq, uid, type) => {
      // 预设面板不参与排名
      if (uid * 1 < 100000006) return false
      uidMap[uid] = { uid, qq, type: type === "ck" ? "ck" : "bind" }
      qqMap[qq] = true
    }

    let keys = [ ...await redis.keys(`${RANK_PREFIX}uid-info:${game}:*`), ...await redis.keys(`${LEGACY_PREFIX}uid-info:${game}:*`) ]
    if (keys.length) {
      // 一次 mGet 批量取回所有 uid-info，避免逐 key 往返
      let vals = await redis.mGet(keys)
      keys.forEach((key, idx) => {
        let data
        try {
          data = vals[idx] ? JSON.parse(vals[idx]) : {}
        } catch (err) {
          data = {}
        }
        let { qq, uidType } = data
        if (!users[qq]) return

        let uidRet = new RegExp(`uid-info:${game}:(\\d{9,10})`).exec(stripPrefix(key))
        if (qq && uidType && uidRet?.[1]) add(qq, uidRet[1], uidType === "ck" ? "ck" : "bind")
      })
    }

    if (rn.NoteUser) {
      // Miao-Yunzai
      await rn.NoteUser.forEach(async(user) => {
        if (!users[user.qq]) return true
        let uids = user.getUidList(game)
        lodash.forEach(uids, (ds) => {
          let { uid, type } = ds
          add(user.qq, uid, type)
        })
      })
    } else {
      if (rn?.gsCfg?.getBingCk) {
        // Yunzai-V3
        let noteCks = await rn.gsCfg.getBingCk(game) || {}
        lodash.forEach(noteCks.ck, (ck, _qq) => {
          let qq = ck.qq || _qq
          let uid = ck.uid
          if (!users[qq]) return true
          add(qq, uid, "ck")
        })
      }
    }

    let pendingQQ = []
    for (let qq in users) {
      if (qqMap[qq]) continue
      pendingQQ.push(qq)
    }
    if (pendingQQ.length) {
      let prefix = Version.isV3 ? "Yz:genshin:mys:qq-uid:" : "genshin:id-uid:"
      // 一次 mGet 批量取回未命中群成员的绑定uid，避免逐 qq 往返
      let uids = await redis.mGet(pendingQQ.map((qq) => `${prefix}${qq}`))
      pendingQQ.forEach((qq, idx) => {
        let uid = uids[idx]
        if (uid) add(qq, uid, "bind")
      })
    }

    return uidMap
  }

  /**
   * 1: '无限制',
   * 2: '绑定有CK的用户',
   * 3: '面板列表有16个角色数据，或绑定CK',
   * 4: '面板列表有安柏&凯亚&丽莎的数据，或绑定CK',
   * 5: '面板列表有16个角色数据且包含安柏&凯亚&丽莎，或绑定CK'
   * @param uid
   * @returns {Promise<boolean>}
   */
  static async checkRankLimit(uid, game = "gs") {
    if (!uid) return false
    // 预设面板不参与排名
    if (uid * 1 < 100000006) return false

    try {
      let rankLimit = Cfg.get("groupRankLimit") * 1 || 1
      if (rankLimit === 1) return true
      let data = await redis.get(`${RANK_PREFIX}uid-info:${game}:${uid}`)
      data = JSON.parse(data)
      if (data.isSelfUid || data.uidType === "ck") return true
      if (rankLimit === 2) return false
      if ((data.totalCount || 0) < 16 && [ 3, 5 ].includes(rankLimit)) return false
      if ((data.basicCount || 0) < 3 && [ 4, 5 ].includes(rankLimit)) return false
      return true
    } catch (e) {
      return false
    }
  }

  key(profile, type) {
    // 特殊处理开拓者的情况
    let profileIdMap = {
      8002: 8001,
      8004: 8003,
      8006: 8005,
      8008: 8007,
      8009: 8010
    }
    if (profileIdMap[profile.id]) { return `${RANK_PREFIX}${this.groupId}:${type}:${profileIdMap[profile.id]}` }
    return `${RANK_PREFIX}${this.groupId}:${type}:${profile.id}`
  }

  /**
   * 获取排行信息
   * @param profile
   * @param force
   * @returns {Promise<{}|boolean>}
   */
  async getRank(profile, force = false) {
    if (!profile || !this.groupId || !this.allowRank || !profile.hasData) return false
    let ret = {}
    for (let typeKey of [ "mark", "dmg", "crit", "valid" ]) {
      let typeRank = await this.getTypeRank(profile, typeKey, force)
      if ([ "mark", "dmg" ].includes(typeKey)) {
        ret[typeKey] = typeRank
        if (!ret.rank || ret.rank >= typeRank.rank) {
          ret.rank = typeRank.rank
          ret.rankType = typeKey
        }
      }
    }
    return ret
  }

  async getTypeRank(profile, type, force) {
    if (!profile || !profile.hasData || !type) return false
    if (type === "dmg" && !profile.hasDmg) return false
    const typeKey = this.key(profile, type)
    let value
    let rank
    if (force) {
      value = await this.getTypeValue(profile, type)
    } else {
      rank = await redis.zRevRank(typeKey, this.uid)
      if (!lodash.isNumber(rank)) value = await this.getTypeValue(profile, type)
    }
    if (value && !lodash.isUndefined(value.score)) {
      let tmpScore = value.score.toString().replace(/%|,/g, "")
      await redis.zAdd(typeKey, { score: tmpScore, value: this.uid })
    }
    if (!lodash.isNumber(rank)) rank = await redis.zRevRank(typeKey, this.uid)
    if (rank === null) rank = 99
    if (force) {
      return {
        rank: rank + 1,
        value: value.score,
        data: value.data
      }
    }
    return {
      rank: rank + 1
    }
  }

  async getTypeValue(profile, type) {
    if (!profile || !profile.hasData) return false

    if ([ "mark", "crit", "valid" ].includes(type)) {
      if (!profile?.artis?.hasArtis) return false
      let mark = profile.getArtisMark(false)
      if (!mark) return false
      if (type === "mark" && mark._mark) {
        return { score: mark.mark * 1, data: mark }
      }
      if (type === "crit" && mark._crit) {
        return { score: mark._crit * 1, data: mark }
      }
      if (type === "valid" && mark._valid) {
        return { score: mark._valid * 1, data: mark }
      }
      return false
    }
    if (type === "dmg" && profile.hasDmg) {
      let enemyLv = profile.game === "gs" ? 103 : 80
      let dmg = await profile.calcDmg({ enemyLv, mode: "single" })
      if (dmg && dmg.avg) {
        return {
          score: dmg.avg,
          data: dmg
        }
      }
    }
    return false
  }
}

export default ProfileRank
