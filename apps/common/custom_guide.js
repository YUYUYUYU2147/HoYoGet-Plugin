import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { makeForwardMsg, config, pluginPriority, oldPostWarn } from '#HoYoGet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 插件根目录（apps 的上一级），别名表读取不依赖进程 cwd、也不依赖任何外部插件
const PLUGIN_ROOT = path.resolve(__dirname, '../..');
// 攻略图片缓存：按「游戏/角色名」存已解析的图片 URL 列表，
// 二次查询直接读缓存秒开，避免每次重复打米游社接口（也降低风控概率）
const GUIDE_CACHE_DIR = path.join(PLUGIN_ROOT, 'data', 'guide-cache');
const GUIDE_CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 天

function guideCacheFile(game, name) {
  const safe = String(name).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
  return path.join(GUIDE_CACHE_DIR, `${game}__${safe}.json`);
}
function readGuideCache(game, name) {
  try {
    const f = guideCacheFile(game, name);
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!d || Date.now() - Number(d.ts || 0) > GUIDE_CACHE_TTL) return null;
    return Array.isArray(d.images) && d.images.length ? d : null;
  } catch { return null; }
}
function writeGuideCache(game, name, images, meta = {}) {
  try {
    fs.mkdirSync(GUIDE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(guideCacheFile(game, name), JSON.stringify({ ts: Date.now(), images, ...meta }, null, 0));
  } catch (err) {
    logger.debug?.(`[HoYoGet][custom_guide] 写缓存失败：${err?.message || err}`);
  }
}

const SEARCH_API = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list';
// 米游社分区攻略搜索：按角色名在对应游戏分区里搜，不依赖具体作者，覆盖面更广
const WALKTHROUGH_API = 'https://bbs-api.miyoushe.com/painter/wapi/searchWalkthrough';
// 原神观测枢官方攻略目录（精选角色攻略）
const YS_STRATEGY_MAP = 'https://act-api-takumi-static.mihoyo.com/common/blackboard/ys_strategy/v1/home/map?app_sn=ys_strategy';
// 米游社帖子详情（取完整图集）
const POST_FULL_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';
const DEFAULT_SIZE = 20;
const SORT_TYPE = '2';
const MAX_IMAGES = 10;
const FETCH_TIMEOUT = 15000;
// 单次查询的请求预算：搜索/目录/详情合计不超过此数，防止米游社风控
const REQUEST_BUDGET = 30;
// 游戏 → 米游社分区 gids
const GIDS_BY_GAME = { gs: 2, sr: 6, zzz: 8 };
// 默认作者UID：当各游戏未单独填UID、或角色不在别名表时兜底使用（无需在锅巴额外保存即生效）
const FALLBACK_UID = '74019947';
// 标题黑名单：这些不是角色攻略本身（晒卡/求助/大盘点）
const EXCLUDE_TITLE_RE = /毕业面板|面板一图流|晒卡|晒面板|晒练度|不知道晒|求助|求教|疑惑|疑问|卡池|合集|阵容推荐|差分|混沌回忆|异相仲裁|星琼统计/;
const GUIDE_TITLE_RE = /攻略|一图流|图鉴|养成|图解/;
// 标题归一：去掉所有非文字/数字
const normText = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * [米哈游]自定义攻略源（极简模式）
 * 只需在锅巴面板为每个游戏填一个「作者UID」，角色名即关键词。
 * 关键词自动用别名表（HoYoGet 自带 system/default/*alias*.json）把别名/英文名/错别字
 * 归一成正式名，例如「Violet / 沃雅尼沙」都会转成「沃雅妮莎」去搜。
 * 角色属于哪个游戏由别名表判定，从而自动选对应游戏的UID。
 *
 * 指令：#角色名攻略  /  #角色名一图流  /  #角色名配对  /  #角色名配队
 *       也可加前缀避免与其它插件冲突：HoYoGet#角色名攻略 / HoYoGet/角色名攻略 / 小花火#角色名攻略（前缀可省略，支持 HoYoGet/小花火 后接 / 或 #）
 *       跨游戏重名/同别名时用游戏前缀指定：#绝区零鲨鱼妹攻略 / #原神玛拉妮攻略
 */

// 三游戏别名表，各自独立加载：1) 归一化关键词；2) 判定角色所属游戏以选UID
const ALIAS_FILES = {
  gs: path.join(PLUGIN_ROOT, 'system/default/gsalias.json'),
  sr: path.join(PLUGIN_ROOT, 'system/default/sralias.json'),
  zzz: path.join(PLUGIN_ROOT, 'system/default/zzzalias.json'),
};
// 米游社 game_id → 站点路径段。原帖链接必须带路径段，否则 /article/{id} 打不开会跳首页
const MYS_PATH_BY_GID = { 1: 'bh3', 2: 'ys', 6: 'sr', 8: 'zzz' };
const MYS_PATH_BY_GAME = { gs: 'ys', sr: 'sr', zzz: 'zzz', bh3: 'bh3' };

function mysPostUrl(postId, gid, game) {
  if (!postId) return '';
  const path = MYS_PATH_BY_GID[Number(gid)] || MYS_PATH_BY_GAME[game] || 'ys';
  return `https://www.miyoushe.com/${path}/article/${postId}`;
}

// 游戏前缀：#绝区零鲨鱼妹攻略 这类写法可显式指定游戏，解决跨游戏别名冲突（如 鲨鱼妹 → 原神玛拉妮 / 绝区零艾莲）
const GAME_PREFIX_MAP = {
  '原神': 'gs', 'gs': 'gs',
  '星铁': 'sr', '星穹': 'sr', '星穹铁道': 'sr', 'sr': 'sr',
  '绝区零': 'zzz', 'zzz': 'zzz',
};
let aliasMaps = null;
let aliasLoaded = false;

function loadAliasMaps() {
  if (aliasLoaded) return aliasMaps;
  aliasLoaded = true;
  const maps = {};
  for (const [game, p] of Object.entries(ALIAS_FILES)) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data && typeof data === 'object') maps[game] = data;
    } catch (err) {
      logger.warn(`[HoYoGet][custom_guide] 读取别名表失败 ${p}: ${err?.message || err}`);
    }
  }
  if (Object.keys(maps).length) aliasMaps = maps;
  return aliasMaps;
}

// 在单个游戏别名表里归一化：输入即正式名(key) 或 命中别名数组 → 返回正式名；否则 null
function formalInMap(name, map) {
  if (!map) return null;
  if (Array.isArray(map[name]) && map[name].length) return name;
  for (const [key, aliases] of Object.entries(map)) {
    if (Array.isArray(aliases) && aliases.includes(name)) return key;
  }
  return null;
}

// 解析图片序号字符串，如 "0" / "0,2" / "0, 2" → [0] / [0, 2]
// 留空取该帖全部图片；填序号取指定张（0=第一张，1=第二张，从0开始）
// 注意：Number('') === 0，''.split() 会得到 ['']，若直接 map(Number) 会把「留空」变成 [0]（只取首图），
// 所以空串必须提前返回 []，并过滤掉分隔产生的空段
function parseIndexes(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  return raw.split(/[,，\s]+/)
    .filter(s => s !== '')
    .map(Number)
    .filter(v => Number.isInteger(v) && v >= 0);
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: 'https://www.miyoushe.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    logger.warn(`[HoYoGet][custom_guide] 请求失败 ${url}: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// 提取帖子完整图片：搜索接口返回的 post.images 在某些分支下只含封面 1 张，
// 完整图集在外层 image_list（每项带 url）。不同接口版本可能在 item.image_list / item.post.image_list 两处，
// 这里都尝试，并兼容「字符串数组」和「{url}对象数组」两种结构，取数量最多的那份
function extractImages(item = {}) {
  const post = item?.post?.post || {};
  const candidates = [
    post.images,
    item?.image_list,
    item?.post?.image_list,
  ].filter(Array.isArray);
  let best = [];
  for (const arr of candidates) {
    const urls = (arr[0] && typeof arr[0] === 'object' && arr[0]?.url)
      ? arr.map(x => x?.url).filter(Boolean)
      : arr.filter(Boolean);
    if (urls.length > best.length) best = urls;
  }
  return best.slice();
}

async function searchPosts(keyword, uid, size = DEFAULT_SIZE) {
  // 米游社标题普遍用「·」(U+00B7)，而别名表/输入可能是「•」(U+2022)「・」等变体，统一成「·」再搜，提高命中率
  const apiKeyword = String(keyword).replace(/[•・∙⋅]/g, '·');
  const url = `${SEARCH_API}?keyword=${encodeURIComponent(apiKeyword)}&uid=${encodeURIComponent(uid)}&size=${size}&offset=0&sort_type=${SORT_TYPE}`;
  const res = await fetchJSON(url);
  if (!res || res.retcode !== 0) return [];
  // 标题必须包含关键词才采用：比较时去掉所有非文字/数字字符（点号变体、空格、括号、书名号等全部忽略，
  // 如「零号·安比」↔「零号安比」↔「零号•安比」都能对上），过滤掉作者动态里正文提到关键词的无关帖子
  const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const kw = norm(keyword);
  return (res?.data?.list || [])
    .map(v => {
      const post = v?.post?.post || {};
      return {
        subject: post.subject,
        post_id: post.post_id,
        created_at: post.created_at,
        publish_at: post.publish_at,
        game_id: v?.game_id,
        images: extractImages(v),
      };
    })
    .filter(p => norm(p.subject).includes(kw));
}

// ============ 米游社分区攻略搜索（移植自成熟做法）============
/**
 * 判断一篇帖子是否是某角色的有效攻略：
 *   · game_id 必须匹配目标分区
 *   · 标题包含角色名 + 攻略类关键词（攻略/一图流/图鉴/养成/图解）
 *   · 排除晒卡/求助/合集等非攻略帖
 *   · 基础角色名不能误匹配「角色·XX」这种新形态
 */
function isGuidePost(postInner, name, gids) {
  const inner = postInner?.post || postInner || {};
  const subject = String(inner.subject || '');
  if (Number(inner.game_id) !== Number(gids)) return false;
  if (!normText(subject).includes(normText(name))) return false;
  if (!GUIDE_TITLE_RE.test(subject)) return false;
  if (EXCLUDE_TITLE_RE.test(subject)) return false;
  const base = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!/[·•]/.test(name) && new RegExp(base + '[·•・‧](?!\\s*(?:角色|攻略|一图|养成|培养|图鉴|图解|全面|详细|简要))').test(subject)) return false;
  return /^\d+$/.test(String(inner.post_id));
}

/**
 * 分区关键词搜索：返回帖子摘要列表。
 * 依次用「角色名 一图流 / 角色名 攻略 / 角色名 养成」三组关键词 × 两种排序搜，
 * 每页 20 条、最多 3 页，受 budget 限制防封。
 * @returns {Promise<Array<{subject, post_id, created_at, game_id, user}>>}
 */
async function searchWalkthrough(name, game, budget) {
  const gids = GIDS_BY_GAME[game];
  if (!gids) return [];
  const out = [];
  const seen = new Set();
  const keywords = [`${name} 一图流`, `${name} 攻略`, `${name} 养成`];
  for (const keyword of keywords) {
    for (const sort of [0, 2]) {
      let cursor = '';
      for (let page = 0; page < 3; page++) {
        if (budget.left <= 0) return out;
        budget.left--;
        const q = new URLSearchParams({ gids: String(gids), size: '20', keyword, sort_type: String(sort), last_id: cursor });
        const res = await fetchJSON(`${WALKTHROUGH_API}?${q}`);
        if (!res || res.retcode !== 0 || !Array.isArray(res.data?.list)) break;
        const posts = res.data.list;
        for (const item of posts) {
          const inner = item?.post || {};
          const id = String(inner.post_id || '');
          if (!id || seen.has(id)) continue;
          if (!isGuidePost(item, name, gids)) continue;
          seen.add(id);
          // 前瞻/创作体验服帖排后，最新更新的排前
          const preview = /前瞻|创作体验服/.test(String(inner.subject || '')) ? 1 : 0;
          out.push({
            subject: inner.subject,
            post_id: id,
            game_id: inner.game_id,
            created_at: inner.created_at,
            updated_at: inner.updated_at,
            user: inner.user,
            _preview: preview,
          });
        }
        const next = String(res.data.last_id || '');
        if (res.data.is_last || !posts.length || !next || next === cursor) break;
        cursor = next;
      }
    }
  }
  out.sort((a, b) => a._preview - b._preview || Number(b.updated_at || b.created_at) - Number(a.updated_at || a.created_at));
  return out;
}

/**
 * 原神观测枢官方角色攻略目录：返回该角色的精选攻略 post_id 列表。
 * 只对原神有意义，其它游戏返回空。
 */
async function searchObservatory(name, budget) {
  if (budget.left <= 0) return [];
  budget.left--;
  const res = await fetchJSON(YS_STRATEGY_MAP);
  if (!res || !Array.isArray(res.data?.list)) return [];
  const flatten = list => list.flatMap(it => [it, ...flatten(it.children || [])]);
  const category = flatten(res.data.list).find(it => it.name === '角色攻略' && it.children?.length);
  const channelName = /^[风岩雷草水火冰]主$/.test(name) ? '旅行者' : name;
  const channel = category?.children?.find(it => normText(it.name) === normText(channelName));
  if (!channel || !Array.isArray(channel.list)) return [];
  const ids = [];
  for (const item of channel.list) {
    const m = /^https:\/\/(?:www\.miyoushe\.com|bbs\.mihoyo\.com)\/(?:ys|sr|zzz|bh3)\/article\/(\d+)(?:[?#].*)?$/.exec(item.bbs_url || '');
    if (m && !ids.includes(m[1])) ids.push(m[1]);
  }
  return ids;
}

/**
 * 拉取帖子详情并提取完整图集。
 * @returns {Promise<Array<string>>} 图片 URL 列表
 */
async function fetchPostImages(postId, gids, budget) {
  if (budget.left <= 0) return [];
  budget.left--;
  const res = await fetchJSON(`${POST_FULL_API}?gids=${gids}&post_id=${postId}&read=1`);
  if (!res || res.retcode !== 0 || !res.data?.post) return [];
  return extractImages(res.data);
}

// 米游社图床（阿里OSS）支持链接参数实时压缩：攻略长图原图常达十几MB，QQ协议端发不动
// （表现为只发出第一张封面、其余全部失败）。统一转 jpg 并压画质（分辨率不变，gif 跳过保持动图）
function compressImg(url = '') {
  if (!url || !url.includes('upload-bbs.miyoushe.com')) return url;
  if (/\.gif($|\?)/i.test(url) || url.includes('x-oss-process')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}x-oss-process=image/resize,w_1200/quality,q_85/format,jpg`;
}

function pickImages(post = {}, indexes = []) {
  const images = post.images || [];
  if (!images.length) return [];
  const idxList = indexes.length
    ? indexes
    : [...Array(Math.min(MAX_IMAGES, images.length)).keys()];
  return idxList.filter(i => images[i]).slice(0, MAX_IMAGES).map(i => compressImg(images[i]));
}

export class custom_guide extends plugin {
  constructor() {
    super({
      name: '[米哈游]自定义攻略源',
      dsc: '只需配置各游戏作者UID，关键词自动取角色别名表正式名',
      event: 'message',
      priority: pluginPriority('custom_guide', -9999999999),
      rule: [
        { reg: '^(?:米哈游[/#]?)?#?(\\S+)(攻略|一图流|配对|配队)$', fnc: 'guide' },
      ],
    });
  }

  async guide(e) {
    if (config()?.custom_guide_enable === false) return false;

    const match = /^(?:米哈游[/#]?)?#?(\S+)(攻略|一图流|配对|配队)$/.exec(e.msg || '');
    if (!match) return false;
    let roleQuery = match[1];

    // 崩三/崩坏3 的攻略（深渊/战场/乐土）由专用插件 mhy_estimate 处理；本插件只支持
    // 原神/星铁/绝区零 角色攻略，直接放行，避免用错误数据源拼出误导性的「未找到」报错
    if (/^(崩三|崩坏3|崩坏三|bh3)/i.test(roleQuery)) return false;
    // 玩法类攻略（战场/乐土/深渊/防卫战/危局）同样是 mhy_estimate 的职责，这里放行，
    // 否则本插件优先级更高会把它当成「角色名」去搜，导致搜不到还误导用户
    if (/(战场|乐土|深渊|防卫战|式舆|危局|强袭)/.test(roleQuery)) return false;

    const cfg = config() || {};
    const maps = loadAliasMaps();
    const games = [
      { key: 'gs', uid: cfg.custom_guide_gs_uid, index: cfg.custom_guide_gs_index },
      { key: 'sr', uid: cfg.custom_guide_sr_uid, index: cfg.custom_guide_sr_index },
      { key: 'zzz', uid: cfg.custom_guide_zzz_uid, index: cfg.custom_guide_zzz_index },
    ];

    // 剥离游戏前缀（如 绝区零/原神/星铁），锁定游戏，避免跨游戏别名冲突
    let forced = null;
    const pm = /^(原神|星穹铁道|星穹|星铁|绝区零|zzz|gs|sr)/i.exec(roleQuery);
    if (pm && pm[1].length < roleQuery.length) {
      forced = GAME_PREFIX_MAP[pm[1].toLowerCase()];
      roleQuery = roleQuery.slice(pm[1].length);
    }

    // 按游戏匹配：哪个游戏的别名表收录了这个角色，就归哪个游戏（决定用哪个游戏的默认源）。
    // 别名冲突时（如 鲨鱼妹 同时收录于原神/绝区零）会命中多个游戏，按序依次尝试各游戏的源
    const matchedGames = [];
    for (const g of games) {
      if (forced && g.key !== forced) continue;
      const formal = formalInMap(roleQuery, maps?.[g.key]);
      if (formal) matchedGames.push({ ...g, formal });
    }

    // 关键词：别名命中用该游戏的正式名（如 大安比→零号·安比），否则用原名
    const keyword = matchedGames.length ? matchedGames[0].formal : roleQuery;
    const indexes = parseIndexes(matchedGames[0]?.index);

    // 候选（去重、按序尝试，首个有结果即停）：
    //  命中别名 → 各命中游戏的默认源；未命中 → 各游戏默认源；最后全局兜底源 → 代码内置 74019947
    const candidates = [];
    const seenCand = new Set();
    const pushCand = (kw, uid, game) => {
      const n = Number(uid);
      if (!uid || !Number.isSafeInteger(n) || n <= 0 || seenCand.has(`${kw}@${n}`)) return;
      seenCand.add(`${kw}@${n}`);
      candidates.push({ keyword: kw, uid: n, game });
    };
    if (matchedGames.length) {
      for (const m of matchedGames) pushCand(m.formal, m.uid, m.key);
    } else {
      for (const g of games) pushCand(roleQuery, g.uid, g.key);
    }
    pushCand(keyword, cfg.custom_guide_uid, matchedGames[0]?.key);
    pushCand(keyword, FALLBACK_UID, matchedGames[0]?.key);
    // 一个可用UID都没有：静默放行，交给 mora 等其它插件处理
    if (!candidates.length) return false;

    // 缓存命中：直接发已保存的图片，秒开且不打接口
    const cacheGame = matchedGames[0]?.key || forced || 'gs';
    const cached = readGuideCache(cacheGame, keyword);
    if (cached && cached.images.length) {
      const msg2 = [];
      const lines = [`「${keyword}」攻略（缓存）`];
      if (cached.author) lines.push(`作者：${cached.author}`);
      if (cached.link) lines.push(`原帖：${cached.link}`);
      msg2.push([lines.join('\n'), segment.image(cached.images[0])]);
      for (const u of cached.images.slice(1)) msg2.push([segment.image(u)]);
      logger.mark(`[HoYoGet][custom_guide] 命中缓存 ${cacheGame}/${keyword}，${cached.images.length} 张`);
      if (cfg.custom_guide_forward !== 'off') {
        await e.reply(await makeForwardMsg(e, msg2, `「${keyword}」攻略来啦~`));
      } else {
        for (const item of msg2) await e.reply(item);
      }
      return true;
    }

    await e.reply(`正在获取「${keyword}」攻略，请稍后...`, true, { recallMsg: 60 });

    const msg = [];
    const seenImages = new Set();
    for (const cand of candidates) {
      const { keyword: kw, uid, game } = cand;
      try {
        const posts = await searchPosts(kw, uid, DEFAULT_SIZE);
        logger.mark(`[HoYoGet][custom_guide] ${kw}/${uid} 搜到 ${posts.length} 帖，各帖图数: ${posts.map(p => p.images.length).join(',') || '0'}`);
        let pushed = false;
        for (const post of posts) {
          const images = pickImages(post, indexes).filter(u => !seenImages.has(u));
          if (!images.length) continue;
          images.forEach(u => seenImages.add(u));
          const lines = [`作者：UID${uid}`, post.subject || kw].filter(Boolean);
          const time = Number(post.created_at || post.publish_at || 0);
          // 老攻略在发布时间后挂时效提醒，避免拿几年前的内容当现版本作业
          if (time) lines.push(`发布：${new Date(time * 1000).toLocaleString('zh-CN', { hour12: false })}${oldPostWarn(time)}`);
          if (post.post_id) lines.push(`原帖：${mysPostUrl(post.post_id, post.game_id, game)}`);
          // 每张图独立一个转发节点：部分适配器对「单节点多图」发送不可靠（只出第一张、其余全丢）
          // 纯图片节点也包成数组，确保适配器按节点渲染
          msg.push([lines.join('\n'), segment.image(images[0])]);
          for (const u of images.slice(1)) msg.push([segment.image(u)]);
          pushed = true;
          if (msg.length >= 12) break;
        }
        if (pushed) break; // 该候选有结果就不再试下一个
      } catch (err) {
        logger.warn(`[HoYoGet][custom_guide] ${kw}/${uid} 获取失败：${err?.message || err}`);
      }
    }

    // ===== 兜底：作者源没结果时，走米游社分区关键词搜索 =====
    // 这样即便没在锅巴配作者 UID，或作者没发过该角色，也能按角色名搜到社区攻略
    if (!msg.length && cfg.custom_guide_walkthrough !== false) {
      const game = matchedGames[0]?.key || forced || 'gs';
      const gids = GIDS_BY_GAME[game];
      if (gids) {
        const budget = { left: REQUEST_BUDGET };
        try {
          // 原神优先走观测枢官方精选目录
          if (game === 'gs') {
            const obsIds = await searchObservatory(keyword, budget);
            for (const pid of obsIds) {
              if (msg.length >= 12 || budget.left <= 0) break;
              const images = await fetchPostImages(pid, gids, budget);
              const picked = pickImages({ images }, indexes).filter(u => !seenImages.has(u));
              if (!picked.length) continue;
              picked.forEach(u => seenImages.add(u));
              const lines = ['来源：观测枢', `原帖：${mysPostUrl(pid, gids, game)}`];
              msg.push([lines.join('\n'), segment.image(picked[0])]);
              for (const u of picked.slice(1)) msg.push([segment.image(u)]);
            }
          }
          // 分区关键词搜索
          if (msg.length < 12 && budget.left > 0) {
            const posts = await searchWalkthrough(keyword, game, budget);
            logger.mark(`[HoYoGet][custom_guide] 分区搜索「${keyword}」(${game}) 命中 ${posts.length} 帖`);
            for (const post of posts) {
              if (msg.length >= 12 || budget.left <= 0) break;
              const images = await fetchPostImages(post.post_id, gids, budget);
              const picked = pickImages({ images }, indexes).filter(u => !seenImages.has(u));
              if (!picked.length) continue;
              picked.forEach(u => seenImages.add(u));
              const lines = [`作者：${post.user?.nickname || '未知'}`, post.subject || keyword];
              const time = Number(post.created_at || 0);
              if (time) lines.push(`发布：${new Date(time * 1000).toLocaleString('zh-CN', { hour12: false })}${oldPostWarn(time)}`);
              lines.push(`原帖：${mysPostUrl(post.post_id, post.game_id, game)}`);
              msg.push([lines.join('\n'), segment.image(picked[0])]);
              for (const u of picked.slice(1)) msg.push([segment.image(u)]);
            }
          }
        } catch (err) {
          logger.warn(`[HoYoGet][custom_guide] 分区搜索兜底失败：${err?.message || err}`);
        }
      }
    }

    if (!msg.length) {
      msg.push(`未找到「${keyword}」的攻略帖子。\n已尝试作者源：${candidates.map(c => `${c.keyword}@UID${c.uid}`).join('、') || '无'}${cfg.custom_guide_walkthrough !== false ? '，及米游社分区搜索' : ''}。\n可在锅巴「自定义攻略源」填写默认源UID，或确认角色名是否正确`);
    }

    if (!msg.length) return e.reply(`未找到「${keyword}」相关攻略图`, true);
    logger.mark(`[HoYoGet][custom_guide] 准备发送转发节点数: ${msg.length}`);
    // 合并转发开关：关闭时逐条拼接发送，且不带「xx攻略来啦~」这类标题文字
    let sentOk = false;
    if (cfg.custom_guide_forward !== 'off') {
      sentOk = await e.reply(await makeForwardMsg(e, msg, `「${keyword}」攻略来啦~`));
    } else {
      for (const item of msg) sentOk = await e.reply(item);
    }
    // 发送成功才写缓存，失败不缓存避免下次拿到坏数据
    if (sentOk && seenImages.size) {
      writeGuideCache(cacheGame, keyword, [...seenImages])
    }
    return true;
  }
}
