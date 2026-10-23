import { useId, useState, type FormEvent } from 'react'
import {
  COUNTDOWN_LIMITS,
  POMODORO_LIMITS,
  REMINDER_OPTIONS,
  TAGS,
  validateConfig,
  type Mode,
  type ReminderMinutes,
  type Tag,
  type TimerConfig,
} from '../timer/index.ts'
import { OfflineRainSuggestion } from '../sounds/AudioControls.tsx'
import { useOnline } from '../sounds/useOnline.ts'
import { AUDIO_SOURCES, GOAL_MAX_LENGTH, type AudioSource } from './options.ts'
import type { PreferencesStore } from './preferences.ts'

const AUDIO_LABELS: Record<AudioSource, string> = { none: 'None', rain: 'Rain', youtube: 'YouTube' }
const MODE_LABELS: Record<Mode, string> = {
  countdown: 'Countdown',
  pomodoro: 'Pomodoro',
  unlimited: 'Unlimited',
}
const MODES: Mode[] = ['countdown', 'pomodoro', 'unlimited']

export interface SessionRequest {
  config: TimerConfig
  tag: Tag
  /** Trimmed; `null` when left empty. */
  goal: string | null
  audio: AudioSource
}

export interface SessionSetupProps {
  preferences: PreferencesStore
  /** Pre-selected reminder for the unlimited timer (AC12.4); off when absent. */
  defaultReminderMinutes?: ReminderMinutes | null
  onStart: (request: SessionRequest) => void | Promise<void>
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Whole numbers only; anything else becomes NaN so range validation rejects it. */
function toNumber(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN
}

interface NumberFieldProps {
  label: string
  unit: string
  value: string
  range: { min: number; max: number }
  error: string | undefined
  onChange: (value: string) => void
}

function NumberField({ label, unit, value, range, error, onChange }: NumberFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-row">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.value)}
        />
        <span aria-hidden="true">{unit}</span>
      </div>
      <p id={hintId} aria-live="polite" className={error ? 'field-hint field-error' : 'field-hint'}>
        {error ?? `${range.min}–${range.max} ${unit}`}
      </p>
    </div>
  )
}

export default function SessionSetup({
  preferences,
  defaultReminderMinutes = null,
  onStart,
}: SessionSetupProps) {
  const [remembered] = useState(() => preferences.load())
  const [mode, setMode] = useState<Mode>('countdown')
  const [tag, setTag] = useState<Tag>(remembered.tag)
  const [goal, setGoal] = useState('')
  const [audio, setAudio] = useState<AudioSource>('none')
  const online = useOnline()
  const [countdown, setCountdown] = useState('25')
  const [focus, setFocus] = useState(String(remembered.pomodoro.focusMinutes))
  const [shortBreak, setShortBreak] = useState(String(remembered.pomodoro.breakMinutes))
  const [blocks, setBlocks] = useState(String(remembered.pomodoro.blocks))
  const [longBreakOn, setLongBreakOn] = useState(remembered.pomodoro.longBreakEnabled)
  const [longBreak, setLongBreak] = useState(String(remembered.pomodoro.longBreakMinutes))
  const [reminder, setReminder] = useState<string>(
    defaultReminderMinutes === null ? 'off' : String(defaultReminderMinutes),
  )
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const groupId = useId()

  let config: TimerConfig
  if (mode === 'countdown') {
    config = { mode, minutes: toNumber(countdown) }
  } else if (mode === 'pomodoro') {
    config = {
      mode,
      focusMinutes: toNumber(focus),
      breakMinutes: toNumber(shortBreak),
      blocks: toNumber(blocks),
      longBreakEnabled: longBreakOn,
      // Remembered even when off, so an unparseable hidden value falls back to the default.
      longBreakMinutes: toNumber(longBreak),
    }
  } else {
    config = {
      mode,
      reminderMinutes: reminder === 'off' ? null : (Number(reminder) as ReminderMinutes),
    }
  }

  const errors = new Map(validateConfig(config).map((e) => [e.field, e.message]))
  // A hidden long-break field can't be fixed by the user; don't block Start on it.
  if (mode === 'pomodoro' && !longBreakOn) errors.delete('longBreakMinutes')

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (errors.size > 0 || starting) return
    // With the long break off its length is not the user's to fix: use the remembered one.
    const toStart: TimerConfig =
      config.mode === 'pomodoro' && !longBreakOn
        ? { ...config, longBreakMinutes: remembered.pomodoro.longBreakMinutes }
        : config
    setStarting(true)
    setFailure(null)
    try {
      await onStart({ config: toStart, tag, goal: goal.trim() === '' ? null : goal.trim(), audio })
      if (toStart.mode === 'pomodoro') preferences.save({ tag, pomodoro: toStart })
      else preferences.save({ ...preferences.load(), tag })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The session could not be started.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <form className="setup" onSubmit={(event) => void submit(event)} noValidate>
      <h1>I Need To Focus</h1>

      <fieldset>
        <legend>Timer</legend>
        <div className="choices">
          {MODES.map((m) => (
            <label key={m} className="choice">
              <input
                type="radio"
                name={`${groupId}-mode`}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>{MODE_LABELS[m]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'countdown' && (
        <NumberField
          label="Duration"
          unit="min"
          value={countdown}
          range={COUNTDOWN_LIMITS}
          error={errors.get('minutes')}
          onChange={setCountdown}
        />
      )}

      {mode === 'pomodoro' && (
        <>
          <NumberField
            label="Focus"
            unit="min"
            value={focus}
            range={POMODORO_LIMITS.focusMinutes}
            error={errors.get('focusMinutes')}
            onChange={setFocus}
          />
          <NumberField
            label="Short break"
            unit="min"
            value={shortBreak}
            range={POMODORO_LIMITS.breakMinutes}
            error={errors.get('breakMinutes')}
            onChange={setShortBreak}
          />
          <NumberField
            label="Focus blocks"
            unit="blocks"
            value={blocks}
            range={POMODORO_LIMITS.blocks}
            error={errors.get('blocks')}
            onChange={setBlocks}
          />
          <label className="choice">
            <input
              type="checkbox"
              checked={longBreakOn}
              onChange={(event) => setLongBreakOn(event.target.checked)}
            />
            <span>Long break after every 4th block</span>
          </label>
          {longBreakOn && (
            <NumberField
              label="Long break"
              unit="min"
              value={longBreak}
              range={POMODORO_LIMITS.longBreakMinutes}
              error={errors.get('longBreakMinutes')}
              onChange={setLongBreak}
            />
          )}
        </>
      )}

      {mode === 'unlimited' && (
        <div className="field">
          <label htmlFor={`${groupId}-reminder`}>Reminder</label>
          <select
            id={`${groupId}-reminder`}
            value={reminder}
            onChange={(event) => setReminder(event.target.value)}
          >
            <option value="off">Off</option>
            {REMINDER_OPTIONS.map((m) => (
              <option key={m} value={m}>
                Every {m} min
              </option>
            ))}
          </select>
        </div>
      )}

      <fieldset>
        <legend>Tag</legend>
        <div className="choices">
          {TAGS.map((t) => (
            <label key={t} className="choice">
              <input
                type="radio"
                name={`${groupId}-tag`}
                checked={tag === t}
                onChange={() => setTag(t)}
              />
              <span>{capitalize(t)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label htmlFor={`${groupId}-goal`}>What are you focusing on? (optional)</label>
        <input
          id={`${groupId}-goal`}
          type="text"
          maxLength={GOAL_MAX_LENGTH}
          autoComplete="off"
          value={goal}
          aria-describedby={`${groupId}-goal-count`}
          onChange={(event) => setGoal(event.target.value)}
        />
        <p id={`${groupId}-goal-count`} className="field-hint">
          {goal.length}/{GOAL_MAX_LENGTH}
        </p>
      </div>

      <fieldset>
        <legend>Background audio</legend>
        <div className="choices">
          {AUDIO_SOURCES.map((a) => (
            <label key={a} className="choice">
              <input
                type="radio"
                name={`${groupId}-audio`}
                checked={audio === a}
                onChange={() => setAudio(a)}
              />
              <span>{AUDIO_LABELS[a]}</span>
            </label>
          ))}
        </div>
        {audio === 'youtube' && !online && (
          <OfflineRainSuggestion onUseRain={() => setAudio('rain')} />
        )}
      </fieldset>

      {failure && (
        <p role="alert" className="field-error">
          {failure}
        </p>
      )}
      <button type="submit" className="primary" disabled={errors.size > 0 || starting}>
        Start
      </button>
    </form>
  )
}
