export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "强化普攻生命回复",
    dmg: ({ talent, calc, attr }, { heal }) => {
      const a = calc(attr.def) * talent.a2["回复·防御百分比"]
      const b = calc(attr.def) * talent.a2["额外回复·防御百分比"]
      return heal(a + b + talent.a2["回复·固定生命值"] + talent.a2["额外回复·固定生命值"])
    }
  }, {
    title: "战技生命回复",
    dmg: ({ talent, calc, attr }, { heal }) => {
      const a = calc(attr.def) * talent.e["回复·防御百分比"]
      const b = calc(attr.def) * talent.e["额外回复·防御百分比"]
      return heal(a + b + talent.e["回复·固定生命值"] + talent.e["额外回复·固定生命值"])
    }
  }, {
    title: "强化普攻伤害",
    params: { hy: true },
    dmg: ({ talent, cons }, dmg) => {
      const normal = dmg(talent.a2["强化普攻伤害"], "a2")
      const elation = dmg.elation(talent.a2["欢愉伤害"] + talent.j["额外欢愉伤害·一位角色"] + talent.q["欢愉伤害"] + (cons >= 4 ? 1 : 0) + (cons === 6 ? 2.4 : 0), 5)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }
]

export const defParams = { punchlineNum: 2 }
export const defDmgIdx = 1
export const mainAttr = "def,speed,heal"

export const buffs = [
  {
    title: "当前笑点：[_punchlineNum]",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum
    }
  }, {
    check: ({ attr }) => attr.def >= 2400,
    title: "行迹-洞察万物：欢愉度提高[elation]%, 治疗量加成提高[heal]%。",
    tree: 1,
    sort: 9,
    data: {
      elation: ({ attr, calc }) => 32 + Math.floor(Math.min(calc(attr.def) - 2400, 3600) / 100) * 3,
      heal: ({ attr, calc }) => calc(attr.elation) * 0.2
    }
  }, {
    check: ({ params }) => params.hy === true,
    title: "行迹-感知容差：持有【好活当赏】时，我方全体目标的效果抵抗提高[effDef]%",
    tree: 2,
    data: {
      effDef: 50
    }
  }, {
    title: "真珠1命：我方全体欢愉度提高[elation]%",
    cons: 1,
    data: {
      elation: 60
    }
  }, {
    title: "真珠2命：我方全体目标的欢愉伤害增笑[elationMerrymake]%",
    cons: 2,
    data: {
      elationMerrymake: 15
    }
  }, {
    title: "真珠4命：欢愉技使我方全体提供的欢愉伤害倍率提高100%",
    cons: 4
  }, {
    title: "真珠6命：【深度学习】时，我方全体目标的全属性抗性穿透提高[kx]%，真珠的强化普攻额外造成240%的冰属性欢愉伤害。",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "rainbowwarmth"
