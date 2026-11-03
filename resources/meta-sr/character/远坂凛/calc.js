export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  },
  {
    title: "战技伤害",
    params: { e: true },
    dmg: ({ talent, cons }, dmg) => {
      let val = talent.e["技能伤害"]
      if (cons >= 2) val *= 1.3
      return dmg(val, "e")
    }
  },
  {
    title: "满宝石强化战技伤害",
    params: { e: true },
    dmg: ({ talent, cons }, dmg) => {
      let num = cons === 6 ? 36 : 12
      let td = num / 3
      let val = talent.e2["技能伤害"] + talent.e2["随机敌方伤害"] * td
      if (cons >= 2) val *= 1.3
      return dmg(val, "e2")
    }
  },
  {
    title: "终结技伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"] + talent.q["其他敌方伤害"], "q")
  },
  {
    title: "天赋追加伤害",
    dmg: ({ talent }, dmg) => dmg(talent.t2["远坂凛·追加伤害"], "t2")
  }
]

export const mainAttr = "atk,cpct,cdmg"
export const defDmgIdx = 3

export const buffs = [
  {
    title: "终结技-山脉震撼•明星之薪：终结技受到伤害提高[enemydmg]%",
    check: ({ params }) => params?.q === true,
    data: {
      enemydmg: ({ talent }) => talent.q["受到伤害提高"] * 100
    }
  },
  {
    title: "天赋-宝石魔术：暴击伤害提高[cdmg]%",
    data: {
      cdmg: ({ talent, cons }) => {
        let d = cons >= 2 ? 2 : 1
        return talent.t["暴击伤害提高"] * d * 100
      }
    }
  },
  {
    title: "行迹-秉持优雅：攻击力提高[atkPct]%, 量子属性抗性穿透提高[kx]%",
    tree: 1,
    data: {
      atkPct: 150,
      kx: 15
    }
  },
  {
    title: "远坂凛2魂：战技伤害提高[eDmg]%, 战技伤害为原伤害的130%",
    check: ({ params }) => params?.e === true,
    cons: 2,
    data: {
      eDmg: 20
    }
  },
  {
    title: "远坂凛4魂：暴击伤害提高叠加2层",
    cons: 4
  },
  {
    title: "远坂凛6魂：全属性抗性穿透提高[kx]%",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "rainbowwarmth"
