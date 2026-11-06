import assert from 'node:assert/strict'
import { parseHoYoGetPrefix, normalizeHoYoGetEvent } from '../system/game_prefix.js'

assert.equal(parseHoYoGetPrefix('星铁抽卡记录').normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('绝区零抽卡记录').normalized, '%绝区零抽卡记录')
assert.equal(parseHoYoGetPrefix('崩坏3抽卡记录').normalized, '#崩三抽卡记录')
assert.equal(parseHoYoGetPrefix('原神抽卡记录').normalized, '#原神抽卡记录')
assert.equal(parseHoYoGetPrefix('#抽卡记录').normalized, '#抽卡记录')
assert.equal(parseHoYoGetPrefix('*抽卡记录').normalized, '*抽卡记录')
assert.equal(parseHoYoGetPrefix('!日历').normalized, '!日历')
assert.equal(parseHoYoGetPrefix('#星铁抽卡记录').normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('#米哈游星铁抽卡记录').normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('自定义抽卡记录', { sr_command_prefixes: '自|自定义' }).normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('星穹铁道抽卡记录').normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('随便聊天'), null)

const event = { msg: '星铁抽卡记录', original_msg: '星铁抽卡记录' }
normalizeHoYoGetEvent(event)
assert.equal(event.msg, '*星铁抽卡记录')
assert.equal(event.original_msg, '*星铁抽卡记录')
assert.equal(event.raw_msg, '星铁抽卡记录')
assert.equal(event.hoyoGetGame, 'sr')

console.log('game prefix self-test passed')
