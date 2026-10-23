import { useCallback, useEffect, useMemo, useState } from 'react'
import { LocalPreferencesStore, type PreferencesStore } from './setup/preferences.ts'
import SessionSetup, { type SessionRequest } from './setup/SessionSetup.tsx'
import type { AudioSource } from './setup/options.ts'
import SessionSummary from './timerscreen/SessionSummary.tsx'
import TimerScreen from './timerscreen/TimerScreen.tsx'
import { createAppServices } from './services.ts'
import { registerLocalDataHooks, type SyncEngine } from './sync/index.ts'
import type { TimerController, TimerUpdate } from './timer/index.ts'

export interface AppProps {
  /**
   * Injectable for tests. By default the app keeps the active session in localStorage, finished
   * sessions in IndexedDB, and syncs them to the server (F13).
   */
  controller?: TimerController
  /** Only used with an injected `controller`; without one, nothing is synced. */
  sync?: SyncEngine
  preferences?: PreferencesStore
  /** How often a finished session that couldn't be saved on the device is tried again. */
  pendingRetryMs?: number
}

export const PENDING_RETRY_MS = 10_000

type View =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate }

export default function App({
  controller,
  sync,
  preferences,
  pendingRetryMs = PENDING_RETRY_MS,
}: AppProps) {
  const services = useMemo(
    () => (controller ? { controller, sync: sync ?? null, hooks: null } : createAppServices()),
    [controller, sync],
  )
  const timer = services.controller
  const prefs = useMemo(() => preferences ?? new LocalPreferencesStore(), [preferences])
  const [view, setView] = useState<View>({ name: 'loading' })
  // Only the setup choice is known here; after a reload the audio source is not remembered yet
  // (audio playback and its persistence arrive with #17 and #18).
  const [notice, setNotice] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioSource>('none')

  // Pick up a session that was running when the app closed (AC6.4), or show how one that ended
  // while the app was closed finished (AC6.5).
  useEffect(() => {
    let cancelled = false
    void timer.restore().then((update) => {
      if (cancelled) return
      if (update.snapshot) setView({ name: 'timer' })
      else if (update.outcome) setView({ name: 'summary', update })
      else setView({ name: 'setup' })
    })
    return () => {
      cancelled = true
    }
  }, [timer])

  // Send what is on the device now, when the connection returns, and on backoff (AC13.3).
  useEffect(() => services.sync?.start(), [services])

  // Sign-out (#9) asks these what would be lost, syncs one last time, and clears.
  useEffect(() => (services.hooks ? registerLocalDataHooks(services.hooks) : undefined), [services])

  // A finished session that couldn't be saved on the device yet (a stalled IndexedDB) stays in
  // the timer's own store; keep trying, and drop the "not saved yet" note once it is saved.
  const recordPending = view.name === 'summary' && view.update.recordPending
  useEffect(() => {
    if (!recordPending) return
    let busy = false
    const id = window.setInterval(() => {
      if (busy) return
      busy = true
      void timer
        .retryPending()
        .then((saved) => {
          if (!saved) return
          setView((current) =>
            current.name === 'summary'
              ? { name: 'summary', update: { ...current.update, recordPending: false } }
              : current,
          )
        })
        .finally(() => {
          busy = false
        })
    }, pendingRetryMs)
    return () => window.clearInterval(id)
  }, [recordPending, timer, pendingRetryMs])

  async function start(request: SessionRequest) {
    setNotice(null)
    await timer.start({ config: request.config, tag: request.tag, goal: request.goal })
    setAudio(request.audio)
    setView({ name: 'timer' })
  }

  const ended = useCallback((update: TimerUpdate) => {
    // An update with no outcome means another tab ended the session; that tab shows the summary.
    if (update.outcome) {
      setView({ name: 'summary', update })
    } else {
      setNotice('This session was ended in another tab.')
      setView({ name: 'setup' })
    }
  }, [])

  if (view.name === 'loading') return <main aria-busy="true" />

  if (view.name === 'timer') {
    return (
      <main className="dark-screen">
        <TimerScreen controller={timer} audio={audio} onEnded={ended} />
      </main>
    )
  }

  if (view.name === 'summary' && view.update.outcome) {
    return (
      <main className="dark-screen">
        <SessionSummary
          outcome={view.update.outcome}
          recordPending={view.update.recordPending}
          onNewSession={() => setView({ name: 'setup' })}
        />
      </main>
    )
  }

  return (
    <main>
      {notice && <p role="status">{notice}</p>}
      <SessionSetup preferences={prefs} onStart={start} />
    </main>
  )
}
