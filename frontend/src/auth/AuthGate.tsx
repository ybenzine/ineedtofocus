import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AccountContext, type Account } from './AccountContext.tsx'
import { AuthError, httpAuthApi, type AuthApi, type User } from './api.ts'
import AuthScreen from './AuthScreen.tsx'
import {
  cacheUser,
  claimLocalData,
  clearLocalUserData,
  clearPendingLogout,
  forgetCachedUser,
  hasPendingLogout,
  loadCachedUser,
  setPendingLogout,
  USER_KEY,
} from './localData.ts'

interface Props {
  children: ReactNode
  api?: AuthApi
}

export const OFFLINE_SIGN_OUT_NOTICE =
  "You're signed out on this device. Your account will be fully signed out the next time this device is online."

/**
 * Shows the sign-in screen until the user is signed in, then the app (AC1.2).
 * If the server can't be reached (offline, timeout, 5xx) but this device remembers a signed-in
 * user, the app opens anyway so the timers keep working offline (F13). The app shows the
 * account bar itself, on its setup screen, through `AccountContext`.
 *
 * Local data is bound to the user id: a different user signing in first removes the previous
 * owner's data. A sign-out that couldn't reach the server leaves a `pendingLogout` marker; while
 * it is set the device is never treated as signed in and `/me` is not called.
 */
export default function AuthGate({ children, api = httpAuthApi }: Props) {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(() => !hasPendingLogout())
  const [logoutPending, setLogoutPending] = useState(hasPendingLogout)

  /** Ends the server session left over from an offline sign-out. True once none is left. */
  const flushLogout = useCallback(async (): Promise<boolean> => {
    if (!hasPendingLogout()) return true
    try {
      // Resolves on 2xx or 401 (the server session is already gone); anything else throws.
      await api.signOut()
    } catch {
      // Network, timeout, 5xx or anything unexpected: keep the marker and try again later.
      return false
    }
    clearPendingLogout()
    setLogoutPending(false)
    return true
  }, [api])

  useEffect(() => {
    let cancelled = false
    if (hasPendingLogout()) {
      void Promise.resolve().then(flushLogout)
      return
    }
    api
      .me()
      .then(async (current) => {
        if (cancelled) return
        if (current) {
          await claimLocalData(current)
          cacheUser(current)
        } else {
          // Expired or revoked elsewhere: keep the data for its owner (AC1.3).
          forgetCachedUser()
        }
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
  }, [api, flushLogout])

  useEffect(() => {
    // Signing out in one tab removes the remembered user; the others follow.
    function onStorage(event: StorageEvent) {
      if (event.key === USER_KEY && event.newValue === null) setUser(null)
    }
    function onOnline() {
      void flushLogout()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('online', onOnline)
    }
  }, [flushLogout])

  const account = useMemo<Account | null>(() => {
    if (!user) return null
    return {
      user,
      signOut: async () => {
        try {
          await api.signOut()
        } catch (error) {
          if (!(error instanceof AuthError && error.kind === 'network')) {
            return "Couldn't sign out. Try again."
          }
          // Offline: sign out on this device now and finish on the server when back online.
          setPendingLogout()
          setLogoutPending(true)
        }
        await clearLocalUserData()
        setUser(null)
        return null
      },
    }
  }, [user, api])

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
        notice={logoutPending ? OFFLINE_SIGN_OUT_NOTICE : ''}
        beforeSubmit={async () =>
          (await flushLogout())
            ? null
            : "Can't finish signing out yet. Connect to the internet, then try again."
        }
        onSignedIn={async (next) => {
          await claimLocalData(next)
          cacheUser(next)
          setUser(next)
        }}
      />
    )
  }

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
