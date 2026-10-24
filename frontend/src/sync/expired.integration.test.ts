import { afterEach, describe, expect, it } from 'vitest'
import { claimLocalData, OWNER_KEY, registerLocalDataHook } from '../auth/localData.ts'
import { sessionDataHook } from '../services.ts'
import { FakeSessionsServer, freshDbName } from '../test/fakeSessionsServer.ts'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { HttpSessionsApi } from './api.ts'
import { OwnedActiveSessionStore } from './owner.ts'
import { deviceSaver } from './saveRecord.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'
import { SyncEngine } from './syncEngine.ts'

const stores: IndexedDbSessionStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  localStorage.clear()
})

describe('a session finished while the sign-in is expired (#120)', () => {
  it('is saved under its owner, sends nothing, and syncs once the same user is back', async () => {
    const server = new FakeSessionsServer()
    const store = new IndexedDbSessionStore({ name: freshDbName() })
    stores.push(store)
    const state: { owner: string | null } = { owner: 'u1' }
    const engine = new SyncEngine({
      store,
      api: new HttpSessionsApi({ fetch: server.fetch }),
      currentOwner: () => state.owner,
      exclusive: (run) => run(),
    })
    const active = new OwnedActiveSessionStore(new MemoryActiveSessionStore(), () => state.owner)
    let now = Date.now()
    const controller = new TimerController({
      store: active,
      saveRecord: deviceSaver({
        store,
        ownerOf: (record) => active.ownerOf(record.id) ?? state.owner,
        afterSave: () => void engine.syncNow(),
      }),
      now: () => now,
    })
    localStorage.setItem(OWNER_KEY, 'u1')
    await controller.start({ config: { mode: 'countdown', minutes: 5 }, tag: 'work', goal: 'g' })
    state.owner = null // the sign-in expired mid-session
    now += 5 * 60_000
    await controller.tick()
    await engine.syncNow()

    expect(server.syncRequests).toEqual([])
    expect((await store.countUnsynced('u1')).sessions).toBe(1)

    // A different user signing in finds nothing of u1's to take or send.
    const unregister = registerLocalDataHook(
      sessionDataHook({ sessions: store, sync: engine, active, currentOwner: () => state.owner }),
    )
    await claimLocalData({ id: 'u2', email: 'x@y.z', created_at: '' })
    unregister()
    state.owner = 'u2'
    await engine.syncNow()
    expect(server.syncRequests).toEqual([])
    expect((await store.countUnsynced('u1')).sessions).toBe(1)

    // The same user again: it is uploaded.
    state.owner = 'u1'
    await engine.syncNow()
    expect(server.syncRequests).toHaveLength(1)
    expect((await store.countUnsynced('u1')).sessions).toBe(0)
  })
})
