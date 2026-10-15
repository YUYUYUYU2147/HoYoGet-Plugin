/**
 * 语法预检：对仓库里的 .js / .mjs 逐个做 node --check。
 *
 * 为什么不直接跑插件：插件依赖宿主提供的 logger / redis / Bot / plugin 等全局，
 * import 进来就会 ReferenceError。`node --check` 只做解析不执行，正好适合当门禁。
 *
 * 排除目录：node_modules、temp、data、.git、resources 下的第三方产物
 * （resources 里是压缩过的前端资源，逐个 check 纯属浪费）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'temp', 'data', 'logs', 'resources', 'service'])
const EXTS = new Set(['.js', '.mjs'])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), out)
      continue
    }
    if (EXTS.has(path.extname(entry.name))) out.push(path.join(dir, entry.name))
  }
  return out
}

const files = walk(ROOT)
const failed = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (err) {
    const detail = (err.stderr || Buffer.alloc(0)).toString().split('\n').slice(0, 4).join('\n')
    failed.push(`${path.relative(ROOT, file)}\n${detail}`)
  }
}

if (failed.length) {
  console.error(`语法检查失败 ${failed.length} / ${files.length} 个文件：\n`)
  failed.forEach(f => console.error(f + '\n'))
  process.exit(1)
}
console.log(`语法预检通过：${files.length} 个文件`)
