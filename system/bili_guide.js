/**
 * B 站攻略视频源。
 *
 * 米游社的战场/乐土/防卫战/危局攻略在社区侧逐渐萎缩（周期玩法，作者难持续产出），
 * 而 B 站对应关键词每天都有新视频。这里作为一个独立补充源：
 *   · 融入现有玩法指令（战场/乐土/防卫战/危局），米游社图之后再补一个 B 站视频
 *   · 默认关闭（B 站视频流量大，由用户自行开启）
 *   · 每次最多发 1 个视频：能下载且小于 dow_size 就直发视频，否则发封面+链接
 */
import { config } from '#HoYoGet';
import bili from './bili.js';

const BILI_SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 玩法 key → 默认搜索关键词（可在锅巴逐项覆盖）
export const BILI_GUIDE_DEFAULTS = {
  zzz_defense: '绝区零 式舆防卫战 攻略',
  zzz_deadly: '绝区零 危局强袭战 攻略',
  bh3_battlefield: '崩坏3 记忆战场 攻略',
  bh3_godwar: '崩坏3 往世乐土 攻略',
  bh3_abyss: '崩坏3 深渊 攻略',
};

/** 从 bili_ck 配置里取 cookie（与 bili.js 共用同一份） */
function biliCookie() {
  try {
    return String(config()?.bili_ck || '').trim();
  } catch {
    return '';
  }
}

/** 去掉 B 站搜索标题里的高亮标签 */
function cleanTitle(t) {
  return String(t || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').trim();
}

/**
 * 搜索 B 站视频，按发布时间倒序取最新若干条。
 * @returns {Promise<Array<{bvid,title,author,mid,pubdate,duration,cover,desc,play}>>}
 */
export async function searchBiliGuide(keyword, size = 10) {
  const q = new URLSearchParams({
    search_type: 'video',
    keyword,
    page: '1',
    page_size: String(size),
    order: 'pubdate', // 按发布时间排序，拿最新
  });
  const res = await fetch(`${BILI_SEARCH_API}?${q}`, {
    headers: {
      'User-Agent': BILI_UA,
      Referer: 'https://www.bilibili.com/',
      Cookie: biliCookie(),
    },
  });
  if (!res.ok) return [];
  const j = await res.json();
  if (j.code !== 0) return [];
  return (j.data?.result || [])
    .filter(v => v.bvid)
    .map(v => ({
      bvid: v.bvid,
      title: cleanTitle(v.title),
      author: v.author,
      mid: v.mid,
      pubdate: Number(v.pubdate) || 0,
      duration: String(v.duration || ''),
      cover: String(v.pic || '').replace(/^\/\//, 'https://'),
      desc: cleanTitle(v.description || '').slice(0, 120),
      play: Number(v.play) || 0,
    }));
}

/**
 * 判断标题是否真的是攻略（排除二创/整活/直播回放等噪音）。
 * 命中「攻略/作业/阵型/满星/打法/教学/解析/一图流」等视为有效。
 */
function isGuideVideoTitle(title) {
  return /攻略|作业|满星|打法|教学|解析|思路|配队|阵容|通关|速通|凹分|一图流|保姆/.test(String(title || ''));
}

/**
 * 为某玩法取一个最合适的 B 站攻略视频。
 * 优先标题含「攻略/满星/打法」等词的、最新的视频。
 * @returns {Promise<object|null>}
 */
export async function pickBiliGuide(key, overrideKeyword = '') {
  const keyword = String(overrideKeyword || config()?.[`bili_guide_${key}`] || BILI_GUIDE_DEFAULTS[key] || '').trim();
  if (!keyword) return null;
  const list = await searchBiliGuide(keyword, 20);
  if (!list.length) return null;
  // 已按发布时间倒序；优先取标题像攻略的，没有则退回最新一条
  const guide = list.find(v => isGuideVideoTitle(v.title));
  return guide || list[0];
}

/**
 * 下载并直发 B 站视频（交给 bili.Download 自己发送）。
 * 注意：Download 内部 finally 会删临时文件，所以不能在外部拿 segment 再发——
 * 必须让它内部 send（vo=false）。成功返回 true。
 */
export async function sendBiliVideo(e, bvid) {
  try {
    // send=false：不加"有其他视频在下载中"的前置回复；vo=false：内部直接发视频
    const ok = await bili.Download(e, bvid, false, null, false);
    return ok === true;
  } catch (err) {
    globalThis.logger?.warn?.(`[HoYoGet][bili_guide] 视频发送失败 ${bvid}: ${err?.message || err}`);
    return false;
  }
}
