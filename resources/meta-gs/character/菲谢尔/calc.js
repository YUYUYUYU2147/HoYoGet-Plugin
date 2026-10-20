export const details = [
  {
    title: "E奥兹召唤伤害",
    params: { e: true },
    dmg: ({ talent, cons }, dmg) => dmg(talent.e["召唤伤害"], "e")
  }, {
    title: "E奥兹攻击伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["奥兹攻击伤害"], "e")
  }, {
    title: "E奥兹攻击激化",
    dmg: ({ talent }, dmg) => dmg(talent.e["奥兹攻击伤害"], "e", "aggravate")
  }, {
    title: "Q至夜幻现伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["落雷伤害"], "q")
  }, {
    title: "Q至夜幻现激化",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["落雷伤害"], "q", "aggravate")
  }
]

export const defDmgIdx = 2
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,mastery"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·宵世幻奏：奥兹在场时，触发超载反应后，攻击力提升[atkPct]%",
    data: {
      atkPct: 22.5
    }
  }, {
    title: "皇女2命：施放元素战技时，能额外造成200%攻击力的伤害",
    cons: 2,
    data: {
      ePct: ({ params }) => params.e ? 200 : 0
    }
  }, {
    title: "皇女4命：施元素爆发时，能额外造成200%攻击力的伤害",
    cons: 4,
    data: {
      qPct: ({ params }) => params.q ? 222 : 0
    }
  }, {
    title: "皇女6命：奥兹进行协同攻击后，魔女的前夜礼·宵世幻奏中提升攻击力的效果提高100%",
    cons: 6,
    data: {
      atkPct: ({ params }) => params.e ? 0 : 100
    }
  }, "aggravate"
]

export const createdBy = "其实雨很好"
