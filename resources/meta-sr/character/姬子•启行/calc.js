export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  },
  {
    title: "满【源能】裁决终结技伤害",
    params: { e: true, cj: true },
    dmg: ({ talent, cons, tree }, dmg) => {
      let yn = cons === 6 ? 6 : 3
      let c6 = cons === 6 ? 1.6 : 0
      let c2 = cons >= 2 ? 1.3 : 1
      return {
        dmg: (dmg(talent.q["技能伤害"] + talent.q["其他目标伤害"] + talent.q["随机单体伤害"] * 3, "q").dmg + dmg((talent.q2["超频粒子光束·全体伤害"] + talent.q2["轨道歼灭脉冲·全体伤害"] + (talent.q2["轨道歼灭脉冲·随机伤害"] + (tree >= 3 ? 0.3 : 0))) * yn, "q2").dmg) * c2 + c6,
        avg: (dmg(talent.q["技能伤害"] + talent.q["其他目标伤害"] + talent.q["随机单体伤害"] * 3, "q").avg + dmg((talent.q2["超频粒子光束·全体伤害"] + talent.q2["轨道歼灭脉冲·全体伤害"] + (talent.q2["轨道歼灭脉冲·随机伤害"] + (tree >= 3 ? 0.3 : 0))) * yn, "q2").avg) * c2 + c6
      }
    }
  },
  {
    title: "满【源能】歼破终结技伤害",
    params: { e: true, qp: true },
    dmg: ({ talent, cons, tree }, dmg) => {
      let yn = cons === 6 ? 6 : 3
      let c6 = cons === 6 ? 1.6 : 0
      let c2 = cons >= 2 ? 1.3 : 1
      return {
        dmg: (dmg(talent.q["技能伤害"] + talent.q["其他目标伤害"] + talent.q["随机单体伤害"] * 3, "q").dmg + dmg((talent.q2["超频粒子光束·全体伤害"] + talent.q2["轨道歼灭脉冲·全体伤害"] + (talent.q2["轨道歼灭脉冲·随机伤害"] + (tree >= 3 ? 0.3 : 0))) * yn, "q2").dmg) * c2 + c6,
        avg: (dmg(talent.q["技能伤害"] + talent.q["其他目标伤害"] + talent.q["随机单体伤害"] * 3, "q").avg + dmg((talent.q2["超频粒子光束·全体伤害"] + talent.q2["轨道歼灭脉冲·全体伤害"] + (talent.q2["轨道歼灭脉冲·随机伤害"] + (tree >= 3 ? 0.3 : 0))) * yn, "q2").avg) * c2 + c6
      }
    }
  },
  {
    title: "裁决助战技伤害",
    params: { e: true, cj: true },
    dmg: ({ talent, cons }, dmg) => {
      let n1 = cons >= 1 ? 4 : 3; let n2 = cons >= 1 ? 5 : 4
      let tas = talent.as["技能伤害"] + talent.as["随机单体伤害"] * n1 + talent.as["全体伤害"] + talent.as["随机敌方伤害"] * n2
      if (cons >= 2) tas *= 1.3
      return dmg(tas, "as")
    }
  },
  {
    title: "歼破助战技伤害",
    params: { e: true, qp: true },
    dmg: ({ talent, cons }, dmg) => {
      let n1 = cons >= 1 ? 4 : 3; let n2 = cons >= 1 ? 5 : 4
      let tas = talent.as["技能伤害"] + talent.as["随机单体伤害"] * n1 + talent.as["全体伤害"] + talent.as["随机敌方伤害"] * n2
      if (cons >= 2) tas *= 1.3
      return dmg(tas, "as")
    }
  }
]

export const mainAttr = "atk,cpct,cdmg"
export const defDmgIdx = 3

export const buffs = [
  {
    title: "战技-升起领航的烽火：我方造成的全体伤害提高[_dmg]%",
    data: {
      _dmg: ({ talent }) => talent.e["全体伤害提高"] * 100,
      dmg: ({ talent, params }) => params.e ? talent.e["全体伤害提高"] * 100 : 0
    }
  },
  {
    title: "天赋-共赴灼热的远征：全属性抗性穿透提高[kx]%, 暴击伤害提高[cdmg]%",
    data: {
      kx: ({ talent }) => talent.t["全属性抗穿提高"] * 100,
      cdmg: ({ talent }) => talent.t["暴击伤害提高"] * 100
    }
  },
  {
    title: "助战技-裁决：造成伤害提高[_dmg]%，终结技伤害提高[_qDmg]%",
    data: {
      _dmg: ({ talent }) => talent.as1["伤害提高"] * 100,
      _qDmg: ({ talent }) => talent.as1["终结技伤害提高"] * 100,
      dmg: ({ talent, params }) => params.cj ? talent.as1["伤害提高"] * 100 : 0,
      qDmg: ({ talent, params }) => params.cj ? talent.as1["终结技伤害提高"] * 100 : 0
    }
  },
  {
    title: "助战技-歼破：暴击伤害提高[_cdmg]%, 战技暴击伤害提高[_ecdmg]%",
    data: {
      _cdmg: ({ talent }) => talent.as2["全体暴击伤害提高"] * 100,
      _ecdmg: ({ talent }) => talent.as2["战技暴击伤害提高"] * 100,
      cdmg: ({ talent, params }) => params.qp ? talent.as2["全体暴击伤害提高"] * 100 + (params?.e ? talent.as2["战技暴击伤害提高"] * 100 : 0) : 0
    }
  },
  {
    title: "行迹-银轨在旷古中静默：3点源能下【轨道歼灭脉冲】的随机单体倍率提高30%",
    tree: 3
  },
  {
    title: "姬子·启行1魂：助战技造成的额外伤害的效果次数增加1次",
    cons: 1
  },
  {
    title: "姬子·启行2魂：终结技和助战技造成伤害为原伤害的130%",
    cons: 2
  },
  {
    title: "姬子·启行4魂：全属性抗性穿透额外提高[kx]%",
    cons: 4,
    data: {
      kx: 10
    }
  },
  {
    title: "姬子·启行6魂：火属性抗性穿透提高[kx]%，助战技能伤害提高[asDmg]%，使用【轨道歼灭脉冲】时额外造成一次160%攻击力的伤害",
    cons: 6,
    data: {
      kx: 20,
      asDmg: 75
    }
  }
]

export const createdBy = "rainbowwarmth"
