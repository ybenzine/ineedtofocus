import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AccountContext, type Account } from './AccountContext.tsx'
import { AuthError, httpAuthApi, type AuthApi, type User } from './api.ts'
import AuthScreen from './AuthScreen.tsx'
import {
  cacheUser,
  clearLocalUserData,
  forgetCachedUser,
  hasUnsavedSession,
  loadCachedUser,
  USER_KEY,
} from './localData.ts'

interface Props {
  children: ReactNode
  api?: AuthApi
}

/**
 * Shows the sign-in screen until the user is signed in, then the app (AC1.2).
 * If the server can't be reached (offline, timeout, 5xx) but this device remembers a signed-in
 * user, the app opens anyway so the timers keep working offline (F13). The app shows the
 * account bar itself, on its setup screen, through `AccountContext`.
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
        const unreachable =
          error instanceof AuthError && (error.kind === 'network' || error.kind === 'server')
        setUser(unreachable ? loadCachedUser() : null)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [api])

  // Signing out in one tab removes the remembered user (or clears storage); the others follow.
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key === null || (event.key === USER_KEY && event.newValue === null)) {
        setUser(null)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const account = useMemo<Account | null>(() => {
    if (!user) return null
    return {
      user,
      signOutError,
      signOut: async () => {
        setSignOutError('')
        if (hasUnsavedSession()) {
          setSignOutError(
            'A session is still running or waiting to be saved on this device. Finish it before signing out.',
          )
          return
        }
        try {
          await api.signOut()
        } catch {
          setSignOutError("Couldn't sign out. Check your connection and try again.")
          return
        }
        await clearLocalUserData()
        setUser(null)
      },
    }
  }, [user, signOutError, api])

  if (checking) {
    return (
      <main>
        <p role="status">Loading…</p>
      </main>
    )
  }
  if (!user) {
    return (
      <AuthScreen
        api={api}
        onSignedIn={(next) => {
          cacheUser(next)
          setUser(next)
        }}
      />
    )
  }

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
