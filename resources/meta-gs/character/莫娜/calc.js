export const details = [
  {
    title: "重击伤害",
    dmg: ({ talent }, dmg) => dmg(talent.a["重击伤害"], "a2")
  }, {
    title: "重击蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.a["重击伤害"], "a2", "vaporize")
  }, {
    title: "E持续伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["持续伤害"], "e")
  }, {
    title: "E持续蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.e["持续伤害"], "e", "vaporize")
  }, {
    title: "E爆裂伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["爆裂伤害"], "e")
  }, {
    title: "E爆裂蒸发",
    dmg: ({ talent }, dmg) => dmg(talent.e["爆裂伤害"], "e", "vaporize")
  }, {
    title: "Q泡影破裂伤害",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["泡影破裂伤害"], "q")
  }, {
    title: "Q泡影破裂蒸发",
    params: { q: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["泡影破裂伤害"], "q", "vaporize")
  }
]

export const defDmgIdx = 7
export const defParams = { Hexenzirkel: true } // 魔女会成员
export const mainAttr = "atk,cpct,cdmg,recharge"

export const buffs = [
  {
    title: "元素爆发-星命定轨：元素爆发持续时间内，提高[dmg]%伤害加成",
    data: {
      dmg: ({ talent }) => talent.q["伤害加成"]
    }
  }, {
    title: "天赋-魔女的前夜礼·天步真原：3层「水星天的辉光」使本次蒸发反应造成的伤害提升[vaporize]%",
    data: {
      vaporize: 15
    }
  }, {
    title: "天赋-「托付于命运吧！」：基于元素充能效率提升水元素伤害[dmg]%",
    sort: 4,
    data: {
      dmg: ({ calc, attr }) => calc(attr.recharge) * 0.2
    }
  }, {
    title: "莫娜1命：命中星异状态下的敌人水元素相关反应效果提升15%",
    cons: 1,
    data: {
      vaporize: ({ params }) => params.q ? 15 : 0
    }
  }, {
    title: "莫娜2命：重击命中敌人时，还会使队伍中附近的所有角色的元素精通提升[mastery]",
    cons: 2,
    data: {
      mastery: 80
    }
  }, {
    title: "莫娜4命：攻击处于星异状态下的敌人时暴击率提升15%，暴击伤害提升15%",
    cons: 4,
    data: {
      cpct: ({ params }) => params.q ? 15 : 0,
      cdmg: ({ params }) => params.q ? 15 : 0
    }
  }, {
    title: "莫娜6命：虚实流动状态后满Buff提升重击180%伤害",
    cons: 6,
    data: {
      a2Dmg: 180
    }
  }, "vaporize"
]

export const createdBy = "其实雨很好"
