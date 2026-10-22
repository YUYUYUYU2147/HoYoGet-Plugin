/**
 * 自定义面板图管理（锅巴用）。
 *
 * 图片放在 resources/hoyo_panel/images/panel/<游戏>/<角色>/ 下，
 * 由「#米哈游上传<角色>面板图」命令或手工拷贝放入。这里只做列目录、
 * 取文件列表与删除，不涉及上传（上传仍走命令）。
 *
 * 游戏键：gs = 原神，sr = 星铁，zzz = 绝区零。
 *
 * 另支持「咕咕牛图库」只读浏览：图片在宿主仓库
 * resources/CowCoos/<repo>/<game>-character/<角色>/ 下，分散在多个
 * repo 目录（主库 + 分库 -2/-3/-4），这里聚合列出，不做删除/上传。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_ROOT = path.join(ROOT, 'resources', 'hoyo_panel', 'images', 'panel')

/** 咕咕牛图库根：宿主仓库根下的 resources/CowCoos（插件根上两级） */
const YZ_ROOT = path.resolve(ROOT, '..', '..')
const COWCOO_ROOT = path.join(YZ_ROOT, 'resources', 'CowCoos')

export const GAME_NAMES = { gs: '原神', sr: '崩坏：星穹铁道', zzz: '绝区零' }

export const PANEL_GAMES = ['gs', 'sr', 'zzz']
export const COWCOO_GAMES = ['gs', 'sr', 'zzz', 'waves']

function gameKey(g) {
  return PANEL_GAMES.includes(g) ? g : 'gs'
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

/* ───────── 咕咕牛图库（只读浏览） ───────── */

/** 列出咕咕牛图库根下所有 repo 目录（排除 .git 等非图库目录） */
function cowCooRepos() {
  try {
    return fs.readdirSync(COWCOO_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
  } catch {
    return []
  }
}

/** 某游戏在咕咕牛图库里出现过的所有 <repo>/<game>-character 目录 */
function cowCooCharDirs(game) {
  const dirs = []
  for (const repo of cowCooRepos()) {
    const d = path.join(COWCOO_ROOT, repo, `${game}-character`)
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) dirs.push(d)
  }
  return dirs
}

/** 列出咕咕牛图库某游戏下所有角色（跨 repo 去重），返回带图片的角色列表 */
export function listCowCooPanels(game = 'gs') {
  if (!COWCOO_GAMES.includes(game)) return []
  const nameSet = new Map()
  for (const dir of cowCooCharDirs(game)) {
    let names = []
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      continue
    }
    for (const name of names) {
      const files = imageFiles(path.join(dir, name))
      if (!files.length) continue
      const cur = nameSet.get(name)
      if (!cur) {
        nameSet.set(name, { game, name, files })
      } else {
        const merged = new Set([...cur.files, ...files])
        cur.files = [...merged].sort()
      }
    }
  }
  return [...nameSet.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 某角色在咕咕牛图库里的图片文件（跨 repo 聚合） */
export function listCowCooFiles(game, name) {
  const n = safeName(name)
  const files = new Set()
  for (const dir of cowCooCharDirs(game)) {
    for (const f of imageFiles(path.join(dir, n))) files.add(f)
  }
  return [...files].sort()
}

/**
 * 咕咕牛图库图片绝对路径：优先返回存在该文件的 repo 目录。
 * 因为同一角色跨 repo 可能重名文件，按「第一个存在该文件」返回。
 */
export function cowCooFilePath(game, name, file) {
  const n = safeName(name)
  const f = path.basename(String(file || ''))
  for (const dir of cowCooCharDirs(game)) {
    const abs = path.join(dir, n, f)
    if (fs.existsSync(abs)) return abs
  }
  return ''
}

export default {
  listPanels, listFiles, panelFilePath, deletePanelFile, saveUploadedFiles,
  listCowCooPanels, listCowCooFiles, cowCooFilePath,
  GAME_NAMES, PANEL_GAMES, COWCOO_GAMES,
}
