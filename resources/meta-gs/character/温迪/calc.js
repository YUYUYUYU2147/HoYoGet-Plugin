export const details = [
  {
    title: "飓风箭一段伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["一段伤害"] * talent.a["飓风箭伤害"] / 100, "a")
  }, {
    title: "E点按伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["点按伤害"], "e")
  }, {
    title: "Q单段伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["持续伤害"], "q")
  }, {
    title: "Q含转化单段",
    params: { q: true },
    dmg: ({ talent }, dmg) => {
      let basic = dmg(talent.q["持续伤害"], "q")
      // 暂时以物伤近似计算
      let fj = dmg(talent.q["附加元素伤害"], "q", "phy")
      return {
        dmg: basic.dmg + fj.dmg,
        avg: basic.avg + fj.avg
      }
    }
  }, {
    title: "扩散反应伤害",
    // eslint-disable-next-line no-empty-pattern
    dmg: ({}, { reaction }) => reaction("swirl")
  }
]

export const defDmgIdx = 0
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,mastery"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·颂时风若：触发扩散反应后，造成的伤害提升[dmg]%， 并使元素爆发造成原本135%的伤害",
    data: {
      dmg: 50,
      qMulti: 35
    }
  }, {
    title: "温迪1命：飓风箭会额外发射两枚能追踪敌人的箭矢，分别造成原本20%的伤害",
    cons: 1
  }, {
    title: "温迪2命：元素战技降低[kx]%风抗与物抗，使下次元素战技造成原本300%伤害",
    cons: 2,
    data: {
      kx: 24
    }
  }, {
    title: "温迪4命：温迪获取元素晶球或元素微粒后，获得25%风元素伤害加成",
    cons: 4,
    data: {
      dmg: 25
    }
  }, {
    check: ({ params }) => params.q,
    title: "温迪6命：受风神之诗伤害的敌人，风元素抗性降低[kx]%，对这些敌人造成的伤害，获得[cdmg]%暴击伤害加成",
    cons: 6,
    data: {
      kx: 20,
      cdmg: 100
    }
  }, "swirl"
]

export const createdBy = "其实雨很好"
