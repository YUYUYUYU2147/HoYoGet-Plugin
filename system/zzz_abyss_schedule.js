/**
 * 绝区零深渊排期表（式舆防卫战 / 危局强袭战）。
 * 数据源：nanoka（static.nanoka.cc）——含开服到测试服全量期数。
 *   式舆：zzz/{版本}/shiyu.json + zh/shiyu/{id}.json
 *   危局：zzz/{版本}/boss.json  + zh/boss/{id}.json
 * 每期取最高防线/关卡的主要 Boss + 弱点，渲染成排期表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const NANOKA = 'https://static.nanoka.cc';
const ICON_BASE = 'https://static.nanoka.cc';

const ELEM_CN = { physical: '物理', fire: '火', ice: '冰', electric: '电', ether: '以太', wind: '风' };

// 本地元素图标（在线无稳定地址）：转 data URI 并缓存
const ELEM_ICON_FILE = {
  physical: 'zzz_challenge/element/Physical.png',
  fire: 'zzz_challenge/element/Fire.png',
  ice: 'zzz_challenge/element/Ice.png',
  electric: 'zzz_challenge/element/Electric.png',
  ether: 'zzz_challenge/element/Ether.png',
  wind: 'zzz_challenge/element/Wind.png',
};
const _elemIconCache = new Map();
function elemIcon(key) {
  if (_elemIconCache.has(key)) return _elemIconCache.get(key);
  let uri = '';
  const rel = ELEM_ICON_FILE[key];
  try {
    if (rel) {
      const abs = path.join(PLUGIN_ROOT, 'resources', rel);
      if (fs.existsSync(abs)) uri = `data:image/png;base64,${fs.readFileSync(abs).toString('base64')}`;
    }
  } catch {}
  _elemIconCache.set(key, uri);
  return uri;
}
function elemItem(key) {
  return { key, cn: ELEM_CN[key] || key, icon: elemIcon(key) };
}

// 本地快照：定时刷新写入，网络失败时回退读取（data/abyss_cache/nanoka_zzz.json）
const CACHE_FILE = path.join(PLUGIN_ROOT, 'data', 'abyss_cache', 'nanoka_zzz.json')
const MANIFEST_URL = `${NANOKA}/manifest.json`
let _snapshot = null
let _recording = null // 刷新时记录本轮成功拉取的 URL -> JSON

function readSnapshot() {
  if (_snapshot !== null) return _snapshot
  try {
    _snapshot = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))?.files || {}
  } catch {
    _snapshot = {}
  }
  return _snapshot
}

async function getJson(url) {
  let data = null
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) })
    if (r.ok) data = await r.json()
  } catch {}
  if (data) {
    if (_recording) _recording[url] = data
    return data
  }
  // 网络失败：用本地快照兜底
  return readSnapshot()[url] ?? null
}

async function nanokaZzzVersion() {
  const j = await getJson(MANIFEST_URL)
  return j?.zzz?.latest || ''
}

/**
 * 定时刷新：把排期要用的 manifest / 列表 / 详情全部拉一遍写入本地快照。
 * 失败不覆盖旧快照（只有拿到的数据才写入）。
 */
export async function refreshZzzAbyssSnapshot(count = 8) {
  const recording = {}
  _recording = recording
  try {
    await buildZzzSchedule('shiyu', count)
    await buildZzzSchedule('deadly', count)
  } finally {
    _recording = null
  }
  if (!Object.keys(recording).length) return { ok: false, files: 0 }
  // 合并旧快照：本轮没拿到的 URL 保留旧数据，避免部分失败时丢失
  const merged = { ...readSnapshot(), ...recording }
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), files: merged }))
  _snapshot = merged
  return { ok: true, files: Object.keys(recording).length }
}

// 怪物图标：nanoka 的 image 是 UI/Sprite/... 路径，转成 assets 地址
function monsterIcon(image = '') {
  if (!image) return '';
  const base = String(image).split('/').pop().replace(/\.png$/i, '');
  return `${ICON_BASE}/assets/zzz/${base}.webp`;
}

// element 里 1=弱点，-1=抗性
function elemsOf(element = {}, sign) {
  return Object.entries(element || {})
    .filter(([, v]) => Number(v) === sign)
    .map(([k]) => elemItem(k));
}

// 从某期详情提取主要 Boss（取最高 stage_num 的 zone 的所有怪物，去重）
// 每个 Boss 带上自己的弱点/抗性，而不是整期汇总。
function zzzHp(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `HP ${Math.round(n).toLocaleString('en-US')}` : '';
}

// 试炼（危局强袭战）每期有多个难度：modes[].zone_type 1001 为普通（3 间，stage 1-3），1002 为困难（1 间）
const ZZZ_MODE_NAME = { 1001: '普通', 1002: '困难' };

// 式舆防卫战：只取最防线（stage_num 最大）的区域，按区域/层分组（与此前一致）
function pickBossesShiyu(detail) {
  const zones = [];
  if (detail?.zone) zones.push(...Object.values(detail.zone));
  for (const m of (detail?.modes || [])) if (m?.zone) zones.push(...Object.values(m.zone));
  if (!zones.length) return { bosses: [], groups: [] };
  const maxStage = Math.max(...zones.map(z => Number(z?.stage_num) || 0));
  const topZones = zones.filter(z => (Number(z?.stage_num) || 0) === maxStage);
  const seen = new Set();
  const bosses = [];
  const groups = [];
  topZones.forEach((z, zi) => {
    const zoneLabel = topZones.length > 1 ? `区域${zi + 1}` : '';
    Object.values(z?.layer_room || {}).forEach((room, li) => {
      const monsters = [];
      for (const mon of Object.values(room?.monster_list || {})) {
        const name = String(mon?.name || '').trim();
        if (!name) continue;
        const item = { name, icon: monsterIcon(mon?.image), hp: zzzHp(mon?.stats?.hp), weak: elemsOf(mon?.element, 1), res: elemsOf(mon?.element, -1) };
        monsters.push(item);
        if (!seen.has(name)) { seen.add(name); bosses.push(item); }
      }
      if (monsters.length) groups.push({ label: [zoneLabel, `第${li + 1}间`].filter(Boolean).join(' · '), bosses: monsters });
    });
  });
  return { bosses, groups };
}

function pickBosses(detail, kind = 'shiyu') {
  if (kind !== 'deadly') return pickBossesShiyu(detail);
  const seen = new Set();
  const bosses = [];
  // 每个难度、每个间（stage）各自一组，标注难度 + 第几间
  const groups = [];
  const modeList = [];
  if (detail?.zone) modeList.push({ zoneType: 0, zone: detail.zone });
  for (const m of (detail?.modes || [])) if (m?.zone) modeList.push({ zoneType: Number(m.zone_type) || 0, zone: m.zone });
  modeList.sort((a, b) => a.zoneType - b.zoneType); // 普通(1001) 先于 困难(1002)
  for (const { zoneType, zone } of modeList) {
    const modeName = ZZZ_MODE_NAME[zoneType] || '';
    const zones = Object.values(zone || {}).sort((a, b) => (Number(a?.stage_num) || 0) - (Number(b?.stage_num) || 0));
    zones.forEach((z) => {
      const stageNo = Number(z?.stage_num) || 0;
      Object.values(z?.layer_room || {}).forEach((room) => {
        const monsters = [];
        for (const mon of Object.values(room?.monster_list || {})) {
          const name = String(mon?.name || '').trim();
          if (!name) continue;
          const item = {
            name,
            icon: monsterIcon(mon?.image),
            hp: zzzHp(mon?.stats?.hp),
            weak: elemsOf(mon?.element, 1),
            res: elemsOf(mon?.element, -1),
          };
          monsters.push(item);
          if (!seen.has(name)) { seen.add(name); bosses.push(item); }
        }
        if (monsters.length) {
          groups.push({
            label: [modeName, stageNo ? `第${stageNo}间` : ''].filter(Boolean).join(' · '),
            bosses: monsters,
          });
        }
      });
    });
  }
  return { bosses, groups };
}

function fmtTime(s = '') {
  return String(s || '').replace(/-/g, '/').slice(0, 10);
}

/**
 * 取最近 count 期。kind='shiyu' 式舆 / 'deadly' 危局。
 * @returns {Promise<{title, gameName, gameShort, rows[], generatedAt}>}
 */
export async function buildZzzSchedule(kind = 'shiyu', count = 8) {
  const nv = await nanokaZzzVersion();
  if (!nv) return null;
  const listFile = kind === 'deadly' ? 'boss.json' : 'shiyu.json';
  const detailDir = kind === 'deadly' ? 'boss' : 'shiyu';
  const index = await getJson(`${NANOKA}/zzz/${nv}/${listFile}`);
  if (!index) return null;

  // 挑出有 begin/end 的期，排除「极限/长周期」特殊节点（begin/end 跨度 > 40 天）
  // 字段名两套：普通期用 live_begin/live_end，长周期特殊节点用 begin/end
  let phases = Object.entries(index)
    .map(([id, v]) => ({
      id,
      begin: v?.live_begin || v?.begin,
      end: v?.live_end || v?.end,
      zh: v?.zh || v?.name || '',
    }))
    .filter(p => p.begin && p.end)
    .map(p => ({ ...p, spanDays: (new Date(p.end) - new Date(p.begin)) / 86400000 }))
    .filter(p => p.spanDays > 0 && p.spanDays <= 40)
    .sort((a, b) => new Date(b.begin) - new Date(a.begin));

  // 去掉重叠的旧期：保留每段起止时间唯一的（防止同一时段多条）
  const uniq = [];
  const seenRange = new Set();
  for (const p of phases) {
    const key = `${p.begin}|${p.end}`;
    if (seenRange.has(key)) continue;
    seenRange.add(key);
    uniq.push(p);
  }
  phases = uniq.slice(0, count);

  const now = Date.now();
  const rows = [];
  for (const ph of phases) {
    const detail = await getJson(`${NANOKA}/zzz/${nv}/zh/${detailDir}/${ph.id}.json`);
    const { bosses, groups } = pickBosses(detail, kind);
    const begin = new Date(ph.begin).getTime();
    const end = new Date(ph.end).getTime();
    rows.push({
      ver: ph.zh || '',
      time: `${fmtTime(ph.begin)} - ${fmtTime(ph.end)}`,
      floorNo: '',
      bosses: bosses.slice(0, 8),
      groups: groups || [],
      weaks: [],
      buffs: [],
      isCurrent: now >= begin && now <= end,
    });
  }

  return {
    title: kind === 'deadly' ? '危局强袭战' : '式舆防卫战',
    source: 'nanoka.cc',
    gameName: '绝区零',
    gameShort: 'ZENLESS ZONE ZERO',
    rows,
    generatedAt: new Date().toISOString().slice(5, 16).replace('T', ' '),
  };
}
