import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SessionStore, SyncEngine } from '../sync/index.ts'
import { useSessionSynced } from './useSynced.ts'

describe('useSessionSynced (#454)', () => {
  it('is false without a store, then follows the session’s state after each sync run', async () => {
    expect(renderHook(() => useSessionSynced('abc', null, null)).result.current).toBe(false)

    let syncState: 'pending' | 'synced' = 'pending'
    const store = { get: () => Promise.resolve({ syncState }) } as unknown as SessionStore
    let notify = () => {}
    const sync = {
      onChange: (listener: () => void) => {
        notify = listener
        return () => {}
      },
    } as unknown as SyncEngine
    const { result } = renderHook(() => useSessionSynced('abc', store, sync))
    await act(async () => {})
    expect(result.current).toBe(false)
    syncState = 'synced'
    act(() => notify())
    await waitFor(() => expect(result.current).toBe(true))
  })
})
