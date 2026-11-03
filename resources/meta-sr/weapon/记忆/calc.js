export default function(staticIdx, keyIdx) {
  return {
    "溯忆": (tables) => {
      return {
        check: ({ params }) => params.Memosprite,
        title: "忆灵在场时，4层【缅怀】使造成的伤害提高[dmg]%",
        data: {
          dmg: tables[1] * 4
        }
      }
    },
    "将光阴织成黄金": [
      staticIdx(1, "speedPct"),
      (tables) => {
        return {
          title: "6层【织锦】使装备者和装备者的忆灵暴击伤害提高[cdmg]%，使造成的普攻伤害提高[aDmg]%",
          data: {
            cdmg: tables[2] * 6,
            aDmg: tables[3] * 6,
            meDmg: tables[3] * 6
          }
        }
      }
    ],
    "胜利只在朝夕间": [
      staticIdx(1, "cdmg"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "装备者的忆灵对我方目标施放技能时，使我方全体目标造成的伤害提高[dmg]%",
          data: {
            dmg: tables[2]
          }
        }
      }
    ],
    "天才们的问候": [
      staticIdx(1, "atkPct"),
      keyIdx("装备者施放终结技后，使装备者与忆灵造成的普攻伤害额外提高[aDmg]%", { aDmg: 2, meDmg: 2 })
    ],
    "多流汗，少流泪": [
      staticIdx(1, "cpct"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "装备者的忆灵在场上时，装备者与忆灵造成的伤害提高[dmg]%",
          data: {
            dmg: tables[2]
          }
        }
      }
    ],
    "记忆永不落幕": [
      staticIdx(1, "speedPct"),
      keyIdx("装备者施放战技后，使我方全体造成的伤害提高[dmg]%", "dmg", 2)
    ],
    "让告别，更美一些": [
      staticIdx(1, "hpPct"),
      keyIdx("使装备者和装备者的忆灵造成的伤害时，无视目标[ignore]%的防御力", "ignore", 2)
    ],
    "愿虹光永驻天空": [
      staticIdx(1, "speedPct"),
      keyIdx("装备者的忆灵施放忆灵技时，使敌方全体受到的伤害提高[enemydmg]%", "enemydmg", 4)
    ],
    "故事的下一页": [
      staticIdx(1, "hpPct"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "装备者的忆灵攻击后，使装备者与忆灵的治疗量提高[heal]%",
          data: {
            heal: tables[2]
          }
        }
      }
    ],
    "花儿不会忘记": [
      staticIdx(1, "cdmg"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "装备者忆灵造成的暴击伤害额外提高[meCdmg]%",
          data: {
            meCdmg: tables[2]
          }
        }
      }
    ],
    "致长夜的星光": [
      staticIdx(1, "hpPct"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "持有【夜色】时，忆灵造成的伤害无视目标[meIgnore]%，装备者和装备者忆灵造成的伤害提高[dmg]%",
          data: {
            meIgnore: tables[2],
            mtIgnore: tables[2],
            dmg: tables[3]
          }
        }
      }
    ],
    "爱如此刻永恒": [
      staticIdx(1, "speedPct"),
      (tables) => {
        return {
          check: ({ params }) => params.Memosprite,
          title: "装备者的忆灵对我方单体施放忆灵技时，敌方全体受到的伤害提高[_enemydmg]%。装备者的忆灵对敌方施放忆灵技时,我方全体的暴击伤害提高[_cdmg]%，上述效果同时持有时，效果提高[_pct]%",
          data: {
            _pct: tables[4],
            _enemydmg: tables[3],
            _cdmg: tables[2],
            enemydmg: tables[3] * (100 + tables[4]) / 100,
            cdmg: tables[2] * (100 + tables[4]) / 100
          }
        }
      }
    ],
    "飞向粉色的明天": [ staticIdx(1, "cdmg") ],
    "你将起身歌唱": [
      staticIdx(1, "hpPct"),
      keyIdx("装备者持有【新声】后，使我方全体速度提高[speedPct]%", "speedPct", 3)
    ]
  }
}
