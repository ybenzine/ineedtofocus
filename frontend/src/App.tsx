import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer } from './sounds/alerts.ts'
import AudioControls from './sounds/AudioControls.tsx'
import { LocalAudioSourceStore, type AudioSourceStore } from './sounds/audioSource.ts'
import { RainPlayer } from './sounds/rain.ts'
import { useAccount } from './auth/AccountContext.tsx'
import AccountBar from './auth/AccountBar.tsx'
import ArchiveScreen from './archive/ArchiveScreen.tsx'
import HistoryScreen from './history/HistoryScreen.tsx'
import { notifySessionExpired, signedInUserId } from './auth/localData.ts'
import ScreenNav from './nav/ScreenNav.tsx'
import { pathForScreen, screenFromPath, type ScreenId } from './nav/screens.ts'
import { httpSettingsApi } from './settings/api.ts'
import {
  SettingsAlertVolumeStore,
  SettingsBackgroundVolumeStore,
  SettingsPreferencesStore,
} from './settings/adapters.ts'
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
  /** Injectable for tests; plays the background rain (#17). */
  rain?: RainPlayer
  /** Injectable for tests; remembers the chosen audio source across reloads. */
  audioStore?: AudioSourceStore
}

export const PENDING_RETRY_MS = 10_000

type View =
  | { name: 'loading' }
  | { name: ScreenId }
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
  // Re-armed on every setup: StrictMode runs setup, cleanup, setup on the same instance.
  useEffect(() => {
    settings.arm()
    return () => settings.dispose()
  }, [settings])
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
  rain,
  audioStore,
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
  const rainPlayer = useMemo(
    () =>
      rain ??
      new RainPlayer({ alerts: player, volume: new SettingsBackgroundVolumeStore(settings) }),
    [rain, player, settings],
  )
  const sourceStore = useMemo(() => audioStore ?? new LocalAudioSourceStore(), [audioStore])
  const { values } = useSettingsState()
  const [view, setView] = useState<View>({ name: 'loading' })
  // The audio source is remembered with the active session (sourceStore), so a reload restores it.
  const [notice, setNotice] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioSource>('none')

  // The sign-in expired mid-session: the timer screen and its summary stay; sign-in follows
  // as soon as the user is on any other screen (#120).
  const account = useAccount()
  const leaveExpired = account?.expired ? account.leaveExpired : null
  useEffect(() => {
    if (leaveExpired && view.name !== 'loading' && view.name !== 'timer' && view.name !== 'summary')
      leaveExpired()
  }, [leaveExpired, view.name])

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
        void settings.refresh() // no wait: sends pending edits, fetches the server copy
        if (!cancelled) {
          setAudio(sourceStore.load())
          setView({ name: 'timer' })
        }
      } else if (update.outcome) {
        sourceStore.clear()
        void settings.refresh()
        if (!cancelled) setView({ name: 'summary', update })
      } else if (screenFromPath(window.location.pathname) !== 'setup') {
        // A deep link (`/history`, `/archive`, `/settings`): those screens don't wait for the server's copy.
        void settings.refresh()
        if (!cancelled) setView({ name: screenFromPath(window.location.pathname) })
      } else {
        sourceStore.clear()
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
  }, [timer, settings, sourceStore])

  // Sync settings whenever the connection returns; at launch `refresh()` runs in the restore
  // effect above (waited for only when the setup screen opens).
  useEffect(() => settings.start(), [settings])

  // The back and forward buttons move between the screens that have URLs (`/history`, `/archive`, `/settings`). They
  // never take over a running timer or a summary.
  useEffect(() => {
    function onPopState() {
      const screen = screenFromPath(window.location.pathname)
      setView((current) =>
        current.name === 'setup' ||
        current.name === 'history' ||
        current.name === 'archive' ||
        current.name === 'settings'
          ? { name: screen }
          : current,
      )
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function goTo(screen: ScreenId) {
    const path = pathForScreen(screen)
    if (window.location.pathname !== path) window.history.pushState(null, '', path)
    setView({ name: screen })
  }

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
    sourceStore.save(request.audio)
    setAudio(request.audio)
    setView({ name: 'timer' })
  }

  const ended = useCallback(
    (update: TimerUpdate) => {
      sourceStore.clear()
      // An update with no outcome means another tab ended the session; that tab shows the summary.
      if (update.outcome) {
        setView({ name: 'summary', update })
      } else {
        setNotice('This session was ended in another tab.')
        setView({ name: 'setup' })
      }
    },
    [sourceStore],
  )

  const changeAudio = useCallback(
    (source: AudioSource) => {
      sourceStore.save(source)
      setAudio(source)
    },
    [sourceStore],
  )

  if (view.name === 'loading') return <main aria-busy="true" />

  if (view.name === 'timer') {
    return (
      <main className="dark-screen">
        <TimerScreen
          controller={timer}
          audio={audio}
          onEvents={player.handleEvents}
          onEnded={ended}
          audioControls={({ paused }) => (
            <AudioControls
              source={audio}
              paused={paused}
              rain={rainPlayer}
              onSourceChange={changeAudio}
            />
          )}
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
          onNewSession={() => goTo('setup')}
          onViewHistory={() => goTo('history')}
        />
      </main>
    )
  }

  if (view.name === 'history') {
    return (
      <main className="dark-screen history-screen">
        <AccountBar controller={timer} />
        <ScreenNav current="history" onNavigate={goTo} />
        <HistoryScreen
          sessions={services.sessions}
          sync={services.sync}
          onNewSession={() => goTo('setup')}
        />
      </main>
    )
  }

  if (view.name === 'archive') {
    return (
      <main className="dark-screen history-screen">
        <AccountBar controller={timer} />
        <ScreenNav current="archive" onNavigate={goTo} />
        <ArchiveScreen sessions={services.sessions} />
      </main>
    )
  }

  if (view.name === 'settings') {
    return (
      <main>
        <AccountBar controller={timer} />
        <ScreenNav current="settings" onNavigate={goTo} />
        <SettingsScreen player={player} />
      </main>
    )
  }

  return (
    <main>
      <AccountBar controller={timer} />
      <ScreenNav current="setup" onNavigate={goTo} />
      {notice && <p role="status">{notice}</p>}
      <SessionSetup
        preferences={prefs}
        defaultReminderMinutes={values.default_reminder_minutes}
        onStart={start}
      />
    </main>
  )
}
