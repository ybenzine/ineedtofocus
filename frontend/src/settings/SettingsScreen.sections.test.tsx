// Settings sections (AC12.9, AC12.10): order, default open state, collapsing without discarding,
// Manage tags, the sync note, and the keyboard.

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnonymousContext, type AnonymousUse } from '../anonymous/AnonymousContext.ts'
import { ANONYMOUS_SETTINGS_NOTE } from '../anonymous/AnonymousScreens.tsx'
import AuthGate from '../auth/AuthGate.tsx'
import type { AuthApi } from '../auth/api.ts'
import { AlertPlayer } from '../sounds/alerts.ts'
import { TagsContext } from '../tags/context.ts'
import { TagsStore } from '../tags/store.ts'
import { FakeTagsApi } from '../test/fakeTagsApi.ts'
import { DeviceAlertVolumeStore } from './adapters.ts'
import { SettingsContext } from './SettingsContext.ts'
import SettingsScreen from './SettingsScreen.tsx'
import { SoundLevelsContext } from './SoundLevelsContext.ts'
import { SoundLevelsStore } from './soundLevels.ts'
import { SettingsStore } from './store.ts'

const SECRET_PATH = '/api/calendar/s3cr3t-s3cr3t-s3cr3t.ics'

function stubFetch() {
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return json({ path: SECRET_PATH, created_at: '2026-11-20T12:00:00Z' })
      }
      return json({ enabled: false, created_at: null, last_fetched_at: null })
    }),
  )
}

const user = { id: 'u1', email: 'a@b.co', created_at: '2026-10-30T00:00:00Z' }
const authApi: AuthApi = {
  me: vi.fn().mockResolvedValue(user),
  signUp: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn().mockResolvedValue(undefined),
}

async function renderScreen(
  options: {
    anonymous?: boolean
    openTags?: boolean
    store?: SettingsStore
    api?: FakeTagsApi
  } = {},
) {
  const levels = new SoundLevelsStore()
  const player = new AlertPlayer({
    volume: new DeviceAlertVolumeStore(levels),
    createContext: () => ({}) as unknown as AudioContext,
    fetchSound: async () => new ArrayBuffer(1),
  })
  const store = options.store ?? new SettingsStore()
  const api = options.api ?? new FakeTagsApi()
  const tags = new TagsStore({ api, owner: 'u1' })
  await tags.refresh()
  const anonymous = options.anonymous
    ? ({ held: {}, openForm: vi.fn() } as unknown as AnonymousUse)
    : null
  const screenEl = (
    <SettingsContext.Provider value={store}>
      <SoundLevelsContext.Provider value={levels}>
        <TagsContext.Provider value={tags}>
          <SettingsScreen player={player} openTags={options.openTags} />
        </TagsContext.Provider>
      </SoundLevelsContext.Provider>
    </SettingsContext.Provider>
  )
  render(
    <AnonymousContext.Provider value={anonymous}>
      {anonymous ? screenEl : <AuthGate api={authApi}>{screenEl}</AuthGate>}
    </AnonymousContext.Provider>,
  )
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  return { store, api }
}

const toggle = (name: string) => screen.getByRole('button', { name })
const expanded = (name: string) => toggle(name).getAttribute('aria-expanded')
const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)

beforeEach(() => stubFetch())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('sections (AC12.9)', () => {
  it('shows Appearance, Audio, Timer, Tags, History, Calendar, Account in that order, each an h2', async () => {
    await renderScreen()
    expect(headings()).toEqual([
      'Appearance',
      'Audio',
      'Timer',
      'Tags',
      'History',
      'Calendar',
      'Account',
    ])
  })

  it('has no History or Account without an account, keeps the note at the top, and the Tags and Calendar prompts', async () => {
    await renderScreen({ anonymous: true })
    expect(headings()).toEqual(['Appearance', 'Audio', 'Timer', 'Tags', 'Calendar'])
    expect(screen.queryByLabelText('Week starts on')).not.toBeInTheDocument()
    const note = screen.getByText(ANONYMOUS_SETTINGS_NOTE)
    expect(note.compareDocumentPosition(toggle('Appearance'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    fireEvent.click(toggle('Tags'))
    fireEvent.click(toggle('Calendar'))
    expect(
      screen.getAllByRole('link', { name: 'Create an account' }).length,
    ).toBeGreaterThanOrEqual(2)
  })

  it('keeps the alert, background and break controls under Audio, with the level hint once', async () => {
    await renderScreen()
    const audio = screen.getByRole('region', { name: 'Audio' })
    for (const label of [
      'Alert volume',
      'Background audio volume',
      'Pause background audio during Pomodoro breaks',
    ]) {
      expect(within(audio).getByLabelText(label)).toBeInTheDocument()
    }
    expect(within(audio).getByRole('button', { name: 'Preview chime' })).toBeInTheDocument()
    expect(screen.getAllByText('Sound levels are saved on this device only.')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Alert sounds' })).not.toBeInTheDocument()
    const timer = screen.getByRole('region', { name: 'Timer' })
    expect(within(timer).getByLabelText(/Keep screen awake/)).toBeInTheDocument()
    expect(within(timer).getByLabelText(/Default reminder interval/)).toBeInTheDocument()
    expect(
      within(screen.getByRole('region', { name: 'History' })).getByLabelText('Week starts on'),
    ).toBeInTheDocument()
  })
})

describe('open and closed (AC12.10)', () => {
  it('opens Appearance, Audio, Timer and History, and closes Tags, Calendar and Account', async () => {
    await renderScreen()
    for (const name of ['Appearance', 'Audio', 'Timer', 'History']) {
      expect(expanded(name)).toBe('true')
    }
    for (const name of ['Tags', 'Calendar', 'Account']) expect(expanded(name)).toBe('false')
  })

  it('has the same defaults without an account', async () => {
    await renderScreen({ anonymous: true })
    for (const name of ['Appearance', 'Audio', 'Timer']) expect(expanded(name)).toBe('true')
    for (const name of ['Tags', 'Calendar']) expect(expanded(name)).toBe('false')
  })

  it('is not remembered: a fresh visit starts from the defaults', async () => {
    const first = await renderScreen()
    fireEvent.click(toggle('Audio'))
    fireEvent.click(toggle('Tags'))
    expect(expanded('Audio')).toBe('false')
    expect(expanded('Tags')).toBe('true')
    document.body.innerHTML = ''
    await renderScreen({ store: first.store })
    expect(expanded('Audio')).toBe('true')
    expect(expanded('Tags')).toBe('false')
  })

  it('hides a closed section from the page but keeps its contents', async () => {
    await renderScreen()
    expect(screen.getByLabelText('Alert volume')).toBeVisible()
    fireEvent.click(toggle('Audio'))
    expect(screen.queryByRole('slider', { name: 'Alert volume' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Alert volume', { selector: 'input' })).not.toBeVisible()
  })

  it('is a native button, so Enter and Space toggle it (covered end to end in the browser)', async () => {
    await renderScreen()
    const button = toggle('Timer')
    expect(button.tagName).toBe('BUTTON')
    expect(button).toHaveAttribute('type', 'button')
    button.focus()
    expect(button).toHaveFocus()
    // jsdom doesn't turn a key press into a click; the native button does in a browser.
    fireEvent.click(button)
    expect(expanded('Timer')).toBe('false')
    fireEvent.click(button)
    expect(expanded('Timer')).toBe('true')
  })

  it('keeps the headings reachable and the toggle named by its heading', async () => {
    await renderScreen()
    const heading = screen.getByRole('heading', { level: 2, name: 'Audio' })
    expect(within(heading).getByRole('button', { name: 'Audio' })).toHaveAttribute('aria-controls')
  })
})

describe('closing never discards', () => {
  it('keeps the one-time calendar link through a close and reopen (AC14.4)', async () => {
    await renderScreen()
    fireEvent.click(toggle('Calendar'))
    fireEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    const link = (await screen.findByLabelText('Subscription link')) as HTMLInputElement
    expect(link.value).toContain(SECRET_PATH)
    fireEvent.click(toggle('Calendar'))
    expect(link).not.toBeVisible()
    fireEvent.click(toggle('Calendar'))
    expect(screen.getByLabelText('Subscription link')).toBe(link)
    expect(link).toBeVisible()
    expect(link.value).toContain(SECRET_PATH)
  })

  it('keeps a tag being typed and an open remove confirmation', async () => {
    const api = new FakeTagsApi()
    api.add('Deep work')
    await renderScreen({ api })
    fireEvent.click(toggle('Tags'))
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'Half typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove Deep work' }))
    expect(screen.getByText(/Remove Deep work\?/)).toBeVisible()
    fireEvent.click(toggle('Tags'))
    fireEvent.click(toggle('Tags'))
    expect(screen.getByLabelText('Tag name')).toHaveValue('Half typed')
    expect(screen.getByText(/Remove Deep work\?/)).toBeVisible()
  })

  it('keeps a password typed into Delete account', async () => {
    await renderScreen()
    fireEvent.click(toggle('Account'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const password = await screen.findByLabelText('Password')
    fireEvent.change(password, { target: { value: 'hunter2hunter2' } })
    fireEvent.click(toggle('Account'))
    fireEvent.click(toggle('Account'))
    expect(screen.getByLabelText('Password')).toHaveValue('hunter2hunter2')
  })
})

describe('Manage tags (AC7.10)', () => {
  it('opens Tags and scrolls it into view, leaving the others at their defaults', async () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    await renderScreen({ openTags: true })
    expect(expanded('Tags')).toBe('true')
    expect(expanded('Calendar')).toBe('false')
    expect(expanded('Account')).toBe('false')
    expect(expanded('Audio')).toBe('true')
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    const target = scroll.mock.contexts[0] as HTMLElement
    expect(target).toContainElement(screen.getByRole('region', { name: 'Tags' }))
  })
})

describe('the sync note', () => {
  it('shows under the title, outside every section, with every section closed', async () => {
    const store = new SettingsStore({ owner: 'u1' })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    await renderScreen({ store })
    act(() => store.update({ week_start_day: 2 }))
    for (const name of ['Appearance', 'Audio', 'Timer', 'History']) fireEvent.click(toggle(name))
    const note = screen.getByText("Saved on this device. It will sync when you're back online.")
    expect(note).toHaveAttribute('role', 'status')
    expect(note).toBeVisible()
    expect(note.closest('[role="region"]')).toBeNull()
    const title = screen.getByRole('heading', { level: 1, name: 'Settings' })
    expect(title.compareDocumentPosition(note)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})
