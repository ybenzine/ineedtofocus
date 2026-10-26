// Keeps the device's copy of a session in step with the server when it was archived or deleted
// on another device. Only runs from an online History or Archive load, which is what
// shows the server's side. Archive and restore stay online-only, so this is the only way the
// device learns about them.

import type { ArchiveApi, ArchivedSession } from '../archive/api.ts'
import type { SessionStore } from './sessionStore.ts'

/** The server's archived list is the whole truth for these ids: mark them archived here. */
export async function markArchivedOnDevice(
  store: SessionStore,
  owner: string,
  archived: readonly Pick<ArchivedSession, 'id' | 'archivedAt'>[],
  /** Ids to leave alone, asked per id (e.g. restored on this screen since the list loaded). */
  isSkipped: (id: string) => boolean = () => false,
): Promise<void> {
  for (const session of archived) {
    if (isSkipped(session.id)) continue
    await store.setArchived(owner, session.id, session.archivedAt)
  }
}

/** The server lists these ids as live: clear the archived mark on the device copy. */
export async function clearArchivedOnDevice(
  store: SessionStore,
  owner: string,
  ids: readonly string[],
  /** Ids to leave alone, asked per id just before each write (archived or restored on this screen). */
  isSkipped: (id: string) => boolean = () => false,
): Promise<void> {
  for (const id of ids) {
    if (isSkipped(id)) continue
    await store.setArchived(owner, id, null)
  }
}

/**
 * `missing` are device sessions the server's active History doesn't list. Each is either
 * archived (then it is in the Archive list: mark it archived) or in neither answer. A session in
 * neither is marked `goneOnServer` and hidden, but kept (#227): it may have been restored on
 * another device between the two requests, or the server may have restored an older backup. It
 * is deleted (with an edit that could never be sent) only when a later pair, whose History
 * request started after the mark was set (`loadStartedAt`), still misses it. Changes nothing if
 * the Archive list can't be loaded, so a session is never hidden on a guess.
 */
export async function reconcileMissing(
  store: SessionStore,
  archiveApi: Pick<ArchiveApi, 'list'>,
  owner: string,
  missing: readonly string[],
  /** Ids to leave alone, asked per id just before each write. */
  isSkipped: (id: string) => boolean,
  /**
   * When this load's History request started (ms since the epoch). Required: a default taken
   * after the answer could confirm a mark written by a pair that overlapped this one.
   */
  loadStartedAt: number,
): Promise<void> {
  if (missing.length === 0) return
  const result = await archiveApi.list()
  if (result.kind !== 'ok') return
  const archived = new Map(result.value.map((s) => [s.id, s]))
  await markArchivedOnDevice(
    store,
    owner,
    missing.flatMap((id) => archived.get(id) ?? []),
    isSkipped,
  )
  await store.markGone(
    owner,
    missing.filter((id) => !archived.has(id) && !isSkipped(id)),
    loadStartedAt,
  )
}

/**
 * The server's archived list (`listed`, loaded just now) is the whole truth for device copies
 * marked archived (#263): a synced one it doesn't list was deleted on another device, or
 * restored there. The copy is already hidden (archived), so it is only marked `goneOnServer`
 * the first time; a later Archive load that started after the mark and still misses it deletes
 * it, as for #227. Never touches device-only archived sessions (rejected), unsynced ones or ones
 * with a pending edit (`markGone` skips those), nor ids in `isSkipped`. Call only after the list
 * loaded.
 */
export async function reconcileArchivedGone(
  store: SessionStore,
  owner: string,
  listed: readonly Pick<ArchivedSession, 'id'>[],
  isSkipped: (id: string) => boolean,
  /** When this load's Archive request started (ms since the epoch). Required, as above. */
  loadStartedAt: number,
): Promise<void> {
  const present = new Set(listed.map((s) => s.id))
  const device = await store.list(owner)
  const missing = device
    .filter(
      (d) =>
        d.syncState === 'synced' &&
        d.archivedAt !== null &&
        !present.has(d.record.id) &&
        !isSkipped(d.record.id),
    )
    .map((d) => d.record.id)
  if (missing.length > 0) await store.markGone(owner, missing, loadStartedAt)
}
