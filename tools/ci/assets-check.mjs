/**
 * 资源引用检查：模板 / 样式表里引用的本地文件必须真实存在。
 *
 * 背景：本插件大量模板引用 `{{ppath}}xxx/yyy.css` 与 `url(./imgs/..)`，
 * 这类路径写错不会报错，只会静默 404 —— 出图时表现为「图没了 / 字体变默认」，
 * 很难靠肉眼发现（曾因此让星铁抽卡页字体全丢、崩三切换页背景空白）。
 *
 * 只检查**被模板实际引用**的 CSS，避免把其他插件的遗留样式也算进来。
 * 外部链接（http/https/data:）与模板变量拼接路径不在检查范围内。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RES = path.join(ROOT, 'resources')

function walk(dir, out = [], filter = () => true) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, filter)
    else if (filter(full)) out.push(full)
  }
  return out
}

const problems = []
const rel = p => path.relative(ROOT, p).split(path.sep).join('/')

// 1) 模板里 {{ppath}}xxx 引用的文件
const htmls = walk(RES, [], f => f.endsWith('.html'))
for (const f of htmls) {
  const s = fs.readFileSync(f, 'utf8')
  for (const m of s.matchAll(/\{\{ppath\}\}([A-Za-z0-9_/.-]+)/g)) {
    const ref = m[1].split('?')[0]
    if (!ref || /\.$/.test(ref)) continue
    // 后面紧跟模板变量（icon_type_{{x}}.png），属于运行时拼接，跳过
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 3)
    if (after.startsWith('{{')) continue
    if (ref.split('/').pop().includes('{{')) continue
    const abs = path.join(RES, decodeURIComponent(ref))
    if (!fs.existsSync(abs)) problems.push(`${rel(f)} -> {{ppath}}${ref}`)
  }
}

// 2) 被模板引用的 CSS 里的 url(...)
const usedCss = new Set()
for (const f of htmls) {
  const s = fs.readFileSync(f, 'utf8')
  for (const m of s.matchAll(/\{\{ppath\}\}([A-Za-z0-9_/.-]+\.css)/g)) {
    const p = path.join(RES, m[1])
    if (fs.existsSync(p)) usedCss.add(p)
  }
}
for (const f of usedCss) {
  const raw = fs.readFileSync(f, 'utf8')
  // 去掉注释，避免把注释掉的 url 也算进来
  const s = raw.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of s.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    let u = m[1].trim()
    if (/^(data:|https?:|\/\/|#)/.test(u) || u.includes('{{')) continue
    u = u.split('?')[0].split('#')[0]
    const abs = path.join(path.dirname(f), decodeURIComponent(u))
    if (!fs.existsSync(abs)) problems.push(`${rel(f)} -> url(${u})`)
  }
}

if (problems.length) {
  console.error(`资源引用检查未通过（${problems.length} 项）：`)
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log(`资源引用检查通过：${htmls.length} 个模板 / ${usedCss.size} 个样式表，引用均存在`)
