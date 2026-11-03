import { HoYoGetGachaPool } from './gacha_pool.js';

// 当前卡池快捷入口：避免“原神卡池 / #原神卡池”被历史卡池或通用卡池规则误吞。
export class HoYoGetGachaPoolShortcut extends HoYoGetGachaPool {
  constructor(e) {
    super(e);
    this.name = '[米哈游]全游戏卡池';
    this.dsc = '原神当前卡池快捷入口';
    this.event = 'message';
    this.priority = -1000000001;
    this.rule = [
      {
        reg: '^[#＃井]*\\s*原神\\s*(?:当前|本期|当期)?\\s*卡池$',
        fnc: 'gsCurrentPoolShortcut'
      }
    ];
  }

  async gsCurrentPoolShortcut(e) {
    e.msg = String(e?.msg || '')
      .replace(/[＃井]/g, '#')
      .replace(/\s+/g, '');
    return this.gsCurrentPool(e);
  }
}
