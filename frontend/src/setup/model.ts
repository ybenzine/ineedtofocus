// The New session setup as the app keeps it (AC2.6, AC7.10, AC8.8 of #405).
//
// A setup in progress survives a trip to another screen in the same tab, so it lives above the
// screen (in `App`), not in it. It stores only what the user changed (`edits`); everything else
// follows the current defaults (the Settings reminder, the synced last-used tag and Pomodoro
// configuration), so a default that changes meanwhile shows at once and never counts as the
// user's change. `began` is what the setup showed when it began: the user changed the setup only
// where an edit differs from it, which is what holds back an automatic update (#244).

import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_POMODORO, type Mode, type ReminderMinutes, type Tag } from '../timer/index.ts'
import type { AudioSource } from './options.ts'
import type { Preferences } from './preferences.ts'

/** AC2.6: a new Countdown setup starts at 30 minutes. */
export const DEFAULT_COUNTDOWN_MINUTES = 30

/** Every field the user can change on the setup screen; numbers are the text in their inputs. */
export interface SetupValues {
  mode: Mode
  countdown: string
  focus: string
  shortBreak: string
  blocks: string
  longBreakOn: boolean
  longBreak: string
  /** `off` or the minutes. */
  reminder: string
  tag: Tag
  goal: string
  audio: AudioSource
  youtubeText: string
}

export type SetupEdits = Partial<SetupValues>

/** What a new setup shows (AC2.6). */
export function defaultValues(
  remembered: Preferences,
  reminderMinutes: ReminderMinutes | null,
): SetupValues {
  const pomodoro = remembered.pomodoro ?? DEFAULT_POMODORO
  return {
    mode: 'countdown',
    countdown: String(DEFAULT_COUNTDOWN_MINUTES),
    focus: String(pomodoro.focusMinutes),
    shortBreak: String(pomodoro.breakMinutes),
    blocks: String(pomodoro.blocks),
    longBreakOn: pomodoro.longBreakEnabled,
    longBreak: String(pomodoro.longBreakMinutes),
    reminder: reminderMinutes === null ? 'off' : String(reminderMinutes),
    tag: remembered.tag,
    goal: '',
    audio: 'none',
    youtubeText: '',
  }
}

export interface SetupModel {
  /** The defaults with the user's edits on top. */
  values: SetupValues
  /** The user has changed the setup from the one it began with. */
  changed: boolean
  /** A start is under way; kept here so it shows on coming back to the screen. */
  starting: boolean
  /** Why the last start failed; kept here for the same reason. */
  failure: string | null
  edit: (patch: SetupEdits) => void
  setStarting: (starting: boolean) => void
  setFailure: (failure: string | null) => void
  /** Begins a new setup: after a session has started. Edits go; the defaults show again. */
  reset: () => void
}

interface State {
  edits: SetupEdits
  began: SetupValues
  starting: boolean
  failure: string | null
}

export function useSetupModel(defaults: SetupValues): SetupModel {
  const [state, setState] = useState<State>(() => ({
    edits: {},
    began: defaults,
    starting: false,
    failure: null,
  }))
  // `reset` and the edit callbacks stay stable; they read the newest defaults through this.
  const latest = useRef(defaults)
  useEffect(() => {
    latest.current = defaults
  })

  const values: SetupValues = { ...defaults, ...state.edits }
  const changed = (Object.keys(state.edits) as (keyof SetupValues)[]).some(
    (key) => state.edits[key] !== state.began[key],
  )

  const edit = useCallback((patch: SetupEdits) => {
    setState((current) => ({ ...current, edits: { ...current.edits, ...patch } }))
  }, [])
  const setStarting = useCallback((starting: boolean) => {
    setState((current) => ({ ...current, starting }))
  }, [])
  const setFailure = useCallback((failure: string | null) => {
    setState((current) => ({ ...current, failure }))
  }, [])
  const reset = useCallback(() => {
    setState((current) => ({ ...current, edits: {}, began: latest.current, failure: null }))
  }, [])

  return {
    values,
    changed,
    starting: state.starting,
    failure: state.failure,
    edit,
    setStarting,
    setFailure,
    reset,
  }
}
