/**
 * Akasha System 数据访问层
 *
 * 站点 https://akasha.cv 前面挂着 Cloudflare。实测**不需要浏览器**：
 * 只要把 User-Agent 伪装成 GsCore / GenshinUID（社区爬虫的常规标识），
 * 普通 fetch 就能直接拿到 JSON，不带这个 UA 才会被 403「Just a moment...」拦下来。
 * （这个 UA 来自社区已有的 Akasha 集成实现，属于对方服务默认放行的标识。）
 *
 * 接口：
 *   GET /api/v2/leaderboards/categories[?characterId=][&variant=stygian]
 *       · 不传 id：全部角色的配装方案（每项含 characterName / short / count）
 *       · variant=stygian：幽境危战各期榜单目录
 *   GET /api/leaderboards?sort=calculation.result&order=-1&size=20&page=1
 *       &filter=&uids=&p=&fromId=&li=&variant=<short>&calculationId=<cid>02
 *       · 角色配装的全球榜
 *   GET /api/leaderboards/stygian?version=<x_y>&sort=stygianScore&order=-1
 *       &size=1&page=1&filter=
 *       · 幽境危战全球榜（按分数排序，可用 uid= 过滤单个人）
 */

const AKASHA_ORIGIN = 'https://akasha.cv'
const AKASHA_UA = 'GsCore / GenshinUID / 6.2.0'

/** 统一的 akasha 请求；返回解析后的 JSON */
async function akashaRequest(route, { timeout = 15000 } = {}) {
  const url = new URL(route, `${AKASHA_ORIGIN}/api/`)
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      'User-Agent': AKASHA_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'application/json',
    },
  })
  if (!res.ok) {
    const hint = res.status === 403 ? '（站点验证拦截，请稍后重试）' : ''
    throw new Error(`Akasha HTTP ${res.status}${hint}`)
  }
  const j = await res.json()
  if (!j || (!('data' in j) && !('totalRows' in j))) throw new Error('Akasha 返回格式错误')
  return j
}

/**
 * 配装方案列表。
 * characterId 传空/不传时返回**全部角色**的方案，用它建「角色名 → characterId」映射。
 */
async function listCategories(characterId = null) {
  const qs = characterId ? `?characterId=${characterId}` : ''
  const j = await akashaRequest(`v2/leaderboards/categories${qs}`)
  return Array.isArray(j?.data) ? j.data : []
}

/**
 * 某配装的全球榜。
 *
 * 关键：`calculationId` **不能**用 `characterId + '02'` 拼 —— 那只是角色的默认方案，
 * 同一角色的多套配装会全部撞到同一个 ID 上（拉回来一模一样的数据）。
 * 真正的方案 ID 在 `cat.weapons[].calculationId` 里（每个武器档位一个），
 * 与网站 URL 的 `/leaderboards/<calculationId>/<variant>` 一一对应。
 *
 * variant 取该武器档位的 defaultVariant（如 180er），没有就用 cat.short 的小写。
 */
async function fetchLeaderboard(cat, { size = 20, page = 1 } = {}) {
  const w = (cat.weapons || [])[0] || {}
  const calcId = w.calculationId || `${cat.characterId}02`
  const variant = w.defaultVariant || String(cat.short || '').toLowerCase()
  const qs = [
    'sort=calculation.result',
    'order=-1',
    `size=${size}`,
    `page=${page}`,
    'filter=',
    'uids=',
    'p=',
    'fromId=',
    'li=',
    `variant=${encodeURIComponent(variant)}`,
    `calculationId=${calcId}`,
  ].join('&')
  const j = await akashaRequest(`leaderboards?${qs}`)
  return { list: Array.isArray(j?.data) ? j.data : [] }
}

/** 幽境危战各期榜单目录（按新增时间倒序） */
async function listStygianSchedules() {
  const j = await akashaRequest('v2/leaderboards/categories?variant=stygian&sort=addDate&order=-1')
  return Array.isArray(j?.data) ? j.data : []
}

/** 幽境危战某期的全球榜 */
async function fetchStygianLeaderboard(version, { size = 20, page = 1, uid = '' } = {}) {
  const qs = new URLSearchParams({
    version: String(version).replace('.', '_'),
    sort: 'stygianScore',
    order: '-1',
    size: String(size),
    page: String(page),
    // 传了 uid 时加上排除标记成绩的过滤，与网站 UID 搜索一致
    filter: uid ? '[susLevel]1[all]1' : '',
  })
  if (uid) qs.set('uid', String(uid))
  const j = await akashaRequest(`leaderboards/stygian?${qs}`)
  return { list: Array.isArray(j?.data) ? j.data : [] }
}

/**
 * 某个 UID 在一期幽境危战里的成绩与全球名次。
 * 幽境榜的 `index` 字段就是全球排名（与角色榜的 ranking 不同）。
 * 未上榜（没打或没上传）返回 null。
 */
async function fetchStygianRankOfUser(version, uid) {
  const { list } = await fetchStygianLeaderboard(version, { size: 1, uid })
  const row = list.find(v => String(v.uid) === String(uid))
  if (!row) return null
  return {
    rank: Number(row.index) || 0,
    score: Number(row.stygianScore) || 0,
    difficulty: Number(row.stygianIndex) || 0,
    seconds: Number(row.stygianSeconds) || 0,
    flagged: !!row.isCheating || Number(row.susLevel) > 0,
    nickname: row.owner?.nickname || '',
    region: row.owner?.region || '',
  }
}

/**
 * 某个 UID 的全部角色计算结果（含全球排名）。
 *
 * 这是「查我自己排第几」的唯一途径：`/api/leaderboards` 的 uids 参数被服务端忽略、
 * 而且只返回前 50，拿不到个人名次；`getCalculationsForUser` 则直接给出每个角色的
 * `calculations.fit.ranking` 与 `outOf`（如 14 / 232338）。
 */
async function getUserCalculations(uid) {
  const j = await akashaRequest(`getCalculationsForUser/${uid}`)
  return Array.isArray(j?.data) ? j.data : []
}

/** 某个 UID 的账号信息（昵称、等级、服务器、拥有的角色等） */
async function getUserProfile(uid) {
  const j = await akashaRequest(`user/${uid}`)
  return j?.data || null
}

export {
  AKASHA_ORIGIN, AKASHA_UA, akashaRequest,
  listCategories, fetchLeaderboard,
  listStygianSchedules, fetchStygianLeaderboard, fetchStygianRankOfUser,
  getUserCalculations, getUserProfile,
}
