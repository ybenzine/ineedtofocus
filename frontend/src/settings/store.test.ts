import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPreferencesStore } from './adapters.ts'
import {
  DEFAULT_SETTINGS,
  SettingsError,
  type Settings,
  type SettingsApi,
  type SettingsPatch,
} from './api.ts'
import { ANON_SETTINGS_KEY, clearAnonymousData } from '../anonymous/keys.ts'
import { DEFAULT_PREFERENCES } from '../setup/preferences.ts'
import { SETTINGS_KEY, SettingsStore } from './store.ts'

afterEach(() => localStorage.clear())

/** A fake server holding one user's settings, last write wins. */
function fakeServer(initial: Partial<Settings> = {}) {
  const server = { value: { ...DEFAULT_SETTINGS, ...initial }, online: true, reject: false }
  const patches: SettingsPatch[] = []
  const api: SettingsApi = {
    get: vi.fn(async () => {
      if (!server.online) throw new SettingsError('network', 'offline')
      return server.value
    }),
    patch: vi.fn(async (patch: SettingsPatch) => {
      if (!server.online) throw new SettingsError('network', 'offline')
      if (server.reject) throw new SettingsError('invalid', 'bad')
      patches.push(patch)
      server.value = { ...server.value, ...patch }
      return server.value
    }),
  }
  return { server, patches, api }
}

const pomodoro = {
  focus_minutes: 40,
  break_minutes: 8,
  blocks: 3,
  long_break_enabled: false,
  long_break_minutes: 20,
}

describe('SettingsStore', () => {
  it('starts from the defaults for a new user (80 / 50 / off / Sunday)', () => {
    const store = new SettingsStore()
    expect(store.values).toEqual(DEFAULT_SETTINGS)
    expect(store.values.alert_volume).toBe(80)
    expect(store.values.background_volume).toBe(50)
    expect(store.values.keep_screen_awake).toBe(false)
    expect(store.values.week_start_day).toBe(0)
  })

  it('sends only the changed fields and clears them once accepted', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api, storage: localStorage })
    store.update({ countdown_recent_minutes: 130 })
    await store.flush()
    expect(patches).toEqual([{ countdown_recent_minutes: 130 }])
    expect(store.hasPending()).toBe(false)
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').values.countdown_recent_minutes,
    ).toBe(130)
  })

  it('does not send a value that did not change', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    store.update({ week_start_day: 0 })
    await store.flush()
    expect(patches).toEqual([])
  })

  it('keeps an offline edit, restores it after a reload, and sends it when back online', async () => {
    const { api, server, patches } = fakeServer()
    server.online = false
    const first = new SettingsStore({ api, storage: localStorage })
    first.update({ week_start_day: 1, default_reminder_minutes: 45 })
    await first.flush()
    expect(first.hasPending()).toBe(true)

    // A reload: a new store reads the device copy.
    const second = new SettingsStore({ api, storage: localStorage })
    expect(second.values.week_start_day).toBe(1)
    expect(second.hasPending()).toBe(true)

    server.online = true
    await second.refresh()
    expect(patches).toEqual([{ week_start_day: 1, default_reminder_minutes: 45 }])
    expect(second.hasPending()).toBe(false)
    expect(server.value.week_start_day).toBe(1)
  })

  it('retries when the browser reports it is online again', async () => {
    const { api, server, patches } = fakeServer()
    server.online = false
    const store = new SettingsStore({ api })
    const stop = store.start()
    store.update({ countdown_recent_minutes: 110 })
    await store.flush()
    expect(patches).toEqual([])
    server.online = true
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(patches).toEqual([{ countdown_recent_minutes: 110 }]))
    stop()
    window.dispatchEvent(new Event('online'))
  })

  it("takes the server's copy for fields with nothing pending (another device's change)", async () => {
    const { api, server } = fakeServer({ countdown_recent_minutes: 130, last_tag: 'study' })
    const store = new SettingsStore({ api, storage: localStorage })
    await store.refresh()
    expect(store.values.countdown_recent_minutes).toBe(130)
    expect(store.values.last_tag).toBe('study')
    server.value = { ...server.value, countdown_recent_minutes: 155 }
    await store.refresh()
    expect(store.values.countdown_recent_minutes).toBe(155)
  })

  it('keeps a pending local edit over the server copy while offline (last write wins)', async () => {
    const { api, server } = fakeServer({ countdown_recent_minutes: 130 })
    const store = new SettingsStore({ api })
    server.online = false
    store.update({ countdown_recent_minutes: 190 })
    server.online = true
    await store.refresh()
    expect(server.value.countdown_recent_minutes).toBe(190)
    expect(store.values.countdown_recent_minutes).toBe(190)
  })

  it('coalesces rapid edits (a slider drag) into the latest value', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    for (const v of [110, 120, 130, 140]) store.update({ countdown_recent_minutes: v })
    await store.flush()
    expect(patches.at(-1)).toEqual({ countdown_recent_minutes: 140 })
    expect(patches.length).toBeLessThanOrEqual(2)
    expect(store.hasPending()).toBe(false)
  })

  it('drops values the server rejects so later edits are not blocked', async () => {
    const { api, server, patches } = fakeServer()
    server.reject = true
    const store = new SettingsStore({ api })
    store.update({ countdown_recent_minutes: 120 })
    await store.flush()
    expect(store.hasPending()).toBe(false)
    server.reject = false
    store.update({ calendar_min_minutes: 10 })
    await store.flush()
    expect(patches).toEqual([{ calendar_min_minutes: 10 }])
  })

  it('ignores a corrupt device cache', () => {
    localStorage.setItem(SETTINGS_KEY, '{nope')
    expect(new SettingsStore({ storage: localStorage }).values).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        values: { alert_volume: 900, countdown_recent_minutes: 900, week_start_day: 3 },
        pending: {},
      }),
    )
    const store = new SettingsStore({ storage: localStorage })
    expect(store.values.alert_volume).toBe(80)
    expect(store.values.week_start_day).toBe(3)
  })

  it('notifies subscribers on change', () => {
    const store = new SettingsStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.update({ week_start_day: 2 })
    expect(listener).toHaveBeenCalled()
    expect(store.getState().values.week_start_day).toBe(2)
  })
})

describe('SettingsPreferencesStore (AC12.5)', () => {
  it('maps the last-used config and tag to and from the API shape', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    const prefs = new SettingsPreferencesStore(store)
    expect(prefs.load().tag).toBe('work') // null last_tag means Work
    prefs.save({
      tag: 'study',
      pomodoro: {
        mode: 'pomodoro',
        focusMinutes: 40,
        breakMinutes: 8,
        blocks: 3,
        longBreakEnabled: false,
        longBreakMinutes: 20,
      },
    })
    await store.flush()
    expect(patches).toEqual([{ last_tag: 'study', pomodoro_config: pomodoro }])
    expect(prefs.load().pomodoro.focusMinutes).toBe(40)
  })

  it('pre-fills on a second device after it syncs', async () => {
    const { api } = fakeServer({ last_tag: 'read', pomodoro_config: pomodoro })
    const deviceB = new SettingsStore({ api })
    await deviceB.refresh()
    const loaded = new SettingsPreferencesStore(deviceB).load()
    expect(loaded.tag).toBe('read')
    expect(loaded.pomodoro).toEqual({
      mode: 'pomodoro',
      focusMinutes: 40,
      breakMinutes: 8,
      blocks: 3,
      longBreakEnabled: false,
      longBreakMinutes: 20,
    })
  })

  it('only sends what changed (a countdown start sends just the tag)', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    const prefs = new SettingsPreferencesStore(store)
    prefs.save({ ...prefs.load(), tag: 'nap' })
    await store.flush()
    expect(patches).toEqual([{ last_tag: 'nap' }])
  })
})

describe('the sound levels are not synced (AC12.2, #336)', () => {
  it('never sends a volume, even when one is passed in or left pending in an old cache', async () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        owner: null,
        values: {},
        pending: { alert_volume: 5, background_volume: 6, week_start_day: 2 },
      }),
    )
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api, storage: localStorage })
    store.update({ alert_volume: 10, week_start_day: 3 } as never)
    await store.flush()
    for (const patch of patches) {
      expect(patch).not.toHaveProperty('alert_volume')
      expect(patch).not.toHaveProperty('background_volume')
    }
    expect(patches.at(-1)).toEqual({ week_start_day: 3 })
  })

  it('tells onLoaded about a real copy only: not the defaults shown before it', async () => {
    const onLoaded = vi.fn()
    const { api } = fakeServer({ alert_volume: 30, background_volume: 70 })
    const store = new SettingsStore({ api, storage: localStorage, onLoaded })
    expect(onLoaded).not.toHaveBeenCalled()
    await store.refresh()
    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ alert_volume: 30, background_volume: 70 })
  })

  it('tells onLoaded about the cached copy at once', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ owner: null, values: { alert_volume: 25 }, pending: {} }),
    )
    const onLoaded = vi.fn()
    new SettingsStore({ storage: localStorage, onLoaded })
    expect(onLoaded.mock.calls[0]?.[0]).toMatchObject({ alert_volume: 25 })
  })
})

describe('countdown_recent_minutes (#409)', () => {
  it('is none by default and ignores a preset or out-of-range value from the cache', () => {
    expect(DEFAULT_SETTINGS.countdown_recent_minutes).toBeNull()
    for (const bad of [30, 0, 241, 1.5, '50', undefined]) {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ owner: null, values: { countdown_recent_minutes: bad } }),
      )
      expect(
        new SettingsStore({ storage: localStorage }).values.countdown_recent_minutes,
      ).toBeNull()
    }
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ owner: null, values: { countdown_recent_minutes: 50 } }),
    )
    expect(new SettingsStore({ storage: localStorage }).values.countdown_recent_minutes).toBe(50)
  })

  it('signed in, goes through the settings store: kept on the device and sent as a patch', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api, storage: localStorage, owner: 'u1' })
    const prefs = new SettingsPreferencesStore(store)
    prefs.save({ ...prefs.load(), countdownRecent: 50 })
    expect(prefs.load().countdownRecent).toBe(50)
    await store.flush()
    expect(patches).toEqual([{ countdown_recent_minutes: 50 }])
    expect(
      JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').values.countdown_recent_minutes,
    ).toBe(50)
  })

  it('offline, the edit stays pending and is sent when the connection returns', async () => {
    const { api, server, patches } = fakeServer()
    server.online = false
    const store = new SettingsStore({ api, storage: localStorage, owner: 'u1' })
    const prefs = new SettingsPreferencesStore(store)
    prefs.save({ ...prefs.load(), countdownRecent: 75 })
    await store.flush()
    expect(store.hasPending()).toBe(true)
    server.online = true
    await store.flush()
    expect(patches).toEqual([{ countdown_recent_minutes: 75 }])
  })

  it('does not save a preset or out-of-range value', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api, storage: localStorage, owner: 'u1' })
    const prefs = new SettingsPreferencesStore(store)
    for (const bad of [30, 0, 500]) prefs.save({ ...prefs.load(), countdownRecent: bad })
    await store.flush()
    expect(patches).toEqual([])
    expect(prefs.load().countdownRecent).toBeNull()
  })

  it('keeps no calendar settings on a guest device, values or pending (AC12.8)', () => {
    const store = new SettingsStore({ storage: localStorage, key: ANON_SETTINGS_KEY })
    store.update({
      theme: 'light',
      calendar_title_template: 'Secret',
      calendar_include_goal: false,
    })
    const raw = localStorage.getItem(ANON_SETTINGS_KEY) ?? ''
    expect(raw).toContain('"theme":"light"')
    expect(raw).not.toContain('calendar')
    expect(raw).not.toContain('Secret')
    for (let i = 0; i < localStorage.length; i++) {
      expect(localStorage.getItem(localStorage.key(i) ?? '')).not.toContain('calendar_')
    }
    // An account's copy does keep them.
    const account = new SettingsStore({ storage: localStorage, owner: 'u1' })
    account.update({ calendar_title_template: 'Mine' })
    expect(localStorage.getItem(SETTINGS_KEY)).toContain('"calendar_title_template":"Mine"')
  })

  it('as a guest, lives under the anonymous key and sign-in clears it', () => {
    const store = new SettingsStore({ storage: localStorage, key: ANON_SETTINGS_KEY })
    new SettingsPreferencesStore(store).save({ ...DEFAULT_PREFERENCES, countdownRecent: 50 })
    expect(localStorage.getItem(ANON_SETTINGS_KEY)).toContain('"countdown_recent_minutes":50')
    // Never in the account's cache.
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    clearAnonymousData()
    expect(localStorage.getItem(ANON_SETTINGS_KEY)).toBeNull()
    const account = new SettingsStore({ storage: localStorage, owner: 'u1' })
    expect(account.values.countdown_recent_minutes).toBeNull()
  })
})
