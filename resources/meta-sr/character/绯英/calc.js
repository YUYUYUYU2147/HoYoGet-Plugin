export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  }, {
    title: "千活战技伤害(单目标)",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, dmg) => {
      let normal = dmg(talent.e["目标伤害"] + talent.e["相邻目标伤害"], "e")
      let elation = dmg.elation(talent.t["欢愉伤害·战技"], params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "千活战技伤害(三目标)",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, dmg) => {
      let normal = dmg(talent.e["目标伤害"] + talent.e["相邻目标伤害"] * 2, "e")
      let elation = dmg.elation(talent.t["欢愉伤害·战技"] * 3, params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "千活终结技伤害(单目标)",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, dmg) => {
      let normal = dmg(talent.q["全体伤害"] + 9 * talent.q["随机伤害"], "q")
      let elation = dmg.elation(talent.t["欢愉伤害·终结技全体"] + 9 * talent.t["欢愉伤害·终结技随机"], params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "千活终结技伤害(三目标)",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, dmg) => {
      let normal = dmg(talent.q["全体伤害"] * 3 + 6 * talent.q["随机伤害"], "q")
      let elation = dmg.elation(talent.t["欢愉伤害·终结技全体"] * 3 + 6 * talent.t["欢愉伤害·终结技随机"], params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }, {
    title: "欢愉技伤害",
    params: { punchlineNum: 11 },
    dmg: ({ talent, params }, { elation }) => elation(talent.j["欢愉伤害"], params.punchlineNum)
  }, {
    title: "【狐狸老师】追加伤害",
    params: { punchlineNum: 11 },
    dmg: ({ talent, cons, params }, dmg) => {
      let normal = dmg(talent.t["追加攻击伤害"], "t")
      let hyls = cons >= 1 ? talent.t["欢愉伤害·狐狸老师"] + talent.j["欢愉伤害"] : talent.t["欢愉伤害·狐狸老师"]
      let elation = dmg.elation(hyls, params.punchlineNum)
      return {
        dmg: normal.dmg + elation.dmg,
        avg: normal.avg + elation.avg
      }
    }
  }
]

export const defParams = { punchlineNum: 1 }
export const defDmgIdx = 4
export const mainAttr = "atk,cpct,cdmg,speed"

export const buffs = [
  {
    title: "当前笑点：[_punchlineNum]",
    data: {
      _punchlineNum: ({ params }) => params.punchlineNum
    }
  }, {
    title: "天赋-青春•韶华无限：绯英获得[elation]%欢愉度",
    data: {
      elation: ({ attr }) => attr.cdmg * 0.2
    }
  }, {
    title: "行迹-瞰众乐：暴击率提高[cpct]%。",
    tree: 1,
    data: {
      cpct: 30
    }
  }, {
    title: "行迹-行裁断：【狐狸老师】额外施加易伤，使其受到的伤害提高[enemydmg]%",
    tree: 2,
    data: {
      enemydmg: 12
    }
  }, {
    title: "绯英1命：全属性抗性穿透提高[kx]%，【狐狸老师】施放攻击后会额外触发一次欢愉技。",
    cons: 1,
    data: {
      kx: 20
    }
  }, {
    title: "绯英2命：暴击伤害提高[cdmg]%。",
    cons: 2,
    data: {
      cdmg: 36
    }
  }, {
    title: "绯英4命：绯英造成的伤害无视敌方目标[ignore]%的防御力。",
    cons: 4,
    data: {
      ignore: 15
    }
  }, {
    title: "绯英6命：绯英造成的欢愉伤害增笑15%，1000点【好活当赏】额外增笑20%",
    cons: 6,
    data: {
      elationMerrymake: 35

    }
  }
]

export const createdBy = "rainbowwarmth"
