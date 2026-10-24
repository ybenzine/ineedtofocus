import { afterEach, describe, expect, it } from 'vitest'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const SERVER = { tag: 'study', goal: 'From the server', archivedAt: null } as const

const opened: IndexedDbSessionStore[] = []

function openStore(name = freshDbName()) {
  const store = new IndexedDbSessionStore({ name })
  opened.push(store)
  return { store, name }
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close()
})

describe('IndexedDbSessionStore', () => {
  it('ac13_2 keeps a saved session across a reload, as not synced yet', async () => {
    const { store, name } = openStore()
    const record = makeRecord({ goal: 'Chapter 3' })
    await store.save(record, ALICE)
    store.close()

    const { store: reopened } = openStore(name)
    const [session] = await reopened.list(ALICE)
    expect(session.record).toEqual(record)
    expect(session.syncState).toBe('pending')
    expect(session.indicator).toBe('not-synced-yet')
  })

  it('ac13_4 saving the same id twice changes nothing', async () => {
    const { store } = openStore()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.markSynced(record.id, null)
    await store.save({ ...record, goal: 'changed' }, BOB)
    const stored = await store.get(record.id)
    expect(stored?.record.goal).toBeNull()
    expect(stored?.ownerId).toBe(ALICE)
    expect(stored?.syncState).toBe('synced')
  })

  it('lists only the owner’s sessions, most recent first', async () => {
    const { store } = openStore()
    const older = makeRecord()
    const newer = makeRecord()
    const bobs = makeRecord()
    await store.save(older, ALICE)
    await store.save(newer, ALICE)
    await store.save(bobs, BOB)
    expect((await store.list(ALICE)).map((s) => s.record.id)).toEqual([newer.id, older.id])
    expect((await store.list(BOB)).map((s) => s.record.id)).toEqual([bobs.id])
  })

  it('ac10_9 shows synced, not synced yet and couldn’t sync distinctly', async () => {
    const { store } = openStore()
    const [pending, synced, rejected] = [makeRecord(), makeRecord(), makeRecord()]
    for (const r of [pending, synced, rejected]) await store.save(r, ALICE)
    await store.markSynced(synced.id, null)
    await store.markRejected(rejected.id, { code: 'validation_error', message: 'bad' })
    const byId = new Map((await store.list(ALICE)).map((s) => [s.record.id, s.indicator]))
    expect(byId.get(pending.id)).toBe('not-synced-yet')
    expect(byId.get(synced.id)).toBe('synced')
    expect(byId.get(rejected.id)).toBe('couldnt-sync')
    expect((await store.get(rejected.id))?.rejection?.code).toBe('validation_error')
  })

  it('takes the server’s tag and goal when a session syncs', async () => {
    const { store } = openStore()
    const record = makeRecord({ goal: 'line\nbreak' })
    await store.save(record, ALICE)
    await store.markSynced(record.id, { id: record.id, ...SERVER })
    const stored = await store.get(record.id)
    expect(stored?.record).toMatchObject({ tag: 'study', goal: 'From the server' })
  })

  it('a rejected session is never turned back into a pending one', async () => {
    const { store } = openStore()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.markRejected(record.id, null)
    expect(await store.uploadQueue(ALICE, 100)).toEqual([])
  })

  it('keeps an edit apart from the session and shows it applied', async () => {
    const { store } = openStore()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.markSynced(record.id, null)
    await store.edit(ALICE, record.id, { goal: 'New goal' })
    await store.edit(ALICE, record.id, { tag: 'read' })
    const stored = await store.get(record.id)
    expect(stored?.record.goal).toBeNull()
    expect(stored?.edit).toEqual({ goal: 'New goal', tag: 'read' })
    const [shown] = await store.list(ALICE)
    expect(shown.record).toMatchObject({ goal: 'New goal', tag: 'read' })
    expect(shown.indicator).toBe('not-synced-yet')
    expect((await store.editQueue(ALICE)).map((s) => s.id)).toEqual([record.id])
  })

  it('ignores an edit to another account’s session', async () => {
    const { store } = openStore()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.edit(BOB, record.id, { goal: 'Not mine' })
    expect((await store.get(record.id))?.edit).toBeNull()
  })

  it('a reply to an older edit keeps the newer one queued', async () => {
    const { store } = openStore()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.markSynced(record.id, null)
    await store.edit(ALICE, record.id, { goal: 'First' })
    const version = (await store.get(record.id))?.editVersion ?? -1
    await store.edit(ALICE, record.id, { goal: 'Second' })
    await store.resolveEdit(record.id, version, { id: record.id, ...SERVER, goal: 'First' })
    const stored = await store.get(record.id)
    expect(stored?.record.goal).toBe('First')
    expect(stored?.edit).toEqual({ goal: 'Second' })
    expect(stored?.editState).toBe('pending')
    await store.dropEdit(record.id, version)
    expect((await store.get(record.id))?.editState).toBe('pending')
  })

  it('counts what an owner hasn’t synced: sessions and edits', async () => {
    const { store } = openStore()
    expect(await store.hasUnsynced(ALICE)).toBe(false)
    const [pending, rejected, edited, clean] = [
      makeRecord(),
      makeRecord(),
      makeRecord(),
      makeRecord(),
    ]
    for (const r of [pending, rejected, edited, clean]) await store.save(r, ALICE)
    await store.save(makeRecord(), BOB)
    await store.markRejected(rejected.id, null)
    await store.markSynced(edited.id, null)
    await store.markSynced(clean.id, null)
    await store.edit(ALICE, edited.id, { tag: 'nap' })
    expect(await store.countUnsynced(ALICE)).toEqual({ sessions: 2, edits: 1 })
    expect(await store.countUnsynced(BOB)).toEqual({ sessions: 1, edits: 0 })
    expect(await store.hasUnsynced(ALICE)).toBe(true)
  })

  it('a session with nobody signed in has no owner and is counted under null', async () => {
    const { store } = openStore()
    await store.save(makeRecord(), null)
    expect(await store.countUnsynced(null)).toEqual({ sessions: 1, edits: 0 })
    expect(await store.countUnsynced(ALICE)).toEqual({ sessions: 0, edits: 0 })
  })

  it('clearing an owner deletes only their sessions', async () => {
    const { store } = openStore()
    const alices = makeRecord()
    const bobs = makeRecord()
    await store.save(alices, ALICE)
    await store.save(bobs, BOB)
    await store.clearOwner(ALICE)
    expect(await store.list(ALICE)).toEqual([])
    expect((await store.list(BOB)).map((s) => s.record.id)).toEqual([bobs.id])
  })
})

describe('archive state on the device', () => {
  const WHEN = '2026-10-21T11:00:00Z'

  async function synced(store: IndexedDbSessionStore, owner: string) {
    const record = makeRecord()
    await store.save(record, owner)
    await store.markSynced(record.id, null)
    return record
  }

  it('setArchived marks and unmarks the owner’s session, and ignores another owner', async () => {
    const { store } = openStore()
    const mine = await synced(store, ALICE)
    await store.setArchived(BOB, mine.id, WHEN)
    expect((await store.get(mine.id))?.archivedAt).toBeNull()
    await store.setArchived(ALICE, mine.id, WHEN)
    expect((await store.get(mine.id))?.archivedAt).toBe(WHEN)
    await store.setArchived(ALICE, mine.id, null)
    expect((await store.get(mine.id))?.archivedAt).toBeNull()
  })

  it('removeArchived deletes only the owner’s synced, archived sessions', async () => {
    const { store } = openStore()
    const archivedMine = await synced(store, ALICE)
    const liveMine = await synced(store, ALICE)
    const archivedBobs = await synced(store, BOB)
    const unsynced = makeRecord()
    await store.save(unsynced, ALICE)
    await store.setArchived(ALICE, archivedMine.id, WHEN)
    await store.setArchived(BOB, archivedBobs.id, WHEN)

    await store.removeArchived(ALICE)

    expect(await store.get(archivedMine.id)).toBeUndefined()
    expect(await store.get(liveMine.id)).toBeDefined()
    expect(await store.get(archivedBobs.id)).toBeDefined()
    expect(await store.get(unsynced.id)).toBeDefined()
  })
})
