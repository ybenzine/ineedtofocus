import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthError, type AuthApi, type User } from './api.ts'
import AuthGate from './AuthGate.tsx'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import { useAccount } from './AccountContext.tsx'
import {
  hasActiveTimer,
  OWNER_KEY,
  PENDING_LOGOUT_KEY,
  registerLocalDataHook,
  USER_KEY,
} from './localData.ts'
import { ResetError, type ResetApi } from './resetApi.ts'
import { captureResetToken, discardResetToken, peekResetToken } from './resetToken.ts'

const alice: User = { id: 'u1', email: 'a@b.co', created_at: '2026-11-06T00:00:00Z' }
const bob: User = { id: 'u2', email: 'c@d.co', created_at: '2026-11-06T00:00:00Z' }
const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12345'
const OFFER = 'Forgot your password? Reset it by email.'
const SENT =
  "If an account exists for that email, we've sent a link to reset your password. Check your inbox."
const CHANGED_SIGN_IN = 'Password changed. Sign in with your new password.'
const NEEDS_LINK = 'This page needs the link from your email. Open it again, or ask for a new one.'
const EXPIRED = 'This link has expired or was already used. Ask for a new one.'
const TOKEN_2 = 'zzzDEF123_-abcDEF123_-abcDEF123_-abcDEF99999'

function makeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn(),
    signIn: vi.fn().mockRejectedValue(new AuthError('rate_limited', 'Too many attempts.', 120)),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeReset(overrides: Partial<ResetApi> = {}): ResetApi {
  return {
    available: vi.fn().mockResolvedValue(true),
    request: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function renderGate(api: AuthApi, resetApi: ResetApi) {
  return render(
    <AuthGate api={api} resetApi={resetApi}>
      <p>the timer app</p>
    </AuthGate>,
  )
}

function goTo(url: string) {
  window.history.replaceState(null, '', url)
  captureResetToken()
}

function fillSignIn(email: string, password = 'wrong password') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
}

function fillSignUp(email: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'long enough pw' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
}

let onLine: boolean
beforeEach(() => {
  localStorage.clear()
  onLine = true
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine)
})
afterEach(() => {
  discardResetToken()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('the sign-in screen (AC8, AC9)', () => {
  it('shows Forgot password? only when reset is available, and opens the form with the email', async () => {
    const reset = makeReset()
    goTo('/login')
    renderGate(makeApi(), reset)
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: ' a@b.co ' } })
    fireEvent.click(await screen.findByRole('link', { name: 'Forgot password?' }))
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toHaveFocus()
    expect(screen.getByLabelText('Email')).toHaveValue('a@b.co')
    expect(window.location.pathname).toBe('/forgot-password')
    // The email travels in memory, never in the address.
    expect(window.location.search).toBe('')
    expect(window.location.hash).toBe('')
  })

  it('hides every offer when reset is off or the options call fails', async () => {
    goTo('/login')
    renderGate(makeApi(), makeReset({ available: vi.fn().mockResolvedValue(false) }))
    await screen.findByLabelText('Email')
    fillSignIn('a@b.co')
    expect(await screen.findByText(/Too many attempts\. Try again in 2 minutes\./)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: OFFER })).not.toBeInTheDocument()
  })

  it('offers the whole line as one link under the 429 message, with the email', async () => {
    goTo('/login')
    renderGate(makeApi(), makeReset())
    await screen.findByRole('link', { name: 'Forgot password?' })
    fillSignIn('a@b.co')
    expect(await screen.findByText(/Too many attempts\./)).toBeVisible()
    const link = await screen.findByRole('link', { name: OFFER })
    expect(link.textContent).toBe(OFFER)
    fireEvent.click(link)
    expect(await screen.findByLabelText('Email')).toHaveValue('a@b.co')
  })

  it('offers nothing on the sign-up form, even after its 429', async () => {
    goTo('/signup')
    const api = makeApi({
      signUp: vi.fn().mockRejectedValue(new AuthError('rate_limited', 'Too many.', 120)),
    })
    renderGate(api, makeReset())
    await screen.findByRole('heading', { name: 'Create your account' })
    fillSignUp('a@b.co')
    expect(await screen.findByText(/Too many attempts\./)).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: OFFER })).not.toBeInTheDocument()
  })

  it('does not offer the line under a wrong password', async () => {
    goTo('/login')
    const api = makeApi({ signIn: vi.fn().mockRejectedValue(new AuthError('invalid', 'Nope.')) })
    renderGate(api, makeReset())
    await screen.findByRole('link', { name: 'Forgot password?' })
    fillSignIn('a@b.co')
    expect(await screen.findByText('Nope.')).toBeVisible()
    expect(screen.queryByRole('link', { name: OFFER })).not.toBeInTheDocument()
  })
})

describe('the request form', () => {
  async function openRequest(reset: ResetApi) {
    goTo('/forgot-password')
    renderGate(makeApi(), reset)
    return screen.findByLabelText('Email')
  }

  it('shows the same confirmation after a request and moves focus to it', async () => {
    const reset = makeReset()
    const email = await openRequest(reset)
    fireEvent.change(email, { target: { value: 'who@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(SENT)
    expect(status).toHaveFocus()
    expect(reset.request).toHaveBeenCalledWith('who@example.com')
  })

  it('refuses a malformed address before asking', async () => {
    const reset = makeReset()
    const email = await openRequest(reset)
    fireEvent.change(email, { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid email address.')
    expect(email).toHaveFocus()
    expect(reset.request).not.toHaveBeenCalled()
  })

  it('shows the wait on a 429', async () => {
    const reset = makeReset({
      request: vi.fn().mockRejectedValue(new ResetError('rate_limited', 1800)),
    })
    const email = await openRequest(reset)
    fireEvent.change(email, { target: { value: 'who@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many requests. Try again in 30 minutes.',
    )
    expect(screen.queryByText(SENT)).not.toBeInTheDocument()
  })

  it('on a 503 says it is unavailable and asks again before offering the link again', async () => {
    // Offered at first; the second answer says it is off.
    const available = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const reset = makeReset({
      available,
      request: vi.fn().mockRejectedValue(new ResetError('unavailable')),
    })
    goTo('/login')
    renderGate(makeApi(), reset)
    fireEvent.click(await screen.findByRole('link', { name: 'Forgot password?' }))
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'who@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Password reset isn't available right now. Try again later.",
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => expect(available).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument()
  })

  it('does not claim to have sent anything when offline', async () => {
    onLine = false
    const reset = makeReset()
    await openRequest(reset)
    expect(screen.getByText('A connection is needed to reset your password.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeDisabled()
  })

  it('goes back to the sign-in screen', async () => {
    await openRequest(makeReset())
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('the reset page (AC8)', () => {
  function openConfirm(reset: ResetApi, api = makeApi()) {
    goTo(`/reset-password#token=${TOKEN}`)
    return renderGate(api, reset)
  }
  function fillPasswords(first: string, second = first) {
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: first } })
    fireEvent.change(screen.getByLabelText('Repeat new password'), { target: { value: second } })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
  }

  it('removes the token from the address and sends it with the new password', async () => {
    const reset = makeReset()
    openConfirm(reset)
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toHaveFocus()
    expect(window.location.href).not.toContain(TOKEN)
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Repeat new password')).toHaveAttribute(
      'autocomplete',
      'new-password',
    )
    fillPasswords('a brand new password')
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(reset.confirm).toHaveBeenCalledWith(TOKEN, 'a brand new password')
    expect(peekResetToken()).toBeNull()
  })

  it('says when the two passwords differ, and when one is too short', async () => {
    const reset = makeReset()
    openConfirm(reset)
    await screen.findByLabelText('New password')
    fillPasswords('a brand new password', 'another one entirely')
    expect(await screen.findByRole('alert')).toHaveTextContent("The passwords don't match.")
    expect(screen.getByLabelText('Repeat new password')).toHaveFocus()
    fillPasswords('short')
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Use a password of 8 to 128 characters.'),
    )
    expect(screen.getByLabelText('New password')).toHaveFocus()
    expect(reset.confirm).not.toHaveBeenCalled()
  })

  it('keeps the form when the server refuses the password, so the link is not used up', async () => {
    const reset = makeReset({ confirm: vi.fn().mockRejectedValue(new ResetError('password')) })
    openConfirm(reset)
    await screen.findByLabelText('New password')
    fillPasswords('a brand new password')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Use a password of 8 to 128 characters.',
    )
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled()
    expect(peekResetToken()).toBe(TOKEN)
  })

  it('on an expired link shows the message and a link back to the request form', async () => {
    const reset = makeReset({ confirm: vi.fn().mockRejectedValue(new ResetError('invalid_token')) })
    openConfirm(reset)
    await screen.findByLabelText('New password')
    fillPasswords('a brand new password')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This link has expired or was already used. Ask for a new one.')
    expect(alert).toHaveFocus()
    expect(peekResetToken()).toBeNull()
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Ask for a new link' }))
    expect(await screen.findByRole('heading', { name: 'Reset your password' })).toBeVisible()
  })

  it('says the page needs the link when there is no token (a reload), and focuses the message', async () => {
    goTo('/reset-password')
    renderGate(makeApi(), makeReset())
    const message = await screen.findByText(NEEDS_LINK)
    expect(message).toHaveFocus()
    expect(screen.queryByText(EXPIRED)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Ask for a new link' })).toBeVisible()
  })

  it('has a way back from the form, to sign-in when signed out', async () => {
    openConfirm(makeReset())
    fireEvent.click(await screen.findByRole('link', { name: 'Back to sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(peekResetToken()).toBeNull()
    expect(window.location.pathname).toBe('/login')
  })

  it('has a way back to the app when signed in', async () => {
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    openConfirm(makeReset(), makeApi({ me: vi.fn().mockResolvedValue(alice) }))
    fireEvent.click(await screen.findByRole('link', { name: 'Back to the app' }))
    expect(await screen.findByText('the timer app')).toBeVisible()
    expect(window.location.pathname).toBe('/')
  })

  it('says a connection is needed offline', async () => {
    onLine = false
    openConfirm(makeReset())
    expect(await screen.findByText('A connection is needed to reset your password.')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
  })

  it('shows the form on a device that holds no account, and on a guest device', async () => {
    localStorage.setItem('ineedtofocus.anonymous.settings', '{}')
    openConfirm(makeReset())
    expect(await screen.findByLabelText('New password')).toBeVisible()
  })
})

describe('after the password changed on a signed-in device (AC8)', () => {
  function signedIn(me: AuthApi['me']) {
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    return makeApi({ me })
  }

  async function reset(api: AuthApi) {
    goTo(`/reset-password#token=${TOKEN}`)
    const clear = vi.fn(async () => undefined)
    const unregister = registerLocalDataHook({
      trySync: vi.fn(async () => undefined),
      countUnsynced: vi.fn(async () => ({ sessions: 2, edits: 0 })),
      clear,
    })
    renderGate(api, makeReset())
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    })
    return { clear, unregister }
  }

  it('ends this sign-in when the account just reset is the signed-in one, keeping local data', async () => {
    // The first check finds the sign-in; the one after the reset finds it revoked.
    const me = vi.fn().mockResolvedValueOnce(alice).mockResolvedValue(null)
    const { clear, unregister } = await reset(signedIn(me))
    const notice = await screen.findByText(CHANGED_SIGN_IN)
    expect(notice).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(screen.queryByText('the timer app')).not.toBeInTheDocument()
    // Nothing on the device was cleared: unsynced sessions stay for their owner (F13).
    expect(clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
    unregister()
  })

  it('keeps a different account signed in and shows a notice', async () => {
    localStorage.setItem(OWNER_KEY, bob.id)
    localStorage.setItem(USER_KEY, JSON.stringify(bob))
    const me = vi.fn().mockResolvedValue(bob)
    const { clear, unregister } = await reset(makeApi({ me }))
    expect(await screen.findByText('the timer app')).toBeVisible()
    expect(await screen.findByText('Password changed.')).toBeVisible()
    expect(clear).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe('/')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Password changed.')).not.toBeInTheDocument()
    unregister()
  })

  it('leaves the sign-in to the next request when the server cannot be reached', async () => {
    const me = vi.fn().mockResolvedValueOnce(alice).mockRejectedValue(new AuthError('network', 'x'))
    const { unregister } = await reset(signedIn(me))
    expect(await screen.findByText('the timer app')).toBeVisible()
    expect(screen.getByText('Password changed.')).toBeVisible()
    unregister()
  })
})

describe('the request form opened from a signed-in device (AC9)', () => {
  it('opens prefilled with the account email without signing out', async () => {
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    goTo('/forgot-password')
    const api = makeApi({ me: vi.fn().mockResolvedValue(alice) })
    renderGate(api, makeReset())
    const email = await screen.findByLabelText('Email')
    expect(email).toHaveValue(alice.email)
    expect(api.signOut).not.toHaveBeenCalled()
    expect(within(document.body).getByRole('button', { name: 'Back' })).toBeVisible()
  })
})

describe('a newer link opened on the reset page (hashchange)', () => {
  function navigateToHash(hash: string) {
    act(() => {
      window.location.hash = hash
    })
  }

  it('reads the token after a reload and takes it out of the address bar', async () => {
    const reset = makeReset()
    goTo('/reset-password')
    renderGate(makeApi(), reset)
    await screen.findByText(NEEDS_LINK)
    navigateToHash(`#token=${TOKEN}`)
    const field = await screen.findByLabelText('New password')
    expect(window.location.href).not.toContain(TOKEN)
    expect(window.location.hash).toBe('')
    fireEvent.change(field, { target: { value: 'a brand new password' } })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(reset.confirm).toHaveBeenCalledWith(TOKEN, 'a brand new password')
  })

  it("uses the newest token when the first link's form is open", async () => {
    const reset = makeReset()
    goTo(`/reset-password#token=${TOKEN}`)
    renderGate(makeApi(), reset)
    await screen.findByLabelText('New password')
    navigateToHash(`#token=${TOKEN_2}`)
    await waitFor(() => expect(window.location.hash).toBe(''))
    expect(window.location.href).not.toContain(TOKEN_2)
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(reset.confirm).toHaveBeenCalledWith(TOKEN_2, 'a brand new password')
  })

  it('reads a fragment that arrived before the gate mounted', async () => {
    const reset = makeReset()
    goTo('/reset-password')
    // Set after the page's own capture and before the listener exists: no event reaches it.
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    renderGate(makeApi(), reset)
    await screen.findByLabelText('New password')
    expect(window.location.href).not.toContain(TOKEN)
    expect(peekResetToken()).toBe(TOKEN)
  })

  it('restarts the form with the newest token on the event itself, without a popstate', async () => {
    const reset = makeReset()
    goTo(`/reset-password#token=${TOKEN}`)
    renderGate(makeApi(), reset)
    await screen.findByLabelText('New password')
    act(() => {
      window.history.replaceState(null, '', `/reset-password#token=${TOKEN_2}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(reset.confirm).toHaveBeenCalledWith(TOKEN_2, 'a brand new password')
  })

  it("keeps a newer link in memory when the older form's confirm is refused afterwards", async () => {
    let refuse: (error: Error) => void = () => undefined
    const reset = makeReset({
      confirm: vi.fn().mockReturnValue(new Promise<void>((_, reject) => (refuse = reject))),
    })
    goTo(`/reset-password#token=${TOKEN}`)
    renderGate(makeApi(), reset)
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    navigateToHash(`#token=${TOKEN_2}`)
    await waitFor(() => expect(peekResetToken()).toBe(TOKEN_2))
    await act(async () => refuse(new ResetError('invalid_token')))
    expect(peekResetToken()).toBe(TOKEN_2)
  })

  it('ignores a fragment without a token, and any fragment on another page', async () => {
    goTo(`/reset-password#token=${TOKEN}`)
    renderGate(makeApi(), makeReset())
    const field = await screen.findByLabelText('New password')
    fireEvent.change(field, { target: { value: 'typed so far' } })
    navigateToHash('#other')
    await act(async () => undefined)
    expect(screen.getByLabelText('New password')).toHaveValue('typed so far')
    expect(peekResetToken()).toBe(TOKEN)
  })

  it('leaves a fragment on another page alone', async () => {
    goTo('/login')
    renderGate(makeApi(), makeReset())
    await screen.findByRole('heading', { name: 'Sign in' })
    navigateToHash(`#token=${TOKEN_2}`)
    await act(async () => undefined)
    expect(window.location.hash).toBe(`#token=${TOKEN_2}`)
    expect(peekResetToken()).toBeNull()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })
})

function Flags() {
  const account = useAccount()
  const leave = account?.expired ? account.leaveExpired : null
  useEffect(() => {
    if (leave && !hasActiveTimer()) leave()
  }, [leave])
  return (
    <p>{account ? (account.expired ? 'state: expired' : 'state: signed in') : 'state: none'}</p>
  )
}

describe('a reset while a timer runs, and after a sign-in that already ended (AC8)', () => {
  async function startTimer() {
    const controller = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => Promise.resolve(),
      now: () => 1_700_000_000_000,
    })
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
  }

  function renderWithFlags(api: AuthApi, reset = makeReset()) {
    return render(
      <AuthGate api={api} resetApi={reset}>
        <p>the timer app</p>
        <Flags />
      </AuthGate>,
    )
  }

  async function changePassword() {
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    })
  }

  it('keeps the running timer up in expired mode, forgets the user and keeps the owner', async () => {
    await startTimer()
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    goTo('/')
    const me = vi.fn().mockResolvedValueOnce(alice).mockResolvedValue(null)
    renderWithFlags(makeApi({ me }))
    await screen.findByText('state: signed in')
    act(() => {
      window.history.pushState(null, '', '/forgot-password')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    // Reach the confirm page the way a link in the same tab would.
    act(() => {
      window.history.pushState(null, '', `/reset-password#token=${TOKEN}`)
      captureResetToken()
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await changePassword()
    expect(await screen.findByText('the timer app')).toBeVisible()
    expect(screen.getByText('state: expired')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.getByText(CHANGED_SIGN_IN)).toBeVisible()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
    expect(hasActiveTimer()).toBe(true)
  })

  it('keeps a timer already in expired mode at start-up up after the reset', async () => {
    await startTimer()
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    goTo(`/reset-password#token=${TOKEN}`)
    renderWithFlags(makeApi())
    await changePassword()
    expect(await screen.findByText('the timer app')).toBeVisible()
    expect(screen.getByText('state: expired')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(screen.getByText(CHANGED_SIGN_IN)).toBeVisible()
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
  })

  it('lets the correct password in when the timer ended while the page was open', async () => {
    await startTimer()
    localStorage.setItem(OWNER_KEY, alice.id)
    localStorage.setItem(USER_KEY, JSON.stringify(alice))
    goTo(`/reset-password#token=${TOKEN}`)
    const api = makeApi({ signIn: vi.fn().mockResolvedValue(alice) })
    renderWithFlags(api)
    await screen.findByLabelText('New password')
    // The timer ends (or another tab stops it) before the confirm.
    localStorage.removeItem('ineedtofocus.activeSession')
    await changePassword()
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('state: signed in')).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })
})

describe('a reset when the server knows a sign-in this page does not hold', () => {
  it('ends in the sign-in screen with the message after an offline sign-out still pending', async () => {
    localStorage.setItem(PENDING_LOGOUT_KEY, '1')
    localStorage.setItem(OWNER_KEY, alice.id)
    const clear = vi.fn(async () => undefined)
    const unregister = registerLocalDataHook({
      trySync: vi.fn(async () => undefined),
      countUnsynced: vi.fn(async () => ({ sessions: 1, edits: 0 })),
      clear,
    })
    goTo(`/reset-password#token=${TOKEN}`)
    const api = makeApi({
      me: vi.fn().mockResolvedValue(alice),
      // The sign-out still can't finish.
      signOut: vi.fn().mockRejectedValue(new AuthError('network', 'offline')),
    })
    renderGate(api, makeReset())
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText(new RegExp(CHANGED_SIGN_IN))).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    // Nothing is cleared, and the sign-out that is still owed stays owed.
    expect(clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
    expect(localStorage.getItem(PENDING_LOGOUT_KEY)).not.toBeNull()
    unregister()
  })

  it('ends in the sign-in screen with the message after a failed start-up check with no remembered user', async () => {
    localStorage.setItem(OWNER_KEY, alice.id)
    goTo(`/reset-password#token=${TOKEN}`)
    const me = vi
      .fn()
      .mockRejectedValueOnce(new AuthError('network', 'offline'))
      .mockResolvedValue(alice)
    renderGate(makeApi({ me }), makeReset())
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.change(screen.getByLabelText('Repeat new password'), {
      target: { value: 'a brand new password' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByText(CHANGED_SIGN_IN)).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible()
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
  })
})
