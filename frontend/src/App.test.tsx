import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

function setup() {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  render(<App controller={controller} preferences={new MemoryPreferencesStore()} />)
  return controller
}

describe('App', () => {
  it('shows the setup screen', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'I Need To Focus' })).toBeInTheDocument()
  })

  it('starts a session through the controller and hands off to the timer placeholder', async () => {
    const controller = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(await screen.findByRole('heading', { name: 'Session started' })).toBeInTheDocument()
    expect(controller.current()?.config).toEqual({ mode: 'countdown', minutes: 25 })
  })
})
