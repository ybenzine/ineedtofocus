// The timer's `saveRecord`: writes a finished session to the device store first (AC13.2), then
// asks the sync engine to send it. A stalled IndexedDB must not freeze the timer screen, so the
// write has a time limit: past it the save counts as failed, the timer shows "not saved yet" and
// keeps the record in its own store until a later retry succeeds (F13: never lost).

import type { SessionRecord } from '../timer/engine.ts'
import type { SessionStore } from './sessionStore.ts'

export const SAVE_TIMEOUT_MS = 4_000

export class SaveTimeoutError extends Error {
  override name = 'SaveTimeoutError'
  constructor(ms: number) {
    super(`Saving on the device took longer than ${ms} ms`)
  }
}

/** Settles like `promise`, or rejects with `SaveTimeoutError` after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SaveTimeoutError(ms)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export interface DeviceSaverOptions {
  store: SessionStore
  /** Who the session belongs to: whoever was signed in when it started (ruling on #9). */
  ownerOf: (record: SessionRecord) => string | null
  /** Called once the record is on the device; starts the network side (never awaited). */
  afterSave?: () => void
  timeoutMs?: number
}

export function deviceSaver({
  store,
  ownerOf,
  afterSave,
  timeoutMs = SAVE_TIMEOUT_MS,
}: DeviceSaverOptions): (record: SessionRecord) => Promise<void> {
  return async (record) => {
    await withTimeout(store.save(record, ownerOf(record)), timeoutMs)
    afterSave?.()
  }
}
