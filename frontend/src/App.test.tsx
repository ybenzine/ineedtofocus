import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertPlayer, MemoryAlertVolumeStore } from './sounds/alerts.ts'
import App from './App.tsx'
import { AccountContext } from './auth/AccountContext.tsx'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { SettingsStore } from './settings/store.ts'
import type { SyncEngine } from './sync/index.ts'
import {
  ACTIVE_SESSION_KEY,
  LocalActiveSessionStore,
  MemoryActiveSessionStore,
  TimerController,
} from './timer/index.ts'

function setup(store = new MemoryActiveSessionStore()) {
  const controller = new TimerController({ store, saveRecord: () => undefined })
  render(<App controller={controller} preferences={new MemoryPreferencesStore()} />)
  return { controller, store }
}

async function runningStore() {
  const store = new MemoryActiveSessionStore()
  const first = new TimerController({ store, saveRecord: () => undefined })
  await first.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
  return store
}

describe('App account bar', () => {
  const account = {
    user: { id: 'u', email: 'a@b.co', created_at: '' },
    signOut: () => Promise.resolve(null),
  }
  function renderSignedIn(store = new MemoryActiveSessionStore()) {
    const controller = new TimerController({ store, saveRecord: () => undefined })
    render(
      <AccountContext.Provider value={account}>
        <App controller={controller} preferences={new MemoryPreferencesStore()} />
      </AccountContext.Provider>,
    )
  }

  it('offers Sign out on the setup screen only, not over the timer', async () => {
    renderSignedIn()
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('offers Sign out on the History screen, refused while a session runs, not on the summary', async () => {
    renderSignedIn()
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    // A session running in another tab: Sign out is refused.
    const other = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await other.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End your session before signing out.',
    )
    window.localStorage.removeItem(ACTIVE_SESSION_KEY)
    window.history.replaceState(null, '', '/')
  })

  it('offers Sign out on the Settings screen, refused while a session runs', async () => {
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    render(
      <AccountContext.Provider value={account}>
        <App controller={controller} settings={new SettingsStore()} />
      </AccountContext.Provider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    expect(window.location.pathname).toBe('/settings')
    const other = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await other.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End your session before signing out.',
    )
    window.localStorage.removeItem(ACTIVE_SESSION_KEY)
    window.history.replaceState(null, '', '/')
  })

  it('does not offer Sign out over a session restored at reload', async () => {
    renderSignedIn(await runningStore())
    await screen.findByRole('timer')
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })
})

describe('App', () => {
  it('shows the setup screen', async () => {
    setup()
    expect(await screen.findByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
  })

  it('starts a session and shows the timer screen', async () => {
    const { controller } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('timer')).toHaveTextContent('25:00')
    expect(controller.current()?.config).toEqual({ mode: 'countdown', minutes: 25 })
  })

  it('unlocks audio on the Start press (browsers block it before a gesture)', async () => {
    const alerts = new AlertPlayer({ volume: new MemoryAlertVolumeStore() })
    const unlock = vi.spyOn(alerts, 'unlock').mockResolvedValue(undefined)
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    render(
      <App controller={controller} preferences={new MemoryPreferencesStore()} alerts={alerts} />,
    )
    expect(unlock).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('unlocks audio on the first gesture of a restored session', async () => {
    const alerts = new AlertPlayer({ volume: new MemoryAlertVolumeStore() })
    const unlock = vi.spyOn(alerts, 'unlock').mockResolvedValue(undefined)
    const store = await runningStore()
    const controller = new TimerController({ store, saveRecord: () => undefined })
    render(
      <App controller={controller} preferences={new MemoryPreferencesStore()} alerts={alerts} />,
    )
    await screen.findByRole('timer')
    await act(async () => undefined) // let the gesture listener attach
    expect(unlock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('timer'))
    expect(unlock).toHaveBeenCalledTimes(1)
  })

  it('shows the summary after stopping, then returns to setup', async () => {
    const { controller } = setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    // Too short to be saved (AC6.2), so the summary explains that.
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('heading', { name: 'Session not saved' })).toBeInTheDocument()
    expect(controller.current()).toBeNull()
    expect(screen.getByRole('link', { name: 'View history' })).toHaveAttribute('href', '/history')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
  })

  it('ac6_4 goes straight to the timer when a session was running at reload', async () => {
    const store = new MemoryActiveSessionStore()
    const first = new TimerController({ store, saveRecord: () => undefined })
    await first.start({
      config: { mode: 'countdown', minutes: 25 },
      tag: 'read',
      goal: 'Chapter 3',
    })
    setup(store)
    expect(await screen.findByRole('timer')).toBeInTheDocument()
    expect(screen.getByText('Chapter 3')).toBeInTheDocument()
  })

  it('explains the jump to setup when another tab ended the session', async () => {
    const store = await runningStore()
    setup(store)
    await screen.findByRole('timer')
    store.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SESSION_KEY }))
    expect(await screen.findByRole('status')).toHaveTextContent('ended in another tab')
    expect(screen.getByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
  })

  it('keeps retrying a session that couldn’t be saved yet and drops the note once it is', async () => {
    const store = new MemoryActiveSessionStore()
    let now = Date.UTC(2026, 9, 23, 9, 0)
    const first = new TimerController({
      store,
      saveRecord: () => Promise.reject(new Error('IndexedDB stalled')),
      now: () => now,
    })
    await first.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    now += 10 * 60_000
    expect((await first.stop()).recordPending).toBe(true)

    let attempts = 0
    const saved: string[] = []
    const controller = new TimerController({
      store,
      saveRecord: async (record) => {
        attempts += 1
        if (attempts < 3) throw new Error('IndexedDB stalled')
        saved.push(record.id)
      },
      now: () => now,
    })
    render(
      <App
        controller={controller}
        preferences={new MemoryPreferencesStore()}
        pendingRetryMs={10}
      />,
    )
    expect(await screen.findByText(/Not saved yet/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/Not saved yet/)).not.toBeInTheDocument())
    expect(screen.getByRole('heading', { name: 'Session ended early' })).toBeInTheDocument()
    expect(saved).toHaveLength(1)
    expect(store.load()).toBeNull()
  })

  it('ac13_3 syncs while the app runs and stops when it closes', async () => {
    const stop = vi.fn()
    const sync = { start: vi.fn(() => stop) } as unknown as SyncEngine
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    const { unmount } = render(
      <App
        services={{ controller, sync, hook: null }}
        preferences={new MemoryPreferencesStore()}
      />,
    )
    await screen.findByRole('heading', { name: 'I Need To Focus' })
    expect(sync.start).toHaveBeenCalled()
    unmount()
    expect(stop).toHaveBeenCalled()
  })
})

describe('App history navigation', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('opens the History screen on a deep link to /history', async () => {
    window.history.replaceState(null, '', '/history')
    setup()
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument()
  })

  it('moves between setup and History with the navigation, updating the URL', async () => {
    setup()
    await screen.findByRole('heading', { name: 'I Need To Focus' })
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/history')
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('follows the back button between setup and History', async () => {
    setup()
    await screen.findByRole('heading', { name: 'I Need To Focus' })
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    act(() => {
      window.history.back()
    })
    expect(await screen.findByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
  })

  it('opens History from the summary link without reloading', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    fireEvent.click(await screen.findByRole('link', { name: 'View history' }))
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/history')
  })
})
