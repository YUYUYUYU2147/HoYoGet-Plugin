import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(PLUGIN_ROOT, 'data', 'alias_online')
const TTL = 12 * 3600 * 1000

/* 在线别名源（raw 直链，绕开 GitHub API 限流）。key = 本地缓存文件名 */
const SOURCES = [
  { key: 'zzz_alias.yaml', url: 'https://raw.githubusercontent.com/ZZZure/ZZZ-Plugin/main/defSet/alias.yaml', game: 'zzz', type: 'js' },
  { key: 'miao_gs_js_alias.js', url: 'https://raw.githubusercontent.com/yoimiya-kokomi/miao-plugin/master/resources/meta-gs/character/alias.js', game: 'gs', type: 'js' },
  { key: 'miao_sr_js_alias.js', url: 'https://raw.githubusercontent.com/yoimiya-kokomi/miao-plugin/master/resources/meta-sr/character/alias.js', game: 'sr', type: 'js' },
  { key: 'miao_gs_syw_alias.js', url: 'https://raw.githubusercontent.com/yoimiya-kokomi/miao-plugin/master/resources/meta-gs/artifact/alias.js', game: 'gs', type: 'syw' },
  { key: 'miao_sr_yq_alias.js', url: 'https://raw.githubusercontent.com/yoimiya-kokomi/miao-plugin/master/resources/meta-sr/artifact/alias.js', game: 'sr', type: 'yq' },
]

const cachePath = key => path.join(CACHE_DIR, key)
const fresh = key => { try { return fs.existsSync(cachePath(key)) && Date.now() - fs.statSync(cachePath(key)).mtimeMs < TTL } catch { return false } }

export async function syncAliasOnline(force = false, logger = null) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }) } catch { /* 建目录失败继续 */ }
  const out = []
  for (const s of SOURCES) {
    if (!force && fresh(s.key)) { out.push({ key: s.key, ok: true, cached: true }); continue }
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const text = await res.text()
      if (!text || text.length < 20) throw new Error('empty')
      fs.writeFileSync(cachePath(s.key), text)
      out.push({ key: s.key, ok: true })
    } catch (e) {
      logger?.debug?.(`[HoYoGet][alias_online] 拉取 ${s.key} 失败：${e?.message || e}`)
      out.push({ key: s.key, ok: false, err: String(e?.message || e) })
    }
  }
  return out
}

/* 返回本地已缓存的在线表（供 name_alias.js 建索引时优先读取） */
export function onlineAliasSources() {
  return SOURCES.map(s => ({ game: s.game, type: s.type, key: s.key, file: cachePath(s.key) })).filter(s => { try { return fs.existsSync(s.file) } catch { return false } })
}

export { CACHE_DIR, SOURCES }