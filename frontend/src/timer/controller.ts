// Runs the one active session (AC6.1) on top of the pure engine: persists every change on the
// device (AC6.4), finishes sessions that ended while the app was closed (AC6.5), and hands each
// finished session to the session store before forgetting it.

import type { Tag, TimerConfig } from './config.ts'
import {
  TimerError,
  advance,
  finishSession,
  pauseSession,
  resumeSession,
  skipBreak,
  snapshot,
  startSession,
  stopSession,
  type ActiveSession,
  type FinishOutcome,
  type SessionRecord,
  type TimerEvent,
  type TimerSnapshot,
} from './engine.ts'
import type { ActiveSessionStore } from './store.ts'

export class ActiveSessionExistsError extends TimerError {
  override name = 'ActiveSessionExistsError'
  constructor() {
    super('A session is already active; stop it before starting another')
  }
}

export class NoActiveSessionError extends TimerError {
  override name = 'NoActiveSessionError'
  constructor() {
    super('There is no active session')
  }
}

export interface TimerUpdate {
  /** The active session after the call; `null` once it has finished or if there is none. */
  snapshot: TimerSnapshot | null
  /** Bells and chimes due since the last call, oldest first. */
  events: TimerEvent[]
  /** Set when the call finished the session: saved, or discarded as too short (AC6.2). */
  outcome: FinishOutcome | null
  /**
   * True if a finished session could not be handed to `saveRecord` yet. It stays on the device
   * and is handed over again by `retryPending`, `restore` or the next `start`.
   */
  recordPending: boolean
}

export interface TimerControllerOptions {
  store: ActiveSessionStore
  /** Saves a finished session (IndexedDB, #19). Must be idempotent by `record.id`. */
  saveRecord: (record: SessionRecord) => void | Promise<void>
  now?: () => number
  newId?: () => string
}

export interface StartOptions {
  config: TimerConfig
  tag: Tag
  goal: string | null
}

const NOTHING: TimerUpdate = { snapshot: null, events: [], outcome: null, recordPending: false }

export class TimerController {
  readonly #store: ActiveSessionStore
  readonly #saveRecord: (record: SessionRecord) => void | Promise<void>
  readonly #now: () => number
  readonly #newId: () => string
  #session: ActiveSession | null = null

  constructor(options: TimerControllerOptions) {
    this.#store = options.store
    this.#saveRecord = options.saveRecord
    this.#now = options.now ?? (() => Date.now())
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  /** The active session right now, or `null`. Read-only: does not report or persist anything. */
  current(): TimerSnapshot | null {
    return this.#session ? snapshot(this.#session, this.#now()) : null
  }

  /**
   * Picks up whatever was on the device when the app last closed (AC6.4). A countdown or
   * Pomodoro that reached its end in the meantime is saved as Completed at its scheduled end
   * (AC6.5). Bells and chimes that fell while the app was closed are not replayed.
   */
  async restore(): Promise<TimerUpdate> {
    const stored = this.#store.load()
    if (stored === null) return NOTHING
    if (stored.pendingRecord !== null) {
      const recordPending = !(await this.#handOff(stored.pendingRecord))
      return {
        ...NOTHING,
        outcome: { kind: 'saved', record: stored.pendingRecord },
        recordPending,
      }
    }
    const now = this.#now()
    const { session, endedAt } = advance(stored.session, now)
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), [])
    }
    this.#session = session
    this.#persist(session)
    return { ...NOTHING, snapshot: snapshot(session, now) }
  }

  /** Starts a new session. Only one can be active at a time (AC6.1). */
  async start(options: StartOptions): Promise<TimerUpdate> {
    const stored = this.#store.load()
    if (stored?.pendingRecord) {
      if (!(await this.#handOff(stored.pendingRecord))) {
        throw new TimerError('The previous session has not been saved yet')
      }
    } else if (this.#session !== null || stored !== null) {
      throw new ActiveSessionExistsError()
    }
    // Another start may have won while the previous record was being handed over.
    if (this.#session !== null) throw new ActiveSessionExistsError()
    const now = this.#now()
    const session = startSession({ id: this.#newId(), ...options }, now)
    this.#session = session
    this.#persist(session)
    return { ...NOTHING, snapshot: snapshot(session, now) }
  }

  /** Call on a timer and when the app becomes visible again: reports due events, ends on time. */
  async tick(): Promise<TimerUpdate> {
    const advanced = this.#advance()
    if (advanced === null) return NOTHING
    const { session, events, endedAt, now } = advanced
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), events)
    }
    if (session !== this.#session) {
      this.#session = session
      this.#persist(session)
    }
    return { ...NOTHING, snapshot: snapshot(session, now), events }
  }

  async pause(): Promise<TimerUpdate> {
    return this.#transition((session, now) => pauseSession(session, now))
  }

  async resume(): Promise<TimerUpdate> {
    return this.#transition((session, now) => resumeSession(session, now))
  }

  /** Skips the current Pomodoro break (AC3.5). */
  async skipBreak(): Promise<TimerUpdate> {
    const events: TimerEvent[] = []
    const update = await this.#transition((session, now) => {
      const result = skipBreak(session, now)
      events.push(result.event)
      return result.session
    })
    return { ...update, events: [...update.events, ...events] }
  }

  /** Stops the session now (AC2.5, AC3.7, AC4.4). */
  async stop(): Promise<TimerUpdate> {
    const advanced = this.#advance()
    if (advanced === null) throw new NoActiveSessionError()
    const { session, events, now } = advanced
    return this.#finish(session, stopSession(session, now), events)
  }

  /** Hands a finished session that couldn't be saved earlier to `saveRecord` again. */
  async retryPending(): Promise<boolean> {
    const stored = this.#store.load()
    if (stored?.pendingRecord == null) return true
    return this.#handOff(stored.pendingRecord)
  }

  #advance(): (ReturnType<typeof advance> & { now: number }) | null {
    if (this.#session === null) return null
    const now = this.#now()
    return { ...advance(this.#session, now), now }
  }

  async #transition(
    apply: (session: ActiveSession, now: number) => ActiveSession,
  ): Promise<TimerUpdate> {
    const advanced = this.#advance()
    if (advanced === null) throw new NoActiveSessionError()
    const { session, events, endedAt, now } = advanced
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), events)
    }
    const next = apply(session, now)
    this.#session = next
    this.#persist(next)
    return { ...NOTHING, snapshot: snapshot(next, now), events }
  }

  async #finish(
    session: ActiveSession,
    outcome: FinishOutcome,
    events: TimerEvent[],
  ): Promise<TimerUpdate> {
    this.#session = null
    if (outcome.kind === 'discarded') {
      this.#store.clear()
      return { ...NOTHING, events, outcome }
    }
    // Keep the record on the device until it has been handed over, so it can't be lost.
    this.#store.save({ session, pendingRecord: outcome.record })
    const handedOff = await this.#handOff(outcome.record)
    return { ...NOTHING, events, outcome, recordPending: !handedOff }
  }

  async #handOff(record: SessionRecord): Promise<boolean> {
    try {
      await this.#saveRecord(record)
    } catch {
      return false
    }
    const stored = this.#store.load()
    if (stored?.pendingRecord?.id === record.id) this.#store.clear()
    return true
  }

  #persist(session: ActiveSession): void {
    this.#store.save({ session, pendingRecord: null })
  }
}
