import { pluginPriority, config } from '#HoYoGet'
import { runCronTask } from '../../system/task_history.js'
import { collectCnScheduleData } from '../../tools/bh3_cn_schedule_source.mjs'

/**
 * 国服崩三排期来源同步。
 * 公共搜索结果中的文字排期包含 Boss/环境数据；定时任务写入
 * data/bh3_schedule_source/latest-data.json，供 UI 适配。日期/期号缺失
 * 时不会覆盖 system/default 下的手动排期数据。
 */
export class bh3_schedule_source extends plugin {
  constructor() {
    super({
      name: '[米哈游]崩三国服排期源',
      dsc: '定时抓取国服崩三排期文字数据',
      event: 'message',
      priority: pluginPriority('bh3_schedule_source', -100),
      rule: [{ reg: '^[#!！]*(崩三|崩坏3|崩坏三|BH3)排期源$', fnc: 'fetchSource' }],
    })
    this.task = {
      cron: String(config()?.bh3_schedule_source_cron || '0 0 */6 * * *'),
      name: '[米哈游]同步崩三国服排期源',
      fnc: () => runCronTask('崩三国服排期源同步', () => this.fetchSource()),
      log: true,
    }
  }

  async fetchSource(e) {
    try {
      const record = await collectCnScheduleData()
      const versions = Object.keys(record.versions || {})
      const tip = `已抓取公开文字排期（${versions.join('、')}），写入 latest-data.json；日期待校对`
      if (e) return e.reply(tip)
      logger.mark?.(`[HoYoGet][bh3_schedule_source] ${tip}`)
      return record
    } catch (err) {
      logger.warn?.(`[HoYoGet][bh3_schedule_source] 抓取失败：${err?.message || err}`)
      if (e) return e.reply(`崩三排期源抓取失败：${err?.message || err}`)
      throw err
    }
  }
}
