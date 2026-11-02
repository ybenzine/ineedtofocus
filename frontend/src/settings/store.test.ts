import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPreferencesStore, SettingsAlertVolumeStore } from './adapters.ts'
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
    store.update({ alert_volume: 30 })
    await store.flush()
    expect(patches).toEqual([{ alert_volume: 30 }])
    expect(store.hasPending()).toBe(false)
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}').values.alert_volume).toBe(30)
  })

  it('does not send a value that did not change', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    store.update({ alert_volume: 80 })
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
    store.update({ alert_volume: 10 })
    await store.flush()
    expect(patches).toEqual([])
    server.online = true
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(patches).toEqual([{ alert_volume: 10 }]))
    stop()
    window.dispatchEvent(new Event('online'))
  })

  it("takes the server's copy for fields with nothing pending (another device's change)", async () => {
    const { api, server } = fakeServer({ alert_volume: 30, last_tag: 'study' })
    const store = new SettingsStore({ api, storage: localStorage })
    await store.refresh()
    expect(store.values.alert_volume).toBe(30)
    expect(store.values.last_tag).toBe('study')
    server.value = { ...server.value, alert_volume: 55 }
    await store.refresh()
    expect(store.values.alert_volume).toBe(55)
  })

  it('keeps a pending local edit over the server copy while offline (last write wins)', async () => {
    const { api, server } = fakeServer({ alert_volume: 30 })
    const store = new SettingsStore({ api })
    server.online = false
    store.update({ alert_volume: 90 })
    server.online = true
    await store.refresh()
    expect(server.value.alert_volume).toBe(90)
    expect(store.values.alert_volume).toBe(90)
  })

  it('coalesces rapid edits (a slider drag) into the latest value', async () => {
    const { api, patches } = fakeServer()
    const store = new SettingsStore({ api })
    for (const v of [10, 20, 30, 40]) store.update({ alert_volume: v })
    await store.flush()
    expect(patches.at(-1)).toEqual({ alert_volume: 40 })
    expect(patches.length).toBeLessThanOrEqual(2)
    expect(store.hasPending()).toBe(false)
  })

  it('drops values the server rejects so later edits are not blocked', async () => {
    const { api, server, patches } = fakeServer()
    server.reject = true
    const store = new SettingsStore({ api })
    store.update({ alert_volume: 20 })
    await store.flush()
    expect(store.hasPending()).toBe(false)
    server.reject = false
    store.update({ background_volume: 10 })
    await store.flush()
    expect(patches).toEqual([{ background_volume: 10 }])
  })

  it('ignores a corrupt device cache', () => {
    localStorage.setItem(SETTINGS_KEY, '{nope')
    expect(new SettingsStore({ storage: localStorage }).values).toEqual(DEFAULT_SETTINGS)
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ values: { alert_volume: 900, week_start_day: 3 }, pending: {} }),
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

describe('SettingsAlertVolumeStore (AC5.2, AC12.2)', () => {
  it('reads and writes alert_volume, not the old local key', async () => {
    localStorage.setItem('ineedtofocus.alertVolume', '5')
    const { api, patches } = fakeServer({ alert_volume: 30 })
    const store = new SettingsStore({ api, storage: localStorage })
    const volume = new SettingsAlertVolumeStore(store)
    expect(volume.load()).toBe(80) // the old key is not migrated
    await store.refresh()
    expect(volume.load()).toBe(30)
    volume.save(150)
    await store.flush()
    expect(patches).toEqual([{ alert_volume: 100 }])
    expect(localStorage.getItem('ineedtofocus.alertVolume')).toBe('5') // untouched
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
