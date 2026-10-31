import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer } from './sounds/alerts.ts'
import AudioControls from './sounds/AudioControls.tsx'
import {
  getDefaultLinkStore,
  LocalAudioSourceStore,
  LocalYoutubeLinkStore,
  type AudioSourceStore,
  type YoutubeLinkStore,
} from './sounds/audioSource.ts'
import { httpYoutubeLinksApi, type YoutubeLinksApi } from './sounds/youtubeLinksApi.ts'
import type { LoadYoutubeApi } from './sounds/ytApi.ts'
import { RainPlayer } from './sounds/rain.ts'
import { useAccount } from './auth/AccountContext.tsx'
import AccountBar from './auth/AccountBar.tsx'
import { useAnonymous } from './anonymous/AnonymousContext.ts'
import { AnonymousArchive, AnonymousHistory } from './anonymous/AnonymousScreens.tsx'
import { anonymousYoutubeApi } from './anonymous/youtube.ts'
import {
  ANON_AUDIO_SOURCE_KEY,
  ANON_SETTINGS_KEY,
  ANON_SETTINGS_LOCK,
  ANON_YOUTUBE_LINK_KEY,
} from './anonymous/keys.ts'
import ArchiveScreen from './archive/ArchiveScreen.tsx'
import HistoryScreen from './history/HistoryScreen.tsx'
import {
  accountSlotHasSession,
  anonymousSlotHasSession,
  notifySessionExpired,
  registerMemoryTimerProbe,
  registerLocalDataHook,
  signedInUserId,
  trySyncAll,
} from './auth/localData.ts'
import { registerMemoryHolder, registerUpdateFlush, setViewBusy } from './update/idle.ts'
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
import { settingsDataHook } from './settings/hook.ts'
import { heldRecordHook } from './timer/hook.ts'
import { SettingsStore } from './settings/store.ts'
import { type PreferencesStore } from './setup/preferences.ts'
import SessionSetup, { type SessionRequest } from './setup/SessionSetup.tsx'
import type { AudioSource } from './setup/options.ts'
import SessionSummary from './timerscreen/SessionSummary.tsx'
import TimerScreen from './timerscreen/TimerScreen.tsx'
import { createAnonymousServices, createAppServices, type AppServices } from './services.ts'
import { useTheme } from './theme.ts'
import { ActiveSessionExistsError, type TimerController, type TimerUpdate } from './timer/index.ts'

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
  /** How often parked sessions are moved into the device store while the app is open. */
  parkedDrainMs?: number
  /** Injectable for tests; plays the chime and the end bell (#16). */
  alerts?: AlertPlayer
  /** Injectable for tests; plays the background rain (#17). */
  rain?: RainPlayer
  /** Injectable for tests; remembers the chosen audio source across reloads. */
  audioStore?: AudioSourceStore
  /** Injectable for tests; the YouTube link store, recent-links API and IFrame loader (#18). */
  youtube?: {
    linkStore?: YoutubeLinkStore
    api?: YoutubeLinksApi
    loadApi?: LoadYoutubeApi
  }
}

export const PENDING_RETRY_MS = 10_000
export const PARKED_DRAIN_MS = 60_000
export const FOREIGN_PENDING_MESSAGE =
  'A session from the account that used this device before could not be saved yet. We keep trying; you can start a new session once it is saved.'

type View =
  | { name: 'loading' }
  | { name: ScreenId }
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate; inAccount?: boolean }

/** How long a first look at the server's settings may hold up the setup screen. */
export const SETTINGS_WAIT_MS = 1500

/**
 * One settings store per signed-in mount (AuthGate renders the app only while someone is signed
 * in), bound to that user, so nothing of theirs outlives them or reaches the next account.
 */
export default function App(props: AppProps) {
  const { settings: given } = props
  // Expired at mount (start-up with a timer running): the store is bound to the expired user
  // so it shows their cached settings, but `currentOwner()` is null, so it never fetches,
  // sends or rewrites the cache.
  const account = useAccount()
  // Without an account (#331) settings are the device's own, under their own key, and never sent.
  const anonymous = useAnonymous()
  const [mountOwner] = useState(() => (account?.expired ? account.user.id : signedInUserId()))
  const settings = useMemo(
    () =>
      given ??
      (anonymous
        ? new SettingsStore({
            storage: window.localStorage,
            key: ANON_SETTINGS_KEY,
            lock: ANON_SETTINGS_LOCK,
          })
        : new SettingsStore({
            api: httpSettingsApi,
            storage: window.localStorage,
            owner: mountOwner,
            currentOwner: signedInUserId,
            onUnauthorized: notifySessionExpired,
          })),
    [given, mountOwner, anonymous],
  )
  // Re-armed on every setup: StrictMode runs setup, cleanup, setup on the same instance.
  useEffect(() => {
    settings.arm()
    return () => settings.dispose()
  }, [settings])
  // Sign-out sends and counts the settings edits not yet accepted (#129).
  useEffect(() => {
    if (anonymous) return
    return registerLocalDataHook(settingsDataHook(settings))
  }, [settings, anonymous])
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
  youtube: youtubeProp,
  pendingRetryMs = PENDING_RETRY_MS,
  parkedDrainMs = PARKED_DRAIN_MS,
}: AppProps & { settings: SettingsStore }) {
  const anonymous = useAnonymous()
  // Without an account the timer keeps its own slot and holds a finished session in memory; the
  // account's services (session store, sync) are never used (#331).
  const services = useMemo<AppServices>(() => {
    if (anonymous) {
      return controller
        ? { controller, sync: null, hook: null }
        : createAnonymousServices(anonymous.held)
    }
    return given ?? (controller ? { controller, sync: null, hook: null } : createAppServices())
  }, [given, controller, anonymous])
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
  const sourceStore = useMemo(
    () =>
      audioStore ??
      (anonymous
        ? new LocalAudioSourceStore(
            window.localStorage,
            ANON_AUDIO_SOURCE_KEY,
            ANON_YOUTUBE_LINK_KEY,
          )
        : new LocalAudioSourceStore()),
    [audioStore, anonymous],
  )
  // Without an account the link is remembered under the anonymous keys, there is no recent list
  // and nothing about a link or its title reaches the server.
  const youtube = useMemo(
    () =>
      anonymous
        ? {
            ...youtubeProp,
            linkStore:
              youtubeProp?.linkStore ??
              new LocalYoutubeLinkStore(window.localStorage, ANON_YOUTUBE_LINK_KEY),
            api: anonymousYoutubeApi,
          }
        : youtubeProp,
    [youtubeProp, anonymous],
  )
  const { values } = useSettingsState()
  const account = useAccount()
  // The anonymous session just saved from the summary's prompt: the app opens on its summary,
  // signed in (#331).
  const [handedOver] = useState(() => account?.handedOver ?? null)
  const [view, setView] = useState<View>(() =>
    handedOver?.outcome
      ? { name: 'summary', update: handedOver, inAccount: true }
      : { name: 'loading' },
  )
  useTheme(values.theme, view.name === 'timer' || view.name === 'summary')
  // A new version may take over only on setup, History, Archive and Settings (#244): the timer,
  // a summary and the start-up restore are never reloaded. Before a reload, send what is pending.
  const viewName = view.name
  useEffect(() => {
    setViewBusy(viewName === 'loading' || viewName === 'timer' || viewName === 'summary')
  }, [viewName])
  useEffect(() => () => setViewBusy(true), [])
  useEffect(
    () =>
      // The settings hook (#129) is among the sync hooks, so this sends settings edits too.
      registerUpdateFlush(trySyncAll),
    [],
  )
  // The audio source is remembered with the active session (sourceStore), so a reload restores it.
  const [notice, setNotice] = useState<string | null>(null)
  // A different user's finished session that still can't be saved on this device: kept trying in
  // the background, and the setup screen says so instead of leaving Start to fail without context.
  const [foreignPending, setForeignPending] = useState(false)
  const [audio, setAudio] = useState<AudioSource>('none')

  // The sign-in expired mid-session: the timer screen and its summary stay; sign-in follows
  // as soon as the user is on any other screen.
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
    if (handedOver?.outcome) {
      // Signed in from the summary's prompt: back on that summary, now in the account.
      void settings.refresh()
      return
    }
    const foreign = services.isForeignSession?.() ?? false
    // A different user's running session never reaches the timer screen, whatever is stored.
    services.discardForeignRunning?.()
    void timer.restore().then(async (restored) => {
      let update = restored
      if (anonymous) {
        // A session finished while the app was closed (AC6.5), or held by this page while a
        // sign-in form was open, is shown from the memory of this page. A finish another page
        // already claimed is not ours to show.
        const held = anonymous.held.get()
        update = held
          ? { ...restored, outcome: { kind: 'saved', record: held.record }, recordPending: false }
          : { ...restored, outcome: null }
      }
      if (foreign && update.recordPending && !cancelled) setForeignPending(true)
      if (update.snapshot && !foreign) {
        void settings.refresh() // no wait: sends pending edits, fetches the server copy
        if (!cancelled) {
          setAudio(sourceStore.load())
          setView({ name: 'timer' })
        }
      } else if (update.outcome && !foreign) {
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
  }, [timer, services, settings, sourceStore, anonymous, handedOver])

  // The held anonymous session is shown only on its summary. Leaving it other than through the
  // prompt's links (New session, any navigation) discards it quietly (#331); so does the marker
  // no longer naming it, which the held session checks itself.
  useEffect(() => {
    if (anonymous && view.name !== 'summary' && view.name !== 'loading') anonymous.held.discard()
  }, [anonymous, view.name])
  useEffect(() => {
    if (!anonymous) return
    return anonymous.held.subscribe(() => {
      setView((current) =>
        current.name === 'summary' &&
        current.update.outcome?.kind === 'saved' &&
        anonymous.held.get() === null
          ? { name: 'setup' }
          : current,
      )
    })
  }, [anonymous])

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

  // A timer kept only in this tab's memory still blocks sign-out and keeps its screen (#245).
  useEffect(() => registerMemoryTimerProbe(() => timer.hasUnsaved()), [timer])
  // ...and so does a finished record held only in memory: no update reload until it is handed over.
  useEffect(() => registerMemoryHolder(() => timer.hasUnsaved() || timer.holdsRecord()), [timer])
  // Sign-out tries to hand a held record over and counts it if it can't (#298). There is no
  // sign-out without an account.
  useEffect(() => {
    if (anonymous) return
    return registerLocalDataHook(heldRecordHook(timer))
  }, [timer, anonymous])

  // Send what is on the device now, when the connection returns, and on backoff (AC13.3).
  // Runs only while someone is signed in: AuthGate renders the app only then (#9).
  useEffect(() => services.sync?.start(), [services])

  // Sessions parked during a sign-in change go into the device store while the app is open too,
  // not only at start-up (a save also triggers a pass).
  useEffect(() => {
    if (!services.drainParked) return
    const id = window.setInterval(() => void services.drainParked?.(), parkedDrainMs)
    return () => window.clearInterval(id)
  }, [services, parkedDrainMs])

  // A finished session that couldn't be saved on the device yet (a stalled IndexedDB) stays in
  // the timer's own store; keep trying, and drop the "not saved yet" note once it is saved.
  const recordPending = (view.name === 'summary' && view.update.recordPending) || foreignPending
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
          setForeignPending(false)
          setView((current) =>
            current.name === 'summary'
              ? { ...current, update: { ...current.update, recordPending: false } }
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
    // One session at a time across both slots (AC6.1): an account's session sits in the other.
    if (anonymous ? accountSlotHasSession() : anonymousSlotHasSession()) {
      throw new ActiveSessionExistsError()
    }
    await timer.start({ config: request.config, tag: request.tag, goal: request.goal })
    // A session started voids any held one, here or in another tab, through the marker.
    anonymous?.held.forgetMarker()
    sourceStore.save(request.audio)
    if (request.audio === 'youtube' && request.youtubeLink !== null) {
      // The timer screen's player picks the link up from the store (it is also what a reload
      // restores, AC6.4). Marking it used is best effort; a title follows once the player knows it.
      const linkStore = youtube?.linkStore ?? getDefaultLinkStore()
      const linksApi = youtube?.api ?? httpYoutubeLinksApi
      linkStore.save(request.youtubeLink)
      linksApi.use(request.youtubeLink).catch(() => undefined)
    }
    setAudio(request.audio)
    setView({ name: 'timer' })
  }

  const ended = useCallback(
    (update: TimerUpdate) => {
      sourceStore.clear()
      // An update with no outcome means another tab ended the session; that tab shows the summary.
      // So does a finish whose session another page claimed first (#331).
      const lost =
        anonymous !== null &&
        update.outcome?.kind === 'saved' &&
        !anonymous.held.holds(update.outcome.record.id)
      if (update.outcome && !lost) {
        setView({ name: 'summary', update })
      } else {
        setNotice('This session was ended in another tab.')
        setView({ name: 'setup' })
      }
    },
    [sourceStore, anonymous],
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
      <main className="focus-screen">
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
              youtube={youtube}
            />
          )}
        />
      </main>
    )
  }

  if (view.name === 'summary' && view.update.outcome) {
    return (
      <main className="focus-screen">
        <SessionSummary
          outcome={view.update.outcome}
          recordPending={view.update.recordPending}
          savePrompt={anonymous !== null && view.update.outcome.kind === 'saved'}
          inAccount={view.inAccount}
          onNewSession={() => goTo('setup')}
          onViewHistory={() => goTo('history')}
        />
      </main>
    )
  }

  if (view.name === 'history') {
    return (
      <main className="history-screen">
        <AccountBar controller={timer} />
        <ScreenNav current="history" onNavigate={goTo} />
        {anonymous ? (
          <AnonymousHistory />
        ) : (
          <HistoryScreen
            sessions={services.sessions}
            sync={services.sync}
            onNewSession={() => goTo('setup')}
          />
        )}
      </main>
    )
  }

  if (view.name === 'archive') {
    return (
      <main className="history-screen">
        <AccountBar controller={timer} />
        <ScreenNav current="archive" onNavigate={goTo} />
        {anonymous ? <AnonymousArchive /> : <ArchiveScreen sessions={services.sessions} />}
      </main>
    )
  }

  if (view.name === 'settings') {
    return (
      <main>
        <AccountBar controller={timer} />
        <ScreenNav current="settings" onNavigate={goTo} />
        <SettingsScreen player={player} controller={timer} />
      </main>
    )
  }

  return (
    <main>
      <AccountBar controller={timer} />
      <ScreenNav current="setup" onNavigate={goTo} />
      {notice && <p role="status">{notice}</p>}
      {foreignPending && <p role="status">{FOREIGN_PENDING_MESSAGE}</p>}
      <SessionSetup
        preferences={prefs}
        defaultReminderMinutes={values.default_reminder_minutes}
        onStart={start}
        youtubeApi={youtube?.api}
      />
    </main>
  )
}
