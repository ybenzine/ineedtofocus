import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountError, type AccountApi } from './accountApi.ts'
import AccountSection from './AccountSection.tsx'
import { type AuthApi, type User } from './api.ts'
import AuthGate from './AuthGate.tsx'
import type { ResetApi } from './resetApi.ts'

const user: User = { id: 'u1', email: 'a@b.co', created_at: '2026-11-06T00:00:00Z' }
const OFFER = 'Forgot your password? Reset it by email.'

function makeAccountApi(error: AccountError): AccountApi {
  return {
    exportData: vi.fn(),
    deleteAccount: vi.fn().mockRejectedValue(error),
    sessionCount: vi.fn().mockResolvedValue(3),
  }
}

function makeAuthApi(): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(user),
    signUp: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
  }
}

function makeReset(available: boolean | 'fails'): ResetApi {
  return {
    // The real API turns a failed call into false.
    available: vi.fn().mockResolvedValue(available === true),
    request: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn(),
  }
}

async function tryDeleting(error: AccountError, reset: ResetApi, auth = makeAuthApi()) {
  render(
    <AuthGate api={auth} resetApi={reset}>
      <AccountSection api={makeAccountApi(error)} />
    </AuthGate>,
  )
  await screen.findByRole('heading', { name: 'Account' })
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
  const dialog = screen.getByRole('dialog', { name: 'Confirm delete account' })
  fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
  // Reset availability is asked when the confirmation opens.
  await vi.waitFor(() => expect(reset.available).toHaveBeenCalled())
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }))
  return { dialog, auth }
}

beforeEach(() => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('delete account offers a reset by email (AC9)', () => {
  it.each([
    ['Incorrect password', new AccountError('forbidden')],
    ['Too many attempts. Try again in 2 minutes.', new AccountError('rate_limited', 100)],
  ])('under "%s", as one link', async (message, error) => {
    const { dialog } = await tryDeleting(error, makeReset(true))
    expect(await within(dialog).findByText(message)).toBeVisible()
    const link = await within(dialog).findByRole('link', { name: OFFER })
    expect(link.textContent).toBe(OFFER)
  })

  it('opens the request form with the account email, without signing out', async () => {
    const { dialog, auth } = await tryDeleting(new AccountError('forbidden'), makeReset(true))
    fireEvent.click(await within(dialog).findByRole('link', { name: OFFER }))
    expect(await screen.findByLabelText('Email')).toHaveValue(user.email)
    expect(auth.signOut).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/forgot-password')
  })

  it.each([
    ['off', false as const],
    ['failing', 'fails' as const],
  ])('is not shown when reset is %s, and the message stays', async (_name, available) => {
    const { dialog } = await tryDeleting(new AccountError('forbidden'), makeReset(available))
    expect(await within(dialog).findByText('Incorrect password')).toBeVisible()
    expect(within(dialog).queryByRole('link', { name: OFFER })).not.toBeInTheDocument()
  })

  it('is not shown under other errors', async () => {
    const { dialog } = await tryDeleting(new AccountError('server'), makeReset(true))
    expect(await within(dialog).findByText(/The server is having trouble/)).toBeVisible()
    expect(within(dialog).queryByRole('link', { name: OFFER })).not.toBeInTheDocument()
  })
})
