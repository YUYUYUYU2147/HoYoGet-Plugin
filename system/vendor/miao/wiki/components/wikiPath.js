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
    /* 只把 "miao-plugin" 映射到资源根。
       "wiki" 必须返回**不存在**的路径：CharImg 里有
         if (fs.existsSync(`${rPath}/${nPath}`)) nPath = '../../wiki/resources/...'
       这个分支本意是「wiki 插件自己有一套图就优先用它」，
       如果 wiki 和 miao 指向同一个根，就会把 nPath 改成无效路径，
       导致 face/gacha 全部取不到（角色头像空白）。 */
    if (_path === 'miao-plugin') {
      const root = metaRoot()
      return isres ? root : path.join(root, '..')
    }
    if (_path === 'wiki') {
      return path.join(rootPath, 'plugins', 'wiki', '__no_wiki_resources__')
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
