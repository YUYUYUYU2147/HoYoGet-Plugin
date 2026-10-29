/**
 * 「咕咕牛」图库管理器的加载入口。
 *
 * 上游文件在 resources/CowCoos/Miao-Plugin-MBT/咕咕牛图库管理器.js，由 #更新咕咕牛 时 git 拉取。
 * 每次加载都按内容哈希比对一次：
 *   1. 上游存在且改写规则命中 -> 生成改写副本并加载，自动跟随上游更新；
 *   2. 上游缺失（新机器尚未下载图库）或上游结构变化导致规则未命中
 *      -> 退回插件自带的基线副本，避免指令整块失效。
 *
 * 需要改写的原因：上游按 plugins/example/ 的布局写死了项目根、common 引入与自链接目标。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const YZ_ROOT = path.resolve(PLUGIN_ROOT, '..', '..')
const UPSTREAM = path.join(YZ_ROOT, 'resources', 'CowCoos', 'Miao-Plugin-MBT', '咕咕牛图库管理器.js')
const BASELINE = path.join(PLUGIN_ROOT, 'resources', 'cowcow', 'gallery_base.js')
const CACHE_DIR = path.join(PLUGIN_ROOT, 'temp', 'cowcow')

/* 渲染精度（RenderMatrix 的 transform:scale）超过 100 时，缩放后的内容会超出初始视口；
   上游与内置基线都按 element.boundingBox() 取裁剪框，部分环境按布局盒返回，出图右侧/底部会缺一块。
   这里换成「量可视矩形（含祖先 transform）+ 撑大视口重量一次」，两条加载路径都会经过它；
   已经带这段实现的代码不会再被替换，因此可以反复执行。 */
const CLIP_FIX_RE = /^([ \t]*)const box = await element\.boundingBox\(\);$/m
const CLIP_FIX_CODE = (pad) =>
  pad + 'const box = await (async () => { const rect = async () => { try { return await element.evaluate(n => { const r = n.getBoundingClientRect(); return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height }; }); } catch (e) { return null; } }; let b = await rect(); if (!b || !(b.width > 0) || !(b.height > 0)) b = await element.boundingBox(); const vp = (page.viewport && page.viewport()) || { width: 0, height: 0 }; const needW = Math.ceil(b.x + b.width + 16); const needH = Math.ceil(b.y + b.height + 16); if (needW > (vp.width || 0) || needH > (vp.height || 0)) { await page.setViewport({ width: Math.max(vp.width || 0, needW), height: Math.max(vp.height || 0, needH), deviceScaleFactor: vp.deviceScaleFactor || 1 }).catch(() => {}); b = (await rect()) || b; } return b; })();'
function applyClipFix(code) {
  if (!CLIP_FIX_RE.test(code)) return code
  return code.replace(CLIP_FIX_RE, (m, pad) => CLIP_FIX_CODE(pad))
}

/** 把上游写死的路径换成本机实际路径；规则不命中返回 null，由调用方回退基线 */
function transform(code, upstreamFile) {
  const libUrl = pathToFileURL(path.join(YZ_ROOT, 'lib', 'common', 'common.js')).href
  const pairs = [
    [/^import common from .*$/m, () => 'import common from ' + JSON.stringify(libUrl) + ';'],
    [/^const __filename = .*$/m, () => 'const __filename = ' + JSON.stringify(upstreamFile) + ';'],
    [/^const __dirname = .*$/m, () => 'const __dirname = ' + JSON.stringify(path.dirname(upstreamFile)) + ';'],
    [/^const YzPath = .*$/m, () => 'const YzPath = ' + JSON.stringify(YZ_ROOT) + ';'],
    [/LinkFiles: \[.*\]/m, () => 'LinkFiles: []'],
  ]
  let out = code
  for (const [re, rep] of pairs) {
    if (!re.test(out)) return null
    out = out.replace(re, rep)
  }
  out = applyClipFix(out)
  return out
}

async function loadUpstream() {
  if (!fs.existsSync(UPSTREAM)) return null
  const patched = transform(fs.readFileSync(UPSTREAM, 'utf8'), UPSTREAM)
  if (!patched) {
    logger.warn?.('[HoYoGet][cowcow] 上游结构与改写规则不匹配，本次使用内置基线')
    return null
  }
  const hash = crypto.createHash('md5').update(patched).digest('hex').slice(0, 12)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, 'gallery_' + hash + '.mjs')
  if (!fs.existsSync(file)) fs.writeFileSync(file, patched, 'utf8')
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (name === path.basename(file)) continue
    try { fs.rmSync(path.join(CACHE_DIR, name), { force: true }) } catch (err) { /* 旧副本删不掉不影响加载 */ }
  }
  return await import(pathToFileURL(file).href + '?v=' + hash)
}

/* 内置基线也要过一遍裁剪修复：只更新了 apps 目录的机器上，基线里仍是旧的取框方式 */
async function loadBaseline() {
  const code = fs.readFileSync(BASELINE, 'utf8')
  const patched = applyClipFix(code)
  if (patched === code) return await import(pathToFileURL(BASELINE).href)
  const hash = crypto.createHash('md5').update(patched).digest('hex').slice(0, 12)
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const file = path.join(CACHE_DIR, 'gallery_base_' + hash + '.mjs')
  if (!fs.existsSync(file)) fs.writeFileSync(file, patched, 'utf8')
  return await import(pathToFileURL(file).href + '?v=' + hash)
}

let mod = null
try {
  mod = await loadUpstream()
} catch (err) {
  logger.warn?.('[HoYoGet][cowcow] 上游副本加载失败，改用内置基线：' + (err?.message || err))
}
if (!mod) mod = await loadBaseline()

export const MiaoPluginMBT = mod.MiaoPluginMBT
export const SleeperAgent = mod.SleeperAgent
