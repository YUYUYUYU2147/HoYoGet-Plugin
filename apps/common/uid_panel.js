/**
 * #uid / !uid 面板接管：在 genshin 原面板后追加崩坏3分组
 *
 * genshin 的 showUid 把游戏写死为 gs/sr/zzz，模板只遍历传入的 uids 数组。
 * 所以这里用更小的 priority 抢先处理 #uid，自行组装四组数据后复用 genshin 的
 * 样式与布局出图（模板副本在 resources/uid/uid-list.html，只是给崩三补了 ! 前缀）。
 *
 * 昵称、等级、头像统一在这里补全：原来的实现依赖 miao 的面板存档，没更新过面板的
 * 账号整行都会退化成「暂无uid信息」且头像退回占位图，绝区零更是从来没有资料。
 * !uid 走崩三自己的入口，!uid1 这类序号切换写 redis 的 HoYoGet:bh3_uid / HoYoGet:bh3_region。
 */
import { pluginPriority, api, mhy } from '#HoYoGet';
import fs from 'node:fs';
import YAML from 'yaml';
import { getBh3UidList } from '../../system/bh3_uid.js';
import { makeGenshinLoader } from '../../system/genshin_loader.js';
import { getRoleProfile } from '../../system/roleProfile.js';

const getNoteUser = makeGenshinLoader('model/mys/NoteUser.js', ['model/mys/NoteUser.js']);

/** 面板模板与布局都用本插件副本；卡片布局样式仍引用 genshin 的 uid-list.css，卸载 genshin 前需先拷进 resources/uid/ */
const TPL_FILE = process.cwd() + '/plugins/HoYoGet-Plugin/resources/uid/uid-list.html';
const LAYOUT_FILE = process.cwd() + '/plugins/HoYoGet-Plugin/resources/uid/layout.html';
const STOKEN_DIR = process.cwd() + '/plugins/HoYoGet-Plugin/data/Stoken/';

const GAME_LIST = [
  { key: 'gs', name: '原神' },
  { key: 'sr', name: '星穹铁道' },
  { key: 'zzz', name: '绝区零' },
];

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

/** 崩三列表缓存：GameRoles 要联网，短时间内重复查询没有必要 */
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

/** 头像缓存：record index 有限流，头像又不常变，同一个 uid 半小时内只查一次 */
const profileCache = new Map();
const PROFILE_TTL = 30 * 60 * 1000;
const PROFILE_BAD_TTL = 3 * 60 * 1000;

function readProfile(game, uid) {
  const key = game + ':' + uid;
  const hit = profileCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts >= hit.ttl) {
    profileCache.delete(key);
    return null;
  }
  return hit.url;
}

function saveProfile(game, uid, url) {
  profileCache.set(game + ':' + uid, {
    ts: Date.now(),
    url: url || '',
    ttl: url ? PROFILE_TTL : PROFILE_BAD_TTL,
  });
  if (profileCache.size > 1000) profileCache.clear();
}

/** Stoken 存档缓存：一次 GameRoles 补齐四个游戏的昵称与等级（绝区零也有） */
const stokenCache = new Map();
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

async function loadStoken(e) {
  const qq = String(e.user_id || '');
  const hit = stokenCache.get(qq);
  if (hit && Date.now() - hit.ts < STOKEN_TTL) return hit.data;
  const data = readStokenFile(qq);
  try {
    const ck = Object.values(data.entries).map(v => v?.ck_stoken).find(Boolean) || '';
    if (ck) {
      const res = await api(e, { type: 'GameRoles', headers: mhy.getHeaders(e, ck), silent: true });
      for (const row of res?.data?.list || []) {
        if (!row?.game_uid) continue;
        data.roles.set(String(row.game_uid), {
          nickname: row.nickname || '',
          level: Number(row.level || 0) || 0,
        });
      }
    }
  } catch (err) {
    logger.debug?.('[HoYoGet][uid] 角色列表取昵称失败：' + (err?.message || err));
  }
  stokenCache.set(qq, { ts: Date.now(), data });
  if (stokenCache.size > 500) stokenCache.clear();
  return data;
}

/**
 * 补全面板资料
 *
 * 昵称与等级取 GameRoles（一次请求覆盖四个游戏），头像取 record index。
 * 头像按 uid + 游戏缓存，只有第一次 #uid 会联网。
 * 崩三的 record 域名在本机容易直连超时，多个账号必须并发；
 * 其余三游戏的 getRoleProfile 会临时改写 e.uid / e.game，只能串行。
 */
async function fillProfiles(games, e, stoken, noteUser) {
  const Player = await getPlayer();
  const ckByStuid = {};
  for (const ltuid of Object.keys(noteUser?.mysUsers || {})) {
    const ck = noteUser.mysUsers[ltuid]?.ck;
    if (ck) ckByStuid[String(ltuid)] = ck;
  }

  const tasks = [];
  for (const game of games) {
    for (const item of game.uidList || []) tasks.push({ game, item });
  }

  /* ① 先用本地数据把昵称、等级、横幅补到最好，这一步不联网 */
  for (const row of tasks) {
    const game = row.game;
    const item = row.item;
    const uid = String(item.uid || '');
    const role = stoken.roles.get(uid) || {};
    /* 服务器类型：优先取存档里的 region_name，缺失时按 uid 推断 */
    const entry = stoken.entries[uid] || {};
    const server = entry.region_name || mhy.getServerName(mhy.getServer(uid, game.key));
    if (server) item.server = server;
    if (role.nickname) item.name = role.nickname;
    if (role.level) item.level = role.level;
    if (game.key === 'zzz') {
      /* 这两个标记只决定缺图时的兜底样式；绝区零同样要补昵称与头像，不能提前退出 */
      item.zzz_banner = true;
      item.zzz_face = true;
    }
    if (!Player) continue;
    try {
      const player = Player.create(uid, game.key);
      const imgs = player?.faceImgs || {};
      if (!item.name && player?.name) item.name = player.name;
      if (!item.level && player?.level) item.level = player.level;
      if (imgs.banner) item.banner = imgs.banner;
      if (imgs.face) item.face = imgs.face;
    } catch (err) {
      continue;
    }
  }

  /* ② 角色列表：昵称与等级的唯一可靠来源。
     record index 不返回这两项（绝区零连昵称都没有），只靠本地存档会显示「暂无uid信息」；
     GameRoles 一次就能返回该账号下全部游戏的 uid / 昵称 / 等级。 */
  const roleInfo = new Map();
  const seenCk = new Set();
  for (const mu of Object.values(noteUser?.mysUsers || {})) {
    const ck = mu?.ck;
    if (!ck || seenCk.has(ck)) continue;
    seenCk.add(ck);
    try {
      const res = await api(e, { type: 'GameRoles', headers: mhy.getHeaders(e, ck), silent: true });
      for (const row of res?.data?.list || []) {
        if (!row?.game_uid) continue;
        roleInfo.set(String(row.game_uid), {
          nickname: row.nickname || '',
          level: Number(row.level || 0) || 0,
        });
      }
    } catch (err) {
      logger.debug?.('[HoYoGet][uid] 取角色列表失败：' + (err?.message || err));
    }
  }
  for (const row of tasks) {
    const info = roleInfo.get(String(row.item.uid || ''));
    if (!info) continue;
    if (info.nickname) row.item.name = info.nickname;
    if (info.level) row.item.level = info.level;
  }

  /* ③ 崩三头像：并发；headers 必须用真 ck，stoken 拼出来的 ck 会被判登录失效 */
  const bh3Rows = tasks.filter(row => row.game.key === 'bh3');
  await Promise.all(bh3Rows.map(async row => {
    const item = row.item;
    const uid = String(item.uid || '');
    const cached = readProfile('bh3', uid);
    if (cached !== null) {
      if (cached) item.faceUrl = cached;
      return;
    }
    const entry = stoken.entries[uid] || {};
    const ck = ckByStuid[String(entry.stuid || '')] || '';
    if (!ck) return;
    let avatar = '';
    try {
      const headers = mhy.getHeaders(e, ck);
      const server = entry.region || mhy.getServer(uid, 'bh3');
      const info = await getRoleProfile(e, uid, 'bh3', { headers, server });
      avatar = info?.avatar || '';
      if (!item.name && info?.nickname) item.name = info.nickname;
      if (!item.level && info?.userLevel) item.level = info.userLevel;
    } catch (err) {
      logger.debug?.('[HoYoGet][uid] 取崩三头像失败：' + (err?.message || err));
    }
    if (avatar) item.faceUrl = avatar;
    saveProfile('bh3', uid, avatar);
  }));

  /* ④ 原神/星铁/绝区零：串行，避免 e.uid / e.game 互相覆盖 */
  for (const row of tasks) {
    if (row.game.key === 'bh3') continue;
    const item = row.item;
    const uid = String(item.uid || '');
    /* 只认非空缓存：之前接口失败留下的空记录不该把后续重查挡掉 */
    const cached = readProfile(row.game.key, uid);
    if (cached) {
      item.faceUrl = cached;
      continue;
    }
    let avatar = '';
    try {
      const info = await getRoleProfile(e, uid, row.game.key);
      avatar = info?.avatar || '';
      if (!item.name && info?.nickname) item.name = info.nickname;
      if (!item.level && info?.userLevel) item.level = info.userLevel;
    } catch (err) {
      logger.debug?.('[HoYoGet][uid] 取资料失败：' + (err?.message || err));
    }
    if (avatar) item.faceUrl = avatar;
    saveProfile(row.game.key, uid, avatar);
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
      { text: '探索', callback: '#探索' },
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
      dsc: '接管 #uid 并在面板追加崩坏3分组，!uid 查看崩坏3，!uidN 切换崩坏3当前uid',
      event: 'message',
      priority: pluginPriority('uid_panel', 100),
      rule: [
        { reg: /^#(我的)?uid$/i, fnc: 'showUid' },
        { reg: /^[!！](我的)?uid$/i, fnc: 'showBh3Uid' },
        { reg: /^[!！]uid[0-9]{1,2}$/i, fnc: 'switchBh3' },
      ],
    });
  }

  /** 读崩三账号列表，失败只记日志，不影响后续逻辑 */
  async readBh3(force) {
    const e = this.e;
    try {
      return await loadBh3(e, e.at || e.user_id, force);
    } catch (err) {
      logger.warn('[HoYoGet][uid] 读取崩三账号失败：' + (err && err.message ? err.message : err));
      return null;
    }
  }

  /** 组装四组数据并出图 */
  async replyPanel(bh3) {
    const e = this.e;
    if (!e.runtime) return false;
    const NoteUser = await getNoteUser();
    if (!NoteUser) return false;
    /* NoteUser.create(e) 会把 e.user 换成 NoteUser，先留一份原对象，
       补资料时还原，保证 getRoleProfile 里按 uid 取 ck 的链路与账本一致 */
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

    const games = GAME_LIST.map(ds => {
      const uidList = normalizeUidList(user.getUidList(ds.key));
      const rawUid = user.getUid(ds.key);
      const current = rawUid && typeof rawUid === 'object' ? rawUid.uid : rawUid;
      return { key: ds.key, name: ds.name, uid: String(current || uidList[0]?.uid || ''), uidList };
    });
    if (bh3 && bh3.list && bh3.list.length) games.push(buildBh3Group(bh3.list, bh3.current));

    try {
      const stoken = await loadStoken(e);
      await withQuietReply(e, () => fillProfiles(games, e, stoken, user));
    } catch (err) {
      logger.warn('[HoYoGet][uid] 补全玩家资料失败：' + (err?.message || err));
    }

    /* 框架在 ...data 之后才写 tplFile，直接放进 data 会被覆盖，必须在 beforeRender 里改 */
    const img = await e.runtime.render(
      'genshin',
      'html/user/uid-list',
      { uids: games },
      {
        retType: 'base64',
        beforeRender({ data }) {
          data.tplFile = TPL_FILE;
          data.uidRes = uidResPath(data);
          data.elemLayout = LAYOUT_FILE;
          /* 布局里的公共样式（背景、字体）取本插件 resources/common，不依赖 miao */
          data.commonRes = String(data.uidRes || '').replace('/resources/uid/', '/resources/common/');
          return data;
        },
      },
    );
    return e.reply([img, buildButtons()]);
  }

  /** #uid：四组数据统一由本面板出图，没有崩三账号也能补全其他游戏资料 */
  async showUid() {
    if (!this.e.runtime) return false;
    const bh3 = await this.readBh3(false);
    return this.replyPanel(bh3);
  }

  /** !uid：崩三自己的入口 */
  async showBh3Uid() {
    const bh3 = await this.readBh3(false);
    if (!bh3 || !bh3.list || !bh3.list.length) return this.e.reply(BH3_EMPTY_TIP);
    return this.replyPanel(bh3);
  }

  /** !uidN：切换崩坏3当前查询uid */
  async switchBh3() {
    const e = this.e;
    const match = String(e.msg || '').match(/[0-9]{1,2}/);
    if (!match) return false;
    const bh3 = await this.readBh3(false);
    if (!bh3 || !bh3.list || !bh3.list.length) return e.reply(BH3_EMPTY_TIP);
    const row = bh3.list[Number(match[0]) - 1];
    if (!row) return e.reply('崩坏3 uid序号不存在，发送 !uid 查看可用序号');
    if (typeof redis === 'undefined') return e.reply('未连接缓存，暂时无法切换崩坏3 uid');

    const qq = String(e.at || e.user_id || '');
    await redis.set('HoYoGet:bh3_uid:' + qq, row.uid);
    if (row.region) await redis.set('HoYoGet:bh3_region:' + qq, row.region);
    bh3Cache.delete(qq);
    return this.replyPanel({ list: bh3.list, current: row.uid });
  }
}

/** 补资料期间静音：米游社接口失败时 checkCode 会直接 e.reply 提示，面板不需要这些提示 */
async function withQuietReply(e, fn) {
  const rawReply = e.reply;
  const rawTips = e.noTips;
  try {
    e.reply = () => {};
    e.noTips = true;
  } catch (err) {
    return await fn();
  }
  try {
    return await fn();
  } finally {
    try {
      e.reply = rawReply;
      e.noTips = rawTips;
    } catch (err) {
      /* 还原失败不影响出图 */
    }
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
