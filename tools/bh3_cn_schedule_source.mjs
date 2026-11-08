#!/usr/bin/env node
/**
 * Collect the latest Chinese Honkai Impact 3 schedule post from the public
 * schedule source.
 *
 * The upstream provider sometimes publishes the schedule as an image and
 * sometimes as plain text. The data collector uses text results first; the
 * image downloader remains a separate fallback. Neither path overwrites
 * abyss_schedule.json/battlefield_schedule.json.
 *
 * Usage:
 *   node tools/bh3_cn_schedule_source.mjs
 *   node tools/bh3_cn_schedule_source.mjs --post 36252
 *   node tools/bh3_cn_schedule_source.mjs --channel public_schedule --out /tmp/bh3
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const DEFAULT_CHANNEL = 'Seele_Leaks'
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = path.join(PLUGIN_ROOT, 'data', 'bh3_schedule_source')
const UA = 'HoYoGet-Plugin/3.x'
const SEARCH_TERMS = ['超弦空间', '记忆战场', '排期']
const execFileAsync = promisify(execFile)

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim()
}

function normalizeCaption(value = '') {
  return decodeHtml(String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim()
}

function normalizeScheduleCaption(value = '') {
  return decodeHtml(String(value)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split(/\r?\n/)
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// Names seen in the public schedule text. The list is deliberately small and
// only used to split an unpunctuated line; bossText always retains the exact
// source span for names not yet known here.
const KNOWN_BOSSES = [
  '虚树神骸-神秘主义', '虚树神骸-存在主义', '虚树神骸-虚无主义',
  '虚数神骸-多元论', '奔狼的领主', '天堂使者', '白之悬剑', '黑之赐死',
  '仿品-「愚之芽」', '愚之芽', '愿之芽', '摩录多', '娑婆', '阿湿波',
  '陨星-帕罗斯', '陨星-奈埃尔', '迷之忍者', '帕凡提', '符华',
]

function splitKnownBosses(value = '') {
  const text = String(value).trim()
  const found = []
  for (const name of KNOWN_BOSSES) {
    let from = 0
    while (true) {
      const index = text.indexOf(name, from)
      if (index < 0) break
      found.push({ index, end: index + name.length, name })
      from = index + name.length
    }
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end)
  const nonOverlapping = []
  for (const item of found) {
    if (!nonOverlapping.some(x => item.index < x.end && item.end > x.index)) nonOverlapping.push(item)
  }
  if (!nonOverlapping.length) return [text.split(/\s+/)[0]?.trim()].filter(Boolean)
  return [...new Set(nonOverlapping.map(item => item.name))]
}

export function extractPosts(html, channel) {
  const marker = new RegExp(`data-post=["']${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(\\d+)["']`, 'g')
  const hits = [...html.matchAll(marker)]
  const posts = []
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index
    const end = i + 1 < hits.length ? hits[i + 1].index : html.length
    const block = html.slice(start, end)
    const captionMatch = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i)
    const caption = normalizeCaption(captionMatch?.[1] || '')
    const isSchedule = /HI\s*3rd|崩坏?3|记忆战场|超弦空间|排期表/i.test(caption)
    if (!isSchedule) continue
    const urls = []
    const add = (u) => {
      if (!u) return
      const clean = decodeHtml(u).replace(/\\u0026/g, '&')
      if (/telesco\.pe\/file\//.test(clean) && !urls.includes(clean)) urls.push(clean)
    }
    // The source page uses background-image for attached photos; the <img> tag is
    // normally the channel avatar, so only use it as a fallback.
    for (const m of block.matchAll(/background-image:url\(['"]([^'"]+)/gi)) add(m[1])
    if (!urls.length) {
      for (const m of block.matchAll(/<img[^>]+src=["']([^"']+)/gi)) add(m[1])
    }
    const date = block.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || ''
    posts.push({
      postId: Number(hits[i][1]),
      url: `https://t.me/${channel}/${hits[i][1]}`,
      caption,
      publishedAt: date,
      images: urls,
    })
  }
  return posts.sort((a, b) => b.postId - a.postId)
}

/** Parse public text search results into data usable by a renderer. */
export function extractScheduleDataPosts(html, channel = DEFAULT_CHANNEL) {
  const marker = new RegExp(`data-post=["']${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/(\\d+)["']`, 'g')
  const posts = []
  for (const hit of html.matchAll(marker)) {
    const start = hit.index
    const end = html.indexOf('data-post=', start + 20)
    const block = html.slice(start, end < 0 ? html.length : end)
    const caption = normalizeScheduleCaption((block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '')
    if (!/(HI\s*3|崩坏\s*3|崩坏三)/i.test(caption) || !/(超弦空间|记忆战场|排期)/i.test(caption)) continue
    const version = caption.match(/HI\s*3(?:rd)?\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1] || ''
    const abyss = []
    // A post can contain several zones with the same environment, e.g.
    // "怯火-高危区 虚树神骸-神秘主义 怯火-高危区 摩录多".  Matching the
    // value with a look-ahead is ambiguous because boss names also contain
    // hyphens.  Locate every environment marker first, then slice the text
    // between adjacent markers.
    const zoneMarkers = [...caption.matchAll(/([^\s，,：:；;]+?)-高危区/g)]
    for (let i = 0; i < zoneMarkers.length; i++) {
      const marker = zoneMarkers[i]
      const start = marker.index + marker[0].length
      const end = i + 1 < zoneMarkers.length ? zoneMarkers[i + 1].index : caption.length
      let value = caption.slice(start, end).trim()
      // Stop at punctuation or a following section heading.  Keep hyphens,
      // middle dots and quotes because they are common in boss names.
      value = value
        .split(/\n|[，,；;。]|\s+(?=(?:记忆战场|超弦空间|Stage\s*[I1二三]|SSS)\b)/i)[0]
        .replace(/^[：:、\s]+/, '')
        .trim()
      const bosses = splitKnownBosses(value)
      const env = marker[1].trim()
      // A zone can list several opponents without punctuation. Preserve the
      // full source span so a later game-specific catalogue can split it
      // without losing information.
      if (env && bosses.length) {
        for (const boss of bosses) abyss.push({ env, boss, bossText: value })
      }
    }

    const battlefield = []
    const stageMatches = [...caption.matchAll(/Stage\s*([I1二三]+)[：:]\s*/gi)]
    const stageName = value => String(value || '')
      .replace(/[（(].*$/, '')
      .split(/\n|[，,；;。]/)[0]
      .trim()
    for (let i = 0; i < stageMatches.length; i++) {
      const match = stageMatches[i]
      const start = match.index + match[0].length
      const end = i + 1 < stageMatches.length ? stageMatches[i + 1].index : caption.length
      const bossText = stageName(caption.slice(start, end))
      for (const boss of splitKnownBosses(bossText)) {
        if (boss) battlefield.push({ stage: match[1].toUpperCase(), boss, bossText })
      }
    }

    // Some posts only say "SSS Boss xxx" and have no Stage labels.  When
    // Stage labels are present, retain the named SSS boss as its own source
    // record and avoid swallowing all three stages into one value.
    const sss = caption.match(/SSS\s*(?:Boss)?\s+([\s\S]+?)(?=\s+Stage\s*[I1二三]+[：:]|\s*[（(]|\s+(?:此类强敌|本期|下期)|$)/i)
    if (sss) {
      const bossText = sss[1].replace(/[（(].*$/, '').trim()
      for (const boss of splitKnownBosses(bossText)) {
        if (boss && !battlefield.some((x) => x.boss === boss)) battlefield.unshift({ stage: 'SSS', boss, bossText })
      }
    }
    const publishedAt = block.match(/<time[^>]+datetime=["']([^"']+)/i)?.[1] || ''
    posts.push({
      postId: Number(hit[1]), url: `https://t.me/${channel}/${hit[1]}`, publishedAt,
      sourceKind: 'text', caption, version, abyss, battlefield, dataStatus: 'partial_no_dates',
    })
  }
  return [...new Map(posts.map((p) => [p.postId, p])).values()].sort((a, b) => b.postId - a.postId)
}

async function fetchText(url) {
  let res
  try {
    res = await fetch(url, { headers: { 'user-agent': UA } })
  } catch (err) {
    throw new Error(`访问排期数据源失败：${url}；${err?.cause?.message || err?.message || err}`)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return await res.text()
}

export async function collectCnScheduleData({ channel = DEFAULT_CHANNEL, outDir = DEFAULT_OUT, terms = SEARCH_TERMS } = {}) {
  const all = []
  for (const term of terms) {
    const html = await fetchText(`https://t.me/s/${channel}?q=${encodeURIComponent(term)}`)
    all.push(...extractScheduleDataPosts(html, channel))
  }
  const posts = [...new Map(all.map((p) => [p.postId, p])).values()].sort((a, b) => b.postId - a.postId)
  if (!posts.length) throw new Error(`排期数据源没有找到 ${channel} 的崩三文字排期数据`)
  const versions = {}
  for (const post of posts) {
    const key = post.version || 'unknown'
    versions[key] ||= { abyss: [], battlefield: [], posts: [] }
    versions[key].posts.push(post.postId)
    versions[key].abyss.push(...post.abyss.map((x) => ({ ...x, sourcePost: post.postId })))
    versions[key].battlefield.push(...post.battlefield.map((x) => ({ ...x, sourcePost: post.postId })))
  }
  for (const value of Object.values(versions)) {
    value.abyss = [...new Map(value.abyss.map((x) => [`${x.env}|${x.boss}`, x])).values()]
    value.battlefield = [...new Map(value.battlefield.map((x) => [`${x.stage}|${x.boss}`, x])).values()]
  }
  await fs.mkdir(outDir, { recursive: true })
  const record = {
    source: 'public schedule text', sourceKind: 'text', channel,
    fetchedAt: new Date().toISOString(), queryTerms: terms,
    dataStatus: 'partial_no_dates',
    note: '文字泄漏提供了 Boss/环境，但多数帖子没有日期和期号，不能直接覆盖本地排期。',
    versions, posts,
  }
  await fs.writeFile(path.join(outDir, 'latest-data.json'), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

async function download(url, file) {
  const res = await fetch(url, { headers: { 'user-agent': UA } })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const data = Buffer.from(await res.arrayBuffer())
  if (!data.length) throw new Error(`empty response ${url}`)
  await fs.writeFile(file, data)
  return data.length
}

/**
 * Create a separate OCR image.  Seele's red/cyan watermark is high-chroma;
 * using the brightest RGB channel keeps dark schedule text while making most
 * of that coloured watermark close to the pale background.  The downloaded
 * original is never modified.
 */
async function prepareOcrImage(input, output) {
  let sharp
  try {
    sharp = (await import('sharp')).default
  } catch (_) {
    // sharp is bundled by HoYoGet, but keep the collector usable on a bare
    // maintenance shell where only ImageMagick is installed.
    try {
      await execFileAsync('convert', [
        input, '-channel', 'RGB', '-separate', '-evaluate-sequence', 'max',
        '-resize', '300%', '-normalize', '-sharpen', '0x1', output,
      ])
      return
    } catch (err) {
      throw new Error(`需要 sharp 或 ImageMagick 生成 OCR 副本：${err?.message || err}`)
    }
  }
  const source = sharp(input).removeAlpha()
  const { data, info } = await source.raw().toBuffer({ resolveWithObject: true })
  const gray = Buffer.alloc(info.width * info.height)
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    gray[p] = Math.max(data[i], data[i + 1] || data[i], data[i + 2] || data[i])
  }
  await sharp(gray, { raw: { width: info.width, height: info.height, channels: 1 } })
    .resize({ width: Math.max(1200, Math.min(2400, info.width * 3)), withoutEnlargement: false })
    .normalize()
    .sharpen()
    .png()
    .toFile(output)
}

export async function collectCnSchedule({ channel = DEFAULT_CHANNEL, post = '', outDir = DEFAULT_OUT } = {}) {
  const pageUrl = post ? `https://t.me/s/${channel}/${post}` : `https://t.me/s/${channel}`
  const html = await fetchText(pageUrl)
  const posts = extractPosts(html, channel)
  const wanted = post ? posts.find((p) => String(p.postId) === String(post)) : posts[0]
  if (!wanted) throw new Error(`未找到 ${channel} 中带排期文字的 HI3 帖子；可用 --post 指定帖子号`)
  if (!wanted.images.length) throw new Error(`帖子 ${wanted.postId} 没有可下载的图片`)

  await fs.mkdir(outDir, { recursive: true })
  const recordFile = path.join(outDir, 'latest.json')
  try {
    const previous = JSON.parse(await fs.readFile(recordFile, 'utf8'))
    const complete = previous.postId === wanted.postId
      && Array.isArray(previous.images)
      && previous.images.length === wanted.images.length
      && (await Promise.all(previous.images.flatMap((x) => [x.file, x.ocrFile]).map((file) => fs.access(file).then(() => true).catch(() => false)))).every(Boolean)
    if (complete) return { ...previous, skipped: true, checkedAt: new Date().toISOString() }
  } catch (_) {}
  const images = []
  for (let i = 0; i < wanted.images.length; i++) {
    const file = path.join(outDir, `${wanted.postId}-${i + 1}.jpg`)
    const bytes = await download(wanted.images[i], file)
    const ocrFile = path.join(outDir, `${wanted.postId}-${i + 1}-ocr.png`)
    await prepareOcrImage(file, ocrFile)
    images.push({ url: wanted.images[i], file, ocrFile, bytes })
  }
  const record = {
    source: 'public schedule image',
    channel,
    postId: wanted.postId,
    postUrl: wanted.url,
    caption: wanted.caption,
    publishedAt: wanted.publishedAt,
    fetchedAt: new Date().toISOString(),
    images,
    watermark: '斜向彩色水印；OCR 使用单独预处理副本，原图保留',
    status: 'downloaded_pending_review',
    note: '图片来源没有结构化 JSON；确认 OCR/人工校对后再写入排期 JSON。',
  }
  await fs.writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`)
  return record
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const channel = arg('channel', DEFAULT_CHANNEL)
    const outDir = path.resolve(arg('out', DEFAULT_OUT))
    const record = process.argv.includes('--data-only')
      ? await collectCnScheduleData({ channel, outDir })
      : await collectCnSchedule({ channel, post: arg('post'), outDir })
    console.log(JSON.stringify(record, null, 2))
  } catch (err) {
    console.error(`[bh3-cn-schedule] ${err?.message || err}`)
    process.exitCode = 1
  }
}
