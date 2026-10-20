export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  },
  {
    title: "战技伤害",
    params: { wl: true },
    dmg: ({ talent, cons }, dmg) => {
      let skillDmg = talent.e["技能伤害"]
      let nearDmg = talent.e["相邻目标伤害"]
      if (cons >= 2) {
        skillDmg += 1
        nearDmg += 0.5
      }
      const total = skillDmg + nearDmg
      return dmg(total, "e")
    }
  },
  {
    title: "战技伤害(三目标)",
    params: { wl: true },
    dmg: ({ talent, cons }, dmg) => {
      let skillDmg = talent.e["技能伤害"]
      let nearDmg = talent.e["相邻目标伤害"] * 2
      if (cons >= 2) {
        skillDmg += 1
        nearDmg += 0.5
      }
      const total = skillDmg + nearDmg
      return dmg(total, "e")
    }
  },
  {
    title: "终结技伤害",
    params: { wl: true, q: true, xzNum: 2 },
    dmg: ({ talent, cons }, dmg) => {
      let tq = talent.q["随机单体伤害"]
      if (cons === 6) tq += 0.8
      return dmg(talent.q["技能伤害"] + tq * 10, "q")
    }
  },
  {
    title: "战技终结技后天赋追加伤害",
    params: { wl: true, q: true, xzNum: 2 },
    dmg: ({ talent }, dmg) => dmg(talent.t2["吉尔伽美什·追加伤害"], "t")
  },
  {
    title: "6层【兴致】终结技伤害",
    params: { wl: true, q: true, xzNum: 6 },
    dmg: ({ talent, cons }, dmg) => {
      let tq = talent.q["随机单体伤害"]
      if (cons === 6) tq += 0.8
      return dmg(talent.q["技能伤害"] + tq * 10, "q")
    }
  }
]

export const mainAttr = "atk,cpct,cdmg"
export const defDmgIdx = 5

export const buffs = [
  {
    title: "技能-王之财宝：无视[ignore]%防御力",
    check: ({ params }) => params?.wl === true,
    data: {
      ignore: ({ talent }) => talent.e["目标防御力"] * 100
    }
  },
  {
    title: "天赋-尽情取悦本王吧：终结技伤害提高[qDmg]%",
    check: ({ params }) => params?.q === true,
    data: {
      qDmg: ({ talent }) => talent.t["终结技伤害提高"] * 100
    }
  },
  {
    title: "行迹-英雄的孤傲：每层【兴致】暴击伤害提高25%",
    tree: 2,
    data: {
      cdmg: ({ params }) => (params.xzNum || 0) * 25
    }
  },
  {
    title: "行迹-王霸的竞逐：攻击力提高[atkPct]%, 暴击伤害提高[cdmg]%",
    tree: 3,
    data: {
      atkPct: 20,
      cdmg: 20
    }
  },
  {
    title: "吉尔伽美什1魂：攻击力提高[atkPct]%。",
    cons: 1,
    check: ({ params }) => params?.wl === true,
    data: {
      atkPct: 60
    }
  },
  {
    title: "吉尔伽美什2魂：战技【王之财宝】对主目标伤害倍率提高100%, 对相邻目标伤害倍率提高50%。",
    cons: 2
  },
  {
    title: "吉尔伽美什6魂：终结技弹射伤害倍率提高80%，全属性抗穿提高[kx]%。",
    cons: 6,
    data: {
      kx: 20
    }
  }
]

export const createdBy = "rainbowwarmth"
