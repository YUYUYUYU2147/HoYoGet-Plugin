export default function(staticIdx, keyIdx) {
  return {
    "嗤笑": [ keyIdx("阿哈时刻发动时，欢愉度提高[elation]%", "elation", 1) ],
    "残泪": [ keyIdx("拥有的笑点大于等于10时，暴击伤害提高[cdmg]%", "cdmg", 1) ],
    "菇菇嘎嘎历险记": [
      staticIdx(1, "elation"),
      keyIdx("施放欢愉技时，使敌方全体受到的欢愉伤害提高[elationEnemydmg]%", "elationEnemydmg", 2)
    ],
    "今日好手气": [
      staticIdx(1, "cpct"),
      keyIdx("施放欢愉技时，欢愉度提高[elation]%", "elation", 2)
    ],
    "花花世界迷人眼": [
      staticIdx(1, "cdmg"),
      (tables) => {
        return {
          title: "消耗4个战技点，使自身造成的欢愉伤害无视敌方目标[elationIgnore]%，并使欢愉度提高[elation]%",
          data: {
            elationIgnore: tables[3] * 4,
            elation: tables[2]
          }
        }
      }
    ],
    "当她决定看见": [
      staticIdx(1, "speedPct"),
      keyIdx("进入战斗或对我方目标施放终结技时，我方全体暴击率提高[cpct]%，暴击伤害提高[cdmg]%", { cpct: 2, cdmg: 3 })
    ],
    "欢愉满溢祝福": [
      staticIdx(1, "atkPct"),
      keyIdx("当装备者对我方单体角色施放战技或终结技后，使目标欢愉度提高[elation]%", "elation", 2)
    ],
    "未来，有我们一起": [
      staticIdx(1, "cdmg"),
      keyIdx("装备者施放终结技后，使我方全体欢愉度提高[elation]%", "elation", 2)
    ],
    "欢迎来到银河城": [
      staticIdx(1, "speedPct"),
      keyIdx("装备者造成的欢愉伤害无视目标[elationIgnore]%", "elationIgnore", 2)
    ],
    "邂逅于下一个花季": [
      staticIdx(1, "cdmg"),
      staticIdx(2, "recharge"),
      keyIdx("装备者施放欢愉技时，使敌方目标受到的伤害提高[_enemydmg]%", "_enemydmg", 3)
    ],
    "放个短假": [
      staticIdx(1, "elation"),
      keyIdx("装备者施放欢愉技时，无视目标[ignore]%防御力", "ignore", 2)
    ],
    "向浪花掷下盛夏": [
      staticIdx(1, "cpct"),
      keyIdx("装备者施放欢愉技时，速度提高[speedPct]%, 欢愉度提高[elation]%", { speedPct: 2, elation: 3 })
    ],
    "献给明日的色彩": [
      staticIdx(1, "defPct"),
      keyIdx("装备者施放欢愉技时，使我方全体造成的伤害提高[dmg]%", "dmg", 4)
    ]
  }
}
