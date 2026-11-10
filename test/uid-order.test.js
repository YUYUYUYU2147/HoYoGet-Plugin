import assert from 'node:assert/strict'
import test from 'node:test'
import { orderUidRowsByReference } from '../system/uid_order.js'

test('orders matching rows by reference and keeps unmatched rows stable', () => {
  const rows = [
    { uid: 'uid-c', name: 'third' },
    { uid: 'uid-a', name: 'first' },
    { uid: 'uid-x', name: 'unmatched-a' },
    { uid: 'uid-b', name: 'second' },
    { uid: 'uid-y', name: 'unmatched-b' },
  ]
  const ordered = orderUidRowsByReference(rows, [
    { uid: 'uid-b' },
    { uid: 'uid-a' },
    { uid: 'uid-c' },
  ])

  assert.deepEqual(ordered.map(row => row.uid), ['uid-b', 'uid-a', 'uid-c', 'uid-x', 'uid-y'])
  assert.deepEqual(rows.map(row => row.uid), ['uid-c', 'uid-a', 'uid-x', 'uid-b', 'uid-y'])
})

test('preserves the source order when no reference list is available', () => {
  const rows = [{ uid: 'uid-c' }, { uid: 'uid-a' }, { uid: 'uid-b' }]
  assert.deepEqual(orderUidRowsByReference(rows).map(row => row.uid), ['uid-c', 'uid-a', 'uid-b'])
})
