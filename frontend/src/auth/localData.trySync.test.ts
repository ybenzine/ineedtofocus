import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLocalDataHook, trySyncAll } from './localData.ts'

afterEach(() => vi.useRealTimers())

describe('trySyncAll', () => {
  it('lets two hooks that each wait 10 s finish together within 10 s, not 20', async () => {
    vi.useFakeTimers()
    const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 10_000))
    const stop = [
      registerLocalDataHook({
        trySync: slow,
        countUnsynced: async () => ({ sessions: 0, edits: 0 }),
        clear: async () => undefined,
      }),
      registerLocalDataHook({
        trySync: slow,
        countUnsynced: async () => ({ sessions: 0, edits: 0 }),
        clear: async () => undefined,
      }),
    ]
    let done = false
    void trySyncAll().then(() => (done = true))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toBe(true)
    stop.forEach((fn) => fn())
  })
})
