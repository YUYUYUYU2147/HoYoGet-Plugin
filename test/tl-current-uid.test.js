import assert from 'node:assert/strict'
import test from 'node:test'

globalThis.plugin = class { constructor (options) { Object.assign(this, options) } }
globalThis.logger = { warn () {}, error () {}, debug () {}, mark () {}, info () {} }
globalThis.config = () => ({ Tl: true })
globalThis.Bot = {}

const { TL } = await import('../apps/common/TL.js')

function makeTl(entries) {
  const tl = new TL()
  tl.getStokenEntry = (e, uid) => entries[uid] || null
  tl.isGameEntry = (entry, game) => entry?.game === game
  return tl
}

test('uses HoYoGet switched UID before e.user and the first stoken entry', async (t) => {
  const oldRedis = globalThis.redis
  t.after(() => { globalThis.redis = oldRedis })
  globalThis.redis = {
    get: async key => ({ 'HoYoGet:cur_uid:gs:10001': '20002' })[key] || null,
  }

  const tl = makeTl({
    20002: { game: 'gs', ck_stoken: 'a' },
    30003: { game: 'gs', ck_stoken: 'b' },
  })
  const e = { user_id: '10001', user: { getUid: () => '30003' } }
  assert.equal(await tl.getCurrentGameUid(e, 'gs'), '20002')
})

test('bh3 checks cur_uid before the legacy bh3_uid key', async (t) => {
  const oldRedis = globalThis.redis
  t.after(() => { globalThis.redis = oldRedis })
  globalThis.redis = {
    get: async key => ({
      'HoYoGet:cur_uid:bh3:10001': '40004',
      'HoYoGet:bh3_uid:10001': '50005',
    })[key] || null,
  }

  const tl = makeTl({
    40004: { game: 'bh3', ck_stoken: 'a' },
    50005: { game: 'bh3', ck_stoken: 'b' },
  })
  assert.equal(await tl.getCurrentGameUid({ user_id: '10001' }, 'bh3'), '40004')
})

test('ignores a switched UID that belongs to another game', async (t) => {
  const oldRedis = globalThis.redis
  t.after(() => { globalThis.redis = oldRedis })
  globalThis.redis = {
    get: async key => ({ 'HoYoGet:cur_uid:gs:10001': '60006' })[key] || null,
  }

  const tl = makeTl({
    60006: { game: 'sr', ck_stoken: 'a' },
    70007: { game: 'gs', ck_stoken: 'b' },
  })
  const e = { user_id: '10001', user: { getUid: () => '70007' } }
  assert.equal(await tl.getCurrentGameUid(e, 'gs'), '70007')
})

test('explicit uid always wins without reading redis', async (t) => {
  const oldRedis = globalThis.redis
  let reads = 0
  t.after(() => { globalThis.redis = oldRedis })
  globalThis.redis = { get: async () => { reads++; return '20002' } }

  const tl = makeTl({ 30003: { game: 'gs', ck_stoken: 'a' } })
  assert.equal(await tl.getCurrentGameUid({ user_id: '10001' }, 'gs', '30003'), '30003')
  assert.equal(reads, 0)
})
