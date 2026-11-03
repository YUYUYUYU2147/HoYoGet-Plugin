import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "战技伤害(单目标)",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  }, {
    title: "战技超击破伤害",
    // eslint-disable-next-line no-empty-pattern
    dmg: ({}, { reaction }) => {
      return {
        avg: reaction("superBreak").avg / 0.9 * 1.5
      }
    }
  }, {
    title: "终结技伤害",
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q")
  }, {
    title: "天赋单次追击伤害",
    dmg: ({ talent }, dmg) => dmg(talent.t["追击·技能伤害"], "t")
  }, {
    title: "天赋单次追击超击破伤害",
    dmg: ({ talent, cons }, { reaction }) => {
      const superBreakPct = talent.t["追击·超击破伤害"] + (cons > 0 ? 0.4 : 0)
      return {
        avg: reaction("superBreak").avg / 0.9 * 1.5 * superBreakPct
      }
    }
  }, {
    title: "行迹提高队友击破特攻",
    dmg: ({ attr, calc }) => {
      return {
        avg: Format.comma(calc(attr.stance) * 0.24 + 50) + "%",
        type: "text"
      }
    }
  }
]

export const defDmgIdx = 6
export const mainAttr = "atk,stance"

export const buffs = [
  {
    title: "战技-舔舐…背叛伸出火舌：我方全体的弱点击破效率提高50%"
  }, {
    title: "终结技-沉溺…飞灰邀入墓床：【败谢】状态下，敌方目标防御力降低[enemyDef]%",
    data: {
      enemyDef: ({ talent }) => talent.q["防御力降低"] * 100
    }
  }, {
    title: "行迹-弃旧，恋新：我方目标为敌方目标添加弱点时，速度提高[speedPct]%",
    tree: 3,
    data: {
      speedPct: 30
    }
  }, {
    title: "大丽花1魂：天赋为【共舞者】提供的超击破伤害倍率额外提高40%",
    cons: 1
  }, {
    title: "大丽花2魂：敌方全体全属性抗性降低20%",
    cons: 2,
    data: {
      kx: 20
    }
  }, {
    title: "大丽花4魂：天赋的追加攻击击中时使目标受到的伤害提高[enemydmg]%",
    cons: 4,
    data: {
      enemydmg: 12
    }
  }, {
    title: "大丽花6魂：【共舞者】的击破特攻提高[stance]%",
    cons: 6,
    data: {
      stance: 150
    }
  }
]

export const createdBy = "其实雨很好"
