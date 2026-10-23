import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRecord } from '../test/fakeSessionsServer.ts'
import { MemoryActiveSessionStore, TimerController, type SessionRecord } from '../timer/index.ts'
import { SAVE_TIMEOUT_MS, SaveTimeoutError, deviceSaver, withTimeout } from './saveRecord.ts'
import type { SessionStore } from './sessionStore.ts'

/** A session store whose `save` can be made to hang or fail; the rest is unused here. */
function fakeStore(save: (record: SessionRecord) => Promise<void>) {
  const saved: SessionRecord[] = []
  const store = {
    save: vi.fn(async (record: SessionRecord) => {
      await save(record)
      saved.push(record)
    }),
  } as unknown as SessionStore
  return { store, saved }
}

const never = () => new Promise<void>(() => undefined)

afterEach(() => {
  vi.useRealTimers()
})

async function finishedSession(saveRecord: (record: SessionRecord) => Promise<void>) {
  const active = new MemoryActiveSessionStore()
  let now = Date.UTC(2026, 9, 23, 9, 0)
  const controller = new TimerController({ store: active, saveRecord, now: () => now })
  await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
  now += 10 * 60_000
  return { controller, active }
}

describe('deviceSaver', () => {
  it('a save that never resolves falls back to "not saved yet" instead of freezing the timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const afterSave = vi.fn()
    const hanging = fakeStore(never)
    let store = hanging.store
    const saveRecord = deviceSaver({
      store: { save: (r: SessionRecord, o: string | null) => store.save(r, o) } as SessionStore,
      ownerOf: () => 'user-alice',
      afterSave,
    })
    const { controller, active } = await finishedSession(saveRecord)

    const stopping = controller.stop()
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    const update = await stopping
    expect(update.outcome?.kind).toBe('saved')
    expect(update.recordPending).toBe(true)
    // Still on the device, in the timer's own store; nothing went to the network.
    expect(active.load()?.pendingRecord?.id).toBe(
      update.outcome?.kind === 'saved' ? update.outcome.record.id : 'missing',
    )
    expect(afterSave).not.toHaveBeenCalled()

    // IndexedDB recovers: the retry stores it and the timer lets go of it.
    const working = fakeStore(async () => undefined)
    store = working.store
    expect(await controller.retryPending()).toBe(true)
    expect(working.saved).toHaveLength(1)
    expect(active.load()).toBeNull()
    expect(afterSave).toHaveBeenCalledOnce()
  })

  it('ac13_2 a failed device write never starts a network call', async () => {
    const afterSave = vi.fn()
    const { store } = fakeStore(async () => {
      throw new Error('QuotaExceededError')
    })
    const { controller, active } = await finishedSession(
      deviceSaver({ store, ownerOf: () => 'user-alice', afterSave }),
    )
    const update = await controller.stop()
    expect(update.recordPending).toBe(true)
    expect(active.load()?.pendingRecord).not.toBeNull()
    expect(afterSave).not.toHaveBeenCalled()
  })

  it('ac13_2 writes to the device first, then starts the sync', async () => {
    const order: string[] = []
    const { store } = fakeStore(async () => {
      order.push('device')
    })
    const save = deviceSaver({
      store,
      ownerOf: () => 'user-alice',
      afterSave: () => order.push('network'),
    })
    const record = makeRecord()
    await save(record)
    expect(order).toEqual(['device', 'network'])
    expect(store.save).toHaveBeenCalledWith(record, 'user-alice')
  })
})

describe('withTimeout', () => {
  it('passes a value or an error through', async () => {
    await expect(withTimeout(Promise.resolve(3), 1_000)).resolves.toBe(3)
    await expect(withTimeout(Promise.reject(new Error('no')), 1_000)).rejects.toThrow('no')
  })

  it('rejects with SaveTimeoutError when the time runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = withTimeout(never(), 100)
    const check = expect(result).rejects.toBeInstanceOf(SaveTimeoutError)
    await vi.advanceTimersByTimeAsync(100)
    await check
  })
})
