// The New session setup kept above the screen (#407, AC2.6, AC7.10).

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import App from './App.tsx'
import { hasOpenEdit } from './update/autoUpdate.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import {
  chooseMode,
  openSheet,
  pickSound,
  pickTag,
  typeDuration,
  typeGoal,
} from './test/setupUi.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

function renderApp(preferences = new MemoryPreferencesStore()) {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  render(<App controller={controller} preferences={preferences} />)
}

afterEach(() => window.history.replaceState(null, '', '/'))

const duration = () => screen.getByLabelText('Duration in minutes, 1 to 240')

async function goAndBack(screenName: string) {
  fireEvent.click(screen.getByRole('button', { name: screenName }))
  await screen.findByRole('heading', { name: screenName })
  fireEvent.click(screen.getByRole('button', { name: 'New session' }))
  await screen.findByRole('button', { name: 'Start' })
}

describe('a setup in progress', () => {
  it('survives a trip to Settings and back: mode, lengths, reminder, tag, goal and sound', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    typeDuration('45')
    typeGoal('Write the report')
    pickTag('Study')
    pickSound('Rain')
    chooseMode('Pomodoro')
    fireEvent.click(screen.getByRole('button', { name: 'Focus, 5 minutes more' }))
    chooseMode('Unlimited')
    fireEvent.click(screen.getByRole('radio', { name: '45 minutes' }))

    await goAndBack('Settings')

    expect(screen.getByRole('radio', { name: 'Unlimited' })).toBeChecked()
    expect(screen.getByRole('radio', { name: '45 minutes' })).toBeChecked()
    expect(screen.getByRole('button', { name: /^Goal\b.*Write the report/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Tag\b.*Study/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sound\b.*Rain/ })).toBeInTheDocument()
    chooseMode('Pomodoro')
    expect(screen.getByLabelText('Focus length in minutes, 5 to 90')).toHaveValue('30')
    chooseMode('Countdown')
    expect(duration()).toHaveValue('45')
  })

  it('survives Manage tags → Settings → back, and does not select a tag just made there', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    typeGoal('Keep me')
    typeDuration('50')
    const sheet = openSheet('Tag')
    fireEvent.click(within(sheet).getByRole('link', { name: 'Manage tags' }))
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(duration()).toHaveValue('50')
    expect(screen.getByRole('button', { name: /^Goal\b.*Keep me/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Tag\b.*Work/ })).toBeInTheDocument()
  })

  it('keeps the setup through the browser’s Back, too', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    typeDuration('70')
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    window.history.back()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument())
    expect(duration()).toHaveValue('70')
  })

  it('is a new one after a session: back to 30, no goal, the remembered tag', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    typeDuration('45')
    typeGoal('One-off')
    pickTag('Nap')
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByRole('heading', { name: 'Session not saved' })
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(duration()).toHaveValue('30')
    expect(screen.getByRole('button', { name: /^Goal\b.*Add a goal/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sound\b.*None/ })).toBeInTheDocument()
    // The tag is the remembered one: the last used.
    expect(screen.getByRole('button', { name: /^Tag\b.*Nap/ })).toBeInTheDocument()
  })

  it('opens Unlimited on Off and the tag on Work for a new user', async () => {
    const preferences = new MemoryPreferencesStore()
    renderApp(preferences)
    await screen.findByRole('button', { name: 'Start' })
    chooseMode('Unlimited')
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked()
    expect(screen.getByRole('button', { name: /^Tag\b.*Work/ })).toBeInTheDocument()
  })

  it('begins the next setup from what the session saved, so repeating it is no change', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    chooseMode('Pomodoro')
    fireEvent.change(screen.getByLabelText('Focus length in minutes, 5 to 90'), {
      target: { value: '35' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await screen.findByRole('heading', { name: 'Session not saved' })
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await screen.findByRole('button', { name: 'Start' })

    // The new setup shows the saved 35. Typing 35 again changes nothing from where it began...
    chooseMode('Pomodoro')
    const focus = () => screen.getByLabelText('Focus length in minutes, 5 to 90')
    expect(focus()).toHaveValue('35')
    fireEvent.change(focus(), { target: { value: '35' } })
    chooseMode('Countdown')
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    expect(hasOpenEdit()).toBe(false)
    // ...and typing 40 does.
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    chooseMode('Pomodoro')
    fireEvent.change(focus(), { target: { value: '40' } })
    chooseMode('Countdown')
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    expect(hasOpenEdit()).toBe(true)
  })
})
