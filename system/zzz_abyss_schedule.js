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
const NANOKA = 'https://static.nanoka.cc';
const ICON_BASE = 'https://static.nanoka.cc';

const ELEM_CN = { physical: '物理', fire: '火', ice: '冰', electric: '电', ether: '以太', wind: '风' };

let _nvCache = null;
async function nanokaZzzVersion() {
  if (_nvCache) return _nvCache;
  try {
    const r = await fetch(`${NANOKA}/manifest.json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j = await r.json();
    _nvCache = j?.zzz?.latest || '';
  } catch { _nvCache = ''; }
  return _nvCache;
}

async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
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
    .map(([k]) => ELEM_CN[k] || k);
}

// 从某期详情提取主要 Boss（取最高 stage_num 的 zone 的所有怪物，去重）
function pickBosses(detail) {
  const zones = [];
  if (detail?.zone) zones.push(...Object.values(detail.zone));
  for (const m of (detail?.modes || [])) {
    if (m?.zone) zones.push(...Object.values(m.zone));
  }
  if (!zones.length) return { bosses: [], weaks: [] };
  // 取最防线（stage_num 最大）
  const maxStage = Math.max(...zones.map(z => Number(z?.stage_num) || 0));
  const topZones = zones.filter(z => (Number(z?.stage_num) || 0) === maxStage);
  const seen = new Set();
  const weakSet = new Map();
  const bosses = [];
  for (const z of topZones) {
    for (const room of Object.values(z?.layer_room || {})) {
      for (const mon of Object.values(room?.monster_list || {})) {
        const name = String(mon?.name || '').trim();
        if (!name) continue;
        for (const w of elemsOf(mon?.element, 1)) if (!weakSet.has(w)) weakSet.set(w, w);
        if (seen.has(name)) continue;
        seen.add(name);
        bosses.push({ name, icon: monsterIcon(mon?.image) });
      }
    }
  }
  return { bosses, weaks: [...weakSet.values()] };
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
    const { bosses, weaks } = pickBosses(detail);
    const begin = new Date(ph.begin).getTime();
    const end = new Date(ph.end).getTime();
    rows.push({
      ver: ph.zh || '',
      time: `${fmtTime(ph.begin)} - ${fmtTime(ph.end)}`,
      floorNo: '',
      bosses: bosses.slice(0, 8),
      weaks: weaks.map(w => ({ cn: w, icon: '' })),
      buffs: [],
      isCurrent: now >= begin && now <= end,
    });
  }

  return {
    title: kind === 'deadly' ? '危局强袭战' : '式舆防卫战',
    gameName: '绝区零',
    gameShort: 'ZENLESS ZONE ZERO',
    rows,
    generatedAt: new Date().toISOString().slice(5, 16).replace('T', ' '),
  };
}
