import { useEffect, useState } from 'react'
import type { SessionStore, SyncEngine } from '../sync/index.ts'

/**
 * Whether the server has session `id` (#454), for the iOS calendar link. Read from the device's
 * session store and re-read after each sync run that changed something. False while unknown.
 */
export function useSessionSynced(
  id: string,
  sessions: SessionStore | null | undefined,
  sync: SyncEngine | null | undefined,
): boolean {
  // Keyed by id, so a new id reads as not synced until its own answer arrives.
  const [known, setKnown] = useState<{ id: string; synced: boolean } | null>(null)
  useEffect(() => {
    if (!sessions) return
    let alive = true
    const read = () =>
      void sessions
        .get(id)
        .then((entry) => {
          if (alive) setKnown({ id, synced: entry?.syncState === 'synced' })
        })
        .catch(() => undefined)
    read()
    const stop = sync?.onChange(read)
    return () => {
      alive = false
      stop?.()
    }
  }, [id, sessions, sync])
  return known?.id === id && known.synced
}
