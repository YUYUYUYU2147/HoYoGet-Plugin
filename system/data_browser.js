import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_PAGE_SIZE = 100;
export const DATA_PREVIEW_BYTES = 256 * 1024;
export class DataBrowserError extends Error {}

export const DATA_CATEGORIES = [
  { id: 'accounts', title: '账号与凭据', icon: '🔑', description: 'CK / SK、设备令牌和签到状态等敏感数据。预览会脱敏。' },
  { id: 'gacha', title: '抽卡与账本', icon: '🎴', description: '各游戏抽卡记录、账本与导入数据。' },
  { id: 'panels', title: '面板与挑战', icon: '📊', description: '角色面板、深渊挑战、战绩与排行榜缓存。' },
  { id: 'settings', title: '插件设置', icon: '⚙️', description: '自定义开盒、群打卡等功能配置。' },
  { id: 'cache', title: '缓存与索引', icon: '🗂', description: '角色索引、别名、图库及查询缓存。' },
  { id: 'other', title: '其他数据', icon: '📦', description: '其余未归入特定用途的数据文件。' },
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
    'alias_online.json': '在线角色别名',
    'bwiki_skill_rate.json': '技能倍率表',
    'manual_gt_url.json': '手动验证码地址',
    'panel_bg.json': '面板背景设置',
    'index.json': '索引文件',
    'version.json': '版本标记',
    'userface.json': '自定义表情索引',
    'zzz_birthday_avatars.json': '绝区零角色生日头像',
    'bh3_birthday_avatars.json': '崩三角色生日头像',
    'zzz_disc_agents.json': '绝区零驱动盘代理人对照',
    'zzz_tachie.json': '绝区零成就数据',
    'zzz_portrait_index.json': '绝区零头像索引',
    'sr_art_thumb.json': '星铁立绘缩略图索引',
    'sr_art_thumb_w260.json': '星铁立绘缩略图索引（宽260）',
    'sr_icon_variant.json': '星铁图标变体',
    'sr_item_list_cache.json': '星铁物品列表缓存',
    'nanoka_ver.json': 'Nanoka 数据版本',
    'bh3_gacha_observed.yaml': '崩三卡池观测记录',
    'bh3_gacha_observed.prev.yaml': '崩三卡池观测记录（上期）',
    '【重要】数据已迁移.txt': '数据迁移说明',
    '别名配置项！.txt': '别名配置说明',


    // system/default：各游戏的别名 / 映射 / 静态配置模板
    'gs_js_names.yaml': '原神角色别名（如「雷电将军」→ 雷神）',
    'gsalias.json': '原神角色别名补充表（社区整理）',
    'gs_en_id.yaml': '原神角色中文名 → enka 英文 id（对外接口用）',
    'gs_artifact_cn.json': '原神圣遗物中文名对照',
    'gslogs.yaml': '原神抽卡常驻/限定判定数据',
    'sr_js_names.yaml': '星铁角色别名',
    'sralias.json': '星铁角色别名补充表（含主角形态）',
    'sr_en_id.yaml': '星铁角色中文名 → enka 英文 id',
    'sr_content_id.json': '星铁内容 id 对照表',
    'sr_workshop_names.json': '星铁工坊遗器/角色名称对照',
    'sr_logs.yaml': '星铁抽卡卡池数据',
    'zzz_js_names.yaml': '绝区零角色别名',
    'zzzalias.json': '绝区零角色别名补充表',
    'zzz_wq_names.yaml': '绝区零音擎别名',
    'zzz_syw_names.yaml': '绝区零驱动盘（遗器）别名',
    'zzz_yq_names.yaml': '绝区零邦布别名',
    'zzz_boss_name.yaml': '绝区零 Boss 名称对照',
    'zzz_boss_meta.yaml': '绝区零 Boss 属性与弱点',
    'zzz_icons.json': '绝区零图标索引',
    'zzz_item_stat.json': '绝区零物品属性',
    'zzz_weapon_stat.json': '绝区零音擎属性',
    'zzz_char_stat.json': '绝区零角色属性',
    'zzz_skill_rate.json': '绝区零技能倍率',
    'zzz_display_weapon.json': '绝区零专武显示配置',
    'zzz_extreme.yaml': '绝区零极限面板预设',
    'zzz_gacha_pool_history.yaml': '绝区零卡池历史',
    'zzz_buff.json': '绝区零 buff 定义',
    'zzz_chip_icons.json': '绝区零驱动盘图标',
    'bh3_js_names.yaml': '崩三女武神别名',
    'bh3_wq_names.yaml': '崩三武器别名',
    'bh3_syw_names.yaml': '崩三圣痕别名',
    'bh3_yq_names.yaml': '崩三人偶（协同者）别名',
    'bh3_boss_names.yaml': '崩三 Boss 名称对照',
    'bh3_gacha_pool_history.yaml': '崩三卡池历史',
    'wqname.yaml': '武器别名（通用）',
    'gz_names.yaml': '光锥别名（如「记一位星神的陨落」→ 星神陨落）',
    'syw.yaml': '遗器/圣痕别名（如「不老者的仙舟」）',
    'yiqi.yaml': '遗器套装别名',
    'help.yaml': '帮助菜单文案',
    'help-detail.yaml': '帮助详情文案',
    'global_help.yaml': '全局帮助文案',
    'manual_overrides.yaml': '手动数据覆盖项',
    'akasha_categories.json': 'Akasha 分类定义',
  };
  if (known[name]) return known[name];
  // system/default 下的模板文件已在上面的表里逐条说明，直接用名称，
  // 不再叠加「目录说明 ·」前缀，避免标题过长。
  // 目录内文件：用「目录说明 · 文件名」让用途更直观
  const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
  const DIR_HINTS = {
    Stoken: '登录凭据',
    fp: '设备指纹',
    memes: '表情包',
    icons: '图标缓存',
    cache: '缓存',
    box: '盒子数据',
    gs_gacha: '原神抽卡记录',
    sr_gacha: '崩铁抽卡记录',
    zzz_gacha: '绝区零抽卡记录',
    bh3_gacha: '崩三抽卡记录',
    zzz_panel: '绝区零面板',
    zzz_challenge: '绝区零挑战',
    bh3_abyss: '崩三深渊',
    user_faces: '自定义表情',
    akasha: 'Akasha 数据',
    alias_online: '在线别名',
    CurrencyLedger: '水晶账本',
    fortoffans: '幻想真境剧诗',
    yshelper: '原神助手',
    bwiki_skill_rate: '技能倍率',
    nanoka: 'Nanoka 数据',
  };
  const top = dir.split('/')[0];
  const hint = DIR_HINTS[top];
  const base = name.replace(/\.(json|ya?ml|db|sqlite3?|txt|webp|png|jpe?g|gif)$/i, '');
  if (hint) {
    // 随机串文件名（如表情图 aro1xote0xs7.gif）没有辨识度，只显示目录说明。
    const randomLike = /^[a-z0-9]{10,}$/i.test(base);
    return randomLike ? hint : `${hint} · ${base}`;
  }
  return base;
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
      // 目录遍历是并发写入时最容易抖动的环节：读不到就跳过整层，但不影响其他目录。
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
        // 文件可能正在被写入/替换：stat 失败时用目录项兜底，避免整个文件从列表消失。
        let stat = null;
        try { stat = await fs.stat(path.join(this.root, ...name.split('/'))); } catch { stat = null; }
        if (category === 'all' || itemCategory === category) {
          files.push({
            path: name,
            name: path.posix.basename(name),
            title,
            category: itemCategory,
            game: owner,
            gameTitle: GAME_NAMES[owner] || '通用',
            sensitive: isSensitive(name),
            size: stat ? stat.size : 0,
            modified: stat ? stat.mtime.toISOString() : '',
            unstable: !stat,
          });
        }
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

  /** 是否允许在线编辑：仅普通文本文件，且非敏感凭据。 */
  editable(relative) {
    if (isSensitive(relative)) return false;
    const ext = path.extname(relative).toLowerCase();
    if (!['.json', '.yaml', '.yml', '.txt', '.cfg', '.ini', '.toml', '.md'].includes(ext)) return false;
    return true;
  }

  /** 保存文本内容（覆盖写），带格式校验与备份。 */
  async save(value, content) {
    const relative = this.normalize(value);
    if (!this.editable(relative)) throw new DataBrowserError('该文件不支持在线编辑');
    if (typeof content !== 'string') throw new DataBrowserError('内容无效');
    if (Buffer.byteLength(content, 'utf8') > DATA_PREVIEW_BYTES) throw new DataBrowserError('内容过大，请下载后本地编辑');
    const ext = path.extname(relative).toLowerCase();
    // JSON 必须能解析、YAML 必须能过基础结构，避免保存出坏文件。
    if (ext === '.json') {
      try { JSON.parse(content); } catch (error) { throw new DataBrowserError(`JSON 格式错误：${error.message}`); }
    }
    const { file } = await this.file(relative);
    const backup = `${file}.bak`;
    try { await fs.copyFile(file, backup); } catch {}
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
    return { path: relative, size: Buffer.byteLength(content, 'utf8') };
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
    const result = { path: relative, name: path.basename(relative), size: stat.size, modified: stat.mtime.toISOString(), truncated: stat.size > buffer.length, sensitive: isSensitive(relative), editable: this.editable(relative) };
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
