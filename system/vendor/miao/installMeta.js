import fs from "node:fs"
import path from "node:path"
import { pipeline } from "node:stream"
import { promisify } from "node:util"
import Cfg from "./components/Cfg.js"
import { miaoPath } from "#hoyo.miao.path"

const pipelineAsync = promisify(pipeline)

// 基线自身及更早的提交不保证（完整包中已包含其内容）。
const BASELINE = {
  gs: "e11ebff926d4efdaf978fed9f73d1a8fdf1c80cf",
  sr: "b2e204c0f73dc43dd510f2c8c38fe0f69266d5f3"
}

/**
 * 返回服务端基线在 commits 列表中的下标（0 = 最新）。
 * 下标大于基线（更旧）的提交服务端不提供增量附件，无法增量应用。
 * @returns {{idx:number}|null} null 表示基线未配置或不在提交列表中
 */
function baselineInfo(game, commits) {
  const base = BASELINE[game]
  if (!base || !Array.isArray(commits)) return null
  const idx = commits.findIndex((c) => c && c.sha === base)
  return idx >= 0 ? { idx } : null
}

const branchOf = (game) => `meta-${game}`
const targetOf = (game) => path.join(miaoPath, "resources", `meta-${game}`)
const shaFileOf = (game) => path.join(targetOf(game), ".sha")

let installed = false
let installing = false

const MISSING_ADMZIP_MSG = "缺少依赖 adm-zip，无法解压meta资源包，请在 miao-plugin 目录下执行 pnpm install adm-zip 后重试"

async function ensureAdmZip() {
  try {
    return (await import("adm-zip")).default
  } catch {
    throw new Error(MISSING_ADMZIP_MSG)
  }
}

async function unzip(zipPath, destDir) {
  const AdmZip = await ensureAdmZip()
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(destDir, true)
}

async function fetchJSONOnce(url, timeout = 30_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return await res.json()
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`请求超时 (${timeout}ms): ${url}`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJSON(url, timeout = 30_000, retries = 3) {
  let lastErr
  for (let i = 1; i <= retries; i++) {
    try {
      return await fetchJSONOnce(url, timeout)
    } catch (err) {
      lastErr = err
      if (i < retries) {
        logger?.mark?.(`[meta] 接口请求失败，正在重试 (${i}/${retries - 1})：${err.message}`)
        await new Promise((resolve) => setTimeout(resolve, 1000 * i))
      }
    }
  }
  throw lastErr
}

async function downloadFile(url, destPath, { timeout = 1_200_000, idleTimeout = 300_000, onProgress } = {}) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const controller = new AbortController()
  let stalled = false
  const timer = setTimeout(() => controller.abort(), timeout)
  let idleTimer = setTimeout(() => { stalled = true; controller.abort() }, idleTimeout)
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { stalled = true; controller.abort() }, idleTimeout)
  }
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    const total = parseInt(res.headers.get("content-length") || "0")
    const { Readable, Transform } = await import("node:stream")
    let received = 0
    const progress = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length
        resetIdle()
        if (onProgress) onProgress(received, total)
        cb(null, chunk)
      }
    })
    await pipelineAsync(Readable.fromWeb(res.body), progress, fs.createWriteStream(destPath))
  } catch (err) {
    if (err.name === "AbortError") {
      if (stalled) throw new Error(`下载卡死超时 (${idleTimeout}ms 无数据): ${url}`)
      throw new Error(`下载超时 (${timeout}ms): ${url}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    clearTimeout(idleTimer)
  }
}

async function downloadWithLog(url, destPath, label) {
  const STEP_MB = 20
  let lastPercentStep = -1
  let lastByteStep = -1
  await downloadFile(url, destPath, {
    onProgress: (received, total) => {
      const receivedMB = received / 1048576
      if (total > 0) {
        const percent = Math.floor((received / total) * 100)
        const step = Math.floor(percent / 20)
        if (step !== lastPercentStep) {
          lastPercentStep = step
          logger?.mark?.(`${label} ${percent}% (${receivedMB.toFixed(1)}/${(total / 1048576).toFixed(1)}MB)`)
        }
      } else {
        const step = Math.floor(receivedMB / STEP_MB)
        if (step !== lastByteStep) {
          lastByteStep = step
          logger?.mark?.(`${label} 已下载 ${receivedMB.toFixed(1)}MB...`)
        }
      }
    }
  })
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function removeDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * 解析增量包中真正的资源根目录。
 * @returns {string|null} 校验通过的根目录，null 表示包内容与提交信息不匹配
 */
function resolveIncrementalRoot(game, extractDir, commit) {
  const expected = (commit.files || [])
    .filter((file) => file?.path && file.status !== "delete")
    .map((file) => file.path)
  if (!expected.length) return extractDir

  const exists = (dir, p) => fs.existsSync(path.join(dir, p)) ||
    fs.existsSync(path.join(dir, p.normalize("NFC"))) ||
    fs.existsSync(path.join(dir, p.normalize("NFD")))
  const hits = (dir) => expected.filter((p) => exists(dir, p)).length

  let best = extractDir
  let bestHit = hits(extractDir)
  if (bestHit < expected.length) {
    for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(extractDir, entry.name)
      const hit = hits(dir)
      if (hit > bestHit) {
        best = dir
        bestHit = hit
      }
    }
  }

  if (bestHit === 0) return null
  if (bestHit < expected.length) {
    logger?.warn?.(`[meta-${game}] 增量包 (${commit.sha.slice(0, 8)}) 只包含 ${bestHit}/${expected.length} 个改动文件，可能不完整`)
  }
  return best
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true
  return fs.readdirSync(dir).length === 0
}

function readSha(game) {
  try {
    const sha = fs.readFileSync(shaFileOf(game), "utf-8").trim()
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : ""
  } catch {
    return ""
  }
}

function writeSha(game, sha) {
  try {
    fs.mkdirSync(targetOf(game), { recursive: true })
    fs.writeFileSync(shaFileOf(game), sha || "", "utf-8")
  } catch (err) {
    logger?.warn?.(`[meta-${game}] 写入版本文件失败: ${err.message}`)
    throw err
  }
}

// 下载并解压完整包
async function downloadFullPackage(game, latestSha) {
  const branch = branchOf(game)
  const zipUrl = `https://cnb.cool/qsyhh_res/meta/-/git/archive/refs/heads/${branch}.zip`
  const workDir = fs.mkdtempSync(path.join(miaoPath, `temp-${branch}-full-`))
  const zipPath = path.join(workDir, `${branch}.zip`)
  const extractDir = path.join(workDir, "extract")
  const backupDir = path.join(workDir, "backup")
  const targetDir = targetOf(game)

  logger?.mark?.(`[meta-${game}] 正在下载完整资源包 (${latestSha.slice(0, 8)})，首次安装耗时较长，请耐心等待...`)
  try {
    await downloadWithLog(zipUrl, zipPath, `[meta-${game}] 下载进度`)
    logger?.mark?.(`[meta-${game}] 下载完成，正在解压...`)
    await unzip(zipPath, extractDir)

    // cnb 归档通常带一层顶层目录，展平之
    const subDirs = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isDirectory())
    const files = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => e.isFile())
    const sourceDir = subDirs.length === 1 && files.length === 0
      ? path.join(extractDir, subDirs[0].name)
      : extractDir

    if (isDirEmpty(path.join(sourceDir, "character"))) {
      throw new Error(`meta-${game} 完整资源包校验失败：缺少 character 数据`)
    }

    let hasBackup = false
    try {
      if (fs.existsSync(targetDir)) {
        fs.renameSync(targetDir, backupDir)
        hasBackup = true
      }
      fs.renameSync(sourceDir, targetDir)
      if (hasBackup) removeDir(backupDir)
    } catch (err) {
      if (!fs.existsSync(targetDir) && hasBackup && fs.existsSync(backupDir)) {
        fs.renameSync(backupDir, targetDir)
      }
      throw err
    }
    logger?.info?.(`[meta-${game}] 完整资源包安装完成`)
  } finally {
    if (fs.existsSync(backupDir) && !fs.existsSync(targetDir)) {
      logger?.error?.(`[meta-${game}] 恢复旧资源失败，备份已保留在 ${backupDir}`)
    } else {
      removeDir(workDir)
    }
  }
}

// 下载并应用单个增量包
async function applyIncrementalUpdate(game, commit) {
  const branch = branchOf(game)
  const sha = commit.sha
  const zipUrl = (commit.assets?.path || "").trim()
  const targetDir = targetOf(game)

  const cleanupEmptyDirs = (fromDir) => {
    let dir = fromDir
    while (dir !== targetDir && dir.startsWith(targetDir)) {
      try {
        if (fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir)
          dir = path.dirname(dir)
        } else break
      } catch {
        break
      }
    }
  }

  const applyRenames = () => {
    const renamedFiles = (commit.files || []).filter((f) => f.status === "rename" && f.previous_filename)
    for (const file of renamedFiles) {
      const oldPath = path.join(targetDir, file.previous_filename)
      const newPath = path.join(targetDir, file.path)
      if (fs.existsSync(newPath)) {
        if (fs.existsSync(oldPath)) {
          fs.rmSync(oldPath, { recursive: true, force: true })
          cleanupEmptyDirs(path.dirname(oldPath))
        }
        continue
      }
      if (!fs.existsSync(oldPath)) continue
      fs.mkdirSync(path.dirname(newPath), { recursive: true })
      fs.renameSync(oldPath, newPath)
      cleanupEmptyDirs(path.dirname(oldPath))
    }
  }

  const applyDeletions = () => {
    const deletedFiles = (commit.files || []).filter((f) => f.status === "delete")
    for (const file of deletedFiles) {
      const filePath = path.join(targetDir, file.path)
      if (!fs.existsSync(filePath)) continue
      fs.rmSync(filePath, { recursive: true, force: true })
      cleanupEmptyDirs(path.dirname(filePath))
    }
  }

  if (!zipUrl) {
    applyRenames()
    applyDeletions()
    return
  }

  const workDir = fs.mkdtempSync(path.join(miaoPath, `temp-${branch}-inc-`))
  const zipPath = path.join(workDir, `${sha.slice(0, 8)}.zip`)
  const extractDir = path.join(workDir, "extract")

  try {
    await downloadFile(zipUrl, zipPath)
    await unzip(zipPath, extractDir)

    const sourceDir = resolveIncrementalRoot(game, extractDir, commit)
    if (!sourceDir) {
      const err = new Error(`meta-${game} 增量包 (${sha.slice(0, 8)}) 内容与提交信息不匹配，无法定位资源根目录`)
      err.metaBadPackage = true
      throw err
    }

    copyDir(sourceDir, targetDir)

    applyRenames()
    applyDeletions()
  } finally {
    removeDir(workDir)
  }
}

// 每个 game 的串行锁：避免后台安装(backgroundSync)与手动更新(#喵喵更新meta资源)并发写同一目录
const branchLocks = new Map()

/**
 * 串行执行单个 game 的安装/更新（同 game 并发时排队等待，避免目录竞争）
 * @param {string} game gs | sr
 * @param {object} opts
 */
async function processBranch(game, opts = {}) {
  const prev = branchLocks.get(game)
  if (prev) {
    try {
      await prev
    } catch {
      // 前序任务失败不影响本次执行
    }
  }
  let task
  task = doProcessBranch(game, opts).finally(() => {
    if (branchLocks.get(game) === task) branchLocks.delete(game)
  })
  branchLocks.set(game, task)
  return task
}

/**
 * 处理单个 game 的安装/更新（实际逻辑，由 processBranch 串行调用）
 * @param {string} game gs | sr
 * @param {object} opts
 * @param {boolean} opts.force 强制重新完整下载
 * @param {boolean} opts.installOnly 仅在缺失时安装，已存在则跳过（不做增量更新）
 * @returns {Promise<{game:string, status:string, message:string, count:number, sha:string}>}
 */
async function doProcessBranch(game, { force = false, installOnly = false } = {}) {
  const branch = branchOf(game)
  const targetDir = targetOf(game)
  const localSha = readSha(game)
  const dirExists = !isDirEmpty(path.join(targetDir, "character"))

  if (dirExists && localSha && installOnly && !force) return { game, status: "exists", message: "资源包已存在", count: 0, sha: localSha }

  const commits = await fetchJSON(`${Cfg.get("metaHost", "https://miao.072420.xyz") || "https://miao.072420.xyz"}/api/${branch}/commits`)
  if (!Array.isArray(commits) || commits.length === 0) return { game, status: "error", message: "远程提交列表为空", count: 0, sha: localSha }
  const latestSha = commits[0].sha

  if (force) {
    await downloadFullPackage(game, latestSha)
    writeSha(game, latestSha)
    return { game, status: "full", message: "已强制重新下载最新资源", count: 0, sha: latestSha }
  }

  if (!dirExists || !localSha) {
    await downloadFullPackage(game, latestSha)
    writeSha(game, latestSha)
    return { game, status: "install", message: "资源包安装成功", count: 0, sha: latestSha }
  }

  if (localSha === latestSha) return { game, status: "latest", message: "已经是最新了", count: 0, sha: localSha }

  const localIndex = commits.findIndex((c) => c.sha === localSha)
  if (localIndex === -1) {
    await downloadFullPackage(game, latestSha)
    writeSha(game, latestSha)
    return { game, status: "full", message: "本地版本过旧，已重新完整下载", count: 0, sha: latestSha }
  }

  const baseline = baselineInfo(game, commits)
  if (baseline && localIndex > baseline.idx) {
    logger?.warn?.(`[meta-${game}] 本地版本早于基线，无法增量更新，重新完整下载`)
    await downloadFullPackage(game, latestSha)
    writeSha(game, latestSha)
    return { game, status: "full", message: "本地版本过旧，已重新完整下载", count: 0, sha: latestSha }
  }

  const pendingCommits = commits.slice(0, localIndex).reverse()
  const missingPayload = pendingCommits.find((commit) => {
    const hasChangedFile = (commit.files || []).some((file) => ![ "delete", "rename" ].includes(file.status))
    if (!hasChangedFile) return false
    if ((commit.assets?.path || "").trim()) return false
    return true
  })
  if (missingPayload) {
    if (missingPayload.assets?.hasFile) {
      logger?.mark?.(`[meta-${game}] 检测到 hasFile 标记提交 (${missingPayload.sha.slice(0, 8)})，增量附件尚未就绪，暂不更新`)
      return { game, status: "pending", message: "增量附件尚未就绪 (hasFile)，暂不更新", count: 0, sha: localSha }
    }
    logger?.warn?.(`[meta-${game}] 增量资源不完整（该提交存在文件改动但缺少增量附件），回退完整下载 (${missingPayload.sha.slice(0, 8)})`)
    await downloadFullPackage(game, latestSha)
    writeSha(game, latestSha)
    return { game, status: "full", message: "增量资源不完整，已重新完整下载", count: 0, sha: latestSha }
  }

  let count = 0
  const messages = []
  for (const commit of pendingCommits) {
    await applyIncrementalUpdate(game, commit)
    count++
    const msg = (commit.commit?.message || "").trim()
    if (msg) messages.push(msg)
    writeSha(game, commit.sha)
  }
  return { game, status: "update", message: `更新成功，应用了 ${count} 个提交`, count, messages, sha: latestSha }
}

async function backgroundSync(games) {
  const failed = []
  for (const game of games) {
    try {
      const ret = await processBranch(game, { installOnly: true })
      if (ret.status === "error") {
        failed.push(game)
        logger?.error?.(`[meta-${game}] 处理失败：${ret.message}`)
      }
    } catch (err) {
      failed.push(game)
      logger?.error?.(`[meta-${game}] 处理失败：${err?.message || err}`)
    }
  }
  logger?.mark?.("========================================")
  if (failed.length) {
    logger?.mark?.(logger?.red?.(`喵喵插件：meta 资源包下载失败 (${failed.join(", ")})，请检查网络后重启重试`) ?? `喵喵插件：meta 资源包下载失败 (${failed.join(", ")})，请检查网络后重启重试`)
  } else {
    logger?.mark?.(logger?.green?.("喵喵插件：meta 资源包下载完成，继续加载~") ?? "喵喵插件：meta 资源包下载完成，继续加载~")
  }
  logger?.mark?.("========================================")
}

async function installMeta() {
  /* 内置版：meta 数据已经随插件发布（resources/meta-gs、meta-sr），
     不再做在线补全，避免首次启动时联网下载与 logger 依赖 */
  installed = true
  installing = false
  return true
}

async function installMetaUnused() {
  if (installed || installing) return true
  installing = true

  const games = [ "gs", "sr" ]
  const missing = games.filter((game) => isDirEmpty(path.join(targetOf(game), "character")) || !readSha(game))

  if (!missing.length) {
    installed = true
    return true
  }

  try {
    await ensureAdmZip()
  } catch (err) {
    logger?.mark?.("========================================")
    logger?.error?.(`喵喵插件：${err.message}`)
    logger?.mark?.("安装依赖后请重启 Yunzai 以自动下载 meta 资源")
    logger?.mark?.("========================================")
    installed = true
    return false
  }

  logger?.mark?.("========================================")
  logger?.mark?.(logger?.yellow?.(`喵喵插件：检测到 meta 资源包缺失 (${missing.join(", ")})`) ?? "喵喵插件：检测到 meta 资源包缺失")
  logger?.mark?.(logger?.yellow?.("正在下载 meta 资源，首次安装体积较大耗时较长，加载将等待下载完成，请耐心等待，勿关闭！") ?? "正在下载 meta 资源，请耐心等待，勿关闭！")
  logger?.mark?.("========================================")

  await backgroundSync(missing)

  installed = true
  return true
}

/**
 * 增量更新指定 game 的 meta 资源，供 #喵喵更新meta资源 使用
 * @param {string} game gs | sr
 * @param {object} opts { force }
 */
async function updateMeta(game, opts = {}) {
  return processBranch(game, opts)
}

function installPromise() {
  if (installed) return Promise.resolve(true)
  // 内置版：直接标记完成，不做下载轮询
  if (typeof installMeta === 'function') {
    installed = true
    return Promise.resolve(true)
  }
  if (!installing) installMeta()
  return new Promise((resolve) => {
    const intervalId = setInterval(() => {
      if (installed) {
        clearInterval(intervalId)
        resolve(true)
      }
    }, 100)
  })
}

export { installMeta, installPromise, updateMeta }
