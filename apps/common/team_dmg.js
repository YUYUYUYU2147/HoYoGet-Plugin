import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import lodash from 'lodash'
import { pluginPriority, render } from '#HoYoGet'
import { readBoundUid, readMysMainUid } from './hoyo_panel.js'
import {
  covTeyvat, buildGsView, buildSrView, buildSimView, fetchTeamDmg, teyvatServer, bigNum,
} from '../../system/team_dmg.js'
import { teamBuffsFrom, parseManualBuffs } from '../../system/sr_team_buff.js'
import { avatarToInput, simulateTeamBattle } from '../../system/sr_engine.js'

/**
 * 队伍伤害计算（原神 `#` / 星铁 `*`）
 *
 * 原神走提瓦特小助手的队伍伤害接口：队友增益（班尼特加攻、万叶减抗、双水共鸣）、
 * 循环轴与充能只有服务端按队伍交互算得对，本地 miao 的伤害规则只算单角色自身面板。
 * 接口给出的是每人的伤害、DPS、评级与计算过程，这里只做取数、对齐和出图。
 *
 * 星铁没有对应接口，用 miao 本地伤害规则（与面板伤害表同源）逐角色汇总。
 * 绝区零见 apps/zzz/zzz_panel_list.js 的 `%队伍伤害`。
 *
 * 关于前缀：部分适配器 / 框架会把 `*` 开头的消息改写成 `#`（实测踩到：
 * `*队伍伤害 流萤,花火,灵砂` 进到插件时 e.msg 已是 `#队伍伤害 ...`），
 * 于是只用前缀判游戏会把星铁指令当成原神。这里做了三层判定：
 *   1. 显式游戏名优先（`#星铁队伍伤害` / `#原神队伍伤害` / `#绝区零队伍伤害`）；
 *   2. 前缀（`#` 原神 / `*` 星铁 / `%` 绝区零）；
 *   3. 前两层定下的游戏里一个角色都没匹配上时，换另一个游戏按角色名再找一次
 *      （星铁与原神角色名不重名），命中就自动切过去。
 */

const TEAM_DMG_REG = /^([#*%])?\s*(?:米哈游)?\s*(原神|星铁|崩铁|绝区零)?\s*(?:队伍|组队|配队)伤害(详情|过程|全图)?\s*(.*)$/
const TEAM_DMG_HELP_REG = /^([#*%])?\s*(?:米哈游)?\s*(原神|星铁|崩铁|绝区零)?\s*(?:队伍|组队|配队)伤害(帮助|说明|help)\s*$/

const CN = { gs: '原神', sr: '星铁', zzz: '绝区零' }
const PREFIX_GAME = { '#': 'gs', '*': 'sr', '%': 'zzz' }

/** 游戏判定：显式游戏名 > 前缀 > 默认原神 */
function gameOf(prefix, name) {
  if (name === '星铁' || name === '崩铁') return 'sr'
  if (name === '绝区零') return 'zzz'
  if (name === '原神') return 'gs'
  return PREFIX_GAME[prefix] || 'gs'
}

/* 角色名 → 游戏：读 miao 的 meta 角色目录表。两家角色重名极少，
   用它比前缀可靠 —— 前缀会被适配器改写，角色名不会。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const META_ROOTS = [
  path.join(PLUGIN_ROOT, 'resources'),
  path.join(PLUGIN_ROOT, '..', 'miao-plugin', 'resources'),
]
const cleanName = (v) => String(v || '').replace(/[·•・\s「」『』]/g, '')
let _metaNames = null

function metaNames() {
  if (_metaNames) return _metaNames
  const out = { gs: [], sr: [] }
  for (const root of META_ROOTS) {
    for (const game of ['gs', 'sr']) {
      try {
        for (const dir of fs.readdirSync(path.join(root, `meta-${game}`, 'character'))) {
          const n = cleanName(dir)
          if (n) out[game].push(n)
        }
      } catch (_) { /* 某个根没有这个游戏的 meta 就跳过 */ }
    }
  }
  _metaNames = out
  return out
}

/** 按角色名判断属于哪个游戏，判不出来返回空串 */
function guessGameByNames(names = []) {
  if (!names.length) return ''
  const idx = metaNames()
  if (!idx.gs.length && !idx.sr.length) return ''
  let gs = 0
  let sr = 0
  for (const raw of names) {
    const n = cleanName(raw)
    if (!n) continue
    const inGs = idx.gs.some((x) => x.includes(n) || n.includes(x))
    const inSr = idx.sr.some((x) => x.includes(n) || n.includes(x))
    if (inSr && !inGs) sr++
    else if (inGs && !inSr) gs++
  }
  return sr > gs ? 'sr' : gs > sr ? 'gs' : ''
}

let _vendorModels = null
async function loadMiao() {
  if (_vendorModels) return _vendorModels
  try {
    const mod = await import('#hoyo.miao.models')
    const hot = await import('#hoyo.miao')
    _vendorModels = { Player: mod.Player, Character: mod.Character, MysApi: mod.MysApi, Format: hot.Format }
    return _vendorModels
  } catch (err) {
    logger.error?.(`[HoYoGet][team_dmg] 内置模型加载失败：${err?.message || err}`)
    return null
  }
}

/** 消息里的角色名 → Avatar 实例（名字 / 简称 / 双向包含） */
function findAvatar(player, name, Character, game) {
  const raw = String(name || '').trim()
  if (!raw) return null
  try {
    const char = Character.get(raw, game)
    if (char) {
      const av = player.getAvatar(char.id)
      if (av && av.name) return av
    }
  } catch (_) { /* 走下面的模糊匹配 */ }
  for (const item of Object.values(player._avatars || {})) {
    let av = item
    try { if (!av?.isAvatar) av = player.getAvatar(av?.id) } catch (_) { av = null }
    const nm = String(av?.name || '')
    if (!nm) continue
    if (nm === raw || nm.includes(raw) || raw.includes(nm)) return av
  }
  return null
}

/** 面板里的全部角色（未指定角色时取前 4 名） */
function allAvatars(player) {
  const list = []
  for (const item of Object.values(player._avatars || {})) {
    let av = item
    try { if (!av?.isAvatar) av = player.getAvatar(av?.id) } catch (_) { av = null }
    if (av?.name) list.push(av)
  }
  return list
}

/**
 * 打开某个游戏的面板并按角色名取 Avatar。
 * 返回 { reason, uid, player, avatars, miss }：
 *   reason = 'ok' | 'nouid' | 'noprofile'
 */
async function openPanel(e, miao, game, uidInMsg, names) {
  let uid = String(uidInMsg || '')
  if (!uid) uid = (await readMysMainUid(e, game)) || (await readBoundUid(e, game)) || ''
  if (!uid) return { reason: 'nouid', game, avatars: [], miss: [] }

  let player
  try {
    player = new miao.Player(uid, game)
    if (!player.hasProfile) {
      player.e = e
      e.isfromMys = false
      const mys = await miao.MysApi.init(e, 'cookie')
      if (mys) await player.refreshProfile(2, false)
    }
  } catch (err) {
    logger.error?.(`[HoYoGet][team_dmg] 读取${CN[game]}面板失败：${err?.message || err}`)
    return { reason: 'noprofile', game, uid, avatars: [], miss: [], err }
  }
  if (!player?.hasProfile) return { reason: 'noprofile', game, uid, avatars: [], miss: [] }

  const avatars = []
  const miss = []
  if (names.length) {
    for (const name of names) {
      const av = findAvatar(player, name, miao.Character, game)
      if (av) avatars.push(av)
      else miss.push(name)
    }
  } else {
    avatars.push(...lodash.sortBy(allAvatars(player), (av) => -(Number(av.level) || 0)).slice(0, 4))
  }
  return { reason: 'ok', game, uid, player, avatars, miss }
}

/**
 * 星铁队伍伤害 + 队友增益。
 *
 * 主 C 的确定顺序：指令里 `主C=xxx` > 自身伤害最高的那个角色。
 * 增益来源：
 *   · 手动 `buff=攻击45%,增伤60%` —— 有了就只用手动（用户自己给的数最准，不再叠加自动值，避免重复计）；
 *   · 否则按队伍里其余角色逐个求值（teamBuffsFrom），叠加到主 C。
 * 只对主 C 叠加：队友增益本来就打在站场输出位身上，其余角色保持自身面板。
 */
async function buildSrWithTeamBuffs(avatars, { manualBuffs = [], mainName = '' } = {}) {
  const base = await buildSrView(avatars)
  const byName = (n) => base.members.find((m) => m.name === String(n || ''))
  const main = byName(mainName) || base.members[0]
  if (!main) return base

  let buffs = []
  if (manualBuffs.length) {
    buffs = manualBuffs
  } else if (avatars.length > 1) {
    const mainAv = avatars.find((a) => String(a.name || '') === main.name)
    for (const av of avatars) {
      if (String(av?.name || '') === main.name) continue
      buffs.push(...(await teamBuffsFrom(av, mainAv?.elem || '')))
    }
  }
  if (!buffs.length) return base
  return await buildSrView(avatars, { teamBuffs: buffs, mainName: main.name })
}

export class team_dmg extends plugin {
  constructor() {
    super({
      name: '[米哈游]队伍伤害',
      dsc: '原神 / 星铁 队伍伤害计算',
      event: 'message',
      priority: pluginPriority('team_dmg', -41900),
      rule: [
        { reg: TEAM_DMG_HELP_REG.source, fnc: 'help' },
        { reg: TEAM_DMG_REG.source, fnc: 'teamDamage' },
      ],
    })
  }

  help(e) {
    const m = String(e.msg || '').match(TEAM_DMG_HELP_REG)
    if (!m) return false
    const game = gameOf(m[1], m[2])
    if (game === 'zzz') return false
    const gs = game === 'gs'
    return e.reply([
      gs ? '【原神】队伍伤害' : '【星铁】队伍伤害',
      '',
      gs ? '  #队伍伤害 胡桃,行秋,夜兰,钟离' : '  *队伍伤害 流萤,花火,灵砂',
      gs ? '  #队伍伤害 123456789 胡桃,行秋,夜兰,钟离' : '  *队伍伤害 123456789 流萤,花火,灵砂',
      gs ? '  #队伍伤害              （取面板前 4 名）' : '  *队伍伤害              （取面板前 4 名）',
      '  #队伍伤害详情 胡桃,行秋,夜兰,钟离（附加伤害过程明细）',
      gs ? '  #星铁队伍伤害 流萤,花火,灵砂（前缀被吞时可用）' : '  #原神队伍伤害 胡桃,行秋,夜兰,钟离（前缀被吞时可用）',
      ...(gs ? [] : [
        '',
        '  *队伍伤害 流萤,花火,灵砂 主C=流萤',
        '  *队伍伤害 流萤,花火,灵砂 buff=攻击45%,增伤60%,暴伤40%',
      '  *队伍伤害 模拟 流萤,花火,灵砂（工坊口径：默认 5 轮 × 3 敌整场模拟）',
      '  *队伍伤害 模拟7轮 流萤,花火,灵砂（指定轮次，1-20）',
      ]),
      '',
      gs
        ? '原神按队伍交互计算，含队友增益、循环轴与充能'
        : '星铁会把队友的「我方全体」类增益按本地技能数据求值后叠加到主 C（默认伤害最高的那个）；写了 buff= 就只用手动值',
    ].join('\n'))
  }

  async teamDamage(e) {
    const m = String(e.msg || '').match(TEAM_DMG_REG)
    if (!m) return false
    const [, prefix, gameName, detailFlag, restRaw] = m
    /* 伤害过程默认不画：一次循环上百条，图会被拉到几千 px，只有指令显式要求才出 */
    const detailWanted = !!detailFlag || /伤害过程|详情|全图/.test(String(restRaw || ''))
    /* 模拟口径：可写「模拟」默认 5 轮，也可写「模拟7轮」指定轮次 */
    const simMatch = String(restRaw || '').match(/(\d+)\s*轮/)
    const simWanted = /模拟|五轮|\d+\s*轮/.test(String(restRaw || ''))
    const simCycles = simMatch ? Math.min(20, Math.max(1, Number(simMatch[1]))) : 5
    const rest = String(restRaw || '').replace(/伤害过程|详情|全图|模拟|五轮|\d+\s*轮/g, ' ').trim()

    /* 手动增益与主 C 参数先从正文里摘出去，避免被当成角色名 */
    const buffArg = (rest.match(/(?:buff|增益)\s*[=:：]\s*([^\s]+)/i) || [])[1] || ''
    const mainArg = (rest.match(/主\s*C\s*[=:：]\s*([^\s,，、]+)/i) || [])[1] || ''
    const manualBuffs = parseManualBuffs(buffArg)
    const mainName = String(mainArg || '').trim()
    const restClean = rest
      .replace(/(?:buff|增益)\s*[=:：]\s*[^\s]+/gi, ' ')
      .replace(/主\s*C\s*[=:：]\s*[^\s,，、]+/gi, ' ')

    const uidInMsg = (restClean.match(/[1-9]\d{8}/) || [])[0] || ''
    const names = restClean
      .replace(/[1-9]\d{8}/g, ' ')
      .split(/[\s,，、。;；|+·]+/)
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 4)

    /* 游戏判定：显式游戏名 > 角色名归属 > 前缀 */
    let game = gameOf(prefix, gameName)
    if (!gameName) {
      const byName = guessGameByNames(names)
      if (byName && byName !== game) {
        logger.mark?.(`[HoYoGet][team_dmg] 按角色名判定为${CN[byName]}（前缀 ${prefix || '无'} 指向 ${CN[game]}）`)
        game = byName
      }
    }
    /* 绝区零由 apps/zzz/zzz_panel_list.js 处理，这里放行 */
    if (game === 'zzz') return false

    const miao = await loadMiao()
    if (!miao) return e.reply('内置面板模型加载失败，请查看日志（system/vendor/miao）。')

    let res = await openPanel(e, miao, game, uidInMsg, names)

    /* 前缀被框架改写时会认错游戏：一个角色都没匹配上就换另一个游戏再找一次。
       显式写了游戏名（#星铁队伍伤害）时不猜，按用户说的来。 */
    const noRole = names.length > 0 && res.reason === 'ok' && !res.avatars.length
    if (!gameName && (noRole || res.reason === 'noprofile')) {
      const alt = game === 'gs' ? 'sr' : 'gs'
      const altRes = await openPanel(e, miao, alt, uidInMsg, names)
      const altOk = altRes.reason === 'ok' && (altRes.avatars.length || !names.length)
      if (altOk) {
        logger.mark?.(`[HoYoGet][team_dmg] 按角色名判定为${CN[alt]}（前缀 ${prefix || '无'} 指向 ${CN[game]}）`)
        res = altRes
        game = alt
      }
    }

    const cn = CN[game]
    if (res.reason === 'nouid') {
      return e.reply([
        `没能确定要查询的${cn} UID。`,
        '可以这样用：',
        `  ${game === 'sr' ? '*' : '#'}队伍伤害 123456789 ${game === 'sr' ? '流萤,花火,灵砂' : '胡桃,行秋,夜兰,钟离'}`,
        `  或先绑定 UID 后再直接发 ${game === 'sr' ? '*' : '#'}队伍伤害`,
      ].join('\n'))
    }
    if (res.reason === 'noprofile') {
      if (res.err) logger.warn?.(`[HoYoGet][team_dmg] ${cn}面板读取失败：${res.err?.message || res.err}`)
      return e.reply([
        `本地暂无 ${res.uid} 的${cn}面板数据。`,
        '请先在游戏内把角色放进展柜并开启显示详情，然后：',
        `  #米哈游${cn}更新面板`,
        names.length ? `若这是${game === 'gs' ? '星铁' : '原神'}队伍，可发「#${game === 'gs' ? '星铁' : '原神'}队伍伤害 ${names.join(',')}」` : '',
      ].filter(Boolean).join('\n'))
    }
    if (names.length && !res.avatars.length) {
      return e.reply([
        `${res.uid} 的${cn}角色柜里没有找到：${res.miss.join('、')}`,
        `可先发「#米哈游${cn}更新面板」再试。`,
        `如果这其实是${game === 'gs' ? '星铁' : '原神'}队伍，可发「#${game === 'gs' ? '星铁' : '原神'}队伍伤害 ${names.join(',')}」`,
      ].join('\n'))
    }
    if (!res.avatars.length) {
      return e.reply(`${res.uid} 的${cn}面板里没有可用角色，可先发「#米哈游${cn}更新面板」。`)
    }

    const uid = res.uid
    const avatars = res.avatars
    e.uid = uid
    e.game = game
    e.isSr = game === 'sr'

    try {
      if (game === 'sr') {
        if (simWanted) {
          const simInputs = avatars.map((av) => avatarToInput(av))
          const sim = await simulateTeamBattle(simInputs, { cycles: simCycles, enemyTotal: 3 })
          const simBuffs = []
          const simMain = String(avatars[0] ? avatars[0].name : '')
          for (const av of avatars) {
            if (String(av.name) === simMain) continue
            simBuffs.push(...(await teamBuffsFrom(av, String(avatars[0] ? avatars[0].elem : ''))))
          }
          const simView = buildSimView(sim, avatars, { uid, teamBuffs: simBuffs, mainName: simMain })
          simView.uid = uid
          simView.source = '工坊引擎 · 5 轮模拟'
          return await render('team_dmg/team', simView, { e, ret: true, dsf: 1.6 })
        }
        const view = await buildSrWithTeamBuffs(avatars, { manualBuffs, mainName })
        view.uid = uid
        return await render('team_dmg/team', view, { e, ret: true, dsf: 1.6 })
      }

      const avatarsByName = {}
      for (const av of avatars) avatarsByName[String(av.name || '')] = av
      const roleData = avatars.map((av) => covTeyvat(av, miao.Format))

      try {
        const { result, source } = await fetchTeamDmg({ uid, server: teyvatServer(uid), role_data: roleData })
        const view = buildGsView(result, avatarsByName, { detail: detailWanted })
        view.source = source
        return await render('team_dmg/team', view, { e, ret: true, dsf: 1.6 })
      } catch (err) {
        /* 接口不可用：明确说明口径后回落本地，别让整条指令直接失效 */
        logger.warn?.(`[HoYoGet][team_dmg] 提瓦特队伍伤害接口失败，回落本地：${err?.message || err}`)
        const view = await buildSrView(avatars)
        view.game = 'gs'
        view.uid = uid
        view.local = true
        return e.reply([
          `提瓦特小助手接口暂时不可用（${err?.message || err}）。`,
          '下面是本地口径：各角色自身面板的最优招式期望伤害，不含队友增益。',
          ...view.members.map((v) => `${v.name}：${v.dmgText}`),
          `合计：${bigNum(view.totalNum)}`,
          '',
          `稍后可再试 #队伍伤害 获取含队友增益的完整计算。`,
        ].join('\n'))
      }
    } catch (err) {
      logger.error?.(`[HoYoGet][team_dmg] 队伍伤害处理失败：${err?.message || err}`)
      return e.reply(`队伍伤害计算失败：${err?.message || err}`)
    }
  }
}

export const __test = {
  gameOf, guessGameByNames, metaNames, TEAM_DMG_REG, TEAM_DMG_HELP_REG, buildSrWithTeamBuffs,
}

