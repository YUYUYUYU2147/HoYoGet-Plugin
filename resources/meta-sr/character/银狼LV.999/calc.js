import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "强普伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a2["技能伤害"], "a2")
  }, {
    title: "强普最后一击伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a2["最后一击伤害"], "a2")
  }, {
    title: "战技伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  }, {
    title: "终结技欢愉伤害",
    dmg: ({ talent, params }, { elation }) => elation(talent.q["欢愉伤害"], params.punchlineNum)
  }, {
    title: "天赋爆率提高(60隐藏分)",
    params: { noBuff: true },
    dmg: ({ talent, attr, calc }) => {
      let maxCpct = 100 - calc(attr.cpct)
      if (maxCpct <= 0) return { avg: "已满暴击率", type: "text" }
      let maxNum = Math.ceil(maxCpct / (talent.t["暴击率提高"] * 100))
      return {
        avg: Format.percent(talent.t["暴击率提高"] * Math.min(maxNum, 60)),
        type: "text"
      }
    }
  }, {
    title: "天赋爆伤提高(60隐藏分)",
    params: { noBuff: true },
    dmg: ({ talent, attr, calc }) => {
      let maxCpct = 100 - calc(attr.cpct)
      if (maxCpct <= 0) maxCpct = 0
      let maxNum = 60 - Math.ceil(maxCpct / (talent.t["暴击率提高"] * 100))
      return {
        avg: Format.percent(talent.t["暴击率提高"] * Math.min((maxNum > 0 ? maxNum : 0), 60)),
        type: "text"
      }
    }
  }, {
    title: "天赋欢愉技伤害",
    dmg: ({ talent, params, cons }, { elation }) => elation(talent.t["欢愉伤害"], params.punchlineNum)
  }, {
    title: "欢愉技伤害",
    dmg: ({ talent, params, cons }, { elation }) => elation(talent.j2["欢愉伤害"], (cons > 3 ? 6 : 1) * params.punchlineNum, { dynamicMerrymake: cons === 6 ? 50 : 0 })
  }
]

export const defParams = { punchlineNum: 7 }
export const defDmgIdx = 4
export const mainAttr = "atk,cpct,cdmg,speed"

export const buffs = [
  {
    title: "当前笑点：[_punchlineNum]",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum
    }
  }, {
    title: "天赋-有我在，把把都是顺风局：使暴击率提高[cpct]%，使暴击伤害提高[cdmg]%",
    tree: 1,
    sort: 9,
    data: {
      cdmg: ({ talent, attr, calc, params }) => {
        if (params.noBuff) return 0
        let maxCpct = 100 - calc(attr.cpct)
        if (maxCpct <= 0) maxCpct = 0
        let maxNum = 60 - Math.ceil(maxCpct / (talent.t["暴击率提高"] * 100))
        return talent.t["暴击率提高"] * Math.min((maxNum > 0 ? maxNum : 0), 60) * 100
      },
      cpct: ({ talent, attr, calc, params }) => {
        if (params.noBuff) return 0
        let maxCpct = 100 - calc(attr.cpct)
        if (maxCpct <= 0) return 0
        let maxNum = Math.ceil(maxCpct / (talent.t["暴击率提高"] * 100))
        return talent.t["暴击率提高"] * Math.min(maxNum, 60) * 100
      }
    }
  }, {
    check: ({ attr, calc }) => calc(attr.speed) >= 160,
    title: "行迹-假结局速通攻略：使自身欢愉度提高[elation]%",
    tree: 1,
    sort: 9,
    data: {
      elation: ({ attr, calc }) => Math.min(Math.floor(calc(attr.speed) - 160) + 50, 250)
    }
  }, {
    title: "狼尊1命：结界中的敌方目标受到的伤害提高[enemydmg]%",
    cons: 1,
    data: {
      enemydmg: 20
    }
  }, {
    title: "狼尊4命：【崩坏级伤害演示】造成的欢愉伤害额外计入5倍的笑点",
    cons: 4
  }, {
    title: "狼尊6命：强化普攻期间造成的欢愉伤害增笑50%。基础抗性为0则抗性降低20%",
    cons: 6,
    data: {
      elationMerrymake: 50,
      kx: 20
    }
  }
]

export const createdBy = "其实雨很好"
