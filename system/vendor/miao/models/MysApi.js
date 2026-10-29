import fetch from "node-fetch"
import Version from "../components/Version.js"
import { Button, User } from "#hoyo.miao.models"

const PATCHED_GET_COOKIE = Symbol.for("miao-plugin.mysInfo.getCookie")
const MAX_COOKIE_SELECTIONS = 50

/* 新版 miao 用驼峰 api 名，旧版 Yunzai/genshin 的 apiTool 只注册了下划线名。
   这里做一层别名，避免「未定义MysApi: challengeBoss」把星铁挑战图整块吞掉。 */
const MYS_API_ALIAS = {
  /* apiTool 里逐光捡金概览的 key 是 'brief'（不是 challenge_brief），
     写错会 getUrl 返回 false → 概览永远拿不到，兜底形同虚设。 */
  challenge_brief: "brief",
  spiralAbyss: "challenge_chaos",
  challengeStory: "challenge_story",
  challengeBoss: "challenge_boss",
  challengePeak: "challenge_peak",
}

function getGameKey (game) {
  if (game && typeof game === "object") {
    game = game.game || game.key || (game.isSr ? "sr" : "gs")
  }
  return ["sr", "star"].includes(game) ? "sr" : "gs"
}

// Prevent old Yunzai runtimes from recursively selecting the same invalid CK.
function patchMysInfoGetCookie (runtime) {
  const MysInfo = runtime?.MysInfo
  const MysUser = runtime?.MysUser
  const prototype = MysInfo?.prototype
  const original = prototype?.getCookie

  if (typeof original !== "function" || original[PATCHED_GET_COOKIE]) {
    return false
  }
  if (!/this\.getCookie\s*\(/.test(Function.prototype.toString.call(original))) {
    return false
  }

  let getCookie
  if (typeof MysUser?.getByQueryUid !== "function") {
    const callDepth = new WeakMap()
    getCookie = async function (game = "gs", ...args) {
      const depth = (callDepth.get(this) || 0) + 1
      if (depth > MAX_COOKIE_SELECTIONS) {
        return ""
      }
      callDepth.set(this, depth)
      try {
        return await original.call(this, getGameKey(game), ...args)
      } finally {
        if (depth === 1) {
          callDepth.delete(this)
        } else {
          callDepth.set(this, depth - 1)
        }
      }
    }
  } else {
    getCookie = async function (game = "gs", onlySelfCk = false) {
      game = getGameKey(game)
      if (this.ckUser?.ck) {
        return this.ckUser.ck
      }

      const attempted = new Set()
      for (let count = 0; count < MAX_COOKIE_SELECTIONS; count++) {
        const mysUser = await MysUser.getByQueryUid(this.uid, game, onlySelfCk)
        if (!mysUser) {
          break
        }
        if (mysUser.ck) {
          this.ckInfo = mysUser.getCkInfo(game)
          this.ckUser = mysUser
          await mysUser.addQueryUid(this.uid, game)
          return mysUser.ck
        }

        const ltuid = mysUser.ltuid && String(mysUser.ltuid)
        if (!ltuid || attempted.has(ltuid)) {
          break
        }
        attempted.add(ltuid)
        await mysUser.disable(game)
        if (onlySelfCk) {
          break
        }
      }
      return ""
    }
  }

  Object.defineProperty(getCookie, PATCHED_GET_COOKIE, { value: true })
  prototype.getCookie = getCookie
  return true
}

export default class MysApi {
  constructor(e, uid, mysInfo) {
    this.e = e
    this.mysInfo = mysInfo
    this.ckInfo = mysInfo.ckInfo
    this.ckUser = mysInfo.ckUser
    this.uid = uid
    e.targetUser = this.targetUser
    e.selfUser = this.selfUser
    e.isSelfCookie = this.isSelfCookie
  }

  get isSelfCookie() {
    return this.uid * 1 === this.ckUid * 1 || this?.mysInfo?.isSelf
  }

  get ckUid() {
    return this.ckInfo.uid
  }

  get ck() {
    return this.ckInfo.ck
  }

  get selfUser() {
    return new User({ id: this.e.user_id, uid: this.uid })
  }

  get targetUser() {
    return new User({ id: this.e.user_id, uid: this.uid })
  }

  static async init(e, auth = "all") {
    if (!e.runtime) {
      Version.runtime()
      return false
    }
    patchMysInfoGetCookie(e.runtime)
    let mys = await e.runtime.getMysInfo(auth)
    if (!mys) return false

    let uid = mys.uid
    e._mys = new MysApi(e, uid, mys)
    return e._mys
  }

  static async initUser(e, auth = "all") {
    let { runtime } = e
    if (!runtime) {
      Version.runtime()
      return false
    }
    let uid
    if (runtime.getUid) {
      uid = await runtime.getUid()
    } else {
      // 兼容处理老版本Yunzai
      uid = runtime.uid || e.uid
      if (e.at) {
        // 暂时使用MysApi.init替代
        let mys = await MysApi.init(e, auth)
        if (!mys) return false

        uid = mys.uid || uid
      }
    }
    if (/星铁/.test(e.msg)) e.isSr = true
    if (uid) {
      return new User({ id: e.user_id, uid })
    } else {
      e.reply([ `请先发送【${e.isSr ? "*" : "#"}绑定+你的UID】来绑定查询目标\n示例：${e.isSr ? "*" : "#"}绑定100000000`, new Button(e).bindUid() ])
      e._replyNeedUid = true
      return false
    }
  }

  /**
   * 检查ck是否可用
   *
   * 这里原来只有 res.ok / retcode 两个判据，本机 IP 被米游社风控拦下时
   * 拿到的是 HTTP 405 加一段 HTML 阻断页，落进来一律 return false，
   * 上层就报成「Cookie失效，请重新登录」——真实原因是 IP 被拦，
   * 跟 CK 无关，用户重登多少次都没用。
   *
   * 现在区分三种结果：
   *   true  -> ck 可用
   *   false -> ck 不可用，细分原因看 this.ckStatus：
   *              reason=expired -> 米游社明确返回 -100/1001 之类的登录态错误，该提示重登
   *              reason=blocked -> 被风控拦下或网络不通，CK 状态未知，只提示稍后重试
   *
   * 两种情况都返回 false，是为了保持调用方原有的「不可用就回退面板服务」行为；
   * 风控时面板服务照样能出数据，比让上层硬着头皮请求米游社划算。
   */
  async checkCk() {
    let url = {
      mys: "https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie",
      hoyolab: "https://sg-public-api.hoyolab.com/binding/api/getUserGameRolesByCookie"
    }
    let target = url[this.ckUser?.type || "mys"]
    let options = { method: "get", headers: { Cookie: this.ckUser?.ck } }

    // genshin 那边已经封装了「直连被拦就改走代理」的出口，能复用就不重复造
    let mhyFetch = null
    try {
      mhyFetch = (await import("../../genshin/model/mys/mhyFetch.js").catch(() => ({ default: null }))).default
    } catch (_) {
      mhyFetch = null
    }

    let res
    try {
      res = await (mhyFetch || fetch)(target, options)
    } catch (err) {
      this.ckStatus = { ok: false, reason: "blocked", message: err?.message || String(err) }
      return false
    }

    let text = ""
    try {
      text = await res.text()
    } catch (_) {
      text = ""
    }

    // 米游社的 JSON 一定以 { 开头；<!doctype / <html 开头的是风控拦截页
    if (!text.trim().startsWith("{")) {
      this.ckStatus = { ok: false, reason: "blocked", message: `HTTP ${res.status}` }
      return false
    }

    let data = null
    try {
      data = JSON.parse(text)
    } catch (_) {
      this.ckStatus = { ok: false, reason: "blocked", message: "返回内容无法解析" }
      return false
    }

    if (data.retcode === 0) {
      this.ckStatus = { ok: true, reason: "ok", retcode: 0 }
      return true
    }

    // 只有米游社明确回的登录态错误才算 CK 失效，其余业务错误一律按未知处理
    let expiredRetcode = [ -100, -1001, 1001, 1002, 1003, 2001 ]
    if (expiredRetcode.includes(Number(data.retcode))) {
      this.ckStatus = { ok: false, reason: "expired", retcode: data.retcode, message: data.message }
      return false
    }

    this.ckStatus = { ok: false, reason: "blocked", retcode: data.retcode, message: data.message }
    return false
  }

  async getMysApi(e, targetType = "all", option = {}) {
    if (this.mys) return this.mys
    /* runtime.getMysApi 会走 runtime._mysInfo[targetType] 缓存，
       而该缓存按 targetType 只初始化一次 —— 第一次初始化时 e.game 是什么，
       就决定了 getSelfUid 取原神还是星铁的 UID。
       e.game 是全局共用的（别的插件可能残留成 'gs'），
       于是「先初始化的是原神」的情况下，所有星铁查询都会拿到原神 UID，
       米游社返回 1008「用户信息不匹配」。

       所以：只要本实例已经有 mysInfo（由调用方按正确游戏初始化好），
       就直接用它构造 genshin 的 MysApi，不再走 runtime 的缓存。 */
    if (this.mysInfo?.uid && this.mysInfo?.ckInfo?.ck) {
      const { default: GMysApi } = await import("../../genshin/model/mys/mysApi.js").catch(() => ({ default: null }))
      if (GMysApi) {
        const opt = { ...option }
        if (e?.isSr) opt.game = 'sr'
        this.mys = new GMysApi(this.mysInfo.uid, this.mysInfo.ckInfo.ck, opt)
        return this.mys
      }
    }
    this.mys = await e.runtime.getMysApi(targetType, option, e.isSr)
    return this.mys
  }

  async getData(api, data) {
    if (!this.mysInfo) return false
    let e = this.e
    let mys = await this.getMysApi(e, api, { log: false })
    if (!mys) return false
    let mysInfo = this.mysInfo || {}
    // 暂时先在plugin侧阻止错误，防止刷屏
    e._original_reply = e._original_reply || e.reply
    e._reqCount = e._reqCount || 0
    e.reply = function(msg) {
      if (!e._isReplyed) {
        e._isReplyed = true
        return e._original_reply(msg)
      } else {
        // logger.error("请求错误")
      }
    }
    e._reqCount++
    /* 旧版 apiTool 只有下划线名（challenge_boss / challenge_story /
       challenge_peak / challenge_chaos），新版 miao 传的是驼峰名。
       先按原名找，找不到再换别名，避免整张挑战图直接返回 false。 */
    let reqApi = api
    if (!mys.getUrl?.(reqApi, data) && MYS_API_ALIAS[api] && mys.getUrl?.(MYS_API_ALIAS[api], data)) {
      reqApi = MYS_API_ALIAS[api]
    }
    if ([ "challengeStory", "challengeBoss", "challengePeak" ].includes(api) && !mys.getUrl?.(reqApi, data)) {
      logger.error(`未定义MysApi: ${api}，请参考 https://gitee.com/qsyhh/Miao-Yunzai/compare/536c1389d4a72a91af833abe226c46c2fb7ccb47...ffc258932af00a31cb676640778683e68bb2b16b 修改`)
      return false
    }
    let ret
    try {
      ret = await mys.getData(reqApi, data)
      if (mysInfo && mysInfo.checkCode) ret = await mysInfo.checkCode(ret, api, this.mys, data)
    } finally {
      e._reqCount--
      if (e._reqCount === 0) e.reply = e._original_reply
    }
    if (!ret) return false
    if (ret.retcode !== 0) e._retcode = ret.retcode
    return ret.data || ret
  }

  // 获取角色信息
  async getCharacter() {
    return await this.getData("character")
  }

  // 获取角色面板
  async getCharacterDetail(character_ids) {
    return await this.getData("characterDetail", { character_ids })
  }

  // 获取角色详情
  async getAvatar(id) {
    return await this.getData("detail", { avatar_id: id })
  }

  // 首页宝箱信息
  async getIndex() {
    return await this.getData("index")
  }

  // 首页个人日历信息
  async getActCalendar() {
    return await this.getData("act_calendar")
  }

  // 获取深渊信息
  async getSpiralAbyss(type = 1) {
    return await this.getData("spiralAbyss", { schedule_type: type })
  }

  // 获取幻想真境剧诗信息
  async getRoleCombat(need_detail = false) {
    return await this.getData("role_combat", { need_detail })
  }

  // 获取幽境危战信息
  async getHardChallenge() {
    return await this.getData("hard_challenge")
  }

  // 获取幽境危战赋光之人信息
  async getHardChallengePopularity() {
    return await this.getData("hard_challenge_popularity")
  }

  // 获取星铁混沌回忆信息
  async getChallengeChaos(type = 1) {
    return await this.getData("spiralAbyss", { schedule_type: type })
  }

  // 获取星铁虚构叙事信息
  async getChallengeStory(type = 1) {
    return await this.getData("challengeStory", { schedule_type: type })
  }

  // 获取星铁末日幻影信息
  async getChallengeBoss(type = 1) {
    return await this.getData("challengeBoss", { schedule_type: type })
  }

  // 获取星铁异相仲裁信息
  /**
   * 逐光捡金概览：一次拿到所有玩法的当期/上期摘要
   * （期数名、星数、最高层、场次）。
   * 有些账号 challenge / challenge_story / challenge_boss 会返回 10041（米游社不开放），
   * 但 challenge_brief 仍然有数据，可以拿它兜底出概览。
   */
  async getChallengeBrief() {
    return await this.getData("challenge_brief")
  }

  async getChallengePeak(type = 1) {
    return await this.getData("challengePeak", { schedule_type: type === 2 ? 3 : 1 })
  }

  async getDetail(id) {
    if (this.e.isSr) return await this.getData("detail", { avatar_id: id, tab_from: "TabOwned" })
    return await this.getData("detail", { avatar_id: id })
  }

  async getCompute(data) {
    return await this.getData("compute", data)
  }

  async getAvatarSkill(id) {
    return await this.getData("avatarSkill", { avatar_id: id })
  }
}
