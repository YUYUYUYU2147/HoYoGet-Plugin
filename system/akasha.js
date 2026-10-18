/**
 * Akasha System 数据访问层（原神角色练度全球榜）
 *
 * 站点 https://akasha.cv 前面有 Cloudflare 的 JS 挑战：
 *   · 任何纯 HTTP 客户端（fetch / axios / curl）都会拿到 403「Just a moment...」
 *   · 抓下来的 cf_clearance 与 UA / IP / TLS 指纹绑定，换个客户端立刻失效
 * 所以只能开一个真实 Chromium 页面，让浏览器自己过挑战，再在页面上下文里
 * 用同源 fetch 调它的接口（见 withPage / callApi）。
 *
 * 接口（从前端 bundle 与真实请求里确认）：
 *   GET /api/v2/leaderboards/categories?characterId=<id>
 *       → 该角色全部配装方案，每项含 name / short / count / characterId
 *   GET /api/leaderboards?sort=calculation.result&order=-1&size=20&page=1
 *       &filter=&uids=&p=&fromId=&li=&variant=<short>&calculationId=<characterId>02
 *       → 该方案的全球榜（按计算伤害降序，calculation.result）
 *
 * 性能：启动浏览器 + 过 CF 约 2.5~3s，之后每次查询约 1.4s。
 * 浏览器实例按需创建、用完即关，不做常驻 —— 常驻会和面板渲染抢内存。
 */

const AKASHA_ORIGIN = 'https://akasha.cv'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 打开一个已过 Cloudflare 的页面，交给 fn 使用，结束后关闭浏览器 */
async function withPage(fn, { timeout = 60000 } = {}) {
  let browser = null
  try {
    const puppeteer = (await import('puppeteer')).default
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
      ],
    })
    const page = await browser.newPage()
    await page.setUserAgent(UA)
    await page.setViewport({ width: 1280, height: 800 })
    // 首页体积小、是纯前端，用它过挑战最快
    await page.goto(`${AKASHA_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout })
    // CF 挑战通过后 cf_clearance 才落盘，稍等一下再发业务请求
    await new Promise(r => setTimeout(r, 2500))
    return await fn(page)
  } finally {
    try { await browser?.close() } catch (_) { /* 关闭失败不影响结果 */ }
  }
}

/** 在页面上下文里发同源请求（带 CF 会话），返回解析后的 JSON */
async function callApi(page, path) {
  const res = await page.evaluate(async url => {
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' } })
      const text = await r.text()
      let json = null
      try { json = JSON.parse(text) } catch (_) { /* 非 JSON 说明又被挑战了 */ }
      return { status: r.status, json, text: json ? '' : text.slice(0, 200) }
    } catch (err) {
      return { status: 0, json: null, text: String(err?.message || err) }
    }
  }, path)
  if (!res.json) {
    const msg = /Just a moment|challenge/i.test(res.text || '')
      ? 'Cloudflare 挑战未通过（稍后重试）'
      : `接口返回异常（HTTP ${res.status}）：${res.text || '空响应'}`
    throw new Error(msg)
  }
  return res.json
}

/**
 * 配装方案列表。
 * characterId 传空/不传时返回**全部角色**的方案（一次约 300KB），
 * 用它建「角色名 → characterId」映射并缓存，避免逐个角色请求。
 */
async function listCategories(page, characterId = null) {
  const qs = characterId ? `?characterId=${characterId}` : ''
  const j = await callApi(page, `/api/v2/leaderboards/categories${qs}`)
  return Array.isArray(j?.data) ? j.data : []
}

/**
 * 某方案的全球榜。
 * @param {object} page
 * @param {object} cat   categories 里的一项（需 characterId / short）
 * @param {object} opt   { size, page }
 */
async function fetchLeaderboard(page, cat, { size = 20, page: pageNo = 1 } = {}) {
  const cid = cat.characterId
  const calcId = `${cid}02`   // 默认计算方案：角色 id + 02
  const qs = [
    'sort=calculation.result',
    'order=-1',
    `size=${size}`,
    `page=${pageNo}`,
    'filter=',
    'uids=',
    'p=',
    'fromId=',
    'li=',
    `variant=${encodeURIComponent(cat.short || '')}`,
    `calculationId=${calcId}`,
  ].join('&')
  const j = await callApi(page, `/api/leaderboards?${qs}`)
  return {
    // 这个接口不返 totalRows（只有 totalRowsHash），总数由调用方按「返回条数 < size」判断是否到底
    list: Array.isArray(j?.data) ? j.data : [],
  }
}

export { AKASHA_ORIGIN, UA, withPage, callApi, listCategories, fetchLeaderboard }
