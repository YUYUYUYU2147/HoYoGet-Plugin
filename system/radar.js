/**
 * 六轴培养雷达图：按常见毕业线归一化，超出即贴边。
 * 只做「相对强弱」示意，不代表官方评分。
 *
 * 面板详情（apps/hoyo_panel.js）与深渊摘要（apps/abyss_stat.js）共用，
 * 两边传入的都是 miao 的 Avatar / profile（带 `attr`）。
 */
export function buildRadar(profile, game = 'gs') {
  const a = profile?.attr || {}
  /* miao 的 attr 里 cpct/cdmg/recharge 已经是百分数（41.5 表示 41.5%），
     不能再 ×100，否则双爆永远贴边。星铁的速度键是 speed（不是 spd）。 */
  const axes = game === 'sr'
    ? [['生命值', a.hp, 8000], ['攻击力', a.atk, 3000], ['防御力', a.def, 1200],
      ['暴击率', a.cpct, 100], ['暴击伤害', a.cdmg, 250], ['速度', a.speed, 160]]
    : [['生命值', a.hp, 35000], ['攻击力', a.atk, 2600], ['防御力', a.def, 1800],
      ['暴击率', a.cpct, 100], ['暴击伤害', a.cdmg, 250], ['元素充能', a.recharge, 200]]
  const cx = 92
  const cy = 92
  const r = 62
  const points = []
  const labels = []
  const spokes = []
  axes.forEach(([label, value, full], i) => {
    const ratio = Math.max(0.14, Math.min(1, (Number(value) || 0) / full))
    const angle = -Math.PI / 2 + i * (Math.PI / 3)
    const x = cx + Math.cos(angle) * r * ratio
    const y = cy + Math.sin(angle) * r * ratio
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    const ex = cx + Math.cos(angle) * r
    const ey = cy + Math.sin(angle) * r
    spokes.push({ x1: cx, y1: cy, x2: ex.toFixed(1), y2: ey.toFixed(1) })
    const lx = cx + Math.cos(angle) * (r + 15)
    const ly = cy + Math.sin(angle) * (r + 15)
    labels.push({
      label,
      x: lx.toFixed(1),
      y: ly.toFixed(1),
      anchor: Math.abs(Math.cos(angle)) < 0.2 ? 'middle' : (Math.cos(angle) > 0 ? 'start' : 'end'),
    })
  })
  /* 三层参考环：由外到内 1 / 0.66 / 0.33，模板里逐层输出 */
  const ring = scale => axes.map((_, i) => {
    const angle = -Math.PI / 2 + i * (Math.PI / 3)
    return `${(cx + Math.cos(angle) * r * scale).toFixed(1)},${(cy + Math.sin(angle) * r * scale).toFixed(1)}`
  }).join(' ')
  const grid = [1, 0.66, 0.33].map(ring)
  return { polygon: points.join(' '), labels, spokes, grid, cx, cy, r }
}
