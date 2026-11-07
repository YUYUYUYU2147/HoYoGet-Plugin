/**
 * 崩三测试服 Boss 提取。
 *
 * 背景：崩三测试服（csf）的 Boss 属于未公开内容，米游社正式接口不提供，
 * 贴吧也没有集中的测试服 Boss 帖。但 B 站 up 主的测试服实况视频标题里，
 * 经常直接写着当期在测的 Boss（如「测试服v2战场愚之芽47664」「...北风狼3秒」）。
 *
 * 做法：搜 B站崩三测试服相关视频 → 从标题里用 Boss 词库匹配 → 按出现次数排序，
 * 得出「本期测试服正在测哪些 Boss」的近似结论，并附视频链接供核对。
 * 注意：这是从玩家视频标题归纳的，不是官方数据，仅作参考。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { config } from '#HoYoGet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOSS_LIB = path.join(__dirname, 'default', 'bh3_testserver_boss.yaml');
const BILI_SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 默认搜索关键词（可在锅巴覆盖）
const DEFAULT_KEYWORD = '崩坏3 测试服';

// 提取名 → 图标库标准名（boss_icons.json 的 names 用标准全名，标题里多用简称）
// 只映射能确认对应的；对不上就留空显示占位，避免张冠李戴。
const ICON_NAME_ALIAS = {
  '月魂': '辉骑士·月魄',
  '月魄': '辉骑士·月魄',
  '北风狼': '奔狼的领主',
  '殉死': '殉死之兽',
  '梅比乌斯': '逐火十三英桀 梅比乌斯',
  '凯文': '凯文 · 卡斯兰娜',
  '陨冰之律者': '「陨影冰骸」',
  '地藏御魂': '地藏御魂',
  '阿湿波': '阿湿波',
  '空之律者': '空之律者',
  '摩录多': '摩录多',
  '虚树神骸-虚无主义': '虚树神骸-虚无主义',
  '姬麟': '姬麟·黑',
  '赫菲斯托斯': '赫菲斯托斯',
};

export { ICON_NAME_ALIAS };

let bossMapCache = null;
/** 载入 Boss 词库：返回 [{ standard, aliases }]，按别名长度降序（最长优先匹配） */
function loadBossMap() {
  if (bossMapCache) return bossMapCache;
  try {
    const raw = YAML.parse(fs.readFileSync(BOSS_LIB, 'utf8')) || {};
    const list = [];
    for (const [std, aliases] of Object.entries(raw)) {
      if (!Array.isArray(aliases) || !aliases.length) continue;
      list.push({ standard: std, aliases: [...new Set([std, ...aliases])] });
    }
    bossMapCache = list;
  } catch (err) {
    globalThis.logger?.warn?.(`[HoYoGet][testserver_boss] 读取Boss词库失败: ${err?.message || err}`);
    bossMapCache = [];
  }
  return bossMapCache;
}

function biliCookie() {
  try { return String(config()?.bili_ck || '').trim(); } catch { return ''; }
}

function cleanTitle(t) {
  return String(t || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

/** 搜 B站视频（按发布时间倒序） */
async function searchBili(keyword, size = 50) {
  const q = new URLSearchParams({
    search_type: 'video', keyword, page: '1', page_size: String(size), order: 'pubdate',
  });
  const res = await fetch(`${BILI_SEARCH_API}?${q}`, {
    headers: { 'User-Agent': BILI_UA, Referer: 'https://www.bilibili.com/', Cookie: biliCookie() },
  });
  if (!res.ok) return [];
  const j = await res.json();
  if (j.code !== 0) return [];
  return (j.data?.result || []).filter(v => v.bvid).map(v => ({
    bvid: v.bvid,
    title: cleanTitle(v.title),
    author: v.author,
    pubdate: Number(v.pubdate) || 0,
    cover: String(v.pic || '').replace(/^\/\//, 'https://'),
  }));
}

/**
 * 从一批标题里提取 Boss：返回 Map<标准名, { count, aliases, samples[] }>
 * 匹配用「最长别名优先」，同一标题里同一 Boss 只计一次。
 */
function extractBosses(videos) {
  const bossMap = loadBossMap();
  // 所有别名按长度降序，长别名先匹配（避免「量子龙虾」被「龙虾」重复计数）
  const flat = [];
  for (const b of bossMap) for (const a of b.aliases) flat.push({ standard: b.standard, alias: a });
  flat.sort((x, y) => y.alias.length - x.alias.length);

  const result = new Map();
  for (const v of videos) {
    const title = v.title;
    const hit = new Set();
    // 已匹配到的别名所占区间，避免短别名重复切进长别名里
    const consumed = [];
    for (const { standard, alias } of flat) {
      if (hit.has(standard)) continue;
      let from = 0;
      while (true) {
        const idx = title.indexOf(alias, from);
        if (idx < 0) break;
        // 该区间已被更长的别名占用则跳过
        const end = idx + alias.length;
        const overlap = consumed.some(([s, e]) => idx < e && end > s);
        if (!overlap) {
          consumed.push([idx, end]);
          hit.add(standard);
          const cur = result.get(standard) || { count: 0, samples: [] };
          cur.count++;
          if (cur.samples.length < 3) cur.samples.push({ title, bvid: v.bvid, author: v.author, pubdate: v.pubdate, cover: v.cover || '' });
          result.set(standard, cur);
          break;
        }
        from = idx + 1;
      }
    }
  }
  return result;
}

/**
 * 主入口：抓测试服最近视频并提取 Boss。
 * @returns {Promise<{keyword, videos, bosses: Array<{name,count,samples}>, version}>}
 */
export async function getTestserverBosses(keywordOverride = '') {
  const keyword = String(keywordOverride || config()?.bh3_testserver_boss_keyword || DEFAULT_KEYWORD).trim();
  // 多关键词合并，覆盖更全
  const keywords = [keyword, `${keyword} 深渊`, `${keyword} 战场`].filter(Boolean);
  const all = [];
  const seen = new Set();
  for (const kw of keywords) {
    const list = await searchBili(kw, 50).catch(() => []);
    for (const v of list) {
      if (seen.has(v.bvid)) continue;
      seen.add(v.bvid);
      all.push(v);
    }
  }
  // 只保留最近 30 天内、且标题带「测试服/csf/v数字」的视频，尽量聚焦当前测试服
  const RECENT_DAYS = 30;
  const now = Date.now() / 1000;
  const recent = all.filter(v => {
    if (!v.pubdate) return true;
    if (now - v.pubdate > RECENT_DAYS * 86400) return false;
    return /测试服|csf|CSF|测试|v\d|V\d/.test(v.title);
  });
  const pool = recent.length ? recent : all;

  const bossMap = extractBosses(pool);
  const bosses = [...bossMap.entries()]
    .map(([name, v]) => ({ name, count: v.count, samples: v.samples }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // 尝试从标题提取测试服版本号（如 9.2 / V2）
  let version = '';
  const vm = pool.map(v => v.title.match(/[Bb]?(\d+\.\d+)测试服|测试服\s*[Vv]?(\d)|csf\s*[Vv]?(\d)/)).find(Boolean);
  if (vm) version = vm[1] ? `${vm[1]}` : '';

  return { keyword, videos: pool, bosses, version };
}
