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
 * archived (then it is in the Archive list: mark it archived) or deleted (not there: remove the
 * device copy, and with it an edit that could never be sent). Changes nothing if the Archive
 * list can't be loaded, so a session is never removed on a guess.
 */
export async function reconcileMissing(
  store: SessionStore,
  archiveApi: Pick<ArchiveApi, 'list'>,
  owner: string,
  missing: readonly string[],
  /** Ids to leave alone, asked per id just before each write. */
  isSkipped: (id: string) => boolean = () => false,
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
  await store.forget(
    owner,
    missing.filter((id) => !archived.has(id) && !isSkipped(id)),
  )
}
