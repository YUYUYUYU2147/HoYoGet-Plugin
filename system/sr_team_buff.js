import lodash from 'lodash'
import DmgAttr from './vendor/miao/models/dmg/DmgAttr.js'

/**
 * 星铁队伍增益
 *
 * miao 的伤害管线（ProfileDmg.calcData）里，最终属性 = 面板 originalAttr + buffs，
 * buffs 由「角色 calc.js 的 buffs + 武器 + 套装」组成，再交给 DmgAttr.calcAttr 逐条累加。
 * 也就是说：队友增益只要作为一条 buff 塞进 buffs，就会精确落在对应乘区上。
 *
 * 数据从哪来：本地 `resources/meta-sr/character/<名>/calc.js` 导出的 `buffs` 里，
 * 本来就写着「我方全体伤害提高[dmg]%」「我方全体暴击伤害提高[cdmg]%」这类条目，
 * data 里的键（atkPct / dmg / cdmg / enemyDef / kx / stance …）与 DmgAttr 的乘区键一一对应。
 * 所以不需要手抄数值：用辅助角色自己的技能等级、面板、行迹、星魂求值，算出来就是这条增益。
 *
 * 求值方式（差值法，避免重复实现 calcAttr 的规则）：
 *   base  = calcAttr(buffs: [])
 *   only  = calcAttr(buffs: 只筛出「给队友」的条目)
 *   delta = only - base  →  转成目标角色可用的 data 键
 * 这样命座条件（cons）、行迹条件（tree）、元素限定都在辅助的上下文里判过，不会张冠李戴。
 */

/** 标题里明确是「给全队 / 给队友」的才算 */
const TEAM_TITLE_RE = /我方全体|我方全队|全队|我方/
/** 单体增益与敌方 debuff：标题里不一定写「我方」，按语义补 */
const TEAM_TITLE_EXTRA = /战技提高暴击伤害|单人攻击力提高|敌方目标防御力降低|降低敌方防御|降低防御力|添加弱点|赐福|抗性穿透/
/** 明显只作用于自己的，排除 */
const SELF_TITLE_RE = /自身|自己的|本角色|施放战技后自身|普攻的暴击率/

const ELEM_WORDS = ['火', '冰', '雷', '风', '量子', '虚数', '物理']

/** 元素限定：标题写「火属性伤害提高」就只对火属性主 C 生效 */
function elemAllowed(title, mainElem) {
  const m = String(title || '').match(new RegExp(`(${ELEM_WORDS.join('|')})属性`))
  if (!m) return true
  if (!mainElem) return true
  return m[1] === String(mainElem)
}

/** 这条 buff 定义是不是给队友的 */
function isTeamBuff(buff, mainElem) {
  const title = String(buff?.title || '')
  if (!title) return false
  if (SELF_TITLE_RE.test(title) && !/我方|全队/.test(title)) return false
  if (!(TEAM_TITLE_RE.test(title) || TEAM_TITLE_EXTRA.test(title))) return false
  return elemAllowed(title, mainElem)
}

/**
 * 标题里写了「风堇2魂」「知更鸟4命」的条目，部分 calc.js 只写在标题里而没写 cons 字段，
 * 这里补一道命座校验，避免 0 命辅助吃到满命的增益。
 */
function consAllowed(buff, cons) {
  const m = String(buff?.title || '').match(/(\d)\s*[魂命]/)
  if (m && cons < Number(m[1])) return false
  return true
}

/** attr 差值 → 目标角色可用的 data 键 */
const DELTA_MAP = [
  ['atk', 'pct', 'atkPct'], ['atk', 'plus', 'atkPlus'],
  ['hp', 'pct', 'hpPct'], ['hp', 'plus', 'hpPlus'],
  ['def', 'pct', 'defPct'], ['def', 'plus', 'defPlus'],
  ['cpct', 'plus', 'cpctPlus'], ['cdmg', 'plus', 'cdmgPlus'],
  ['dmg', 'plus', 'dmgPlus'], ['mastery', 'plus', 'masteryPlus'],
  ['stance', 'plus', 'stancePlus'], ['speed', 'pct', 'speedPct'], ['speed', 'plus', 'speedPlus'],
  ['recharge', 'plus', 'rechargePlus'], ['heal', 'plus', 'healPlus'],
  ['enemydmg', 'plus', 'enemydmgPlus'], ['effPct', 'plus', 'effPctPlus'],
]

const SKILL_KEYS = ['a', 'a2', 'a3', 'e', 'q', 't', 'me', 'mt', 'j', 'as', 'dot', 'break']

function attrToData(base, only) {
  const data = {}
  for (const [field, sub, key] of DELTA_MAP) {
    const d = (only?.[field]?.[sub] || 0) - (base?.[field]?.[sub] || 0)
    if (Math.abs(d) > 1e-9) data[key] = Math.round(d * 1000) / 1000
  }
  /* 敌方侧：减防 / 无视防御 / 抗性穿透 */
  const defDown = (only?.enemy?.def || 0) - (base?.enemy?.def || 0)
  if (Math.abs(defDown) > 1e-9) data.enemyDef = Math.round(defDown * 1000) / 1000
  const ignore = (only?.enemy?.ignore || 0) - (base?.enemy?.ignore || 0)
  if (Math.abs(ignore) > 1e-9) data.ignore = Math.round(ignore * 1000) / 1000
  const kx = (only?.kx || 0) - (base?.kx || 0)
  if (Math.abs(kx) > 1e-9) data.kx = Math.round(kx * 1000) / 1000
  /* 技能级增伤：eDmg / qDmg / meDmg … */
  for (const sk of SKILL_KEYS) {
    const d = (only?.[sk]?.dmg || 0) - (base?.[sk]?.dmg || 0)
    if (Math.abs(d) > 1e-9) data[`${sk}Dmg`] = Math.round(d * 1000) / 1000
    const p = (only?.[sk]?.pct || 0) - (base?.[sk]?.pct || 0)
    if (Math.abs(p) > 1e-9) data[`${sk}Pct`] = Math.round(p * 1000) / 1000
  }
  return data
}

/**
 * 某个辅助角色给队友提供的增益。
 * 返回 [{ src, title, data }]，data 为空或没有可识别的乘区时丢弃。
 */
export async function teamBuffsFrom(helperAv, mainElem = '') {
  try {
    /* calcDmg 会按需创建 av.dmg（内含 profile/talent/trees），不用自己拼 ds */
    await helperAv.calcDmg({ mode: 'profile' })
    const inst = helperAv.dmg
    if (!inst?.profile) return []
    const rule = await inst.getCalcRule()
    const defs = Array.isArray(rule?.buffs) ? rule.buffs : []
    if (!defs.length) return []

    const cons = Number(inst.profile.cons) || Number(helperAv.cons) || 0
    const picked = defs.filter((b) => isTeamBuff(b, mainElem) && consAllowed(b, cons))
    if (!picked.length) return []

    const { id, weapon, attr, artis } = inst.profile
    const meta = {
      charId: inst.char?.id,
      uid: inst.profile.uid,
      level: inst.profile.level,
      cons: inst.profile.cons * 1,
      talent: inst.talent(),
      trees: inst.trees(),
      weapon,
    }
    const originalAttr = DmgAttr.getAttr({ id, weapon, attr, char: inst.char, game: 'sr', sp: inst.detail?.sp })
    /* 队伍伤害按理想循环估算：终结技视为全程覆盖（calc.js 里 params.q 就是「是否处于终结技状态」） */
    const params = { q: true }
    const run = (buffs) => {
      const { attr: a, msg } = DmgAttr.calcAttr({
        originalAttr, buffs: lodash.cloneDeep(buffs), artis, meta, params: lodash.cloneDeep(params), game: 'sr',
      })
      return { attr: a, msg }
    }
    const base = run([])
    const only = run(picked)
    const data = attrToData(base.attr, only.attr)
    if (!Object.keys(data).length) return []

    /* msg 是 calcAttr 回填过数值的标题（占位符已替换），比原始 title 可读 */
    const titles = (only.msg || []).map((t) => String(t || '').trim()).filter(Boolean)
    return [{
      src: String(helperAv.name || ''),
      title: titles.length ? titles.join('；') : picked.map((b) => String(b.title || '')).join('；'),
      data,
    }]
  } catch (err) {
    globalThis.logger?.debug?.(`[HoYoGet][sr_team_buff] ${helperAv?.name} 增益解析失败：${err?.message || err}`)
    return []
  }
}

/* ───────── 手动增益：buff=攻击45%,增伤60%,暴伤40%,减防12% ───────── */

const MANUAL_KEYS = [
  [/(暴击伤害|爆伤|暴伤|cdmg)/, 'cdmgPlus', '暴伤'],
  [/(暴击率|暴击|cpct)/, 'cpctPlus', '暴击率'],
  [/(攻击力|攻击|atk)/, 'atkPct', '攻击'],
  [/(生命值|生命|hp)/, 'hpPct', '生命'],
  [/(防御力|防御|def)/, 'defPct', '防御'],
  [/(增伤|伤害提高|伤害|dmg)/, 'dmgPlus', '增伤'],
  [/(精通|mastery)/, 'masteryPlus', '精通'],
  [/(速度|speed)/, 'speedPlus', '速度'],
  [/(击破特攻|击破|stance)/, 'stancePlus', '击破特攻'],
  [/(易伤|enemydmg)/, 'enemydmgPlus', '易伤'],
  [/(减防|降防|enemyDef)/, 'enemyDef', '减防'],
  [/(无视防御|ignore)/, 'ignore', '无视防御'],
  [/(抗性穿透|穿透|kx)/, 'kx', '抗性穿透'],
  [/(充能|recharge)/, 'rechargePlus', '充能'],
]

/**
 * 解析 `buff=攻击45%,增伤60%,暴伤40%`。
 * 用于表里没收录的辅助：数值由用户给，绝对准。
 */
export function parseManualBuffs(text) {
  const s = String(text || '').trim()
  if (!s) return []
  const out = []
  for (const part of s.split(/[,，、;；|]+/).map((v) => v.trim()).filter(Boolean)) {
    const m = part.match(/^([^\d+\-.=]+?)\s*[=:]?\s*([+\-]?\d+(?:\.\d+)?)\s*%?$/)
    if (!m) continue
    const label = m[1].replace(/\s+/g, '')
    const value = Number(m[2])
    if (!Number.isFinite(value)) continue
    const hit = MANUAL_KEYS.find(([re]) => re.test(label))
    if (!hit) continue
    out.push({ key: hit[1], name: hit[2], value })
  }
  if (!out.length) return []
  return [{
    src: '手动',
    title: out.map((v) => `${v.name}+${v.value}%`).join('；'),
    data: out.reduce((acc, v) => { acc[v.key] = (acc[v.key] || 0) + v.value; return acc }, {}),
  }]
}

/**
 * 带增益计算角色伤害：把额外 buff 注入 miao 的 buff 链，算完立刻还原，不影响其它指令。
 */
export async function calcAvatarWithBuffs(av, extraBuffs = []) {
  if (!extraBuffs?.length) return await av.calcDmg({ mode: 'profile' })
  await av.calcDmg({ mode: 'profile' })
  const inst = av.dmg
  if (!inst) return await av.calcDmg({ mode: 'profile' })

  const orig = inst.getBuffs.bind(inst)
  const injected = extraBuffs.map((b, i) => ({
    title: `${b.src ? b.src + '：' : ''}${b.title || '队伍增益'}`,
    data: lodash.cloneDeep(b.data || {}),
    sort: 1,
    __idx: i,
  }))
  inst.getBuffs = (buffs) => orig(buffs).concat(lodash.cloneDeep(injected))
  try {
    return await inst.calcData({ mode: 'profile' })
  } finally {
    inst.getBuffs = orig
  }
}

export const __test = { isTeamBuff, attrToData, parseManualBuffs, teamBuffsFrom, calcAvatarWithBuffs }
