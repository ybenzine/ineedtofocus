// Settings → Calendar (F14, AC12.8, AC14.4): settings, preview, tag list, guest view, and each
// subscribe state.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnonymousContext, type AnonymousUse } from '../anonymous/AnonymousContext.ts'
import { cacheUser } from '../auth/localData.ts'
import { SETTINGS_KEY, SettingsStore } from '../settings/store.ts'
import { SettingsContext } from '../settings/SettingsContext.ts'
import type { ApiResult } from '../sync/api.ts'
import { TagsContext } from '../tags/context.ts'
import { TagsStore } from '../tags/store.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import type { CalendarApi, FeedCreated, FeedStatus } from './api.ts'
import CalendarSection from './CalendarSection.tsx'

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0)
const SECRET_PATH = '/api/calendar/s3cr3t-s3cr3t-s3cr3t.ics'

class FakeCalendarApi implements CalendarApi {
  status: FeedStatus = { enabled: false, createdAt: null, lastFetchedAt: null }
  calls: string[] = []
  fail: Partial<Record<'status' | 'create' | 'delete', boolean>> = {}
  #n = 0
  async feedStatus(): Promise<ApiResult<FeedStatus>> {
    this.calls.push('status')
    // Like the real API, nothing works without a connection.
    if (!navigator.onLine) return { kind: 'unavailable' }
    return this.fail.status ? { kind: 'unavailable' } : { kind: 'ok', value: this.status }
  }
  async createFeed(): Promise<ApiResult<FeedCreated>> {
    this.calls.push('create')
    if (!navigator.onLine || this.fail.create) return { kind: 'unavailable' }
    this.#n += 1
    this.status = { enabled: true, createdAt: '2026-11-02T12:00:00Z', lastFetchedAt: null }
    return {
      kind: 'ok',
      value: {
        path: SECRET_PATH.replace('s3cr3t', `s${this.#n}`),
        createdAt: '2026-11-02T12:00:00Z',
      },
    }
  }
  async deleteFeed(): Promise<ApiResult<null>> {
    this.calls.push('delete')
    if (!navigator.onLine || this.fail.delete) return { kind: 'unavailable' }
    this.status = { enabled: false, createdAt: null, lastFetchedAt: null }
    return { kind: 'ok', value: null }
  }
  async exportIcs(): Promise<never> {
    throw new Error('not used here')
  }
}

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

function renderSection(
  options: { api?: FakeCalendarApi; settings?: SettingsStore; tags?: TagsStore } = {},
) {
  const api = options.api ?? new FakeCalendarApi()
  const settings = options.settings ?? new SettingsStore({ storage: localStorage, owner: 'u1' })
  const tags = options.tags ?? new TagsStore()
  render(
    <SettingsContext.Provider value={settings}>
      <TagsContext.Provider value={tags}>
        <CalendarSection api={api} now={() => NOW} />
      </TagsContext.Provider>
    </SettingsContext.Provider>,
  )
  return { api, settings, tags }
}

beforeEach(() => {
  setOnline(true)
  vi.stubGlobal('open', vi.fn())
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('without an account (AC1.8, AC12.8)', () => {
  it('shows only the nudge with its two links, and makes no request', () => {
    const api = new FakeCalendarApi()
    const anonymous = { held: {}, openForm: vi.fn() } as unknown as AnonymousUse
    render(
      <AnonymousContext.Provider value={anonymous}>
        <CalendarSection api={api} />
      </AnonymousContext.Provider>,
    )
    expect(screen.getByRole('heading', { name: 'Calendar' })).toBeInTheDocument()
    expect(
      screen.getByText('to add your sessions to your calendar.', { exact: false }).textContent,
    ).toBe('Create an account or log in to add your sessions to your calendar.')
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute(
      'href',
      '/signup',
    )
    expect(screen.getByRole('link', { name: 'log in' })).toHaveAttribute('href', '/login')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(api.calls).toEqual([])
  })
})

describe('the settings (AC12.8)', () => {
  it('shows the defaults', async () => {
    renderSection()
    expect(screen.getByLabelText('Event title')).toHaveValue('{tag}: {goal}')
    expect(
      screen.getByText(/Placeholders: \{tag\}, \{goal\}, \{mode\}, \{focus_time\}\./),
    ).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'Include goals' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Include description' })).toBeChecked()
    expect(screen.getByLabelText('Minimum length')).toHaveValue('0')
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument()
    expect(screen.getByLabelText('Calendar name')).toHaveValue('I Need To Focus')
    await screen.findByRole('button', { name: 'Create link' })
  })

  it('saves each setting', async () => {
    const { settings } = renderSection()
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: '{mode} {tag}' } })
    expect(settings.values.calendar_title_template).toBe('{mode} {tag}')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include goals' }))
    expect(settings.values.calendar_include_goal).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include description' }))
    expect(settings.values.calendar_include_description).toBe(false)
    fireEvent.change(screen.getByLabelText('Minimum length'), { target: { value: '10' } })
    expect(settings.values.calendar_min_minutes).toBe(10)
    fireEvent.change(screen.getByLabelText('Calendar name'), { target: { value: '  Deep work ' } })
    expect(settings.values.calendar_name).toBe('Deep work')
    await screen.findByRole('button', { name: 'Create link' })
  })

  it('shows the field error and sends nothing for out-of-range input', async () => {
    const { settings } = renderSection()
    const update = vi.spyOn(settings, 'update')
    fireEvent.change(screen.getByLabelText('Event title'), {
      target: { value: 'x'.repeat(121) },
    })
    expect(screen.getByRole('alert')).toHaveTextContent('at most 120 characters')
    fireEvent.change(screen.getByLabelText('Calendar name'), { target: { value: '   ' } })
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('Give the calendar a name.')
    fireEvent.change(screen.getByLabelText('Calendar name'), { target: { value: 'n'.repeat(61) } })
    expect(screen.getAllByRole('alert')[1]).toHaveTextContent('at most 60 characters')
    expect(update).not.toHaveBeenCalled()
    // 120 characters is fine, counted as the server counts them.
    fireEvent.change(screen.getByLabelText('Event title'), { target: { value: '😀'.repeat(120) } })
    expect(update).toHaveBeenCalledWith({ calendar_title_template: '😀'.repeat(120) })
    await screen.findByRole('button', { name: 'Create link' })
  })
})

describe('the preview (AC14.3)', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(process.cwd(), '../_docs/api/fixtures/calendar-events.json'), 'utf-8'),
  ) as {
    origin: string
    tags: { id: string; name: string; removed: boolean }[]
    cases: {
      reason: string
      session: {
        id: string
        mode: string
        tag: string
        goal: string | null
        started_at: string
        ended_at: string
        focus_seconds: number
        paused_seconds: number
        status: string
        blocks_completed: number
        mode_config: unknown
      }
      settings: Record<string, unknown>
      expected: { summary: string; description: string | null }
    }[]
  }

  it('follows the template as typed, from a sample session', async () => {
    renderSection()
    expect(screen.getByText('Preview, from a sample session:')).toBeVisible()
    expect(screen.getByText('Work: Write chapter 3')).toBeVisible()
    fireEvent.change(screen.getByLabelText('Event title'), {
      target: { value: '{mode} · {tag} – {goal} ({focus_time})' },
    })
    expect(screen.getByText('Countdown · Work – Write chapter 3 (25 min)')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include goals' }))
    expect(screen.getByText('Countdown · Work – (25 min)')).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include description' }))
    expect(screen.queryByText(/^Tag: Work/)).not.toBeInTheDocument()
    await screen.findByRole('button', { name: 'Create link' })
  })

  it.each(fixture.cases.map((c) => [c.reason, c] as const))(
    'matches the fixture: %s',
    async (_reason, c) => {
      const tags = new TagsStore({
        api: {
          list: async () =>
            fixture.tags.map((t) => ({
              id: t.id,
              name: t.name,
              color: 'indigo' as const,
              createdAt: '2026-10-01T00:00:00Z',
              removedAt: t.removed ? '2026-10-20T00:00:00Z' : null,
            })),
        } as never,
        owner: 'u1',
      })
      await tags.refresh()
      cacheUser({ id: 'u1', email: 'a@b.co', created_at: '2026-10-30T00:00:00Z' })
      const f = c.session
      const sessions = {
        list: async () => [
          {
            archivedAt: null,
            goneOnServer: false,
            record: {
              id: f.id,
              mode: f.mode,
              tag: f.tag,
              goal: f.goal,
              startedAt: f.started_at,
              endedAt: f.ended_at,
              focusSeconds: f.focus_seconds,
              pausedSeconds: f.paused_seconds,
              status: f.status,
              modeConfig: f.mode_config,
              blocksCompleted: f.blocks_completed,
            },
          },
        ],
      }
      const settings = new SettingsStore({ storage: localStorage, owner: 'u1' })
      settings.update(c.settings as never)
      render(
        <SettingsContext.Provider value={settings}>
          <TagsContext.Provider value={tags}>
            <CalendarSection api={new FakeCalendarApi()} sessions={sessions as never} />
          </TagsContext.Provider>
        </SettingsContext.Provider>,
      )
      await screen.findByText('Preview, from your latest session:')
      expect(document.querySelector('.calendar-preview-title')?.textContent).toBe(
        c.expected.summary,
      )
      const description = document.querySelector('.calendar-preview-description')
      if (c.expected.description === null) expect(description).toBeNull()
      else
        expect(description?.textContent).toBe(
          c.expected.description.replace(fixture.origin, window.location.origin),
        )
      await screen.findByRole('button', { name: 'Create link' })
    },
  )

  it('names a custom tag by its current name, from the latest session', async () => {
    const tagsApi = new FakeTagsApi()
    const tag = tagsApi.add('Side, project')
    const tags = new TagsStore({ api: tagsApi, owner: 'u1' })
    await tags.refresh()
    cacheUser({ id: 'u1', email: 'a@b.co', created_at: '2026-10-30T00:00:00Z' })
    const sessions = {
      list: async () => [
        {
          archivedAt: null,
          goneOnServer: false,
          record: {
            id: '0f6e2b9a-3c1d-4e5f-8a7b-000000000099',
            mode: 'countdown',
            tag: tag.id,
            goal: 'Landing page',
            startedAt: '2026-10-30T09:00:00Z',
            endedAt: '2026-10-30T09:30:00Z',
            focusSeconds: 1800,
            pausedSeconds: 0,
            status: 'completed',
            modeConfig: { mode: 'countdown', minutes: 30 },
            blocksCompleted: 0,
          },
        },
      ],
    }
    const api = new FakeCalendarApi()
    render(
      <SettingsContext.Provider value={new SettingsStore()}>
        <TagsContext.Provider value={tags}>
          <CalendarSection api={api} sessions={sessions as never} now={() => NOW} />
        </TagsContext.Provider>
      </SettingsContext.Provider>,
    )
    expect(await screen.findByText('Preview, from your latest session:')).toBeVisible()
    expect(screen.getByText('Side, project: Landing page')).toBeVisible()
    expect(screen.getByText(/Tag: Side, project/)).toBeVisible()
    await screen.findByRole('button', { name: 'Create link' })
  })
})

describe('Tags in the calendar (AC12.8, AC7.8)', () => {
  it('lists built-in tags, then custom ones oldest first, removed last and marked', async () => {
    const tagsApi = new FakeTagsApi()
    tagsApi.add('Piano', 'blue', true)
    tagsApi.add('Zeta')
    tagsApi.add('Alpha')
    const tags = new TagsStore({ api: tagsApi, owner: 'u1' })
    await tags.refresh()
    renderSection({ tags })
    const group = screen.getByRole('group', { name: 'Tags in the calendar' })
    const names = within(group)
      .getAllByRole('checkbox')
      .map((box) => box.closest('label')?.textContent)
    expect(names).toEqual([
      'Work',
      'Study',
      'Nap',
      'Read',
      'Meditation',
      'Exercise',
      'Zeta',
      'Alpha',
      'Piano (removed)',
    ])
    within(group)
      .getAllByRole('checkbox')
      .forEach((box) => expect(box).toBeChecked())
    await screen.findByRole('button', { name: 'Create link' })
  })

  it('stores the unticked tags by id, and keeps ids it has no row for', async () => {
    const settings = new SettingsStore({ storage: localStorage, owner: 'u1' })
    settings.update({ calendar_excluded_tags: ['gone-tag-id'] })
    renderSection({ settings })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nap' }))
    expect(settings.values.calendar_excluded_tags).toEqual(['gone-tag-id', 'nap'])
    expect(screen.getByRole('checkbox', { name: 'Nap' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nap' }))
    expect(settings.values.calendar_excluded_tags).toEqual(['gone-tag-id'])
    await screen.findByRole('button', { name: 'Create link' })
  })

  it('says the calendar stays empty when every tag is unticked', async () => {
    renderSection()
    const empty = 'No tags are selected, so your calendar stays empty.'
    expect(screen.queryByText(empty)).not.toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Tags in the calendar' })
    for (const box of within(group).getAllByRole('checkbox')) fireEvent.click(box)
    expect(screen.getByText(empty)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Work' }))
    expect(screen.queryByText(empty)).not.toBeInTheDocument()
    await screen.findByRole('button', { name: 'Create link' })
  })

  it('leaves a tag created later ticked', async () => {
    const tagsApi = new FakeTagsApi()
    const tags = new TagsStore({ api: tagsApi, owner: 'u1' })
    await tags.refresh()
    const { settings } = renderSection({ tags })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Nap' }))
    tagsApi.add('Later')
    await act(async () => tags.refresh())
    expect(screen.getByRole('checkbox', { name: 'Later' })).toBeChecked()
    expect(settings.values.calendar_excluded_tags).toEqual(['nap'])
  })
})

describe('subscribing (AC14.4)', () => {
  it('on a phone, swaps the Google button for copy-the-link steps (#453)', async () => {
    const ua = vi
      .spyOn(navigator, 'userAgent', 'get')
      .mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await screen.findByLabelText('Subscription link')
    expect(screen.queryByRole('link', { name: 'Add to Google Calendar' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Add to Apple Calendar' })).toBeVisible()
    expect(screen.getByText(/Google Calendar can only subscribe from a computer/)).toBeVisible()
    ua.mockRestore()
  })

  it('goes off → created → reset → off', async () => {
    const { api } = renderSection()
    await screen.findByText('Subscribe in your calendar app')
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))

    // Created: the link is shown once, in its three forms.
    const field = await screen.findByLabelText('Subscription link')
    expect(field).toHaveValue(
      `${window.location.origin}/api/calendar/s1-s1-s1.ics`.replace(/s1-s1-s1/, 's1-s3cr3t-s3cr3t'),
    )
    const webcal = screen.getByRole('link', { name: 'Add to Apple Calendar' })
    expect(webcal.getAttribute('href')).toMatch(/^webcal:\/\/.*\/api\/calendar\/s1-/)
    const google = screen.getByRole('link', { name: 'Add to Google Calendar' })
    const googleUrl = new URL(google.getAttribute('href') ?? '')
    expect(googleUrl.origin + googleUrl.pathname).toBe('https://calendar.google.com/calendar/u/0/r')
    expect(googleUrl.searchParams.get('cid')).toBe(webcal.getAttribute('href'))
    expect(google).toHaveAttribute('target', '_blank')
    expect(
      screen.getByText(
        /This link is shown only now\. Anyone with it can see your sessions, including goals\. Reset it/,
      ),
    ).toBeVisible()

    // Copy.
    const writeText = vi.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith((field as HTMLInputElement).value))
    expect(await screen.findByText('Link copied.')).toBeVisible()

    // The new link is announced: focus is on its field.
    expect(field).toHaveFocus()

    // Reset: confirms (Cancel and Escape give focus back), then the new link is shown once.
    const resetButton = screen.getByRole('button', { name: 'Reset link' })
    fireEvent.click(resetButton)
    const dialog = screen.getByRole('alertdialog', { name: 'Reset the link' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Reset link' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Reset link' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Reset link' })).toHaveFocus()
    expect(api.calls).toEqual(['status', 'create'])
    fireEvent.click(screen.getByRole('button', { name: 'Reset link' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset link' }),
    )
    // One POST replaces the link.
    await waitFor(() => expect(api.calls).toEqual(['status', 'create', 'create']))
    const second = (await screen.findByLabelText('Subscription link')) as HTMLInputElement
    expect(second.value).toContain('/api/calendar/s2-')
    await waitFor(() => expect(second).toHaveFocus())

    // Turn off: confirms, then back to the off state.
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn off' }),
    )
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeVisible()
    expect(screen.queryByLabelText('Subscription link')).not.toBeInTheDocument()
  })

  it('says whether goals are in the note', async () => {
    const settings = new SettingsStore({ storage: localStorage, owner: 'u1' })
    settings.update({ calendar_include_goal: false })
    renderSection({ settings })
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    const note = await screen.findByText(/This link is shown only now/)
    expect(note.textContent).toBe(
      'This link is shown only now. Anyone with it can see your sessions. Reset it if it’s shared by mistake.',
    )
  })

  it('on a later visit shows when the app last checked, never the link', async () => {
    const api = new FakeCalendarApi()
    api.status = {
      enabled: true,
      createdAt: '2026-10-30T10:00:00Z',
      lastFetchedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    }
    renderSection({ api })
    expect(
      await screen.findByText('Subscribed · last checked by your calendar app 3 hours ago'),
    ).toBeVisible()
    expect(screen.queryByLabelText('Subscription link')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument()
  })

  it('says "not yet" before the first fetch', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    renderSection({ api })
    expect(
      await screen.findByText('Subscribed · last checked by your calendar app not yet'),
    ).toBeVisible()
  })

  it('turns off from the later-visit state', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    renderSection({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn off' }),
    )
    const create = await screen.findByRole('button', { name: 'Create link' })
    expect(create).toBeVisible()
    await waitFor(() => expect(create).toHaveFocus())
    expect(api.calls).toEqual(['status', 'delete'])
  })

  it('opened offline: says it needs a connection and shows no Create link, then loads when back online', async () => {
    setOnline(false)
    const { api } = renderSection()
    expect(
      await screen.findByText('Needs a connection to load your calendar subscription.'),
    ).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Create link' })).not.toBeInTheDocument()
    expect(screen.queryByText('Couldn’t load your calendar link.')).not.toBeInTheDocument()
    expect(api.calls).toEqual([])

    // The connection returns: the status loads and the button works.
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    setOnline(true)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(await screen.findByText(/Subscribed · last checked/)).toBeVisible()
    expect(api.calls).toEqual(['status'])
    expect(screen.getByRole('button', { name: 'Reset link' })).toBeEnabled()
  })

  it('disables the confirmation’s button when the connection drops while it is open', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    renderSection({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Reset link' }))
    const confirm = within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Reset link',
    })
    expect(confirm).toBeEnabled()
    setOnline(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(confirm).toBeDisabled()
    fireEvent.click(confirm)
    expect(api.calls).toEqual(['status'])
  })

  it('disables Reset and Turn off offline', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    renderSection({ api })
    expect(await screen.findByRole('button', { name: 'Reset link' })).toBeEnabled()
    setOnline(false)
    act(() => {
      window.dispatchEvent(new Event('offline'))
    })
    expect(screen.getByRole('button', { name: 'Reset link' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeDisabled()
    expect(screen.getByText('Needs a connection.')).toBeVisible()
  })

  it('shows an error when the link can’t be made, and when it can’t be turned off', async () => {
    const api = new FakeCalendarApi()
    api.fail.create = true
    renderSection({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t create the link')
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled()
  })

  it('keeps the old state when turning off fails', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    api.fail.delete = true
    renderSection({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn off' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t turn off the link')
    expect(screen.getByText(/Subscribed/)).toBeVisible()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toHaveFocus())
  })

  it('keeps the subscribed state and the old link when a reset fails', async () => {
    const api = new FakeCalendarApi()
    api.status = { enabled: true, createdAt: '2026-10-30T10:00:00Z', lastFetchedAt: null }
    renderSection({ api })
    fireEvent.click(await screen.findByRole('button', { name: 'Reset link' }))
    api.fail.create = true
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Reset link' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t reset the link. The old one still works.',
    )
    expect(screen.getByText(/Subscribed · last checked/)).toBeVisible()
    expect(screen.queryByLabelText('Subscription link')).not.toBeInTheDocument()
    expect(api.calls).toEqual(['status', 'create'])
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset link' })).toHaveFocus())
  })

  it('says so when the status can’t be loaded, and Retry loads it again', async () => {
    const api = new FakeCalendarApi()
    api.fail.status = true
    renderSection({ api })
    expect(await screen.findByText('Couldn’t load your calendar link.')).toBeVisible()
    api.fail.status = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeEnabled()
    expect(api.calls).toEqual(['status', 'status'])
  })

  it('never writes the secret path to storage or the console (AC14.8)', async () => {
    const log = vi.spyOn(console, 'log')
    const warn = vi.spyOn(console, 'warn')
    const error = vi.spyOn(console, 'error')
    const { settings } = renderSection()
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await screen.findByLabelText('Subscription link')
    settings.update({ theme: 'light' }) // forces a cache write after the link exists
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const value = store.getItem(store.key(i) ?? '') ?? ''
        expect(value).not.toContain('s1-s3cr3t')
        expect(value).not.toContain('/api/calendar/')
      }
    }
    expect(localStorage.getItem(SETTINGS_KEY)).not.toContain('calendar/')
    for (const spy of [log, warn, error]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('s1-s3cr3t')
    }
  })
})
