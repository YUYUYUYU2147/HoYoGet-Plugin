import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_PAGE_SIZE = 100;
export const DATA_PREVIEW_BYTES = 256 * 1024;
export class DataBrowserError extends Error {}

export const DATA_CATEGORIES = [
  { id: 'accounts', title: '账号与凭据', description: 'CK / SK、设备令牌和签到状态等敏感数据。预览会脱敏。' },
  { id: 'gacha', title: '抽卡与账本', description: '各游戏抽卡记录、账本与导入数据。' },
  { id: 'panels', title: '面板与挑战', description: '角色面板、深渊挑战、战绩与排行榜缓存。' },
  { id: 'settings', title: '插件设置', description: '自定义开盒、群打卡等功能配置。' },
  { id: 'cache', title: '缓存与索引', description: '角色索引、别名、图库及查询缓存。' },
  { id: 'other', title: '其他数据', description: '其余未归入特定用途的数据文件。' },
];

const GAME_NAMES = { gs: '原神', sr: '崩铁', zzz: '绝区零', bh3: '崩坏3' };
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function classify(relative) {
  const parts = relative.split('/');
  const top = parts[0].toLowerCase();
  if (['stoken', 'fp'].includes(top) || ['ck_state.json', 'invalid_stuid.json'].includes(relative)) return 'accounts';
  if (/^(gs|sr|zzz|bh3)_gacha(?:\/|$)/i.test(relative) || /gacha|ledger|authkey/i.test(relative)) return 'gacha';
  if (/^(zzz_panel|zzz_challenge|sr_gacha|bh3_abyss|yshelper|fortoffans)(\/|$)/i.test(relative)) return 'panels';
  if (relative === 'autoGroupSign.json' || top === 'box' || /^(panel_bg|manual_gt_url)/i.test(parts.at(-1))) return 'settings';
  if (/^(memes|alias_online|bwiki_skill_rate|cache|icons)(\/|$)/i.test(relative) || /index|cache|map|thumb|version/i.test(parts.at(-1))) return 'cache';
  return 'other';
}

function gameFor(relative) {
  const text = relative.toLowerCase();
  for (const key of ['gs', 'sr', 'zzz', 'bh3']) {
    if (text.split('/').some(part => part === `${key}_gacha` || part === `${key}_panel` || part === `${key}_challenge`)
      || (key === 'gs' && /^(yshelper|fortoffans)(\/|$)/.test(text))) return key;
  }
  if (text.startsWith('stoken/') || text.startsWith('fp/')) return 'common';
  return 'common';
}

function titleFor(relative) {
  const name = path.posix.basename(relative);
  const known = {
    'autoGroupSign.json': '自动群打卡设置',
    'ck_state.json': '凭据状态',
    'invalid_stuid.json': '失效 UID 状态',
    'GroupName.yaml': '群名称缓存',
    'task_history.json': '任务记录',
    'config.json': '功能配置',
  };
  return known[name] || name.replace(/\.(json|ya?ml|db|sqlite3?|txt)$/i, '');
}

function isSensitive(relative) {
  return relative.split('/').some(part => ['stoken', 'fp'].includes(part.toLowerCase()))
    || /(^|\/)(ck_state|invalid_stuid)\.json$/i.test(relative)
    || /(authkey|cookie|credential|login.?ticket|access.?token|refresh.?token)/i.test(relative);
}

function redactText(content) {
  return content
    .replace(/("(?:cookie|cookie_token|ck_stoken|stoken|ltoken|ltuid|mid|login_ticket|authkey|device_fp|device_id|password|secret|access.?token|refresh.?token)"\s*:\s*)("(?:\\.|[^"\\])*"|[^,}\r\n]+)/gi, '$1"[已脱敏]"')
    .replace(/^([\s-]*(?:cookie|cookie_token|ck_stoken|stoken|ltoken|ltuid|mid|login_ticket|authkey|device_fp|device_id|password|secret|access.?token|refresh.?token)\s*:\s*).+$/gim, '$1[已脱敏]');
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export class HoYoGetDataBrowser {
  constructor(root = path.resolve(process.cwd(), 'data/HoYoGet-Plugin')) {
    this.root = path.resolve(root);
  }

  normalize(value = '') {
    if (typeof value !== 'string' || value.length > 2048 || CONTROL_CHARS.test(value) || /^[a-z]:/i.test(value)) {
      throw new DataBrowserError('数据路径无效');
    }
    const normalized = value.replaceAll('\\', '/');
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) throw new DataBrowserError('路径必须位于 HoYoGet 数据目录内');
    return normalized.split('/').filter(part => part && part !== '.').join('/');
  }

  async resolve(value = '') {
    const relative = this.normalize(value);
    const root = await fs.realpath(this.root);
    const file = path.join(root, ...relative.split('/').filter(Boolean));
    let current = root;
    for (const part of relative.split('/').filter(Boolean)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new DataBrowserError('不跟随符号链接读取数据');
    }
    const real = await fs.realpath(file);
    if (!inside(root, real)) throw new DataBrowserError('路径必须位于 HoYoGet 数据目录内');
    return { file: real, relative, stat: await fs.stat(real) };
  }

  async list({ category = 'all', game = 'all', search = '', page = 1 } = {}) {
    if (!['all', ...DATA_CATEGORIES.map(item => item.id)].includes(category)) throw new DataBrowserError('数据类别无效');
    if (!['all', 'common', ...Object.keys(GAME_NAMES)].includes(game)) throw new DataBrowserError('游戏筛选无效');
    if (typeof search !== 'string' || search.length > 200) throw new DataBrowserError('搜索内容无效');
    page = Number(page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new DataBrowserError('页码无效');

    const files = [];
    const categoryCounts = Object.fromEntries(DATA_CATEGORIES.map(item => [item.id, 0]));
    let scanned = 0;
    const walk = async (relative = '') => {
      if (scanned >= 50000) return;
      let entries;
      try { entries = await fs.readdir(path.join(this.root, ...relative.split('/').filter(Boolean)), { withFileTypes: true }); }
      catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      for (const entry of entries) {
        if (++scanned > 50000) return;
        const name = [relative, entry.name].filter(Boolean).join('/');
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(name); continue; }
        if (!entry.isFile()) continue;
        const owner = gameFor(name);
        const title = titleFor(name);
        const itemCategory = classify(name);
        if (game !== 'all' && owner !== game) continue;
        if (!`${name} ${title}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) continue;
        categoryCounts[itemCategory]++;
        try {
          const stat = await fs.stat(path.join(this.root, ...name.split('/')));
          if (category === 'all' || itemCategory === category) files.push({ path: name, name: path.posix.basename(name), title, category: itemCategory, game: owner, gameTitle: GAME_NAMES[owner] || '通用', sensitive: isSensitive(name), size: stat.size, modified: stat.mtime.toISOString() });
        } catch {}
      }
    };
    try { await walk(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    files.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }));
    const offset = (page - 1) * DATA_PAGE_SIZE;
    return {
      categories: DATA_CATEGORIES.map(item => ({ ...item, count: categoryCounts[item.id] })),
      games: [{ id: 'all', title: '全部游戏' }, ...Object.entries(GAME_NAMES).map(([id, title]) => ({ id, title })), { id: 'common', title: '通用' }],
      items: files.slice(offset, offset + DATA_PAGE_SIZE), total: files.length, page, pageSize: DATA_PAGE_SIZE, truncated: scanned >= 50000,
    };
  }

  async file(value) {
    const entry = await this.resolve(value);
    if (!entry.stat.isFile()) throw new DataBrowserError('请选择普通文件');
    return entry;
  }

  async preview(value) {
    const { file, relative, stat } = await this.file(value);
    const handle = await fs.open(file, 'r');
    let buffer;
    try {
      const out = Buffer.alloc(Math.min(stat.size, DATA_PREVIEW_BYTES));
      const { bytesRead } = await handle.read(out, 0, out.length, 0);
      buffer = out.subarray(0, bytesRead);
    } finally { await handle.close(); }
    const result = { path: relative, name: path.basename(relative), size: stat.size, modified: stat.mtime.toISOString(), truncated: stat.size > buffer.length, sensitive: isSensitive(relative) };
    if (buffer.subarray(0, 16).toString() === 'SQLite format 3\0') return { ...result, kind: 'sqlite' };
    const ext = path.extname(relative).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.ico'].includes(ext)) return { ...result, kind: 'image' };
    let content = null;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer, { stream: result.truncated });
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) content = null;
    } catch {}
    if (content !== null) {
      if (result.sensitive) content = redactText(content);
      return { ...result, kind: 'text', content, redacted: result.sensitive };
    }
    const bytes = buffer.subarray(0, 4096), lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const row = bytes.subarray(offset, offset + 16);
      const hex = [...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47);
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${row.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
    }
    return { ...result, kind: 'binary', content: lines.join('\n') };
  }
}
