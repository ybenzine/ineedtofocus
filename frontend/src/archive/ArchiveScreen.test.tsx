import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpSessionsApi } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import { HttpArchiveApi } from './api.ts'
import ArchiveScreen from './ArchiveScreen.tsx'

let server: FakeSessionsServer
let store: IndexedDbSessionStore

beforeEach(() => {
  server = new FakeSessionsServer()
  store = new IndexedDbSessionStore({ name: freshDbName() })
})

afterEach(() => {
  store.close()
  vi.restoreAllMocks()
})

async function archived(goal: string, offsetMinutes = 0) {
  const record = makeRecord({
    goal,
    startedAt: new Date(Date.UTC(2026, 9, 20, 9, offsetMinutes)).toISOString(),
  })
  await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
  await store.save(record, 'me')
  await store.markSynced(record.id, { id: record.id, tag: 'work', goal, archivedAt: null })
  server.archive(record.id)
  await store.setArchived('me', record.id, '2026-10-23T12:00:00Z')
  return record
}

function renderScreen() {
  return render(
    <ArchiveScreen
      api={new HttpArchiveApi({ fetch: server.fetch })}
      sessions={store}
      ownerId="me"
      timeZone="UTC"
    />,
  )
}

describe('ArchiveScreen', () => {
  it('ac11_3 lists the archived sessions, read-only', async () => {
    await archived('First')
    await archived('Second', 5)
    renderScreen()
    expect(await screen.findByText('First')).toBeInTheDocument()
    expect(screen.getByText('Second')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Archive' })).toBeInTheDocument()
    // AC11.4: the only actions are Restore and Delete all.
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Restore/ })).toHaveLength(2)
  })

  it('shows an empty state', async () => {
    renderScreen()
    expect(await screen.findByText('No archived sessions.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Delete all/ })).not.toBeInTheDocument()
  })

  it('shows an error with a retry when the list cannot be loaded', async () => {
    await archived('Later')
    server.mode = 'offline'
    renderScreen()
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t load archived sessions/)
    server.mode = 'up'
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Later')).toBeInTheDocument()
  })

  it('ac11_5 restores a session, on the server and on the device', async () => {
    const record = await archived('Bring back')
    await store.setArchived('me', record.id, '2026-10-20T10:00:00Z')
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    expect(await screen.findByText('Session restored to History.')).toBeInTheDocument()
    expect(screen.queryByText('Bring back')).not.toBeInTheDocument()
    expect(server.sessions.get(record.id)?.archivedAt).toBeNull()
    expect((await store.get(record.id))?.archivedAt).toBeNull()
    expect(server.get(record.id)).toMatchObject({ goal: 'Bring back' })
  })

  it('keeps the session when the restore fails', async () => {
    await archived('Stuck')
    renderScreen()
    const button = await screen.findByRole('button', { name: /^Restore/ })
    server.mode = 'down'
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t restore the session/)
    expect(screen.getByText('Stuck')).toBeInTheDocument()
  })

  it('ac11_6 asks first, stating the count, and Cancel deletes nothing', async () => {
    await archived('A')
    await archived('B', 1)
    await archived('C', 2)
    renderScreen()
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent(
      'Permanently delete 3 archived sessions? This can’t be undone.',
    )
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(server.requests.filter((r) => r.startsWith('DELETE'))).toHaveLength(0)
    expect(server.sessions.size).toBe(3)
  })

  it('ac11_6 deletes every archived session after confirming and reports the count', async () => {
    const record = await archived('A')
    await archived('B', 1)
    await syncedLive()
    renderScreen()
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 sessions' }))
    expect(await screen.findByText('Deleted 2 archived sessions.')).toBeInTheDocument()
    expect(screen.getByText('No archived sessions.')).toBeInTheDocument()
    expect(server.sessions.size).toBe(1) // the live session is untouched (AC11.7)
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
  })

  it('#133 loading marks a session archived on another device as archived on the device', async () => {
    const record = makeRecord({ goal: 'Elsewhere' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
    await store.save(record, 'me')
    await store.markSynced(record.id, {
      id: record.id,
      tag: 'work',
      goal: 'Elsewhere',
      archivedAt: null,
    })
    server.archive(record.id)
    renderScreen()
    await screen.findByText('Elsewhere')
    await waitFor(async () => expect((await store.get(record.id))?.archivedAt).not.toBeNull())
  })

  it('#133 delete all also removes device copies of sessions archived on other devices', async () => {
    const record = makeRecord({ goal: 'Elsewhere' })
    await new HttpSessionsApi({ fetch: server.fetch }).sync([record])
    await store.save(record, 'me')
    await store.markSynced(record.id, {
      id: record.id,
      tag: 'work',
      goal: 'Elsewhere',
      archivedAt: null,
    })
    server.archive(record.id)
    // The load is slow to mark it (or failed to): delete-all still takes it, as it was listed.
    vi.spyOn(store, 'setArchived').mockResolvedValue(undefined)
    renderScreen()
    await screen.findByText('Elsewhere')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    await screen.findByText('Deleted 1 archived session.')
    await waitFor(async () => expect(await store.get(record.id)).toBeUndefined())
  })

  it('says so if the delete does not go through, and deletes nothing locally', async () => {
    const record = await archived('A')
    await store.setArchived('me', record.id, '2026-10-20T10:00:00Z')
    renderScreen()
    await screen.findByText('A')
    fireEvent.click(screen.getByRole('button', { name: 'Delete all archived sessions' }))
    server.mode = 'offline'
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 session' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t delete the archived sessions/,
    )
    expect(screen.getByText('A')).toBeInTheDocument()
    expect(await store.get(record.id)).toBeDefined()
  })

  it('Escape closes the confirmation and returns focus to Delete all', async () => {
    await archived('A')
    renderScreen()
    await screen.findByText('A')
    const button = screen.getByRole('button', { name: 'Delete all archived sessions' })
    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('moves focus to the heading after a restore', async () => {
    await archived('A')
    renderScreen()
    fireEvent.click(await screen.findByRole('button', { name: /^Restore/ }))
    await screen.findByText('Session restored to History.')
    expect(screen.getByRole('heading', { name: 'Archive' })).toHaveFocus()
  })

  async function syncedLive() {
    await new HttpSessionsApi({ fetch: server.fetch }).sync([makeRecord()])
  }
})
