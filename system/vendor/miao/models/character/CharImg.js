/**
 * 角色照片及角色图像资源相关
 */
import fs from "node:fs"
import lodash from "lodash"
import sizeOf from "image-size"
import { miaoPath } from "#hoyo.miao.path"

const rPath = `${miaoPath}/resources`

/* 资源根：本插件 resources 优先，外部 miao-plugin 作为兜底。
   内置模型被搬进插件后，原实现仍写死 ./plugins/miao-plugin/resources，
   miao 未安装时目录扫描恒为空，表现为头像、立绘全丢。 */
const RES_ROOTS = [ rPath, "./plugins/miao-plugin/resources" ]
const resolveRes = function(rel) {
  for (const root of RES_ROOTS) {
    const p = `${root}/${rel}`
    if (fs.existsSync(p)) return p
  }
  return `${RES_ROOTS[0]}/${rel}`
}

// 目录图片列表与图片尺寸缓存，TTL 60s：消除同一批出图内的重复读盘，新上传图片≤1分钟生效
const _dirCache = new Map()
const _sizeCache = new Map()
const _CACHE_TTL = 60 * 1000

const readImgDir = function(charImgPath) {
  let now = Date.now()
  let cached = _dirCache.get(charImgPath)
  if (cached && now - cached.time < _CACHE_TTL) return cached.imgs
  let dirPath = resolveRes(charImgPath)
  let imgs = []
  if (fs.existsSync(dirPath)) {
    imgs = fs.readdirSync(dirPath)
      .filter((img) => /\.(png|jpg|webp|jpeg)/i.test(img))
      .map((img) => `${charImgPath}/${img}`)
  }
  _dirCache.set(charImgPath, { time: now, imgs })
  return imgs
}

const getImgSize = function(img) {
  let cached = _sizeCache.get(img)
  if (cached) return cached
  let ret = sizeOf(resolveRes(img))
  _sizeCache.set(img, ret)
  return ret
}

const CharImg = {

  // 获取角色的插画
  getCardImg(names, se = false, def = true) {
    let list = []
    let addImg = function(charImgPath) {
      for (let img of readImgDir(charImgPath)) list.push(img)
    }
    if (!lodash.isArray(names)) names = [ names ]
    for (let name of names) {
      addImg(`character-img/${name}`)
      addImg(`character-img/${name}/upload`)
      if (se) addImg(`character-img/${name}/se`)
      const plusPath = resolveRes("miao-res-plus") + "/"
      if (fs.existsSync(plusPath)) {
        addImg(`miao-res-plus/character-img/${name}`)
        if (se) addImg(`miao-res-plus/character-img/${name}/se`)
      }
    }
    let img = lodash.sample(list)
    if (!img) return false
    let ret = getImgSize(img)
    ret.img = img
    ret.mode = ret.width > ret.height ? "left" : "bottom"
    return ret
  },

  getRandomImg(imgPaths, defImgs = []) {
    for (let imgPath of imgPaths) {
      let ret = []
      for (let type of [ "webp", "png" ]) {
        if (fs.existsSync(`${rPath}/${imgPath}.${type}`)) ret.push(imgPath + `.${type}`)
      }
      if (fs.existsSync(`${rPath}/${imgPath}`)) {
        let imgs = fs.readdirSync(`${rPath}/${imgPath}`).filter((file) => {
          return /\.(png|webp)$/.test(file)
        })
        for (let img of imgs) {
          ret.push(`${imgPath}/${encodeURIComponent(img)}`)
        }
      }
      if (ret.length > 0) return lodash.sample(ret)
    }
    for (let defImg of defImgs) {
      if (fs.existsSync(`${rPath}/${defImg}`)) return defImg
    }
  },

  // 获取角色的图像资源数据
  getImgs(name, costumeIdx = "", travelerElem = "", weaponType = "sword", talentCons) {
    costumeIdx = costumeIdx === "2" ? "2" : ""
    let imgs = {}
    if (![ "空", "荧", "旅行者" ].includes(name)) travelerElem = ""
    const nPath = `/meta-gs/character/${name}/`
    const tPath = `/meta-gs/character/旅行者/${travelerElem}/`
    let add = (key, path, path2) => {
      let fileType = "webp"
      // 表情包及自定义头像为png格式
      if (key === "bFace" || key === "zFace") fileType = "png"
      if (path2 && fs.existsSync(`${rPath}/${nPath}/${path2}.${fileType}`)) {
        imgs[key] = `${nPath}${path2}.${fileType}`
      } else if (fs.existsSync(`${rPath}/${nPath}/${path}.${fileType}`)) {
        imgs[key] = `${nPath}${path}.${fileType}`
      }
    }
    let tAdd = (key, path) => {
      imgs[key] = `${travelerElem ? tPath : nPath}${path}.webp`
    }
    add("face", "imgs/face", `imgs/face${costumeIdx}`)
    add("qFace", "imgs/face", "imgs/face-q")
    add("bFace", "imgs/face-b")
    add("zFace", "imgs/face-z")
    add("side", "imgs/side", `imgs/side${costumeIdx}`)
    add("gacha", "imgs/gacha")
    add("splash", "imgs/splash", `imgs/splash${costumeIdx}`)
    tAdd("card", "imgs/card")
    tAdd("banner", "imgs/banner")
    for (let i = 1; i <= 6; i++) {
      tAdd(`cons${i}`, `icons/cons-${i}`)
    }
    for (let i = 0; i <= 4; i++) {
      tAdd(`passive${i}`, `icons/passive-${i}`)
    }
    imgs.a = `/common/item/atk-${weaponType}.webp`
    for (let t of [ "e", "q" ]) {
      imgs[t] = talentCons[t] > 0 ? imgs[`cons${talentCons[t]}`] : `${nPath}icons/talent-${t}.webp`
    }
    return imgs
  },

  // 获取星铁角色图像资源
  getImgsSr(name, talentCons) {
    const nPath = `/meta-sr/character/${name}/`
    let imgs = {}
    let add = (key, path, path2) => {
      let fileType = "webp"
      // 表情包及自定义头像为png格式
      if (key === "bFace" || key === "zFace") fileType = "png"
      if (path2 && fs.existsSync(`${rPath}/${nPath}/${path2}.${fileType}`)) {
        imgs[key] = `${nPath}${path2}.${fileType}`
      } else if (fs.existsSync(`${rPath}/${nPath}/${path}.${fileType}`)) {
        imgs[key] = `${nPath}${path}.${fileType}`
      }
    }
    add("face", "imgs/face")
    add("qFace", "imgs/face", "imgs/face-q")
    add("bFace", "imgs/face-b")
    add("zFace", "imgs/face-z")
    add("splash", "imgs/splash")
    add("preview", "imgs/preview")
    for (let i = 1; i <= 4; i++) {
      add(`tree${i}`, `imgs/tree-${i}`)
    }
    for (let key of [ "a", "e", "q", "t", "z", "j", "as", "a2", "e2", "q2", "me", "me2", "mt", "mt1", "mt2" ]) {
      add(key, `imgs/talent-${key}`)
    }
    for (let i = 1; i <= 6; i++) {
      if (i !== 3 && i !== 5) add(`cons${i}`, `imgs/cons-${i}`)
    }
    imgs.banner = "meta-sr/character/common/imgs/banner.webp"
    imgs.card = "meta-sr/character/common/imgs/card.webp"
    imgs.cons3 = imgs[talentCons[3]]
    imgs.cons5 = imgs[talentCons[5]]
    return imgs
  }
}
export default CharImg
