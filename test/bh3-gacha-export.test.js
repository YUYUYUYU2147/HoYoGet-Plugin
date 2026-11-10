import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.plugin = class { constructor (options) { Object.assign(this, options) } }
globalThis.logger = { warn () {}, error () {}, debug () {}, mark () {} }
globalThis.config = () => ({})
globalThis.Bot = {}

const { buildBh3Export, gacha_export } = await import('../apps/common/gacha_export.js')

const source = {
  uid: '12345678',
  data_time: '2026-11-10 12:00:00',
  data: {
    '角色补给A': [
      { time: '2026-11-10 10:00:00', content: '[角色]测试女武神角色卡' },
      { time: '2026-11-10 10:00:00', content: '[材料]金币*50000' },
      { time: '2026-11-10 10:00:00', content: '[材料]金币*50000' },
    ],
    '装备补给B': [
      { time: '2026-11-09 08:30:15', content: '[武器]测试武器' },
    ],
    '武器': [
      { time: '2026-11-09 08:30:15', content: '[材料]礼包币*100' },
    ],
    '家园补给': [
      { time: '2026-11-10 10:00:00', content: '[角色]商店兑换物' },
    ],
    '礼包币记录': [
      { time: '2026-11-09 08:30:15', content: '[材料]礼包币*100' },
    ],
  },
}

test('exports pool rows and APK BH3 rows without losing duplicate pulls', () => {
  const payload = buildBh3Export(source.uid, source, {
    char: { 测试女武神: '初始阶级/S' },
    weapon: { 测试武器: '武器星级/五星武器' },
    stigmata: { 测试圣痕: '圣痕星级/四星' },
  })
  const poolRows = Object.values(payload.pools).flatMap(pool => pool.records)
  const apkRows = payload.bh3[0].list

  assert.equal(payload.game, 'bh3')
  assert.equal(payload.info.uigf_version, undefined)
  assert.deepEqual(Object.keys(payload.pools), ['角色补给A', '装备补给B', '武器'])
  assert.equal(poolRows.length, 5)
  assert.equal(poolRows.filter(row => row.content === '[材料]金币*50000').length, 2)
  assert.equal(poolRows.filter(row => row.content === '[材料]礼包币*100').length, 1)
  assert.equal(apkRows.length, 5)
  assert.equal(new Set(apkRows.map(row => row.id)).size, 5)
  assert.ok(apkRows.every(row => /^\d+$/.test(row.id)))
  assert.ok(apkRows.every(row => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.time)))
  assert.equal(apkRows.find(row => row.pool_name === '装备补给B').gacha_type, '4')
  assert.deepEqual(apkRows.find(row => row.content === '[角色]测试女武神角色卡'), {
    uid: source.uid,
    id: apkRows.find(row => row.content === '[角色]测试女武神角色卡').id,
    gacha_type: '1',
    uigf_gacha_type: '1',
    item_id: '',
    name: '测试女武神',
    item_type: '角色',
    rank_type: '5',
    time: '2026-11-10 10:00:00',
    count: '1',
    content: '[角色]测试女武神角色卡',
    pool_name: '角色补给A',
  })
  assert.equal(apkRows.find(row => row.content === '[武器]测试武器').rank_type, '5')
  assert.equal(buildBh3Export(source.uid, {
    data: { '装备补给B': [{ time: '2026-11-09 08:30:15', content: '[圣痕]测试圣痕' }] },
  }, { stigmata: { 测试圣痕: '圣痕星级/四星' } }).bh3[0].list[0].rank_type, '4')
})

test('rejects malformed times and content that the importer would reject', () => {
  assert.throws(() => buildBh3Export(source.uid, {
    data: { '角色补给A': [{ time: '2026-02-30 10:00:00', content: '[角色]无效日期' }] },
  }), /时间无效/)
  assert.throws(() => buildBh3Export(source.uid, {
    data: { '角色补给A': [{ time: '2026-11-10 10:00:00', content: ' '.repeat(501) }] },
  }), /内容为空或过长/)
})

test('drops a legacy pool when its records are already present in a canonical pool', () => {
  const row = { time: '2026-11-10 10:00:00', content: '[角色]同一条记录角色卡' }
  const payload = buildBh3Export('12345678', {
    data: {
      '角色补给B': [row, row],
      '武器': [row],
    },
  })

  assert.deepEqual(Object.keys(payload.pools), ['角色补给B'])
  assert.equal(payload.bh3[0].list.length, 2)
  assert.ok(payload.bh3[0].list.every(item => item.gacha_type === '2'))
})

test('registers the requested BH3 export command aliases', () => {
  const rule = new RegExp(new gacha_export().rule.find(item => item.fnc === 'exportBh3Log').reg)
  for (const command of [
    '#崩三导出抽卡记录',
    '崩坏3导出抽卡记录 12345678',
    '#崩坏三抽卡记录导出',
    '#导出崩三抽卡记录',
  ]) assert.match(command, rule)
})
