// 工坊公开接口的请求层（绝区零 api.zzzmap.com / 星穹铁道 api.lingyuan.design）
//
// 两家工坊由同一开发方出品：返回统一 { code, data } 包装，POST 接口用同一套签名算法。
// 因此请求与签名只在这里实现一份，apps/zzz_workshop.js 与 apps/sr_workshop.js 共用。
//
// 接口来源：小程序包 wx06433d7f9d17db8b / wx9660a6f443d341bb 解包后提取，
// 参数与踩坑见 HANDOFF_2026-10-19.md。接口随时可能调整，失败抛 Error，由调用方转成可读提示。

import { createHash } from 'node:crypto'

export const ZZZ_HOST = 'https://api.zzzmap.com'
export const SR_HOST = 'https://api.lingyuan.design'

const REQUEST_TIMEOUT = 12000
const MAX_ATTEMPTS = 4

/** 小程序请求库固定追加的签名盐 */
const SIGN_KEY = 'VW^)(^*^$$#*%(#)!@VIAI%'
const APP_VERSION = '100'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

/**
 * 值得重试的错误：
 *   · 连接层瞬时错误（超时、DNS、断连）
 *   · 证书错误 —— api.lingyuan.design 有 3 个 A 记录，其中 1 个证书已过期，
 *     约 1/3 请求随机失败，换节点重试即可
 *   · HTTP 5xx
 */
function retryable(err) {
  const code = err?.cause?.code || ''
  if (/^(CERT_|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNREFUSED)/.test(code)) return true
  if (err?.name === 'TimeoutError' || err?.name === 'TypeError') return true
  if (/HTTP 5\d\d/.test(err?.message || '')) return true
  return false
}

async function fetchJson(url, init) {
  let last
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, init())
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (Number(json?.code) !== 0) throw new Error(json?.message || `接口返回 code=${json?.code}`)
      return json.data
    } catch (err) {
      last = err
      if (attempt === MAX_ATTEMPTS - 1 || !retryable(err)) throw err
    }
  }
  throw last
}

/**
 * GET 接口。
 * 空串是有效取值（星铁排行用 role_rank= 表示「不限星魂」），所以只跳过 undefined / null。
 */
export async function request(pathname, query = {}, host = ZZZ_HOST) {
  const url = new URL(pathname, host)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return await fetchJson(url, () => ({
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': UA,
    },
  }))
}

/**
 * POST 签名：参数去 null → 对象值 JSON.stringify → 拼 k=v → 按整串排序 → 末尾并入 SIGN_KEY → MD5。
 * 规则来自小程序请求库，两家工坊完全一致。
 */
function signOf(params) {
  const merged = { ...params, key: SIGN_KEY }
  const pairs = Object.entries(merged).map(([key, value]) => {
    const text = typeof value === 'object' ? JSON.stringify(value) : value
    return `${key}=${text ?? ''}`
  })
  return createHash('md5').update(pairs.join('&').split('&').sort().join('&')).digest('hex')
}

/** POST 接口需要 sign / time / version / platform 头；body 是扁平参数（不是 { data } 包装） */
export async function signedPost(pathname, params, host = ZZZ_HOST) {
  const body = {}
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) body[key] = value
  }
  return await fetchJson(new URL(pathname, host), () => ({
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': UA,
      version: APP_VERSION,
      platform: 'weixin',
      sign: signOf(params),
      time: String(Date.now()),
    },
    body: JSON.stringify(body),
  }))
}

/** set_info「32700_2__32800_2」→ [{ setId, count }]，两家工坊格式一致 */
export function parseSetInfo(raw) {
  const text = String(raw || '')
  if (!text) return []
  return text
    .split('__')
    .map(part => {
      const [setId, count] = part.split('_')
      return { setId: String(setId || ''), count: Number(count) || 0 }
    })
    .filter(part => part.setId)
}
