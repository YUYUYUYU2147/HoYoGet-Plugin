import { pluginPriority, render } from '#HoYoGet'
import { yshelperAbyssRank } from '../../system/yshelper.js'

/**
 * 原神深渊（深境螺旋）角色使用率统计。
 * 数据源：提瓦特小助手 getAbyssRank.php（全球玩家样本的使用率 / 持有率）。
 */
const RE_USAGE = /^[*#]?(?:米哈游)?\s*(?:原神)?\s*(?:(上期|往期)\s*)?(?:深渊|深境)?\s*使用率(?:\s*(上期|往期))?$/i

export class abyss_usage extends plugin {
  constructor() {
    super({
      name: '[米哈游]深渊使用率',
      dsc: '原神深渊角色使用率统计（提瓦特小助手）',
      event: 'message',
      priority: pluginPriority('abyss_usage', -32000),
      rule: [
        { reg: RE_USAGE.source, fnc: 'usage' },
      ],
    })
  }

  async usage(e) {
    const msg = String(e.msg || '')
    const schedule = /(上期|往期)/.test(msg) ? 2 : 1
    try {
      const data = await yshelperAbyssRank({ schedule })
      if (!data) return e.reply('未获取到深渊使用率数据，请稍后再试。')
      for (const g of data.groups || []) {
        for (const r of g.list || []) {
          r.starStr = r.star ? '★'.repeat(r.star) : ''
        }
      }
      const img = await render('abyss_usage/rank', {
        ...data,
        scheduleText: schedule === 2 ? '上期' : '本期',
        offline: !!data.offline,
      }, { e, ret: true, dsf: 3.2 })
      return img
    } catch (err) {
      logger.warn?.(`[HoYoGet][abyss_usage] 深渊使用率查询失败：${err?.message || err}`)
      return e.reply(`深渊使用率查询失败：${err?.message || err}`)
    }
  }
}
