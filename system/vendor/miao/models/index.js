import fs from "node:fs"
import Base from "./Base.js"
import Character from "../wiki/models/Character.js"
import Artifact from "../wiki/models/Artifact.js"
import ArtifactSet from "./ArtifactSet.js"
import Abyss from "./Abyss.js"
import RoleCombat from "./RoleCombat.js"
import HardChallenge from "./HardChallenge.js"
import Player from "./Player.js"
import Avatar from "./Avatar.js"
import ProfileDmg from "./ProfileDmg.js"
import ProfileRank from "./ProfileRank.js"
import Material from "../wiki/models/Material.js"
import Weapon from "../wiki/models/Weapon.js"
import User from "./User.js"
import MysApi from "./MysApi.js"
import Button from "./Button.js"
import { miaoPath, rootPath } from "#hoyo.miao.path"

/* 内置版：只从自己的 meta 根加载（resources/meta-gs｜meta-sr）。
   原实现优先读 plugins/wiki/resources 下的副本，那两个文件按 wiki 的 package
   作用域解析 #miao 会失败，导致角色表为空。 */
const moduleLogger = globalThis.logger
for (let game of [ "gs", "sr" ]) {
  for (let type of [ "artifact", "character", "material", "weapon" ]) {
    const file = `${miaoPath}/resources/meta-${game}/${type}/index.js`
    if (!fs.existsSync(file)) continue
    try {
      await import(`file://${file}`)
    } catch (e) {
      moduleLogger?.error?.(`[HoYoGet][vendor] 加载 meta-${game}/${type} 失败：${e?.message || e}`)
    }
  }
}

export {
  Base,
  Abyss,
  RoleCombat,
  HardChallenge,
  Button,
  Character,
  Artifact,
  ArtifactSet,
  Avatar,
  ProfileDmg,
  ProfileRank,
  Material,
  Weapon,
  User,
  MysApi,
  Player
}
