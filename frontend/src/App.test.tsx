import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App.tsx'
import { AccountContext } from './auth/AccountContext.tsx'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { ACTIVE_SESSION_KEY, MemoryActiveSessionStore, TimerController } from './timer/index.ts'

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
    signOutError: '',
    signOut: () => Promise.resolve(),
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
})
