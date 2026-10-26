import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SettingsError,
  type Settings,
  type SettingsApi,
  type SettingsPatch,
} from './api.ts'
import { SETTINGS_KEY, SETTINGS_LOCK, SettingsStore } from './store.ts'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fakeServer() {
  const server = { value: { ...DEFAULT_SETTINGS } as Settings, online: true }
  const patches: SettingsPatch[] = []
  const api: SettingsApi = {
    get: vi.fn(async () => {
      if (!server.online) throw new SettingsError('network', 'offline')
      return server.value
    }),
    patch: vi.fn(async (patch: SettingsPatch) => {
      if (!server.online) throw new SettingsError('network', 'offline')
      patches.push(patch)
      server.value = { ...server.value, ...patch }
      return server.value
    }),
  }
  return { server, patches, api }
}

function stored() {
  return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as {
    owner: string | null
    values: Settings
    pending: SettingsPatch
  }
}

/**
 * Web Locks as browsers have them: granted on a later task, one holder at a time. Returns the
 * names requested.
 */
function deferredLocks(): string[] {
  const names: string[] = []
  let chain: Promise<unknown> = Promise.resolve()
  vi.stubGlobal('navigator', {
    ...navigator,
    onLine: true,
    locks: {
      request: (name: string, run: () => Promise<unknown>) => {
        names.push(name)
        const result = chain.then(() => new Promise((r) => setTimeout(r, 0))).then(run)
        chain = result.catch(() => undefined)
        return result
      },
    },
  })
  return names
}

/** A tab: its own store over the shared localStorage and the shared server. */
function openTab(api: SettingsApi) {
  return new SettingsStore({ api, storage: localStorage, owner: 'u1', retryBaseMs: 3_600_000 })
}

describe("two tabs never drop each other's pending edits (#129)", () => {
  it("keeps tab A's offline week start when tab B changes the background volume, and sends both", async () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api) // opened before A's edit: its own copy knows nothing of it
    server.online = false
    a.update({ week_start_day: 3 })
    await a.flush()
    expect(stored().pending).toEqual({ week_start_day: 3 })
    a.dispose() // tab A is closed before the connection returns

    server.online = true
    b.update({ background_volume: 70 })
    await b.flush()

    expect(server.value.week_start_day).toBe(3)
    expect(server.value.background_volume).toBe(70)
    expect(b.values.week_start_day).toBe(3)
    expect(b.hasPending()).toBe(false)
    expect(stored().pending).toEqual({})
  })

  it('merges when tab B is offline too, and the next online refresh sends both', async () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    a.update({ week_start_day: 3 })
    b.update({ background_volume: 70 })
    a.dispose()
    expect(stored().pending).toEqual({ week_start_day: 3, background_volume: 70 })

    server.online = true
    await b.refresh()
    expect(server.value).toMatchObject({ week_start_day: 3, background_volume: 70 })
  })

  it('includes the theme in the merge', async () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    a.update({ theme: 'light' })
    b.update({ alert_volume: 10 })
    await b.flush() // the send fails: offline
    expect(stored().pending).toEqual({ theme: 'light', alert_volume: 10 })
    server.online = true
    await b.flush()
    expect(server.value).toMatchObject({ theme: 'light', alert_volume: 10 })
  })

  it('lets the later edit win when both tabs edit the same field', async () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    a.update({ week_start_day: 3 })
    await a.flush()
    b.update({ week_start_day: 5 })
    await b.flush()
    expect(stored().pending).toEqual({ week_start_day: 5 })
    // Tab A still holds its older value until it looks at the cache again; it must not send it.
    server.online = true
    await a.flush()
    expect(server.value.week_start_day).toBe(5)
    expect(a.values.week_start_day).toBe(5)
  })

  it('keeps a field another tab changed while a send was in flight', async () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    vi.mocked(api.patch).mockImplementationOnce(async (patch) => {
      await gate
      server.value = { ...server.value, ...patch }
      return server.value
    })
    a.update({ alert_volume: 20 }) // in flight
    server.online = false
    b.update({ alert_volume: 30 }) // later edit, other tab, kept pending
    await b.flush()
    server.online = true
    release()
    await a.flush()
    // The reply to 20 did not clear the later 30: it was sent next.
    expect(server.value.alert_volume).toBe(30)
    expect(stored().pending).toEqual({})
  })

  it('merges an accepted send under a Web Lock where there is one', async () => {
    const held = deferredLocks()
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    a.update({ week_start_day: 3 })
    await a.flush()
    expect(stored().pending).toEqual({ week_start_day: 3 })
    b.update({ background_volume: 70 })
    await b.flush() // the send fails: offline
    expect(stored().pending).toEqual({ week_start_day: 3, background_volume: 70 })
    server.online = true
    await b.flush()
    expect(server.value).toMatchObject({ week_start_day: 3, background_volume: 70 })
    expect(held).toContain(SETTINGS_LOCK) // the accepted send is applied under the lock
  })

  it('sends the merged cache, not its own older copy, when the lock grants later', async () => {
    deferredLocks()
    const { server, api, patches } = fakeServer()
    const a = openTab(api)
    server.online = false
    a.update({ week_start_day: 3 })
    await a.flush()
    const b = openTab(api) // starts with week start 3 pending, and misses every later change
    expect(b.countUnsynced()).toBe(1)
    server.online = true
    await a.flush()
    a.update({ week_start_day: 5 })
    await a.flush()
    expect(server.value.week_start_day).toBe(5)

    b.update({ background_volume: 70 })
    await b.flush()

    expect(patches.at(-1)).toEqual({ background_volume: 70 })
    expect(server.value).toMatchObject({ week_start_day: 5, background_volume: 70 })
    expect(b.values.week_start_day).toBe(5)
  })

  it('has the edit in the cache the moment update() returns, even when the lock grants later (#279)', async () => {
    deferredLocks()
    const { api } = fakeServer()
    const a = openTab(api)
    a.update({ theme: 'dark' })
    // Read synchronously: a reload right now must still find the theme (theme-init.js reads it).
    expect(stored().values.theme).toBe('dark')
    expect(stored().pending).toEqual({ theme: 'dark' })
    await a.flush() // let the send finish before the cache is cleared
  })

  it("keeps another tab's pending edit and the later edit per field with the synchronous write (#279)", async () => {
    deferredLocks()
    const { server, api } = fakeServer()
    server.online = false
    const a = openTab(api)
    const b = openTab(api)
    a.update({ week_start_day: 3 })
    b.update({ background_volume: 70 }) // b never saw a's edit
    expect(stored().pending).toEqual({ week_start_day: 3, background_volume: 70 })
    b.update({ week_start_day: 5 })
    expect(stored().pending).toEqual({ week_start_day: 5, background_volume: 70 })
    await Promise.all([a.flush(), b.flush()]) // the sends fail: offline
    server.online = true
    await a.flush()
    expect(server.value).toMatchObject({ week_start_day: 5, background_volume: 70 })
  })

  it('still merges, and keeps counting, when the lock request is refused', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      onLine: true,
      locks: { request: () => Promise.reject(new DOMException('no', 'SecurityError')) },
    })
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    b.update({ alert_volume: 10 })
    await b.flush()
    a.update({ week_start_day: 3 })
    await a.flush()
    expect(stored().pending).toEqual({ alert_volume: 10, week_start_day: 3 })
    // Not stuck "writing": this tab still sees the other tab's edit.
    expect(b.countUnsynced()).toBe(2)
  })

  it("does not adopt another user's cache or break the owner binding", () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        owner: 'someone-else',
        values: DEFAULT_SETTINGS,
        pending: { alert_volume: 1 },
      }),
    )
    const { api } = fakeServer()
    const store = openTab(api)
    expect(store.countUnsynced()).toBe(0)
    store.update({ week_start_day: 2 })
    expect(stored().owner).toBe('u1')
    expect(stored().pending).toEqual({ week_start_day: 2 })
  })
})

describe('countUnsynced and trySync', () => {
  it("counts pending fields, other tabs' included", () => {
    const { server, api } = fakeServer()
    const a = openTab(api)
    const b = openTab(api)
    server.online = false
    a.update({ week_start_day: 3 })
    expect(b.countUnsynced()).toBe(1)
  })

  it('sends pending edits and stops waiting after the limit', async () => {
    vi.useFakeTimers()
    try {
      const { api } = fakeServer()
      vi.mocked(api.patch).mockImplementation(() => new Promise(() => undefined))
      const store = openTab(api)
      store.update({ week_start_day: 3 })
      let done = false
      void store.trySync(10_000).then(() => (done = true))
      await vi.advanceTimersByTimeAsync(9_999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(done).toBe(true)
      expect(store.countUnsynced()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing offline', async () => {
    const { api } = fakeServer()
    const store = openTab(api)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    store.update({ week_start_day: 3 })
    vi.mocked(api.patch).mockClear()
    await store.trySync()
    expect(api.patch).not.toHaveBeenCalled()
  })
})

describe("an edit survives a parallel tab's locked merge (#279)", () => {
  /** Tab B's storage view: once armed, A's `update()` lands between B's read and B's write. */
  function racingStorage(onRead: () => void) {
    const state = { armed: false }
    const view = {
      getItem: (k: string) => {
        const v = localStorage.getItem(k)
        if (state.armed && k === SETTINGS_KEY) {
          state.armed = false
          onRead()
        }
        return v
      },
      setItem: (k: string, v: string) => localStorage.setItem(k, v),
      removeItem: (k: string) => localStorage.removeItem(k),
    } as unknown as Storage
    return { state, view }
  }
  const settle = () => new Promise((r) => setTimeout(r, 30))

  it("keeps A's edit in the cache when B's accepted send overwrites it", async () => {
    deferredLocks()
    const { server, api } = fakeServer()
    const a = new SettingsStore({
      api: { ...api, patch: vi.fn(() => new Promise<Settings>(() => undefined)) },
      storage: localStorage,
      owner: 'u1',
      retryBaseMs: 3_600_000,
    })
    const race = racingStorage(() => a.update({ week_start_day: 5 }))
    const b = new SettingsStore({
      api: {
        ...api,
        patch: vi.fn(async (p: SettingsPatch) => {
          const r = await api.patch(p)
          race.state.armed = true
          return r
        }),
      },
      storage: race.view,
      owner: 'u1',
      retryBaseMs: 3_600_000,
    })
    b.update({ background_volume: 70 })
    await b.flush()
    await settle()
    expect(stored().pending).toHaveProperty('week_start_day', 5)
    expect(stored().values.week_start_day).toBe(5)
    expect(server.value.background_volume).toBe(70)
  })

  it("sends A's edit when A has a send in flight and B overwrites the edit", async () => {
    deferredLocks()
    const { server, api } = fakeServer()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const aPatch = vi.fn(async (p: SettingsPatch) => {
      if (aPatch.mock.calls.length === 1) await gate
      return api.patch(p)
    })
    const a = new SettingsStore({
      api: { get: api.get, patch: aPatch },
      storage: localStorage,
      owner: 'u1',
      retryBaseMs: 3_600_000,
    })
    a.update({ alert_volume: 20 }) // A's send is in flight
    await settle()
    const race = racingStorage(() => a.update({ week_start_day: 5 }))
    const b = new SettingsStore({
      api: {
        ...api,
        patch: vi.fn(async (p: SettingsPatch) => {
          const r = await api.patch(p)
          race.state.armed = true
          return r
        }),
      },
      storage: race.view,
      owner: 'u1',
      retryBaseMs: 3_600_000,
    })
    b.update({ background_volume: 70 })
    await b.flush()
    await settle()
    release()
    await a.flush()
    await settle()
    expect(server.value.week_start_day).toBe(5)
    expect(a.values.week_start_day).toBe(5)
  })

  it('does not undo a newer edit of the same field in another tab', async () => {
    deferredLocks()
    const { server, api } = fakeServer()
    server.online = false
    const a = openTab(api)
    const b = openTab(api)
    a.update({ week_start_day: 3 })
    b.update({ week_start_day: 5 }) // later: pending, so A's repair leaves it alone
    await settle()
    expect(stored().pending).toEqual({ week_start_day: 5 })
    expect(stored().values.week_start_day).toBe(5)
  })
})
