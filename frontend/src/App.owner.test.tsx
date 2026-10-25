import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App, { FOREIGN_PENDING_MESSAGE } from './App.tsx'
import { OWNER_KEY, USER_KEY } from './auth/localData.ts'
import { createAppServices, type AppServices } from './services.ts'
import { SettingsStore } from './settings/store.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { IndexedDbSessionStore, OwnedActiveSessionStore } from './sync/index.ts'
import { ACTIVE_SESSION_KEY, LocalActiveSessionStore, TimerController } from './timer/index.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'

afterEach(async () => {
  vi.useRealTimers()
  // The device database is shared by the tests in this file.
  const store = new IndexedDbSessionStore()
  await store.clearOwner(ALICE)
  await store.clearOwner(BOB)
  store.close()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

/** Alice's finished session that couldn't be handed over: it stays in the timer's store. */
async function alicesUnsavedSession() {
  localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
  localStorage.setItem(OWNER_KEY, ALICE)
  // A session under a minute is discarded as too short, so the clock moves.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 23, 9, 0))
  const controller = new TimerController({
    store: new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => ALICE),
    saveRecord: () => Promise.reject(new Error('IndexedDB down')),
  })
  await controller.start({
    config: { mode: 'countdown', minutes: 25 },
    tag: 'work',
    goal: 'secret goal',
  })
  vi.setSystemTime(Date.UTC(2026, 9, 23, 9, 10))
  await controller.stop()
  vi.useRealTimers()
}

/** Alice's countdown, started with the clock at `startAt`; it stays in the timer's store. */
async function alicesSession(startAt: number, goal = 'secret goal') {
  localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
  localStorage.setItem(OWNER_KEY, ALICE)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(startAt)
  const controller = new TimerController({
    store: new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => ALICE),
    saveRecord: () => undefined,
  })
  await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal })
}

const NINE = Date.UTC(2026, 9, 23, 9, 0)

function renderApp(services: AppServices) {
  return render(
    <App
      services={services}
      settings={new SettingsStore()}
      preferences={new MemoryPreferencesStore()}
    />,
  )
}

describe('a previous owner’s summary (AC1)', () => {
  it('is not shown to a different signed-in user, and the record stays under its owner', async () => {
    await alicesUnsavedSession()
    const services = createAppServices(() => BOB)
    renderApp(services)
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(/secret goal/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Session ended early' })).not.toBeInTheDocument()

    await vi.waitFor(async () => expect(await services.sessions?.list(ALICE)).toHaveLength(1))
    expect(await services.sessions?.list(BOB)).toEqual([])
  })

  it('is shown to the same user', async () => {
    await alicesUnsavedSession()
    renderApp(createAppServices(() => ALICE))
    expect(await screen.findByRole('heading', { name: 'Session ended early' })).toBeInTheDocument()
  })

  it('is not hidden while the sign-in is expired (no user is signed in)', async () => {
    await alicesUnsavedSession()
    expect(createAppServices(() => null).isForeignSession?.()).toBe(false)
    expect(createAppServices(() => BOB).isForeignSession?.()).toBe(true)
  })
})

describe('a session that ended while the app was closed (AC6.5)', () => {
  it('under a foreign owner is handed over under its owner and its summary is not shown', async () => {
    await alicesSession(NINE)
    vi.setSystemTime(NINE + 40 * 60_000) // 15 minutes past its end
    const services = createAppServices(() => BOB)
    expect(services.isForeignSession?.()).toBe(true)
    renderApp(services)
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(/secret goal/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Session complete' })).not.toBeInTheDocument()
    await vi.waitFor(async () => expect(await services.sessions?.list(ALICE)).toHaveLength(1))
    expect(await services.sessions?.list(BOB)).toEqual([])
  })

  it('under the same user still shows the summary', async () => {
    await alicesSession(NINE)
    vi.setSystemTime(NINE + 40 * 60_000)
    renderApp(createAppServices(() => ALICE))
    expect(await screen.findByRole('heading', { name: 'Session complete' })).toBeInTheDocument()
  })
})

describe('a running session of a different user (AC2)', () => {
  it('never renders on the timer screen', async () => {
    await alicesSession(NINE)
    vi.setSystemTime(NINE + 5 * 60_000)
    const services = createAppServices(() => BOB)
    renderApp(services)
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(/secret goal/)).not.toBeInTheDocument()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(await services.sessions?.list(BOB)).toEqual([])
  })

  it('stays for the same user', async () => {
    await alicesSession(NINE)
    vi.setSystemTime(NINE + 5 * 60_000)
    renderApp(createAppServices(() => ALICE))
    expect(await screen.findByText(/secret goal/)).toBeInTheDocument()
  })

  it('stays when the sign-in has expired (nobody is signed in, AC1.3)', async () => {
    await alicesSession(NINE)
    vi.setSystemTime(NINE + 5 * 60_000)
    renderApp(createAppServices(() => null))
    expect(await screen.findByText(/secret goal/)).toBeInTheDocument()
  })
})

describe('a foreign session that cannot be saved yet (AC3)', () => {
  it('is retried in the background and the new user is told', async () => {
    await alicesUnsavedSession()
    const services = createAppServices(() => BOB)
    const sessions = services.sessions!
    const save = sessions.save.bind(sessions)
    let failing = true
    vi.spyOn(sessions, 'save').mockImplementation((record, owner) =>
      failing ? Promise.reject(new Error('IndexedDB down')) : save(record, owner),
    )
    render(
      <App
        services={services}
        settings={new SettingsStore()}
        preferences={new MemoryPreferencesStore()}
        pendingRetryMs={50}
      />,
    )
    expect(await screen.findByText(FOREIGN_PENDING_MESSAGE)).toBeInTheDocument()
    expect(screen.queryByText(/secret goal/)).not.toBeInTheDocument()

    failing = false
    await vi.waitFor(async () => expect(await sessions.list(ALICE)).toHaveLength(1))
    await vi.waitFor(() => expect(screen.queryByText(FOREIGN_PENDING_MESSAGE)).toBeNull())
    expect(await sessions.list(BOB)).toEqual([])
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
  })

  it('Start explains why it waits instead of the bare "has not been saved yet"', async () => {
    await alicesUnsavedSession()
    const services = createAppServices(() => BOB)
    vi.spyOn(services.sessions!, 'save').mockRejectedValue(new Error('IndexedDB down'))
    renderApp(services)
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/still being saved on this device/)
  })
})

describe('parked sessions while the app is open (AC2)', () => {
  it('a pass runs on a timer', async () => {
    localStorage.setItem(USER_KEY, JSON.stringify({ id: ALICE, email: 'a@example.com' }))
    localStorage.setItem(OWNER_KEY, ALICE)
    const drainParked = vi.fn().mockResolvedValue(undefined)
    const controller = new TimerController({
      store: new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => ALICE),
      saveRecord: () => undefined,
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    render(
      <App
        services={{ controller, sync: null, hook: null, drainParked }}
        settings={new SettingsStore()}
        preferences={new MemoryPreferencesStore()}
        parkedDrainMs={1000}
      />,
    )
    await act(() => vi.advanceTimersByTimeAsync(3500))
    expect(drainParked).toHaveBeenCalledTimes(3)
  })
})
