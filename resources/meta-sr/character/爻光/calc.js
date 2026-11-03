import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害(主目标)",
    dmg: ({ talent }, dmg) => dmg(talent.a["目标伤害"], "a")
  }, {
    title: "普攻伤害(完整)",
    dmg: ({ talent }, dmg) => dmg(talent.a["目标伤害"] + talent.a["相邻目标伤害"] * 2, "a")
  }, {
    title: "战技欢愉度提高",
    params: { noBuff: true },
    dmg: ({ talent, attr, calc }) => {
      return {
        avg: Format.percent(talent.e["欢愉度提高"] * calc(attr.elation) / 100),
        type: "text"
      }
    }
  }, {
    title: "天赋额外欢愉伤害",
    dmg: ({ talent, params }, { elation }) => elation(talent.t["额外欢愉伤害"], params.punchlineNum)
  }, {
    title: "终结技后欢愉技伤害(全体)",
    params: { punchlineNum: 20, cons_4: true },
    dmg: ({ talent, params, cons }, { elation }) => elation(talent.j["欢愉伤害"] + (cons == 6 ? 1 : 0), cons > 0 ? 40 : params.punchlineNum)
  }, {
    title: "终结技后欢愉技伤害(随机单体)",
    params: { punchlineNum: 20, cons_4: true },
    dmg: ({ talent, params, cons }, { elation }) => elation(talent.j["欢愉伤害·随机单体"] + (cons == 6 ? 1 : 0), cons > 0 ? 40 : params.punchlineNum)
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
    title: "战技-十方光映，万法皆明：结界持续期间，我方全体目标欢愉度提高[elation]%",
    sort: 9,
    data: {
      elation: ({ talent, attr, calc, params }) => params.noBuff ? 0 : talent.e["欢愉度提高"] * calc(attr.elation)
    }
  }, {
    title: "终结技-霓裳铁羽，六爻皆吉：使我方全体目标全属性抗性穿透提高[kx]%",
    data: {
      kx: ({ talent }) => talent.q["抗性穿透提高"] * 100
    }
  }, {
    title: "欢愉技-赠君一卦，火树银花：敌方目标受到的伤害提高[enemydmg]%",
    data: {
      enemydmg: 16
    }
  }, {
    check: ({ attr, calc }) => calc(attr.speed) >= 120,
    title: "行迹-开屏有礼：使自身欢愉度提高[elation]%",
    sort: 1,
    data: {
      elation: ({ attr, calc }) => Math.min(Math.floor(calc(attr.speed) - 120) + 30, 230)
    }
  }, {
    title: "行迹-神闲意满：自身暴击伤害提高[cdmg]%",
    data: {
      cdmg: 60
    }
  }, {
    title: "爻光1命：我方全体目标造成欢愉伤害时无视目标20%防御力",
    cons: 1,
    data: {
      elationIgnore: 20
    }
  }, {
    title: "爻光2命：我方全体目标速度提高12%，欢愉度额外提高16%",
    cons: 2,
    data: {
      speedPct: 12,
      elation: 16
    }
  }, {
    title: "爻光4命：我方全体角色欢愉技造成的伤害为原伤害的150%",
    cons: 4,
    data: {
      elationMulti: ({ params }) => params.cons_4 ? 50 : 0
    }
  }, {
    title: "爻光6命：我方全体目标的欢愉伤害增笑25%。爻光欢愉技的伤害倍率提高原倍率的100%",
    cons: 6,
    data: {
      elationMerrymake: 25
    }
  }
]

export const createdBy = "其实雨很好"
