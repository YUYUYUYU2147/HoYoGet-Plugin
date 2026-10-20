/* eslint-disable no-empty-pattern */
export const details = [
  {
    title: "E技能伤害",
    dmg: ({ talent }, dmg) => dmg(talent.e["技能伤害"], "e,nightsoul")
  }, {
    title: "E焚曜之环伤害",
    params: { fy: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["焚曜之环伤害"], "e,nightsoul")
  }, {
    title: "驰轮车普攻一段伤害(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车普通攻击一段伤害"], "a,nightsoul")
  }, {
    title: "驰轮车普攻一段融化(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车普通攻击一段伤害"], "a,nightsoul", "融化")
  }, {
    title: "驰轮车重击循环伤害(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车重击循环伤害"], "a2,nightsoul")
  }, {
    title: "驰轮车重击循环融化(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车重击循环伤害"], "a2,nightsoul", "融化")
  }, {
    title: "驰轮车重击终结伤害(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车重击终结伤害"], "a2,nightsoul")
  }, {
    title: "驰轮车重击终结融化(满战意 死生之炉状态)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.e["驰轮车重击终结伤害"], "a2,nightsoul", "融化")
  }, {
    title: "Q技能伤害(100战意)",
    params: { zy: 100, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q,nightsoul")
  }, {
    title: "Q技能伤害(满战意)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q,nightsoul")
  }, {
    title: "Q技能融化(满战意)",
    params: { zy: 200, cl: true },
    dmg: ({ talent }, dmg) => dmg(talent.q["技能伤害"], "q,nightsoul", "融化")
  }, {
    check: ({ cons }) => cons === 6,
    title: "六命焚曜之环攻击驰轮车冲撞伤害",
    params: { fy: true },
    dmg: ({}, dmg) => dmg(200, "e,nightsoul")
  }, {
    check: ({ cons }) => cons === 6,
    title: "六命「焚曜之环·灼象」伤害",
    params: { cl: true },
    dmg: ({}, dmg) => dmg(500, "e,nightsoul")
  }
]

export const defDmgIdx = 10
export const defParams = { Nightsoul: true }
export const mainAttr = "atk,cpct,cdmg"

export const buffs = [
  {
    check: ({ params }) => params.zy > 0,
    title: "元素爆发-燔天之时：死生之炉状态下，[_zy]层战意使坠日斩伤害提升[qPlus]，「古名解放」普通攻击伤害提升[aPlus]，「古名解放」重攻击伤害提升[a2Plus]",
    sort: 9,
    data: {
      _zy: ({ params }) => params.zy,
      qPlus: ({ talent, calc, attr, params }) => params.zy * talent.q["坠日斩伤害提升"] * calc(attr.atk) / 100,
      aPlus: ({ talent, calc, attr, params }) => params.zy * talent.q["驰轮车普通攻击伤害提升"] * calc(attr.atk) / 100,
      a2Plus: ({ talent, calc, attr, params }) => params.zy * talent.q["驰轮车重击伤害提升"] * calc(attr.atk) / 100
    }
  }, {
    title: "天赋-炎花献礼：队伍中的附近的角色触发「夜魂迸发」时，玛薇卡的攻击力提升[atkPct]%",
    data: {
      atkPct: 30
    }
  }, {
    check: ({ params }) => params.zy > 0,
    title: "天赋-「基扬戈兹」：施放元素爆发燔天之时后，[_zy]层战意，使角色造成的伤害提升[dmg]%",
    data: {
      _zy: ({ params }) => params.zy,
      dmg: ({ params }) => 0.2 * params.zy
    }
  }, {
    title: "玛薇卡1命：获取战意后，玛薇卡的攻击力提升[atkPct]%",
    cons: 1,
    data: {
      atkPct: 40
    }
  }, {
    title: "玛薇卡2命：夜魂加持状态下时，基础攻击力提升200点",
    cons: 2,
    data: {
      atkBase: 200
    }
  }, {
    title: "玛薇卡2命：焚曜之环状态下，附近的敌人的防御力降低20%。驰轮车状态下，玛薇卡的普通攻击、重击、元素爆发燔天之时中的坠日斩造成的伤害提升[aPlus]/[a2Plus]/[qPlus]",
    sort: 9,
    cons: 2,
    data: {
      enemyDef: ({ params }) => params.fy ? 20 : 0,
      aPlus: ({ calc, attr }) => calc(attr.atk) * 60 / 100,
      a2Plus: ({ calc, attr }) => calc(attr.atk) * 90 / 100,
      qPlus: ({ calc, attr }) => calc(attr.atk) * 120 / 100
    }
  }, {
    title: "玛薇卡4命：额外获得[dmg]%伤害加成",
    cons: 4,
    data: {
      dmg: 10
    }
  }, {
    title: "玛薇卡6命：驾驶驰轮车时使附近的敌人的防御力降低20%",
    cons: 6,
    data: {
      enemyDef: ({ params }) => params.cl ? 20 : 0
    }
  }
]

export const createdBy = "其实雨很好&觅麟"
