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
    upHistory: [{ type: 'weapon', start: '2026-11-01 00:00:00', end: '2026-11-10 00:00:00', s: '测试武器', a: [] }],
  })
  const poolRows = Object.values(payload.pools).flatMap(pool => pool.records)
  const apkRows = payload.bh3[0].list

  assert.equal(payload.game, 'bh3')
  assert.equal(payload.info.uigf_version, undefined)
  assert.deepEqual(Object.keys(payload.pools), ['角色补给A', '装备补给B', '家园补给'])
  assert.equal(poolRows.length, 5)
  assert.equal(poolRows.filter(row => row.content === '[材料]金币*50000').length, 2)
  assert.equal(poolRows.filter(row => row.content === '[材料]礼包币*100').length, 0)
  assert.equal(apkRows.length, 5)
  assert.equal(new Set(apkRows.map(row => row.id)).size, 5)
  assert.ok(apkRows.every(row => /^\d+$/.test(row.id)))
  assert.ok(apkRows.every(row => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.time)))
  assert.equal(apkRows.find(row => row.pool_name === '装备补给B').gacha_type, '4|装备补给B')
  assert.equal(apkRows.find(row => row.pool_name === '家园补给').gacha_type, '6|家园补给')
  assert.deepEqual(apkRows.find(row => row.content === '[角色]测试女武神角色卡'), {
    uid: source.uid,
    id: apkRows.find(row => row.content === '[角色]测试女武神角色卡').id,
    gacha_type: '1|角色补给A',
    uigf_gacha_type: '1|角色补给A',
    item_id: '',
    name: '测试女武神',
    item_type: '角色',
    rank_type: '5',
    is_up: true,
    time: '2026-11-10 10:00:00',
    count: '1',
    content: '[角色]测试女武神角色卡',
    pool_name: '角色补给A',
  })
  assert.equal(apkRows.find(row => row.content === '[武器]测试武器').rank_type, '5')
  assert.equal(buildBh3Export(source.uid, {
    data: { '装备补给B': [{ time: '2026-11-09 08:30:15', content: '[圣痕]测试圣痕' }] },
  }, {
    stigmata: { 测试圣痕: '圣痕星级/四星' },
    upHistory: [{ type: 'weapon', start: '2026-11-01 00:00:00', end: '2026-11-10 00:00:00', s: '测试圣痕', a: [] }],
  }).bh3[0].list[0].rank_type, '4')
})

test('rejects malformed times and content that the importer would reject', () => {
  assert.throws(() => buildBh3Export(source.uid, {
    data: { '角色补给A': [{ time: '2026-02-30 10:00:00', content: '[角色]无效日期' }] },
  }), /时间无效/)
  assert.throws(() => buildBh3Export(source.uid, {
    data: { '角色补给A': [{ time: '2026-11-10 10:00:00', content: ' '.repeat(501) }] },
  }), /内容为空或过长/)
})

test('counts every equipment-supply stigma as four-star', () => {
  const payload = buildBh3Export('12345678', {
    data: {
      '装备补给B': [{ time: '2026-10-16 01:53:22', content: '[圣痕]非UP圣痕' }],
    },
  }, {
    stigmata: { 非UP圣痕: '圣痕星级/五星' },
    upHistory: [{ type: 'weapon', start: '2026-10-01 00:00:00', end: '2026-11-01 00:00:00', s: '其他武器', a: ['其他圣痕'] }],
  })
  assert.equal(payload.bh3[0].list[0].rank_type, '4')
  assert.equal(payload.bh3[0].list[0].is_up, false)
})

test('counts non-featured equipment weapons as four-star and featured weapons as five-star', () => {
  const payload = buildBh3Export('12345678', {
    data: {
      '装备补给B': [
        { time: '2026-10-16 01:53:22', content: '[武器]火妖精Ⅱ型' },
        { time: '2026-10-16 01:53:22', content: '[武器]本期UP武器' },
        { time: '2026-10-16 01:53:22', content: '[武器]星级未知武器' },
      ],
    },
  }, {
    weapon: { 火妖精Ⅱ型: '武器星级/五星武器', 本期UP武器: '武器星级/五星武器' },
    upHistory: [{ type: 'weapon', start: '2026-10-01 00:00:00', end: '2026-11-01 00:00:00', s: '本期UP武器', a: [] }],
  })
  const [nonFeatured, featured, unknownRank] = payload.bh3[0].list

  assert.equal(nonFeatured.rank_type, '4')
  assert.equal(nonFeatured.is_up, false)
  assert.equal(featured.rank_type, '5')
  assert.equal(featured.is_up, true)
  assert.equal(unknownRank.rank_type, '4')
  assert.equal(unknownRank.is_up, false)
})

test('keeps featured equipment rank overrides on the banner start day', () => {
  const payload = buildBh3Export('12345678', {
    data: {
      '装备补给B': [
        { time: '2026-06-13 00:57:04', content: '[武器]晦夜麟光' },
        { time: '2026-06-13 00:57:04', content: '[圣痕]岁岁如新' },
      ],
    },
  })
  const rows = payload.bh3[0].list

  assert.deepEqual(rows.map(row => [row.name, row.rank_type, row.is_up]), [
    ['晦夜麟光', '5', true],
    ['岁岁如新', '4', true],
  ])
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
  assert.ok(payload.bh3[0].list.every(item => item.gacha_type === '2|角色补给B'))
})

test('never exports legacy aliases as pools when no canonical copy exists', () => {
  const row = { time: '2026-11-10 10:00:00', content: '[材料]星石*500' }
  assert.throws(() => buildBh3Export('12345678', {
    data: { '武器': [row], '礼包币记录': [row] },
  }), /没有可导出的崩三抽卡记录/)

  const payload = buildBh3Export('12345678', {
    data: {
      '角色补给A': [row],
      '武器': [row],
      '礼包币记录': [row],
    },
  })
  assert.deepEqual(Object.keys(payload.pools), ['角色补给A'])
  assert.ok(payload.bh3[0].list.every(item => /^[1-6]\|/.test(item.gacha_type)))
})

test('keeps BH3 character pools distinct and marks every initial S as UP outside home supply', () => {
  const payload = buildBh3Export('12345678', {
    data: {
      '角色补给A': [
        { time: '2026-11-10 10:00:00', content: '[角色]测试女武神角色卡' },
        { time: '2026-11-10 10:00:00', content: '[角色]非UP女武神角色卡' },
      ],
      '角色补给B': [
        { time: '2026-11-10 10:00:00', content: '[角色]角色池B初始S角色卡' },
      ],
      '家园补给': [
        { time: '2026-11-10 10:00:00', content: '[角色]家园初始S角色卡' },
      ],
    },
  }, {
    char: {
      测试女武神: '初始阶级/S',
      非UP女武神: '初始阶级/S',
      角色池B初始S: '初始阶级/S',
      家园初始S: '初始阶级/S',
    },
    upHistory: [{ type: 'char', start: '2026-11-01 00:00:00', end: '2026-11-20 00:00:00', s: '测试女武神', a: [] }],
  })

  assert.equal(payload.bh3[0].list.find(row => row.name === '测试女武神').is_up, true)
  assert.equal(payload.bh3[0].list.find(row => row.name === '非UP女武神').is_up, true)
  assert.equal(payload.bh3[0].list.find(row => row.name === '角色池B初始S').gacha_type, '2|角色补给B')
  assert.equal(payload.bh3[0].list.find(row => row.name === '角色池B初始S').is_up, true)
  assert.equal(payload.bh3[0].list.find(row => row.name === '家园初始S').is_up, null)
})

test('uses the official BH3 wiki title for the HoYoGet companion alias', () => {
  const payload = buildBh3Export('12345678', {
    data: {
      '协同补给': [{ time: '2026-10-05 12:20:10', content: '[协同者]游云' }],
    },
  }, {
    upHistory: [{ type: 'char', start: '2026-09-24 12:00:00', end: '2026-11-06 12:00:00', s: '协同者轮替', a: ['白鹿游云'] }],
  })

  assert.deepEqual(payload.pools['协同补给'].records, [
    { time: '2026-10-05 12:20:10', content: '[协同者]游云' },
  ])
  assert.equal(payload.bh3[0].list[0].name, '白鹿游云')
  assert.equal(payload.bh3[0].list[0].is_up, true)
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
