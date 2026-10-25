// A session archived or deleted on another device: an online History load updates the device
// copy, so offline History stops showing it (#133).

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpArchiveApi } from '../archive/api.ts'
import { HttpSessionsApi, type ApiResult } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { SyncEngine } from '../sync/syncEngine.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import type { SessionRecord } from '../timer/engine.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

/** The History API answered from the fake server's non-archived sessions (day view, UTC). */
class ServerHistory implements HistoryApi {
  offline = false
  /** Also lists archived sessions: an answer that predates an archive made on this screen. */
  stale = false
  /** Every answer given, so a test can wait for a request to finish. */
  readonly answers: Promise<unknown>[] = []
  readonly server: FakeSessionsServer

  constructor(server: FakeSessionsServer) {
    this.server = server
  }

  get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    const answer = this.answer(query)
    this.answers.push(answer)
    return answer
  }

  async answer(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    if (this.offline) return { kind: 'unavailable' }
    const base = emptyData(query.view, 'UTC', 1, periodFor('day', query.date ?? '', 1))
    const sessions: HistorySession[] = []
    for (const stored of this.server.sessions.values()) {
      if (stored.archivedAt !== null && !this.stale) continue
      const item = stored.item
      sessions.push({
        id: String(item.id),
        mode: item.mode as HistorySession['mode'],
        tag: item.tag as HistorySession['tag'],
        goal: (item.goal as string | null) ?? null,
        startedAt: String(item.started_at),
        focusSeconds: Number(item.focus_seconds),
        status: item.status as HistorySession['status'],
        indicator: 'synced',
      })
    }
    return { kind: 'ok', value: mergeSessions(base, sessions, []) }
  }
}

let server: FakeSessionsServer
let history: ServerHistory
let store: IndexedDbSessionStore
let engine: SyncEngine

beforeEach(() => {
  server = new FakeSessionsServer()
  history = new ServerHistory(server)
  store = new IndexedDbSessionStore({ name: freshDbName() })
  engine = new SyncEngine({
    store,
    api: new HttpSessionsApi({ fetch: server.fetch }),
    currentOwner: () => 'me',
    isOnline: () => true,
    exclusive: (run) => run(),
  })
})

afterEach(() => {
  store.close()
  vi.restoreAllMocks()
})

function renderScreen() {
  return render(
    <HistoryScreen
      api={history}
      timeZone="UTC"
      now={() => NOW}
      ownerId="me"
      sessions={store}
      sync={engine}
      sessionsApi={new HttpSessionsApi({ fetch: server.fetch })}
      archiveApi={new HttpArchiveApi({ fetch: server.fetch })}
    />,
  )
}

async function syncedSession(overrides: Partial<SessionRecord> = {}) {
  const record = makeRecord({ startedAt: '2026-10-21T09:00:00Z', ...overrides })
  const result = await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
  if (result.kind !== 'ok') throw new Error('setup failed')
  await store.save(record, 'me')
  await store.markSynced(record.id, result.value[0].session)
  return record
}

describe('a session archived or deleted on another device (#133)', () => {
  it('ac1 an online load marks a session archived elsewhere as archived on the device', async () => {
    const record = await syncedSession({ goal: 'Elsewhere' })
    server.archive(record.id)
    const first = renderScreen()
    await screen.findByText('No sessions in this period.')
    await waitFor(async () => expect((await store.get(record.id))?.archivedAt).not.toBeNull())
    first.unmount()

    // Offline, with nothing cached: History no longer shows it.
    history.offline = true
    renderScreen()
    await screen.findByText(/Showing what’s saved on this device/)
    expect(screen.queryByText('Elsewhere')).not.toBeInTheDocument()
  })

  it('ac1 an online load removes a session deleted on another device from the device', async () => {
    const record = await syncedSession({ goal: 'Deleted elsewhere' })
    server.sessions.delete(record.id)
    renderScreen()
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
  })

  it('ac2 a stuck "Couldn’t sync" edit goes away with a session deleted elsewhere', async () => {
    const record = await syncedSession({ goal: 'Mine' })
    await store.edit('me', record.id, { goal: 'Late edit' })
    server.sessions.delete(record.id)
    // The 404 keeps the edit as "Couldn't sync" (Decision log)...
    await engine.syncNow()
    expect((await store.get(record.id))?.editState).toBe('rejected')
    // ...until an online load shows the session is gone.
    renderScreen()
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
    expect(await store.countUnsynced('me')).toEqual({ sessions: 0, edits: 0 })
  })

  it('keeps everything when the Archive list cannot be loaded (never removes on a guess)', async () => {
    const record = await syncedSession({ goal: 'Unsure' })
    server.sessions.delete(record.id)
    const archiveApi = new HttpArchiveApi({ fetch: () => Promise.reject(new Error('down')) })
    render(
      <HistoryScreen
        api={history}
        timeZone="UTC"
        now={() => NOW}
        ownerId="me"
        sessions={store}
        archiveApi={archiveApi}
      />,
    )
    await screen.findByText('No sessions in this period.')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await store.get(record.id)).toBeDefined()
  })

  it('leaves alone a session outside the period and one that is not synced', async () => {
    const other = await syncedSession({ startedAt: '2026-10-10T09:00:00Z' })
    const unsynced = makeRecord({ startedAt: '2026-10-21T10:00:00Z' })
    await store.save(unsynced, 'me')
    server.sessions.delete(other.id)
    renderScreen()
    await screen.findByText('Not synced yet')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await store.get(other.id)).toBeDefined()
    expect(await store.get(unsynced.id)).toBeDefined()
  })
})

describe('a session restored on another device (#228)', () => {
  it('ac1 ac2 an online load clears the archived mark, so offline History shows it again', async () => {
    const record = await syncedSession({ goal: 'Back again' })
    await store.setArchived('me', record.id, '2026-10-21T10:00:00Z')
    const first = renderScreen()
    await waitFor(async () => expect((await store.get(record.id))?.archivedAt).toBeNull())
    first.unmount()

    history.offline = true
    renderScreen()
    await screen.findByText(/Showing what’s saved on this device/)
    expect(await screen.findByText('Back again')).toBeInTheDocument()
  })

  it('keeps the mark of a session archived here when an older answer still lists it', async () => {
    await syncedSession({ goal: 'Mine to archive' })
    renderScreen()
    const archive = await screen.findByRole('button', { name: /^Archive/ })
    // The answer that follows the archive still lists the session as live (it predates it).
    history.stale = true
    fireEvent.click(archive)
    await screen.findByText(/Session archived/)
    // Wait for the request that follows the archive (and the reconcile it starts) to finish.
    await waitFor(() => expect(history.answers.length).toBeGreaterThanOrEqual(2))
    await act(async () => {
      await Promise.all(history.answers)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const [mine] = await store.list('me')
    expect(mine.archivedAt).not.toBeNull()
  })

  it('keeps a session live when Undo ran while a reconcile was loading the Archive list', async () => {
    const record = await syncedSession({ goal: 'Undone' })
    const real = new HttpArchiveApi({ fetch: server.fetch })
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let hold = false
    const archiveApi = {
      archive: (id: string) => real.archive(id),
      restore: (id: string) => real.restore(id),
      // An older answer: it still lists the session as archived.
      list: async () => {
        if (!hold) return real.list()
        await held
        return {
          kind: 'ok' as const,
          value: [{ id: record.id, archivedAt: '2026-10-21T10:00:00Z' }],
        }
      },
    } as unknown as HttpArchiveApi
    // The archive's own device write fails, so the next load sees the session as missing.
    vi.spyOn(store, 'setArchived').mockRejectedValueOnce(new Error('write failed'))
    render(
      <HistoryScreen
        api={history}
        timeZone="UTC"
        now={() => NOW}
        ownerId="me"
        sessions={store}
        sync={engine}
        sessionsApi={new HttpSessionsApi({ fetch: server.fetch })}
        archiveApi={archiveApi}
      />,
    )
    const archive = await screen.findByRole('button', { name: /^Archive/ })
    hold = true
    fireEvent.click(archive)
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(screen.queryByText(/Session archived/)).not.toBeInTheDocument())
    await waitFor(async () => expect((await store.get(record.id))?.archivedAt).toBeNull())
    // Let the reload that follows Undo finish first, so it cannot repair a stale mark.
    await act(async () => {
      await Promise.all(history.answers)
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const forgets = vi.spyOn(store, 'forget')
    release()
    await waitFor(() => expect(forgets).toHaveBeenCalled())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect((await store.get(record.id))?.archivedAt).toBeNull()
  })
})
