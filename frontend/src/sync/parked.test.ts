import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OWNER_KEY,
  USER_KEY,
  claimLocalData,
  countUnsynced,
  registerLocalDataHook,
  type LocalDataHook,
} from '../auth/localData.ts'
import { sessionDataHook } from '../services.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import {
  ACTIVE_SESSION_KEY,
  LocalActiveSessionStore,
  TimerController,
  type SessionRecord,
} from '../timer/index.ts'
import { HttpSessionsApi } from './api.ts'
import { ACTIVE_OWNER_KEY, OwnedActiveSessionStore, quarantinePendingRecord } from './owner.ts'
import { PARKED_KEY, drainParked, loadParked, parkSession } from './parked.ts'
import { IndexedDbSessionStore, type SessionStore } from './sessionStore.ts'
import { SyncEngine } from './syncEngine.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'
const bob = { id: BOB, email: 'b@example.com', created_at: '2026-10-23T00:00:00Z' }

const stores: IndexedDbSessionStore[] = []
const unregisters: (() => void)[] = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  for (const unregister of unregisters.splice(0)) unregister()
  for (const store of stores.splice(0)) store.close()
  localStorage.clear()
})

function openStore() {
  const store = new IndexedDbSessionStore({ name: freshDbName() })
  stores.push(store)
  return store
}

/** A store whose `save` fails or never settles; reads are never reached here. */
function brokenStore(save: () => Promise<void>): SessionStore {
  return { save } as unknown as SessionStore
}

let clock = Date.UTC(2026, 9, 23, 9, 0)

function aliceController(saveRecord: (record: SessionRecord) => Promise<void>) {
  localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
  localStorage.setItem(OWNER_KEY, ALICE)
  const active = new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => ALICE)
  const controller = new TimerController({ store: active, saveRecord, now: () => clock })
  return { active, controller }
}

/** Alice finishes a session that couldn't be saved on the device: it stays the pendingRecord. */
async function alicesUnsavedSession() {
  const { active, controller } = aliceController(() => Promise.reject(new Error('IndexedDB')))
  await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: 'Hers' })
  clock += 10 * 60_000
  const update = await controller.stop()
  expect(update.recordPending).toBe(true)
  const record = active.load()?.pendingRecord
  if (!record) throw new Error('expected a pending record')
  return { active, record }
}

function registerHook(active: OwnedActiveSessionStore, sessions: SessionStore) {
  const sync = new SyncEngine({
    store: sessions,
    api: new HttpSessionsApi({ fetch: new FakeSessionsServer().fetch }),
    currentOwner: () => null,
    isOnline: () => false,
  })
  const hook = sessionDataHook({ sessions, sync, active, currentOwner: () => BOB })
  unregisters.push(registerLocalDataHook(hook))
  return hook
}

describe('quarantine when IndexedDB fails (F13, owner ruling on #9)', () => {
  it('a quarantine that throws parks the session, sign-in proceeds, and a later start-up stores it', async () => {
    const { active, record } = await alicesUnsavedSession()
    registerHook(
      active,
      brokenStore(() => Promise.reject(new Error('IndexedDB'))),
    )

    await claimLocalData(bob)
    expect(localStorage.getItem(OWNER_KEY)).toBe(BOB)
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(loadParked()).toEqual([{ ownerId: ALICE, record }])

    // Later start-up with a working IndexedDB: moved into the store under Alice, shelf emptied.
    const sessions = openStore()
    expect(await drainParked(sessions)).toBe(1)
    expect(localStorage.getItem(PARKED_KEY)).toBeNull()
    expect((await sessions.list(ALICE)).map((s) => s.record)).toEqual([record])
    expect(await sessions.list(BOB)).toEqual([])
  })

  it('a quarantine that never resolves is cut off; the session is parked and sign-in proceeds', async () => {
    const { active, record } = await alicesUnsavedSession()
    registerHook(
      active,
      brokenStore(() => new Promise<void>(() => undefined)),
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const claiming = claimLocalData(bob)
    await vi.advanceTimersByTimeAsync(10_000)
    await claiming
    vi.useRealTimers()
    expect(localStorage.getItem(OWNER_KEY)).toBe(BOB)
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(loadParked()).toEqual([{ ownerId: ALICE, record }])

    const sessions = openStore()
    await drainParked(sessions)
    expect((await sessions.list(ALICE)).map((s) => s.record.id)).toEqual([record.id])
  })

  it('a hook that hangs past its own limit is still cut off by sign-in, and the safety net parks', async () => {
    const { record } = await alicesUnsavedSession()
    const hanging: LocalDataHook = {
      countUnsynced: async () => ({ sessions: 0, edits: 0 }),
      trySync: async () => undefined,
      clear: async () => undefined,
      quarantine: () => new Promise<void>(() => undefined),
    }
    unregisters.push(registerLocalDataHook(hanging))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const claiming = claimLocalData(bob)
    await vi.advanceTimersByTimeAsync(10_000)
    await claiming
    expect(loadParked()).toEqual([{ ownerId: ALICE, record }])
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem(ACTIVE_OWNER_KEY)).toBeNull()
  })

  it('a parked-list lock that is never granted is cut off; sign-in proceeds and the timer keeps its copy', async () => {
    const { record } = await alicesUnsavedSession()
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: { request: () => new Promise(() => undefined) },
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const claiming = claimLocalData(bob)
    await vi.advanceTimersByTimeAsync(10_000)
    await claiming
    vi.unstubAllGlobals()
    expect(localStorage.getItem(OWNER_KEY)).toBe(BOB)
    // Not parked, so not deleted either: it stays where the next start-up finds it.
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toContain(record.id)
    expect(loadParked()).toEqual([])
  })

  it('never deletes the session if it can be neither stored nor parked', async () => {
    await alicesUnsavedSession()
    const setItem = Storage.prototype.setItem
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === PARKED_KEY) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      setItem.call(this, key, value)
    })
    await claimLocalData(bob)
    spy.mockRestore()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
  })

  it('a later drain that fails leaves the session parked for next time', async () => {
    const record = makeRecord()
    await parkSession(ALICE, record)
    expect(await drainParked(brokenStore(() => Promise.reject(new Error('x'))))).toBe(0)
    expect(
      await drainParked(
        brokenStore(() => new Promise<void>(() => undefined)),
        { timeoutMs: 10 },
      ),
    ).toBe(0)
    expect(loadParked()).toEqual([{ ownerId: ALICE, record }])
  })
})

describe('a previous owner’s session that ended while the app was closed (AC6.5)', () => {
  it('is quarantined as Completed under them, not deleted', async () => {
    const { controller, active } = aliceController(() => Promise.resolve())
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'read', goal: null })
    clock += 60 * 60_000 // the app was closed past the countdown's end
    const sessions = openStore()
    await quarantinePendingRecord(active, sessions, ALICE, { now: () => clock })
    const [session] = await sessions.list(ALICE)
    expect(session.record).toMatchObject({
      status: 'completed',
      focusSeconds: 25 * 60,
      tag: 'read',
    })
    expect(active.load()).toBeNull()
  })

  it('a session still running is not moved (an unfinished timer stays with its account)', async () => {
    const { controller, active } = aliceController(() => Promise.resolve())
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'read', goal: null })
    clock += 5 * 60_000
    const sessions = openStore()
    await quarantinePendingRecord(active, sessions, ALICE, { now: () => clock })
    expect(await sessions.list(ALICE)).toEqual([])
    expect(active.load()).not.toBeNull()
  })
})

describe('parked sessions belong to their owner', () => {
  it('are counted and cleared with that owner’s data only; clear() with no user does nothing', async () => {
    const sessions = openStore()
    const sync = new SyncEngine({
      store: sessions,
      api: new HttpSessionsApi({ fetch: new FakeSessionsServer().fetch }),
      currentOwner: () => null,
      isOnline: () => false,
    })
    const who = { owner: ALICE as string | null }
    const hook = sessionDataHook({
      sessions,
      sync,
      active: new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => who.owner),
      currentOwner: () => who.owner,
    })
    await parkSession(ALICE, makeRecord())
    const bobs = makeRecord()
    await parkSession(BOB, bobs)
    const nobodys = makeRecord()
    await sessions.save(nobodys, null)
    expect(await hook.countUnsynced()).toEqual({ sessions: 1, edits: 0 })

    who.owner = null
    await hook.clear()
    expect(await sessions.countUnsynced(null)).toEqual({ sessions: 1, edits: 0 })
    expect(loadParked()).toHaveLength(2)

    who.owner = ALICE
    await hook.clear()
    expect(loadParked()).toEqual([{ ownerId: BOB, record: bobs }])
    unregisters.push(registerLocalDataHook(hook))
    expect(await countUnsynced()).toEqual({ sessions: 0, edits: 0 })
  })
})
