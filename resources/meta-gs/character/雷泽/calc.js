export const details = [
  {
    title: "普攻首段伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["一段伤害"], "a", "phy")
  }, {
    title: "E点按技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["点按技能伤害"], "e")
  }, {
    title: "E长按技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["长按技能伤害"], "e")
  }, {
    title: "Q释放伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["爆发伤害"], "q")
  }, {
    title: "Q协同攻击首段",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["狼魂伤害"] * talent.a["一段伤害"] / 100, "q")
  }
]

export const defDmgIdx = 4
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,dmg"

export const buffs = [
  {
    title: "天赋-魔女的前夜礼·苍雷奔涌：元素爆发雷狼造成的伤害提升，提升值相当于雷泽的攻击力的70%",
    data: {
      qPct: ({ params }) => params.q ? 70 : 0
    }
  }, {
    title: "雷泽1命：获得元素球后8秒伤害提高[dmg]%",
    cons: 1,
    data: {
      dmg: 10,
      phy: 10
    }
  }, {
    title: "雷泽2命：攻击生命值低于30%的敌人暴击率提高[cpct]%",
    cons: 2,
    data: {
      cpct: 10
    }
  }, {
    title: "雷泽4命：元素战技点按降低敌人防御力[enemyDef]%",
    cons: 4,
    data: {
      enemyDef: 15
    }
  }, {
    title: "雷泽6命：消耗雷之印后，暴击率提升[cpct]%，暴击伤害提升[cdmg]%",
    cons: 6,
    data: {
      cpct: 10,
      cdmg: 50
    }
  }
]

export const createdBy = "其实雨很好"
