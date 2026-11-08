/**
 * 崩三 Boss 属性（怪物属性 / 伤害类型 / 怪物类型 / 威胁等级）。
 * 数据来自崩三敌人图鉴详情（getBh3BossCodex），同一 Boss 只查一次，结果进内存缓存。
 * 图鉴没有弱点表，只能给出属性与伤害类型；查不到则返回空，不影响排期出图。
 */
import { getBh3BossCodex } from './bh3_abyss_boss.js'

const ATTR_CACHE = new Map()

// 属性 -> 样式类（与排期模板中的 .attr-* 对应）
export const BH3_ATTR_CLASS = {
  火: 'fire', 冰: 'ice', 雷: 'thunder', 物理: 'phys', 虚数: 'imaginary', 风: 'wind', 量子: 'quantum',
  异能: 'ability', 生物: 'bio', 机械: 'mech', 星辰: 'star', 星尘: 'star',
}

const BH3_ATTR_ICONS = {
  火: 'bh3_火.svg', 冰: 'bh3_冰.svg', 雷: 'bh3_雷.svg', 物理: 'bh3_物理.svg',
  虚数: 'bh3_虚数.png', 量子: 'bh3_量子.png',
  异能: 'bh3_异能.png', 生物: 'bh3_生物.png', 机械: 'bh3_机械.png', 星辰: 'bh3_星尘.png', 星尘: 'bh3_星尘.png',
}

const BH3_DMG_ICONS = {
  物理: 'bh3_流血.png', 火: 'bh3_点燃.png', 火伤: 'bh3_点燃.png', 火焰: 'bh3_点燃.png', 火焰元素: 'bh3_点燃.png',
  冰: 'bh3_冻结.png', 冰伤: 'bh3_冻结.png', 冰冻: 'bh3_冻结.png', 冰冻元素: 'bh3_冻结.png',
  雷: 'bh3_麻痹.png', 雷伤: 'bh3_麻痹.png', 雷电: 'bh3_麻痹.png', 雷电元素: 'bh3_麻痹.png',
}

function iconList(value, icons) {
  return String(value || '').split(/[、，,/]/).map(part => icons[part.trim()]).filter(Boolean)
}

function pick(text, label) {
  const m = String(text || '').match(new RegExp(`${label}：([^\\n]+)`))
  return m ? m[1].trim() : ''
}

export async function getBh3BossAttrs(name) {
  if (!name) return null
  if (ATTR_CACHE.has(name)) return ATTR_CACHE.get(name)
  let attrs = null
  try {
    const codex = await getBh3BossCodex(name)
    if (codex && typeof codex === 'object' && codex.text) {
      // 多属性形如「异能（骑乘战马）、生物（摔下战马）」，只保留属性名
      const clean = v => String(v || '').replace(/（[^）]*）/g, '').replace(/^无$/, '').trim()
      const attr = clean(pick(codex.text, '怪物属性'))
      const dmg = clean(pick(codex.text, '伤害类型'))
      const type = pick(codex.text, '怪物类型')
      const threat = pick(codex.text, '威胁等级')
      if (attr || dmg || threat) {
        attrs = {
          attr, attrClass: BH3_ATTR_CLASS[attr] || 'other',
          attrIcons: iconList(attr, BH3_ATTR_ICONS),
          dmg, dmgIcons: iconList(dmg, BH3_DMG_ICONS), type, threat,
        }
      }
    }
  } catch (_) {
    attrs = null
  }
  // 查询失败不缓存，下次出图再试
  if (attrs) ATTR_CACHE.set(name, attrs)
  return attrs
}

/** 给排期/战场的 Boss 列表补上属性字段（就地修改，返回同一数组） */
export async function enrichBh3BossAttrs(items = [], nameKey = 'boss') {
  const names = [...new Set(items.map(it => it?.[nameKey]).filter(Boolean))]
  const found = new Map()
  for (const name of names) found.set(name, await getBh3BossAttrs(name))
  for (const it of items) {
    const a = found.get(it?.[nameKey])
    if (a) Object.assign(it, {
      attr: a.attr, attrClass: a.attrClass, attrIcons: a.attrIcons,
      dmg: a.dmg, dmgIcons: a.dmgIcons, threat: a.threat, bossType: a.type,
    })
  }
  return items
}
