import { usefulAttr } from "../../artifact/artis-mark.js"

export default function({ attr, def, rule }) {
  if (attr.atk >= 1600) {
    return rule("知更鸟·晴歌-爆伤辅", { hp: 100, atk: 50, def: 0, speed: 100, cpct: 50, cdmg: 100, stance: 0, heal: 0, recharge: 100, effPct: 0, effDef: 0, dmg: 0 })
  }
  return def(usefulAttr["知更鸟·晴歌"])
}
