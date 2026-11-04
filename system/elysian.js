/**
 * 崩坏3「往世乐土」热门角色榜。
 *
 * 数据来自米游社公开的 record 接口（无需 CK）：
 *   https://api-takumi-record.mihoyo.com/game_record/appv2/honkai3rd/api/god_war/recommend/list
 *   .../recommend/detail?avatar_id=&schedule_id=
 * 这里只做请求 + 结构归一化，渲染交给 resources/elysian/elysian.html。
 */
import crypto from 'crypto'

const BASE = 'https://api-takumi-record.mihoyo.com/game_record/appv2/honkai3rd/api/god_war/recommend'
const SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
const APP_VERSION = '2.116.0'
const UA = `Mozilla/5.0 (Linux; Android 12; XQ-AT52 Build/58.2.A.7.93; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.88 Mobile Safari/537.36 miHoYoBBS/${APP_VERSION}`

const ROMAN = ['I.', 'II.', 'III.', 'IV.', 'V.', 'VI.']
const text = v => String(v || '').replace(/\\n/g, '\n')
const selected = v => v?.name && v.name !== 'unselected'
const ordered = (values = []) => (values || [])
  .map((v, i) => ({ ...v, desc: text(v.desc), order: ROMAN[i] || `${i + 1}.` }))
  .filter(selected)

const nameKey = v => String(v || '').toLowerCase().replace(/[\s·・♪♥❤「」『』.]/g, '')

/** 在榜单里按「序号 / 完整名 / 唯一包含」选角色 */
export function selectRecommendation(rows = [], query = '') {
  const key = nameKey(query)
  if (!key) return undefined
  if (/^\d+$/.test(key)) return rows.find(r => String(r.avatar_id) === key) || rows[Number(key) - 1]
  const exact = rows.find(r => nameKey(r.avatar?.name) === key)
  if (exact) return exact
  const matches = rows.filter(r => nameKey(r.avatar?.name).includes(key))
  return matches.length === 1 ? matches[0] : undefined
}

export function normalizeRecommendation(row = {}) {
  const stages = ['begin', 'end'].map((stage, index) => {
    const item = row[`${stage}_extra_items`] || {}
    const supports = row[`${stage}_support_avatars`] || {}
    return {
      label: index ? '后期推荐携带' : '开局推荐携带',
      items: ['', 'assistant_'].map(prefix => {
        const star = Math.min(5, Math.max(0, Number(item[`${prefix}star`]) || 0))
        return {
          name: item[`${prefix}name`] || '',
          icon: item[`${prefix}icon`] || '',
          stars: '★'.repeat(star) + '☆'.repeat(5 - star),
        }
      }).filter(it => it.name || it.icon),
      supports: [supports.first, supports.second].filter(it => it?.name || it?.icon),
    }
  })
  return {
    id: row.avatar_id,
    name: row.avatar?.name || '未知角色',
    icon: row.avatar?.icon || '',
    exclusive: ordered(row.exclusive_buffs),
    core: (row.core_buffs || [])
      .map((entry, i) => ({
        ...entry.buff,
        order: ROMAN[i] || `${i + 1}.`,
        assistants: ordered(entry.assistant_buffs),
      }))
      .filter(selected),
    stages,
  }
}

function makeDs(query = '') {
  const t = Math.round(Date.now() / 1000)
  const r = Math.floor(Math.random() * 900000 + 100000)
  const d = crypto.createHash('md5').update(`salt=${SALT}&t=${t}&r=${r}&b=&q=${query}`).digest('hex')
  return `${t},${r},${d}`
}

const cache = new Map()

async function get(type, query = '') {
  const key = `${type}?${query}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data

  const url = `${BASE}/${type}${query ? `?${query}` : ''}`
  const res = await fetch(url, {
    headers: {
      'x-rpc-app_version': APP_VERSION,
      'x-rpc-client_type': '5',
      'User-Agent': UA,
      Origin: 'https://webstatic.mihoyo.com',
      'X-Requested-With': 'com.mihoyo.hyperion',
      Referer: 'https://webstatic.mihoyo.com/',
      Accept: 'application/json, text/plain, */*',
      DS: makeDs(query),
    },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error('热门榜暂时无法获取，请稍后重试')
  const json = await res.json()
  if (json?.retcode !== 0 || !json.data) throw new Error('热门榜暂时无法获取，请稍后重试')
  const data = json.data
  if (type === 'list' && (!Array.isArray(data.data) || !data.data.length)) {
    throw new Error('本期热门榜正在统计刷新，请稍后再试（每周一 10:00 起刷新）')
  }
  if (type === 'detail' && !data.data?.avatar_id) {
    throw new Error('该角色推荐详情暂未公布，请稍后重试')
  }
  for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k)
  cache.set(key, { data, expires: Date.now() + 60 * 1000 })
  return data
}

export function fetchElysianList() {
  return get('list')
}

export async function fetchElysianDetail(avatarId, scheduleId) {
  if (!/^\d+$/.test(String(avatarId)) || !/^\d+$/.test(String(scheduleId))) {
    throw new Error('无效的热门榜角色或期数')
  }
  const q = new URLSearchParams({ avatar_id: String(avatarId), schedule_id: String(scheduleId) }).toString()
  return (await get('detail', q)).data
}
