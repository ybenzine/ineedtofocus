import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import { HttpSessionsApi } from './api.ts'
import { deviceSaver } from './saveRecord.ts'
import { IndexedDbSessionStore } from './sessionStore.ts'
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  SyncEngine,
  backoffDelay,
  type Scheduler,
} from './syncEngine.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'

/** Collects scheduled retries instead of waiting for them. */
class ManualScheduler implements Scheduler {
  readonly pending = new Map<number, { run: () => void; delayMs: number }>()
  #next = 0

  schedule(run: () => void, delayMs: number): unknown {
    this.#next += 1
    this.pending.set(this.#next, { run, delayMs })
    return this.#next
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number)
  }

  get delays(): number[] {
    return [...this.pending.values()].map((p) => p.delayMs)
  }

  /** Fires every scheduled retry. */
  fire(): void {
    const due = [...this.pending.values()]
    this.pending.clear()
    for (const { run } of due) run()
  }
}

const stores: IndexedDbSessionStore[] = []
const stops: (() => void)[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const stop of stops.splice(0)) stop()
  for (const store of stores.splice(0)) store.close()
})

function setup(options: { owner?: string | null } = {}) {
  const server = new FakeSessionsServer()
  const store = new IndexedDbSessionStore({ name: freshDbName() })
  stores.push(store)
  const scheduler = new ManualScheduler()
  const state = { online: true, owner: options.owner === undefined ? ALICE : options.owner }
  const engine = new SyncEngine({
    store,
    api: new HttpSessionsApi({ fetch: server.fetch }),
    currentOwner: () => state.owner,
    scheduler,
    isOnline: () => state.online,
    random: () => 0.999,
    exclusive: (run) => run(),
  })
  return { server, store, scheduler, state, engine }
}

function start(engine: SyncEngine) {
  const stop = engine.start()
  stops.push(stop)
  return stop
}

/** Lets the event-driven pass started by `start()` or an event finish. */
async function settle(engine: SyncEngine) {
  await engine.syncNow()
}

describe('SyncEngine', () => {
  it('ac13_3 a session finished offline reaches the server exactly once when back online', async () => {
    const { server, store, state, engine } = setup()
    state.online = false
    let now = Date.UTC(2026, 9, 23, 9, 0)
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: deviceSaver({
        store,
        ownerOf: () => ALICE,
        afterSave: () => void engine.syncNow(),
      }),
      now: () => now,
    })
    start(engine)
    await controller.start({
      config: { mode: 'countdown', minutes: 5 },
      tag: 'read',
      goal: 'Ch. 3',
    })
    now += 5 * 60_000
    const update = await controller.tick()
    expect(update.outcome?.kind).toBe('saved')
    expect(update.recordPending).toBe(false)
    const id = update.outcome?.kind === 'saved' ? update.outcome.record.id : ''

    // AC13.2: on the device, nothing sent while offline.
    expect((await store.get(id))?.syncState).toBe('pending')
    expect(server.syncRequests).toEqual([])

    state.online = true
    window.dispatchEvent(new Event('online'))
    await settle(engine)
    window.dispatchEvent(new Event('online'))
    await settle(engine)

    expect(server.sessions.size).toBe(1)
    expect(server.get(id)).toMatchObject({ id, tag: 'read', goal: 'Ch. 3', focus_seconds: 300 })
    expect(server.syncRequests).toEqual([[id]])
    expect((await store.get(id))?.syncState).toBe('synced')
  })

  it('ac13_4 a retry after a lost reply doesn’t duplicate the session', async () => {
    const { server, store, scheduler, engine } = setup()
    start(engine)
    await settle(engine)
    const record = makeRecord()
    await store.save(record, ALICE)
    server.mode = 'lose-reply'
    expect((await engine.syncNow()).outcome).toBe('unavailable')
    expect(server.sessions.size).toBe(1) // saved, but the device didn't hear back
    expect((await store.get(record.id))?.syncState).toBe('pending')

    scheduler.fire()
    await settle(engine)
    expect(server.syncRequests).toEqual([[record.id], [record.id]])
    expect(server.sessions.size).toBe(1)
    expect((await store.get(record.id))?.syncState).toBe('synced')
  })

  it('ac13_5 network and server errors keep every session and retry with growing backoff', async () => {
    const { server, store, scheduler, engine } = setup()
    start(engine)
    await settle(engine)
    const records = [makeRecord(), makeRecord()]
    for (const r of records) await store.save(r, ALICE)

    server.mode = 'offline'
    expect((await engine.syncNow()).outcome).toBe('unavailable')
    expect(scheduler.delays).toEqual([backoffDelay(1, () => 0.999)])
    server.mode = 'down'
    scheduler.fire()
    await settle(engine)
    expect(engine.failures).toBeGreaterThanOrEqual(2)
    expect(scheduler.delays[0]).toBeGreaterThan(backoffDelay(1, () => 0.999))
    expect(await store.countUnsynced(ALICE)).toEqual({ sessions: 2, edits: 0 })
    expect(server.sessions.size).toBe(0)

    server.mode = 'up'
    scheduler.fire()
    await settle(engine)
    expect(server.sessions.size).toBe(2)
    expect(engine.failures).toBe(0)
    expect(scheduler.pending.size).toBe(0)
  })

  it('backoff doubles from 2 s and stops growing at 5 minutes', () => {
    const top = () => 0.999999
    expect(backoffDelay(1, top)).toBeCloseTo(BACKOFF_BASE_MS, -1)
    expect(backoffDelay(2, top)).toBeCloseTo(2 * BACKOFF_BASE_MS, -1)
    expect(backoffDelay(30, top)).toBeCloseTo(BACKOFF_MAX_MS, -2)
    expect(backoffDelay(3, () => 0)).toBe(2 * BACKOFF_BASE_MS)
  })

  it('a 401 keeps everything and waits for the next trigger instead of retrying', async () => {
    const { server, store, scheduler, engine } = setup()
    start(engine)
    await settle(engine)
    const record = makeRecord()
    await store.save(record, ALICE)
    server.mode = 'signed-out'
    expect((await engine.syncNow()).outcome).toBe('unauthorized')
    expect(scheduler.pending.size).toBe(0)
    expect((await store.get(record.id))?.syncState).toBe('pending')

    server.mode = 'up'
    document.dispatchEvent(new Event('visibilitychange'))
    await settle(engine)
    expect((await store.get(record.id))?.syncState).toBe('synced')
  })

  it('a partial-failure batch saves the valid sessions; the rejected one is kept, not retried, and blocks nothing', async () => {
    const { server, store, engine } = setup()
    const good = makeRecord()
    const bad = makeRecord({ focusSeconds: 30 })
    const foreign = makeRecord()
    server.otherAccount.add(foreign.id)
    for (const r of [good, bad, foreign]) await store.save(r, ALICE)

    const report = await engine.syncNow()
    expect(report).toMatchObject({ outcome: 'done', synced: 1, rejected: 2 })
    expect((await store.get(good.id))?.syncState).toBe('synced')
    expect((await store.get(bad.id))?.syncState).toBe('rejected')
    expect((await store.get(foreign.id))?.rejection?.code).toBe('conflict')
    const indicators = new Map((await store.list(ALICE)).map((s) => [s.record.id, s.indicator]))
    expect(indicators.get(bad.id)).toBe('couldnt-sync')

    const later = makeRecord()
    await store.save(later, ALICE)
    await engine.syncNow()
    expect(server.syncRequests.at(-1)).toEqual([later.id])
    expect((await store.get(later.id))?.syncState).toBe('synced')
    expect((await store.get(bad.id))?.syncState).toBe('rejected')
  })

  it('sends at most 100 sessions per request', async () => {
    const { server, store, engine } = setup()
    for (let i = 0; i < 230; i++) await store.save(makeRecord(), ALICE)
    await engine.syncNow()
    expect(server.syncRequests.map((ids) => ids.length)).toEqual([100, 100, 30])
    expect(server.sessions.size).toBe(230)
  })

  it('ac11_4 an offline edit to a saved session goes as PATCH, never as a re-save', async () => {
    const { server, store, state, engine } = setup()
    const record = makeRecord({ goal: 'Old' })
    await store.save(record, ALICE)
    await engine.syncNow()
    state.online = false
    await store.edit(ALICE, record.id, { goal: 'New', tag: 'study' })
    expect((await engine.syncNow()).outcome).toBe('offline')

    state.online = true
    const report = await engine.syncNow()
    expect(report.edited).toBe(1)
    expect(server.syncRequests).toEqual([[record.id]])
    expect(server.editRequests).toEqual([{ id: record.id, body: { goal: 'New', tag: 'study' } }])
    expect(server.get(record.id)).toMatchObject({ goal: 'New', tag: 'study' })
    const stored = await store.get(record.id)
    expect(stored).toMatchObject({ edit: null, editState: null })
    expect(stored?.record).toMatchObject({ goal: 'New', tag: 'study' })
  })

  it('an edit made before the session synced waits for it, then goes as PATCH', async () => {
    const { server, store, engine } = setup()
    const record = makeRecord({ goal: 'Old' })
    await store.save(record, ALICE)
    await store.edit(ALICE, record.id, { goal: 'New' })
    await engine.syncNow()
    expect(server.syncRequests).toEqual([[record.id]])
    expect(server.editRequests.map((e) => e.body)).toEqual([{ goal: 'New' }])
    expect(server.get(record.id)?.goal).toBe('New')
  })

  it('ac11_4 an edit to a session archived elsewhere (409) is dropped without touching the session', async () => {
    const { server, store, engine } = setup()
    const record = makeRecord({ goal: 'Kept' })
    await store.save(record, ALICE)
    await engine.syncNow()
    server.archive(record.id)
    await store.edit(ALICE, record.id, { goal: 'Lost' })
    const report = await engine.syncNow()
    expect(report.outcome).toBe('done')
    expect(report.dropped).toEqual([record.id])
    expect(server.get(record.id)?.goal).toBe('Kept')
    const stored = await store.get(record.id)
    expect(stored).toMatchObject({ edit: null, editState: null })
    expect(stored?.record.goal).toBe('Kept')
    await engine.syncNow()
    expect(server.editRequests).toHaveLength(1)
  })

  it('reports a dropped edit from every pass of one syncNow loop, not just the last', async () => {
    const { server, store, engine } = setup()
    const record = makeRecord()
    await store.save(record, ALICE)
    await engine.syncNow()
    server.archive(record.id)
    await store.edit(ALICE, record.id, { goal: 'Lost' })
    // The second call runs a second pass after the first, which has nothing left to drop.
    const [first, second] = await Promise.all([engine.syncNow(), engine.syncNow()])
    expect(server.editRequests).toHaveLength(1)
    expect(first.dropped).toEqual([record.id])
    expect(second.dropped).toEqual([record.id])
  })

  it('#133 a 409 also marks the device copy archived, so offline History stops showing it', async () => {
    const { server, store, engine } = setup()
    const record = makeRecord()
    await store.save(record, ALICE)
    await engine.syncNow()
    server.archive(record.id)
    await store.edit(ALICE, record.id, { goal: 'Lost' })
    await engine.syncNow()
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()
  })

  it('lists a session once in dropped even when two passes both got a 409, and gives each caller its own copy', async () => {
    const server = new FakeSessionsServer()
    const store = new IndexedDbSessionStore({ name: freshDbName() })
    stores.push(store)
    const real = new HttpSessionsApi({ fetch: server.fetch })
    const record = makeRecord()
    let edits = 0
    const api = {
      sync: real.sync.bind(real),
      edit: async (id: string, change: Parameters<typeof real.edit>[1]) => {
        edits += 1
        // A new edit lands while the first is in flight, so the second pass sends (and drops) it too.
        if (edits === 1) await store.edit(ALICE, record.id, { goal: 'Again' })
        return real.edit(id, change)
      },
    }
    const engine = new SyncEngine({
      store,
      api,
      currentOwner: () => ALICE,
      scheduler: new ManualScheduler(),
      isOnline: () => true,
      exclusive: (run) => run(),
    })
    await store.save(record, ALICE)
    await engine.syncNow()
    server.archive(record.id)
    await store.edit(ALICE, record.id, { goal: 'Lost' })

    const [first, second] = await Promise.all([engine.syncNow(), engine.syncNow()])

    expect(edits).toBe(2)
    expect(first.dropped).toEqual([record.id])
    expect(second.dropped).toEqual([record.id])
    first.dropped.push('mutated')
    expect(second.dropped).toEqual([record.id])
  })

  it('reports no dropped edit when the edit was applied or nothing was queued', async () => {
    const { store, engine } = setup()
    const record = makeRecord()
    await store.save(record, ALICE)
    expect((await engine.syncNow()).dropped).toEqual([])
    await store.edit(ALICE, record.id, { goal: 'Ok' })
    const report = await engine.syncNow()
    expect(report).toMatchObject({ edited: 1, dropped: [] })
  })

  it('an edit the server refuses (422) is kept as couldn’t sync and not retried', async () => {
    const { server, store, engine } = setup()
    const record = makeRecord()
    await store.save(record, ALICE)
    await engine.syncNow()
    await store.edit(ALICE, record.id, { goal: 'x'.repeat(121) })
    await engine.syncNow()
    await engine.syncNow()
    expect(server.editRequests).toHaveLength(1)
    const [shown] = await store.list(ALICE)
    expect(shown.indicator).toBe('couldnt-sync')
    expect(await store.countUnsynced(ALICE)).toEqual({ sessions: 0, edits: 1 })
  })

  it('a save during a running pass is sent right after it', async () => {
    const { server, store, engine } = setup()
    const first = makeRecord()
    await store.save(first, ALICE)
    const running = engine.syncNow()
    const second = makeRecord()
    await store.save(second, ALICE)
    const queued = engine.syncNow()
    await Promise.all([running, queued])
    expect(server.sessions.size).toBe(2)
  })

  it('sends only the signed-in user’s sessions; another account’s stay quarantined', async () => {
    const { server, store, state, engine } = setup()
    const alices = makeRecord()
    const bobs = makeRecord()
    const nobodys = makeRecord()
    await store.save(alices, ALICE)
    await store.save(bobs, BOB)
    await store.save(nobodys, null)
    await engine.syncNow()
    expect([...server.sessions.keys()]).toEqual([alices.id])

    state.owner = BOB
    await engine.syncNow()
    expect([...server.sessions.keys()].sort()).toEqual([alices.id, bobs.id].sort())
    expect((await store.get(nobodys.id))?.syncState).toBe('pending')

    state.owner = null
    expect((await engine.syncNow()).synced).toBe(0)
    expect(server.syncRequests).toHaveLength(2)
  })

  it('stops before sending if the user changed during the pass', async () => {
    const { server, store, state, engine } = setup()
    await store.save(makeRecord(), ALICE)
    const original = store.uploadQueue.bind(store)
    store.uploadQueue = async (owner, limit) => {
      const batch = await original(owner, limit)
      state.owner = BOB // someone else signed in while the device was reading its queue
      return batch
    }
    expect((await engine.syncNow()).outcome).toBe('owner-changed')
    expect(server.syncRequests).toEqual([])
  })

  it('a stalled device store fails the pass in time, releasing the cross-tab lock', async () => {
    const { server, store } = setup()
    await store.save(makeRecord(), ALICE)
    let held = 0
    let stall = true
    const engine = new SyncEngine({
      store: {
        uploadQueue: (owner: string, limit: number) =>
          stall ? new Promise<never>(() => undefined) : store.uploadQueue(owner, limit),
        markSynced: (id: string, s: Parameters<typeof store.markSynced>[1]) =>
          store.markSynced(id, s),
        markRejected: (id: string, e: Parameters<typeof store.markRejected>[1]) =>
          store.markRejected(id, e),
        editQueue: (owner: string) => store.editQueue(owner),
      } as unknown as IndexedDbSessionStore,
      api: new HttpSessionsApi({ fetch: server.fetch }),
      currentOwner: () => ALICE,
      isOnline: () => true,
      storeTimeoutMs: 20,
      exclusive: async (run) => {
        held += 1
        try {
          return await run()
        } finally {
          held -= 1
        }
      },
    })
    // The time limit runs on a fake clock, so only the test decides when it expires: a real 20 ms
    // limit also cut off the healthy second pass when the machine was busy.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const stalled = engine.syncNow()
      await vi.advanceTimersByTimeAsync(20)
      expect((await stalled).outcome).toBe('unavailable')
      expect(held).toBe(0)
      stall = false
      expect((await engine.syncNow()).synced).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a 401 to the accounts UI, but not a change of user', async () => {
    const { server, store, state } = setup()
    const expired: string[] = []
    const engine = new SyncEngine({
      store,
      api: new HttpSessionsApi({ fetch: server.fetch }),
      currentOwner: () => state.owner,
      isOnline: () => true,
      exclusive: (run) => run(),
      onUnauthorized: () => expired.push('401'),
    })
    await store.save(makeRecord(), ALICE)
    server.mode = 'signed-out'
    await engine.syncNow()
    expect(expired).toEqual(['401'])
    expect(await store.countUnsynced(ALICE)).toEqual({ sessions: 1, edits: 0 })
  })

  it('trySync syncs before sign-out, skips the wait offline and gives up after the time limit', async () => {
    const { server, store, state, engine } = setup()
    await store.save(makeRecord(), ALICE)
    await engine.trySync(1_000)
    expect(server.sessions.size).toBe(1)

    state.online = false
    await store.save(makeRecord(), ALICE)
    await engine.trySync(1_000)
    expect(server.syncRequests).toHaveLength(1)

    state.online = true
    const stalled = new Promise<Response>(() => undefined)
    const slow = new SyncEngine({
      store,
      api: new HttpSessionsApi({ fetch: () => stalled }),
      currentOwner: () => ALICE,
      isOnline: () => true,
      exclusive: (run) => run(),
    })
    const started = Date.now()
    await slow.trySync(50)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('a stopped engine leaves no retry behind', async () => {
    const { server, store, scheduler, engine } = setup()
    const stop = start(engine)
    await settle(engine)
    await store.save(makeRecord(), ALICE)
    server.mode = 'down'
    await engine.syncNow()
    expect(scheduler.pending.size).toBe(1)
    stop()
    expect(scheduler.pending.size).toBe(0)
  })
})

describe('onChange (#264)', () => {
  it('calls the listener once per run that changed something, not for an idle run', async () => {
    const { store, engine } = setup()
    const reports: number[] = []
    const stop = engine.onChange((report) => reports.push(report.synced))
    await engine.syncNow() // nothing to send
    expect(reports).toEqual([])
    await store.save(makeRecord(), ALICE)
    await engine.syncNow()
    expect(reports).toEqual([1])
    stop()
    await store.save(makeRecord(), ALICE)
    await engine.syncNow()
    expect(reports).toEqual([1])
  })

  it('notifies once when a second caller joins and the last pass finds nothing', async () => {
    const { store, engine } = setup()
    const calls: number[] = []
    engine.onChange(() => calls.push(1))
    await store.save(makeRecord(), ALICE)
    const [first] = await Promise.all([engine.syncNow(), engine.syncNow()])
    expect(first.synced).toBe(0) // the loop's last pass was idle
    expect((await store.list(ALICE))[0].syncState).toBe('synced')
    expect(calls).toEqual([1])
  })

  it('counts a refused edit as a change', async () => {
    const { store, engine } = setup()
    const record = makeRecord()
    await store.save(record, ALICE)
    await store.markSynced(record.id, { id: record.id, tag: 'work', goal: null, archivedAt: null })
    await store.edit(ALICE, record.id, { goal: 'x' }) // the server has no such session: 404
    const calls: number[] = []
    engine.onChange(() => calls.push(1))
    await engine.syncNow()
    expect((await store.get(record.id))?.editState).toBe('rejected')
    expect(calls).toEqual([1])
  })

  it('a throwing listener does not break the sync or the other listeners', async () => {
    const { store, engine } = setup()
    const seen: string[] = []
    engine.onChange(() => {
      throw new Error('boom')
    })
    engine.onChange(() => seen.push('ok'))
    await store.save(makeRecord(), ALICE)
    const report = await engine.syncNow()
    expect(report.synced).toBe(1)
    expect(seen).toEqual(['ok'])
  })
})
