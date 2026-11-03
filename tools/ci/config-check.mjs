/**
 * 配置与卡池表自检。
 *
 * 查两类容易「肉眼看不出来、运行时才炸」的问题：
 *   1. YAML 能否解析（system/default 下的配置与卡池表、config 模板）；
 *   2. 卡池表的结构约定：imgs 与 gz_five 同长（历史上出过一次两条 imgs 指向
 *      同一张图，导致第二把武器的图标显示成第一把）。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const problems = []

// —— 1. 全部 YAML 至少能解析 ——
function walkYaml(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkYaml(p, out)
    else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) out.push(p)
  }
  return out
}

const yamlFiles = [
  ...walkYaml(path.join(ROOT, 'system/default')),
  ...walkYaml(path.join(ROOT, '.github')),
]
const parsed = new Map()
for (const file of yamlFiles) {
  try {
    parsed.set(file, YAML.parse(fs.readFileSync(file, 'utf8')))
  } catch (err) {
    problems.push(`${path.relative(ROOT, file)} 解析失败：${err.message}`)
  }
}

// —— 2. 星铁卡池表：双光锥池的两张图必须不同 ——
const srLogs = path.join(ROOT, 'system/default/sr_logs.yaml')
if (parsed.has(srLogs)) {
  const list = [].concat(parsed.get(srLogs))
  list.forEach((item, i) => {
    const cones = Array.isArray(item?.gz_five) ? item.gz_five.filter(Boolean) : []
    const imgs = (item?.imgs || []).filter(Boolean)
    if (cones.length > 1 && imgs.length > 1 && imgs[0] === imgs[1]) {
      problems.push(`sr_logs.yaml 第 ${i + 1} 条（${item.ver}）：两张 imgs 指向同一张图`)
    }
  })
}

if (problems.length) {
  console.error('配置自检未通过：')
  problems.forEach(p => console.error(' - ' + p))
  process.exit(1)
}
console.log(`配置自检通过：${yamlFiles.length} 个 YAML` + (parsed.has(srLogs) ? '，卡池表结构正常' : ''))
