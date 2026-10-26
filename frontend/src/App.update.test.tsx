import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { hasOpenEdit } from './update/autoUpdate.ts'
import { holdsMemoryOnlyData, isViewBusy } from './update/idle.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import {
  MemoryActiveSessionStore,
  TimerController,
  type ActiveSessionStore,
} from './timer/index.ts'

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
    await screen.findByRole('heading', { name: 'I Need To Focus' })
    await waitFor(() => expect(isViewBusy()).toBe(false))
  })

  it('a goal typed on the setup screen holds the update', async () => {
    renderApp()
    const goal = await screen.findByLabelText(/what are you focusing on/i)
    expect(hasOpenEdit()).toBe(false)
    fireEvent.change(goal, { target: { value: 'Write the report' } })
    expect(hasOpenEdit()).toBe(true)
    fireEvent.change(goal, { target: { value: '' } })
    expect(hasOpenEdit()).toBe(false)
  })

  it('a duration typed on the setup screen holds the update after the field loses focus', async () => {
    renderApp()
    const minutes = await screen.findByLabelText(/minutes|duration/i)
    minutes.focus()
    fireEvent.change(minutes, { target: { value: '45' } })
    minutes.blur()
    expect(document.activeElement).not.toBe(minutes)
    expect(hasOpenEdit()).toBe(true)
    fireEvent.change(minutes, { target: { value: '25' } })
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
    const { store, state } = failingStore()
    const controller = new TimerController({ store, saveRecord: () => undefined })
    render(<App controller={controller} preferences={new MemoryPreferencesStore()} />)
    await screen.findByRole('button', { name: 'Start' })
    expect(holdsMemoryOnlyData()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(controller.hasUnsaved()).toBe(true)
    expect(controller.holdsRecord()).toBe(false)
    expect(holdsMemoryOnlyData()).toBe(true)

    state.failing = false // the next tick writes it
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
