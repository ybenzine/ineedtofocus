import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbSessionStore } from '../sync/sessionStore.ts'
import { freshDbName, makeRecord } from '../test/fakeSessionsServer.ts'
import type { ApiResult } from '../sync/api.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0) // Wed 21 Oct 2026

const synced = (overrides: Partial<HistorySession> = {}): HistorySession => ({
  id: crypto.randomUUID(),
  mode: 'pomodoro',
  tag: 'study',
  goal: 'Chapter 4',
  startedAt: '2026-10-21T08:30:00Z',
  focusSeconds: 3600,
  status: 'ended_early',
  indicator: 'synced',
  ...overrides,
})

class FakeApi implements HistoryApi {
  queries: HistoryQuery[] = []
  offline = false
  sessions: HistorySession[] = []

  async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
    this.queries.push(query)
    if (this.offline) return { kind: 'unavailable' }
    const period =
      query.view === 'all'
        ? null
        : query.view === 'custom'
          ? { start: query.start ?? '', end: query.end ?? '' }
          : periodFor(query.view, query.date ?? '', 1)
    const base = emptyData(query.view, 'UTC', 1, period)
    const wanted = this.sessions.filter(
      (s) => query.tags.length === 0 || query.tags.includes(s.tag),
    )
    return { kind: 'ok', value: mergeSessions({ ...base }, wanted, []) }
  }
}

function renderScreen(api: FakeApi, props: Partial<Parameters<typeof HistoryScreen>[0]> = {}) {
  return render(
    <HistoryScreen
      api={api}
      timeZone="UTC"
      now={() => NOW}
      ownerId="me"
      sessions={null}
      {...props}
    />,
  )
}

afterEach(() => vi.restoreAllMocks())

describe('HistoryScreen', () => {
  it('ac10_5 asks for the Day view in the given time zone, with today as the date', async () => {
    const api = new FakeApi()
    renderScreen(api)
    await screen.findByText('No sessions in this period.')
    expect(api.queries[0]).toMatchObject({ view: 'day', tz: 'UTC', date: '2026-10-21', tags: [] })
  })

  it('ac10_3 ac10_4 shows totals, tag breakdown and rows, with no chart in the Day view', async () => {
    const api = new FakeApi()
    api.sessions = [
      synced(),
      synced({
        id: 'later',
        tag: 'work',
        goal: null,
        focusSeconds: 1500,
        mode: 'countdown',
        status: 'completed',
        startedAt: '2026-10-21T10:00:00Z',
      }),
    ]
    renderScreen(api)
    await screen.findByText('Focus time')
    expect(screen.getByText('1 h 25 min')).toBeInTheDocument() // 3600 + 1500 s total
    expect(screen.getByText('2')).toBeInTheDocument()
    const rows = screen.getAllByRole('listitem').filter((li) => li.className === 'history-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Countdown')).toBeInTheDocument() // newest first
    expect(within(rows[0]).getByText('Completed')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Pomodoro')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Ended early')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Chapter 4')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'By tag' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /Focus time by/ })).not.toBeInTheDocument()
  })

  it('ac10_3 draws one bar per day for a week and one per month for All time', async () => {
    const api = new FakeApi()
    api.sessions = [synced()]
    renderScreen(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Week' }))
    await screen.findByRole('heading', { name: 'Focus time by day' })
    expect(document.querySelectorAll('.history-chart li')).toHaveLength(7)
    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    await screen.findByRole('heading', { name: 'Focus time by month' })
    expect(document.querySelectorAll('.history-chart li')).toHaveLength(1)
    expect(api.queries.at(-1)).toMatchObject({ view: 'all' })
  })

  it('ac10_1 steps to the previous period and stops Next at the current one', async () => {
    const api = new FakeApi()
    renderScreen(api)
    await screen.findByText('No sessions in this period.')
    expect(screen.getByRole('button', { name: 'Next day' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Previous day' }))
    await waitFor(() => expect(api.queries.at(-1)?.date).toBe('2026-10-20'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next day' })).toBeEnabled())
  })

  it('draws month bars for a custom range of 63 days or more', async () => {
    const api = new FakeApi()
    api.sessions = [synced({ startedAt: '2026-08-10T08:00:00Z' })]
    renderScreen(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Custom' }))
    expect(screen.queryByText('All time', { selector: 'p' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-07-01' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await screen.findByRole('heading', { name: 'Focus time by month' })
    expect(document.querySelectorAll('.history-chart li')).toHaveLength(3)
  })

  it('ac10_1 refuses a custom range that ends before it starts', async () => {
    const api = new FakeApi()
    renderScreen(api)
    fireEvent.click(await screen.findByRole('button', { name: 'Custom' }))
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-10' } })
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-05' } })
    const before = api.queries.length
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/end date can't be before the start/i)
    expect(api.queries).toHaveLength(before)

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-12' } })
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() =>
      expect(api.queries.at(-1)).toMatchObject({
        view: 'custom',
        start: '2026-10-10',
        end: '2026-10-12',
      }),
    )
  })

  it('ac10_2 filters by any of the selected tags', async () => {
    const api = new FakeApi()
    api.sessions = [synced(), synced({ tag: 'work' }), synced({ tag: 'nap' })]
    renderScreen(api)
    await screen.findByText('Focus time')
    fireEvent.click(screen.getByRole('button', { name: 'study' }))
    fireEvent.click(screen.getByRole('button', { name: 'work' }))
    await waitFor(() => expect(api.queries.at(-1)?.tags).toEqual(['study', 'work']))
    await waitFor(() => expect(screen.getAllByText('study').length).toBeGreaterThan(0))
    expect(document.querySelectorAll('.history-row')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'All tags' }))
    await waitFor(() => expect(api.queries.at(-1)?.tags).toEqual([]))
  })

  it('ac10_8 shows an empty state', async () => {
    const onNewSession = vi.fn()
    renderScreen(new FakeApi(), { onNewSession })
    expect(await screen.findByText('No sessions in this period.')).toBeInTheDocument()
    expect(screen.queryByText('Focus time')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Start a session' }))
    expect(onNewSession).toHaveBeenCalled()
  })

  describe('sessions on the device (AC10.9)', () => {
    async function deviceStore() {
      const store = new IndexedDbSessionStore({ name: freshDbName() })
      return store
    }

    it('adds unsynced sessions to the list and totals with their indicators', async () => {
      const store = await deviceStore()
      const base = { startedAt: '2026-10-21T09:00:00Z', focusSeconds: 600 }
      const pending = makeRecord({ ...base, goal: 'Not yet' })
      const rejected = makeRecord({ ...base, startedAt: '2026-10-21T07:00:00Z' })
      const others = makeRecord(base)
      await store.save(pending, 'me')
      await store.save(rejected, 'me')
      await store.markRejected(rejected.id, null)
      await store.save(others, 'someone-else')
      const api = new FakeApi()
      api.sessions = [synced({ startedAt: '2026-10-21T08:00:00Z', focusSeconds: 3600 })]
      renderScreen(api, { sessions: store })

      expect(await screen.findByText('Not synced yet')).toBeInTheDocument()
      expect(screen.getByText('Couldn’t sync')).toBeInTheDocument()
      expect(screen.getByText('Not yet')).toBeInTheDocument()
      expect(screen.getByText('3')).toBeInTheDocument() // 1 synced + 2 of mine, not the other owner's
      expect(screen.getByText('1 h 20 min')).toBeInTheDocument()
      expect(
        screen.getByText(/Includes 2 sessions not saved to your account yet/),
      ).toBeInTheDocument()
      store.close()
    })

    it('leaves out an archived session even when it has a queued edit', async () => {
      const store = await deviceStore()
      const r = makeRecord({ startedAt: '2026-10-21T09:00:00Z' })
      await store.save(r, 'me')
      await store.markSynced(r.id, {
        id: r.id,
        tag: 'work',
        goal: null,
        archivedAt: '2026-10-21T11:00:00Z',
      })
      await store.edit('me', r.id, { tag: 'read' })
      renderScreen(new FakeApi(), { sessions: store })
      await screen.findByText('No sessions in this period.')
      store.close()
    })

    it('does not count a synced session with a pending edit as not saved', async () => {
      const store = await deviceStore()
      const r = makeRecord({ startedAt: '2026-10-21T09:00:00Z' })
      await store.save(r, 'me')
      await store.markSynced(r.id, { id: r.id, tag: 'work', goal: null, archivedAt: null })
      await store.edit('me', r.id, { tag: 'read' })
      const api = new FakeApi()
      api.sessions = [synced({ id: r.id, tag: 'work' })]
      renderScreen(api, { sessions: store })
      await screen.findByText('Focus time')
      expect(screen.queryByText(/not saved to your account/)).not.toBeInTheDocument()
      // The server decides what a tag filter shows; the edited session isn't added under 'read'.
      fireEvent.click(screen.getByRole('button', { name: 'read' }))
      await screen.findByText('No sessions with these tags in this period.')
      store.close()
    })

    it('offline with an earlier answer keeps sessions that synced after it', async () => {
      const store = await deviceStore()
      const api = new FakeApi()
      api.sessions = [synced({ goal: 'From the server' })]
      renderScreen(api, { sessions: store })
      await screen.findByText('From the server')
      const later = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Synced later' })
      await store.save(later, 'me')
      await store.markSynced(later.id, null)
      const gone = makeRecord({ startedAt: '2026-10-21T09:30:00Z', goal: 'Archived one' })
      await store.save(gone, 'me')
      await store.markSynced(gone.id, {
        id: gone.id,
        tag: 'work',
        goal: null,
        archivedAt: '2026-10-21T10:00:00Z',
      })
      api.offline = true
      window.dispatchEvent(new Event('online'))
      expect(await screen.findByText('Synced later')).toBeInTheDocument()
      expect(screen.getByText('From the server')).toBeInTheDocument()
      expect(screen.queryByText('Archived one')).not.toBeInTheDocument()
      expect(screen.getByText(/You’re offline/)).toBeInTheDocument()
      store.close()
    })

    it('shows no device sessions when nobody is known to be signed in', async () => {
      const store = await deviceStore()
      await store.save(makeRecord({ startedAt: '2026-10-21T09:00:00Z' }), 'me')
      const api = new FakeApi()
      renderScreen(api, { sessions: store, ownerId: null })
      await screen.findByText('No sessions in this period.')
      store.close()
    })

    it('offline: shows the device sessions with an offline note instead of failing', async () => {
      const store = await deviceStore()
      const r = makeRecord({ startedAt: '2026-10-21T09:00:00Z', goal: 'Saved here' })
      await store.save(r, 'me')
      await store.markSynced(r.id, null)
      const api = new FakeApi()
      api.offline = true
      renderScreen(api, { sessions: store })
      expect(await screen.findByText('Saved here')).toBeInTheDocument()
      expect(screen.getByText(/You’re offline/)).toBeInTheDocument()
      expect(screen.queryByText('Not synced yet')).not.toBeInTheDocument()
      store.close()
    })

    it('offline with nothing on the device shows the offline note and the empty state', async () => {
      const api = new FakeApi()
      api.offline = true
      renderScreen(api)
      expect(await screen.findByText(/You’re offline/)).toBeInTheDocument()
      expect(screen.getByText('No sessions in this period.')).toBeInTheDocument()
    })
  })
})
