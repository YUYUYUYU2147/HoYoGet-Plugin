export const details = [
  {
    title: "E蹦蹦炸弹伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["蹦蹦炸弹伤害"], "e")
  }, {
    title: "E蹦蹦炸弹蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.e["蹦蹦炸弹伤害"], "e", "vaporize")
  }, {
    title: "E诡雷爆炸伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["诡雷伤害"], "e")
  }, {
    title: "E诡雷爆炸蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.e["诡雷伤害"], "e", "vaporize")
  }, {
    title: "E后带火花重击",
    dmg: ({ talent }, dmg) => dmg(talent.a["重击伤害"] * 150 / 100, "a2")
  }, {
    title: "E后带火花重击蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.a["重击伤害"] * 150 / 100, "a2", "vaporize")
  }, {
    title: "单次轰轰火花伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["轰轰火花伤害"], "q")
  }
]

export const defDmgIdx = 5
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,mastery"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·火花魔法：拥有3枚「轰轰勋章」时，特殊重击「嘭嘭轰击」将会造成原本150%的伤害"
  }, {
    title: "天赋-砰砰礼物：爆裂火花使重击伤害提升50%",
    data: {
      a2Dmg: 50
    }
  }, {
    title: "可莉1命：召唤火花轰击敌人后，攻击力提升[atkPct]%",
    cons: 1,
    data: {
      atkPct: 60
    }
  }, {
    title: "可莉2命：元素战技命中敌人时，使敌人的防御力降低23%",
    cons: 2,
    data: {
      enemyDef: 23
    }
  }, {
    title: "可莉6命：释放轰轰火花后获得50%火元素伤害加成",
    cons: 6,
    data: {
      dmg: 50
    }
  }, "vaporize"
]

export const createdBy = "其实雨很好"
