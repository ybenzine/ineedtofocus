import { useCallback, useEffect, useMemo, useState } from 'react'
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

export default function App({ controller, preferences }: AppProps) {
  const timer = useMemo(() => controller ?? createController(), [controller])
  const prefs = useMemo(() => preferences ?? new LocalPreferencesStore(), [preferences])
  const [view, setView] = useState<View>({ name: 'loading' })
  // Only the setup choice is known here; after a reload the audio source is not remembered yet
  // (audio playback and its persistence arrive with #17 and #18).
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

  async function start(request: SessionRequest) {
    await timer.start({ config: request.config, tag: request.tag, goal: request.goal })
    setAudio(request.audio)
    setView({ name: 'timer' })
  }

  const ended = useCallback((update: TimerUpdate) => {
    // An update with no outcome means another tab ended the session; nothing to summarise here.
    setView(update.outcome ? { name: 'summary', update } : { name: 'setup' })
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
      <SessionSetup preferences={prefs} onStart={start} />
    </main>
  )
}
