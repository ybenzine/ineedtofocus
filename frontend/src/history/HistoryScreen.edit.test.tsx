// Edit and archive on History (F11), through the real HTTP clients against the fake server.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpArchiveApi } from '../archive/api.ts'
import { HttpSessionsApi } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { SyncEngine } from '../sync/syncEngine.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import type { ApiResult } from '../sync/api.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'
import type { SessionRecord } from '../timer/engine.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

/** The History API answered from the fake server's non-archived sessions. */
class ServerHistory implements HistoryApi {
  readonly server: FakeSessionsServer
  offline = false

  constructor(server: FakeSessionsServer) {
    this.server = server
  }

  async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    if (this.offline) return { kind: 'unavailable' }
    const base = emptyData(query.view, 'UTC', 1, periodFor('day', query.date ?? '', 1))
    const sessions: HistorySession[] = []
    for (const stored of this.server.sessions.values()) {
      if (stored.archivedAt !== null) continue
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
let name: string
let store: IndexedDbSessionStore
let engine: SyncEngine

beforeEach(() => {
  server = new FakeSessionsServer()
  history = new ServerHistory(server)
  name = freshDbName()
  store = new IndexedDbSessionStore({ name })
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

function renderScreen(props: Partial<Parameters<typeof HistoryScreen>[0]> = {}) {
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
      {...props}
    />,
  )
}

async function syncedSession(overrides: Partial<SessionRecord> = {}, onDevice = true) {
  const record = makeRecord({ startedAt: '2026-10-21T09:00:00Z', ...overrides })
  const api = new HttpSessionsApi({ fetch: server.fetch })
  const result = await api.sync([record])
  if (result.kind !== 'ok') throw new Error('setup failed')
  if (onDevice) {
    await store.save(record, 'me')
    await store.markSynced(record.id, result.value[0].session)
  }
  return record
}

describe('editing a session (AC11.1)', () => {
  it('changes tag and goal, shows them at once and sends them as a PATCH', async () => {
    const record = await syncedSession({ goal: 'Old goal', tag: 'work' })
    renderScreen()
    await screen.findByText('Old goal')

    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'study' } })
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'New goal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('New goal')).toBeInTheDocument()
    await waitFor(() => expect(server.editRequests).toHaveLength(1))
    expect(server.editRequests[0]).toEqual({
      id: record.id,
      body: { tag: 'study', goal: 'New goal' },
    })
    await waitFor(() => expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument())
    expect(screen.queryByText('Old goal')).not.toBeInTheDocument()
    expect(server.get(record.id)).toMatchObject({ tag: 'study', goal: 'New goal' })
    expect(await store.countUnsynced('me')).toEqual({ sessions: 0, edits: 0 })
  })

  it('offline: keeps the change on the device with a badge, then syncs it', async () => {
    const record = await syncedSession({ goal: 'Old goal' })
    server.mode = 'offline'
    renderScreen()
    await screen.findByText('Old goal')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Written offline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Written offline')).toBeInTheDocument()
    expect(await screen.findByText('Not synced yet')).toBeInTheDocument()

    server.mode = 'up'
    await engine.syncNow()
    expect(server.get(record.id)).toMatchObject({ goal: 'Written offline' })
  })

  it('moves the session between tags in the breakdown', async () => {
    await syncedSession({ tag: 'work', focusSeconds: 1500 })
    renderScreen()
    await screen.findByText('Focus time')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Tag'), { target: { value: 'nap' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => {
      const items = document.querySelectorAll('.history-tag-list li')
      expect(items).toHaveLength(1)
      expect(items[0]).toHaveTextContent('nap')
    })
  })

  it('keeps a goal to one line and 120 characters, and clears it when emptied', async () => {
    const record = await syncedSession({ goal: 'Keep me' })
    renderScreen()
    await screen.findByText('Keep me')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    const goal = screen.getByLabelText('Goal')
    expect(goal).toHaveAttribute('maxlength', '120')
    fireEvent.change(goal, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(server.editRequests).toHaveLength(1))
    expect(server.editRequests[0].body).toEqual({ goal: null })
    expect(server.get(record.id)).toMatchObject({ goal: null })
  })

  it('sends nothing when nothing changed, and Cancel discards the form', async () => {
    await syncedSession({ goal: 'Same' })
    renderScreen()
    await screen.findByText('Same')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByLabelText('Tag')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Other' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('Same')).toBeInTheDocument()
    expect(server.editRequests).toHaveLength(0)
  })

  it('edits a session that only the server has, online', async () => {
    const record = await syncedSession({ goal: 'From elsewhere' }, false)
    renderScreen()
    await screen.findByText('From elsewhere')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Fixed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Fixed')).toBeInTheDocument()
    expect(server.get(record.id)).toMatchObject({ goal: 'Fixed' })
  })

  it('says so when the session was archived on another device', async () => {
    const record = await syncedSession({ goal: 'Gone soon' }, false)
    renderScreen()
    await screen.findByText('Gone soon')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    server.archive(record.id)
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Late' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/archived on another device/)
  })

  it('a session not saved to the account yet can be edited but not archived', async () => {
    await store.save(makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Local' }), 'me')
    server.mode = 'offline'
    renderScreen()
    await screen.findByText('Local')
    expect(screen.queryByRole('button', { name: /^Archive session/ })).not.toBeInTheDocument()
    expect(screen.getByText(/archived once it has synced/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Edit session/ })).toBeInTheDocument()
  })
})

describe('archiving a session (AC11.2)', () => {
  it('removes it from the list and totals at once and offers Undo', async () => {
    const record = await syncedSession({ goal: 'Archive me', focusSeconds: 1500 })
    await syncedSession({ goal: 'Stay', focusSeconds: 600, startedAt: '2026-10-21T10:00:00Z' })
    renderScreen()
    await screen.findByText('Archive me')
    expect(screen.getByText('2')).toBeInTheDocument()

    const row = screen.getByText('Archive me').closest('li') as HTMLElement
    fireEvent.click(row.querySelector('button[aria-label^="Archive"]') as HTMLElement)

    await waitFor(() => expect(screen.queryByText('Archive me')).not.toBeInTheDocument())
    expect(screen.getByText('Stay')).toBeInTheDocument()
    expect(await screen.findByText('Session archived.')).toBeInTheDocument()
    expect(screen.getAllByText('10 min').length).toBeGreaterThan(0)
    expect(server.sessions.get(record.id)?.archivedAt).not.toBeNull()
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()
  })

  it('Undo brings the session back unchanged (AC11.5)', async () => {
    const record = await syncedSession({ goal: 'Undo me', tag: 'read' })
    renderScreen()
    await screen.findByText('Undo me')
    fireEvent.click(screen.getByRole('button', { name: /^Archive session/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Undo me')).toBeInTheDocument()
    expect(screen.queryByText('Session archived.')).not.toBeInTheDocument()
    expect(server.sessions.get(record.id)?.archivedAt).toBeNull()
    expect((await store.get(record.id))?.archivedAt).toBeNull()
    expect(server.get(record.id)).toMatchObject({ tag: 'read', goal: 'Undo me' })
  })

  it('puts the session back and says so if the archive does not reach the server', async () => {
    await syncedSession({ goal: 'Stays put' })
    renderScreen()
    await screen.findByText('Stays put')
    server.mode = 'offline'
    fireEvent.click(screen.getByRole('button', { name: /^Archive session/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t archive the session/)
    expect(screen.getByText('Stays put')).toBeInTheDocument()
    expect(screen.queryByText('Session archived.')).not.toBeInTheDocument()
  })

  it('sends a queued edit before archiving, so a restore returns it as the user left it', async () => {
    const record = await syncedSession({ goal: 'Before' })
    server.mode = 'offline'
    renderScreen()
    await screen.findByText('Before')
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'After' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('After')
    server.mode = 'up'
    fireEvent.click(screen.getByRole('button', { name: /^Archive session/ }))
    await screen.findByText('Session archived.')
    expect(server.get(record.id)).toMatchObject({ goal: 'After' })
    expect(server.sessions.get(record.id)?.archivedAt).not.toBeNull()
  })

  it('offline, the session archived on this device stays out of the cached view', async () => {
    await syncedSession({ goal: 'Archived here' })
    await syncedSession({ goal: 'Still here', startedAt: '2026-10-21T10:00:00Z' })
    renderScreen()
    await screen.findByText('Archived here')
    const row = screen.getByText('Archived here').closest('li') as HTMLElement
    fireEvent.click(row.querySelector('button[aria-label^="Archive"]') as HTMLElement)
    await screen.findByText('Session archived.')
    history.offline = true
    window.dispatchEvent(new Event('online'))
    expect(await screen.findByText(/You’re offline/)).toBeInTheDocument()
    expect(screen.getByText('Still here')).toBeInTheDocument()
    expect(screen.queryByText('Archived here')).not.toBeInTheDocument()
  })
})

describe('archived device sessions stay out of History', () => {
  /** A session that has not synced but is marked archived on the device. */
  async function unsyncedArchived() {
    const record = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Hidden unsynced' })
    await store.save(record, 'me')
    const raw = new Dexie(name)
    raw.version(1).stores({ sessions: 'id, ownerId, syncState, editState' })
    await raw.table('sessions').update(record.id, { archivedAt: '2026-10-21T11:00:00Z' })
    raw.close()
    expect((await store.get(record.id))?.syncState).toBe('pending')
    return record
  }

  it('online: leaves out an unsynced session that is archived', async () => {
    await unsyncedArchived()
    renderScreen()
    await screen.findByText('No sessions in this period.')
    expect(screen.queryByText('Hidden unsynced')).not.toBeInTheDocument()
    expect(screen.queryByText(/not saved to your account/)).not.toBeInTheDocument()
  })

  it('offline: leaves it out too', async () => {
    await unsyncedArchived()
    history.offline = true
    renderScreen()
    await screen.findByText(/You’re offline/)
    expect(screen.queryByText('Hidden unsynced')).not.toBeInTheDocument()
  })
})
