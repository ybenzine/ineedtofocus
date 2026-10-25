// A session archived on this device only (a rejected session) is never changed by the
// cross-device reconcile: the server never had it.

import { afterEach, expect, it } from 'vitest'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { clearArchivedOnDevice, markArchivedOnDevice, reconcileMissing } from './reconcile.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'

let store: IndexedDbSessionStore | null = null
afterEach(() => store?.close())

it('clearArchivedOnDevice, markArchivedOnDevice and reconcileMissing leave it archived and rejected', async () => {
  store = new IndexedDbSessionStore({ name: freshDbName() })
  const record = makeRecord()
  await store.save(record, 'me')
  await store.markRejected(record.id, null)
  await store.archiveOnDevice('me', record.id)

  // Even if the server's lists named the id, the device-only archive stays.
  await clearArchivedOnDevice(store, 'me', [record.id])
  await reconcileMissing(store, { list: async () => ({ kind: 'ok', value: [] }) }, 'me', [
    record.id,
  ])
  await markArchivedOnDevice(store, 'me', [{ id: record.id, archivedAt: '2026-10-25T00:00:00Z' }])

  const stored = await store.get(record.id)
  expect(stored?.syncState).toBe('rejected')
  expect(stored?.archivedAt).not.toBeNull()
  expect(stored?.archivedAt).not.toBe('2026-10-25T00:00:00Z')
})
