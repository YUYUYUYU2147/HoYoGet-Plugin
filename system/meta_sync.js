// 从线上同步 meta 资源（角色/武器/圣遗物图片与数据）
//
// 与 miao-plugin 的 installMeta 同一份数据源（作者自建服务，公开可访问）：
//   1. GET https://miao.072420.xyz/api/meta-{gs,sr}/commits   取提交列表
//   2. 每个提交带 assets.path（增量包 zip）与 files（变更清单）
//   3. 下载增量包 → unzip → 覆盖到 resources/meta-{gs,sr}
//
// 这样做的好处：仓库里不用放 300MB 图片，且 miao 卸载后仍能自己补齐资源。
// 解压依赖系统 unzip（Linux 自带；没有就提示手动解压）。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RES_ROOT = path.join(PLUGIN_ROOT, 'resources')

const HOST = () => {
  try {
    return String(globalThis.__HOYO_META_HOST__ || 'https://miao.072420.xyz').replace(/\/+$/, '')
  } catch {
    return 'https://miao.072420.xyz'
  }
}

/** 与 miao 的 installMeta 一致：分支名 meta-gs / meta-sr */
const branchOf = game => `meta-${game === 'sr' ? 'sr' : 'gs'}`
const targetOf = game => path.join(RES_ROOT, branchOf(game))
const shaFileOf = game => path.join(targetOf(game), '.sha')

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

async function fetchJson(url, timeout = 30000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

async function download(url, dest, timeout = 300000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, buf)
    return buf.length
  } finally {
    clearTimeout(timer)
  }
}

/** 解压 zip 到目录（用系统 unzip；没有就抛错让调用方提示手动处理） */
async function unzipTo(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  try {
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 120000 })
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error('系统没有 unzip，无法自动解压；请手动解压后覆盖到 resources/meta-* 目录')
    }
    throw err
  }
}

/** zip 里通常包一层顶层目录，找到真正的资源根（含 character/） */
function resolveSourceDir(extractDir) {
  if (fs.existsSync(path.join(extractDir, 'character'))) return extractDir
  for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const sub = path.join(extractDir, entry.name)
    if (fs.existsSync(path.join(sub, 'character'))) return sub
  }
  return null
}

/** 递归复制（覆盖同名文件） */
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else fs.copyFileSync(from, to)
  }
}

/**
 * 角色子目录数量：判断 meta 资源是否装全的粗判据。
 * 完整时应接近全部角色数（实测 gs 128、sr 109 个目录），取下限 100；
 * 只有增量包时目录数远少于此，据此识别半套资源。
 */
const MIN_CHAR_DIRS = 100

function countCharDirs(game) {
  try {
    return fs.readdirSync(path.join(targetOf(game), 'character'), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).length
  } catch {
    return 0
  }
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
 * 增量包只带「这次改动过的文件」，基线里的命座/天赋图标（character/<名>/icons/）
 * 和元素/武器图标（common/）不会出现在增量包里；首次安装如果只应用最新增量包，
 * 这些图会一直缺，面板上就只剩空圆圈/空方块。miao 装了的话按缺失补齐。
 *
 * 只补 common/ 和 meta-{game}/，不碰 profile/（咕咕牛自定义立绘，体积大且是用户数据）。
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

/** 全量仓库：增量包只带改动文件，基线图标只能靠全量分支 */
const FULL_REPO = 'https://cnb.cool/qsyhh_res/meta.git'

/**
 * 从全量分支补齐缺失文件（该分支 HEAD 与远端提交 sha 一致）。
 * @returns {Promise<number>} 补齐的文件数
 */
async function pullFull(game) {
  const tmp = path.join(PLUGIN_ROOT, 'temp', 'meta_full', branchOf(game) + '-' + Date.now())
  try {
    await execFileAsync('git', ['clone', '--depth', '1', '-b', branchOf(game), FULL_REPO, tmp], { timeout: 600000 })
    let copied = 0
    for (const entry of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      copied += copyMissingTree(path.join(tmp, entry.name), path.join(targetOf(game), entry.name))
    }
    return copied
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

/**
 * 同步一个游戏的 meta 资源。
 *
 * @param {string} game 'gs' | 'sr'
 * @param {object} opts { log, maxCommits } —— log 用于输出进度（可选）
 * @returns {Promise<{game, updated:number, latest:string, skipped:boolean, filled:number, chars?:number}>}
 */
export async function syncMeta(game, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const branch = branchOf(game)
  const commits = await fetchJson(`${HOST()}/api/${branch}/commits`)
  if (!Array.isArray(commits) || !commits.length) throw new Error('远程提交列表为空')

  const latest = commits[0].sha
  const local = readSha(game)
  const localChars = countCharDirs(game)
  if (local && local === latest && localChars >= MIN_CHAR_DIRS) {
    /* 版本与角色目录数都达标才跳过；半套资源仍用 miao 补齐 */
    const filled = backfillFromMiao(game)
    log(`${branch} 已是最新（${latest.slice(0, 8)}）${filled ? `，从 miao 补齐 ${filled} 个文件` : ''}`)
    return { game, updated: 0, latest, skipped: true, filled }
  }
  if (local && local === latest) {
    /* 版本标记最新但角色目录不全，不能跳过，转为全量补齐 */
    log(branch + ' 标记为最新但只有 ' + localChars + ' 个角色目录，转为全量补齐')
  }

  const workDir = path.join(PLUGIN_ROOT, 'temp', 'meta_sync', `${branch}-${Date.now()}`)
  fs.mkdirSync(workDir, { recursive: true })

  /* 没有本地版本、或版本标记最新但目录不全时，只装最新一个增量包，
     缺的部分交给后面的全量补齐；其余情况从最新往回做到本地那个提交，
     逐个应用，保证文件齐 */
  const todo = []
  if (!local || local === latest) {
    todo.push(commits[0])
  } else {
    for (const c of commits) {
      if (c.sha === local) break
      todo.push(c)
    }
    todo.reverse() // 从旧到新依次应用
    if (todo.length > 30) todo.splice(0, todo.length - 30) // 太久没同步时只补最近 30 个
  }

  let updated = 0
  for (const commit of todo) {
    const url = String(commit?.assets?.path || '').trim()
    if (!url) continue
    const zipPath = path.join(workDir, `${commit.sha.slice(0, 8)}.zip`)
    const extractDir = path.join(workDir, `x-${commit.sha.slice(0, 8)}`)
    try {
      const bytes = await download(url, zipPath)
      await unzipTo(zipPath, extractDir)
      const src = resolveSourceDir(extractDir)
      if (!src) throw new Error('增量包结构不认识（找不到 character/）')
      copyDir(src, targetOf(game))
      updated++
      log(`${branch} 应用 ${commit.sha.slice(0, 8)}（${(bytes / 1024).toFixed(0)}KB）`)
    } catch (err) {
      log(`${branch} ${commit.sha.slice(0, 8)} 失败：${err?.message || err}`)
    } finally {
      try { fs.rmSync(extractDir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
      try { fs.rmSync(zipPath, { force: true }) } catch { /* 同上 */ }
    }
  }

  try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  let filled = backfillFromMiao(game)
  if (filled) log(`${branch} 从 miao 补齐 ${filled} 个文件`)
  if (countCharDirs(game) < MIN_CHAR_DIRS) {
    try {
      filled += await pullFull(game)
    } catch (err) {
      log(branch + ' 全量补齐失败：' + (err?.message || err))
    }
  }
  const chars = countCharDirs(game)
  if (chars >= MIN_CHAR_DIRS) writeSha(game, latest)
  else log(branch + ' 资源仍不完整（' + chars + ' 个角色目录），保留旧版本标记以便重试')
  return { game, updated, latest, skipped: false, filled, chars }
}

/** 两个游戏一起同步 */
export async function syncAllMeta(opts = {}) {
  const out = []
  for (const game of ['gs', 'sr']) {
    try {
      out.push(await syncMeta(game, opts))
    } catch (err) {
      out.push({ game, error: String(err?.message || err) })
    }
  }
  return out
}
