import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { DEFAULT_SETTINGS, SettingsError } from './settings/api.ts'
import { SettingsStore } from './settings/store.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

const pomodoro = {
  focus_minutes: 40,
  break_minutes: 8,
  blocks: 3,
  long_break_enabled: false,
  long_break_minutes: 20,
}

function renderWith(settings: SettingsStore) {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  render(<App controller={controller} settings={settings} />)
}

describe('App with settings (#22)', () => {
  it('reaches Settings from the setup screen and back', async () => {
    renderWith(new SettingsStore())
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it("pre-fills the setup screen with the other device's tag and config (AC12.5)", async () => {
    const api = {
      get: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        last_tag: 'study',
        pomodoro_config: pomodoro,
        default_reminder_minutes: 30,
      }),
      patch: vi.fn(),
    }
    renderWith(new SettingsStore({ api }))
    await screen.findByRole('button', { name: 'Start' })
    expect(screen.getByRole('radio', { name: 'Study' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Pomodoro' }))
    expect(screen.getByDisplayValue('40')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Unlimited' }))
    expect(screen.getByLabelText('Reminder')).toHaveValue('30')
  })

  it('still opens offline, using the device copy', async () => {
    const api = {
      get: vi.fn().mockRejectedValue(new SettingsError('network', 'offline')),
      patch: vi.fn().mockRejectedValue(new SettingsError('network', 'offline')),
    }
    const settings = new SettingsStore({ api })
    settings.update({ last_tag: 'nap' })
    renderWith(settings)
    await screen.findByRole('button', { name: 'Start' })
    expect(screen.getByRole('radio', { name: 'Nap' })).toBeChecked()
  })
})
