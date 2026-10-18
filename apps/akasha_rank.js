import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render, config } from '#HoYoGet'
import { withPage, listCategories, fetchLeaderboard } from '../system/akasha.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_FILE = path.join(PLUGIN_ROOT, 'temp', 'akasha_categories.json')
const CACHE_TTL = 6 * 3600 * 1000   // 分类（角色→方案）缓存 6 小时

/**
 * Akasha System 原神全球练度榜。
 *
 * 数据源特性：站点过 Cloudflare 挑战只能靠真实浏览器，所以一次请求要开一次
 * Chromium（约 2.5s 起步）。为了不让用户干等，这里做了两层缓存：
 *   · 角色→方案 的分类表缓存 6 小时（体积小、变化慢）
 *   · 实际榜单不缓存（用户要看的是当下排名）
 *
 * 指令：
 *   akasha <角色>            查看该角色默认方案的全球榜
 *   akasha <角色> <方案名>   指定方案（如 akasha 胡桃 蒸发）
 *   akasha 角色列表          查看收录了哪些角色
 */
const AKASHA_REG = /^(?:#?米哈游)?\s*akasha\s*(.*)$/i

/** 中英文角色名归一：去掉空格/标点，统一小写 */
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_.·'"'']/g, '')

/** 常见原神角色的中文名 → akasha 英文名，覆盖不到时退回原名匹配 */
const CN_ALIAS = {
  胡桃: 'Hu Tao', 甘雨: 'Ganyu', 雷神: 'Raiden Shogun', 雷电将军: 'Raiden Shogun',
  神里绫华: 'Kamisato Ayaka', 绫华: 'Kamisato Ayaka', 温迪: 'Venti', 钟离: 'Zhongli',
  可莉: 'Klee', 迪卢克: 'Diluc', 刻晴: 'Keqing', 莫娜: 'Mona', 七七: 'Qiqi',
  琴: 'Jean', 夜兰: 'Yelan', 神里绫人: 'Kamisato Ayato', 八重神子: 'Yae Miko',
  宵宫: 'Yoimiya', 珊瑚宫心海: 'Sangonomiya Kokomi', 心海: 'Sangonomiya Kokomi',
  雷电: 'Raiden Shogun', 申鹤: 'Shenhe', 荒泷一斗: 'Arataki Itto', 一斗: 'Arataki Itoo',
  云堇: 'Yun Jin', 早柚: 'Sayu', 五郎: 'Gorou', 久岐忍: 'Kuki Shinobu',
  鹿野院平藏: 'Shikanoin Heizou', 平藏: 'Shikanoin Heizou', 提纳里: 'Tighnari',
  柯莱: 'Collei', 多莉: 'Dori', 坎蒂丝: 'Candace', 赛诺: 'Cyno', 妮露: 'Nilou',
  纳西妲: 'Nahida', 草神: 'Nahida', 莱依拉: 'Layla', 流浪者: 'Wanderer', 散兵: 'Wanderer',
  珐露珊: 'Faruzan', 瑶瑶: 'Yaoyao', 艾尔海森: 'Alhaitham', 海森: 'Alhaitham',
  迪希雅: 'Dehya', 米卡: 'Mika', 卡维: 'Kaveh', 白术: 'Baizhu', 琳妮特: 'Lynette',
  林尼: 'Lyney', 菲米尼: 'Freminet', 那维莱特: 'Neuvillette', 莱欧斯利: 'Wriothesley',
  芙宁娜: 'Furina', 芙芙: 'Furina', 夏洛蒂: 'Charlotte', 娜维娅: 'Navia',
  夏沃蕾: 'Chevreuse', 嘉明: 'Gaming', 闲云: 'Xianyun', 千织: 'Chiori',
  阿蕾奇诺: 'Arlecchino', 仆人: 'Arlecchino', 克洛琳德: 'Clorinde', 希格雯: 'Sigewinne',
  艾梅莉埃: 'Emilie', 卡齐娜: 'Kachina', 基尼奇: 'Kinich', 玛拉妮: 'Mualani',
  希诺宁: 'Xilonen', 恰斯卡: 'Chasca', 玛薇卡: 'Mavuika', 火神: 'Mavuika',
  茜特菈莉: 'Citlali', 蓝砚: 'Lan Yan', 梦见月瑞希: 'Yumemizuki Mizuki',
  瓦蕾莎: 'Varesa', 伊安珊: 'Iansan', 爱可菲: 'Escoffier', 丝柯克: 'Skirk',
  塔利雅: 'Dahlia', 伊涅芙: 'Ineffa', 菲林斯: 'Flins', 6: '',
  旅行者: 'Traveler', 空: 'Traveler', 荧: 'Traveler',
}

/** 读缓存的分类表；过期或缺失返回 null */
function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (Date.now() - (j.at || 0) < CACHE_TTL && Array.isArray(j.data)) return j.data
  } catch (_) { /* 无缓存 */ }
  return null
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: Date.now(), data }))
  } catch (_) { /* 写缓存失败不影响主流程 */ }
}

/** 从全部分类里挑出某角色的方案；支持中英文名 */
function pickCategories(all, keyword) {
  const key = norm(CN_ALIAS[keyword] || keyword)
  const byName = new Map()
  for (const c of all || []) {
    const en = norm(c.characterName)
    byName.set(en, c.characterName)
  }
  // 先精确命中英文名/中文别名，再退回包含匹配
  let target = byName.get(key)
  if (!target) {
    for (const [en, name] of byName) {
      if (en === key) { target = name; break }
    }
  }
  if (!target) {
    for (const name of new Set((all || []).map(c => c.characterName))) {
      const en = norm(name)
      if (en.includes(key) || key.includes(en)) { target = name; break }
    }
  }
  if (!target) return null
  const list = (all || []).filter(c => c.characterName === target)
  return { name: target, categories: list }
}

/** 从榜单条目里抽出模板要用的字段 */
function viewEntry(e, idx) {
  const calc = e?.calculation || {}
  const owner = e?.owner || {}
  return {
    rank: idx + 1,
    uid: e?.uid || '',
    nickname: owner.nickname || '旅行者',
    ar: Math.floor(Number(owner.adventureRank) || 0),
    region: owner.region || '',
    damage: Number(calc.result) || 0,
    result: formatNum(calc.result),
    cons: e?.constellation ?? 0,
    weapon: {
      name: e?.weapon?.name || '',
      rarity: e?.weapon?.rarity || '',
      refinement: e?.weapon?.refinement ?? '',
    },
    talents: e?.talentsLevelMap || {},
    lastUpdate: e?.lastBuildUpdate ? new Date(e.lastBuildUpdate).toLocaleDateString('zh-CN') : '',
  }
}

function formatNum(v) {
  const n = Number(v) || 0
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return String(Math.round(n))
}

export class akasha_rank extends plugin {
  constructor() {
    super({
      name: '[米哈游]Akasha排名',
      dsc: '原神角色练度全球排名（Akasha System）',
      event: 'message',
      priority: pluginPriority('akasha', -41000),
      rule: [{ reg: AKASHA_REG.source, fnc: 'akasha' }],
    })
  }

  async akasha(e) {
    const arg = String(String(e.msg || '').match(AKASHA_REG)?.[1] || '').trim()
    if (!arg) {
      return e.reply([
        'Akasha System · 原神全球练度榜',
        '',
        '用法：',
        '  akasha <角色>          查看该角色默认配装的全球榜',
        '  akasha <角色> <方案>   指定方案，如 akasha 胡桃 蒸发',
        '  akasha 角色列表        查看收录的角色与玩家数',
        '',
        '数据来自 akasha.cv（按该配装理论伤害排序），需要真实浏览器过验证，',
        '首次查询约 3 秒。',
      ].join('\n'))
    }

    if (/^(角色列表|列表|list)$/i.test(arg)) return this.listRoles(e)

    try {
      return await withPage(async page => {
        // 1) 分类表（缓存）
        let all = readCache()
        if (!all) {
          all = await listCategories(page, null)
          writeCache(all)
        }

        // 2) 定位角色与方案
        const [roleRaw, ...rest] = arg.split(/\s+/)
        const hit = pickCategories(all, roleRaw)
        if (!hit) {
          return e.reply(`akasha 里没有找到「${roleRaw}」。\n可发「akasha 角色列表」查看收录范围。`)
        }
        const planKey = rest.join(' ')
        let cat = hit.categories[0]
        if (planKey) {
          const k = norm(planKey)
          const found = hit.categories.find(c => norm(c.name).includes(k) || norm(c.short) === k)
          if (!found) {
            return e.reply([
              `「${hit.name}」没有匹配到方案「${planKey}」。`,
              '可选方案：',
              ...hit.categories.map(c => `  ${c.name}（${c.short}）`),
            ].join('\n'))
          }
          cat = found
        }

        // 3) 拉榜单
        const { list } = await fetchLeaderboard(page, cat, { size: 20 })
        if (!list.length) return e.reply(`「${hit.name}」的「${cat.name}」暂无榜单数据。`)

        const rows = list.map(viewEntry)
        const img = await render('akasha/rank', {
          roleName: hit.name,
          planName: cat.name,
          planShort: cat.short,
          playerCount: cat.count || 0,
          rows,
        }, { e, ret: true })
        return img
      })
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 查询失败: ${err?.message || err}`)
      return e.reply(`Akasha 查询失败：${err?.message || err}\n（站点有 Cloudflare 验证，偶尔会超时，稍后重试）`)
    }
  }

  /** 收录角色一览（按玩家数降序，取前 40） */
  async listRoles(e) {
    try {
      return await withPage(async page => {
        let all = readCache()
        if (!all) {
          all = await listCategories(page, null)
          writeCache(all)
        }
        const byRole = new Map()
        for (const c of all) {
          const cur = byRole.get(c.characterName) || { name: c.characterName, plans: 0, count: 0, element: c.element, rarity: c.rarity }
          cur.plans += 1
          cur.count = Math.max(cur.count, c.count || 0)
          byRole.set(c.characterName, cur)
        }
        const rows = [...byRole.values()].sort((a, b) => b.count - a.count).slice(0, 40)
        return e.reply([
          `Akasha 收录角色（共 ${byRole.size} 位，按玩家数排序前 ${rows.length}）：`,
          ...rows.map((r, i) => `${String(i + 1).padStart(2, ' ')}. ${r.name}  ${formatNum(r.count)} 人 · ${r.plans} 套方案`),
          '',
          '用 akasha <角色> 查看某个角色的榜单',
        ].join('\n'))
      })
    } catch (err) {
      return e.reply(`获取角色列表失败：${err?.message || err}`)
    }
  }
}
