import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { OWNER_KEY, USER_KEY } from './auth/localData.ts'
import { createAppServices, type AppServices } from './services.ts'
import { SettingsStore } from './settings/store.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { OwnedActiveSessionStore } from './sync/index.ts'
import { LocalActiveSessionStore, TimerController } from './timer/index.ts'

const ALICE = 'user-alice'
const BOB = 'user-bob'

afterEach(() => {
  vi.useRealTimers()
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
