// A way out of "Couldn't sync" on History and Archive (F11, F13): discard a refused edit, archive
// a rejected session on this device only.

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpArchiveApi } from '../archive/api.ts'
import ArchiveScreen from '../archive/ArchiveScreen.tsx'
import { HttpSessionsApi } from '../sync/api.ts'
import type { ApiResult } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { SyncEngine } from '../sync/syncEngine.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

class ServerHistory implements HistoryApi {
  offline = false
  readonly server: FakeSessionsServer
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

function renderHistory() {
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

/** A synced session whose queued edit the server refused (422). */
async function sessionWithRefusedEdit() {
  const record = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Synced goal', tag: 'work' })
  const result = await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
  if (result.kind !== 'ok') throw new Error('setup failed')
  await store.save(record, 'me')
  await store.markSynced(record.id, result.value[0].session)
  await store.edit('me', record.id, { tag: 'study', goal: 'Refused goal' })
  const version = (await store.get(record.id))?.editVersion ?? 0
  await store.rejectEdit(record.id, version, null)
  return record
}

/** A session the server rejected, on the device only. */
async function rejectedSession(goal = 'Wrong clock') {
  const record = makeRecord({ startedAt: '2026-10-21T10:00:00Z', goal })
  await store.save(record, 'me')
  await store.markRejected(record.id, null)
  return record
}

describe('Discard change (AC11.1, AC13.5)', () => {
  it('asks first with Cancel focused; Cancel keeps the edit and returns focus', async () => {
    await sessionWithRefusedEdit()
    renderHistory()
    await screen.findByText('Refused goal')

    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      'Discard this change? The session keeps its last synced tag and goal.',
    )
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Discard change to session/ })).toHaveFocus()
    expect(screen.getByText('Refused goal')).toBeInTheDocument()
  })

  it('Escape also cancels', async () => {
    await sessionWithRefusedEdit()
    renderHistory()
    await screen.findByText('Refused goal')
    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Discard change to session/ })).toHaveFocus()
  })

  it('on confirm removes the edit, shows the server’s tag and goal and makes Archive available', async () => {
    const record = await sessionWithRefusedEdit()
    renderHistory()
    await screen.findByText('Refused goal')
    expect(screen.getByText('Couldn’t sync')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Archive session/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    const dialog = screen.getByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard change' }))

    expect(await screen.findByText('Synced goal')).toBeInTheDocument()
    expect(screen.queryByText('Refused goal')).not.toBeInTheDocument()
    expect(screen.queryByText('Couldn’t sync')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Archive session/ })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /^Edit session/ })).toHaveFocus())
    const stored = await store.get(record.id)
    expect(stored?.edit).toBeNull()
    expect(stored?.editState).toBeNull()
    // Nothing is sent to discard it.
    expect(server.editRequests).toHaveLength(0)
  })
})

describe('Discard change: edge cases (#253)', () => {
  it('works offline: nothing is sent and the row shows the synced tag and goal', async () => {
    await sessionWithRefusedEdit()
    history.offline = true
    server.mode = 'offline'
    renderHistory()
    await screen.findByText('Refused goal')
    server.requests.length = 0

    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard change' }),
    )

    expect(await screen.findByText('Synced goal')).toBeInTheDocument()
    expect(screen.queryByText('Refused goal')).not.toBeInTheDocument()
    expect(server.requests).toEqual([])
    expect(server.editRequests).toHaveLength(0)
  })

  it('when the discard fails, says so and puts focus back on the Discard button', async () => {
    const record = await sessionWithRefusedEdit()
    vi.spyOn(store, 'discardEdit').mockRejectedValue(new Error('disk full'))
    renderHistory()
    await screen.findByText('Refused goal')

    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard change' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t discard the change')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Discard change to session/ })).toHaveFocus(),
    )
    expect(screen.getByText('Refused goal')).toBeInTheDocument()
    expect((await store.get(record.id))?.editState).toBe('rejected')
  })

  it('keeps the row’s Edit button inert while the confirmation is open', async () => {
    await sessionWithRefusedEdit()
    renderHistory()
    await screen.findByText('Refused goal')
    const edit = screen.getByRole('button', { name: /^Edit session/ })
    expect(edit).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: /^Discard change to session/ }))
    expect(screen.getByRole('button', { name: /^Edit session/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /^Edit session/ }))
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: /^Edit session/ })).toBeEnabled()
  })
})

describe('Archive on this device only (AC11.2, AC11.4, AC11.5)', () => {
  it('is offered for a rejected session instead of the usual Archive', async () => {
    await rejectedSession()
    renderHistory()
    expect(await screen.findByText('Wrong clock')).toBeInTheDocument()
    expect(screen.getByText('Couldn’t sync')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /on this device only$/ })).toBeInTheDocument()
    expect(screen.queryByText('Can be archived once it has synced.')).not.toBeInTheDocument()
  })

  it('a not-synced-yet session still cannot be archived', async () => {
    await store.save(makeRecord({ startedAt: '2026-10-21T10:00:00Z', goal: 'Pending' }), 'me')
    renderHistory()
    await screen.findByText('Pending')
    expect(screen.getByText('Can be archived once it has synced.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /on this device only/ })).toBeNull()
  })

  it('leaves History and totals at once, offline too, sending nothing, with Undo', async () => {
    const record = await rejectedSession()
    history.offline = true
    renderHistory()
    await screen.findByText('Wrong clock')

    fireEvent.click(screen.getByRole('button', { name: /on this device only$/ }))

    expect(await screen.findByText('Session archived on this device only.')).toBeInTheDocument()
    expect(screen.queryByText('Wrong clock')).not.toBeInTheDocument()
    expect(screen.getByText('No sessions in this period.')).toBeInTheDocument()
    expect(server.requests).toEqual([])
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()

    // Undo puts it back, still marked, and sends nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Wrong clock')).toBeInTheDocument()
    expect(screen.getByText('Couldn’t sync')).toBeInTheDocument()
    expect(server.requests).toEqual([])
    expect((await store.get(record.id))?.archivedAt).toBeNull()
  })

  it('stays archived through an online load: the cross-device reconcile leaves it alone', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    const other = makeRecord({ startedAt: '2026-10-21T08:00:00Z', goal: 'On the server' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([other])
    renderHistory()
    await screen.findByText('On the server')
    expect(screen.queryByText('Wrong clock')).not.toBeInTheDocument()
    // Let the fire-and-forget reconcile finish.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const stored = await store.get(record.id)
    expect(stored?.archivedAt).not.toBeNull()
    expect(stored?.syncState).toBe('rejected')
    expect(server.requests.filter((r) => /\/(archive|restore)$/.test(r))).toEqual([])
  })
})

describe('a late Undo reply (#253)', () => {
  it('does not clear the message of a newer device-only archive', async () => {
    const synced = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'On the server' })
    const result = await new HttpSessionsApi({ fetch: server.fetch }).sync([synced])
    if (result.kind !== 'ok') throw new Error('setup failed')
    await store.save(synced, 'me')
    await store.markSynced(synced.id, result.value[0].session)
    await rejectedSession()

    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowRestore: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init)
      if (String(input).endsWith('/restore')) await gate
      return response
    }
    render(
      <HistoryScreen
        api={history}
        timeZone="UTC"
        now={() => NOW}
        ownerId="me"
        sessions={store}
        sync={engine}
        sessionsApi={new HttpSessionsApi({ fetch: server.fetch })}
        archiveApi={new HttpArchiveApi({ fetch: slowRestore })}
      />,
    )
    await screen.findByText('On the server')

    fireEvent.click(screen.getByRole('button', { name: /^Archive session from .*[AP]M$/ }))
    expect(await screen.findByText('Session archived.')).toBeInTheDocument()
    // Undo is sent, but its reply is held back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(server.requests.some((r) => r.endsWith('/restore'))).toBe(true))

    fireEvent.click(await screen.findByRole('button', { name: /on this device only$/ }))
    expect(await screen.findByText('Session archived on this device only.')).toBeInTheDocument()

    release()
    await waitFor(() => expect(server.sessions.get(synced.id)?.archivedAt).toBeNull())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByText('Session archived on this device only.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})

describe('a late device-only Undo (#264)', () => {
  it('does not clear the message of a newer device-only archive', async () => {
    await rejectedSession('First refused')
    await store.save(
      makeRecord({ startedAt: '2026-10-21T08:00:00Z', goal: 'Second refused' }),
      'me',
    )
    const second = (await store.list('me')).find((d) => d.record.goal === 'Second refused')
    if (!second) throw new Error('setup failed')
    await store.markRejected(second.record.id, null)

    const original = store.restoreOnDevice.bind(store)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(store, 'restoreOnDevice').mockImplementation(async (owner, id) => {
      await gate
      return original(owner, id)
    })
    renderHistory()
    await screen.findByText('First refused')

    fireEvent.click(screen.getAllByRole('button', { name: /on this device only$/ })[0])
    expect(await screen.findByText('Session archived on this device only.')).toBeInTheDocument()
    // Undo is under way (held back) when another session is archived on this device only.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    fireEvent.click(await screen.findByRole('button', { name: /on this device only$/ }))
    await waitFor(async () =>
      expect((await store.list('me')).filter((d) => d.archivedAt !== null)).toHaveLength(2),
    )

    release()
    await waitFor(async () =>
      expect((await store.list('me')).filter((d) => d.archivedAt !== null)).toHaveLength(1),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.getByText('Session archived on this device only.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})

describe('the Archive screen with a device-only session', () => {
  function renderArchive() {
    return render(
      <ArchiveScreen
        api={new HttpArchiveApi({ fetch: server.fetch })}
        sessions={store}
        ownerId="me"
        timeZone="UTC"
      />,
    )
  }

  it('lists it marked "Only on this device"', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    renderArchive()
    expect(await screen.findByText('Wrong clock')).toBeInTheDocument()
    expect(screen.getByText('Only on this device')).toBeInTheDocument()
  })

  it('Restore (AC11.5) puts it back in History, still "Couldn’t sync", with no request for it', async () => {
    const record = await rejectedSession()
    const before = await store.get(record.id)
    await store.archiveOnDevice('me', record.id)
    renderArchive()
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    expect(await screen.findByText('Session restored to History.')).toBeInTheDocument()
    expect(screen.queryByText('Only on this device')).not.toBeInTheDocument()
    expect(server.requests.filter((r) => r.includes('restore'))).toEqual([])
    expect(await store.get(record.id)).toEqual(before)
    expect((await store.list('me'))[0].indicator).toBe('couldnt-sync')
  })

  it('Delete all (AC11.6) counts it in the confirmation and deletes it', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    const onServer = makeRecord({ goal: 'Server archived' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([onServer])
    server.archive(onServer.id)
    renderArchive()
    await screen.findByText('Wrong clock')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Permanently delete 2 archived sessions? This can’t be undone.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 sessions' }))
    expect(await screen.findByText('Deleted 2 archived sessions.')).toBeInTheDocument()
    expect(screen.getByText('No archived sessions.')).toBeInTheDocument()
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
  })

  it('Delete all works when the device-only session is the only one', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    renderArchive()
    await screen.findByText('Wrong clock')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Permanently delete 1 archived session?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    expect(await screen.findByText('Deleted 1 archived session.')).toBeInTheDocument()
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
  })

  it('Delete all keeps device-only sessions when the server delete fails', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    renderArchive()
    await screen.findByText('Wrong clock')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    server.mode = 'down'
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t delete/)
    expect(screen.getByText('Wrong clock')).toBeInTheDocument()
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()
    // Focus goes back to Delete all (it was disabled while the request ran).
    const deleteAll = screen.getByRole('button', { name: 'Delete all archived sessions' })
    await waitFor(() => expect(deleteAll).toHaveFocus())
  })

  it('a failed Delete all clears an earlier notice instead of showing it next to the error', async () => {
    for (const goal of ['One', 'Two']) {
      const record = makeRecord({ goal })
      await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
      server.archive(record.id)
    }
    renderArchive()
    await screen.findByText('One')
    fireEvent.click(screen.getAllByRole('button', { name: /^Restore/ })[0])
    expect(await screen.findByText('Session restored to History.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    server.mode = 'down'
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t delete/)
    expect(screen.queryByText('Session restored to History.')).not.toBeInTheDocument()
  })

  it('Delete all says so when the server deleted 0 and nothing else was on the device', async () => {
    // Listed, but deleted elsewhere before the confirmation: the server removes none.
    vi.spyOn(HttpArchiveApi.prototype, 'list').mockResolvedValue({
      kind: 'ok',
      value: [
        {
          id: 'gone-1',
          mode: 'countdown',
          tag: 'work',
          goal: 'Gone',
          startedAt: '2026-10-21T09:00:00Z',
          focusSeconds: 600,
          status: 'completed',
          archivedAt: '2026-10-22T09:00:00Z',
        },
      ],
    })
    vi.spyOn(HttpArchiveApi.prototype, 'deleteAll').mockResolvedValue({ kind: 'ok', value: 0 })
    renderArchive()
    await screen.findByText('Gone')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    expect(await screen.findByText('Deleted 0 archived sessions.')).toBeInTheDocument()
    expect(screen.getByText('No archived sessions.')).toBeInTheDocument()
  })

  it('on equal archive times the server row comes before the device-only row', async () => {
    store.close()
    const at = Date.UTC(2026, 9, 23, 12)
    store = new IndexedDbSessionStore({ name: freshDbName(), now: () => at })
    const device = await rejectedSession('Device tie')
    await store.archiveOnDevice('me', device.id)
    vi.spyOn(HttpArchiveApi.prototype, 'list').mockResolvedValue({
      kind: 'ok',
      value: [
        {
          id: 'server-tie',
          mode: 'countdown',
          tag: 'work',
          goal: 'Server tie',
          startedAt: '2026-10-21T09:00:00Z',
          focusSeconds: 600,
          status: 'completed',
          archivedAt: new Date(at).toISOString(),
        },
      ],
    })
    renderArchive()
    await screen.findByText('Server tie')
    await screen.findByText('Device tie')
    const goals = screen
      .getAllByRole('listitem')
      .map((item) => /Device tie|Server tie/.exec(item.textContent ?? '')?.[0])
    expect(goals).toEqual(['Server tie', 'Device tie'])
  })

  it('Delete all says so when the device-side delete fails, and keeps those rows listed', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    const onServer = makeRecord({ goal: 'Server archived' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([onServer])
    server.archive(onServer.id)
    vi.spyOn(store, 'removeArchived').mockRejectedValue(new Error('disk full'))
    renderArchive()
    await screen.findByText('Wrong clock')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 sessions' }))

    // Only the server's session is reported deleted.
    expect(await screen.findByText('Deleted 1 archived session.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/only on this device/)
    expect(screen.getByText('Wrong clock')).toBeInTheDocument()
    expect(screen.queryByText('Server archived')).not.toBeInTheDocument()
    // Focus returns in an effect once the busy state ends, which may follow the messages.
    const deleteAll = screen.getByRole('button', { name: 'Delete all archived sessions' })
    await waitFor(() => expect(deleteAll).toHaveFocus())
    expect((await store.get(record.id))?.archivedAt).not.toBeNull()
  })

  it('lists server and device-only rows in one list, newest archived first', async () => {
    store.close()
    let clock = Date.UTC(2026, 9, 24, 12)
    store = new IndexedDbSessionStore({ name: freshDbName(), now: () => clock })
    const newer = await rejectedSession('Device newer')
    await store.archiveOnDevice('me', newer.id)
    clock = Date.UTC(2026, 9, 22, 12)
    const older = makeRecord({ startedAt: '2026-10-21T11:00:00Z', goal: 'Device older' })
    await store.save(older, 'me')
    await store.markRejected(older.id, null)
    await store.archiveOnDevice('me', older.id)
    const onServer = makeRecord({ goal: 'Server archived' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([onServer])
    server.archive(onServer.id) // archived 2026-10-23, between the two

    renderArchive()
    await screen.findByText('Server archived')
    await screen.findByText('Device older')
    const goals = screen
      .getAllByRole('listitem')
      .map((item) => /Device newer|Server archived|Device older/.exec(item.textContent ?? '')?.[0])
    expect(goals).toEqual(['Device newer', 'Server archived', 'Device older'])
  })

  it('is still shown, and restorable, when the server’s list cannot be loaded', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    server.mode = 'offline'
    renderArchive()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t load archived sessions/)
    expect(await screen.findByText('Only on this device')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^Restore/ }))
    await waitFor(async () => expect((await store.get(record.id))?.archivedAt).toBeNull())
  })
})

describe('sign-out count', () => {
  it('still counts a device-only archived session until it is deleted', async () => {
    const record = await rejectedSession()
    await store.archiveOnDevice('me', record.id)
    expect(await store.countUnsynced('me')).toEqual({ sessions: 1, edits: 0 })
    await store.removeArchived('me')
    expect(await store.countUnsynced('me')).toEqual({ sessions: 0, edits: 0 })
  })
})
