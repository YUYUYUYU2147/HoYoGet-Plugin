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
 */
function metaRoot() {
  const candidates = []
  try {
    const cfg = globalThis.__HOYO_META_ROOT__
    if (cfg) candidates.push(cfg)
  } catch (_) { }
  candidates.push(path.join(pluginPath, 'resources'))
  candidates.push(path.join(rootPath, 'plugins', 'miao-plugin', 'resources'))
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'meta-gs'))) return dir
    } catch (_) { }
  }
  return candidates[1]
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
