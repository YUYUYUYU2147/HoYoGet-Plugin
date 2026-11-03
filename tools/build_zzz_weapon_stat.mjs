// 生成绝区零音擎基础数值表：system/default/zzz_weapon_stat.json
//
// 用途：工坊详情接口的「原始形态」（source_api=2025）不带面板，音擎只有 id 与精炼等级，
// 需要满级基础数值才能还原面板。
//
// 数据源优先级：
//   1. Bwiki 音擎页首表「基础攻击力 50~743」「副属性 暴击率 9.6~24%」
//   2. 米游社百科 multi_table「初始面板：… 满级面板：…」（Bwiki 缺词条时兜底）
//      米游社没有可用的搜索/目录接口，只能按 entry_page_id 读取，下面的 MIYOUSHE_IDS 是扫描得到的。
//   3. 两者都没有时按 Lv1 值 × 14.85 估算，并标记 derived
//
// 注意：部分新音擎的主属性是「基础防御力」而不是「基础攻击力」（如血髓秘匣、喵运当头），
// 这类音擎对攻击面板贡献为 0，表里 baseType 记为 def。
//
// 用法：node tools/build_zzz_weapon_stat.mjs [--force]
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'system/default/zzz_weapon_stat.json')
const LIST_API = 'https://api.zzzmap.com/api/v1/weapon/list?limit=500'
const WIKI = 'https://wiki.biligame.com/zzz/'
const MIYOUSHE = 'https://act-api-takumi-static.mihoyo.com/hoyowiki/zzz/wapi/entry_page'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
const CONCURRENCY = 4
const LEVEL_RATIO = 14.85

// 米游社百科词条 id（2026-10 扫描 2160-2260 得到）
const MIYOUSHE_IDS = {
  绯月银棺: 2234,
  血髓秘匣: 2189,
  '「月相」-弦': 2190,
  喵运当头: 2200,
  猩红渴望: 2188,
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchText(url, retry = 2, headers = { 'user-agent': UA }) {
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
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

function parseBwiki(html) {
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

/** 米游社词条页：multi_table 里「初始面板：… 满级面板：…」 */
async function parseMiyoushe(name) {
  const id = MIYOUSHE_IDS[name]
  if (!id) return null
  const url = `${MIYOUSHE}?app_sn=zzz_wiki&entry_page_id=${id}&lang=zh-cn`
  const raw = await fetchText(url, 2, {
    accept: 'application/json, text/plain, */*',
    referer: 'https://baike.mihoyo.com/',
    'x-rpc-wiki_app': 'zzz',
    'x-rpc-language': 'zh-cn',
    'user-agent': UA,
  })
  const page = JSON.parse(raw)?.data?.page
  for (const mod of page?.modules || []) {
    for (const comp of mod.components || []) {
      if (comp.component_id !== 'multi_table') continue
      for (const tb of JSON.parse(comp.data || '{}').tables || []) {
        for (const row of tb.row || []) {
          const text = plain(row.join(' ')).replace(/\s+/g, ' ')
          if (!/满级面板/.test(text)) continue
          const full = text.slice(text.indexOf('满级面板'))
          const atk = full.match(/基础攻击力\+?([\d.]+)/)
          const def = full.match(/基础防御力\+?([\d.]+)/)
          const sub = full.match(/(?:基础攻击力|基础防御力)\+?[\d.]+\s+(\S+?)\+?([\d.]+%?)/)
          return {
            baseType: atk ? 'atk' : 'def',
            atk1: null,
            atk60: atk ? Number(atk[1]) : 0,
            def60: def ? Number(def[1]) : null,
            subName: sub ? sub[1] : '',
            sub1: '',
            sub60: sub ? sub[2] : '',
            source: 'miyoushe',
            entryId: id,
          }
        }
      }
    }
  }
  return null
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
      const parsed = parseBwiki(await fetchText(WIKI + encodeURIComponent(name)))
      if (!parsed.atk60) throw new Error('未解析到基础攻击力')
      weapons[id] = { name, baseType: 'atk', ...parsed, source: 'bwiki' }
    } catch (err) {
      failed++
      console.warn(`[Bwiki 失败] ${id} ${name}：${err.message}`)
    } finally {
      done++
      if (done % 10 === 0) console.log(`  进度 ${done}/${rows.length}`)
    }
  }
}))

// 米游社兜底
const missing = rows.filter(row => !weapons[String(row.item_id)])
console.log(`\nBwiki 未覆盖 ${missing.length} 条，尝试米游社…`)
for (const row of missing) {
  const id = String(row.item_id)
  const name = row.nick_name || ''
  try {
    const parsed = await parseMiyoushe(name)
    if (!parsed) continue
    weapons[id] = { name, ...parsed }
    const val = parsed.baseType === 'def' ? `def ${parsed.def60}` : `atk ${parsed.atk60}`
    console.log(`  米游社补全 ${id} ${name}（${parsed.baseType} ${val}）`)
  } catch (err) {
    console.warn(`  米游社失败 ${id} ${name}：${err.message}`)
  }
}

// 最后兜底：Lv1 × 14.85，标记 derived
// weapon/list 的 attack 对部分音擎是 0，改用 zzz_item_stat.json 的 main.value 取 Lv1 值
const ITEM_STAT = path.join(ROOT, 'system/default/zzz_item_stat.json')
const itemStat = fs.existsSync(ITEM_STAT) ? JSON.parse(fs.readFileSync(ITEM_STAT, 'utf8')) : {}
const SUB_NAME = {
  12102: '攻击力', 11102: '生命值', 13102: '防御力', 20103: '暴击率', 21103: '暴击伤害',
  23103: '穿透率', 23203: '穿透值', 31203: '异常精通', 30502: '能量自动回复',
  12202: '冲击力', 31402: '异常掌控',
}
const PCT_SUB = new Set([12102, 11102, 13102, 20103, 21103, 23103, 30502, 31402])
/** item_stat 的满级副词条 → 展示用字符串（编码映射见上方注释） */
function formatSub(pid, value) {
  const v = Number(value) || 0
  if (PCT_SUB.has(pid)) return `${(v / 4000 * 100).toFixed(1)}%`
  if (pid === 31203) return String(Math.round(v / 0.4))
  return String(Math.round(v / 40))
}
const stillMissing = rows.filter(row => !weapons[String(row.item_id)])
for (const row of stillMissing) {
  const id = String(row.item_id)
  const fallback = itemStat?.weapons?.[id]
  const lv1 = Number(row.attack) || Number(fallback?.main?.value) || 0
  if (!lv1) continue
  const isDef = Number(fallback?.main?.pid) === 13101
  const subPid = Number(fallback?.sub?.pid) || 0
  const subVal = Number(fallback?.sub?.value) || 0
  /* item_stat 的副词条存的是满级值，但编码按属性类型不同。
     用 85 条 Bwiki 数据反推验证（85/85 吻合）：
       百分比类（攻击/生命/防御/双暴/穿透率/能量回复/异常掌控） val/4000*100
       冲击力、穿透值                                       val/40
       异常精通                                             val/0.4 */
  const sub60 = subPid ? formatSub(subPid, subVal) : ''
  const subDerived = !!subPid
  weapons[id] = {
    name: row.nick_name || fallback?.name || '',
    baseType: isDef ? 'def' : 'atk',
    atk1: isDef ? null : lv1,
    atk60: isDef ? 0 : Math.round(lv1 * LEVEL_RATIO),
    def60: isDef ? Math.round(lv1 * LEVEL_RATIO) : null,
    subName: SUB_NAME[subPid] || '',
    sub1: '',
    sub60,
    subDerived,
    source: 'derived',
  }
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'Bwiki 音擎页 + 米游社百科 multi_table（Bwiki 缺词条时）',
  count: Object.keys(weapons).length,
  failed: rows.length - Object.keys(weapons).length,
  sources: Object.values(weapons).reduce((acc, w) => {
    acc[w.source] = (acc[w.source] || 0) + 1
    return acc
  }, {}),
  weapons,
}
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.log(`\n写入 ${OUT}`)
console.log(`成功 ${payload.count} / ${rows.length}，缺失 ${payload.failed}`)

for (const id of ['14109', '13001', '2234', '2189']) {
  const key = ['2234', '2189'].includes(id) ? id : id
  const hit = weapons[id] || weapons[key]
  if (hit) console.log('校验', id, JSON.stringify(hit))
}
