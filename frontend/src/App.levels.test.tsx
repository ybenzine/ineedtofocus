import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { ANON_SETTINGS_KEY } from './anonymous/keys.ts'
import { SoundLevelsStore } from './settings/soundLevels.ts'
import { SettingsStore } from './settings/store.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

function guest(alert: number, background: number) {
  localStorage.setItem(
    ANON_SETTINGS_KEY,
    JSON.stringify({ owner: null, values: { alert_volume: alert, background_volume: background } }),
  )
}

function tree(levels: SoundLevelsStore, settings: SettingsStore) {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  return (
    <App
      controller={controller}
      preferences={new MemoryPreferencesStore()}
      levels={levels}
      settings={settings}
    />
  )
}

describe('the device sound levels in the app (#430)', () => {
  it('start from the guest settings, else 80/50, and never from the account', () => {
    guest(20, 90)
    const levels = new SoundLevelsStore(localStorage)
    expect(levels.getState()).toEqual({ alert: 80, background: 50 })
    render(tree(levels, new SettingsStore()))
    expect(levels.getState()).toEqual({ alert: 20, background: 90 })
  })

  it('stay at 80/50 with no guest settings', () => {
    const levels = new SoundLevelsStore(localStorage)
    render(tree(levels, new SettingsStore()))
    expect(levels.getState()).toEqual({ alert: 80, background: 50 })
    expect(localStorage.getItem('ineedtofocus.device.alertVolume')).toBeNull()
  })

  it('are never overwritten by a seed when the settings store changes', () => {
    guest(20, 90)
    const levels = new SoundLevelsStore(localStorage)
    levels.set('alert', 10)
    const view = render(tree(levels, new SettingsStore()))
    expect(levels.getState()).toEqual({ alert: 10, background: 90 }) // only the missing one
    guest(99, 99)
    view.rerender(tree(levels, new SettingsStore()))
    expect(levels.getState()).toEqual({ alert: 10, background: 90 })
  })
})
