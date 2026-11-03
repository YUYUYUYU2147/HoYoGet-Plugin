/**
 * 模板缓存失效。
 *
 * 框架的 Renderer 把模板内容缓存在内存里（Renderer.html[tplFile]），
 * 只靠 chokidar 监听文件变化来删缓存。实测在部分环境（inotify 数量受限、
 * 容器里文件系统事件丢失）监听不生效，于是改了 html/css 之后出图还是旧样子，
 * 必须 #重启 才更新。
 *
 * 这里按「文件 mtime + size」判断：只要和上次记录的不一致，就删掉缓存，
 * 让 Renderer 重新读盘。代价是每次渲染多一次 statSync（微秒级），
 * 换来的是改模板即时生效。
 */
import fs from 'node:fs'
import Renderer from '../../../lib/renderer/Renderer.js'

const seen = new Map()

/**
 * @param {string} tplFile 模板绝对路径（或相对 cwd 的路径）
 */
export function bustTplCache(tplFile) {
  if (!tplFile) return
  try {
    const st = fs.statSync(tplFile)
    const sig = `${st.mtimeMs}:${st.size}`
    if (seen.get(tplFile) === sig) return
    seen.set(tplFile, sig)
    if (Renderer.html) delete Renderer.html[tplFile]
  } catch {
    /* 文件不在就算了，交给 Renderer 自己报「加载html错误」 */
  }
}

export default { bustTplCache }
