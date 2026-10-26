// The iPhone/iPad silent-mode hint (#307): where it shows, where it doesn't, how it's presented.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsContext } from '../settings/SettingsContext.ts'
import SettingsScreen from '../settings/SettingsScreen.tsx'
import { SettingsStore } from '../settings/store.ts'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import SessionSetup, { type SessionRequest } from '../setup/SessionSetup.tsx'
import { MemoryActiveSessionStore, TimerController } from '../timer/index.ts'
import TimerScreen from '../timerscreen/TimerScreen.tsx'
import { AlertPlayer, MemoryAlertVolumeStore } from './alerts.ts'
import { SETTINGS_SILENT_HINT, SETUP_SILENT_HINT } from './appleMobile.ts'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

function device(userAgent: string, maxTouchPoints: number) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  // jsdom has no maxTouchPoints, so there is nothing to spy on.
  Object.defineProperty(navigator, 'maxTouchPoints', { value: maxTouchPoints, configurable: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'maxTouchPoints')
})

function renderSettings() {
  const store = new SettingsStore()
  const player = new AlertPlayer({
    volume: new MemoryAlertVolumeStore(80),
    createContext: () => ({}) as unknown as AudioContext,
    fetchSound: async () => new ArrayBuffer(1),
  })
  render(
    <SettingsContext.Provider value={store}>
      <SettingsScreen player={player} />
    </SettingsContext.Provider>,
  )
}

function renderSetup() {
  const onStart = vi.fn<(request: SessionRequest) => void>()
  render(<SessionSetup preferences={new MemoryPreferencesStore()} onStart={onStart} />)
  return { onStart }
}

const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }))

describe('Settings hint', () => {
  it('shows the sentence after the previews and describes both buttons with it', () => {
    device(IPHONE, 5)
    renderSettings()
    const hint = screen.getByText(SETTINGS_SILENT_HINT)
    expect(hint.tagName).toBe('P')
    const bell = screen.getByRole('button', { name: 'Preview bell' })
    expect(bell.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    for (const name of ['Preview chime', 'Preview bell']) {
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(SETTINGS_SILENT_HINT)
    }
    expect(SETTINGS_SILENT_HINT).toBe(
      'On iPhone and iPad, the chime, bell and rain are off while silent mode is on.',
    )
  })

  it('is plain text: no live region, alert role or dismiss control', () => {
    device(IPHONE, 5)
    renderSettings()
    const hint = screen.getByText(SETTINGS_SILENT_HINT)
    expect(hint).not.toHaveAttribute('role')
    expect(hint).not.toHaveAttribute('aria-live')
    expect(hint.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull()
    expect(within(hint).queryByRole('button')).toBeNull()
    expect(hint.textContent).not.toMatch(/youtube/i)
  })

  it('is absent on desktop Chrome and the buttons describe nothing', () => {
    device(DESKTOP_CHROME, 0)
    renderSettings()
    expect(screen.queryByText(/silent mode/)).not.toBeInTheDocument()
    for (const name of ['Preview chime', 'Preview bell']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('aria-describedby')
    }
  })
})

describe('Setup hint', () => {
  it('shows only while Rain is selected, and again when switching back', () => {
    device(IPHONE, 5)
    renderSetup()
    const fieldset = screen.getByRole('group', { name: 'Background audio' })
    expect(within(fieldset).queryByText(SETUP_SILENT_HINT)).not.toBeInTheDocument()
    pick('Rain')
    const hint = within(fieldset).getByText(SETUP_SILENT_HINT)
    expect(hint.tagName).toBe('P')
    expect(hint).not.toHaveAttribute('role')
    expect(hint).not.toHaveAttribute('aria-live')
    expect(hint.textContent).not.toMatch(/youtube/i)
    expect(SETUP_SILENT_HINT).toBe(
      'On iPhone and iPad, rain and alerts are off while silent mode is on.',
    )
    pick('None')
    expect(screen.queryByText(SETUP_SILENT_HINT)).not.toBeInTheDocument()
    pick('Rain')
    expect(screen.getByText(SETUP_SILENT_HINT)).toBeInTheDocument()
    pick('YouTube')
    expect(screen.queryByText(SETUP_SILENT_HINT)).not.toBeInTheDocument()
    expect(screen.queryByText(/silent mode/)).not.toBeInTheDocument()
  })

  it('is absent on desktop Chrome with Rain selected', () => {
    device(DESKTOP_CHROME, 0)
    renderSetup()
    pick('Rain')
    expect(screen.queryByText(/silent mode/)).not.toBeInTheDocument()
  })

  it('does not get in the way of starting a session with Rain', async () => {
    device(IPHONE, 5)
    const { onStart } = renderSetup()
    pick('Rain')
    const start = screen.getByRole('button', { name: 'Start' })
    expect(start).toBeEnabled()
    fireEvent.click(start)
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].audio).toBe('rain')
  })
})

describe('Timer screen', () => {
  it('never shows either hint, even on an iPhone with Rain playing', async () => {
    device(IPHONE, 5)
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await controller.start({
      config: { mode: 'countdown', minutes: 5 },
      tag: 'work',
      goal: null,
    })
    render(
      <TimerScreen
        controller={controller}
        audio="rain"
        onEvents={() => undefined}
        onEnded={() => undefined}
      />,
    )
    expect(screen.getByText('Rain')).toBeInTheDocument()
    expect(screen.queryByText(/silent mode/)).not.toBeInTheDocument()
  })
})
