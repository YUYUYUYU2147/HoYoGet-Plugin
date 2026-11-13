// 从官方 miao-plugin 仓库同步 meta 资源（角色/武器/圣遗物图片与数据）
//
// 更新方式：git pull
//   1. 在 temp/miao-meta-repo 维护一个浅克隆，只用 sparse-checkout 检出
//      resources/meta-gs 与 resources/meta-sr，避免拉取整个仓库
//   2. 每次同步 fetch 后 reset 到 origin/master（等价 git pull）
//   3. 把两个资源目录覆盖到本插件 resources/meta-{gs,sr}
//
// 官方仓库（Gitee 源已不可用）：
//   https://github.com/yoimiya-kokomi/miao-plugin
// 7.3 资源对应 PR #1328（已合并进 master）。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES_ROOT = path.join(PLUGIN_ROOT, 'resources')

const MIAO_REPO = 'https://github.com/yoimiya-kokomi/miao-plugin.git'
const MIAO_BRANCH = 'master'
const CACHE_DIR = path.join(PLUGIN_ROOT, 'temp', 'miao-meta-repo')
const SPARSE_DIRS = ['resources/meta-gs', 'resources/meta-sr']
const GIT_TIMEOUT = 30 * 60 * 1000

/** 与 miao 的资源目录命名一致：meta-gs / meta-sr */
const branchOf = game => `meta-${game === 'sr' ? 'sr' : 'gs'}`
const targetOf = game => path.join(RES_ROOT, branchOf(game))
const shaFileOf = game => path.join(targetOf(game), '.sha')

async function git(args, { cwd = PLUGIN_ROOT, timeout = GIT_TIMEOUT } = {}) {
  const ret = await execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  return String(ret.stdout || '')
}

function readSha(game) {
  try {
    const s = fs.readFileSync(shaFileOf(game), 'utf8').trim()
    return /^[0-9a-f]{40}$/i.test(s) ? s : ''
  } catch {
    return ''
  }
}

function writeSha(game, sha) {
  try {
    fs.mkdirSync(targetOf(game), { recursive: true })
    fs.writeFileSync(shaFileOf(game), sha || '', 'utf8')
  } catch { /* 写不进去不影响图片已生效 */ }
}

/* 只检出 meta 资源目录的浅克隆；已有缓存时 fetch 并快进到最新 master */
async function ensureCache() {
  if (fs.existsSync(path.join(CACHE_DIR, '.git'))) {
    let usable = false
    try {
      usable = (await git(['-C', CACHE_DIR, 'rev-parse', '--is-inside-work-tree'])).trim() === 'true'
    } catch { /* 缓存损坏 */ }
    if (usable) {
      /* 拉取失败（断网/超时）时保留现有缓存，下次再试，不要删掉重下几百 MB */
      await git(['-C', CACHE_DIR, 'fetch', '--depth', '1', 'origin', MIAO_BRANCH])
      await git(['-C', CACHE_DIR, 'reset', '--hard', 'FETCH_HEAD'])
      return
    }
    logger?.warn?.('[HoYoGet][meta] 本地 miao 仓库损坏，重新克隆')
    try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true })
  try {
    await git([
      'clone', '--filter=blob:none', '--no-checkout', '--depth', '1',
      '--branch', MIAO_BRANCH, MIAO_REPO, CACHE_DIR,
    ])
    await git(['-C', CACHE_DIR, 'sparse-checkout', 'init', '--cone'])
    await git(['-C', CACHE_DIR, 'sparse-checkout', 'set', ...SPARSE_DIRS])
    await git(['-C', CACHE_DIR, 'checkout', '-f', MIAO_BRANCH])
  } catch (err) {
    /* 老版本 git / 镜像不支持 partial clone 时退回普通浅克隆 */
    logger?.warn?.(`[HoYoGet][meta] sparse clone 失败，改用完整浅克隆：${err?.message || err}`)
    try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
    await git(['clone', '--depth', '1', '--branch', MIAO_BRANCH, MIAO_REPO, CACHE_DIR])
  }
}

async function cacheHead() {
  return (await git(['-C', CACHE_DIR, 'rev-parse', 'HEAD'])).trim()
}

/**
 * 递归复制（覆盖同名文件）。
 *
 * 用「大小 + mtime」判断是否需要覆盖：git checkout 不会重写未变化的文件，
 * 复制后把目标文件的 mtime 对齐成源文件，这样次日同步时内容没变的图片
 * 不会被重复复制几百 MB。返回实际复制的文件数。
 */
function copyTree(src, dest) {
  let copied = 0
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      /* 上游偶尔会把同名路径从文件改成目录（或反过来），先清掉旧类型 */
      try {
        if (!fs.statSync(to).isDirectory()) fs.rmSync(to, { recursive: true, force: true })
      } catch { /* 目标不存在 */ }
      copied += copyTree(from, to)
      continue
    }
    try {
      if (fs.statSync(to).isDirectory()) fs.rmSync(to, { recursive: true, force: true })
    } catch { /* 目标不存在 */ }
    let st = null
    try { st = fs.statSync(from) } catch { continue }
    let same = false
    try {
      const cur = fs.statSync(to)
      /* utimesSync 只保留到毫秒，源文件可能是亚毫秒精度，留 1ms 容差 */
      same = cur.size === st.size && Math.abs(cur.mtimeMs - st.mtimeMs) < 1
    } catch { /* 目标不存在 */ }
    if (same) continue
    fs.copyFileSync(from, to)
    try { fs.utimesSync(to, st.atime, st.mtime) } catch { /* 忽略 */ }
    copied++
  }
  return copied
}

/**
 * 角色子目录数量：判断 meta 资源是否装全的粗判据。
 * 完整时实测 gs 130、sr 110 个角色目录（character/ 下另有 alias.js/data.json 等文件，
 * 不计入）。取下限 90，既低于 sr 的实际数量，又远高于半套资源的目录数。
 */
const MIN_CHAR_DIRS = 90

function countCharDirs(game) {
  try {
    return fs.readdirSync(path.join(targetOf(game), 'character'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).length
  } catch {
    return 0
  }
}

/**
 * 本地已落地的图片数量（webp/png/jpg）。
 *
 * 只数角色目录会漏掉「有数值数据、但一张图都没有」的半套资源：
 * 版本标记与目录数都达标时会被判成已是最新而跳过，图片永远补不上。
 * 把图片数也作为跳过前提，缺失时强制走全量补齐。
 */
export function countImageFiles(game) {
  const exts = /\.(webp|png|jpe?g)$/i
  let n = 0
  const walk = dir => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (exts.test(entry.name)) n++
    }
  }
  walk(targetOf(game))
  return n
}

/**
 * 本地 miao 资源根（缺文件时用作兜底来源）。
 *
 * 依次尝试环境变量指定目录、同级 miao-plugin、/tmp 下的 miao 源码副本，
 * 以及同级任意插件目录中同时带 meta-gs 与 common 的 resources，
 * 避免 miao 改名或挪到临时目录后兜底整体失效。
 */
function miaoResRoot() {
  const candidates = []
  try {
    if (globalThis.__HOYO_MIAO_RES__) candidates.push(String(globalThis.__HOYO_MIAO_RES__))
  } catch { /* 忽略 */ }
  if (process.env.HOYO_MIAO_RES) candidates.push(process.env.HOYO_MIAO_RES)
  const pluginsDir = path.resolve(PLUGIN_ROOT, '..')
  candidates.push(path.join(pluginsDir, 'miao-plugin', 'resources'))
  candidates.push(path.join(pluginsDir, 'miao-plugin-next', 'resources'))
  candidates.push('/tmp/miao-src/resources')
  try {
    for (const name of fs.readdirSync(pluginsDir)) {
      const dir = path.join(pluginsDir, name)
      if (path.resolve(dir) === PLUGIN_ROOT) continue
      candidates.push(path.join(dir, 'resources'))
    }
  } catch { /* 忽略 */ }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'meta-gs')) && fs.existsSync(path.join(dir, 'common'))) return dir
    } catch { /* 忽略 */ }
  }
  return String()
}

/** 只复制目标目录里没有的文件，返回复制数量 */
function copyMissingTree(src, dest) {
  let copied = 0
  const walk = (from, to) => {
    let entries
    try {
      entries = fs.readdirSync(from, { withFileTypes: true })
    } catch (_) {
      return
    }
    try { fs.mkdirSync(to, { recursive: true }) } catch (_) { return }
    for (const entry of entries) {
      const a = path.join(from, entry.name)
      const b = path.join(to, entry.name)
      if (entry.isDirectory()) walk(a, b)
      else if (!fs.existsSync(b)) {
        try {
          fs.copyFileSync(a, b)
          copied++
        } catch (_) { /* 单个文件失败不影响其它 */ }
      }
    }
  }
  walk(src, dest)
  return copied
}

/**
 * 用本地 miao-plugin 的资源补齐缺失文件。
 *
 * 只补 common/ 和 meta-{game}/，不碰 profile/（自定义立绘，体积大，也不该被资源同步覆盖）。
 * @returns {number} 补齐的文件数
 */
export function backfillFromMiao(game) {
  const srcRoot = miaoResRoot()
  if (!fs.existsSync(srcRoot)) return 0
  let copied = 0
  copied += copyMissingTree(path.join(srcRoot, 'common'), path.join(RES_ROOT, 'common'))
  copied += copyMissingTree(path.join(srcRoot, branchOf(game)), targetOf(game))
  return copied
}

/** 缓存已就绪时的单游戏同步 */
async function syncOne(game, opts, latest) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const branch = branchOf(game)
  const srcDir = path.join(CACHE_DIR, 'resources', branch)
  if (!fs.existsSync(srcDir)) throw new Error(`miao 仓库缺少 resources/${branch}`)

  const local = readSha(game)
  const localChars = countCharDirs(game)
  const localImgs = countImageFiles(game)

  /* 不只看 .sha 就直接跳过：插件自动更新会 git reset --hard，把已同步的
     入库数据回退成仓库版本，而 .sha 是忽略文件、不会被重置。这里始终走一遍
     copyTree（按大小 + mtime 比对，内容没变时几乎零开销）来兜住这种情况。 */
  const files = copyTree(srcDir, targetOf(game))
  const filled = backfillFromMiao(game)
  if (filled) log(`${branch} 从 miao 补齐 ${filled} 个文件`)
  const chars = countCharDirs(game)
  const imgs = countImageFiles(game)
  if (chars >= MIN_CHAR_DIRS && imgs > 0) writeSha(game, latest)
  else log(`${branch} 资源仍不完整（${chars} 个角色目录 / ${imgs} 张图），保留旧版本标记以便重试`)

  const skipped = files === 0 && local === latest && localChars >= MIN_CHAR_DIRS && localImgs > 0
  if (skipped) {
    log(`${branch} 已是最新（${latest.slice(0, 8)} / ${localImgs} 张图）${filled ? `，从 miao 补齐 ${filled} 个文件` : ''}`)
  } else {
    if (local && local === latest && localChars < MIN_CHAR_DIRS) {
      log(`${branch} 标记为最新但只有 ${localChars} 个角色目录，重新同步资源`)
    }
    log(`${branch} 同步 ${files} 个文件（${latest.slice(0, 8)}）`)
  }
  return { game, updated: files > 0 ? 1 : 0, files, latest, skipped, filled, chars, imgs }
}

/**
 * 同步一个游戏的 meta 资源。
 *
 * @param {string} game 'gs' | 'sr'
 * @param {object} opts { log } —— log 用于输出进度（可选）
 * @returns {Promise<{game, updated:number, files:number, latest:string, skipped:boolean, filled:number, chars?:number, imgs?:number}>}
 */
export async function syncMeta(game, opts = {}) {
  await ensureCache()
  return syncOne(game, opts, await cacheHead())
}

/** 两个游戏一起同步（只拉一次仓库） */
export async function syncAllMeta(opts = {}) {
  const out = []
  let latest = ''
  try {
    await ensureCache()
    latest = await cacheHead()
  } catch (err) {
    const message = String(err?.message || err)
    for (const game of ['gs', 'sr']) out.push({ game, error: message })
    return out
  }
  for (const game of ['gs', 'sr']) {
    try {
      out.push(await syncOne(game, opts, latest))
    } catch (err) {
      out.push({ game, error: String(err?.message || err) })
    }
  }
  return out
}
