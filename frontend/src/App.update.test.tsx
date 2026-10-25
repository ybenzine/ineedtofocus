import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'
import { hasOpenEdit } from './update/autoUpdate.ts'
import { isViewBusy } from './update/idle.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

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
