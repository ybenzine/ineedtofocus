import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionDataHooks } from '../services.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { HttpSessionsApi } from './api.ts'
import { registerLocalDataHooks, registeredLocalDataHooks } from './localDataHooks.ts'
import {
  ACTIVE_OWNER_KEY,
  OwnedActiveSessionStore,
  USER_KEY,
  cachedUserId,
  quarantinePendingRecord,
} from './owner.ts'
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
function setup() {
  const server = new FakeSessionsServer()
  const sessions = new IndexedDbSessionStore({ name: freshDbName() })
  stores.push(sessions)
  const who = { owner: ALICE as string | null }
  const currentOwner = () => who.owner
  const sync = new SyncEngine({
    store: sessions,
    api: new HttpSessionsApi({ fetch: server.fetch }),
    currentOwner,
    isOnline: () => true,
    exclusive: (run) => run(),
  })
  const active = new OwnedActiveSessionStore(new MemoryActiveSessionStore(), currentOwner)
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
  const hooks = sessionDataHooks({ sessions, sync, active, currentOwner })
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

describe('cachedUserId', () => {
  it('reads the signed-in user cached by the accounts UI', () => {
    expect(cachedUserId()).toBeNull()
    localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
    expect(cachedUserId()).toBe(ALICE)
    localStorage.setItem(USER_KEY, '{not json')
    expect(cachedUserId()).toBeNull()
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
    await hooks.quarantine(ALICE)
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

  it('registers and unregisters', () => {
    const { hooks } = setup()
    const unregister = registerLocalDataHooks(hooks)
    expect(registeredLocalDataHooks()).toContain(hooks)
    unregister()
    expect(registeredLocalDataHooks()).not.toContain(hooks)
  })
})
