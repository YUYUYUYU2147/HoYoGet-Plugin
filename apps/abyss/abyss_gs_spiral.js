import { abyss_stat, GS_SPIRAL_RULE } from './abyss_stat.js'

/**
 * 深境螺旋单独一个插件类：Yunzai 的 priority 是插件级，rule 不能单独设优先级。
 * 数字越小越先执行，Number.MIN_SAFE_INTEGER 让它排在所有插件之前。
 *
 * 必须放在独立文件：本插件 index.js 的自举加载器每个文件只取第一个插件类，
 * 同一个文件里再导出一个子类会被漏掉。
 */
export class abyss_gs_spiral extends abyss_stat {
  constructor() {
    super()
    this.name = '[米哈游]深境螺旋'
    this.dsc = '原神深境螺旋战绩图'
    this.priority = Number.MIN_SAFE_INTEGER
    this.rule = [GS_SPIRAL_RULE]
  }
}
