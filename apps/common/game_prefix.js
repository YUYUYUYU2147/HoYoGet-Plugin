import { config } from '#HoYoGet'
import { normalizeHoYoGetEvent } from '../../system/game_prefix.js'

/** Runs before command handlers so configured game-name prefixes share native symbols. */
export class HoYoGetGamePrefix extends plugin {
  constructor() {
    super({
      name: '[米哈游]统一游戏指令前缀',
      dsc: '统一处理游戏文字前缀',
      event: 'message',
      priority: Number.MIN_SAFE_INTEGER,
    })
  }

  accept(e) {
    normalizeHoYoGetEvent(e, config() || {})
  }
}
