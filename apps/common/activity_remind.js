import fs from 'node:fs';
import moment from 'moment';
import { segment } from 'oicq';
import { yaml, config, pluginPriority } from '#HoYoGet';
import { mhyFetch } from '../../system/mhy_fetch.js';

const _path = './plugins/HoYoGet-Plugin/config/';
const cfgFile = _path + 'activity_remind.yaml';
const defaultCfg = {
  enable: false,
  hours_before: 24,
  push_image: true,
  at_mode: 'none',
  at_users: [],
  // 谁可以在群里开关活动提醒：master/owner/admin/all
  permission: 'master',
  // 通用屏蔽词 + 分游戏屏蔽词；同一游戏两者用 | 合并
  ban_words: '专题展示页|主题曲|前瞻特别节目预告|角色PV|签到福利|商城|周边|手办|有奖活动|已开奖|问卷|征集|作品展示|同人|大别野|米游币',
  ban_words_game: { gs: '', sr: '', zzz: '', bh3: '' },
  groups: { gs: [], sr: [], zzz: [], bh3: [] },
};

const gameMap = {
  gs: { name: '原神', short: '原神' },
  sr: { name: '星穹铁道', short: '星铁' },
  zzz: { name: '绝区零', short: '绝区零' },
  bh3: { name: '崩坏3', short: '崩三' },
};

const api = {
  gs: 'https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=60&uid=100000000',
  sr: 'https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&auth_appid=announcement&authkey_ver=1&bundle_id=hkrpg_cn&channel_id=1&level=70&platform=pc&region=prod_gf_cn&sdk_presentation_style=fullscreen&sdk_screen_transparent=true&sign_type=2&uid=100000000',
  zzz: 'https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnList?game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=70&platform=pc&region=prod_gf_cn&uid=12345678',
};

const BH3_NEWS_API = 'https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList?gids=1&page_size=80&type=1';
const BH3_POST_API = 'https://bbs-api.miyoushe.com/post/wapi/getPostFull?gids=1&read=1&post_id=';
const bh3IgnoreReg = /(封禁|外挂|账号交易|公平运营|问题修复|已知问题|维护通知|更新说明|防沉迷|客服|开奖|名单|问卷|壁纸)/;

function getCfg() {
  const cfg = yaml.get(cfgFile) || {};
  const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
  const banWordsGame = { ...defaultCfg.ban_words_game, ...(cfg.ban_words_game || {}) };
  return { ...defaultCfg, ...cfg, groups, ban_words_game: banWordsGame };
}

function saveCfg(cfg) {
  yaml.set(cfgFile, 'enable', !!cfg.enable);
  yaml.set(cfgFile, 'hours_before', Number(cfg.hours_before || 24));
  yaml.set(cfgFile, 'push_image', cfg.push_image !== false);
  yaml.set(cfgFile, 'at_mode', cfg.at_mode || 'none');
  yaml.set(cfgFile, 'at_users', normalizeList(cfg.at_users));
  yaml.set(cfgFile, 'permission', ['master', 'owner', 'admin', 'all'].includes(cfg.permission) ? cfg.permission : 'master');
  yaml.set(cfgFile, 'ban_words', String(cfg.ban_words || ''));
  yaml.set(cfgFile, 'ban_words_game', { ...defaultCfg.ban_words_game, ...(cfg.ban_words_game || {}) });
  yaml.set(cfgFile, 'groups', cfg.groups || defaultCfg.groups);
}

function normalizeList(value = []) {
  if (Array.isArray(value)) return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
  return [...new Set(String(value || '').split(/[,，\s]+/).map(v => v.trim()).filter(Boolean))];
}

/** 群配置既认旧的扁平数组，也认 { botId: [群号] }；统一展平成「群号」或「botId:群号」 */
function flattenGroups(value) {
  if (Array.isArray(value)) return normalizeList(value);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([botId, list]) =>
      normalizeList(list).map(gid => `${botId}:${gid}`));
  }
  return normalizeList(value);
}

/** 把推送目标拆成机器人与群号；不带机器人前缀时交给默认 Bot */
function parseTarget(entry) {
  const text = String(entry || '').trim();
  const m = text.match(/^(\d+):(\d+)$/);
  return m ? { botId: m[1], groupId: m[2] } : { botId: '', groupId: text };
}

function botIdOf(e) {
  return String(e?.self_id || e?.bot?.uin || globalThis.Bot?.uin || '');
}

function defaultBotId() {
  const bot = globalThis.Bot;
  if (bot?.uin) return String(bot.uin);
  if (bot?.self_id) return String(bot.self_id);
  if (bot && typeof bot === 'object') {
    const key = Object.keys(bot).find(id => /^\d+$/.test(id));
    if (key) return key;
  }
  return '';
}

/** 群命令写入的条目：默认机器人存纯群号，其它机器人存 botId:群号 */
function groupEntry(e, gid) {
  const botId = botIdOf(e);
  const def = defaultBotId();
  return botId && def && botId !== def ? `${botId}:${gid}` : String(gid);
}

function parseGame(msg = '') {
  if (/原神/.test(msg)) return 'gs';
  if (/星铁|星穹铁道|崩铁/.test(msg)) return 'sr';
  if (/绝区零|ZZZ/i.test(msg)) return 'zzz';
  if (/崩三|崩坏3|崩坏三|BH3/i.test(msg)) return 'bh3';
  return '';
}

function isEnableMsg(msg = '') {
  return /开启|on/i.test(msg);
}

function cleanText(text = '') {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function htmlToText(html = '') {
  return cleanText(String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parseEndTime(value) {
  if (!value) return null;
  const m = moment(String(value).replace(/\//g, '-'), ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', moment.ISO_8601], true);
  return m.isValid() ? m : null;
}

function remainText(now, end) {
  const diff = Math.max(0, end.valueOf() - now.valueOf());
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分钟`;
  return `${minutes}分钟`;
}

function inWindow(end, now, hoursBefore) {
  const diff = end.valueOf() - now.valueOf();
  return diff >= 0 && diff <= Number(hoursBefore || 24) * 3600000;
}

function banReg(cfg, game = '') {
  const parts = [String(cfg.ban_words || '').trim(), String(cfg.ban_words_game?.[game] || '').trim()].filter(Boolean);
  if (!parts.length) return null;
  try { return new RegExp(parts.join('|')); } catch (_) { return null; }
}

/** 群内开关提醒的权限：主人始终可用，其余按配置 */
function hasPermission(e, cfg) {
  if (e?.isMaster) return true;
  const need = String(cfg.permission || 'master');
  if (need === 'all') return true;
  const role = e?.sender?.role;
  if (need === 'admin') return !!(e?.isGroupAdmin || e?.isGroupOwner || role === 'admin' || role === 'owner');
  if (need === 'owner') return !!(e?.isGroupOwner || role === 'owner');
  return false;
}

let _activityAgent;
async function activityAgent() {
  if (_activityAgent !== undefined) return _activityAgent;
  const proxy = String(config().activity_proxy || '').trim();
  if (!proxy) { _activityAgent = null; return null; }
  try {
    // 可选依赖：宿主 Yunzai 通常自带，没有就退回直连
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    _activityAgent = new HttpsProxyAgent(proxy);
  } catch (err) {
    logger.warn?.(`[activity_remind] 活动请求代理不可用，改直连：${err?.message || err}`);
    _activityAgent = null;
  }
  return _activityAgent;
}

async function fetchJson(url, opt = {}) {
  const agent = await activityAgent();
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
  let res = null;
  // 429 多为短时限流：重试两次；配了 activity_proxy 时每次都走代理
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await mhyFetch(url, {
      headers,
      ...(agent ? { agent } : {}),
      signal: AbortSignal.timeout(opt.timeout || 12000),
    });
    if (res.status !== 429) break;
    if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// 生日数据：原神取自 meta-gs 的 birth，绝区零取自 nanoka 的 partner_info.birthday
let _birthdays = null
function birthdaysOf(game) {
  if (_birthdays === null) {
    try { _birthdays = JSON.parse(fs.readFileSync('./plugins/HoYoGet-Plugin/resources/calendar/birthdays.json', 'utf8')) }
    catch (_) { _birthdays = {} }
  }
  return _birthdays[game] || {}
}

// 大事件分类：卡池 / 版本 / 商店 / 常驻刷新 / 活动
export function eventKind(game, title = "") {
  const t = String(title || '');
  if (/跃迁|祈愿|赋形|频段|卡池|调频|复刻/.test(t)) return 'gacha';
  // 商城上新 / 城募 / 礼包是商店条目；「新增关卡」「无名勋礼」不是
  if (/商店|商城|城募|礼包|兑换/.test(t) || /上新/.test(t)) return 'shop';
  if (/^\s*\d+\.\d+\s*版本\s*[「【]?[^\s」】]*\s*(更新公告|更新说明|开启|上线)/.test(t)) return 'version';
  if (/模拟宇宙|货币战争|混沌回忆|虚构叙事|末日幻影|深境螺旋|周期|刷新|双倍/.test(t)) return 'reset';
  if (/生日/.test(t)) return 'birthday';
  return 'event';
}

export const KIND_META = {
  gacha: { label: '卡池', cls: 'gacha' },
  version: { label: '版本', cls: 'version' },
  shop: { label: '商店', cls: 'shop' },
  reset: { label: '刷新', cls: 'reset' },
  birthday: { label: '生日', cls: 'birthday' },
  event: { label: '活动', cls: 'event' },
};

function flattenAnnList(json, game) {
  const items = [];
  if (Array.isArray(json?.data?.list)) {
    for (const group of json.data.list) if (Array.isArray(group?.list)) items.push(...group.list);
  }
  if (Array.isArray(json?.data?.pic_list)) {
    for (const pic of json.data.pic_list) {
      if (Array.isArray(pic?.list)) items.push(...pic.list);
      if (Array.isArray(pic?.type_list)) {
        for (const type of pic.type_list) if (Array.isArray(type?.list)) items.push(...type.list);
      }
    }
  }
  return items.map(item => {
    const title = cleanText(item.title || item.subtitle || '');
    const subtitle = cleanText(item.subtitle || item.title || '');
    return {
      game,
      id: item.ann_id || item.id || title,
      kind: eventKind(game, title),
      title,
      subtitle,
      banner: item.banner || item.img || item.cover || '',
      start: parseEndTime(item.start_time),
      startText: item.start_time || '',
      end: parseEndTime(item.end_time),
      endText: item.end_time || '',
      tag: item.tag_label || item.type_label || '',
    };
  }).filter(i => i.title && i.end);
}

// 原神公告里混着大量长期/资讯类条目，日历只保留有明确起止的限时活动
const GS_CAL_IGNORE = /速览|FAQ|问答|签到|社区|内容展示页|首充|双倍|返利|重置说明|版本更新说明|更新公告|停服|维护|问卷|周边|表情包|壁纸|漫画|音频|OST|原声|预约|预下载|配置要求|防沉迷|实名|协议|隐私|封禁|处罚|外挂|客服|反馈|社区规则|创作者|直播|赛事|嘉年华|音乐会|展览|线下|网页活动|H5|测试服|招募/i;

function gsLikelyActivity(item, now) {
  const title = item.title || '';
  if (!title || GS_CAL_IGNORE.test(title) || !item.end) return false;
  // 十年/几十年后的“永久”说明不是活动
  const span = item.end.valueOf() - (item.start?.valueOf() || now);
  if (span > 400 * 864e5 && !/活动|祈愿|盛典|礼盒/.test(title)) return false;
  // “版本内容一览/机制说明”不是可参与的活动
  if (/内容一览|机制说明|版本说明|更新说明/.test(title)) return false;
  // 活动标题一般带「」或含活动/任务/祈愿/挑战等，长草条目多为“说明/一览”
  if (/说明$|合集$/.test(title) && !/活动/.test(title)) return false;
  return /活动|祈愿|挑战|任务|签到|盛典|礼盒|奖励|获取|参与|开启|限时|双倍|唤取|跃迁|频段|试炼|危战|七圣召唤|纪行|赛季|兑换/.test(title);
}

// 星铁公告同样混着周边/问卷/社媒/版本说明，日历只保留可参与的限时内容
const SR_CAL_IGNORE = /周边|手办|服饰|优惠|商城|问卷|调研|防沉迷|公平运营|社媒|聚合页|直播|赛事|音乐会|壁纸|表情包|漫画|OST|原声|测试服|招募|跃迁记录|统计上线|社区|论坛|协议|隐私|封禁|处罚|外挂|客服|反馈|更新说明|已知问题|优化|修复|预下载|配置/i;

function srLikelyActivity(item) {
  const title = item.title || '';
  if (!title || SR_CAL_IGNORE.test(title)) return false;
  if (/^《.*》.*(声明|公告)$/.test(title) && !/活动/.test(title)) return false;
  return /活动|跃迁|祈愿|卡池|挑战|试炼|商店|上新|版本|任务|奖励|获取|限时|双倍|盛典|乐园|搭配|工坊|频段|纪行|赛季|兑换|签到|联动|位面|模拟宇宙|忘却|虚构|末日|混沌|差分|货币战争/i.test(title);
}

function zzzLikelyActivity(item, tag, title) {
  if (!title) return false;
  if (/周边|手办|服饰|问卷|调研|防沉迷|公平运营|社媒|壁纸|表情包|音频|OST|测试服|招募|客服|反馈|更新说明|已知问题|预下载/i.test(title)) return false;
  return /活动公告|丽都资讯|活动/.test(tag) || /活动|调频|频段|限时|补给|签到|邀约|版本|商城|上新|任务|奖励|获取|兑换|挑战|试炼|登录|邮件/i.test(title);
}

function filterOfficialActivities(list, game) {
  const now = Date.now();
  return list.filter(item => {
    const tag = item.tag || '';
    const title = item.title || '';
    if (game === 'gs') return gsLikelyActivity(item, now);
    if (game === 'sr') return srLikelyActivity(item);
    if (game === 'zzz') return zzzLikelyActivity(item, tag, title);
    return true;
  });
}

async function getOfficialActivities(game) {
  const json = await fetchJson(api[game]);
  if (json?.retcode !== 0 && json?.retcode !== undefined) throw new Error(json?.message || json?.retcode);
  const list = flattenAnnList(json, game);
  return filterOfficialActivities(list, game);
}

async function getBh3Activities() {
  const listJson = await fetchJson(BH3_NEWS_API);
  const posts = listJson?.data?.list || [];
  const ret = [];
  // 崩三公告量较大，活动到期提醒只扫前 28 条容易被资讯/攻略挤掉，导致没有推送。
  for (const item of posts.slice(0, 60)) {
    const post = item?.post || item;
    const title = cleanText(post.subject || post.title || '');
    if (!title || bh3IgnoreReg.test(title)) continue;
    let detail = null;
    try {
      const json = await fetchJson(BH3_POST_API + post.post_id, { timeout: 10000 });
      detail = json?.data?.post?.post || null;
    } catch (_) {}
    const content = htmlToText(detail?.content || post.content || '');
    const time = extractBh3Time(content, post.created_at);
    if (!time?.end) continue;
    ret.push({
      game: 'bh3',
      id: post.post_id || title,
      title: title.replace(/^【[^】]+】/, ''),
      subtitle: title.replace(/^【[^】]+】/, ''),
      banner: item?.image_list?.[0]?.url || post.cover || post.images?.[0] || '',
      end: time.end,
      endText: time.end.format('YYYY-MM-DD HH:mm'),
      tag: '活动',
    });
  }
  return ret;
}

function extractBh3Time(text = '', createdAt = 0) {
  text = String(text || '').replace(/\s+/g, ' ');
  const year = moment.unix(Number(createdAt) || moment().unix()).year();
  const versionAfter = text.match(/(\d+\.\d+)版本更新后\s*[~～至\-—]+\s*(?:(20\d{2})[年\/-])?([0-9]{1,2})月([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/);
  if (versionAfter) {
    const s = getBh3VersionStart(versionAfter[1], createdAt);
    const e = moment(`${versionAfter[2] || year}-${versionAfter[3]}-${versionAfter[4]} ${versionAfter[5]}`, 'YYYY-M-D H:mm');
    if (s.isValid() && e.isValid()) {
      if (e.isBefore(s)) e.add(1, 'year');
      return { start: s, end: e };
    }
  }
  const regs = [
    /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{4})[年\/-]([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})(?:[:0-9]*)?\s*[~～至\-—]+\s*(?:([0-9]{4})[年\/-])?([0-9]{1,2})[月\/-]([0-9]{1,2})日?\s*([0-9]{1,2}:[0-9]{2})/,
    /(?:开放时间|活动时间|补给时间|上架时间|售卖时间|兑换时间|开启时间|期间)[：:>\s]*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
    /([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})\s*[~～至\-—]+\s*([0-9]{1,2})月([0-9]{1,2})日\s*([0-9]{1,2}:[0-9]{2})/,
  ];
  for (const reg of regs) {
    const m = text.match(reg);
    if (!m) continue;
    let s, e;
    if (m.length >= 9 && m[1]?.length === 4) {
      s = moment(`${m[1]}-${m[2]}-${m[3]} ${m[4]}`, 'YYYY-M-D H:mm');
      e = moment(`${m[5] || m[1]}-${m[6]}-${m[7]} ${m[8]}`, 'YYYY-M-D H:mm');
    } else {
      s = moment(`${year}-${m[1]}-${m[2]} ${m[3]}`, 'YYYY-M-D H:mm');
      e = moment(`${year}-${m[4]}-${m[5]} ${m[6]}`, 'YYYY-M-D H:mm');
    }
    if (!s.isValid() || !e.isValid()) continue;
    if (e.isBefore(s)) e.add(1, 'year');
    return { start: s, end: e };
  }
  return null;
}

function getBh3VersionStart(version = '', createdAt = 0) {
  const map = {
    '9.0': '2026-07-23 11:00',
  };
  if (map[version]) return moment(map[version], 'YYYY-MM-DD HH:mm');
  const base = moment.unix(Number(createdAt) || moment().unix());
  return base.hour(11).minute(0).second(0).millisecond(0);
}

async function getActivities(game) {
  if (game === 'bh3') return await getBh3Activities();
  return await getOfficialActivities(game);
}

/** 日历用：返回公告接口里的活动（含开始/结束时间），不需要 CK */
export async function getCalendarActivities(game) {
  if (game === 'bh3') return [];
  return await getOfficialActivities(game);
}

/**
 * 近 N 天角色生日（原神/绝区零有本地表，星铁暂无可靠数据）。
 * 生日是全年固定节点，不依赖公告接口；返回与活动同结构，日期为生日当天。
 */
export function getBirthdayActivities(game, days = 14, now = moment()) {
  const table = birthdaysOf(game);
  if (!table || !Object.keys(table).length) return [];
  const start = now.clone().startOf('day')
  const out = []
  const seen = new Set()
  for (let i = 0; i < days; i++) {
    const d = start.clone().add(i, 'days')
    const key = `${d.month() + 1}-${d.date()}`
    for (const [name, [m, day]] of Object.entries(table)) {
      if (`${m}-${day}` !== key || seen.has(`${key}:${name}`)) continue
      seen.add(`${key}:${name}`)
      out.push({
        game,
        id: `birthday:${key}:${name}`,
        kind: 'birthday',
        title: `${name}生日`,
        subtitle: `${name}生日`,
        banner: '',
        start: d.clone(),
        startText: d.format('YYYY-MM-DD HH:mm:ss'),
        end: d.clone().endOf('day'),
        endText: d.format('YYYY-MM-DD HH:mm:ss'),
        tag: '生日',
      })
    }
  }
  return out
}

function buildMsg(cfg, item, now) {
  const game = gameMap[item.game]?.short || item.game;
  const msg = [];
  const atMode = String(cfg.at_mode || 'none').toLowerCase();
  const atUsers = normalizeList(cfg.at_users);
  if (atMode === 'all') msg.push(segment.at('all'), '\n');
  else if (atMode === 'users') {
    for (const qq of atUsers) msg.push(segment.at(qq));
    if (atUsers.length) msg.push('\n');
  }
  msg.push(`【${game}活动即将结束通知】\n活动：${item.subtitle || item.title}\n剩余时间：${remainText(now, item.end)}\n结束时间：${item.end.format('YYYY-MM-DD HH:mm')}`);
  if (cfg.push_image !== false && item.banner) msg.push('\n', segment.image(item.banner));
  return msg;
}

async function sendGroupMsg(groupId, msg, e = null, botId = '') {
  const gid = Number(groupId) || groupId;
  const botObj = globalThis.Bot || (typeof Bot !== 'undefined' ? Bot : null) || globalThis.bot;
  // 指定了机器人就优先用对应 Bot，多机器人部署不会串号
  if (botId && botObj?.[botId]?.pickGroup) return botObj[botId].pickGroup(gid).sendMsg(msg);
  if (e?.isGroup && String(e.group_id) === String(groupId) && e.group?.sendMsg) return e.group.sendMsg(msg);
  if (botObj?.sendGroupMsg) return botObj.sendGroupMsg(gid, msg);
  if (botObj?.pickGroup) return botObj.pickGroup(gid).sendMsg(msg);
  if (e?.bot?.pickGroup) return e.bot.pickGroup(gid).sendMsg(msg);
  if (e?.pickGroup) return e.pickGroup(gid).sendMsg(msg);
  throw new Error('Bot对象不可用，无法发送群消息');
}

export class activity_remind extends plugin {
  constructor() {
    super({
      name: '[米哈游]活动到期提醒',
      dsc: '原神/星铁/绝区零/崩坏3活动到期推送',
      event: 'message',
      priority: pluginPriority('activity_remind', -1000002),
      rule: [
        { reg: '^#*(原神|星铁|星穹铁道|崩铁|绝区零|ZZZ|崩三|崩坏3|崩坏三|BH3)(开启|关闭)(到期活动|活动到期)(提醒|预警)?(推送)?$', fnc: 'toggleGame', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(开启|关闭)全部(游戏)?(到期活动|活动到期)(提醒|预警)?(推送)?$', fnc: 'toggleAll', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(?:米哈游)?(活动到期|到期活动)(提醒|预警)?状态$', fnc: 'status', priority: pluginPriority('activity_remind', -1000002) },
        { reg: '^#*(?:米哈游)?(活动到期|到期活动)(提醒|预警)?测试$', fnc: 'testPush', priority: pluginPriority('activity_remind', -1000002) },
      ],
    });
    this.task = {
      cron: '0 0 * * * *',
      name: '[米哈游]活动到期提醒检查',
      fnc: () => this.checkAndPush(),
      log: false,
    };
  }

  async toggleGame(e) {
    if (!e.isGroup) return e.reply('请在需要推送的群聊里操作');
    const game = parseGame(e.msg);
    if (!game) return false;
    const cfg = getCfg();
    if (!hasPermission(e, cfg)) return e.reply('没有开关活动提醒的权限');
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    const list = flattenGroups(groups[game]);
    const gid = String(e.group_id);
    const enable = isEnableMsg(e.msg);
    const entry = groupEntry(e, gid);
    const drop = new Set([gid, entry, `${botIdOf(e)}:${gid}`]);
    groups[game] = enable ? [...new Set([...list, entry])] : list.filter(v => !drop.has(String(v)));
    cfg.groups = groups;
    cfg.enable = Object.values(groups).some(arr => flattenGroups(arr).length);
    saveCfg(cfg);
    return e.reply(`${gameMap[game].short}活动到期提醒已${enable ? '开启' : '关闭'}${enable ? '\n如有即将到期的活动将自动推送至此' : ''}`);
  }

  async toggleAll(e) {
    if (!e.isGroup) return e.reply('请在需要推送的群聊里操作');
    const cfg = getCfg();
    if (!hasPermission(e, cfg)) return e.reply('没有开关活动提醒的权限');
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    const gid = String(e.group_id);
    const enable = isEnableMsg(e.msg);
    const entry = groupEntry(e, gid);
    const drop = new Set([gid, entry, `${botIdOf(e)}:${gid}`]);
    for (const game of Object.keys(gameMap)) {
      const list = flattenGroups(groups[game]);
      groups[game] = enable ? [...new Set([...list, entry])] : list.filter(v => !drop.has(String(v)));
    }
    cfg.groups = groups;
    cfg.enable = Object.values(groups).some(arr => flattenGroups(arr).length);
    saveCfg(cfg);
    return e.reply(`全部游戏（原神、星铁、绝区零、崩三）活动到期提醒已${enable ? '开启' : '关闭'}${enable ? '\n如有即将到期的活动将自动推送至此' : ''}`);
  }

  async status(e) {
    const cfg = getCfg();
    const lines = Object.entries(gameMap).map(([key, info]) => `${info.short}：${flattenGroups(cfg.groups?.[key]).join('、') || '未开启'}`);
    return e.reply(`活动到期提醒：${cfg.enable ? '已开启' : '未开启'}\n提前时间：${cfg.hours_before || 24}小时\n开关权限：${cfg.permission || 'master'}\n${lines.join('\n')}`);
  }

  async testPush(e) {
    if (!e.isMaster) return e.reply('仅主人可操作');
    await e.reply('开始检查四游戏活动到期提醒，请稍候...');
    return this.checkAndPush(e, true);
  }

  async checkAndPush(e = null, manual = false) {
    const cfg = getCfg();
    const groups = { ...defaultCfg.groups, ...(cfg.groups || {}) };
    if (!cfg.enable && !manual) return;
    const now = moment();
    const resultLines = [];

    for (const game of Object.keys(gameMap)) {
      const reg = banReg(cfg, game);
      const targetGroups = flattenGroups(groups[game]);
      if (!targetGroups.length && !manual) continue;
      let list = [];
      try {
        list = await getActivities(game);
      } catch (err) {
        logger.warn(`[activity_remind] 获取${gameMap[game].short}活动失败：${err?.message || err}`);
        if (manual) resultLines.push(`${gameMap[game].short}：获取失败 ${err?.message || err}`);
        continue;
      }
      list = list
        .filter(item => item.end && inWindow(item.end, now, cfg.hours_before || 24))
        .filter(item => !reg || !reg.test(item.title || '') && !reg.test(item.subtitle || ''));
      const seen = new Set();
      list = list.filter(item => {
        const k = `${item.title}|${item.end.format('YYYY-MM-DD HH:mm')}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (manual) resultLines.push(`${gameMap[game].short}：${list.length ? list.map(i => `${i.title}（剩余${remainText(now, i.end)}）`).join('、') : '暂无即将到期活动'}`);
      if (!targetGroups.length) continue;

      for (const entry of targetGroups) {
        const { botId, groupId } = parseTarget(entry);
        for (const item of list) {
          const dedup = `xhh:activity_remind:sent:${game}:${botId || 'default'}:${groupId}:${item.id}:${item.end.format('YYYYMMDDHHmm')}`;
          if (!manual && await redis.get(dedup)) continue;
          try {
            await sendGroupMsg(groupId, buildMsg(cfg, item, now), e, botId);
            await redis.set(dedup, '1', { EX: 3 * 24 * 3600 });
            logger.mark(`[activity_remind] 已推送 ${gameMap[game].short} ${item.title} -> ${groupId}`);
          } catch (err) {
            logger.warn(`[activity_remind] 推送到群 ${groupId} 失败：${err?.message || err}`);
          }
        }
      }
    }
    if (manual && e) return e.reply(`活动到期检查完成：\n${resultLines.join('\n') || '无结果'}`);
  }
}
