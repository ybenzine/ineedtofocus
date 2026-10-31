import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.tsx'
import { AuthError, type AuthApi, type User } from '../auth/api.ts'
import AuthGate from '../auth/AuthGate.tsx'
import { OWNER_KEY } from '../auth/localData.ts'
import { IndexedDbSessionStore, OwnedActiveSessionStore } from '../sync/index.ts'
import { MemoryPreferencesStore } from '../setup/preferences.ts'
import {
  ACTIVE_SESSION_KEY,
  LocalActiveSessionStore,
  TimerController,
  type StoredTimer,
} from '../timer/index.ts'
import { SETTINGS_KEY } from '../settings/store.ts'
import {
  ANON_ACTIVE_SESSION_KEY,
  ANON_AUDIO_SOURCE_KEY,
  ANON_HELD_ID_KEY,
  ANON_SETTINGS_KEY,
  ANON_YOUTUBE_LINK_KEY,
  ANONYMOUS_PREFIX,
} from './keys.ts'
import { hasStoredSession } from '../update/autoUpdate.ts'

const NINE = Date.UTC(2026, 9, 30, 9, 0)
const alice: User = { id: 'u1', email: 'a@b.co', created_at: '2026-10-30T00:00:00Z' }

function makeApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(null),
    signUp: vi.fn().mockResolvedValue(alice),
    signIn: vi.fn().mockResolvedValue(alice),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const fetchSpy = vi.fn()

beforeEach(() => {
  fetchSpy.mockReset().mockRejectedValue(new Error('no network in this test'))
  vi.stubGlobal('fetch', fetchSpy)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NINE)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
  localStorage.clear()
  sessionStorage.clear()
})

interface Rig {
  api: AuthApi
  saveRecord: ReturnType<typeof vi.fn>
  account: TimerController
}

function renderApp(
  options: { api?: AuthApi; saveRecord?: (record: unknown) => Promise<void> | void } = {},
) {
  const api = options.api ?? makeApi()
  const saveRecord = vi.fn(options.saveRecord ?? (() => undefined))
  // The account's timer: the one the app uses once someone is signed in.
  const account = new TimerController({
    store: new OwnedActiveSessionStore(new LocalActiveSessionStore(), () => alice.id),
    saveRecord,
  })
  const ui = (
    <AuthGate api={api} handOver={(state) => account.adopt(state)}>
      <App
        services={{ controller: account, sync: null, hook: null }}
        preferences={new MemoryPreferencesStore()}
        pendingRetryMs={50}
      />
    </AuthGate>
  )
  const view = render(ui)
  const rig: Rig = { api, saveRecord, account }
  return { ...view, rig, rerender: () => view.rerender(ui) }
}

async function startAndStop(seconds: number) {
  fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
  await screen.findByRole('timer')
  await act(async () => {
    vi.setSystemTime(NINE + seconds * 1000)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
}

async function finishAnonymousSession(seconds = 120) {
  await startAndStop(seconds)
  await screen.findByText(isPrompt)
}

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
}

const PROMPT = 'Create an account or log in to save this session'
/** The prompt is one paragraph with two links in it, so its text is split across elements. */
const isPrompt = (_content: string, element: Element | null) =>
  element?.tagName === 'P' && element.textContent === PROMPT

function apiCalls(): string[] {
  return fetchSpy.mock.calls.map((call) => String(call[0]))
}

describe('first screen and account bar', () => {
  it('opens on New session when the device holds no account data, with no data request', async () => {
    const { rig } = renderApp()
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    // Only the start-up check of the sign-in.
    expect(rig.api.me).toHaveBeenCalledTimes(1)
    expect(apiCalls()).toEqual([])
  })

  it('shows Create account and Log in in the account bar, with no email or Sign out', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/signup')
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(screen.queryByText(/@/)).not.toBeInTheDocument()
  })

  it('does not show the account bar over the timer', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument()
  })

  it('shows the sign-in screen first when an account left its data (an expired sign-in)', async () => {
    localStorage.setItem(OWNER_KEY, alice.id)
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    // Anonymous use is allowed here: the slot is empty.
    expect(screen.getByRole('link', { name: 'Continue without an account' })).toBeInTheDocument()
  })

  it('does not offer anonymous use while an account session sits in the slot', async () => {
    const stuck = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => Promise.reject(new Error('down')),
    })
    await stuck.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: 'mine' })
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue without an account' })).toBeNull()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull()
  })

  it('takes a tab that is showing anonymous use to sign-in when an account session appears', async () => {
    renderApp()
    await screen.findByRole('button', { name: 'Start' })
    const other = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await other.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: ACTIVE_SESSION_KEY }))
    })
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Continue without an account' })).toBeNull()
  })

  it('refuses to start while an account session is in the other slot (AC6.1)', async () => {
    renderApp()
    const start = await screen.findByRole('button', { name: 'Start' })
    const other = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: () => undefined,
    })
    await other.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    fireEvent.click(start)
    expect(await screen.findByText(/already active/)).toBeInTheDocument()
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
  })
})

describe('/signup, /login and Continue without an account', () => {
  it('opens the sign-up form at /signup and the sign-in form at /login', async () => {
    window.history.replaceState(null, '', '/signup')
    const { unmount } = renderApp()
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    unmount()
    window.history.replaceState(null, '', '/login')
    renderApp()
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('opens a form from the account bar and Continue goes back to the screen it was opened from', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    fireEvent.click(screen.getByRole('link', { name: 'Log in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    fireEvent.click(screen.getByRole('link', { name: 'Continue without an account' }))
    await screen.findByRole('heading', { name: 'Settings' })
    await waitFor(() => expect(window.location.pathname).toBe('/settings'))
  })

  it('Continue from a form opened directly goes to New session', async () => {
    window.history.replaceState(null, '', '/login')
    renderApp()
    fireEvent.click(await screen.findByRole('link', { name: 'Continue without an account' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('a sign-in opened from the account bar returns to the screen it was opened from', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    await screen.findByRole('heading', { name: 'History' })
    fireEvent.click(screen.getByRole('link', { name: 'Log in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(window.location.pathname).toBe('/history'))
  })

  it('a sign-in opened directly at /login and every sign-up land on New session', async () => {
    window.history.replaceState(null, '', '/login')
    const first = renderApp()
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(window.location.pathname).toBe('/')
    first.unmount()
    localStorage.clear()

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Create account' }))
    await screen.findByRole('heading', { name: 'Create your account' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(window.location.pathname).toBe('/')
  })

  it('a signed-in user going to /login gets New session', async () => {
    window.history.replaceState(null, '', '/login')
    renderApp({ api: makeApi({ me: vi.fn().mockResolvedValue(alice) }) })
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})

describe('what an anonymous user can do', () => {
  it('runs a session in its own slot, never in the account keys, IndexedDB or the sync queue', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).not.toBeNull()
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem('ineedtofocus.activeSessionOwner')).toBeNull()
    expect(apiCalls()).toEqual([])
  })

  it('restores a running anonymous session after a reload', async () => {
    const first = renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    first.unmount() // the reload
    renderApp()
    expect(await screen.findByRole('timer')).toBeInTheDocument()
  })

  it('shows History and Archive as one paragraph with links, and makes no request', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    const history = await screen.findByRole('heading', { name: 'History' })
    const section = history.closest('section') as HTMLElement
    expect(section.querySelectorAll('p')).toHaveLength(1)
    expect(section).toHaveTextContent('Create an account or log in to see your focus history.')
    expect(within(section).getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup',
    )
    expect(within(section).getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/login')

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    const archive = (await screen.findByRole('heading', { name: 'Archive' })).closest(
      'section',
    ) as HTMLElement
    expect(archive).toHaveTextContent('Create an account or log in to see your archived sessions.')
    expect(apiCalls()).toEqual([])
  })

  it('shows Settings without Week start and the Account section, saved on the device only', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    expect(
      screen.getByText(
        "Without an account, your settings are saved on this device only. When you log in, your account's settings are used instead.",
      ),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Week starts on')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(JSON.parse(localStorage.getItem(ANON_SETTINGS_KEY) ?? '{}').values.theme).toBe('light')
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    expect(apiCalls()).toEqual([])
  })

  it('remembers the audio source and YouTube link under the anonymous keys, with no recent list', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('radio', { name: 'YouTube' }))
    fireEvent.change(screen.getByLabelText('YouTube link'), {
      target: { value: 'https://youtu.be/dQw4w9WgXcQ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    expect(localStorage.getItem(ANON_AUDIO_SOURCE_KEY)).toBe('youtube')
    expect(localStorage.getItem(ANON_YOUTUBE_LINK_KEY)).toBe('https://youtu.be/dQw4w9WgXcQ')
    expect(localStorage.getItem('ineedtofocus.youtubeLink')).toBeNull()
    expect(apiCalls()).toEqual([])
  })
})

describe('the summary prompt', () => {
  it('shows the prompt, with two links, for a session of at least 60 s', async () => {
    renderApp()
    await finishAnonymousSession(60)
    const prompt = screen.getByText(isPrompt).closest('p') as HTMLElement
    expect(prompt).toHaveTextContent(PROMPT)
    expect(within(prompt).getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup',
    )
    expect(within(prompt).getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/login')
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'View history' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Not saved yet/)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('shows today\'s "not saved" message and no prompt under 60 s', async () => {
    renderApp()
    await startAndStop(59)
    expect(await screen.findByRole('heading', { name: 'Session not saved' })).toBeInTheDocument()
    expect(screen.queryByText(isPrompt)).not.toBeInTheDocument()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBeNull()
  })

  it('keeps the finished record out of every storage and the marker names it', async () => {
    renderApp()
    fireEvent.change(await screen.findByLabelText(/What are you focusing on/), {
      target: { value: 'private goal' },
    })
    await startAndStop(120)
    await screen.findByText(isPrompt)
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).not.toBeNull()
    expect(JSON.stringify({ ...localStorage })).not.toContain('private goal')
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('private goal')
    const sessions = new IndexedDbSessionStore()
    expect(await sessions.countUnsynced(null)).toEqual({ sessions: 0, edits: 0 })
    sessions.close()
    expect(apiCalls()).toEqual([])
  })

  it('keeps the page busy for the automatic update, and another tab may still update', async () => {
    renderApp()
    await finishAnonymousSession()
    const { holdsMemoryOnlyData } = await import('../update/idle.ts')
    expect(holdsMemoryOnlyData()).toBe(true)
    // The marker is not a stored session: another idle tab is free to update.
    expect(hasStoredSession()).toBe(false)
  })

  it('discards the held session quietly on New session', async () => {
    renderApp()
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(localStorage.getItem(ANON_HELD_ID_KEY)).toBeNull()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('discards it on a reload', async () => {
    const first = renderApp()
    await finishAnonymousSession()
    first.unmount()
    renderApp()
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(isPrompt)).not.toBeInTheDocument()
  })

  it('discards it when a session starts in another tab, caught on visibilitychange', async () => {
    renderApp()
    await finishAnonymousSession()
    // Another tab starts a session: it replaces the marker.
    localStorage.removeItem(ANON_HELD_ID_KEY)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(isPrompt)).not.toBeInTheDocument()
  })

  it('discards it when a sign-in elsewhere clears the anonymous keys', async () => {
    renderApp()
    await finishAnonymousSession()
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(ANONYMOUS_PREFIX)) localStorage.removeItem(key)
    }
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('a finish that another page claimed first is not shown', async () => {
    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    await act(async () => {
      vi.setSystemTime(NINE + 120_000)
    })
    // Another tab finishes it first: the slot is empty by the time this one stops.
    localStorage.removeItem(ANON_ACTIVE_SESSION_KEY)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByText(isPrompt)).not.toBeInTheDocument()
  })

  it('shows a countdown that ended while the app was closed as the held session', async () => {
    const first = renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    first.unmount() // the app closes
    vi.setSystemTime(NINE + 3 * 3_600_000)
    renderApp()
    expect(await screen.findByText(isPrompt)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Session complete' })).toBeInTheDocument()
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
  })
})

describe('signing up or in from the prompt', () => {
  it('opens the form in place, keeps the session, and Back or Continue return to the summary', async () => {
    renderApp()
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }))
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/signup')
    // Switching forms keeps the origin.
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    fireEvent.click(screen.getByRole('link', { name: 'Continue without an account' }))
    expect(await screen.findByText(isPrompt)).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Session ended early' })).toBeInTheDocument()

    // The browser's Back button acts the same.
    fireEvent.click(screen.getByRole('link', { name: 'log in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    act(() => {
      window.history.back()
    })
    expect(await screen.findByText(isPrompt)).toBeInTheDocument()
  })

  it('saves the session after a sign-up and shows its summary, signed in', async () => {
    const { rig } = renderApp()
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }))
    await screen.findByRole('heading', { name: 'Create your account' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('This session is now in your account.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('This session is now in your account.')
    expect(screen.getByRole('link', { name: 'View history' })).toBeInTheDocument()
    expect(screen.queryByText(isPrompt)).not.toBeInTheDocument()
    expect(rig.saveRecord).toHaveBeenCalledTimes(1)
    const record = rig.saveRecord.mock.calls[0]?.[0] as { focusSeconds: number; id: string }
    expect(record.focusSeconds).toBe(120)
    expect(window.location.pathname).toBe('/')
    expect(localStorage.getItem(OWNER_KEY)).toBe(alice.id)
    // Everything anonymous is gone.
    expect(Object.keys(localStorage).filter((k) => k.startsWith(ANONYMOUS_PREFIX))).toEqual([])
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
  })

  it('saves it after a sign-in too', async () => {
    const { rig } = renderApp()
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'log in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('This session is now in your account.')).toBeInTheDocument()
    expect(rig.api.signIn).toHaveBeenCalledTimes(1)
    expect(rig.saveRecord).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed device write as a pending record, with the usual note, and says it is in the account once saved', async () => {
    let fail = true
    const { rig } = renderApp({
      saveRecord: () => (fail ? Promise.reject(new Error('IndexedDB down')) : undefined),
    })
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }))
    await screen.findByRole('heading', { name: 'Create your account' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(/Not saved yet/)).toBeInTheDocument()
    expect(screen.queryByText('This session is now in your account.')).not.toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem(ACTIVE_SESSION_KEY) ?? 'null') as StoredTimer
    expect(stored.pendingRecord?.focusSeconds).toBe(120)

    fail = false
    expect(await screen.findByText('This session is now in your account.')).toBeInTheDocument()
    expect(rig.saveRecord.mock.calls.length).toBeGreaterThan(1)
    expect(localStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull()
  })

  it('does not save a session whose marker is gone by the time the sign-in answers', async () => {
    const signUp = vi.fn(async () => {
      // Another tab started a session while the request was out.
      localStorage.removeItem(ANON_HELD_ID_KEY)
      return alice
    })
    const { rig } = renderApp({ api: makeApi({ signUp }) })
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'Create an account' }))
    await screen.findByRole('heading', { name: 'Create your account' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(rig.saveRecord).not.toHaveBeenCalled()
  })

  it('keeps the session and shows the usual errors when the form fails (offline)', async () => {
    const signIn = vi.fn().mockRejectedValue(new AuthError('network', 'offline'))
    renderApp({ api: makeApi({ signIn }) })
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'log in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Continue without an account' }))
    expect(await screen.findByText(isPrompt)).toBeInTheDocument()
  })

  it('returns to the summary after a sign-out followed by anonymous use', async () => {
    const api = makeApi({ me: vi.fn().mockResolvedValue(alice) })
    const { rig } = renderApp({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    fireEvent.click(await screen.findByRole('link', { name: 'Continue without an account' }))
    await finishAnonymousSession()
    fireEvent.click(screen.getByRole('link', { name: 'log in' }))
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('This session is now in your account.')).toBeInTheDocument()
    expect(rig.saveRecord).toHaveBeenCalledTimes(1)
  })
})

describe('clearing at every sign-in', () => {
  it('removes every anonymous key, whatever is stored, at a sign-in not from the prompt', async () => {
    localStorage.setItem(ANON_SETTINGS_KEY, '{"values":{}}')
    localStorage.setItem(ANON_AUDIO_SOURCE_KEY, 'rain')
    localStorage.setItem(ANON_YOUTUBE_LINK_KEY, 'https://youtu.be/dQw4w9WgXcQ')
    localStorage.setItem(ANON_HELD_ID_KEY, 'some-id')
    window.history.replaceState(null, '', '/login')
    renderApp()
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(Object.keys(localStorage).filter((k) => k.startsWith(ANONYMOUS_PREFIX))).toEqual([])
  })

  it('discards a running anonymous session in the slot at a sign-in', async () => {
    const first = renderApp()
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }))
    await screen.findByRole('timer')
    first.unmount()
    window.history.replaceState(null, '', '/login')
    renderApp()
    await screen.findByRole('heading', { name: 'Sign in' })
    fill('a@b.co', 'longenough1')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByRole('button', { name: 'Start' })
    expect(localStorage.getItem(ANON_ACTIVE_SESSION_KEY)).toBeNull()
  })

  it("never reads, rewrites or clears an expired account's data while used anonymously", async () => {
    const accountData = {
      [OWNER_KEY]: alice.id,
      [SETTINGS_KEY]: JSON.stringify({ owner: alice.id, values: { theme: 'dark' }, pending: {} }),
      'ineedtofocus.audioSource': 'rain',
    }
    for (const [key, value] of Object.entries(accountData)) localStorage.setItem(key, value)
    renderApp()
    fireEvent.click(await screen.findByRole('link', { name: 'Continue without an account' }))
    await startAndStop(120)
    await screen.findByText(isPrompt)
    for (const [key, value] of Object.entries(accountData)) {
      expect(localStorage.getItem(key)).toBe(value)
    }
    expect(apiCalls()).toEqual([])
  })
})
