import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppServices } from '../services.ts'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { ACTIVE_SESSION_KEY } from '../timer/index.ts'
import { PARKED_KEY, PARKED_LOCK, drainParked, loadParked, parkSession } from './parked.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const stores: IndexedDbSessionStore[] = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) store.close()
  localStorage.clear()
})

function openStore() {
  const store = new IndexedDbSessionStore({ name: freshDbName() })
  stores.push(store)
  return store
}

/** A Web Locks stand-in: one holder per name at a time, the rest queue (like two tabs). */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>()
  const requested: string[] = []
  return {
    requested,
    request: <T>(name: string, run: () => Promise<T>): Promise<T> => {
      requested.push(name)
      const result = (tails.get(name) ?? Promise.resolve()).then(run)
      tails.set(
        name,
        result.catch(() => undefined),
      )
      return result
    },
  }
}

describe('updates to the parked list are atomic across tabs (AC3)', () => {
  it('park and remove take the parked list’s Web Lock', async () => {
    const locks = fakeLocks()
    vi.stubGlobal('navigator', { ...navigator, locks })
    await parkSession(ALICE, makeRecord())
    await drainParked(openStore())
    expect(locks.requested).toEqual([PARKED_LOCK, PARKED_LOCK])
    expect(loadParked()).toEqual([])
  })

  it('two writers at once keep both entries', async () => {
    vi.stubGlobal('navigator', { ...navigator, locks: fakeLocks() })
    const a = makeRecord()
    const b = makeRecord()
    await Promise.all([parkSession(ALICE, a), parkSession(BOB, b)])
    expect(loadParked().map((p) => p.record.id)).toEqual([a.id, b.id])
  })

  it('works without Web Locks (jsdom, older browsers)', async () => {
    expect(navigator.locks).toBeUndefined()
    const a = makeRecord()
    const b = makeRecord()
    await Promise.all([parkSession(ALICE, a), parkSession(ALICE, b), parkSession(ALICE, a)])
    expect(loadParked().map((p) => p.record.id)).toEqual([a.id, b.id])
  })

  it('a refused write rejects, so the caller knows not to delete the original', async () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key) {
      if (key === PARKED_KEY) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    await expect(parkSession(ALICE, makeRecord())).rejects.toThrow()
    spy.mockRestore()
  })
})

describe('parked sessions move into the store while the app is open (AC2)', () => {
  it('after a successful save, and only then are they removed from the shelf', async () => {
    const services = createAppServices(() => ALICE)
    const parked = makeRecord()
    await parkSession(BOB, parked)

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 9, 23, 9, 0))
    await services.controller.start({
      config: { mode: 'countdown', minutes: 25 },
      tag: 'work',
      goal: null,
    })
    vi.setSystemTime(Date.UTC(2026, 9, 23, 9, 10))
    await services.controller.stop()
    vi.useRealTimers()

    await vi.waitFor(() => expect(loadParked()).toEqual([]))
    expect((await services.sessions?.list(BOB))?.map((s) => s.record.id)).toEqual([parked.id])
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
  })

  it('a failed write leaves the entry on the shelf for the next pass', async () => {
    const parked = makeRecord()
    await parkSession(BOB, parked)
    const failing = { save: () => Promise.reject(new Error('IndexedDB down')) }
    expect(await drainParked(failing as unknown as IndexedDbSessionStore)).toBe(0)
    expect(loadParked().map((p) => p.record.id)).toEqual([parked.id])
  })

  it('overlapping passes in one tab run one at a time', async () => {
    const services = createAppServices(() => ALICE)
    await parkSession(BOB, makeRecord())
    const first = services.drainParked?.()
    const second = services.drainParked?.()
    expect(second).toBe(first)
    await first
    expect(loadParked()).toEqual([])
  })
})
