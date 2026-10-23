// The full-screen timer (F9): time, phase, progress, tag, goal, audio controls and the
// pause / resume / stop / skip-break controls. The controller owns the timer; this only shows it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AudioSource } from '../setup/options.ts'
import {
  ACTIVE_SESSION_KEY,
  type TimerController,
  type TimerEvent,
  type TimerSnapshot,
  type TimerUpdate,
} from '../timer/index.ts'
import { formatCountdown, formatElapsed } from './format.ts'
import { useKeepAwakeSetting, useWakeLock, wakeLockSupported } from './wakeLock.ts'

const TICK_MS = 250

const PHASE_LABEL = { focus: 'Focus', break: 'Break', 'long-break': 'Long break' } as const
const MODE_LABEL = { countdown: 'Countdown', pomodoro: 'Pomodoro', unlimited: 'Unlimited' } as const
const AUDIO_LABEL: Record<AudioSource, string> = {
  none: 'No background audio',
  rain: 'Rain',
  youtube: 'YouTube',
}

export interface TimerScreenProps {
  controller: TimerController
  /** The source picked on the setup screen. Playback arrives with #17 (Rain) and #18 (YouTube). */
  audio: AudioSource
  /**
   * Hook for the sounds (#16): bells and chimes due since the last tick. A `phase-change` with
   * `skipped: true` is the user skipping a break and must NOT ring (decision log, #13).
   */
  onEvents?: (events: TimerEvent[]) => void
  /** The session is over (stopped, completed, or ended in another tab): show the summary. */
  onEnded: (update: TimerUpdate) => void
  /** Hook for the audio controls (#17, #18): rendered inside the audio region. */
  audioControls?: ReactNode
}

function clockText(snapshot: TimerSnapshot): string {
  if (snapshot.pomodoro) return formatCountdown(snapshot.pomodoro.phaseRemainingMs)
  if (snapshot.remainingMs !== null) return formatCountdown(snapshot.remainingMs)
  return formatElapsed(snapshot.focusMs)
}

export default function TimerScreen({
  controller,
  audio,
  onEvents,
  onEnded,
  audioControls,
}: TimerScreenProps) {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(() => controller.current())
  const [keepAwake, setKeepAwake] = useKeepAwakeSetting()
  const [error, setError] = useState<string | null>(null)
  const callbacks = useRef({ onEvents, onEnded })
  useEffect(() => {
    callbacks.current = { onEvents, onEnded }
  })
  useWakeLock(keepAwake)

  const endedRef = useRef(false)

  const apply = useCallback((update: TimerUpdate) => {
    if (endedRef.current) return // a tick already in flight when the session ended
    if (update.events.length > 0) callbacks.current.onEvents?.(update.events)
    if (update.snapshot) {
      setSnapshot(update.snapshot)
    } else {
      endedRef.current = true
      callbacks.current.onEnded(update)
    }
  }, [])

  // One call at a time in this tab: saving a finished session may take a while (IndexedDB, #19),
  // and a tick that started meanwhile would see "no session" and hide the real outcome. User
  // actions wait their turn; ticks and storage reads are simply skipped while something runs.
  const tail = useRef<Promise<void>>(Promise.resolve())
  const inFlight = useRef(0)

  const run = useCallback(
    (action: () => Promise<TimerUpdate>, background = false): Promise<void> => {
      if (background && inFlight.current > 0) return Promise.resolve()
      inFlight.current += 1
      const job = tail.current.then(async () => {
        setError(null)
        try {
          apply(await action())
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Something went wrong')
        } finally {
          inFlight.current -= 1
        }
      })
      tail.current = job
      return job
    },
    [apply],
  )

  // Time is derived from timestamps on every tick, so a throttled background tab, a sleeping
  // device or a reload can't make it drift (F6). Also tick when the tab is shown again and when
  // another tab changes the stored session.
  useEffect(() => {
    const tick = () => void run(() => controller.tick(), true)
    const id = window.setInterval(tick, TICK_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    // Another tab changed the stored session: only read it. Writing here would make the other
    // tab react in turn, and the two would write back and forth.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== ACTIVE_SESSION_KEY) return
      if (inFlight.current > 0) return
      const current = controller.current()
      if (current) setSnapshot(current)
      else apply({ snapshot: null, events: [], outcome: null, recordPending: false })
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('storage', onStorage)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('storage', onStorage)
    }
  }, [controller, run, apply])

  if (snapshot === null) return null

  const { pomodoro } = snapshot
  const inBreak = pomodoro !== null && pomodoro.phase !== 'focus'
  const label = pomodoro ? PHASE_LABEL[pomodoro.phase] : 'Focus'

  return (
    <section className={`timer-screen${inBreak ? ' on-break' : ''}`} aria-label="Focus timer">
      <p className="timer-mode">{MODE_LABEL[snapshot.mode]}</p>

      <h1 className="timer-phase" aria-live="polite">
        {snapshot.paused ? `${label}, paused` : label}
      </h1>

      <div className="timer-clock" role="timer" aria-label="Time">
        {clockText(snapshot)}
      </div>

      {pomodoro && (
        <p className="timer-progress">
          Block {pomodoro.block} of {pomodoro.totalBlocks}
        </p>
      )}

      <p className="timer-meta">
        <span className="timer-tag">{snapshot.tag}</span>
        {snapshot.goal && <span className="timer-goal">{snapshot.goal}</span>}
      </p>

      <div className="timer-controls">
        {snapshot.paused ? (
          <button
            type="button"
            className="primary"
            onClick={() => void run(() => controller.resume())}
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={() => void run(() => controller.pause())}
          >
            Pause
          </button>
        )}
        {inBreak && (
          <button
            type="button"
            className="secondary"
            onClick={() => void run(() => controller.skipBreak())}
          >
            Skip break
          </button>
        )}
        <button
          type="button"
          className="secondary danger"
          onClick={() => void run(() => controller.stop())}
        >
          Stop
        </button>
      </div>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <section className="timer-audio" aria-label="Background audio">
        <p>{AUDIO_LABEL[audio]}</p>
        {audioControls}
      </section>

      <div className="timer-awake">
        <label className="choice">
          <input
            type="checkbox"
            checked={keepAwake}
            disabled={!wakeLockSupported()}
            aria-describedby="keep-awake-hint"
            onChange={(event) => setKeepAwake(event.target.checked)}
          />
          Keep screen awake
        </label>
        <p id="keep-awake-hint" className="field-hint">
          {wakeLockSupported()
            ? 'Stops the screen from turning off during the session.'
            : 'Not supported on this device or browser.'}
        </p>
      </div>
    </section>
  )
}
