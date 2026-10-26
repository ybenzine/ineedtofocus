import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OWNER_KEY,
  USER_KEY,
  claimLocalData,
  clearLocalUserData,
  countUnsynced,
  registerLocalDataHook,
  signedInUserId,
} from '../auth/localData.ts'
import { sessionDataHook } from '../services.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import {
  LocalActiveSessionStore,
  MemoryActiveSessionStore,
  TimerController,
} from '../timer/index.ts'
import { HttpSessionsApi } from './api.ts'
import { ACTIVE_OWNER_KEY, OwnedActiveSessionStore, quarantinePendingRecord } from './owner.ts'
import { deviceSaver } from './saveRecord.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'
import { SyncEngine } from './syncEngine.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'

const stores: IndexedDbSessionStore[] = []

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  localStorage.clear()
})

/** The app's wiring (services.ts), with a fake clock and a fake server. */
function setup(currentOwnerOverride?: () => string | null) {
  const server = new FakeSessionsServer()
  const sessions = new IndexedDbSessionStore({ name: freshDbName() })
  stores.push(sessions)
  const who = { owner: ALICE as string | null }
  const currentOwner = currentOwnerOverride ?? (() => who.owner)
  const sync = new SyncEngine({
    store: sessions,
    api: new HttpSessionsApi({ fetch: server.fetch }),
    currentOwner,
    isOnline: () => true,
    exclusive: (run) => run(),
  })
  const active = new OwnedActiveSessionStore(
    currentOwnerOverride ? new LocalActiveSessionStore() : new MemoryActiveSessionStore(),
    currentOwner,
  )
  let now = Date.UTC(2026, 9, 23, 9, 0)
  const saveState = { failing: false }
  const save = deviceSaver({
    store: sessions,
    ownerOf: (record) => active.ownerOf(record.id) ?? currentOwner(),
  })
  const controller = new TimerController({
    store: active,
    saveRecord: async (record) => {
      if (saveState.failing) throw new Error('IndexedDB unavailable')
      await save(record)
    },
    now: () => now,
  })
  const hooks = sessionDataHook({ sessions, sync, active, currentOwner })
  const finish = async () => {
    await controller.start({
      config: { mode: 'unlimited', reminderMinutes: null },
      tag: 'work',
      goal: 'Secret goal',
    })
    now += 10 * 60_000
    return controller.stop()
  }
  return { server, sessions, sync, active, controller, hooks, who, saveState, finish }
}

describe('signedInUserId', () => {
  it('is the cached user, if the device’s data is bound to them', () => {
    expect(signedInUserId()).toBeNull()
    localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
    expect(signedInUserId()).toBe(ALICE)
    localStorage.setItem(OWNER_KEY, ALICE)
    expect(signedInUserId()).toBe(ALICE)
    localStorage.setItem(OWNER_KEY, BOB)
    expect(signedInUserId()).toBeNull()
    localStorage.setItem(USER_KEY, '{not json')
    expect(signedInUserId()).toBeNull()
  })
})

describe('session owners', () => {
  it('stores a finished session under the user who started it', async () => {
    const { sessions, finish } = setup()
    const update = await finish()
    expect(update.recordPending).toBe(false)
    const [session] = await sessions.list(ALICE)
    expect(session.record.goal).toBe('Secret goal')
    expect(localStorage.getItem(ACTIVE_OWNER_KEY)).toBeNull()
  })

  it('a previous owner’s pendingRecord is stored under them, never under the new user', async () => {
    const { sessions, controller, who, saveState, finish, server, sync } = setup()
    saveState.failing = true
    const update = await finish()
    expect(update.recordPending).toBe(true)

    // Bob signs in on this device; the app restarts and hands the record over.
    who.owner = BOB
    saveState.failing = false
    await controller.restore()
    expect(await sessions.list(BOB)).toEqual([])
    expect(await sessions.countUnsynced(ALICE)).toEqual({ sessions: 1, edits: 0 })
    await sync.syncNow()
    expect(server.sessions.size).toBe(0)

    // Alice signs in again: it syncs to her account.
    who.owner = ALICE
    await sync.syncNow()
    expect(server.sessions.size).toBe(1)
  })

  it('quarantine moves the previous owner’s pendingRecord into the store under them', async () => {
    const { sessions, active, saveState, finish, hooks } = setup()
    saveState.failing = true
    await finish()
    await hooks.quarantine?.(ALICE)
    expect(active.load()).toBeNull()
    expect((await sessions.list(ALICE)).map((s) => s.indicator)).toEqual(['not-synced-yet'])
    // Nothing pending: a no-op.
    await quarantinePendingRecord(active, sessions, ALICE)
    expect(await sessions.list(ALICE)).toHaveLength(1)
  })
})

describe('sign-out hooks', () => {
  it('count, sync and clear only the signed-in user’s data', async () => {
    const { sessions, server, hooks, who, sync } = setup()
    const alices = [makeRecord(), makeRecord()]
    await sessions.save(alices[1], ALICE)
    await sync.syncNow()
    await sessions.save(alices[0], ALICE)
    const bobs = makeRecord()
    await sessions.save(bobs, BOB)
    await sessions.edit(ALICE, alices[1].id, { goal: 'Changed' })

    expect(await hooks.countUnsynced()).toEqual({ sessions: 1, edits: 1 })
    server.mode = 'offline'
    await hooks.trySync()
    expect(await hooks.countUnsynced()).toEqual({ sessions: 1, edits: 1 })
    server.mode = 'up'
    await hooks.trySync()
    expect(await hooks.countUnsynced()).toEqual({ sessions: 0, edits: 0 })

    await hooks.clear()
    expect(await sessions.list(ALICE)).toEqual([])
    who.owner = BOB
    expect((await sessions.list(BOB)).map((s) => s.record.id)).toEqual([bobs.id])
  })
})

describe('with the accounts UI’s registry (#9)', () => {
  const alice = { id: ALICE, email: 'a@example.com', created_at: '2026-10-23T00:00:00Z' }
  const bob = { id: BOB, email: 'b@example.com', created_at: '2026-10-23T00:00:00Z' }
  const unregisters: (() => void)[] = []

  afterEach(() => {
    for (const unregister of unregisters.splice(0)) unregister()
  })

  function signIn(user: typeof alice) {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
    localStorage.setItem(OWNER_KEY, user.id)
  }

  function registered() {
    const app = setup(signedInUserId)
    unregisters.push(registerLocalDataHook(app.hooks))
    return app
  }

  it('a different user’s sign-in quarantines the previous owner’s unsaved session', async () => {
    signIn(alice)
    const { sessions, saveState, finish, sync, server } = registered()
    saveState.failing = true
    expect((await finish()).recordPending).toBe(true)
    expect(await countUnsynced()).toEqual({ sessions: 1, edits: 0 })

    await claimLocalData(bob)
    localStorage.setItem(USER_KEY, JSON.stringify(bob))
    expect(localStorage.getItem(ACTIVE_OWNER_KEY)).toBeNull()
    expect(await sessions.list(BOB)).toEqual([])
    expect(await countUnsynced()).toEqual({ sessions: 0, edits: 0 })
    await sync.syncNow()
    expect(server.sessions.size).toBe(0)

    // Alice signs in again on this device: her session syncs to her account.
    await claimLocalData(alice)
    signIn(alice)
    expect((await sessions.list(ALICE)).map((s) => s.indicator)).toEqual(['not-synced-yet'])
    await sync.syncNow()
    expect(server.sessions.size).toBe(1)
  })

  it('sign-out clears only the signed-in user’s sessions, through the hook', async () => {
    signIn(alice)
    const { sessions } = registered()
    await sessions.save(makeRecord(), ALICE)
    const bobs = makeRecord()
    await sessions.save(bobs, BOB)
    await clearLocalUserData()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(await sessions.list(ALICE)).toEqual([])
    expect((await sessions.list(BOB)).map((s) => s.record.id)).toEqual([bobs.id])
  })

  it('a hook whose clear fails doesn’t stop the rest of sign-out', async () => {
    signIn(alice)
    const { sessions } = registered()
    await sessions.save(makeRecord(), ALICE)
    unregisters.push(
      registerLocalDataHook({
        countUnsynced: async () => ({ sessions: 0, edits: 0 }),
        trySync: async () => undefined,
        clear: async () => {
          throw new Error('IndexedDB unavailable')
        },
      }),
    )
    await clearLocalUserData()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBeNull()
    expect(await sessions.list(ALICE)).toEqual([])
  })
})

describe('a session whose first write failed keeps its owner on the retry (#245)', () => {
  it('records the user who started it, not whoever is signed in at the retry', () => {
    let signedIn: string | null = ALICE
    let full = true
    const storage: Storage = Object.assign(Object.create(window.localStorage) as Storage, {
      getItem: (key: string) => window.localStorage.getItem(key),
      removeItem: (key: string) => window.localStorage.removeItem(key),
      setItem: (key: string, value: string) => {
        if (full) throw new Error('QuotaExceededError')
        window.localStorage.setItem(key, value)
      },
    })
    const active = new OwnedActiveSessionStore(
      new MemoryActiveSessionStore(),
      () => signedIn,
      storage,
    )
    const state = {
      session: { id: 's1' } as never,
      pendingRecord: null,
    }
    expect(() => active.save(state)).toThrow()
    signedIn = null // another tab signed Alice out
    full = false
    active.save(state)
    expect(active.ownerOf('s1')).toBe(ALICE)
  })
})
