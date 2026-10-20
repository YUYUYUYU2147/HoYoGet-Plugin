/**
 * 绝区零挑战记录：式舆防卫战 / 危局强袭战
 *
 *   %式舆防卫战        （也认：式舆 / 深渊 / 防卫战 / 防卫 / 上期 / 往期）
 *   %危局强袭战        （也认：危局 / 强袭 / 强袭战 / 上期 / 往期）
 *
 * 模板直接用 ZZZ-Plugin 里现成的那两套页面（作者自写，已复制到
 * resources/zzz_challenge/，只改了资源前缀），所以观感与 ZZZ-Plugin 完全一致。
 * 取数复用 zzz_panel_list 的 CK/服务器/接口封装，归一化在 system/zzz_challenge.js。
 * 优先级必须高于 ZZZ-Plugin（-30000）才抢得到指令。
 */
import { pluginPriority, render } from '#HoYoGet'
import { normalizeShiyu, normalizeDeadly } from '../system/zzz_challenge.js'
import { zzz_panel_list } from './zzz_panel_list.js'

export class zzz_challenge extends zzz_panel_list {
  constructor() {
    super()
    this.name = '[米哈游]绝区零挑战'
    this.dsc = '绝区零式舆防卫战 / 危局强袭战记录'
    // 压过 ZZZ-Plugin 的 abyss/deadly（默认 70，桥接 -30000）
    this.priority = pluginPriority('zzz_challenge', -32000)
    /* 父类构造会注册「挑战提醒」定时任务；这里只复用它的取数方法，不能再挂一份 */
    this.task = null
    this.rule = [
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(式舆防卫战|式舆|深渊|防卫战|防卫)$/i.source, fnc: 'shiyu' },
      { reg: /^#?(?:%|％|绝区零|米游社)?\s*(上期|往期)?\s*(危局强袭战|危局|强袭|强袭战)$/i.source, fnc: 'deadly' },
    ]
  }

  /** 统一取数：uid / ck / 玩家信息 */
  async prepare(e) {
    const uid = this.getZzzUid(e)
    if (!uid) return { error: '请先绑定绝区零账号（#米哈游扫码绑定 或 %绑定你的UID）' }
    const ck = await this.getCk(e, uid)
    if (!ck || !Object.values(ck).some(item => item?.ck)) {
      return { error: '尚未绑定 cookie，请先绑定 cookie 或 #扫码登录' }
    }
    let player = null
    try { player = await this.fetchPlayer(e, uid, ck) } catch { /* 取不到昵称就留空 */ }
    return { uid, ck, player: player || {} }
  }

  /** 式舆防卫战 */
  async shiyu(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)
    const prev = /(上期|往期)/.test(String(e.msg || ''))

    let raw
    try {
      raw = prev
        ? await this.zzzGetRaw(e, uid, ck, 'challenge', await this.challengeQuery(e, uid, ck))
        : await this.zzzRemindFetch(e, uid, ck, 'challenge')
    } catch (err) {
      return e.reply(`式舆防卫战查询失败：${err?.message || err}`)
    }

    const data = normalizeShiyu(raw, { uid, nickname: player?.nickname, avatar: player?.avatar })
    if (data.empty) return e.reply('没有查到式舆防卫战数据，可能是本期还没打，或面板未公开。')

    return render('zzz_challenge/challenge', { ...data, footer: 'from 米哈游' }, { e, ret: true, dsf: 2.4 })
  }

  /** 危局强袭战 */
  async deadly(e) {
    const { error, uid, ck, player } = await this.prepare(e)
    if (error) return e.reply(error)
    const prev = /(上期|往期)/.test(String(e.msg || ''))

    let raw
    try {
      raw = prev
        ? await this.zzzGetRaw(e, uid, ck, 'deadly', await this.deadlyQuery(e, uid, ck))
        : await this.zzzRemindFetch(e, uid, ck, 'deadly')
    } catch (err) {
      return e.reply(`危局强袭战查询失败：${err?.message || err}`)
    }
    if (!raw?.has_data) return e.reply('没有危局强袭战数据，可能是本期还没打。')

    const data = normalizeDeadly(raw, { uid, nickname: player?.nickname, avatar: player?.avatar })
    if (data.empty) return e.reply('没有查到危局强袭战数据。')

    return render('zzz_challenge/deadly', { ...data, footer: 'from 米哈游' }, { e, ret: true, dsf: 2.4 })
  }

  /** 往期查询串（zzzRemindFetch 只封装了当期，往期要自己拼） */
  async challengeQuery(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    return `lang=zh-cn&role_id=${uid}&server=${server}&schedule_type=1`
  }

  async deadlyQuery(e, uid, ck) {
    const server = await this.pickServer(uid, ck)
    if (!server) throw new Error('未能判断服务器分区')
    return `lang=zh-cn&uid=${uid}&region=${server}&schedule_type=1`
  }
}
