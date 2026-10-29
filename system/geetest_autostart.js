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
import net from 'node:net'
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

/** TCP 探活：只判端口有没有人在听，不发请求 */
function probePort(host = '127.0.0.1', port = 2149, timeout = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function waitPort(ms = 12000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await probePort()) return true
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

/**
 * pm2 里那条记录用的解释器/脚本还在不在磁盘上。
 * 换过安装目录、清过 .venv 之后，记录会一直指着旧路径：
 * pm2 restart 只会以同样的方式再崩一次，服务永远起不来。
 */
async function pm2EntryBroken() {
  try {
    const { stdout } = await run('pm2 jlist', 20000)
    const start = stdout.indexOf('[')
    if (start < 0) return false
    const list = JSON.parse(stdout.slice(start))
    const proc = list.find(p => p?.name === PM2_NAME)
    if (!proc) return false
    const env = proc.pm2_env || {}
    const exec = String(env.pm_exec_path || '')
    if (exec && !fs.existsSync(exec)) return true
    const args = Array.isArray(env.args) ? env.args.map(String) : []
    const script = args.find(a => a.slice(-3) === '.py')
    return !!(script && !fs.existsSync(script))
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
        if (!managed) {
          await run('pm2 start ' + q(py) + ' --name ' + PM2_NAME + ' -- ' + q(SERVER_PY), 120000)
        } else if (await pm2EntryBroken()) {
          /* 记录里的解释器或脚本已经不在磁盘上（换过安装目录、清过 .venv）：
             pm2 restart 只会以同样的方式再崩一次，必须删掉按当前 venv 重建 */
          logger?.mark?.('[HoYoGet][geetest] pm2 记录指向的文件已不存在，按当前 venv 重建 ' + PM2_NAME)
          await run('pm2 delete ' + PM2_NAME, 30000).catch(() => {})
          await run('pm2 start ' + q(py) + ' --name ' + PM2_NAME + ' -- ' + q(SERVER_PY), 120000)
        } else {
          await run('pm2 restart ' + PM2_NAME, 60000).catch(() => {})
          if (!await waitPort(12000)) {
            /* restart 之后进程可能立刻又崩（依赖缺失、端口被占），端口起不来就按当前 venv 重建一次 */
            logger?.mark?.('[HoYoGet][geetest] pm2 restart 后端口未就绪，改为重建 ' + PM2_NAME)
            await run('pm2 delete ' + PM2_NAME, 30000).catch(() => {})
            await run('pm2 start ' + q(py) + ' --name ' + PM2_NAME + ' -- ' + q(SERVER_PY), 120000)
            await waitPort(12000)
          }
        }
        await run('pm2 save', 60000).catch(() => {})
        logger?.mark?.('[HoYoGet][geetest] 已通过 pm2 自动拉起过码服务（' + PM2_NAME + '）')
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
