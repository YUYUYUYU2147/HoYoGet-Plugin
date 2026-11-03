export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "终结技伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q")
  }, {
    title: "战技/终结技护盾量",
    dmg: ({ talent, attr, calc }, { shield }) => shield(talent.q["攻击百分比"] * calc(attr.atk) + talent.q["固定值"])
  }, {
    title: "龙灵追击伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["龙灵追击伤害"], "q")
  }, {
    title: "附加伤害(腾荒为同袍)",
    dmg: ({ talent, cons }, dmg) => dmg(talent.q["附加伤害"] * (cons > 1 ? 2 : 1), "q")
  }, {
    title: "天赋龙灵行动护盾量",
    dmg: ({ talent, attr, calc }, { shield }) => shield(talent.t["攻击百分比"] * calc(attr.atk) + talent.t["固定值"])
  }, {
    tree: 3,
    title: "龙灵行动额外护盾量",
    dmg: ({ attr, calc }, { shield }) => shield(calc(attr.atk) * 0.05 + 100)
  }, {
    tree: 3,
    title: "龙灵行动额外附加伤害",
    dmg: ({ cons }, dmg) => dmg(0.4 * (cons > 1 ? 2 : 1), "q")
  }, {
    title: "护盾量上限",
    dmg: ({ talent, attr, calc }, { shield }) => {
      let { avg } = shield(talent.e["攻击百分比"] * calc(attr.atk) + talent.e["固定值"])
      return { avg: avg * 3 }
    }
  }, {
    cons: 6,
    title: "6命终结技附加伤害",
    // eslint-disable-next-line no-empty-pattern
    dmg: ({}, dmg) => dmg(3.3, "q")
  }
]

export const mainAttr = "atk,cpct,cdmg"
export const defDmgIdx = 2

export const buffs = [
  {
    title: "Tip：以下均为丹恒•腾荒成为【同袍】时触发的效果"
  }, {
    title: "行迹-神秀：成为【同袍】的目标攻击力提高[atkPct]%",
    tree: 2,
    sort: 9,
    data: {
      atkPct: 15
    }
  }, {
    title: "丹恒•腾荒1命：使【同袍】全属性抗性穿透提高[kx]%",
    cons: 1,
    data: {
      kx: 18
    }
  }, {
    title: "丹恒•腾荒2命：【同袍】造成的附加伤害为原伤害的200%",
    cons: 2
  }, {
    title: "丹恒•腾荒6命：存在【同袍】时，使敌方全体受到的伤害提高[enemydmg]%，【同袍】造成伤害时，无视敌方目标[ignore]%的防御力",
    cons: 6,
    data: {
      enemydmg: 20,
      ignore: 12
    }
  }
]

export const createdBy = "其实雨很好"
