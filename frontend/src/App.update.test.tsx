import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { hasOpenEdit } from './update/autoUpdate.ts'
import { holdsMemoryOnlyData, isViewBusy } from './update/idle.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { typeDuration, typeGoal } from './test/setupUi.ts'
import {
  DEFAULT_POMODORO,
  MemoryActiveSessionStore,
  TimerController,
  type ActiveSessionStore,
} from './timer/index.ts'

// Screens change the URL; the next test starts on New session.
afterEach(() => window.history.replaceState(null, '', '/'))

function renderApp() {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  render(<App controller={controller} preferences={new MemoryPreferencesStore()} />)
}

// What the updater (#244) is told: the app is idle only on setup, History, Archive and Settings.
describe('App tells the updater when it is idle', () => {
  it('busy on the timer and the summary, idle on the screens around them', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    await waitFor(() => expect(isViewBusy()).toBe(false))

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    await waitFor(() => expect(isViewBusy()).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByRole('heading', { name: 'Session not saved' })
    await waitFor(() => expect(isViewBusy()).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await screen.findByRole('button', { name: 'Start' })
    await waitFor(() => expect(isViewBusy()).toBe(false))
  })

  it('a goal typed on the setup screen holds the update', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    expect(hasOpenEdit()).toBe(false)
    typeGoal('Write the report')
    expect(hasOpenEdit()).toBe(true)
    typeGoal('')
    expect(hasOpenEdit()).toBe(false)
  })

  it('a duration typed on the setup screen holds the update after the field loses focus', async () => {
    renderApp()
    const minutes = await screen.findByLabelText('Duration in minutes, 1 to 240')
    minutes.focus()
    fireEvent.change(minutes, { target: { value: '45' } })
    minutes.blur()
    expect(document.activeElement).not.toBe(minutes)
    expect(hasOpenEdit()).toBe(true)
    // Back to the 30 a new setup begins with: nothing to lose.
    fireEvent.change(minutes, { target: { value: '30' } })
    expect(hasOpenEdit()).toBe(false)
  })

  it('a changed setup that is kept holds the update on every other screen (AC2.6, AC8.8)', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    typeDuration('45')
    for (const screenName of ['History', 'Archive', 'Settings']) {
      fireEvent.click(screen.getByRole('button', { name: screenName }))
      await screen.findByRole('heading', { name: screenName })
      expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
      expect(hasOpenEdit(), screenName).toBe(true)
    }
    // Back to what it began with: the hold is gone, on the same screen.
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(screen.getByLabelText('Duration in minutes, 1 to 240')).toHaveValue('45')
    typeDuration('30')
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    expect(hasOpenEdit()).toBe(false)
  })

  it('a setup nobody touched does not hold the update, even after a default changes', async () => {
    const preferences = new MemoryPreferencesStore()
    const controller = new TimerController({
      store: new MemoryActiveSessionStore(),
      saveRecord: () => undefined,
    })
    const { rerender } = render(<App controller={controller} preferences={preferences} />)
    await screen.findByRole('button', { name: 'Start' })
    preferences.save({ tag: 'study', pomodoro: { ...DEFAULT_POMODORO, focusMinutes: 40 } })
    rerender(<App controller={controller} preferences={preferences} />)
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    expect(hasOpenEdit()).toBe(false)
  })
})

// App registers `timer.hasUnsaved() || timer.holdsRecord()` with the updater (#245, #286): a tab
// holding either must not be reloaded, and must stop holding once the data is on the device.
describe('App tells the updater when the tab holds data only in memory', () => {
  afterEach(() => vi.useRealTimers())

  /** A store whose writes throw while `state.failing` is set. */
  function failingStore() {
    const inner = new MemoryActiveSessionStore()
    const state = { failing: true }
    const store: ActiveSessionStore = {
      load: () => inner.load(),
      clear: () => inner.clear(),
      save(value) {
        if (state.failing) throw new Error('QuotaExceededError')
        inner.save(value)
      },
    }
    return { store, state }
  }

  it('a timer that exists only in memory holds the update until it reaches the device', async () => {
    const { store } = failingStore()
    const controller = new TimerController({ store, saveRecord: () => undefined })
    const { unmount } = render(
      <App controller={controller} preferences={new MemoryPreferencesStore()} />,
    )
    await screen.findByRole('button', { name: 'Start' })
    expect(holdsMemoryOnlyData()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(controller.hasUnsaved()).toBe(true)
    expect(controller.holdsRecord()).toBe(false)
    expect(holdsMemoryOnlyData()).toBe(true)

    // Unmounting unregisters the holder, even while the timer is still memory-only.
    unmount()
    expect(controller.hasUnsaved()).toBe(true)
    expect(holdsMemoryOnlyData()).toBe(false)
  })

  it('a memory-only timer lets go once the next tick writes it', async () => {
    const { store, state } = failingStore()
    const controller = new TimerController({ store, saveRecord: () => undefined })
    render(<App controller={controller} preferences={new MemoryPreferencesStore()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(holdsMemoryOnlyData()).toBe(true)

    // The next tick: TimerScreen's TICK_MS interval retries the write (#refresh/#writeUnsaved).
    state.failing = false
    await waitFor(() => expect(holdsMemoryOnlyData()).toBe(false), { timeout: 3000 })
  })

  it('a finished record held only in memory holds the update until it is handed over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { store, state } = failingStore()
    let failSave = true
    const saved: string[] = []
    const controller = new TimerController({
      store,
      saveRecord: (record) => {
        if (failSave) throw new Error('IndexedDB unavailable')
        saved.push(record.id)
      },
    })
    render(
      <App
        controller={controller}
        preferences={new MemoryPreferencesStore()}
        pendingRetryMs={20}
      />,
    )
    await screen.findByRole('button', { name: 'Start' })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    vi.setSystemTime(Date.now() + 5 * 60_000)

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(controller.holdsRecord()).toBe(true))
    expect(controller.hasUnsaved()).toBe(false) // only the record is held, not the timer
    expect(holdsMemoryOnlyData()).toBe(true)

    failSave = false
    state.failing = false
    await waitFor(() => expect(saved).toHaveLength(1), { timeout: 3000 })
    await waitFor(() => expect(holdsMemoryOnlyData()).toBe(false))
    expect(controller.holdsRecord()).toBe(false)
  })
})
