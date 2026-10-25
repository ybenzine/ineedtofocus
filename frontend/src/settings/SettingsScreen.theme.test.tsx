import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingsAlertVolumeStore } from './adapters.ts'
import { AlertPlayer } from '../sounds/alerts.ts'
import { SettingsContext } from './SettingsContext.ts'
import SettingsScreen from './SettingsScreen.tsx'
import { parseSettings } from './api.ts'
import { SettingsStore } from './store.ts'

function renderScreen(store = new SettingsStore()) {
  const player = new AlertPlayer({
    volume: new SettingsAlertVolumeStore(store),
    createContext: () => ({}) as unknown as AudioContext,
  })
  render(
    <SettingsContext.Provider value={store}>
      <SettingsScreen player={player} />
    </SettingsContext.Provider>,
  )
  return store
}

describe('SettingsScreen appearance (theme)', () => {
  it('offers System (default), Dark and Light, with System selected for a new user', () => {
    renderScreen()
    const group = screen.getByRole('group', { name: 'Appearance' })
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((r) => r.parentElement?.textContent)).toEqual([
      'System (default)',
      'Dark',
      'Light',
    ])
    expect(within(group).getByRole('radio', { name: 'System (default)' })).toBeChecked()
  })

  it('saves the choice to the store so it syncs like other settings', () => {
    const store = renderScreen()
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(store.values.theme).toBe('light')
    expect(store.getState().pending).toEqual({ theme: 'light' })
    expect(screen.getByRole('radio', { name: 'Light' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(store.values.theme).toBe('dark')
  })
})

describe('theme in the settings data', () => {
  it('defaults to system and ignores unknown values', () => {
    expect(parseSettings({}).theme).toBe('system')
    expect(parseSettings({ theme: 'sepia' }).theme).toBe('system')
    expect(parseSettings({ theme: 'light' }).theme).toBe('light')
  })
})
