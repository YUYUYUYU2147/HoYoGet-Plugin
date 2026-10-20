import { Format } from "#miao"

export const details = [
  {
    title: "普攻伤害",
    dmg: ({ talent, attr, calc }, { basic }) => basic(calc(attr.hp) * talent.a["技能伤害"], "a")
  }, {
    title: "战技晴空乐手回复",
    dmg: ({ talent, attr, calc }, { heal }) => heal(calc(attr.hp) * talent.e["治疗·百分比生命"], "e")
  }, {
    title: "终结技能量回复",
    params: { noBuff: true },
    dmg: ({ talent, attr, calc }, { basic }) => {
      return {
        avg: attr.sp * talent.q["回能·能量上限"],
        type: "text"
      }
    }
  }, {
    title: "满气氛值天赋无视防御力",
    params: { noBuff: true },
    dmg: ({ talent, cons }) => {
      let qf = cons >= 2 ? 14 : 12
      return {
        avg: Format.percent((talent.t["减防·百分比气氛值"] + qf * 0.005)),
        type: "text"
      }
    }
  }, {
    title: "忆灵技伤害",
    params: { Fever: true },
    dmg: ({ talent, attr, cons, calc }, { basic }) => {
      let skillRate = cons === 6 ? talent.me["技能伤害"] * 2 : talent.me["技能伤害"]
      let base = calc(attr.hp) * skillRate
      return basic(base, "me")
    }
  }, {
    title: "满气氛值1魂忆灵技额外伤害",
    params: { Fever: true },
    cons: 1,
    dmg: ({ talent, attr, cons, calc }, { basic }) => {
      let base = calc(attr.hp) * (talent.a["技能伤害"] + cons === 6 ? talent.me["技能伤害"] * 2 : talent.me["技能伤害"])
      let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
      return basic(base * (0.11 + qf * 0.001), "me")
    }
  }, {
    title: "满气氛值忆灵天赋自身伤害提高",
    params: { noBuff: true },
    dmg: ({ talent, cons }) => {
      let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
      return {
        avg: Format.percent((talent.mt["伤害提高"] + qf * talent.mt["伤害提高·气氛值"])),
        type: "text"
      }
    }
  }, {
    title: "满气氛值行迹队友攻击力提高",
    params: { noBuff: true },
    dmg: ({ attr, calc, cons }, { basic }) => {
      let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
      let rate = 0.16 + qf * 0.004
      let atkGain = calc(attr.hp) * rate
      return {
        avg: `${Math.round(atkGain)}`,
        type: "text"
      }
    }
  }, {
    title: "满气氛值行迹队友暴击伤害提高",
    params: { noBuff: true },
    dmg: ({ attr, calc, cons }, { basic }) => {
      let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
      let rate = 0.4 + qf * 0.015
      return {
        avg: Format.percent(rate),
        type: "text"
      }
    }
  }
]

export const defDmgIdx = 4
export const defParams = { Memosprite: true }
export const mainAttr = "hp,cpct,cdmg,speed"

export const buffs = [
  {
    title: "晴空乐手状态：基础生命值: [_hpBase]，基础速度: [_speedBase]",
    data: {
      _hpBase: ({ attr, calc }) => calc(attr.hp) * 0.7,
      _speedBase: ({ attr, calc }) => calc(attr.speed) * 1.8
    }
  }, {
    title: "天赋-巡游在无界的天空：满气氛值无视防御力[ignore]%。",
    data: {
      ignore: ({ talent, cons }) => {
        let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
        return (talent.t["减防·百分比气氛值"] + qf * 0.005) * 100
      }
    }
  }, {
    title: "忆灵天赋-扑翅雀跃的和声：知更鸟·晴歌伤害提高[dmg]%。",
    data: {
      dmg: ({ talent, cons }) => {
        let qf = cons >= 4 ? 20 : cons >= 2 ? 14 : 12
        return (talent.mt["伤害提高"] + qf * talent.mt["伤害提高·气氛值"]) * 100
      }
    }
  }, {
    title: "忆灵天赋-扑翅雀跃的和声：「晴空乐手」在场时，使敌方全体受到的伤害分别提高[dmg]%。",
    check: ({ params }) => params.Fever,
    data: {
      dmg: ({ talent }) => talent.mt["伤害提高·三位成员"] * 100
    }
  }, {
    title: "行迹-重构谐乐：知更鸟·晴歌与「晴空乐手」的暴击率提高50%。",
    tree: 3,
    data: {
      cpct: 50,
      meCpct: 50
    }
  }, {
    title: "知更鸟·晴歌2魂：我方目标的全属性抗性穿透提高[kx]%，气氛值上限提高20，第一次施放技能使知更鸟•晴歌获得气氛值时额外获得2点。",
    cons: 2,
    data: {
      kx: 18
    }
  }, {
    title: "知更鸟·晴歌4魂：进入【Fever】状态时，立即获得12点气氛值，「晴空乐手」的速度提高[speedPct]%",
    cons: 4,
    check: ({ params }) => params.Fever,
    data: {
      speedPct: 20 + 20 * 0.5
    }
  }, {
    title: "知更鸟·晴歌6魂：忆灵技的伤害倍率提高原倍率的100%",
    cons: 6
  }
]

export const createdBy = "rainbowwarmth"
