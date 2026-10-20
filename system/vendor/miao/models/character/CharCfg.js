import fs from "node:fs"
import lodash from "lodash"
import { installPromise } from "../../installMeta.js"
import { Cfg, Data } from "#hoyo.miao"
import { miaoPath } from "#hoyo.miao.path"

let cfgMap = {
  char: {},
  game: "gs",
  async init(game = "gs") {
    await installPromise()
    this.game = game
    let chars = fs.readdirSync(`${miaoPath}/resources/meta-${game}/character`)
    for (let char of chars) {
      cfgMap.char[char] = {}
      let curr = cfgMap.char[char]
      // 评分规则
      if (cfgMap.exists(char, "artis_user")) {
        curr.artis = await cfgMap.getCfg(char, "artis_user", "default")
      } else if (cfgMap.exists(char, "artis")) {
        curr.artis = await cfgMap.getCfg(char, "artis", "default")
      }
      // 伤害计算
      if (cfgMap.exists(char, "calc_user")) {
        curr.calc = await cfgMap.getCfg(char, "calc_user")
        curr.calcCreatedBy = "自定义伤害"
      } else {
        if (cfgMap.exists(char, "calc_auto")) {
          curr.calcAuto = await cfgMap.getCfg(char, "calc_auto")
        }
        if (cfgMap.exists(char, "calc")) {
          curr.calc = await cfgMap.getCfg(char, "calc")
          curr.calcCreatedBy = "喵喵"
        }
      }
    }
  },
  exists(char, file) {
    return fs.existsSync(`${miaoPath}/resources/meta-${this.game}/character/${char}/${file}.js`)
  },
  async getCfg(char, file, module = "") {
    let cfg = await Data.importModule(`resources/meta-${this.game}/character/${char}/${file}.js`, "miao")
    if (module) return cfg[module]
    return cfg
  }
}
let cfgMapGs = { char: {} }
let cfgMapSr = { char: {} }
let reloadCfg = async() => {
  cfgMap.char = {}
  await cfgMap.init("gs")
  cfgMapGs = { ...cfgMap, char: { ...cfgMap.char } }
  await cfgMap.init("sr")
  cfgMapSr = { ...cfgMap, char: {} }
  for (const k of Object.keys(cfgMap.char)) {
    if (!(k in cfgMapGs.char)) cfgMapSr.char[k] = cfgMap.char[k]
  }
}

await reloadCfg()

/**
 * 角色相关配置
 */
let CharCfg = {
  // 初始化/重载评分和伤害计算配置
  reloadCfg,

  // 获取角色伤害计算相关配置
  getCalcRule(char) {
    let charName = char.isTraveler ? `旅行者/${char.elem}` : char.name
    let charCfg = cfgMap.char[charName]
    if (!charCfg) return false

    // 按优先级选择 calc 源：calc_user > calc_auto(需teamCalc) > calc
    let cfg, createdBy
    if (charCfg.calcCreatedBy === "自定义伤害") {
      cfg = charCfg.calc
      createdBy = "自定义伤害"
    } else if (charCfg.calcAuto && Cfg.get("teamCalc")) {
      cfg = charCfg.calcAuto
      createdBy = "组团伤害"
    } else if (charCfg.calc) {
      cfg = charCfg.calc
      createdBy = charCfg.calcCreatedBy || "喵喵"
    }
    if (!cfg || lodash.isEmpty(cfg)) return false
    return {
      createdBy: createdBy.slice(0, 15),
      details: cfg.details || false,
      buffs: cfg.buffs || [],
      defParams: cfg.defParams || {},
      defDmgIdx: cfg.defDmgIdx || -1,
      defDmgKey: cfg.defDmgKey || "",
      mainAttr: cfg.mainAttr || "atk,cpct,cdmg",
      enemyName: cfg.enemyName || (char.isSr ? "弱点敌人" : "小宝")
    }
  },
  getArtisCfg(char) {
    if (char.game !== "sr") {
      // 评分规则在 旅行者 下而非 旅行者/elem 下
      let charName = char.isTraveler ? "旅行者" : char.name
      return cfgMapGs.char[charName]?.artis || false
    } else {
      return cfgMapSr.char[char.name]?.artis || false
    }
  }
}
export default CharCfg
