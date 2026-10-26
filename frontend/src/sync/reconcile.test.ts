import { afterEach, describe, expect, it, vi } from 'vitest'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import {
  clearArchivedOnDevice,
  markArchivedOnDevice,
  reconcileArchivedGone,
  reconcileMissing,
} from './reconcile.ts'
import { IndexedDbSessionStore, type SessionStore } from './sessionStore.ts'

describe('markArchivedOnDevice', () => {
  it('#133 marks the listed sessions archived, except ones skipped since the list loaded', async () => {
    const setArchived = vi.fn().mockResolvedValue(undefined)
    const store = { setArchived } as unknown as SessionStore
    const list = [
      { id: 'a', archivedAt: '2026-10-20T10:00:00Z' },
      { id: 'restored', archivedAt: '2026-10-20T11:00:00Z' },
    ]
    await markArchivedOnDevice(store, 'me', list, (id) => id === 'restored')
    expect(setArchived).toHaveBeenCalledTimes(1)
    expect(setArchived).toHaveBeenCalledWith('me', 'a', '2026-10-20T10:00:00Z')
  })
})

describe('clearArchivedOnDevice', () => {
  it('#228 clears the mark of the listed ids, except skipped ones', async () => {
    const setArchived = vi.fn().mockResolvedValue(undefined)
    const store = { setArchived } as unknown as SessionStore
    await clearArchivedOnDevice(store, 'me', ['a', 'mine'], (id) => id === 'mine')
    expect(setArchived).toHaveBeenCalledTimes(1)
    expect(setArchived).toHaveBeenCalledWith('me', 'a', null)
  })
})

describe('reconcileMissing racing with Undo on this screen', () => {
  it('#228 does not mark archived a session whose Undo started while the Archive list loaded', async () => {
    const setArchived = vi.fn().mockResolvedValue(undefined)
    const markGone = vi.fn().mockResolvedValue(undefined)
    const store = { setArchived, markGone } as unknown as SessionStore
    const restored = new Set<string>()
    let answer: (value: unknown) => void = () => undefined
    const archiveApi = {
      list: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    } as unknown as Parameters<typeof reconcileMissing>[1]

    const reconcile = reconcileMissing(
      store,
      archiveApi,
      'me',
      ['s'],
      (id) => restored.has(id),
      123,
    )
    // The user taps Undo: the restore call is under way (and its own setArchived(null) follows).
    restored.add('s')
    answer({ kind: 'ok', value: [{ id: 's', archivedAt: '2026-10-21T10:00:00Z' }] })
    await reconcile
    expect(setArchived).not.toHaveBeenCalled()
    expect(markGone).toHaveBeenCalledWith('me', [], 123)
  })
})

describe('reconcileArchivedGone', () => {
  const device = (id: string, over: Record<string, unknown> = {}) => ({
    record: { id },
    syncState: 'synced',
    archivedAt: '2026-10-20T10:00:00Z',
    ...over,
  })
  it('#263 marks only synced archived copies the list lacks, except skipped ones', async () => {
    const markGone = vi.fn().mockResolvedValue(undefined)
    const list = vi
      .fn()
      .mockResolvedValue([
        device('listed'),
        device('gone'),
        device('mine'),
        device('rejected', { syncState: 'rejected' }),
        device('pending', { syncState: 'pending' }),
        device('live', { archivedAt: null }),
      ])
    const store = { list, markGone } as unknown as SessionStore
    await reconcileArchivedGone(store, 'me', [{ id: 'listed' }], (id) => id === 'mine', 123)
    expect(markGone).toHaveBeenCalledWith('me', ['gone'], 123)
  })
})

describe('the load start time confirms a mark (#258)', () => {
  const opened: IndexedDbSessionStore[] = []
  afterEach(() => opened.splice(0).forEach((s) => s.close()))
  const noArchive = { list: async () => ({ kind: 'ok' as const, value: [] }) }

  async function marked(clock: number) {
    const store = new IndexedDbSessionStore({ name: freshDbName(), now: () => clock })
    opened.push(store)
    const record = makeRecord()
    await store.save(record, 'me')
    await store.markSynced(record.id, null)
    await reconcileMissing(store, noArchive, 'me', [record.id], () => false, clock)
    return { store, record }
  }

  it('a pair that started after the mark confirms it, one that started at or before it does not', async () => {
    const { store, record } = await marked(1000)
    expect((await store.get(record.id))?.goneOnServer).toBe(1000)
    await reconcileMissing(store, noArchive, 'me', [record.id], () => false, 900)
    await reconcileMissing(store, noArchive, 'me', [record.id], () => false, 1000)
    expect(await store.get(record.id)).toBeDefined()
    await reconcileMissing(store, noArchive, 'me', [record.id], () => false, 1001)
    expect(await store.get(record.id)).toBeUndefined()
  })

  it('without a start time nothing is confirmed (no default taken after the answer)', async () => {
    const { store, record } = await marked(1000)
    // @ts-expect-error loadStartedAt is required: a caller can't leave it out
    await reconcileMissing(store, noArchive, 'me', [record.id], () => false)
    expect(await store.get(record.id)).toBeDefined()
  })

  it('reconcileArchivedGone needs the start time too', async () => {
    const { store, record } = await marked(1000)
    await store.setArchived('me', record.id, '2026-10-20T10:00:00Z')
    await store.markGone('me', [record.id], 1000)
    // @ts-expect-error loadStartedAt is required
    await reconcileArchivedGone(store, 'me', [], () => false)
    expect(await store.get(record.id)).toBeDefined()
  })
})
