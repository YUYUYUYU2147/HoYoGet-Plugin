import fs from 'node:fs';
import path from 'node:path';

function mergeMissing(sourceDir, targetDir, state) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    let targetStat;
    try { targetStat = fs.lstatSync(target); } catch {}

    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!targetStat || targetStat.isDirectory()) mergeMissing(source, target, state);
      else state.conflicts++;
      continue;
    }
    if (targetStat) {
      state.conflicts++;
      continue;
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      state.copied++;
    } else {
      state.conflicts++;
    }
  }
}

function isGeneratedBoxDefault(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg.only_admin === false
      && cfg.recall_time === 0
      && Array.isArray(cfg.protect_ids) && cfg.protect_ids.length === 0
      && Array.isArray(cfg.display_options) && cfg.display_options.length === 27
      && cfg.autobox?.enter === false
      && cfg.autobox?.exit === false
      && Array.isArray(cfg.autobox?.white_groups) && cfg.autobox.white_groups.length === 0;
  } catch { return false; }
}

function migrateLegacyConfig(source, target, state, { replaceGeneratedBoxDefault = false } = {}) {
  let sourceStat;
  try { sourceStat = fs.statSync(source); } catch {}
  if (!sourceStat?.isFile()) return;
  if (fs.existsSync(target)) {
    if (!replaceGeneratedBoxDefault || !isGeneratedBoxDefault(target)) {
      state.conflicts++;
      return;
    }
    let backup = `${target}.generated-default-backup`;
    if (fs.existsSync(backup)) backup = `${backup}-${Date.now()}`;
    fs.renameSync(target, backup);
    state.backups.push(backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  state.copied++;
}

/** Move runtime storage to Yunzai's shared data/HoYoGet-Plugin directory. */
export function migrateHoYoGetData(root = process.cwd(), log = () => {}) {
  const legacyDir = path.resolve(root, 'plugins/HoYoGet-Plugin/data');
  const unifiedDir = path.resolve(root, 'data/HoYoGet-Plugin');
  const backupBase = `${legacyDir}.legacy-backup`;
  fs.mkdirSync(path.dirname(unifiedDir), { recursive: true });

  const targetStat = (() => { try { return fs.lstatSync(unifiedDir); } catch {} })();
  if (targetStat && !targetStat.isDirectory()) throw new Error(`统一数据路径不是目录：${unifiedDir}`);

  const legacyStat = (() => { try { return fs.lstatSync(legacyDir); } catch {} })();
  const state = { copied: 0, conflicts: 0, backups: [] };
  const migrateSidecars = () => {
    migrateLegacyConfig(
      path.resolve(root, 'data/box/config.json'),
      path.join(unifiedDir, 'box/config.json'),
      state,
      { replaceGeneratedBoxDefault: true },
    );
    migrateLegacyConfig(
      path.resolve(root, 'data/autoGroupSign.json'),
      path.join(unifiedDir, 'autoGroupSign.json'),
      state,
    );
  };
  if (legacyStat?.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(legacyDir), fs.readlinkSync(legacyDir));
    if (resolved !== unifiedDir) throw new Error(`旧数据路径已指向其他位置：${resolved}`);
    fs.mkdirSync(unifiedDir, { recursive: true });
    migrateSidecars();
    if (state.copied) {
      log(`[HoYoGet] 迁入旧插件配置：${unifiedDir}；复制 ${state.copied} 项，目标冲突保留新目录版本 ${state.conflicts} 项${state.backups.length ? `，默认配置备份：${state.backups.join(', ')}` : ''}`);
    }
    return { unifiedDir, alreadyMigrated: true, ...state };
  }
  if (legacyStat && !legacyStat.isDirectory()) throw new Error(`旧数据路径不是目录：${legacyDir}`);

  if (legacyStat) mergeMissing(legacyDir, unifiedDir, state);
  else fs.mkdirSync(unifiedDir, { recursive: true });
  migrateSidecars();

  let backupDir = null;
  if (legacyStat) {
    backupDir = backupBase;
    if (fs.existsSync(backupDir)) backupDir = `${backupBase}-${Date.now()}`;
    fs.renameSync(legacyDir, backupDir);
  }
  fs.symlinkSync(path.relative(path.dirname(legacyDir), unifiedDir), legacyDir, 'dir');
  log(`[HoYoGet] 数据统一目录：${unifiedDir}${backupDir ? `；旧目录备份：${backupDir}` : ''}；复制 ${state.copied} 项，目标冲突保留新目录版本 ${state.conflicts} 项${state.backups.length ? `，默认配置备份：${state.backups.join(', ')}` : ''}`);
  return { unifiedDir, backupDir, alreadyMigrated: false, ...state };
}
