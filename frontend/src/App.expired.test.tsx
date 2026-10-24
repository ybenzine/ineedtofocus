import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App.tsx'
import { AuthError, type AuthApi, type User } from './auth/api.ts'
import AuthGate from './auth/AuthGate.tsx'
import {
  OWNER_KEY,
  USER_KEY,
  claimLocalData,
  notifySessionExpired,
  signedInUserId,
} from './auth/localData.ts'
import { AlertPlayer, MemoryAlertVolumeStore } from './sounds/alerts.ts'
import { MemoryPreferencesStore } from './setup/preferences.ts'
import { SettingsStore } from './settings/store.ts'
import { OwnedActiveSessionStore } from './sync/index.ts'
import { LocalActiveSessionStore, TimerController, type SessionRecord } from './timer/index.ts'

const user: User = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }
const other: User = { id: 'u2', email: 'c@d.co', created_at: '2026-10-23T00:00:00Z' }

function setup(me: AuthApi['me'], options: { running?: boolean; settings?: boolean } = {}) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  localStorage.setItem(OWNER_KEY, user.id)
  const saved: { record: SessionRecord; owner: string | null }[] = []
  const active = new OwnedActiveSessionStore(new LocalActiveSessionStore(), signedInUserId)
  const controller = new TimerController({
    store: active,
    saveRecord: (record) => {
      saved.push({ record, owner: active.ownerOf(record.id) ?? null })
    },
  })
  const preStarted = options.running
    ? controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    : Promise.resolve()
  const alerts = new AlertPlayer({ volume: new MemoryAlertVolumeStore() })
  const handle = vi.spyOn(alerts, 'handleEvents').mockImplementation(() => undefined)
  const api: AuthApi = {
    me,
    signUp: vi.fn(),
    signIn: vi.fn().mockResolvedValue(user),
    signOut: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <AuthGate api={api}>
      <App
        controller={controller}
        preferences={new MemoryPreferencesStore()}
        {...(options.settings ? {} : { settings: new SettingsStore() })}
        alerts={alerts}
      />
    </AuthGate>,
  )
  return { controller, saved, handle, preStarted }
}

async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(50))
}

const meSequence = () => vi.fn().mockResolvedValueOnce(user).mockResolvedValue(null)

describe('a 401 while a timer runs (#120)', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  async function startTimer() {
    await act(() => vi.advanceTimersByTimeAsync(2000))
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await act(() => vi.advanceTimersByTimeAsync(10))
    expect(screen.getByRole('timer')).toBeInTheDocument()
  }

  async function settleThen<T>(read: () => T): Promise<T> {
    await settle()
    return read()
  }

  async function expire() {
    act(() => notifySessionExpired())
    await act(() => vi.advanceTimersByTimeAsync(10))
  }

  it('keeps the timer counting, controllable and ringing, then shows sign-in after the summary', async () => {
    const { saved, handle } = setup(meSequence())
    await startTimer()
    await expire()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(localStorage.getItem(OWNER_KEY)).toBe(user.id)

    // Counting on, pause and resume work.
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(screen.getByRole('timer')).toHaveTextContent('24:')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    fireEvent.click(await settleThen(() => screen.getByRole('button', { name: 'Resume' })))

    // The countdown ends while signed out: the end bell is requested, the summary shows.
    await act(() => vi.advanceTimersByTimeAsync(25 * 60_000))
    expect(handle).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: 'session-end' })]),
    )
    const newSession = await settleThen(() => screen.getByRole('button', { name: 'New session' }))
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()

    // Saved on the device under its owner.
    expect(saved).toHaveLength(1)
    expect(saved[0]?.owner).toBe(user.id)

    // Leaving the summary shows sign-in; the data stays bound to its owner.
    fireEvent.click(newSession)
    expect(
      await settleThen(() => screen.getByRole('heading', { name: 'Sign in' })),
    ).toBeInTheDocument()
    expect(localStorage.getItem(OWNER_KEY)).toBe(user.id)
  })

  it('shows sign-in at once when no timer is running', async () => {
    setup(meSequence())
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
    await expire()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it('ends the session with Stop, then shows sign-in after the summary', async () => {
    setup(meSequence())
    await startTimer()
    await expire()
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    const next = await settleThen(() => screen.getByRole('button', { name: 'New session' }))
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
    fireEvent.click(next)
    expect(
      await settleThen(() => screen.getByRole('heading', { name: 'Sign in' })),
    ).toBeInTheDocument()
  })

  it('a different user signing in afterwards does not take the finished session', async () => {
    const { saved } = setup(meSequence())
    await startTimer()
    await expire()
    await act(() => vi.advanceTimersByTimeAsync(25 * 60_000))
    fireEvent.click(await settleThen(() => screen.getByRole('button', { name: 'New session' })))
    await settle()
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    await act(() => claimLocalData(other))
    expect(saved[0]?.owner).toBe(user.id)
    expect(localStorage.getItem(OWNER_KEY)).toBe(other.id)
  })

  it('a second 401, in the same tick or later, keeps the expired timer screen', async () => {
    setup(meSequence())
    await startTimer()
    act(() => {
      notifySessionExpired()
      notifySessionExpired()
    })
    await settle()
    act(() => notifySessionExpired())
    await act(() => vi.advanceTimersByTimeAsync(50))
    act(() => notifySessionExpired())
    await settle()
    expect(screen.getByRole('timer')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('a 401 right after the session finished keeps the summary until it is left', async () => {
    setup(meSequence())
    await startTimer()
    await act(() => vi.advanceTimersByTimeAsync(25 * 60_000))
    await settle()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    await expire()
    expect(screen.getByRole('button', { name: 'New session' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('start-up with /me answering 401 and a timer running keeps the timer; settings stay quiet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const settingsCache = JSON.stringify({
        owner: user.id,
        values: { alert_volume: 33 },
        pending: {},
      })
      localStorage.setItem('ineedtofocus.settings', settingsCache)
      const { preStarted } = setup(vi.fn().mockResolvedValue(null), {
        running: true,
        settings: false,
      })
      await act(async () => {
        await preStarted
      })
      await act(() => vi.advanceTimersByTimeAsync(3000))
      expect(screen.getByRole('timer')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Sign in' })).not.toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
      expect(localStorage.getItem('ineedtofocus.settings')).toBe(settingsCache)
      expect(localStorage.getItem(OWNER_KEY)).toBe(user.id)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('another tab removing the cached user does not sign out a running timer', async () => {
    setup(meSequence())
    await startTimer()
    localStorage.removeItem(USER_KEY)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: USER_KEY, newValue: null }))
    })
    await settle()
    expect(screen.getByRole('timer')).toBeInTheDocument()
  })

  it('leaves the expired state when the same user signs in again in another tab', async () => {
    setup(meSequence())
    await startTimer()
    await expire()
    const value = JSON.stringify(user)
    localStorage.setItem(USER_KEY, value)
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: USER_KEY, newValue: value }))
    })
    await settle()
    // Signed in again: a later 401 is a real expiry again, handled as the first.
    act(() => notifySessionExpired())
    await settle()
    expect(screen.getByRole('timer')).toBeInTheDocument()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
  })

  it('treats an unreachable server as still signed in', async () => {
    const me = vi
      .fn()
      .mockResolvedValueOnce(user)
      .mockRejectedValue(new AuthError('network', 'offline'))
    setup(me)
    await startTimer()
    await expire()
    expect(screen.getByRole('timer')).toBeInTheDocument()
    expect(localStorage.getItem(USER_KEY)).not.toBeNull()
  })
})
