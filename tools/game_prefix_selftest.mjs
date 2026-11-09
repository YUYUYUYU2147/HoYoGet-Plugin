import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parseHoYoGetPrefix, normalizeHoYoGetEvent } from '../system/game_prefix.js'

assert.equal(parseHoYoGetPrefix('星铁抽卡记录').normalized, '*星铁抽卡记录')
assert.equal(parseHoYoGetPrefix('绝区零抽卡记录').normalized, '%绝区零抽卡记录')
assert.equal(parseHoYoGetPrefix('崩坏3抽卡记录').normalized, '!崩三抽卡记录')
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

// Exercise the actual BH3 constructor rules against the text the prefix
// normalizer feeds to the framework. Constructor changes require a restart.
const pluginRoot = path.resolve(import.meta.dirname, '..')
const ruleSources = [
  ['apps/bh3/bh3_abyss.js', ['崩三深渊']],
  ['apps/bh3/bh3_battlefield.js', ['崩三战场', '崩三记忆战场', '!战场', '！战场']],
  ['apps/bh3/bh3_godwar.js', ['崩三乐土', '崩三往世乐土']],
  ['apps/bh3/bh3_weekly.js', ['崩三周常', '崩三周常挑战']],
  ['apps/common/TL.js', ['崩三体力', '崩三全部体力']],
]
for (const [file, messages] of ruleSources) {
  const source = fs.readFileSync(path.join(pluginRoot, file), 'utf8')
  const rules = [...source.matchAll(/reg:\s*(['"])(.*?)\1/g)]
    .map((m) => new RegExp(m[2].replace(/\\\\/g, '\\')))
  assert.ok(rules.length, `${file} has registered command rules`)
  for (const message of messages) {
    const normalized = parseHoYoGetPrefix(message)?.normalized || message
    assert.ok(rules.some((rule) => rule.test(normalized)), `${file} should match ${normalized}`)
  }
}

console.log('game prefix self-test passed')
