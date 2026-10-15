/**
 * 隐私信息扫描：拦住不该进仓库的号码与凭据。
 *
 * 规则来自仓库既有的硬约束：UID、QQ 号、群号、stoken、ltuid、Cookie、token
 * 一律不进代码与注释。这里做的是「宁可误报也别漏」的粗筛 —— 注释里写「某 UID」
 * 这类脱敏写法不会命中，写真号才会。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'temp', 'data', 'logs', 'resources', 'service'])
const EXTS = new Set(['.js', '.mjs', '.json', '.yaml', '.yml', '.md'])

// 明显是占位/示例的号段，忽略，避免把文档里的假数据当成泄露
const WHITELIST = new Set([
  '18500001234', '123456789', '987654321', '10000', '123123123',
  '9999999999', '99999999999',
])

/**
 * 只扫「入库文件」。
 *
 * 仓库里 AGENTS.md / HANDOFF_* 与 config/、data/ 都在 .gitignore 中，属于本地
 * 留存（含排查用的真实上下文，恰恰是最不该外传的），但它们躺在工作区里，
 * 直接 walk 目录会把它们一并扫出来。git ls-files 拿到的才是真正会进仓库的清单。
 */
function trackedFiles() {
  try {
    // --others --exclude-standard 带上「还没提交但没被忽略」的新文件：
    // 只用 ls-files 的话，新写的文件在 commit 之前是扫不到的，而那正是最需要拦的时候
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter(f => EXTS.has(path.extname(f)))
  } catch {
    return null
  }
}

const RULES = [
  // 既覆盖 `cookie_token=xxx`，也覆盖对象字面量里的 `cookie_token: 'xxx'`
  { name: 'Cookie 赋值', re: /\b(cookie_token|ltuid|ltoken_v2|account_mid_v2|stoken)\s*[:=]\s*['"][^'"]{6,}['"]/i },
  { name: 'Cookie 字面量', re: /['"](cookie_token|ltoken_v2|account_mid_v2)\s*:\s*['"][^'"]{6,}['"]/i },
  { name: '疑似凭据', re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: '数据库连接串', re: /\b(mysql|postgres):\/\/[^\s'"`]+:[^\s'"`]+@/i },
]

// 9~11 位连续数字：QQ 号 / 手机号 / UID 的常见形态。
// 但仓库里这类数字大量是**游戏内物品 ID**（如 285802042 勾魂摄魄的支配者），
// 光看数字无法区分，所以只在同一行出现个人身份关键词时才判为泄露。
const NUM_RE = /(?<![\w.])\d{9,11}(?![\w.])/g
const PERSONAL_HINT = /\b(uid|user_id|ltuid|stuid|qq|group_id|account|passport|群号|账号|绑定)\b|绑定\s*[:：]/i

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

const tracked = trackedFiles()
const files = tracked
  ? tracked.map(f => path.join(ROOT, f)).filter(f => fs.existsSync(f))
  : walk(ROOT)

const problems = []
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, idx) => {
    for (const { name, re } of RULES) {
      if (re.test(line)) problems.push(`${path.relative(ROOT, file)}:${idx + 1} ${name}`)
    }
    // URL 与长 base64 片段里的数字不是身份信息（announcement api 的 game_biz、
    // 图片直链等），先剔除再判
    const probe = line.replace(/https?:\/\/\S+/g, '')
    if (PERSONAL_HINT.test(probe)) {
      for (const n of probe.match(NUM_RE) || []) {
        if (WHITELIST.has(n)) continue
        if (/^(19|20)\d{2}$/.test(n)) continue
        problems.push(`${path.relative(ROOT, file)}:${idx + 1} 疑似身份号码 ${n}`)
      }
    }
  })
}

if (problems.length) {
  console.error('隐私信息扫描发现问题（请确认是否为误报，确属泄露请改用脱敏写法）：')
  problems.slice(0, 40).forEach(p => console.error(' - ' + p))
  if (problems.length > 40) console.error(` … 共 ${problems.length} 处`)
  process.exit(1)
}
console.log('隐私信息扫描通过')
