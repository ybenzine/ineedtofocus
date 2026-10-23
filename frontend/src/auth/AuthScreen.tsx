import { useState, type FormEvent } from 'react'
import { AuthError, describeWait, type AuthApi, type User } from './api.ts'

type Mode = 'signin' | 'signup'

interface Props {
  api: AuthApi
  onSignedIn: (user: User) => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AuthScreen({ api, onSignedIn }: Props) {
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [emailError, setEmailError] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  function switchMode(next: Mode) {
    setMode(next)
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
    if (emailProblem || passwordProblem) return

    setBusy(true)
    try {
      const user =
        mode === 'signup'
          ? await api.signUp(trimmed, password)
          : await api.signIn(trimmed, password)
      onSignedIn(user)
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.kind === 'duplicate') setEmailError(error.message)
        else if (error.kind === 'password') setPasswordError(error.message)
        else if (error.kind === 'rate_limited') {
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
      <h2>{signUp ? 'Create your account' : 'Sign in'}</h2>
      <form className="setup" onSubmit={(e) => void submit(e)} noValidate>
        <label>
          Email
          <input
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
            type="password"
            name="password"
            autoComplete={signUp ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? 'password-error' : undefined}
          />
        </label>
        {signUp && !passwordError && <p>8 to 128 characters.</p>}
        {passwordError && (
          <p id="password-error" role="alert">
            {passwordError}
          </p>
        )}
        {formError && <p role="alert">{formError}</p>}
        <button type="submit" disabled={busy}>
          {signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p>
        {signUp ? 'Already have an account? ' : 'New here? '}
        <button type="button" onClick={() => switchMode(signUp ? 'signin' : 'signup')}>
          {signUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
    </main>
  )
}
