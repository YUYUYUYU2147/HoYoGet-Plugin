/**
 * 内置版资源路径（原 wiki 插件同名模块）。
 * 资源根优先用本插件自己的 resources，找不到再退回外部插件目录，
 * 这样 miao / wiki 卸载后仍能按 meta 目录读图。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { metaRoot } from '../../path.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const vendorRoot = path.join(__dirname, '..', '..')
const pluginPath = path.join(vendorRoot, '..', '..', '..')
const rootPath = path.join(pluginPath, '..', '..')

let wikiPath = {
  getDir(_path, isres = false) {
    // "miao-plugin" / "wiki" 这两个历史占位名，统一映射到资源根
    if (_path === 'miao-plugin' || _path === 'wiki') {
      const root = metaRoot()
      return path.join(root, isres === false ? '..' : '', isres ? '' : '')
    }
    return path.join(rootPath, 'plugins', _path, isres ? 'resources' : '')
  },
  getRes(relPath) {
    const own = path.join(pluginPath, 'resources', relPath)
    if (fs.existsSync(own)) return relPath
    return relPath
  }
}

export default wikiPath
