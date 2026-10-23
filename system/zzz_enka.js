/**
 * Enka 面板数据兜底（绝区零）。
 *
 * 米游社 avatar/basic、avatar/info 只返回账号「展示柜」里的部分角色，
 * 且不同账号展示柜内容不同（有的只有最近上线的几个新角色），老角色
 * （叶瞬光 / 雅 / 艾莲 等）查不到详情、算不出评分。
 *
 * Enka（https://enka.network/api/zzz/uid/<uid>）返回 ShowcaseDetail.AvatarList，
 * 含角色完整驱动盘（主/副词条）、音擎、技能等级，能补齐米游社拿不到的角色。
 * 这里把 Enka 的字段转成本插件 normalizeDetail/calcEquipScore 认识的结构
 * （对齐米游社 avatar/info 的 avatar_list[i]）。
 *
 * 安全：纯 GET 公开接口、只读、不携带 CK。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP_DIR = path.join(PLUGIN_ROOT, 'resources', 'zzz', 'map')
const ENKA_BASE = 'https://enka.network/api/zzz/uid/'
const UA = 'ZZZ-Plugin/UCPr'

/** 百分比类属性 id（与 ZZZ-Plugin formater.js 的 percentPropId 一致） */
const PERCENT_IDS = new Set([11102, 12102, 12202, 13102, 20103, 21103, 23103, 30502, 31402, 31503, 31603, 31703, 31803, 31903, 32303])
function isPercent(propId) {
  return PERCENT_IDS.has(Number(propId))
}
/** 驱动盘稀有度：id 第 4 位 4=S、3=A、2=B（对齐 ZZZ-Plugin Rarity 枚举） */
const EQUIP_RARITY = { 4: 'S', 3: 'A', 2: 'B' }

let _partner = null
let _suit = null
function partnerMap() {
  if (_partner) return _partner
  try { _partner = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'PartnerId2Data.json'), 'utf8')) } catch { _partner = {} }
  return _partner
}
function suitMap() {
  if (_suit) return _suit
  try { _suit = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'SuitData.json'), 'utf8')) } catch { _suit = {} }
  return _suit
}

function fmtProp(propId, value, pct) {
  const n = Number(value) || 0
  if (pct) {
    const v = n / 100
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}%`
  }
  return String(Math.trunc(n))
}

/** 米游社列表用方形头像；Enka 不返回图标，这里用本地 ZZZ-Plugin 立绘或 nanoka 镜像补上 */
function roleIcon(info) {
  const sprite = info?.sprite_id
  if (!sprite) return ''
  const local = path.join(process.cwd(), 'plugins', 'ZZZ-Plugin', 'resources', 'images', 'nanoka', 'role', `IconRole${sprite}_01.webp`)
  try { return `data:image/webp;base64,${fs.readFileSync(local).toString('base64')}` } catch { /* 没装 ZZZ-Plugin 就用镜像 */ }
  return `https://static.nanoka.cc/assets/zzz/IconRole${sprite}_01.webp`
}

let _weapon = null
function weaponMap() {
  if (_weapon) return _weapon
  try { _weapon = JSON.parse(fs.readFileSync(path.join(MAP_DIR, 'WeaponId2Data.json'), 'utf8')) } catch { _weapon = {} }
  return _weapon
}

function convertEquip(equipSlot) {
  const eq = equipSlot?.Equipment
  if (!eq?.Id) return null
  const id = String(eq.Id)
  const suitId = Number(`${id.slice(0, 3)}00`)
  const suit = suitMap()[String(suitId)]
  const rarityChar = id[3]
  const rarity = EQUIP_RARITY[rarityChar] || 'S'
  const mainProps = (eq.MainPropertyList || []).map(p => {
    const pid = Number(p.PropertyId)
    return { property_id: pid, property_name: '', base: fmtProp(pid, p.PropertyValue, isPercent(pid)), level: Number(p.PropertyLevel) || 0 }
  })
  const subProps = (eq.RandomPropertyList || []).map(p => {
    const pid = Number(p.PropertyId)
    const lv = Number(p.PropertyLevel) || 0
    return { property_id: pid, property_name: '', base: fmtProp(pid, p.PropertyValue * lv, isPercent(pid)), level: lv }
  })
  return {
    id: eq.Id,
    level: Number(eq.Level) || 0,
    name: suit ? `${suit.name}[${equipSlot.Slot}]` : `驱动盘${id}`,
    icon: '',
    rarity,
    equipment_type: Number(equipSlot.Slot) || 0,
    main_properties: mainProps,
    properties: subProps,
    equip_suit: { suit_id: suitId, name: suit?.name || '', own: 0 },
    invalid_property_cnt: 0,
    all_hit: false,
  }
}

/**
 * 拉某 uid 的 Enka 面板，返回 { playerInfo, avatars }。
 * avatars 结构与米游社 avatar/info 的 avatar_list 项尽量对齐（id/level/name_mi18n/
 * equip/weapon/skills/rank...），供 normalizeDetail/calcEquipScore 复用。
 */
export async function fetchEnkaPanel(uid, { timeout = 15000 } = {}) {
  const res = await fetch(`${ENKA_BASE}${uid}`, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`Enka HTTP ${res.status}`)
  const data = await res.json()
  const sd = data?.PlayerInfo?.ShowcaseDetail
  const list = sd?.AvatarList
  if (!Array.isArray(list) || !list.length) throw new Error('Enka 未返回展示柜角色')

  const partners = partnerMap()
  const avatars = list.map(a => {
    const id = Number(a.Id)
    const info = partners[String(id)] || {}
    const equips = (a.EquippedList || []).map(convertEquip).filter(Boolean)
    // Enka 的 equip_suit.own 需要按套装计数，这里补上
    const suitCount = {}
    for (const e of equips) {
      const sid = e.equip_suit?.suit_id
      if (sid) suitCount[sid] = (suitCount[sid] || 0) + 1
    }
    for (const e of equips) if (e.equip_suit?.suit_id) e.equip_suit.own = suitCount[e.equip_suit.suit_id]

    const w = a.Weapon || {}
    const wData = w.Id ? (weaponMap()[String(w.Id)] || {}) : {}
    const weapon = w.Id ? {
      id: w.Id,
      level: Number(w.Level) || 0,
      star: Number(w.BreakLevel) || 0,
      rarity: String(w.Id)[5] === '1' ? 'S' : 'A',
      name: wData.Name || '',
      icon: '',
      main_properties: (w.MainPropertyList || []).map(p => ({ property_id: Number(p.PropertyId), property_name: '', base: fmtProp(Number(p.PropertyId), p.PropertyValue, isPercent(p.PropertyId)) })),
      properties: (w.RandomPropertyList || []).map(p => ({ property_id: Number(p.PropertyId), property_name: '', base: '' })),
    } : null

    const skills = (a.SkillLevelList || []).map(s => ({ skill_type: Number(s.Index), level: Number(s.Level) || 0 }))
    const rank = Number(a.TalentLevel) || 0
    return {
      id,
      level: Number(a.Level) || 0,
      name_mi18n: info.name || '',
      full_name_mi18n: info.full_name || info.name || '',
      element_type: Number(info.ElementType) || 0,
      avatar_profession: Number(info.WeaponType) || 0,
      rarity: info.Rarity || 'A',
      rank,
      ranks: [],
      role_square_url: roleIcon(info),
      equip: equips,
      weapon,
      skills,
      properties: [], // Enka 不给角色面板基础属性终值，评分用驱动盘即可
      _fromEnka: true,
    }
  })

  const profile = data?.PlayerInfo?.SocialDetail?.ProfileDetail || {}
  return {
    avatars,
    playerInfo: { nickname: profile.Nickname || '', level: profile.Level || 0, uid },
  }
}
