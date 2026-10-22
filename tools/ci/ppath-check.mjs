/**
 * 检查「直接调用 puppeteer.render 时是否传了 ppath」。
 *
 * 背景：xhh 的模板里资源路径一律写成 `{{ppath}}xxx/yyy.css`，而 ppath 只有
 * system/render.js 的 beforeRender 会注入；直接 `puppeteer.render(name, data)`
 * 的调用必须自己传，框架不会补。漏传的后果不是报错，而是 {{ppath}} 被渲染成
 * 空串 -> CSS、背景图、图标全部 404 -> 页面上是一张没有样式的裸 HTML（曾因此
 * 让崩三抽卡记录变成满屏文字堆叠、切换水晶UID 变成白块）。
 *
 * 这类漏配很容易在批量改动或回滚中被无声抹掉，所以放进 CI 静态兜底：
 * 只要某个模板用到了 {{ppath}}，对应 render 调用就必须带 ppath。
 *
 * 反过来不检查「没用到 {{ppath}} 的模板多传了 ppath」—— 那是无害的冗余。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const APPS = path.join(ROOT, 'apps')
const RES = path.join(ROOT, 'resources')

/** 收集某个 html 模板用到的资源目录，形如 bh3_ledger */
function resourceDirsOf(html) {
  const dirs = new Set()
  // 1) 模板里 {{ppath}}xxx/ 形式的引用
  for (const m of html.matchAll(/\{\{ppath\}\}([A-Za-z0-9_]+)\//g)) dirs.add(m[1])
  return dirs
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (name.endsWith('.html')) out.push(full)
  }
  return out
}

/** 模板里出现 {{ppath}} 的资源目录集合 */
const tplDirs = new Set()
for (const f of walk(RES)) {
  for (const d of resourceDirsOf(fs.readFileSync(f, 'utf8'))) tplDirs.add(d)
}

/** 解析 render 调用：取 name 参数与紧随其后的对象文本 */
function renderCalls(src) {
  const out = []
  const re = /puppeteer\.render\(\s*'([^']+)'\s*,\s*\{/g
  let m
  while ((m = re.exec(src))) {
    // 从 '{' 起做括号配平，取出该调用的数据对象文本
    let i = src.indexOf('{', m.index + m[0].length - 1)
    let depth = 0
    let start = i
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') {
        depth--
        if (depth === 0) break
      }
    }
    out.push({ name: m[1], args: src.slice(start, i + 1), index: m.index })
  }
  return out
}

const problems = []
let checked = 0

function walkJs(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) walkJs(full, out)
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

for (const full of walkJs(APPS)) {
  const file = path.relative(APPS, full).replace(/\\/g, '/')
  const src = fs.readFileSync(full, 'utf8')
  for (const call of renderCalls(src)) {
    // name 形如 '小花火/bh3_ledger/uid_switch'，取出资源目录段 bh3_ledger
    const seg = call.name.split('/').filter(Boolean)
    if (seg.length < 2) continue
    const dir = seg[seg.length - 2]
    if (!tplDirs.has(dir)) continue // 该模板不依赖 ppath，跳过
    checked++
    if (!/\bppath\s*:/.test(call.args)) {
      const line = src.slice(0, call.index).split('\n').length
      problems.push(`${file}:${line}  render('${call.name}') 所在模板用到 {{ppath}}，但没有传 ppath`)
    }
  }
}

if (problems.length) {
  console.error('ppath 检查未通过：')
  for (const p of problems) console.error('  ✗ ' + p)
  console.error(`\n共 ${problems.length} 处。ppath 不会被框架注入，必须自己传，例如：`)
  console.error("  ppath: '../../../../../plugins/HoYoGet-Plugin/resources/',")
  process.exit(1)
}

console.log(`ppath 检查通过：${checked} 个依赖 ppath 的渲染调用均已传入`)
