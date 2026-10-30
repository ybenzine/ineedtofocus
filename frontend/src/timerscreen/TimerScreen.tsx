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
import { YoutubeIcon } from '../sounds/YoutubeLabel.tsx'
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
  /**
   * The audio controls (#17, #18), rendered inside the audio region. A function receives the
   * timer's paused state, which the audio follows (AC8.2).
   */
  audioControls?: ReactNode | ((state: { paused: boolean }) => ReactNode)
}

function clockText(snapshot: TimerSnapshot): string {
  if (snapshot.pomodoro) return formatCountdown(snapshot.pomodoro.phaseRemainingMs)
  if (snapshot.remainingMs !== null) return formatCountdown(snapshot.remainingMs)
  return formatElapsed(snapshot.focusMs)
}

/** "of 25:00": the length of the countdown or Pomodoro phase; "elapsed" for an unlimited timer. */
function totalText(snapshot: TimerSnapshot): string {
  const { config, pomodoro } = snapshot
  let minutes: number | null = null
  if (config.mode === 'countdown') minutes = config.minutes
  else if (config.mode === 'pomodoro' && pomodoro) {
    minutes =
      pomodoro.phase === 'focus'
        ? config.focusMinutes
        : pomodoro.phase === 'break'
          ? config.breakMinutes
          : config.longBreakMinutes
  }
  return minutes === null ? 'elapsed' : `of ${formatCountdown(minutes * 60_000)}`
}

/** The audio card's icon: a rain cloud, the YouTube mark, or a muted speaker. Decorative. */
function AudioIcon({ source }: { source: AudioSource }) {
  if (source === 'youtube') return <YoutubeIcon />
  return (
    <svg
      className="timer-audio-icon"
      aria-hidden="true"
      focusable="false"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {source === 'rain' ? (
        <>
          <path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3" />
          <path d="M8 19v2M8 13v2M16 19v2M16 13v2M12 21v2M12 15v2" />
        </>
      ) : (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="m22 9-6 6M16 9l6 6" />
        </>
      )}
    </svg>
  )
}

/** Shown while the timer runs only in memory; clears once the write to the device lands (#245). */
export const UNSAVED_NOTICE = "This session isn't saved on this device yet. Keep this tab open."

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
  // The timer runs only in memory: a reload would lose it (#245).
  const [unsaved, setUnsaved] = useState(() => controller.hasUnsaved())
  const callbacks = useRef({ onEvents, onEnded })
  useEffect(() => {
    callbacks.current = { onEvents, onEnded }
  })
  useWakeLock(keepAwake)

  const endedRef = useRef(false)

  // Keyboard and screen-reader users arrive on the new screen: focus its heading (WCAG 2.4.3).
  const headingRef = useRef<HTMLHeadingElement>(null)
  const hasSession = snapshot !== null
  useEffect(() => {
    if (hasSession) headingRef.current?.focus()
  }, [hasSession])

  const apply = useCallback((update: TimerUpdate) => {
    if (endedRef.current) return // a tick already in flight when the session ended
    if (update.events.length > 0) callbacks.current.onEvents?.(update.events)
    if (update.snapshot) {
      setSnapshot(update.snapshot)
      setUnsaved(update.unsaved === true)
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
        // Only a user action clears the message; ticks must not make it vanish unread.
        if (!background) setError(null)
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
      if (current) {
        setSnapshot(current)
        setUnsaved(controller.hasUnsaved())
      } else apply({ snapshot: null, events: [], outcome: null, recordPending: false })
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

  const total = totalText(snapshot)

  return (
    <section className={`timer-screen${inBreak ? ' on-break' : ''}`} aria-label="Focus timer">
      <div className="timer-top">
        <h1 className="timer-phase" aria-live="polite" tabIndex={-1} ref={headingRef}>
          {snapshot.paused ? `${label}, paused` : label}
        </h1>
        {pomodoro ? (
          <p className="timer-progress">
            <span className="sr-only">{MODE_LABEL[snapshot.mode]}. </span>
            <span>
              Block {pomodoro.block} of {pomodoro.totalBlocks}
            </span>
          </p>
        ) : (
          <p className="timer-mode">{MODE_LABEL[snapshot.mode]}</p>
        )}
      </div>

      <div className="timer-ring">
        <div className="timer-clock" role="timer" aria-label="Time">
          {clockText(snapshot)}
        </div>
        <p className="timer-of">{total}</p>
      </div>

      <p className="timer-meta">
        <span className="timer-tag">{snapshot.tag}</span>
        {snapshot.goal && <span className="timer-goal">{snapshot.goal}</span>}
      </p>

      <p role="status" className={unsaved ? 'timer-unsaved' : undefined}>
        {unsaved ? UNSAVED_NOTICE : ''}
      </p>

      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}

      <div className="timer-bottom">
        <section className="timer-audio" aria-label="Background audio">
          <AudioIcon source={audio} />
          <p className="timer-audio-name">{AUDIO_LABEL[audio]}</p>
          {typeof audioControls === 'function'
            ? audioControls({ paused: snapshot.paused })
            : audioControls}
        </section>

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
          <button
            type="button"
            className="secondary danger"
            onClick={() => void run(() => controller.stop())}
          >
            Stop
          </button>
          {inBreak && (
            <button
              type="button"
              className="secondary timer-skip"
              onClick={() => void run(() => controller.skipBreak())}
            >
              Skip break
            </button>
          )}
        </div>

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
      </div>
    </section>
  )
}
