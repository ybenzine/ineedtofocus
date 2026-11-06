import { useEffect, useRef, useState, type FormEvent } from 'react'
import { describeWait } from './api.ts'
import { ResetError, type ResetApi } from './resetApi.ts'
import { discardResetToken, peekResetToken } from './resetToken.ts'
import { useOnline } from '../sounds/useOnline.ts'

/** The two pages of password reset (AC1.9, #350). */
export type ResetView =
  | { kind: 'request'; email: string; pushed: boolean; from: string }
  | { kind: 'confirm'; token: string | null }

export const REQUEST_SENT_MESSAGE =
  "If an account exists for that email, we've sent a link to reset your password. Check your inbox."
export const INVALID_LINK_MESSAGE = 'This link has expired or was already used. Ask for a new one.'
/** No token in the address (a reload keeps none, by design): the link itself may still work. */
export const MISSING_LINK_MESSAGE =
  'This page needs the link from your email. Open it again, or ask for a new one.'
export const PASSWORD_CHANGED_MESSAGE = 'Password changed. Sign in with your new password.'
export const RESET_OFFLINE_MESSAGE = 'A connection is needed to reset your password.'
export const RESET_UNAVAILABLE_MESSAGE =
  "Password reset isn't available right now. Try again later."

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PASSWORD_PROBLEM = 'Use a password of 8 to 128 characters.'

function requestFailure(error: unknown): string {
  if (error instanceof ResetError) {
    switch (error.kind) {
      case 'rate_limited':
        return `Too many requests. ${describeWait(error.retryAfterSeconds)}`
      case 'unavailable':
        return RESET_UNAVAILABLE_MESSAGE
      case 'email':
        return 'Enter a valid email address.'
      case 'network':
        return "Can't reach the server. Check your connection and try again."
      case 'server':
        return 'The server is having trouble. Try again in a moment.'
    }
  }
  return 'Something went wrong. Try again in a moment.'
}

function confirmFailure(error: unknown): string {
  if (error instanceof ResetError) {
    switch (error.kind) {
      case 'rate_limited':
        return `Too many attempts. ${describeWait(error.retryAfterSeconds)}`
      case 'unavailable':
        return RESET_UNAVAILABLE_MESSAGE
      case 'network':
        return "Can't reach the server. Check your connection and try again."
      case 'server':
        return 'The server is having trouble. Try again in a moment.'
    }
  }
  return 'Something went wrong. Try again in a moment.'
}

interface Props {
  view: ResetView
  api: ResetApi
  /** This device holds a sign-in (the request form was opened from the app). */
  signedIn: boolean
  /** Leaves the page: to the sign-in screen, or back to the app. */
  onBack: () => void
  /** From an expired link to the request form. */
  onRequestNew: () => void
  /** The password was changed (204). */
  onChanged: () => void | Promise<void>
  /** The server says reset isn't configured (503): ask again whether to offer it. */
  onUnavailable: () => void
}

export default function ResetPage({
  view,
  api,
  signedIn,
  onBack,
  onRequestNew,
  onChanged,
  onUnavailable,
}: Props) {
  return (
    <main>
      <h1>I Need To Focus</h1>
      {view.kind === 'request' ? (
        <RequestForm
          key="request"
          initialEmail={view.email}
          api={api}
          signedIn={signedIn}
          onBack={onBack}
          onUnavailable={onUnavailable}
        />
      ) : (
        <ConfirmForm
          // A newer link opened on this page starts the form over with its token.
          key={`confirm-${view.token ?? ''}`}
          token={view.token}
          api={api}
          signedIn={signedIn}
          onBack={onBack}
          onRequestNew={onRequestNew}
          onChanged={onChanged}
          onUnavailable={onUnavailable}
        />
      )}
    </main>
  )
}

function RequestForm({
  initialEmail,
  api,
  signedIn,
  onBack,
  onUnavailable,
}: {
  initialEmail: string
  api: ResetApi
  signedIn: boolean
  onBack: () => void
  onUnavailable: () => void
}) {
  const online = useOnline()
  const [email, setEmail] = useState(initialEmail)
  const [emailError, setEmailError] = useState('')
  const [formError, setFormError] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const sentRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])
  useEffect(() => {
    if (sent) sentRef.current?.focus()
  }, [sent])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    const trimmed = email.trim()
    setFormError('')
    if (!EMAIL_PATTERN.test(trimmed)) {
      setEmailError('Enter a valid email address.')
      emailRef.current?.focus()
      return
    }
    setEmailError('')
    setBusy(true)
    try {
      await api.request(trimmed)
      // The same words whether or not an account exists (the server answers alike).
      setSent(true)
    } catch (error) {
      if (error instanceof ResetError && error.kind === 'unavailable') onUnavailable()
      setFormError(requestFailure(error))
    }
    setBusy(false)
  }

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Reset your password
      </h2>
      {sent ? (
        <>
          <p ref={sentRef} role="status" tabIndex={-1}>
            {REQUEST_SENT_MESSAGE}
          </p>
          <p>
            <button type="button" onClick={onBack}>
              {signedIn ? 'Back' : 'Back to sign in'}
            </button>
          </p>
        </>
      ) : (
        <>
          {!online && <p role="status">{RESET_OFFLINE_MESSAGE}</p>}
          <form className="setup auth-card" onSubmit={(e) => void submit(e)} noValidate>
            <label>
              Email
              <input
                ref={emailRef}
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? 'reset-email-error' : undefined}
              />
            </label>
            {emailError && (
              <p id="reset-email-error" role="alert">
                {emailError}
              </p>
            )}
            {formError && <p role="alert">{formError}</p>}
            <button type="submit" className="primary" disabled={busy || !online}>
              Send reset link
            </button>
          </form>
          <p>
            <button type="button" onClick={onBack}>
              {signedIn ? 'Back' : 'Back to sign in'}
            </button>
          </p>
        </>
      )}
    </>
  )
}

function ConfirmForm({
  token,
  api,
  signedIn,
  onBack,
  onRequestNew,
  onChanged,
  onUnavailable,
}: {
  token: string | null
  api: ResetApi
  signedIn: boolean
  onBack: () => void
  onRequestNew: () => void
  onChanged: () => void | Promise<void>
  onUnavailable: () => void
}) {
  const online = useOnline()
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [repeatError, setRepeatError] = useState('')
  const [formError, setFormError] = useState('')
  // No token in the address (a reload, or a link cut short) has a message of its own.
  const [spent, setSpent] = useState(token === null)
  const [busy, setBusy] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const repeatRef = useRef<HTMLInputElement>(null)
  const spentRef = useRef<HTMLParagraphElement>(null)

  // The message is focused when it replaces the form, and when it is all there is.
  useEffect(() => {
    if (spent) spentRef.current?.focus()
    else headingRef.current?.focus()
  }, [spent])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy || token === null) return
    setFormError('')
    const passwordProblem = password.length >= 8 && password.length <= 128 ? '' : PASSWORD_PROBLEM
    const repeatProblem =
      !passwordProblem && repeat !== password ? "The passwords don't match." : ''
    setPasswordError(passwordProblem)
    setRepeatError(repeatProblem)
    if (passwordProblem || repeatProblem) {
      ;(passwordProblem ? passwordRef : repeatRef).current?.focus()
      return
    }
    setBusy(true)
    try {
      await api.confirm(token, password)
    } catch (error) {
      if (error instanceof ResetError && error.kind === 'invalid_token') {
        // Only this form's own token: a newer link opened meanwhile keeps its place in memory.
        if (peekResetToken() === token) discardResetToken()
        setSpent(true)
      } else if (error instanceof ResetError && error.kind === 'password') {
        // A refused password doesn't use up the link.
        setPasswordError(PASSWORD_PROBLEM)
        passwordRef.current?.focus()
      } else {
        if (error instanceof ResetError && error.kind === 'unavailable') onUnavailable()
        setFormError(confirmFailure(error))
      }
      setBusy(false)
      return
    }
    if (peekResetToken() === token) discardResetToken()
    setPassword('')
    setRepeat('')
    await onChanged()
  }

  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        Choose a new password
      </h2>
      {spent ? (
        <>
          <p ref={spentRef} role="alert" tabIndex={-1}>
            {token === null ? MISSING_LINK_MESSAGE : INVALID_LINK_MESSAGE}
          </p>
          <p>
            <a
              className="auth-link"
              href="/forgot-password"
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
                event.preventDefault()
                onRequestNew()
              }}
            >
              Ask for a new link
            </a>
          </p>
        </>
      ) : (
        <>
          {!online && <p role="status">{RESET_OFFLINE_MESSAGE}</p>}
          <form className="setup auth-card" onSubmit={(e) => void submit(e)} noValidate>
            <label>
              New password
              <input
                ref={passwordRef}
                type="password"
                name="new-password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? 'reset-password-error' : 'reset-password-hint'}
              />
            </label>
            {!passwordError && <p id="reset-password-hint">8 to 128 characters.</p>}
            {passwordError && (
              <p id="reset-password-error" role="alert">
                {passwordError}
              </p>
            )}
            <label>
              Repeat new password
              <input
                ref={repeatRef}
                type="password"
                name="repeat-new-password"
                autoComplete="new-password"
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
                aria-invalid={repeatError ? true : undefined}
                aria-describedby={repeatError ? 'reset-repeat-error' : undefined}
              />
            </label>
            {repeatError && (
              <p id="reset-repeat-error" role="alert">
                {repeatError}
              </p>
            )}
            {formError && <p role="alert">{formError}</p>}
            <button type="submit" className="primary" disabled={busy || !online}>
              Change password
            </button>
          </form>
        </>
      )}
      <p>
        <a
          className="auth-link"
          href={signedIn ? '/' : '/login'}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            onBack()
          }}
        >
          {signedIn ? 'Back to the app' : 'Back to sign in'}
        </a>
      </p>
    </>
  )
}
