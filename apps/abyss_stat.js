/**
 * 深渊 / 挑战战绩（玩家自己的记录）
 *
 *   #米哈游深境螺旋 [上期]        原神
 *   #米哈游混沌回忆 [上期]        星铁
 *   #米哈游虚构叙事 [上期]        星铁
 *   #米哈游末日幻影 [上期]        星铁
 *   #米哈游王棋 / 异相仲裁 [上期]  星铁
 *
 * 数据走米游社 record 接口（内联的 miao MysApi，不依赖 miao 插件本体），
 * 模板用 miao 作者的 stat/*.html（已复制到 resources/abyss_stat/ 并改成独立页面）。
 */
import { render, pluginPriority } from '#HoYoGet'
import { metaResRel } from '#hoyo.miao.path'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 模板里 <% include(_tpl_path+'/avatar-card.html') %> 用的目录（我们自己的副本） */
const abyssTplPath = () => path.join(PLUGIN_ROOT, 'resources', 'abyss_stat', 'tpl') + path.sep
/** meta 资源（角色立绘/武器图）的 URL 前缀，跟随 system/vendor/miao/path.js 的 meta 根 */
const miaoResPath = () => '../../../../..' + '/' + metaResRel()
import { buildGsAbyss, buildSrChallengeData, SR_CFG, timeCalc, elemIcon } from '../system/abyss_stat.js'

const RULES = [
  { reg: /^#?(?:米哈游)?\s*(?:原神)?\s*(上期|往期)?\s*(深境螺旋|深境|深渊)$/i.source, fnc: 'gsSpiral' },
  { reg: /^#?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(混沌回忆|混沌|忘却之庭|忘却)$/i.source, fnc: 'srChaos' },
  { reg: /^#?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(虚构叙事|虚构)$/i.source, fnc: 'srStory' },
  { reg: /^#?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(末日幻影|末日)$/i.source, fnc: 'srBoss' },
  { reg: /^#?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(王棋|异相仲裁|异相|仲裁)$/i.source, fnc: 'srPeak' },
]

export class abyss_stat extends plugin {
  constructor() {
    super({
      name: '[米哈游]深渊战绩',
      dsc: '原神深境螺旋、星铁混沌 / 虚构 / 末日 / 王棋的战绩图',
      event: 'message',
      // 要压过 miao 的同名指令（miao 的 stat 优先级见其 apps/stat.js）
      priority: pluginPriority('abyss_stat', -33000),
      rule: RULES,
    })
  }

  /** 取 MysApi 实例（失败时回复并返回 null） */
  async mys(e, game) {
    e.isSr = game === 'sr'
    let miao
    try {
      miao = await import('#hoyo.miao.models')
    } catch (err) {
      await e.reply(`内置数据层加载失败：${err?.message || err}`)
      return null
    }
    const mys = await miao.MysApi.init(e, 'all')
    if (!mys) {
      await e.reply(`请先绑定${game === 'sr' ? '星铁' : '原神'}账号，并确认 Cookie 有效`)
      return null
    }
    let ok = false
    try { ok = await mys.checkCk() } catch { ok = false }
    if (!ok) {
      await e.reply(`UID ${mys.uid} 的 Cookie 已失效，请重新登录或 #刷新ck`)
      return null
    }
    return mys
  }

  /** 原神深境螺旋 */
  async gsSpiral(e) {
    const type = /(上期|往期)/.test(String(e.msg || '')) ? 2 : 1
    const mys = await this.mys(e, 'gs')
    if (!mys) return
    let raw
    try {
      raw = await mys.getSpiralAbyss(type)
    } catch (err) {
      return e.reply(`查询深境螺旋失败：${err?.message || err}`)
    }
    if (!raw?.floors?.length) return e.reply('没有查到本期深境螺旋记录，可能还没打或未公开。')

    const data = buildGsAbyss(raw)
    /* 角色详情（头像/武器/圣遗物）：模板按 avatars[id] 渲染角色卡，
       取不到就传空对象，模板里有 avatar 判空，只是不显示卡片 */
    const avatars = await this.fetchAvatars(mys, data)
    const miaoRes = miaoResPath()
    return render('abyss_stat/abyss-summary', {
      abyss: data,
      uid: mys.uid,
      avatars,
      // 角色卡模板（tpl/avatar-card.html）里的图片都相对 miao resources
      _res_path: miaoRes,
      _miao_path: miaoRes,
      timeCalc,
      elemIcon,
      tplPath: abyssTplPath(),
      msg: type === 2 ? '上期' : '',
      stat: data.stat || [],
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 2 })
  }

  /**
   * 取深渊用到的角色详情，整理成模板要的 { id: 角色卡数据 }。
   * 失败返回空对象（模板会跳过角色卡，不影响其它内容）。
   */
  async fetchAvatars(mys, abyss) {
    const ids = new Set()
    for (const floor of Object.values(abyss.floors || {})) {
      for (const lv of (floor.levels || [])) {
        for (const key of ['up', 'down']) {
          for (const id of (lv[key]?.avatars || [])) ids.add(id)
        }
      }
    }
    if (!ids.size) return {}
    try {
      const miao = await import('#hoyo.miao.models')
      const detail = await mys.getCharacter()
      if (!detail?.avatars) return {}
      const player = miao.Player.create(mys)
      player.setMysCharData(detail)
      return player.getAvatarData([...ids]) || {}
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_stat] 角色详情获取失败：${err?.message || err}`)
      return {}
    }
  }

  /** 星铁系（混沌 / 虚构 / 末日 / 王棋） */
  async srChallenge(e, key) {
    const cfg = SR_CFG[key]
    const type = /(上期|往期)/.test(String(e.msg || '')) ? 2 : 1
    const mys = await this.mys(e, 'sr')
    if (!mys) return
    let raw
    try {
      raw = await mys[cfg.api](type)
    } catch (err) {
      return e.reply(`查询${cfg.title}失败：${err?.message || err}`)
    }
    const data = buildSrChallengeData(raw, cfg)
    if (!data) return e.reply(`没有查到本期${cfg.title}记录，可能还没打或未公开。`)
    return render(`abyss_stat/${cfg.tpl}`, {
      story: data,
      uid: mys.uid,
      nickname: '',
      timeCalc,
      elemIcon,
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 2 })
  }

  srChaos(e) { return this.srChallenge(e, 'chaos') }
  srStory(e) { return this.srChallenge(e, 'story') }
  srBoss(e) { return this.srChallenge(e, 'boss') }
  srPeak(e) { return this.srChallenge(e, 'peak') }
}
