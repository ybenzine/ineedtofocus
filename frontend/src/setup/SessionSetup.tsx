// The New session screen, dial first (#407): the mode switch, a dial that previews the session,
// the presets or reminders, then Tag, Goal and Sound rows that open sheets, and Start. The setup
// is kept above the screen (`model.ts`) so it survives a trip to another screen.

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  COUNTDOWN_LIMITS,
  POMODORO_LIMITS,
  REMINDER_OPTIONS,
  validateConfig,
  type Mode,
  type PomodoroConfig,
  type ReminderMinutes,
  type Tag,
  type TimerConfig,
} from '../timer/index.ts'
import { useAnonymous } from '../anonymous/AnonymousContext.ts'
import { useOnline } from '../sounds/useOnline.ts'
import { checkYoutubeLink } from '../sounds/youtubeLink.ts'
import type { YoutubeLinksApi } from '../sounds/youtubeLinksApi.ts'
import { useTagsView } from '../tags/context.ts'
import { TagDot } from '../tags/TagName.tsx'
import Dial from './Dial.tsx'
import { countdownArcs, pomodoroArcs, reminderTicks, stepTo } from './dial.ts'
import {
  ChevronIcon,
  GoalIcon,
  MinusIcon,
  NoSoundIcon,
  PlusIcon,
  RainIcon,
  SoundIcon,
  TagIcon,
  YoutubeIcon,
} from './icons.tsx'
import { chimeLine, formatLength, pomodoroTotalMinutes, summaryLine } from './length.ts'
import { defaultValues, useSetupModel, type SetupModel } from './model.ts'
import { AUDIO_LABELS, CLOCK_REFRESH_MS, COUNTDOWN_PRESETS, type AudioSource } from './options.ts'
import type { PreferencesStore } from './preferences.ts'
import { SoundSheet, TagGoalSheet } from './SetupSheets.tsx'

const MODE_LABELS: Record<Mode, string> = {
  countdown: 'Countdown',
  pomodoro: 'Pomodoro',
  unlimited: 'Unlimited',
}
const MODES: Mode[] = ['countdown', 'pomodoro', 'unlimited']

const SOUND_ICONS: Record<AudioSource, () => ReactNode> = {
  none: () => <NoSoundIcon />,
  rain: () => <RainIcon />,
  youtube: () => <YoutubeIcon />,
}

export interface SessionRequest {
  config: TimerConfig
  tag: Tag
  /** Trimmed; `null` when left empty. */
  goal: string | null
  audio: AudioSource
  /** The normalised YouTube link, set exactly when `audio` is `youtube` (#325). */
  youtubeLink: string | null
}

export interface SessionSetupProps {
  preferences: PreferencesStore
  /** Pre-selected reminder for the unlimited timer (AC12.4); off when absent. */
  defaultReminderMinutes?: ReminderMinutes | null
  onStart: (request: SessionRequest) => void | Promise<void>
  /** Injectable for tests; the recent YouTube links. */
  youtubeApi?: YoutubeLinksApi
  /**
   * The setup as kept above this screen. Without it the screen keeps its own, which is gone with
   * the screen (single-screen tests).
   */
  model?: SetupModel
  /** Opens Settings → Tags; the Manage tags link shows only when this is given and someone is signed in. */
  onManageTags?: () => void
  /** Injectable for tests; the locale of the end time. */
  locale?: string
}

/** Whole numbers only; anything else becomes NaN so range validation rejects it. */
function toNumber(text: string): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

function StepButton({
  label,
  direction,
  onClick,
  large = false,
}: {
  label: string
  direction: 1 | -1
  onClick: () => void
  large?: boolean
}) {
  return (
    <button
      type="button"
      className={large ? 'step-button step-button-large' : 'step-button'}
      aria-label={label}
      onClick={onClick}
    >
      {direction === 1 ? <PlusIcon size={large ? 20 : 18} /> : <MinusIcon size={large ? 20 : 18} />}
    </button>
  )
}

/** A row of the Break / Blocks card: its label, then − value + . */
function StepperRow({
  label,
  value,
  lessLabel,
  moreLabel,
  onLess,
  onMore,
}: {
  label: string
  value: string
  lessLabel: string
  moreLabel: string
  onLess: () => void
  onMore: () => void
}) {
  return (
    <div className="setup-row stepper-row">
      <span className="row-label">{label}</span>
      <StepButton label={lessLabel} direction={-1} onClick={onLess} />
      <span className="stepper-value">{value}</span>
      <StepButton label={moreLabel} direction={1} onClick={onMore} />
    </div>
  )
}

export default function SessionSetup({
  preferences,
  defaultReminderMinutes = null,
  onStart,
  youtubeApi,
  model: given,
  onManageTags,
  locale,
}: SessionSetupProps) {
  const remembered = preferences.load()
  const defaults = defaultValues(remembered, defaultReminderMinutes)
  const own = useSetupModel(defaults)
  const model = given ?? own
  const { values, starting, failure } = model
  const {
    mode,
    countdown,
    focus,
    shortBreak,
    blocks,
    longBreakOn,
    longBreak,
    reminder,
    goal,
    audio,
    youtubeText,
  } = values

  // A tag that is no longer offered (the last one used was removed, AC7.7) starts on Work.
  const tagsView = useTagsView()
  const tag = tagsView.pickable.some((t) => t.id === values.tag) ? values.tag : 'work'
  const tagInfo = tagsView.info(tag)
  const anonymous = useAnonymous()
  const online = useOnline()
  const now = useNow()
  const [sheet, setSheet] = useState<'tag' | 'goal' | 'sound' | null>(null)
  const tagRow = useRef<HTMLButtonElement>(null)
  const goalRow = useRef<HTMLButtonElement>(null)
  const soundRow = useRef<HTMLButtonElement>(null)
  const goalField = useRef<HTMLInputElement>(null)
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

  // YouTube needs a link that will play before the session can start (#325).
  const youtubeCheck = audio === 'youtube' ? checkYoutubeLink(youtubeText) : null
  const youtubeLink = youtubeCheck?.ok ? youtubeCheck.link.url : null
  const needsLink = audio === 'youtube' && youtubeLink === null
  const linkHintId = `${groupId}-link-hint`
  const blocked = errors.size > 0 || needsLink

  // --- The dial ---------------------------------------------------------------------------
  const countdownMinutes = config.mode === 'countdown' ? config.minutes : Number.NaN
  // With the long break off its length can be anything for the plan; use the valid default.
  const pomodoroForPlan: PomodoroConfig | null =
    config.mode === 'pomodoro' &&
    ['focusMinutes', 'breakMinutes', 'blocks'].every((f) => !errors.has(f)) &&
    (config.longBreakEnabled ? !errors.has('longBreakMinutes') : true)
      ? config
      : null
  const reminderMinutes = reminder === 'off' ? null : Number(reminder)

  // The line under the dial: the whole session's length, then when it ends (AC2.6, AC3.8, AC4.6).
  let lengthText = ''
  let line = ''
  if (mode === 'countdown' && errors.size === 0) {
    lengthText = formatLength(countdownMinutes)
    line = summaryLine(now, countdownMinutes, locale)
  } else if (mode === 'pomodoro' && pomodoroForPlan) {
    const total = pomodoroTotalMinutes(pomodoroForPlan)
    lengthText = formatLength(total)
    line = summaryLine(now, total, locale)
  } else if (mode === 'unlimited') {
    lengthText = chimeLine(reminderMinutes)
    line = lengthText
  }
  // The live region says the line again only when the user changed something, never when the
  // clock moved on: its text is fixed from the render in which the length or mode changed.
  const announceKey = `${mode}|${lengthText}`
  const [announced, setAnnounced] = useState({ key: announceKey, text: line })
  if (announced.key !== announceKey) setAnnounced({ key: announceKey, text: line })

  const arcs =
    mode === 'countdown'
      ? countdownArcs(countdownMinutes)
      : mode === 'pomodoro' && pomodoroForPlan
        ? pomodoroArcs(pomodoroForPlan)
        : []
  const ticks = mode === 'unlimited' ? reminderTicks(reminderMinutes) : []

  const countdownValid = mode === 'countdown' && errors.size === 0
  const errorId = `${groupId}-errors`
  const errorList = [...errors.entries()]

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (blocked || starting) return
    // With the long break off its length is not the user's to fix: use the remembered one.
    const toStart: TimerConfig =
      config.mode === 'pomodoro' && !longBreakOn
        ? { ...config, longBreakMinutes: remembered.pomodoro.longBreakMinutes }
        : config
    model.setStarting(true)
    model.setFailure(null)
    try {
      await onStart({
        config: toStart,
        tag,
        goal: goal.trim() === '' ? null : goal.trim(),
        audio,
        youtubeLink,
      })
      if (toStart.mode === 'pomodoro') preferences.save({ tag, pomodoro: toStart })
      else preferences.save({ ...preferences.load(), tag })
    } catch (error) {
      model.setFailure(error instanceof Error ? error.message : 'The session could not be started.')
    } finally {
      model.setStarting(false)
    }
  }

  const stepCountdown = (direction: 1 | -1) =>
    model.edit({
      countdown: String(stepTo(toNumber(countdown), direction, 5, COUNTDOWN_LIMITS, 30)),
    })
  const stepFocus = (direction: 1 | -1) =>
    model.edit({
      focus: String(stepTo(toNumber(focus), direction, 5, POMODORO_LIMITS.focusMinutes, 25)),
    })
  const stepLongBreak = (direction: 1 | -1) =>
    model.edit({
      longBreak: String(
        stepTo(toNumber(longBreak), direction, 5, POMODORO_LIMITS.longBreakMinutes, 15),
      ),
    })
  const stepBreak = (direction: 1 | -1) =>
    model.edit({
      shortBreak: String(
        stepTo(toNumber(shortBreak), direction, 1, POMODORO_LIMITS.breakMinutes, 5),
      ),
    })
  const stepBlocks = (direction: 1 | -1) =>
    model.edit({
      blocks: String(stepTo(toNumber(blocks), direction, 1, POMODORO_LIMITS.blocks, 4)),
    })

  const goalText = goal.trim()

  return (
    <form
      className="setup setup-dial"
      data-holds-update={model.changed ? '' : undefined}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <h1 className="sr-only">New session</h1>
      <div className="setup-body">
        <fieldset className="mode-switch">
          <legend className="sr-only">Timer</legend>
          {MODES.map((m) => (
            <label key={m} className="mode-option">
              <input
                type="radio"
                name={`${groupId}-mode`}
                checked={mode === m}
                onChange={() => model.edit({ mode: m })}
              />
              <span>{MODE_LABELS[m]}</span>
            </label>
          ))}
        </fieldset>

        {mode === 'countdown' && (
          <div className="dial-row">
            <StepButton
              large
              direction={-1}
              label="5 minutes less"
              onClick={() => stepCountdown(-1)}
            />
            <Dial arcs={arcs}>
              <input
                className="dial-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                aria-label="Duration in minutes, 1 to 240"
                aria-invalid={errors.has('minutes') ? true : undefined}
                aria-describedby={errors.has('minutes') ? errorId : undefined}
                value={countdown}
                onChange={(event) => model.edit({ countdown: event.target.value })}
              />
              <span className="dial-unit">minutes</span>
              <DialLine line={line} announced={announced.text} />
            </Dial>
            <StepButton
              large
              direction={1}
              label="5 minutes more"
              onClick={() => stepCountdown(1)}
            />
          </div>
        )}

        {mode === 'pomodoro' && (
          <div className="dial-row">
            <StepButton
              large
              direction={-1}
              label="Focus, 5 minutes less"
              onClick={() => stepFocus(-1)}
            />
            <Dial arcs={arcs} className="dial-small">
              <input
                className="dial-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                aria-label="Focus length in minutes, 5 to 90"
                aria-invalid={errors.has('focusMinutes') ? true : undefined}
                aria-describedby={errors.has('focusMinutes') ? errorId : undefined}
                value={focus}
                onChange={(event) => model.edit({ focus: event.target.value })}
              />
              <span className="dial-unit">min focus</span>
              <DialLine line={line} announced={announced.text} />
            </Dial>
            <StepButton
              large
              direction={1}
              label="Focus, 5 minutes more"
              onClick={() => stepFocus(1)}
            />
          </div>
        )}

        {mode === 'unlimited' && (
          <div className="dial-row dial-row-single">
            <Dial ticks={ticks}>
              <span className="dial-infinity" aria-hidden="true">
                ∞
              </span>
              <span className="dial-unit">no time limit</span>
              <DialLine line={line} announced={announced.text} />
            </Dial>
          </div>
        )}

        <div id={errorId} className="setup-errors" aria-live="polite">
          {errorList.map(([field, message]) => (
            <p key={field} className="field-error">
              {message}
            </p>
          ))}
        </div>

        {mode === 'countdown' && (
          <div className="presets" role="group" aria-label="Preset lengths">
            {COUNTDOWN_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                className="preset"
                aria-label={`${minutes} minutes`}
                aria-pressed={countdownValid && countdownMinutes === minutes}
                onClick={() => model.edit({ countdown: String(minutes) })}
              >
                {minutes}
              </button>
            ))}
          </div>
        )}

        {mode === 'unlimited' && (
          <fieldset className="reminders">
            <legend className="caption">Remind me every</legend>
            <div className="reminder-pills">
              {['off', ...REMINDER_OPTIONS.map(String)].map((value) => (
                <label key={value} className="pill pill-small">
                  <input
                    type="radio"
                    name={`${groupId}-reminder`}
                    checked={reminder === value}
                    aria-label={value === 'off' ? 'Off' : `${value} minutes`}
                    onChange={() => model.edit({ reminder: value })}
                  />
                  <span>{value === 'off' ? 'Off' : value}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {mode === 'pomodoro' && (
          <div className="setup-card">
            <StepperRow
              label="Break"
              value={`${shortBreak} min`}
              lessLabel="Break, 1 minute less"
              moreLabel="Break, 1 minute more"
              onLess={() => stepBreak(-1)}
              onMore={() => stepBreak(1)}
            />
            <StepperRow
              label="Blocks"
              value={blocks}
              lessLabel="One block fewer"
              moreLabel="One block more"
              onLess={() => stepBlocks(-1)}
              onMore={() => stepBlocks(1)}
            />
            <label className="setup-row switch-row">
              <span className="row-label">
                Long break <span className="row-note">· every 4th block</span>
              </span>
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={longBreakOn}
                onChange={(event) => model.edit({ longBreakOn: event.target.checked })}
              />
              <span className="switch" aria-hidden="true" />
            </label>
            {longBreakOn && (
              <div className="setup-row stepper-row">
                <span className="row-label">Length</span>
                <StepButton
                  label="Long break, 5 minutes less"
                  direction={-1}
                  onClick={() => stepLongBreak(-1)}
                />
                <span className="stepper-value stepper-field">
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={4}
                    aria-label="Long break in minutes, 5 to 60"
                    aria-invalid={errors.has('longBreakMinutes') ? true : undefined}
                    aria-describedby={errors.has('longBreakMinutes') ? errorId : undefined}
                    value={longBreak}
                    onChange={(event) => model.edit({ longBreak: event.target.value })}
                  />
                  <span aria-hidden="true">min</span>
                </span>
                <StepButton
                  label="Long break, 5 minutes more"
                  direction={1}
                  onClick={() => stepLongBreak(1)}
                />
              </div>
            )}
          </div>
        )}

        <div className="setup-card">
          <button
            ref={tagRow}
            type="button"
            className="setup-row row-button"
            aria-haspopup="dialog"
            onClick={() => setSheet('tag')}
          >
            <span className="row-icon">
              <TagIcon />
            </span>
            <span className="row-label">Tag</span>{' '}
            <span className="row-value row-value-strong">
              <TagDot color={tagInfo.color} />
              <span className="tag-name-text">{tagInfo.name}</span>
            </span>
            <span className="row-chevron">
              <ChevronIcon />
            </span>
          </button>
          <button
            ref={goalRow}
            type="button"
            className="setup-row row-button"
            aria-haspopup="dialog"
            onClick={() => setSheet('goal')}
          >
            <span className="row-icon">
              <GoalIcon />
            </span>
            <span className="row-label">Goal</span>{' '}
            <span
              className={
                goalText === ''
                  ? 'row-value row-value-goal'
                  : 'row-value row-value-goal row-value-set'
              }
            >
              {goalText === '' ? 'Add a goal' : goalText}
            </span>
            <span className="row-chevron">
              <ChevronIcon />
            </span>
          </button>
          <button
            ref={soundRow}
            type="button"
            className="setup-row row-button"
            aria-haspopup="dialog"
            onClick={() => setSheet('sound')}
          >
            <span className="row-icon">
              <SoundIcon />
            </span>
            <span className="row-label">Sound</span>{' '}
            <span className="row-value row-value-strong">
              <span className="row-sound-icon">{SOUND_ICONS[audio]()}</span>
              {AUDIO_LABELS[audio]}
            </span>
            <span className="row-chevron">
              <ChevronIcon />
            </span>
          </button>
        </div>

        {needsLink && (
          <p id={linkHintId} className="field-hint">
            {online
              ? 'Add a YouTube link under Sound to start.'
              : "You are offline, so YouTube can't play. Choose Rain under Sound to start."}
          </p>
        )}
        {failure && (
          <p role="alert" className="field-error">
            {failure}
          </p>
        )}
      </div>

      <div className="setup-footer">
        <button
          type="submit"
          className="primary start-button"
          disabled={blocked || starting}
          aria-describedby={needsLink ? linkHintId : undefined}
        >
          Start
        </button>
      </div>

      {(sheet === 'tag' || sheet === 'goal') && (
        <TagGoalSheet
          tags={tagsView.pickable}
          tag={tag}
          onTag={(next) => model.edit({ tag: next })}
          goal={goal}
          onGoal={(next) => model.edit({ goal: next })}
          goalRef={goalField}
          focusGoal={sheet === 'goal'}
          onManageTags={onManageTags && !anonymous ? onManageTags : undefined}
          onClose={() => setSheet(null)}
          returnFocusTo={sheet === 'goal' ? goalRow : tagRow}
        />
      )}
      {sheet === 'sound' && (
        <SoundSheet
          audio={audio}
          onAudio={(next) => model.edit({ audio: next })}
          youtubeText={youtubeText}
          onYoutubeText={(text) => model.edit({ youtubeText: text })}
          youtubeApi={youtubeApi}
          online={online}
          onClose={() => setSheet(null)}
          returnFocusTo={soundRow}
        />
      )}
    </form>
  )
}

/**
 * The summary line. What is drawn follows the clock; what a screen reader hears is a separate
 * live region that only changes when the user changes the setup (AC9).
 */
function DialLine({ line, announced }: { line: string; announced: string }) {
  return (
    <>
      <span className="dial-line" data-testid="dial-line" aria-hidden="true">
        {line}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {announced}
      </span>
    </>
  )
}
