import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer } from './sounds/alerts.ts'
import AccountBar from './auth/AccountBar.tsx'
import ScreenNav from './nav/ScreenNav.tsx'
import { type ScreenId } from './nav/screens.ts'
import { httpSettingsApi } from './settings/api.ts'
import { SettingsPreferencesStore, SettingsAlertVolumeStore } from './settings/adapters.ts'
import { SettingsContext, useSettingsState } from './settings/SettingsContext.ts'
import SettingsScreen from './settings/SettingsScreen.tsx'
import { SettingsStore } from './settings/store.ts'
import { type PreferencesStore } from './setup/preferences.ts'
import SessionSetup, { type SessionRequest } from './setup/SessionSetup.tsx'
import type { AudioSource } from './setup/options.ts'
import SessionSummary from './timerscreen/SessionSummary.tsx'
import TimerScreen from './timerscreen/TimerScreen.tsx'
import {
  LocalActiveSessionStore,
  TimerController,
  type SessionRecord,
  type TimerUpdate,
} from './timer/index.ts'

export interface AppProps {
  /** Injectable for tests; the app uses the device's localStorage by default. */
  controller?: TimerController
  /** Settings with their device cache and sync; the app uses the Settings API by default. */
  settings?: SettingsStore
  /** Overrides the settings-backed last-used Pomodoro config and tag. */
  preferences?: PreferencesStore
  /** Injectable for tests; plays the chime and the end bell (#16). */
  alerts?: AlertPlayer
}

// The session store (IndexedDB, #19) isn't built yet; until it is, finished records are dropped.
// #19 replaces this.
function saveRecordPlaceholder(record: SessionRecord): void {
  void record
}

function createController(): TimerController {
  return new TimerController({
    store: new LocalActiveSessionStore(),
    saveRecord: saveRecordPlaceholder,
  })
}

type View =
  | { name: 'loading' }
  | { name: 'setup' }
  | { name: 'settings' }
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate }

/** How long a first look at the server's settings may hold up the setup screen. */
const SETTINGS_WAIT_MS = 1500

function createSettings(): SettingsStore {
  return new SettingsStore({ api: httpSettingsApi, storage: window.localStorage })
}

export default function App(props: AppProps) {
  const settings = useMemo(() => props.settings ?? createSettings(), [props.settings])
  return (
    <SettingsContext.Provider value={settings}>
      <AppBody {...props} settings={settings} />
    </SettingsContext.Provider>
  )
}

function AppBody({
  controller,
  settings,
  preferences,
  alerts,
}: AppProps & { settings: SettingsStore }) {
  const timer = useMemo(() => controller ?? createController(), [controller])
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
    // Sync settings whenever the connection returns (AC13.3).
    return settings.start()
  }, [settings])

  useEffect(() => {
    let cancelled = false
    // The setup screen reads the last-used config and tag once, so give the server's copy a
    // moment to arrive first (another device may have changed it); offline it is skipped.
    let timeout: ReturnType<typeof setTimeout> | undefined
    const settingsReady = Promise.race([
      settings.refresh(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, SETTINGS_WAIT_MS)
      }),
    ]).finally(() => clearTimeout(timeout))
    void Promise.all([timer.restore(), settingsReady]).then(([update]) => {
      if (cancelled) return
      if (update.snapshot) setView({ name: 'timer' })
      else if (update.outcome) setView({ name: 'summary', update })
      else setView({ name: 'setup' })
    })
    return () => {
      cancelled = true
    }
  }, [timer, settings])

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
