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
import type { ActiveSessionStore, StoredTimer } from './store.ts'

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
  /**
   * True if the session's latest change could not be written to the device yet (storage full or
   * unavailable). The timer keeps running and the write is retried on every later call, but a
   * reload before then would lose that change: the caller should say so.
   */
  unsaved?: boolean
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

interface Unsaved {
  base: ActiveSession | null
  session: ActiveSession
}

const NOTHING: TimerUpdate = {
  snapshot: null,
  events: [],
  outcome: null,
  recordPending: false,
  unsaved: false,
}

export class TimerController {
  readonly #store: ActiveSessionStore
  readonly #saveRecord: (record: SessionRecord) => void | Promise<void>
  readonly #now: () => number
  readonly #newId: () => string
  #session: ActiveSession | null = null
  /**
   * A change whose write to the store failed. `base` is the stored session it was made from
   * (`null` for a start: the store was empty). It is written again on the next call, as long as
   * the store still holds `base`; if another tab has changed the stored session meanwhile, the
   * stored one wins and this is dropped.
   */
  #unsaved: Unsaved | null = null
  /**
   * A finished session's record that could not be kept in the store as `pendingRecord` (the
   * write failed). Held here until `saveRecord` accepts it, so it isn't lost while the tab lives.
   */
  #held: SessionRecord | null = null

  constructor(options: TimerControllerOptions) {
    this.#store = options.store
    this.#saveRecord = options.saveRecord
    this.#now = options.now ?? (() => Date.now())
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  /**
   * The active session right now, or `null`. Reads the stored copy, so it follows changes made
   * in other tabs; reports and persists nothing.
   */
  current(): TimerSnapshot | null {
    this.#refresh(false)
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
    const pending = this.#pendingFor(stored)
    if (pending !== null) {
      const recordPending = !(await this.#handOff(pending))
      return { ...NOTHING, outcome: { kind: 'saved', record: pending }, recordPending }
    }
    // Same rules as a tick: adopt the stored session (and finish a pending retry), and write only
    // when events were skipped, so a second tab opening never undoes another tab's pending write.
    this.#refresh()
    const from = this.#session
    if (from === null) return NOTHING
    const now = this.#now()
    const { session, events, endedAt } = advance(from, now)
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), [])
    }
    if (events.length > 0) this.#commit(from, session)
    else this.#session = session
    return { ...NOTHING, snapshot: snapshot(session, now), unsaved: this.#unsaved !== null }
  }

  /** Starts a new session. Only one can be active at a time (AC6.1). */
  async start(options: StartOptions): Promise<TimerUpdate> {
    const stored = this.#store.load()
    const pending = this.#held ?? (stored === null ? null : this.#pendingFor(stored))
    if (pending !== null) {
      if (!(await this.#handOff(pending))) {
        throw new TimerError(
          'Your last session is still being saved on this device. Try again in a moment.',
        )
      }
    } else if (this.#session !== null || stored !== null) {
      throw new ActiveSessionExistsError()
    }
    // Another start may have won while the previous record was being handed over.
    // (including one another tab started: the store, not just this tab's memory, is the truth).
    if (this.#session !== null || this.#store.load() !== null) {
      throw new ActiveSessionExistsError()
    }
    const now = this.#now()
    const session = startSession({ id: this.#newId(), ...options }, now)
    // A failed write doesn't throw or hide the timer: it runs, is written again on the next call,
    // and the update says it isn't on the device yet.
    this.#commit(null, session)
    return { ...NOTHING, snapshot: snapshot(session, now), unsaved: this.#unsaved !== null }
  }

  /** Call on a timer and when the app becomes visible again: reports due events, ends on time. */
  async tick(): Promise<TimerUpdate> {
    const advanced = this.#advance()
    if (advanced === null) return NOTHING
    const { from, session, events, endedAt, now } = advanced
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), events)
    }
    // Only write when there is something other tabs must not replay (events already reported).
    // A quiet tick changes nothing worth storing, so two tabs never write back and forth.
    if (events.length > 0) this.#commit(from, session)
    else this.#session = session
    return { ...NOTHING, snapshot: snapshot(session, now), events, unsaved: this.#unsaved !== null }
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

  /**
   * True while the running session, or its latest change, exists only in this tab's memory
   * (the last write to the device failed). Reads nothing from the store.
   */
  hasUnsaved(): boolean {
    return this.#unsaved !== null
  }

  /**
   * True while a finished session's record exists only in this tab's memory: neither the
   * `pendingRecord` write nor `saveRecord` has landed (#286). A reload would lose it.
   */
  holdsRecord(): boolean {
    return this.#held !== null
  }

  /**
   * Drops a record held only in memory (#298): sign-out confirmed it would be deleted, and the
   * controller outlives the sign-out, so a later `start()` must not hand it to `saveRecord`.
   */
  discardHeld(): void {
    this.#held = null
  }

  /**
   * Takes over a finished session that was started elsewhere (an anonymous session saved from
   * the summary's prompt, #331) and hands it to `saveRecord` unchanged. Like `#finish`, it keeps
   * the record on the device until it is handed over, and holds it in memory if the store
   * refuses it; if this device already has another session in the store, that one is left alone.
   */
  async adopt(state: StoredTimer): Promise<TimerUpdate> {
    const record = state.pendingRecord
    if (record === null) throw new TimerError('There is no finished session to take over')
    let stored = false
    if (this.#session === null && this.#store.load() === null) {
      try {
        this.#store.save(state)
        stored = true
      } catch {
        // Held in memory below.
      }
    }
    if (!stored) this.#held = record
    const handedOff = await this.#handOff(record)
    return { ...NOTHING, outcome: { kind: 'saved', record }, recordPending: !handedOff }
  }

  /** Hands a finished session that couldn't be saved earlier to `saveRecord` again. */
  async retryPending(): Promise<boolean> {
    const stored = this.#store.load()
    const pending = this.#held ?? (stored === null ? null : this.#pendingFor(stored))
    if (pending === null) return true
    return this.#handOff(pending)
  }

  /**
   * The device's copy is the truth: another tab may have paused, resumed, skipped or stopped
   * since this one last looked. Adopt what is stored instead of overwriting it with a stale copy.
   */
  #refresh(write = true): void {
    const stored = this.#store.load()
    const unsaved = this.#unsaved
    if (unsaved !== null) {
      const same =
        stored === null
          ? unsaved.base === null
          : unsaved.base !== null &&
            stored.pendingRecord === null &&
            this.#pendingFor(stored) === null &&
            JSON.stringify(stored.session) === JSON.stringify(unsaved.base)
      if (same) {
        if (write) this.#writeUnsaved(unsaved)
        this.#session = unsaved.session
        return
      }
      // Another tab (or a finish) moved the stored session on: the stored one is the truth.
      this.#unsaved = null
    }
    this.#session = stored === null || this.#pendingFor(stored) !== null ? null : stored.session
  }

  /** The finished session's record still to be handed over, whether stored or only held here. */
  #pendingFor(stored: StoredTimer): SessionRecord | null {
    if (stored.pendingRecord !== null) return stored.pendingRecord
    return this.#held !== null && this.#held.id === stored.session.id ? this.#held : null
  }

  #advance(): (ReturnType<typeof advance> & { now: number; from: ActiveSession }) | null {
    this.#refresh()
    const from = this.#session
    if (from === null) return null
    const now = this.#now()
    return { ...advance(from, now), now, from }
  }

  async #transition(
    apply: (session: ActiveSession, now: number) => ActiveSession,
  ): Promise<TimerUpdate> {
    const advanced = this.#advance()
    if (advanced === null) throw new NoActiveSessionError()
    const { from, session, events, endedAt, now } = advanced
    if (endedAt !== null) {
      return this.#finish(session, finishSession(session, endedAt, 'completed'), events)
    }
    const next = apply(session, now)
    this.#commit(from, next)
    return { ...NOTHING, snapshot: snapshot(next, now), events, unsaved: this.#unsaved !== null }
  }

  async #finish(
    session: ActiveSession,
    outcome: FinishOutcome,
    events: TimerEvent[],
  ): Promise<TimerUpdate> {
    this.#session = null
    this.#unsaved = null
    if (outcome.kind === 'discarded') {
      this.#store.clear()
      return { ...NOTHING, events, outcome }
    }
    // Keep the record on the device until it has been handed over, so it can't be lost. If the
    // store refuses it, hold it here and hand it over anyway: the session store is the durable
    // place, and `saveRecord` is idempotent by id.
    try {
      this.#store.save({ session, pendingRecord: outcome.record })
    } catch {
      this.#held = outcome.record
    }
    const handedOff = await this.#handOff(outcome.record)
    return { ...NOTHING, events, outcome, recordPending: !handedOff }
  }

  async #handOff(record: SessionRecord): Promise<boolean> {
    try {
      await this.#saveRecord(record)
    } catch {
      return false
    }
    if (this.#held?.id === record.id) this.#held = null
    const stored = this.#store.load()
    // The stored copy is this record's pending copy, or the running session it came from when
    // the pending copy couldn't be written.
    if (stored?.session.id === record.id) {
      try {
        this.#store.clear()
      } catch {
        // Nothing more to do; the next start or restore finds the same id and hands over again.
      }
    }
    return true
  }

  /**
   * Writes a tick's or an action's new session, then adopts it. If the write fails the session
   * is still adopted here (so the display and events stay right) but is kept in `#unsaved` and
   * written again by the next call, so memory never runs ahead of the store without a retry.
   */
  #commit(from: ActiveSession | null, session: ActiveSession): void {
    const base = this.#unsaved === null ? from : this.#unsaved.base
    this.#session = session
    this.#unsaved = { base, session }
    this.#writeUnsaved(this.#unsaved)
  }

  #writeUnsaved(unsaved: Unsaved): void {
    try {
      this.#persist(unsaved.session)
    } catch {
      return
    }
    if (this.#unsaved === unsaved) this.#unsaved = null
  }

  #persist(session: ActiveSession): void {
    this.#store.save({ session, pendingRecord: null })
  }
}
