/**
 * 绝区零挑战记录：式舆防卫战 / 危局强袭战
 *
 *   %式舆防卫战        （也认：式舆 / 深渊 / 防卫战 / 防卫 / 上期 / 往期）
 *   %危局强袭战        （也认：危局 / 强袭 / 强袭战 / 上期 / 往期）
 *
 * 取数复用 zzz_panel_list 里的 zzzRemindFetch（米游社 record 接口），
 * 归一化在 system/zzz_challenge.js，排版在 resources/zzz_challenge/，
 * 不复用 ZZZ-Plugin 的模板。优先级必须高于 ZZZ-Plugin（-30000）才抢得到指令。
 */
import { config, pluginPriority, render } from '#HoYoGet'
import { normalizeShiyu, normalizeDeadly } from '../system/zzz_challenge.js'
import { getPanelBg } from '../system/zzz_panel_bg.js'
import { zzz_panel_list } from './zzz_panel_list.js'

/* 复用面板类的取数能力（getCk / pickServer / zzzRemindFetch 都不依赖实例状态） */
export class zzz_challenge extends zzz_panel_list {
  constructor() {
    super()
    this.name = '[米哈游]绝区零挑战'
    this.dsc = '绝区零式舆防卫战 / 危局强袭战记录'
    // 必须压过 ZZZ-Plugin 的 abyss/deadly（默认 70 与 -30000 两档都要赢）
    this.priority = pluginPriority('zzz_challenge', -32000)
    /* 父类构造会注册「挑战提醒」定时任务；这里只是复用它的取数方法，
       不能再挂一份，否则提醒会重复发 */
    this.task = null
    this.rule = [
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(式舆防卫战|式舆|深渊|防卫战|防卫)$/i.source, fnc: 'shiyu' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(危局强袭战|危局|强袭|强袭战)$/i.source, fnc: 'deadly' },
    ]
  }

  /** 统一取数：uid / ck / 玩家信息 */
  async prepare(e) {
    const uid = this.getZzzUid(e)
    if (!uid) {
      return { error: '请先绑定绝区零账号（#米哈游扫码绑定 或 %绑定你的UID）' }
    }
    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return { error: '尚未绑定 cookie，请先绑定 cookie 或 #扫码登录' }
    }
    let player = null
    try { player = await this.fetchPlayer(e, uid, ck) } catch { /* 取不到昵称就用空 */ }
    return { uid, ck, player: player || {} }
  }

  /** 式舆防卫战 */
  async shiyu(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)

    const prev = /(上期|往期)/.test(String(e.msg || ''))
    let raw
    try {
      raw = await this.zzzRemindFetch(e, uid, ck, prev ? 'challenge_period' : 'challenge')
      /* zzzRemindFetch 只认 challenge / deadly，往期要单独拼参数 */
      if (prev) raw = await this.fetchShiyuPeriod(e, uid, ck)
    } catch (err) {
      return e.reply(`式舆防卫战查询失败：${err?.message || err}`)
    }
    const data = normalizeShiyu(raw, { uid, nickname: player?.nickname, avatar: player?.avatar })
    if (data.empty) return e.reply('没有查到式舆防卫战数据，可能是本期还没打，或面板未公开。')

    return render('zzz_challenge/challenge', {
      data,
      footer: 'from 米哈游',
      appleStyle: true,
      ...this.bgData(),
    }, { e, ret: true, dsf: 2.4 })
  }

  /** 危局强袭战 */
  async deadly(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)

    const prev = /(上期|往期)/.test(String(e.msg || ''))
    let raw
    try {
      raw = prev
        ? await this.fetchDeadlyPeriod(e, uid, ck)
        : await this.zzzRemindFetch(e, uid, ck, 'deadly')
    } catch (err) {
      return e.reply(`危局强袭战查询失败：${err?.message || err}`)
    }
    if (!raw?.has_data) return e.reply('没有危局强袭战数据，可能是本期还没打。')

    const data = normalizeDeadly(raw, { uid, nickname: player?.nickname, avatar: player?.avatar })
    if (data.empty) return e.reply('没有查到危局强袭战数据。')

    return render('zzz_challenge/challenge', {
      data,
      footer: 'from 米哈游',
      appleStyle: true,
      ...this.bgData(),
    }, { e, ret: true, dsf: 2.4 })
  }

  /* 往期数据：zzzRemindFetch 没封装这两个 method，这里按同样方式取 */
  async fetchShiyuPeriod(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    const q = `lang=zh-cn&role_id=${uid}&server=${server}&schedule_type=1`
    return this.zzzGetRaw(e, uid, ck, 'challenge', q)
  }

  async fetchDeadlyPeriod(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    const q = `lang=zh-cn&uid=${uid}&region=${server}&schedule_type=1`
    return this.zzzGetRaw(e, uid, ck, 'deadly', q)
  }

  /** 页面背景（复用角色面板的随机背景，取不到就用纯色） */
  bgData() {
    try { return { bgImage: getPanelBg() } } catch { return {} }
  }
}
