import { mhyFetch } from '../../system/mhy_fetch.js';
import { makeGenshinLoader } from "../../system/genshin_loader.js"
import { makeForwardMsg, pluginPriority } from '#HoYoGet';
const getNoteUser = makeGenshinLoader("model/mys/NoteUser.js", ["model/mys/NoteUser.js"])

const GLOBAL_SEARCH_API = 'https://bbs-api.mihoyo.com/post/wapi/searchPosts';
const POST_FULL_API = 'https://bbs-api.mihoyo.com/post/wapi/getPostFull';

const headers = {
  Referer: 'https://www.miyoushe.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
};

/**
 * 关键词只用于「把范围缩小到官方前瞻区域」，不再假设官方标题的固定措辞。
 *
 * 之前写死具体标题（如绝区零的「前瞻，一站式搞定」）有两个问题：
 * 1) 官方会改命名——绝区零 3.1 起把「前瞻，一站式搞定」换成
 *    「版本前瞻内容总汇」，旧关键词就再也搜不到新版本（实测 3.0 之后全断）。
 * 2) 各版本标题本身带版本号，凑不出一个能覆盖所有版本的关键词。
 *
 * 现在统一搜宽关键词，真正的「哪条是本期官方汇总」交给 officialRe 判定，
 * 再按 created_at 倒序取最新几期。
 */
const GAME_CONFIG = {
  bh3: { gid: 1, name: '崩坏3', keywords: ['特别节目', '内容回顾'] },
  gs: { gid: 2, name: '原神', keywords: ['前瞻汇总', '版本前瞻'] },
  sr: { gid: 6, name: '崩坏：星穹铁道', keywords: ['前瞻特别节目', '特别节目内容回顾'] },
  zzz: { gid: 8, name: '绝区零', keywords: ['前瞻', '版本前瞻'] },
};

/**
 * 判定是否为「官方前瞻汇总帖」。
 * 排除抽奖、预告、攻略征集、直播总结、剧情猜想等蹭热度的帖子；
 * 保留各游戏官方汇总的共性措辞。
 */
/**
 * 展示几期。
 *
 * 原先固定 3 条，实测每条都要一次 getPostFull 详情请求 + 最多 9 张图，
 * 3 条就是 3 次详情 + 最多 27 张图；而 getPostFull 对连续请求敏感，
 * 实测连发几次就返回 Forbidden（风控），表现为指令直接失败。
 *
 * 默认只取最新 1 期：用户问「最新前瞻」时本来就不需要历史，
 * 请求数从 3 降到 1 既更快也几乎不会撞风控。
 * 想看历史可置 2~3（注意详情请求会相应增加）。
 */
const MAX_POSTS = 1;

const OFFICIAL_RE = /(前瞻汇总|前瞻信息|前瞻内容总汇|内容总汇|内容回顾|前瞻特别节目回顾|前瞻特别节目|前瞻一览)/;
const EXCLUDE_RE = /(预告|转发抽奖|抽奖|兑换码|攻略征集|直播总结|剧情猜想|前瞻奖励|福利拉满|白嫖)/;

function pickGame(msg = '') {
  if (/崩三|崩坏三|崩坏3|bh3/i.test(msg)) return 'bh3';
  if (/原神|gs/i.test(msg)) return 'gs';
  if (/星铁|崩铁|星穹|sr/i.test(msg)) return 'sr';
  if (/绝区零|绝区|zzz/i.test(msg)) return 'zzz';
  return null;
}

/**
 * 同一期官方前瞻会发多条（如星铁的「前瞻特别节目」与「…回顾长图」），
 * 标题里都带同一个版本号。这里按「版本号（无版本号则用发布日）归并，
 * 每组只保留发布时间最新的一条，避免三条额度被同一期占满。
 */
function dedupeByVersion(posts = []) {
  const groups = new Map();
  for (const post of posts) {
    const subject = String(post?.subject || '');
    const ver = subject.match(/(\d+\.\d+)/);
    // 同一份发布时间视为同一期（部分游戏同期的两条帖 created_at 完全一致）
    const day = Math.floor(Number(post?.created_at || 0) / 86400);
    const key = ver ? `v${ver[1]}` : `d${day}`;
    const exist = groups.get(key);
    if (!exist || Number(post.created_at || 0) > Number(exist.created_at || 0)) {
      groups.set(key, post);
    }
  }
  return [...groups.values()].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

function decodeHtml(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function collectJsonText(value, depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(v => collectJsonText(v, depth + 1));
  if (typeof value !== 'object') return [];
  const preferKeys = ['text', 'insert', 'content', 'desc', 'title'];
  const direct = preferKeys.flatMap(k => collectJsonText(value[k], depth + 1));
  if (direct.length) return direct;
  return Object.values(value).flatMap(v => collectJsonText(v, depth + 1));
}

function extractPostSummary(post = {}, maxLen = 2000) {
  let content = post.content || post.structured_content || post.summary || '';
  try {
    const json = JSON.parse(content);
    if (json?.text) content = json.text;
    else content = collectJsonText(json).join('\n');
  } catch (_) {}
  const text = decodeHtml(content)
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

async function searchGlobalPosts(keyword, gids, size = 10) {
  const url = `${GLOBAL_SEARCH_API}?gids=${encodeURIComponent(gids)}&size=${size}&keyword=${encodeURIComponent(keyword)}&sort_type=2`;
  const res = await mhyFetch(url, { headers }).then(r => r.json());
  return (res?.data?.posts || [])
    .map(v => v?.post)
    .filter(Boolean)
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0));
}

async function fetchPostFull(post = {}, gids = 1) {
  if (!post?.post_id) return post;
  try {
    const url = `${POST_FULL_API}?gids=${encodeURIComponent(gids)}&read=1&post_id=${encodeURIComponent(post.post_id)}`;
    const res = await mhyFetch(url, { headers }).then(r => r.json());
    const full = res?.data?.post?.post || res?.data?.post || {};
    const imgs = (full.images?.length ? full.images : post.images) || [];
    /* upload-bbs.miyoushe.com 在机房出口连不上，同路径的 upload-bbs.mihoyo.com 可直连 */
    return { ...post, ...full, images: imgs.map(u => String(u || "").replace("upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com")) };
  } catch (err) {
    logger.warn(`[HoYoGet][前瞻] 获取帖子详情 ${post.post_id} 失败: ${err?.message || err}`);
    return post;
  }
}

function isForwardPost(post = {}) {
  const raw = [post.subject, post.content, post.structured_content, post.summary]
    .filter(Boolean).join('\n');
  return /前瞻|特别节目|内容回顾/.test(raw);
}

function formatPostInfo(post = {}, gameName) {
  const lines = [`【${gameName}前瞻】${post.subject || ''}`];
  const ts = Number(post.created_at || post.publish_at || 0);
  if (ts) lines.push(`发布时间：${new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false })}`);
  const summary = extractPostSummary(post);
  if (summary) lines.push(`内容摘要：${summary}`);
  if (post.post_id) {
    // 搜索接口返回的 tid 为 null，但 ys/article/{post_id} 是通用格式，
    // 带 tid 时更精确（部分帖在 /ys/article/ 下打不开）。
    const link = post.tid
      ? `https://www.miyoushe.com/ys/article/${post.post_id}?tid=${post.tid}`
      : `https://www.miyoushe.com/ys/article/${post.post_id}`;
    lines.push(`原帖：${link}`);
  }
  return lines.filter(Boolean).join('\n');
}

export class forward_info extends plugin {
  constructor() {
    super({
      name: '[米哈游]前瞻信息',
      dsc: '原神/星铁/崩坏3/绝区零版本前瞻信息汇总',
      event: 'message',
      priority: pluginPriority('forward_info', -Infinity),
      rule: [
        { reg: "^[#*%]*(米哈游)?(崩三|崩坏三|崩坏3|原神|星铁|崩铁|星穹铁道|绝区零)?(前瞻)(信息)?$", fnc: "forwardInfo" },
      ],
    });
  }

  async forwardInfo() {
    let key = pickGame(this.e.msg);
    if (!key) {
      /* 指令里没写游戏名时，按该 QQ 已绑定的游戏推断；多个游戏都有绑定则要求指明 */
      const order = ["sr", "gs", "zzz", "bh3"];
      try {
        const nu = await (await getNoteUser()).create(this.e.user_id);
        const bound = order.filter(g => !!String(nu?.getUid(g) || ""));
        if (bound.length === 1) key = bound[0];
        else if (bound.length > 1) {
          const names = bound.map(g => GAME_CONFIG[g].name).join(" / ");
          return this.e.reply(`检测到多个游戏绑定（${names}），请指明游戏，例如：#星铁前瞻信息`);
        }
      } catch (_) {}
      if (!key) return this.e.reply("请指明游戏，例如：#星铁前瞻信息");
    }
    const cfg = GAME_CONFIG[key];
    await this.e.reply(`${cfg.name}前瞻信息获取中，请稍后...`, true, { recallMsg: 60 });

    const seenPosts = new Set();
    const seenImages = new Set();
    const msg = [];
    let detailFailed = false;

    // 1) 先把所有关键词的结果收齐、按 post_id 去重，再统一筛选与排序。
    //    原先是一边搜一边取、取够 3 条就 break，导致结果取决于哪个关键词先命中，
    //    并不保证是最新版本——这正是「拿不到 3.3」的直接原因。
    const candidates = [];
    for (const keyword of cfg.keywords) {
      try {
        const posts = await searchGlobalPosts(keyword, cfg.gid, 20);
        for (const post of posts) {
          if (!post?.post_id || seenPosts.has(post.post_id)) continue;
          seenPosts.add(post.post_id);
          candidates.push(post);
        }
      } catch (err) {
        logger.warn(`[HoYoGet][前瞻] 搜索 ${keyword} 失败: ${err?.message || err}`);
      }
    }

    // 2) 标题粗筛（省掉后续详情请求），再按发布时间倒序取最新几期。
    //    同一期官方常发两条（如星铁「前瞻特别节目」与「…回顾长图」），
    //    标题里带版本号，按「版本号 + 发布日」归并，只留一条，
    //    否则三条额度会被同一期占满、看不到更早的版本。
    const picked = dedupeByVersion(
      candidates
        .filter(post => !EXCLUDE_RE.test(post.subject || ''))
        .filter(post => OFFICIAL_RE.test(post.subject || ''))
        .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    ).slice(0, MAX_POSTS);

    // 3) 粗筛后仍无结果时放宽：至少含「前瞻/特别节目/内容回顾」，避免命名再变就完全失效
    const fallback = picked.length ? picked : candidates
      .filter(post => /(前瞻|特别节目|内容回顾)/.test(post.subject || ''))
      .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
      .slice(0, MAX_POSTS);
    if (!picked.length && fallback.length) {
      logger.mark(`[HoYoGet][前瞻] ${cfg.name} 标题特征未命中，回退到宽筛选`);
    }

    for (let post of (picked.length ? picked : fallback)) {
      post = await fetchPostFull(post, cfg.gid);
      if (!isForwardPost(post)) continue;
      const imageSegments = (post?.images || [])
        .filter(url => url && !seenImages.has(url))
        .slice(0, 9)
        .map(url => {
          seenImages.add(url);
          return segment.image(url);
        });
      const postInfo = formatPostInfo(post, cfg.name);
      if (!imageSegments.length && !extractPostSummary(post)) {
        // 详情接口被风控时会退化成只有搜索摘要的帖子。此时仍给出标题与发布时间，
        // 而不是直接丢进 continue 让用户看到「未找到」——那会把网络问题
        // 伪装成「官方没发前瞻」。
        detailFailed = true;
        msg.push([postInfo]);
        break;
      }
      msg.push([postInfo, ...imageSegments]);
      if (msg.length >= MAX_POSTS) break;
    }

    if (!msg.length) {
      return this.e.reply(`未找到${cfg.name}前瞻信息相关帖子，请稍后再试~`, true);
    }
    if (detailFailed) {
      // 明确告知是取详情失败而非没有前瞻
      msg[msg.length - 1].push('\n（详情接口暂时取不到，这里只显示标题，稍后重试可拿到完整长图）');
    }
    return this.e.reply(await makeForwardMsg(this.e, msg, `${cfg.name}前瞻信息汇总`));
  }
}
