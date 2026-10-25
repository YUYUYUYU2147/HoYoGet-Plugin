// 绝区零面板/挑战共用的随机背景图地址
//
// 配置项 zzz_panel_bg_url：留空则用纯色底；非 http 地址（本地文件）原样返回。
// 随机图接口 URL 不变时 Chromium 会吃缓存，所以每次拼一个唯一参数强制重取。

import { config } from '#HoYoGet'

const DEFAULT_PANEL_BG = 'https://api.yppp.net/api.php'

export function getPanelBg() {
  let url = DEFAULT_PANEL_BG
  try { url = String(config()?.zzz_panel_bg_url ?? DEFAULT_PANEL_BG).trim() } catch { /* 用默认 */ }
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}_=${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export { DEFAULT_PANEL_BG }
// 跟随 302 取到 cdn 上的固定图片地址：同一地址恒为同一张图，
// 用它渲染可让「#背景图」取回与面板完全一致的那张
export async function resolvePanelBg() {
  const url = getPanelBg()
  if (!/^https?:\/\//i.test(url)) return url
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', Referer: 'https://api.yppp.net/' },
      signal: AbortSignal.timeout(8000),
    })
    res.body?.cancel?.()?.catch?.(() => {})
    return /^https?:\/\//i.test(String(res.url || '')) ? res.url : url
  } catch {
    return url
  }
}
