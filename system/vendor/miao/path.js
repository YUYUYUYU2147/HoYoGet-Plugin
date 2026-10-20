/**
 * 本插件内置的 miao 数据层（vendor）路径。
 *
 * 代码来自 miao-plugin（作者 Yoimiya-Kokomi，MIT/开源，见其 README），
 * 搬进来的目的是让面板不再 import 外部插件，miao 卸载后仍能跑。
 * 静态数据与图片另放：这里给出可配置的资源根目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* 上游代码里有裸 logger 引用（Yunzai 全局）。这里兜一个最小实现，
   保证脱离 Yunzai 进程（单测/脚本）加载时不会 ReferenceError。 */
if (typeof globalThis.logger === 'undefined') {
  const noop = () => {}
  globalThis.logger = { mark: noop, info: noop, warn: noop, error: noop, debug: noop, yellow: s => s, green: s => s, red: s => s }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// vendor 根（system/vendor/miao）
const vendorPath = __dirname
// 插件根
const pluginPath = path.join(__dirname, '..', '..', '..')
// yunzai 根
const rootPath = path.join(pluginPath, '..', '..')

/**
 * 静态数据（meta-gs / meta-sr）根目录，按顺序找：
 *   1. 配置 panel_meta_root（绝对路径或相对插件根）
 *   2. 插件自己的 resources/meta-gs｜meta-sr（若已拷入）
 *   3. 外部 miao-plugin/resources（兼容老用户，图都还在那儿）
 *
 * 不能只看「有没有角色立绘」：插件自带的 resources 可能只拷了数据 + imgs，
 * 而命座/天赋图标在 character/<名>/icons/、元素与武器图标在 common/ 下。
 * 选到这种「半套」目录时，立绘正常但命座、天赋、元素图标全部 404。
 * 所以按资源完整度打分，分高的优先。
 */
function hasDir(p) {
  try { return fs.statSync(p).isDirectory() } catch (_) { return false }
}
function hasFiles(p) {
  try { return fs.readdirSync(p).length > 0 } catch (_) { return false }
}

/** 资源根完整度：common/bg（元素图标）、角色 icons（命座/天赋）、
 *  profile（咕咕牛自定义立绘）、角色 imgs（立绘）。 */
function rootScore(dir) {
  if (!dir) return -1
  let score = 0
  if (hasFiles(path.join(dir, 'common', 'bg'))) score += 4
  if (hasDir(path.join(dir, 'profile', 'normal-character'))) score += 2
  try {
    const chars = path.join(dir, 'meta-gs', 'character')
    let imgs = false
    let icons = false
    for (const name of fs.readdirSync(chars)) {
      if (!imgs && hasFiles(path.join(chars, name, 'imgs'))) imgs = true
      if (!icons && hasFiles(path.join(chars, name, 'icons'))) icons = true
      if (imgs && icons) break
    }
    if (imgs) score += 1
    if (icons) score += 4
  } catch (_) { }
  return score
}

let _metaRoot = null
function metaRoot() {
  if (_metaRoot) return _metaRoot
  const candidates = []
  /* 显式配置的根优先，即使它不完整（用户自己指定，按用户的来） */
  try {
    const cfg = globalThis.__HOYO_META_ROOT__
    if (cfg && fs.existsSync(path.join(cfg, 'meta-gs'))) {
      _metaRoot = cfg
      return cfg
    }
  } catch (_) { }
  candidates.push(path.join(pluginPath, 'resources'))
  candidates.push(path.join(rootPath, 'plugins', 'miao-plugin', 'resources'))

  let best = null
  let bestScore = 0
  for (const dir of candidates) {
    try {
      if (!dir || !fs.existsSync(path.join(dir, 'meta-gs'))) continue
    } catch (_) { continue }
    const score = rootScore(dir)
    if (score > bestScore) {
      best = dir
      bestScore = score
    }
  }
  if (best) {
    _metaRoot = best
    return best
  }
  // 没有完整的就退回「有 meta-gs」的第一个（数据可用，图可能缺）
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'meta-gs'))) {
        _metaRoot = dir
        return dir
      }
    } catch (_) { }
  }
  _metaRoot = candidates[1]
  return _metaRoot
}

/* 兼容 miao 的写法：miaoPath/resources/meta-gs/... —— meta 根在别处时也能拼对 */
function miaoPathNow() {
  return path.dirname(metaRoot())
}
const miaoPath = miaoPathNow()

/**
 * meta 资源在仓库里的相对路径（不带前导斜杠）：plugins/<插件>/resources/
 * 模板里按 HTML 落盘深度拼 ../ 前缀即可。
 */
function metaResRel() {
  const root = metaRoot()
  return path.relative(rootPath, root).split(path.sep).join('/') + '/'
}

export { vendorPath, pluginPath, rootPath, metaRoot, miaoPath, metaResRel }
