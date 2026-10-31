import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishSession, startSession } from '../timer/engine.ts'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import { HeldSession, AnonymousActiveSessionStore } from './held.ts'
import {
  ANON_ACTIVE_SESSION_KEY,
  ANON_HELD_ID_KEY,
  ANONYMOUS_PREFIX,
  clearAnonymousData,
} from './keys.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
  sessionStorage.clear()
})

/** A controller on the anonymous slot, as the app builds one, with its own page's HeldSession. */
function page(now: () => number) {
  const held = new HeldSession()
  const controller = new TimerController({
    store: new AnonymousActiveSessionStore(held),
    saveRecord: (record) => held.claim(record),
    now,
    newId: () => 'session-1',
  })
  return { held, controller }
}

const COUNTDOWN = {
  config: { mode: 'countdown', minutes: 25 },
  tag: 'work',
  goal: 'secret',
} as const

describe('the held anonymous session', () => {
  it('moves a finished session out of the slot into memory only, and names it in the marker', async () => {
    let now = 1_000_000
    const { held, controller } = page(() => now)
    await controller.start(COUNTDOWN)
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).not.toBeNull()
    now += 120_000
    const update = await controller.stop()
    expect(update.outcome?.kind).toBe('saved')
    expect(held.get()?.record.goal).toBe('secret')
    expect(held.holds('session-1')).toBe(true)
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBe('session-1')
    // The record is in no storage at all.
    const everything = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    expect(everything).not.toContain('secret')
  })

  it('is held by one page only: the one that empties the slot', async () => {
    let now = 1_000_000
    const first = page(() => now)
    await first.controller.start(COUNTDOWN)
    // A second tab loaded the same running session.
    const second = page(() => now)
    now += 120_000
    await Promise.all([first.controller.stop(), second.controller.restore()])
    const holders = [first.held, second.held].filter((h) => h.get() !== null)
    expect(holders).toHaveLength(1)
  })

  it('holds nothing when the slot is empty or holds another session by then', async () => {
    const session = startSession({ id: 'mine', ...COUNTDOWN }, 1_000_000)
    const outcome = finishSession(session, 1_120_000, 'completed')
    if (outcome.kind !== 'saved') throw new Error('expected a saved session')
    const held = new HeldSession()
    held.stash({ session, pendingRecord: outcome.record })
    // Empty: another page already claimed it.
    await held.claim(outcome.record)
    expect(held.get()).toBeNull()
    // Another session: a new one started in another tab.
    const other = startSession({ id: 'other', ...COUNTDOWN }, 1_000_000)
    localStorage.setItem(
      ANON_ACTIVE_SESSION_KEY,
      JSON.stringify({ session: other, pendingRecord: null }),
    )
    held.stash({ session, pendingRecord: outcome.record })
    await held.claim(outcome.record)
    expect(held.get()).toBeNull()
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toContain('"other"')
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBeNull()
  })

  it('takes the claim under a Web Lock when there is one', async () => {
    const request = vi.fn((_name: string, callback: () => Promise<unknown>) => callback())
    vi.stubGlobal('navigator', { ...navigator, locks: { request } })
    let now = 1_000_000
    const { held, controller } = page(() => now)
    await controller.start(COUNTDOWN)
    now += 120_000
    await controller.stop()
    expect(request).toHaveBeenCalledWith('ineedtofocus-anonymous-held', expect.any(Function))
    expect(held.get()).not.toBeNull()
  })

  it('still claims when the lock request itself fails', async () => {
    const request = vi.fn(() => Promise.reject(new Error('no locks')))
    vi.stubGlobal('navigator', { ...navigator, locks: { request } })
    let now = 1_000_000
    const { held, controller } = page(() => now)
    await controller.start(COUNTDOWN)
    now += 120_000
    await controller.stop()
    expect(held.get()).not.toBeNull()
  })

  async function held() {
    let now = 1_000_000
    const p = page(() => now)
    await p.controller.start(COUNTDOWN)
    now += 120_000
    await p.controller.stop()
    return p.held
  }

  it('is discarded when the marker is removed, replaced, or checked after a storage event', async () => {
    const h = await held()
    const listener = vi.fn()
    h.subscribe(listener)
    localStorage.setItem(ANON_HELD_ID_KEY, 'someone-else')
    window.dispatchEvent(new StorageEvent('storage', { key: ANON_HELD_ID_KEY }))
    expect(h.get()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(1)
    // Another page's marker is not ours to remove.
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBe('someone-else')
  })

  it.each(['pageshow', 'visibilitychange'])('re-checks the marker on %s', async (eventName) => {
    const h = await held()
    localStorage.removeItem(ANON_HELD_ID_KEY)
    if (eventName === 'pageshow') window.dispatchEvent(new Event('pageshow'))
    else document.dispatchEvent(new Event('visibilitychange'))
    expect(h.get()).toBeNull()
  })

  it('keeps the session while the marker still names it', async () => {
    const h = await held()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    window.dispatchEvent(new Event('pageshow'))
    expect(h.get()).not.toBeNull()
    expect(h.verify()).toBe(true)
  })

  it('hands the record over once, after checking the marker, and not when it is gone', async () => {
    const h = await held()
    const taken = h.take()
    expect(taken?.record.id).toBe('session-1')
    expect(h.get()).toBeNull()
    expect(h.take()).toBeNull()

    const again = await held()
    localStorage.removeItem(ANON_HELD_ID_KEY)
    expect(again.take()).toBeNull()
  })

  it('forgets the marker and the session when a session starts', async () => {
    const h = await held()
    h.forgetMarker()
    expect(h.get()).toBeNull()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBeNull()
  })

  it('removes its own marker when discarded', async () => {
    const h = await held()
    h.discard()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBeNull()
  })
})

describe('the anonymous slot', () => {
  it('never stores a finished record', () => {
    const held = new HeldSession()
    const store = new AnonymousActiveSessionStore(held)
    const session = startSession({ id: 's', ...COUNTDOWN }, 0)
    const outcome = finishSession(session, 120_000, 'completed')
    if (outcome.kind !== 'saved') throw new Error('expected a saved session')
    store.save({ session, pendingRecord: outcome.record })
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
    store.save({ session, pendingRecord: null })
    expect(new LocalActiveSessionStore(localStorage, ANON_ACTIVE_SESSION_KEY).load()).not.toBeNull()
  })

  it('clearAnonymousData removes every anonymous key and nothing else', () => {
    localStorage.setItem(`${ANONYMOUS_PREFIX}settings`, '{}')
    localStorage.setItem(`${ANONYMOUS_PREFIX}audioSource`, 'rain')
    localStorage.setItem(`${ANONYMOUS_PREFIX}youtubeLink`, 'x')
    localStorage.setItem(ANON_HELD_ID_KEY, 'id')
    localStorage.setItem(ANON_ACTIVE_SESSION_KEY, '{}')
    localStorage.setItem('ineedtofocus.settings', 'account')
    localStorage.setItem('ineedtofocus.owner', 'u1')
    clearAnonymousData()
    expect(Object.keys(localStorage).sort()).toEqual([
      'ineedtofocus.owner',
      'ineedtofocus.settings',
    ])
  })
})
