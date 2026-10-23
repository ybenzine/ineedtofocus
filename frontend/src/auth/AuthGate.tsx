import { useEffect, useState, type ReactNode } from 'react'
import { AuthError, httpAuthApi, type AuthApi, type User } from './api.ts'
import AuthScreen from './AuthScreen.tsx'
import { cacheUser, clearLocalUserData, forgetCachedUser, loadCachedUser } from './localData.ts'

interface Props {
  children: ReactNode
  api?: AuthApi
}

/**
 * Shows the sign-in screen until the user is signed in, then the app (AC1.2).
 * If the server can't be reached but this device remembers a signed-in user, the app opens
 * anyway so the timers keep working offline (F13).
 */
export default function AuthGate({ children, api = httpAuthApi }: Props) {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(true)
  const [signOutError, setSignOutError] = useState('')

  useEffect(() => {
    let cancelled = false
    api
      .me()
      .then((current) => {
        if (cancelled) return
        if (current) cacheUser(current)
        else forgetCachedUser()
        setUser(current)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof AuthError && error.kind === 'network') setUser(loadCachedUser())
        else setUser(null)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  function signedIn(next: User) {
    cacheUser(next)
    setUser(next)
  }

  async function signOut() {
    setSignOutError('')
    try {
      await api.signOut()
    } catch {
      setSignOutError("Couldn't sign out. Check your connection and try again.")
      return
    }
    await clearLocalUserData()
    setUser(null)
  }

  if (checking) {
    return (
      <main>
        <p role="status">Loading…</p>
      </main>
    )
  }
  if (!user) return <AuthScreen api={api} onSignedIn={signedIn} />

  return (
    <>
      <header className="account-bar">
        <span>{user.email}</span>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
        {signOutError && <span role="alert">{signOutError}</span>}
      </header>
      {children}
    </>
  )
}
