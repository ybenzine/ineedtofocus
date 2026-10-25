// What the app tells the updater (#244): which screen is up, and what to send before a reload.
// A module-level signal rather than a prop, because the updater starts in `main.tsx`, outside React.

type Listener = () => void

let viewBusy = true
const listeners = new Set<Listener>()
const flushers = new Set<() => Promise<unknown>>()

/** True while the timer, a summary or the start-up restore is on screen: never reload then. */
export function setViewBusy(busy: boolean): void {
  if (viewBusy === busy) return
  viewBusy = busy
  for (const listener of [...listeners]) listener()
}

export function isViewBusy(): boolean {
  return viewBusy
}

/** Called whenever the screen changes. */
export function onViewChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Work to send before a reload (settings edits, the sync queue). Never needs to throw. */
export function registerUpdateFlush(flush: () => Promise<unknown>): () => void {
  flushers.add(flush)
  return () => flushers.delete(flush)
}

export async function runUpdateFlushes(): Promise<void> {
  await Promise.all(
    [...flushers].map(async (flush) => {
      try {
        await flush()
      } catch {
        // Still on the device (settings pending, sessions in IndexedDB); the reload loses nothing.
      }
    }),
  )
}
