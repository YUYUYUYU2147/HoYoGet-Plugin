export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["技能伤害"], "a")
  },
  {
    title: "战技伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e")
  },
  {
    title: "终结技伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q")
  },
  {
    title: "战技伤害(【饲饵】目标)",
    params: { bait: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"] + talent.e["额外技能伤害"], "e")
  },
  {
    title: "天赋追加伤害(0层【婪酣】)",
    params: { bait: true, lhCount: 0 },
    dmg: ({ talent }, dmg) => dmg(talent.t["追加攻击伤害"], "t")
  },
  {
    title: "天赋追加伤害(满【婪酣】)",
    params: { bait: true, bits: true },
    dmg: ({ talent }, dmg) => {
      return dmg(talent.t["追加攻击伤害"], "t")
    }
  },
  {
    title: "终结技+强化追加(满【婪酣】)",
    params: { q: true, bait: true, bits: true },
    dmg: ({ talent, cons }, dmg) => {
      const lhCount = cons >= 2 ? 18 : 12
      const s = Math.floor(lhCount / 4)
      const qDmg = dmg(talent.q["技能伤害"], "q")
      const tDmg = dmg(talent.t["追加攻击伤害"], "t")
      const qExtraDmg = dmg(talent.q["额外技能伤害"] * s, "q")
      return {
        dmg: qDmg.dmg + tDmg.dmg + qExtraDmg.dmg,
        avg: qDmg.avg + tDmg.avg + qExtraDmg.avg
      }
    }
  }
]

export const defDmgIdx = 6
export const mainAttr = "atk,cpct,cdmg"

export const buffs = [
  {
    title: "战技-鞭哨：场上存在【饲饵】时，敌方全体防御力降低[enemyDef]%。",
    check: ({ params }) => params?.bait === true,
    data: {
      enemyDef: ({ talent }) => talent.e["防御力降低"] * 100
    }
  },
  {
    title: "行迹-影肢：追加攻击伤害提高[tDmg]%",
    tree: 2,
    data: {
      tDmg: ({ cons, params }) => {
        const lhCount = params?.lhCount ?? (cons >= 2 ? 18 : 12)
        return 80 + lhCount * 10
      }
    }
  },
  {
    title: "行迹-头狼：我方全体暴击伤害提高[cdmg]%，追加攻击暴击伤害额外提高[tCdmg]%。",
    tree: 3,
    data: {
      cdmg: 40,
      tCdmg: 80
    }
  },
  {
    title: "不死途1魂：敌方全体受到的伤害提高[enemydmg]%。",
    cons: 1,
    data: {
      enemydmg: 36
    }
  },
  {
    title: "不死途2魂：【婪酣】叠加上限提高至18层。",
    cons: 2
  },
  {
    title: "不死途4魂：施放终结技时，攻击力提高[atkPct]%。",
    cons: 4,
    data: {
      atkPct: ({ params }) => params?.q ? 40 : 0
    }
  },
  {
    title: "不死途6魂：场上存在【饲饵】时，敌方全体全属性抗性降低[kx]%，满【婪酣】时造成的伤害提高[dmg]%。",
    cons: 6,
    data: {
      kx: ({ params }) => params?.bait === true ? 20 : 0,
      dmg: ({ params, cons }) => {
        if (params?.bits !== true) return 0
        return Math.min(cons >= 2 ? 18 : 12, 30) * 4
      }
    }
  }
]

export const createdBy = "rainbowwarmth"
