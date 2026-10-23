import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_KEY } from '../settings/store.ts'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import { ACTIVE_SESSION_KEY } from '../timer/store.ts'
import AccountBar from './AccountBar.tsx'
import { AuthError, type AuthApi, type User } from './api.ts'
import AuthGate, { OFFLINE_SIGN_OUT_NOTICE } from './AuthGate.tsx'
import {
  OWNER_KEY,
  PENDING_LOGOUT_KEY,
  USER_KEY,
  registerLocalDataHook,
  type LocalDataHook,
} from './localData.ts'

const user: User = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }
const other: User = { id: 'u2', email: 'c@d.co', created_at: '2026-10-23T00:00:00Z' }
const offline = new AuthError('network', 'offline')

function makeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(user),
    signIn: vi.fn().mockResolvedValue(user),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeController(saveRecord: () => Promise<void> = () => Promise.resolve()) {
  let now = 1_700_000_000_000
  const controller = new TimerController({
    store: new LocalActiveSessionStore(),
    saveRecord,
    now: () => now,
  })
  return { controller, advance: (ms: number) => (now += ms) }
}

/** A finished session that `saveRecord` refused: it stays as `pendingRecord`. */
async function pendingSession() {
  const { controller, advance } = makeController(() => Promise.reject(new Error('store down')))
  await controller.start({
    config: { mode: 'countdown', minutes: 25 },
    tag: 'work',
    goal: 'secret',
  })
  advance(120_000)
  await controller.stop()
  return controller
}

function renderGate(api: AuthApi, controller = makeController().controller) {
  return render(
    <AuthGate api={api}>
      <AccountBar controller={controller} />
      <p>the timer app</p>
    </AuthGate>,
  )
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
}

function seedUserData() {
  localStorage.setItem(SETTINGS_KEY, '{"tag":"work"}')
  localStorage.setItem('someone.elses.key', 'keep me')
}

afterEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

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
    localStorage.setItem(USER_KEY, JSON.stringify(user))
    renderGate(makeApi({ me: vi.fn().mockRejectedValue(offline) }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
  })

  it('opens the app for a remembered user when the server returns an error', async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
    const down = new AuthError('server', 'down')
    renderGate(makeApi({ me: vi.fn().mockRejectedValue(down) }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
  })

  it('shows sign-in when offline with no remembered user', async () => {
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

  it('moves focus to the first invalid field and links the password hint', async () => {
    renderGate(makeApi())
    await screen.findByRole('heading', { name: 'Sign in' })
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }))
    expect(screen.getByRole('heading', { name: 'Create your account' })).toHaveFocus()
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'password-hint')
    fill('a@b.co', 'short')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus())
    fill('nope', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveFocus())
  })

  it('signs out other tabs when the remembered user is removed', async () => {
    renderGate(makeApi({ me: vi.fn().mockResolvedValue(user) }))
    await screen.findByText('the timer app')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: USER_KEY, newValue: null }))
    })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  // AC1.4 e2e moved to #23; this models two devices (separate storage) with one account.
  it('signs in on a second device as the same account', async () => {
    const api = makeApi()
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

describe('sign out', () => {
  async function signedIn(api: AuthApi, controller?: TimerController) {
    renderGate(api, controller)
    await screen.findByText('the timer app')
  }

  it('clears only the app-owned data, not other keys', async () => {
    const api = makeApi({ me: vi.fn().mockResolvedValue(user) })
    await signedIn(api)
    seedUserData()
    sessionStorage.setItem('anything', 'x')
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(api.signOut).toHaveBeenCalled()
    for (const key of [SETTINGS_KEY, USER_KEY, OWNER_KEY]) {
      expect(localStorage.getItem(key)).toBeNull()
    }
    expect(localStorage.getItem('someone.elses.key')).toBe('keep me')
    expect(sessionStorage.getItem('anything')).toBe('x')
  })

  it('runs registered hooks: try to sync, count, then clear', async () => {
    const hook: LocalDataHook = {
      trySync: vi.fn().mockResolvedValue(undefined),
      countUnsynced: vi.fn().mockResolvedValue(0),
      clear: vi.fn().mockResolvedValue(undefined),
    }
    const unregister = registerLocalDataHook(hook)
    await signedIn(makeApi({ me: vi.fn().mockResolvedValue(user) }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(hook.trySync).toHaveBeenCalled()
    expect(hook.clear).toHaveBeenCalled()
    unregister()
  })

  it('asks before deleting what a registered hook reports as unsynced', async () => {
    const hook: LocalDataHook = {
      trySync: vi.fn().mockResolvedValue(undefined),
      countUnsynced: vi.fn().mockResolvedValue(3),
      clear: vi.fn().mockResolvedValue(undefined),
    }
    const unregister = registerLocalDataHook(hook)
    await signedIn(makeApi({ me: vi.fn().mockResolvedValue(user) }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText(/3 finished sessions haven't been saved/)).toBeInTheDocument()
    expect(hook.clear).not.toHaveBeenCalled()
    unregister()
  })

  it('refuses while a timer is running and clears nothing', async () => {
    const { controller } = makeController()
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    const api = makeApi({ me: vi.fn().mockResolvedValue(user) })
    await signedIn(api, controller)
    seedUserData()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End your session before signing out.',
    )
    expect(api.signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull()
    expect(screen.getByText('the timer app')).toBeInTheDocument()
  })

  it('confirms with Cancel as the default when a finished session is still unsaved', async () => {
    const controller = await pendingSession()
    const api = makeApi({ me: vi.fn().mockResolvedValue(user) })
    await signedIn(api, controller)
    seedUserData()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(
      await screen.findByText(
        "1 finished session hasn't been saved and will be deleted from this device.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.signOut).not.toHaveBeenCalled()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out anyway' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem('someone.elses.key')).toBe('keep me')
  })

  it('does not ask when the unsaved session is delivered by the retry', async () => {
    let fail = true
    const { controller, advance } = makeController(() =>
      fail ? Promise.reject(new Error('down')) : Promise.resolve(),
    )
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    advance(120_000)
    await controller.stop()
    fail = false
    await signedIn(makeApi({ me: vi.fn().mockResolvedValue(user) }), controller)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('keeps the user signed in with a message when the server fails', async () => {
    const api = makeApi({
      me: vi.fn().mockResolvedValue(user),
      signOut: vi.fn().mockRejectedValue(new AuthError('server', 'down')),
    })
    await signedIn(api)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't sign out. Try again.")
    expect(screen.getByText('the timer app')).toBeInTheDocument()
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull()
  })
})

describe('offline sign out', () => {
  it('clears data, sets the marker and explains', async () => {
    const api = makeApi({
      me: vi.fn().mockResolvedValue(user),
      signOut: vi.fn().mockRejectedValue(offline),
    })
    renderGate(api)
    await screen.findByText('the timer app')
    seedUserData()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText(OFFLINE_SIGN_OUT_NOTICE)).toBeInTheDocument()
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).not.toBeNull()
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(localStorage.getItem('someone.elses.key')).toBe('keep me')
  })

  it('with the marker set, start-up skips /me, shows sign-in and tries the logout', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
    const api = makeApi({
      me: vi.fn().mockResolvedValue(user),
      signOut: vi.fn().mockRejectedValue(offline),
    })
    renderGate(api)
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(api.me).not.toHaveBeenCalled()
    await waitFor(() => expect(api.signOut).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).not.toBeNull()
    expect(screen.getByText(OFFLINE_SIGN_OUT_NOTICE)).toBeInTheDocument()
  })

  it('removes the marker once the logout succeeds', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
    const api = makeApi()
    renderGate(api)
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull())
    expect(screen.queryByText(OFFLINE_SIGN_OUT_NOTICE)).not.toBeInTheDocument()
  })

  it('keeps the marker after a 5xx and retries when the device comes online', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
    const signOut = vi
      .fn()
      .mockRejectedValueOnce(new AuthError('server', 'down'))
      .mockResolvedValue(undefined)
    renderGate(makeApi({ signOut }))
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).not.toBeNull()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    await waitFor(() => expect(localStorage.getItem(PENDING_LOGOUT_KEY)).toBeNull())
    expect(signOut).toHaveBeenCalledTimes(2)
  })

  it('runs the queued logout before a sign-in request, and blocks sign-in while it fails', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
    const order: string[] = []
    const signOut = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push('logout')
        return Promise.reject(offline)
      })
      .mockImplementationOnce(() => {
        order.push('logout')
        return Promise.reject(offline)
      })
      .mockImplementation(() => {
        order.push('logout')
        return Promise.resolve()
      })
    const signIn = vi.fn().mockImplementation(() => {
      order.push('signin')
      return Promise.resolve(user)
    })
    renderGate(makeApi({ signOut, signIn }))
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))

    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/Can't finish signing out yet/)).toBeInTheDocument()
    expect(signIn).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('the timer app')).toBeInTheDocument()
    expect(order).toEqual(['logout', 'logout', 'logout', 'signin'])
  })
})

describe('local data belongs to one user', () => {
  it('keeps the data when /me returns 401 for a remembered user', async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(user))
    localStorage.setItem(OWNER_KEY, user.id)
    seedUserData()
    renderGate(makeApi())
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBe(user.id)
  })

  it('restores everything when the same user signs in again', async () => {
    const controller = await pendingSession()
    localStorage.setItem(OWNER_KEY, user.id)
    seedUserData()
    renderGate(makeApi(), controller)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('the timer app')
    expect(localStorage.getItem(SETTINGS_KEY)).not.toBeNull()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
  })

  it('starts a different user clean and never hands them the previous pending record', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const stuck = await pendingSession()
    localStorage.setItem(OWNER_KEY, user.id)
    seedUserData()
    const { controller } = makeController(save)
    renderGate(makeApi({ signIn: vi.fn().mockResolvedValue(other) }), controller)
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('c@d.co', 'password1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('the timer app')
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBe(other.id)
    expect(localStorage.getItem('someone.elses.key')).toBe('keep me')
    expect(await controller.retryPending()).toBe(true)
    expect(save).not.toHaveBeenCalled()
    void stuck
  })
})
