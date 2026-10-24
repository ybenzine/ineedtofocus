// Sends what is on the device to the server (AC13.3) without ever losing it (AC13.5).
//
// - Sessions go in batches of up to 100 to `POST /api/sessions/sync`. Each result is per item:
//   `created`/`existing` mark the session synced, `rejected` marks it "Couldn't sync"; it stays on
//   the device, isn't retried automatically and doesn't hold back the others.
// - Retries are safe: the server dedupes by the session's client-generated id (AC13.4).
// - Network errors, timeouts and 5xx keep everything and retry with exponential backoff.
// - 401 means the sign-in expired: keep everything, stop until the next trigger (sign-in, back
//   online, app visible again).
// - Tag/goal edits to a synced session go as `PATCH`; a 409 (archived elsewhere) drops the edit,
//   and the device copy is marked archived; a 404 or 422 keeps it marked "Couldn't sync"
//   (AC11.4). A 404 means the session was deleted elsewhere: the next online History load sees
//   it is gone and removes the device copy with its stuck edit (#133).
// - Only the signed-in user's items are sent; other accounts' stay quarantined on the device.

import { SYNC_BATCH_LIMIT, type SessionsApi } from './api.ts'
import { SAVE_TIMEOUT_MS, withTimeout } from './saveRecord.ts'
import type { SessionStore } from './sessionStore.ts'

export type SyncOutcome =
  /** Everything that could be sent was sent. */
  | 'done'
  /** The device is offline; waits for the `online` event. */
  | 'offline'
  /** 401: the sign-in expired; reported through `onUnauthorized`, waits for a new sign-in. */
  | 'unauthorized'
  /** The signed-in user changed during the pass; nothing more was sent. */
  | 'owner-changed'
  /** Network or server error; a retry is scheduled with backoff. */
  | 'unavailable'

export interface SyncReport {
  outcome: SyncOutcome
  /** Sessions the server now has (created or already there). */
  synced: number
  /** Sessions the server refused this time. */
  rejected: number
  /** Edits the server applied. */
  edited: number
  /** Ids of sessions whose queued edit the server refused with a 409 (archived elsewhere) and was dropped. */
  dropped: string[]
}

export interface Scheduler {
  schedule(run: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

export const BACKOFF_BASE_MS = 2_000
export const BACKOFF_MAX_MS = 5 * 60_000
/** How long sign-out waits for a last sync (ruling on #9). */
export const TRY_SYNC_TIMEOUT_MS = 10_000

export interface SyncEngineOptions {
  store: SessionStore
  api: SessionsApi
  /** The signed-in user's id, or `null` if nobody is: then nothing is sent. */
  currentOwner: () => string | null
  scheduler?: Scheduler
  /** `navigator.onLine` by default. */
  isOnline?: () => boolean
  /** 0 ≤ x < 1, for backoff jitter. */
  random?: () => number
  /**
   * Runs one pass at a time across tabs (Web Locks when available). Two tabs syncing at once
   * would still be safe (idempotent by id), just wasteful.
   */
  exclusive?: <T>(run: () => Promise<T>) => Promise<T>
  /**
   * Time limit for each device-store call inside a pass. A stalled IndexedDB then fails the pass
   * (kept, retried with backoff) instead of holding the cross-tab lock forever.
   */
  storeTimeoutMs?: number
  /** Called when the server answers 401: the sign-in expired (the accounts UI re-checks it). */
  onUnauthorized?: () => void
}

const browserScheduler: Scheduler = {
  schedule: (run, delayMs) => window.setTimeout(run, delayMs),
  cancel: (handle) => window.clearTimeout(handle as number),
}

function browserExclusive<T>(run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return run()
  return locks.request('ineedtofocus-sync', run)
}

/** Delay before retry number `attempt` (1-based): 2 s, 4 s, 8 s … capped at 5 min, with jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(ceiling * (0.5 + random() / 2))
}

function copyReport(report: SyncReport): SyncReport {
  return { ...report, dropped: [...report.dropped] }
}

export class SyncEngine {
  readonly #store: SessionStore
  readonly #api: SessionsApi
  readonly #currentOwner: () => string | null
  readonly #scheduler: Scheduler
  readonly #isOnline: () => boolean
  readonly #random: () => number
  readonly #exclusive: <T>(run: () => Promise<T>) => Promise<T>
  readonly #storeTimeoutMs: number
  readonly #onUnauthorized: () => void
  #running: Promise<SyncReport> | null = null
  #again = false
  #failures = 0
  #retry: unknown = null
  #active = 0

  constructor(options: SyncEngineOptions) {
    this.#store = options.store
    this.#api = options.api
    this.#currentOwner = options.currentOwner
    this.#scheduler = options.scheduler ?? browserScheduler
    this.#isOnline = options.isOnline ?? (() => navigator.onLine)
    this.#random = options.random ?? Math.random
    this.#exclusive = options.exclusive ?? browserExclusive
    this.#storeTimeoutMs = options.storeTimeoutMs ?? SAVE_TIMEOUT_MS
    this.#onUnauthorized = options.onUnauthorized ?? (() => undefined)
  }

  /** Consecutive failed passes; drives the backoff. */
  get failures(): number {
    return this.#failures
  }

  /** True while a retry is scheduled. */
  get retryScheduled(): boolean {
    return this.#retry !== null
  }

  /**
   * Runs a sync pass now. If one is already running, another runs right after it (so nothing
   * saved meanwhile waits for the next trigger) and the returned report is the later one's,
   * except `dropped`, which covers every pass of the loop (without duplicates), whereas
   * `synced`, `rejected`, `edited` and `outcome` come from the last pass. Every caller gets its
   * own copy of the report.
   */
  syncNow(): Promise<SyncReport> {
    if (this.#running !== null) {
      this.#again = true
      return this.#running.then(copyReport)
    }
    this.#cancelRetry()
    const run = async (): Promise<SyncReport> => {
      let report: SyncReport
      // Gathered across every pass of the loop: the last pass alone could miss an earlier drop.
      const dropped: string[] = []
      do {
        this.#again = false
        report = await this.#exclusive(() => this.#pass())
        for (const id of report.dropped) if (!dropped.includes(id)) dropped.push(id)
      } while (this.#again)
      return { ...report, dropped }
    }
    this.#running = run().finally(() => {
      this.#running = null
    })
    return this.#running.then((report) => {
      this.#afterPass(report)
      return copyReport(report)
    })
  }

  /**
   * Sync before signing out: runs a pass, waiting at most `timeoutMs` (the pass itself carries on
   * in the background). Skipped when offline, so sign-out can warn straight away.
   */
  async trySync(timeoutMs: number = TRY_SYNC_TIMEOUT_MS): Promise<void> {
    if (!this.#isOnline()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([this.syncNow().then(() => undefined), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Starts syncing: once now, again when the connection returns or the app becomes visible,
   * and on the backoff schedule after a failure. Returns a function that stops it.
   */
  start(): () => void {
    this.#active += 1
    const onOnline = () => void this.syncNow()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.syncNow()
    }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    void this.syncNow()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      this.#active -= 1
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      if (this.#active === 0) this.#cancelRetry()
    }
  }

  #afterPass(report: SyncReport): void {
    if (report.outcome === 'unauthorized') this.#onUnauthorized()
    if (report.outcome === 'unavailable') {
      this.#failures += 1
      this.#scheduleRetry()
    } else {
      // Done, offline or signed out: a later trigger (online, visible, sign-in, save) resumes.
      this.#failures = 0
    }
  }

  #scheduleRetry(): void {
    // Retries run only while the engine is started, so a stopped engine leaves no timer behind.
    if (this.#active === 0) return
    this.#cancelRetry()
    this.#retry = this.#scheduler.schedule(
      () => {
        this.#retry = null
        void this.syncNow()
      },
      backoffDelay(this.#failures, this.#random),
    )
  }

  #cancelRetry(): void {
    if (this.#retry === null) return
    this.#scheduler.cancel(this.#retry)
    this.#retry = null
  }

  /** A device-store call with the pass's time limit. */
  #io<T>(operation: Promise<T>): Promise<T> {
    return withTimeout(operation, this.#storeTimeoutMs)
  }

  async #pass(): Promise<SyncReport> {
    const report: SyncReport = { outcome: 'done', synced: 0, rejected: 0, edited: 0, dropped: [] }
    if (!this.#isOnline()) return { ...report, outcome: 'offline' }
    const owner = this.#currentOwner()
    if (owner === null) return report
    try {
      const uploads = await this.#upload(owner, report)
      if (uploads !== 'done') return { ...report, outcome: uploads }
      // Await before spreading: `report` is filled in as the edits go out.
      const edits = await this.#sendEdits(owner, report)
      return { ...report, outcome: edits }
    } catch {
      // The device store failed (IndexedDB error): nothing was lost, try again later.
      return { ...report, outcome: 'unavailable' }
    }
  }

  /**
   * The request goes out with whoever's cookie the browser holds now, so stop if the user
   * changed since the pass began: their items must never reach another account.
   */
  #ownerChanged(owner: string): boolean {
    return this.#currentOwner() !== owner
  }

  async #upload(owner: string, report: SyncReport): Promise<SyncOutcome> {
    for (;;) {
      const batch = await this.#io(this.#store.uploadQueue(owner, SYNC_BATCH_LIMIT))
      if (batch.length === 0) return 'done'
      if (this.#ownerChanged(owner)) return 'owner-changed'
      const result = await this.#api.sync(batch.map((entry) => entry.record))
      if (result.kind === 'unauthorized') return 'unauthorized'
      // Anything but per-item results (5xx, network, a whole-request 422) saves nothing: retry.
      if (result.kind !== 'ok') return 'unavailable'
      let settled = 0
      for (const item of result.value) {
        const entry = batch[item.index]
        // Only trust a result that clearly belongs to the item we sent.
        if (entry === undefined || (item.id !== null && item.id !== entry.id)) continue
        if (item.status === 'rejected') {
          await this.#io(this.#store.markRejected(entry.id, item.error))
          report.rejected += 1
        } else {
          await this.#io(this.#store.markSynced(entry.id, item.session))
          report.synced += 1
        }
        settled += 1
      }
      // A reply that settled nothing would loop forever: treat it as a server error.
      if (settled === 0) return 'unavailable'
    }
  }

  async #sendEdits(owner: string, report: SyncReport): Promise<SyncOutcome> {
    for (const entry of await this.#io(this.#store.editQueue(owner))) {
      if (entry.edit === null) continue
      if (this.#ownerChanged(owner)) return 'owner-changed'
      const version = entry.editVersion
      const result = await this.#api.edit(entry.id, entry.edit)
      switch (result.kind) {
        case 'ok':
          await this.#io(this.#store.resolveEdit(entry.id, version, result.value))
          report.edited += 1
          break
        case 'conflict':
          // Archived on the server (AC11.4): the edit can never apply; the session is untouched.
          await this.#io(this.#store.dropEdit(entry.id, version))
          // The device copy follows, so offline History stops showing it. The real time comes
          // with the next online History or Archive load.
          await this.#io(this.#store.setArchived(owner, entry.id, new Date().toISOString()))
          if (!report.dropped.includes(entry.id)) report.dropped.push(entry.id)
          break
        case 'invalid':
        case 'not_found':
          await this.#io(
            this.#store.rejectEdit(entry.id, version, 'error' in result ? result.error : null),
          )
          break
        case 'unauthorized':
          return 'unauthorized'
        case 'unavailable':
          return 'unavailable'
      }
    }
    return 'done'
  }
}
