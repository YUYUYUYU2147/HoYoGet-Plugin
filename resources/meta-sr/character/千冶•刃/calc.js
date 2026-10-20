export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.a["技能伤害"], "a")
  },
  {
    title: "强化普攻伤害",
    params: { q: true },
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.a2["技能伤害"], "a2")
  },
  {
    title: "战技伤害",
    params: { q: true },
    dmg: ({ talent, attr, calc }, { basic }) => {
      let td = talent.e["技能伤害"] + talent.e["随机单体伤害"] * 4
      return basic(calc(attr.hp) * td, "e")
    }
  },
  {
    title: "天赋追加伤害",
    params: { q: true },
    dmg: ({ talent, attr, calc, cons }, { basic }) => {
      let td = talent.e["技能伤害"] + talent.e["随机单体伤害"] * 4
      if (cons >= 2) td += 0.75
      return basic(calc(attr.hp) * td, "e")
    }
  },
  {
    title: "千冶铸一，万劫烬灭伤害",
    params: { q: true },
    dmg: ({ talent, attr, calc, cons }, { basic }) => {
      let td = talent.q2["技能伤害"]
      if (cons == 6) td += 1.5
      return basic(calc(attr.hp) * td, "q2")
    }
  }
]

export const defDmgIdx = 4
export const mainAttr = "hp,cpct,cdmg"

export const buffs = [
  {
    title: "终结技-骸骨当炉，血肉即薪：目标防御力降低[_enemyDef]%, 受到伤害提高[_enemydmg]%，暴击率提高[_cpct]%，暴击伤害提高[_cdmg]%。",
    data: {
      _enemyDef: ({ talent }) => talent.q["防御力降低"] * 100,
      enemyDef: ({ talent, params }) => params.q ? talent.q["防御力降低"] * 100 : 0,
      _enemydmg: ({ talent, params }) => talent.q["伤害提高"] * 100,
      enemydmg: ({ talent, params }) => params.q ? talent.q["伤害提高"] * 100 : 0,
      _cpct: 20,
      cpct: ({ params }) => params.q ? 20 : 0,
      _cdmg: ({ talent }) => talent.q["暴击伤害提高"] * 100,
      cdmg: ({ talent, params }) => params.q ? talent.q["暴击伤害提高"] * 100 : 0
    }
  },
  {
    title: "天赋-万淬心：我方目标造成的伤害提高[dmg]%。",
    tree: 3,
    data: {
      dmg: 125
    }
  },
  {
    title: "千冶•刃1魂：结界持续期间，使敌方全体全属性抗性降低[kx]%。",
    cons: 1,
    data: {
      kx: 20
    }
  },
  {
    title: "千冶•刃2魂：施放终结技造成伤害时, 追加伤害提高75%。",
    cons: 2
  },
  {
    title: "千冶•刃4魂：【万淬心】使我方目标造成的伤害额外提高[dmg]%。",
    cons: 4,
    data: {
      dmg: 50
    }
  },
  {
    title: "千冶•刃6魂：【千冶铸一，万劫烬灭】的伤害倍率提高150%",
    cons: 6
  }
]

export const createdBy = "rainbowwarmth"
