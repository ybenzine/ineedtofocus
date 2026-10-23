import { useEffect, useMemo, useState } from 'react'
import { LocalPreferencesStore, type PreferencesStore } from './setup/preferences.ts'
import SessionSetup, { type SessionRequest } from './setup/SessionSetup.tsx'
import { LocalActiveSessionStore, TimerController, type SessionRecord } from './timer/index.ts'

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

export default function App({ controller, preferences }: AppProps) {
  const timer = useMemo(() => controller ?? createController(), [controller])
  const prefs = useMemo(() => preferences ?? new LocalPreferencesStore(), [preferences])
  const [running, setRunning] = useState(false)

  // Pick up a session that was running when the app closed (AC6.4); #15 shows it properly.
  useEffect(() => {
    void timer.restore().then((update) => {
      if (update.snapshot) setRunning(true)
    })
  }, [timer])

  async function start(request: SessionRequest) {
    await timer.start({ config: request.config, tag: request.tag, goal: request.goal })
    setRunning(true)
  }

  if (running) {
    // Placeholder hand-off: the full-screen timer arrives with #15.
    return (
      <main>
        <h1>Session started</h1>
        <p>The timer screen is coming soon.</p>
        <button
          type="button"
          onClick={() => {
            void timer.stop().then(() => setRunning(false))
          }}
        >
          Stop
        </button>
      </main>
    )
  }

  return (
    <main>
      <SessionSetup preferences={prefs} onStart={start} />
    </main>
  )
}
