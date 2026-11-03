import fs from 'fs'
import moment from 'moment'
import { pluginPriority, render } from '#HoYoGet'
import { getCalendarActivities, getBirthdayActivities, fillZzzBirthdayAvatars, KIND_META } from './activity_remind.js'

/* 指令：
 *   #日历 / #原神日历      → 原神
 *   *日历 / *星铁日历      → 星铁
 *   %日历 / %绝区零日历    → 绝区零
 *   #崩三日历              → 交给已有的崩三日历（!日历）
 */
const CAL_RE = /^[#%*＊]?\s*(?:(原神|星铁|星穹|崩铁|绝区零|zzz|崩三|崩坏3|崩坏三)\s*)?日历(?:表|列表)?$/i

const GAME_CN = { gs: '原神', sr: '星穹铁道', zzz: '绝区零' }
/* 公告接口里混着周边/问卷/版本说明，日历只保留游戏内活动 */
const CAL_IGNORE = /周边|商城|商店|手办|服饰|优惠|折扣|问卷|调研|防沉迷|公平运营|版本|更新|优化|修复|已知问题|预下载|角色演示|角色PV|版本PV|动画短片|激励计划|攻略征集|测试招募|社区|社媒|聚合页|专题|资讯|公告|有奖|抽奖|兑换码|论坛|米游社|跃迁|调频|祈愿|卡池|无名勋礼|任务说明|统计上线|上新/

function gameOf(msg = '') {
  const text = String(msg)
  const word = text.match(/(原神|星铁|星穹|崩铁|绝区零|zzz|崩三|崩坏3|崩坏三)/i)?.[1] || ''
  if (word) {
    if (/崩三|崩坏3|崩坏三/i.test(word)) return 'bh3'
    if (/星铁|星穹|崩铁/i.test(word)) return 'sr'
    if (/绝区零|zzz/i.test(word)) return 'zzz'
    return 'gs'
  }
  if (/^\s*[%％]/.test(text)) return 'zzz'
  if (/^\s*[\*＊]/.test(text)) return 'sr'
  return 'gs'
}

/* 生日角色立绘表：resources/calendar/portraits.json（{ game: { 角色名: 立绘链接 } }） */
const PORTRAITS_FILE = './plugins/HoYoGet-Plugin/resources/calendar/portraits.json'
let PORTRAITS = null
let PORTRAITS_MTIME = 0
function portraitsOf(game) {
  try {
    const mtime = fs.statSync(PORTRAITS_FILE).mtimeMs
    if (PORTRAITS === null || mtime !== PORTRAITS_MTIME) {
      PORTRAITS = JSON.parse(fs.readFileSync(PORTRAITS_FILE, "utf-8"))
      PORTRAITS_MTIME = mtime
    }
  } catch (_) {
    if (PORTRAITS === null) PORTRAITS = {}
  }
  return PORTRAITS[game] || {}
}
function portraitOf(game, name) {
  const table = portraitsOf(game)
  const key = String(name || "").replace(/\s+/g, "")
  if (!key) return ""
  if (table[key]) return table[key]
  const hit = Object.keys(table).find(k => k.includes(key) || key.includes(k))
  return hit ? table[hit] : ""
}
function fmtDate(d, now) {
  if (!d?.isValid?.()) return '—'
  return d.year() === now.year() ? d.format('M/D HH:mm') : d.format('YYYY/M/D HH:mm')
}

function remainText(now, end) {
  const diff = Math.max(0, end.valueOf() - now.valueOf())
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${minutes}分`
  return `${minutes}分钟`
}

/* 进度条内极简剩余时间：以完整天数为单位，控制在 3-4 个字符 */
function remainShort(now, end) {
  const diff = Math.max(0, end.valueOf() - now.valueOf())
  const days = Math.floor(diff / 86400000)
  if (days >= 1) return `${days}天`
  const hours = Math.floor(diff / 3600000)
  if (hours >= 1) return `${hours}小时`
  const minutes = Math.floor(diff / 60000)
  return `${minutes}分`
}
/** 活动 banner 缩成小方图，避免远程图片在截图前还没加载 */
async function bannerThumb(url) {
  const u = String(url || '').trim()
  if (!/^https?:\/\//i.test(u)) return ''
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return ''
    const type = String(res.headers.get('content-type') || '')
    if (!/^image\//i.test(type)) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > 5 * 1024 * 1024) return ''
    const sharp = (await import('sharp')).default
    const out = await sharp(buf).resize(96, 64, { fit: 'cover' }).webp({ quality: 70 }).toBuffer()
    return `data:image/webp;base64,${out.toString('base64')}`
  } catch (_) {
    return ''
  }
}

export class calendar extends plugin {
  constructor() {
    super({
      name: '[米哈游]日历',
      dsc: '原神/星铁/绝区零活动日历',
      event: 'message',
      priority: pluginPriority('calendar', -999998),
      rule: [
        { reg: CAL_RE.source, fnc: 'calendar' },
      ],
    })
  }

  async accept(e) {
    const msg = String(e?.msg || '').trim()
    if (!CAL_RE.test(msg)) return false
    const game = gameOf(msg)
    this.e = e
    await this.calendar(e)
    return 'return'
  }

  async calendar(e) {
    const game = gameOf(e?.msg || '')
    if (game === 'bh3') {
      // 崩三日历有独立实现：直接转过去出图，不再只回一句提示
      try {
        const { bh3_calendar } = await import('../bh3/bh3_calendar.js')
        return await new bh3_calendar().calendar(e)
      } catch (err) {
        return e.reply(`崩三日历生成失败：${err?.message || err}`)
      }
    }
    const now = moment()
    try {
      const raw = await getCalendarActivities(game)
      // 生日是本地固定表，和公告合并；原神/绝区零有，星铁暂无
      const birthdays = getBirthdayActivities(game, 21, now)
      if (game === 'zzz' && birthdays.length) {
        // 绝区零头像要按官方 wiki 补一次（结果落 data/ 缓存，后续直接命中）
        try {
          await fillZzzBirthdayAvatars(birthdays.map(b => b.person))
          for (const b of birthdays) b.avatar = b.avatar || ''
        } catch (_) {}
      }
      raw.push(...birthdays)
      // 14 天窗口：今天前后各 7 天；超出窗口的活动裁到边界并打箭头
      const winStart = now.clone().startOf('day').subtract(7, 'days')
      const winEnd = winStart.clone().add(14, 'days')
      const windowMs = winEnd.valueOf() - winStart.valueOf()
      const list = (raw || [])
        .filter(item => {
          if (!item?.end?.isValid?.()) return false
          if (item?.kind === 'birthday') {
            // 生日按当天标记：只保留窗口内且没过去的
            return !item.end.isBefore(now) && !item.end.isBefore(winStart)
          }
          if (CAL_IGNORE.test(item.title || '')) return false
          if (item.end.isBefore(now)) return false
          if (item.end.isBefore(winStart)) return false
          if (item.start?.isValid?.() && item.start.isAfter(winEnd)) return false
          return true
        })
        .sort((a, b) => (a.start?.valueOf?.() || winStart.valueOf()) - (b.start?.valueOf?.() || winStart.valueOf()))
        .slice(0, 30)
        .map(item => {
          const started = !item.start || item.start.isSameOrBefore(now)
          const s = item.start?.isValid?.() && item.start.isAfter(winStart) ? item.start : winStart
          const e = item.end.isBefore(winEnd) ? item.end : winEnd
          let left = Math.max(0, Math.min(100, (s.valueOf() - winStart.valueOf()) / windowMs * 100))
          let width = Math.max(0.6, Math.min(100 - left, (e.valueOf() - s.valueOf()) / windowMs * 100))
          /* 极窄条（即将开始，起点贴近窗口末端）回退左端并给足宽度，避免向右撑出轨道 */
          if (width < 6) {
            left = Math.max(0, Math.min(left, 94))
            width = 6
          }
          return {
            title: item.title || item.subtitle || '未命名活动',
            srcBanner: item.banner || '',
            kind: KIND_META[item.kind]?.cls || 'event',
            kindLabel: KIND_META[item.kind]?.label || '活动',
            person: item.person || '',
            avatar: item.avatar || '',
            portrait: item.kind === 'birthday' ? portraitOf(game, item.person) : '',
            tag: item.tag || '',
            startText: fmtDate(item.start, now),
            endText: fmtDate(item.end, now),
            remain: remainText(now, item.end),
            status: started ? '进行中' : '即将开始',
            statusClass: started ? 'on' : 'soon',
            startAbs: item.start?.isValid?.() ? item.start.clone() : winStart.clone(),
            left: left.toFixed(2),
            width: width.toFixed(2),
            clipLeft: !!item.start?.isValid?.() && item.start.isBefore(winStart),
            clipRight: item.end.isAfter(winEnd),
            barText: remainShort(now, item.end),
          }
        })
      if (!list.length) return e.reply(`暂未获取到${GAME_CN[game]}活动日历，请稍后再试。`)
      // banner 缩图：6 个一组，失败不影响日历
      for (let i = 0; i < list.length; i += 6) {
        await Promise.all(list.slice(i, i + 6).map(async a => {
          a.banner = await bannerThumb(a.srcBanner)
        }))
      }

      // 大事件：版本/卡池/商店/刷新按“发生日”标在时间轴上，同一类只留最近一次
      const mk = (kind, label) => ({ kind, kindLabel: label, seen: new Set() })
      const groups = [mk('version', '版本'), mk('gacha', '卡池'), mk('shop', '商店'), mk('reset', '刷新'), mk('birthday', '生日')]
        .filter(g => list.some(a => a.kind === g.kind))
      const markList = []
      for (const g of groups) {
        for (const a of list) {
          if (a.kind !== g.kind) continue
          const day = Math.max(0, Math.min(13, a.startAbs.clone().startOf('day').diff(winStart, 'days')))
          if (g.seen.has(day)) continue
          g.seen.add(day)
          markList.push({
            kind: g.kind,
            kindLabel: g.kindLabel,
            day: a.startAbs.format('M/D'),
            short: a.title.replace(/^[「【]|」$|】$/g, '').slice(0, 12),
            title: a.title,
            person: a.person || '',
            avatar: a.avatar || '',
            pos: Math.min(92, Math.max(8, (day + 0.5) / 14 * 100)),
            abs: a.startAbs.valueOf(),
          })
        }
      }
      markList.sort((x, y) => x.abs - y.abs)
      const marks = markList.length

      const active = list.filter(i => i.status === '进行中').length
      const days = Array.from({ length: 14 }, (_, i) => {
        const d = winStart.clone().add(i, 'days')
        return {
          md: d.format('M/D'),
          week: '日一二三四五六'[d.day()],
          today: d.isSame(now, 'day'),
          weekend: [0, 6].includes(d.day()),
        }
      })
      const nowFrac = Math.max(0, Math.min(1, (now.valueOf() - winStart.valueOf()) / windowMs))
      return render('calendar/calendar', {
        game,
        gameCn: GAME_CN[game],
        nowText: now.format('YYYY-MM-DD HH:mm'),
        list,
        days,
        nowPos: (26 + 74 * nowFrac).toFixed(2),
        total: list.length,
        active,
        marks,
        markList,
        soon: list.length - active,
      }, { e, ret: true, dsf: 2 })
    } catch (err) {
      logger.error?.(`[HoYoGet][calendar] 获取日历失败：${err?.message || err}`)
      return e.reply(`获取${GAME_CN[game]}活动日历失败：${err?.message || err}`)
    }
  }
}
