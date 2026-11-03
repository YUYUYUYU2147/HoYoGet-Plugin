export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "战技伤害",
    params: { punchlineNum: 5 },
    dmg: ({ talent, params }, dmg) => {
      const normal = dmg(talent.e["技能伤害"], "e")
      const elation = dmg.elation(talent.t["欢愉伤害"], params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "终结技伤害",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, dmg) => {
      const normal = dmg(talent.q["技能伤害"], "q")
      const elation = dmg.elation(talent.t["欢愉伤害·额外"], params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "【举杯！敬炽烈一夏】伤害",
    params: { q: true, punchlineNum: 11 },
    dmg: ({ talent, params }, { elation }) => elation(talent.j["欢愉伤害"] + talent.j["欢愉伤害·随机单体"] * 10, params.punchlineNum)
  }, {
    title: "20笑点【举杯！敬炽烈一夏】伤害",
    params: { q: true, punchlineNum: 20 },
    dmg: ({ talent, params }, { elation }) => elation(talent.j["欢愉伤害"] + talent.j["欢愉伤害·随机单体"] * 10, params.punchlineNum)
  }, {
    title: "满热意【All in！敬炽烈一夏】伤害",
    params: { q: true, punchlineNum: 11 },
    dmg: ({ talent, params, cons }, { elation }) => elation(talent.j2["欢愉伤害"] + talent.j2["欢愉伤害·随机单体"] * 10 + (cons > 2 ? 50 : 30) * talent.j2["欢愉伤害·额外"], params.punchlineNum)
  }
]

export const defParams = { punchlineNum: 5 }
export const defDmgIdx = 4
export const mainAttr = "atk,cpct,cdmg,speed"

export const buffs = [
  {
    title: "当前笑点：[_punchlineNum]",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum
    }
  }, {
    check: ({ params }) => params.q,
    title: "终结技-胜局，凌越飓浪之上：速度提高[speedPct]%",
    data: {
      speedPct: ({ talent }) => talent.q["速度提高"] * 100
    }
  }, {
    check: ({ attr, calc }) => calc(attr.speed) >= 140,
    title: "行迹-极乐派对：欢愉度提高[elation]%",
    tree: 1,
    data: {
      elation: ({ attr, calc }) => Math.min(Math.max(calc(attr.speed) - 140, 0) + 30, 230)
    }
  }, {
    title: "行迹-旧梦淘金：暴击伤害提高[cdmg]%",
    tree: 3,
    data: {
      cdmg: 96
    }
  }, {
    title: "砂金·戏浪1命：全属性抗性穿透提高[kx]%。",
    cons: 1,
    data: {
      kx: 24
    }
  }, {
    title: "砂金•戏浪4命：砂金•戏浪施放战技时，使我方全体造成的伤害无视敌方目标[ignore]%的防御力，",
    cons: 4,
    data: {
      ignore: 18
    }
  }, {
    title: "砂金·戏浪6命：砂金·戏浪造成的欢愉伤害增笑[elationMerrymake]%",
    cons: 6,
    data: {
      elationMerrymake: 25
    }
  }
]

export const createdBy = "rainbowwarmth"
