import { yaml, render, mys, config, reply_recallMsg } from '#xhh';
import { gsRoleView, srRoleView } from '../system/role_detail.js';
import { buildRelicView, extractRelicArt } from './wiki/relic_view.js';
import { fetchGsRole, buildGsDetail, fetchGsGuidePage, parseGsGuide, resolveGsGuideIcons, fetchGsRoleList, fetchGsWeaponList, fetchGsArtifactList, fetchSrRoleList, fetchSrLcList, fetchSrRelicList } from './wiki/bwiki_gs.js';
import { fetchSrRole } from './wiki/bwiki_sr.js';
import { fetchGsBwikiItem, fetchGsBwikiItemHtml } from './wiki/bwiki_gs_item.js';
import { mihoyoItemAgents, mihoyoEntryId, mihoyoDiscParts } from './wiki/mihoyo_agents.js';
import { zzzDiscAgents } from './wiki/zzz_disc_agents.js';
import { fetchSrBwikiItem } from './wiki/bwiki_sr_item.js';
import { fetchZzzBwikiWeapon, fetchZzzBwikiDisc, fetchZzzBwikiChar, fetchZzzBwikiBangboo } from './wiki/bwiki_zzz.js';
import { fetchZzzRoleCard } from './wiki/zzz_role.js';
import { fetchMihoyoBangboo, buildBangbooView } from './wiki/bangboo_view.js';
import { fetchSrGuide } from './wiki/bwiki_sr_guide.js';
import { readFileSync } from 'node:fs';
import fs from 'fs';
import { JSDOM } from 'jsdom';
const { window } = new JSDOM();
const DOMParser = window.DOMParser;

// 绝区零角色/音擎别名，分别配置在 system/default/zzz_js_names.yaml、zzz_wq_names.yaml（格式：正式名: [别名列表]）
// 单字别名（如"雅"）过于宽泛，不能直接参与模糊兜底，否则随机串会误命中，只做精确匹配。
const _zzzAliasCache = {};
const ZZZ_ALIAS_FILES = {
  43: 'zzz_js_names.yaml',   // 代理人
  44: 'zzz_yq_names.yaml',   // 邦布
  45: 'zzz_wq_names.yaml',   // 音擎
  46: 'zzz_syw_names.yaml'   // 驱动盘
};
// nanoka 驱动盘推荐副词条（fairy_recommend.part_sub_list）只给属性 ID，
// ID→名称映射只能从各角色 part4/5/6/part_sub 收集，覆盖不全时会漏（如安比的暴击伤害=21103），
// 这里内置完整对照表兜底（11x/12x/13x 结尾 02 为百分比、03 为固定值）。
const ZZZ_PROP_NAMES = {
  11102: '生命值百分比', 11103: '生命值',
  12102: '攻击力百分比', 12103: '攻击力',
  13102: '防御力百分比', 13103: '防御力',
  12202: '冲击力',
  20103: '暴击率', 21103: '暴击伤害',
  23103: '穿透率', 30502: '能量自动回复',
  31203: '异常精通', 31402: '异常掌控',
  31503: '物理伤害加成', 31603: '火属性伤害加成',
  31703: '冰属性伤害加成', 31803: '电属性伤害加成',
  31903: '以太伤害加成', 32303: '风属性伤害加成'
};

// 兼容 ZZZ-Plugin（ZZZure/ZZZ-Plugin）的代理人别名表：
// 它的别名同样是「正式名: [别名列表]」，但存在 config/alias.yaml（用户自定义）与 defSet/alias.yaml（默认）两处，
// 且会随版本更新补充新角色/英文别名。这里读它做补充，本地表优先。
const ZZZ_PLUGIN_ALIAS_FILES = [
  './plugins/ZZZ-Plugin/config/alias.yaml',
  './plugins/ZZZ-Plugin/defSet/alias.yaml'
];
let _zzzPluginAlias = null;
function zzzPluginAliasMap() {
  if (_zzzPluginAlias) return _zzzPluginAlias;
  const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase();
  const map = {};
  for (const file of ZZZ_PLUGIN_ALIAS_FILES) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = yaml.get(file);
      if (!data || typeof data !== 'object') continue;
      for (const [formal, val] of Object.entries(data)) {
        const fk = norm(formal);
        if (!fk) continue;
        // 数组是默认写法；对象形态（{name, full_name, alias}）也兼容一下
        const list = Array.isArray(val) ? val : [val?.name, val?.full_name, val?.alias, ...(val?.aliases || [])];
        for (const key of [fk, ...list.map(norm)].filter(Boolean)) {
          if (!map[key]) map[key] = formal; // 先读 config，用户自定义优先
        }
      }
    } catch (_) { /* 插件不存在或格式异常时忽略 */ }
  }
  _zzzPluginAlias = map;
  return map;
}

// 兼容 喵喵插件（miao-plugin）的原神/星铁角色、武器别名：
// 它的 Character/Weapon 模型自带完整别名表，get(name) 支持用别名反查正式名。
// 本地 yaml 与官方 Wiki 都匹配不到时，用它兜底（本地表优先，加载失败静默降级）。
let _miaoModels = null;
async function miaoModels() {
  if (_miaoModels !== null) return _miaoModels;
  try {
    _miaoModels = await import('../../miao-plugin/models/index.js');
  } catch (err) {
    _miaoModels = false;
    if (config().debug) logger.mark(`[xhh] 未加载 miao-plugin 模型，跳过喵喵别名兜底: ${err?.message || err}`);
  }
  return _miaoModels;
}
// kind: 'char' | 'weapon'；game: 'gs' | 'sr'
async function miaoResolve(raw = '', kind = 'char', game = 'gs') {
  const models = await miaoModels();
  if (!models) return '';
  try {
    const Model = kind === 'weapon' ? models.Weapon : models.Character;
    if (!Model?.get) return '';
    const hit = Model.get(raw, game === 'sr' ? 'sr' : 'gs');
    return hit?.name || '';
  } catch (_) {
    return '';
  }
}

function zzzAliasMap(channelId = 43) {
  const file = ZZZ_ALIAS_FILES[channelId] || ZZZ_ALIAS_FILES[43];
  const cacheKey = `__${file}`;
  if (_zzzAliasCache[cacheKey]) return _zzzAliasCache[cacheKey];
  const names = yaml.get(`./plugins/xhh/system/default/${file}`) || {};
  const norm = v => String(v || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase();
  const map = {};
  for (const [formal, aliases] of Object.entries(names)) {
    const fk = norm(formal);
    if (fk) map[fk] = formal;
    for (const a of (Array.isArray(aliases) ? aliases : [])) {
      const key = norm(a);
      if (key) map[key] = formal;
    }
  }
  // 代理人（channel 43）再并入 ZZZ-Plugin 的别名，本地表已有的键不覆盖
  if (Number(channelId) === 43) {
    for (const [key, formal] of Object.entries(zzzPluginAliasMap())) {
      if (key && !map[key]) map[key] = formal;
    }
  }
  _zzzAliasCache[cacheKey] = map;
  return map;
}


function collectWikiValues(input, nameOnly = false, out = []) {
  if (input === undefined || input === null) return out;
  if (typeof input === 'string') {
    if (nameOnly) {
      const text = input.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      if (text) out.push(text);
    } else {
      const links = input.match(/https?:\/\/[^\s"'<>\)]+/g) || [];
      out.push(...links);
      const srcs = [...input.matchAll(/(?:src|data-src)=['"]([^'"]+)['"]/g)].map(m => m[1]);
      out.push(...srcs);
    }
    return out;
  }
  if (Array.isArray(input)) {
    for (const item of input) collectWikiValues(item, nameOnly, out);
    return out;
  }
  if (typeof input === 'object') {
    const keys = nameOnly
      ? ['name', 'title', 'label', 'text', 'value', 'desc', 'nickname']
      : ['icon', 'img', 'image', 'url', 'src', 'avatar', 'file', 'value'];
    for (const key of keys) {
      if (typeof input[key] === 'string' && input[key]) out.push(input[key]);
    }
    for (const val of Object.values(input)) {
      if (val && typeof val === 'object') collectWikiValues(val, nameOnly, out);
    }
  }
  return out;
}

function extractUnique(input = [], nameOnly = false) {
  const seen = new Set();
  const values = collectWikiValues(input, nameOnly, [])
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .map(v => nameOnly ? v.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : v);
  return values.filter(v => {
    if (!v || seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

function extractElements(arr = [], indexes = []) {
  if (!Array.isArray(arr)) return [];
  return indexes.map(i => arr[i]).filter(v => v !== undefined && v !== null && v !== '');
}

function decodeWikiText(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractWikiMaterialEntries(html = '') {
  const ret = [];
  const text = String(html || '');
  const re = /data-entry-img=["']([^"']+)["'][\s\S]*?data-entry-name=["']([^"']+)["'][\s\S]*?data-entry-amount=["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const amount = Number(String(m[3] || '').replace(/[^\d.]/g, '')) || 0;
    ret.push({
      img: m[1],
      name: decodeWikiText(m[2]),
      amount,
    });
  }
  return ret;
}

function extractUniqueHttpsLinks(text = '') {
  const links = String(text || '').match(/https?:\/\/[^\s"'<>\)]+/g) || [];
  return [...new Set(links)];
}

function extractChineseWords(text = '') {
  return String(text || '').match(/[\u4e00-\u9fa5·・（）()]+/g) || [];
}

function extractHonkaiStarRailData(html = '') {
  const text = String(html || '').replace(/<br\s*\/?\>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const clean = text.replace(/\s+/g, ' ').trim();
  return {
    img: extractUniqueHttpsLinks(html)[0] || '',
    fate: clean.match(/命途\s*([^\s]+)/)?.[1] || '',
    rarity: clean.match(/稀有度\s*([^\s]+)/)?.[1] || '',
    desc: clean,
    jineng: ['', clean]
  };
}

const pr = yaml.get('./plugins/xhh/config/other.yaml').wiki;
/* 名称归一化键：星铁同一角色的不同形态在两边写法可能差一个分隔符
   （nanoka「三月七•巡猎」/ 维基「三月七・巡猎」），匹配键统一去掉「•·・」和空格。
   原来是 mergeSrBwikiIcons 里的局部 const，mergeGsBwikiRoleIcons 也在用 →
   跨函数引用报 `nmKey is not defined`（原神角色/武器列表一查就崩）。提到模块级。 */
const nmKey = v => String(v || '').replace(/[•·・\s]/g, '');
/** 当前是不是测试服数据模式（TEST 角标只在这种模式下出现） */
const isTestDataMode = () => {
    try {
        return mys.getDataMode() === 'test';
    } catch (_) {
        return false;
    }
};
// 维基现成的五星/四星星图，来源同 system/role_detail.js
const GS_STAR_ICON = {
    5: 'https://patchwiki.biligame.com/images/ys/f/ff/0dlkmof43y8aam8fphgixaejy571iqc.png',
    4: 'https://patchwiki.biligame.com/images/ys/2/2a/ssqzx9cint7m3yudjwviabu4nkd8s9o.png',
};

export class Wiki extends plugin {
  constructor(e) {
    super({
      name: '[小花火]图鉴',
      dsc: '图鉴',
      event: 'message',
      priority: pr || -99,
      rule: [
        // 图鉴数据模式切换（与锅巴 UI 的 data_mode 同一份配置，改完即时生效）
        {
          reg: '^[#＃%]*(?:切换)?(?:正式服|测试服)(?:数据)?(?:模式)?$',
          fnc: 'data_mode',
        },
        {
          reg: '^[#＃%]*(?:切换)?数据模式$',
          fnc: 'data_mode',
        },
        {
          reg: '^[#%*]*(星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3)?\\s*(.+)图鉴$',
          fnc: 'illustrated_book',
        },
        {
          reg: '^[#%*]*(星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3)?\\s*图鉴\\s*(.+)$',
          fnc: 'illustrated_book',
        },
        // 角色故事单独一条指令：故事正文加起来能占整张图鉴 40% 的高度，
        // 塞进图鉴里图会变得又长又难发，而故事又不是每次都要看。
        {
          reg: '^[#%*]*(星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3)?\\s*(.+)(?:故事|剧情)$',
          fnc: 'role_story',
        },
        {
          reg: '^[#%*]*(星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3)?\\s*(?:故事|剧情)\\s*(.+)$',
          fnc: 'role_story',
        },
      ],
    });
  }

  getWikiIcon(text = '', game = '') {
    text = String(text || '');
    // 星级不是元素/类型图标，不能用"包含星"兜底，否则"五星"会误显示成崩三星尘。
    if (/^(一|二|三|四|五)星$|^[SAB]级$/.test(text)) return '';

    const gsIconMap = {
      '水': '水.png', '火': '火.png', '冰': '冰.png', '雷': '雷.png',
      '风': '风.png', '岩': '岩.png', '草': '草.png',
      // 武器类型图标此前一个都没有，原神角色列表的武器徽章一直是纯文字。
      // 来源是米游社社区文章 67647108「武器类型图标」的五张 720×720 官方图
      // （文章 55479392 里那三张是头像框/成就杂图和壁纸，不是武器类型）。
      // 原图是半透明中灰，在近白底徽章上发灰，已整体转黑剪影并居中裁到 256×256，
      // 和命途图标（毁灭.png 等）风格一致。
      '单手剑': '单手剑.png', '双手剑': '双手剑.png', '弓': '弓.png', '法器': '法器.png',
      // 「长枪」是 nanoka/游戏内写法，「长柄武器」是 Bwiki 角色一览的写法，
      // 两种都指同一类武器，两个 key 都要映射，否则只显示文字。
      '长枪': '长枪.png', '长柄武器': '长枪.png'
      // 特弓 / 特殊武器官方没给对应图，先不映射，保持纯文字，不硬凑
    };
    const srIconMap = {
      '物理': 'sr_物理.png', '火': 'sr_火.png', '冰': 'sr_冰.png',
      '雷': 'sr_雷.png', '风': 'sr_风.png', '量子': 'sr_量子.png', '虚数': 'sr_虚数.png',
      '毁灭': '毁灭.png', '巡猎': '巡猎.png', '智识': '智识.png', '同谐': '同谐.png',
      '虚无': '虚无.png', '存护': '存护.png', '丰饶': '丰饶.png', '记忆': '记忆.png',
      '欢愉': '欢愉.png'
    };
    const zzzIconMap = {
      '物理': 'zzz_物理.png',
      '火': 'zzz_火.png',
      '冰': 'zzz_冰.png',
      '电': 'zzz_电.png',
      '以太': 'zzz_以太.png',
      '风': 'zzz_风.png',
      '强攻': 'zzz_强攻.png',
      '击破': 'zzz_击破.png',
      '异常': 'zzz_异常.png',
      '支援': 'zzz_支援.png',
      '防护': 'zzz_防护.png',
      '命破': 'zzz_命破.png'
    };
    const bh3IconMap = {
      '星尘': 'bh3_星尘.png', '星辰': 'bh3_星尘.png',
      '生物': 'bh3_生物.png', '异能': 'bh3_异能.png', '机械': 'bh3_机械.png', '量子': 'bh3_量子.png', '虚数': 'bh3_虚数.png',
      // 崩三伤害类型 / 武器类型 / 状态效果徽章（官方高清，来自 图标SR）
      '物理': 'bh3_物理.png',
      '火伤': 'bh3_火伤.png', '火焰元素': 'bh3_火伤.png', '火焰': 'bh3_火伤.png', '火': 'bh3_火伤.png',
      '冰伤': 'bh3_冰伤.png', '冰冻元素': 'bh3_冰伤.png', '冰冻': 'bh3_冰伤.png', '冰': 'bh3_冰伤.png',
      '雷伤': 'bh3_雷伤.png', '雷电元素': 'bh3_雷伤.png', '雷电': 'bh3_雷伤.png', '雷': 'bh3_雷伤.png',
      '双枪': 'bh3_双枪.png', '大剑': 'bh3_大剑.png', '太刀': 'bh3_太刀.png', '拳套': 'bh3_拳套.png',
      '弓箭': 'bh3_弓箭.png', '十字架': 'bh3_十字架.png', '环刃': 'bh3_环刃.png', '链刃': 'bh3_链刃.png',
      '镰刀': 'bh3_镰刀.png', '骑枪': 'bh3_骑枪.png', '机关杖': 'bh3_机关杖.png', '速射弩': 'bh3_速射弩.png',
      '重炮': 'bh3_重炮.png', '火箭锤': 'bh3_火箭锤.png', '梭镖': 'bh3_梭镖.png',
      '冻结': 'bh3_冻结.png', '点燃': 'bh3_点燃.png', '流血': 'bh3_流血.png', '麻痹': 'bh3_麻痹.png',
      '召唤物': 'bh3_召唤物.png', '吸引': 'bh3_吸引.png', '对空': 'bh3_对空.png', '时空': 'bh3_时空.png',
      '治疗': 'bh3_治疗.png', '虚弱': 'bh3_虚弱.png', '脆弱': 'bh3_脆弱.png', '高频': 'bh3_高频.png',
      '重击': 'bh3_重击.png', '驱动核心': 'bh3_驱动核心.png', '爆发': 'bh3_爆发.png', '眩晕': 'bh3_眩晕.png',
      '世界之星': 'xzh_世界之星.png', '无存之仪': 'xzh_无存之仪.png', '命运之轮': 'xzh_命运之轮.png', '升变之理': 'xzh_升变之理.png', '天衍之杯': 'xzh_天衍之杯.png',
      '界域共鸣': 'xzh_界域共鸣.png', '万有之星': 'xzh_万有之星.png', '星影偕行': 'xzh_星影偕行.png', '天渊易位': 'xzh_天渊易位.png', '复盈相生': 'xzh_复盈相生.png',
      '星之环特性': '星环特性.svg', '星之环分野': '星环分野.svg',
      '输出': '定位.svg', '辅助': '定位.svg', '定位': '定位.svg'
    };

    if (game === 'zzz') return zzzIconMap[text] || '';
    if (game === 'sr') return srIconMap[text] || '';
    if (game === 'gs') return gsIconMap[text] || '';
    if (game === 'bh3') {
      for (const [key, icon] of Object.entries(bh3IconMap)) {
        if (text.includes(key)) return icon;
      }
      return '';
    }

    // 未指定游戏时只做精确匹配，避免"五星/星铁"等被误判成星尘。
    const genericMap = { ...gsIconMap, ...srIconMap, ...zzzIconMap, ...bh3IconMap };
    if (genericMap[text]) return genericMap[text];
    for (const [key, icon] of Object.entries(bh3IconMap)) {
      if (text.includes(key)) return icon;
    }
    return '';
  }

  /**
   * 角色故事：从指令里抽出角色名（与图鉴同一套规则，去掉「故事/剧情」后缀）。
   */
  parseStoryQuery(e) {
    const starPrefix = /^[＃#%]*\*/.test(e.msg);
    const isSr = starPrefix || e.msg.includes('星铁');
    const isZZZ = e.msg.includes('绝区零') || e.msg.includes('ZZZ');
    const isBH3 = /崩坏3|崩坏三|崩三|BH3/i.test(e.msg);
    let name = e.msg
      .replace(/^[#%*]*/, '')
      .replace(/^(?:xhh|小花火)[#%*]*/i, '')
      .replace(/星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3/gi, '')
      .replace(/(?:故事|剧情)/g, '')
      .trim();
    name = name.replace(/^[:：\s]+|[:：\s]+$/g, '').trim();
    return { name, isSr, isZZZ, isBH3 };
  }

  /**
   * #角色故事 / #故事角色 / #角色剧情 —— 原神走 Bwiki。
   * 其他游戏暂不支持，直接回话说明，不静默失败。
   */
  async role_story(e) {
    if (!config().wiki) return false;
    let { name, isSr, isZZZ, isBH3 } = this.parseStoryQuery(e);
    if (!name) return false;
    if (isZZZ || isBH3) {
      await e.reply(`「${name}」的角色故事暂未支持，目前只有原神和星铁可用。`);
      return true;
    }
    /* Bwiki 的页名为角色正式名，而查询时可能输入称号或别称（「仆人」「散兵」等）。
       该路径此前未做别名归一，「#仆人故事」会直接用「仆人」查询 Bwiki，
       被判定为缺页后返回空结果。此处补充与 role() 相同的归一逻辑：
       遍历 *_js_names.yaml，当某正式名的别名数组包含输入名时替换为正式名。
       该逻辑对所有角色通用。 */
    const storyNamePath = isSr
      ? './plugins/xhh/system/default/sr_js_names.yaml'
      : './plugins/xhh/system/default/gs_js_names.yaml';
    const storyNames = yaml.get(storyNamePath);
    for (const i in storyNames) {
      if (Array.isArray(storyNames[i]) && storyNames[i].includes(name)) { name = i; break; }
    }
    /* ⚠️ Bwiki 是正式服站，test 模式下整个故事功能跳过。
       下面两条路都是**裸调** fetchSrRole/fetchGsRole，不经 mys.data()，
       所以 mys.data() 的 modeOk 闸门管不到它们 —— 不挡的话，
       test 模式下「#钟离故事」会直接拿到正式服角色的故事。
       test 模式只出测试服数据，两边不混用。 */
    if (isTestDataMode()) {
      logger.debug?.('[xhh][图鉴] 测试服数据模式：跳过 Bwiki 角色故事（Bwiki 只有正式服数据）');
      await e.reply(`「${name}」的角色故事在测试服模式下暂不可用。\n`
        + `角色故事目前只有 Bwiki 一个数据源，而 Bwiki 只有正式服数据。\n`
        + `切换正式服模式可用：#切换正式服模式`);
      return true;
    }
    // 星铁走 Bwiki 的角色页（表5 就是角色故事），和原神一样逐条渲染
    if (isSr) {
      const sr = await fetchSrRole(name).catch(err => {
        logger.debug?.(`[xhh][bwiki_sr] ${name} 故事抓取异常: ${err?.message}`);
        return null;
      });
      const stories = sr?.stories || [];
      if (!stories.length) {
        await e.reply(`没有找到「${name}」的角色故事。`);
        return true;
      }
      return render('wiki/gs_story', {
        name: sr.name || name,
        icon: sr.icon || '',
        title: sr.badges?.find(b => b.k === '称号')?.v || '',
        stories,
        source: '数据来源 wiki.biligame.com',
      }, { e, ret: true });
    }
    let d = null;
    try { d = await fetchGsRole(name); }
    catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${name} 故事抓取异常: ${err?.message}`);
      return false;
    }
    if (!d || !d.stories?.length) {
      await e.reply(`没有找到「${name}」的角色故事。`);
      return true;
    }
    const { detail, extra } = buildGsDetail(d);
    const stories = [extra.detailStory, ...(d.stories || [])
      .filter(x => !/角色详细|角色简介|角色介绍/.test(String(x.title || '')))
      .map(x => ({
        title: String(x.title || '').replace(/\s*[（(]解锁条件[：:][^）)]*[）)]\s*$/, '').trim(),
        unlock: x.unlock || '',
        body: String(x.body || '').trim(),
      }))].filter(Boolean);
    if (!stories.length) {
      await e.reply(`「${name}」没有可显示的角色故事。`);
      return true;
    }
    const g = k => { const v = d.basic?.[k]; return Array.isArray(v) ? (v[0] ?? '') : (v ?? ''); };
    return render('wiki/gs_story', {
      name: detail.name,
      icon: detail.icon,
      title: g('称号'),
      stories,
      source: extra.source,
    }, { e, ret: true });
  }

  /** 图鉴数据模式：#切换正式服模式 / #切换测试服模式 / #数据模式（查当前） */
  async data_mode(e) {
    const raw = String(e?.msg || '').replace(/^[#＃%*\s]+/, '');
    const now = mys.getDataMode();
    const target = /正式服/.test(raw) ? 'official' : (/测试服/.test(raw) ? 'test' : '');
    const mode = target ? mys.setDataMode(target) : now;
    const label = mode === 'official' ? '正式服' : '测试服';
    /* 指令不带服别时是纯查询，不写盘。此前无论查询还是切换都回复「已切到…」，
       查询现状时也回复「已切到正式服模式」，与未做切换的事实不符。 */
    const tip = !target
      ? (mode === 'official'
        ? '当前是正式服模式：列表与查询都不出测试服条目。'
        : '当前是测试服模式：列表只显示测试服条目。')
      : (mode === 'official'
        ? '已切到正式服模式：列表与查询都不出测试服条目。'
        : '已切到测试服模式：列表只显示测试服条目。');
    const msg = `${tip}\n当前数据模式：${label}（配置项：config/config.yaml 的 data_mode，锅巴 UI 里也能改）`;
    /* 必须传撤回时长：reply_recallMsg 内部是 setTimeout(..., time * 1000)，
       time 为undefined 时算成 NaN，等于上一句刚发出去就被撤回，消息根本看不到。
       60 秒与 user.js 的扫码提示一致。 */
    return reply_recallMsg(e, msg, 60);
  }

  async illustrated_book(e) {
    if (!config().wiki) return false;
    // 本项目约定：* 前缀代表星铁（同 sr_logs.js），# 前缀代表原神
    const starPrefix = /^[＃#%]*\*/.test(e.msg);
    const isSr = starPrefix || e.msg.includes('星铁');
    const isZZZ = e.msg.includes('绝区零') || e.msg.includes('ZZZ');
    let isBH3 = e.msg.includes('崩坏3') || e.msg.includes('崩坏三') || e.msg.includes('崩三') || e.msg.includes('BH3');
    let name = e.msg
      .replace(/^[#%*]*/, '')
      // 插件前缀（xhh菲欧妮图鉴 / 小花火菲欧妮图鉴）不参与查询名
      .replace(/^(?:xhh|小花火)[#%*]*/i, '')
      .replace(/星铁|绝区零|ZZZ|崩坏3|崩坏三|崩三|BH3/gi, '')
      .trim();
    name = name.startsWith('图鉴') ? name.replace(/^图鉴/, '') : name.replace(/图鉴$/, '');
    name = name.replace(/^[:：\s]+|[:：\s]+$/g, '').trim();
    if (!name) return false;
    // 「圣痕」是崩坏3独有的叫法：原神叫圣遗物、星铁叫遗器、绝区零叫驱动盘。
    // 不带游戏前缀时按崩三处理 —— 以前 #圣痕图鉴 会落到原神分支，
    // 列出的是原神圣遗物却标着「圣痕」，和 #崩三圣痕 完全不是一回事。
    if (!isSr && !isZZZ && !isBH3 && /圣痕/.test(name)) isBH3 = true;
    // 怪物/BOSS 图鉴交给 monster 插件处理，通用图鉴规则直接让路，
    // 避免把「绝区零怪物图鉴」当成角色「怪物」去查然后回「没有找到」
    const skipName = name
      .replace(/^(原神|genshin|ys|gs|星穹铁道|崩坏星穹铁道|星铁|铁道|穹铁|sr|崩坏3|崩坏三|崩三|bh3)/i, '')
      .trim();
    // 只要以怪物类关键词开头（「怪物图鉴」「怪物」「怪物摩录多图鉴」「boss地藏」…）就交给 monster 插件；
    // 旧正则只认「怪物图鉴」「怪物」，「怪物摩录多图鉴」会漏过去被当成角色「怪物摩录多」查然后回「没有找到」
    if (/^(怪物|魔物|敌人|boss|首领|enemy|monster)/i.test(skipName)) return false;
    const hasBh3ExclusiveWords = /(专武|专属武器|专属圣痕|专属套|毕业圣痕|圣痕套)/.test(name);
    const hasZzzExclusiveWords = /(专武|专属武器|专属音擎|签名音擎|专属驱动盘|推荐驱动盘|驱动盘套|驱动套)/.test(name);
    if (isBH3 && hasBh3ExclusiveWords) {
      if (await this.bh3ExclusiveEquip(e, name)) return true;
    }
    if (isZZZ && hasZzzExclusiveWords) {
      if (await this.zzzExclusiveEquip(e, name)) return true;
    }
    // 没写游戏前缀时也支持"艾莲专武图鉴 / 希儿专武图鉴"。
    // 先按原神/星铁武器别名表匹配（"XX专武"多在此表登记），命中即出图；
    // 再按绝区零代理人、崩三装甲匹配；都没命中时继续走普通图鉴。
    if (!isSr && !isZZZ && !isBH3) {
      if (hasZzzExclusiveWords || hasBh3ExclusiveWords) {
        if (await this.weapon(e, name)) return true;
        if (await this.weapon(e, name, true)) return true;
      }
      if (hasZzzExclusiveWords && await this.zzzExclusiveEquip(e, name)) return true;
      if (hasBh3ExclusiveWords && await this.bh3ExclusiveEquip(e, name)) return true;
    }
    // 纯列表关键词（武器/音擎/驱动盘…）没必要再按角色、单品逐个试探，
    // 直接出列表，省掉一轮 zzz_tujian 请求，也避免日志里出现「角色解析: 武器」这类误导
    if (/^(角色|武器|光锥|遗器|音擎|驱动盘|邦布|圣遗物|圣痕|人偶|协同者|大剑|双手剑|单手剑|长枪|长柄武器|弓|弓箭|法器)$/.test(name)) {
      return this.list(e, name, isSr, isZZZ, isBH3);
    }
    // 统一处理角色/武器/遗器查询
    const checkTypes = [
      { method: 'role', args: [e, name] },
      { method: 'weapon', args: [e, name] },
      { method: 'syw_yiqi', args: [e, name] },
    ];
    if (isZZZ) {
      for (const { method, args } of checkTypes) {
        if (await this[method](...args, false, true)) return true;
      }
      // 绝区零特有: 邦布
      if (await this.bangboo(e, name)) return true;
    } else if (isBH3) {
      for (const { method, args } of checkTypes) {
        if (await this[method](...args, false, false, true)) return true;
      }
      // 崩三特有的 人偶 / 协同者（不写游戏前缀时也会兜底试一次）
      if (await this.bh3_yq(e, name, true)) return true;
    } else if (isSr) {
      for (const { method, args } of checkTypes) {
        if (await this[method](...args, true)) return true;
      }
    } else {
      for (const { method, args } of checkTypes) {
        if (await this[method](...args)) return true;
        if (await this[method](...args, true)) return true;
      }
      // 未写游戏前缀时，也兜底尝试绝区零，支持"安比图鉴 / 图鉴安比"这类写法。
      for (const { method, args } of checkTypes) {
        if (await this[method](...args, false, true)) return true;
      }
      if (await this.bangboo(e, name)) return true;
      // 崩三的圣痕名常带套装名（如「琪亚娜·乐运天降」是「来日亦然」套装的一件），
      // 和原神/星铁/绝区零的名字不重样，但不带前缀时前面三个游戏都试过了，
      // 只有走到这里才拉崩三数据，不会拖慢正常查询。
      for (const { method, args } of checkTypes) {
        if (await this[method](...args, false, false, true)) return true;
      }
      if (await this.bh3_yq(e, name, true)) return true;
    }
    /* 最后查总列表。
       ⚠️ test 模式下**只在「纯列表关键词」时才允许走**。
       上面 #524 已经把纯关键词（角色/武器/光锥/圣遗物…）直接送去 list() 了，
       所以走到这里的 name 一定还带着具体条目名（如「钟离」）。
       test 模式下这类名字必然查不到（modeOk 已挡住正式服条目），
       再掉进 list() 就是拿空列表去套 condition，轻则空卡，重则给出误导性的列表。
       因此 test 模式对正式服条目不应触发，只认测试服列表里已有的条目。 */
    const isPureListKeyword = /^(角色|武器|光锥|遗器|音擎|驱动盘|邦布|圣遗物|圣痕|人偶|协同者|大剑|双手剑|单手剑|长枪|长柄武器|弓|弓箭|法器)$/.test(name);
    if (isTestDataMode() && !isPureListKeyword) {
      logger.debug?.(`[xhh][图鉴] 测试服数据模式：「${name}」不在测试服列表，拒绝出图`);
      await e.reply(`测试服模式下没有「${name}」的图鉴数据。\n`
        + `测试服列表只收录测试服条目（头像右上角带「预告」标记的）。\n`
        + `切换正式服模式可用：#切换正式服模式`);
      return true;
    }
    if (/角色|武器|大剑|双手剑|单手剑|法器|长枪|弓箭|弓|光锥|圣遗物|遗器|音擎|驱动盘|邦布|圣痕|人偶|协同者/.test(name)) return this.list(e, name, isSr, isZZZ, isBH3);
    // 全部未命中时给出提示，避免静默无响应被当成插件故障
    if (config().debug) logger.mark(`[xhh] 图鉴未命中: name=「${name}」 isSr=${isSr} isZZZ=${isZZZ} isBH3=${isBH3}`);
    if (name.length >= 2) {
      // 以前这里写死建议「绝区零」，崩三的名字（如「乐运天降」）看到这条只会更困惑，
      // 而且后半句「*X图鉴 / #X图鉴」就是把刚敲过的那条命令再抄一遍，没有信息量。
      // 改成列出四个游戏真实的前缀写法。
      await e.reply(`没有找到「${name}」的图鉴数据。\n可尝试在名字前加上游戏前缀：原神 / 星铁 / 绝区零 / 崩三，或检查名称是否正确。`);
      return true;
    }
    return false;
  }

  // 崩三人偶 / 协同者单查（数据层两个分类已拆开，这里依次按名找，命中即出详情卡）
  async bh3_yq(e, name, isBH3 = false) {
    if (!isBH3 || !name) return false;
    for (const type of ['yq', 'hb']) {
      let ret;
      try {
        ret = await mys.data(name, type, false, false, true);
      } catch (_) { continue; }
      if (!ret?.id) continue;
      const data = await mys.detail(ret.id, false, false, true);
      if (data?.content) {
        await this.bh3_yq_pictures(e, data, type);
        return true;
      }
    }
    return false;
  }

  async list(e, name, isSr = false, isZZZ = false, isBH3 = false) {
    if (/光锥|遗器|虚无|巡猎|物理|量子|虚数|毁灭|智识|同谐|存护|丰饶|记忆/.test(name)) isSr = true;
    if (/音擎|驱动盘|邦布|以太|强攻|击破|防护|支援|异常/.test(name)) isZZZ = true;
    if (/圣痕|人偶|协同者|生物|机械|量子|虚数|星尘|星辰|异能|火焰|冰冻|雷电/.test(name)) isBH3 = true;

    let type, _name
    
    if (name=='遗器') type = 'yq', _name = '遗器';
    if (name=='圣遗物') type = 'syw', _name = '圣遗物';
    // 星铁语境下「武器」=「光锥」（星铁没有 wq_list，武器对应 gz）
    if (/武器|大剑|双手剑|单手剑|法器|长枪|弓箭|弓/.test(name)) {
      if (isSr) { type = 'gz', _name = '光锥'; }
      else { type = 'wq', _name = '武器'; }
    }
    if (name.includes('光锥')) type = 'gz', _name = '光锥';
    if (name.includes('音擎')) type = 'wq', _name = '音擎';
    if (name.includes('驱动盘')) type = 'syw', _name = '驱动盘';
    if (name.includes('邦布')) type = 'yq', _name = '邦布';
    if (name.includes('圣痕')) type = 'syw', _name = '圣痕';
    if (name.includes('人偶')) type = 'yq', _name = '人偶';
    if (name.includes('协同者')) type = 'hb', _name = '协同者';
    if (name.includes('角色')) type = 'js', _name = '角色';

    if(!_name) return false;
    
    let data = await mys.data('', type, isSr, isZZZ, isBH3);

    /* test 模式禁用官方兜底后，nanoka 一挂列表就是空的（见 4.1'''）。
       静默返回空数组的话，用户看到的是一张空图，完全不知道是「没数据」
       还是「插件坏了」。这里显式说明原因并给出下一步。
       注意不能用 `!data.length` 一刀切 —— 绝区零邦布/音擎这类
       test 模式下本来就可能真的为空（该游戏还没进测试服），那种情况
       要提示「该类别暂无测试服数据」而不是「nanoka 不可用」。 */
    if (Array.isArray(data) && !data.length) {
      await e.reply(isTestDataMode()
        ? `${_name}在测试服模式下暂时没有数据。\n`
          + `测试服模式只使用 nanoka 数据源（nanoka 暂时不可用时不会降级到官方源）。\n`
          + `可稍后重试，或切换正式服模式：#切换正式服模式`
        : `${_name}暂时没有数据，可能是数据源暂时不可用。`);
      logger.debug?.(`[xhh][图鉴] ${_name} 列表为空（test=${isTestDataMode()}）`);
      return true;
    }

    let condition = name.replace(/崩坏3|崩坏三|崩三|角色|武器|光锥|音擎|驱动盘|邦布|圣痕|人偶|协同者/g, '');

    // 崩坏三圣痕有 700 条（五星 475、四星 204、三星 15、二星 6；其中五星套装 449），
    // 「圣痕 全部 / 四星 / 三星 / 二星 / 单件」可以放开对应范围。
    // 开关在 config.yaml 的 bh3_syw_full_list，置 true 则恢复全量。
    //
    // 套装在列表里是按件拆开的：一套三个部位就是 (上)(中)(下) 三条，
    // 五星套装 449 条去重后只剩 208 套（120 套三件 + 87 套单件 + 1 套两件）。
    // 列表只取每套的第一件代表，体积和浏览量都减半。
    if (isBH3 && type === 'syw') {
      const STAR_WORDS = { '五星': '五星', '5星': '五星', '四星': '四星', '4星': '四星', '三星': '三星', '3星': '三星', '二星': '二星', '2星': '二星' };
      const starKey = STAR_WORDS[condition];
      const onlyPiece = /^(单件|散件|单件圣痕)$/.test(condition);
      const wantAll = !!config().bh3_syw_full_list || /^(全部|全量|所有)$/.test(condition);
      if (wantAll) {
        _name = condition ? `圣痕${condition}` : '圣痕';
      } else if (starKey) {
        data = data.filter(item => item.ji === starKey);
        _name = `圣痕${condition}`;
      } else if (onlyPiece) {
        data = data.filter(item => item.isSet !== 'true');
        _name = '圣痕单件';
      } else {
        data = data.filter(item => item.ji === '五星' && item.isSet === 'true');
        _name = '五星圣痕';
      }
      // 套装按部位拆条，列表只留每套一件代表，并把代表身上的部位后缀去掉，
      // 显示成「赫拉克利特」而不是「赫拉克利点(上)」——一条代表整套。
      // 部位后缀在 bh3_data 里按列表原样保留，这里按同样的规则剥掉。
      if (/^(全部|全量|所有)$/.test(condition) || !config().bh3_syw_full_list) {
        const seen = new Set();
        data = data
          .filter(item => {
            const key = String(item.name || '').replace(/[（(](上|中|下)[）)]|·(上|中|下)$|-(上|中|下)$/g, '');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .map(item => ({
            ...item,
            name: String(item.name || '').replace(/[（(](上|中|下)[）)]|·(上|中|下)$|-(上|中|下)$/g, '')
          }));
        if (!wantAll) _name = `${_name}（${data.length} 套）`;
      }
    }

    if (!isSr && !isZZZ && !isBH3) {
      switch (condition) {
        case '五星':
        case '5星':
          data = data.filter(item => item.ji === '五星');
          _name = '五星角色';
          if (type === 'wq') _name = '五星武器';
          if (type === 'syw') _name = '五星圣遗物';
          break;
        case '四星':
        case '4星':
          data = data.filter(item => item.ji === '四星');
          _name = '四星角色';
          if (type === 'wq') _name = '四星武器';
          if (type === 'syw') _name = '四星圣遗物';
          break;
        case '三星':
        case '3星':
          data = data.filter(item => item.ji === '三星');
          _name = '三星角色';
          if (type === 'wq') _name = '三星武器';
          if (type === 'syw') _name = '三星圣遗物';
          break;
        case '水系':
        case '水':
          data = data.filter(item => item.yuanshu === '水');
          _name = '水系角色';
          break;
        case '火系':
        case '火':
          data = data.filter(item => item.yuanshu === '火');
          _name = '火系角色';
          break;
        case '冰系':
        case '冰':
          data = data.filter(item => item.yuanshu === '冰');
          _name = '冰系角色';
          break;
        case '雷系':
        case '雷':
          data = data.filter(item => item.yuanshu === '雷');
          _name = '雷系角色';
          break;
        case '风系':
        case '风':
          data = data.filter(item => item.yuanshu === '风');
          _name = '风系角色';
          break;
        case '岩系':
        case '岩':
          data = data.filter(item => item.yuanshu === '岩');
          _name = '岩系角色';
          break;
        case '草系':
        case '草':
          data = data.filter(item => item.yuanshu === '草');
          _name = '草系角色';
          break;
        case '单手剑':
          data = data.filter(item => item.wuqi === '单手剑');
          _name = '单手剑武器';
          break;
        case '双手剑':
        case '大剑':
          data = data.filter(item => item.wuqi === '双手剑');
          _name = '双手剑武器';
          break;
        case '长柄':
        case '长枪':
          data = data.filter(item => item.wuqi === '长柄武器');
          _name = '长柄武器';
          break;
        case '弓系':
        case '弓箭':
        case '弓':
          data = data.filter(item => item.wuqi === '弓');
          _name = '弓武器';
          break;
        case '法器':
          data = data.filter(item => item.wuqi === '法器');
          _name = '法器武器';
          break;
      }
} else if (isBH3) {
      switch (condition) {
        case '五星':
        case '5星':
          data = data.filter(item => item.ji === '五星');
          _name = '五星角色';
          if (type === 'wq') _name = '五星武器';
          if (type === 'syw') _name = '五星圣痕';
          break;
        case '四星':
        case '4星':
          data = data.filter(item => item.ji === '四星');
          _name = '四星角色';
          if (type === 'wq') _name = '四星武器';
          if (type === 'syw') _name = '四星圣痕';
          break;
        case '三星':
        case '3星':
          data = data.filter(item => item.ji === '三星');
          _name = '三星角色';
          if (type === 'wq') _name = '三星武器';
          if (type === 'syw') _name = '三星遗器';
          break;
        case '物理':
        case '物理系':
          data = data.filter(item => item.yuanshu === '物理');
          _name = '物理角色';
          break;
        case '火':
        case '火系':
        case '火焰':
          data = data.filter(item => item.yuanshu === '火' || item.yuanshu === '火焰');
          _name = '火系角色';
          break;
        case '冰':
        case '冰系':
        case '冰冻':
          data = data.filter(item => item.yuanshu === '冰' || item.yuanshu === '冰冻');
          _name = '冰系角色';
          break;
        case '雷':
        case '雷系':
        case '雷电':
          data = data.filter(item => item.yuanshu === '雷' || item.yuanshu === '雷电');
          _name = '雷系角色';
          break;
        case '生物':
        case '生物系':
          data = data.filter(item => item.yuanshu === '生物');
          _name = '生物角色';
          break
        case '量子':
        case '量子系':
          data = data.filter(item => item.yuanshu === '量子');
          _name = '量子角色';
          break;
        case '虚数':
        case '虚数系':
          data = data.filter(item => item.yuanshu === '虚数');
          _name = '虚数角色';
          break;
        case '异能':
        case '异能系':
          data = data.filter(item => item.yuanshu === '异能');
          _name = '异能角色';
          break;
        case '机械':
        case '机械系':
          data = data.filter(item => item.yuanshu === '机械');
          _name = '机械角色';
          break;
        case '星尘':
        case '星辰':
        case '星尘系':
        case '星辰系':
          data = data.filter(item => item.yuanshu === '星尘');
          _name = '星尘角色';
          break;
      }
    } else if (isSr) {
      // 星铁此前完全没有分档分支，#光锥五星 / #遗器四星 一律返回全量列表。
      // 属性按 shuxing 取（nanoka 角色 ext 给的是 属性/{damageType}），命途按 mingtu 取。
      // 不是 yuanshu —— 星铁角色的 ext 里只有 命途/ 与 属性/、没有 元素/，
      // 所以原先混在 BH3 分支里按 yuanshu 过滤的量子、虚数那几条是双重死代码：
      // 分支进不去，字段也永远取不到值。那几条留在原处不动，避免动到既有分支。
      const srNoun = type === 'gz' ? '光锥' : type === 'yq' ? '遗器' : '角色';
      // 遗器套装在两个数据源里都没有星级标签：nanoka relicset.json 的 ext 只有套装效果，
      // 官方 sr_wiki 频道 30 的 60 条也只有套装种类与套装效果，ji 恒为空。
      // 这种列表不参与分档筛选，否则 #遗器五星 会从 64 条直接变成 0 条。
      const srTierable = data.some(it => it.ji);
      switch (condition) {
        case '五星':
        case '五星':
          if (srTierable) data = data.filter(item => item.ji === '五星');
          _name = `五星${srNoun}`;
          break;
        case '四星':
        case '四星':
          if (srTierable) data = data.filter(item => item.ji === '四星');
          _name = `四星${srNoun}`;
          break;
        case '三星':
        case '三星':
          if (srTierable) data = data.filter(item => item.ji === '三星');
          _name = `三星${srNoun}`;
          break;
        case '物理':
          data = data.filter(item => item.shuxing === '物理');
          _name = '物理角色';
          break;
        case '物理系':
          data = data.filter(item => item.shuxing === '物理');
          _name = '物理角色';
          break;
        case '火':
          data = data.filter(item => item.shuxing === '火');
          _name = '火角色';
          break;
        case '冰':
          data = data.filter(item => item.shuxing === '冰');
          _name = '冰角色';
          break;
        case '雷':
          data = data.filter(item => item.shuxing === '雷');
          _name = '雷角色';
          break;
        case '风':
          data = data.filter(item => item.shuxing === '风');
          _name = '风角色';
          break;
        case '虚数':
          data = data.filter(item => item.shuxing === '虚数');
          _name = '虚数角色';
          break;
        case '虚数系':
          data = data.filter(item => item.shuxing === '虚数');
          _name = '虚数角色';
          break;
        case '量子':
          data = data.filter(item => item.shuxing === '量子');
          _name = '量子角色';
          break;
        case '量子系':
          data = data.filter(item => item.shuxing === '量子');
          _name = '量子角色';
          break;
        case '存护':
          data = data.filter(item => item.mingtu === '存护');
          _name = '存护角色';
          break;
        case '巡猎':
          data = data.filter(item => item.mingtu === '巡猎');
          _name = '巡猎角色';
          break;
        case '智识':
          data = data.filter(item => item.mingtu === '智识');
          _name = '智识角色';
          break;
        case '虚无':
          data = data.filter(item => item.mingtu === '虚无');
          _name = '虚无角色';
          break;
        case '毁灭':
          data = data.filter(item => item.mingtu === '毁灭');
          _name = '毁灭角色';
          break;
        case '丰饶':
          data = data.filter(item => item.mingtu === '丰饶');
          _name = '丰饶角色';
          break;
        case '同谐':
          data = data.filter(item => item.mingtu === '同谐');
          _name = '同谐角色';
          break;
        case '记忆':
          data = data.filter(item => item.mingtu === '记忆');
          _name = '记忆角色';
          break;
        case '欢愉':
          data = data.filter(item => item.mingtu === '欢愉');
          _name = '欢愉角色';
          break;
      }
    }
    const ratingOrder = { 五星: 1, 'S级': 1, 四星: 2, 'A级': 2, 三星: 3, 'B级': 3, 二星: 4, 一星: 5 };
    // 重新排序：星级高的排顶部；绝区零同星级内按上线先后排列
    // （nanoka 的 content_id 与米游社官方 content_id 都随角色/音擎上线时间递增，数字升序即上线顺序）
    data = data.sort((a, b) => {
      const diff = (ratingOrder[a.ji] ?? 99) - (ratingOrder[b.ji] ?? 99);
      if (diff) return diff;
      if (isZZZ) {
        // 绝区零按 zzz_data 给的 _ord 排：未上线置顶 → 卡池首发日期新→旧 →
        // 无记录的按 id 降序兜底。不能退回按 content_id 排，nanoka 的 id 与上线
        // 顺序对不上（实测 12 处逆序，如 希格莉德 排在更晚的 蕾米埃尔 之前），
        // 而且官方 Wiki 回退时 content_id 是另一套 id 空间，两种源会排出完全
        // 不同的顺序（前 62 位只有 5 位相同）。原神/星铁不用这段，理由见上。
        const ao = Number(a._ord), bo = Number(b._ord);
        if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
      }
      return 0;
    });
    // _ord 只是排序用的临时字段，别带进模板数据
    if (isZZZ) data = data.map(({ _ord, ...rest }) => rest);
    //根据name去重（主角只需要显示一个）
    data = data.filter(
      (item, index, self) => index === self.findIndex(t => t.name === item.name)
    );
    // 原神角色：头像换成 Bwiki 角色一览的图（维基原图，nanoka 只有方块 webp）。
    // 抓不到 / 被 567 限流时 fetchGsRoleList 返回 null，这里原样保留 nanoka 数据，
    // 降级链（icon → iconFallback，list.html 的 onerror 逐级切换）完全不动。
    /* Bwiki 是正式服数据源，测试服模式下整个跳过：
       合并函数会把 Bwiki 一览的条目补进列表，而 Bwiki 那边没有 isUnreleased 标记，
       一合并就把正式服条目全塞回测试服列表里（实测原神武器从 3 条涨到 439 条）。
       test 模式只用 nanoka + manifest.new.*，两种数据不混用。 */
    if (isTestDataMode()) {
      logger.debug?.('[xhh][图鉴] 测试服数据模式：跳过 Bwiki 合并，列表只用 nanoka 数据');
    } else if (!isSr && !isZZZ && !isBH3 && ['js', 'wq', 'syw'].includes(type)) {
      data = await this.mergeGsBwikiRoleIcons(data, type);
    } else if (isSr && !isZZZ && !isBH3 && ['js', 'gz', 'yq'].includes(type)) {
      data = await this.mergeSrBwikiIcons(data, type);
    }
    /* 合并之后再按星级排一次：合并函数会把 Bwiki 一览里 nanoka 没有的条目追加到末尾
       （星铁实测追加了银狼LV.999、开拓者•欢愉、三月七•巡猎 等 8 条），
       这些条目是在上面那次星级排序之后才进来的，不重排就会插进别的档位里
       （实测出现 2 次五星被四星夹断）。Array.sort 是稳定的，
       同档位内 nanoka 的新→旧、以及武器的 Bwiki 页面顺序都不会被打乱。 */
    if (!isZZZ && !isBH3 && (isSr ? ['js', 'gz', 'yq'] : ['js', 'wq', 'syw']).includes(type)) {
      data = [...data].sort((a, b) => (ratingOrder[a.ji] ?? 99) - (ratingOrder[b.ji] ?? 99));
    }

    if (data.length > 50)
      reply_recallMsg(e, `正在获取${_name}列表中,请等待...`, 30);
    // 超过这个条数就按「长列表」处理：降 zoom + 降 jpeg 质量，否则 QQ 发不出去
    const LONG_LIST = n => n > 60;
    // 星级描边配色：五星/S级金色、四星/A级紫色、三星/B级蓝色（绝区零与原神/星铁统一）
    const rankClassMap = { 五星: 'r5', 'S级': 'r5', 四星: 'r4', 'A级': 'r4', 三星: 'r3', 'B级': 'r3', 二星: 'r2', 一星: 'r1' };
    data = data.map(item => ({
      ...item,
      rankClass: rankClassMap[item.ji] || 'r0',
      /* TEST 角标只在 test 数据模式下出现，且**不再塞进 badges**——
         它以前混在徽章行里（名字下方），跟星级/属性徽章挤在一列，
         一眼看不出是「这条是测试服」。现在单独走 isTest，
         由 list.html 渲染成头像右上角的角标。
         official 模式列出的都是正式服条目，一条都不带标；
         test 模式整列都是测试服数据（filterListByMode 已按 manifest.new.* 过滤）。 */
      isTest: isTestDataMode(),
      badges: (isBH3
        // 崩坏3的圣痕属性是多值的（bh3_data 的 attributes 数组），要展开；角色/武器那条走 yuanshu 标量。
        // 圣痕属性常常有 6~8 个（实测 700 条里 617 条是多属性，最多的 7~8 个），
        // 全列出来每张卡片要撑出七八个徽章，列表高度从 3423px 涨到 5097px。
        // 合成单个「多属性」徽章，只有一个属性时仍显示具体名字（那才是有效信息），
        // 完整属性列表在详情页看。damage / starRing 是另外的类别，不参与合并。
        ? [
            ...(Array.isArray(item.attributes)
                ? (item.attributes.length > 1 ? ['多属性'] : item.attributes)
                : [item.attributes || item.yuanshu].filter(Boolean)),
            ...(Array.isArray(item.damage) ? item.damage : [item.damage]),
            item.starRingField,
            ...(Array.isArray(item.starRing) ? item.starRing : [item.starRing]),
            item.wuqi
        ]
        // 星铁的特性来自命途/属性，不是元素/武器，不接上这两个分支星铁就只剩一个星级徽章
        : isSr ? [item.ji, item.mingtu, item.shuxing]
        : [item.ji, item.yuanshu, item.wuqi])
        .filter(v => v && v !== '未知' && v !== 'false')
        .map(v => {
          const icon = this.getWikiIcon(v, isZZZ ? 'zzz' : isSr ? 'sr' : isBH3 ? 'bh3' : 'gs');
          return { text: v, icon, kind: icon ? 'icon-only' : '' };
        })
    }));
    // 长列表改用紧凑多列排版，一张图出完。
    // 崩坏三圣痕有 700 条，走 wiki/list 的竖排会直接崩：页面过高超出 Chromium
    // 截图上限（120 条起报 Page is too large / Unable to capture screenshot）。
    // 100 条虽能截出但已有 21437px 高、6.1MB，发到 QQ 被拒（rich media transfer
    // failed，日志里那条 16.7MB 的图就是这么发不出去的）。
    // 曾试过渲染器的 data.multiPage，但它只切截图，700 张远程图标仍会一次性
    // 加载进同一页面，内存一样顶不住；分批渲染每批 60 条倒是能跑通，只是要发
    // 8 到 12 张图，太吵。
    // 改用 wiki/list_dense：8 列、图标 40px。实测五星圣痕 449 条
    // 2895px 高、0.73MB（jpeg），全量 700 条同排版也在同一量级，一张图搞定。
    // 紧凑排版只给崩坏三圣痕用，别的一律走 wiki/list。
    //
    // 圣痕需要特殊处理：米游社官方频道有 700 条（五星 475、四星 204、三星 15、
    // 二星 6），走 wiki/list 的竖排会直接崩 —— 页面过高超出 Chromium 截图上限
    // （120 条起报 Page is too large / Unable to capture screenshot）；100 条虽能
    // 截出但已有 21437px 高、6.1MB，发到 QQ 被拒（rich media transfer failed，
    // 日志里那条 16.7MB 的图就是这么发不出去的）。wiki/list_dense 用 8 列网格，
    // 实测 700 条也只有 4751px、5.34MB，一张图装得下。
    //
    // 曾按「条目数 > 100」全局启用，结果原神角色（144）、崩三角色（111）也被切过去，
    // 而 list_dense 只渲染图标和名字、不渲染 badges，星级/元素/命途/属性徽章全丢了。
    // 四个游戏的角色图鉴、武器、遗器等列表保持 wiki/list 同一套 UI，
    // 只有圣痕这一类条目特别多的用紧凑排版。
    const isLong = LONG_LIST(data.length);
    if (isBH3 && type === 'syw') {
      return render('wiki/list_dense', {
        name: _name,
        total: data.length,
        data,
      }, { e, ret: true });
    }
    data = {
      name: _name,
      data: data,
      // 只压 jpeg 质量，不再动 zoom。
      // 之前为了压体积把 zoom 从 2.4 降到 1.2，结果列表整张发出去是糊的
      //（字号本来就只有 10px，再缩一半就没法看了）。
      // 重新实测同一张列表：zoom 2.4 + q85 = 1.99MB，q75 = 1.54MB，都远
      // 在 QQ 的限制之内 —— 之前那张 4MB 是 CSS 没加载、页面按裸 HTML 排版
      // 撑出来的，不是正常体积。ppath 修好之后根本不需要降 zoom。
      quality: isLong ? 85 : undefined,
    };
    return render('wiki/list', data, { e, ret: true });
  }

  /**
   * 原神角色列表：Bwiki 头像覆盖 nanoka 头像。
   * fetchGsRoleList 内部有缓存，抓不到（567 限流/结构变化）时返回 null → 原样返回 nanoka 数据。
   * 覆盖时把 nanoka 的基础图顺延成 iconFallback，list.html 的 onerror 逐级切换，
   * 于是「Bwiki 图 → nanoka 方块 → nanoka 圆形」三级兜底，行为不变。
   * Bwiki 多出来的角色（测试服新角色 nanoka 还没有）按 nanoka 字段补齐。
   * 排序：五星组在前、四星组在后，组内最新的在最顶部。
   * 组内不重排 —— 两个数据源本身都是「上线时间降序」（mys.js 的 releaseRank、
   * Bwiki 角色一览的默认顺序都是新的在前），稳定排序保持原序即可。
   */
  /**
   * 图鉴背景图：从配置的随机图接口取一张，压到 1100px 宽的 jpeg 存到 temp/bg/。
   *
   * 为什么不直接把远程 URL 丢给模板：
   *   1) 原图是 2560×1440 的 PNG（实测 2MB），页面里铺开后 jpeg 体积会翻几倍，
   *      QQ 直接拒收（rich media transfer failed）。先在 Node 里压过再给模板。
   *   2) 远程图偶尔 404 或超时，模板里没有 onerror 兜底就会留一块空白。
   *      存本地文件后，<img> 加载不了也只是不显示，底色还在。
   *
   * 接口不可用 / 返回的不是图片 → 返回空串，模板退回纯色底。
   */
  async fetchGsBgFile() {
    const cfg = config();
    if (cfg.gs_bg === false) return '';
    const api = String(cfg.gs_bg_api || 'https://api.yppp.net/api.php').trim();
    if (!/^https?:\/\//i.test(api)) return '';
    const dir = `${process.cwd()}/temp/bg`;
    const key = Buffer.from(api).toString('base64url').slice(0, 40);
    const out = `${dir}/${key}.jpg`;
    // 6 小时换一张：同一张图反复用没意义，但也别每次出图都去打接口
    try {
      if (fs.existsSync(out) && Date.now() - fs.statSync(out).mtimeMs < 6 * 3600 * 1000) return out;
    } catch { /* 目录还没有，继续下载 */ }
    try {
      const ctrl = AbortSignal.timeout(15000);
      const r = await fetch(api, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', Referer: 'https://api.yppp.net/' },
        redirect: 'follow',
        signal: ctrl,
      });
      const ct = String(r.headers.get('content-type') || '');
      if (!r.ok || !ct.startsWith('image/')) return '';
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1024) return '';
      const sharp = (await import('sharp')).default;
      await fs.promises.mkdir(dir, { recursive: true });
      await sharp(buf).resize({ width: 1100 }).jpeg({ quality: 68 }).toFile(out);
      return out;
    } catch (err) {
      logger.debug?.(`[xhh][wiki] 背景图获取失败: ${err?.message}`);
      return '';
    }
  }

  /**
   * 星铁列表（角色 / 光锥 / 遗器）用 Bwiki 图覆盖 nanoka 图。
   * 和原神那套一样：抓不到整条回落 nanoka、nanoka 图顺延成 iconFallback 兜底。
   * 额外把命途/属性也换成 Bwiki 的叫法，与星铁详情卡保持一致。
   */
  /**
   * 星铁角色名 → 米游社 sr_wiki 的 content_id。
   * `mergeSrBwikiRole()` 里要用它拿「推荐光锥/遗器」攻略模块，但这个方法此前
   * **根本没定义** → `this.srContentId is not a function`，星铁角色卡一走到就崩。
   * 数据源：官方 sr_wiki 角色列表（channel_id=17），结果缓存，避免每次都请求。
   */
  async srContentId(name = '') {
    const key = nmKey(name);
    if (!key) return '';
    this._srCidCache ||= new Map();
    if (this._srCidCache.has(key)) return this._srCidCache.get(key);
    let cid = '';
    try {
      const res = await fetch('https://api-static.mihoyo.com/common/blackboard/sr_wiki/v1/home/content/list?app_sn=sr_wiki&channel_id=17')
        .then(r => r.json());
      const root = res?.data?.list?.[0];
      const children = Array.isArray(root?.children) ? root.children : [];
      const roleBox = children.find(c => c.name === '角色') || root;
      const list = Array.isArray(roleBox?.list) ? roleBox.list : [];
      const hit = list.find(x => nmKey(x.title) === key)
        || (key.length >= 2 ? list.find(x => nmKey(x.title).includes(key)) : null);
      cid = String(hit?.content_id ?? hit?.id ?? '');
    } catch { /* 取不到就不带推荐光锥/遗器，不影响出卡 */ }
    this._srCidCache.set(key, cid);
    return cid;
  }

  async mergeSrBwikiIcons(data, type) {
    // 星铁同一角色的不同形态在两边写法可能差一个分隔符
    // （nanoka「三月七•巡猎」/ 维基「三月七・巡猎」之类），
    // 匹配键统一去掉「•·・」和空格，只按纯名字比。
    const fetchers = { js: fetchSrRoleList, gz: fetchSrLcList, yq: fetchSrRelicList };
    const label = { js: '角色', gz: '光锥', yq: '遗器' }[type] || '条目';
    const fetcher = fetchers[type];
    if (!fetcher) return data;
    let list = null;
    try {
      list = await fetcher();
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_sr] ${label}图鉴抓取异常: ${err?.message}`);
      return data;
    }
    if (!list?.length) return data;
    const byName = new Map(list.map(x => [nmKey(x.name), x]));
    const seen = new Set();
    const merged = [];
    for (const item of data) {
      const nm = String(item.name || '').trim();
      const hit = byName.get(nmKey(nm));
      seen.add(nmKey(nm));
      if (!hit?.icon) { merged.push({ ...item, nanokaOnly: true }); continue; }
      merged.push({
        ...item,
        nanokaOnly: false,
        icon: hit.icon,
        iconFallback: item.icon || '',
        // 遗器没有星级/命途字段，保持 nanoka 的
        ...(type === 'yq' ? {} : {
          /* 优先用自己的 ji：Bwiki 那边写的是「5星」「4星」，而 list() 的
             rankClassMap 与 #五星xx 分档只认「五星」「四星」，用 Bwiki 的写法
             会让整批条目落成 r0（实测星铁光锥 170 条里 145 条没档位、也没排序）。
             自己这边没有星级时才用 Bwiki 的。 */
          ji: item.ji || hit.ji || '',
          mingtu: hit.path || item.mingtu,
          ...(type === 'js' ? { shuxing: hit.kind || item.shuxing } : {}),
        }),
      });
    }
    for (const x of list) {
      const nm = String(x.name || '').trim();
      if (!nm || seen.has(nmKey(nm)) || !x.icon) continue;
      merged.push({
        name: nm,
        /* Bwiki 的星级写法是「5星」「4星」，这里补成中文写法，
           否则这些 Bwiki 独有条目落成 r0（列表里看着像没有星级）。 */
        ji: { '5星': '五星', '4星': '四星', '3星': '三星' }[x.ji] || x.ji || '',
        mingtu: type === 'yq' ? '' : (x.path || ''),
        shuxing: type === 'js' ? (x.kind || '') : '',
        icon: x.icon,
        iconFallback: '',
        aliases: [nm],
        nanokaOnly: false,
      });
    }
    const hit = data.filter(i => byName.get(String(i.name || '').trim())?.icon).length;
    logger.debug?.(`[xhh][bwiki_sr] ${label}列表: Bwiki ${list.length} 条, 覆盖 nanoka ${hit}/${data.length}, 补入 ${merged.length - data.length}`);
    return merged;
  }

  async mergeGsBwikiRoleIcons(data, kind = 'js') {
    // 角色/武器/圣遗物三个列表都是「Bwiki 图覆盖 nanoka 图，抓不到就整条回落」，
    // 只有数据源和补条目的字段不一样，所以走同一个函数。
    const fetchers = { js: fetchGsRoleList, wq: fetchGsWeaponList, syw: fetchGsArtifactList };
    const label = { js: '角色', wq: '武器', syw: '圣遗物' }[kind] || '条目';
    const fetcher = fetchers[kind];
    if (!fetcher) return data;
    let list = null;
    try {
      list = await fetcher();
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${label}一览抓取异常: ${err?.message}`);
      return data;
    }
    if (!list?.length) return data;
    const GS_ELEMENT = { 风: '风', 火: '火', 冰: '冰', 雷: '雷', 水: '水', 岩: '岩', 草: '草' };
    const byName = new Map(list.map(x => [nmKey(x.name), x]));
    /* 再建一张「剥掉括号后缀」的索引：nanoka 与 Bwiki 的同名条目常带不同后缀 ——
       旅行者 → 旅行者（冰）/（火）/…（Bwiki 按形态分开 8 条），
       奇偶·男性 / 奇偶·女性 → 奇偶（nanoka 用「·」带性别，Bwiki 只有一条）。
       头像和星图在各形态之间没有区别，按剥掉后缀的名字匹配即可。 */
    const bareKey = v => nmKey(String(v || '').replace(/[（(][^（()）]*[）)]\s*$/, ''));
    const byBare = new Map(list.map(x => [bareKey(x.name), x]));
    // Bwiki 一览里查不到的（测试服角色米提亚/瓦列里等）按已有星级补星图，
    // 否则列表里就只有这几条缺稀有度标。
    const starByJi = { 五星: GS_STAR_ICON[5], 四星: GS_STAR_ICON[4] };
    const seen = new Set();
    const merged = [];
    for (const item of data) {
      const nm = String(item.name || '').trim();
      let hit = byName.get(nmKey(nm));
      /* 精确匹配落空时按剥后缀的名字再试：nmKey 只去掉「•·・」和空格、不去括号，
         「旅行者」对上「旅行者（冰）」、「奇偶·男性」对上「奇偶」都靠这一层。
         之前匹配不上会保留没有 rarityIcon 的 nanoka 原条目，列表头像就缺五星标。 */
      if (!hit) {
        const bases = [nm];
        const head = nm.split(/[•·・]/)[0].trim();
        if (head && head !== nm) bases.push(head);
        for (const base of bases) {
          hit = byBare.get(nmKey(base));
          if (hit) break;
        }
      }
      seen.add(nmKey(nm));
      if (!hit?.icon) {
        /* Bwiki 武器页只收抽卡池武器（实测 218 个去重名），正式服列表有 284 条，
           剩下的免费 1~3 星武器、活动武器、武器幻化在这里都匹配不到。
           这些条目保留 nanoka 数据，但星图按已有星级补上，否则头像上没有稀有度标。 */
        merged.push({ ...item, rarityIcon: item.rarityIcon || starByJi[item.ji] || '', nanokaOnly: true });
        continue;
      }
      // 命之座/上线时间那些字段 nanoka 更全，不动。
      // 武器类型特意改用 Bwiki 的叫法：nanoka 写「长枪」，Bwiki 写「长柄武器」，
      // 列表和详情卡（详情卡走 Bwiki）用同一套词，不然看着像类型对不上。
      merged.push({
        ...item,
        icon: hit.icon,
        iconFallback: item.icon || '',
        rarityIcon: hit.rarityIcon || starByJi[item.ji] || '',
        nanokaOnly: false,
        wuqi: (kind === 'wq' && hit.weapon) ? hit.weapon : item.wuqi,
      });
    }
    // Bwiki 有、nanoka 没有的：补成同形状条目追加在后面。
    // 旅行者各形态跳过：nanoka 那边已经按 name 去重只留一个「旅行者」，
    // 这里再补三个形态就等于把刚去掉的重复又加回来。
    // 武器/圣遗物页没有 data-param，拿不到武器类型/元素，这类补出来的条目
    // 徽章就只有星级那一项 —— 能显示出来比不显示强，完整信息看详情页。
    const extraNames = [];
    for (const x of list) {
      const nm = String(x.name || '').trim();
      if (!nm || seen.has(nm) || !x.icon) continue;
      if (kind === 'js' && /^旅行者/.test(nm)) continue;
      extraNames.push(nm);
      merged.push({
        name: nm,
        ji: String(x.rarity) === '5' ? '五星' : '四星',
        // Bwiki 里还有「无」「与旅行者相同」这类占位元素值，不是元素名，
        // 直接透传会让徽章显示成「元素/无」，过滤掉。
        yuanshu: kind === 'js' ? (GS_ELEMENT[x.element] || '') : '',
        // 武器一览的响应式页签能给出武器类型，页签标题按顺序对应每个 case
        wuqi: (kind === 'js' || kind === 'wq') ? (x.weapon || '') : '',
        icon: x.icon,
        iconFallback: '',
        rarityIcon: x.rarityIcon || '',
        aliases: [nm],
        nanokaOnly: false,
      });
    }
    // 星级分组：五星 → 四星。只按星级分组，组内不动 —— 两个源的原始顺序
    // 都已经是「上线时间降序」，Array.sort 稳定，不会打乱同分组内的先后。
    const rankOf = it => (it.ji === '五星' ? 0 : it.ji === '四星' ? 1 : 2);
    merged.sort((a, b) => rankOf(a) - rankOf(b));
    const hit = data.filter(i => byName.has(String(i.name || '').trim()) && byName.get(String(i.name || '').trim()).icon).length;
    logger.debug?.(`[xhh][bwiki_gs] ${label}列表: Bwiki ${list.length} 条, 覆盖 nanoka ${hit}/${data.length}, 补入 ${extraNames.length}`);
    /* 排序按 Bwiki 武器一览页的顺序来 —— **只对武器**（kind === 'wq'）。
       武器一览页的卡片结构本身就分 g5 / g4 两组，页面顺序即「5★ 组在前、组内新→旧」，
       直接照搬没问题。
       角色一览页用的是另一套 divsort 结构，页面上四星五星是交错排的，
       照搬页面顺序会把四星插进五星堆里（实测 122 条里出现 29 次五星被四星夹断）。
       所以角色与圣遗物不碰页面顺序，交给星级排序：
       ratingOrder 先按五星→四星分段，段内保留 nanoka 的新→旧。 */
    if (kind === 'wq') {
        const pageOrder = new Map();
        list.forEach((x, i) => { const k = nmKey(x.name); if (!pageOrder.has(k)) pageOrder.set(k, i); });
        const ordOf = x => {
            const k = pageOrder.get(nmKey(x.name));
            return k === undefined ? Number.MAX_SAFE_INTEGER : k;
        };
        const tierRank = { 五星: 1, 四星: 2, 三星: 3, 二星: 4, 一星: 5 };
        merged.sort((a, b) => {
            const oa = ordOf(a), ob = ordOf(b);
            if (oa !== ob) {
                // 两边都在页面上：按页面顺序；只有一边在页面上：该条排前面
                if (oa !== Number.MAX_SAFE_INTEGER && ob !== Number.MAX_SAFE_INTEGER) return oa - ob;
                return oa === Number.MAX_SAFE_INTEGER ? 1 : -1;
            }
            return (tierRank[a.ji] ?? 9) - (tierRank[b.ji] ?? 9);
        });
    }
    return merged;
  }



  normalizeZzzKey(text = '') {
    return String(text || '').replace(/[\s·・\-—_「」『』《》【】\[\]（）()]/g, '').toLowerCase();
  }

  async getZzzWikiEntries(channelId = 43) {
    if (!this._zzzObcIconCache) this._zzzObcIconCache = {};
    if (!this._zzzObcIconCache[channelId]) {
      try {
        const url = `https://api-takumi-static.mihoyo.com/common/blackboard/zzz_wiki/v1/home/content/list?app_sn=zzz_wiki&channel_id=${channelId}`;
        const res = await fetch(url).then(r => r.json());
        const root = res?.data?.list?.[0];
        let list = Array.isArray(root?.list) ? root.list : [];
        if (!list.length && Array.isArray(root?.children)) {
          const child = root.children.find(v => Number(v.id) === Number(channelId)) || root.children[0];
          list = Array.isArray(child?.list) ? child.list : [];
        }
        this._zzzObcIconCache[channelId] = list.map(item => ({
          title: String(item.title || '').replace(/\s/g, ''),
          alias: String(item.alias_name || '').replace(/\s/g, ''),
          aliases: String(item.alias_name || '')
            .split(/[、,，/|；;\s]+/)
            .map(v => v.trim())
            .filter(Boolean),
          icon: item.icon || ''
        }));
      } catch (err) {
        globalThis.logger?.warn?.('[xhh][wiki] 获取绝区零官方图标失败:', err);
        this._zzzObcIconCache[channelId] = [];
      }
    }
    return this._zzzObcIconCache[channelId];
  }

  async resolveZzzWikiName(name = '', channelId = 43) {
    const key = this.normalizeZzzKey(name);
    if (!key) return name;
    const alias = zzzAliasMap(channelId)[key];
    if (alias) return alias;
    const list = await this.getZzzWikiEntries(channelId);
    const keysOf = item => [item.title, item.alias, ...(item.aliases || [])].map(v => this.normalizeZzzKey(v)).filter(Boolean);
    let hit = list.find(item => keysOf(item).some(v => v === key));
    // 单字别名（如"雅"）过于宽泛，禁止其参与 key.includes(v) 兜底，避免随机串误命中
    if (!hit) hit = list.find(item => keysOf(item).some(v => v.includes(key) || (v.length >= 2 && key.includes(v))));
    return hit?.title || name;
  }

  async getZzzObcIcon(name = '', channelId = 43) {
    if (!name) return '';
    const list = await this.getZzzWikiEntries(channelId);
    const key = this.normalizeZzzKey(zzzAliasMap(channelId)[this.normalizeZzzKey(name)] || name);
    const hit = list.find(item => {
      const keys = [item.title, item.alias, ...(item.aliases || [])].map(v => this.normalizeZzzKey(v)).filter(Boolean);
      return keys.some(v => v === key || v.includes(key) || (v.length >= 2 && key.includes(v)));
    });
    return hit?.icon || '';
  }

  zzzCleanText(text = '', len = 120) {
    text = String(text || '')
      .replace(/<color=[^>]+>/g, '')
      .replace(/<\/color>/g, '')
      .replace(/<IconMap:[^>]+>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    return text.length > len ? `${text.slice(0, len)}…` : text;
  }

  zzzRichText(text = '') {
    return String(text || '')
      // 白色是游戏内深色界面的强调色，放到本插件的浅色卡片上会看不清。
      .replace(/#FFFFFF/gi, '#6b5b45')
      .replace(/<color=([^>]+)>/gi, '<span style="color:$1">')
      .replace(/<\/color>/gi, '</span>')
      .replace(/<IconMap:[^>]+>/gi, '')
      .replace(/\n/g, '<br>');
  }

  zzzDisplayText(text = '') {
    // 普通攻击/冲刺攻击等标签原本是游戏深色界面的白色，改成深色；
    // 百分比和属性数值保留原数据颜色，方便快速区分。
    return this.zzzRichText(String(text || '').replace(/#FFFFFF/gi, '#6b5b45'));
  }

  zzzMaxRandProperty(c = {}) {
    const value = Number(c.rand_property?.value || 0);
    const rate = Number(c.stars?.['5']?.rand_rate || 0);
    if (!Number.isFinite(value) || !Number.isFinite(rate) || !rate) return this.zzzFormatProperty(c.rand_property);
    const max = value * rate / 600000;
    return `${Number.isInteger(max) ? max : max.toFixed(1)}%`;
  }

  zzzFirstValue(obj = {}) {
    return Object.values(obj || {})[0] || '';
  }

  zzzFormatProperty(prop = {}) {
    const value = Number(prop.value);
    if (!Number.isFinite(value)) return prop.value || '';
    const format = String(prop.format || '');
    if (format.includes('%')) {
      const percent = value / 100;
      return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
    }
    return String(value);
  }

  getZzzWeaponTalent(c = {}) {
    const talents = Object.values(c.talents || {});
    return talents[talents.length - 1] || talents[0] || null;
  }

  // 绝区零代理人专属音擎/推荐驱动盘快捷查询
  async zzzExclusiveEquip(e, rawName = '') {
    const wantDrive = /(专属驱动盘|推荐驱动盘|驱动盘套|驱动套)/.test(rawName);
    const wantWeapon = /(专武|专属武器|专属音擎|签名音擎)/.test(rawName);
    let roleQuery = String(rawName || '')
      .replace(/专属武器|专属音擎|签名音擎|专武|专属驱动盘|推荐驱动盘|驱动盘套|驱动套/g, '')
      .replace(/图鉴/g, '')
      .trim();
    if (!roleQuery || (!wantWeapon && !wantDrive)) return false;

    const roleName = await this.resolveZzzWikiName(roleQuery, 43);
    const detail = await this.getZzzRoleDetail(roleName);
    if (!detail) return false;

    if (wantDrive) {
      const drives = await this.findZzzRecommendDrives(detail);
      if (!drives.length) {
        await e.reply(`未找到「${roleName}」的推荐驱动盘信息，建议直接发送具体驱动盘名图鉴。`);
        return true;
      }
      for (const name of drives) {
        if (await this.syw_yiqi(e, name, false, true, false)) return true;
      }
      await e.reply(`已识别「${roleName}」推荐驱动盘：${drives.join(' / ')}，但图鉴别名暂未命中。可以直接用完整驱动盘名查询。`);
      return true;
    }

    const weapon = await this.findZzzSignatureWeapon(roleName, detail);
    if (!weapon) {
      await e.reply(`未找到「${roleName}」的专属音擎信息，建议直接发送具体音擎名图鉴。`);
      return true;
    }
    if (await this.weapon(e, weapon, false, true, false)) return true;
    await e.reply(`已识别「${roleName}」专属音擎：${weapon}，但图鉴别名暂未命中。可以直接用完整音擎名查询。`);
    return true;
  }

  async getZzzRoleDetail(roleName = '') {
    try {
      const name = await this.resolveZzzWikiName(roleName, 43);
      const ret = await mys.data(name, 'js', false, true);
      const id = Array.isArray(ret) ? ret.find(v => v?.title === name)?.id || ret[0]?.id : ret?.id;
      if (!id) return null;
      return await mys.detail(id, false, true);
    } catch (err) {
      if (config().debug) logger.mark(`[xhh] ZZZ专属装备获取代理人详情失败: ${roleName} ${err?.message || err}`);
      return null;
    }
  }

  async findZzzRecommendDrives(detail = {}) {
    const list = await this.getZzzWikiEntries(46);
    const text = JSON.stringify(detail.content || {});
    const hits = [];
    for (const item of list) {
      if (item.title && text.includes(item.title)) hits.push(item.title);
    }
    return [...new Set(hits)].slice(0, 2);
  }

  async findZzzSignatureWeapon(roleName = '', detail = {}) {
    const direct = await this.findZzzWeaponInRoleDetail(detail);
    if (direct) return direct;
    const c = detail.content || {};
    const aliases = [roleName, c.name, c.code_name, c.partner_info?.full_name]
      .flatMap(v => String(v || '').split(/[、,，/|；;\s]+/))
      .map(v => v.trim())
      .filter(v => v && v.length >= 2);
    const full = String(c.partner_info?.full_name || '');
    if (full.includes('·')) aliases.push(full.split('·')[0], full.split('·').slice(-1)[0]);

    const mapPath = './plugins/ZZZ-Plugin/resources/map/WeaponId2Data.json';
    if (!fs.existsSync(mapPath)) return '';
    let weaponMap = {};
    try { weaponMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8')); } catch (_) { return ''; }

    let best = { name: '', score: 0 };
    for (const item of Object.values(weaponMap)) {
      const name = item?.Name || item?.name || '';
      const desc = `${item?.Desc || ''}\n${item?.Desc2 || ''}\n${item?.Desc3 || ''}`;
      if (!name || !desc) continue;
      let score = 0;
      for (const alias of [...new Set(aliases)]) {
        if (!alias) continue;
        if (desc.includes(`是${alias}惯用`)) score += 120;
        if (desc.includes(`${alias}惯用`)) score += 100;
        if (desc.includes(`对于${alias}来说`)) score += 80;
        if (desc.includes(`——${alias}`) || desc.includes(`—${alias}`)) score += 35;
        if (desc.includes(alias)) score += 15;
      }
      if (score > best.score) best = { name, score };
    }
    return best.score >= 15 ? best.name : '';
  }

  async findZzzWeaponInRoleDetail(detail = {}) {
    const list = await this.getZzzWikiEntries(45);
    const text = JSON.stringify(detail.content || {});
    const hit = list.find(item => item.title && text.includes(item.title));
    return hit?.title || '';
  }

  async zzz_role_pictures(e, data) {
    const c = data.content || {};
    const partner = c.partner_info || {};
    const rarity = c.rarity === 4 ? 'S' : c.rarity === 3 ? 'A' : `${c.rarity || '?'}星`;
    const element = this.zzzFirstValue(c.element_type) || this.zzzFirstValue(c.special_element_type) || '未知属性';
    const type = this.zzzFirstValue(c.weapon_type) || '未知特性';
    const camp = this.zzzFirstValue(c.camp) || '未知阵营';
    const hit = this.zzzFirstValue(c.hit_type) || '未知攻击类型';
    const maxLv = c.level?.['6'] || {};
    const base = c.stats || {};
    const passiveMax = Object.values(c.passive?.level || {}).slice(-1)[0] || {};
    const skills = Object.entries(c.skill || {}).slice(0, 5).map(([key, val]) => {
      const first = (val.description || []).find(v => v?.desc) || {};
      return {
        name: first.name || ({ basic: '普通攻击', dodge: '闪避', special: '特殊技', chain: '连携技', assist: '支援技' }[key] || key),
        desc: this.zzzCleanText(first.desc, 110)
      };
    }).filter(v => v.name || v.desc);
    if (passiveMax.name?.length) {
      skills.unshift({ name: passiveMax.name[0], desc: this.zzzCleanText(passiveMax.desc?.[0], 110) });
      if (passiveMax.name[1]) skills.unshift({ name: passiveMax.name[1], desc: this.zzzCleanText(passiveMax.desc?.[1], 110) });
    }
    const talents = Object.values(c.talent || {}).slice(0, 6).map(v => ({
      level: v.level,
      name: v.name,
      desc: this.zzzCleanText(v.desc, 88)
    }));
    const fr = c.fairy_recommend || {};
    // nanoka 的 part4/5/6 是「主词条推荐集合」，与实际 slot 不是一一对应
    // （如艾莲 part6=暴击伤害，但 6 号位并无此词条），按主词条/副词条两组展示，避免错误的号位标注
    const mainStats = [fr.part4?.name, fr.part5?.name, fr.part6?.name].filter(Boolean);
    const propMap = { ...ZZZ_PROP_NAMES };
    [fr.part4, fr.part5, fr.part6, fr.part_sub].forEach(p => { if (p?.prop) propMap[p.prop] = p.name; });
    const subNames = [fr.part_sub?.name, ...(fr.part_sub_list || [])]
      .map(id => propMap[id] || id)
      .filter((v, i, arr) => v && arr.indexOf(v) === i);
    const recommend = {
      main: mainStats.join(' / '),
      sub: subNames.join(' / ')
    };
    // 档案简介是图鉴核心内容，不做字数截断；之前 260 字会在部分角色末尾显示"…"。
    const profile = this.zzzCleanText(partner.profile_desc || c.desc || '', 9999);
    const obcIcon = await this.getZzzObcIcon(c.name, 43);
    const ascendMaterials = await mys.zzzParseRoleAscendMaterials(c.level);
    const skillMaterials = await mys.zzzParseRoleSkillMaterials(c.skill);
    const expMaterials = await mys.zzzParseRoleExpMaterials(c.level_exp);
    const passiveMaterials = await mys.zzzParseRolePassiveMaterials(c.passive);
    const view = {
      name: c.name || '未知代理人',
      avatar_img: obcIcon,
      code_name: c.code_name || '',
      full_name: partner.full_name || '',
      avatar_text: (c.name || '?').slice(0, 1),
      tags: [
        { text: rarity, primary: true },
        { text: element, primary: true },
        { text: type },
        { text: camp },
        { text: hit }
      ].filter(v => v.text),
      profile,
      info: [
        { key: '全名', value: partner.full_name || c.name },
        { key: '生日', value: partner.birthday || '-' },
        { key: '性别', value: partner.gender || '-' },
        { key: '阵营', value: camp },
        { key: '属性', value: element, icon: this.getWikiIcon(element, 'zzz') },
        { key: '特性', value: type, icon: this.getWikiIcon(type, 'zzz') }
      ],
      stats: [
        { key: '生命', value: (base.hp_max || 0) + (maxLv.hp_max || 0) },
        { key: '攻击', value: (base.attack || 0) + (maxLv.attack || 0) },
        { key: '防御', value: (base.defence || 0) + (maxLv.defence || 0) },
        { key: '冲击力', value: base.break_stun || '-' },
        { key: '异常掌控', value: base.element_abnormal_power || '-' },
        { key: '异常精通', value: base.element_mystery || '-' },
        { key: '暴击率', value: base.crit ? `${base.crit / 100}%` : '-' },
        { key: '暴击伤害', value: base.crit_damage ? `${base.crit_damage / 100}%` : '-' }
      ],
      strategy: (c.strategy || []).map(v => this.zzzCleanText(v, 90)).filter(v => v && !/^\d{1,2}$/.test(v)),
      skills: skills.slice(0, 6),
      talents,
      recommend,
      ascendMaterials,
      skillMaterials,
      expMaterials,
      passiveMaterials
    };
    return render('wiki/zzz_role_nk', view, { e, ret: true });
  }

  async zzz_wq_pictures(e, data) {
    const c = data.content || {};
    const obcIcon = await this.getZzzObcIcon(c.name, 45);
    const refinements = Object.entries(c.talents || {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([level, talent]) => ({
        level,
        name: talent?.name || '音擎效果',
        desc: this.zzzDisplayText(talent?.desc || '')
      }))
      .filter(v => v.desc);
    const talent = refinements[0];
    const materials = await mys.zzzParseMaterials(c.materials, c.level);
    const view = {
      name: c.name || '未知音擎',
      avatar_img: obcIcon,
      code_name: c.code_name || '',
      avatar_text: '音',
      tags: [
        { text: c.rarity === 4 ? 'S' : c.rarity === 3 ? 'A' : `${c.rarity || '?'}星`, primary: true },
        { text: this.zzzFirstValue(c.weapon_type) || '音擎', primary: true },
        { text: c.base_property?.name },
        { text: c.rand_property?.name }
      ].filter(v => v.text),
      profile: this.zzzCleanText(c.desc || c.desc3 || '', 260),
      info: [
        { key: '类型', value: this.zzzFirstValue(c.weapon_type) || '-' },
        { key: '基础属性（满级）', value: `${c.base_property?.name || '-'} ${c.max_attack || '-'}` },
        { key: '副属性（满级）', value: `${c.rand_property?.name || '-'} ${this.zzzMaxRandProperty(c)}` },
        { key: '适用说明', value: c.desc2 || '-' }
      ],
      stats: [],
      strategy: [],
      skills: talent ? [{
        name: talent.name || '音擎效果',
        desc: this.zzzDisplayText(talent.desc || '')
      }] : [],
      refinements,
      talents: [],
      recommend: [],
      materials
    };
    return render('wiki/zzz_role_nk', view, { e, ret: true });
  }

  async zzz_syw_pictures(e, data) {
    const c = data.content || {};
    // 单栏版式，和星铁 wiki/yiqi 一致：名称与图标左右两格、左对齐，共用 yq_syw.css。
    // 之前试过原神 wiki/syw 那种 .pic_ 居中块，图标小、留白多，没采用。
    // 更早之前这里错用角色卡模板 wiki/zzz_role，那是带 info-grid / stats-grid /
    // skill-grid 的三栏布局，驱动盘只有两条套装效果，套上去又空又宽。
    // 单独建 wiki/zzz_syw 而不直接用 wiki/yiqi：yiqi 的 {{t.value}} 会转义，
    // zzzRichText 产出的 <span style="color:…"> 技能名高亮会变成字面量显示在页面上；
    // zzz_syw 改用 {{@t.value}} 不转义，排版仍与 yiqi 一致。
    // 官方 Wiki 回退时只有 name/summary，没有 desc2/desc4，套装效果会留空。
    const icon = mys.zzzSuitIcon?.(c.icon) || '';
    const view = {
      name: c.name || '未知驱动盘',
      pic: icon ? [icon] : [],
      table: [
        { key: '2件套', value: this.zzzCleanText(c.desc2 || '', 120) },
        { key: '4件套', value: this.zzzRichText(c.desc4 || '') }
      ].filter(v => v.value)
    };
    return render('wiki/zzz_syw', view, { e, ret: true });
  }

  async zzz_yq_pictures(e, data) {
    const c = data.content || {};
    const base = c.stats || {};
    // 优先本地补图目录（剧情邦布官方观测枢没有头像），其次观测枢图标
    const obcIcon = mys.zzzBangbooLocalIcon?.(c.name) || await this.getZzzObcIcon(c.name, 44);
    const view = {
      name: c.name || '未知邦布',
      avatar_img: obcIcon,
      code_name: c.code_name || '',
      avatar_text: '布',
      tags: [{ text: c.rarity === 4 ? 'S' : c.rarity === 3 ? 'A' : `${c.rarity || '?'}星`, primary: true }, { text: '邦布', primary: true }],
      profile: this.zzzCleanText(c.desc || '', 220),
      info: [{ key: '代号', value: c.code_name || '-' }, { key: '稀有度', value: c.rarity || '-' }],
      stats: [
        { key: '生命', value: base.hp_max || '-' },
        { key: '攻击', value: base.attack || '-' },
        { key: '防御', value: base.defence || '-' },
        { key: '冲击力', value: base.break_stun || '-' },
        { key: '异常掌控', value: base.element_abnormal_power || '-' }
      ],
      strategy: [],
      skills: Object.values(c.skill || {}).slice(0, 5).map(v => ({ name: v.name, desc: this.zzzCleanText(v.desc, 100) })).filter(v => v.name || v.desc),
      talents: [], recommend: []
    };
    return render('wiki/zzz_role_nk', view, { e, ret: true });
  }

  async bangboo(e, name) {
    name = await this.resolveZzzWikiName(name, 44);
    // 正式服模式：绝区零邦布优先 Bwiki 词条 + 米游社属性，失败回退 nanoka。测试服只用 nanoka。
    if (!isTestDataMode()) {
      const done = await this.zzz_bangboo_bwiki_pictures(e, name);
      if (done !== false && done != null) return true;
    }
    const ret = await mys.data(name, 'yq', false, true);
    if (!ret?.id) return false;
    const data = await mys.detail(ret.id, false, true);
    if (!data) return false;
    return this.zzz_yq_pictures(e, data);
  }


  //遗器图
  async yiqi_pictures(e, data) {
    let ext = JSON.parse(data.ext).c_30;
    data = {
      name: data.title,
      pic: ext.picture.list,
      table: ext.table.list,
    };
    render('wiki/yiqi', data, { e, ret: true });
  }

  //圣遗物图
  async syw_pictures(e, data) {
    let ext = JSON.parse(data.ext).c_218;
    data = {
      name: data.title,
      icon: data.icon,
      table: ext.table.list,
    };
    render('wiki/syw', data, { e, ret: true });
  }

  //圣遗物和遗器
  async syw_yiqi(e, name, isSr = false, isZZZ = false, isBH3 = false, roleName = '') {
    if (isZZZ) {
      name = await this.resolveZzzWikiName(name, 46);
      // 正式服模式：绝区零驱动盘优先 Bwiki 词条页，失败再回退 nanoka。测试服只用 nanoka。
      if (!isTestDataMode()) {
        const done = await this.zzz_syw_bwiki_pictures(e, name);
        if (done !== false && done != null) return true;
      }
      const ret = await mys.data(name, 'syw', false, true);
      if (!ret?.id) return false;
      const data = await mys.detail(ret.id, false, true);
      if (!data) return false;
      this.zzz_syw_pictures(e, data);
      return true;
    }
    const path = isZZZ
      ? './plugins/xhh/system/default/zzz_syw_names.yaml'
      : isBH3
      ? './plugins/xhh/system/default/bh3_syw_names.yaml'
      : isSr
      ? './plugins/xhh/system/default/yiqi.yaml'
      : './plugins/xhh/system/default/syw.yaml';
    const _name = yaml.get(path);
    for (let i in _name) {
      if (_name[i].includes(name)) {
        name = i;
        break;
      }
    }
    // 本地 yaml 只做别名归一，不再当准入门槛。
    // 以前用 Object.keys(_name).includes(name) 卡一道，结果是 yaml 里没有的套装
    // 一律 return false —— 而 syw.yaml 只有 59 个、yiqi.yaml 只有 54 个，
    // 都少于 nanoka 的 65 / 64 套，新出的套装就这么被挡在门外。
    // 名字没在 yaml 里就保持原样，交给下面的列表匹配（mys.data 会按 title 精确匹配）。
    {
      // 星铁遗器：正式服优先 Bwiki 词条页，失败再回退 nanoka。测试服只用 nanoka。
      if (isSr && !isZZZ && !isBH3 && !isTestDataMode()) {
        const done = await this.sr_relic_bwiki_pictures(e, name);
        if (done !== false && done != null) return true;
      }
      // 原神圣遗物：正式服优先 Bwiki 词条页，失败再回退米游社/nanoka。测试服只用 nanoka。
      if (!isSr && !isZZZ && !isBH3 && !isTestDataMode()) {
        const done = await this.gs_syw_bwiki_pictures(e, name);
        if (done !== false && done != null) return true;
      }
      let data = await mys.data(name, isZZZ ? 'syw' : isBH3 ? 'syw' : isSr ? 'yq' : 'syw', isSr, isZZZ, isBH3);
      if (!data) return false;
      if (Array.isArray(data)) {
        data = data.find(v => v.title == name);
        if (!data) return false;
      }
      if (isZZZ) {
        this.zzz_syw_pictures(e, data);
      } else if (isBH3) {
        const id = data?.id || data?.content_id;
        const detail = id ? await mys.detail(id, false, false, true) : data;
        if (!detail) return false;
        this.bh3_syw_pictures(e, detail, roleName);
      } else if (isSr) {
        this.yiqi_pictures(e, data);
      } else {
        this.syw_pictures(e, data);
      }
      return true;
    }
    return false;
  }

  //武器
  async weapon(e, name, isSr = false, isZZZ = false, isBH3 = false, roleName = '') {
    if (isZZZ) {
      name = await this.resolveZzzWikiName(name, 45);
      // 正式服模式：绝区零音擎优先 Bwiki 词条页，失败再回退 nanoka。测试服只用 nanoka。
      if (!isTestDataMode()) {
        const done = await this.zzz_wq_bwiki_pictures(e, name);
        if (done !== false && done != null) return true;
      }
      const ret = await mys.data(name, 'wq', false, true);
      if (!ret?.id) return false;
      const data = await mys.detail(ret.id, false, true);
      if (!data) return false;
      this.zzz_wq_pictures(e, data);
      return true;
    }
    const path = isZZZ
      ? './plugins/xhh/system/default/zzz_wq_names.yaml'
      : isBH3
      ? './plugins/xhh/system/default/bh3_wq_names.yaml'
      : !isSr
      ? './plugins/xhh/system/default/wqname.yaml'
      : './plugins/xhh/system/default/gz_names.yaml';
    const wq_name = yaml.get(path) || {};
    for (let i in wq_name) {
      if (Array.isArray(wq_name[i]) && wq_name[i].includes(name)) {
        name = i;
        break;
      }
    }
    // 本地 yaml 没命中时，用喵喵插件的武器别名表兜底（仅原神/星铁，ZZZ/BH3 走各自流程）
    let wq = Object.keys(wq_name).includes(name) ? name : '';
    if (!wq && !isZZZ && !isBH3) {
      const miao = await miaoResolve(name, 'weapon', isSr ? 'sr' : 'gs');
      if (miao) wq = miao;
    }
    /* 别名表只做别名归一，不再当准入门槛 —— 和 syw_yiqi 里那条注释同一个道理。
       gz_names.yaml 只有 157 条，而星铁光锥实测 172 个，缺 15 个：
       嗤笑 / 残泪 / 放个短假 / 未来，有我们一起 / 向着地平线的终点 / 在世界尽头相会吧！/
       献给明日的色彩 / 一场谎言的终幕 / 欢迎来到银河城 / 邂逅于下一个花季 /
       灼尽炼狱的新骸 / 你将起身歌唱 / 向浪花掷下盛夏 / 当第一声「阿哈」响起 / 欢愉满溢祝福。
       以前 wq 为空就直接 return false，这 15 个连正式名都查不到。
       system/default 目录标注了不许改动，所以不往 yaml 里补条目，改为放行给列表匹配。 */
    if (!wq) wq = name;
    if (wq) {
      // 正式服模式：原神武器优先 Bwiki 词条页，失败再回退米游社/nanoka。测试服模式只用 nanoka。
      if (!isSr && !isZZZ && !isBH3 && !isTestDataMode()) {
        const done = await this.gs_wq_bwiki_pictures(e, wq);
        if (done !== false && done != null) return true;
      }
      // 星铁光锥同理：正式服优先 Bwiki 词条页。
      if (isSr && !isZZZ && !isBH3 && !isTestDataMode()) {
        const done = await this.sr_item_bwiki_pictures(e, wq, 'gz');
        if (done !== false && done != null) return true;
      }
      // 类型要透传给 detail：nanoka 的详情文件按类型分目录（光锥 lightcone / 武器 weapon），
      // 不传就一律按 character 去取，光锥 id 必然 404（见 mys.js nanoka_detail 注释）。
      const wtype = isZZZ ? 'wq' : isBH3 ? 'wq' : isSr ? 'gz' : 'wq';
      const { id } = await mys.data(wq, wtype, isSr, isZZZ, isBH3);
      if (!id) return false;
      let data = await mys.detail(id, isSr, isZZZ, isBH3, false, wtype);
      // 详情取不到（Bwiki 限流 567、或该条目 Bwiki 没收）就干净返回 false，
      // 让调用方走「没有找到」的提示，而不是把 null 丢进渲染器。
      // 这里刻意不校验 data.content 的内部结构：详情源被限流时结构同样为空，
      // 早先加了结构判断，结果 雾切之回光 这种确实有页面的条目也被判成无详情。
      if (!data) {
        logger.debug?.(`[xhh][图鉴] 武器「${wq}」详情获取失败（id=${id}）`);
        return false;
      }
      // 渲染器是按 Bwiki 页面结构写的，条目缺页时解析会抛异常；
      // 兜住异常并记日志，避免整条消息被吞掉。
      try {
        if (isZZZ) this.zzz_wq_pictures(e, data);
        else if (isBH3) this.bh3_wq_pictures(e, data, roleName);
        else if (isSr) {
          // nanoka 兜底的数据结构（{ content: {...}, nanoka: true }）和 Bwiki 完全不同，
          // 直接丢给 sr_gz_pictures 会读 data.content.contents[0].text 崩溃。
          if (data?.nanoka) this.sr_gz_nanoka_pictures(e, data);
          else this.sr_gz_pictures(e, data);
        }
        else this.gs_wq_pictures(e, data);
      } catch (err) {
        logger.error?.(`[xhh][图鉴] 武器「${wq}」详情渲染失败: ${err?.message || err}`);
        return false;
      }
      return true;
    }
    return false;
  }

  //角色
  async role(e, name, isSr = false, isZZZ = false, isBH3 = false) {
    const dbg = (...args) => { if (config().debug) logger.mark('[xhh][图鉴解析]', ...args); };
    if (isZZZ) {
      name = await this.resolveZzzWikiName(name, 43);
      dbg('ZZZ 角色解析:', name);
      // 正式服模式：绝区零角色优先米游社百科 + Bwiki 徽章/属性/攻略，失败回退 nanoka。测试服只用 nanoka。
      if (!isTestDataMode()) {
        const done = await this.zzz_bwiki_role_pictures(e, name);
        if (done !== false && done != null) return true;
      }
      const ret = await mys.data(name, 'js', false, true);
      if (!ret?.id) { dbg('ZZZ wiki 无此角色:', name); return false; }
      dbg('ZZZ 命中条目:', `id=${ret.id}`, ret.official ? '来源=官方Wiki兜底(详情走官方)' : '来源=nanoka');
      // ret.official：id 来自官方 Wiki 兜底匹配，详情直接走官方源（nanoka 使用独立编号体系，拿官方 id 查必然 404）
      const data = await mys.detail(ret.id, false, true, false, !!ret.official);
      if (!data) { dbg('ZZZ 角色详情获取失败:', name, 'id=' + ret.id); return false; }
      this.zzz_role_pictures(e, data);
      return true;
    }
    const path = isZZZ
      ? './plugins/xhh/system/default/zzz_js_names.yaml'
      : isBH3
      ? './plugins/xhh/system/default/bh3_js_names.yaml'
      : isSr
      ? './plugins/xhh/system/default/sr_js_names.yaml'
      : './plugins/xhh/system/default/gs_js_names.yaml';
    const role_name = yaml.get(path);
    for (let i in role_name) {
      if (role_name[i].includes(name)) {
        name = i;
        break;
      }
    }
    // 本地 yaml 没命中时，用喵喵插件的角色别名表兜底（仅原神/星铁，ZZZ/BH3 走各自流程）
    let rname = Object.keys(role_name).includes(name) ? name : '';
    if (!rname && !isZZZ && !isBH3) {
      const miao = await miaoResolve(name, 'char', isSr ? 'sr' : 'gs');
      if (miao) rname = miao;
    }
    // 本地别名表是人工维护的，会漏新角色（官方 94 个角色本地只有 89 条），
    // 具体就是带装饰符的：「星神★阿哈」「砂金•戏浪」「银狼LV.999」等。
    // 别名表没命中时，直接拿原名去官方 Wiki 做模糊匹配（mys.data() 已支持「精确 -> 包含」两级匹配），
    // 这样下个新角色上线不再需要手动补别名。
    if (!rname) {
      dbg('本地/喵喵别名未命中，回退官方 Wiki 模糊匹配:', name);
      rname = name;
    }
    if (rname) {
      let hitSr = isSr;
      let { id } = await mys.data(rname, 'js', hitSr, isZZZ, isBH3);
      if (!id && !isZZZ && !isBH3) {
        // 命令没带游戏前缀时只查命令暗示的那一个游戏，于是「#阿哈图鉴」会去
        // 原神列表里找，而阿哈是星铁角色。实测阿哈不在原神列表、芙宁娜不在
        // 星铁列表，两边都查一遍才能让「#角色名图鉴」不必显式写「星铁」。
        // 命令带了前缀的第一次就能查到，不会走到这里，不会覆盖显式指定。
        hitSr = !isSr;
        ({ id } = await mys.data(rname, 'js', hitSr, isZZZ, isBH3));
        if (id) dbg('跨游戏回退命中:', rname, '→', hitSr ? '星铁' : '原神');
      }
      isSr = hitSr;
      // 原神：优先 Bwiki。Bwiki 收录更全（有角色档案、徽章图标、逐级数值），
      // nanoka 只作为兜底 —— 测试服角色 Bwiki 还没有，只能走 nanoka。
      // 星铁/绝区零/崩三暂时仍走原路径，Bwiki 那套只验证过原神。
      //
      // 这一段放在「!id 就 return false」之前：Bwiki 有而官方角色列表没有的角色
      // （例如刚上线或仅维基收录的）也能出图，否则会被官方列表先挡掉。
      /* ⚠️ 但 test 模式下**必须整段跳过**。Bwiki 是正式服站，里面全是正式服角色；
         这条分支不走 mys.data()、直接裸调 fetchGsRole，所以 mys.data() 里的
         modeOk 闸门（mys.js 的单查闸门）根本管不到它 —— 不挡的话，
         test 模式下发「#钟离图鉴」会直接拿到 Bwiki 的正式服数据，
         等于测试服模式把正式服内容放了出来。
         test 模式只用 nanoka + manifest.new.*，两种数据不混用。 */
      if (isTestDataMode()) {
        dbg('测试服数据模式：跳过 Bwiki 角色图鉴，只用 nanoka 数据');
      } else if (!isSr && !isZZZ && !isBH3) {
        const done = await this.gs_bwiki_role_pictures(e, rname);
        // render 返回的是 e.runtime.render 的结果，不保证是布尔值，
        // 所以用「非 false」判定成功，否则成功时也可能被当成失败再降级一次。
        if (done !== false && done != null) return true;
        dbg('Bwiki 无此角色或渲染失败，回退 nanoka:', rname);
      }
      if (!id) { dbg('wiki 无此角色条目:', rname); return false; }
      let data = await mys.detail(id, isSr, isZZZ, isBH3);
      if (!data) { dbg('角色详情获取失败:', rname, 'id=' + id); return false; }
      if (data?.nanoka) return this.nanoka_role_pictures(e, data, isSr);
      else if (isZZZ) this.zzz_role_pictures(e, data);
      else if (isBH3) this.bh3_role_pictures(e, data);
      else if (isSr) this.sr_role_pictures(e, data);
      else this.gs_role_pictures(e, data);
      return true;
    }
    return false;
  }

  //星铁角色
    // nanoka 源的角色详情卡：技能逐级数值 / 命座(星魂) / 天赋 / 属性成长表
    /**
   * 原神角色图鉴：Bwiki 数据源。
   * 抓不到就返回 false，让调用方降级到 nanoka —— 测试服角色只有 nanoka 有。
   */
  async gs_bwiki_role_pictures(e, name) {
    /* 纵深防御：调用方（role）已挡过一次，这里再挡一道。
       Bwiki 是正式服站，本函数不该在 test 模式下被触达。 */
    if (isTestDataMode()) {
      logger.debug?.(`[xhh][bwiki_gs] 测试服数据模式：拒绝 Bwiki 角色图鉴（${name}）`);
      return false;
    }
    const dbg = (...a) => { if (config().debug) logger.mark('[xhh][bwiki_gs]', ...a); };
    let d = null;
    try {
      d = await fetchGsRole(name);
    } catch (err) {
      // 绝不能让 Bwiki 的异常把整条图鉴指令带崩
      logger.debug?.(`[xhh][bwiki_gs] ${name} 抓取异常: ${err?.message}`);
      return false;
    }
    if (!d) return false;
    /* 页面存在但内容明显不完整时也别硬渲染，宁可回退 nanoka。
       ⚠️ 不能只看 skillBlocks.length：测试服新角色（如米提亚）在 Bwiki 上
       词条已建但技能数据**未录入**，每个技能块里只剩「请上传文件『.gif』」占位符 ——
       块数照样是 6，但 name 全是「文件:.png」、desc 全空。
       只数块数会把它当「完整」放行，卡面就是空的。
       所以这里额外校验：技能名要像真的技能名（不含占位符标记），
       且至少有带描述的技能。 */
    const placeholder = /文件[:：]|请上传文件|\.png|\.gif/i;
    const realSkills = (d.skillBlocks || []).filter(b =>
      b?.name && !placeholder.test(String(b.name)) && String(b.desc || '').trim().length > 0);
    if (!d.basic || !Object.keys(d.basic).length || !realSkills.length) {
      dbg(`${name} 解析内容不完整（技能块${d.skillBlocks?.length ?? 0}个/有效${realSkills.length}个），回退 nanoka`);
      return false;
    }
    const { detail, extra } = buildGsDetail(d);
    const view = gsRoleView(detail, '');
    view.source = extra.source;
    view.topBadges = extra.topBadges;
    view.gacha = extra.gacha;
    // 角色详细：图鉴顶部第一块；#角色故事 指令也用 extra.detailStory，同一份数据
    view.detailStory = extra.detailStory;
    // 背景图：纯装饰，失败返回空串，不影响图鉴本身
    view.bgFile = await this.fetchGsBgFile();
    // 攻略：子页不存在时返回 null，模板的 {{if guide}} 会整块跳过
    try {
      // 图标再走一次文件页换成原图，缩略图放大是糊的
      view.guide = await resolveGsGuideIcons(parseGsGuide(await fetchGsGuidePage(detail.name)));
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${detail.name} 攻略抓取失败: ${err?.message}`);
      view.guide = null;
    }
    dbg(`${name} → ${detail.name} 技能${detail.skills.length} 命座${detail.constellations.length} ` +
      `天赋${detail.passives.length} 徽章${extra.topBadges.length} 攻略${view.guide ? '有' : '无'}`);
    try {
      return await render('wiki/gs_role_nk', { ...view, name: detail.name }, { e, ret: true });
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${name} 渲染失败: ${err?.message}`);
      return false;
    }
  }

  async nanoka_role_pictures(e, data, isSr = false) {
        const c = data?.content || {};
        const tpl = isSr ? 'wiki/sr_role_nk' : 'wiki/gs_role_nk';
        const view = isSr ? srRoleView(c, c.id || '') : gsRoleView(c, c.id || '');
        const name = c.name;
        if (!name) return false;
        if (!isSr) return render(tpl, { ...view, name }, { e, ret: true });

        // 星铁：基础信息 / 属性成长 / 技能 / 星魂 改用 Bwiki，
        // 推荐光锥、遗器、词条这些 nanoka 更全（页面里也没有），保留 nanoka 的。
        // 抓取或解析失败时 sr 视图保持原样，整张卡退回全 nanoka，不会缺块。
        const bw = await this.mergeSrBwikiRole(name, view);
        return render(tpl, { ...bw, name }, { e, ret: true });
    }

  /**
     * 星铁角色卡：Bwiki 覆盖 nanoka。
     * 只覆盖 Bwiki 确实解析到的字段；数组为空就不覆盖，避免把 nanoka 有用的
     * 推荐光锥/遗器/词条清空（那些数据 Bwiki 角色页里根本没有）。
     */
    async mergeSrBwikiRole(name, view) {
        /* Bwiki 是正式服站。test 模式下整段跳过，保留 nanoka 的测试服视图 ——
           否则技能/属性/命途会被 Bwiki 的正式服数据覆盖，正式服内容就漏进来了。
           这里同样是裸调 fetchSrRole，不经 mys.data()，闸门管不到。 */
        if (isTestDataMode()) {
            logger.debug?.(`[xhh][图鉴] 测试服数据模式：跳过 Bwiki 合并（${name}），保留 nanoka 视图`);
            return view;
        }
        try {
            const bw = await fetchSrRole(name);
            if (!bw) {
              logger.debug?.(`[xhh][bwiki_sr] ${name} 无 Bwiki 数据，保留 nanoka`);
              return view;
            }
            const merged = { ...view };
            const take = k => { if (bw[k] !== undefined && bw[k] !== null && bw[k] !== '') merged[k] = bw[k]; };
            ['icon', 'rarity', 'rarityIcon', 'rarityIconUrl', 'path', 'pathIcon', 'pathIconUrl',
              'damage', 'damageIcon', 'damageIconUrl', 'camp',
              'hp', 'atk', 'def', 'speed', 'crit', 'critDmg', 'spNeed', 'traceBonus', 'desc', 'growth'].forEach(take);
            if (Array.isArray(bw.skills) && bw.skills.length) merged.skills = bw.skills;
            if (Array.isArray(bw.ranks) && bw.ranks.length) merged.ranks = bw.ranks;
            if (Array.isArray(bw.passives) && bw.passives.length) merged.passives = bw.passives;
            // 角色故事：nanoka 那边本来就有，但维基的版本带解锁条件、分段更整齐，
            // 一并用 Bwiki 的
            if (Array.isArray(bw.stories) && bw.stories.length) merged.stories = bw.stories;
            // 卡面只留角色详情，完整故事走「#角色名故事」
            if (bw.detailStory) merged.detailStory = bw.detailStory;
            // 培养材料：Bwiki 带图标且口径明确（角色晋阶总计 + 技能/行迹晋阶），
            // 比 nanoka 的合计更好用
            if (Array.isArray(bw.materials) && bw.materials.length) merged.materials = bw.materials;
            // 卡池信息 + 顶部徽章（稀有度/命途/属性/称号/身份/CV…），和原神卡对齐
            if (bw.gacha) merged.gacha = bw.gacha;
            if (Array.isArray(bw.badges) && bw.badges.length) merged.badges = bw.badges;
            // 光锥/遗器推荐：米游社 sr_wiki 的攻略模块，需要 角色名 → content_id 映射
            const cid = this.srContentId(name);
            if (cid) {
              const g2 = await fetchSrGuide(cid).catch(() => null);
              if (g2?.lightcones?.length || g2?.relics?.length) merged.srGuide = g2;
            }
            logger.debug?.(`[xhh][bwiki_sr] ${name} 技能${merged.skills?.length} 星魂${merged.ranks?.length} 成长${merged.growth?.length}`);
            return merged;
        } catch (err) {
            logger.debug?.(`[xhh][bwiki_sr] ${name} 异常，保留 nanoka: ${err?.message}`);
            return view;
        }
    }

  async sr_role_pictures(e, data) {
    const userinfo = data.content.rpg_new_tmp_content?.base?.userInfo;
    const modules = data.content.rpg_new_tmp_content?.modules;
    let text = JSON.parse(data.content.ext);
    text = JSON.parse(text.c_18.filter.text);
    let attribute, fate, rarity;
    text.map(v => {
      if (v.includes('属性')) {
        attribute = v.replace(/属性\//, '');
      }
      if (v.includes('命途')) {
        fate = v.replace(/命途\//, '');
      }
      if (v.includes('星级')) {
        rarity = v.replace(/星级\//, '');
      }
    });
    let character,
      character_material,
      attr = [];
    if (modules) {
      modules.forEach(module => {
        if (module.name === '角色信息') {
          character = JSON.parse(module.components[0].data).list;
        }
        if (module.name === '角色晋阶') {
          character_material = JSON.parse(module.components[0].data).list[0]
            .materials;
        }
      });
      character.forEach(v => {
        attr.push({
          key: v.rightKey,
          value: v.rightValue,
        });
      });
    } else {
      const js = JSON.parse(
        fs.readFileSync(
          `./plugins/miao-plugin/resources/meta-sr/character/${data.content.title}/data.json`,
          'utf-8'
        )
      );
      attr.push({ key: '阵营', value: js.allegiance });
      attr.push({ key: '命途/属性', value: fate + '/' + attribute });
      attr.push({ key: '中文cv', value: js.cncv });
    }
    data = {
      name: userinfo?.name || data.content.title,
      //级
      star: userinfo?.rarity || rarity == '五星' ? 5 : 4,
      //属性
      attribute: attribute,
      //命途
      fate: fate,
      //封面链接
      img:
        userinfo?.figurePath ||
        `../../../../../plugins/miao-plugin/resources/meta-sr/character/${data.content.title}/imgs/splash.webp`,
      //角色标签
      attr: attr,
      attr_: userinfo ? true : false,
      //突破材料(另一个排版没有,懒得写了)
      material: character_material,
    };
    render('wiki/sr_role', data, { e, ret: true });
  }

  //原神角色
  async gs_role_pictures(e, data) {
    if (!data?.page?.modules?.length) {
        logger.debug?.(`[xhh][图鉴] 角色详情页结构缺失（page=${data?.page === null ? 'null' : '无'}），跳过该渲染`);
        return false;
    }
    const modules = data.page.modules;
    const role_attribute = {
      '#378383': '风',
      '#5FACC1': '冰',
      '#6455A6': '雷',
      '#518ABB': '水',
      '#B8584B': '火',
      '#6D9840': '草',
      '#C09257': '岩',
    };
    let character, character_material, character_talent;
    modules.forEach(module => {
      if (module.name === '基础信息') {
        character = JSON.parse(module.components[0].data);
      }
      if (module.name === '角色突破') {
        character_material = JSON.parse(module.components[0].data);
      }
      if (module.name === '天赋') {
        character_talent = JSON.parse(module.components[0].data).list[0].attr
          .row;
      }
    });

    //计算天赋材料：新版米游社 Wiki 的天赋表格字段经常变动，不能再固定取 3/4/11 列
    const talentRows = Array.isArray(character_talent) ? character_talent : [];
    const materialRow =
      talentRows.find(row => Array.isArray(row) && row.some(v => /升级材料/.test(decodeWikiText(v)))) ||
      talentRows[talentRows.length - 1] ||
      [];
    const materialMap = new Map();
    for (const cell of materialRow.slice(2)) {
      for (const item of extractWikiMaterialEntries(cell)) {
        if (!item.name || !item.img) continue;
        const old = materialMap.get(item.name) || { ...item, amount: 0, order: materialMap.size };
        old.amount += item.amount;
        materialMap.set(item.name, old);
      }
    }
    const bookRank = name => {
      if (/教导/.test(name)) return 0;
      if (/指引/.test(name)) return 1;
      if (/哲学/.test(name)) return 2;
      return 9;
    };
    const materialRank = name => {
      if (bookRank(name) < 9) return 0;
      if (/皇冠|智识之冕/.test(name)) return 3;
      // 常见掉落材料放在天赋书后面，周本材料前面
      if (/哨|面具|绘卷|箭簇|鸦印|刀镡|孢|蜜|花蜜|徽记|史莱姆|丘丘|鳍|齿|牙|壳|核|枝|叶|芽|露|尉官|士官|新兵/.test(name)) return 1;
      return 2;
    };
    const talentMaterials = [...materialMap.values()]
      .map(v => ({ ...v, amount: v.amount * 3 }))
      .sort((a, b) => materialRank(a.name) - materialRank(b.name) || bookRank(a.name) - bookRank(b.name) || a.order - b.order);
    let pngs = talentMaterials.map(v => v.img).slice(0, 8);
    let png_names = talentMaterials.map(v => `${v.name} x${v.amount}`).slice(0, 8);
    const weeks = {
      '周一/四/日': ['自由', '繁荣', '浮世', '诤言', '公平', '角逐', '月光'],
      '周二/五/日': ['抗争', '勤劳', '风雅', '巧思', '正义', '焚燔', '乐园'],
      '周三/六/日': ['诗文', '黄金', '天光', '笃行', '秩序', '纷争', '浪迹'],
    };
    let week;
    for (const k in weeks) {
      weeks[k].map(v => {
        if (png_names.some(name => name.includes(v))) week = k;
      });
      if (week) break;
    }
    while (pngs.length < 8) pngs.push('');
    while (png_names.length < 8) png_names.push('');

    //计算成长属性
    let grow = character_material.list[character_material.list.length - 1];
    grow = grow.attr[grow.attr.length - 1];
    grow.value = grow.value[0].replace(/<p>(.*)<\/p>/, '$1').trim();
    if (grow.key == '暴击伤害') {
      grow.value = '38.4%';
    } else if (grow.key == '暴击率') {
      grow.value = '19.2%';
    }
    character_material = character_material.list[0].materials;
    data = {
      name: character.name,
      //级
      star: character.star,
      //元素标志
      attribute: role_attribute[character.role_attribute],
      //封面链接
      img: character.avatar_pc,
      //角色标签
      attr: character.attr,
      //突破材料
      material: character_material,
      //成长属性
      grow: grow.key + ' ' + grow.value,
      //天赋材料图片
      pngs: pngs,
      //天赋材料
      png_names: png_names,
      //天赋材料周几
      week: week,
    };
    render('wiki/gs_role', data, { e, ret: true });
  }

  //原神武器（Bwiki 词条页优先，正式服模式）
  async gs_wq_bwiki_pictures(e, name) {
    let item = null;
    try {
      item = await fetchGsBwikiItem(name, 'wq');
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${name} 武器词条抓取异常: ${err?.message}`);
      return false;
    }
    if (!item) return false;
    // 模板用 starList 渲染星级 ★，解析结果里只有 stars 数字，这里补成数组
    const view = {
      ...item,
      starList: Array.from({ length: Number(item.stars) || 0 }),
    };
    return render('wiki/gs_item_bwiki', view, { e, ret: true });
  }

  // 星铁光锥/遗器（Bwiki 词条页优先，正式服模式）。
  // 列表层提供名字/命途/星级/图标，词条层提供技能/面板/故事，两者合并后渲染。
  async sr_item_bwiki_pictures(e, name, type = 'gz') {
    const fetcher = type === 'gz' ? fetchSrLcList : fetchSrRelicList;
    const metaList = await fetcher().catch(() => null);
    const meta = (metaList || []).find(x => nmKey(x.name) === nmKey(name));
    let detail = null;
    try {
      detail = await fetchSrBwikiItem(name, type);
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_sr] ${name} 词条抓取异常: ${err?.message}`);
    }
    if (!detail && !meta) return false;
    const view = {
      ...(detail || {}),
      name: meta?.name || name,
      icon: meta?.icon || detail?.pageIcon || detail?.icon || '',
      path: meta?.path || '',
      ji: meta?.ji || '',
      version: meta?.version || detail?.version || '',
      intro: detail?.desc || '',
    };
    return render('wiki/sr_item_bwiki', view, { e, ret: true });
  }

  // 星铁遗器（Bwiki 词条页优先，正式服模式）。套装/散件/二四件套/推荐角色
  // 均来自词条层，用 buildRelicView 归一后渲染共用的 relic_bwiki 模板。
  async sr_relic_bwiki_pictures(e, name) {
    let detail = null;
    try {
      detail = await fetchSrBwikiItem(name, 'yq');
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_sr] ${name} 遗器词条抓取异常: ${err?.message}`);
      return false;
    }
    if (!detail) return false;
    const setIcon = detail.pageIcon || detail.setIcons?.[0] || '';
    const view = buildRelicView({
      game: 'sr',
      name,
      base: { ...detail, icon: setIcon },
      art: {
        setIcon,
        pieceIcons: detail.pieceIcons || [],
        agents: detail.agents || [],
        /* 星铁的推荐理由按注释来自 Bwiki「遗器说明」小节（parseSrBwikiItem 存进 desc）：
           推荐角色小节只有头像、没有理由，遗器说明就是星铁版的「推荐理由」
           （见 relic_view.js 顶部注释）。故事区走 origin（遗器来历），不会重复。 */
        reason: detail.desc || '',
      },
      storyTitle: '遗器来历',
    });
    return render('wiki/relic_bwiki', view, { e, ret: true });
  }

  // 绝区零音擎（Bwiki 词条页优先，正式服模式）
  async zzz_wq_bwiki_pictures(e, name) {
    let d = null;
    try {
      d = await fetchZzzBwikiWeapon(name);
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_zzz] ${name} 音擎词条抓取异常: ${err?.message}`);
      return false;
    }
    if (!d) return false;
    // 卡面方图：音擎页没有「音擎图标-名.png」这类 alt（实测深海访客页只有
    // 武器立绘/调频立绘），fetchZzzBwikiWeapon 的 icon 提取会落空。改从官方音擎
    // 列表按名字取方图，与邦布 entryId 同一匹配模式。
    let icon = d.icon || '';
    if (!icon) {
      try {
        const list = await mys.zzz_official_list('wq');
        const key = v => String(v || '').replace(/[\s·・]/g, '');
        const hit = (list || []).find(v => key(v.title) === key(name));
        if (hit?.icon) icon = hit.icon;
      } catch (err) {
        logger.debug?.(`[xhh][bwiki_zzz] ${name} 官方音擎列表匹配失败: ${err?.message}`);
      }
    }
    return render('wiki/zzz_wq_bwiki', { ...d, name, icon }, { e, ret: true });
  }

  // 绝区零驱动盘的 nanoka 兜底视图：Bwiki 抓不到（限流熔断 / 词条缺失）时用，
  // 把 nanoka 的字段映射成与 Bwiki 词条同构的视图，仍渲染新版卡 zzz_syw_bwiki
  // —— 作者要求「只要新卡」，不回落旧模板 wiki/zzz_syw。
  // nanoka 驱动盘详情只有 id/name/icon/desc2/desc4/story，
  // 缺稀有度/版本/获取途径/TAG，这些留空，模板按 {{if}} 不渲染。
  async zzz_syw_nanoka_view(name) {
    try {
      const ret = await mys.data(name, 'syw', false, true);
      if (!ret?.id) return null;
      const data = await mys.detail(ret.id, false, true);
      const c = data?.content || {};
      let set2 = c.desc2 || '', set4 = c.desc4 || '';
      /* 米游社官方那一级的套装效果在 ext.c_46.table.list（key=2 / 4），
         和 nanoka 的 desc2/desc4 **字段名不同**，以前没做映射 ——
         于是 nanoka 冷却、整份切到官方源时，驱动盘只剩名字、套装效果全空
         （zzz_syw_pictures 的注释也记着这个坑）。这里补上映射，
         让官方源同样能填满新版卡的二/四件套。 */
      if (!set2 && !set4) {
        try {
          const list = await mys.zzz_official_list('syw');
          const key = v => String(v || '').replace(/[\s·・]/g, '');
          const hit = (list || []).find(v => key(v.title) === key(name));
          const ext = typeof hit?.ext === 'string' ? JSON.parse(hit.ext || '{}') : (hit?.ext || {});
          for (const r of (((ext.c_46 || ext).table || {}).list || [])) {
            const k = String(r?.key || '');
            if (/^2/.test(k) && !set2) set2 = r?.value || '';
            else if (/^4/.test(k) && !set4) set4 = r?.value || '';
          }
        } catch (_) { }
      }
      if (!c.name && !set2) return null;
      return {
        icon: mys.zzzSuitIcon?.(c.icon) || '',
        set2: this.zzzRichText(set2),
        set4: this.zzzRichText(set4),
        desc: this.zzzCleanText(c.story || '', 200),
        stories: [],
      };
    } catch (_) {
      return null;
    }
  }

  // 绝区零驱动盘（Bwiki 词条页优先，正式服模式）
  async zzz_syw_bwiki_pictures(e, name) {
    let d = null;
    try {
      d = await fetchZzzBwikiDisc(name);
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_zzz] ${name} 驱动盘词条抓取异常: ${err?.message}`);
    }
    /* Bwiki 抓不到时**不回退旧模板**：换 nanoka 数据源取 2/4 件套与描述，
       仍出新版卡（作者要求「只要新卡」）。nanoka 也没有才交给外层回落。 */
    if (!d) d = await this.zzz_syw_nanoka_view(name);
    if (!d) return false;
    /* 推荐代理人按注释约定走米游社词条页的「推荐角色 / 推荐理由」（zzz_disc_agents.js，
       官方原文且带理由）。米游社与 Bwiki 编号体系不同，entryId 只能按名字
       从官方驱动盘列表匹配 —— 与邦布取 entryId 同一模式。 */
    try {
      const list = await mys.zzz_official_list('syw');
      const key = v => String(v || '').replace(/[\s·・]/g, '');
      const hit = (list || []).find(v => key(v.title) === key(name));
      const entryId = hit?.content_id || '';
      const ag = await zzzDiscAgents(name, entryId);
      if (ag.length) d.agents = ag;
      const parts = await mihoyoDiscParts('zzz', entryId);
      if (parts.length) d.parts = parts;
    } catch (_) { /* 官方数据取不到不影响出卡 */ }
    return render('wiki/zzz_syw_bwiki', { ...d, name }, { e, ret: true });
  }

  // 绝区零角色（正式服模式：米游社百科 + Bwiki 徽章/属性/攻略合并，逻辑在 fetchZzzRoleCard）
  async zzz_bwiki_role_pictures(e, name) {
    let card = null;
    try {
      card = await fetchZzzRoleCard(name);
    } catch (err) {
      logger.debug?.(`[xhh][zzz_role] ${name} 角色卡抓取异常: ${err?.message}`);
      return false;
    }
    if (!card) return false;
    return render('wiki/zzz_role_nk', card, { e, ret: true });
  }

  // 绝区零邦布（正式服模式：Bwiki 词条 + 米游社基础属性/搭配组合，buildBangbooView 归一）。
  // 米游社与 Bwiki 编号体系不同，entryId 只能按名字从官方邦布列表匹配。
  async zzz_bangboo_bwiki_pictures(e, name) {
    let bw = null;
    try {
      bw = await fetchZzzBwikiBangboo(name);
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_zzz] ${name} 邦布词条抓取异常: ${err?.message}`);
    }
    let entryId = '';
    let icon = bw?.icon || '';
    try {
      const list = await mys.zzz_official_list('yq');
      const key = v => String(v || '').replace(/[\s·・]/g, '');
      const hit = (list || []).find(v => key(v.title) === key(name));
      if (hit) { entryId = hit.content_id; icon = icon || hit.icon || ''; }
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_zzz] ${name} 官方邦布列表匹配失败: ${err?.message}`);
    }
    if (!bw && !entryId) return false;
    let my = { stats: [], talents: [], teams: [] };
    if (entryId) {
      try { my = await fetchMihoyoBangboo(entryId); } catch (err) { my = { stats: [], talents: [], teams: [] }; }
    }
    const view = buildBangbooView({ bw: bw || {}, my, name, icon, entryId });
    return render('wiki/zzz_yq_bwiki', view, { e, ret: true });
  }

  // 原神圣遗物（Bwiki 词条页优先，正式服模式）。二/四件套、故事、推荐角色来自词条层，
  // 散件图用 extractRelicArt 从词条页 HTML 按「生之花/死之羽…」命名规则抽取。
  async gs_syw_bwiki_pictures(e, name) {
    let detail = null;
    try {
      detail = await fetchGsBwikiItem(name, 'syw');
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${name} 圣遗物词条抓取异常: ${err?.message}`);
      return false;
    }
    if (!detail) return this.gs_syw_fallback_pictures(e, name);
    const art = { setIcon: detail.icon || '', pieceIcons: [], agents: [] };
    /* 推荐角色按 relic_view.js 里那套约定：原神走米游社词条页的「搭配推荐」
       （表头 [角色名称, 推荐原因, 词缀搭配]，mihoyoItemAgents 已认），
       官方写了就用官方的 —— 带推荐原因，且是官方原文。
       Bwiki 那份是编辑者观点（页面自带「以下内容可能存在主观性」声明），
       只在官方没写时兜底。 */
    let official = [];
    try {
      const entryId = await mihoyoEntryId('gs', name);
      if (entryId) official = await mihoyoItemAgents('gs', entryId);
    } catch (_) { /* 官方推荐取不到不影响出卡 */ }
    try {
      const html = await fetchGsBwikiItemHtml(name);
      if (html) {
        const extracted = extractRelicArt(html, 'gs', name);
        art.setIcon = extracted.setIcon || art.setIcon;
        art.pieceIcons = extracted.pieceIcons || [];
        if (!official.length) {
          // 官方没写推荐才用 Bwiki：先带推荐说明的精选，再补块内头像（按名字去重）
          art.agents = [...(detail.agents || [])];
          const have = new Set(art.agents.map(a => a.name));
          for (const a of extracted.agents || []) {
            if (have.has(a.name)) continue;
            art.agents.push(a);
            have.add(a.name);
          }
        }
      }
    } catch (_) { /* 散件图取不到不影响出卡 */ }
    if (official.length) art.agents = official;
    else if (!art.agents.length) art.agents = detail.agents || [];
    const view = buildRelicView({
      game: 'gs',
      name,
      base: { ...detail, ji: detail.stars ? `${detail.stars}星` : '' },
      art,
      storyTitle: '圣遗物故事',
    });
    return render('wiki/relic_bwiki', view, { e, ret: true });
  }

  // 原神圣遗物兜底：Bwiki 未收录的新套装（实测「绝缘之帷」ys/sr 站搜索均为 0 条），
  // 用 nanoka/米游社列表 ext 里的二/四件套文本出新版卡，不再回落旧版单栏模板。
  async gs_syw_fallback_pictures(e, name) {
    let item = null;
    try {
      const data = await mys.data(name, 'syw', false, false);
      if (Array.isArray(data)) item = data.find(v => v.title === name);
    } catch (err) {
      logger.debug?.(`[xhh][bwiki_gs] ${name} 圣遗物列表匹配失败: ${err?.message}`);
      return false;
    }
    if (!item) return false;
    let set2 = '', set4 = '';
    try {
      const box = JSON.parse(item.ext || '{}');
      for (const r of (box.c_218?.table?.list || [])) {
        if (/^2件套/.test(r.key || '')) set2 = r.value || '';
        else if (/^4件套/.test(r.key || '')) set4 = r.value || '';
      }
    } catch (_) {}
    if (!set2 && !set4) return false;
    const view = buildRelicView({
      game: 'gs',
      name,
      base: { set2, set4, icon: item.icon || '' },
      art: { setIcon: item.icon || '', pieceIcons: [], agents: [] },
      storyTitle: '圣遗物故事',
    });
    return render('wiki/relic_bwiki', view, { e, ret: true });
  }

  //原神武器
  async gs_wq_pictures(e, data) {
    /* 米游社官方兜底在查不到时返回 { page: null }（日志里 13:44 的
       TypeError: Cannot read properties of null (reading 'page') 就是这里抛的，
       未捕获异常会把整条消息吞掉，群里表现为「发了图鉴没反应/内容不全）。
       详情取不到就交回调用方走别的渲染路径，不要在这里崩。 */
    if (!data?.page?.modules?.length) {
        logger.debug?.(`[xhh][图鉴] 武器详情页结构缺失（page=${data?.page === null ? 'null' : '无'}），跳过该渲染`);
        return false;
    }
    const modules = data.page.modules;
    let wq, description, numeric_value;
    modules.forEach((v, i) => {
      if (i == 0) wq = JSON.parse(v.components[0].data);
      if (v.name == '装备描述') description = JSON.parse(v.components[0].data);
      if (v.name == '成长数值')
        numeric_value = JSON.parse(v.components[0].data).list;
    });
    const rich_text = description.rich_text;
    description.attr.map((v, i, arr) => {
      arr[i].value = v.value[0];
    });
    const attr = description.attr;
    //材料
    const materials = numeric_value[0].materials;
    //数值
    const numeric_ = numeric_value[numeric_value.length - 1].attr[0].value[0];
    //如果喵有图就调用
    // const path_img = this.getpath(wq.name)

    const arr = numeric_
      .match(/<p>(.*?)<\/p>/g)
      .map(m => m.replace(/<p>|<\/p>/g, ''));
    const atk = arr[0].replace(/基础攻击力/g, '').replace(/:|：/g, '')

    const attr_ = {
      key: arr[1].split(/[:：]/)[0],
      value: arr[1].split(/[:：]/)[1],
    };
    //材料周几
    const weeks = {
      '周一/四/日': [
        '高塔孤王',
        '孤云寒林',
        '远海夷地',
        '谧林涓露',
        '悠古弦音',
        '贡祭炽心',
        '奇巧秘器'
      ],
      '周二/五/日': [
        '凛风奔狼',
        '雾海云间',
        '鸣神御灵',
        '绿洲花园',
        '纯圣露滴',
        '谵妄圣主',
        '长夜燧火'
      ],
      '周三/六/日': [
        '狮牙斗士',
        '漆黑陨铁',
        '今昔剧画',
        '烈日威权',
        '无垢之海',
        '神合秘烟',
        '终北遗嗣'
      ],
    };
    let week;
    for (const k in weeks) {
      weeks[k].map(v => {
        if (materials[0].nickname.includes(v)) week = k;
      });
      if (week) break;
    }
    data = {
      name: wq.name,
      type: wq.category,
      //级
      star: wq.star + '星',
      //图片
      img: wq.image,
      rich_text,
      attr,
      materials,
      // path_img,
      //基础攻击力
      atk,
      //武器副属性
      attr_,
      week,
    };
    render('wiki/wq', data, { e, ret: true });
  }

  //星铁光锥
  async sr_gz_pictures(e, data) {
    let content = data.content.contents[0].text;
    const name = data.content.title;
    let grow = content.match(/80级<\/td>(.*?)<\/table>/g)[0].match(/\d+/g);
    let material = content.match(/晋阶材料(.*)信用点/g)[0];
    const rawHtml = content.match(
      /<img src=(.*?)基础介绍(.*?)命途(.*?)稀有度(.*?)技能(.*?)光锥描述(.*?)<img/g
    );
    const cn = extractChineseWords(material);
    material = extractUniqueHttpsLinks(material);
    let mat = [0, 6, 12, 2, 5, 11, 1].map(index => material[index]); //重新排序，提取
    if (cn[2] === cn[5])
      mat = [0, 5, 11, 3, 6, 12, 1].map(index => material[index]); //另一种排版
    let mat_num = [20, 20, 14, 4, 12, 15, '89.3w'];
    content = extractHonkaiStarRailData(rawHtml[0]);
    content.jineng[1] = content.jineng[1].replace(
      /【([\d.%/]+)】/g,
      '<p class="lan">【$1】</p>'
    );
    if (content.rarity == '4星') mat_num = [15, 15, 12, 3, 9, 12, '70.7w'];
    let miaoshu = '';
    const descMatch = rawHtml[0].match(/光锥描述(.*?)<img/);
    if (descMatch) {
      miaoshu = descMatch[1]
        .replace(/<br\s*\/?\>/g, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    data = {
      name,
      ...content,
      mingtu: content.fate,
      xiyoudu: content.rarity,
      miaoshu,
      grow,
      mat,
      mat_num,
    };
    render('wiki/gz', data, { e, ret: true });
  }

  // 星铁光锥 nanoka 兜底渲染（Bwiki 限流/缺页时走 detail() 的 nanoka 回退）
  // nanoka 数据结构：content = { id, name, rarity, base_type, refinements, stats, desc, itemMap, lightconeMap, relicsetMap }
  // 与 Bwiki HTML 结构完全不同，单独适配成 wiki/gz 模板字段。
  async sr_gz_nanoka_pictures(e, data) {
    const c = data?.content || {};
    const srRarityCn = r => {
      const m = /(\d+)\s*$/.exec(String(r || ''));
      const n = m ? Number(m[1]) : 0;
      return n === 5 ? '5星' : n === 4 ? '4星' : n === 3 ? '3星' : n === 2 ? '2星' : n === 1 ? '1星' : '';
    };
    const srPathCn = {
      Knight: '存护', Rogue: '巡猎', Mage: '智识', Warlock: '虚无',
      Warrior: '毁灭', Priest: '丰饶', Shaman: '同谐',
      Memory: '记忆', Elation: '欢愉'
    };
    const itemIconUrl = raw => {
      const num = (String(raw).match(/(\d+)\.[a-z0-9]+$/i) || [])[1] || '';
      return num ? `https://static.nanoka.cc/assets/hsr/itemfigures/${num}.webp` : '';
    };
    const refinements = c.refinements || {};
    const levels = refinements.level || {};
    const maxLv = Math.max(0, ...Object.keys(levels).map(Number));
    const params = levels[String(maxLv)]?.param_list || [];
    let skillDesc = String(refinements.desc || '')
      .replace(/<color=(#[0-9a-fA-F]+)>/g, '<span style="color:$1">')
      .replace(/<\/color>/g, '</span>')
      .replace(/<unbreak>/g, '')
      .replace(/<\/unbreak>/g, '');
    skillDesc = skillDesc.replace(/#(\d+)\[i\]/g, (m, n) => {
      const idx = Number(n) - 1;
      const v = params[idx];
      if (v === undefined || v === null) return m;
      if (v < 1 && v > 0) return `${Math.round(v * 100)}%`;
      return String(v);
    });
    // 80 级属性：stats 按 promotion 升序，最后一段即满级
    const stats = (c.stats || []).slice().sort((a, b) => (a.promotion || 0) - (b.promotion || 0));
    const maxStat = stats[stats.length - 1] || {};
    const grow = ['', maxStat.base_hp || 0, maxStat.base_attack || 0, maxStat.base_defence || 0];
    // 晋阶材料：按 item_id 汇总，最后一格放信用点
    const materialCounts = {};
    let totalCredits = 0;
    for (const s of stats) {
      for (const cost of s.promotion_cost_list || []) {
        if (cost.item_id === 2) {
          totalCredits += cost.item_num || 0;
        } else {
          materialCounts[cost.item_id] = Math.max(materialCounts[cost.item_id] || 0, cost.item_num || 0);
        }
      }
    }
    const itemMap = c.itemMap || {};
    const matIds = Object.keys(materialCounts).sort((a, b) => Number(a) - Number(b));
    const mat = [];
    const mat_num = [];
    for (const id of matIds) {
      const item = itemMap[id];
      const icon = item?.item_figure_icon_path ? itemIconUrl(item.item_figure_icon_path) : '';
      if (icon) {
        mat.push(icon);
        mat_num.push(materialCounts[id]);
      }
    }
    // 固定补到 6 个材料 + 1 个信用点，避免模板 7 格越界
    while (mat.length < 6) {
      mat.push('');
      mat_num.push('');
    }
    const creditIcon = itemMap['2']?.item_figure_icon_path ? itemIconUrl(itemMap['2'].item_figure_icon_path) : '';
    mat.push(creditIcon);
    mat_num.push(totalCredits > 0 ? `${(totalCredits / 10000).toFixed(totalCredits % 10000 === 0 ? 0 : 1)}w` : '');
    const view = {
      name: c.name,
      mingtu: srPathCn[c.base_type] || c.base_type || '',
      xiyoudu: srRarityCn(c.rarity),
      img: c.id ? `https://static.nanoka.cc/assets/hsr/lightconemaxfigures/${c.id}.webp` : '',
      grow,
      jineng: ['', skillDesc],
      miaoshu: c.desc || '',
      mat,
      mat_num
    };
    render('wiki/gz', view, { e, ret: true });
  }

  /*
    getpath(name) {
        let path = './plugins/miao-plugin/resources/meta-gs/weapon/'
        const path_arr = fs.readdirSync(path).filter(file => {
            try {
                return fs.lstatSync(`${path}/${file}`).isDirectory();
            } catch {
                return false;
            }
        })
        let _path = false
        path_arr.map(v => {
            const path_ = path + v + '/' + name + '/gacha.webp'
            if (fs.existsSync(path_)) return _path = path_
})
        return _path
    }
*/
// 崩坏3角色专武/专属圣痕快捷查询
  async bh3ExclusiveEquip(e, rawName = '') {
    const wantStigma = /(专属圣痕|专属套|毕业圣痕|圣痕套)/.test(rawName);
    const wantWeapon = /(专武|专属武器)/.test(rawName);
    let roleQuery = String(rawName || '')
      .replace(/专属武器|专武|专属圣痕|专属套|毕业圣痕|圣痕套/g, '')
      .replace(/图鉴/g, '')
      .trim();
    if (!roleQuery || (!wantWeapon && !wantStigma)) return false;

    const roleName = this.resolveBh3RoleAlias(roleQuery);
    if (!roleName) return false;
    const detail = await this.getBh3RoleDetail(roleName);
    if (!detail) return false;
    const equips = this.extractBh3ExclusiveEquips(detail);
    const target = wantStigma ? equips.stigma : equips.weapon;
    if (!target) {
      await e.reply(`未找到「${roleName}」的${wantStigma ? '专属圣痕' : '专武'}信息，建议直接发送具体装备名图鉴。`);
      return true;
    }

    const names = Array.isArray(target) ? target : [target];
    for (const name of names) {
      if (!name) continue;
      const ok = wantStigma
        ? await this.syw_yiqi(e, name, false, false, true, roleName)
        : await this.weapon(e, name, false, false, true, roleName);
      if (ok) return true;
    }
    await e.reply(`已识别「${roleName}」${wantStigma ? '专属圣痕' : '专武'}：${names.filter(Boolean).join(' / ')}，但图鉴别名暂未命中。可以直接用完整装备名查询。`);
    return true;
  }

  resolveBh3RoleAlias(name = '') {
    const roleNames = yaml.get('./plugins/xhh/system/default/bh3_js_names.yaml') || {};
    if (roleNames[name]) return name;
    const clean = String(name || '').replace(/[\s·・!！♪♥☆★「」『』:：-]/g, '').toLowerCase();
    let first = '';
    for (const [role, aliases] of Object.entries(roleNames)) {
      const list = [role, ...(Array.isArray(aliases) ? aliases : [])];
      for (const alias of list) {
        const a = String(alias || '').replace(/[\s·・!！♪♥☆★「」『』:：-]/g, '').toLowerCase();
        if (!a) continue;
        if (a === clean) return role;
        if (!first && (a.includes(clean) || clean.includes(a))) first = role;
      }
    }
    return first;
  }

  async getBh3RoleDetail(roleName = '') {
    try {
      const ret = await mys.data(roleName, 'js', false, false, true);
      const id = Array.isArray(ret) ? ret.find(v => v?.title === roleName)?.id || ret[0]?.id : ret?.id;
      if (!id) return null;
      return await mys.detail(id, false, false, true);
    } catch (err) {
      if (config().debug) logger.mark(`[xhh] BH3专属装备获取角色详情失败: ${roleName} ${err?.message || err}`);
      return null;
    }
  }

  extractBh3ExclusiveEquips(data = {}) {
    const content = data.content || {};
    const parts = [];
    for (const section of content.contents || []) {
      const text = String(section.text || '');
      const matches = text.matchAll(/data-data="([^"]+)"/g);
      for (const match of matches) {
        try {
          const arr = JSON.parse(decodeURIComponent(match[1]));
          if (Array.isArray(arr)) parts.push(...arr);
        } catch (_) {}
      }
    }
    const equipPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'equipmentRecommendation')?.data || {};
    const groups = equipPart.equipment || [];
    const all = [];
    for (const group of groups) {
      for (const eq of group.equips || []) {
        const title = String(eq.title || eq.name || '').trim();
        if (title) all.push(title);
      }
    }
    const cleanName = (name = '') => String(name)
      .replace(/\((上|中|下)\)|（(上|中|下)）|·(上|中|下)$|-(上|中|下)$/g, '')
      .trim();
    const isStigma = name => /(圣痕|上\)|中\)|下\)|（上）|（中）|（下）|·上|·中|·下|-上|-中|-下)/.test(name) || this.hasBh3StigmaName(cleanName(name));
    const weapon = all.find(name => !isStigma(name));
    const stigmaNames = [...new Set(all.filter(isStigma).map(cleanName).filter(Boolean))];
    return { weapon, stigma: stigmaNames[0] || '' };
  }

  hasBh3StigmaName(name = '') {
    const names = yaml.get('./plugins/xhh/system/default/bh3_syw_names.yaml') || {};
    if (names[name]) return true;
    return Object.values(names).some(list => Array.isArray(list) && list.includes(name));
  }

// 崩坏3角色
  async bh3_role_pictures(e, data) {
    const content = data.content || {};
    const title = content.title;
    const icon = content.icon || '';

    const stripHtml = (text = '') => String(text)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const shortText = (text = '', len = 96) => {
      text = stripHtml(text).replace(/\n{2,}/g, '\n');
      return text.length > len ? `${text.slice(0, len)}…` : text;
    };
    const uniquePush = (list, item, key = 'key') => {
      if (!item || !item[key]) return;
      if (!list.some(v => v[key] === item[key])) list.push(item);
    };
    const parseTmplParts = () => {
      const parts = [];
      for (const section of content.contents || []) {
        const text = String(section.text || '');
        const matches = text.matchAll(/data-data="([^"]+)"/g);
        for (const match of matches) {
          try {
            const arr = JSON.parse(decodeURIComponent(match[1]));
            if (Array.isArray(arr)) parts.push(...arr);
          } catch (err) {
            if (config().debug) logger.mark(`[xhh] BH3 wiki模板解析失败: ${title}`);
          }
        }
      }
      return parts;
    };

    let basic_info = content.basic_info || {};
    try {
      const ext = JSON.parse(content.ext || '{}');
      const filters = JSON.parse(ext.c_18?.filter?.text || '[]');
      for (const item of filters) {
        const [key, value] = item.split('/');
        if (key && value) basic_info[key] = basic_info[key] ? `${basic_info[key]}、${value}` : value;
      }
    } catch (_) {}

    const parts = parseTmplParts();
    const basicPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'basicIntroduction')?.data || {};
    const equipPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'equipmentRecommendation')?.data || {};
    const skillPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'skill')?.data || {};
    const advanceGeneralPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'advanceGeneral')?.data || {};
    const advanceDataPart = parts.find(p => p?.tmplKey === 'valkyrie' && p?.partKey === 'advanceData')?.data || {};

    const introFields = [];
    for (const item of basicPart.mainFields || []) {
      uniquePush(introFields, { key: item.nameL, value: item.valueL });
      uniquePush(introFields, { key: item.nameR, value: item.valueR });
      if (item.nameL && item.valueL && !basic_info[item.nameL]) basic_info[item.nameL] = item.valueL;
      if (item.nameR && item.valueR && !basic_info[item.nameR]) basic_info[item.nameR] = item.valueR;
    }
    const subFields = (basicPart.subFields || [])
      .map(item => ({ key: item.name, value: shortText(item.value, 120) }))
      .filter(item => item.key && item.value);

    const element = basic_info['属性'] || basic_info['角色属性'] || '未知';
    const character_name = basic_info['角色'] || '';
    const rarity = basic_info['初始阶级'] || 'S';
    const type = basic_info['装甲特性'] || basic_info['角色定位'] || '未知';

    const element_icon_map = {
      '物理': 'bh3_物理.png',
      '火伤': 'bh3_火伤.png', '火焰元素': 'bh3_火伤.png', '火焰': 'bh3_火伤.png', '火': 'bh3_火伤.png',
      '冰伤': 'bh3_冰伤.png', '冰冻元素': 'bh3_冰伤.png', '冰冻': 'bh3_冰伤.png', '冰': 'bh3_冰伤.png',
      '雷伤': 'bh3_雷伤.png', '雷电元素': 'bh3_雷伤.png', '雷电': 'bh3_雷伤.png', '雷': 'bh3_雷伤.png',
      // 崩三武器类型 / 状态效果徽章（官方高清，来自 图标SR）
      '双枪': 'bh3_双枪.png', '大剑': 'bh3_大剑.png', '太刀': 'bh3_太刀.png', '拳套': 'bh3_拳套.png',
      '弓箭': 'bh3_弓箭.png', '十字架': 'bh3_十字架.png', '环刃': 'bh3_环刃.png', '链刃': 'bh3_链刃.png',
      '镰刀': 'bh3_镰刀.png', '骑枪': 'bh3_骑枪.png', '机关杖': 'bh3_机关杖.png', '速射弩': 'bh3_速射弩.png',
      '重炮': 'bh3_重炮.png', '火箭锤': 'bh3_火箭锤.png', '梭镖': 'bh3_梭镖.png',
      '冻结': 'bh3_冻结.png', '点燃': 'bh3_点燃.png', '流血': 'bh3_流血.png', '麻痹': 'bh3_麻痹.png',
      '召唤物': 'bh3_召唤物.png', '吸引': 'bh3_吸引.png', '对空': 'bh3_对空.png', '时空': 'bh3_时空.png',
      '治疗': 'bh3_治疗.png', '虚弱': 'bh3_虚弱.png', '脆弱': 'bh3_脆弱.png', '高频': 'bh3_高频.png',
      '重击': 'bh3_重击.png', '驱动核心': 'bh3_驱动核心.png', '爆发': 'bh3_爆发.png', '眩晕': 'bh3_眩晕.png',
      '生物': 'bh3_生物.png',
      '量子': 'bh3_量子.png',
      '虚数': 'bh3_虚数.png',
      '异能': 'bh3_异能.png',
      '机械': 'bh3_机械.png',
      '星尘': 'bh3_星尘.png',
      '星辰': 'bh3_星尘.png',
      '星尘属性': 'bh3_星尘.png',
      '星辰属性': 'bh3_星尘.png',
      '世界之星': 'xzh_世界之星.png',
      '无存之仪': 'xzh_无存之仪.png',
      '命运之轮': 'xzh_命运之轮.png',
      '升变之理': 'xzh_升变之理.png',
      '天衍之杯': 'xzh_天衍之杯.png',
      '界域共鸣': 'xzh_界域共鸣.png',
      '万有之星': 'xzh_万有之星.png',
      '星影偕行': 'xzh_星影偕行.png',
      '天渊易位': 'xzh_天渊易位.png',
      '复盈相生': 'xzh_复盈相生.png',
      '星之环特性': '星环特性.svg',
      '星之环分野': '星环分野.svg',
      '角色定位': '定位.svg',
      '输出': '定位.svg',
      '辅助': '定位.svg'
    };

    const img = (basicPart.avatar || icon || '').startsWith('http') ? (basicPart.avatar || icon) : `https://api-takumi-static.mihoyo.com/hoyowiki/bh3_wiki${basicPart.avatar || icon}`;
    const element_icon = element_icon_map[element] || (String(element).includes('星') ? 'bh3_星尘.png' : 'bh3_物理.svg');
    const getAttrIcon = (key = '', value = '') => {
      const text = `${key} ${value}`;
      for (const [k, icon] of Object.entries(element_icon_map)) {
        if (text.includes(k)) return icon;
      }
      if (text.includes('星')) return 'bh3_星尘.png';
      return '';
    };

    for (const item of introFields) item.icon = getAttrIcon(item.key, item.value);
    for (const item of subFields) item.icon = getAttrIcon(item.key, item.value);

    // 部分崩三角色的「武器类型」只存在于 basicIntroduction.mainFields，
    // 不一定会出现在 content.basic_info；显式从主字段兜底，避免角色图鉴漏显示。
    const weaponTypeField = [
      ...introFields,
      ...(basicPart.mainFields || []).flatMap(item => [
        { key: item.nameL, value: item.valueL },
        { key: item.nameR, value: item.valueR }
      ])
    ].find(item => /武器类型|武器/.test(String(item.key || '')) && String(item.value || '').trim());
    if (weaponTypeField && !Object.entries(basic_info).some(([key, value]) =>
      /武器类型|武器/.test(String(key)) && String(value || '').trim()
    )) {
      basic_info['武器类型'] = stripHtml(weaponTypeField.value);
    }

    const starRingText = subFields
      .filter(item => item.key === '星之环')
      .map(item => stripHtml(item.value))
      .join('\n');
    const starRingField = basic_info['星之环分野'] ||
      (starRingText.match(/分野\s*[：:]\s*(.*?)(?=特性\s*[：:]|$)/)?.[1] || '').trim();
    const starRingTraits = String(basic_info['星之环特性'] ||
      (starRingText.match(/特性\s*[：:]\s*(.*?)(?=注\s*[：:]|$)/)?.[1] || ''))
      .split(/[、,，\/]/).map(s => s.trim()).filter(Boolean);
    const starRing = (starRingField || starRingTraits.length)
      ? {
          field: starRingField,
          fieldIcon: starRingField ? getAttrIcon('星之环分野', starRingField) : '',
          traits: starRingTraits.map(t => ({ name: t, icon: getAttrIcon('星之环特性', t) }))
        }
      : null;

    const attr = Object.entries(basic_info)
      .filter(([key, value]) => key && value && key !== '星之环特性' && key !== '星之环分野')
      .map(([key, value]) => ({ key, value, icon: getAttrIcon(key, value) }));

    const hexagon = (basicPart.hexagon || []).map(item => ({
      key: item.key,
      value: Number(item.value || 0),
      level: item.level || ''
    })).filter(item => item.key);

    const equipment = (equipPart.equipment || []).slice(0, 3).map(group => ({
      name: group.name_ || group.name || '推荐装备',
      equips: (group.equips || []).slice(0, 4).map(eq => ({
        title: eq.title || eq.name || '',
        icon: eq.icon || ''
      })).filter(eq => eq.title || eq.icon),
      attackPoint: group.attackPoint,
      functionPoint: group.functionPoint,
      matchingDegree: group.matchingDegree,
      reason: shortText(group.reason, 110)
    })).filter(group => group.equips.length || group.reason);

    const skills = (skillPart.items || []).slice(0, 6).map(item => {
      const first = (item.list || []).find(v => v?.desc || v?.name) || {};
      return {
        name: item.name_ || item.name || first.name || '技能',
        icon: item.img || first.icon || '',
        desc: first.name ? `${first.name}：${shortText(first.desc, 96)}` : shortText(first.desc || item.desc, 96)
      };
    }).filter(item => item.name || item.desc);

    const advance = (advanceGeneralPart.advanceGeneral || []).map(item => {
      const cost = String(item.cost || '').trim();
      return {
        icon: item.icon || '',
        cost,
        costLabel: /^[ABSSS]+$/i.test(cost) ? `晋升至 ${cost}` : `消耗 ${cost || '-'}`,
        desc: shortText(String(item.desc || '').replace(/提高高/g, '提高'), 78)
      };
    }).filter(item => item.desc || item.icon);

    const maxRankData = (advanceDataPart.advanceData || []).slice(-1)[0] || {};
    const maxStats = [
      { key: '生命', value: maxRankData.life },
      { key: '能量', value: maxRankData.energy },
      { key: '攻击', value: maxRankData.attack },
      { key: '防御', value: maxRankData.defense },
      { key: '会心', value: maxRankData.understanding }
    ].filter(item => item.value !== undefined && item.value !== null && item.value !== '');

    data = {
      name: title,
      star: rarity === 'S' ? 5 : 4,
      attribute: element,
      specialty: type,
      specialty_icon: getAttrIcon('装甲特性', type),
      character: character_name,
      summary: content.summary || '',
      img,
      attr,
      starRing,
      introFields,
      subFields,
      hexagon,
      equipment,
      skills,
      advance,
      maxStats,
      attr_icon: element_icon,
      material: []
    };
    return render('wiki/bh3_role', data, { e, ret: true });
  }

  // 崩坏3武器
  async bh3_wq_pictures(e, data, roleName = '') {
    if (!data || !data.content) {
      if (config().debug) logger.mark('[xhh] BH3武器详情数据为空');
      await e.reply(`未获取到武器详情，请稍后重试。`);
      return false;
    }
    const content = data.content;
    const title = content.title || '未知武器';

    const decodeHtml = (text = '') => String(text || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const stripHtml = (text = '') => decodeHtml(text)
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
    const absImg = (url = '') => {
      if (!url) return '';
      if (/^https?:/i.test(url)) return url;
      if (url.startsWith('//')) return `https:${url}`;
      return `https://api-takumi-static.mihoyo.com/hoyowiki/bh3_wiki${url}`;
    };
    const cleanRich = (html = '') => decodeHtml(html)
      .replace(/<span[^>]*data-type="详情"[\s\S]*?<\/span>/g, '')
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, '')
      .replace(/<table[\s\S]*?<\/table>/g, m => m.length > 1600 ? '' : m)
      .replace(/style="[^"]*"/g, '')
      .replace(/class="[^"]*"/g, '')
      .replace(/<p>\s*<\/p>/g, '')
      .trim();
    const parseTmplParts = () => {
      const parts = [];
      for (const section of content.contents || []) {
        const text = String(section.text || '');
        for (const match of text.matchAll(/data-data="([^"]+)"/g)) {
          try {
            const arr = JSON.parse(decodeURIComponent(match[1]));
            if (Array.isArray(arr)) parts.push(...arr);
          } catch (err) {
            if (config().debug) logger.mark(`[xhh] BH3武器模板解析失败: ${title} ${err?.message || err}`);
          }
        }
      }
      return parts;
    };

    const parts = parseTmplParts();
    const weaponPart = parts.find(p => p?.tmplKey === 'weapon');
    const info = weaponPart?.data || {};
    const skillData = parts.find(p => p?.tmplKey === 'weapon' && p?.partKey === 'skill')?.data || {};
    const forgingData = parts.find(p => p?.tmplKey === 'weapon' && p?.partKey === 'forging')?.data || {};
    const materialData = parts.find(p => p?.partKey === 'material')?.data || {};

    let type = '未知';
    let star = info.starValue || 5;
    try {
      const ext = JSON.parse(content.ext || '{}');
      const filters = JSON.parse(ext.c_20?.filter?.text || ext.filter?.text || '[]');
      for (const item of filters) {
        if (String(item).includes('武器类型/')) type = String(item).replace('武器类型/', '');
        if (String(item).includes('武器星级/')) {
          const v = String(item).replace('武器星级/', '');
          if (/超限/.test(v)) star = 6;
          else if (/\d/.test(v)) star = v.match(/\d+/)?.[0] || star;
        }
      }
    } catch (_) {}

    let attr = Array.isArray(info.attr) ? info.attr.map(a => ({ key: a.key, value: stripHtml(a.value) })).filter(a => a.key && a.value) : [];
    if (type !== '未知' && !attr.some(a => a.key === '武器类型')) attr.unshift({ key: '武器类型', value: type });
    if (star && !attr.some(a => a.key === '星级')) attr.unshift({ key: '星级', value: `${star}星` });
    const atk = attr.find(a => /攻击|攻击力/.test(a.key))?.value || (attr.length > 0 ? '-' : '未知');
    const sub = attr.find(a => !/攻击|武器类型|星级/.test(a.key)) || { key: '副属性', value: attr.length > 0 ? '-' : '未知' };

    const skillRows = [
      ...(Array.isArray(skillData.attr) ? skillData.attr : [])
    ].filter(v => v?.key || v?.name);
    let richText = skillRows.map(s => {
      const key = s.key || s.name || '技能';
      const value = cleanRich(s.value || s.desc || '');
      return `<div class="bh3-skill"><h3>${key}</h3><div>${value || '-'}</div></div>`;
    }).join('');
    if (!richText && info.desc) {
      richText = `<div class="bh3-skill"><h3>武器介绍</h3><div>${cleanRich(info.desc)}</div></div>`;
    } else if (info.desc) {
      richText = `<div class="bh3-skill intro"><h3>武器介绍</h3><div>${cleanRich(info.desc)}</div></div>` + richText;
    }
    if (!richText && content.summary) {
      richText = `<div class="bh3-skill"><h3>武器介绍</h3><div>${content.summary}</div></div>`;
    }

    const materialSource = []
      .concat(forgingData.materials || forgingData.attr || [])
      .concat(materialData.materials || materialData.attr || []);
    const materials = materialSource.map(m => ({
      name: stripHtml(m.name || m.key || m.title || m.text || ''),
      icon: absImg(m.icon || m.img || ''),
      count: m.count || m.num || m.value || ''
    })).filter(m => m.name || m.icon);

    let week = 'Wiki收录';
    for (const gm of info.gainMethods || []) {
      if (gm.key === '获取途径' && gm.value) week = stripHtml(gm.value);
    }

    const img = absImg(info.icon || content.icon);
    const view = {
      name: title,
      type,
      star: `${star || 5}星`,
      img,
      rich_text: richText || '<p>暂无武器技能详情，请稍后刷新 Wiki 数据。</p>',
      attr,
      materials,
      atk,
      attr_: { key: sub.key || '副属性', value: sub.value || '未知' },
      week,
      roleName
    };
    return render('wiki/bh3_wq', view, { e, ret: true });
  }

  // 崩坏3圣痕
  async bh3_syw_pictures(e, data, roleName = '') {
    if (!data || !data.content) {
      if (config().debug) logger.mark('[xhh] BH3圣痕详情数据为空');
      await e.reply('未获取到圣痕详情，请稍后重试或使用完整圣痕名称查询。');
      return false;
    }

    const stripHtml = (text = '') => String(text || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<p[^>]*>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s*\n\s*/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    const parseContent = (cnt) => {
      const parts = [];
      for (const section of cnt.contents || []) {
        for (const match of String(section.text || '').matchAll(/data-data="([^"]+)"/g)) {
          try {
            const arr = JSON.parse(decodeURIComponent(match[1]));
            if (Array.isArray(arr)) parts.push(...arr);
          } catch (_) {}
        }
      }
      return {
        main: parts.find(p => p?.tmplKey === 'stigmata' && p?.partKey === 'main')?.data || {},
        role: parts.find(p => p?.tmplKey === 'stigmata' && p?.partKey === 'role')?.data || {},
        basic: parts.find(p => p?.tmplKey === 'stigmata' && p?.partKey === 'basicAttr')?.data || {},
        equip: parts.find(p => p?.tmplKey === 'stigmata' && p?.partKey === 'equipmentRecommendation')?.data || {}
      };
    };

    const absImg = (url = '') => {
      if (!url) return '';
      if (/^https?:/i.test(url)) return url;
      if (url.startsWith('//')) return `https:${url}`;
      return `https://api-takumi-static.mihoyo.com/hoyowiki/bh3_wiki${url}`;
    };

    const extractId = (url = '') => {
      const m = url.match(/\/content\/(\d+)\/detail/);
      return m ? m[1] : null;
    };

    const buildPiece = (cnt) => {
      const parsed = parseContent(cnt);
      const pos = (parsed.main.subFields || []).find(s => s.name === '位置')?.value || '';
      const skillList = (parsed.role.attr || []).map(a => stripHtml(a.value || '')).filter(Boolean);
      const attrList = Array.isArray(parsed.basic.attr) ? parsed.basic.attr.map(a => ({ key: a.key, value: String(a.value ?? '') })) : [];
      const comment = stripHtml(parsed.basic.comment || '');
      return {
        name: cnt.title || '未知',
        position: pos,
        icon: absImg(parsed.main.avatar || cnt.icon),
        skill: skillList.join('\n') || '无',
        attr: attrList,
        comment
      };
    };

    const firstContent = data.content;
    const firstParsed = parseContent(firstContent);
    const firstMain = firstParsed.main;
    const setInfo = (firstMain.subFields || []).find(s => s.name === '所属套装');
    const setName = setInfo?.value || '';
    const relatives = firstMain.relatives || [];
    const equipRec = firstParsed.equip;

    // Collect all piece content_ids: current + relatives
    const ids = [firstContent.id];
    for (const rel of relatives) {
      const rid = extractId(rel.url);
      if (rid && !ids.includes(rid)) ids.push(rid);
    }

    // Fetch all pieces in parallel
    const allData = await Promise.all(ids.map(id => mys.detail(id, false, false, true)));
    const pieces = allData.filter(Boolean).map(d => buildPiece(d.content || d));

    const setDesc = (equipRec.equipment || []).map(g => stripHtml(g.reason || '')).filter(Boolean).join('\n')
      || pieces.map(p => p.comment).filter(Boolean).join('\n')
      || pieces.map(p => p.skill).join('\n');

    data = {
      setName,
      pieces,
      setDesc: setDesc || '无',
      star: 5,
      roleName
    };
    render('wiki/bh3_syw', data, { e, ret: true });
  }

  // 崩坏3人偶/协同者
  // 百科人偶/协同者的正文不在 content/summary 里，而在 content.contents[].text 的
  // data-data 属性（一段 URL 编码的模板 JSON），这里把有信息量的字段抽成行文本。
  parseBh3YqBody(content = {}, title = '') {
    const strip = s => String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const lines = [];
    const seen = new Set();
    const add = (label, v) => {
      if (!v || v === title) return;
      const key = `${label}:${v}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push(`${label}：${v}`);
    };
    const push = (label, val, max = 90) => {
      let v = strip(val);
      if (v.length > max) v = `${v.slice(0, max)}…`;
      add(label, v);
    };
    // 多行内容（如进阶说明）不能走 strip，否则换行会被压成空格
    const pushRaw = (label, arr = [], max = 400) => {
      let v = arr.filter(Boolean).join('\n');
      if (v.length > max) v = `${v.slice(0, max)}…`;
      add(label, v);
    };
    for (const sec of content.contents || []) {
      const m = String(sec.text || '').match(/data-data="([^"]+)"/);
      if (!m) continue;
      let items = [];
      try { items = JSON.parse(decodeURIComponent(m[1])); } catch (_) { continue; }
      for (const it of items) {
        let d = it.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
        switch (it.partKey) {
          case 'basicIntroduction': {
            for (const f of d.mainFields || []) {
              if (f?.nameL) push(f.nameL, f.valueL, 40);
              if (f?.nameR) push(f.nameR, f.valueR, 40);
            }
            for (const f of d.subFields || []) push(f.name || '简介', f.value, 150);
            const hex = (d.hexagon || []).filter(h => h?.key).map(h => `${h.key}${h.level || h.value || ''}`);
            if (hex.length) push('评级', hex.join(' / '), 80);
            break;
          }
          case 'advanceGeneral': {
            const txt = (d.advanceGeneral || [])
              .map(x => `${x.starValue ? `${x.starValue}★ ` : ''}${strip(x.desc)}`)
              .filter(Boolean);
            if (txt.length) pushRaw('进阶', txt, 400);
            break;
          }
          case 'equipmentRecommendation': {
            const names = (d.equipment || [])
              .flatMap(g => (g.equips || []).map(x => x.title || x.name || x.name_ || ''))
              .filter(Boolean);
            if (names.length) push('推荐搭配', names.slice(0, 6).join('、'), 120);
            break;
          }
          case 'gainMethod': {
            // 「协同者与星之环 / 系统说明」是通用系统文案，不是条目本身的信息，跳过
            if (/星之环|系统说明/.test(d.title || '')) break;
            const txt = (d.gainMethod || [])
              .map(x => `${x.key || ''}${x.value ? ` ${strip(x.value)}` : ''}`)
              .filter(Boolean);
            if (txt.length) push(d.title || '获取途径', txt.join('；'), 120);
            break;
          }
          case 'skill': {
            const groups = [].concat(d.equipment || [], d.items || []);
            const names = groups.map(g => g.name_ || g.name || '').filter(Boolean);
            const skills = groups
              .flatMap(g => (g.skills || g.list || []).map(x => x.key || x.name_ || x.name || x.title || ''))
              .filter(Boolean);
            if (names.length) push('技能分类', names.join('、'), 100);
            if (skills.length) push('技能', skills.slice(0, 12).join('、'), 160);
            break;
          }
        }
      }
    }
    return lines;
  }

  async bh3_yq_pictures(e, data, poolType = '') {
    const content = data.content || {};
    const title = content.title;
    // 百科现在直接返回完整 https 图标地址，只有相对路径才需要补前缀，否则会拼成坏链导致裂图
    const rawIcon = String(content.icon || '');
    const icon = /^https?:/i.test(rawIcon) ? rawIcon
      : rawIcon.startsWith('//') ? `https:${rawIcon}`
        : `https://api-takumi-static.mihoyo.com/hoyowiki/bh3_wiki${rawIcon}`;

    // 百科人偶/协同者条目基本没有正文（summary 往往就是标题本身），
    // 从 ext 过滤字段里挖 类型/星级，凑一张有信息量的卡
    let ext = {};
    try { ext = typeof content.ext === 'string' ? JSON.parse(content.ext) : (content.ext || {}); } catch (_) {}
    const tags = [];
    for (const v of Object.values(ext)) {
      let filters = [];
      try { filters = JSON.parse(v?.filter?.text || '[]'); } catch (_) {}
      for (const f of filters) {
        const m = String(f).match(/^(人偶类型|协同者类型|人偶星级|星级)\/(.+)$/);
        if (m) tags.push(`${m[1]}：${m[2]}`);
      }
    }
    tags.unshift(poolType === 'hb' ? '类别：协同者' : '类别：人偶');

    let summary = String(content.summary || '').trim();
    // summary 只是标题或「标题-协同者」时，不当作简介复读
    if (!summary || summary === title || summary.replace(/-?协同者$/, '').trim() === title) summary = '';
    const body = this.parseBh3YqBody(content, title);
    const desc = [...tags, ...body, summary].filter(Boolean).join('\n')
      || [tags.join('　|　'), '百科暂未收录该条目的详细介绍。'].join('\n');

    data = {
      name: title,
      desc,
      icon
    };
    render('wiki/bh3_yq', data, { e, ret: true });

}

}
