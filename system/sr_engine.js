import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * 星穹铁道工坊战斗引擎适配层
 *
 * 工坊小程序「队伍DPS / 角色伤害查询」的前端计算引擎已还原成独立 H5
 * （engine.bundle.js），这里把它接进 HoYoGet 的星铁队伍伤害：
 *   伤害公式（乘区）与 characters_config 技能倍率来自工坊引擎，
 *   面板（含光锥 / 遗器）来自 miao Avatar 的 attr（米游社面板）。
 *
 * 队友增益分两类处理：
 *   我方增益（攻击/暴击/暴伤/增伤/击破特攻…）→ 换算成工坊 props 终值；
 *   敌方 debuff（减防/无视防御/抗性穿透/易伤）→ 注入工坊 enemy/attacker 的
 *     current 字段（defenseDelRatio / kxAddRatio / ysAddRatio），这些字段引擎
 *     在 defense_ratio / kx_ratio / ys_ratio 乘区里已按官方公式消费，注入即生效。
 */

let _HSR = null
function engine() {
  if (_HSR) return _HSR
  require(path.join(__dirname, 'sr_engine', 'engine.bundle.js'))
  _HSR = global.HSR
  if (!_HSR) throw new Error('工坊引擎加载失败：global.HSR 不存在')
  const sys = require(path.join(__dirname, 'sr_engine', 'system_data.json'))
  _HSR.setSystemData(sys?.data || sys)
  /* 套装类要读 getApp().globalData.$G.game（node 环境没有小程序运行时），
     这两张表 system_data.json 里本来就有，补个桩即可。
     system_artifacts 缺 set_id，按单件 5★ id 前三位补（61241 -> 124）。 */
  installGameStub(sys?.data || sys)
  return _HSR
}

let _GAME = null
function installGameStub(root) {
  if (_GAME) return _GAME
  const data = root || {}
  const dict = (k) => data[k] || []
  const artifacts = dict("system_artifacts")
  for (const a of artifacts) {
    if (a && !a.set_id) {
      const first = (a.artifacts_json || [])[0]
      const id5 = first && first.item_id5
      if (id5) a.set_id = Number(String(id5).slice(1, 4))
    }
  }
  const game = {
    getGameDictByKey: (k) => dict(k),
    getSystemRole: (e) => {
      const id = String((e && e.item_id) || e || "")
      return dict("system_roles").find((r) => String(r.item_id) === id && r.item_id !== "") || null
    },
    getSystemRelicBySetId: (setId) => artifacts.find((a) => String(a.set_id) === String(setId)) || null,
    getRelicSetInfo: () => null,
  }
  _GAME = game
  globalThis.getApp = () => ({ globalData: { $G: { game } } })
  return game
}

/** 元素 → 工坊 props 的增伤键 */
const ELEM_ADD = {
  物理: 'physicalAddHurt', 火: 'fireAddHurt', 冰: 'iceAddHurt', 雷: 'elecAddHurt',
  风: 'windAddHurt', 量子: 'quantumAddHurt', 虚数: 'imaginaryAddHurt',
}

/** miao 行迹等级兼容数字 / { level } 两种结构 */
function talentLevel(talent, key) {
  const v = talent?.[key]
  if (v == null) return 1
  if (typeof v === 'number') return v
  if (typeof v === 'object') return Number(v.level) || 1
  return Number(v) || 1
}

/**
 * miao Avatar → 工坊 calcDamage 输入。
 * 面板用 miao attr 的终值（已含光锥与遗器），因此不传 weaponConfig，避免重复计光锥。
 */

/**
 * miao 的套装统计（{"套装名": 件数}）→ 工坊 relicList。
 * 工坊按单件 id 反查套装（mc.default[id].set_id），单件 5★ id 存在
 * system_artifacts[].artifacts_json[].item_id5，所以按套装名匹配后取前 N 件。
 * 少了它 4 件套 / 2 件套的增伤、治疗加成全部不生效。
 */
export function relicListOf(av) {
  engine()
  const sets = av?.artis?.sets || {}
  const all = (_GAME && _GAME.getGameDictByKey("system_artifacts")) || []
  const out = []
  for (const name of Object.keys(sets)) {
    const hit = all.find((a) => String(a.name) === String(name))
    if (!hit) continue
    const ids = (hit.artifacts_json || []).map((p) => p.item_id5).filter(Boolean)
    const total = Math.min(Number(sets[name]) || 0, ids.length)
    for (let i = 0; i < total; i++) out.push({ id: String(ids[i]), level: 15 })
  }
  return out
}

export function avatarToInput(av) {
  const attr = av.attr || {}
  /* base 必须给：引擎的 updatePanelSpeed 会按 base 重算行动值，只给 *Final 会算出 NaN，
     该角色在行动队列里永远排不到队首（实测遐蝶一次都不出手）。 */
  const base = av.base || {}
  const b = (v, fb) => (Number(v) > 0 ? Number(v) : Number(fb) || 0)
  const props = {
    hpFinal: Number(attr.hp) || 0,
    hpBase: b(base.hp, attr.hp),
    attackFinal: Number(attr.atk) || 0,
    attackBase: b(base.atk, attr.atk),
    defenseFinal: Number(attr.def) || 0,
    defenseBase: b(base.def, attr.def),
    speedFinal: Number(attr.speed) || 0,
    speedBase: b(base.speed, attr.speed),
    criticalChance: (Number(attr.cpct) || 0) / 100,
    criticalDamage: (Number(attr.cdmg) || 0) / 100,
    statusProbability: (Number(attr.effPct) || 0) / 100,
    // 击破特攻 → 工坊 stanceBreakRatio（break_ratio 区）；breakEffectAddRatio 是击破效率，勿混
    stanceBreakRatio: (Number(attr.stance) || 0) / 100,
    /* 治疗加成：缺了它风堇的治疗量偏低，遐蝶的信任条（34000）攒不满，死龙就召不出来 */
    healRatio: Number(attr.heal) || 0,
  }
  const ek = ELEM_ADD[String(av.elem || '')]
  if (ek) props[ek] = (Number(attr.dmg) || 0) / 100
  return {
    item_id: av.id,
    relicList: relicListOf(av),
    level: Number(av.level) || 80,
    rank: Number(av.cons) || 0,
    skill_levels: {
      普攻: talentLevel(av.talent, 'a'),
      战技: talentLevel(av.talent, 'e'),
      终结技: talentLevel(av.talent, 'q'),
      天赋: talentLevel(av.talent, 't'),
    },
    props,
  }
}

const SKILL_TYPES = ['普攻', '战技', '终结技', '天赋']

/**
 * miao teamBuffs（[{ src, title, data }]）→ 工坊注入 patch。
 * data 里的键是 miao 乘区键，值统一为百分数（45 = 45%）；atkPlus/hpPlus/defPlus/speedPlus 为固定值。
 *
 * 返回：
 *   props    我方面板增益（终值增量），最终加到 avatarToInput 的面板终值上
 *   enemy    敌方 debuff（defenseDelRatio 减防 / ysAddRatio 易伤）
 *   attacker 角色侧注入（kxAddRatio 抗性穿透 / hurtAddRatio 全增伤；hurtAddRatio 走 inst.current 而非 props，因为 initAsync 不消费 props.hurtAddRatio）
 */
export function teamBuffsToPatch(teamBuffs = [], av) {
  const props = {}
  const enemy = { defenseDelRatio: 0, ysAddRatio: 0 }
  const attacker = { kxAddRatio: 0, hurtAddRatio: 0 }
  const base = av?.base || {}
  const add = (o, k, v) => { o[k] = (o[k] || 0) + v }
  for (const b of teamBuffs || []) {
    const d = b?.data || {}
    for (const [k, v] of Object.entries(d)) {
      const n = Number(v) || 0
      if (!n) continue
      switch (k) {
        /* 百分比类：乘白值（miao base 里的 xxxBase） */
        case 'atkPct': add(props, 'attackFinal', (Number(base.atkBase) || 0) * n / 100); break
        case 'hpPct': add(props, 'hpFinal', (Number(base.hpBase) || 0) * n / 100); break
        case 'defPct': add(props, 'defenseFinal', (Number(base.defBase) || 0) * n / 100); break
        case 'speedPct': add(props, 'speedFinal', (Number(base.speedBase) || 0) * n / 100); break
        /* 固定值类 */
        case 'atkPlus': add(props, 'attackFinal', n); break
        case 'hpPlus': add(props, 'hpFinal', n); break
        case 'defPlus': add(props, 'defenseFinal', n); break
        case 'speedPlus': add(props, 'speedFinal', n); break
        /* 面板百分比类（0-1 小数） */
        case 'cpctPlus': add(props, 'criticalChance', n / 100); break
        case 'cdmgPlus': add(props, 'criticalDamage', n / 100); break
        case 'dmgPlus': add(attacker, 'hurtAddRatio', n / 100); break
        case 'stancePlus': add(props, 'stanceBreakRatio', n / 100); break
        /* 敌方 debuff（current 注入） */
        case 'enemyDef': add(enemy, 'defenseDelRatio', n / 100); break
        case 'ignore': add(enemy, 'defenseDelRatio', n / 100); break
        case 'enemydmgPlus': add(enemy, 'ysAddRatio', n / 100); break
        case 'kx': add(attacker, 'kxAddRatio', n / 100); break
        /* rechargePlus/healPlus/masteryPlus/effPctPlus 及技能级 aDmg/eDmg/… 不影响直伤，忽略 */
        default: break
      }
    }
  }
  return { props, enemy, attacker }
}

/**
 * 工坊引擎算单技能期望伤害，支持敌方 debuff 注入。
 * 复刻 engine 的 calcDamage，但把 patch 注入 enemy.current / inst.current。
 */
async function calcDamageWithBuffs(input, patch = {}) {
  const H = engine()
  const req = H._req
  const C = H.constants()
  const cfgAll = req('c8e9').default || []
  let base = null
  for (const c of cfgAll) if (String(c.item_id) === String(input.item_id)) { base = c; break }
  if (!base) throw new Error('找不到角色 ' + input.item_id)
  const cfg = JSON.parse(JSON.stringify(base))
  if (input.level) cfg.level = input.level
  if (input.skill_ranks) cfg.skill_ranks = input.skill_ranks
  cfg.props = Object.assign({}, input.props || {})

  const Mgr = req('db24').default
  const inst = new Mgr().getInstance(cfg)
  await inst.initAsync()

  const Enemy = req('0515').default
  const enemy = new Enemy({ name: '测试目标', id: 9000202, item_id: 900020, level: input.enemyLevel || 80 })
  // 敌方 debuff：减防 / 易伤 / 抗性降低
  if (patch.enemy) {
    if (patch.enemy.defenseDelRatio) enemy.current.defenseDelRatio = patch.enemy.defenseDelRatio
    if (patch.enemy.ysAddRatio) enemy.current.ysAddRatio = patch.enemy.ysAddRatio
  }
  // 角色侧：抗性穿透 / 全增伤（hurtAddRatio 走 current 注入，基准 1）
  if (patch.attacker) {
    if (patch.attacker.kxAddRatio) inst.current.kxAddRatio = patch.attacker.kxAddRatio
    if (patch.attacker.hurtAddRatio) inst.current.hurtAddRatio = (inst.current.hurtAddRatio || 1) + patch.attacker.hurtAddRatio
  }

  const BM = req('3d45').default
  const bm = new BM([inst], [enemy])
  const dm = bm.damageManager

  const type = input.skillType || '战技'
  let skill = null
  for (const k of (inst.skills || [])) if (k.type === type) { skill = k; break }
  if (!skill) skill = (inst.skills || [])[0]
  if (!skill) throw new Error('该角色没有可用技能')

  const opt = {
    damageType: C.DAMAGE_NORMAL,
    damageMainProp: C.DAMAGE_MAIN_PROP.ATTACK,
    overrideCalcAreas: {},
  }
  const areas = dm.getDamageCalcArae(inst, enemy, skill, opt)
  const keys = ['attack', 'bl', 'crit_ratio', 'hurt_ratio', 'ys_ratio', 'kx_ratio', 'resilience_ratio', 'defense_ratio', 'ysbl_ratio']
  const total = dm.calcAreasKeysValue(keys, areas)
  return {
    totalDamage: total,
    skill: { name: skill.name, type: skill.type, bl: skill.blValue },
  }
}

/**
 * 工坊引擎算某角色最优招式期望伤害（可带队友增益）。
 * 返回结构与 miao calcDmg 兼容：{ ret: [{ avg, title }] }，供 buildSrView 直接复用。
 */
export async function calcAvatarBestDmg(av, enemyLevel = 80, teamBuffs = []) {
  const input = avatarToInput(av)
  const patch = teamBuffsToPatch(teamBuffs, av)
  // 我方增益叠加到面板终值（hurtAddRatio 走 patch.attacker，不在此处）
  const props = { ...input.props }
  for (const [k, v] of Object.entries(patch.props || {})) {
    props[k] = (props[k] || 0) + v
  }
  let best = null
  for (const type of SKILL_TYPES) {
    try {
      const r = await calcDamageWithBuffs({ ...input, props, skillType: type, enemyLevel }, patch)
      if (r && (best == null || r.totalDamage > best.totalDamage)) best = r
    } catch (_) { /* 该技能无伤害规则则跳过 */ }
  }
  if (!best) return { ret: [] }
  return {
    ret: [{ avg: best.totalDamage, title: best.skill?.name || best.skill?.type || '' }],
    totalDamage: best.totalDamage,
    skill: best.skill,
  }
}


/** 从工坊角色配置表里取一份可改写的配置 */
function cfgOf(HSR, itemId) {
  const all = HSR._req("c8e9").default || []
  const hit = all.find((c) => String(c.item_id) === String(itemId))
  if (!hit) throw new Error("工坊配置里找不到角色 " + itemId)
  return JSON.parse(JSON.stringify(hit))
}

/** 补行动技能槽：实例化后 actionSkills 是空的，AI 取不到技能就静默不出手 */
function fillActionSkills(inst) {
  try { if (typeof inst.changeActionSKills === "function") inst.changeActionSKills(false) } catch (_) { /* 部分子类没有这个方法 */ }
  if (!inst.actionSkills || !inst.actionSkills.length || typeof inst.actionSkills[0] !== "string") {
    const id = String(inst.item_id || "")
    inst.actionSkills = [id + "01", id + "02", id + "03"]
  }
}

/**
 * 工坊口径的整场模拟：cycles 轮 × enemyTotal 敌，自动战斗。
 *
 * 与 calcAvatarBestDmg 的区别：那个是「单角色最优单招期望」，这个是工坊
 * 「队伍DPS伤害计算」页的同一套流程 —— 按速度排行动值、AI 自动选技
 * （输出位 autoCarryMode / 辅助位 autoSupportMode / 生存位 autoLiveMode，
 * 终结技由 autoUltimate 插队）、忆灵参战，最后按 logManager 汇总每人伤害。
 *
 * 三处必须的初始化，缺一个就完全没伤害（都是实测踩出来的）：
 *   1. props 必须带 *Base（见 avatarToInput），否则行动值算成 NaN，角色永不行动；
 *   2. 实例化后要补 actionSkills，否则 AI 取不到技能；
 *   3. 推进靠 battleStart 内部的 execRound → eventOnWaitAction 递归，跑完必须调
 *      logManager.getFormatBattleLogs() 才会汇总出 totalDamage / groupRoleDamages。
 */
export async function simulateTeamBattle(inputs = [], opts = {}) {
  const { cycles = 5, enemyTotal = 3 } = opts
  const empty = { totalDamage: 0, teamDps: 0, groups: [], cycles }
  if (!inputs.length) return empty
  const HSR = engine()
  const Mgr = HSR._req("db24").default
  const Enemy = HSR._req("0515").default
  const BM = HSR._req("3d45").default
  const CONST = HSR._req("286c").default
  const mgr = new Mgr()
  const chars = []
  for (const input of inputs) {
    const cfg = cfgOf(HSR, input.item_id)
    cfg.props = { ...input.props }
    if (input.relicList && input.relicList.length) cfg.relicList = input.relicList
    const lv = input.skill_levels || {}
    cfg.skills = (cfg.skills || []).map((sk) => {
      if (sk && lv[sk.type]) sk.level = lv[sk.type]
      return sk
    })
    const inst = mgr.getInstance(cfg)
    await inst.initAsync()
    fillActionSkills(inst)
    chars.push(inst)
  }
  const enemies = []
  for (let i = 0; i < enemyTotal; i++) {
    enemies.push(new Enemy({ name: "敌人" + (i + 1), id: 9000202, item_id: 900020, level: 80 }))
  }
  const bm = new BM(chars, enemies)
  HSR._req("af51").default.setInstance(bm)
  bm.setBattleCycle(cycles)
  bm.setBattleMode(CONST.BATTLE_MODE.AUTO)
  bm.battleStart()
  const lm = bm.logManager
  try { lm.getFormatBattleLogs() } catch (_) { /* 汇总失败就用已有日志 */ }
  const groups = (lm.groupRoleDamages || []).map((g) => ({
    name: String(g.name || ""),
    objectId: String(g.object_id || ""),
    value: Number(g.value) || 0,
    hits: Number(g.totalRecord) || 0,
  }))
  const totalDamage = Number(lm.totalDamage) || 0
  /* 行动记录：logManager 会给每个回合的 skills 写 desc（"遐蝶使用了战技 [xxx]"），
     去掉主语就是一串可直接展示的操作手法。 */
  const actions = []
  for (const round of (lm.battleLogs || [])) {
    for (const sk of (round.skills || [])) {
      const d = String(sk.desc || "")
      if (!d) continue
      const cut = d.indexOf("使用了")
      actions.push(cut >= 0 ? d.slice(cut + 3).trim() : d)
    }
  }
  return { totalDamage, teamDps: cycles > 0 ? totalDamage / cycles : 0, groups, actions: actions.slice(0, 18), cycles }
}

export const __test = { engine, avatarToInput, teamBuffsToPatch, calcAvatarBestDmg, simulateTeamBattle, ELEM_ADD }
