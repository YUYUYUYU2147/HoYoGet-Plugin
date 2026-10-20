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
/* 圣遗物词条 key → 中文（面板里用的简称） */
const ATTR_CN = {
  hp: '生命值', hpPlus: '小生命', hpPct: '生命值',
  atk: '攻击力', atkPlus: '小攻击', atkPct: '攻击力',
  def: '防御力', defPlus: '小防御', defPct: '防御力',
  cpct: '暴击率', cdmg: '暴击伤害', mastery: '元素精通',
  recharge: '元素充能', dmg: '伤害加成', phy: '物理伤害',
  heal: '治疗加成', shield: '护盾强效', diffelem: '元素抗性',
  speed: '速度', stance: '击破特攻', effPct: '效果命中', effDef: '效果抵抗',
  pyro: '火伤', hydro: '水伤', cryo: '冰伤', electro: '雷伤',
  anemo: '风伤', geo: '岩伤', dendro: '草伤', physical: '物伤',
}
/* 这些 key 的数值是固定值（不带 %），其余都是百分比 */
const FLAT_KEYS = new Set(['hpPlus', 'atkPlus', 'defPlus'])
const attrName = key => ATTR_CN[key] || key

const abyssTplPath = () => path.join(PLUGIN_ROOT, 'resources', 'abyss_stat', 'tpl') + path.sep
/**
 * 角色立绘 / 武器图 / 圣遗物图的 URL 前缀。
 *
 * metaResRel() 会长出「图片实际所在的那个 resources」（优先本插件自己的，
 * 没有才回落到 plugins/miao-plugin/resources），所以两边都可用：
 * 图片已经拷进本插件，miao 装了/没装都不影响。
 */
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
    /* 统计项可能缺字段（米游社部分账号不返回战技/爆发榜），打出来便于排查 */
    try {
      logger.mark?.(`[HoYoGet][abyss_stat] 统计项 ${data.stat?.length || 0} 个：`
        + (data.stat || []).map(x => x.title).join('/')
        + ` | 原始字段：damage=${!!raw.damage_rank} take=${!!raw.take_damage_rank} defeat=${!!raw.defeat_rank}`
        + ` e=${!!raw.normal_skill_rank} q=${!!raw.energy_skill_rank}`)
    } catch (_) { }
    /* 角色详情（头像/武器/圣遗物）：模板按 avatars[id] 渲染角色卡，
       取不到就传空对象，模板里有 avatar 判空，只是不显示卡片 */
    const avatars = await this.fetchAvatars(e, mys, data)
    /* 右栏的深渊 BOSS 信息：接口（spiralAbyss）不返回怪物，从速览同一份数据源补，
       按层号对齐；取不到就不显示右栏，不影响主图 */
    /* 圣遗物详情只挂在最高层（第 12 层）下面，且只展示顶部统计（最强一击/
       最高承伤/最多击破/战技/爆发）对应的那几个角色，低层不显示 */
    const statIds = [...new Set((data.stat || []).map(s => Number(s.id)).filter(Boolean))]
    const artisTeams = statIds
      .map(id => avatars[id])
      .filter(a => a && a.artisDetail && a.artisDetail.length)
      .map(a => ({ name: a.name, setName: a.artisSet?.name || '', artis: a.artisDetail }))
    const floorNums = Object.keys(data.floors || {}).map(Number).filter(Number.isFinite)
    const topFloor = floorNums.length ? Math.max(...floorNums) : 0
    if (topFloor && data.floors[topFloor]) data.floors[topFloor].artisTeams = artisTeams

    const bosses = await this.fetchFloorBosses()
    logger.mark?.(`[HoYoGet][abyss_stat] BOSS 配置层数：${Object.keys(bosses).join(',') || '无'}`
      + ` | 本图层：${Object.keys(data.floors || {}).join(',')}`)
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
      bossesByFloor: bosses,
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 3.2 })
  }

  /** 当期深渊每层的怪物/BOSS（来自速览的数据源），失败返回 {} */
  async fetchFloorBosses() {
    try {
      const { getAbyssBossesByFloor } = await import('./abyss_now.js')
      return await getAbyssBossesByFloor({})
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_stat] 深渊 BOSS 配置获取失败：${err?.message || err}`)
      return {}
    }
  }

  /**
   * 取深渊用到的角色详情，整理成模板要的 { id: 角色卡数据 }。
   * 失败返回空对象（模板会跳过角色卡，不影响其它内容）。
   */
  async fetchAvatars(e, mys, abyss) {
    const ids = new Set()
    for (const floor of Object.values(abyss.floors || {})) {
      for (const lv of (floor.levels || [])) {
        for (const key of ['up', 'down']) {
          for (const id of (lv[key]?.avatars || [])) ids.add(id)
        }
      }
    }
    /* 顶部统计（最强一击/最高承伤…）也是按角色 id 取立绘，
       漏掉它们会导致对应那张卡被模板的 {{if avatar}} 过滤掉（少一项） */
    for (const s of (abyss.stat || [])) {
      if (s?.id) ids.add(Number(s.id) || s.id)
    }
    if (!ids.size) return {}
    try {
      const miao = await import('#hoyo.miao.models')
      /* 角色详情需要 cookie 权限：部分环境 init(e,'all') 拿到的是 roleIndex（无 CK），
         那样 getCharacter 会返回空，角色卡就整片空白 */
      let detail = null
      try {
        const miaoInit = miao.MysApi.init
        const cookieMys = await miaoInit(e, 'cookie')
        if (cookieMys) detail = await cookieMys.getCharacter()
      } catch (_) { /* 退回下面用 all 的实例 */ }
      if (!detail?.avatars) detail = await mys.getCharacter()
      if (!detail?.avatars) {
        logger.mark?.(`[HoYoGet][abyss_stat] 角色详情为空（getCharacter 未返回 avatars），跳过角色卡`)
        return {}
      }
      // Player.create 传的是 e（内部取 e._mys.uid / e.uid），不是 mys 实例
      const player = miao.Player.create(e)
      player.setMysCharData(detail)
      const ret = player.getAvatarData([...ids]) || {}
      /* 左栏要列出每队的圣遗物详情（单件：套装/等级/主词条/副词条），
         getAvatarData 只给套装汇总，单件要单独取，失败忽略 */
      for (const id of Object.keys(ret)) {
        try {
          const av = player.getAvatar(id)
          const arts = av?.getArtisDetail?.() || {}
          const list = Object.keys(arts)
            .sort((a, b) => Number(a) - Number(b))
            .map(k => {
              const v = arts[k] || {}
              const fmtAttr = x => {
                if (!x?.key) return ''
                const n = Number(x.value)
                const pct = !FLAT_KEYS.has(x.key)
                return `${attrName(x.key)}${pct ? n.toFixed(1) + '%' : ' ' + Math.round(n)}`
              }
              return {
                slot: Number(k),
                name: v.name || '',
                set: v.set || '',
                level: v.level || 0,
                icon: v.img || '',
                main: v.main ? fmtAttr({ key: v.main.key, value: v.main.value }) : '',
                attrs: (v.attrs || []).map(fmtAttr).filter(Boolean),
              }
            })
            .filter(x => x.name || x.set)
          if (list.length) ret[id] = { ...ret[id], artisDetail: list }
        } catch (_) { /* 单角色取不到就跳过 */ }
      }
      /* 缺面板的角色（深渊里出现过、但米游社角色详情里没有）会导致立绘/圣遗物为空，
         把名单打出来方便判断是「没展示圣遗物」还是「角色不在橱窗」 */
      const missing = [...ids].filter(id => !ret[id])
      const noArtis = Object.values(ret).filter(a => !a?.artisSet?.imgs?.length).map(a => a?.name)
      logger.mark?.(`[HoYoGet][abyss_stat] 角色卡：需要 ${ids.size} 个，取到 ${Object.keys(ret).length} 个`
        + (missing.length ? `，缺面板：${missing.join(',')}` : '')
        + (noArtis.length ? `，无圣遗物：${noArtis.join(',')}` : ''))
      return ret
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
    }, { e, ret: true, dsf: 3.2 })
  }

  srChaos(e) { return this.srChallenge(e, 'chaos') }
  srStory(e) { return this.srChallenge(e, 'story') }
  srBoss(e) { return this.srChallenge(e, 'boss') }
  srPeak(e) { return this.srChallenge(e, 'peak') }
}
