/**
 * genshin 插件模块的按需加载器。
 *
 * 为什么需要它：ESM 在模块解析阶段一次性解析全部静态依赖，任一路径不存在就整份
 * 文件抛 ERR_MODULE_NOT_FOUND，而且 ESM 没有 try/catch 兜底 —— 结果是**整个插件
 * 加载失败**，而不是某个功能失效。所以跨插件引用一律走这里动态 import。
 *
 * 用法：
 *   const r = await loadGenshinModule('model/mys/NoteUser.js', ['model/mys/NoteUser.js'])
 *   if (!r.ok) return   // r.err 已打过日志
 *   const NoteUser = r.value
 */

// 插件可能装在 plugins/ 下、也可能被 TRSS 挂到别处，多给几个候选根。
const GENSHIN_ROOTS = [
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

// 同一个模块只报一次错：缺 genshin 时每个指令都会触发加载，刷屏没有意义
const missingGenshinModules = new Set()

/**
 * 按需加载 genshin 的一个模块，取其 default 或指定的具名导出。
 * @param {string} tag 功能标记，用于错误提示与去重
 * @param {string[]} relPaths 相对 genshin 插件根的候选路径
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
      `[HoYoGet] 未能在 genshin 插件中找到 ${tag}（已尝试 ${candidates.length} 个路径，` +
      `最后错误：${lastErr?.message || lastErr}）。相关功能将不可用，请更新 genshin 插件。`
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
