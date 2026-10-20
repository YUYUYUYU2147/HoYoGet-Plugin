import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: (attrs, { basic }) => calcDmg(attrs, basic, attrs.talent.a["技能伤害"])
  }, {
    title: "强化普攻伤害(单体)",
    dmg: (attrs, { basic }) => calcDmg(attrs, basic, attrs.talent.a2["单体伤害"])
  }, {
    title: "强化普攻伤害(群攻单体)",
    dmg: (attrs, { basic }) => calcDmg(attrs, basic, attrs.talent.a2["群攻伤害"])
  }, {
    title: "强化普攻伤害(完整 3目标)",
    dmg: (attrs, { basic }) => {
      let dmg1 = calcDmg(attrs, basic, attrs.talent.a2["单体伤害"])
      let dmg2 = calcDmg(attrs, basic, attrs.talent.a2["群攻伤害"] * 3)
      return {
        avg: dmg1.avg + dmg2.avg,
        dmg: dmg1.dmg + dmg2.dmg
      }
    }
  }, {
    title: "忆灵技伤害",
    dmg: (attrs, { basic }) => calcDmg(attrs, basic, attrs.talent.me["技能伤害"])
  }, {
    title: "强化忆灵技单段额外伤害",
    dmg: (attrs, { basic }) => calcDmg(attrs, basic, attrs.talent.me2list[13]["技能伤害"] + (attrs.cons === 6 ? 0.72 : 0))
  }, {
    title: "忆灵天赋生命提高",
    dmg: ({ talent, attr }) => {
      return {
        avg: Format.comma(attr.hp.base * talent.mt["生命提高"], 1),
        type: "text"
      }
    }
  }
]

export const defDmgIdx = 3
export const defParams = { Memosprite: true }
export const mainAttr = "hp,cpct,cdmg"

export const buffs = [
  {
    title: "德谬歌状态：基础生命值: [_hpBase]，基础速度: 0",
    data: {
      _hpBase: ({ attr, calc }) => calc(attr.staticAttr.hp)
    }
  }, {
    title: "终结技-诗的「◦」誓约的「∞」：昔涟和德谬歌的暴击率提高[cpct]%",
    data: {
      cpct: ({ talent }) => talent.q["暴率提高"] * 100
    }
  }, {
    title: "天赋-众愿啊，汇流如歌：昔涟在场时，我方全体目标造成的伤害提高[dmg]%",
    data: {
      dmg: ({ talent }) => talent.t["伤害提高"] * 100
    }
  }, {
    title: "忆灵天赋-等待，在所有的过去：德谬歌在场时，昔涟与德谬歌的生命上限提高[hpPlus]",
    data: {
      hpPlus: ({ talent, attr }) => attr.hp.base * talent.mt["生命提高"]
    }
  }, {
    check: ({ attr, calc }) => calc(attr.speed) >= 180,
    title: "行迹-三相的因果：当前速度[_speed]，造成的伤害提高[dmg]%",
    sort: 9,
    tree: 3,
    data: {
      _speed: ({ attr, calc }) => calc(attr.speed),
      dmg: 20,
      kx: ({ attr, calc }) => Math.min(Math.floor((calc(attr.speed) - 180)) * 2, 120)
    }
  }, {
    title: "昔涟2魂：通过战技的结界造成的真实伤害倍率提高24%",
    cons: 2
  }, {
    title: "昔涟4魂：德谬歌施放12次【花与箭的舞曲】后，本场战斗中触发忆灵技【献予「真我」之诗】的弹射伤害倍率提高72%",
    cons: 4
  }, {
    title: "昔涟6魂：德谬歌触发1次忆灵技【献予「真我」之诗】施放【花与箭的舞曲】时，敌方全体目标的防御力降低[enemyDef]%",
    cons: 6,
    data: {
      enemyDef: 20
    }
  }
]

/**
 * @param attrs - 数据集
 * @param basic - 计算函数
 * @param talentPct - 天赋倍率
 * @returns {object}
 * - avg 期望伤害
 * - dmg 暴击伤害
 */
function calcDmg(attrs, basic, talentPct) {
  let { talent, attr, calc, cons } = attrs
  let basePct = calc(attr.hp) * talentPct
  let baseDmg = basic(basePct * (1 + talent.e["真实伤害"]), "a")
  let consDmg = { avg: 0, dmg: 0 }
  if (cons > 1) consDmg = basic(basePct * 0.24, "a")
  return {
    avg: baseDmg.avg + consDmg.avg,
    dmg: baseDmg.dmg + consDmg.dmg
  }
}

export const createdBy = "其实雨很好"
