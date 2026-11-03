export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "8次强化战技后强普伤害(主目标)",
    dmg: ({ talent }, dmg) => dmg(talent.a2["目标伤害"] + talent.e2["倍率提高"] * 9, "a2")
  }, {
    title: "8次强化战技后强普伤害(完整)",
    dmg: ({ talent }, dmg) => dmg(talent.a2["目标伤害"] + talent.e2["倍率提高"] * 9 + (talent.a2["相邻目标伤害"] + talent.e2["相邻目标倍率提高"] * 9) * 2, "a2")
  }, {
    title: "强普欢愉伤害(主目标)",
    dmg: ({ talent, params }, { elation }) => elation(talent.t["欢愉伤害·目标"], params.punchlineNum)
  }, {
    title: "强普欢愉伤害(完整)",
    dmg: ({ talent, params }, { elation }) => elation(talent.t["欢愉伤害·目标"] + talent.t["欢愉伤害·相邻目标"] * 2, params.punchlineNum)
  }, {
    title: "强普欢愉伤害(额外目标)",
    dmg: ({ talent, params }, { elation }) => elation(talent.t["欢愉伤害·随机目标"], params.punchlineNum)
  }, {
    title: "终结技伤害",
    dmg: ({ talent, attr, calc }, dmg) => dmg(calc(attr.elation) * 0.6 + talent.q["技能伤害"], "q")
  }, {
    title: "终结技欢愉伤害",
    params: { punchlineNum: 14 },
    dmg: ({ talent, params }, { elation }) => elation(talent.t["欢愉伤害·全体目标"], params.punchlineNum)
  }, {
    title: "欢愉技伤害(全体)",
    params: { punchlineNum: 20 },
    dmg: ({ talent, params }, { elation }) => elation(talent.j["欢愉伤害"], params.punchlineNum)
  }, {
    title: "欢愉技伤害(随机单体)",
    params: { punchlineNum: 20 },
    dmg: ({ talent, params }, { elation }) => elation(talent.j["欢愉伤害·随机单体"], params.punchlineNum)
  }
]

export const defParams = { punchlineNum: 12 }
export const defDmgIdx = 4
export const mainAttr = "atk,cpct,cdmg"

export const buffs = [
  {
    title: "当前笑点：[_punchlineNum]",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum
    }
  }, {
    check: ({ attr, calc }) => calc(attr.atk) >= 2000,
    title: "行迹-甜蜜！笑点签售会：使自身欢愉度提高[elation]%",
    sort: 1,
    data: {
      elation: ({ attr, calc }) => Math.min(Math.floor((calc(attr.atk) - 2000) / 100) * 5, 80)
    }
  }, {
    title: "行迹-沸腾！真伪调色盘：[_punchlineNum]个笑点，使我方全体暴击伤害提高[cdmg]%",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum,
      cdmg: ({ params }) => Math.min(params.punchlineNum * 8, 80)
    }
  }, {
    title: "火花1命：[_punchlineNum]个笑点，使我方全体全属性抗性穿透提高[kx]%",
    cons: 1,
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum,
      kx: ({ params }) => Math.min(params.punchlineNum, 15)
    }
  }, {
    title: "火花2命：消耗4个【爆点】使自身暴击伤害提高40%",
    cons: 2,
    data: {
      cdmg: 40
    }
  }, {
    title: "火花4命：施放终结技时，自身欢愉度提高[elation]%",
    cons: 4,
    data: {
      elation: 36
    }
  }, {
    title: "火花6命：全属性抗性穿透提高[kx]%",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "其实雨很好"
