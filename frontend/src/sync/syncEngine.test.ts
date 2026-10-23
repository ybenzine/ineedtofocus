import { afterEach, describe, expect, it } from 'vitest'
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
    expect(server.get(record.id)?.goal).toBe('Kept')
    const stored = await store.get(record.id)
    expect(stored).toMatchObject({ edit: null, editState: null })
    expect(stored?.record.goal).toBe('Kept')
    await engine.syncNow()
    expect(server.editRequests).toHaveLength(1)
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
    expect((await engine.syncNow()).outcome).toBe('unauthorized')
    expect(server.syncRequests).toEqual([])
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
