import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthError, type AuthApi, type User } from './api.ts'
import AuthGate from './AuthGate.tsx'

const user: User = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }

function makeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(user),
    signIn: vi.fn().mockResolvedValue(user),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderGate(api: AuthApi) {
  return render(
    <AuthGate api={api}>
      <p>the timer app</p>
    </AuthGate>,
  )
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
}

afterEach(() => localStorage.clear())

describe('AuthGate', () => {
  it('sends a signed-out user to sign in', async () => {
    renderGate(makeApi())
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText('the timer app')).not.toBeInTheDocument()
  })

  it('lands a signed-in user on the app', async () => {
    renderGate(makeApi({ me: vi.fn().mockResolvedValue(user) }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
    expect(screen.getByText('a@b.co')).toBeInTheDocument()
  })

  it('opens the app offline for a remembered user', async () => {
    localStorage.setItem('intf.user', JSON.stringify(user))
    const offline = new AuthError('network', 'offline')
    renderGate(makeApi({ me: vi.fn().mockRejectedValue(offline) }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
  })

  it('shows sign-in when offline with no remembered user', async () => {
    const offline = new AuthError('network', 'offline')
    renderGate(makeApi({ me: vi.fn().mockRejectedValue(offline) }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('validates inline without calling the server', async () => {
    const api = makeApi()
    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('not-an-email', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
    expect(screen.getByText('Use a password of 8 to 128 characters.')).toBeInTheDocument()
    expect(api.signIn).not.toHaveBeenCalled()
  })

  it('rejects a password over 128 characters', async () => {
    const api = makeApi()
    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'x'.repeat(129))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Use a password of 8 to 128 characters.')).toBeInTheDocument()
    expect(api.signIn).not.toHaveBeenCalled()
  })

  it('signs in with the trimmed email and shows the app', async () => {
    const api = makeApi()
    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('  a@b.co ', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
    expect(api.signIn).toHaveBeenCalledWith('a@b.co', 'password1')
  })

  it('shows the generic message for a wrong email or password', async () => {
    const error = new AuthError('invalid', 'Incorrect email or password.')
    renderGate(makeApi({ signIn: vi.fn().mockRejectedValue(error) }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Incorrect email or password.')).toBeInTheDocument()
  })

  it('shows the Retry-After wait when locked out', async () => {
    const error = new AuthError('rate_limited', 'Too many attempts.', 421)
    renderGate(makeApi({ signIn: vi.fn().mockRejectedValue(error) }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(
      await screen.findByText('Too many attempts. Try again in 8 minutes.'),
    ).toBeInTheDocument()
  })

  it('signs up (which signs in) and shows a duplicate-email error on the email field', async () => {
    const duplicate = new AuthError('duplicate', 'An account with this email already exists.')
    const api = makeApi({
      signUp: vi.fn().mockRejectedValueOnce(duplicate).mockResolvedValue(user),
    })
    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }))
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(
      await screen.findByText('An account with this email already exists.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
  })

  it('signs out and clears local user data from the device', async () => {
    const api = makeApi({ me: vi.fn().mockResolvedValue(user) })
    renderGate(api)
    await screen.findByText('the timer app')
    localStorage.setItem('intf.setup.preferences', '{"goal":"secret"}')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(api.signOut).toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
  })

  it('keeps the user signed in and says so when sign-out fails', async () => {
    const api = makeApi({
      me: vi.fn().mockResolvedValue(user),
      signOut: vi.fn().mockRejectedValue(new AuthError('network', 'offline')),
    })
    renderGate(api)
    await screen.findByText('the timer app')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign out")
    expect(screen.getByText('the timer app')).toBeInTheDocument()
  })

  // AC1.4: a second device signs in and gets the same account's data from the server.
  // The real two-browser e2e arrives with Playwright (#23); this models two devices with
  // separate local storage against one fake server.
  it('signs in on a second device as the same account', async () => {
    const server = { user }
    const api = makeApi({
      signIn: vi.fn().mockImplementation(() => Promise.resolve(server.user)),
    })
    const first = renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('the timer app')
    first.unmount()
    localStorage.clear() // a different device has its own storage

    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(screen.getByText('a@b.co')).toBeInTheDocument())
    expect(api.signIn).toHaveBeenCalledTimes(2)
  })
})
