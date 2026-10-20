import { Format } from "#miao"

export const details = [
  {
    title: "E技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  }, {
    title: "Q技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q")
  }, {
    title: "Q圣眷护盾吸收量",
    dmg: ({ attr, calc, talent }, { shield }) => shield(talent.q["圣眷护盾吸收量2"][0] / 100 * calc(attr.hp) + talent.q["圣眷护盾吸收量2"][1])
  }, {
    title: "天赋提高攻击速度",
    dmg: ({ attr, calc }) => {
      return {
        avg: Format.percent(Math.min(Math.floor(calc(attr.hp) / 1000) * 0.5, 20) / 100),
        type: "text"
      }
    }
  }
]

export const defDmgIdx = 2
export const mainAttr = "hp,atk,cpct,cdmg"

export const buffs = [
  {
    title: "塔利雅2命：护盾强效提升[shield]%",
    cons: 2,
    data: {
      shield: 25
    }
  }
]
