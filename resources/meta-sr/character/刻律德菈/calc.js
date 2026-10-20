import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "战技暴伤提高",
    dmg: ({ talent }) => {
      return {
        avg: Format.percent(talent.e["暴伤提高"]),
        type: "text"
      }
    }
  }, {
    title: "战技抗性穿透提高",
    dmg: ({ talent }) => {
      return {
        avg: Format.percent(talent.e["抗性穿透提高"]),
        type: "text"
      }
    }
  }, {
    title: "终结技伤害",
    dmg: ({ talent, cons }, dmg) => dmg(talent.q["技能伤害"] + (cons >= 4 ? 2.4 : 0), "q")
  }, {
    title: "天赋攻击力提高",
    dmg: ({ attr, calc, talent }) => {
      return {
        avg: Format.comma(calc(attr.atk) * talent.t["攻击力提高"], 1),
        type: "text"
      }
    }
  }, {
    title: "天赋附加伤害",
    params: { q: true },
    dmg: ({ talent, cons }, dmg) => dmg(talent.t["附加伤害"] + (cons >= 6 ? 3 : 0), "t")
  }
]

export const defDmgIdx = 4
export const mainAttr = "atk,cpct,cdmg"

export const buffs = [
  {
    check: ({ attr, calc }) => calc(attr.atk) >= 2100,
    title: "行迹-来者：[_atk]点攻击力使自身暴击伤害提高[cdmg]%",
    sort: 9,
    tree: 1,
    data: {
      _atk: ({ attr, calc }) => calc(attr.atk),
      cdmg: ({ attr, calc }) => Math.min(Math.floor((calc(attr.atk) - 2000) / 100) * 18, 360)
    }
  }, {
    title: "行迹-见者：暴击率提高[cpct]%。",
    tree: 2,
    data: {
      cpct: 100
    }
  }, {
    title: "行迹-征服者：施放战技时，使自身和持有【军功】的队友速度提高[speed]点",
    tree: 3,
    data: {
      speed: 20
    }
  }, {
    title: "刻律德菈2魂：场上存在持有【军功】的队友时，刻律德菈造成的伤害提高[dmg]%",
    cons: 2,
    data: {
      dmg: 160
    }
  }, {
    title: "刻律德菈4魂：终结技的伤害倍率提高240%",
    cons: 4
  }, {
    title: "刻律德菈6魂：【军功】触发的附加伤害倍率提高300%，场上存在持有【军功】的队友时，刻律德菈全属性抗性穿透提高[kx]%",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "其实雨很好"
