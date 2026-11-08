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
          dmg, type, threat,
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
    if (a) Object.assign(it, { attr: a.attr, attrClass: a.attrClass, dmg: a.dmg, threat: a.threat, bossType: a.type })
  }
  return items
}
