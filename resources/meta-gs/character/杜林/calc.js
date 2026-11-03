export const details = [
  {
    title: "E转变·白化之是伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["转变·白化之是伤害"], "e")
  }, {
    title: "E转变·黑度之否总伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["转变·黑度之否伤害"], "e")
  }, {
    title: "E转变·黑度之否总蒸发",
    params: { Heidu: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["转变·黑度之否伤害"], "e", "vaporize")
  }, {
    title: "Q白化法·如光流变总伤害",
    params: { Bleaching: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["白化法·如光流变伤害"], "q")
  }, {
    title: "Q黑度法·如星阴燃总伤害",
    params: { Heidu: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["黑度法·如星阴燃伤害"], "q")
  }, {
    title: "Q黑度法·如星阴燃总蒸发",
    params: { Heidu: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["黑度法·如星阴燃伤害"], "q", "vaporize")
  }, {
    title: "Q白焰之龙伤害",
    params: { Bleaching: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["白焰之龙伤害"], "q")
  }, {
    title: "Q黑蚀之龙伤害",
    params: { Heidu: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["黑蚀之龙伤害"], "q")
  }, {
    title: "Q黑蚀之龙蒸发",
    params: { Heidu: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["黑蚀之龙伤害"], "q", "vaporize")
  }
]

export const defDmgIdx = 8
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,dmg"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·升华赞歌：光灵遵神数显现持续时间内，白焰之龙力量形态下，额外降低15%抗性，黑蚀之龙力量形态下，蒸发、融化反应造成的伤害额外提升30%",
    data: {
      kx: ({ params }) => params.Bleaching ? 20 * 75 / 100 : 0,
      vaporize: ({ params }) => params.Heidu ? 40 * 75 / 100 : 0,
      melt: ({ params }) => params.Heidu ? 40 * 75 / 100 : 0
    }
  }, {
    title: "天赋-光灵遵神数显现：白焰之龙力量形态下，造成火元素相关反应后，或对燃烧状态敌人造成伤害时，降低敌人20%抗性，黑蚀之龙力量形态下，蒸发、融化反应伤害提升40%",
    data: {
      kx: ({ params }) => params.Bleaching ? 20 : 0,
      vaporize: ({ params }) => params.Heidu ? 40 : 0,
      melt: ({ params }) => params.Heidu ? 40 : 0
    }
  }, {
    title: "天赋-混沌如黑夜构成：施放元素爆发后，额外造成相当于原本白焰之龙与黑蚀之龙的间歇性攻击造成伤害的[qMulti]%的伤害",
    sort: 9,
    data: {
      qMulti: ({ calc, attr }) => Math.min(Math.floor(calc(attr.atk) / 100) * 3, 75)
    }
  }, {
    title: "杜林1命：施放元素爆发白化法·如光流变，提升队伍中的所有其他角色造成的伤害[_qPlus]，施放元素爆发黑度法·如星阴燃，提升元素爆发造成的伤害[_q2Plus]。",
    cons: 1,
    sort: 9,
    data: {
      _qPlus: ({ calc, attr }) => calc(attr.atk) * 60 / 100,
      _q2Plus: ({ calc, attr }) => calc(attr.atk) * 150 / 100,
      qPlus: ({ calc, attr, params }) => params.Heidu ? calc(attr.atk) * 60 / 100 : 0
    }
  }, {
    title: "杜林2命：施放元素爆发后，造成火元素相关反应后，或对燃烧状态敌人造成伤害时，火元素伤害提升[dmg]%",
    cons: 2,
    data: {
      dmg: 50
    }
  }, {
    title: "杜林4命：元素爆发伤害提升[qDmg]%",
    cons: 4,
    data: {
      qDmg: 40
    }
  }, {
    title: "杜林6命：元素爆发伤害将无视敌人30%的防御力，元素爆发白化法·如光流变获得强化，命中的敌人防御力降低30%，元素爆发黑度法·如星阴燃获得强化，造成的伤害将额外无视敌人40%的防御力",
    cons: 6,
    data: {
      qIgnore: ({ params }) => 30 + (params.Heidu ? 40 : 0),
      qDef: ({ params }) => params.Bleaching ? 30 : 0
    }
  }, "vaporize"
]

export const createdBy = "其实雨很好"
