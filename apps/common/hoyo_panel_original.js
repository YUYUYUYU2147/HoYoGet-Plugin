import { hoyo_panel, ORIGINAL_REG } from './hoyo_panel.js'

const BARE_ORIGINAL_REG = /^#?\s*原图$/i

/** 原图单独一个最高优先级插件类：要压过 miao 的 getOriginalPicture / 咕咕牛原图管理器等 */
export class hoyo_panel_original extends hoyo_panel {
  constructor() {
    super()
    this.name = '[米哈游]面板原图'
    this.dsc = '原神/星铁面板立绘原图（主人）'
    this.priority = Number.MIN_SAFE_INTEGER
    this.rule = [{ reg: ORIGINAL_REG.source, fnc: 'panelOriginal' }]
  }

  async accept(e) {
    const msg = String(e?.msg || '')
    /* 明确的 #原神原图 / #星铁原图 / #米哈游原图：全部由本插件接管（非主人由 panelOriginal 拒绝） */
    if (ORIGINAL_REG.test(msg)) {
      this.e = e
      await this.panelOriginal(e)
      return 'return'
    }
    /* 裸 #原图 只给主人接管；非主人放行，避免影响 miao / 咕咕牛等插件的原图功能 */
    if (!BARE_ORIGINAL_REG.test(msg) || !e.isMaster) return false
    this.e = e
    await this.panelOriginal(e)
    return 'return'
  }
}
