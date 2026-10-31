import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AuthError, describeWait, type AuthApi, type User } from './api.ts'

import type { AuthForm as Mode } from '../anonymous/AnonymousContext.ts'

interface Props {
  api: AuthApi
  /** Which form is shown; `onModeChange` is called when the user switches. */
  mode: Mode
  onModeChange: (mode: Mode) => void
  onSignedIn: (user: User, signedUp: boolean) => void
  /** "Continue without an account" (#331); absent where anonymous use isn't offered. */
  onContinue?: () => void
  /** Shown above the form, e.g. after an offline sign-out. */
  notice?: string
  /** Runs before each sign-in or sign-up request; a returned message stops the request. */
  beforeSubmit?: () => Promise<string | null>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AuthScreen({
  api,
  mode,
  onModeChange,
  onContinue,
  onSignedIn,
  notice,
  beforeSubmit = () => Promise.resolve(null),
}: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const switched = useRef(false)

  // After switching between sign-in and sign-up, announce the new form by focusing its heading.
  useEffect(() => {
    if (switched.current) headingRef.current?.focus()
  }, [mode])

  function switchMode(next: Mode) {
    switched.current = true
    onModeChange(next)
    setEmailError('')
    setPasswordError('')
    setFormError('')
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const trimmed = email.trim()
    const emailProblem = EMAIL_PATTERN.test(trimmed) ? '' : 'Enter a valid email address.'
    const passwordProblem =
      password.length >= 8 && password.length <= 128 ? '' : 'Use a password of 8 to 128 characters.'
    setEmailError(emailProblem)
    setPasswordError(passwordProblem)
    setFormError('')
    if (emailProblem || passwordProblem) {
      ;(emailProblem ? emailRef : passwordRef).current?.focus()
      return
    }

    setBusy(true)
    try {
      // A sign-out that never reached the server is finished first.
      const blocked = await beforeSubmit()
      if (blocked) {
        setFormError(blocked)
        setBusy(false)
        return
      }
      const user =
        mode === 'signup'
          ? await api.signUp(trimmed, password)
          : await api.signIn(trimmed, password)
      onSignedIn(user, mode === 'signup')
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.kind === 'duplicate') {
          setEmailError(error.message)
          emailRef.current?.focus()
        } else if (error.kind === 'password') {
          setPasswordError(error.message)
          passwordRef.current?.focus()
        } else if (error.kind === 'rate_limited') {
          setFormError(`Too many attempts. ${describeWait(error.retryAfterSeconds)}`)
        } else setFormError(error.message)
      } else {
        setFormError('Something went wrong. Try again in a moment.')
      }
      setBusy(false)
    }
  }

  const signUp = mode === 'signup'
  return (
    <main>
      <h1>I Need To Focus</h1>
      {notice && <p role="status">{notice}</p>}
      <h2 ref={headingRef} tabIndex={-1}>
        {signUp ? 'Create your account' : 'Sign in'}
      </h2>
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
            aria-describedby={emailError ? 'email-error' : undefined}
          />
        </label>
        {emailError && (
          <p id="email-error" role="alert">
            {emailError}
          </p>
        )}
        <label>
          Password
          <input
            ref={passwordRef}
            type="password"
            name="password"
            autoComplete={signUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={
              passwordError ? 'password-error' : signUp ? 'password-hint' : undefined
            }
          />
        </label>
        {signUp && !passwordError && <p id="password-hint">8 to 128 characters.</p>}
        {passwordError && (
          <p id="password-error" role="alert">
            {passwordError}
          </p>
        )}
        {formError && <p role="alert">{formError}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p>
        {signUp ? 'Already have an account? ' : 'New here? '}
        <button type="button" onClick={() => switchMode(signUp ? 'signin' : 'signup')}>
          {signUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      {onContinue && (
        <p>
          <a
            className="auth-link"
            href="/"
            onClick={(event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onContinue()
            }}
          >
            Continue without an account
          </a>
        </p>
      )}
    </main>
  )
}
