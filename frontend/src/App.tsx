import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer } from './sounds/alerts.ts'
import AccountBar from './auth/AccountBar.tsx'
import { notifySessionExpired, signedInUserId } from './auth/localData.ts'
import ScreenNav from './nav/ScreenNav.tsx'
import { type ScreenId } from './nav/screens.ts'
import { httpSettingsApi } from './settings/api.ts'
import { SettingsAlertVolumeStore, SettingsPreferencesStore } from './settings/adapters.ts'
import { SettingsContext, useSettingsState } from './settings/SettingsContext.ts'
import SettingsScreen from './settings/SettingsScreen.tsx'
import { SettingsStore } from './settings/store.ts'
import { type PreferencesStore } from './setup/preferences.ts'
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
  /** Settings with their device cache and sync; the app uses the Settings API by default. */
  settings?: SettingsStore
  /** Overrides the settings-backed last-used Pomodoro config and tag. */
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
  | { name: 'settings' }
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate }

/** How long a first look at the server's settings may hold up the setup screen. */
export const SETTINGS_WAIT_MS = 1500

/**
 * One settings store per signed-in mount (AuthGate renders the app only while someone is signed
 * in), bound to that user, so nothing of theirs outlives them or reaches the next account.
 */
export default function App(props: AppProps) {
  const { settings: given } = props
  const settings = useMemo(
    () =>
      given ??
      new SettingsStore({
        api: httpSettingsApi,
        storage: window.localStorage,
        owner: signedInUserId(),
        currentOwner: signedInUserId,
        onUnauthorized: notifySessionExpired,
      }),
    [given],
  )
  useEffect(() => () => settings.dispose(), [settings])
  return (
    <SettingsContext.Provider value={settings}>
      <AppBody {...props} settings={settings} />
    </SettingsContext.Provider>
  )
}

function AppBody({
  services: given,
  controller,
  settings,
  preferences,
  alerts,
  pendingRetryMs = PENDING_RETRY_MS,
}: AppProps & { settings: SettingsStore }) {
  const services = useMemo<AppServices>(
    () => given ?? (controller ? { controller, sync: null, hook: null } : createAppServices()),
    [given, controller],
  )
  const timer = services.controller
  const prefs = useMemo(
    () => preferences ?? new SettingsPreferencesStore(settings),
    [preferences, settings],
  )
  const player = useMemo(
    () => alerts ?? new AlertPlayer({ volume: new SettingsAlertVolumeStore(settings) }),
    [alerts, settings],
  )
  const { values } = useSettingsState()
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
    void timer.restore().then(async (update) => {
      if (update.snapshot) {
        if (!cancelled) setView({ name: 'timer' })
      } else if (update.outcome) {
        if (!cancelled) setView({ name: 'summary', update })
      } else {
        // Only the setup screen needs the server's last-used config and tag, which it reads
        // once: give them a moment to arrive (another device may have changed them). Offline,
        // or slow, it opens from the device copy.
        let timeout: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          settings.refresh(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, SETTINGS_WAIT_MS)
          }),
        ])
        clearTimeout(timeout)
        if (!cancelled) setView({ name: 'setup' })
      }
    })
    return () => {
      cancelled = true
    }
  }, [timer, settings])

  // Sync settings at launch (when not waited for above) and whenever the connection returns.
  useEffect(() => settings.start(), [settings])

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

  const navigate = (screen: ScreenId) =>
    setView(screen === 'settings' ? { name: 'settings' } : { name: 'setup' })

  if (view.name === 'settings') {
    return (
      <main>
        <AccountBar controller={timer} />
        <ScreenNav current="settings" onNavigate={navigate} />
        <SettingsScreen player={player} />
      </main>
    )
  }

  return (
    <main>
      <AccountBar controller={timer} />
      <ScreenNav current="setup" onNavigate={navigate} />
      {notice && <p role="status">{notice}</p>}
      <SessionSetup
        preferences={prefs}
        defaultReminderMinutes={values.default_reminder_minutes}
        onStart={start}
      />
    </main>
  )
}
