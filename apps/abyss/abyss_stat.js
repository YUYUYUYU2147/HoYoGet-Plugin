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

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
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
/* 五张卡片并排时雷达只有一百多像素宽，轴名用两字简称才放得下 */
const RADAR_SHORT = {
  生命值: '生命', 攻击力: '攻击', 防御力: '防御',
  暴击率: '暴击', 暴击伤害: '暴伤', 元素充能: '充能',
}
const shortRadar = radar => radar && {
  ...radar,
  labels: radar.labels.map(l => ({ ...l, label: RADAR_SHORT[l.label] || l.label })),
}

const abyssTplPath = () => path.join(PLUGIN_ROOT, 'resources', 'abyss_stat', 'tpl') + path.sep
/* art-template 的沙箱里没有全局 Array，模板不能写 Array(n)。
   这里在模块侧生成重复数组，模板只调用 repeat(n)。 */
const repeat = n => Array.from({ length: Math.max(0, Math.min(20, Math.floor(Number(n) || 0))) })
/**
 * 角色立绘 / 武器图 / 圣遗物图的 URL 前缀。
 *
 * metaResRel() 会长出「图片实际所在的那个 resources」（优先本插件自己的，
 * 没有才回落到 plugins/miao-plugin/resources），所以两边都可用：
 * 图片已经拷进本插件，miao 装了/没装都不影响。
 */
const miaoResPath = () => '../../../../..' + '/' + metaResRel()
import { buildGsAbyss, buildSrChallengeData, SR_CFG, timeCalc, elemIcon } from '../../system/abyss_stat.js'
import { buildRadar } from '../../system/radar.js'
import { getRoleProfile } from '../../system/roleProfile.js'

/** 米游社星铁挑战接口的错误码说明 */
function describeSrErr(code) {
  switch (Number(code)) {
    case 10102: return '米游社数据未公开（战绩隐藏）'
    case 10041: return '米游社未开放该接口（战绩未公开）'
    case 1008: return '请求过于频繁被限流，请稍后再试'
    case -10001: return '请求被限流或参数无效（米游社 -10001），请稍后重试'
    case -502: return '米游社服务异常（-502），请稍后重试'
    default: return code ? `接口未返回数据（retcode ${code}）` : '接口未返回数据'
  }
}

export const GS_SPIRAL_RULE = {
  // #深渊 / #深境螺旋 都归原神；不带前缀的「深渊」不再默认成原神，避免和星铁混
  reg: /^#(?:米哈游)?\s*(?:原神)?\s*(上期|往期)?\s*(深境螺旋|深境|深渊|原神深渊)$/i.source,
  fnc: 'gsSpiral',
}
const RULES = [
  // *深渊 = 星铁深渊总览；#深渊 归原神深境螺旋（GS_SPIRAL_RULE），不能再用 [*#] 一起吞
  { reg: /^\*(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(深渊|逐光捡金|逐光)$/i.source, fnc: 'srAbyss' },
  { reg: /^#(?:米哈游)?\s*(?:星铁|崩铁|星穹)\s*(上期|往期)?\s*(深渊|逐光捡金|逐光)$/i.source, fnc: 'srAbyss' },
  { reg: /^[*#]?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(混沌回忆|混沌|忘却之庭|忘却)$/i.source, fnc: 'srChaos' },
  { reg: /^[*#]?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(虚构叙事|虚构)$/i.source, fnc: 'srStory' },
  { reg: /^[*#]?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(末日幻影|末日)$/i.source, fnc: 'srBoss' },
  { reg: /^[*#]?(?:米哈游)?\s*(?:星铁|崩铁|星穹)?\s*(上期|往期)?\s*(王棋|异相仲裁|异相|仲裁)$/i.source, fnc: 'srPeak' },
]

export class abyss_stat extends plugin {
  constructor() {
    super({
      name: '[米哈游]深渊战绩',
      dsc: '星铁混沌 / 虚构 / 末日 / 王棋的战绩图',
      event: 'message',
      // 要压过 miao / genshin 的同名指令（数字越小越先执行）
      priority: pluginPriority('abyss_stat', -33000),
      rule: RULES,
    })
  }

  /**
   * 取 MysApi 实例（失败时回复并返回 null）。
   *
   * 必须用 'cookie' 而不是 'all'：'all' 允许回落到公共 CK 池，拿别人的 CK 查你的 UID，
   * 米游社统一返回 10102「Data is not public for the user」——看着像战绩被隐藏，
   * 实际是 CK 不是本人的。genshin 的深渊走的也是只认自身 CK 的那条路。
   */
  async mys(e, game) {
    e.isSr = game === 'sr'
    /* e.game 必须显式设：genshin 的 getSelfUid 里 `e.game || (e.isSr ? 'sr' : 'gs')`，
       e.game 优先，若被别处残留成 'gs' 就会拿原神 UID 去查星铁深渊。 */
    e.game = game
    let miao
    try {
      miao = await import('#hoyo.miao.models')
    } catch (err) {
      await e.reply(`内置数据层加载失败：${err?.message || err}`)
      return null
    }
    let mys = null
    try { mys = await miao.MysApi.init(e, 'cookie') } catch (_) { mys = null }
    if (!mys) mys = await miao.MysApi.init(e, 'all')
    if (!mys) {
      await e.reply(`请先绑定${game === 'sr' ? '星铁' : '原神'}账号，并确认 Cookie 有效`)
      return null
    }
    /* 不在这里做 checkCk()：
       checkCk 会额外打一次米游社接口判活，偶尔因风控直接失败，
       于是「接口其实能用」的情况被我们自己挡掉，表现为深渊数据整块为空。
       真拿不到数据时，下面每个玩法都会各自带出具体的错误原因。 */
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
    const profile = await getRoleProfile(e, mys.uid, 'gs').catch(() => ({}))
    if (profile.avatar) profile.avatar = String(profile.avatar).replace(/^http:/, 'https:')
    /* 右栏的深渊 BOSS 信息：接口（spiralAbyss）不返回怪物，从速览同一份数据源补，
       按层号对齐；取不到就不显示右栏，不影响主图 */
    /* 培养雷达 + 圣遗物评分只挂在最高层（第 12 层）下面，且只展示顶部统计
       （最强一击/最高承伤/最多击破/战技/爆发）对应的那几个角色，低层不显示。
       没有面板数据的角色也保留卡片（头像/套装），雷达与评分留空。 */
    const statIds = [...new Set((data.stat || []).map(s => Number(s.id)).filter(Boolean))]
    const markKeyOf = mark => String(mark || '').toLowerCase().replace(/[^a-z]/g, '')
    const artisTeams = statIds.map(id => {
      const a = avatars[id]
      if (!a) return null
      const sets = a.artisSet?.sets || {}
      const setText = Object.keys(sets).length
        ? Object.entries(sets).map(([name, count]) => `${name}×${count}`).join(' + ')
        : ''
      const mark = a.artisSummary?.mark || ''
      return {
        id,
        name: a.name || '',
        face: a.qFace || a.face || '',
        setName: a.artisSummary?.set || a.artisSet?.name || '',
        setText,
        mark,
        markKey: markKeyOf(mark),
        score: a.artisSummary?.score || '',
        radar: a.radar || null,
      }
    }).filter(Boolean)
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
      profile,
      avatars,
      // 角色卡模板（tpl/avatar-card.html）里的图片都相对 miao resources
      _res_path: miaoRes,
      _miao_path: miaoRes,
      timeCalc,
      elemIcon,
      repeat,
      tplPath: abyssTplPath(),
      msg: type === 2 ? '上期' : '',
      stat: data.stat || [],
      bossesByFloor: bosses,
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 4 })
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
          /* 只有完整面板（isProfile）才有 attr / 圣遗物评分；
             米游社橱窗数据只有套装名，雷达和评分留空。 */
          if (av?.isProfile && av.attr && Object.keys(av.attr).length) {
            ret[id] = {
              ...ret[id],
              radar: shortRadar(buildRadar(av, 'gs')),
            }
          }
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
          const mark = av?.getArtisMark?.(true) || {}
          const score = Number(mark._mark)
          if (list.length || score) {
            ret[id] = {
              ...ret[id],
              ...(list.length ? { artisDetail: list } : {}),
              artisSummary: {
                set: ret[id]?.artisSet?.name || '',
                mark: mark.markClass || '',
                score: score ? (Math.round(score * 10) / 10).toFixed(1) : '',
              },
            }
          }
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

  /** 星铁战绩楼层里的角色详情，供模板的 avatars[id] 使用；失败返回空对象 */
  async fetchSrAvatars(e, mys, data) {
    const ids = new Set()
    for (const floor of (data.floors || [])) {
      for (const node of (floor.nodes || [])) {
        for (const a of (node.avatars || [])) {
          if (a?.id) ids.add(Number(a.id) || a.id)
        }
      }
    }
    if (!ids.size) return {}
    try {
      const miao = await import('#hoyo.miao.models')
      let detail = null
      try {
        const cookieMys = await miao.MysApi.init(e, 'cookie')
        if (cookieMys) detail = await cookieMys.getCharacter()
      } catch (_) { /* 退回当前实例 */ }
      if (!detail?.avatars) detail = await mys.getCharacter()
      if (!detail?.avatars) return {}
      const player = miao.Player.create(e)
      player.setMysCharData(detail)
      return player.getAvatarData([...ids]) || {}
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_stat] 星铁角色详情获取失败：${err?.message || err}`)
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
    const data = buildSrChallengeData(raw, cfg, type)
    if (!data) return e.reply(`没有查到本期${cfg.title}记录，可能还没打或未公开。`)
    const modeKey = { chaos: 'sr_chaos', story: 'sr_fiction', boss: 'sr_shadow' }[key]
    const [avatars, bossMap] = await Promise.all([
      this.fetchSrAvatars(e, mys, data),
      modeKey
        ? import('./abyss_now.js')
          .then(m => m.getSrBossesByFloor(modeKey, { offset: type === 2 ? 1 : 0 }))
          .catch(() => ({}))
        : Promise.resolve({}),
    ])
    const userFloors = (data.floors || [])
      .map(f => ({ index: Number(f.index) }))
      .filter(f => Number.isFinite(f.index))
      .sort((a, b) => b.index - a.index)
    const bossEntries = Object.entries(bossMap || {})
      .map(([index, halves]) => ({ index: Number(index), halves }))
      .filter(b => Number.isFinite(b.index))
      .sort((a, b) => b.index - a.index)
    const userFloorIdx = new Set(userFloors.map(f => f.index))
    /* 虚构/末日的战绩 floor.index 可能是 4/3/2/1，而 Alioth 只收录 4/3；
       先按 index 精确匹配，没匹配上就按「从高到低」的顺序对齐，避免整个右栏空掉。 */
    const matchedBosses = bossEntries.filter(b => userFloorIdx.has(b.index))
    const alignedBosses = matchedBosses.length
      ? matchedBosses
      : bossEntries.map((b, i) => ({
        ...b,
        index: Number(userFloors[i]?.index ?? b.index),
      }))
    /* 右栏太长：只保留最后两层（bossEntries 已按楼层从高到低排序，取头部两层） */
    const srBosses = alignedBosses.slice(0, 2)
    if (!srBosses.length) {
      logger.mark?.(`[HoYoGet][abyss_stat] ${cfg.title}右栏无怪物数据`
        + `（user floors: ${userFloors.map(f => f.index).join('/') || '无'}`
        + `；Alioth floors: ${bossEntries.map(b => b.index).join('/') || '无'}）`)
    }
    return render(`abyss_stat/${cfg.tpl}`, {
      story: data,
      uid: mys.uid,
      nickname: '',
      avatars,
      mysFailed: !Object.keys(avatars).length,
      srBosses,
      /* 两栏总宽 1120 CSS；body 还有 1.4 倍 transform，shotium 默认 800 视窗会裁掉右栏 */
      viewport: { width: 1600, height: 600 },
      timeCalc,
      elemIcon,
      repeat,
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 4 })
  }

  srChaos(e) { return this.srChallenge(e, 'chaos') }
  srStory(e) { return this.srChallenge(e, 'story') }
  srBoss(e) { return this.srChallenge(e, 'boss') }
  srPeak(e) { return this.srChallenge(e, 'peak') }

  /**
   * 星铁深渊总览：混沌 + 虚构 + 末日 + 王棋。
   * 版式直接套 genshin 的 abyss_all：每类一列长图，几列横向拼成一张宽图，
   * 顶部只额外加一条本插件自己的标题栏。
   */
  async srAbyss(e) {
    const type = /(上期|往期)/.test(String(e.msg || '')) ? 2 : 1
    const mys = await this.mys(e, 'sr')
    if (!mys) return
    const keys = ['chaos', 'story', 'boss', 'peak']
    const columns = []
    const errors = []
    let priv = 0
    /* challenge / challenge_story / challenge_boss 有些账号会返回 10041（米游社不开放），
       但 challenge_brief 仍能拿到当期/上期的期数名、星数、最高层、场次。
       先取一次，主接口全挂时用它兜底，至少能出概览卡。 */
    let brief = null
    try {
      const b = await mys.getChallengeBrief?.()
      if (b && Array.isArray(b.list)) brief = b.list
    } catch (_) { brief = null }
    for (const key of keys) {
      const cfg = SR_CFG[key]
      let raw = null
      try {
        raw = await mys[cfg.api](type)
      } catch (err) {
        errors.push(`${cfg.title}: ${err?.message || err}`)
        continue
      }
      if (!raw) {
        const code = e?._retcode
        if (code === 10102 || code === 10041) priv++
        errors.push(`${cfg.title}: ${describeSrErr(code)}`)
        continue
      }
      const data = buildSrChallengeData(raw, cfg, type)
      if (!data) continue
      const col = this.buildSrColumn(data, cfg, raw, key)
      if (col) columns.push(col)
      else if (data) {
        /* 有数据但没有可渲染的楼层（比如本期只打了快速通关）：仍然出一列，
           至少把星数/最高关卡/周期显示出来，不然整列消失会让人以为没数据。 */
        const empty = this.buildSrColumn(data, cfg, raw, key, true)
        if (empty) columns.push(empty)
      }
    }

    /* 逐类兜底：某一类主接口拿不到（10041 未公开 / 限流），
       就用 challenge_brief 里对应那条的摘要补一列概览。
       brief 里有当期/上期的期数名、星数、最高层、场次，够画概览卡了。 */
    if (brief?.length) {
      const typeMap = { Chasm: 'chaos', Story: 'story', Boss: 'boss', Peak: 'peak' };
      const have = new Set(columns.map(c => c.key));
      for (const item of brief) {
        const key = typeMap[item.challenge_type];
        if (!key || have.has(key)) continue;
        const sch = type === 2 ? (item.last_schedule || item.cur_schedule) : (item.cur_schedule || item.last_schedule);
        if (!sch) continue;
        const cfg = SR_CFG[key];
        columns.push({
          key,
          type: key === 'chaos' ? 'abyss' : key,
          title: cfg.title,
          hasStarMode: !!sch.has_tierce,
          maxLabel: key === 'boss' ? '最高难度' : '最高关卡',
          showRound: key !== 'boss',
          showTotalScore: key !== 'chaos',
          showNodeScore: true,
          periodText: '',
          group: {},
          briefOnly: true,
          periodName: sch.group_name || '',
          list: {
            star_num: Number(sch.finish_star_count || 0),
            max_floor: sch.finish_floor_name || '',
            battle_num: Number(sch.times || 0),
          },
          floors: [],
        });
        have.add(key);
        logger.mark?.(`[HoYoGet][abyss_stat] *深渊 ${cfg.title} 主接口无数据，已用概览接口补一列`)
      }
    }

    if (!columns.length) {
      if (errors.some(e => /限流|-10001|-502/.test(e))) {
        return e.reply('米游社接口限流了（invalid request / -502），这是短时限流，不是没有数据。\n'
          + '请等 1~2 分钟后再发一次 *深渊；若依旧失败，再看下面的具体错误。\n'
          + errors.join('\n'))
      }
      if (priv === keys.length) {
        return e.reply('米游社返回「数据未公开」(10041/10102)，通常是这两个原因：\n'
          + '1) 用的是公共 CK 而不是你自己的：日志里出现「分配查询ck」就属于这种，重新 #扫码绑定 后再试；\n'
          + '2) 确实在米游社「我的 → 战绩」里隐藏了战绩，关掉即可。\n'
          + '（10041 表示米游社没有开放该接口，账号本身看不到深渊详情）')
      }
      logger.mark?.(`[HoYoGet][abyss_stat] *深渊 四类都无数据：${errors.join(' | ') || '接口未返回楼层'}`)
      return e.reply('没有查到本期星铁深渊数据，可能还没打或面板未公开。'
        + (errors.length ? `\n${errors.join('\n')}` : ''))
    }

    /* 与 genshin 同款：每列 430 CSS 宽，列间距 12，容器左右各 16 */
    const totalWidth = columns.length * 430 + 32 + Math.max(columns.length - 1, 0) * 12
    /* 顶部头像用玩家自己的游戏头像（星铁 index 接口），取不到再回退星铁图标 */
    let avatar = ''
    try {
      const profile = await getRoleProfile(e, mys.uid, 'sr')
      avatar = profile?.avatar || ''
      if (avatar) avatar = String(avatar).replace(/^http:/, 'https:')
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_stat] 取玩家头像失败：${err?.message || err}`)
    }
    return render('abyss_stat/sr-abyss-all', {
      period: type === 2 ? '上期' : '当期',
      uid: mys.uid,
      avatar,
      columns,
      totalWidth,
      contentWidth: totalWidth - 32,
      layoutcopyright: 'from 米哈游',
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 3.2, viewport: { width: Math.max(1000, totalWidth), height: 900 } })
  }

  /**
   * 一类玩法 → 一列。字段名保持 genshin abyss_all 模板的约定
   * （list.star_num / list.max_floor / list.battle_num / floors[].node_1 …），
   * 这样模板可以原样复用，不用改写。
   */
  buildSrColumn(data, cfg, raw, key, allowEmpty = false) {
    if (!data) return null
    const type = cfg.type
    const group = data.group || {}
    /* 末日幻影的 BOSS 立绘在 group 里，模板要 upper/lower/tierce_boss */
    const bossGroup = {
      upper_boss: group?.upper_boss || null,
      lower_boss: group?.lower_boss || null,
      tierce_boss: group?.tierce_boss || null,
    }
    const floors = (data.floors || [])
      .filter(f => (f.nodes || []).some(n => n?.avatars?.length) || f.isFast)
      .map(f => {
        const node = n => {
          if (!n || !n.avatars?.length) return null
          const b = n.raw?.buff || n.raw?.maze_buff
            || (Array.isArray(n.raw?.buff_list) ? n.raw.buff_list[0] : null)
          return {
            hasData: true,
            score: n.score,
            challenge_time_str: n.time || '',
            buff: b ? { id: b.id || b.name || 'buff', icon: b.icon || '', name_mi18n: b.name_mi18n || b.name || '', desc_mi18n: String(b.desc_mi18n || b.desc || '').replace(/<[^>]+>/g, '').trim() } : null,
            avatars: (n.avatars || []).map(a => ({
              icon: a.icon || '',
              rarity: a.rarity || 5,
              rank: a.rank || 0,
              level: a.level || 80,
              element: a.element || '',
            })),
          }
        }
        const allscore = (f.nodes || []).reduce((sum, n) => sum + (Number(n?.score) || 0), 0)
        return {
          name: f.name,
          star_num: f.star,
          round_num: f.roundNum || 0,
          allscore,
          hasTierceRecord: !!f.extraStar,
          node_1: node(f.node1),
          node_2: node(f.node2),
          node_3: node(f.node3),
        }
      })
    if (!floors.length && !allowEmpty) return null

    return {
      key,
      type: key === 'chaos' ? 'abyss' : key,
      title: cfg.title,
      hasStarMode: floors.some(f => f.hasTierceRecord),
      maxLabel: key === 'boss' ? '最高难度' : '最高关卡',
      showRound: key !== 'boss',
      showTotalScore: key !== 'chaos',
      showNodeScore: true,
      periodText: data.beginTime && data.endTime
        ? `${timeCalc(data.beginTime)} - ${timeCalc(data.endTime)}`
        : '',
      group: bossGroup,
      list: {
        star_num: data.totalStar ?? 0,
        max_floor: data.bestFloor || data.periodName || '',
        battle_num: data.battleNum ?? 0,
      },
      floors,
    }
  }

  srChaos(e) { return this.srChallenge(e, 'chaos') }
  srStory(e) { return this.srChallenge(e, 'story') }
  srBoss(e) { return this.srChallenge(e, 'boss') }
  srPeak(e) { return this.srChallenge(e, 'peak') }

  /**
   * 把一期的楼层整理成总览页可渲染的结构：
   * 每层带星数/分数、各节点的角色，以及节点上的关卡效果（buff）。
   */
  collectSrFloors(data) {
    if (!data) return []
    return (data.floors || []).map(f => {
      const nodes = (f.nodes || []).filter(n => n && n.avatars?.length)
      const buffs = []
      for (const n of (f.nodes || [])) {
        const raw = n?.raw || {}
        const b = raw.buff || raw.maze_buff || (Array.isArray(raw.buff_list) ? raw.buff_list[0] : null)
        if (!b) continue
        const desc = String(b.desc_mi18n || b.desc || b.simple_desc_mi18m || '')
          .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        if (!desc) continue
        buffs.push({ name: b.name_mi18n || b.name || '', desc, icon: b.icon || '' })
      }
      return { ...f, nodes, buffs }
    }).filter(f => f.nodes.length || f.isFast)
  }

  /** 星铁深渊总览：混沌 + 虚构 + 末日 + 王棋 四类一次拉全，汇总成一张卡 */
  async srAbyss(e) {
    const type = /(上期|往期)/.test(String(e.msg || '')) ? 2 : 1
    const mys = await this.mys(e, 'sr')
    if (!mys) return
    const keys = ['chaos', 'story', 'boss', 'peak']
    const cards = []
    for (const key of keys) {
      const cfg = SR_CFG[key]
      try {
        const raw = await mys[cfg.api](type)
        if (!raw) {
          /* getData 在 retcode!==0 时返回 false，并把 retcode 记到 e._retcode */
          const code = e?._retcode
          cards.push({
            key,
            title: cfg.title,
            ok: false,
            private: code === 10102,
            err: code === 10102 ? '米游社数据未公开' : '接口未返回数据（可能该玩法本期未参与）',
          })
          continue
        }
        const data = buildSrChallengeData(raw, cfg, type)
        cards.push({
          key,
          title: cfg.title,
          ok: !!data,
          totalStar: data?.totalStar ?? 0,
          extraStar: data?.extraStar ?? 0,
          bestFloor: data?.bestFloor ?? '',
          periodName: data?.periodName ?? '',
          battleNum: data?.battleNum ?? 0,
          period: data?.beginTime && data?.endTime
            ? `${timeCalc(data.beginTime)} - ${timeCalc(data.endTime)}`
            : '',
          /* 四类玩法的满星基准：混沌/虚构 12，末日 10，王棋按额外星 */
          fullStar: { chaos: 12, story: 12, boss: 10, peak: 0 }[key] || 0,
          floors: this.collectSrFloors(data),
        })
      } catch (err) {
        cards.push({ key, title: cfg.title, ok: false, err: err?.message || String(err) })
      }
    }
    const anyData = cards.some(c => c.ok)
    if (!anyData) {
      if (cards.every(c => c.private)) {
        return e.reply('米游社返回「数据未公开」，通常是这两个原因：\n'
          + '1) 用的是公共 CK 而不是你自己的：日志里出现「分配查询ck」就属于这种，重新 #扫码绑定 后再试；\n'
          + '2) 确实在米游社「我的 → 战绩」里隐藏了战绩，关掉即可。')
      }
      const errs = cards.filter(c => c.err).map(c => `${c.title}: ${c.err}`).slice(0, 4)
      logger.mark?.(`[HoYoGet][abyss_stat] *深渊 四类都无数据：${errs.join(' | ') || '接口未返回楼层'}`)
      return e.reply('没有查到本期星铁深渊数据，可能还没打或面板未公开。'
        + (errs.length ? `\n${errs.join('\n')}` : ''))
    }

    return render('abyss_stat/sr-abyss-all', {
      period: type === 2 ? '上期' : '当期',
      cards,
      uid: mys.uid,
      repeat,
      elemIcon,
      _miao_path: miaoResPath(),
      sys: { copyright: '' },
    }, { e, ret: true, dsf: 3.2 })
  }
}
