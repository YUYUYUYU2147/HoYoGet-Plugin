/**
 * 面板排名的「范围」共享状态（按会话分键、落盘持久化）。
 *
 * 两个模块共用：
 *   · apps/zzz_rank.js     本地面板排名（本群 / 全部已保存记录）
 *   · apps/zzz_workshop.js 工坊练度排名（本群 / 工坊全服）
 *
 * 为什么不再用内存单值：
 *   · 进程一退出就没了，每次启动都回落到「本群」。本群没人把该角色传进工坊
 *     角色柜时，用户会看到「本群没有成员上传」的提示，得反复手动切换；
 *   · 全局单值还会让 A 群的切换影响所有群与私聊，与「本群范围只统计本群成员」
 *     的语义冲突。
 *
 * 存储：
 *   data/zzz_panel/rank_scope.json
 *   { "group:123456": "all", "u:10001": "group", ... }
 *   群聊按群号，私聊按 u+QQ（私聊没有群号，用 QQ 区分）。
 *
 * 可靠性：写入走「临时文件 + rename」，避免进程中断留下半截 JSON；
 * 读/写失败一律静默退化到默认值，不影响指令本身。
 */
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_SCOPE = 'group'
const STORE_DIR = path.join(process.cwd(), 'data', 'zzz_panel')
const STORE_FILE = path.join(STORE_DIR, 'rank_scope.json')

/** 内存缓存：避免每条指令都读磁盘；写盘后再同步 */
let cache = null

/** e → 会话键。群聊用群号，私聊用 QQ；都拿不到时退回一个固定键（等价于旧的全局行为） */
function keyOf(e) {
  if (!e) return 'global'
  const gid = e.group_id || e.groupId
  if (gid) return `group:${gid}`
  const uid = e.user_id || e.sender?.user_id
  if (uid) return `u:${uid}`
  return 'global'
}

function load() {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    cache = parsed && typeof parsed === 'object' ? parsed : {}
  } catch (_) {
    /* 首次运行 / 文件损坏 / 无权限，都退回空表 */
    cache = {}
  }
  return cache
}

function save() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true })
    const tmp = `${STORE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1))
    fs.renameSync(tmp, STORE_FILE)
  } catch (_) {
    /* 落盘失败不影响本次运行，内存里的值仍然生效 */
  }
}

const normalize = (value) => (value === 'all' ? 'all' : DEFAULT_SCOPE)

/**
 * 设置范围。
 * e 是新签名（按会话分键）；不传 e 时写 'global' 键，兼容尚未传 e 的旧调用。
 */
export function setRankScope(next, e) {
  const store = load()
  const key = keyOf(e)
  const value = normalize(next)
  store[key] = value
  save()
  return value
}

/** 读取范围。不传 e 时读 'global' 键 */
export function getRankScope(e) {
  const store = load()
  return normalize(store[keyOf(e)])
}

export function scopeLabel(value = DEFAULT_SCOPE) {
  return value === 'all' ? '全部' : '本群'
}

export default { setRankScope, getRankScope, scopeLabel }
