export const details = [
  {
    title: "E技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  }, {
    title: "Q每跳基础伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["持续伤害"], "q")
  }, {
    title: "Q每跳附加伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["附加元素伤害"], "q")
  }, {
    title: "为队友提升精通",
    dmg: ({ calc, attr }) => {
      return {
        avg: calc(attr.mastery) * 0.2 + 50 + (attr.mastery.inc || 0)
      }
    }
  }, {
    title: "扩散反应伤害",
    dmg: ({}, { reaction }) => reaction("swirl")
  }
]

export const defDmgIdx = 3
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,mastery"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·七循之理：释放元素战技与元素爆发后，普通攻击、重击、下落攻击、元素战技和元素爆发造成的伤害提升[dmg]%",
    data: {
      dmg: 5.71428 + 7.14285
    }
  }, {
    title: "砂糖6命：元素爆发发生了元素转化，获得28.57142%元素伤害加成",
    data: {
      dmg: ({ params }) => (params.q ? 20 : 0) + 8.57142
    }
  }, "swirl"
]

export const createdBy = "其实雨很好"
