/**
 * 自定义面板图管理（锅巴用）。
 *
 * 图片放在 resources/hoyo_panel/images/panel/<游戏>/<角色>/ 下，
 * 由「#米哈游上传<角色>面板图」命令或手工拷贝放入。这里只做列目录、
 * 取文件列表与删除，不涉及上传（上传仍走命令）。
 *
 * 游戏键：gs = 原神，sr = 星铁。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_ROOT = path.join(ROOT, 'resources', 'hoyo_panel', 'images', 'panel')

export const GAME_NAMES = { gs: '原神', sr: '崩坏：星穹铁道' }

function gameKey(g) {
  return g === 'sr' ? 'sr' : 'gs'
}

function safeName(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '').trim()
}

function imageFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()
  } catch {
    return []
  }
}

/** 列出某游戏下所有有图角色 */
export function listPanels(game = 'gs') {
  const g = gameKey(game)
  const base = path.join(PANEL_ROOT, g)
  let names = []
  try {
    names = fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const files = imageFiles(path.join(base, name))
    if (!files.length) continue
    out.push({ game: g, name, files })
  }
  return out
}

/** 某角色的图片文件列表 */
export function listFiles(game, name) {
  const g = gameKey(game)
  const n = safeName(name)
  const dir = path.join(PANEL_ROOT, g, n)
  return imageFiles(dir)
}

/** 图片绝对路径（给 res.sendFile 用） */
export function panelFilePath(game, name, file) {
  const g = gameKey(game)
  const n = safeName(name)
  const f = path.basename(String(file || ''))
  const abs = path.join(PANEL_ROOT, g, n, f)
  return fs.existsSync(abs) ? abs : ''
}

/** 删除一张图；删完目录为空则一并移除目录 */
export function deletePanelFile(game, name, file) {
  const abs = panelFilePath(game, name, file)
  if (!abs) return false
  try {
    fs.unlinkSync(abs)
    const dir = path.dirname(abs)
    if (imageFiles(dir).length === 0) {
      try { fs.rmdirSync(dir) } catch { /* 非空或权限问题就算了 */ }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 把 multer 落盘的临时文件搬进目标角色的面板图目录。
 * @param {string} game gs | sr
 * @param {string} name 角色名
 * @param {Array<{path:string, originalname:string}>} files multer 的 req.files
 * @returns {{saved: string[], skipped: string[]}}
 */
export function saveUploadedFiles(game, name, files = []) {
  const g = gameKey(game)
  const n = safeName(name)
  if (!n) throw new Error('角色名不能为空')
  const dir = path.join(PANEL_ROOT, g, n)
  fs.mkdirSync(dir, { recursive: true })
  const list = Array.isArray(files) ? files : [files]
  const saved = []
  const skipped = []
  for (const f of list) {
    if (!f?.path || !f?.originalname) continue
    const base = path.basename(String(f.originalname))
    if (!/\.(png|jpe?g|webp)$/i.test(base)) {
      skipped.push(base)
      try { fs.unlinkSync(f.path) } catch { /* 清临时失败就算了 */ }
      continue
    }
    let target = path.join(dir, base)
    if (fs.existsSync(target)) {
      const ext = path.extname(base)
      target = path.join(dir, `${path.basename(base, ext)}-${Date.now().toString(36)}${ext}`)
    }
    try {
      fs.renameSync(f.path, target)
      saved.push(path.basename(target))
    } catch {
      // 跨文件系统 rename 失败时退回复制 + 删临时
      fs.copyFileSync(f.path, target)
      try { fs.unlinkSync(f.path) } catch { /* 忽略 */ }
      saved.push(path.basename(target))
    }
  }
  return { saved, skipped }
}

export default { listPanels, listFiles, panelFilePath, deletePanelFile, saveUploadedFiles, GAME_NAMES }
