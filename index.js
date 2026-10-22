import fs from 'node:fs';
import path from 'node:path';
import NodeModule from 'node:module';

/* 全模块热重载：框架热重载只给插件入口加 cache bust，插件内部的 import 都是
   裸相对路径，会命中 ESM 缓存 —— system/ 与 apps 子目录改完仍跑旧代码。
   这里在任何插件模块被导入之前注册 resolve 钩子，让整条依赖链一起失效
   （实现见 system/hot/hooks.mjs）。
   用默认导入而非具名导入：Node < 20.6 没有 register，具名导入会在链接期直接报错，
   那样低版本连启动都起不来；这里走 typeof 判断，缺失就跳过，不影响正常加载。 */
if (!globalThis.__xhhHotHooked) {
  try {
    if (typeof NodeModule.register !== 'function') throw new Error('node:module 未提供 register（需 Node ≥ 20.6）');
    NodeModule.register('./system/hot/hooks.mjs', import.meta.url);
    globalThis.__xhhHotHooked = true;
    // 成功也要留痕：排查「热重载为什么没生效」时，先确认这一行在不在日志里
    logger.info?.('[HoYoGet] 热重载钩子已注册：插件内所有模块随热重载一起失效');
  } catch (err) {
    logger.warn?.(`[HoYoGet] 热重载钩子注册失败，仅入口可热重载：${err?.message || err}`);
  }
}
const { default: yaml } = await import('./system/yaml.js');

logger.info('\x1B[31m---------៷>ᴗ<៷---------\x1B[0m');
logger.info('\x1B[31m米哈游插件正在载入...\x1B[0m');
logger.info('\x1B[31m-------------------------\x1B[0m');

var paths = ['config/', 'temp/', 'data/', 'data/fp/', 'data/Stoken/'];

paths.map(path => {
  if (!fs.existsSync('./plugins/HoYoGet-Plugin/' + path)) {
    fs.mkdirSync('./plugins/HoYoGet-Plugin/' + path);
  }
});

let paths_ = ['config.yaml', 'sign.yaml', 'other.yaml', 'bh3_remind.yaml', 'activity_remind.yaml'];

for (const _path of paths_) {
  const cfg_path = './plugins/HoYoGet-Plugin/config/' + _path;
  const def_cfg_path = './plugins/HoYoGet-Plugin/system/default/default_config/' + _path;
  if (!fs.existsSync(cfg_path)) {
    fs.cpSync(def_cfg_path, cfg_path);
    continue;
  }

  let cfg = yaml.get('./plugins/HoYoGet-Plugin/config/' + _path);
  let def_cfg = yaml.get(def_cfg_path);

  // 只补默认配置里新增的键，绝不覆盖、绝不删除用户已有的键。
  //
  // 原来这里是「键数不一致就 fs.cpSync 整份覆盖，再把两边都有的键回填」，
  // 有两个问题（见 issue #2）：
  //   1) 整份覆盖会静默删掉所有只存在于用户配置的键。锅巴面板 setConfigData
  //      写入的键（abyss_report_sr_fiction_levels、abyss_report_zzz_shiyu_stages、
  //      bili_live_priority 等）默认配置里并没有，每次重启都会被抹掉。
  //   2) 触发条件是「键数」而不是「缺哪些键」：用户删掉一个默认键、又自己加了
  //      一个键，键数正好相等 → 整段同步被跳过，插件新增的默认键永远补不进来。
  //      反过来只要键数有差就整份覆盖，损失远大于收益。
  //
  // 现在逐键比对：默认里有、用户里没有的才补进去，其余一律不动。
  // 用户想清理废弃键可以自己删，插件不该替用户做这个决定。
  //
  // 嵌套对象要递归补：activity_remind.yaml 的 groups 就是一层对象，
  // 只比顶层的话，默认配置以后给 groups 加新游戏（如 nte: []）就补不进来。
  // 数组一律整个保留用户的（顺序和内容都是用户自己定的，不该插手）。
  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  // 只收集「缺失的键路径」，不修改内存里的对象，最后交给 yaml.setMissing 增量写盘。
  // 千万别把补完的 cfg 整个 stringify 回去 —— 那样会抹掉用户配置文件里
  // 全部注释和排版（实测 84 行注释会变成 0 行）。
  // 键路径用 \0 分隔各层，避免键名本身带 '.' 时被 setIn 拆错层级。
  const missing = [];
  const find = (userObj, defObj, prefix) => {
    for (const key in defObj) {
      if (!Object.prototype.hasOwnProperty.call(defObj, key)) continue;
      const path = prefix ? `${prefix}\0${key}` : key;
      if (!Object.prototype.hasOwnProperty.call(userObj, key)) {
        missing.push({ path, key });
        continue;
      }
      if (isPlainObject(userObj[key]) && isPlainObject(defObj[key])) {
        find(userObj[key], defObj[key], path);
      }
    }
  };
  find(cfg, def_cfg, '');
  // 取值要按整条路径在 def_cfg 里逐层走，不能只取最后一段 ——
  // 否则嵌套键（如 groups.nte）会取到 undefined，把 undefined 写进配置文件。
  const pickDefault = p => p.split('\0').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), def_cfg);
  if (missing.length && yaml.setMissing(cfg_path, missing.map(m => m.path), pickDefault)) {
    logger.info(`[HoYoGet] 配置 ${_path} 补充新增键：${missing.map(m => m.path.replace(/\0/g, '.')).join(', ')}`);
  }
}

const APP_ROOT = './plugins/HoYoGet-Plugin/apps'
const APP_SKIP_DIRS = new Set(['wiki', 'lib'])
/** 递归收集 apps 下的插件文件，返回相对 apps/ 的 POSIX 路径；wiki/、lib/ 是辅助模块目录，不是插件入口 */
function collectAppFiles(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (APP_SKIP_DIRS.has(entry.name)) continue
      out.push(...collectAppFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`))
    } else if (entry.name.endsWith('.js')) {
      out.push(`${prefix}${entry.name}`)
    }
  }
  return out
}
const files = collectAppFiles(APP_ROOT).sort()

let ret = [];

const cacheKey = Date.now();
files.forEach(file => {
  // TRSS 的插件热重载只给 index.js 加 cache bust；apps 子模块也要带版本号，
  // 否则 #重启/#热重载 后仍可能使用旧的 ESM 缓存。
  ret.push(import(`./apps/${file}?v=${cacheKey}`));
});

ret = await Promise.allSettled(ret);

let apps = {};
for (let i in files) {
  let name = files[i].replace('.js', '');

  if (ret[i].status != 'fulfilled') {
    logger.error(`载入插件错误：${logger.red(name)}`);
    logger.error(ret[i].reason);
    continue;
  }
  // 只认真正的插件类（原型继承自全局 plugin）。曾因某模块把工具函数导出在前，
  // 盲取第一个导出会把函数当类注册：new fn() 得到无 task 的对象，
  // 框架 collectTask 读 .cron 直接抛错、整个插件加载失败。
  const exportsObj = ret[i].value
  const base = globalThis.plugin
  // 不做「有 prototype 就算」的兜底：那样等于退回旧行为，工具函数仍会被当类注册
  const cls = typeof base === 'function'
    ? Object.values(exportsObj).find(v => typeof v === 'function' && v.prototype instanceof base)
    : null
  if (!cls) {
    logger.error(`[HoYoGet] ${logger.red(name)} 未导出插件类，已跳过注册`)
    continue
  }
  apps[name] = cls
}

// 启动手动验证码服务（必须在所有模块就绪后调用，config 才可读）
try {
  const { startManualGeetest } = await import('./system/manual_geetest.js');
  startManualGeetest();
} catch (err) {
  logger.error(`[HoYoGet] 手动验证码服务启动异常：${err?.message || err}`);
}

/* 自举热重载：框架的 #重载插件 实测不会重新 import ESM 入口，改完代码不生效、
   只能 #重启。所以插件自己监听 apps/ 与 system/ 的文件变化，重新 import 后就地
   把新方法拷到框架正在用的类上 —— 改完即生效，不用重启也不用发命令。
   开关在 config.yaml 的 auto_reload（缺省即开启）。 */
try {
  // ⚠ 这里不能用 config()：index.js 没有从 '#米哈游' 导入 config（那是 apps/*.js 才有的），
  //    直接用会 ReferenceError。入口读配置一律走 yaml.get。
  const cfg = yaml.get('./plugins/HoYoGet-Plugin/config/config.yaml') || {};
  if (cfg.auto_reload !== false) {
    const { startAutoReload } = await import('./system/hot/auto_reload.js');
    startAutoReload({ apps, files, root: new URL('./', import.meta.url).href, logger });
  }
} catch (err) {
  logger.error(`[HoYoGet] 自举热重载启动异常：${err?.message || err}`);
}

/* 过码服务自愈：用户部署过（venv + server.py 在）但服务没在跑时自动拉起。
   pm2 没设开机自启、进程崩溃、机器重启都会导致掉线，原来只能手动重发
   #过码部署 —— 启动时先兜一次，撞码时 system/sign.js 还会再兜一次。 */
setTimeout(async () => {
  try {
    const { deployed, ensureStarted } = await import('./system/geetest_autostart.js');
    if (!deployed()) return;
    // 入口没有 config()，按上面的既有约定走 yaml.get
    const cfg = yaml.get('./plugins/HoYoGet-Plugin/config/config.yaml') || {};
    const addr = String(cfg.auto_verify_addr ?? 'http://127.0.0.1:2149/solve').trim();
    if (!addr) return; // 显式关掉了自动过码
    let up = false;
    try {
      const resp = await fetch(`${addr.replace(/\/solve\/?$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
      up = (await resp.json())?.ok === true;
    } catch { up = false; }
    if (up) return;
    logger.mark('[HoYoGet][geetest] 过码服务未在运行，尝试自动拉起…');
    const r = await ensureStarted({ force: true });
    logger[r.started ? 'mark' : 'warn'](`[HoYoGet][geetest] 自动拉起${r.started ? '成功' : '失败'}：${r.reason}`);
  } catch (err) {
    logger.warn(`[HoYoGet][geetest] 启动自愈失败：${err?.message || err}`);
  }
}, 12000);

/* 启动后台补齐 meta 资源（角色立绘/武器/圣遗物图片）。
   以前这些图只存在于 miao-plugin 的 resources，卸载 miao 后全空；
   现在从作者的服务增量同步到本插件 resources，首次装/缺图时自动补。
   不阻塞启动，失败只记日志。 */
setTimeout(async () => {
  try {
    const { syncMeta } = await import('./system/meta_sync.js');
    for (const game of ['gs', 'sr']) {
      const target = `./plugins/HoYoGet-Plugin/resources/meta-${game}/character`;
      // 没有角色目录才需要拉；已有资源就交给 #米哈游更新资源包 手动触发
      let need = false;
      try { need = !fs.existsSync(target) || fs.readdirSync(target).length === 0; } catch { need = true; }
      if (!need) continue;
      logger.mark(`[HoYoGet][meta] ${game} 资源缺失，开始在线同步…`);
      await syncMeta(game, { log: (m) => logger.mark(`[HoYoGet][meta] ${m}`) });
    }
  } catch (err) {
    logger.warn(`[HoYoGet][meta] 在线同步资源失败：${err?.message || err}`);
  }
}, 8000);

// 补齐配置里群号对应的群名，供锅巴群白名单下拉展示
setTimeout(async () => {
  try {
    const { refreshGroupNames, cacheGroupList } = await import('./system/group_name.js');
    cacheGroupList();
    setInterval(() => {
      try {
        cacheGroupList();
      } catch {}
    }, 5 * 60 * 1000).unref?.();
    const collect = (file, pick) => {
      try {
        return pick(yaml.get('./plugins/HoYoGet-Plugin/config/' + file) || {});
      } catch {
        return [];
      }
    };
    const ids = [
      ...collect('bh3_remind.yaml', v => [...(v.groups || []), ...(v.all_note_groups || [])]),
      ...collect('sign.yaml', v => [...(v.sign_group || []), ...(v.bbs_sign_group || [])]),
      ...collect('activity_remind.yaml', v => Object.values(v.groups || {}).flat()),
      ...collect('config.yaml', v => v.groups || []),
    ].map(v => String(v).trim()).filter(Boolean);
    if (ids.length) await refreshGroupNames([...new Set(ids)]);
  } catch (err) {
    logger.debug(`[HoYoGet] 群名缓存刷新失败：${err.message}`);
  }
}, 30 * 1000);

export { apps };
