import assert from 'node:assert/strict'
import test from 'node:test'
import { selectUidGames, shouldUseUidGrid, uidViewModeFromPrefix } from '../system/uid_view.js'

const games = [
  { key: 'gs', uidList: [{ uid: 'uid-a' }] },
  { key: 'sr', uidList: [{ uid: 'uid-b' }, { uid: 'uid-c' }] },
  { key: 'zzz', uidList: [{ uid: 'uid-d' }] },
  { key: 'bh3', uidList: [{ uid: 'uid-e' }] },
]

test('maps display prefixes to their game scopes', () => {
  assert.equal(uidViewModeFromPrefix('#'), 'all')
  assert.equal(uidViewModeFromPrefix('*'), 'sr')
  assert.equal(uidViewModeFromPrefix('%'), 'zzz')
  assert.equal(uidViewModeFromPrefix('!'), 'bh3')
  assert.equal(uidViewModeFromPrefix('！'), 'bh3')
  assert.equal(uidViewModeFromPrefix('?'), '')
})

test('keeps full game order and filters single-game views', () => {
  assert.deepEqual(selectUidGames(games).map(game => game.key), ['gs', 'sr', 'zzz', 'bh3'])
  assert.deepEqual(selectUidGames(games, 'sr').map(game => game.key), ['sr'])
  assert.deepEqual(selectUidGames(games, 'zzz').map(game => game.key), ['zzz'])
  assert.deepEqual(selectUidGames(games, 'bh3').map(game => game.key), ['bh3'])
  assert.deepEqual(selectUidGames(games, 'sr')[0].uidList.map(row => row.uid), ['uid-b', 'uid-c'])
})

test('uses a grid only for all-game views with more than ten UIDs', () => {
  const ten = [{ key: 'sr', uidList: Array.from({ length: 10 }, (_, i) => ({ uid: `uid-${i}` })) }]
  const eleven = [{ key: 'sr', uidList: Array.from({ length: 11 }, (_, i) => ({ uid: `uid-${i}` })) }]
  assert.equal(shouldUseUidGrid(ten), false)
  assert.equal(shouldUseUidGrid(eleven), true)
  assert.equal(shouldUseUidGrid(eleven, 'sr'), false)
})
