// An open History keeps up with the sync engine (#264, AC10.9): the "not saved" note and the
// "Not synced yet" badge follow what the device really holds, with no reload.

import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpSessionsApi } from '../sync/api.ts'
import type { ApiResult } from '../sync/api.ts'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { SyncEngine } from '../sync/syncEngine.ts'
import { FakeSessionsServer, freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

class CountingHistory implements HistoryApi {
  gets = 0
  readonly #server: FakeSessionsServer
  constructor(server: FakeSessionsServer) {
    this.#server = server
  }

  async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    this.gets += 1
    const base = emptyData(query.view, 'UTC', 1, periodFor('day', query.date ?? '', 1))
    const sessions: HistorySession[] = []
    for (const stored of this.#server.sessions.values()) {
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
let history: CountingHistory
let store: IndexedDbSessionStore
let engine: SyncEngine

beforeEach(() => {
  server = new FakeSessionsServer()
  history = new CountingHistory(server)
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
    />,
  )
}

describe('a sync finishing while History is open', () => {
  it('drops the "not saved" note and the badge without a reload or remount', async () => {
    await store.save(makeRecord({ startedAt: '2026-10-21T10:00:00Z', goal: 'Parked' }), 'me')
    renderHistory()
    expect(
      await screen.findByText(/Includes 1 session not saved to your account yet/),
    ).toBeInTheDocument()
    expect(screen.getByText('Not synced yet')).toBeInTheDocument()
    const heading = screen.getByRole('heading', { level: 1 })
    const getsBefore = history.gets

    await act(async () => {
      await engine.syncNow()
    })

    await waitFor(() =>
      expect(screen.queryByText(/not saved to your account yet/)).not.toBeInTheDocument(),
    )
    expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument()
    expect(await screen.findByText('Parked')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading) // not remounted
    expect(history.gets).toBe(getsBefore + 1) // one History reload for the pass
  })

  it('counts down while the refused session stays on the device', async () => {
    await store.save(makeRecord({ startedAt: '2026-10-21T10:00:00Z', goal: 'Fine' }), 'me')
    const bad = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Refused' })
    await store.save(bad, 'me')
    renderHistory()
    await screen.findByText(/Includes 2 sessions not saved/)
    vi.spyOn(HttpSessionsApi.prototype, 'sync').mockImplementation(async (records) => ({
      kind: 'ok',
      value: records.map((record, index) =>
        record.id === bad.id
          ? { index, id: record.id, status: 'rejected' as const, error: null, session: null }
          : {
              index,
              id: record.id,
              status: 'created' as const,
              error: null,
              session: { id: record.id, tag: 'work' as const, goal: 'Fine', archivedAt: null },
            },
      ),
    }))
    await act(async () => {
      await engine.syncNow()
    })
    expect(await screen.findByText(/Includes 1 session not saved/)).toBeInTheDocument()
  })

  it('does not reload History when the pass changed nothing', async () => {
    renderHistory()
    await screen.findByText('No sessions in this period.')
    const getsBefore = history.gets
    await act(async () => {
      await engine.syncNow()
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(history.gets).toBe(getsBefore)
  })

  it('stops listening once History is closed', async () => {
    await store.save(makeRecord({ startedAt: '2026-10-21T10:00:00Z' }), 'me')
    const unsubscribe = vi.fn()
    const original = engine.onChange.bind(engine)
    vi.spyOn(engine, 'onChange').mockImplementation((listener) => {
      const stop = original(listener)
      return () => {
        unsubscribe()
        stop()
      }
    })
    const view = renderHistory()
    await screen.findByText(/not saved to your account yet/)
    expect(unsubscribe).not.toHaveBeenCalled()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
