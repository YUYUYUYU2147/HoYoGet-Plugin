// 生成绝区零音擎基础数值表：system/default/zzz_weapon_stat.json
//
// 用途：工坊详情接口的「原始形态」（source_api=2025）不带面板，音擎只有 id 与精炼等级，
// 需要满级基础攻击与副属性才能还原面板。Bwiki 音擎页首张表直接给「基础攻击力 50~743」
// 「副属性 暴击率 9.6~24%」，取区间上限即可。
//
// 用法：node tools/build_zzz_weapon_stat.mjs [--force]
// 输出：{ generatedAt, count, source, weapons: { [itemId]: { name, atk1, atk60, subName, sub1, sub60 } } }
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'system/default/zzz_weapon_stat.json')
const LIST_API = 'https://api.zzzmap.com/api/v1/weapon/list?limit=500'
const WIKI = 'https://wiki.biligame.com/zzz/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const CONCURRENCY = 4

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchText(url, retry = 2) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (i === retry) throw err
      await sleep(600 * (i + 1))
    }
  }
}

const plain = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|li|tr|div|td|th)>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ')

function parseWeapon(html) {
  const txt = plain(html)
  const atk = txt.match(/基础攻击力\s*([\d.]+)\s*~\s*([\d.]+)/)
  const sub = txt.match(/副属性\s*([^\d\s][^\n]*?)\s*([\d.]+%?)\s*~\s*([\d.]+%?)/)
  return {
    atk1: atk ? Number(atk[1]) : null,
    atk60: atk ? Number(atk[2]) : null,
    subName: sub ? sub[1].trim() : '',
    sub1: sub ? sub[2] : '',
    sub60: sub ? sub[3] : '',
  }
}

const force = process.argv.includes('--force')
if (!force && fs.existsSync(OUT)) {
  const old = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  if (old?.count >= 90) {
    console.log(`已存在 ${OUT}（${old.count} 条），如需重建加 --force`)
    process.exit(0)
  }
}

const list = await fetch(LIST_API).then(r => r.json())
const rows = list?.data?.rows || []
if (!rows.length) throw new Error('音擎列表为空')
console.log(`音擎列表 ${rows.length} 条，开始抓取 Bwiki…`)

const weapons = {}
let done = 0
let failed = 0

const queue = [...rows]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) {
    const row = queue.shift()
    const id = String(row.item_id)
    const name = row.nick_name || ''
    if (!name) { failed++; continue }
    try {
      const html = await fetchText(WIKI + encodeURIComponent(name))
      const parsed = parseWeapon(html)
      if (!parsed.atk60) {
        failed++
        console.warn(`[跳过] ${id} ${name}：未解析到基础攻击力`)
        continue
      }
      weapons[id] = { name, ...parsed }
    } catch (err) {
      failed++
      console.warn(`[失败] ${id} ${name}：${err.message}`)
    } finally {
      done++
      if (done % 10 === 0) console.log(`  进度 ${done}/${rows.length}`)
    }
  }
}))

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'wiki.biligame.com/zzz 音擎页「基础攻击力 a~b」「副属性 x a~b」',
  count: Object.keys(weapons).length,
  failed,
  weapons,
}
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.log(`\n写入 ${OUT}`)
console.log(`成功 ${payload.count}，失败 ${failed}`)

// 抽样校验：已知 14109 霰落星殿 Lv60 = 743 / 暴击率 24%
for (const id of ['14109', '13001']) {
  if (weapons[id]) console.log('校验', id, JSON.stringify(weapons[id]))
}
