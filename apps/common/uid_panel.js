/**
 * 多游戏 UID 列表展示与序号切换。
 *
 * #uid 展示四款游戏，星铁、绝区零和崩坏3命令只保留对应分组。
 * 列表超过阈值时使用网格排版，所有序号沿用各游戏账号列表的顺序。
 *
 * 昵称、等级和头像只从本地角色缓存补全，不在显示 UID 时发起资料请求。
 * 角色缓存缺失时保留 UID 并显示暂无数据状态，同时附上本插件的面板更新命令。
 * !uid 走崩三自己的入口，!uid1 这类序号切换写 redis 的 HoYoGet:bh3_uid / HoYoGet:bh3_region。
 * 未安装 genshin 插件时，另外三游戏的 #uidN / *uidN / %uidN 也由本面板接管，
 * 切换结果写 redis 的 HoYoGet:cur_uid:<game>:<qq>，内置 NoteUser 读取该键决定当前 uid；
 * 装了 genshin 时这三个前缀仍交还 genshin，行为与之前一致。
 */
import { pluginPriority, mhy } from '#HoYoGet';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { getBh3UidList } from '../../system/bh3_uid.js';
import { makeGenshinLoader } from '../../system/genshin_loader.js';
import { orderUidRowsByReference } from '../../system/uid_order.js';
import { selectUidGames, shouldUseUidGrid, UID_RENDER_SCALE, uidRenderViewportWidth, uidViewModeFromPrefix } from '../../system/uid_view.js';

const getNoteUser = makeGenshinLoader('model/mys/NoteUser.js', ['model/mys/NoteUser.js']);

/** 面板模板与布局都用本插件副本；卡片布局样式仍引用 genshin 的 uid-list.css，卸载 genshin 前需先拷进 resources/uid/ */
const TPL_FILE = process.cwd() + '/plugins/HoYoGet-Plugin/resources/uid/uid-list.html';
const LAYOUT_FILE = process.cwd() + '/plugins/HoYoGet-Plugin/resources/uid/layout.html';
const STOKEN_DIR = process.cwd() + '/plugins/HoYoGet-Plugin/data/Stoken/';

const GAME_LIST = [
  { key: 'gs', name: '原神', refreshCommand: '#更新面板' },
  { key: 'sr', name: '星穹铁道', refreshCommand: '*更新面板' },
  { key: 'zzz', name: '绝区零', refreshCommand: '%更新面板' },
];
const REGION_NAME_TO_SERVER = {
  天空岛: '国服',
  世界树: 'B服',
  星穹列车: '国服',
  新艾利都: '国服',
};
/** 切换uid的前缀：# 原神、* 星铁、% 绝区零、! 崩三，与模板 tips 一致 */
const UID_MARK_GAME = { '#': 'gs', '*': 'sr', '%': 'zzz', '!': 'bh3', '！': 'bh3' };

/**
 * 外部 genshin 插件是否已安装。
 * 已安装时 #uidN / *uidN / %uidN 由 genshin 处理，本插件只保留崩三的叹号入口；
 * 未安装时其他三个游戏的切换无人响应，由本面板补上。
 */
let genshinInstalled;
function hasGenshinPlugin() {
  if (genshinInstalled !== undefined) return genshinInstalled;
  try {
    genshinInstalled = fs.existsSync(process.cwd() + '/plugins/genshin/model/mys/NoteUser.js');
  } catch (err) {
    genshinInstalled = false;
  }
  return genshinInstalled;
}

const BH3_EMPTY_TIP = '未找到绑定的崩坏3账号，发送 #uid 查看其他游戏的uid';

/** miao 的 Player 只用来补本地横幅图，取不到不影响面板本身 */
let playerApi;
async function getPlayer() {
  if (playerApi !== undefined) return playerApi;
  playerApi = false;
  const candidates = ["#miao.models", "../../../miao-plugin/models/index.js"];
  for (const path of candidates) {
    try {
      const mod = await import(path);
      const Player = mod.Player || (mod.default && mod.default.Player);
      if (Player) {
        playerApi = Player;
        break;
      }
    } catch (err) {
      continue;
    }
  }
  return playerApi;
}

/** 崩三绑定列表缓存：重复读本地 Stoken 与 Redis 没有必要 */
const bh3Cache = new Map();
const BH3_CACHE_TTL = 60 * 1000;
async function loadBh3(e, qq, force) {
  const key = String(qq || '');
  const hit = bh3Cache.get(key);
  if (!force && hit && Date.now() - hit.ts < BH3_CACHE_TTL) return hit.data;
  const data = await getBh3UidList(e, qq);
  bh3Cache.set(key, { ts: Date.now(), data });
  if (bh3Cache.size > 500) bh3Cache.clear();
  return data;
}

/** 头像缓存：先复用本进程命中，再读已有的 Redis 头像/昵称缓存 */
const profileCache = new Map();
const PROFILE_TTL = 30 * 60 * 1000;
const PROFILE_BAD_TTL = 3 * 60 * 1000;

function readProfile(game, uid) {
  const key = `${game}:${uid}`;
  const hit = profileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts >= hit.ttl) {
    profileCache.delete(key);
    return null;
  }
  return hit.url;
}

function saveProfile(game, uid, url) {
  profileCache.set(`${game}:${uid}`, {
    ts: Date.now(),
    url: url || '',
    ttl: url ? PROFILE_TTL : PROFILE_BAD_TTL,
  });
  if (profileCache.size > 1000) profileCache.clear();
}

/** Stoken 角色缓存：合并各 CK 的 GameRoles，供 UID 面板与体力卡片复用 */
const stokenCache = new Map();
const roleDataCache = new Map();
const STOKEN_TTL = 60 * 1000;

function readStokenFile(qq) {
  const out = { entries: {}, roles: new Map() };
  try {
    const file = STOKEN_DIR + qq + '.yaml';
    if (!fs.existsSync(file)) return out;
    const data = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
    for (const uid of Object.keys(data)) {
      if (!/^\d+$/.test(uid)) continue;
      out.entries[uid] = data[uid] || {};
    }
  } catch (err) {
    logger.debug?.('[HoYoGet][uid] 读取 Stoken 存档失败：' + (err?.message || err));
  }
  return out;
}

function loadStoken(e) {
  const qq = String(e.user_id || '');
  const hit = stokenCache.get(qq);
  if (hit && Date.now() - hit.ts < STOKEN_TTL) return hit.data;
  const data = readStokenFile(qq);
  for (const [key, role] of roleDataCache) {
    if (!key.startsWith(`${qq}:`)) continue;
    data.roles.set(key.slice(qq.length + 1), role);
  }
  stokenCache.set(qq, { ts: Date.now(), data });
  if (stokenCache.size > 500) stokenCache.clear();
  return data;
}

export function getCachedStokenRole(qq, uid) {
  const hit = stokenCache.get(String(qq || ''));
  if (!hit || Date.now() - hit.ts >= STOKEN_TTL) return null;
  return hit.data?.roles?.get(String(uid)) || null;
}

export function saveCachedStokenRole(qq, uid, role) {
  if (!qq || !uid || !role) return;
  const key = String(qq);
  const hit = stokenCache.get(key);
  const data = hit && Date.now() - hit.ts < STOKEN_TTL ? hit.data : readStokenFile(key);
  const normalized = {
    nickname: role.nickname || '',
    level: Number(role.level || 0) || 0,
  };
  data.roles.set(String(uid), normalized);
  roleDataCache.set(`${key}:${uid}`, normalized);
  if (roleDataCache.size > 2000) roleDataCache.clear();
  stokenCache.set(key, { ts: Date.now(), data });
}

function localImageUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(?:data:|https?:\/\/)/i.test(raw)) return raw;
  if (!/\.(?:png|jpe?g|webp|gif)$/i.test(raw)) return '';
  const file = path.isAbsolute(raw)
    ? raw
    : path.resolve(process.cwd(), raw.replace(/^\.\//, ''));
  try {
    if (!fs.existsSync(file)) return '';
    const ext = path.extname(file).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext];
    return mime ? `data:${mime};base64,${fs.readFileSync(file).toString('base64')}` : '';
  } catch {
    return '';
  }
}

function profileFromCache(data, readGameAvatar = false) {
  for (const row of [data?.role_info, data?.player_info, data?.player, data?.user, data]) {
    if (!row || typeof row !== 'object') continue;
    const nickname = String(row.nickname || row.name || row.nick_name || '').trim();
    const level = Number(row.level ?? row.userLevel ?? row.user_level) || 0;
    const avatar = readGameAvatar ? localImageUrl(row.gameAvatar || row.avatar || row.faceUrl) : '';
    if (nickname || level || avatar) return { nickname, level, avatar };
  }
  return { nickname: '', level: 0, avatar: '' };
}

function readLocalRoleCache(game, uid) {
  const files = [path.join(process.cwd(), 'data', 'PlayerData', game, `${uid}.json`)];
  if (game === 'zzz') {
    files.push(
      path.join(process.cwd(), 'data', 'ZZZ-Plugin', 'player', `${uid}.json`),
      path.join(process.cwd(), 'plugins', 'ZZZ-Plugin', 'data', 'player', `${uid}.json`),
      path.join(process.cwd(), 'plugins', 'HoYoGet-Plugin', 'data', 'zzz_gacha', 'zzz_plugin', 'player', `${uid}.json`),
    );
  }

  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const profile = profileFromCache(JSON.parse(fs.readFileSync(file, 'utf8')), game === 'zzz');
      if (profile.nickname || profile.level || profile.avatar) return profile;
    } catch { /* 跳过损坏或不可读的本地缓存 */ }
  }

  if (game === 'zzz') {
    const file = path.join(process.cwd(), 'data', 'NoteData', 'zzz', `${uid}.json`);
    try {
      const note = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const year of Object.values(note || {}).reverse()) {
        for (const month of Object.values(year || {}).reverse()) {
          const profile = profileFromCache(month?.role_info, true);
          if (profile.nickname || profile.level || profile.avatar) return profile;
        }
      }
    } catch { /* 没有 NoteData 缓存时继续使用占位头像 */ }
  }
  return { nickname: '', level: 0, avatar: '' };
}

/** 从绑定记录和本地角色缓存补齐显示信息，不在 #uid 时发起资料请求 */
async function fillProfiles(games, stoken, qq) {
  const Player = await getPlayer();
  const tasks = [];
  for (const game of games) {
    for (const item of game.uidList || []) tasks.push({ game, item });
  }

  for (const row of tasks) {
    const game = row.game;
    const item = row.item;
    const uid = String(item.uid || '');
    const role = stoken.roles.get(uid) || {};
    const cached = readLocalRoleCache(game.key, uid);
    const memoryAvatar = readProfile(game.key, uid);
    const entry = stoken.entries[uid] || {};
    const cookie = String(entry.ck_stoken || '');
    const hasCk = Boolean((entry.ltoken || /(?:^|;\s*)ltoken=/.test(cookie))
      && (entry.cookie_token || /(?:^|;\s*)cookie_token=/.test(cookie)));
    const hasSk = Boolean(entry.stoken || /(?:^|;\s*)stoken=/.test(cookie));
    let lastRefresh = '';
    try { lastRefresh = await redis.get(`HoYoGet:uid:ck-refresh:${qq}:${uid}`) || ''; } catch { /* 无刷新状态缓存 */ }
    item.ckLabel = lastRefresh === 'fail'
      ? 'CK失败'
      : lastRefresh === 'ok' || (hasCk && hasSk)
        ? 'CK'
        : hasCk
          ? 'CK未验'
          : '无CK';
    item.ckStatus = lastRefresh === 'fail'
      ? 'fail'
      : lastRefresh === 'ok' || (hasCk && hasSk)
        ? 'ok'
        : hasCk
          ? 'unknown'
          : 'missing';
    item.skLabel = hasSk ? 'SK' : '无SK';
    item.skStatus = hasSk ? 'ok' : 'missing';
    const regionCode = entry.region || '';
    const regionName = entry.region_name || '';
    const server = item.server || (regionCode
      ? mhy.getServerName(regionCode)
      : (REGION_NAME_TO_SERVER[regionName] || (regionName ? mhy.getServerName(regionName) : '')));
    if (server) item.server = server;
    if (!item.name) item.name = role.nickname || cached.nickname || '';
    if (!item.level) item.level = Number(role.level) || cached.level || 0;
    if (!item.faceUrl) item.faceUrl = memoryAvatar || cached.avatar || '';

    try {
      const [avatar, nickname, level] = await Promise.all([
        redis.get(`Yz:genshin:uidFaceUrl:${game.key}:${uid}`),
        item.name ? null : redis.get(`Yz:genshin:uidNickname:${game.key}:${uid}`),
        item.level ? null : redis.get(`Yz:genshin:uidLevel:${game.key}:${uid}`),
      ]);
      if (avatar) item.faceUrl = String(avatar);
      if (!item.name && nickname) item.name = String(nickname);
      if (!item.level && Number(level) > 0) item.level = Number(level);
    } catch { /* Redis 缓存不可用时继续读本地角色缓存 */ }

    const refreshed = globalThis.__hoyoGetUidProfileCache?.get(`${game.key}:${uid}`);
    if (refreshed && Date.now() - refreshed.at < 12 * 60 * 60 * 1000) {
      if (refreshed.avatar) item.faceUrl = refreshed.avatar;
      if (refreshed.nickname) item.name = refreshed.nickname;
      if (Number(refreshed.level) > 0) item.level = Number(refreshed.level);
    }

    if (game.key === 'zzz') {
      item.zzz_banner = true;
      item.zzz_face = true;
    }

    const playerFile = path.join(process.cwd(), 'data', 'PlayerData', game.key, `${uid}.json`);
    if (Player && fs.existsSync(playerFile)) {
      try {
        const player = Player.create(uid, game.key);
        if (!item.name && player?.name) item.name = player.name;
        if (!item.level && player?.level) item.level = player.level;
      } catch (err) {
        logger.debug?.(`[HoYoGet][uid] 读取 ${game.key} 本地角色缓存失败：${err?.message || err}`);
      }
    }
    if (item.faceUrl) saveProfile(game.key, uid, item.faceUrl);
    item.hasRoleData = Boolean(String(item.name || '').trim() || Number(item.level) > 0);
  }
}

/**
 * uid 列表归一化为对象数组。
 *
 * 内置 NoteUser 的 getUidList 返回字符串数组，部分版本的 genshin 返回
 * { uid, ... } 对象数组；模板与补资料逻辑统一按对象取字段，这里一次转换，
 * 两种来源都能用。
 * 角标类型：内置 NoteUser 的 getUidList 只返回 uid 字符串，没有 type 字段，
 * 模板按 type 判定角标，缺省会把扫码登录的账号全部显示成「绑定」。条目均
 * 来自持有 Cookie 的账号，这里统一补成 ck。
 */
function normalizeUidList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item && typeof item === 'object') {
      const uid = String(item.uid || item.uid_str || '').trim();
      if (uid) out.push({ type: 'ck', ...item, uid });
    } else {
      const uid = String(item ?? '').trim();
      if (uid) out.push({ uid, type: 'ck' });
    }
  }
  return out;
}

/** 崩三分组：face/banner 用占位图，模板对 zzz_face/zzz_banner 有专门分支 */
function buildBh3Group(list, current) {
  const uidList = list.map(row => ({
    uid: String(row.uid),
    type: 'ck',
    name: row.nickname || '',
    level: Number(row.level || 0),
    server: row.serverName || '',
    zzz_face: true,
    zzz_banner: true,
  }));
  return { key: 'bh3', name: '崩坏3', uid: String(current || ''), uidList };
}

/** 与 genshin showUid 的按钮保持一致 */
function buildButtons() {
  return segment.button(
    [
      { text: '绑定UID', input: '#绑定uid' },
      { text: '切换UID', input: '#uid' },
      { text: '删除UID', input: '#删除uid' },
    ],
    [
      { text: '角色', callback: '#角色' },
      { text: '更新面板', callback: '#更新面板' },
      { text: '武器', callback: '#武器' },
      { text: '深渊', callback: '#深渊' },
    ],
    [
      { text: '统计', callback: '#练度统计' },
      { text: '面板', callback: '#面板' },
      { text: '体力', callback: '#体力' },
      { text: '原石', callback: '#原石' },
    ],
    [
      { text: '留影', callback: '#留影叙佳期' },
      { text: '七圣', callback: '#七圣召唤查询牌组' },
      { text: '抽卡', callback: '#抽卡记录' },
      { text: '充值', callback: '#充值记录' },
    ],
  );
}

export class uidPanel extends plugin {
  constructor() {
    super({
      name: '[米哈游]UID面板(含崩坏3)',
      dsc: '展示多游戏UID列表，未装 genshin 时补上UID切换',
      event: 'message',
      priority: pluginPriority('uid_panel', 100),
      rule: [
        { reg: /^#(我的)?uid$/i, fnc: 'showUid' },
        { reg: /^\*uid$/i, fnc: 'showStarRailUid' },
        { reg: /^%uid$/i, fnc: 'showZzzUid' },
        { reg: /uid$/i, fnc: 'showBh3Uid' },
        { reg: /uid[0-9]{1,2}$/i, fnc: 'switchBh3' },
      ],
    });
  }

  /** 读崩三账号列表，失败只记日志，不影响后续逻辑 */
  async readBh3(force) {
    const e = this.e;
    try {
      const result = await loadBh3(e, e.at || e.user_id, force);
      if (!result?.list?.length) return result;
      try {
        const NoteUser = await getNoteUser();
        if (!NoteUser) return result;
        const user = await NoteUser.create(String(e.at || e.user_id || ''));
        return {
          ...result,
          list: orderUidRowsByReference(result.list, user?.getUidList?.('bh3')),
        };
      } catch (err) {
        logger.debug?.('[HoYoGet][uid] UID排序参考读取失败，沿用原列表顺序：' + (err?.message || err));
        return result;
      }
    } catch (err) {
      logger.warn('[HoYoGet][uid] 读取崩三账号失败：' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /** 组装四组数据并出图 */
  async replyPanel(bh3, mode = 'all') {
    const e = this.e;
    if (!e.runtime) return false;
    const NoteUser = await getNoteUser();
    if (!NoteUser) return false;
    /* NoteUser.create(e) 会把 e.user 换成 NoteUser，先留一份原对象供当前事件继续使用 */
    const originUser = e.user;
    let user = null;
    try {
      user = await NoteUser.create(e);
    } catch (err) {
      return false;
    }
    if (!user) return false;
    if (originUser) {
      try {
        e.user = originUser;
      } catch (err) {
        /* 只读就保持 NoteUser，取资料走它的 getMysUser */
      }
    }

    const allGames = GAME_LIST.map(ds => {
      const uidList = normalizeUidList(user.getUidList(ds.key));
      const rawUid = user.getUid(ds.key);
      const current = rawUid && typeof rawUid === 'object' ? rawUid.uid : rawUid;
      return {
        key: ds.key,
        name: ds.name,
        refreshCommand: ds.refreshCommand,
        uid: String(current || uidList[0]?.uid || ''),
        uidList,
      };
    });
    allGames.push(buildBh3Group(Array.isArray(bh3?.list) ? bh3.list : [], bh3?.current));
    const games = selectUidGames(allGames, mode);

    try {
      const stoken = await loadStoken(e);
      await fillProfiles(games, stoken, e.user_id);
    } catch (err) {
      logger.warn('[HoYoGet][uid] 补全玩家资料失败：' + (err?.message || err));
    }

    const qq = String(e.user_id || '');
    const senderAvatar = String(e.sender?.avatar || '');
    const qqAvatar = /^https?:\/\//i.test(senderAvatar)
      ? senderAvatar
      : /^\d{5,12}$/.test(qq) ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : '';
    for (const game of games) {
      for (const item of game.uidList || []) item.qqAvatar = qqAvatar;
    }

    const useGrid = shouldUseUidGrid(games);
    const viewportWidth = uidRenderViewportWidth(games);
    const img = await e.runtime.render(
      'genshin',
      'html/user/uid-list',
      { uids: games, bodyClass: useGrid ? 'uid-panel uid-grid' : 'uid-panel' },
      {
        retType: 'base64',
        beforeRender({ data }) {
          /* 框架在 ...data 之后才写 tplFile，模板资源与截图参数要在此处设置 */
          data.tplFile = TPL_FILE;
          data.uidRes = uidResPath(data);
          /* 绝对 file:// 前缀：相对路径依赖截图输出目录的深度，换个宿主/目录层级就容易 404
             （表现为卡片只剩底色、没有横幅背景图）。这里直接用本插件 resources/uid 的绝对地址。 */
          data.uidResAbs = pathToFileURL(path.join(process.cwd(), 'plugins/HoYoGet-Plugin/resources/uid/')).href;
          data.commonResAbs = pathToFileURL(path.join(process.cwd(), 'plugins/HoYoGet-Plugin/resources/common/')).href;
          data.elemLayout = LAYOUT_FILE;
          /* 布局里的公共样式（背景、字体）取本插件 resources/common，不依赖 miao */
          data.commonRes = String(data.uidRes || '').replace('/resources/uid/', '/resources/common/');
          data.sys = { ...data.sys, scale: `style=zoom:${UID_RENDER_SCALE}` };
          data.quality = 100;
          data.viewport = { ...data.viewport, width: viewportWidth, height: data.viewport?.height || 900 };
          return data;
        },
      },
    );
    return e.reply([img, buildButtons()]);
  }

  /** #uid：四组数据统一由本面板出图，没有崩三账号也能补全其他游戏资料 */
  async showUid() {
    if (!this.e.runtime) return false;
    const e = this.e;
    const rawText = String(e.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim()
      || (Array.isArray(e.message) ? e.message.filter(m => m.type === 'text').map(m => m.data?.text ?? m.text ?? '').join('') : '')
      || String(e.msg || '');
    const mode = uidViewModeFromPrefix(rawText[0]) || 'all';
    if (mode === 'sr' || mode === 'zzz') return this.replyPanel(null, mode);
    if (mode === 'bh3') return this.showBh3Uid();
    const bh3 = await this.readBh3(false);
    return this.replyPanel(bh3);
  }

  /** *uid：只展示星穹铁道 */
  async showStarRailUid() {
    if (!this.e.runtime) return false;
    return this.replyPanel(null, uidViewModeFromPrefix('*'));
  }

  /** %uid：只展示绝区零 */
  async showZzzUid() {
    if (!this.e.runtime) return false;
    return this.replyPanel(null, uidViewModeFromPrefix('%'));
  }

  /** !uid：崩三自己的入口 */
  async showBh3Uid() {
    /* 井号前缀归 genshin 面板，本入口只处理半角与全角叹号 */
    const e = this.e;
    const originText = String(e.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim()
      || (Array.isArray(e.message) ? e.message.filter(m => m.type === 'text').map(m => m.data?.text ?? m.text ?? '').join('') : '')
    if (!/^[!！]/.test(originText || String(e.msg || ''))) return false
    const bh3 = await this.readBh3(false);
    if (!bh3 || !bh3.list || !bh3.list.length) return this.e.reply(BH3_EMPTY_TIP);
    return this.replyPanel(bh3, 'bh3');
  }

  /** 切换uid：!uidN 归崩坏3；未装 genshin 时 #uidN / *uidN / %uidN 由本插件接管。
   * 方法名沿用 switchBh3：热重载只替换原型方法，规则表里的 fnc 改名不会生效。 */
  async switchBh3() {
    const e = this.e;
    /* 部分框架会把全角叹号归一化成井号，e.msg 区分不出前缀，改看原始消息 */
    const originText = String(e.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim()
      || (Array.isArray(e.message) ? e.message.filter(m => m.type === 'text').map(m => m.data?.text ?? m.text ?? '').join('') : '');
    const text = originText || String(e.msg || '');
    const hit = text.match(/([#*%!！])\s*uid\s*([0-9]{1,2})\s*$/i);
    if (!hit) return false;
    const game = UID_MARK_GAME[hit[1]];
    const idx = Number(hit[2]);
    if (!game) return false;
    if (!idx) return false;
    if (game === 'bh3') return this.switchBh3Index(idx);
    /* 装了 genshin 时切换仍由它响应，但本插件要把当前 UID 同步到自己的键，
       否则 #uidN 之后 HoYoGet 的抽卡更新仍读最初绑定的账号（多账号时取错 stoken）。
       只写 redis、不回复消息，交给 genshin 出面板。 */
    if (hasGenshinPlugin()) {
      await this.syncGameUid(game, idx);
      return false;
    }
    return this.switchGameUid(game, idx, uidViewModeFromPrefix(hit[1]));
  }

  /** !uidN：切换崩坏3当前查询uid，由 switchBh3 按前缀分派进来 */
  async switchBh3Index(idx) {
    const bh3 = await this.readBh3(false);
    if (!bh3?.list?.length) return this.e.reply(BH3_EMPTY_TIP);
    const row = bh3.list[idx - 1];
    if (!row) return this.e.reply('崩坏3 uid序号不存在，发送 !uid 查看可用序号');
    if (typeof redis === 'undefined') return this.e.reply('未连接缓存，暂时无法切换崩坏3 uid');
    const qq = String(this.e.at || this.e.user_id || '');
    await redis.set('HoYoGet:bh3_uid:' + qq, row.uid);
    await redis.set('HoYoGet:cur_uid:bh3:' + qq, row.uid);
    if (row.region) await redis.set('HoYoGet:bh3_region:' + qq, row.region);
    await redis.set('HoYoGet:bh3_manual:' + qq, '1');
    bh3Cache.delete(qq);
    return this.replyPanel({ list: bh3.list, current: row.uid }, 'bh3');
  }

  /** 装了 genshin 时静默同步当前 UID（只写 redis，不回复），避免抢它的面板 */
  async syncGameUid(game, idx) {
    const qq = String(this.e.at || this.e.user_id || '');
    if (typeof redis === 'undefined' || !qq) return;
    try {
      const NoteUser = await getNoteUser();
      if (!NoteUser) return;
      const user = await NoteUser.create(qq);
      const list = normalizeUidList(user?.getUidList(game));
      const row = list[idx - 1];
      if (row?.uid) await redis.set('HoYoGet:cur_uid:' + game + ':' + qq, String(row.uid));
    } catch (err) {
      logger.debug?.(`[uid_panel] 同步当前 uid 失败：${err?.message || err}`);
    }
  }

  /** #uidN / *uidN / %uidN：未装 genshin 时切换该游戏的当前 uid */
  async switchGameUid(game, idx, mode = game) {
    const e = this.e;
    const qq = String(e.at || e.user_id || '');
    if (typeof redis === 'undefined') return e.reply('未连接缓存，暂时无法切换uid');
    const NoteUser = await getNoteUser();
    if (!NoteUser) return false;
    let user = null;
    try {
      user = await NoteUser.create(qq);
    } catch (err) {
      return false;
    }
    if (!user) return false;
    const name = (GAME_LIST.find(v => v.key === game) || {}).name || game;
    const list = normalizeUidList(user.getUidList(game));
    if (!list.length) return e.reply('没有绑定' + name + '账号，发送 #uid 查看已绑定的uid');
    const row = list[idx - 1];
    if (!row) return e.reply(name + ' uid序号不存在，发送 #uid 查看可用序号');
    await redis.set('HoYoGet:cur_uid:' + game + ':' + qq, String(row.uid));
    return this.replyPanel(mode === 'all' ? await this.readBh3(false) : null, mode);
  }
}

/** 面板背景图与默认头像都在插件自己的 resources 下，不改 genshin 的任何文件 */
const UID_RES_FALLBACK = '../../../plugins/HoYoGet-Plugin/resources/uid/';

function uidResPath(data) {
  /* _miao_path 的深度跟着渲染输出目录走，直接沿用它的前缀最稳 */
  const miao = String(data?._miao_path || '');
  if (miao.indexOf('miao-plugin/resources/') >= 0) {
    return miao.replace('miao-plugin/resources/', 'HoYoGet-Plugin/resources/uid/');
  }
  /* 未装 miao 时沿用 _res_path 的前缀：两者都指向同一输出目录，深度一致 */
  const res = String(data?._res_path || '');
  if (res.indexOf('plugins/genshin/resources/') >= 0) {
    return res.replace('plugins/genshin/resources/', 'plugins/HoYoGet-Plugin/resources/uid/');
  }
  return UID_RES_FALLBACK;
}
