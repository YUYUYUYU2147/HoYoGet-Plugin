import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pluginPriority, render, config } from '#HoYoGet'
import {
  listCategories, fetchLeaderboard, listStygianSchedules, fetchStygianLeaderboard,
  fetchStygianRankOfUser, getUserCalculations, getUserProfile,
} from '../system/akasha.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_CN_FILE = path.join(PLUGIN_ROOT, 'system', 'default', 'gs_artifact_cn.json')

/** 圣遗物英文名 → 中文（akasha 只给英文，无 id 可自动对照，靠这份手工表） */
let ARTIFACT_CN = null
function artifactCn() {
  if (ARTIFACT_CN) return ARTIFACT_CN
  try {
    ARTIFACT_CN = JSON.parse(fs.readFileSync(ARTIFACT_CN_FILE, 'utf8'))
  } catch (_) {
    ARTIFACT_CN = { sets: {}, pieces: {} }
  }
  return ARTIFACT_CN
}
const cnSetName = en => artifactCn().sets?.[en] || en || ''
const cnPieceName = en => artifactCn().pieces?.[en] || en || ''
const CACHE_FILE = path.join(PLUGIN_ROOT, 'temp', 'akasha_categories.json')
const CACHE_TTL = 6 * 3600 * 1000   // 分类（角色→方案）缓存 6 小时

/**
 * Akasha System 全球榜。
 *
 * 数据源只需要伪装 UA（GsCore / GenshinUID），无需浏览器，单次请求 1 秒内。
 * 角色→方案的分类表变化慢，缓存 6 小时；榜单本身不缓存（用户要看当下排名）。
 *
 * 指令：
 *   akasha <角色>            角色配装的全球榜（默认方案）
 *   akasha <角色> <方案名>   指定方案（如 akasha 胡桃 蒸发）
 *   akasha 角色列表          收录了哪些角色
 *   akasha 幽境 [期数]       幽境危战全球榜（省略期数取最新一期）
 */
/* 多种写法都收（akasha 不好打，中文写法是主入口）：
   · #<角色>全球排名 / <角色>全球排名   —— 与绝区零的 %<角色>面板排名 对齐
   · 全球 <角色> [方案] / 全球排名 <角色> —— 更短的写法
   · akasha / 阿卡夏 <角色> [方案]      —— 英文名与中文译名（阿卡夏 / 阿克夏）都收 */
const AKASHA_REG = /^#?(?:米哈游)?\s*(?:akasha|阿卡夏|阿克夏)\s*(.*)$/i
/* 负向预查排除「我的」：否则「#我的全球排名」会被当成角色名「我的」 */
const AKASHA_CN_REG = /^#?(?:米哈游)?\s*(?!我的\s*$|全球\s*$)(.+?)\s*全球排名$/
const AKASHA_SHORT_REG = /^#?(?:米哈游)?\s*全球(?:排名)?\s+(.+)$/
/* 查「我自己的排名」：名次数据在 getCalculationsForUser 里，
   与上面那几个「看榜单前 N 名」的指令是完全不同的数据源。 */
/* 可带 UID：#我的全球排名 123456789 */
const AKASHA_ME_REG = /^#?(?:米哈游)?\s*(?:我的)?全球(?:排名?|名次)?(?:\s+\d{9,10})?\s*$/
/* 我的幽境排名：#我的幽境排名 / 幽境排名 / my幽境 */
const AKASHA_MY_STYGIAN_REG = /^#?(?:米哈游)?\s*(?:我的)?幽境(?:排名|名次|成绩)(?:\s+\d{1,2}\.\d)?(?:\s+\d{9,10})?\s*$/
/* 我的圣遗物排行（Akasha 无全球圣遗物榜，只按暴击值排自己的） */
const AKASHA_ARTIFACT_REG = /^#?(?:米哈游)?\s*(?:我的)?圣遗物(?:排名|排行|评分|榜)(?:\s+\d{9,10})?\s*$/

/**
 * 从 Yunzai 的 Users 表读该用户的「原神 UID」（games.gs.uid）。
 * 喵喵插件绑定的也是这一份数据，所以两种绑定方式都能命中。
 */
async function readBoundGsUid(e) {
  const qq = String(e?.user_id || e?.sender?.user_id || '').trim()
  if (!qq) return ''
  const dbFile = path.join(process.cwd(), 'data', 'db', 'data.db')
  if (!fs.existsSync(dbFile)) return ''
  try {
    const sqlite3 = (await import('sqlite3')).default
    const row = await new Promise(resolve => {
      const db = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY, err => (err ? resolve(null) : null))
      db.get('select games from Users where id = ?', [qq], (err2, r) => {
        db.close(() => {})
        resolve(err2 ? null : r)
      })
    })
    if (!row?.games) return ''
    const uid = String(JSON.parse(row.games)?.gs?.uid || '').trim()
    return /^[1-9]\d{8,9}$/.test(uid) ? uid : ''
  } catch (_) {
    return ''
  }
}

/**
 * 解析要查询的原神 UID。
 * 顺序：消息里的 9~10 位数字 → e.uid → Users 表 games.gs.uid → 喵喵的 MysApi。
 * 不用 miao 的 getTargetUid()：它未绑定时会自己 reply 提示并置 e._replyNeedUid，
 * 与本插件的回复重复。
 */
async function resolveGsUid(e) {
  let uid = ''
  const inMsg = String(e?.msg || '').match(/\b([1-9]\d{8,9})\b/)
  if (inMsg) uid = inMsg[1]
  if (!uid) uid = String(e?.uid || '').trim()
  if (!uid) uid = await readBoundGsUid(e)
  if (!uid) {
    try {
      const { MysApi } = await import('../../miao-plugin/models/index.js')
      const user = await MysApi.initUser(e)
      if (user?.uid) uid = String(user.uid)
    } catch (_) { /* 没装喵喵或接口变了就跳过 */ }
  }
  return /^[1-9]\d{8,9}$/.test(uid) ? uid : ''
}

/** 角色 id → 中文名（用 CN_ALIAS 反查；查不到就退回英文名） */
const ID_TO_CN = { 10000002: '神里绫华', 10000003: '琴', 10000006: '丽莎', 10000007: '荧',
  10000016: '迪卢克', 10000021: '安柏', 10000022: '温迪', 10000023: '香菱', 10000024: '北斗',
  10000025: '行秋', 10000026: '魈', 10000027: '凝光', 10000029: '可莉', 10000030: '钟离',
  10000031: '菲谢尔', 10000032: '班尼特', 10000034: '诺艾尔', 10000035: '七七', 10000036: '重云',
  10000037: '甘雨', 10000038: '阿贝多', 10000039: '迪奥娜', 10000041: '莫娜', 10000042: '刻晴',
  10000043: '砂糖', 10000044: '辛焱', 10000045: '罗莎莉亚', 10000046: '胡桃', 10000047: '枫原万叶',
  10000048: '烟绯', 10000049: '宵宫', 10000050: '托马', 10000051: '优菈', 10000052: '雷电将军',
  10000053: '早柚', 10000054: '珊瑚宫心海', 10000055: '五郎', 10000056: '九条裟罗', 10000057: '荒泷一斗',
  10000058: '八重神子', 10000059: '鹿野院平藏', 10000060: '夜兰', 10000061: '绮良良',
  10000062: '埃洛伊', 10000063: '申鹤', 10000064: '云堇', 10000065: '久岐忍', 10000066: '神里绫人',
  10000067: '柯莱', 10000068: '多莉', 10000069: '提纳里', 10000070: '妮露', 10000071: '赛诺',
  10000072: '坎蒂丝', 10000073: '纳西妲', 10000074: '莱依拉', 10000075: '流浪者', 10000076: '珐露珊',
  10000077: '瑶瑶', 10000078: '艾尔海森', 10000079: '迪希雅', 10000080: '米卡', 10000081: '卡维',
  10000082: '白术', 10000083: '琳妮特', 10000084: '林尼', 10000085: '菲米尼', 10000086: '莱欧斯利',
  10000087: '那维莱特', 10000088: '夏洛蒂', 10000089: '芙宁娜', 10000090: '夏沃蕾',
  10000091: '娜维娅', 10000092: '神里绫华', 10000093: '闲云', 10000094: '嘉明', 10000095: '千织',
  10000096: '阿蕾奇诺', 10000097: '希格雯', 10000098: '克洛琳德', 10000099: '艾梅莉埃',
  10000101: '基尼奇', 10000102: '玛拉妮', 10000103: '卡齐娜', 10000104: '希诺宁',
  10000105: '恰斯卡', 10000106: '玛薇卡', 10000107: '茜特菈莉', 10000108: '蓝砚',
  10000109: '梦见月瑞希', 10000110: '瓦蕾莎', 10000111: '伊安珊', 10000112: '爱可菲',
  10000113: '丝柯克', 10000114: '塔利雅', 10000115: '伊涅芙', 10000116: '菲林斯' }

const characterName = (id, fallback = '') => ID_TO_CN[id] || fallback || String(id)

/**
 * akasha 的方案名是英文（如 "Melt Combo, Avg DMG"），接口不提供中文。
 * 这里按「术语 → 中文」逐词替换，剩下的英文原样保留。
 * 覆盖率靠 akasha 的实际用词统计得出（Combo/Team/Vape/Melt 等出现频率最高）。
 */
const PLAN_TERMS = [
  // 反应
  [/Avg DMG|Average DMG/gi, '平均伤害'],
  [/Lunar-Bloom/gi, '月绽放'], [/Lunar-Charged/gi, '月感电'], [/Lunar-Crystallize/gi, '月结晶'],
  [/Stellar-Conduct/gi, '星导'], [/Moonsign/gi, '月兆'],
  [/Melt/gi, '融化'], [/Vape|Vaporize/gi, '蒸发'], [/Overload/gi, '超载'],
  [/Aggravate/gi, '激化'], [/Spread/gi, '蔓激化'], [/Hyperbloom/gi, '超绽放'],
  [/Quickbloom/gi, '激绽'], [/Bloom/gi, '绽放'], [/Burgeon/gi, '烈绽放'],
  [/Freeze|Frozen/gi, '冻结'], [/Superconduct/gi, '超导'], [/Electro-Charged/gi, '感电'],
  [/Shatter/gi, '碎冰'], [/Crystallize/gi, '结晶'], [/Swirl/gi, '扩散'],

  // 队伍/打法
  [/Premium Team/gi, '高配队'], [/Basic Team/gi, '基础队'], [/Hyper Team/gi, '强化队'],
  [/Team/gi, '队'], [/Combo/gi, '连招'], [/Rotation/gi, '循环'],
  [/On-Field|On Field/gi, '站场'], [/Off-Field|Off Field/gi, '后台'],
  [/Main DPS/gi, '主C'], [/Sub DPS|Sub-DPS/gi, '副C'], [/DPS/gi, '输出'],
  [/Skill/gi, '战技'], [/Burst/gi, '爆发'], [/Normal Attack/gi, '普攻'],
  [/Charged Attack/gi, '重击'], [/Plunge/gi, '下落'], [/EQ/gi, '战技+爆发'],
  [/Basic/gi, '基础'], [/Premium/gi, '高配'], [/Hyper/gi, '强化'],
  // 数量/构成
  [/Triple/gi, '三'], [/Double/gi, '双'], [/Single/gi, '单'], [/Mono/gi, '纯色'],
  // 元素
  [/Pyro/gi, '火'], [/Hydro/gi, '水'], [/Cryo/gi, '冰'], [/Electro/gi, '雷'],
  [/Anemo/gi, '风'], [/Geo/gi, '岩'], [/Dendro/gi, '草'],
  // 场景
  [/vs Boss/gi, '对单'], [/Boss/gi, '首领'], [/AoE/gi, '对群'],
  [/Single Target/gi, '单体'], [/Unbuffed/gi, '无buff'], [/Full Buffs?/gi, '满buff'],
  [/Max Stacks?/gi, '满层'], [/with/gi, '配'], [/without/gi, '不带'],
  [/No Buffs?/gi, '无buff'], [/Balance/gi, '平衡'], [/Formula/gi, '公式'],
  [/Energy Recharge|ER/gi, '充能'],
]

/** 把英文方案名翻成中文；不认识的部分保留原文 */
function cnPlanName(name = '') {
  let out = String(name)
  for (const [re, cn] of PLAN_TERMS) out = out.replace(re, cn)
  return out
    .replace(/\s*,\s*/g, ' · ')          // 逗号变分隔点
    // 两个中文字符之间的空格去掉：「融化 连招」→「融化连招」
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 圣遗物部位（enka 的 equipType） */
const SLOT_CN = {
  EQUIP_BRACER: '生之花', EQUIP_NECKLACE: '死之羽',
  EQUIP_SHOES: '时之沙', EQUIP_RING: '空之杯',
  EQUIP_ONSET: '理之冠',
}

/** enka 属性键 → 中文 */
const STAT_CN = {
  'Flat HP': '生命值', 'HP%': '生命值%', 'Flat ATK': '攻击力', 'ATK%': '攻击力%',
  'Flat DEF': '防御力', 'DEF%': '防御力%',
  'Crit RATE': '暴击率', 'Crit DMG': '暴击伤害',
  'Energy Recharge': '充能效率', 'Elemental Mastery': '元素精通',
  'Healing Bonus': '治疗加成', 'Physical DMG Bonus': '物理伤害',
  'Pyro DMG Bonus': '火伤', 'Hydro DMG Bonus': '水伤', 'Cryo DMG Bonus': '冰伤',
  'Electro DMG Bonus': '雷伤', 'Anemo DMG Bonus': '风伤', 'Geo DMG Bonus': '岩伤',
  'Dendro DMG Bonus': '草伤',
}
const cnStat = k => STAT_CN[k] || k || ''

/** 属性值格式化：百分比类加 %，其余取整 */
function formatStatValue(key = '', v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return /%|Bonus|Recharge|RATE|DMG/.test(key) ? `${n.toFixed(1)}%` : String(Math.round(n))
}

/** 幽境危战难度档位（与游戏内一致） */
const STYGIAN_DIFFICULTY = ['未挑战', '普通', '进阶', '困难', '险恶', '无畏', '绝境']

/** 精炼中文：R1 → 一阶，R5 → 满精 */
const refineText = n => {
  const v = Number(n) || 0
  if (!v) return ''
  if (v >= 5) return '满精'
  return `${['', '一', '二', '三', '四'][v]}阶`
}

/** 命座中文：C0 → 零命，C6 → 满命（原神称「命之座」，社区口语「几命」） */
const consText = n => {
  const v = Number(n) || 0
  if (v >= 6) return '满命'
  const CN = ['零命', '一命', '二命', '三命', '四命', '五命']
  return CN[v] || `${v}命`
}

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
    consText: consText(e?.constellation),
    weapon: {
      name: e?.weapon?.name || '',
      rarity: e?.weapon?.rarity || '',
      refinement: e?.weapon?.refinement ?? '',
      refineText: refineText(e?.weapon?.refinement),
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
      /* 规则按「具体 → 宽泛」排列：ME 必须排在 CN/SHORT 前面，
         否则「#我的全球排名」会被 CN 的 (.+?) 当成角色名「我的」抓走。 */
      rule: [
        { reg: AKASHA_ME_REG.source, fnc: 'myRank' },
        { reg: AKASHA_MY_STYGIAN_REG.source, fnc: 'myStygianRank' },
        { reg: AKASHA_ARTIFACT_REG.source, fnc: 'myArtifactRank' },
        { reg: AKASHA_REG.source, fnc: 'akasha' },
        { reg: AKASHA_CN_REG.source, fnc: 'akasha' },
        { reg: AKASHA_SHORT_REG.source, fnc: 'akasha' },
      ],
    })
  }

  async akasha(e) {
    const raw = String(e.msg || '')
    // 中文写法 → 转成内部参数
    const cn = raw.match(AKASHA_CN_REG)
    const short = raw.match(AKASHA_SHORT_REG)
    let arg = cn
      ? cn[1].trim()
      : short
        ? short[1].trim()
        : String(raw.match(AKASHA_REG)?.[1] || '').trim()
    // 「#原神全球排名」等同于不带参数的 akasha（出帮助 + 用法）
    if (/^(原神|genshin)$/i.test(arg)) arg = ''
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
    // 「#幽境全球排名」/「akasha 幽境 7.1」都走幽境榜
    if (/^幽境/.test(arg)) return this.stygian(e, arg)

    try {
      // 1) 分类表（缓存）
      let all = readCache()
      if (!all) {
        all = await listCategories()
        writeCache(all)
      }

      // 2) 定位角色与方案
      const [roleRaw, ...rest] = arg.split(/\s+/)
      const hit = pickCategories(all, roleRaw)
      if (!hit) {
        return e.reply(`akasha 里没有找到「${roleRaw}」。\n可发「akasha 角色列表」查看收录范围。`)
      }
      /* 不指定方案时把该角色的**全部方案**都拉出来（每个方案是一个独立榜单）。
         指定方案才只出那一个。方案数最多 6 个（神里绫华），并发拉取。 */
      const planKey = rest.join(' ')
      let cats = hit.categories
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
        cats = [found]
      }

      // 并发拉取每个方案的榜单
      const boards = await Promise.all(cats.map(async c => {
        try {
          const { list } = await fetchLeaderboard(c, { size: 20 })
          return { cat: c, rows: list.map(viewEntry) }
        } catch (err) {
          logger.warn?.(`[HoYoGet][akasha] 方案「${c.name}」拉取失败：${err?.message || err}`)
          return { cat: c, rows: [] }
        }
      }))
      const usable = boards.filter(b => b.rows.length)
      if (!usable.length) return e.reply(`「${hit.name}」暂无榜单数据。`)

      const img = await render('akasha/rank', {
        roleName: hit.name,
        boards: usable.map(b => ({
          planName: cnPlanName(b.cat.name),
          planShort: b.cat.short,
          playerCount: b.cat.count || 0,
          rows: b.rows,
        })),
        planCount: usable.length,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 查询失败: ${err?.message || err}`)
      return e.reply(`Akasha 查询失败：${err?.message || err}`)
    }
  }

  /**
   * 「#我的全球排名」：查自己的每个角色在 Akasha 上的名次。
   *
   * UID 来源依次为：消息里直接写的 UID → e.uid → 喵喵插件绑定的原神 UID。
   * 名次来自 getCalculationsForUser（不受「榜单只返回前 50」的限制）。
   */
  async myRank(e) {
    const uid = await resolveGsUid(e)
    if (!uid) {
      return e.reply([
        '没能确定要查询的原神 UID。',
        '可以这样用：',
        '  #我的全球排名 123456789   （直接带 UID）',
        '  或先绑定：#绑定123456789',
      ].join('\n'))
    }

    try {
      const [list, profile] = await Promise.all([
        getUserCalculations(uid),
        getUserProfile(uid).catch(() => null),
      ])
      if (!list.length) {
        return e.reply(`Akasha 上没有 UID ${uid} 的数据。\n请先在 akasha.cv 更新一次展柜（角色详情需在游戏内公开）。`)
      }

      // 只保留有排名数据的角色，按百分位排序（名次/总数越小越靠前）
      const rows = list
        .map(r => {
          const fit = r?.calculations?.fit
          if (!fit?.ranking) return null
          const rank = Number(fit.ranking) || 0
          const outOf = Number(fit.outOf) || 0
          return {
            name: characterName(r.characterId),
            icon: r.icon || '',
            rank,
            outOf,
            percent: outOf ? rank / outOf * 100 : 0,
            // 「超过多少人」= 100 − 百分位；名次 1 时就是 99.9%
            beatPercent: outOf ? Math.max(0, (1 - rank / outOf) * 100).toFixed(1) : '0.0',
            planName: cnPlanName(fit.name || ''),
            result: formatNum(fit.result),
            weapon: fit.weapon?.name || r.weapon?.name || '',
            cons: r.constellation ?? 0,
            consText: consText(r.constellation),
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.percent - b.percent)

      if (!rows.length) return e.reply(`UID ${uid} 在 Akasha 上暂无可用的排名数据（角色可能未进任何榜单）。`)

      const img = await render('akasha/myrank', {
        uid,
        nickname: profile?.account?.nickname || '',
        level: profile?.account?.level || '',
        region: profile?.account?.region || '',
        rows,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 查我的排名失败: ${err?.message || err}`)
      return e.reply(`查询失败：${err?.message || err}`)
    }
  }

  /**
   * 「#我的幽境排名」：查自己在幽境危战里的全球名次。
   *
   * 与角色榜不同，幽境榜的接口**支持 uid 过滤**（角色榜的 uids 参数被服务端忽略），
   * 所以能直接拿到任意名次；返回的 index 就是全球排名。
   */
  async myStygianRank(e) {
    const uid = await resolveGsUid(e)
    if (!uid) {
      return e.reply([
        '没能确定要查询的原神 UID。',
        '可以这样用：',
        '  #我的幽境排名 123456789',
        '  或先绑定：#绑定123456789',
      ].join('\n'))
    }

    try {
      const schedules = await listStygianSchedules()
      if (!schedules.length) return e.reply('Akasha 暂未收录幽境危战榜单。')

      // 消息里可带版本号（如「#我的幽境排名 7.0」），否则取最新一期
      const ver = String(e.msg || '').match(/\b(\d{1,2}\.\d)\b/)?.[1]
      let board = schedules[0]
      if (ver) {
        const hit = schedules.find(s => String(s.version) === ver)
        if (!hit) {
          return e.reply([
            `没有找到幽境期数「${ver}」。`,
            '可选期数（最近 8 期）：',
            ...schedules.slice(0, 8).map(s => `  ${s.version}（期号 ${s.scheduleId}）`),
          ].join('\n'))
        }
        board = hit
      }

      const res = await fetchStygianRankOfUser(board.version, uid)
      if (!res) {
        return e.reply([
          `UID ${uid} 在幽境危战 ${board.version} 期没有查到成绩。`,
          '可能原因：这一期没有打，或者没在小程序里上传过成绩。',
        ].join('\n'))
      }
      if (res.flagged) {
        return e.reply(`UID ${uid} 在幽境 ${board.version} 期的成绩被 Akasha 标记，暂不计入排名。`)
      }

      const img = await render('akasha/mystygian', {
        uid,
        version: board.version,
        scheduleId: board.scheduleId,
        sampleText: formatNum(board.count || 0),
        rank: res.rank,
        scoreText: formatNum(res.score),
        difficultyText: STYGIAN_DIFFICULTY[res.difficulty] || String(res.difficulty),
        seconds: res.seconds,
        nickname: res.nickname,
        region: res.region,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 查我的幽境排名失败: ${err?.message || err}`)
      return e.reply(`查询失败：${err?.message || err}`)
    }
  }

  /**
   * 「#我的圣遗物排行」：把自己在 Akasha 上展示的圣遗物按暴击值排序。
   *
   * Akasha 没有圣遗物全球榜，只给每个圣遗物的 critValue
   * （暴击率×2 + 暴击伤害）。所以这是**个人排行**，不是全球排名。
   */
  async myArtifactRank(e) {
    const uid = await resolveGsUid(e)
    if (!uid) {
      return e.reply([
        '没能确定要查询的原神 UID。',
        '可以这样用：',
        '  #我的圣遗物排行 123456789',
        '  或先绑定：#绑定123456789',
      ].join('\n'))
    }

    try {
      const list = await getArtifactsByUid(uid)
      if (!list.length) {
        return e.reply([
          `Akasha 上没有 UID ${uid} 的圣遗物数据。`,
          '圣遗物需要在游戏内公开后，通过 Akasha 的浏览器扩展或站点同步才会收录。',
        ].join('\n'))
      }

      const rows = list.slice(0, 20).map((a, i) => {
        const subs = a.substats || {}
        // 暴击率×2 + 暴击伤害 与接口给的 critValue 应一致，这里自己算一份用于展示
        const cr = Number(subs['Crit RATE'] || 0)
        const cd = Number(subs['Crit DMG'] || 0)
        return {
          rank: i + 1,
          name: cnPieceName(a.name) || a.name || '',
          set: cnSetName(a.setName) || a.setName || '',
          icon: a.icon || '',
          slot: SLOT_CN[a.equipType] || a.equipType || '',
          stars: a.stars || 0,
          level: a.level ?? 0,
          critValue: Math.round(Number(a.critValue) || 0),
          critRate: cr ? cr.toFixed(1) : '',
          critDmg: cd ? cd.toFixed(1) : '',
          mainStat: cnStat(a.mainStatKey),
          mainValue: formatStatValue(a.mainStatKey, a.mainStatValue),
          substats: Object.entries(subs)
            .filter(([k]) => !/^(Crit RATE|Crit DMG)$/.test(k))
            .map(([k, v]) => ({ name: cnStat(k), value: formatStatValue(k, v) })),
        }
      })

      const avg = rows.length ? (rows.reduce((s, r) => s + r.critValue, 0) / rows.length).toFixed(1) : '0'
      const best = rows[0] || null

      const img = await render('akasha/artifact', {
        uid,
        total: list.length,
        shown: rows.length,
        avg,
        bestValue: best?.critValue || 0,
        rows,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 圣遗物排行失败: ${err?.message || err}`)
      return e.reply(`查询失败：${err?.message || err}`)
    }
  }

  /** 收录角色一览（按玩家数降序，取前 40） */
  async listRoles(e) {
    try {
      let all = readCache()
      if (!all) {
        all = await listCategories()
        writeCache(all)
      }
      const byRole = new Map()
      for (const c of all) {
        const cur = byRole.get(c.characterName) || { name: c.characterName, plans: 0, count: 0 }
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
    } catch (err) {
      return e.reply(`获取角色列表失败：${err?.message || err}`)
    }
  }

  /** 幽境危战全球榜（akasha 的 stygian 榜单） */
  async stygian(e, arg) {
    try {
      const schedules = await listStygianSchedules()
      if (!schedules.length) return e.reply('Akasha 暂未收录幽境危战榜单。')

      // 参数可以是版本号（如 5.3）或期号；省略取最新一期
      const key = String(arg).replace(/^幽境(危战)?/, '').trim()
      let board = schedules[0]
      if (key) {
        const hit = schedules.find(s => String(s.version) === key || String(s.scheduleId) === key)
        if (!hit) {
          return e.reply([
            `没有找到幽境期数「${key}」。`,
            '可选期数（最近 8 期）：',
            ...schedules.slice(0, 8).map(s => `  ${s.version}（期号 ${s.scheduleId}，样本 ${formatNum(s.count)}）`),
          ].join('\n'))
        }
        board = hit
      }

      const { list } = await fetchStygianLeaderboard(board.version, { size: 20 })
      if (!list.length) return e.reply(`幽境 ${board.version} 暂无榜单数据。`)

      const rows = list.map((e2, i) => ({
        ...viewEntry(e2, i),
        score: Number(e2?.stygianScore) || 0,
        scoreText: formatNum(e2?.stygianScore),
        seconds: Number(e2?.stygianSeconds) || 0,
        difficulty: Number(e2?.stygianIndex) || 0,
        flagged: !!e2?.isCheating || Number(e2?.susLevel) > 0,
      }))

      const img = await render('akasha/stygian', {
        version: board.version,
        scheduleId: board.scheduleId,
        sampleCount: board.count || 0,
        sampleText: formatNum(board.count),
        rows,
      }, { e, ret: true })
      return img
    } catch (err) {
      logger.error?.(`[HoYoGet][akasha] 幽境查询失败: ${err?.message || err}`)
      return e.reply(`幽境全球榜查询失败：${err?.message || err}`)
    }
  }
}
