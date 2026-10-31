import { describe, expect, it, vi } from 'vitest'
import { createAppServices } from '../services.ts'
import type { IndexedDbSessionStore } from '../sync/index.ts'
import { finishSession, startSession, type SessionRecord } from './engine.ts'
import { MemoryActiveSessionStore, TimerController, type StoredTimer } from './index.ts'

const CONFIG = { mode: 'countdown', minutes: 25 } as const

function finished(id: string): StoredTimer {
  const session = startSession({ id, config: CONFIG, tag: 'work', goal: id }, 0)
  const outcome = finishSession(session, 120_000, 'completed')
  if (outcome.kind !== 'saved') throw new Error('expected a saved session')
  return { session, pendingRecord: outcome.record }
}

describe('TimerController.adopt', () => {
  it('hands the record over unchanged', async () => {
    const saved: SessionRecord[] = []
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: (record) => void saved.push(record),
    })
    const state = finished('anon')
    const update = await controller.adopt(state)
    expect(update.recordPending).toBe(false)
    expect(saved).toEqual([state.pendingRecord])
  })

  it('never drops an account record held only in memory (#286, F13)', async () => {
    // The device store refuses every write, and saving fails until `up`.
    let up = false
    const saved: string[] = []
    const inner = new MemoryActiveSessionStore()
    const controller = new TimerController({
      store: {
        load: () => inner.load(),
        clear: () => inner.clear(),
        save() {
          throw new Error('QuotaExceededError')
        },
      },
      saveRecord: (record) => {
        if (!up) return Promise.reject(new Error('IndexedDB down'))
        saved.push(record.id)
        return Promise.resolve()
      },
    })
    // alice-1 ends and is held only in memory.
    const first = finished('alice-1')
    expect((await controller.adopt(first)).recordPending).toBe(true)
    expect(controller.holdsRecord()).toBe(true)

    // The anonymous record arrives while alice-1 is still held: it queues behind it.
    const second = await controller.adopt(finished('anon-1'))
    expect(second.recordPending).toBe(true)
    expect(saved).toEqual([])

    up = true
    expect(await controller.retryPending()).toBe(true)
    expect(saved.sort()).toEqual(['alice-1', 'anon-1'])
    expect(controller.holdsRecord()).toBe(false)
  })

  it('start waits for queued records', async () => {
    const controller = new TimerController({
      store: {
        load: () => null,
        clear: () => undefined,
        save() {
          throw new Error('full')
        },
      },
      saveRecord: () => Promise.reject(new Error('down')),
    })
    await controller.adopt(finished('a'))
    await controller.adopt(finished('b'))
    await expect(controller.start({ config: CONFIG, tag: 'work', goal: null })).rejects.toThrow(
      /still being saved/,
    )
  })
})

describe('adopted records keep their owner (AC1.3, #331)', () => {
  it('a record held or queued across an expiry and a different sign-in is saved under its own owner', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    let owner = 'alice'
    let up = false
    const services = createAppServices(() => owner, {
      // The device refuses every write of the timer's own store.
      activeStore: {
        load: () => null,
        clear: () => undefined,
        save() {
          throw new Error('QuotaExceededError')
        },
      },
    })
    const sessions = services.sessions as IndexedDbSessionStore
    const save = sessions.save.bind(sessions)
    vi.spyOn(sessions, 'save').mockImplementation((record, ownerId) =>
      up ? save(record, ownerId) : Promise.reject(new Error('IndexedDB down')),
    )
    const { controller } = services

    // Alice's record is held in memory; Bob's prompt record queues behind it.
    await controller.adopt(finished('alice-1'))
    owner = 'bob'
    await controller.adopt(finished('bob-anon-1'))
    // Bob's sign-in expires and Carol signs in.
    owner = 'carol'
    up = true
    expect(await controller.retryPending()).toBe(true)

    const ids = async (who: string) => (await sessions.list(who)).map((s) => s.record.id)
    expect(await ids('alice')).toEqual(['alice-1'])
    expect(await ids('bob')).toEqual(['bob-anon-1'])
    expect(await ids('carol')).toEqual([])
    for (const who of ['alice', 'bob', 'carol']) await sessions.clearOwner(who)
    sessions.close()
    vi.unstubAllGlobals()
  })
})
