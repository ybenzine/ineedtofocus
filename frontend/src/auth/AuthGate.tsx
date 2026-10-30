import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AccountContext, type Account } from './AccountContext.tsx'
import { AuthError, httpAuthApi, type AuthApi, type User } from './api.ts'
import AuthScreen from './AuthScreen.tsx'
import {
  cacheUser,
  claimLocalData,
  clearLocalUserData,
  clearPendingLogout,
  forgetCachedUser,
  hasActiveTimer,
  hasPendingLogout,
  loadCachedUser,
  SESSION_EXPIRED_EVENT,
  setPendingLogout,
  USER_KEY,
} from './localData.ts'
import { applyTheme } from '../theme.ts'

interface Props {
  children: ReactNode
  api?: AuthApi
}

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted.'

export const OFFLINE_SIGN_OUT_NOTICE =
  "You're signed out on this device. Your account will be fully signed out the next time this device is online."

export const OFFLINE_SIGN_OUT_MESSAGE =
  "Can't finish signing out yet. Connect to the internet, then try again."
export const SERVER_SIGN_OUT_MESSAGE =
  "Can't finish signing out yet. The server couldn't be reached. Try again shortly."

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
  const [deleted, setDeleted] = useState(false)
  // The sign-in expired while a timer runs: the app (and its timer) stays up, signed out on the
  // device, until the app calls `leaveExpired` once no timer runs.
  const [expired, setExpired] = useState(false)
  // Read by the event handlers, which are set up once: a second 401 never ends the expired state.
  const expiredRef = useRef(false)
  const userRef = useRef<User | null>(null)
  useEffect(() => {
    expiredRef.current = expired
    userRef.current = user
  }, [expired, user])
  // Signed out: the sign-in screen follows the device, not the last user's explicit theme.
  useEffect(() => {
    if (!checking && !user) applyTheme('system')
  }, [checking, user])

  /**
   * Ends the server session left over from an offline sign-out. Resolves `'done'` once none is
   * left, `'offline'` when the server couldn't be reached, `'server'` when it answered with an
   * error.
   */
  const flushLogout = useCallback(async (): Promise<'done' | 'offline' | 'server'> => {
    if (!hasPendingLogout()) return 'done'
    try {
      // Resolves on 2xx or 401 (the server session is already gone); anything else throws.
      await api.signOut()
    } catch (error) {
      // Network, timeout, 5xx or anything unexpected: keep the marker and try again later.
      return error instanceof AuthError && error.kind === 'network' ? 'offline' : 'server'
    }
    clearPendingLogout()
    setLogoutPending(false)
    return 'done'
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
          const cached = loadCachedUser()
          forgetCachedUser()
          if (cached && hasActiveTimer()) {
            // A timer is still running or paused: keep its screen until it ends.
            setExpired(true)
            setUser(cached)
            return
          }
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
      if (event.key !== USER_KEY) return
      if (event.newValue === null) {
        // Another tab signed out or found the sign-in expired. A timer running here keeps its
        // screen. An explicit sign-out removes a stored session first, but cannot see one kept only in
        // this tab's memory (#245); that one also stays, in expired mode.
        if (userRef.current && hasActiveTimer()) setExpired(true)
        else setUser(null)
      } else if (expiredRef.current) {
        // The same user signed in again in another tab: this one is signed in again too.
        try {
          const next = JSON.parse(event.newValue) as User
          if (next.id === userRef.current?.id) setExpired(false)
        } catch {
          // Unreadable: stay as we are.
        }
      }
    }
    function onOnline() {
      void flushLogout()
    }
    // Sync got a 401: check the sign-in again, handled like an expiry found at start-up (the
    // data stays for its owner). An unreachable server leaves things as they are.
    function onExpired() {
      // Already expired (or signed out): further 401s change nothing.
      if (expiredRef.current || !userRef.current) return
      api.me().then(
        (current) => {
          if (current || expiredRef.current || !userRef.current) return
          forgetCachedUser()
          // Keep the app mounted: it shows sign-in itself (`leaveExpired`) once no timer runs
          // and no summary is open.
          expiredRef.current = true
          setExpired(true)
        },
        () => undefined,
      )
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('online', onOnline)
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('online', onOnline)
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
    }
  }, [flushLogout, api])

  const account = useMemo<Account | null>(() => {
    if (!user) return null
    return {
      user,
      expired,
      leaveExpired: () => {
        if (!expired) return
        setExpired(false)
        setUser(null)
      },
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
      accountDeleted: async () => {
        await clearLocalUserData()
        setDeleted(true)
        setUser(null)
      },
    }
  }, [user, api, expired])

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
        notice={[deleted && ACCOUNT_DELETED_NOTICE, logoutPending && OFFLINE_SIGN_OUT_NOTICE]
          .filter(Boolean)
          .join(' ')}
        beforeSubmit={async () => {
          const result = await flushLogout()
          if (result === 'done') return null
          return result === 'server' ? SERVER_SIGN_OUT_MESSAGE : OFFLINE_SIGN_OUT_MESSAGE
        }}
        onSignedIn={async (next, signedUp) => {
          // A new account, or the next sign-in after a deletion, starts on New session
          // whatever screen the URL still names.
          if ((signedUp || deleted) && window.location.pathname !== '/') {
            window.history.replaceState(null, '', '/')
          }
          await claimLocalData(next)
          cacheUser(next)
          setDeleted(false)
          setUser(next)
        }}
      />
    )
  }

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
