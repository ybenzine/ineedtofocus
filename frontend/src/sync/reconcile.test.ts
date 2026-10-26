import { describe, expect, it, vi } from 'vitest'
import {
  clearArchivedOnDevice,
  markArchivedOnDevice,
  reconcileArchivedGone,
  reconcileMissing,
} from './reconcile.ts'
import type { SessionStore } from './sessionStore.ts'

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

    const reconcile = reconcileMissing(store, archiveApi, 'me', ['s'], (id) => restored.has(id))
    // The user taps Undo: the restore call is under way (and its own setArchived(null) follows).
    restored.add('s')
    answer({ kind: 'ok', value: [{ id: 's', archivedAt: '2026-10-21T10:00:00Z' }] })
    await reconcile
    expect(setArchived).not.toHaveBeenCalled()
    expect(markGone).toHaveBeenCalledWith('me', [], expect.any(Number))
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
