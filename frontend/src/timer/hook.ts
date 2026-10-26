import type { LocalDataHook } from '../auth/localData.ts'
import { SAVE_TIMEOUT_MS, withTimeout } from '../sync/saveRecord.ts'
import type { TimerController } from './controller.ts'

/**
 * The sign-out hook for a finished session held only in this tab's memory (#298): sign-out
 * tries to hand it over once more and, if it still can't, counts it like any unsynced session
 * so the confirmation asks first. Nothing to clear: the record lives in the tab and goes with it.
 */
export function heldRecordHook(controller: TimerController): LocalDataHook {
  return {
    countUnsynced: async () => ({
      sessions: controller.holdsRecord() ? 1 : 0,
      edits: 0,
    }),
    trySync: async () => {
      if (controller.holdsRecord()) await withTimeout(controller.retryPending(), SAVE_TIMEOUT_MS)
    },
    clear: async () => undefined,
  }
}
