/**
 * 采集绝区零音擎 / 驱动盘套装的静态事实 → system/default/zzz_item_stat.json
 *
 * ## 为什么需要
 *
 * 极限面板脱离面板记录独立出图后，音擎与驱动盘不能再从记录里读 —— 必须自带：
 *   - id → 名称 / 稀有度 / 职司限制 / 基础属性 / 副词条 / 被动描述（按精炼档）
 *   - 套装：名称 / 2件&4件效果 / 本地图标文件名
 * 这些全是**游戏公开数据**，只取值不取逻辑。
 *
 * ## 图标来源（重要）
 *
 * 图片本身不在本插件里，而是引用已安装的 ZZZ-Plugin 资源目录：
 *   立绘 resources/images/role/IconRole<NN>.png
 *   音擎 resources/images/weapon/<CodeName>_High.png
 *   套装 resources/images/suit/<sprite_file>.png
 * 理由：那批图有 916MB，复制进本插件不现实；插件本来就已依赖 ZZZ-Plugin 的
 * mysapi.js。**若未安装 ZZZ-Plugin，图标会取不到，面板仍能出（只是没图）**，
 * 已在运行时做降级处理。
 *
 * 用法：node tools/extract_zzz_item_stat.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'system', 'default', 'zzz_item_stat.json')

const ZZZ = [
  path.join(process.cwd(), 'plugins', 'ZZZ-Plugin'),
  path.join(ROOT, '..', 'ZZZ-Plugin'),
].find(p => fs.existsSync(path.join(p, 'resources', 'map', 'WeaponId2Data.json')))
if (!ZZZ) {
  console.error('找不到 ZZZ-Plugin 的 resources/map')
  process.exit(1)
}

const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
const weapons = JSON.parse(fs.readFileSync(path.join(ZZZ, 'resources/map/WeaponId2Data.json'), 'utf8'))
const suits = JSON.parse(fs.readFileSync(path.join(ZZZ, 'resources/map/SuitData.json'), 'utf8'))

const wq = {}
for (const id of Object.keys(weapons)) {
  const x = weapons[id]
  const file = `${x.CodeName}_High`
  const talents = {}
  for (const lv of Object.keys(x.Talents || {})) {
    const t = x.Talents[lv]
    if (t?.Desc) talents[lv] = strip(t.Desc)
  }
  wq[id] = {
    name: x.Name,
    rarity: x.Rarity,
    // WeaponType 是对象，如 {"3":"异常"}
    professions: Object.values(x.WeaponType || {}),
    // 主词条（基础攻击力/基础防御力）与副词条各一条
    main: x.BaseProperty ? { pid: Number(x.BaseProperty.Id), name: x.BaseProperty.Name, value: Number(x.BaseProperty.Value) } : null,
    sub: x.RandProperty ? { pid: Number(x.RandProperty.Id), name: x.RandProperty.Name, value: Number(x.RandProperty.Value) } : null,
    // 被动按精炼档：1~5
    talents,
    sprite: file,
  }
}

const st = {}
for (const id of Object.keys(suits)) {
  const x = suits[id]
  st[id] = {
    name: x.name,
    desc2: strip(x.desc1),      // 2 件套
    desc4: strip(x.desc2),      // 4 件套
    sprite: x.sprite_file,
  }
}

const payload = {
  _comment: '绝区零音擎与驱动盘套装静态事实（名称/稀有度/职司/主副词条/被动/套装效果/图标文件名）。数值均为游戏公开数据。图标文件本体在 ZZZ-Plugin 的 resources/images 下，本表只存文件名，未安装 ZZZ-Plugin 时图标取不到但面板照常出图。重生成：node tools/extract_zzz_item_stat.mjs',
  _source: 'ZZZ-Plugin resources/map/{WeaponId2Data,SuitData}.json（只读事实表）',
  weaponCount: Object.keys(wq).length,
  suitCount: Object.keys(st).length,
  weapons: wq,
  suits: st,
}
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1), 'utf-8')
console.log(`写入 ${OUT}：音擎 ${payload.weaponCount} / 套装 ${payload.suitCount}，${(fs.statSync(OUT).size / 1024).toFixed(1)}KB`)

// 覆盖率自检：预设里用到的音擎/套装是否都能查到
const preset = fs.readFileSync(path.join(ROOT, 'system/default/zzz_extreme.yaml'), 'utf8')
const usedW = [...preset.matchAll(/^\s*weapon_id:\s*(\d+)/gm)].map(m => m[1])
const missW = [...new Set(usedW)].filter(id => !wq[id])
console.log(`预设引用音擎 ${new Set(usedW).size} 个，查不到：${missW.length ? missW.join(' ') : '无'}`)