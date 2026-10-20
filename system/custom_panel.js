// 咕咕牛图库（CowCoos）自定义面板图
//
// 咕咕牛管理器把下载的角色面板图部署到 miao-plugin 的
//   plugins/miao-plugin/resources/profile/normal-character/<角色名>/
// 一张角色可能有多张（雷电将军 40+ 张），miao 自己的面板也是从这个目录随机取。
// 这里同样随机取一张，返回「相对 miao 的 resources」的路径，
// 模板里已经用 {{_miao_path}} 拼前缀，所以格式与 miao 的 imgs.* 一致。
//
// 找不到就返回空串，调用方回落到官方立绘，不影响出图。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 本插件自己的自定义面板目录：resources/hoyo_panel/images/panel/<游戏>/<角色>/ */
export const CUSTOM_PANEL_ROOT = path.join(PLUGIN_ROOT, 'resources', 'hoyo_panel', 'images', 'panel')
/** 裁掉左侧二维码信息栏后的缓存目录（自动生成，不入库） */
export const CUSTOM_PANEL_CROP_ROOT = path.join(PLUGIN_ROOT, 'resources', 'hoyo_panel', 'images', 'panel_crop')

const MIAO_RES = path.join(process.cwd(), 'plugins', 'miao-plugin', 'resources')
const NORMAL_DIR = path.join(MIAO_RES, 'profile', 'normal-character')

/** 目录里挑一张图；没有返回空串 */
function pickInDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return ''
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    if (!files.length) return ''
    const file = files[Math.floor(Math.random() * files.length)]
    // 和 miao 一致：文件名里可能有空格/中文，拼进 src 前要编码
    return `profile/normal-character/${path.basename(dir)}/${encodeURIComponent(file)}`
  } catch {
    return ''
  }
}

/**
 * 取角色的自定义面板图（相对 miao resources 的路径）。
 * @param {string[]} names 依次尝试的角色名（正式名、别名）
 * @returns {string} 形如 profile/normal-character/雷电将军/%E9%9B%B7...webp
 */
export function pickCustomPanelArt(names = []) {
  const list = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))]
  for (const name of list) {
    for (const variant of [name, `「${name}」`, name.replace(/[「」]/g, '')]) {
      const hit = pickInDir(path.join(NORMAL_DIR, variant))
      if (hit) return hit
    }
  }
  return ''
}

/** 该角色是否有自定义面板图（不随机，只判存在） */
export function hasCustomPanelArt(names = []) {
  const list = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))]
  for (const name of list) {
    for (const variant of [name, `「${name}」`, name.replace(/[「」]/g, '')]) {
      try {
        const dir = path.join(NORMAL_DIR, variant)
        if (fs.statSync(dir).isDirectory()
          && fs.readdirSync(dir).some(f => /\.(png|jpe?g|webp)$/i.test(f))) return true
      } catch { /* 继续试下一个 */ }
    }
  }
  return false
}


/** 角色在自定义目录里的文件夹（兼容「XX」式写法） */
function nameVariants(name) {
  const n = String(name || '').trim()
  if (!n) return []
  return [...new Set([n, `「${n}」`, n.replace(/[「」]/g, '')])]
}

/**
 * 本插件自定义面板图（resources/hoyo_panel/images/panel/<game>/<角色>/）。
 * @returns {string} 相对插件 resources 的路径，如 hoyo_panel/images/panel/gs/雷电将军/x.webp
 */
export function pickUserPanelArt(game, names = []) {
  const g = game === 'sr' ? 'sr' : 'gs'
  for (const name of names.flatMap(n => nameVariants(n))) {
    const dir = path.join(CUSTOM_PANEL_ROOT, g, name)
    const hit = pickInDir(dir)
    if (!hit) continue
    // pickInDir 返回的是 miao 的格式，这里换算成插件内的路径
    return `hoyo_panel/images/panel/${g}/${encodeURIComponent(name)}/${hit.split('/').pop()}`
  }
  return ''
}

/** 列出某角色自定义目录下的图片文件名（按名字排序） */
export function listUserPanelArt(game, name) {
  const g = game === 'sr' ? 'sr' : 'gs'
  for (const n of nameVariants(name)) {
    const dir = path.join(CUSTOM_PANEL_ROOT, g, n)
    try {
      const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()
      if (files.length) return { dir, name: n, files }
    } catch { /* 试下一个写法 */ }
  }
  return { dir: path.join(CUSTOM_PANEL_ROOT, g, String(name || '').trim()), name: String(name || '').trim(), files: [] }
}

/** 上传用的目标目录（不存在就建） */
export function ensureUserPanelDir(game, name) {
  const g = game === 'sr' ? 'sr' : 'gs'
  const dir = path.join(CUSTOM_PANEL_ROOT, g, String(name || '').trim())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}


/**
 * 咕咕牛图库的面板图左侧带二维码/编号信息栏，直接当立绘会露出来。
 * 按比例裁掉左侧（默认 24%，1280 宽的图约 307px，正好切在二维码栏右缘），
 * 结果写到 panel_crop/<game>/<hash>.webp 缓存；返回插件内相对路径。
 *
 * @param {string} splash miao 目录下的相对路径（profile/normal-character/...）
 * @param {string} splashLocal 本插件目录下的相对路径（hoyo_panel/images/panel/...）
 * @param {string} game gs | sr
 * @param {number} ratio 左侧裁切比例，0 < ratio < 0.5
 * @returns {Promise<string>} 裁切后的插件内相对路径；失败返回空串
 */
export async function cropCustomPanelArt(splash = '', splashLocal = '', game = 'gs', ratio = 0.24) {
  const srcRel = splashLocal || splash
  if (!srcRel) return ''
  const r = Number(ratio)
  if (!Number.isFinite(r) || r <= 0 || r >= 0.5) return ''
  const g = game === 'sr' ? 'sr' : 'gs'
  try {
    const srcAbs = splashLocal
      ? path.join(PLUGIN_ROOT, 'resources', decodeURIComponent(srcRel))
      : path.join(MIAO_RES, decodeURIComponent(srcRel))
    if (!fs.existsSync(srcAbs)) return ''
    const stat = fs.statSync(srcAbs)
    const key = crypto.createHash('sha1')
      .update(`${srcAbs}|${stat.size}|${stat.mtimeMs}|${r}`)
      .digest('hex').slice(0, 16)
    const destRel = `hoyo_panel/images/panel_crop/${g}/${key}.webp`
    const destAbs = path.join(PLUGIN_ROOT, 'resources', destRel)
    if (fs.existsSync(destAbs)) return destRel
    const meta = await sharp(srcAbs).metadata()
    const width = Number(meta.width) || 0
    const height = Number(meta.height) || 0
    const left = Math.round(width * r)
    if (!width || !height || left <= 0 || left >= width) return ''
    fs.mkdirSync(path.dirname(destAbs), { recursive: true })
    await sharp(srcAbs)
      .extract({ left, top: 0, width: width - left, height })
      .webp({ quality: 92 })
      .toFile(destAbs)
    return destRel
  } catch {
    return ''
  }
}
