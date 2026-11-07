/**
 * 崩三正式服深渊排期表：数据驱动渲染。
 *
 * 数据写在 system/default/abyss_schedule.json（可用锅巴指向自定义文件），
 * 结构：
 *   title/subtitle/period/cycle/source  —— 表头信息
 *   rows[]: { date, boss, no, env, buff }
 *     - date 日期区间，如 "2026.09.25–09.27"
 *     - boss Boss 名（用于匹配图标）
 *     - no   编号，如 "#1571"
 *     - env  环境全称，如 "火焰环境"
 *     - buff 效果简写键（火/冰/雷/物/克制/影舞/流变/远程/血棘/虚数/点燃/统御）
 *
 * 渲染时自动：匹配 Boss 图标、按环境上色、生成语义化的 buff 说明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA = path.join(__dirname, 'default', 'abyss_schedule.json');
const ENEMY_ICONS = path.join(__dirname, 'default', 'bh3_enemy_icons.json');
const BATTLE_ICONS = path.join(__dirname, '..', 'resources', 'bh3_battlefield', 'boss_icons.json');

// 效果简写 → 完整说明
export const BUFF_TEXT = {
  '火': '敌人受到的火焰元素伤害增加50%，冰冻元素伤害减少50%',
  '冰': '敌人受到的冰冻元素伤害增加50%，火焰元素伤害减少50%',
  '雷': '敌人受到的雷电元素伤害增加50%，物理伤害减少50%',
  '物': '敌人受到的物理伤害增加50%，雷电元素伤害减少50%',
  '克制': '属性克制关系提升20%',
  '影舞': '每有1个【星影偕行】特性角色，全队全伤害+15%（上限30%）；【命运之轮】激活时全队全伤害+40%',
  '流变': '每有1个【天渊易位】特性角色，全队全伤害+10%；【升变之理】激活时全队全伤害+40%',
  '远程': '敌人受到的远程攻击伤害增加50%，近战攻击伤害减少50%',
  '血棘': '敌人在流血状态时受到伤害提高40%，流血伤害提高45%',
  '虚数': '虚数属性角色造成的伤害提高20%',
  '点燃': '敌人在点燃状态时受到伤害提高40%，点燃伤害提高45%',
  '统御': '召唤物伤害提高30%；场上存在自身召唤物时，角色伤害提高20%',
};

// 效果简写 → 环境圆点样式类
export const ENV_CLASS = {
  '火': 'fire', '冰': 'ice', '雷': 'thunder', '物': 'phys', '克制': 'counter',
  '影舞': 'shadow', '流变': 'flow', '远程': 'ranged', '血棘': 'blood',
  '虚数': 'imaginary', '点燃': 'ignite', '统御': 'summon',
};

// 名称别名（数据里的写法 → 图标库写法）
const ICON_ALIAS = {
  '陨冰之律者': '「陨影冰骸」',
  '支配之律者·乌合之众': '支配之律者 乌合之众',
  '迷之忍者': '谜之忍者 八重霞',
};

let _icons = null;
function loadIcons() {
  if (_icons) return _icons;
  const map = {};
  try {
    const e = JSON.parse(fs.readFileSync(ENEMY_ICONS, 'utf8')).bosses || {};
    Object.assign(map, e);
  } catch {}
  try {
    const b = JSON.parse(fs.readFileSync(BATTLE_ICONS, 'utf8')).bosses || {};
    for (const v of Object.values(b)) if (v?.name && !map[v.name]) map[v.name] = v.avatar || v.raw || '';
  } catch {}
  _icons = map;
  return map;
}

/** 按 Boss 名匹配图标，找不到返回空串 */
function iconOf(name) {
  const map = loadIcons();
  const n = ICON_ALIAS[name] || name;
  if (map[n]) return map[n];
  if (map[name]) return map[name];
  // 模糊：图鉴名包含该名或去掉后缀的关键前缀
  const key = String(name).replace(/·.*/, '').replace(/（.*/, '').replace(/\(.*/, '');
  for (const [kn, ku] of Object.entries(map)) {
    if (kn.includes(name) || (key && kn.includes(key))) return ku;
  }
  // 兜底近似
  if (name.includes('符华')) return map['识之律者'] || '';
  if (name === '冰之律者') return map['「陨影冰骸」'] || '';
  return '';
}

/**
 * 读取排期数据文件。file 留空用内置默认 JSON。
 * @returns {{title,subtitle,period,cycle,source,rows,stats}}
 */
export function readSchedule(file = '') {
  const target = file && fs.existsSync(file) ? file : DEFAULT_DATA;
  const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  const rows = (raw.rows || []).map(r => {
    const buff = String(r.buff || '');
    return {
      date: r.date || '',
      boss: r.boss || '未知',
      no: r.no || '',
      env: r.env || '',
      buff: BUFF_TEXT[buff] || r.buff || '',
      envClass: ENV_CLASS[buff] || '',
      icon: iconOf(r.boss || ''),
    };
  });
  const envSet = new Set(rows.map(r => r.env).filter(Boolean));
  return {
    title: raw.title || '崩三深渊排期表',
    subtitle: raw.subtitle || '',
    period: raw.period || '',
    cycle: raw.cycle || '',
    source: raw.source || '',
    rows,
    stats: {
      periods: rows.length,
      envCount: envSet.size,
      bossCount: new Set(rows.map(r => r.boss)).size,
    },
  };
}
