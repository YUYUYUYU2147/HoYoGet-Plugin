import fetch from 'node-fetch';
import moment from 'moment';
import { render, pluginPriority } from '#HoYoGet';
import { enrichNanokaForAlioth, pickStageEnrich } from '../../system/sr_enrich.js';
import { buildZzzSchedule, refreshZzzAbyssSnapshot } from '../../system/zzz_abyss_schedule.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 数据来源：Alioth.wiki（开源站点，静态 JSON 直出，无需鉴权）
// 数据：https://json.alioth.wiki/data/{gi|hsr}/ch/{file}.json 与 {file}/{期id}.json
// 图标：https://transform.alioth.wiki/i/{gi|sr}/...（图片目录用 sr，数据目录用 hsr）
// 注意：transform 服务只接受固定宽度（实测 64/128 可用，48/96 会 400）
const DATA_BASE = 'https://json.alioth.wiki/data';
const IMG_BASE = 'https://transform.alioth.wiki/i';
const LANG = 'ch';

/* 排期图主题：每种深渊玩法一套配色 + 背景图（取自各游戏已有素材），风格尽量贴近游戏 UI */
export const SCHEDULE_THEMES = {
  gs_abyss:   { game: 'gs', light: true, name: '深境螺旋',     accent: '#f5d37a', accent2: '#8fb8ff', bg: 'abyss_stat/bg/bg-hydro.webp',   deco: 'gs',  tag: 'SPIRAL ABYSS' },
  gs_theater: { game: 'gs', light: true, name: '幻想真境剧诗', accent: '#e7b8ff', accent2: '#ffd98a', bg: 'abyss_stat/bg/bg-electro.webp', deco: 'gs',  tag: 'IMAGINARIUM THEATER' },
  gs_stygian: { game: 'gs', light: true, name: '幽境危战',     accent: '#7ff2e0', accent2: '#b5ffdc', bg: 'abyss_stat/bg/bg-dendro.webp',  deco: 'gs',  tag: 'STYGIAN ONSLAUGHT' },
  sr_chaos:   { game: 'sr', light: true, name: '混沌回忆',     accent: '#8fe3ff', accent2: '#c7b6ff', bg: 'abyss_stat/bg/bg-sr.webp',      deco: 'sr',  tag: 'CHAOS MEMORY' },
  sr_fiction: { game: 'sr', light: true, name: '虚构叙事',     accent: '#c9b2ff', accent2: '#ff9ad5', bg: 'abyss_stat/bg/bg-quantum.webp', deco: 'sr',  tag: 'PURE FICTION' },
  sr_shadow:  { game: 'sr', light: true, name: '末日幻影',     accent: '#ff6b7a', accent2: '#ffb36b', bg: 'abyss_stat/bg/bg-pyro.webp',    deco: 'sr',  tag: 'APOCALYPTIC SHADOW' },
  sr_arb:     { game: 'sr', light: true, name: '异相仲裁',     accent: '#c9961a', accent2: '#e8c15a', bg: 'abyss_stat/bg/bg-geo.webp',     deco: 'sr',  tag: 'FORGOTTEN HALL · ARBITRATION' },
  zzz_shiyu:  { game: 'zzz', light: false, name: '式舆防卫战',  accent: '#ffd400', accent2: '#ffffff', bg: 'zzz_challenge/img/bg1.png',     deco: 'zzz', tag: 'SHIYU DEFENSE' },
  zzz_deadly: { game: 'zzz', light: false, name: '危局强袭战',  accent: '#ff3d4a', accent2: '#ffd400', bg: 'zzz_challenge/img/bg.png',      deco: 'zzz', tag: 'DEADLY ASSAULT' },
};

export const MODES = {
  gs_abyss: {
    game: 'gs', data: 'gi', img: 'gi', file: 'abyss',
    title: '深境螺旋', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildAbyss,
  },
  gs_theater: {
    game: 'gs', data: 'gi', img: 'gi', file: 'theater',
    title: '幻想真境剧诗', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildTheater,
  },
  gs_stygian: {
    game: 'gs', data: 'gi', img: 'gi', file: 'stygian',
    title: '幽境危战', gameName: '原神', gameShort: 'GENSHIN IMPACT', build: buildStygian,
  },
  sr_chaos: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'chaos',
    title: '混沌回忆', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_fiction: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'fiction',
    title: '虚构叙事', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_shadow: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'as',
    title: '末日幻影', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildSr,
  },
  sr_arb: {
    game: 'sr', data: 'hsr', img: 'sr', file: 'arbitration',
    title: '异相仲裁', gameName: '崩坏：星穹铁道', gameShort: 'STAR RAIL', build: buildArb,
  },
};

const GI_ELEM = { Fire: '火', Water: '水', Grass: '草', Elec: '雷', Ice: '冰', Wind: '风', Rock: '岩', All: '全' };
const SR_ELEM = { Phys: '物理', Fire: '火', Ice: '冰', Wind: '风', Elec: '雷', Quantum: '量子', Imaginary: '虚数' };
const ZZZ_ELEM = { physical: '物理', fire: '火', ice: '冰', electric: '电', ether: '以太', wind: '风' };

// 期数索引 10 分钟、当期详情 6 小时缓存（当期数据在版本内基本不变，避免每次请求都打对方 CDN）
const CACHE = new Map();

async function fetchJson(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 HoYoGet-abyss-now' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, ttl = 10 * 60 * 1000) {
  const hit = CACHE.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  const v = await fetchJson(url);
  CACHE.set(url, { t: Date.now(), v });
  return v;
}

// Time 形如「2026/10/16 - 2026/11/16」或「2026/11」，解析成时间戳用于判断当期
function periodRange(time = '') {
  const t = String(time || '');
  const toDate = s => {
    const m = String(s || '').match(/(\d{4})[\/.](\d{1,2})(?:[\/.](\d{1,2}))?/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3] || 1)).getTime();
  };
  const parts = t.split('-').map(v => v.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const start = toDate(parts[0]);
    let end = toDate(parts[1]);
    if (start && end) {
      // 结束时间可能省略年份，补上起始年份
      if (!/^\d{4}/.test(parts[1])) {
        const ds = new Date(start);
        const mp = String(parts[1]).split('/');
        end = new Date(ds.getFullYear(), Number(mp[0] || ds.getMonth() + 1) - 1, Number(mp[1] || 1)).getTime();
      }
      return { start, end: end + 24 * 3600 * 1000 - 1 };
    }
  }
  const single = toDate(t);
  return single ? { start: single, end: single + 31 * 24 * 3600 * 1000 } : null;
}

// 期数选择：默认当期（按时间命中），支持指定版本、指定期号、上一期/下一期
async function loadPhase(mode, opts = {}) {
  const index = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}.json`);
  const phases = index.Phases || [];
  if (!phases.length) return null;

  let idx = 0;
  let tag = '当期';
  const verList = () => phases.slice(0, 6).map(p => p.Ver).filter(Boolean).join(' / ');

  if (opts.periodId) {
    idx = phases.findIndex(p => String(p._id) === String(opts.periodId));
    if (idx < 0) return { error: `未找到第 ${opts.periodId} 期数据，可用期号：${phases.slice(0, 6).map(p => p._id).join(' / ')}` };
    tag = `第${opts.periodId}期`;
  } else if (opts.version) {
    const v = String(opts.version);
    idx = phases.findIndex(p => String(p.Ver || '').startsWith(v));
    if (idx < 0) idx = phases.findIndex(p => String(p.Ver || '').includes(v));
    if (idx < 0) return { error: `未找到版本 ${v} 的${mode.title}数据，可用版本：${verList()}` };
    tag = `${phases[idx].Ver || v}`;
  } else {
    // 未指定时按时间定位当期（进行中的一期），取不到再用最新一期兜底
    const now = Date.now();
    let cur = phases.findIndex(p => {
      const r = periodRange(p.Time);
      return r && now >= r.start && now <= r.end;
    });
    if (cur < 0) cur = 0;
    const off = Number(opts.offset || 0);
    idx = cur + off;
    if (idx < 0) return { error: `已是最新一期（${phases[0].Ver || ''} ${phases[0].Time || ''}），暂无下一期数据` };
    if (idx > phases.length - 1) return { error: '没有更早的期数了' };
    if (off === 0) tag = '当期';
    else if (off === 1) tag = '上一期';
    else if (off === -1) tag = '下一期';
    else tag = off > 0 ? `往前第${off}期` : `往后第${-off}期`;
  }

  const phase = phases[idx];
  const detail = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}/${phase._id}.json`, 6 * 60 * 60 * 1000);
  if (!detail) return null;
  return { phase, detail, tag };
}

function fmt(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return '-';
  return Math.round(n).toLocaleString('en-US');
}

function pct(num) {
  const n = Number(num);
  if (!Number.isFinite(n)) return '-';
  return `${Math.round(n * 1000) / 10}%`;
}

// 站点文案里带有 <color style='...'>、<b class='...'> 和星铁的 @数字# 占位符，转成模板可直接渲染的标签
function cleanRich(text = '') {
  return String(text || '')
    .replace(/@([^#\n]{0,40})#/g, '$1')
    .replace(/<color[^>]*>/gi, '<span class="hl">')
    .replace(/<\/color>/gi, '</span>')
    .replace(/<b[^>]*>/gi, '<b class="hl">')
    .replace(/<br\s*\/?>/gi, '<br>')
    .replace(/<(?!\/?(?:b|span|br|i|u)\b)[^>]*>/gi, '')
    // 源数据在行内高亮数字前后会带换行（如“伤害提高\n<span>80%</span>\n，持续”），紧贴标签的换行是排版噪音，删掉；
    // 句子之间的换行才转成 <br>
    .replace(/\n(?=<)|(?<=>)\n/g, '')
    .replace(/\n+/g, '<br>')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 纯文本：去掉所有标签，只留文字（怪物名用，模板里 {{name}} 是转义输出） */
function plainText(text = '') {
  return cleanRich(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 本地元素图标：在线 transform 接口已 404，改用插件内置资源转 data URI（缓存）。
// 每个元素给多个候选路径，按顺序取第一个存在的文件（历史资源命名有 typo/多套）。
const LOCAL_ELEM = {
  // 星铁：meta-sr/public/icons/（注意 elem-ice 实际存成了 elm-ice）
  sr: {
    Fire: ['meta-sr/public/icons/elem-fire.webp', 'meta-sr/public/icons/attr-fire.webp'],
    Ice: ['meta-sr/public/icons/elm-ice.webp', 'meta-sr/public/icons/attr-ice.webp', 'meta-sr/public/icons/elem-ice.webp'],
    Elec: ['meta-sr/public/icons/elem-elec.webp', 'meta-sr/public/icons/attr-elec.webp'],
    Wind: ['meta-sr/public/icons/elem-wind.webp'],
    Phys: ['meta-sr/public/icons/elem-phy.webp', 'meta-sr/public/icons/attr-phy.webp'],
    Quantum: ['meta-sr/public/icons/elem-auantum.webp', 'meta-sr/public/icons/tree-auantum.webp'],
    Imaginary: ['meta-sr/public/icons/elem-imaginary.webp', 'meta-sr/public/icons/attr-imaginary.webp'],
  },
  // 原神：gs_role/imgs/elem/*.png（英文键对应）
  gi: {
    Fire: ['gs_role/imgs/elem/pyro.png'],
    Water: ['gs_role/imgs/elem/hydro.png'],
    Grass: ['gs_role/imgs/elem/dendro.png'],
    Elec: ['gs_role/imgs/elem/electro.png'],
    Ice: ['gs_role/imgs/elem/cryo.png'],
    Wind: ['gs_role/imgs/elem/anemo.png'],
    Rock: ['gs_role/imgs/elem/geo.png'],
  },
  // 绝区零：zzz_challenge/element/*.png
  zzz: {
    physical: ['zzz_challenge/element/Physical.png'],
    fire: ['zzz_challenge/element/Fire.png'],
    ice: ['zzz_challenge/element/Ice.png'],
    electric: ['zzz_challenge/element/Electric.png'],
    ether: ['zzz_challenge/element/Ether.png'],
    wind: ['zzz_challenge/element/Wind.png'],
  },
};
const _elemIconCache = new Map();
function localElemIcon(game, key) {
  const cands = LOCAL_ELEM[game]?.[key];
  if (!cands) return '';
  const cacheKey = `${game}:${key}`;
  if (_elemIconCache.has(cacheKey)) return _elemIconCache.get(cacheKey);
  let uri = '';
  for (const rel of cands) {
    try {
      const abs = path.join(PLUGIN_ROOT, 'resources', rel);
      if (!fs.existsSync(abs)) continue;
      const ext = path.extname(abs).slice(1).toLowerCase();
      uri = `data:image/${ext === 'png' ? 'png' : ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'webp'};base64,${fs.readFileSync(abs).toString('base64')}`;
      break;
    } catch {}
  }
  _elemIconCache.set(cacheKey, uri);
  return uri;
}

function elemView(game, keys = []) {
  const map = game === 'gi' ? GI_ELEM : game === 'zzz' ? ZZZ_ELEM : SR_ELEM;
  return (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(k => ({
    key: k,
    cn: map[k] || map[String(k).toLowerCase()] || k,
    // All 表示「全属性」无图标；其余用本地内置图标
    icon: k === 'All' ? '' : localElemIcon(game, k),
  })).filter(v => v.cn);
}

// 抗性条目统一摊平：{ elems:[{cn,icon,key}], value } → [{key,cn,icon,value}]
function flattenRes(list = []) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : [])) {
    for (const e of (r?.elems || [])) out.push({ key: e.key, cn: e.cn, icon: e.icon || '', value: r.value || '' });
  }
  return out;
}

function monsterIcon(game, icon = '') {
  if (!icon) return '';
  icon = String(icon).replace(/^\//, '').replace(/\.png$/i, '');
  if (game === 'sr') return `${IMG_BASE}/sr/${icon}.png?w=128&f=auto`;
  // 幽境危战首领立绘在独立目录
  const dir = icon.startsWith('UI_Img_LeyLineChallenge') ? 'LeyLineChallenge' : 'MonsterIcon';
  return `${IMG_BASE}/gi/${dir}/${icon}.png?w=128&f=auto`;
}

// 远程头像转 base64 内嵌，避免截图时 CSS 背景图还没加载完而显示空白
const _inlineIconCache = new Map();
// 并发上限：同时发起过多图片请求会超时，导致回退成远程链接，渲染时直接空白
const ICON_CONCURRENCY = 4;
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function inlineIcon(url = '') {
  if (!url || !/^https?:/i.test(url)) return url;
  if (_inlineIconCache.has(url)) return _inlineIconCache.get(url);
  let uri = '';
  // 失败重试 3 次；全部失败则不回退远程链接（远程链接在渲染时一定空白），留空并不缓存，下次再试
  for (let attempt = 0; attempt < 3 && !uri; attempt++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
        uri = `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
      }
    } catch {}
  }
  if (uri) _inlineIconCache.set(url, uri);
  return uri;
}

/** 把排期视图里所有 BOSS 远程头像内嵌为 base64（原神/星铁/绝区零共用） */
export async function inlineViewIcons(view) {
  if (!view?.rows?.length) return view;
  for (const r of view.rows) {
    r.bosses = await mapLimit(r.bosses || [], ICON_CONCURRENCY, async b => ({ ...b, icon: await inlineIcon(b.icon) }));
    // 分组里的 BOSS 也要内嵌（渲染用的是 groups；只处理 bosses 会留下远程链接，渲染时空白）
    for (const g of r.groups || []) {
      g.bosses = await mapLimit(g.bosses || [], ICON_CONCURRENCY, async b => ({ ...b, icon: await inlineIcon(b.icon) }));
      g.big = g.bosses.filter(b => !b.mini).length;
      g.hasMini = g.bosses.some(b => b.mini);
    }
  }
  return view;
}

function avatarIcon(icon = '') {
  if (!icon) return '';
  return `${IMG_BASE}/gi/AvatarIcon/${String(icon).replace(/\.png$/i, '')}.png?w=128&f=auto`;
}

// 对象/数组统一转数组（星铁 as 玩法的 Skills/Tags 是 {1:..,2:..} 形式）
function valuesOf(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function buffList(items = []) {
  return items.map(v => ({ name: cleanRich(v.Name), desc: cleanRich(v.Desc || v.desc) }))
    .filter(v => v.name || v.desc);
}

/* ---------------- 原神：深境螺旋 ---------------- */

// RES = [[['冰','草','岩'], '40%'], [['火'], '-20%']]
function giRes(show) {
  return (show || []).map(entry => ({
    elems: elemView('gi', Array.isArray(entry?.[0]) ? entry[0] : [entry?.[0]])
      .map(e => e.key === 'All' ? { ...e, cn: '全抗' } : e),
    value: entry?.[1] || '',
  })).filter(v => v.elems.length && v.value);
}

/* 护盾：Alioth 的波次数据里有 `Shield: [{ Type: 'Elec', Value: 8 }]`，
   元素 + 护盾量都齐全，直接用它；老数据/无 Shield 字段时再用名字兜底。 */
function giShield(show) {
  return (Array.isArray(show) ? show : (show ? [show] : []))
    .map(s => ({
      elems: elemView('gi', [s?.Type]),
      value: s?.Value != null ? String(s.Value) : '',
    }))
    .filter(v => v.elems.length && v.value !== '');
}

/* 名字兜底：带盾/盔/铠的丘丘暴徒与丘丘王、深渊法师/使徒/咏者、
   愚人众先遣队都有元素护盾或护甲；攻略文案里明确写了「护盾」的再补一刀。 */
const SHIELD_NAME_RE = /盾|盔|铠|法师|使徒|咏者|重卫士|先遣队/
const SHIELD_FALLBACK = [{ elems: [{ cn: '护盾', icon: '' }], value: '' }]
function hasShieldName(name = '') {
  return SHIELD_NAME_RE.test(String(name || ''))
}

function giMonster(detail, m = {}) {
  const info = detail.Monsters?.[m.ID] || {};
  const name = plainText(info.Name) || plainText(m.Note) || `怪物 ${m.ID}`;
  const shield = giShield(m.Shield);
  return {
    name,
    icon: monsterIcon('gi', info.Icon),
    hp: fmt(m.HP),
    count: Number(m.Num) > 1 ? m.Num : (m.HPCount || ''),
    res: giRes(info.RES),
    shield: shield.length ? shield : (hasShieldName(name) ? SHIELD_FALLBACK : []),
    mech: '',
  };
}

async function buildAbyss(mode, opts = {}) {
  const layer = opts.layer;
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const floors = detail.Floors || [];
  if (!floors.length) return null;
  const nums = floors.map(f => Number(f.Index)).filter(Number.isFinite);
  const want = nums.includes(Number(layer)) ? Number(layer) : Math.max(...nums);
  const floor = floors.find(f => Number(f.Index) === want) || floors[floors.length - 1];

  const chambers = (floor.Chambers || []).slice().sort((a, b) => a.Index - b.Index || a.Half - b.Half);
  const halvesMap = new Map();
  for (const c of chambers) {
    const half = {
      label: Number(c.Half) === 1 ? '上半' : '下半',
      level: c.Level,
      waves: (c.Waves || []).map(w => ({
        name: w.Wave || '',
        monsters: (w.Monsters || []).map(m => giMonster(detail, m)),
      })),
    };
    if (!halvesMap.has(c.Index)) halvesMap.set(c.Index, []);
    halvesMap.get(c.Index).push(half);
  }
  const rooms = [...halvesMap.keys()].sort((a, b) => a - b).map(idx => ({ idx, halves: halvesMap.get(idx) }));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '渊月祝福',
    buffs: buffList(detail.Blessings),
    disorder: cleanRich(floor.Disorder || ''),
    hasDisorder: true,
    sections: [{ title: `第${floor.Index}层`, meta: `HP ${pct(floor.HPRatio)}`, rooms }],
    tip: layer ? '' : '默认展示最高层，可发送如「米哈游原神11层深渊速览」查看其它层',
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 原神：幻想真境剧诗 ---------------- */

// 怪物名称：alioth 的 monster/<id>.json -> Main.Name（幻想真境剧诗的 Boss 只给 ID，名字要单独取）
async function monsterNameById(id) {
  if (!id) return '';
  const d = await getJson(`${DATA_BASE}/gi/${LANG}/monster/${id}.json`, 24 * 3600 * 1000);
  return plainText(d?.Main?.Name || '');
}

async function theaterMonsters(detail, list = [], mini = false) {
  const out = [];
  for (const it of list) {
    const isObj = it && typeof it === 'object';
    const id = isObj ? it.ID : it;
    const iconKey = detail.Monsters?.[id];
    out.push({
      name: await monsterNameById(id),
      icon: monsterIcon('gi', typeof iconKey === 'string' ? iconKey : iconKey?.Icon),
      // 幕内普通怪的数据源没有血量，明确标注「未公布」而不是留空
      hp: isObj && it.HP ? `HP ${fmt(it.HP)}` : (mini ? 'HP 未公布' : ''),
      count: '',
      res: [],
      mech: '',
      mini,
    });
  }
  return out;
}

async function buildTheater(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const halvesOf = async (arr, prefix) => Promise.all((arr || []).map(async (v, i) => ({
    label: `${prefix}${arr.length > 1 ? ` ${i + 1}` : ''}`,
    time: v.Time || '',
    waves: [{ name: '', monsters: await theaterMonsters(detail, v.Monsters || []) }],
  })));

  const rooms = [];
  if (detail.Boss?.length) rooms.push({ idx: rooms.length + 1, halves: await halvesOf(detail.Boss, '首领关卡') });
  if (detail.Arcana?.length) rooms.push({ idx: rooms.length + 1, halves: await halvesOf(detail.Arcana, '秘域关卡') });

  const chamberHalves = await Promise.all((detail.Chambers || []).map(async c => {
    const waves = await Promise.all((c.Configs || []).map(async cfg => ({
      name: '',
      monsters: await theaterMonsters(detail, detail.MP?.[cfg] || [], true),
    })));
    return { label: `第${c._id}幕`, level: c.Level, waves };
  }));
  if (chamberHalves.length) rooms.push({ idx: rooms.length + 1, halves: chamberHalves });

  const sections = [];
  if (rooms.length) sections.push({ title: '当期关卡', meta: '', rooms });
  if (detail.MonDesc && Object.keys(detail.MonDesc).length) {
    // MonDesc 按 MP 配置 id 索引，反查所属幕并按幕数排序（对象键顺序不保证按幕数）；纯文本截断（不能切 HTML，否则切在标签中间会渲染出乱码）
    const cfgChamber = {};
    for (const c of (detail.Chambers || [])) for (const cfg of (c.Configs || [])) cfgChamber[cfg] = c._id;
    const mechHalves = Object.entries(detail.MonDesc)
      .map(([cfg, d]) => ({ cfg, d, chamber: Number(cfgChamber[cfg]) || 999 }))
      .sort((a, b) => a.chamber - b.chamber)
      .slice(0, 6)
      .map(({ cfg, d, chamber }, i) => {
        const text = String(d || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const label = chamber !== 999 ? `第${chamber}幕 · 机制` : `机制 ${i + 1}`;
        return { label, waves: [{ name: text.length > 160 ? `${text.slice(0, 160)}…` : text, monsters: [] }] };
      });
    sections.push({ title: '首领机制', meta: '', rooms: [{ idx: 1, halves: mechHalves }] });
  }

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    elems: elemView('gi', detail.Elem),
    charRows: [
      { label: '开幕角色', chars: (detail.Initial || []).map(c => ({ icon: avatarIcon(c.Icon) })) },
      { label: '特邀角色', chars: (detail.Invitation || []).map(c => ({ icon: avatarIcon(c.Icon) })) },
    ].filter(v => v.chars.length),
    buffTitle: '',
    buffs: [],
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 原神：幽境危战 ---------------- */

function styMonster(detail, id, diffIdx) {
  const info = detail.Monsters?.[id] || {};
  return {
    name: plainText(info.Name) || `怪物 ${id}`,
    icon: monsterIcon('gi', info.Icon),
    hp: info.Stats ? `HP ${fmt(info.Stats.HP)}` : '',
    count: '',
    res: giRes((info.RESShow || [])[diffIdx] || (info.RESShow || [])[0]),
    mech: (info.Buff || []).map(b => plainText(b.Name)).filter(Boolean).join(' / '),
  };
}

async function buildStygian(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  const levels = detail.Levels || [];
  if (!levels.length) return null;

  const sections = levels.map((lv, idx) => ({
    title: `难度 ${lv.Level}`,
    meta: (lv.Monsters || []).map(id => detail.Monsters?.[id]?.Advantage).filter(Boolean).length ? '' : '',
    rooms: [{
      idx: 1,
      halves: [{
        label: '敌人',
        waves: [{ name: '', monsters: (lv.Monsters || []).map(id => styMonster(detail, id, idx)) }],
      }],
    }],
  }));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '',
    buffs: [],
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 星铁：混沌回忆 / 虚构叙事 / 末日幻影 ---------------- */

function srMonster(detail, m = {}, healPct = 0) {
  const info = detail.Monsters?.[m.ID] || {};
  const res = Object.entries(info.RES || {}).map(([k, v]) => ({
    elems: elemView('sr', k),
    value: pct(v),
  })).filter(v => v.elems.length);
  const mon = {
    name: plainText(info.Name) || `怪物 ${m.ID}`,
    icon: monsterIcon('sr', info.Icon),
    hp: fmt(m.HP),
      // HPCount = 血条数，即页面上的 xN（如「9,645,484 x2」），与污染等级无关
      hpMult: Number(info.HPCount) > 1 ? Number(info.HPCount) : 0,
      // VoracityHP = 污染（贪饕）额外加的血量，独立字段，不是百分比推导
      voracityHp: m.VoracityHP ? fmt(m.VoracityHP) : '',
      // 贪饕被击倒时回复的血量 = 本层 HP × 该期贪饕回血比例。
      // 比例只有 nanoka 有（maze_buff_param[1]），由 enrichNanokaForAlioth 补进来。
      greedPct: 0,
      greedHp: '',
      spd: m.SPD ? fmt(m.SPD) : '',
      stance: m.Stance ? (Math.round(Number(m.Stance) * 10) / 10).toFixed(1) : '',
    count: '',
    weak: elemView('sr', info.Weak),
    res,
    mech: '',
  };
  if (healPct > 0) {
    const base = Number(String(mon.hp).replace(/,/g, '')) || 0;
    if (base > 0) {
      mon.greedPct = Math.round(healPct * 100);
      mon.greedHp = fmt(Math.round(base * healPct));
    }
  }
  return mon;
}

// 混沌/虚构的 Waves 是数组；末日幻影的 Waves 是单个对象（首领本体）
function srWaves(detail, stage, healPct = 0) {
  const raw = stage.Waves;
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return list.map((w, i) => {
    let monsters = [];
    if (Array.isArray(w.Monsters)) monsters = w.Monsters.map(m => srMonster(detail, m, healPct));
    else if (w.ID) monsters = [srMonster(detail, w, healPct)];
    /* 同波召唤的小怪：挂在 Summons 上，补在首领之后 */
    if (!Array.isArray(w.Monsters) && Array.isArray(w.Summons) && w.Summons.length) {
      for (const sm of w.Summons) {
        const one = srMonster(detail, sm, healPct);
        one.isSummon = true;
        monsters.push(one);
      }
    }
    return {
      name: plainText(w.WaveName) || (Array.isArray(raw) && list.length > 1 ? `第${w.Wave ?? i + 1}波` : ''),
      monsters,
    };
  }).filter(v => v.monsters.length);
}

function srStageHalf(detail, st, label, nanokaMap) {
  const stageId = st.StageID;
  const stage = detail.Stages?.[String(stageId)] || detail.Stages?.[stageId] || {};
  const healPct = Number(pickStageEnrich(nanokaMap, stageId)?.healPct) || 0;
  return {
    label,
    level: stage.Level,
    elems: elemView('sr', st.Elem),
    waves: srWaves(detail, stage, healPct),
  };
}

async function buildSr(mode, opts = {}) {
  const layer = opts.layer;
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;
  // alioth 没有污染机制说明与贪饕回血比例，这两样只有 nanoka 有，补进来
  const nanokaMap = await enrichNanokaForAlioth(String(phase._id), detail, mode.file || 'chaos');
  const floors = detail.Floors || [];
  if (!floors.length) return null;
  const nums = floors.map(f => Number(f.Floor)).filter(Number.isFinite);
  const want = nums.includes(Number(layer)) ? Number(layer) : Math.max(...nums);
  const floor = floors.find(f => Number(f.Floor) === want) || floors[floors.length - 1];

  const halves = (floor.Stages || []).map(st => srStageHalf(detail, st, Number(st.Half) === 1 ? '上半' : Number(st.Half) === 2 ? '下半' : `第${st.Half}关`, nanokaMap))
    .filter(v => v.waves.length);

  const buffs = [];
  if (detail.Buff?.Name || detail.Buff?.Desc) buffs.push(...buffList([detail.Buff]));
  buffs.push(...buffList(valuesOf(detail.NewBuffs)));
  for (const v of valuesOf(detail.Skills)) {
    const desc = [v.Desc, v.Desc2].filter(Boolean).map(cleanRich).filter(Boolean).join('<br>');
    if (v.Name || desc) buffs.push({ name: cleanRich(v.Name), desc });
  }
  // 末日幻影的 Tags 是首领机制
  for (const v of valuesOf(detail.Tags)) buffs.push(...buffList(valuesOf(v.Tags).length ? valuesOf(v.Tags) : [v]));

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: mode.file === 'fiction' ? '关卡增益 / 战技' : mode.file === 'as' ? '关卡增益 / 首领机制' : '关卡增益',
    buffs,
    disorder: '',
    hasDisorder: false,
    sections: [{
      title: `第${floor.Floor}层`,
      meta: [floor.HP ? `总HP ${fmt(floor.HP)}` : '', floor.HP_S ? `单 ${fmt(floor.HP_S)} / 群 ${fmt(floor.HP_M)}` : '', halves[0]?.level ? `Lv.${halves[0].level}` : ''].filter(Boolean).join(' · '),
      rooms: [{ idx: floor.Floor, halves }],
    }],
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/**
 * 取星铁当期每一层的怪物/BOSS，供战绩图右栏用。
 * 与「速览」同一份数据源；失败返回 {}，不影响主图。
 * @param {'sr_chaos'|'sr_fiction'|'sr_shadow'} modeKey
 * @param {object} opts 与 loadPhase 相同，可传 offset=1 取上期
 * @returns {Promise<Object<number, Array<{label,level,waves}>>>}
 */
/**
 * 星铁各玩法的「关卡增益 / 战技」文本（来自 Alioth 速览数据）。
 * 按玩法返回 [{ name, desc }]，供总览页挂在每个节点上。
 */
export async function getSrBuffs(modeKey) {
  const mode = MODES[modeKey];
  if (!mode || mode.game !== 'sr') return [];
  try {
    const index = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}.json`);
    const phases = index?.Phases || [];
    if (!phases.length) return [];
    const now = Date.now();
    let idx = phases.findIndex(p => {
      const r = periodRange(p.Time);
      return r && now >= r.start && now <= r.end;
    });
    if (idx < 0) idx = 0;
    const phase = phases[idx];
    const detail = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}/${phase._id}.json`, 6 * 60 * 60 * 1000);
    if (!detail) return [];
    const out = [];
    if (detail.Buff?.Name || detail.Buff?.Desc) out.push(...buffList([detail.Buff]));
    out.push(...buffList(detail.NewBuffs || []));
    for (const v of valuesOf(detail.Skills)) {
      const desc = [v.Desc, v.Desc2].filter(Boolean).map(cleanRich).filter(Boolean).join('\n');
      if (v.Name || desc) out.push({ name: cleanRich(v.Name), desc });
    }
    return out;
  } catch (err) {
    logger.debug?.(`[HoYoGet][abyss_now] 星铁增益获取失败(${modeKey})：${err?.message || err}`);
    return [];
  }
}

export async function getSrBossesByFloor(modeKey, opts = {}) {
  const mode = MODES[modeKey];
  if (!mode || mode.game !== 'sr' || !['sr_chaos', 'sr_fiction', 'sr_shadow'].includes(modeKey)) return {};
  try {
    const loaded = await loadPhase(mode, opts);
    if (!loaded || loaded.error) return {};
    const { phase, detail } = loaded;
    const nanokaMap = await enrichNanokaForAlioth(String(phase._id), detail, mode.file || 'chaos').catch(() => null);
    const out = {};
    for (const floor of (detail.Floors || [])) {
      const idx = Number(floor.Floor);
      if (!Number.isFinite(idx)) continue;
      const halves = (floor.Stages || [])
        .map(st => srStageHalf(detail, st, Number(st.Half) === 1 ? '上半' : Number(st.Half) === 2 ? '下半' : `第${st.Half}关`, nanokaMap))
        .filter(v => v.waves.length);
      if (halves.length) out[idx] = halves;
    }
    return out;
  } catch (err) {
    logger.debug?.(`[HoYoGet][abyss_now] 星铁怪物配置获取失败：${err?.message || err}`);
    return {};
  }
}

/**
 * 取星铁异相仲裁（王棋）的「骑士关卡 + 王棋关卡」BOSS 血量/弱点/抗性，
 * 供王棋战绩图右栏用。与速览同一份 Alioth 数据源；失败返回空对象。
 * 返回 { knight: { [Index]: half }, king: { [Index]: half } }，
 * 其中 half = { label, level, waves:[{name, monsters:[...]}] }。
 * 左栏关卡与右栏 BOSS 按此索引一一对应：
 *   首领 → king[hard_mode ? 5 : 4]（困难/普通），骑士 i → knight[i]。
 */
export async function getSrArbKingBosses(opts = {}) {
  const mode = MODES.sr_arb;
  if (!mode) return {};
  try {
    const loaded = await loadPhase(mode, opts);
    if (!loaded || loaded.error) return {};
    const { detail } = loaded;
    /* 骑士关卡怪物 buff（血嗜 / 桎梏+ / 激怒 / 闭锁）：KnightTags 按 Index 给标题 */
    const knightTags = {};
    for (const v of detail.KnightTags || []) {
      knightTags[v.Index] = valuesOf(v.Tags).map(t => cleanRich(t.Name)).filter(Boolean);
    }
    /* 王棋关卡怪物 buff（血嗜 / 洞穿 / 不屈 / +）：KingTags 按 Index 给标题。
       血量高 = 绝境（Index 5，血嗜+/洞穿+/不屈），血量低 = 普通（Index 4，血嗜/洞穿），
       与挑战记录 boss_record.hard_mode 对应（true=绝境→5，false=普通→4）。 */
    const kingTags = {};
    for (const v of detail.KingTags || []) {
      kingTags[v.Index] = valuesOf(v.Tags).map(t => cleanRich(t.Name)).filter(Boolean);
    }
    const knight = {};
    const king = {};
    for (const v of detail.Knight || []) {
      const h = srStageHalf(detail, v, `骑士关卡 ${v.Index}`);
      if (h.waves.length) {
        h.tags = knightTags[v.Index] || [];
        knight[v.Index] = h;
      }
    }
    for (const v of detail.King || []) {
      const h = srStageHalf(detail, v, `王棋关卡 ${v.Index}`);
      if (h.waves.length) {
        h.tags = kingTags[v.Index] || [];
        king[v.Index] = h;
      }
    }
    return { knight, king, kingMechs: collectKingMechs(detail) };
  } catch (err) {
    logger.debug?.(`[HoYoGet][abyss_now] 星铁王棋BOSS配置获取失败：${err?.message || err}`);
    return {};
  }
}

/**
 * 王棋首领（堕神之血·亚婆离）的机制（血脑屏障 / 稳态失衡）。
 * 来源：detail.Guides（list）里 Icon 与首领怪物一致的条目，
 * 只取首领、不含小怪（月夜天马 / 灯塔）与骑士关。
 */
function collectKingMechs(detail) {
  try {
    // Icon → 机制列表
    const mechByIcon = {};
    for (const g of detail.Guides || []) {
      const icon = g.Icon;
      const mechs = (g.Guide || [])
        .map(gi => ({
          title: plainText(gi.Title),
          desc: (gi.DescList || []).map(d => cleanRich(d)).filter(Boolean).join('<br>'),
        }))
        .filter(m => m.title || m.desc);
      if (icon && mechs.length) mechByIcon[icon] = mechs;
    }
    // 王棋关卡里名字含「亚婆离」的首领 → 取其机制
    for (const v of detail.King || []) {
      const st = detail.Stages?.[String(v.StageID)] || detail.Stages?.[v.StageID] || {};
      const waves = Array.isArray(st.Waves) ? st.Waves : (st.Waves ? [st.Waves] : []);
      for (const w of waves) {
        const mons = Array.isArray(w.Monsters) ? w.Monsters : (w.Monsters ? [w.Monsters] : []);
        for (const m of mons) {
          const info = detail.Monsters?.[m.ID] || {};
          if (/亚婆离/.test(plainText(info.Name) || '')) {
            const mechs = mechByIcon[info.Icon];
            if (mechs && mechs.length) return mechs;
          }
        }
      }
    }
    return [];
  } catch (err) {
    logger.debug?.(`[HoYoGet][abyss_now] 王棋首领机制解析失败：${err?.message || err}`);
    return [];
  }
}

/* ---------------- 星铁：异相仲裁 ---------------- */

async function buildArb(mode, opts = {}) {
  const loaded = await loadPhase(mode, opts);
  if (!loaded) return null;
  if (loaded.error) return { error: loaded.error };
  const { phase, detail, tag } = loaded;

  const tagMap = new Map();
  for (const v of valuesOf(detail.KnightTags)) tagMap.set(`K${v.Index}`, valuesOf(v.Tags));
  for (const v of valuesOf(detail.KingTags)) tagMap.set(`G${v.Index}`, valuesOf(v.Tags));

  const buildGroup = (list, prefix, tagKey) => (list || []).map(v => {
    const half = srStageHalf(detail, v, `${prefix} ${v.Index}`);
    const tags = tagMap.get(`${tagKey}${v.Index}`) || [];
    half.mechTags = tags.map(t => cleanRich(t.Name)).filter(Boolean);
    return half;
  }).filter(v => v.waves.length);

  const knightHalves = buildGroup(detail.Knight, '骑士关卡', 'K');
  const kingHalves = buildGroup(detail.King, '王棋关卡', 'G');

  const sections = [];
  if (knightHalves.length) {
    sections.push({ title: '骑士关卡', meta: detail.HP_Knight ? `总HP ${fmt(detail.HP_Knight)}` : '', rooms: [{ idx: 1, halves: knightHalves }] });
  }
  if (kingHalves.length) {
    sections.push({ title: '王棋关卡', meta: detail.HP_King ? `总HP ${fmt(detail.HP_King)}${detail.HP_King_Hard ? ` / 困难 ${fmt(detail.HP_King_Hard)}` : ''}` : '', rooms: [{ idx: 1, halves: kingHalves }] });
  }

  const buffs = buffList(valuesOf(detail.Buffs));
  for (const [key, tags] of tagMap) {
    const label = key.startsWith('K') ? '骑士' : '王棋';
    for (const t of tags) {
      if (t.Name || t.Desc) buffs.push({ name: `${label}关卡 · ${cleanRich(t.Name)}`, desc: cleanRich(t.Desc) });
    }
  }

  return {
    ...mode,
    id: phase._id,
    ver: phase.Ver || '',
    period: phase.Time || '',
    phaseTag: tag,
    buffTitle: '关卡增益 / 首领机制',
    buffs,
    disorder: '',
    hasDisorder: false,
    sections,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

/* ---------------- 消息解析 ---------------- */

function parseMsg(msg = '') {
  const rawText = String(msg || '');
  // 统一前缀：*=星铁、#=原神，文字前缀（星铁/原神…）可能已被归一掉
  const symGame = /^[*＊]/.test(rawText.trimStart()) ? 'sr' : /^[#＃]/.test(rawText.trimStart()) ? 'gs' : '';
  const text = rawText.replace(/^[#＃*＊]{0,2}米哈游/i, '').trim();
  const layer = text.match(/(\d{1,2})层/)?.[1] || '';
  // 版本（7.1）优先于层数；期号支持「58期」「第58期」
  const version = text.match(/([0-9]{1,2}\.[0-9]{1,2})/)?.[1] || '';
  const periodId = text.match(/第?([0-9]{2,4})期/)?.[1] || '';
  let offset = 0;
  if (/上一期|上期|上一|前一期/.test(text)) offset = 1;
  else if (/下一期|下期|下一|后一期/.test(text)) offset = -1;
  const game = /原神/.test(text) ? 'gs' : /星铁|星穹|崩铁/.test(text) ? 'sr' : symGame;
  let modeKey = '';
  if (/幻想|真境|剧诗/.test(text)) modeKey = 'gs_theater';
  else if (/幽境|危战/.test(text)) modeKey = 'gs_stygian';
  else if (/末日|幻影/.test(text)) modeKey = 'sr_shadow';
  else if (/异相|仲裁|王棋/.test(text)) modeKey = 'sr_arb';
  else if (/深境|螺旋/.test(text)) modeKey = 'gs_abyss';
  else if (/混沌|回忆/.test(text)) modeKey = 'sr_chaos';
  else if (/虚构/.test(text)) modeKey = 'sr_fiction';
  else if (game === 'sr') modeKey = 'sr_chaos';
  else modeKey = 'gs_abyss'; // 未写游戏/玩法时默认原神深渊
  return { layer, version, periodId, offset, modeKey };
}

/**
 * 取当期深渊每一层的怪物/BOSS 配置（给「深境螺旋」战绩图做右栏用）。
 * 数据源与速览相同（Alioth 静态 JSON），失败返回空对象，不影响主图。
 * @returns {Promise<Object<number, Array>>} { 12: [{label,level,waves:[{monsters:[...]}]}] }
 */
export async function getAbyssBossesByFloor(opts = {}) {
  try {
    const mode = MODES.gs_abyss;
    const loaded = await loadPhase(mode, opts);
    if (!loaded || loaded.error) return {};
    const detail = loaded.detail || {};
    const out = {};
    /* 攻略（技能应对）：顶层 Guides[怪物ID] = { Content: [{Title, DescList}] } */
    const guidesOf = id => {
      const g = detail.Guides?.[id] || detail.Guides?.[String(id)];
      if (!Array.isArray(g?.Content)) return [];
      return g.Content
        .map(c => ({
          title: plainText(c?.Title),
          lines: (c?.DescList || []).map(d => plainText(d)).filter(Boolean),
        }))
        .filter(c => c.title || c.lines.length)
        .slice(0, 3);
    };
    for (const floor of (detail.Floors || [])) {
      const idx = Number(floor.Index);
      if (!Number.isFinite(idx)) continue;
      const chambers = (floor.Chambers || []).slice().sort((a, b) => a.Index - b.Index || a.Half - b.Half);
      const halvesMap = new Map();
      for (const c of chambers) {
        const half = {
          label: Number(c.Half) === 1 ? '上半' : '下半',
          level: c.Level,
          waves: (c.Waves || []).map(w => ({
            name: w.Wave || '',
            monsters: (w.Monsters || []).map(m => {
              const mon = giMonster(detail, m);
              if (!mon) return null;
              // 该怪若有攻略，挂上技能应对（每个房间最多显示前 3 条）
              const g = guidesOf(m.ID);
              if (g.length) mon.guides = g;
              if (!mon.shield.length && g.some(x => /护盾/.test(`${x.title} ${(x.lines || []).join(' ')}`))) {
                mon.shield = SHIELD_FALLBACK;
              }
              return mon;
            }).filter(Boolean),
          })).filter(w => w.monsters.length),
        };
        if (!half.waves.length) continue;
        if (!halvesMap.has(c.Index)) halvesMap.set(c.Index, []);
        halvesMap.get(c.Index).push(half);
      }
      out[idx] = [...halvesMap.keys()].sort((a, b) => a - b).map(roomIdx => ({ idx: roomIdx, halves: halvesMap.get(roomIdx) }));
    }
    return out;
  } catch (err) {
    logger.debug?.(`[HoYoGet][abyss_now] 取深渊 BOSS 配置失败：${err?.message || err}`);
    return {};
  }
}

/**
 * 把模式视图（sections→rooms→halves→waves→monsters）展开成「层/间/半」分组，
 * 每组带上该间的 BOSS 名单（含头像、弱点、抗性），用于排期图逐间标注。
 */
// 统一血量文本：原神/星铁/深渊 HP 字段格式不一，这里统一成「HP 数值」
function hpText(v) {
  if (v === undefined || v === null || v === '') return '';
  const t = String(v).trim();
  if (!t) return '';
  return /^HP/i.test(t) ? t : `HP ${t}`;
}

async function groupsFromView(view) {
  const groups = [];
  for (const sec of view?.sections || []) {
    const multiRoom = (sec.rooms || []).length > 1;
    for (const room of sec.rooms || []) {
      for (const half of room.halves || []) {
        const seen = new Set();
        const bosses = [];
        for (const w of half.waves || []) {
          for (const mon of w.monsters || []) {
            if (!mon?.name || seen.has(mon.name)) continue;
            seen.add(mon.name);
            bosses.push({
              name: mon.name,
              icon: mon.icon || '',
              hp: hpText(mon.hp),
              mini: !!mon.mini,
              weak: (mon.weak || []).map(e => ({ key: e.key, cn: e.cn, icon: e.icon || '' })),
              res: flattenRes(mon.res),
            });
          }
        }
        const label = [
          sec.title,
          multiRoom && room.idx ? `第${room.idx}间` : '',
          half.label || '',
        ].filter(Boolean).join(' · ');
        if (bosses.length) {
          const items = await mapLimit(bosses, ICON_CONCURRENCY, async b => ({ ...b, icon: await inlineIcon(b.icon) }));
          groups.push({
            label,
            bosses: items,
            big: items.filter(b => !b.mini).length,
            hasMini: items.some(b => b.mini),
          });
        }
      }
    }
  }
  return groups;
}

/**
 * 多期排期总览：取最近 count 期，每期列出最高层的 Boss 名单。
 * 数据源与速览相同（Alioth 静态 JSON）。用于「深渊排期表」展示历史各期 Boss。
 */
export async function buildSchedule(mode, opts = {}) {
  if (mode.game !== 'sr' && !['abyss','theater','stygian'].includes(mode.file)) return null;
  const index = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}.json`);
  const phases = (index.Phases || []).slice(0, opts.count || 8);
  const now = Date.now();
  const rows = [];
  for (const ph of phases) {
    let bosses = [];
    let floorNo = '';
    let weaks = [];
    let buffs = [];
    try {
      const detail = await getJson(`${DATA_BASE}/${mode.data}/${LANG}/${mode.file}/${ph._id}.json`, 6 * 3600 * 1000);
      // 把关卡里的怪物补成「带自身弱点/抗性」的 Boss 条目（按名字去重）
      const seen = new Set();
      const addMon = (mon, fallbackWeak = []) => {
        const name = mon?.name;
        if (!name || seen.has(name)) return;
        seen.add(name);
        const weak = (mon.weak?.length ? mon.weak : fallbackWeak)
          .map(e => ({ key: e.key, cn: e.cn, icon: e.icon || '' }));
        bosses.push({ name, icon: mon.icon || '', hp: hpText(mon.hp), weak, res: flattenRes(mon.res) });
      };
      if (mode.game === 'sr' && mode.file === 'arbitration') {
        // 异相仲裁：Knight(骑士小关) + King(王棋Boss) 各带 StageID
        floorNo = '王棋';
        const stages = [...(detail.King || []), ...(detail.Knight || [])];
        for (const st of stages) {
          const half = srStageHalf(detail, { StageID: st.StageID, Elem: st.Elem, Half: st.Index }, '', {});
          for (const w of half.waves) for (const mon of w.monsters) addMon(mon, half.elems);
        }
        // 仲裁增益：Buffs + Knight/KingTags
        buffs.push(...buffList(valuesOf(detail.Buffs)));
        for (const t of [...(detail.KingTags || []), ...(detail.KnightTags || [])]) buffs.push(...buffList(t.Tags || []));
      } else if (mode.game === 'sr') {
        const floors = detail.Floors || [];
        if (floors.length) {
          const nums = floors.map(f => Number(f.Floor)).filter(Number.isFinite);
          const top = floors.find(f => Number(f.Floor) === Math.max(...nums)) || floors[0];
          floorNo = `第${top.Floor}层`;
          for (const st of (top.Stages || [])) {
            const half = srStageHalf(detail, st, '', {});
            for (const w of half.waves) for (const mon of w.monsters) addMon(mon, half.elems);
          }
        }
        // 关卡增益：Buff + NewBuffs + Skills + Tags（末日首领机制）
        if (detail.Buff?.Name || detail.Buff?.Desc) buffs.push(...buffList([detail.Buff]));
        buffs.push(...buffList(valuesOf(detail.NewBuffs)));
        for (const v of valuesOf(detail.Skills)) {
          const desc = [v.Desc, v.Desc2].filter(Boolean).map(cleanRich).filter(Boolean).join('；');
          if (v.Name || desc) buffs.push({ name: cleanRich(v.Name), desc });
        }
        for (const v of valuesOf(detail.Tags)) buffs.push(...buffList(valuesOf(v.Tags).length ? valuesOf(v.Tags) : [v]));
      } else if (mode.file === 'abyss') {
        const view = await buildAbyss(mode, { ...opts, periodId: ph._id });
        if (view?.sections?.length) {
          floorNo = view.sections[0].title || '';
          for (const sec of view.sections) {
            for (const room of sec.rooms || []) {
              for (const half of room.halves || []) {
                for (const w of half.waves || []) {
                  for (const mon of w.monsters || []) addMon(mon);
                }
              }
            }
          }
          // 原神没有「弱点」概念，只有抗性；首领抗性已挂在各 Boss 上
          buffs = view.buffs || [];
        }
      } else if (mode.file === 'theater') {
        // 幻想真境剧诗：Elem 是整期弱点（无法细分到单个首领），Boss[].Monsters 只给图标
        weaks = elemView('gi', detail.Elem || []);
        for (const b of (detail.Boss || [])) {
          for (const m of (b.Monsters || [])) {
            const key = String(m.ID);
            if (seen.has(key)) continue;
            seen.add(key);
            bosses.push({ name: '', icon: monsterIcon('gi', m.Icon || ''), weak: [], res: [] });
          }
        }
      } else if (mode.file === 'stygian') {
        // 幽境危战：Levels 最高档 Boss（每个 Boss 带自己的抗性）
        const lv = (detail.Levels || []).slice(-1)[0] || (detail.Levels || [])[0];
        const diffIdx = Math.max(0, (detail.Levels || []).length - 1);
        for (const id of (lv?.Monsters || [])) addMon(styMonster(detail, id, diffIdx));
      }
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_now] 排期期数 ${ph._id} 解析失败: ${err?.message || err}`);
    }
    const range = periodRange(ph.Time);
    const isCurrent = !!(range && now >= range.start && now <= range.end);
    const cut = bosses.slice(0, 8);
    const cutInline = await mapLimit(cut, ICON_CONCURRENCY, async b => ({ ...b, icon: await inlineIcon(b.icon) }));
    // 逐间分组：每层/每间/每半的 BOSS 名单，排期图按这个展示
    let groups = [];
    try {
      if (mode.build) groups = await groupsFromView(await mode.build(mode, { periodId: ph._id }));
    } catch (err) {
      logger.debug?.(`[HoYoGet][abyss_now] 排期期数 ${ph._id} 分组失败: ${err?.message || err}`);
    }
    rows.push({
      ver: ph.Ver || '',
      time: ph.Time || '',
      floorNo,
      groups,
      bosses: cutInline,
      // 整期弱点只在 Boss 没有各自弱点时展示（如幻想真境剧诗）
      weaks: weaks.length && !cut.some(b => b.weak?.length) ? weaks : [],
      buffs: buffs.filter(b => b.name || b.desc).slice(0, 4),
      isCurrent,
    });
  }
  return {
    title: mode.title,
    gameName: mode.gameName,
    gameShort: mode.gameShort,
    theme: SCHEDULE_THEMES[Object.keys(MODES).find(k => MODES[k] === mode)] || {},
    rows,
    generatedAt: moment().format('MM-DD HH:mm'),
  };
}

export class AbyssNow extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]深渊速览',
      dsc: 'Alioth 深渊当期速览（原神/星铁全玩法）',
      event: 'message',
      priority: pluginPriority('abyss_now', 100),
      rule: [
        {
          reg: '^(?:[#＃*＊]|米哈游|(?=原神|星铁|星穹|崩铁))(?:米哈游)?(?:原神|星铁|星穹|崩铁)?(?:([0-9]{1,2}\\.[0-9]{1,2}))?(?:第?([0-9]{2,4})期)?(?:上一期|上期|上一|下一期|下期|下一)?(?:([0-9]{1,2})层)?(深境螺旋|深境|深渊|幻想真境剧诗|幻想剧诗|幻想|真境|剧诗|幽境危战|幽境|危战|混沌回忆|混沌|回忆|虚构叙事|虚构|末日幻影|末日|幻影|异相仲裁|异相|仲裁|王棋)(?:([0-9]{1,2})层)?(?:上一期|上期|上一|下一期|下期|下一)?(速览|一览|详情|情报|阵容)$',
          fnc: 'overview',
        },
        {
          // 深渊排期表：列出最近多期的 Boss（#=原神、*=星铁，文字前缀已被统一归一）
          reg: '^(?:[#＃*＊]|米哈游|(?=原神|星铁|星穹|崩铁))(?:米哈游)?(?:原神|星铁|星穹|崩铁)?(深境螺旋|深境|深渊|幻想真境剧诗|幻想剧诗|幻想|真境|剧诗|幽境危战|幽境|危战|混沌回忆|混沌|回忆|虚构叙事|虚构|末日幻影|末日|幻影|异相仲裁|异相|仲裁)(排期|排期表|时间线)$',
          fnc: 'schedule',
        },
        {
          // 绝区零深渊排期：式舆防卫战 / 危局强袭战
          reg: '^[#%％]?(绝区零|绝区|zzz|ZZZ|米哈游)?\\s*(式舆防卫战|式舆|防卫战|危局强袭战|危局|强袭战|强袭)\\s*(排期|排期表|时间线)$',
          fnc: 'zzzSchedule',
        },
      ],
    });
    // 绝区零深渊数据定时写入本地快照（每 6 小时），排期生成时网络失败可回退读取
    this.task = {
      cron: '0 0 */6 * * *',
      name: '[米哈游]绝区零深渊数据快照',
      fnc: () => refreshZzzAbyssSnapshot(8).then(r => logger.info(`[HoYoGet][abyss_now] 绝区零深渊快照 ${r.ok ? '已更新' : '未更新'}（${r.files} 个文件）`)).catch(err => logger.warn(`[HoYoGet][abyss_now] 绝区零深渊快照失败: ${err?.message || err}`)),
      log: false,
    }
    // 首次加载后延迟 30 秒补一次快照（只做一次）
    if (!globalThis.__hoyoGetZzzSnapshotBoot) {
      globalThis.__hoyoGetZzzSnapshotBoot = true
      setTimeout(() => refreshZzzAbyssSnapshot(8).catch(() => {}), 30 * 1000)
    }
  }

  async overview(e) {
    const sel = parseMsg(e.msg);
    const mode = MODES[sel.modeKey];
    try {
      const view = await mode.build(mode, sel);
      if (view?.error) {
        return e.reply(view.error, true, { recallMsg: 60 });
      }
      if (!view || !view.sections?.length) {
        return e.reply('未获取到 Alioth 当期数据，请稍后再试。', true, { recallMsg: 60 });
      }
      // 不传 pct，跟随锅巴「图片渲染精度」img_quality（render.js qualityScale）。
      const img = await render('abyss_now/overview', view, { e });
      if (view.tip) await e.reply(view.tip, true, { recallMsg: 60 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][abyss_now] ${mode.title} 速览失败: ${err?.message || err}`);
      return e.reply(`${mode.title}数据获取失败，请稍后再试。`, true, { recallMsg: 60 });
    }
  }

  async zzzSchedule(e) {
    const msg = String(e.msg || '');
    const kind = /危局|强袭/.test(msg) ? 'deadly' : 'shiyu';
    try {
      const view = await inlineViewIcons(await buildZzzSchedule(kind, 8));
      if (!view || !view.rows?.length) {
        return e.reply('未获取到绝区零排期数据，请稍后再试。', true, { recallMsg: 60 });
      }
      view.theme = SCHEDULE_THEMES[kind === 'deadly' ? 'zzz_deadly' : 'zzz_shiyu'];
      const img = await render('abyss_now/schedule', view, { e });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][abyss_now] 绝区零排期失败: ${err?.message || err}`);
      return e.reply('绝区零排期数据获取失败，请稍后再试。', true, { recallMsg: 60 });
    }
  }

  async schedule(e) {
    const msg = String(e.msg || '');
    const sel = parseMsg(msg.replace(/(排期表|排期|时间线)$/, '速览'));
    const mode = MODES[sel.modeKey];
    if (!mode) return e.reply('未识别的深渊玩法', true);
    try {
      const view = await buildSchedule(mode, { count: 8 });
      if (!view || !view.rows?.length) {
        return e.reply(`未获取到${mode.title}排期数据，请稍后再试。`, true, { recallMsg: 60 });
      }
      const img = await render('abyss_now/schedule', view, { e });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][abyss_now] ${mode.title} 排期失败: ${err?.message || err}`);
      return e.reply(`${mode.title}排期数据获取失败，请稍后再试。`, true, { recallMsg: 60 });
    }
  }
}
