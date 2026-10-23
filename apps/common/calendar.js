import moment from 'moment'
import { pluginPriority, render } from '#HoYoGet'
import { getCalendarActivities } from './activity_remind.js'

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
    if (game === 'bh3') {
      await e.reply('崩坏3日历请发送「！日历」或「#崩三日历」')
      return 'return'
    }
    this.e = e
    await this.calendar(e)
    return 'return'
  }

  async calendar(e) {
    const game = gameOf(e?.msg || '')
    if (game === 'bh3') return e.reply('崩坏3日历请发送「！日历」或「#崩三日历」')
    const now = moment()
    try {
      const raw = await getCalendarActivities(game)
      const list = (raw || [])
        .filter(item => item?.end?.isValid?.() && item.end.isAfter(now.clone().startOf('day')) && !CAL_IGNORE.test(item.title || ''))
        .sort((a, b) => a.end.valueOf() - b.end.valueOf())
        .slice(0, 40)
        .map(item => {
          const started = !item.start || item.start.isSameOrBefore(now)
          const totalMs = item.start ? item.end.valueOf() - item.start.valueOf() : 0
          const leftMs = item.end.valueOf() - now.valueOf()
          const progress = started
            ? (totalMs > 0 ? Math.max(0, Math.min(100, leftMs / totalMs * 100)) : 100)
            : 100
          return {
            title: item.title || item.subtitle || '未命名活动',
            progress: progress.toFixed(1),
            tag: item.tag || '',
            startText: fmtDate(item.start, now),
            endText: fmtDate(item.end, now),
            remain: remainText(now, item.end),
            status: started ? '进行中' : '即将开始',
            statusClass: started ? 'on' : 'soon',
          }
        })
      if (!list.length) return e.reply(`暂未获取到${GAME_CN[game]}活动日历，请稍后再试。`)
      const active = list.filter(i => i.status === '进行中').length
      return render('calendar/calendar', {
        game,
        gameCn: GAME_CN[game],
        nowText: now.format('YYYY-MM-DD HH:mm'),
        list,
        total: list.length,
        active,
        soon: list.length - active,
      }, { e, ret: true, dsf: 2 })
    } catch (err) {
      logger.error?.(`[HoYoGet][calendar] 获取日历失败：${err?.message || err}`)
      return e.reply(`获取${GAME_CN[game]}活动日历失败：${err?.message || err}`)
    }
  }
}
