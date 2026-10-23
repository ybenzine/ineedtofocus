import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer, LocalAlertVolumeStore } from './sounds/alerts.ts'
import AccountBar from './auth/AccountBar.tsx'
import { LocalPreferencesStore, type PreferencesStore } from './setup/preferences.ts'
import SessionSetup, { type SessionRequest } from './setup/SessionSetup.tsx'
import type { AudioSource } from './setup/options.ts'
import SessionSummary from './timerscreen/SessionSummary.tsx'
import TimerScreen from './timerscreen/TimerScreen.tsx'
import { createAppServices, type AppServices } from './services.ts'
import type { TimerController, TimerUpdate } from './timer/index.ts'

export interface AppProps {
  /**
   * The timer, session store and sync (`main.tsx` creates them once). Without them the app
   * makes its own: the active session in localStorage, finished sessions in IndexedDB, synced
   * to the server (F13).
   */
  services?: AppServices
  /** For tests: just a timer, with nothing stored or synced beyond what it is given. */
  controller?: TimerController
  preferences?: PreferencesStore
  /** How often a finished session that couldn't be saved on the device is tried again. */
  pendingRetryMs?: number
  /** Injectable for tests; plays the chime and the end bell (#16). */
  alerts?: AlertPlayer
}

export const PENDING_RETRY_MS = 10_000

type View =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate }

export default function App({
  services: given,
  controller,
  preferences,
  alerts,
  pendingRetryMs = PENDING_RETRY_MS,
}: AppProps) {
  const services = useMemo<AppServices>(
    () => given ?? (controller ? { controller, sync: null, hook: null } : createAppServices()),
    [given, controller],
  )
  const timer = services.controller
  const prefs = useMemo(() => preferences ?? new LocalPreferencesStore(), [preferences])
  const player = useMemo(
    () => alerts ?? new AlertPlayer({ volume: new LocalAlertVolumeStore() }),
    [alerts],
  )
  const [view, setView] = useState<View>({ name: 'loading' })
  // Only the setup choice is known here; after a reload the audio source is not remembered yet
  // (audio playback and its persistence arrive with #17 and #18).
  const [notice, setNotice] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioSource>('none')

  // A session restored after a reload has had no user gesture yet: unlock audio on the first
  // one, or iOS keeps every later chime and bell silent.
  useEffect(() => {
    if (view.name !== 'timer') return
    return player.unlockOnGesture()
  }, [view.name, player])

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
  // Runs only while someone is signed in: AuthGate renders the app only then (#9).
  useEffect(() => services.sync?.start(), [services])

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
    void player.unlock() // the Start press is the user gesture browsers require before audio
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
        <TimerScreen
          controller={timer}
          audio={audio}
          onEvents={player.handleEvents}
          onEnded={ended}
        />
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
      <AccountBar controller={timer} />
      {notice && <p role="status">{notice}</p>}
      <SessionSetup preferences={prefs} onStart={start} />
    </main>
  )
}
