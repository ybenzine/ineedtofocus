// The Add to calendar control (F14, AC14.7): choices, settings applied, offline, keyboard.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheUser, forgetCachedUser, signedInUserId } from '../auth/localData.ts'
import { SettingsContext } from '../settings/SettingsContext.ts'
import { SettingsStore } from '../settings/store.ts'
import { TagsContext } from '../tags/context.ts'
import { TagsStore } from '../tags/store.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import SessionSummary from '../timerscreen/SessionSummary.tsx'
import type { SessionRecord } from '../timer/index.ts'
import AddToCalendar, { type CalendarSession } from './AddToCalendar.tsx'
import { PROBE_TIMEOUT_MS, PROBE_VALID_MS } from './useIcsProbe.ts'

const session: CalendarSession = {
  id: '0f6e2b9a-3c1d-4e5f-8a7b-0000000000aa',
  mode: 'countdown',
  tag: 'work',
  goal: 'Write chapter 3',
  startedAt: '2026-10-30T09:00:00.000Z',
  endedAt: '2026-10-30T09:25:00.000Z',
  focusSeconds: 1500,
  pausedSeconds: 0,
  status: 'completed',
  blocks: null,
  blocksCompleted: 0,
}

const record: SessionRecord = {
  id: session.id,
  mode: 'countdown',
  tag: 'work',
  goal: 'Write chapter 3',
  startedAt: session.startedAt,
  endedAt: session.endedAt,
  focusSeconds: 1500,
  pausedSeconds: 0,
  status: 'completed',
  modeConfig: { mode: 'countdown', minutes: 25 },
  blocksCompleted: 0,
}

function withProviders(ui: ReactElement, settings = new SettingsStore(), tags = new TagsStore()) {
  return (
    <SettingsContext.Provider value={settings}>
      <TagsContext.Provider value={tags}>{ui}</TagsContext.Provider>
    </SettingsContext.Provider>
  )
}

function setOnline(online: boolean) {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
}

const label = /^Add to calendar: Work, 25 min on /

beforeEach(() => setOnline(true))
afterEach(() => {
  vi.restoreAllMocks()
  forgetCachedUser()
})

describe('the control', () => {
  it('is a button named by the session, which opens two choices', () => {
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    const button = screen.getByRole('button', {
      name: /^Add to calendar: Work, 25 min on Oct 30 at 9:00\s?AM$/,
    })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('link', { name: 'Google Calendar' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Apple Calendar / other (.ics)' })).toBeInTheDocument()
  })

  it('keeps the choice when a tap blurs with no related target (iOS focuses nothing), then closes', () => {
    render(withProviders(<AddToCalendar session={session} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    const ics = screen.getByRole('link', { name: 'Apple Calendar / other (.ics)' })
    // iOS order for a tap on the second choice: pointerdown, blur of the focused first choice
    // with relatedTarget null, then click.
    fireEvent.pointerDown(ics)
    fireEvent.blur(screen.getByRole('link', { name: 'Google Calendar' }), { relatedTarget: null })
    expect(screen.getByRole('link', { name: 'Apple Calendar / other (.ics)' })).toBe(ics)
    expect(fireEvent.click(ics)).toBe(true) // not default-prevented: the browser follows the link
  })

  it('closes on a press outside, and on tabbing out', () => {
    render(
      withProviders(
        <div>
          <AddToCalendar session={session} />
          <button>other</button>
        </div>,
      ),
    )
    const toggle = screen.getByRole('button', { name: label })
    fireEvent.click(toggle)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'other' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    fireEvent.blur(screen.getByRole('link', { name: 'Google Calendar' }), {
      relatedTarget: screen.getByRole('button', { name: 'other' }),
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes when Tab moves focus out of the page (blur with no related target, no press)', () => {
    render(withProviders(<AddToCalendar session={session} />))
    const toggle = screen.getByRole('button', { name: label })
    fireEvent.click(toggle)
    const google = screen.getByRole('link', { name: 'Google Calendar' })
    fireEvent.keyDown(google, { key: 'Tab' })
    fireEvent.blur(google, { relatedTarget: null })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('names a custom tag by its current name, and an unknown tag "Tag"', async () => {
    const api = new FakeTagsApi()
    const tag = api.add('Side, project')
    const tags = new TagsStore({ api, owner: 'u1' })
    await tags.refresh()
    const { rerender } = render(
      withProviders(<AddToCalendar session={{ ...session, tag: tag.id }} />, undefined, tags),
    )
    expect(
      screen.getByRole('button', { name: /^Add to calendar: Side, project, 25 min on / }),
    ).toBeInTheDocument()
    rerender(
      withProviders(
        <AddToCalendar session={{ ...session, tag: 'not-a-known-id' }} />,
        undefined,
        tags,
      ),
    )
    expect(screen.getByRole('button', { name: /^Add to calendar: Tag, 25 min on / })).toBeVisible()
  })

  it('moves focus into the choices, closes on Escape and gives focus back', () => {
    render(withProviders(<AddToCalendar session={session} />))
    const button = screen.getByRole('button', { name: label })
    button.focus()
    fireEvent.click(button)
    expect(screen.getByRole('link', { name: 'Google Calendar' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('link', { name: 'Google Calendar' }), { key: 'Escape' })
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })
})

describe('Google Calendar', () => {
  it('opens the pre-filled page in a new tab, with the settings applied', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_title_template: '{focus_time} of {tag}: {goal}' })
    render(withProviders(<AddToCalendar session={session} />, settings))
    fireEvent.click(screen.getByRole('button', { name: label }))
    const link = screen.getByRole('link', { name: 'Google Calendar' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    const url = new URL(link.getAttribute('href') ?? '')
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render')
    expect(url.searchParams.get('text')).toBe('25 min of Work: Write chapter 3')
    expect(url.searchParams.get('dates')).toBe('20261030T090000Z/20261030T092500Z')
    expect(url.searchParams.get('details')).toContain('Goal: Write chapter 3')
  })

  it('leaves the goal out when goals are off, and the details when the description is off', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_include_goal: false, calendar_include_description: false })
    render(withProviders(<AddToCalendar session={session} />, settings))
    fireEvent.click(screen.getByRole('button', { name: label }))
    const url = new URL(
      screen.getByRole('link', { name: 'Google Calendar' }).getAttribute('href') ?? '',
    )
    expect(url.searchParams.get('text')).toBe('Work')
    expect(url.searchParams.has('details')).toBe(false)
  })

  it('does not apply the tag or minimum-length settings: the session was picked on purpose', () => {
    const settings = new SettingsStore()
    settings.update({ calendar_excluded_tags: ['work'], calendar_min_minutes: 15 })
    render(withProviders(<AddToCalendar session={{ ...session, focusSeconds: 90 }} />, settings))
    expect(screen.getByRole('button', { name: /^Add to calendar: Work, 1 min on / })).toBeVisible()
  })

  it('is disabled offline, with a hint, and does nothing', () => {
    setOnline(false)
    render(withProviders(<AddToCalendar session={session} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(screen.queryByRole('link', { name: 'Google Calendar' })).not.toBeInTheDocument()
    const google = screen.getByRole('button', { name: 'Google Calendar' })
    expect(google).toHaveAttribute('aria-disabled', 'true')
    expect(google).toHaveAccessibleDescription('Needs a connection')
    const open = vi.spyOn(window, 'open')
    fireEvent.click(google)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('Apple Calendar / other (.ics)', () => {
  function capture() {
    const blobs: Blob[] = []
    const revoked = vi.fn()
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob)
          return 'blob:test'
        },
        revokeObjectURL: revoked,
      }),
    )
    return { blobs, revoked }
  }
  const choice = () => screen.getByRole('link', { name: 'Apple Calendar / other (.ics)' })

  it('is a link to a one-event file made before the tap, named ineedtofocus-<local date>-<HHMM>.ics', async () => {
    const { blobs } = capture()
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(choice()).toHaveAttribute('href', 'blob:test')
    expect(choice()).toHaveAttribute('download', 'ineedtofocus-2026-10-30-0900.ics')
    expect(blobs[0]?.type).toBe('text/calendar;charset=utf-8')
    const text = await (blobs[0] as Blob).text()
    expect(text).toContain('BEGIN:VCALENDAR\r\n')
    expect(text).toContain('UID:0f6e2b9a-3c1d-4e5f-8a7b-0000000000aa@ineedtofoc.us\r\n')
    expect(text).toContain('SUMMARY:Work: Write chapter 3\r\n')
    expect(text).toContain('DTSTART:20261030T090000Z\r\nDTEND:20261030T092500Z\r\n')
    expect(text).toContain('TRANSP:TRANSPARENT\r\n')
    expect(text).not.toContain('VALARM')
  })

  it('closes after the tap, with focus back on the button, and frees the file later', () => {
    vi.useFakeTimers()
    const { revoked } = capture()
    const { unmount } = render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    const toggle = screen.getByRole('button', { name: label })
    fireEvent.click(toggle)
    expect(fireEvent.click(choice())).toBe(true)
    // Still there during the click, so the browser can follow the link.
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    act(() => void vi.advanceTimersByTime(0))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveFocus()
    expect(revoked).not.toHaveBeenCalled()
    unmount()
    act(() => void vi.advanceTimersByTime(60_000))
    expect(revoked).toHaveBeenCalledWith('blob:test')
    vi.useRealTimers()
  })

  it('works offline', async () => {
    setOnline(false)
    const { blobs } = capture()
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(choice()).toHaveAttribute('href', 'blob:test')
    expect(await (blobs[0] as Blob).text()).toContain('SUMMARY:Work: Write chapter 3')
  })

  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'

  const ICS = 'Apple Calendar / other (.ics)'

  function stubProbe(status: number | 'network' | 'hang') {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (status === 'network') return Promise.reject(new TypeError('Failed to fetch'))
      if (status === 'hang')
        return new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError'))),
        )
      return Promise.resolve(new Response(null, { status }))
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function openIos() {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
    signIn()
    render(withProviders(<AddToCalendar session={session} timeZone="UTC" synced />))
    fireEvent.click(screen.getByRole('button', { name: label }))
  }

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  describe('the server probe (#458)', () => {
    const PATH = `/api/calendar/session/${session.id}.ics?tz=UTC`

    it('sends a HEAD with credentials and no cache, and disables the choice while it is in flight', async () => {
      const fetchMock = stubProbe('hang')
      openIos()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(PATH)
      expect(init).toMatchObject({ method: 'HEAD', credentials: 'include', cache: 'no-store' })
      const button = screen.getByRole('button', { name: ICS })
      expect(button).toHaveAttribute('aria-disabled', 'true')
      expect(button).toHaveAccessibleDescription('Checking…')
    })

    it('offers the link on a 200', async () => {
      stubProbe(200)
      openIos()
      expect(await screen.findByRole('link', { name: ICS })).toHaveAttribute('href', PATH)
    })

    it.each([
      ['404 (archived or gone)', 404, "Can't add this session right now"],
      ['5xx', 503, "Can't add this session right now"],
      ['a network failure', 'network', "Can't add this session right now"],
      ['401 (sign-in expired)', 401, 'Sign in again to add this session'],
    ] as const)('keeps the choice disabled on %s, with a hint', async (_n, status, hint) => {
      stubProbe(status)
      openIos()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(hint),
      )
      expect(screen.getByRole('button', { name: ICS })).toHaveAttribute('aria-disabled', 'true')
      expect(screen.queryByRole('link', { name: ICS })).toBeNull()
    })

    it('does not sign anyone out on a 401', async () => {
      stubProbe(401)
      openIos()
      await screen.findByText('Sign in again to add this session')
      expect(signedInUserId()).toBe('u1')
    })

    it('gives up on a hung probe after the timeout', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      stubProbe('hang')
      openIos()
      await act(() => vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 100))
      expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(
        "Can't add this session right now",
      )
    })

    it('disables the link when the device goes offline after it opened, and probes again when back', async () => {
      const fetchMock = stubProbe(200)
      openIos()
      await screen.findByRole('link', { name: ICS })
      setOnline(false)
      act(() => void window.dispatchEvent(new Event('offline')))
      expect(screen.queryByRole('link', { name: ICS })).toBeNull()
      expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(
        'Needs a connection',
      )
      setOnline(true)
      act(() => void window.dispatchEvent(new Event('online')))
      await screen.findByRole('link', { name: ICS })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('asks again after the answer expires, and the link goes away if the session was archived', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const fetchMock = stubProbe(200)
      openIos()
      await screen.findByRole('link', { name: ICS })
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
      await act(() => vi.advanceTimersByTimeAsync(PROBE_VALID_MS + 100))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('link', { name: ICS })).toBeNull()
      expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(
        "Can't add this session right now",
      )
    })

    /** A fetch whose answers the test gives one by one; the signal is recorded, not obeyed. */
    function manualProbe(obeyAbort = false) {
      const calls: { resolve: (status: number) => void; signal: AbortSignal }[] = []
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          if (obeyAbort)
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('', 'AbortError')),
            )
          calls.push({
            signal: init?.signal as AbortSignal,
            resolve: (status) => resolve(new Response(null, { status })),
          })
        })
      })
      vi.stubGlobal('fetch', fetchMock)
      return { calls, fetchMock }
    }

    const answer = (call: { resolve: (s: number) => void }, status = 200) =>
      act(async () => call.resolve(status))
    const returnToForeground = (event: 'visibilitychange' | 'pageshow' = 'visibilitychange') =>
      act(() => {
        if (event === 'visibilitychange') document.dispatchEvent(new Event(event))
        else window.dispatchEvent(new Event(event))
      })
    const checking = () => {
      expect(screen.queryByRole('link', { name: ICS })).toBeNull()
      expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription('Checking…')
    }

    it.each(['visibilitychange', 'pageshow'] as const)(
      'goes back to "Checking…" when the app returns (%s), until a new answer arrives',
      async (event) => {
        const { calls, fetchMock } = manualProbe()
        openIos()
        await answer(calls[0])
        expect(screen.getByRole('link', { name: ICS })).toBeInTheDocument()
        await returnToForeground(event)
        expect(fetchMock).toHaveBeenCalledTimes(2)
        checking()
        await answer(calls[1])
        expect(screen.getByRole('link', { name: ICS })).toBeInTheDocument()
      },
    )

    it('holds "Checking…" after the foreground even when a held failure was showing, and when the re-check hangs', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { calls } = manualProbe(true)
      openIos()
      await answer(calls[0], 404)
      await returnToForeground()
      checking()
      await act(() => vi.advanceTimersByTimeAsync(7_900))
      checking()
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(
        "Can't add this session right now",
      )
    })

    it('ignores the first answer once a newer request is out', async () => {
      const { calls } = manualProbe()
      openIos()
      await returnToForeground()
      await answer(calls[0]) // late answer of the superseded request
      checking()
      await answer(calls[1])
      expect(screen.getByRole('link', { name: ICS })).toBeInTheDocument()
    })

    it('aborts the superseded request and the one in flight when the menu closes', async () => {
      const { calls } = manualProbe()
      openIos()
      await returnToForeground()
      expect(calls[0].signal.aborted).toBe(true)
      expect(calls[1].signal.aborted).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(calls[1].signal.aborted).toBe(true)
    })

    it('keeps the last answer through the 20 s re-check, silently, with exactly one request per 20 s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { calls, fetchMock } = manualProbe()
      openIos()
      await answer(calls[0])
      const link = screen.getByRole('link', { name: ICS })
      const mutations: MutationRecord[] = []
      const observer = new MutationObserver((m) => mutations.push(...m))
      observer.observe(screen.getByRole('list'), {
        subtree: true,
        childList: true,
        characterData: true,
      })
      await act(() => vi.advanceTimersByTimeAsync(19_900))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('link', { name: ICS })).toBe(link) // no flicker while it is out
      await answer(calls[1])
      observer.disconnect()
      expect(mutations).toHaveLength(0)
      expect(screen.getByRole('link', { name: ICS })).toBe(link)
    })

    it('runs one chain of re-checks after a foreground return, and none after the menu closes', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { calls, fetchMock } = manualProbe()
      openIos()
      await answer(calls[0])
      await returnToForeground()
      await answer(calls[1])
      await act(() => vi.advanceTimersByTimeAsync(20_100))
      expect(fetchMock).toHaveBeenCalledTimes(3)
      await answer(calls[2])
      fireEvent.click(screen.getByRole('button', { name: label }))
      await act(() => vi.advanceTimersByTimeAsync(120_000))
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('offers the link only on a 200, not on another 2xx', async () => {
      stubProbe(204)
      openIos()
      await waitFor(() =>
        expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription(
          "Can't add this session right now",
        ),
      )
    })

    it('waits exactly 8 s for an answer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { calls } = manualProbe()
      openIos()
      await act(() => vi.advanceTimersByTimeAsync(7_900))
      expect(calls[0].signal.aborted).toBe(false)
      await act(() => vi.advanceTimersByTimeAsync(200))
      expect(calls[0].signal.aborted).toBe(true)
    })

    it('starts from "Checking…" on every open: an earlier 200 never shows on a reopened menu', async () => {
      const { calls, fetchMock } = manualProbe()
      openIos()
      await answer(calls[0])
      const toggle = screen.getByRole('button', { name: label })
      fireEvent.click(toggle) // close
      fireEvent.click(toggle) // reopen
      expect(fetchMock).toHaveBeenCalledTimes(2)
      checking()
    })

    it('ignores an answer that arrives after the menu closed', async () => {
      const { calls } = manualProbe()
      openIos()
      const toggle = screen.getByRole('button', { name: label })
      fireEvent.click(toggle)
      await answer(calls[0])
      fireEvent.click(toggle)
      checking()
    })

    it("does not show an earlier open's 200 after going offline and back", async () => {
      const { calls } = manualProbe()
      openIos()
      await answer(calls[0])
      setOnline(false)
      act(() => void window.dispatchEvent(new Event('offline')))
      setOnline(true)
      act(() => void window.dispatchEvent(new Event('online')))
      checking()
    })

    it('does not carry a 200 over to another session while the menu stays open', async () => {
      const { calls } = manualProbe()
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
      signIn()
      const ui = (id: string) =>
        withProviders(<AddToCalendar session={{ ...session, id }} timeZone="UTC" synced />)
      const { rerender } = render(ui(session.id))
      fireEvent.click(screen.getByRole('button', { name: label }))
      await answer(calls[0])
      rerender(ui('0f6e2b9a-3c1d-4e5f-8a7b-0000000000bb'))
      checking()
      expect(calls[1].signal.aborted).toBe(false)
      expect(calls[0].signal.aborted).toBe(true)
    })

    it('puts focus on the new element when the link and the disabled button swap', async () => {
      const { calls } = manualProbe()
      openIos()
      await answer(calls[0])
      const link = screen.getByRole('link', { name: ICS })
      link.focus()
      await returnToForeground()
      expect(screen.getByRole('button', { name: ICS })).toHaveFocus()
      await answer(calls[1])
      expect(screen.getByRole('link', { name: ICS })).toHaveFocus()
      // and offline: Escape still closes the menu afterwards
      setOnline(false)
      act(() => void window.dispatchEvent(new Event('offline')))
      expect(screen.getByRole('button', { name: ICS })).toHaveFocus()
      fireEvent.keyDown(screen.getByRole('button', { name: ICS }), { key: 'Escape' })
      expect(screen.queryByRole('list')).toBeNull()
    })

    it('keeps one live region mounted through the swap, so hints are announced, and its line is kept', async () => {
      const { calls } = manualProbe()
      openIos()
      const status = screen.getByRole('status')
      expect(status).toHaveTextContent('Checking…')
      await answer(calls[0])
      expect(screen.getByRole('status')).toBe(status)
      expect(status.textContent).toBe('\u00a0') // empty, but it keeps its line: nothing moves
      await returnToForeground()
      expect(screen.getByRole('status')).toBe(status)
      expect(status).toHaveTextContent('Checking…')
    })

    it('sends no probe before the menu opens, nor when the local checks already refuse', async () => {
      const fetchMock = stubProbe(200)
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
      signIn()
      render(withProviders(<AddToCalendar session={session} timeZone="UTC" />))
      expect(fetchMock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(fetchMock).not.toHaveBeenCalled() // not synced
    })

    it('sends no probe off iOS', () => {
      const fetchMock = stubProbe(200)
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
      capture()
      signIn()
      render(withProviders(<AddToCalendar session={session} synced />))
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  function signIn() {
    cacheUser({ id: 'u1', email: 'a@b.co' } as never)
  }

  it.each([
    ['Safari', false],
    ['the installed Home Screen app', true],
  ])(
    'on iOS in %s is a same-tab link to the server copy, with no download and no blob',
    async (_name, standalone) => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
      if (standalone)
        Object.defineProperty(navigator, 'standalone', { value: true, configurable: true })
      signIn()
      const { blobs } = capture()
      const open = vi.spyOn(window, 'open')
      stubProbe(200)
      render(withProviders(<AddToCalendar session={session} timeZone="Europe/Paris" synced />))
      fireEvent.click(screen.getByRole('button', { name: label }))
      await screen.findByRole('link', { name: ICS })
      expect(choice()).toHaveAttribute(
        'href',
        `/api/calendar/session/${session.id}.ics?tz=Europe%2FParis`,
      )
      expect(choice()).toHaveAttribute('target', '_self')
      expect(choice()).not.toHaveAttribute('download')
      expect(blobs).toHaveLength(0)
      fireEvent.click(choice())
      expect(open).not.toHaveBeenCalled()
      delete (navigator as { standalone?: boolean }).standalone
    },
  )

  it('on iOS uses the device time zone when none is given', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
    signIn()
    stubProbe(200)
    render(withProviders(<AddToCalendar session={session} synced />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    await screen.findByRole('link', { name: ICS })
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(choice().getAttribute('href')).toContain(`?tz=${encodeURIComponent(zone)}`)
  })

  it.each([
    ['offline', false, true, 'Needs a connection'],
    ['not synced yet', true, false, 'Not synced yet'],
  ])('on iOS is disabled with a hint when %s', (_name, online, synced, hint) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
    signIn()
    setOnline(online)
    render(withProviders(<AddToCalendar session={session} synced={synced} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(screen.queryByRole('link', { name: ICS })).toBeNull()
    const button = screen.getByRole('button', { name: ICS })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAccessibleDescription(hint)
  })

  it('on iOS is disabled when not signed in', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE)
    render(withProviders(<AddToCalendar session={session} synced />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(screen.getByRole('button', { name: ICS })).toHaveAccessibleDescription('Sign in first')
  })

  it('keeps the blob download on other platforms', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    capture()
    render(withProviders(<AddToCalendar session={session} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(choice()).toHaveAttribute('href', 'blob:test')
    expect(choice()).toHaveAttribute('download')
    expect(choice()).not.toHaveAttribute('target')
  })

  it('off iOS, unsynced and offline still gets the device-built file', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (X11; Linux x86_64)')
    setOnline(false)
    const { blobs } = capture()
    render(withProviders(<AddToCalendar session={session} synced={false} />))
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(choice()).toHaveAttribute('download')
    expect(await (blobs[0] as Blob).text()).toContain('SUMMARY:Work: Write chapter 3')
  })

  it('makes the file again when a setting changes while the menu is open', async () => {
    const { blobs } = capture()
    const settings = new SettingsStore()
    render(withProviders(<AddToCalendar session={session} />, settings))
    fireEvent.click(screen.getByRole('button', { name: label }))
    act(() => settings.update({ calendar_title_template: 'Focus on {tag}' }))
    expect(await (blobs.at(-1) as Blob).text()).toContain('SUMMARY:Focus on Work')
  })
})

describe('on the session summary (AC14.7)', () => {
  it('is on a signed-in summary, also for a session not synced yet', () => {
    render(
      withProviders(
        <SessionSummary outcome={{ kind: 'saved', record }} recordPending onNewSession={vi.fn()} />,
      ),
    )
    expect(screen.getByText(/Not saved yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeVisible()
  })

  it('is absent from a summary without an account, and appears on it once it is the account’s', () => {
    const ui = (savePrompt: boolean, inAccount: boolean) =>
      withProviders(
        <SessionSummary
          outcome={{ kind: 'saved', record }}
          savePrompt={savePrompt}
          inAccount={inAccount}
          onNewSession={vi.fn()}
        />,
      )
    const { rerender } = render(ui(true, false))
    expect(screen.getByText(/to save this session/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Add to calendar: / })).not.toBeInTheDocument()
    rerender(ui(false, true))
    expect(screen.queryByText(/to save this session/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeVisible()
  })

  it('is absent when the session was not saved', () => {
    render(
      withProviders(
        <SessionSummary
          outcome={{
            kind: 'discarded',
            reason: 'too_short',
            focusSeconds: 10,
            message: 'Too short',
          }}
          onNewSession={vi.fn()}
        />,
      ),
    )
    expect(screen.queryByRole('button', { name: /^Add to calendar: / })).not.toBeInTheDocument()
  })
})
