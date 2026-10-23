import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertPlayer, LocalAlertVolumeStore } from './sounds/alerts.ts'
import AudioControls from './sounds/AudioControls.tsx'
import { LocalAudioSourceStore, type AudioSourceStore } from './sounds/audioSource.ts'
import { LocalBackgroundVolumeStore, RainPlayer } from './sounds/rain.ts'
import AccountBar from './auth/AccountBar.tsx'
import { LocalPreferencesStore, type PreferencesStore } from './setup/preferences.ts'
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
  preferences?: PreferencesStore
  /** Injectable for tests; plays the chime and the end bell (#16). */
  alerts?: AlertPlayer
  /** Injectable for tests; plays the background rain (#17). */
  rain?: RainPlayer
  /** Injectable for tests; remembers the chosen audio source across reloads. */
  audioStore?: AudioSourceStore
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
  | { name: 'timer' }
  | { name: 'summary'; update: TimerUpdate }

export default function App({ controller, preferences, alerts, rain, audioStore }: AppProps) {
  const timer = useMemo(() => controller ?? createController(), [controller])
  const prefs = useMemo(() => preferences ?? new LocalPreferencesStore(), [preferences])
  const player = useMemo(
    () => alerts ?? new AlertPlayer({ volume: new LocalAlertVolumeStore() }),
    [alerts],
  )
  const rainPlayer = useMemo(
    () => rain ?? new RainPlayer({ alerts: player, volume: new LocalBackgroundVolumeStore() }),
    [rain, player],
  )
  const sourceStore = useMemo(() => audioStore ?? new LocalAudioSourceStore(), [audioStore])
  const [view, setView] = useState<View>({ name: 'loading' })
  // The audio source is remembered with the active session (sourceStore), so a reload restores it.
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
      if (update.snapshot) {
        setAudio(sourceStore.load())
        setView({ name: 'timer' })
      } else {
        sourceStore.clear()
        if (update.outcome) setView({ name: 'summary', update })
        else setView({ name: 'setup' })
      }
    })
    return () => {
      cancelled = true
    }
  }, [timer, sourceStore])

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
