import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { pathForScreen, screenFromPath } from './nav/screens.ts'
import { SettingsStore } from './settings/store.ts'
import { MemoryActiveSessionStore, TimerController } from './timer/index.ts'

function renderApp() {
  const controller = new TimerController({
    store: new MemoryActiveSessionStore(),
    saveRecord: () => undefined,
  })
  render(<App controller={controller} settings={new SettingsStore()} />)
}

afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

describe('the Archive screen in the app', () => {
  it('has a URL', () => {
    expect(pathForScreen('archive')).toBe('/archive')
    expect(screenFromPath('/archive')).toBe('archive')
    expect(screenFromPath('/archive/')).toBe('archive')
  })

  it('opens from the navigation, keeps sign out in reach, and goes back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
    )
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/archive')
    expect(await screen.findByText('No archived sessions.')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Screens' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('opens from a deep link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 })),
    )
    window.history.replaceState(null, '', '/archive')
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Archive' })).toBeInTheDocument()
  })
})
