// isup_patch —— 小助手抽卡「不歪率」修正补丁模块
// 问题：小助手用一份过时的常驻名单判定 UP/歪，导致 3.x 新入常驻角色（希儿/符玄等）
//       被算成不歪，不歪率虚高。
// 修复：改用卡池日程表(sr_logs.yaml / zzz_gacha_pool_history.yaml)反推 isUP：
//       isUP = 该五星的名字是否出现在「它抽出时刻所在卡池期数」的 UP 列表里。
//       这样无需维护常驻名单，开服UP池抽到标准角色、新入常驻角色都自动判对。
//
// 用法（CLI）：
//   node join_isup.mjs <导出JSON> [sr|zzz]
// 用法（模块）：
//   import { computeGachaRate } from './join_isup.mjs';
//   const r = computeGachaRate(exportJson, { game: 'sr' });  // r.character / r.weapon
//
// 导出 JSON 兼容：星铁 {roleList, weaponList} / 绝区零 UIGF {gachaLog:{list}}，字段 name|item_name 均可。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 日程表目录：本文件在 HoYoGet/ 下任意子目录都可正确定位到 system/default
const SCHEDULE_DIR = path.join(__dirname, '..', 'system', 'default');

const FAR = Date.UTC(2099, 0, 1);
const fix = n => String(n || '').replace(/&amp;/g, '&').trim();

// ---------- 时间解析 ----------
function parseTime(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/版本更新后|正式开服后|长期/.test(s)) return null; // 占位，稍后按前一期补
  const ms = new Date(s.replace(/-/g, '/')).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// ---------- 期数合并：同 timer 的多条(复刻/同窗多band)合并为一条，UP 列表取并集 ----------
function mergePeriods(periods) {
  const m = new Map();
  for (const p of periods) {
    const k = p.key || (p.start + '~' + (p.end ?? FAR));
    if (!m.has(k)) m.set(k, { key: k, start: p.start, end: p.end, role: [...p.role], weapon: [...p.weapon] });
    else {
      const e = m.get(k);
      e.role = [...new Set([...e.role, ...p.role])];
      e.weapon = [...new Set([...e.weapon, ...p.weapon])];
    }
  }
  return [...m.values()];
}

// ---------- 期数构建：合并 -> 按 end 排序 -> 补全 start 缝隙 ----------
function buildPeriods(periods) {
  periods = mergePeriods(periods);
  periods.sort((a, b) => (a.end ?? 0) - (b.end ?? 0));
  let last = 0;
  for (const p of periods) {
    if (p.start == null) p.start = last + 60000;
    last = p.end ?? FAR;
  }
  return periods;
}

// ---------- 解析：星铁 sr_logs.yaml（js_five=角色UP, gz_five=光锥UP） ----------
function parseSr(txt) {
  const blocks = txt.split(/\n- ver:/).map((b, i) => (i === 0 ? b : '- ver:' + b));
  const periods = [];
  for (const b of blocks) {
    if (!/ver:\s*\S/.test(b)) continue;
    const tline = (b.match(/time:\s*(.+)/) || [])[1]?.trim() || '';
    const [sa, ea] = tline.split('~').map(x => x.trim());
    const js = [...b.matchAll(/js_five:([\s\S]*?)(?=\n\s*(gz_five|imgs|ver):|$)/g)];
    const gz = [...b.matchAll(/gz_five:([\s\S]*?)(?=\n\s*(js_four|gz_four|imgs|ver):|$)/g)];
    const pick = m => (m[1].match(/-\s*(.+)/g) || []).map(x => fix(x.replace('-', '')));
    periods.push({
      key: sa + '~' + ea,
      start: parseTime(sa), end: parseTime(ea),
      role: pick(js[0] || { 1: '' }), weapon: pick(gz[0] || { 1: '' }),
    });
  }
  return periods;
}

// ---------- 解析：绝区零 zzz_gacha_pool_history.yaml（type=角色/武器, s=UP的S级） ----------
function parseZzz(txt) {
  const blocks = txt.split(/\n- title:/).map((b, i) => (i === 0 ? b : '- title:' + b));
  const periods = [];
  for (const b of blocks) {
    const type = (b.match(/type:\s*(\S+)/) || [])[1];
    const timer = (b.match(/timer:\s*(.+)/) || [])[1]?.trim();
    const s = (b.match(/^\s*s:\s*(.+)/m) || [])[1]?.trim();
    if (!type || !timer || !s) continue;
    const [sa, ea] = timer.split('~').map(x => x.trim());
    const p = { key: sa + '~' + ea, start: parseTime(sa), end: parseTime(ea), role: [], weapon: [] };
    if (type === '角色') p.role.push(s);
    else if (type === '武器') p.weapon.push(s);
    // 邦布/其他 type 不影响角色/音擎池的 UP 判定
    periods.push(p);
  }
  return periods;
}

const SCHEDULES = {
  sr:  { file: 'sr_logs.yaml', parse: parseSr },
  zzz: { file: 'zzz_gacha_pool_history.yaml', parse: parseZzz },
};

// ---------- 名字归一化：去伴随者、统一间隔符 ----------
// 日程表写法：托帕&账账 / 丹恒•腾荒；抽卡记录写法：托帕 / 丹恒·腾荒
function normName(n) {
  n = fix(n);
  n = n.split(/[&\uFF06、，,\s]/)[0];          // 截掉伴随者（&账账 等）
  n = n.replace(/[•·⋅･]/g, '·');               // 统一间隔符 • · ⋅
  return n.trim();
}
function nameMatch(a, b) {
  a = normName(a); b = normName(b);
  return a === b || a.includes(b) || b.includes(a);
}

// ---------- isUP 查询闭包 ----------
function makeIsUP(periods) {
  return (name, t, pool) => {
    if (pool !== 'role' && pool !== 'weapon') return null; // 常驻/新手池不计入小保底
    const hit = periods.filter(p => p.start <= t && t <= (p.end ?? FAR));
    if (hit.length) return hit.some(p => p[pool].some(s => nameMatch(s, name))); // 命中含该名=UP
    // 缝隙：取最近期数兜底
    const near = periods.reduce((b, p) => {
      const c = (p.start + t) / 2, d = Math.abs(c - t);
      return (!b || d < b.d) ? { p, d } : b;
    }, { p: null, d: Infinity });
    return near.p ? near.p[pool].some(s => nameMatch(s, name)) : null;
  };
}

// ---------- 抽取导出里的五星（按卡池类型） ----------
function getList(obj) {
  if (!obj) return [];
  if (Array.isArray(obj)) return obj;
  if (Array.isArray(obj.list)) return obj.list;
  return [];
}
function extractFiveStars(json) {
  let recs = [];
  if (Array.isArray(json)) recs = json;
  else for (const k of ['roleList', 'weaponList', 'gachaLog', 'list', 'zzzGachaLog', 'hsrGachaLog'])
    recs = recs.concat(getList(json[k]));
  const role = [], weapon = [];
  for (const r of recs) {
    if (String(r.rank_type) !== '5') continue;
    const gt = String(r.gacha_type);
    const name = fix(r.name || r.item_name);
    const t = new Date(String(r.time).replace(/-/g, '/')).getTime();
    if (gt === '11') role.push({ name, t });
    else if (gt === '12') weapon.push({ name, t });
  }
  return { role, weapon };
}

// ---------- 50/50 链：歪后跳过下一张(大保底) ----------
function computePool(records, pool, isUP) {
  const sorted = records.slice().sort((a, b) => a.t - b.t);
  let w = 0, l = 0, d = 0, g = false;
  for (const r of sorted) {
    const u = isUP(r.name, r.t, pool);
    if (u === null) continue;
    if (g) { d++; g = false; continue; } // 大保底，排除
    if (u) { w++; g = false; } else { l++; g = true; }
  }
  const total = w + l;
  return { win: w, lose: l, guarantee: d, total, rate: total ? +(100 * w / total).toFixed(1) : null };
}

// ---------- 对外主接口 ----------
export function computeGachaRate(json, { game = 'sr' } = {}) {
  const sch = SCHEDULES[game];
  if (!sch) throw new Error('未知游戏: ' + game + '（支持: ' + Object.keys(SCHEDULES).join('/') + '）');
  const txt = fs.readFileSync(path.join(SCHEDULE_DIR, sch.file), 'utf8');
  const periods = buildPeriods(sch.parse(txt));
  const isUP = makeIsUP(periods);
  const { role, weapon } = extractFiveStars(json);
  return { game, character: computePool(role, 'role', isUP), weapon: computePool(weapon, 'weapon', isUP) };
}

// 供测试/调试：直接构建某游戏的 isUP 查询
export function buildIsUP(game = 'sr') {
  const sch = SCHEDULES[game];
  const txt = fs.readFileSync(path.join(SCHEDULE_DIR, sch.file), 'utf8');
  return makeIsUP(buildPeriods(sch.parse(txt)));
}

// ---------- CLI ----------
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const file = process.argv[2];
  const game = process.argv[3] || 'sr';
  if (!file) { console.log('用法: node join_isup.mjs <导出JSON> [sr|zzz]'); process.exit(1); }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = computeGachaRate(json, { game });
  const fmt = p => `不歪 ${p.win} / 小保底 ${p.total} / 大保底 ${p.guarantee} -> 不歪率 ${p.rate}%`;
  console.log(`游戏=${r.game}`);
  console.log('角色池: ' + fmt(r.character));
  console.log('武器池: ' + fmt(r.weapon));
}
