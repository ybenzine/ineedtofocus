import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import AccountBar from './AccountBar.tsx'
import { AccountContext } from './AccountContext.tsx'
import { registerLocalDataHook } from './localData.ts'

afterEach(() => localStorage.clear())

describe('sign-out confirmation keyboard use (#151)', () => {
  it('closes on Escape and returns focus to Sign out', async () => {
    const unregister = registerLocalDataHook({
      trySync: vi.fn().mockResolvedValue(undefined),
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
      <AccountContext.Provider value={{ user, signOut }}>
        <AccountBar controller={controller} />
      </AccountContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const cancel = await screen.findByRole('button', { name: 'Cancel' })
    await waitFor(() => expect(cancel).toHaveFocus())

    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveFocus()
    expect(signOut).not.toHaveBeenCalled()
    unregister()
  })
})
