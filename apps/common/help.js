import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, pluginPriority, yaml } from '#HoYoGet';

const HELP_PATH = './plugins/HoYoGet-Plugin/system/default/help.yaml';
const DETAIL_HELP_PATH = './plugins/HoYoGet-Plugin/system/default/help-detail.yaml';
const HELP_URL = 'https://yuyu2147.dpdns.org/';
const GLOBAL_HELP_PATH = './plugins/HoYoGet-Plugin/system/default/global_help.yaml';
const GLOBAL_HELP_CFG = './plugins/HoYoGet-Plugin/config/global_help.yaml';
const GLOBAL_THEME_ROOT = './plugins/HoYoGet-Plugin/resources/global_help/theme';
const GAME_HELP_ALIASES = {
  原神: ['原神'],
  星铁: ['星铁', '崩铁'],
  崩铁: ['星铁', '崩铁'],
  绝区零: ['绝区零'],
  崩三: ['崩三', '崩坏3', '崩坏三'],
  崩坏3: ['崩三', '崩坏3', '崩坏三'],
};
/* 各游戏的帮助主题：模板里落成 <body class="theme-xxx">，由 help.css 决定配色与纹理。
   没有单独主题时用 default（通用蓝白）。新增主题只需在这里加一条 + 在 css 里补
   一组 --g-* 变量，不用改模板。 */
/* 账号 / 签到 / 系统维护类指令：四个游戏完全通用，只保留在总览与完整帮助。
   注意别把「游戏玩法」误伤进来：这里只收与账号体系、签到、CK/设备维护相关的词。 */
const ACCOUNT_SYSTEM_RE = /签到|扫码绑定|删除stoken|刷新cookie|刷新ck|清理无效绑定|清理失效绑定|代签到|过码|设备|自动签到|签到名单|绑定列表|CK情况|cookie|ck情况|体力推送|数据模式|切换正式服|切换测试服|语音缓存|刷新卡池数据|更新卡池数据|资源预估|预估|盘点|速报|前瞻信息|原石余额|星琼余额|设置余额|米哈游 前缀/

const GAME_THEME = {
  原神: 'genshin',
  星铁: 'starrail',
  崩铁: 'starrail',
  绝区零: 'zzz',
  崩三: 'honkai3',
  崩坏3: 'honkai3',
};
/* 帮助页顶部标题/副标题：分游戏出图时换成游戏名，比「米哈游插件」更有指向性 */
const THEME_HEAD = {
  genshin: { title: '原神', sub: '命令帮助 · 提瓦特指南' },
  starrail: { title: '星穹铁道', sub: '命令帮助 · 星穹列车手册' },
  zzz: { title: '绝区零', sub: '命令帮助 · 绳网终端' },
  honkai3: { title: '崩坏3', sub: '命令帮助 · 休伯利安舰务' },
  bilibili: { title: '哔哩哔哩', sub: '命令帮助 · B站功能' },
  global: { title: '全局帮助', sub: '米哈游插件 · 全部指令速查' },
  default: { title: '米哈游插件', sub: '命令帮助 · 指令速查' },
};

/* 喵喵帮助主题的默认样式（resources/global_help/theme/default/config.js 同款） */
const GLOBAL_THEME_STYLE = {
  fontColor: '#ceb78b',
  fontShadow: 'none',
  descColor: '#eee',
  contBgColor: 'rgba(6, 21, 31, .5)',
  contBgBlur: 3,
  headerBgColor: 'rgba(6, 21, 31, .4)',
  rowBgColor1: 'rgba(6, 21, 31, .2)',
  rowBgColor2: 'rgba(6, 21, 31, .35)',
};

/** 读全局帮助：支持喵喵的 helpCfg/helpList，也兼容旧的 title/subtitle/groups */
function readGlobalHelp() {
  const file = fs.existsSync(GLOBAL_HELP_CFG) ? GLOBAL_HELP_CFG
    : (fs.existsSync(GLOBAL_HELP_PATH) ? GLOBAL_HELP_PATH : '');
  if (!file) return null;
  const raw = yaml.get(file) || {};
  if (raw.helpCfg || raw.helpList) {
    const helpCfg = raw.helpCfg || {};
    const helpList = raw.helpList || raw.helpGroup || [];
    if (!Array.isArray(helpList) || !helpList.length) return null;
    return { helpCfg, helpList };
  }
  const groups = Array.isArray(raw) ? raw : (raw.groups || raw.list || raw.data || []);
  if (!Array.isArray(groups) || !groups.length) return null;
  return {
    helpCfg: { title: raw.title || '全局帮助', subTitle: raw.subtitle || '米哈游插件 · 全部指令速查' },
    helpList: groups,
  };
}

/** 喵喵帮助图标：icon.png 是 50px 一格的雪碧图，按编号取位 */
function iconCss(icon) {
  const n = Number(icon);
  if (!n) return 'display:none';
  const x = (n - 1) % 10;
  const y = (n - x - 1) / 10;
  return `background-position:-${x * 100}px -${y * 100}px`;
}

/** 手写状态标签 → 颜色分类（与锅巴页同一套关键词） */
function tagClass(text) {
  if (/免CK|免费|无需|公开|自动|推送|定时|每天/i.test(text)) return 'green';
  if (/需CK|需要CK|需扫码|需登录|需绑定|限时/i.test(text)) return 'amber';
  if (/主人|仅主人|失效|停用/i.test(text)) return 'red';
  return 'gray';
}

function imageTags(item) {
  return String(item?.tag || '')
    .split(/[,，|｜]/)
    .map(v => v.trim())
    .filter(Boolean)
    .map(text => ({ text, cls: tagClass(text) }));
}

/** 预先把每行补齐成 colCount 列，模板只负责渲染，不再做取模运算 */
function buildHelpGroups(helpList, colCount) {
  return helpList.map(group => {
    const items = (group.list || []).map(item => ({
      title: item.title || '',
      desc: item.desc || '',
      css: iconCss(item.icon),
      tags: imageTags(item),
    }));
    const rows = [];
    for (let i = 0; i < items.length; i += colCount) {
      const row = items.slice(i, i + colCount);
      while (row.length < colCount) row.push(null);
      rows.push(row);
    }
    return { group: group.group || '未分组', auth: group.auth, rows };
  });
}

/** 可用的帮助主题（有 main.png 的目录） */
function globalThemeNames() {
  try {
    return fs.readdirSync(GLOBAL_THEME_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && fs.existsSync(path.join(GLOBAL_THEME_ROOT, e.name, 'main.png')))
      .map(e => e.name);
  } catch {
    return ['default'];
  }
}

/** 按 helpCfg.theme / themeExclude 选一个主题，all 表示全部随机 */
function pickGlobalTheme(helpCfg) {
  const all = globalThemeNames();
  let names = all;
  const rawTheme = helpCfg.theme;
  // 支持 theme: all / '31' / '1,2' / ['1','2']
  const theme = Array.isArray(rawTheme)
    ? rawTheme
    : (typeof rawTheme === 'string' && rawTheme.includes(',')
      ? rawTheme.split(',').map(v => v.trim()).filter(Boolean)
      : rawTheme);
  const custom = Array.isArray(theme) && theme.length;
  if (custom) names = all.filter(n => theme.includes(n));
  else if (theme && theme !== 'all') names = all.filter(n => n === String(theme));
  // 只有「全部随机」才应用 themeExclude；手选主题应尊重用户选择
  if (!custom) {
    const exclude = Array.isArray(helpCfg.themeExclude) ? helpCfg.themeExclude : [];
    if (exclude.length) names = names.filter(n => !exclude.includes(n));
  }
  if (!names.length) names = all.filter(n => n !== 'default');
  if (!names.length) names = ['default'];
  return names[Math.floor(Math.random() * names.length)];
}

const _themeStyleCache = new Map();
/** 读主题 config.js 的 style（失败就用默认） */
async function loadGlobalThemeStyle(name) {
  if (_themeStyleCache.has(name)) return _themeStyleCache.get(name);
  let style = {};
  try {
    const file = path.resolve(GLOBAL_THEME_ROOT, name, 'config.js');
    if (fs.existsSync(file)) {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      style = mod?.style || {};
    }
  } catch (err) {
    logger.debug?.(`[HoYoGet][help] 主题 ${name} 读取失败: ${err?.message || err}`);
  }
  _themeStyleCache.set(name, style);
  return style;
}

const DEFAULT_BG_API = 'https://api.yppp.net/pc.php';

/** 随机背景接口大多 302 到图片；只取最终图片 URL，失败就回退本地主题 */
async function resolveRandomBg(api) {
  const url = String(api || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });
    try { await res.body?.cancel?.(); } catch { /* 忽略 */ }
    let target = '';
    if (res.status >= 300 && res.status < 400) target = res.headers.get('location') || '';
    else if (res.ok) target = url;
    if (!/^https?:\/\//i.test(target)) return '';
    // 避免把引号/括号带进 CSS url()
    if (/["'\\\n\r()]/.test(target)) return '';
    // 关键：把图片下下来转成 data URI。只给 URL 时 Chromium 可能在
    // 背景图加载完成前就截图，结果落到 CSS 里的本地默认背景。
    const img = await fetch(target, { signal: AbortSignal.timeout(8000) });
    if (!img.ok) return '';
    const type = String(img.headers.get('content-type') || '');
    if (!/^image\//i.test(type)) return '';
    const buf = Buffer.from(await img.arrayBuffer());
    if (!buf.length || buf.length > 10 * 1024 * 1024) return '';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** 按 helpCfg.background 选背景：本地主题 / 随机接口 / 各一半 */
async function pickGlobalBackground(helpCfg, themeName) {
  const mode = String(helpCfg.background || 'mix').toLowerCase();
  const api = helpCfg.backgroundApi || DEFAULT_BG_API;
  const useApi = mode === 'api' || (mode === 'mix' && Math.random() < 0.5);
  if (useApi) {
    const url = await resolveRandomBg(api);
    if (url) return { mode: 'api', url };
    logger.debug?.('[HoYoGet][help] 随机背景获取失败，回退本地主题背景');
  }
  return { mode: 'theme', url: '' };
}

/** 生成喵喵同款主题样式（宽度、配色、行底、毛玻璃） */
/* 用户自定义样式只允许这些键，避免把任意 CSS 注入模板 */
const STYLE_COLOR_KEYS = ['fontColor', 'descColor', 'titleColor', 'subTitleColor', 'fontShadow', 'contBgColor', 'headerBgColor', 'rowBgColor1', 'rowBgColor2', 'tagRed', 'tagAmber', 'tagGreen', 'tagGray'];
const STYLE_SIZE_KEYS = ['titleSize', 'groupSize', 'itemSize', 'descSize', 'contBgBlur'];

function safeCssValue(value) {
  const v = String(value ?? '').trim();
  if (!v || v.length > 120) return '';
  // 只允许颜色/阴影/尺寸这类字符，禁止 ; { } 等注入
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(v) ? v : '';
}

function safeSize(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.min(max, Math.max(min, n))}px`;
}

function safePx(value, max = 20) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${Math.min(max, Math.max(0, n))}px`;
}

function globalStyle(helpCfg, themeStyle = {}) {
  // 默认 → 主题 → 用户在锅巴里改的样式（用户优先）
  const rawStyle = { ...GLOBAL_THEME_STYLE, ...(themeStyle || {}), ...(helpCfg.style || {}) };
  const style = {};
  for (const key of STYLE_COLOR_KEYS) style[key] = safeCssValue(rawStyle[key]);
  const colCount = Math.min(5, Math.max(2, parseInt(helpCfg.colCount) || 3));
  const colWidth = Math.min(500, Math.max(100, parseInt(helpCfg.colWidth) || 265));
  const width = Math.min(2500, Math.max(800, colCount * colWidth + 30));
  const blurNum = Number(rawStyle.contBgBlur);
  const blur = helpCfg.bgBlur === false ? 'none' : `blur(${Number.isFinite(blurNum) ? Math.min(20, Math.max(0, blurNum)) : 3}px)`;
  const css = [
    `body, .container { width: ${width}px; }`,
    `.help-table .td { width: ${100 / colCount}%; }`,
    `.help-title, .help-group { color: ${style.fontColor || '#ceb78b'}; text-shadow: ${style.fontShadow || 'none'}; }`,
    `.help-desc { color: ${style.descColor || '#eee'}; }`,
    `.head-box .title { color: ${style.titleColor || '#fff'}; ${safeSize(rawStyle.titleSize, 8, 120) ? `font-size:${safeSize(rawStyle.titleSize, 8, 120)};` : ''} }`,
    `.head-box .label { color: ${style.subTitleColor || '#fff'}; }`,
    `.help-group { background: ${style.headerBgColor || 'rgba(6, 21, 31, .4)'}; ${safeSize(rawStyle.groupSize, 8, 60) ? `font-size:${safeSize(rawStyle.groupSize, 8, 60)};` : ''} }`,
    `.help-title { ${safeSize(rawStyle.itemSize, 8, 60) ? `font-size:${safeSize(rawStyle.itemSize, 8, 60)};` : ''} }`,
    `.help-desc { ${safeSize(rawStyle.descSize, 8, 60) ? `font-size:${safeSize(rawStyle.descSize, 8, 60)};` : ''} }`,
    `.cont-box { background: ${style.contBgColor || 'rgba(6, 21, 31, .5)'}; backdrop-filter: ${blur}; }`,
    `.help-table .tr:nth-child(odd) { background: ${style.rowBgColor1 || 'rgba(6, 21, 31, .2)'}; }`,
    `.help-table .tr:nth-child(even) { background: ${style.rowBgColor2 || 'rgba(6, 21, 31, .35)'}; }`,
    `.container { --help-tag-red: ${style.tagRed || '#dc2626'}; --help-tag-amber: ${style.tagAmber || '#b45309'}; --help-tag-green: ${style.tagGreen || '#15803d'}; --help-tag-gray: ${style.tagGray || '#6b7280'}; }`,
  ].join('\n');
  return { style: `<style>${css}</style>`, colCount, width };
}

const WEB_GAME_META = {
  gs: { name: '原神', color: '#f0b25a' },
  sr: { name: '星穹铁道', color: '#8fa6ff' },
  zzz: { name: '绝区零', color: '#5eead4' },
  bh3: { name: '崩坏3', color: '#f08ac0' },
  common: { name: '通用', color: '#7de2ff' },
}
const WEB_GAME_ORDER = ['gs', 'sr', 'zzz', 'bh3', 'common']

function webGameOf(text) {
  const hit = []
  if (/原神|提瓦特|原石|七圣|尘歌壶|深境螺旋|幻想真境/.test(text)) hit.push('gs')
  if (/星铁|星穹|崩铁|星琼|模拟宇宙|忘却之庭|虚构叙事|末日幻影|差分宇宙|货币战争|寰宇蝗灾/.test(text)) hit.push('sr')
  if (/绝区零|ZZZ|%|菲林|邦布|音擎|驱动盘|调频|式舆|危局|临界推演|空洞/.test(text)) hit.push('zzz')
  if (/崩三|崩坏3|崩坏三|bbb|往世乐土|超弦空间|记忆战场|休伯利安|母带/.test(text)) hit.push('bh3')
  return hit.length === 1 ? hit[0] : 'common'
}

function buildWebData(helpList, colCount) {
  const groups = helpList.map(group => {
    const items = (group.list || []).map(item => ({
      title: item.title || '',
      desc: item.desc || '',
      css: iconCss(item.icon),
      tags: imageTags(item),
      game: webGameOf(`${item.title || ''} ${item.desc || ''} ${group.group || ''}`),
    }))
    const counts = {}
    for (const item of items) counts[item.game] = (counts[item.game] || 0) + 1
    const game = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'common'
    return {
      group: group.group || '未分组',
      auth: group.auth === 'master' ? 'master' : '',
      color: WEB_GAME_META[game]?.color || '#7de2ff',
      items,
      cols: colCount,
    }
  })
  const chips = WEB_GAME_ORDER.map(key => ({
    key,
    name: WEB_GAME_META[key].name,
    count: groups.reduce((n, g) => n + g.items.filter(i => i.game === key).length, 0),
  })).filter(c => c.count > 0)
  const total = groups.reduce((n, g) => n + g.items.length, 0)
  return {
    groups,
    chips,
    stats: [
      { k: '指令总数', v: total },
      { k: '板块', v: groups.length },
      { k: '帮助主题', v: globalThemeNames().length },
      { k: '支持游戏', v: 4 },
    ],
  }
}

function webStyleCss(helpCfg, themeStyle = {}, pageWidth = 1000) {
  const raw = { ...GLOBAL_THEME_STYLE, ...(themeStyle || {}), ...(helpCfg.style || {}) }
  const color = key => safeCssValue(raw[key])
  const size = (key, def, max) => safeSize(raw[key], 8, max) || def
  const blurNum = Number(raw.contBgBlur)
  const blur = helpCfg.bgBlur === false ? 'none' : `blur(${Number.isFinite(blurNum) ? Math.min(20, Math.max(0, blurNum)) : 3}px)`
  const css = `body {
    width: ${pageWidth}px;
    --w-head: ${color('titleColor') || '#ffffff'};
    --w-sub: ${color('subTitleColor') || '#c9d7ee'};
    --w-item: ${color('fontColor') || '#f0d9a8'};
    --w-desc: ${color('descColor') || '#c7d2e5'};
    --w-panel: ${color('contBgColor') || 'rgba(6,21,31,.55)'};
    --w-group: ${color('headerBgColor') || 'rgba(6,21,31,.42)'};
    --w-card: ${color('rowBgColor1') || 'rgba(6,21,31,.35)'};
    --w-card-alt: ${color('rowBgColor2') || 'rgba(6,21,31,.28)'};
    --w-shadow: ${color('fontShadow') || 'none'};
    --w-tag-red: ${color('tagRed') || '#dc2626'};
    --w-tag-amber: ${color('tagAmber') || '#b45309'};
    --w-tag-green: ${color('tagGreen') || '#15803d'};
    --w-tag-gray: ${color('tagGray') || '#6b7280'};
    --w-title-size: ${size('titleSize', '46px', 120)};
    --w-group-size: ${size('groupSize', '16px', 60)};
    --w-item-size: ${size('itemSize', '15px', 60)};
    --w-desc-size: ${size('descSize', '12px', 60)};
    --w-blur: ${blur};
    --w-page-dim: ${Number.isFinite(Number(raw.pageDim)) ? Math.min(100, Math.max(0, Number(raw.pageDim))) / 100 : 0.45};
    --w-page-blur: ${safePx(raw.pageBlur, 20) || '2px'};
  }`
  return `<style>${css}</style>`
}

function appStyleCss(helpCfg, themeStyle = {}, pageWidth = 1000) {
  const raw = { ...GLOBAL_THEME_STYLE, ...(themeStyle || {}), ...(helpCfg.style || {}) }
  const color = key => safeCssValue(raw[key])
  const size = (key, def, max) => safeSize(raw[key], 8, max) || def
  const dimNum = Number(raw.pageDim)
  const dim = Number.isFinite(dimNum) ? Math.min(100, Math.max(0, dimNum)) / 100 : 0.88
  const blur = safePx(raw.pageBlur, 20) || '18px'
  const css = `body {
    width: ${pageWidth}px;
    --w-head: ${color('titleColor') || '#111827'};
    --w-sub: ${color('subTitleColor') || '#6b7280'};
    --w-item: ${color('fontColor') || '#111827'};
    --w-desc: ${color('descColor') || '#6b7280'};
    --w-tag-red: ${color('tagRed') || '#dc2626'};
    --w-tag-amber: ${color('tagAmber') || '#b45309'};
    --w-tag-green: ${color('tagGreen') || '#15803d'};
    --w-tag-gray: ${color('tagGray') || '#64748b'};
    --w-title-size: ${size('titleSize', '48px', 120)};
    --w-group-size: ${size('groupSize', '18px', 60)};
    --w-item-size: ${size('itemSize', '17px', 60)};
    --w-desc-size: ${size('descSize', '14px', 60)};
    --w-page-dim: ${dim};
    --w-page-blur: ${blur};
  }`
  return `<style>${css}</style>`
}

export class help extends plugin {
  constructor(e) {
    super({
      name: '[米哈游]帮助',
      dsc: '帮助',
      event: 'message',
      priority: pluginPriority('help', 100),
      rule: [
        {
          reg: '^#*米哈游(命令|帮助|菜单|help|说明|功能|指令|使用说明)$',
          fnc: 'help',
        },
        {
          reg: '^#*米哈游(原神|星铁|崩铁|绝区零|崩三|崩坏3|卡池|图鉴|攻略|B站|b站|完整)帮助$',
          fnc: 'help',
        },
        {
          // 全局帮助：抢在其它插件的 #帮助 前（优先级取最小值）
          reg: '^#*(?:全局)?帮助$',
          fnc: 'globalHelp',
          priority: Number.MIN_SAFE_INTEGER,
        },
      ],
    });
  }

  async globalHelp(e) {
    try {
      // 优先使用喵喵风格全局帮助（config/global_help.yaml），否则回退完整帮助
      const custom = readGlobalHelp();
      if (custom) {
        const helpCfg = custom.helpCfg || {};
        const helpList = custom.helpList.filter(group => !(group.auth === 'master' && !e.isMaster));
        const themeName = pickGlobalTheme(helpCfg);
        const themeStyle = await loadGlobalThemeStyle(themeName);
        const { style, colCount } = globalStyle(helpCfg, themeStyle);
        const bg = await pickGlobalBackground(helpCfg, themeName);
        const bgLabel = bg.mode === 'api' ? '随机背景' : `主题 ${themeName}`;
        // 默认 App 浅色版；可选 web 深色 / classic 喵喵
        const layout = helpCfg.layout === 'classic' ? 'classic' : (helpCfg.layout === 'web' ? 'web' : 'app');
        if (layout !== 'classic') {
          const web = buildWebData(helpList, colCount);
          // 纵向：板块上下排列；iOS 版每组单列，网页深色版按 colCount 分列
          for (const group of web.groups) group.cols = layout === 'app' ? 1 : colCount;
          const pageWidth = 1000;
          const img = await render('global_help/web', {
            helpCfg,
            ...web,
            colCount,
            layout,
            groupCols: 1,
            pageWidth,
            themeName,
            bgMode: bg.mode,
            bgUrl: bg.url,
            bgLabel,
            style: layout === 'app' ? appStyleCss(helpCfg, themeStyle, pageWidth) : webStyleCss(helpCfg, themeStyle, pageWidth),
          }, { e, pct: 1, dsf: 2 });
          return e.reply(img);
        }
        const img = await render('global_help/index', {
          helpCfg,
          helpGroup: buildHelpGroups(helpList, colCount),
          colCount,
          themeName,
          bgMode: bg.mode,
          bgUrl: bg.url,
          bgLabel,
          style,
        }, { e, pct: 1, dsf: 2 });
        return e.reply(img);
      }
      const raw = yaml.get(DETAIL_HELP_PATH) || [];
      const data = Array.isArray(raw) ? raw : (raw.list || raw.data || []);
      if (!data.length) {
        return e.reply('帮助内容为空，可在线查看：' + HELP_URL, true, { recallMsg: 60 });
      }
      const head = THEME_HEAD.global;
      const img = await render('help/help', {
        data,
        au: !!e.isMaster,
        theme: 'global',
        headTitle: head.title,
        headSub: head.sub,
      }, { e, pct: 1 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][help] 全局帮助图渲染失败: ${err?.message || err}`);
      return e.reply(`米哈游全局帮助：${HELP_URL}`, true, { recallMsg: 60 });
    }
  }

  async help(e) {
    try {
      const msg = String(e.msg || '').trim().replace(/^#+/, '');
      const command = msg.replace(/^米哈游/i, '');
      const game = Object.prototype.hasOwnProperty.call(GAME_HELP_ALIASES, command.replace(/帮助$/, ''))
        ? command.replace(/帮助$/, '')
        : '';
      const isDetail = /^(?:完整|卡池|图鉴|攻略|B站|b站)帮助$/.test(command) || !!game;
      const raw = yaml.get(isDetail ? DETAIL_HELP_PATH : HELP_PATH) || [];
      let data = Array.isArray(raw) ? raw : (raw.list || raw.data || []);
      if (game) {
        const aliases = GAME_HELP_ALIASES[game];
        /* 「全游戏通用」的命令：标题里通常同时列出多个游戏名（体力、签到、扫码绑定等），
           判定看的是「这条命令是否与具体游戏无关」，而不是模糊关键词命中——
           早先用的 shared 正则带 `体力|签到`，会把「原神体力 / 星铁体力 / 绝区零体力 / 崩三体力」
           这类**跨游戏并列**的条目混进单游戏帮助里。 */
        const GAME_WORD = /(原神|星铁|崩铁|绝区零|崩三|崩坏3|崩坏三)/
        const isCrossGame = text => {
          const words = new Set(text.match(new RegExp(GAME_WORD.source, 'g')) || [])
          return words.size >= 2   // 同时提到两个及以上游戏 = 跨游戏通用命令
        }
        const isCurrentGame = text => aliases.some(a => text.includes(a))
        /* 与具体游戏无关的分组整组剔除：
           · 主人专用命令 / 设备命令 —— 权限类，不属于任何游戏
           · bilibili命令      —— B站功能，与游戏无关（以前没排除，崩三/原神帮助里
             会混进十几条 B站指令）
           卡池计时器 / 怪物图鉴 这类分组里既有跨游戏条目、也有单游戏条目，
           不能整组剔除，交给下面的逐条过滤处理。 */
        const GAME_AGNOSTIC_GROUPS = new Set(['主人专用命令', '设备命令', 'bilibili命令'])
        data = data.filter(group => {
          if (GAME_AGNOSTIC_GROUPS.has(group.group)) return false
          if (group.group === '崩坏3') return GAME_HELP_ALIASES['崩坏3'].includes(game) || game === '崩三'
          if (group.group === '原神/星铁') return !['崩三', '崩坏3'].includes(game)
          return true
        })
        data = data.map(group => ({
          ...group,
          list: group.list.filter(item => {
            const text = `${item.title} ${item.desc}`
            /* 跨游戏并列的命令（标题里出现两个及以上游戏名，如
               「#原神UP总览 / #星铁UP总览 / #绝区零UP总览 / #崩三UP总览」）
               只在总览里出现，单游戏帮助一律不收 —— 否则每个游戏的帮助都会
               带上另外三个游戏的同名指令。 */
            if (isCrossGame(text)) return false
            // 提到别的游戏、但没提本游戏：排除
            if (GAME_WORD.test(text) && !isCurrentGame(text)) return false
            /* 账号 / 签到 / 系统维护类指令：对四个游戏完全一样，属于插件级功能，
               不该出现在任何单个游戏的帮助里（只在总览与完整帮助里出现）。
               判据是命令本身在描述「账号与系统」，而不是某个游戏的玩法内容。 */
            if (ACCOUNT_SYSTEM_RE.test(text)) return false
            return true
          })
        })).filter(group => group.list.length)
      } else if (isDetail) {
        const type = command.match(/^(卡池|图鉴|攻略|B站|b站)帮助$/)?.[1] || '';
        const matchers = {
          卡池: /卡池|复刻|UP|多久没复刻/,
          图鉴: /图鉴|怪物|首领|敌人|魔物/,
          攻略: /攻略|配队|配对|作业|阵容|一图流/,
          B站: /./,
          b站: /./,
        };
        if (type === 'B站' || type === 'b站') {
          data = data.filter(group => group.group === 'bilibili命令').map(group => ({
            ...group, group: 'B站功能',
          }));
        } else if (matchers[type]) {
          data = data.map(group => ({
            ...group,
            list: group.list.filter(item => matchers[type].test(`${item.title} ${item.desc}`))
          })).filter(group => group.list.length);
        }
      }
      if (!data.length) {
        return e.reply('帮助内容为空，可在线查看：' + HELP_URL, true, { recallMsg: 60 });
      }
      // au 为主人时才展示「主人专用指令」分组
      // 「B站帮助」是独立的主题（B站粉），不属于任何游戏
      const isBiliHelp = /^(?:B站|b站)帮助$/.test(command)
      const theme = isBiliHelp ? 'bilibili' : (game ? (GAME_THEME[game] || 'default') : 'default')
      const head = THEME_HEAD[theme] || THEME_HEAD.default
      const img = await render('help/help', {
        data,
        au: !!e.isMaster,
        theme,
        headTitle: head.title,
        headSub: head.sub,
      }, { e, pct: 1 });
      return e.reply(img);
    } catch (err) {
      logger.warn(`[HoYoGet][help] 帮助图渲染失败: ${err?.message || err}`);
      return e.reply(`米哈游命令帮助：${HELP_URL}`, true, { recallMsg: 60 });
    }
  }
}
