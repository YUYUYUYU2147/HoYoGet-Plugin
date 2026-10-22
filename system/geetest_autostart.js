/**
 * 过码服务的自动拉起。
 *
 * 场景：用户部署过一次 `#过码部署` 之后，服务因为机器重启、进程崩溃、
 * 或 pm2 没设自启而消失。此时不该再让人手动发指令 —— 插件在需要过码时
 * 自己把它拉起来即可。
 *
 * 前提判断：只有 `service/geetest/.venv` 与 `server.py` 都在，才认为
 * 「用户确实部署过」。没部署过就什么都不做（不偷偷装依赖、不建 venv）。
 *
 * 启动策略：
 *   1. 有 pm2 → pm2 start（并尝试 pm2 save / startup）
 *   2. 没有 pm2 → nohup 后台起（能救急，重启后仍需再拉）
 *
 * 防抖：同一进程内 5 分钟内只尝试一次，避免每个版块都去起一遍。
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execAsync = promisify(exec)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVICE_DIR = path.join(ROOT, 'service', 'geetest')
const VENV_DIR = path.join(SERVICE_DIR, '.venv')
const SERVER_PY = path.join(SERVICE_DIR, 'server.py')
const PM2_NAME = 'xhh-geetest-solver'
const IS_WIN = process.platform === 'win32'

const RETRY_GAP = 5 * 60 * 1000
let lastTry = 0
let starting = null

function q(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`
}

async function run(cmd, timeout = 30000) {
  return execAsync(cmd, { timeout, windowsHide: true })
}

async function has(cmd) {
  try {
    await run(cmd, 15000)
    return true
  } catch {
    return false
  }
}

/** venv 里的解释器（兼容 Scripts/ 与 bin/） */
function venvPython() {
  const candidates = IS_WIN
    ? [['Scripts', 'python.exe'], ['Scripts', 'python'], ['bin', 'python']]
    : [['bin', 'python3'], ['bin', 'python'], ['Scripts', 'python.exe']]
  for (const rel of candidates) {
    const p = path.join(VENV_DIR, ...rel)
    if (fs.existsSync(p)) return p
  }
  return ''
}

/** 用户是否部署过（只看文件，不启动任何东西） */
export function deployed() {
  return fs.existsSync(SERVER_PY) && !!venvPython()
}

async function pm2HasProcess() {
  if (!await has('pm2 -v')) return null
  try {
    const { stdout } = await run('pm2 jlist', 20000)
    const start = stdout.indexOf('[')
    if (start < 0) return false
    const list = JSON.parse(stdout.slice(start))
    return Array.isArray(list) && list.some(p => p?.name === PM2_NAME)
  } catch {
    return false
  }
}

/**
 * 启动过码服务。
 * @param {{force?:boolean, logger?:object}} [opts] force 跳过防抖
 * @returns {Promise<{started:boolean, reason:string}>}
 */
export async function ensureStarted(opts = {}) {
  const logger = opts.logger || globalThis.logger
  if (!deployed()) return { started: false, reason: '未部署' }
  const now = Date.now()
  if (!opts.force && now - lastTry < RETRY_GAP) return { started: false, reason: '刚试过，稍后再试' }
  if (starting) return starting
  lastTry = now

  starting = (async () => {
    const py = venvPython()
    try {
      if (await has('pm2 -v')) {
        const managed = await pm2HasProcess()
        if (managed) {
          await run(`pm2 restart ${PM2_NAME}`, 60000).catch(() => {})
        } else {
          await run(`pm2 start ${q(py)} --name ${PM2_NAME} -- ${q(SERVER_PY)}`, 120000)
        }
        await run('pm2 save', 60000).catch(() => {})
        logger?.mark?.(`[HoYoGet][geetest] 已通过 pm2 自动拉起过码服务（${PM2_NAME}）`)
        return { started: true, reason: 'pm2' }
      }
      // 没有 pm2：nohup 兜底，至少这一轮能用
      if (IS_WIN) {
        await run(`cd /d ${q(SERVICE_DIR)} && start "" /b ${q(py)} server.py > server.log 2>&1`, 30000)
      } else {
        await run(
          `cd ${q(SERVICE_DIR)} && nohup ${q(py)} server.py > server.log 2>&1 & disown`,
          30000,
        )
      }
      logger?.mark?.('[HoYoGet][geetest] 已通过 nohup 自动拉起过码服务（重启后需再拉，建议装 pm2）')
      return { started: true, reason: 'nohup' }
    } catch (err) {
      logger?.warn?.(`[HoYoGet][geetest] 自动拉起失败：${err?.message || err}`)
      return { started: false, reason: String(err?.message || err) }
    } finally {
      starting = null
    }
  })()
  return starting
}

export default { ensureStarted, deployed }
