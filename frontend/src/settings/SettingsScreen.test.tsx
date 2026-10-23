import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AlertPlayer } from '../sounds/alerts.ts'
import { SettingsAlertVolumeStore } from './adapters.ts'
import { SettingsContext } from './SettingsContext.ts'
import SettingsScreen from './SettingsScreen.tsx'
import { SettingsStore } from './store.ts'

function fakeContext() {
  const sources: { start: ReturnType<typeof vi.fn> }[] = []
  const gain = { gain: { value: 0 }, connect: vi.fn() }
  const context = {
    state: 'running',
    destination: {},
    resume: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async () => ({})),
    createGain: vi.fn(() => gain),
    createBufferSource: vi.fn(() => {
      const source = { buffer: null, connect: vi.fn(), start: vi.fn() }
      sources.push(source)
      return source
    }),
  }
  return { context, gain, sources }
}

function renderScreen(store = new SettingsStore()) {
  const audio = fakeContext()
  const player = new AlertPlayer({
    volume: new SettingsAlertVolumeStore(store),
    createContext: () => audio.context as unknown as AudioContext,
    fetchSound: async () => new ArrayBuffer(1),
  })
  render(
    <SettingsContext.Provider value={store}>
      <SettingsScreen player={player} />
    </SettingsContext.Provider>,
  )
  return { store, ...audio }
}

describe('SettingsScreen', () => {
  it('shows the defaults for a new user', () => {
    renderScreen()
    expect(screen.getByLabelText('Week starts on')).toHaveValue('0')
    expect(screen.getByLabelText('Alert volume')).toHaveValue('80')
    expect(screen.getByLabelText('Background audio volume')).toHaveValue('50')
    expect(screen.getByLabelText('Default reminder interval (unlimited timer)')).toHaveValue('off')
  })

  it('saves each setting to the store (AC12.1-12.4)', () => {
    const { store } = renderScreen()
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Background audio volume'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Default reminder interval (unlimited timer)'), {
      target: { value: '45' },
    })
    expect(store.values).toMatchObject({
      week_start_day: 1,
      background_volume: 20,
      default_reminder_minutes: 45,
    })
    fireEvent.change(screen.getByLabelText('Default reminder interval (unlimited timer)'), {
      target: { value: 'off' },
    })
    expect(store.values.default_reminder_minutes).toBeNull()
  })

  it('toggles keep screen awake when the browser supports it, else disables it', () => {
    renderScreen()
    const toggle = screen.getByRole('checkbox', { name: /Keep screen awake/ })
    expect(toggle).toBeDisabled() // jsdom has no Wake Lock API
    expect(screen.getByText(/can.t keep the screen awake/)).toBeInTheDocument()
  })

  it('keeps keep-awake on when supported', () => {
    vi.stubGlobal('navigator', { ...navigator, wakeLock: { request: vi.fn() } })
    const { store } = renderScreen()
    fireEvent.click(screen.getByRole('checkbox', { name: /Keep screen awake/ }))
    expect(store.values.keep_screen_awake).toBe(true)
    vi.unstubAllGlobals()
  })

  it('has one alert-volume control, which sets alert_volume and drives the previews (AC5.3)', async () => {
    const { store, gain, sources } = renderScreen()
    expect(screen.getAllByLabelText(/alert volume/i)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Alert volume'), { target: { value: '30' } })
    expect(store.values.alert_volume).toBe(30)
    fireEvent.click(screen.getByRole('button', { name: 'Preview chime' }))
    await vi.waitFor(() => expect(sources).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Preview bell' }))
    await vi.waitFor(() => expect(sources).toHaveLength(2))
    expect(gain.gain.value).toBe(0.3)
  })

  it("shows another device's alert volume from the cache", () => {
    const store = new SettingsStore()
    store.update({ alert_volume: 30 })
    renderScreen(store)
    expect(screen.getByLabelText('Alert volume')).toHaveValue('30')
  })

  it('notes the time zone for days and weeks (AC10.5)', () => {
    renderScreen()
    expect(screen.getByText(/follow this device.s time zone/)).toBeInTheDocument()
  })

  it('says when changes are waiting to sync', async () => {
    const store = new SettingsStore({
      api: {
        get: () => Promise.reject(new Error('offline')),
        patch: () => Promise.reject(new Error('offline')),
      },
    })
    renderScreen(store)
    expect(within(screen.getByRole('status')).queryByText(/sync/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '2' } })
    expect(await screen.findByText(/sync when you.re back online/)).toBeInTheDocument()
  })

  it('does not show the note while an ordinary save is in flight', () => {
    const store = new SettingsStore({
      api: { get: () => new Promise(() => undefined), patch: () => new Promise(() => undefined) },
    })
    renderScreen(store)
    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '2' } })
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('follows a synced alert volume arriving while Settings is open', () => {
    const { store } = renderScreen()
    act(() => store.update({ alert_volume: 12 }))
    expect(screen.getByLabelText('Alert volume')).toHaveValue('12')
  })
})
