import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.a["技能伤害"], "a")
  }, {
    title: "战技忆灵爆伤提高",
    dmg: ({ talent, attr, calc }) => {
      return {
        avg: Format.percent(calc(attr.cdmg) * talent.e["爆伤提高"] / 100),
        type: "text"
      }
    }
  }, {
    title: "终结技长夜伤害",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.q["长夜伤害"], "q")
  }, {
    title: "忆灵技伤害(16忆质)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * (talent.me["技能伤害"] + talent.me["额外伤害"] * 4), "me")
  }, {
    title: "忆灵技伤害(28忆质)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * (talent.me["技能伤害"] + talent.me["额外伤害"] * 7), "me")
  }, {
    title: "长夜自爆伤害(16忆质 主目标)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.me2["目标伤害"] * 16, "me")
  }, {
    title: "长夜自爆伤害(16忆质 3目标完整)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * (talent.me2["目标伤害"] + talent.me2["相邻目标伤害"] * 2) * 16, "me")
  }, {
    title: "长夜自爆伤害(28忆质 主目标)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.me2["目标伤害"] * 28, "me")
  }, {
    title: "长夜自爆伤害(28忆质 3目标完整)",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * (talent.me2["目标伤害"] + talent.me2["相邻目标伤害"] * 2) * 28, "me")
  }
]

export const defDmgIdx = 8
export const defParams = { Memosprite: true }
export const mainAttr = "hp,cpct,cdmg"

export const buffs = [
  {
    title: "长夜状态：基础生命值: [_hpBase]，基础速度: 160",
    data: {
      _hpBase: ({ attr, calc }) => calc(attr.staticAttr.hp) * 0.5
    }
  }, {
    title: "战技-白昼悄然离去：使忆灵的暴击伤害提高[meCdmg]%",
    sort: 9,
    data: {
      meCdmg: ({ talent, attr, calc }) => calc(attr.cdmg) * talent.e["爆伤提高"]
    }
  }, {
    title: "终结技-晚安，全世界无眠：进入【至暗之谜】状态，期间敌方全体受到的伤害提高[enemydmg]%，长夜月和忆灵「长夜」造成的伤害提高[dmg]%",
    data: {
      enemydmg: ({ talent }) => talent.q["受到的伤害提高"] * 100,
      dmg: ({ talent }) => talent.q["伤害提高"] * 100
    }
  }, {
    title: "天赋-今夜与我同行：长夜月或忆灵长夜1次生命降低，使自身和忆灵长夜的暴击伤害提高[cdmg]%",
    data: {
      cdmg: ({ talent }) => talent.t["爆伤提高"] * 100
    }
  }, {
    title: "忆灵天赋-孤独，浮游，漆黑：长夜在场时，长夜月和长夜造成的伤害提高[dmg]%",
    data: {
      dmg: ({ talent }) => talent.mt["伤害提高"] * 100
    }
  }, {
    title: "行迹-天黑黑，月寂寂：暴击率提高[cpct]%，施放技能时，消耗生命值的5%，使暴击伤害提高[cdmg]%",
    tree: 1,
    data: {
      cpct: 35,
      cdmg: 15
    }
  }, {
    title: "行迹-天亮了，雨落了：4名记忆角色，额外使我方全体忆灵暴击伤害提高[cdmg]%",
    tree: 3,
    data: {
      cdmg: 65
    }
  }, {
    title: "长夜月1魂：4名敌方目标，我方忆灵造成的伤害为原伤害的120%",
    cons: 1,
    data: {
      meMulti: 20
    }
  }, {
    title: "长夜月2魂：暴击伤害提高[cdmg]%",
    cons: 2,
    data: {
      cdmg: 40
    }
  }, {
    title: "长夜月6魂：长夜月在场时，我方全体目标的全属性抗性穿透提高[kx]%",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "其实雨很好"
