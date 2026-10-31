import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AccountContext, type Account } from './AccountContext.tsx'
import { AuthError, httpAuthApi, type AuthApi, type User } from './api.ts'
import AuthScreen from './AuthScreen.tsx'
import {
  accountSlotHasSession,
  cacheUser,
  claimLocalData,
  clearLocalUserData,
  clearPendingLogout,
  forgetCachedUser,
  hasActiveTimer,
  hasOwner,
  hasPendingLogout,
  loadCachedUser,
  SESSION_EXPIRED_EVENT,
  setPendingLogout,
  USER_KEY,
} from './localData.ts'
import {
  AnonymousContext,
  formFromPath,
  pathForForm,
  type AnonymousUse,
  type AuthForm,
  type FormOrigin,
} from '../anonymous/AnonymousContext.ts'
import { HeldSession } from '../anonymous/held.ts'
import {
  ANON_AUDIO_SOURCE_KEY,
  ANON_SETTINGS_KEY,
  ANON_YOUTUBE_LINK_KEY,
  clearAnonymousData,
} from '../anonymous/keys.ts'
import { registerMemoryHolder } from '../update/idle.ts'
import { ACTIVE_SESSION_KEY, type StoredTimer } from '../timer/store.ts'
import type { TimerUpdate } from '../timer/index.ts'
import { applyTheme } from '../theme.ts'

interface Props {
  children: ReactNode
  api?: AuthApi
  /**
   * Hands the finished anonymous session saved from the summary's prompt to the account's timer
   * (device store first, then sync, #331). Without it that session cannot be saved.
   */
  handOver?: (state: StoredTimer) => Promise<TimerUpdate>
}

/** A sign-in or sign-up form opened at `/login` or `/signup` (#331). */
interface FormRoute {
  form: AuthForm
  /** Opened from the summary's prompt: the session held there is saved after signing in. */
  fromPrompt: boolean
  /** Reached by an in-app click (one history entry was added), not by a typed URL or reload. */
  pushed: boolean
  /** The path the form was opened from. */
  from: string
}

function routeFromLocation(): FormRoute | null {
  const form = formFromPath(window.location.pathname)
  return form === null ? null : { form, fromPrompt: false, pushed: false, from: '/' }
}

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted.'

export const OFFLINE_SIGN_OUT_NOTICE =
  "You're signed out on this device. Your account will be fully signed out the next time this device is online."

export const OFFLINE_SIGN_OUT_MESSAGE =
  "Can't finish signing out yet. Connect to the internet, then try again."
export const SERVER_SIGN_OUT_MESSAGE =
  "Can't finish signing out yet. The server couldn't be reached. Try again shortly."

/**
 * Shows the app: signed in with an account, or without one (#331). A device that holds no
 * account data opens on New session, signed out; the sign-in screen shows first only when it
 * does (an expired sign-in), after a sign-out or deletion, or when `/login` or `/signup` is
 * asked for. Anonymous use is not offered while an account's session sits in the stored-session
 * slot (AC1.8). The app shows the account bar itself, on its setup screen, through
 * `AccountContext`.
 * If the server can't be reached (offline, timeout, 5xx) but this device remembers a signed-in
 * user, the app opens anyway so the timers keep working offline (F13).
 *
 * Local data is bound to the user id: a different user signing in first removes the previous
 * owner's data. A sign-out that couldn't reach the server leaves a `pendingLogout` marker; while
 * it is set the device is never treated as signed in and `/me` is not called.
 */
export default function AuthGate({ children, api = httpAuthApi, handOver }: Props) {
  const [user, setUser] = useState<User | null>(null)
  const [checking, setChecking] = useState(() => !hasPendingLogout())
  const [logoutPending, setLogoutPending] = useState(hasPendingLogout)
  const [deleted, setDeleted] = useState(false)
  // The sign-in expired while a timer runs: the app (and its timer) stays up, signed out on the
  // device, until the app calls `leaveExpired` once no timer runs.
  const [expired, setExpired] = useState(false)
  // Without an account the app opens on New session unless the device holds an account's data
  // (`mustSignIn`), a form was asked for (`route`) or an account's session sits in the slot.
  const [held] = useState(() => new HeldSession())
  const [route, setRoute] = useState<FormRoute | null>(routeFromLocation)
  const [mode, setMode] = useState<AuthForm>(
    () => formFromPath(window.location.pathname) ?? 'signin',
  )
  const [mustSignIn, setMustSignIn] = useState(() => hasOwner() || hasPendingLogout())
  const [handedOver, setHandedOver] = useState<TimerUpdate | null>(null)
  // Re-render when another tab changes the stored session: anonymous use isn't offered while an
  // account's session is in it.
  const [, setSlotChanges] = useState(0)
  // Bumped when another tab clears the anonymous data (a sign-in): the anonymous app is keyed by
  // it and remounts with fresh stores, whether or not this tab then follows the sign-in, so it
  // can never write back what was cleared (#396).
  const [anonymousEpoch, setAnonymousEpoch] = useState(0)
  const blocked = !user && accountSlotHasSession()
  const showForm = route !== null || mustSignIn || blocked
  // Read by the event handlers, which are set up once: a second 401 never ends the expired state.
  const expiredRef = useRef(false)
  const userRef = useRef<User | null>(null)
  // Signed out here (the app without an account, or a form): follows a sign-in from another tab.
  const anonymousShownRef = useRef(false)
  useEffect(() => {
    expiredRef.current = expired
    userRef.current = user
    anonymousShownRef.current = !checking && !user
  }, [expired, user, checking])
  // Signed out: the sign-in screen follows the device, not the last user's explicit theme.
  useEffect(() => {
    if (!checking && !user && showForm) applyTheme('system')
  }, [checking, user, showForm])
  // A finished anonymous session held by this page keeps it busy for the automatic update.
  useEffect(() => registerMemoryHolder(() => held.get() !== null), [held])
  // An account's session appeared in the slot: nothing anonymous is kept here any more.
  useEffect(() => {
    if (blocked) held.discard()
  }, [blocked, held])
  // Anonymous data never outlives a signed-in mount, offline with the cached user included: a
  // session left in the anonymous slot would otherwise block the account's Start (AC6.1).
  const signedIn = user !== null && !expired
  useEffect(() => {
    if (signedIn) clearAnonymousData()
  }, [signedIn])
  // Whatever ends the user's sign-in ends it the same way.
  const endUser = useCallback(() => {
    setMode('signin')
    setMustSignIn(true)
    setHandedOver(null)
    setUser(null)
  }, [])

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
          clearAnonymousData()
          // Signed in, `/login` and `/signup` have nothing to show: New session.
          if (formFromPath(window.location.pathname) !== null) {
            window.history.replaceState(null, '', '/')
          }
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
      if (event.key === null || event.key === ACTIVE_SESSION_KEY) setSlotChanges((n) => n + 1)
      const clearedAnonymous =
        event.key === null ||
        ((event.key === ANON_SETTINGS_KEY ||
          event.key === ANON_AUDIO_SOURCE_KEY ||
          event.key === ANON_YOUTUBE_LINK_KEY) &&
          event.newValue === null)
      if (clearedAnonymous && !userRef.current) setAnonymousEpoch((n) => n + 1)
      if (event.key !== USER_KEY) return
      if (event.newValue === null) {
        // Another tab signed out or found the sign-in expired. A timer running here keeps its
        // screen. An explicit sign-out removes a stored session first, but cannot see one kept only in
        // this tab's memory (#245); that one also stays, in expired mode.
        if (userRef.current && hasActiveTimer()) setExpired(true)
        else if (userRef.current) endUser()
      } else if (!userRef.current && anonymousShownRef.current) {
        // Someone signed in in another tab: that sign-in cleared the anonymous data, so this
        // tab must not keep showing, or writing back, its stale copy, and a form here must not
        // lead to anonymous use beside an account. Follow the sign-in; the app then remounts as
        // the account's, with fresh stores (#331). Asks `/me` once; if the server can't be
        // reached it uses the user the other tab just cached, as start-up does.
        const follow = async (current: User) => {
          if (userRef.current || !anonymousShownRef.current) return
          held.discard()
          await claimLocalData(current)
          clearAnonymousData()
          cacheUser(current)
          if (formFromPath(window.location.pathname) !== null) {
            window.history.replaceState(null, '', '/')
          }
          setRoute(null)
          setMustSignIn(false)
          setUser(current)
        }
        api.me().then(
          (current) => (current ? follow(current) : undefined),
          (error: unknown) => {
            const unreachable =
              error instanceof AuthError && (error.kind === 'network' || error.kind === 'server')
            const cached = unreachable ? loadCachedUser() : null
            return cached ? follow(cached) : undefined
          },
        )
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
    // The back and forward buttons open and close the forms.
    function onPopState() {
      const form = formFromPath(window.location.pathname)
      if (form === null) {
        setRoute(null)
        return
      }
      setMode(form)
      setRoute((previous) => ({
        form,
        fromPrompt: previous?.fromPrompt ?? false,
        pushed: true,
        from: previous?.from ?? '/',
      }))
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
    window.addEventListener('popstate', onPopState)
    window.addEventListener('online', onOnline)
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('popstate', onPopState)
      window.removeEventListener('online', onOnline)
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired)
    }
  }, [flushLogout, api, endUser, held])

  const account = useMemo<Account | null>(() => {
    if (!user) return null
    return {
      user,
      expired,
      leaveExpired: () => {
        if (!expired) return
        setExpired(false)
        endUser()
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
        endUser()
        return null
      },
      accountDeleted: async () => {
        // Reset the URL now, not at the next sign-in, so a reload cannot bring the last
        // screen back (AC1.7).
        if (window.location.pathname !== '/') window.history.replaceState(null, '', '/')
        await clearLocalUserData()
        setDeleted(true)
        endUser()
      },
      handedOver,
    }
  }, [user, api, expired, handedOver, endUser])

  const openForm = useCallback((form: AuthForm, origin: FormOrigin) => {
    const from = window.location.pathname
    window.history.pushState(null, '', pathForForm(form))
    setMode(form)
    setRoute({ form, fromPrompt: origin === 'prompt', pushed: true, from })
  }, [])
  const anonymous = useMemo<AnonymousUse>(() => ({ held, openForm }), [held, openForm])

  function continueWithoutAccount() {
    setMustSignIn(false)
    if (route?.pushed) {
      // Back to where the form was opened from (the summary, for its prompt); `popstate` then
      // closes the form.
      window.history.back()
      return
    }
    if (window.location.pathname !== '/') window.history.replaceState(null, '', '/')
    setRoute(null)
  }

  function changeMode(next: AuthForm) {
    setMode(next)
    if (route === null) return
    // The same history entry, so one Back still leaves the form; the origin stays.
    window.history.replaceState(null, '', pathForForm(next))
    setRoute({ ...route, form: next })
  }

  /** Where the URL goes after signing in: the form's origin, or New session. */
  function landingAfterSignIn(signedUp: boolean, saving: boolean): string | null {
    if (saving && route) return route.from
    if (signedUp || deleted) return '/'
    if (route === null) return null // the sign-in screen stood over the screen's own URL
    return route.pushed ? route.from : '/'
  }

  if (checking) {
    return (
      <main>
        <p role="status">Loading…</p>
      </main>
    )
  }
  if (!user && !showForm) {
    return (
      <AnonymousContext.Provider key={anonymousEpoch} value={anonymous}>
        {children}
      </AnonymousContext.Provider>
    )
  }
  if (!user) {
    return (
      <AuthScreen
        api={api}
        mode={mode}
        onModeChange={changeMode}
        onContinue={blocked ? undefined : continueWithoutAccount}
        notice={[deleted && ACCOUNT_DELETED_NOTICE, logoutPending && OFFLINE_SIGN_OUT_NOTICE]
          .filter(Boolean)
          .join(' ')}
        beforeSubmit={async () => {
          const result = await flushLogout()
          if (result === 'done') return null
          return result === 'server' ? SERVER_SIGN_OUT_MESSAGE : OFFLINE_SIGN_OUT_MESSAGE
        }}
        onSignedIn={async (next, signedUp) => {
          // The session held for the prompt is taken first, while its marker still names it;
          // any other sign-in or sign-up discards what this page holds (#331).
          const fromPrompt = route?.fromPrompt ?? false
          const taken = fromPrompt ? held.take() : null
          if (!fromPrompt) held.discard()
          const landing = landingAfterSignIn(signedUp, taken !== null)
          if (landing !== null && window.location.pathname !== landing) {
            window.history.replaceState(null, '', landing)
          }
          await claimLocalData(next)
          // Every anonymous key goes, so held sessions in other tabs are discarded through the
          // marker. The one session being saved is in this page's memory only.
          clearAnonymousData()
          cacheUser(next)
          let update: TimerUpdate | null = null
          if (taken !== null && handOver) {
            update = await handOver({ session: taken.session, pendingRecord: taken.record })
          }
          setHandedOver(update)
          setDeleted(false)
          setRoute(null)
          setMustSignIn(false)
          setUser(next)
        }}
      />
    )
  }

  return <AccountContext.Provider value={account}>{children}</AccountContext.Provider>
}
