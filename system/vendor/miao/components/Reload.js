import lodash from "lodash"
import Data from "./Data.js"
import Meta from "./Meta.js"

export async function reloadAllMeta(game = "gs") {
  const resPath = `resources/meta-${game}`
  const isSr = game === "sr"

  async function reloadArtifact() {
    const mark = await Data.importModule(`${resPath}/artifact/artis-mark.js`, "miao")
    const aliasMod = await Data.importModule(`${resPath}/artifact/alias.js`, "miao")
    const calcMod = await Data.importModule(`${resPath}/artifact/calc.js`, "miao")
    if (!mark?.usefulAttr) return

    Meta.resetCreate(game, "arti")
    Meta.resetCreate(game, "artiSet")

    const artiData = Data.readJSON(`${resPath}/artifact/data.json`, "miao") || {}
    const setMeta = Meta.create(game, "artiSet")
    const artiMeta = Meta.create(game, "arti")
    const setIds = {}

    lodash.forEach(artiData, (setData) => {
      const effect = isSr ? setData.skill : setData.effect
      const artiSet = { name: setData.name, effect, idxs: {} }
      setMeta.addDataItem(setData.name, artiSet)

      lodash.forEach(setData.idxs, (as, idx) => {
        if (as.name) {
          artiSet.idxs[idx] = as.name
          const item = isSr
            ? { ...as, set: setData.name, setId: setData.id, idx }
            : { set: setData.name, name: as.name, idx }
          artiMeta.addDataItem(as.name, item)
          setIds[setData.name] = setIds[setData.name] || (isSr ? "" : as.id.toString().slice(0, 2))
        }
      })
    })

    if (isSr) {
      if (aliasMod?.artiSetAbbr) setMeta.addAbbr(aliasMod.artiSetAbbr)
      if (aliasMod?.aliasCfg) setMeta.addAlias(aliasMod.aliasCfg)
      if (aliasMod?.artiAbbr) artiMeta.addAbbr(aliasMod.artiAbbr)
      const idMap = {}
      lodash.forEach(artiData, (setData) => {
        lodash.forEach(setData.idxs, (ds) => {
          if (ds.name && ds.ids) idMap[ds.name] = lodash.keys(ds.ids).join(",")
        })
      })
      artiMeta.addAlias(idMap, true)
    } else {
      if (aliasMod?.setAbbr) setMeta.addAbbr(aliasMod.setAbbr)
      if (aliasMod?.setAlias) setMeta.addAlias(aliasMod.setAlias)
      setMeta.addAlias(setIds)
    }

    const artiBuffs = calcMod?.default || calcMod
    if (isSr) {
      const metaMod = await Data.importModule(`${resPath}/artifact/meta.js`, "miao")
      const metaData = Data.readJSON(`${resPath}/artifact/meta.json`, "miao") || {}
      artiMeta.addMeta({
        usefulAttr: mark.usefulAttr,
        mainAttr: metaMod?.mainAttr,
        subAttr: metaMod?.subAttr,
        attrMap: metaMod?.attrMap,
        artiBuffs,
        metaData
      })
    } else {
      const extra = await Data.importModule(`${resPath}/artifact/extra.js`, "miao")
      artiMeta.addMeta({
        usefulAttr: mark.usefulAttr,
        mainAttr: extra?.mainAttr,
        subAttr: extra?.subAttr,
        attrMap: extra?.attrMap,
        attrNameMap: extra?.attrNameMap,
        mainIdMap: extra?.mainIdMap,
        attrIdMap: extra?.attrIdMap,
        artiBuffs
      })
    }
    setMeta.addMeta({ artiBuffs })
  }

  async function reloadCharacter() {
    const aliasMod = await Data.importModule(`${resPath}/character/alias.js`, "miao")
    if (!aliasMod?.alias) return

    Meta.resetCreate(game, "char")

    const meta = Meta.create(game, "char")
    const data = Data.readJSON(`${resPath}/character/data.json`, "miao") || {}
    meta.addData(data)
    meta.addAlias(aliasMod.alias)

    const extraMod = await Data.importModule(`${resPath}/character/extra.js`, "miao")

    if (isSr) {
      const abbr = { ...(aliasMod?.abbr || {}) }
      lodash.forEach(data, (ds) => {
        abbr[ds.name] = abbr[ds.name] || ds.name
      })
      meta.addAbbr(abbr)
    } else {
      const travelers = [ "荧", "空", "旅行者" ]
      travelers.forEach((name) => {
        const id = meta.getId(name)
        if (id) {
          meta.addDataItem(id, Data.readJSON(`${resPath}/character/${name}/data.json`, "miao"))
        }
      })
      const extraChars = extraMod?.extraChars || {}
      lodash.forEach(extraChars, (alias, char) => {
        meta.addDataItem(char, { id: char, name: char })
      })
      meta.addAlias(extraChars)
    }
    const wifeCfg = extraMod?.wifeCfg || {}
    if (!lodash.isEmpty(wifeCfg)) {
      const targetGame = isSr ? "gs" : game
      const gsMeta = Meta.create(targetGame, "char")
      let { wifeData } = gsMeta.getMeta()
      wifeData = wifeData || {}
      const { diyCfg } = await Data.importCfg("character")
      const diyWifeData = diyCfg.wifeData || {}
      const addWife = (txt, type) => {
        wifeData[type] = wifeData[type] || {}
        Data.eachStr(txt, (name) => {
          const id = meta.getId(name)
          if (id) wifeData[type][id] = true
        })
      }
      lodash.forEach(wifeCfg, (txt, type) => addWife(txt, type))
      lodash.forEach(diyWifeData, (txt, type) => addWife(txt, type))
      gsMeta.addMeta({ wifeData })
    }
  }

  async function reloadWeapon() {
    Meta.resetCreate(game, "weapon")

    if (isSr) {
      const aliasMod = await Data.importModule(`${resPath}/weapon/alias.js`, "miao")
      const data = Data.readJSON(`${resPath}/weapon/data.json`, "miao") || {}
      const types = "存护,丰饶,毁灭,同谐,虚无,巡猎,智识,记忆,欢愉".split(",")

      const meta = Meta.create(game, "weapon")
      meta.addData(data)
      meta.addAlias(aliasMod?.aliasCfg || {})
      meta.addAbbr(aliasMod?.abbr || {})

      const weaponBuffs = {}
      for (const type of types) {
        const calc = await Data.importDefault(`${resPath}/weapon/${type}/calc.js`, "miao")
        if (lodash.isFunction(calc)) {
          const result = calc(
            (idx, key) => ({ isStatic: true, idx, key }),
            (title, key, idx) => {
              if (lodash.isPlainObject(key)) {
                return (tables) => {
                  const d = {}
                  lodash.forEach(key, (i, k) => { d[k] = tables[i] })
                  return { title, data: d }
                }
              }
              return { title, idx, key }
            }
          )
          lodash.forEach(result, (ds, key) => {
            const id = meta.getId(key)
            if (id) weaponBuffs[id] = ds
          })
        }
      }
      meta.addMeta({ weaponBuffs })
    } else {
      const aliasMod = await Data.importModule(`${resPath}/weapon/alias.js`, "miao")
      const extraMod = await Data.importModule(`${resPath}/weapon/extra.js`, "miao")
      const descMod = await Data.importModule(`${resPath}/weapon/desc.js`, "miao")
      if (!extraMod?.weaponType) return

      const weaponBuffs = {}
      const data = {}
      const step = (start, s = 0) => {
        if (!s) s = start / 4
        const ret = []
        for (let idx = 0; idx <= 5; idx++) ret.push(start + s * idx)
        return ret
      }
      const attr = (key, start, _step) => {
        const refine = {}
        refine[key] = step(start, _step)
        return { title: `${key}提高[key]`, isStatic: true, refine }
      }

      for (const type in extraMod.weaponType) {
        const typeCalc = await Data.importDefault(`${resPath}/weapon/${type}/calc.js`, "miao")
        if (typeCalc) {
          lodash.extend(weaponBuffs, typeCalc(step, attr))
        }
        const typeData = Data.readJSON(`${resPath}/weapon/${type}/data.json`, "miao") || {}
        lodash.forEach(typeData, (ds) => {
          data[ds.id] = { id: ds.id, name: ds.name, type, star: ds.star }
        })
      }

      const meta = Meta.create(game, "weapon")
      meta.addData(data)
      meta.addAlias(aliasMod?.alias || {})
      meta.addAbbr(aliasMod?.abbr || {})
      meta.addMeta({
        weaponType: extraMod.weaponType,
        weaponSet: extraMod.weaponSet,
        weaponBuffs,
        descFix: descMod?.descFix || {}
      })
    }
  }

  async function reloadMaterial() {
    Meta.resetCreate(game, "material")

    const data = Data.readJSON(`${resPath}/material/data.json`, "miao") || {}
    const meta = Meta.create(game, "material")

    if (isSr) {
      const ret = {}
      lodash.forEach(data, (ds, key) => {
        lodash.forEach(ds, (item) => {
          ret[item.name] = { poseType: item.type, type: key, id: item.id, name: item.name, star: item.star }
        })
      })
      meta.addData(ret)
    } else {
      const abbrMod = await Data.importModule(`${resPath}/material/abbr.js`, "miao")
      const dailyMod = await Data.importDefault(`${resPath}/material/daily.js`, "miao")
      if (!dailyMod) return

      const ret = {}
      const abbr2 = {}
      const citys = [ "蒙德", "璃月", "稻妻", "须弥", "枫丹", "纳塔" ]

      lodash.forEach(data, (ds) => {
        const { type, name } = ds
        const tmp = { name, type, star: ds.star }
        if (type === "talent" || type === "weapon") {
          tmp.abbr = (ds.type === "talent" ? Data.regRet(/「(.+)」/, name, 1) : name.slice(0, 4)) || name
          abbr2[name] = tmp.abbr
          lodash.forEach(dailyMod[type], (weekData, week) => {
            const cid = weekData.indexOf(tmp.abbr)
            if (cid !== -1) {
              tmp.week = week * 1
              tmp.city = citys[cid]
              tmp.cid = cid + 1
              return false
            }
          })
        }
        if (ds.items) {
          tmp.items = {}
          lodash.forEach(ds.items, (item) => {
            tmp.items[item.star] = item.name
            ret[item.name] = { name: item.name, type: item.type, star: item.star }
          })
        }
        ret[ds.name] = tmp
      })

      meta.addData(ret)
      meta.addAbbr(abbrMod?.abbr || {})
      meta.addAbbr(abbr2)
      meta.addMeta({ dailyData: dailyMod })
    }
  }
  await reloadArtifact()
  await reloadCharacter()
  await reloadWeapon()
  await reloadMaterial()
}
