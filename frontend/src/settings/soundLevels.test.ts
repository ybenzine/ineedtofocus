import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANON_SETTINGS_KEY, clearAnonymousData } from '../anonymous/keys.ts'
import { clearLocalUserData, claimLocalData } from '../auth/localData.ts'
import { DeviceAlertVolumeStore } from './adapters.ts'
import { DEFAULT_SETTINGS, type Settings, type SettingsApi } from './api.ts'
import {
  ALERT_VOLUME_KEY,
  BACKGROUND_VOLUME_KEY,
  SoundLevelsStore,
  type SoundLevels,
} from './soundLevels.ts'
import { SettingsStore } from './store.ts'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

/** A second device: its own storage, the same account on the same server. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

function serverApi(value: Settings): SettingsApi & { patches: unknown[] } {
  const patches: unknown[] = []
  return {
    patches,
    get: async () => value,
    patch: async (patch) => {
      patches.push(patch)
      value = { ...value, ...patch }
      return value
    },
  }
}

function device(api: SettingsApi, storage: Storage) {
  const levels = new SoundLevelsStore(storage)
  const settings = new SettingsStore({
    api,
    storage,
    owner: 'u1',
    onLoaded: (values) => levels.seed(values),
  })
  return { levels, settings }
}

describe('SoundLevelsStore (AC12.2, #336)', () => {
  it('starts at 80 / 50 and writes nothing until a level is changed', () => {
    const levels = new SoundLevelsStore(localStorage)
    expect(levels.getState()).toEqual<SoundLevels>({ alert: 80, background: 50 })
    expect(localStorage.length).toBe(0)
  })

  it('keeps a level across a reload, in device keys of its own', () => {
    const first = new SoundLevelsStore(localStorage)
    first.set('alert', 30)
    first.set('background', 70)
    expect(new SoundLevelsStore(localStorage).getState()).toEqual({ alert: 30, background: 70 })
    expect(Object.keys(localStorage).sort()).toEqual([ALERT_VOLUME_KEY, BACKGROUND_VOLUME_KEY])
    expect(ALERT_VOLUME_KEY.startsWith('ineedtofocus.anonymous.')).toBe(false)
  })

  it('ignores a level that is not a whole number from 0 to 100', () => {
    localStorage.setItem(ALERT_VOLUME_KEY, '900')
    localStorage.setItem(BACKGROUND_VOLUME_KEY, '"x"')
    const levels = new SoundLevelsStore(localStorage)
    expect(levels.getState()).toEqual({ alert: 80, background: 50 })
    levels.set('alert', Number.NaN)
    levels.set('alert', 101)
    expect(levels.alert).toBe(80)
  })

  it('follows another tab through the storage event, not only after a reload', () => {
    const levels = new SoundLevelsStore(localStorage)
    const stop = levels.start()
    const listener = vi.fn()
    levels.subscribe(listener)
    localStorage.setItem(BACKGROUND_VOLUME_KEY, '15') // what the other tab wrote
    window.dispatchEvent(
      new StorageEvent('storage', { key: BACKGROUND_VOLUME_KEY, newValue: '15' }),
    )
    expect(levels.background).toBe(15)
    expect(listener).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new StorageEvent('storage', { key: 'ineedtofocus.settings' }))
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    localStorage.setItem(BACKGROUND_VOLUME_KEY, '25')
    window.dispatchEvent(new StorageEvent('storage', { key: BACKGROUND_VOLUME_KEY }))
    expect(levels.background).toBe(15)
  })

  it('the alert adapter reads and writes the device level, clamped', () => {
    const store = new DeviceAlertVolumeStore(new SoundLevelsStore(localStorage))
    store.save(150)
    expect(store.load()).toBe(100)
    expect(localStorage.getItem(ALERT_VOLUME_KEY)).toBe('100')
  })

  describe('seeding a device that has no level of its own', () => {
    it('takes the guest settings first', () => {
      localStorage.setItem(
        ANON_SETTINGS_KEY,
        JSON.stringify({ owner: null, values: { alert_volume: 20, background_volume: 90 } }),
      )
      const levels = new SoundLevelsStore(localStorage)
      levels.seed({ alert_volume: 30, background_volume: 70 })
      expect(levels.getState()).toEqual({ alert: 20, background: 90 })
    })

    it("else takes the account's server value", () => {
      const levels = new SoundLevelsStore(localStorage)
      levels.seed({ alert_volume: 30, background_volume: 70 })
      expect(levels.getState()).toEqual({ alert: 30, background: 70 })
      expect(localStorage.getItem(ALERT_VOLUME_KEY)).toBe('30')
    })

    it('else stays at the defaults and stores nothing', () => {
      const levels = new SoundLevelsStore(localStorage)
      levels.seed()
      expect(levels.getState()).toEqual({ alert: 80, background: 50 })
      expect(localStorage.length).toBe(0)
    })

    it('happens once: a level the device already has is never replaced', () => {
      const levels = new SoundLevelsStore(localStorage)
      levels.set('alert', 10)
      levels.seed({ alert_volume: 30, background_volume: 70 })
      expect(levels.getState()).toEqual({ alert: 10, background: 70 })
      levels.seed({ alert_volume: 99, background_volume: 99 })
      expect(levels.getState()).toEqual({ alert: 10, background: 70 })
    })
  })

  it('survives sign-out, a different user signing in and a guest clearing', async () => {
    const levels = new SoundLevelsStore(localStorage)
    levels.set('alert', 33)
    levels.set('background', 44)
    localStorage.setItem(ANON_SETTINGS_KEY, '{}')
    clearAnonymousData(localStorage)
    expect(localStorage.getItem(ANON_SETTINGS_KEY)).toBeNull()
    localStorage.setItem('ineedtofocus.owner', 'u1')
    await claimLocalData({ id: 'u2', email: 'b@example.com' } as never)
    await clearLocalUserData()
    expect(new SoundLevelsStore(localStorage).getState()).toEqual({ alert: 33, background: 44 })
  })
})

describe('the levels and the settings store', () => {
  it('seeds 30/70 from the first real load, never from the 80/50 shown before it', async () => {
    const storage = memoryStorage()
    const api = serverApi({ ...DEFAULT_SETTINGS, alert_volume: 30, background_volume: 70 })
    const { levels, settings } = device(api, storage)
    expect(levels.getState()).toEqual({ alert: 80, background: 50 }) // shown, not stored
    expect(storage.length).toBe(0)
    await settings.refresh()
    expect(levels.getState()).toEqual({ alert: 30, background: 70 })
    expect(storage.getItem(ALERT_VOLUME_KEY)).toBe('30')
  })

  it('seeds from the cached settings at start-up, offline', async () => {
    const storage = memoryStorage()
    storage.setItem(
      'ineedtofocus.settings',
      JSON.stringify({ owner: 'u1', values: { alert_volume: 25, background_volume: 65 } }),
    )
    const api: SettingsApi = {
      get: () => Promise.reject(new Error('offline')),
      patch: () => Promise.reject(new Error('offline')),
    }
    const { levels } = device(api, storage)
    await Promise.resolve()
    expect(levels.getState()).toEqual({ alert: 25, background: 65 })
  })

  it('does not store 80/50 when an edit was cached before the first load, then reloaded', async () => {
    const storage = memoryStorage()
    const down: SettingsApi = {
      get: () => Promise.reject(new Error('offline')),
      patch: () => Promise.reject(new Error('offline')),
    }
    device(down, storage).settings.update({ theme: 'light' }) // cache = defaults + the edit
    const server = serverApi({ ...DEFAULT_SETTINGS, alert_volume: 30, background_volume: 70 })
    const reloaded = device(server, storage)
    await Promise.resolve()
    expect(storage.getItem(ALERT_VOLUME_KEY)).toBeNull()
    await reloaded.settings.refresh()
    expect(reloaded.levels.getState()).toEqual({ alert: 30, background: 70 })
  })

  it('does not seed from a cache that is not this user’s', () => {
    const storage = memoryStorage()
    storage.setItem(
      'ineedtofocus.settings',
      JSON.stringify({ owner: 'other', values: { alert_volume: 25 } }),
    )
    const { levels } = device(serverApi(DEFAULT_SETTINGS), storage)
    expect(levels.alert).toBe(80)
    expect(storage.getItem(ALERT_VOLUME_KEY)).toBeNull()
  })

  it('keeps each device’s own levels: no PATCH carries a volume, and a reload and a settings load keep them', async () => {
    const api = serverApi({ ...DEFAULT_SETTINGS, alert_volume: 40, background_volume: 40 })
    const phoneStorage = memoryStorage()
    const laptopStorage = memoryStorage()
    const phone = device(api, phoneStorage)
    const laptop = device(api, laptopStorage)
    await Promise.all([phone.settings.refresh(), laptop.settings.refresh()])
    expect(phone.levels.getState()).toEqual({ alert: 40, background: 40 })

    phone.levels.set('alert', 10)
    phone.levels.set('background', 95)
    // An ordinary synced edit alongside: it syncs, the levels do not.
    phone.settings.update({ week_start_day: 2 })
    await phone.settings.flush()
    expect(api.patches).toEqual([{ week_start_day: 2 }])

    await laptop.settings.refresh()
    expect(laptop.levels.getState()).toEqual({ alert: 40, background: 40 })
    expect(laptop.settings.values.week_start_day).toBe(2) // the other settings still sync

    // After a reload of each device.
    const reloadedPhone = device(api, phoneStorage)
    const reloadedLaptop = device(api, laptopStorage)
    await Promise.all([reloadedPhone.settings.refresh(), reloadedLaptop.settings.refresh()])
    expect(reloadedPhone.levels.getState()).toEqual({ alert: 10, background: 95 })
    expect(reloadedLaptop.levels.getState()).toEqual({ alert: 40, background: 40 })
  })
})
