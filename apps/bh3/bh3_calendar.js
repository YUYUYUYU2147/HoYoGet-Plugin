import fs from 'fs';
import YAML from 'yaml';
import fetch from 'node-fetch';
import moment from 'moment';
import { render, pluginPriority } from '#HoYoGet';

const NEWS_API = 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?gids=1&page_size=80&type=1';
const POST_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull?gids=1&read=1&post_id=';
const CACHE_KEY = 'xhh:bh3:calendar:v6';
const BH3_ICON_DIR = './plugins/HoYoGet-Plugin/data/bh3_gacha/icons';
/** 补给名段里「通用描述」不算名字（装备补给 / 角色补给 / 服装补给…） */
const BH3_GENERIC_SEG = /^(装备补给|角色补给|服装补给|主题补给|协同补给|协同者补给|精确补给|精准补给|跃升补给|扩充补给|补给|限时开启|开启)?$/;

function isBh3NameSegment(seg = '') {
  const s = String(seg || '').trim();
  if (!s) return false;
  if (BH3_GENERIC_SEG.test(s)) return false;
  // 只剩类型描述（去掉「限时开启」之类后为空）也不算
  const core = s.replace(/限时开启[!！]*$/, '').replace(/主题补给$/, '').trim();
  if (!core || BH3_GENERIC_SEG.test(core)) return false;
  return true;
}

/* 卡池本地库：崩三公告正文只写「>>补给信息 [图片]」，时间在官方配图里，
   正文解析不出日期；卡池库里有按「公告日→周四开池 + 补给周期」推好的准确时间，
   日历的补给条目直接复用它，保证日历和「崩三当前卡池」显示一致。 */
const BH3_POOL_HISTORY_PATH = './plugins/HoYoGet-Plugin/system/default/bh3_gacha_pool_history.yaml';
/* 官方 wiki「女武神」列表：拿装甲头像给生日用 */
const BH3_WIKI_BASE = 'https://api-takumi-static.mihoyo.com/common/blackboard/bh3_wiki/v1/home/content/list?app_sn=bh3_wiki';

/* 女武神立绘：wiki「女武神」频道（channel 18）给的是 115×116 半身立绘，
   拿来当日历行的缩略图正合适。
   立绘是远程 URL，截图时可能还没加载完（渲染出来是空白格），
   所以先缓存到 data/bh3_calendar_icons/<名字>.png，模板用本地路径。 */
const BH3_ICON_CACHE_DIR = './plugins/HoYoGet-Plugin/resources/bh3_calendar/icons';
let _bh3CharIcons = null;
async function bh3CharIcons() {
  if (_bh3CharIcons !== null) return _bh3CharIcons;
  _bh3CharIcons = {};
  try {
    const res = await fetch(`${BH3_WIKI_BASE}&channel_id=18`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    const json = await res.json();
    for (const item of json?.data?.list?.[0]?.list || []) {
      if (!item?.title || !item?.icon) continue;
      const local = await cacheBh3Icon(item.title, item.icon);
      _bh3CharIcons[item.title] = local || item.icon;
    }
  } catch (_) {}
  return _bh3CharIcons;
}

/** 下一个女武神立绘到本地，返回可直接给 <img src> 用的路径 */
async function cacheBh3Icon(name, url) {
  try {
    if (!fs.existsSync(BH3_ICON_CACHE_DIR)) fs.mkdirSync(BH3_ICON_CACHE_DIR, { recursive: true });
    const file = `${String(name).replace(/[\\/:*?"<>|]/g, '_')}.png`;
    const abs = `${BH3_ICON_CACHE_DIR}/${file}`;
    if (fs.existsSync(abs)) return `bh3_calendar_icons/${file}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 2 * 1024 * 1024) return '';
    fs.writeFileSync(abs, buf);
    return `bh3_calendar/icons/${file}`;
  } catch (_) {
    return '';
  }
}

/* 名称清洗：去掉书名号与「X之律者」的前缀差异 */
function bh3CleanName(name = '') {
  return String(name || '')
    .replace(/[\s「」『』【】（）()·・•!！♪♫♥❤☆★]/g, '')
    .replace(/^(真我|薪炎|终焉|始源|空之|理之|雷之|识之|死生|人之|天元|月下|戒律|螺旋|黄金|繁星|无限|浮生|鏖灭|旭光|刹那|救世)之律者/g, '$1律者')
    .trim();
}

/** 在立绘表里找最接近的一条（精确 → 包含） */
function bh3FindCharIcon(icons = {}, name = '') {
  const target = bh3CleanName(name);
  if (!target) return '';
  const keys = Object.keys(icons);
  for (const k of keys) if (bh3CleanName(k) === target) return icons[k];
  for (const k of keys) {
    const c = bh3CleanName(k);
    if (c && (c.includes(target) || target.includes(c))) return icons[k];
  }
  return '';
}
// 崩三公告/活动更新较频繁；原先缓存 10 分钟会让日历看起来不像实时更新。
// 保留 60 秒短缓存，避免同一分钟内重复请求米游社过多。
const CACHE_TTL = 60;

const ignoreReg = /(封禁|外挂|账号交易|公平运营|问题修复|已知问题|维护通知|更新说明|防沉迷|客服|开奖|名单|问卷|壁纸)/;
const timeTitleReg = /(开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)/;

// 女武神生日表（月-日 → 角色名），来源：米游社「崩坏3角色生日整理」帖 39681618，
// 并与百度百科「崩坏3角色生日表」交叉核对。观测枢详情接口没有生日字段，故用静态表；
// 第二部新角色（希娜狄雅/科拉莉/赫丽娅/松雀等）暂无可靠公开数据，后续确认后直接在此补行即可。
/* 爱酱（崩坏3 官方叫「爱衣Λ」）是特殊角色/拟态，不是女武神装甲，
   官方 wiki 装甲列表里没有它，头像用官方「爱衣Λ信箱」公告图裁出来的形象。 */
const BH3_AIYI_AVATAR = 'bh3_calendar/aiyi.png';

/* 生日表里的角色名 → 官方 wiki 角色列表里的代表装甲（头像从女武神列表取）。
   崩三 wiki 只收「装甲名」，没有「琪亚娜」这种角色本名，必须显式映射。 */
const BIRTHDAY_VALK = {
  '琪亚娜': '白骑士·月光',
  '芽衣': '雷电女王的鬼铠',
  '布洛妮娅': '次元边界突破',
  '德丽莎': '女武神·誓约',
  '希儿': '魇夜星渊',
  '符华': '影骑士·月轮',
  '姬子': '真炎幸魂',
  '八重樱': '逆神巫女',
  '卡莲': '黯蔷薇',
  '丽塔': '失落迷迭',
  '幽兰黛尔': '天元骑英',
  '西琳': '空之律者',
  '爱莉希雅': '真我·人之律者',
  '格蕾修': '繁星·绘世之卷',
  '塞西莉娅': '圣女祈祷',
  '苏莎娜': '女武神·荣光',
  '卡罗尔': '女武神·热砂',
  '时雨绮罗': '糖露星霜',
  '阿波尼亚': '戒律·深罪之槛',
  '维尔薇': '螺旋·愚戏之匣',
  '梅比乌斯': '无限·噬界之蛇',
  '李素裳': '玉骑士·月痕',
  '爱因斯坦': '女武神·巡矢',
  '羽兔': '织羽梦旌',
  '乔伊斯': '女武神·重机',
  '伊甸': '黄金·璀耀之歌',
};

/* wiki 头像缓存（data/ 不入库）：{ 角色名: data URI } */
const BH3_AVATAR_CACHE = './plugins/HoYoGet-Plugin/data/bh3_birthday_avatars.json';

const BIRTHDAYS = {
  '1-1': ['幽兰黛尔', '乔伊斯'],
  '2-9': ['符华'],
  '2-17': ['羽兔'],
  '3-1': ['丽塔'],
  '3-14': ['爱因斯坦'],
  '3-28': ['德丽莎'],
  '4-3': ['李素裳'],
  '4-13': ['芽衣'],
  '4-30': ['梅比乌斯'],
  '5-5': ['维尔薇'],
  '5-25': ['阿波尼亚'],
  '5-29': ['卡莲'],
  '6-11': ['姬子'],
  '7-22': ['八重樱'],
  '8-18': ['布洛妮娅'],
  '9-8': ['时雨绮罗'],
  '9-23': ['卡罗尔'],
  '10-18': ['希儿'],
  '10-24': ['爱酱'],
  '10-31': ['伊甸'],
  '11-11': ['西琳', '爱莉希雅'],
  '11-29': ['苏莎娜'],
  '12-7': ['琪亚娜'],
  '12-21': ['格蕾修'],
  '12-25': ['塞西莉娅']
};

export class bh3_calendar extends plugin {
  constructor() {
    super({
      name: '[米哈游]崩三日历',
      dsc: '崩坏3活动/补给日历',
      event: 'message',
      priority: pluginPriority('bh3_calendar', -999999),
      rule: [
        { reg: '^[!！]日历$', fnc: 'calendar' },
        { reg: '^#?(崩三|崩坏3|崩坏三|BH3)(日历|日历列表)$', fnc: 'calendar' }
      ]
    });
  }

  async calendar(e) {
    try {
      // 用户主动查询日历时直接实时拉取，不读 Redis 旧缓存。
      const data = await this.getCalendarData(e, true);
      if (!data?.list?.length) return e.reply('暂未解析到崩坏3活动日历数据，请稍后再试。');
      return render('bh3_calendar/calendar', data, { e, ret: true, pct: 1.65 });
    } catch (err) {
      logger.error('[HoYoGet][bh3_calendar] 日历生成失败:', err);
      return e.reply(`崩三日历生成失败：${err?.message || err}`);
    }
  }

  async getCalendarData(e, force = false) {
    moment.locale('zh-cn');
    const now = moment();
    let cached = force ? null : await redis.get(CACHE_KEY);
    if (cached) {
      try {
        const data = JSON.parse(cached);
        data.nowTime = now.format('YYYY-MM-DD HH:mm');
        data.nowDate = now.date();
        data.nowLeft = this.getNowLeft(data.range, now);
        data.splash = this.getFixedSplash();
        return data;
      } catch (_) {}
    }

    const posts = await this.requestNews();
    const list = [];
    // 多扫一些公告，避免当前有效活动/补给被近期资讯挤出前 28 条后不显示。
    for (const item of posts.slice(0, 60)) {
      const post = item?.post || item;
      const title = this.cleanText(post.subject || post.title || '');
      if (!title || ignoreReg.test(title)) continue;
      let detail = null;
      try { detail = await this.requestPost(post.post_id); } catch (err) { logger.debug?.(`[HoYoGet][bh3_calendar] 帖子详情失败 ${post.post_id}: ${err?.message || err}`); }
      let content = this.htmlToText(detail?.content || post.content || '');
      let time = this.extractTime(content, post.created_at);
      /* 帖子详情接口的正文被截断（常停在「>>补给信息 [图片]」），
         公告里明明写着「10月16日12:00~10月30日12:00」却读不到。
         详情拿不到时间时，改走「瞬间搜索」接口 —— 它的 content 更完整，
         能拿到准确的开放时间区间。 */
      if (!time?.end) {
        const full = await this.fetchInstantContent(title);
        if (full) {
          time = this.extractTime(full, post.created_at);
          if (time?.end) content = full;
        }
      }
      // 已结束的直接不要，别让它们占坑后被裁成窄条堆在日历左上角
      if (!time || !time.end.isAfter(now)) continue;
      const banner = item?.image_list?.[0]?.url || post.cover || post.images?.[0] || '';
      list.push({
        id: post.post_id,
        title: title.replace(/^【[^】]+】/, ''),
        rawTitle: title,
        type: this.getType(title),
        typeName: this.getTypeName(title),
        start: time.start.format('MM-DD HH:mm'),
        end: time.end.format('MM-DD HH:mm'),
        startFull: time.start.format('YYYY-MM-DD HH:mm'),
        endFull: time.end.format('YYYY-MM-DD HH:mm'),
        leftTime: this.leftLabel(now, time.start, time.end),
        banner
      });
      if (list.length >= 18) break;
    }
    /* 官方公告列表接口固定只返回 20 条（page_size 无效、无分页），
       09-21 那批「镜见之钥 / 时序之律者」直接被漏掉，日历里就没这两个池子。
       这里用卡池库做补充：把库里当前有效的补给都补进列表，
       公告列表有的条目按原样保留（时间/封面更准），库里多出来的补上。 */
    this.fillMissingSupplyPools(list, now);
    // 补给/服装的时间改用卡池库（公告正文拿不到准确日期），与「崩三当前卡池」保持一致
    this.applyBh3PoolTimes(list);
    // 给每条补上立绘：优先用卡池库里的 UP 名去 wiki 女武神列表匹配
    {
      const icons = await bh3CharIcons();
      if (Object.keys(icons).length) {
        const poolNames = this.loadBh3PoolNames();
        for (const item of list) {
          const title = String(item.title || '');
          // 从「【补给】名称丨类型」里取名字段
          const segs = title.replace(/^【[^】]*】/, '').split(/[丨｜|]/).map(x => x.replace(/[「」『』]/g, '').trim()).filter(Boolean);
          let icon = '';
          for (const seg of segs) {
            const hit = bh3FindCharIcon(icons, seg) || bh3FindCharIcon(icons, seg.replace(/主题补给.*$/, '').trim());
            if (hit) { icon = hit; break; }
          }
          if (!icon) {
            for (const nm of poolNames) {
              if (!title.includes(nm)) continue;
              const hit = bh3FindCharIcon(icons, nm);
              if (hit) { icon = hit; break; }
            }
          }
          if (icon) item.icon = icon;
        }
      }
    }

    /* 与米哈游三游戏日历同一套甘特模板：今天前后各 7 天，条带按起止铺开 */
    const winStart = now.clone().startOf('day').subtract(7, 'days');
    const winEnd = winStart.clone().add(14, 'days');
    const windowMs = winEnd.valueOf() - winStart.valueOf();
    const calList = list
      .map(i => ({ ...i, startM: moment(i.startFull, 'YYYY-MM-DD HH:mm'), endM: moment(i.endFull, 'YYYY-MM-DD HH:mm') }))
      .filter(i => i.startM.isValid() && i.endM.isValid())
      .filter(i => i.endM.isAfter(now) && i.endM.isAfter(winStart) && i.startM.isBefore(winEnd))
      .sort((a, b) => a.startM - b.startM)
      .slice(0, 24)
      .map(item => {
        const started = item.startM.isSameOrBefore(now);
        const s = item.startM.isAfter(winStart) ? item.startM : winStart;
        const e = item.endM.isBefore(winEnd) ? item.endM : winEnd;
        const left = Math.max(0, Math.min(100, (s.valueOf() - winStart.valueOf()) / windowMs * 100));
        const width = Math.max(0.6, Math.min(100 - left, (e.valueOf() - s.valueOf()) / windowMs * 100));
        const kind = { supply: 'gacha', outfit: 'shop', event: 'event', normal: 'event' }[item.type] || 'event';
        return {
          title: item.title,
          startAbs: item.startM.clone(),
          kind,
          kindLabel: item.typeName,
          startText: item.startM.format('M/D HH:mm'),
          endText: item.endM.format('M/D HH:mm'),
          status: started ? '进行中' : '即将开始',
          statusClass: started ? 'on' : 'soon',
          left: left.toFixed(2),
          width: width.toFixed(2),
          clipLeft: item.startM.isBefore(winStart),
          clipRight: item.endM.isAfter(winEnd),
          barText: this.leftLabel(now, item.startM, item.endM),
          srcBanner: item.banner || '',
        };
      });

    /* 大事件：补给 / 服装，按开放日打点，同类同日去重 */
    const mk = (kind, label) => ({ kind, kindLabel: label, seen: new Set() });
    const groups = [mk('gacha', '补给'), mk('shop', '服装')].filter(g => calList.some(a => a.kind === g.kind));
    const markList = [];
    for (const g of groups) {
      for (const a of calList) {
        if (a.kind !== g.kind) continue;
        const day = Math.max(0, Math.min(13, a.startAbs.clone().startOf('day').diff(winStart, 'days')));
        if (g.seen.has(day)) continue;
        g.seen.add(day);
        markList.push({
          kind: g.kind,
          kindLabel: g.kindLabel,
          day: a.startAbs.format('M/D'),
          short: a.title.replace(/^[「【]|」$|】$/g, '').slice(0, 12),
          title: a.title,
          pos: ((day + 0.5) / 14 * 100).toFixed(2),
          abs: a.startAbs.valueOf(),
        });
      }
    }
    markList.sort((x, y) => x.abs - y.abs);

    /* 生日头像：本地缓存没有的，按需从官方 wiki 补一次（失败不影响日历） */
    const birthdayData = this.getBirthdays(now);
    try {
      await this.fillBirthdayAvatars(birthdayData.flatMap(b => b.people.map(p => p.name)));
      for (const b of birthdayData) {
        for (const p of b.people) if (!p.avatar) p.avatar = this.birthdayAvatar(p.name);
      }
    } catch (_) {}

    const data = {
      game: 'bh3',
      gameCn: '崩坏3',
      title: '崩坏3大事件日历',
      subtitle: '数据来源：米游社官方公告',
      nowText: now.format('YYYY-MM-DD HH:mm'),
      nowDate: now.date(),
      dateList: this.getDateList(winStart),
      birthdays: birthdayData,
      range: { start: winStart.format('YYYY-MM-DD HH:mm:ss'), end: winEnd.format('YYYY-MM-DD HH:mm:ss') },
      nowLeft: this.getNowLeft({ start: winStart.format('YYYY-MM-DD HH:mm:ss'), end: winEnd.format('YYYY-MM-DD HH:mm:ss') }, now),
      list: calList,
      markList,
      marks: markList.length,
      nowPos: (26 + 74 * (this.getNowLeft({ start: winStart.format('YYYY-MM-DD HH:mm:ss'), end: winEnd.format('YYYY-MM-DD HH:mm:ss') }, now) / 100)).toFixed(2),
      rawCount: list.length,
      splash: this.getFixedSplash()
    };
    await redis.set(CACHE_KEY, JSON.stringify(data), { EX: CACHE_TTL });
    return data;
  }


  getFixedSplash() {
    const dir = './plugins/HoYoGet-Plugin/resources/gacha_pool/fixed_splash/崩坏3';
    try {
      if (!fs.existsSync(dir)) return '';
      const files = fs.readdirSync(dir)
        .filter(f => /\.(png|webp|jpg|jpeg)$/i.test(f))
        .filter(f => {
          try { return fs.statSync(`${dir}/${f}`).isFile(); } catch (_) { return false; }
        });
      if (!files.length) return '';
      const file = files[Math.floor(Math.random() * files.length)];
      return `gacha_pool/fixed_splash/崩坏3/${file}`;
    } catch (_) {
      return '';
    }
  }

  async requestNews() {
    const res = await fetch(NEWS_API, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`米游社列表 HTTP ${res.status}`);
    const json = await res.json();
    if (json?.retcode !== 0 || !Array.isArray(json?.data?.list)) throw new Error(`米游社列表异常：${json?.message || json?.retcode}`);
    return json.data.list;
  }

  async requestPost(postId) {
    if (!postId) return null;
    const res = await fetch(POST_API + postId, { headers: this.headers(postId), signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`帖子详情 HTTP ${res.status}`);
    const json = await res.json();
    if (json?.retcode !== 0) throw new Error(`帖子详情异常：${json?.message || json?.retcode}`);
    return json?.data?.post?.post || null;
  }

  headers(postId = '') {
    return {
      Referer: postId ? `https://www.miyoushe.com/bh3/article/${postId}` : 'https://www.miyoushe.com/bh3',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    };
  }

  cleanText(text = '') {
    return String(text || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
  }

  htmlToText(html = '') {
    return this.cleanText(String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim();
  }

  extractTime(text = '', createdAt = 0) {
    text = String(text || '').replace(/\s+/g, ' ');
    const year = moment.unix(Number(createdAt) || moment().unix()).year();
    const versionAfter = text.match(/(\d+\.\d+)版本更新后\s*[~～至\-—]+\s*(?:(20\d{2})[年\/-])?([0-9]{1,2})月([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/);
    if (versionAfter) {
      const s = this.getVersionStart(versionAfter[1], createdAt);
      const e = moment(`${versionAfter[2] || year}-${versionAfter[3]}-${versionAfter[4]} ${versionAfter[5]}`, 'YYYY-M-D H:mm');
      if (s.isValid() && e.isValid()) {
        if (e.isBefore(s)) e.add(1, 'year');
        return { start: s, end: e };
      }
    }
    const regs = [
      /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{4})[年\/-]([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})(?:[:0-9]*)?\s*[~～至\-—]+\s*(?:([0-9]{4})[年\/-])?([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/,
      /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
      /([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/
    ];
    for (const reg of regs) {
      const m = text.match(reg);
      if (!m) continue;
      let s, e;
      if (m.length >= 9 && m[1]?.length === 4) {
        s = moment(`${m[1]}-${m[2]}-${m[3]} ${m[4]}`, 'YYYY-M-D H:mm');
        e = moment(`${m[5] || m[1]}-${m[6]}-${m[7]} ${m[8]}`, 'YYYY-M-D H:mm');
      } else {
        const offset = timeTitleReg.test(text.slice(Math.max(0, m.index - 30), m.index + 30)) ? 0 : 0;
        s = moment(`${year}-${m[1 + offset]}-${m[2 + offset]} ${m[3 + offset]}`, 'YYYY-M-D H:mm');
        e = moment(`${year}-${m[4 + offset]}-${m[5 + offset]} ${m[6 + offset]}`, 'YYYY-M-D H:mm');
      }
      if (!s.isValid() || !e.isValid()) continue;
      if (e.isBefore(s)) e.add(1, 'year');
      return { start: s, end: e };
    }
    return null;
  }

  getVersionStart(version = '', createdAt = 0) {
    // 优先读卡池同步自动抓取的版本更新时间（#刷新卡池 写入的 bh3_version_start.json），
    // 读不到时用下方种子表兜底；不跨文件 import，避免模块加载失败拖垮插件。
    const raw = String(version ?? '').trim();
    const num = Number(raw);
    const keys = [raw, Number.isNaN(num) ? '' : num.toFixed(1)];
    let auto = {};
    try {
      auto = JSON.parse(fs.readFileSync('./plugins/HoYoGet-Plugin/system/default/bh3_version_start.json', 'utf-8'));
    } catch (_) {
      auto = {};
    }
    const seed = { '9.0': '2026-07-23 11:00' };
    for (const k of keys) {
      if (!k) continue;
      const val = (auto && auto[k]) || seed[k];
      if (!val) continue;
      const m = moment(String(val).replace(/-/g, '/'), 'YYYY/MM/DD HH:mm');
      if (m.isValid()) return m;
    }
    const base = moment.unix(Number(createdAt) || moment().unix());
    // 兜底：没有维护结束时间时，按公告发布日期 11:00 作为版本更新后起点。
    return base.hour(11).minute(0).second(0).millisecond(0);
  }

  getType(title = '') {
    if (/补给|扩充|精准|跃升|协同/.test(title)) return 'supply';
    if (/服装|皮肤|时装/.test(title)) return 'outfit';
    if (/登录|水晶|福利|活动|挑战|关卡|作战|复刻/.test(title)) return 'event';
    return 'normal';
  }

  getTypeName(title = '') {
    const type = this.getType(title);
    return { supply: '补给', outfit: '服装', event: '活动', normal: '公告' }[type];
  }

  getRange(now) {
    // 日历默认展示“今天起”的当前/未来活动；不再把昨天已结束的补给挤在最前面。
    return { start: now.clone().startOf('day'), end: now.clone().startOf('day').add(16, 'days').endOf('day') };
  }

  // 近期生日：日历只显示17天，窗口卡得巧就一个生日都看不到，这里单独列未来45天的
  /**
   * 载入卡池库里的补给时间，按「UP 名 / 补给名」建索引。
   * @returns {Map<string, {start:string, end:string, name:string}>}
   */
  loadBh3PoolTimes() {
    const map = new Map();
    try {
      if (!fs.existsSync(BH3_POOL_HISTORY_PATH)) return map;
      const data = YAML.parse(fs.readFileSync(BH3_POOL_HISTORY_PATH, 'utf-8'));
      /* 库里的版本是从新到旧排的，同名补给（如 8.9 与 9.1 都有「垂曦净蕊」）
         要用**最新版本**那条，所以先写入的优先、后来的不覆盖。 */
      for (const vp of data?.pools || []) {
        for (const p of vp.pools || []) {
          if (!p.start || !p.end) continue;
          const item = { start: p.start, end: p.end, name: p.s || p.name || '' };
          /* 只用补给自身的 UP 名建索引，不要把 target（配套角色）也当 key：
             「垂曦净蕊」的装备池 target 是「愈生佑翎」，
             用 target 建 key 会让角色池和装备池互相串台。 */
          if (p.s) map.set(String(p.s).trim(), item);
          /* 补给名格式：「【补给】<主体名>丨<类型>」。
             主体名取「丨」**前**一段（银雪与梦的公主 / 时序之律者），
             取后一段会拿到「服装补给限时开启！」这种类型描述，匹配全错。 */
          /* 补给名两种写法都有：
             「【补给】垂曦净蕊&花愈朝夕丨装备补给」（名称在前）
             「【补给】装备补给丨垂曦净蕊&花愈朝夕」（类型在前）
             所以「丨」前后两段都作为候选 key（去掉书名号与「主题补给」后缀）。 */
          /* 补给名两种写法都有：
             「【补给】垂曦净蕊&花愈朝夕丨装备补给」（名称在前）
             「【补给】装备补给丨垂曦净蕊&花愈朝夕」（类型在前）
             「丨」前后两段都作为候选，但**通用描述段要排除**
             （「装备补给」「服装补给限时开启！」这类段会命中别的池）。 */
          const raw = String(p.name || '').replace(/^【[^】]*】/, '');
          const segs = raw.split(/[丨｜|]/).map(x => x.replace(/[「」『』]/g, '').trim()).filter(Boolean);
          for (const seg of segs) {
            if (!isBh3NameSegment(seg)) continue;
            if (!map.has(seg)) map.set(seg, item);
            const theme = seg.replace(/主题补给.*$/, '').trim();
            if (theme && theme !== seg && !map.has(theme)) map.set(theme, item);
          }
        }
      }
    } catch (_) {}
    return map;
  }

  /**
   * 用「瞬间搜索」接口取公告正文（比帖子详情接口完整）。
   * 关键词用公告标题里的「丨」前那段主体名。
   */
  async fetchInstantContent(title = '') {
    const raw = String(title || '').replace(/^【[^】]*】/, '');
    const kw = (raw.split(/[丨｜|]/)[0] || '').replace(/[「」『』]/g, '').trim();
    if (!kw || kw.length > 20) return '';
    try {
      const url = 'https://bbs-api.miyoushe.com/painter/api/user_instant/search/list?keyword=' +
        encodeURIComponent(kw) + '&uid=73565430&size=20&offset=0&sort_type=2';
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
      if (!res.ok) return '';
      const json = await res.json();
      for (const it of json?.data?.list || []) {
        const p = it?.post?.post || it?.post || {};
        const t = String(p.subject || '');
        if (!t.includes(kw)) continue;
        if (!/补给|服装|公告/.test(t)) continue;
        const body = String(p.content || '');
        if (/开放时间|活动时间/.test(body)) return body;
      }
    } catch (_) {}
    return '';
  }

  /** 卡池库里所有补给/服装的名字（用于按名字匹配立绘） */
  loadBh3PoolNames() {
    const out = new Set();
    try {
      if (!fs.existsSync(BH3_POOL_HISTORY_PATH)) return [];
      const data = YAML.parse(fs.readFileSync(BH3_POOL_HISTORY_PATH, 'utf-8'));
      for (const vp of data?.pools || []) {
        for (const p of vp.pools || []) {
          if (p.s) out.add(String(p.s).trim());
          const raw = String(p.name || '').replace(/^【[^】]*】/, '');
          for (const seg of raw.split(/[丨｜|]/)) {
            const t = seg.replace(/[「」『』]/g, '').trim();
            if (t) out.add(t);
          }
        }
      }
    } catch (_) {}
    return [...out];
  }

  /**
   * 用卡池库补齐公告列表里缺的补给条目。
   * 公告列表只有 20 条，早一批的补给（镜见之钥/时序之律者等）会整批消失；
   * 这里把卡池库里「当前仍在进行」的补给补上，标题统一成公告的写法。
   */
  fillMissingSupplyPools(list = [], now = moment()) {
    const data = this.loadBh3PoolEntries();
    if (!data.length) return list;
    const has = new Set(list.map(i => this.normalizeSupplyTitle(i.title || '')));
    for (const p of data) {
      const end = moment(p.end, 'YYYY-MM-DD HH:mm:ss');
      const start = moment(p.start, 'YYYY-MM-DD HH:mm:ss');
      if (!end.isValid() || end.isBefore(now)) continue;
      const title = String(p.name || '').replace(/^【[^】]*】/, '');
      const key = this.normalizeSupplyTitle(title);
      if (!key || has.has(key)) continue;
      has.add(key);
      const type = /服装|时装|皮肤/.test(title) ? 'outfit'
        : /装备补给/.test(title) ? 'weapon'
          : /协同/.test(title) ? 'partner' : 'char';
      list.push({
        id: `pool:${p.s || key}`,
        title,
        rawTitle: p.name || '',
        type: type === 'weapon' || type === 'partner' ? 'supply' : type,
        typeName: { supply: '补给', outfit: '服装', event: '活动', normal: '公告' }[type === 'weapon' || type === 'partner' ? 'supply' : type] || '补给',
        start: start.isValid() ? start : now.clone(),
        end,
        startFull: start.isValid() ? start.format('YYYY-MM-DD HH:mm') : now.format('YYYY-MM-DD HH:mm'),
        endFull: end.format('YYYY-MM-DD HH:mm'),
        leftTime: this.leftLabel(now, start.isValid() ? start : now.clone(), end),
        banner: Array.isArray(p.imgs) ? (p.imgs.filter(Boolean)[0] || '') : '',
        fromPool: true,
      });
    }
    return list;
  }

  /** 标题归一：去掉类型前缀与书名号，只留主体名，用于判重 */
  normalizeSupplyTitle(title = '') {
    const segs = String(title || '').replace(/^【[^】]*】/, '')
      .split(/[丨｜|]/).map(x => x.replace(/[「」『』【】]/g, '').trim()).filter(Boolean);
    const generic = /^(装备补给|角色补给|服装补给|主题补给|协同补给|协同者补给|补给|限时开启|开启)$/;
    for (const seg of segs) {
      const core = seg.replace(/主题补给.*$/, '').replace(/限时开启[!！]*$/, '').trim();
      if (core && !generic.test(core)) return core;
    }
    return segs[0] || '';
  }

  /** 卡池库里所有带时间的补给条目 */
  loadBh3PoolEntries() {
    const out = [];
    try {
      if (!fs.existsSync(BH3_POOL_HISTORY_PATH)) return out;
      const data = YAML.parse(fs.readFileSync(BH3_POOL_HISTORY_PATH, 'utf-8'));
      for (const vp of data?.pools || []) {
        for (const p of vp.pools || []) {
          if (!p.start || !p.end) continue;
          out.push({ ...p, version: vp.version });
        }
      }
    } catch (_) {}
    return out;
  }

  /** 用卡池库里的时间覆盖日历里该补给的起止（对不上就保持公告解析的结果） */
  applyBh3PoolTimes(list = []) {
    const map = this.loadBh3PoolTimes();
    if (!map.size) return list;
    let hit = 0;
    for (const item of list) {
      if (item.type !== 'supply' && item.type !== 'outfit') continue;
      const title = String(item.title || '');
      /* 名称可能在「丨」前也可能在后，两段都试；
         必须整段完全相等才算命中 —— 早期版本做过「去掉开启/主题补给」之类的清洗，
         会把不同补给归到同一个 key，导致新池套上老池的时间。 */
      const segs = title.replace(/^【[^】]*】/, '').split(/[丨｜|]/)
        .map(x => x.replace(/[「」『』]/g, '').trim()).filter(Boolean);
      const candidates = [];
      for (const seg of segs) {
        if (!isBh3NameSegment(seg)) continue;
        candidates.push(seg);
        const theme = seg.replace(/主题补给.*$/, '').trim();
        if (theme && theme !== seg) candidates.push(theme);
      }
      const found = candidates.map(c => map.get(c)).find(Boolean);
      if (!found) continue;
      const s = moment(found.start, 'YYYY-MM-DD HH:mm:ss');
      const e = moment(found.end, 'YYYY-MM-DD HH:mm:ss');
      if (!s.isValid() || !e.isValid()) continue;
      item.start = s;
      item.end = e;
      item.startFull = found.start;
      item.endFull = found.end;
      item.leftTime = this.leftLabel(moment(), s, e);
      item.poolTimeFrom = 'local';
      hit++;
    }
    if (hit) logger.mark?.(`[HoYoGet][bh3_calendar] 复用卡池库时间 ${hit} 条`);
    return list;
  }

  /* 角色头像：优先用抽卡记录缓存的官方 wiki 立绘（data/bh3_gacha/icons/char_*.png），
     名字对不上时退回 wiki 角色列表接口，最后才只显示名字。 */
  birthdayAvatar(name = '') {
    const clean = String(name || '').trim();
    if (!clean) return '';
    // 爱酱走专属形象
    if (clean === '爱酱') return BH3_AIYI_AVATAR;
    // 1) 本地抽卡缓存里正好有这个角色立绘（最省事，但不全）
    for (const key of [clean, BIRTHDAY_VALK[clean]].filter(Boolean)) {
      try {
        const abs = `${BH3_ICON_DIR}/char_${key}.png`;
        if (fs.existsSync(abs)) return `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`;
      } catch (_) {}
    }
    // 2) 之前从 wiki 取过并缓存
    try {
      const cache = JSON.parse(fs.readFileSync(BH3_AVATAR_CACHE, 'utf8'));
      if (cache?.[clean]) return cache[clean];
    } catch (_) {}
    return '';
  }

  /** 从崩三官方 wiki「女武神」列表补齐生日头像，结果落 data/ 缓存，不重复请求 */
  async fillBirthdayAvatars(names = []) {
    const need = [...new Set((names || []).filter(n => n && !this.birthdayAvatar(n)))];
    if (!need.length) return 0;
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(BH3_AVATAR_CACHE, 'utf8')) || {}; } catch (_) { cache = {}; }
    let icons = {};
    try {
      const res = await fetch(`${BH3_WIKI_BASE}&channel_id=18`, { headers: this.headers(), signal: AbortSignal.timeout(12000) });
      const json = await res.json();
      const list = json?.data?.list?.[0]?.list || [];
      for (const it of list) if (it?.title && it?.icon) icons[it.title] = it.icon;
    } catch (_) { return 0; }
    let got = 0;
    for (const name of need) {
      const valk = BIRTHDAY_VALK[name];
      const url = valk ? icons[valk] : '';
      if (!url) continue;
      try {
        const r = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (!buf.length || buf.length > 3 * 1024 * 1024) continue;
        cache[name] = `data:image/png;base64,${buf.toString('base64')}`;
        got++;
      } catch (_) {}
    }
    if (got) {
      try { fs.writeFileSync(BH3_AVATAR_CACHE, JSON.stringify(cache), 'utf-8'); } catch (_) {}
    }
    return got;
  }

  getBirthdays(now, days = 45) {
    const out = [];
    for (let i = 0; i <= days; i++) {
      const d = now.clone().add(i, 'days');
      const names = BIRTHDAYS[`${d.month() + 1}-${d.date()}`];
      if (!names?.length) continue;
      const week = ['日', '一', '二', '三', '四', '五', '六'][d.day()];
      out.push({
        date: d.format('MM-DD'),
        week,
        names,
        people: names.map(n => ({ name: n, avatar: this.birthdayAvatar(n) })),
        days: i,
        label: i === 0 ? '今天' : `${i}天后`,
        isToday: i === 0
      });
    }
    return out.slice(0, 8);
  }

  getDateList(start, size = 14) {
    const ret = [];
    const week = ['日', '一', '二', '三', '四', '五', '六'];
    for (let i = 0; i < size; i++) {
      const d = start.clone().add(i, 'days');
      ret.push({
        md: d.format('M/D'),
        day: d.date(),
        month: d.month() + 1,
        week: week[d.day()],
        isToday: d.isSame(moment(), 'day'),
        weekend: [0, 6].includes(d.day()),
        bd: BIRTHDAYS[`${d.month() + 1}-${d.date()}`] || []
      });
    }
    return ret;
  }

  getNowLeft(range, now) {
    const s = moment(range.start);
    const e = moment(range.end);
    return Math.max(0, Math.min(100, (now - s) / (e - s) * 100));
  }

  layout(list, range, now) {
    const total = range.end - range.start;
    const rows = [];
    const items = list
      // 双保险：除了日期范围，再剔一次已结束的（缓存数据可能带着旧活动进来）
      .filter(i => moment(i.endFull).isAfter(now) && moment(i.startFull).isBefore(range.end))
      .sort((a, b) => moment(a.startFull) - moment(b.startFull) || moment(a.endFull) - moment(b.endFull))
      .map(item => {
        const s = moment.max(moment(item.startFull), range.start);
        const e = moment.min(moment(item.endFull), range.end);
        const left = Math.max(0, (s - range.start) / total * 100);
        const width = Math.max(2, (e - s) / total * 100);
        let row = rows.findIndex(end => left >= end + 0.5);
        if (row < 0) { row = rows.length; rows.push(0); }
        rows[row] = left + width;
        // 窄条放不下完整标题/时间，交给 CSS 截断或隐藏，避免文字溢出压到相邻条上
        const barCls = [
          `row-${row}`, item.type,
          moment(item.startFull).isBefore(now) && moment(item.endFull).isAfter(now) ? 'active' : '',
          item.banner ? 'has-bg' : '',
          width < 16 ? 'narrow' : '',
          width < 9 ? 'tiny' : ''
        ].filter(Boolean).join(' ');
        return { ...item, left, width, row, barCls };
      });

    // CSS 只写死了 8 行的 top，活动一多（都能有 12+ 行）后面的全叠在一起。
    // 改成按实际行数压缩行高，top/高度直接内联，行数再多也画得下。
    const count = Math.max(1, rows.length);
    const pad = 14, gap = 8;
    const rowH = Math.max(30, Math.min(72, Math.floor((675 - pad * 2 - gap * (count - 1)) / count)));
    return items.map(item => ({
      ...item,
      top: pad + item.row * (rowH + gap),
      barH: rowH,
      barCls: item.barCls + (rowH < 56 ? ' slim' : ''),
    }));
  }

  leftLabel(now, start, end) {
    if (now.isBefore(start)) return `${start.from(now, true)}后开始`;
    if (now.isBefore(end)) return `${end.from(now, true)}后结束`;
    return '已结束';
  }
}
