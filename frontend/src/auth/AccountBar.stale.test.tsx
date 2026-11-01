import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signOutButton } from '../test/accountMenu.ts'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import AccountBar from './AccountBar.tsx'
import { AccountContext } from './AccountContext.tsx'
import { registerLocalDataHook } from './localData.ts'

afterEach(() => localStorage.clear())

describe('closing the menu during the sign-out sync (#406)', () => {
  it('leaves no stale confirmation and does not sign out', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const unregister = registerLocalDataHook({
      trySync: () => gate,
      countUnsynced: vi.fn().mockResolvedValue({ sessions: 2, edits: 0 }),
      clear: vi.fn().mockResolvedValue(undefined),
    })
    const signOut = vi.fn().mockResolvedValue(null)
    const controller = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => Promise.resolve(),
    })
    const user = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }
    render(
      <AccountContext.Provider
        value={{
          user,
          expired: false,
          leaveExpired: () => undefined,
          signOut,
          accountDeleted: async () => undefined,
        }}
      >
        <AccountBar controller={controller} />
      </AccountContext.Provider>,
    )
    fireEvent.click(signOutButton())
    // The sync is still running: close the menu with its button, then let the sync finish.
    fireEvent.click(screen.getByRole('button', { name: 'a@b.co' }))
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    fireEvent.click(screen.getByRole('button', { name: 'a@b.co' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(signOut).not.toHaveBeenCalled()
    unregister()
  })
})
