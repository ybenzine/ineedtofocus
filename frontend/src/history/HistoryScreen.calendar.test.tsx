// The History download (AC14.6): the button, its hints and the request it makes.

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheUser, forgetCachedUser } from '../auth/localData.ts'
import type { CalendarApi } from '../calendar/api.ts'
import type { ApiResult } from '../sync/api.ts'
import type { HistoryApi, HistoryData, HistoryQuery, HistorySession } from './api.ts'
import HistoryScreen from './HistoryScreen.tsx'
import { emptyData, mergeSessions, periodFor } from './model.ts'

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0)

const session = (overrides: Partial<HistorySession> = {}): HistorySession => ({
  id: 'a',
  mode: 'countdown',
  tag: 'work',
  goal: null,
  startedAt: '2026-10-21T10:00:00Z',
  endedAt: '2026-10-21T10:25:00Z',
  focusSeconds: 1500,
  pausedSeconds: 0,
  status: 'completed',
  blocks: null,
  blocksCompleted: 0,
  indicator: 'synced',
  ...overrides,
})

function historyApi(sessions: HistorySession[]): HistoryApi {
  return {
    async get(query: HistoryQuery): Promise<ApiResult<HistoryData>> {
      const period =
        query.view === 'all'
          ? null
          : query.view === 'custom'
            ? { start: query.start ?? '', end: query.end ?? '' }
            : periodFor(query.view, query.date ?? '', 1)
      return {
        kind: 'ok',
        value: mergeSessions(emptyData(query.view, 'UTC', 1, period), sessions, []),
      }
    },
  }
}

function calendar() {
  const exportIcs = vi.fn(async (): Promise<never> => {
    return {
      kind: 'ok',
      value: { text: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'f.ics' },
    } as never
  })
  return { exportIcs } as unknown as Pick<CalendarApi, 'exportIcs'> & {
    exportIcs: typeof exportIcs
  }
}

function renderScreen(sessions: HistorySession[], api = calendar()) {
  render(
    <HistoryScreen
      api={historyApi(sessions)}
      calendarApi={api}
      timeZone="UTC"
      now={() => NOW}
      ownerId="me"
      sessions={null}
    />,
  )
  return api
}

function stubDownload() {
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }),
  )
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const button = () => screen.findByRole('button', { name: 'Add to calendar (.ics)' })

describe('Add to calendar (.ics) on History', () => {
  it('asks for the view on screen, then the next view and the tag filter', async () => {
    const api = renderScreen([session()])
    const click = stubDownload()
    fireEvent.click(await button())
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(api.exportIcs).toHaveBeenLastCalledWith({
      view: 'day',
      tz: 'UTC',
      tags: [],
      date: '2026-10-21',
    })

    fireEvent.click(screen.getByRole('button', { name: 'Week' }))
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    fireEvent.click(await button())
    await waitFor(() => expect(api.exportIcs).toHaveBeenCalledTimes(2))
    expect(api.exportIcs).toHaveBeenLastCalledWith({
      view: 'week',
      tz: 'UTC',
      tags: ['work'],
      date: '2026-10-21',
    })

    fireEvent.click(screen.getByRole('button', { name: 'All time' }))
    fireEvent.click(await button())
    await waitFor(() => expect(api.exportIcs).toHaveBeenCalledTimes(3))
    expect(api.exportIcs).toHaveBeenLastCalledWith(expect.objectContaining({ view: 'all' }))
  })

  it('saves the file the server named', async () => {
    renderScreen([session()])
    const names: string[] = []
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() }),
    )
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download)
    })
    fireEvent.click(await button())
    await waitFor(() => expect(names).toEqual(['f.ics']))
  })

  it('explains where the file opens', async () => {
    renderScreen([session()])
    await button()
    expect(
      screen.getByText(
        'Apple Calendar opens this file. In Google Calendar, import it at calendar.google.com → Settings → Import.',
        { exact: false },
      ),
    ).toBeVisible()
    expect(screen.queryByText(/Sessions not synced yet/)).not.toBeInTheDocument()
  })

  it('adds that sessions not synced yet are left out when the view has some', async () => {
    renderScreen([session({ unsaved: true, indicator: 'not-synced-yet' })])
    await button()
    expect(screen.getByText(/Sessions not synced yet aren’t included\./)).toBeVisible()
  })

  it('is disabled offline, with a hint', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const api = renderScreen([session()])
    const download = await button()
    expect(download).toBeDisabled()
    expect(download).toHaveAccessibleDescription(/Needs a connection\./)
    fireEvent.click(download)
    expect(api.exportIcs).not.toHaveBeenCalled()
  })

  it('shows an error when the file can’t be made', async () => {
    const api = calendar()
    api.exportIcs.mockResolvedValueOnce({ kind: 'unavailable' } as never)
    renderScreen([session()], api)
    fireEvent.click(await button())
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t make the calendar file')
  })
})

describe('the per-row Add to calendar on iOS (#454)', () => {
  const iosChoice = async (rows: HistorySession[]) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)',
    )
    cacheUser({ id: 'me', email: 'a@b.co', created_at: '2026-01-01T00:00:00Z' })
    renderScreen(rows)
    fireEvent.click(await screen.findByRole('button', { name: /^Add to calendar: / }))
  }

  afterEach(() => forgetCachedUser())

  it('is disabled with "Not synced yet" for a session not on the server', async () => {
    await iosChoice([session({ unsaved: true, indicator: 'not-synced-yet' })])
    expect(
      screen.getByRole('button', { name: 'Apple Calendar / other (.ics)' }),
    ).toHaveAccessibleDescription('Not synced yet')
  })

  it('is a link to the server copy for a synced session', async () => {
    await iosChoice([session()])
    expect(screen.getByRole('link', { name: 'Apple Calendar / other (.ics)' })).toHaveAttribute(
      'href',
      '/api/calendar/session/a.ics?tz=UTC',
    )
  })
})
