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
 * 同步一个游戏的 meta 资源。
 *
 * @param {string} game 'gs' | 'sr'
 * @param {object} opts { log, maxCommits } —— log 用于输出进度（可选）
 * @returns {Promise<{game, updated:number, latest:string, skipped:boolean}>}
 */
export async function syncMeta(game, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const branch = branchOf(game)
  const commits = await fetchJson(`${HOST()}/api/${branch}/commits`)
  if (!Array.isArray(commits) || !commits.length) throw new Error('远程提交列表为空')

  const latest = commits[0].sha
  const local = readSha(game)
  if (local && local === latest && fs.existsSync(path.join(targetOf(game), 'character'))) {
    log(`${branch} 已是最新（${latest.slice(0, 8)}）`)
    return { game, updated: 0, latest, skipped: true }
  }

  const workDir = path.join(PLUGIN_ROOT, 'temp', 'meta_sync', `${branch}-${Date.now()}`)
  fs.mkdirSync(workDir, { recursive: true })

  /* 没有本地版本就只装最新一个增量包（首次可能不完整）；
     有本地版本时从最新往回做到本地那个提交，逐个应用，保证文件齐 */
  const todo = []
  if (!local) {
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

  writeSha(game, latest)
  try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  return { game, updated, latest, skipped: false }
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
