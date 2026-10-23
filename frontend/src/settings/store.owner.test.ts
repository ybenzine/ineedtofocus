import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsError, type Settings, type SettingsApi, type SettingsPatch } from './api.ts'
import { DEFAULT_SETTINGS } from './api.ts'
import { SETTINGS_KEY, SettingsStore } from './store.ts'

afterEach(() => {
  localStorage.clear()
  vi.useRealTimers()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('one account never reaches the next', () => {
  it('ignores an in-flight PATCH that resolves after sign-out and sends nothing for the next user', async () => {
    let user: string | null = 'a'
    const first = deferred<Settings>()
    const calls: { as: string | null; patch: SettingsPatch }[] = []
    const api: SettingsApi = {
      get: vi.fn(async () => DEFAULT_SETTINGS),
      patch: vi.fn((patch: SettingsPatch) => {
        calls.push({ as: user, patch })
        return calls.length === 1
          ? first.promise
          : Promise.reject(new SettingsError('unauthorized', 'no'))
      }),
    }
    const storeA = new SettingsStore({
      api,
      storage: localStorage,
      owner: 'a',
      currentOwner: () => user,
    })
    storeA.update({ alert_volume: 10 }) // PATCH 1 in flight
    storeA.update({ week_start_day: 3 }) // queued behind it

    // Sign-out: the app unmounts (dispose) and the app's keys are removed.
    storeA.dispose()
    user = null
    localStorage.removeItem(SETTINGS_KEY)

    first.resolve({ ...DEFAULT_SETTINGS, alert_volume: 10 })
    await storeA.flush()
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull() // nothing written back

    // User B signs in on the same device.
    user = 'b'
    const storeB = new SettingsStore({
      api,
      storage: localStorage,
      owner: 'b',
      currentOwner: () => user,
    })
    expect(storeB.values).toEqual(DEFAULT_SETTINGS)
    expect(storeB.hasPending()).toBe(false)
    await storeB.refresh()
    expect(calls).toHaveLength(1) // only A's first PATCH, which was sent as A
    expect(calls[0].as).toBe('a')
  })

  it('stops by itself when the signed-in user changes, even without dispose', async () => {
    let user: string | null = 'a'
    const api: SettingsApi = { get: vi.fn(), patch: vi.fn(async () => DEFAULT_SETTINGS) }
    const store = new SettingsStore({
      api,
      storage: localStorage,
      owner: 'a',
      currentOwner: () => user,
    })
    user = null
    store.update({ alert_volume: 5 })
    await store.flush()
    expect(api.patch).not.toHaveBeenCalled()
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
  })

  it("never loads another user's cache", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ owner: 'a', values: { alert_volume: 5 }, pending: { week_start_day: 2 } }),
    )
    const store = new SettingsStore({ storage: localStorage, owner: 'b' })
    expect(store.values.alert_volume).toBe(80)
    expect(store.hasPending()).toBe(false)
    expect(new SettingsStore({ storage: localStorage, owner: 'a' }).values.alert_volume).toBe(5)
  })

  it('aborts the request in flight on dispose', () => {
    let signal: AbortSignal | undefined
    const api: SettingsApi = {
      get: vi.fn(),
      patch: vi.fn((_patch, s) => {
        signal = s
        return new Promise<Settings>(() => undefined)
      }),
    }
    const store = new SettingsStore({ api })
    store.update({ alert_volume: 1 })
    store.dispose()
    expect(signal?.aborted).toBe(true)
  })
})

describe('sync details', () => {
  it('a stale GET cannot undo a newer accepted edit', async () => {
    const get = deferred<Settings>()
    const api: SettingsApi = {
      get: vi.fn(() => get.promise),
      patch: vi.fn(async (patch: SettingsPatch) => ({ ...DEFAULT_SETTINGS, ...patch })),
    }
    const store = new SettingsStore({ api })
    const refreshing = store.refresh()
    await vi.waitFor(() => expect(api.get).toHaveBeenCalled())
    store.update({ alert_volume: 20 })
    await store.flush()
    get.resolve(DEFAULT_SETTINGS) // answers with the old volume, 80
    await refreshing
    expect(store.values.alert_volume).toBe(20)
  })

  it('retries a server error with backoff while online', async () => {
    vi.useFakeTimers()
    let failures = 2
    const api: SettingsApi = {
      get: vi.fn(),
      patch: vi.fn(async (patch: SettingsPatch) => {
        if (failures-- > 0) throw new SettingsError('server', 'boom')
        return { ...DEFAULT_SETTINGS, ...patch }
      }),
    }
    const store = new SettingsStore({ api, retryBaseMs: 1000 })
    store.update({ alert_volume: 20 })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().stalled).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.patch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.patch).toHaveBeenCalledTimes(3)
    expect(store.hasPending()).toBe(false)
    expect(store.getState().stalled).toBe(false)
  })

  it('reports an expired sign-in on 401 and keeps the edit', async () => {
    const onUnauthorized = vi.fn()
    const api: SettingsApi = {
      get: vi.fn(),
      patch: vi.fn(async () => {
        throw new SettingsError('unauthorized', 'no')
      }),
    }
    const store = new SettingsStore({ api, onUnauthorized })
    store.update({ alert_volume: 20 })
    await store.flush()
    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(store.hasPending()).toBe(true)
  })

  it('on 422 drops only the rejected field and still sends the rest', async () => {
    const patches: SettingsPatch[] = []
    const api: SettingsApi = {
      get: vi.fn(),
      patch: vi.fn(async (patch: SettingsPatch) => {
        patches.push(patch)
        if ('alert_volume' in patch) {
          throw new SettingsError('invalid', 'bad', ['alert_volume'])
        }
        return { ...DEFAULT_SETTINGS, ...patch }
      }),
    }
    const store = new SettingsStore({ api })
    // Offline batch with one bad value.
    store.update({ alert_volume: 20, week_start_day: 2 })
    await store.flush()
    expect(patches).toEqual([{ alert_volume: 20, week_start_day: 2 }, { week_start_day: 2 }])
    expect(store.hasPending()).toBe(false)
    expect(store.values.week_start_day).toBe(2)
  })
})
