import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';

const NEWS_API = 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList';
// 静态资源域名与接口域名指向同一套公告接口，某一域名解析到坏地址池时互相兜底
const NEWS_API_ALT = 'https://bbs-api.miyoushe.com/painter/wapi/getNewsList';
const POST_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull';
/* 详情接口在 bbs-api 域名上会整条挂死：TCP 能连、TLS 之后没有响应，十秒级超时。
   static 域名同一接口正常（实测 getPostFull 200、3 秒返回），因此两个域名都试，static 优先。 */
const POST_API_ALT = 'https://bbs-api-static.miyoushe.com/post/wapi/getPostFull';


/* 米游社公告域名走自建 CDN，DNS 每轮解析会轮换到不同机房地址池，部分地址池从本机
   不可达：TCP 握手能完成，TLS 阶段再无响应；而 fetch（undici）只取解析结果里的首个
   地址、不会换地址重试，请求便一直挂到超时，日志表现为 TimeoutError。
   处理思路：解析后并发做 TLS 握手探测，选定可达地址再发 https 请求，结果缓存十分钟；
   请求失败即拉黑该地址并清空缓存，重试时重新解析换池。 */
const IP_TTL = 10 * 60 * 1000;
const IP_BAD_TTL = 10 * 60 * 1000;
/* TLS 探测失败只短时间避开：并发握手排队也会超时，按请求失败的口径拉黑十分钟，
   会把整个地址池误判成不可用，公告详情随即成片失败（14:30:09 那一轮即如此）。 */
const PROBE_BAD_TTL = 60 * 1000;
const ipCache = new Map();
const ipBad = new Map();

const REQUEST_HEADERS = {
  Referer: 'https://www.miyoushe.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
};

function tlsProbe(ip, hostname, timeout = 2500) {
  return new Promise(resolve => {
    const socket = tls.connect({ host: ip, port: 443, servername: hostname, timeout });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.once('secureConnect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function badSet(hostname) {
  let set = ipBad.get(hostname);
  if (!set) { set = new Map(); ipBad.set(hostname, set); }
  return set;
}

function markBad(hostname, ip, ttl = IP_BAD_TTL) {
  if (!ip) return;
  badSet(hostname).set(ip, Date.now() + ttl);
  const cached = ipCache.get(hostname);
  if (cached && cached.ip === ip) ipCache.delete(hostname);
}

function isBadIp(hostname, ip) {
  const set = badSet(hostname);
  const expire = set.get(ip);
  if (!expire) return false;
  if (expire > Date.now()) return true;
  set.delete(ip);
  return false;
}
const ipPending = new Map();

/* 并发请求共用同一次探测：公告详情是并发拉的，每个请求各自解析并握手，
   同一台机器会打出一片探测超时，地址池很快就被自己清空。 */
function pickIp(hostname) {
  const pending = ipPending.get(hostname);
  if (pending) return pending;
  const task = pickIpNow(hostname).finally(() => ipPending.delete(hostname));
  ipPending.set(hostname, task);
  return task;
}

async function pickIpNow(hostname) {
  const cached = ipCache.get(hostname);
  if (cached && Date.now() - cached.at < IP_TTL && !isBadIp(hostname, cached.ip)) return cached.ip;
  let candidates = [];
  // 同一轮解析只会给出同一个地址池，池内全被拉黑时再解析几次换个池子
  for (let round = 0; round < 3 && !candidates.length; round++) {
    // 解析器自带缓存，连着问三次拿到的是同一份答案，稍等再问才可能换到别的地址池
    if (round) await new Promise(r => setTimeout(r, 300 * round));
    const ips = await dns.resolve4(hostname).catch(() => []);
    candidates = ips.filter(ip => !isBadIp(hostname, ip));
  }
  if (!candidates.length) return '';
  const ip = await new Promise(resolve => {
    let pending = candidates.length;
    for (const candidate of candidates) {
      tlsProbe(candidate, hostname).then(ok => {
        if (ok) { resolve(candidate); return; }
        // 探测失败多半是瞬时拥塞：只短时间避开这个地址，不要按请求失败的口径拉黑
        markBad(hostname, candidate, PROBE_BAD_TTL);
        if (--pending === 0) resolve('');
      });
    }
  });
  if (ip) ipCache.set(hostname, { ip, at: Date.now() });
  return ip;
}

/* 系统解析器直连：地址池给不出可用出口（DNS 空答、整池被拉黑）时的兜底。
   以前这里直接抛错，公告详情会在同一分钟里成片报「米游社接口无可用出口地址」。 */
function requestDirect(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(target, { headers: REQUEST_HEADERS, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error('米游社接口 HTTP ' + res.statusCode));
        try {
          resolve(JSON.parse(text));
        } catch (_) {
          reject(new Error('米游社接口返回非 JSON：' + text.slice(0, 120)));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('米游社接口请求超时 ' + timeoutMs + 'ms')));
    req.on('error', reject);
  });
}

function requestJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    pickIp(target.hostname).then(ip => {
      // 整池不可达：改用系统解析器直连，不再让整轮公告详情直接失败
      if (!ip) return requestDirect(url, timeoutMs).then(resolve, reject);
      const options = {
        headers: REQUEST_HEADERS,
        servername: target.hostname,
        timeout: timeoutMs,
        // 地址已选定，关闭多地址探测，避免在坏地址上再等一轮
        autoSelectFamily: false
      };
      options.lookup = (host, opts, cb) => (
        // 部分调用路径会以 all 形式索取地址表，两种形态都要兼容
        opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)
      );
      const req = https.get(target, options, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return reject(new Error('米游社接口 HTTP ' + res.statusCode));
          try {
            resolve(JSON.parse(text));
          } catch (_) {
            reject(new Error('米游社接口返回非 JSON：' + text.slice(0, 120)));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('米游社接口请求超时 ' + timeoutMs + 'ms')));
      req.on('error', err => {
        markBad(target.hostname, ip);
        // 选定地址连不上时也退回直连：宁可多打一次，也不要整条详情链路失败
        requestDirect(url, timeoutMs).then(resolve, () => reject(err));
      });
    }).catch(reject);
  });
}

async function requestJsonWithRetry(urls, { attempts = 3, timeoutMs = 12000 } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  let lastErr = null;
  for (let round = 0; round < attempts; round++) {
    for (const url of list) {
      try {
        return await requestJson(url, timeoutMs);
      } catch (err) {
        lastErr = err;
      }
    }
    if (round + 1 < attempts) await new Promise(r => setTimeout(r, 600 * (round + 1)));
  }
  throw lastErr || new Error('米游社接口请求失败');
}


const GAME_META = {
  gs: {
    name: '原神',
    gid: 2,
    aliases: ['原神', 'gs'],
    keywords: /(祈愿|概率UP|集录祈愿|溯光祈愿)/,
    exclude: /(问题|修复|说明|反馈|预下载|更新说明|版本更新)/
  },
  sr: {
    name: '星穹铁道',
    gid: 6,
    aliases: ['星铁', '崩铁', '星穹铁道', 'sr'],
    keywords: /(活动跃迁|角色活动跃迁|光锥活动跃迁|联动跃迁|联动公告|联动更新|跃迁)/,
    // 「联动跃迁说明」这类公告虽然标题含「说明」，但本质是卡池公告，需要保留。
    // 「跃迁记录统计上线」等工具类公告带「跃迁」关键词但不是卡池公告，需要排除。
    exclude: /(活动说明|双倍|问题|修复|更新说明|记录统计|统计上线)/,
    // 已滚出 getNewsList 最新列表、但联动卡池背景仍需要的公告，通过 postId 直接补拉详情。
    // 「Fate[UBW] 联动跃迁说明」包含 690x320 联动横图，自动选图时应优于此公告而非「联动更新公告」。
    pinnedPosts: [
      { postId: '76423940', note: 'Fate[UBW] 联动跃迁说明（联动横图）' }
    ]
  },
  zzz: {
    name: '绝区零',
    gid: 8,
    aliases: ['绝区零', '绝区', 'zzz'],
    keywords: /(限时频段|独家频段|音擎频段|频段|调频)/,
    exclude: /(活动说明|封禁|FAQ|已知问题|壁纸|档案|养成指南|说明书)/
  },
  bh3: {
    name: '崩坏3',
    gid: 1,
    aliases: ['崩三', '崩坏3', '崩坏三', 'bh3'],
    keywords: /(补给|扩充|精准|角色补给|装备补给|服装补给|协同)/,
    exclude: /(封禁|外挂|账号|问题|修复|更新说明)/
  }
};

const CACHE_TTL = 6 * 60 * 60;
const CACHE_VER = 'v2';

class OfficialGachaPool {
  get games() {
    return GAME_META;
  }

  resolveGame(text = '') {
    const raw = String(text).toLowerCase();
    for (const [key, meta] of Object.entries(GAME_META)) {
      if (meta.aliases.some(v => raw.includes(String(v).toLowerCase()))) return key;
    }
    return '';
  }

  normalizeVersion(version = '') {
    return String(version || '').replace(/^v/i, '').replace(/版本/g, '').trim();
  }

  extractVersion(text = '') {
    return this.normalizeVersion(String(text).match(/(\d+\.\d+)/)?.[1] || '');
  }

  cacheKey(game, version = 'latest') {
    return `HoYoGet:gacha_pool:official:${CACHE_VER}:${game}:${this.normalizeVersion(version) || 'latest'}`;
  }

  async requestNews(game, pageSize = 30) {
    const meta = GAME_META[game];
    if (!meta) return [];
    const query = `?gids=${meta.gid}&page_size=${pageSize}&type=1`;
    const json = await requestJsonWithRetry([`${NEWS_API}${query}`, `${NEWS_API_ALT}${query}`]);
    if (json?.retcode !== 0 || !Array.isArray(json?.data?.list)) {
      throw new Error(`米游社公告接口异常：${JSON.stringify(json).slice(0, 180)}`);
    }
    return json.data.list;
  }

  async requestPostFull(game, postId = '') {
    const meta = GAME_META[game];
    if (!meta || !postId) return null;
    const url = `${POST_API}?gids=${meta.gid}&read=1&post_id=${postId}`;
    const query = url.slice(url.indexOf('?'));
    // static 域名排前面：bbs-api 那台在这条链路上长期无响应，先试能用的那个
    const json = await requestJsonWithRetry([POST_API_ALT + query, POST_API + query], { attempts: 2, timeoutMs: 8000 });
    if (json?.retcode !== 0) throw new Error(`米游社公告详情异常：${JSON.stringify(json).slice(0, 180)}`);
    return json?.data?.post?.post || null;
  }

  /** 任意米游社接口 GET：搜索接口不在固定 URL 表里，但同样需要出口地址池兜底 */
  async requestJsonUrl(url, timeoutMs = 15000) {
    return requestJsonWithRetry(url, { timeoutMs });
  }

  decodeHtml(text = '') {
    return String(text || '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  htmlToText(html = '') {
    return this.decodeHtml(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim();
  }

  cleanUpName(name = '') {
    return String(name || '')
      .replace(/[「」『』【】［］\[\]]/g, '')
      .replace(/[（(].*?[）)]/g, '')
      .replace(/^(限定|常驻)?[SA]\s*级/, '')
      .replace(/^\d星/, '')
      // 去掉「称号·名字」里的称号前缀，如「轰鸣雷鸣波·伊涅芙」→「伊涅芙」
      .replace(/^.+·(?=[\u4e00-\u9fa5])/, '')
      .trim();
  }

  pushName(list, name = '') {
    const clean = this.cleanUpName(name);
    if (clean && !list.includes(clean) && clean.length <= 20) list.push(clean);
  }

  extractQuotedNames(text = '') {
    const ret = [];
    const re = /[「『\[]([^」』\]\n]+)[」』\]]/g;
    let m;
    while ((m = re.exec(text))) this.pushName(ret, m[1]);
    return ret;
  }

  extractRankNames(text = '', rank = '5', categories = []) {
    const ret = [];
    const rankMap = { 4: '(?:4|四)', 5: '(?:5|五)', S: 'S', A: 'A' };
    const rankPart = rankMap[rank] || rank;
    const cat = categories.length ? `(?:${categories.join('|')})` : '[\\u4e00-\\u9fa5A-Za-z]*';
    // 取“5星角色/限定S级代理人/4星光锥”后，到“概率/获取概率/跃迁/祈愿/调频/。”之前的名字段。
    const re = new RegExp(`(?:限定)?${rankPart}(?:星|级)${cat}([\\s\\S]{0,260}?)(?:以及|的?(?:祈愿|跃迁|调频)?(?:获取)?概率|概率|将|，|。)`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const names = this.extractQuotedNames(m[1]);
      if (names.length) {
        for (const name of names) this.pushName(ret, name);
      } else {
        // 无引号包裹时按顿号/逗号拆分，取合理的候选名。
        for (const c of String(m[1]).split(/[,，、]/)) {
          const clean = c.replace(/[（(].*?[）)]/g, '').trim();
          if (/^[\u4e00-\u9fa5A-Za-z0-9·・•]{2,12}$/.test(clean) && !/^(概率|获取|祈愿|跃迁|调频|限时|大幅|活动|奖励|以及|和)$/.test(clean)) {
            this.pushName(ret, clean);
          }
        }
      }
    }
    return ret;
  }

  parseUpInfo(game, text = '') {
    const plain = this.htmlToText(text);
    const activeText = plain
      // 不按感叹号切句，避免把「点个关注吧！」这类道具名截断。
      .split(/(?<=。)|\n/g)
      .filter(v => /概率/.test(v) && /(提升|UP|提高|大幅|限时)/i.test(v))
      .join('。') || plain;
    const s = [];
    const a = [];
    const parseSource = (source) => {
      if (game === 'gs') {
        for (const v of this.extractRankNames(source, '5', ['角色', '武器'])) this.pushName(s, v);
        for (const v of this.extractRankNames(source, '4', ['角色', '武器'])) this.pushName(a, v);
      } else if (game === 'sr') {
        for (const v of this.extractRankNames(source, '5', ['角色', '光锥'])) this.pushName(s, v);
        for (const v of this.extractRankNames(source, '4', ['角色', '光锥'])) this.pushName(a, v);
      } else if (game === 'zzz') {
        for (const v of this.extractRankNames(source, 'S', ['代理人', '音擎'])) this.pushName(s, v);
        for (const v of this.extractRankNames(source, 'A', ['代理人', '音擎'])) this.pushName(a, v);
      } else if (game === 'bh3') {
        for (const v of this.extractRankNames(source, 'S', ['角色', '女武神', '人偶', '协同者', '武器', '圣痕'])) this.pushName(s, v);
        for (const v of this.extractRankNames(source, 'A', ['角色', '女武神', '人偶', '协同者', '武器', '圣痕'])) this.pushName(a, v);
      }
    };
    parseSource(activeText);
    // 过滤后的概率行没解析全时，再用完整正文兜底一次。
    if (activeText !== plain && (!s.length || !a.length)) parseSource(plain);
    // 原神/星铁 4 星写法多样（如「4星角色「A」「B」「C」的祈愿获取概率大幅提升」），
    // 上面的正则若漏掉 4 星，直接抓“4星角色/4星武器”所在行内的全部引号名兜底。
    if ((game === 'gs' || game === 'sr') && !a.length) {
      const line = String(plain).match(/(?:4|四)星(?:角色|武器)[^\n]{0,120}/)?.[0] || '';
      for (const n of this.extractQuotedNames(line)) this.pushName(a, n);
    }
    // 崩三补给公告的写法较散，至少把“角色补给/装备补给”里显眼的限定名抓出来。
    if (game === 'bh3' && !s.length) {
      const m = plain.match(/(?:角色补给|扩充补给|装备补给|精准补给)[\s\S]{0,80}?[「『]([^」』]+)[」』]/);
      if (m) this.pushName(s, m[1]);
    }
    return { s: s.slice(0, 6), a: a.slice(0, 8) };
  }

  async enrichRecords(game, records = []) {
    const ret = new Array(records.length);
    const CONCURRENCY = 2;
    let cursor = 0;
    // 详情接口的 retcode 1034 是「验证码」，但这条链路全程不带 Cookie/DS，是纯 IP 级限速，
    // 所以借账号过码解不开（实测裸请求 / 带 Cookie / 带 DS 三种形态结果一致）。
    // 实测触发因素是刷新密度：17 次刷新挤在 2.5 小时内会撞 120 次，而定时任务每 30 分钟
    // 均匀一次长期为 0。这里的并发与间隔是降低密度用的，熔断后剩余公告用列表摘要兜底，
    // 不连环报错、不加重限制；真正的限速与退避在 apps/gacha_pool.js 那侧统一做。
    let riskControl = false;
    const worker = async () => {
      while (cursor < records.length) {
        const idx = cursor++;
        const record = records[idx];
        if (riskControl) {
          ret[idx] = {
            ...record,
            up: this.parseUpInfo(game, record.summary || record.title || ''),
            contentText: this.htmlToText(record.summary || '')
          };
          continue;
        }
        try {
          await new Promise(r => setTimeout(r, 200 * idx));
          const full = await this.requestPostFull(game, record.postId);
          const content = full?.content || full?.structured_content || record.summary || '';
          const up = this.parseUpInfo(game, content);
          let images = full?.images?.length ? full.images : record.images;
          let cover = full?.cover || record.cover || full?.images?.[0] || record.images?.[0] || '';
          // 部分游戏（原神/星铁）详情接口的 images 字段为空，但正文 HTML 里有公告 banner 图。
          if (!images?.length) {
            const raw = String(content || '');
            const fromContent = [];
            const re = /<img[^>]+src=["']([^"']+)["']/gi;
            let m;
            while ((m = re.exec(raw))) {
              const url = m[1];
              if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(url) && !fromContent.includes(url)) fromContent.push(url);
            }
            if (fromContent.length) {
              images = fromContent;
              if (!cover) cover = fromContent[0];
            }
          }
          ret[idx] = {
            ...record,
            contentText: this.htmlToText(content).slice(0, 3000),
            up,
            images,
            cover
          };
        } catch (err) {
          // 1034 = 米游社要求验证码（IP 级限速）：熔断剩余请求，避免连环失败继续加热
          if (/retcode.?[:=]?\s*"?1034/i.test(String(err?.message || err))) {
            riskControl = true;
            logger.warn(`[HoYoGet][gacha_pool] ${GAME_META[game]?.name || game} 详情接口触发风控(1034)，本次剩余公告用摘要兜底`);
          } else {
            logger.warn(`[HoYoGet][gacha_pool] ${GAME_META[game]?.name || game} 公告详情拉取失败，已回退公告摘要:`, record.title, err?.message || err);
          }
          // 详情接口失败时也保留正文文本，避免下游把 contentText 误判为“公告正文为空”
          ret[idx] = {
            ...record,
            up: this.parseUpInfo(game, record.summary || record.title || ''),
            contentText: this.htmlToText(record.summary || '')
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, records.length) }, worker));
    this.lastRiskControl = riskControl;
    return ret.filter(Boolean);
  }

  toRecord(game, item = {}) {
    const meta = GAME_META[game];
    const post = item.post || {};
    const images = [];
    for (const img of item.image_list || []) {
      if (img?.url) images.push(img.url);
    }
    for (const img of post.images || []) {
      if (img && !images.includes(img)) images.push(img);
    }
    const cover = item.cover?.url || post.cover || images[0] || '';
    return {
      game,
      gameName: meta?.name || game,
      source: '米游社官方公告',
      title: post.subject || '',
      version: this.extractVersion(post.subject || ''),
      postId: post.post_id || '',
      createdAt: post.created_at ? Number(post.created_at) * 1000 : 0,
      url: this.postUrl(game, post.post_id),
      cover,
      images,
      summary: post.summary || ''
    };
  }

  postUrl(game, postId) {
    const pathMap = { gs: 'ys', sr: 'sr', zzz: 'zzz', bh3: 'bh3' };
    return postId ? `https://www.miyoushe.com/${pathMap[game] || 'ys'}/article/${postId}` : '';
  }

  filterRecords(game, items = [], version = '') {
    const meta = GAME_META[game];
    const ver = this.normalizeVersion(version);
    return items
      .map(v => this.toRecord(game, v))
      .filter(v => {
        const title = v.title || '';
        if (!meta.keywords.test(title)) return false;
        // 标题本身已命中「跃迁」类关键词时，即使含「说明」也保留（如联动跃迁说明）。
        if (meta.exclude.test(title) && !/(跃迁|补给)/.test(title)) return false;
        if (ver && !title.includes(ver)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async fetch(game, { version = '', force = false } = {}) {
    const meta = GAME_META[game];
    if (!meta) return { game, records: [], error: '未知游戏' };
    const ver = this.normalizeVersion(version);
    const key = this.cacheKey(game, ver || 'latest');
    if (!force) {
      const cache = await redis.get(key);
      if (cache) {
        try {
          return { game, records: JSON.parse(cache), cache: true };
        } catch (_) {
          await redis.del(key);
        }
      }
    }
    try {
      const items = await this.requestNews(game);
      let records = this.filterRecords(game, items, ver);
      // 指定版本时，当前 30 条没筛到就扩大一点范围再试。
      if (ver && !records.length) {
        const more = await this.requestNews(game, 80);
        records = this.filterRecords(game, more, ver);
      }
      // 详情接口需要逐条请求；当前卡池只展示靠前公告，限制数量避免首次查询卡太久。
      records = await this.enrichRecords(game, records.slice(0, 16));
      const riskHit = this.lastRiskControl === true;
      this.lastRiskControl = false;
      // 风控期间详情全挂、数据残缺：若已有可用缓存，直接返回缓存，避免残缺数据覆盖好数据；
      // 没有缓存时也要带上 riskControl 标记，让调用方跳过本地库同步（残缺数据不能写库）。
      if (riskHit) {
        const old = await redis.get(key);
        let oldRecords = null;
        try { oldRecords = JSON.parse(old); } catch (_) {}
        if (Array.isArray(oldRecords) && oldRecords.length) {
          logger.warn(`[HoYoGet][gacha_pool] ${meta.name} 详情接口风控(1034)，使用缓存公告数据`);
          return { game, records: oldRecords, cache: true, riskControl: true };
        }
        return { game, records, cache: false, riskControl: true };
      }
      // 无版本查询（当前卡池/刷新）时，补齐已滚出最新列表的固定公告（如「Fate[UBW] 联动跃迁说明」），
      // 供卡池背景选图使用；版本查询不做补源，避免混入无关公告。
      if (!ver && !riskHit) {
        for (const pinned of meta.pinnedPosts || []) {
          if (records.some(r => String(r.postId) === String(pinned.postId))) continue;
          try {
            const full = await this.requestPostFull(game, pinned.postId);
            if (full) {
              const extra = await this.enrichRecords(game, [{
                game,
                gameName: meta?.name || game,
                source: '米游社官方公告',
                title: full.subject || '',
                version: this.extractVersion(full.subject || ''),
                postId: full.post_id || pinned.postId,
                createdAt: full.created_at ? Number(full.created_at) * 1000 : 0,
                url: this.postUrl(game, full.post_id),
                cover: '',
                images: full.images || [],
                summary: full.summary || ''
              }]);
              if (extra[0]) records.push(extra[0]);
            }
          } catch (err) {
            logger.warn(`[HoYoGet][gacha_pool] ${meta.name} 固定公告补拉失败:`, pinned.postId, err.message);
          }
        }
        records.sort((a, b) => b.createdAt - a.createdAt);
      }
      await redis.set(key, JSON.stringify(records), { EX: CACHE_TTL });
      return { game, records, cache: false };
    } catch (err) {
      const cache = await redis.get(key);
      if (cache) {
        try {
          return { game, records: JSON.parse(cache), cache: true, error: err.message };
        } catch (_) {}
      }
      logger.warn(`[HoYoGet][gacha_pool] ${meta.name} 米游社卡池公告获取失败:`, err);
      return { game, records: [], error: err.message || String(err) };
    }
  }

  async refreshAll() {
    const ret = [];
    for (const game of Object.keys(GAME_META)) {
      ret.push(await this.fetch(game, { force: true }));
    }
    return ret;
  }

  async fetchAll() {
    const ret = [];
    for (const game of Object.keys(GAME_META)) {
      ret.push(await this.fetch(game));
    }
    return ret;
  }
}

export default new OfficialGachaPool();
