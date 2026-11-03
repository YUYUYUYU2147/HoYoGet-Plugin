/**
 * redis 键前缀。
 *
 * 面板/排名数据原来存在 `miao:*` 下（miao-plugin 的历史前缀）。本插件内置数据层后
 * 改成 `hoyo:*`，但迁移期间要能和旧数据并存：
 *   - 写入：一律写 `hoyo:*`
 *   - 读取：先读 `hoyo:*`，没有再回落 `miao:*`
 * 等确认不再需要 miao 时，把 FALLBACK_PREFIX 删掉即可。
 */

export const PREFIX = 'hoyo:'
export const FALLBACK_PREFIX = 'miao:'

/** 逻辑键 → 实际键（调用方只写逻辑键，如 `rank:${gid}:dmg:10000002`） */
export const key = (logical) => PREFIX + logical

/** 读取：先新前缀，再旧前缀 */
export async function get(logical) {
  if (typeof redis === 'undefined') return null
  const v = await redis.get(key(logical))
  if (v !== null && v !== undefined) return v
  return redis.get(FALLBACK_PREFIX + logical)
}

/** 写入：只写新前缀 */
export async function set(logical, value, options) {
  if (typeof redis === 'undefined') return null
  return options ? redis.set(key(logical), value, options) : redis.set(key(logical), value)
}

/** 该逻辑键是否存在于新前缀（用于判断迁移是否完成） */
export async function exists(logical) {
  if (typeof redis === 'undefined') return 0
  return redis.exists(key(logical))
}

/* ───────── 面板缓存（md5 / 冷却 / 用户配置） ───────── */

/** 角色面板缓存键的逻辑部分：gs|sr + uid + 角色 id */
export const profileMd5Key = (game, uid, id) => `profile:${game}:${uid}:md5:${id}`

/** 读面板 md5：新前缀优先，回落旧前缀（让老的「是否更新」判断不失效） */
export async function getMD5(logical) {
  if (typeof redis === 'undefined') return null
  const v = await redis.get(PREFIX + logical)
  if (v !== null && v !== undefined) return v
  return redis.get(FALLBACK_PREFIX + logical)
}
