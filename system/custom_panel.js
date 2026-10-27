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

/* 咕咕牛管理器（example/咕咕牛图库管理器.js）把面板图部署到 miao-plugin 的
   resources/profile/normal-character/。miao 插件本身可能已被卸载，
   但那个目录仍可能由咕咕牛管理器维护，所以这里做多候选：
     1. config.panel_custom_art_dir（用户显式配置，优先）
     2. plugins/miao-plugin/resources/profile/normal-character（咕咕牛默认位置）
     3. 本插件 resources/hoyo_panel/images/panel/<game>（用户手动放图）
   全部缺失时返回空串，调用方回落到官方立绘。 */
/* 项目根：以插件根上推两级（plugins/<本插件>），不要依赖 process.cwd()
   —— 从插件目录里跑脚本时 cwd 会变成插件根，路径就全错了。 */
const YZ_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const MIAO_RES = path.join(YZ_ROOT, 'plugins', 'miao-plugin', 'resources')
/** 咕咕牛图库目录候选（按优先级） */
/* 配置通过 #HoYoGet 动态取，避免 system ↔ 入口的循环依赖 */
let _cfgMod = null
async function loadConfigFn() {
  if (_cfgMod) return _cfgMod
  try {
    const m = await import('#HoYoGet')
    _cfgMod = typeof m.config === 'function' ? m.config : () => ({})
  } catch { _cfgMod = () => ({}) }
  return _cfgMod
}

/* 同步版本：只读已缓存的配置；首次调用前由调用方预先 await primeCustomArtConfig() */
let _cfgSnapshot = null
export async function primeCustomArtConfig() {
  if (_cfgSnapshot) return _cfgSnapshot
  const fn = await loadConfigFn()
  try { _cfgSnapshot = fn() || {} } catch { _cfgSnapshot = {} }
  return _cfgSnapshot
}
function readConfigSafe() {
  return _cfgSnapshot || {}
}

/* 咕咕牛图库在云崽 resources/CowCoos 下，按仓库分目录：
     Miao-Plugin-MBT/{gs,sr}-character   主库
     Miao-Plugin-MBT-2/gs-character      原神补充库
     Miao-Plugin-MBT-3/sr-character      星铁补充库
     Miao-Plugin-MBT-4/{gs,sr}-character 综合库
     Communitys/<hash>/normal-character  社区投稿（不区分游戏）
   另外 miao-plugin 被卸载前，咕咕牛管理器可能把图部署到它的 resources 下。 */
const COWCOO_ROOT = path.join(YZ_ROOT, 'resources', 'CowCoos')
const COWCOO_REPOS = ['Miao-Plugin-MBT', 'Miao-Plugin-MBT-2', 'Miao-Plugin-MBT-3', 'Miao-Plugin-MBT-4']

function normalDirCandidates(game = 'gs') {
  const g = ['gs', 'sr', 'zzz'].includes(game) ? game : 'gs'
  const out = []
  try {
    const conf = readConfigSafe() || {}
    const custom = String(conf.panel_custom_art_dir || '').trim()
    if (custom) out.push(path.resolve(YZ_ROOT, custom))
  } catch { /* 配置读不到就跳过 */ }
  // 咕咕牛图库主库与补充库
  for (const repo of COWCOO_REPOS) {
    out.push(path.join(COWCOO_ROOT, repo, `${g}-character`))
  }
  // 社区投稿（目录里没有游戏区分，gs/sr 都试）
  try {
    const community = path.join(COWCOO_ROOT, 'Communitys')
    for (const name of fs.readdirSync(community)) {
      if (name.endsWith('.json') || name.endsWith('.git')) continue
      out.push(path.join(community, name, 'normal-character'))
    }
  } catch { /* 没有社区目录就跳过 */ }
  // 老部署位置（miao 插件存在时咕咕牛管理器的目标）
  out.push(path.join(MIAO_RES, 'profile', 'normal-character'))
  return out
}
const NORMAL_DIR = path.join(MIAO_RES, 'profile', 'normal-character')

/** 目录里挑一张图；没有返回空串。返回路径以 miao resources 为基准（`profile/normal-character/...`） */
function pickInDir(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return ''
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort()
    if (!files.length) return ''
    const file = files[Math.floor(Math.random() * files.length)]
    // 和 miao 一致：文件名里可能有空格/中文，拼进 src 前要编码
    // 目录可能在插件外（咕咕牛自定义目录），统一按 basename 拼，
    // 由 cropCustomPanelArt 用绝对路径实际读取
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
export function pickCustomPanelArt(names = [], game = 'gs') {
  const list = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))]
  for (const base of normalDirCandidates(game)) {
    for (const name of list) {
      for (const variant of [name, `「${name}」`, name.replace(/[「」]/g, '')]) {
        const hit = pickInDir(path.join(base, variant))
        if (hit) return hit
      }
    }
  }
  return ''
}

/** 该角色是否有自定义面板图（不随机，只判存在） */
export function hasCustomPanelArt(names = [], game = 'gs') {
  const list = [...new Set(names.map(n => String(n || '').trim()).filter(Boolean))]
  for (const base of normalDirCandidates(game)) {
    for (const name of list) {
      for (const variant of [name, `「${name}」`, name.replace(/[「」]/g, '')]) {
        try {
          const dir = path.join(base, variant)
          if (fs.statSync(dir).isDirectory()
            && fs.readdirSync(dir).some(f => /\.(png|jpe?g|webp)$/i.test(f))) return true
        } catch { /* 继续试下一个 */ }
      }
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
  const g = ['gs', 'sr', 'zzz'].includes(game) ? game : 'gs'
  for (const name of names.flatMap(n => nameVariants(n))) {
    const dir = path.join(CUSTOM_PANEL_ROOT, g, name)
    try { if (!pickInDir(dir)) { for (const b of normalDirCandidates(g)) { let f2 = []; try { f2 = fs.readdirSync(path.join(b, name)).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort() } catch (e) { } if (f2.length) { const bf = f2[Math.floor(Math.random() * f2.length)]; fs.mkdirSync(dir, { recursive: true }); const dp = path.join(dir, bf); if (!fs.existsSync(dp)) { try { fs.linkSync(path.join(b, name, bf), dp) } catch (e) { fs.copyFileSync(path.join(b, name, bf), dp) } } break } } } } catch (e) { }
  const hit = pickInDir(dir)
    if (!hit) continue
    // pickInDir 返回的是 miao 的格式，这里换算成插件内的路径
    return `hoyo_panel/images/panel/${g}/${encodeURIComponent(name)}/${hit.split('/').pop()}`
  }
  return ''
}

/**
 * 把咕咕牛图库的面板图全量硬链接进本插件目录。
 * 原本只在渲染某个角色时按需同步一个角色，目录长期不全、统计数字还会随访问慢慢增长；
 * 启动后调用一次即可补齐。已存在的文件跳过，不覆盖用户自己上传的图。
 * zzz 走 zzz_panel 软链，不需要同步。
 */
export function syncAllUserPanelArt(games = ['gs', 'sr']) {
  const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp']
  const isImgFile = f => IMG_EXT.some(x => f.toLowerCase().endsWith(x))
  const ret = { roles: 0, files: 0 }
  for (const game of games) {
    if (game !== 'gs' && game !== 'sr') continue
    let names = null
    try {
      names = new Set(fs.readdirSync(path.join(PLUGIN_ROOT, 'resources', 'meta-' + game, 'character')))
    } catch { names = null }
    for (const base of normalDirCandidates(game)) {
      let dirs = []
      try {
        dirs = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
      } catch { continue }
      for (const name of dirs) {
        if (names && !names.has(name)) continue
        const src = path.join(base, name)
        let imgs = []
        try { imgs = fs.readdirSync(src).filter(isImgFile) } catch { continue }
        if (!imgs.length) continue
        const dest = path.join(CUSTOM_PANEL_ROOT, game, name)
        try { fs.mkdirSync(dest, { recursive: true }) } catch { continue }
        let added = false
        for (const file of imgs) {
          const dp = path.join(dest, file)
          if (fs.existsSync(dp)) continue
          try { fs.linkSync(path.join(src, file), dp) } catch { try { fs.copyFileSync(path.join(src, file), dp) } catch { continue } }
          added = true
          ret.files++
        }
        if (added) ret.roles++
      }
    }
  }
  return ret
}
/** 列出某角色自定义目录下的图片文件名（按名字排序） */
export function listUserPanelArt(game, name) {
  const g = ['gs', 'sr', 'zzz'].includes(game) ? game : 'gs'
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
  const g = ['gs', 'sr', 'zzz'].includes(game) ? game : 'gs'
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
  const g = ['gs', 'sr', 'zzz'].includes(game) ? game : 'gs'
  try {
    /* 咕咕牛目录可能被配置到插件外，按候选目录依次找原始文件 */
    let srcAbs = ''
    if (splashLocal) {
      srcAbs = path.join(PLUGIN_ROOT, 'resources', decodeURIComponent(srcRel))
    } else {
      const rel = decodeURIComponent(srcRel).replace(/^profile\/normal-character\//, '')
      for (const base of normalDirCandidates(g)) {
        const candidate = path.join(base, rel)
        if (fs.existsSync(candidate)) { srcAbs = candidate; break }
      }
      if (!srcAbs) srcAbs = path.join(MIAO_RES, decodeURIComponent(srcRel))
    }
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
