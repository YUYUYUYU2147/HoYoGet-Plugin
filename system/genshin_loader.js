/**
 * 按需加载「米游社数据层」的统一入口。
 *
 * 为什么需要它：ESM 在模块解析阶段一次性解析全部静态依赖，任一路径不存在就整份
 * 文件抛 ERR_MODULE_NOT_FOUND，而且 ESM 没有 try/catch 兜底 —— 结果是**整个插件
 * 加载失败**，而不是某个功能失效。所以跨模块引用一律走这里动态 import。
 *
 * 候选顺序（先内置，后外部）：
 *   1. ./vendor/genshin/  本插件内置的实现，不依赖任何外部插件；
 *   2. genshin 插件目录    用户自行安装 genshin 时，用它的更新版本。
 * 内置层覆盖 model/mys 下的 NoteUser / mysInfo / mhyFetch；
 * gachaLog 等尚未内置的模块找不到时只是对应功能降级，不影响插件加载。
 *
 * 用法：
 *   const r = await loadGenshinModule('model/mys/NoteUser.js', ['model/mys/NoteUser.js'])
 *   if (!r.ok) return   // r.err 已打过日志
 *   const NoteUser = r.value
 */

// 内置兼容层放在最前：缺外部插件时功能仍然可用。
const GENSHIN_ROOTS = [
  './vendor/genshin/',
  '../../genshin/',
  '../genshin/',
  './genshin/',
]

/** 在多个候选根下拼出全部候选模块 URL（顺序即尝试顺序） */
function resolveGenshinModule(relPaths) {
  const bases = GENSHIN_ROOTS.map(root => new URL(root, import.meta.url).href)
  const found = []
  for (const base of bases) {
    for (const rel of relPaths) {
      const url = new URL(rel, base).href
      if (!found.includes(url)) found.push(url)
    }
  }
  return found
}

// 同一个模块只报一次错：缺模块时每个指令都会触发加载，刷屏没有意义
const missingGenshinModules = new Set()

/**
 * 按需加载一个数据层模块，取其 default 或指定的具名导出。
 * @param {string} tag 功能标记，用于错误提示与去重
 * @param {string[]} relPaths 相对候选根（如 model/mys/NoteUser.js）的路径
 * @param {string|null} named 取具名导出；传 '*' 返回整个模块命名空间；不传则取 default
 * @returns {Promise<{ok: boolean, value: any, err?: Error}>}
 */
export async function loadGenshinModule(tag, relPaths, named = null) {
  const candidates = resolveGenshinModule(relPaths)
  let lastErr
  for (const url of candidates) {
    try {
      const mod = await import(url)
      if (named === '*') return { ok: true, value: mod }
      if (named) return { ok: true, value: mod[named] }
      return { ok: true, value: mod.default }
    } catch (err) {
      lastErr = err
    }
  }
  if (!missingGenshinModules.has(tag)) {
    missingGenshinModules.add(tag)
    logger.error(
      `[HoYoGet] 未找到数据层模块 ${tag}（已尝试 ${candidates.length} 个路径，` +
      `最后错误：${lastErr?.message || lastErr}）。相关功能将不可用。`
    )
  }
  return { ok: false, value: null, err: lastErr }
}

/** 同上，但缓存模块引用（同一模块反复取用时不再走一次 import） */
export function makeGenshinLoader(tag, relPaths, named = null) {
  let cache = null
  return async function get() {
    if (!cache) cache = await loadGenshinModule(tag, relPaths, named)
    return cache.value
  }
}
