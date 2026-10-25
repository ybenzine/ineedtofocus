import { describe, expect, it, vi } from 'vitest'
import { markArchivedOnDevice } from './reconcile.ts'
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
