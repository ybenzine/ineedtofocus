// A way out of "Couldn't sync": discard a refused edit, archive a rejected session on the device.

import { afterEach, describe, expect, it } from 'vitest'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'

const ME = 'user-me'
const OTHER = 'user-other'
const SERVER = { id: 'x', tag: 'work', goal: 'Synced goal', archivedAt: null } as const

const opened: IndexedDbSessionStore[] = []
function openStore() {
  const store = new IndexedDbSessionStore({ name: freshDbName(), now: () => Date.UTC(2026, 9, 24) })
  opened.push(store)
  return store
}
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

async function rejectedSession(store: IndexedDbSessionStore) {
  const record = makeRecord({ goal: 'Wrong clock' })
  await store.save(record, ME)
  await store.markRejected(record.id, null)
  return record
}

describe('discardEdit', () => {
  it('removes a refused edit; the session shows its last synced tag and goal', async () => {
    const store = openStore()
    const record = makeRecord({ goal: null })
    await store.save(record, ME)
    await store.markSynced(record.id, SERVER)
    await store.edit(ME, record.id, { tag: 'study', goal: 'New' })
    const version = (await store.get(record.id))?.editVersion ?? 0
    await store.rejectEdit(record.id, version, null)

    await store.discardEdit(ME, record.id)

    const [session] = await store.list(ME)
    expect(session.edit).toBeNull()
    expect(session.editState).toBeNull()
    expect(session.record).toMatchObject({ tag: 'work', goal: 'Synced goal' })
    expect(session.indicator).toBe('synced')
    expect(await store.countUnsynced(ME)).toEqual({ sessions: 0, edits: 0 })
  })

  it('leaves a pending edit, and another account’s edit, alone', async () => {
    const store = openStore()
    const record = makeRecord()
    await store.save(record, ME)
    await store.markSynced(record.id, SERVER)
    await store.edit(ME, record.id, { tag: 'study' })
    await store.discardEdit(ME, record.id)
    expect((await store.get(record.id))?.editState).toBe('pending')

    const version = (await store.get(record.id))?.editVersion ?? 0
    await store.rejectEdit(record.id, version, null)
    await store.discardEdit(OTHER, record.id)
    expect((await store.get(record.id))?.editState).toBe('rejected')
  })
})

describe('archiving on this device only', () => {
  it('archives a rejected session; it is still unsynced and listed as archived', async () => {
    const store = openStore()
    const record = await rejectedSession(store)

    await store.archiveOnDevice(ME, record.id)

    const [session] = await store.list(ME)
    expect(session.archivedAt).toBe('2026-10-24T00:00:00.000Z')
    expect(session.syncState).toBe('rejected')
    expect(session.indicator).toBe('couldnt-sync')
    // Sign-out still counts it (it would be lost from the device).
    expect(await store.countUnsynced(ME)).toEqual({ sessions: 1, edits: 0 })
    expect(await store.uploadQueue(ME, 10)).toEqual([])
  })

  it('refuses a pending or synced session, and another account’s', async () => {
    const store = openStore()
    const pending = makeRecord()
    const synced = makeRecord()
    await store.save(pending, ME)
    await store.save(synced, ME)
    await store.markSynced(synced.id, SERVER)
    const rejected = await rejectedSession(store)

    await store.archiveOnDevice(ME, pending.id)
    await store.archiveOnDevice(ME, synced.id)
    await store.archiveOnDevice(OTHER, rejected.id)

    for (const { id } of [pending, synced, rejected]) {
      expect((await store.get(id))?.archivedAt).toBeNull()
    }
  })

  it('restore puts it back, still rejected, with nothing else changed', async () => {
    const store = openStore()
    const record = await rejectedSession(store)
    const before = await store.get(record.id)
    await store.archiveOnDevice(ME, record.id)

    await store.restoreOnDevice(ME, record.id)

    expect(await store.get(record.id)).toEqual(before)
    expect((await store.list(ME))[0].indicator).toBe('couldnt-sync')
  })

  it('the server’s archive state never changes it (the server never had it)', async () => {
    const store = openStore()
    const record = await rejectedSession(store)
    await store.archiveOnDevice(ME, record.id)
    await store.setArchived(ME, record.id, null)
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()
    await store.markGone(ME, [record.id], Date.now() + 1000)
    expect(await store.get(record.id)).toBeDefined()
  })

  it('removeArchived deletes it with the rest; a rejected session that is not archived stays', async () => {
    const store = openStore()
    const archived = await rejectedSession(store)
    const live = await rejectedSession(store)
    await store.archiveOnDevice(ME, archived.id)

    await store.removeArchived(ME)

    expect(await store.get(archived.id)).toBeUndefined()
    expect(await store.get(live.id)).toBeDefined()
  })
})
