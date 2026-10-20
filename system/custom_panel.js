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
