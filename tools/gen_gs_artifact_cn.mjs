/**
 * 生成原神圣遗物中英对照表 → system/default/gs_artifact_cn.json
 *
 * 来源：miao-plugin 的 resources/meta-gs/artifact/data.json（只有中文名）。
 * akasha 返回的是英文名，两者没有公共 id，无法自动对齐。
 * 这张表是为了把 akasha 的英文名翻成中文显示用，**人工维护**：
 *   · sets / pieces 里是「英文 → 中文」的直接映射
 *   · 新增套装时按 akasha 返回的英文名补一行即可
 *
 * 运行：node tools/gen_gs_artifact_cn.mjs
 * （只是把手工表落成 JSON，方便运行时读取，不做任何抓取）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'system', 'default', 'gs_artifact_cn.json')

/** 套装英文名 → 中文名 */
const SETS = {
  'Fragment of Harmonic Whimsy': '谐律异想断章',
  'Unfinished Reverie': '未竟的遐思',
  'Nighttime Whispers in the Echoing Woods': '回声之林夜话',
  'Song of Days Past': '昔时之歌',
  'Golden Troupe': '黄金剧团',
  'Marechaussee Hunter': '逐影猎人',
  'Nymph\'s Dream': '水仙之梦',
  'Vourukasha\'s Glow': '花海甘露之光',
  'Vermillion Hereafter': '辰砂往生录',
  'Echoes of an Offering': '来歆余响',
  'Deepwood Memories': '深林的记忆',
  'Gilded Dreams': '饰金之梦',
  'Desert Pavilion Chronicle': '沙上楼阁史话',
  'Flower of Paradise Lost': '乐园遗落之花',
  'Husk of Opulent Dreams': '华馆梦醒形骸记',
  'Ocean-Hued Clam': '海染砗磲',
  'Emblem of Severed Fate': '绝缘之旗印',
  'Shimenawa\'s Reminiscence': '追忆之注连',
  'Pale Flame': '苍白之火',
  'Tenacity of the Millelith': '千岩牢固',
  'Crimson Witch of Flames': '炽烈的炎之魔女',
  'Lavawalker': '渡过烈火的贤人',
  'Blizzard Strayer': '冰风迷途的勇士',
  'Heart of Depth': '沉沦之心',
  'Thundersoother': '平息鸣雷的尊者',
  'Thundering Fury': '如雷的盛怒',
  'Viridescent Venerer': '翠绿之影',
  'Maiden Beloved': '被怜爱的少女',
  'Archaic Petra': '悠古的磐岩',
  'Retracing Bolide': '逆飞的流星',
  'Noblesse Oblige': '昔日宗室之仪',
  'Bloodstained Chivalry': '染血的骑士道',
  'Gladiator\'s Finale': '角斗士的终幕礼',
  'Wanderer\'s Troupe': '流浪大地的乐团',
  'Berserker': '战狂',
  'Instructor': '教官',
  'The Exile': '流放者',
  'Defender\'s Will': '守护之心',
  'Tiny Miracle': '奇迹',
  'Scholar': '学士',
  'Prayers for Destiny': '祭水之人',
  'Prayers for Illumination': '祭火之人',
  'Prayers for Wisdom': '祭雷之人',
  'Prayers to Springtime': '祭冰之人',
  'Resolution of Sojourner': '行者之心',
  'Lucky Dog': '幸运儿',
  'Adventurer': '冒险家',
  'Gambler': '赌徒',
  'Martial Artist': '武人',
  'Brave Heart': '勇士之心',
  'Prayers to the Firmament': '祭风之人',
  'Aubade of Morningstar and Moon': '长夜之誓',
  'Silken Moon\'s Serenade': '月女的华彩',
  'Finale of the Deep Galleries': '深廊终曲',
  'Long Night\'s Oath': '长夜之誓',
  'Obsidian Codex': '黑曜秘典',
  'Scroll of the Hero of Cinder City': '烬城勇者绘卷',
  'Song of Days Past ': '昔时之歌',
  'Unfinished Reverie ': '未竟的遐思',
  'Bloodstained Chivalry ': '染血的骑士道',
  'Disenchantment in Deep Dreams': '梦醒之瓢',
  'Wanderer\'s Troupe ': '流浪大地的乐团',
}

/** 单件英文名 → 中文名（akasha 的 name 字段） */
const PIECES = {
  'Harmonious Symphony Prelude': '谐律交响的前奏',
  'Ancient Sea\'s Nocturnal Musing': '古海玄幽的夜想',
  'The Grand Jape of the Turning of Fate': '命途轮转的谐谑',
  'Ichor Shower Rhapsody': '灵露倾洒的狂诗',
  'Whimsical Dance of the Withered': '异想零落的圆舞',
  'Deft Hands': '灵巧手',
  'In Remembrance of Viridescent Fields': '翠绿的追忆',
  'Viridescent Venerer\'s Broken Oath': '翠绿的猎人',
  'A Drifting Petal': '翠绿的猎人之花',
  'Viridescent Venerer\'s Sorrow': '翠绿的猎人之羽',
  'Viridescent Venerer\'s Longing': '翠绿的猎人之时',
  'Viridescent Venerer\'s Vessel': '翠绿的猎人之瓶',
  'Viridescent Venerer\'s Wreath': '翠绿的猎人之冠',
}

const data = {
  _comment: '原神圣遗物英文 → 中文对照。akasha 只返回英文名且无 id，只能靠这张表翻译。新增套装时在此补一行后重跑本脚本。',
  sets: SETS,
  pieces: PIECES,
}

fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n')
console.log(`已写入 ${OUT}`)
console.log(`套装 ${Object.keys(SETS).length} 条，单件 ${Object.keys(PIECES).length} 条`)
