export const details = [
  {
    title: "E阳华伤害",
    talent: "e",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  }, {
    title: "E刹那之花伤害",
    dmg: ({ talent, attr, calc }, { basic }) => basic(talent.e["刹那之花伤害"] * calc(attr.def) / 100, "e")
  }, {
    title: "E刹那之花(打半血)",
    params: { half: true },
    dmg: ({ talent, attr, calc }, { basic }) => {
      let ret = talent.e["刹那之花伤害"] * calc(attr.def) / 100
      return basic(ret, "e")
    }
  }, {
    title: "Q总伤害",
    check: ({ cons }) => cons < 2,
    params: { buff: 0 },
    dmg: ({ talent }, dmg) => dmg(talent.q["爆发伤害"] + talent.q["生灭之花伤害"] * 7, "q")
  }, {
    title: "满BuffQ总伤害",
    cons: 2,
    dmg: ({ talent }, dmg) => dmg(talent.q["爆发伤害"] + talent.q["生灭之花伤害"] * 7, "q")
  }
]

export const defDmgIdx = 1
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "def,atk,cpct,cdmg"

export const buffs = [
  {
    check: ({ attr, calc }) => calc(attr.def) >= 1000,
    title: "天赋-魔女的前夜礼·白芒之书：炼成瑰银后的20秒内，基于防御力，提升[aDmg]%普通攻击、重击、下落攻击、元素战技和元素爆发造成的伤害",
    sort: 9,
    data: {
      aDmg: ({ attr, calc }) => Math.min(calc(attr.def) / 1000 * 10, 30),
      a2Dmg: ({ attr, calc }) => Math.min(calc(attr.def) / 1000 * 10, 30),
      a3Dmg: ({ attr, calc }) => Math.min(calc(attr.def) / 1000 * 10, 30),
      eDmg: ({ attr, calc }) => Math.min(calc(attr.def) / 1000 * 10, 30),
      qDmg: ({ attr, calc }) => Math.min(calc(attr.def) / 1000 * 10, 30)
    }
  }, {
    title: "天赋-白垩色的威压：刹那之花对生命值低于50%的敌人造成的伤害提高25%。场上存在瑰银时，本次伤害额外提高[ePlus]%",
    sort: 9,
    data: {
      eDmg: ({ params }) => params.half ? 25 : 0,
      ePlus: ({ params, attr, calc }) => params.half ? calc(attr.def) * 2.4 : 0
    }
  }, {
    title: "天赋-瓶中人的天慧：施放元素爆发时，使附近的队伍中角色的元素精通提高[mastery]点",
    data: {
      mastery: 125
    }
  }, {
    title: "阿贝多1命：施放元素战技后的20秒内，自身的防御力提升[defPct]%",
    cons: 1,
    data: {
      defPct: 50
    }
  }, {
    title: "阿贝多2命：4层生灭计数效果，提高元素爆发[qPlus]伤害",
    cons: 2,
    sort: 9,
    data: {
      qPlus: ({ params, attr, calc }) => params.buff === 0 ? 0 : calc(attr.def) * 1.2
    }
  }, {
    title: "阿贝多4命：处于阳华的领域中时，下落攻击造成的伤害提高[a3Dmg]%",
    cons: 4,
    data: {
      a3Dmg: 30
    }
  }, {
    title: "阿贝多6命：若处于结晶反应产生的护盾庇护下，造成的伤害提升[dmg]%。施放元素爆发时，摧毁场上所有的瑰银，使生灭之花造成的伤害提升[qPlus]",
    cons: 6,
    sort: 9,
    data: {
      dmg: 17,
      qPlus: ({ attr, calc }) => calc(attr.def) * 2.5
    }
  }
]

export const createdBy = "其实雨很好"
