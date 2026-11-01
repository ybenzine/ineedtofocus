import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chooseMode,
  closeSheet,
  openSheet,
  pickSound,
  pickTag,
  startButton as start,
  typeDuration,
  typeGoal,
} from '../test/setupUi.ts'
import { CLOCK_REFRESH_MS, cleanGoal } from './options.ts'
import { DEFAULT_PREFERENCES, MemoryPreferencesStore } from './preferences.ts'
import SessionSetup, { type SessionRequest } from './SessionSetup.tsx'

function setup(preferences = new MemoryPreferencesStore(), locale = 'en-US') {
  const onStart = vi.fn<(request: SessionRequest) => void>()
  render(<SessionSetup preferences={preferences} onStart={onStart} locale={locale} />)
  return { onStart, preferences }
}

const typeFocus = (value: string) =>
  fireEvent.change(screen.getByLabelText('Focus length in minutes, 5 to 90'), {
    target: { value },
  })
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const duration = () => screen.getByLabelText('Duration in minutes, 1 to 240')

afterEach(() => {
  vi.useRealTimers()
})

describe('SessionSetup layout', () => {
  it('has the mode switch, the dial, the presets, the rows and Start, and no page heading box', () => {
    setup()
    expect(screen.getByRole('group', { name: 'Timer' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')?.textContent)).toEqual([
      'Countdown',
      'Pomodoro',
      'Unlimited',
    ])
    expect(screen.getByRole('group', { name: 'Preset lengths' })).toBeInTheDocument()
    for (const row of ['Tag', 'Goal', 'Sound']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${row}\\b`) })).toHaveAttribute(
        'aria-haspopup',
        'dialog',
      )
    }
    expect(start()).toBeInTheDocument()
    // The only heading left is the screen reader one.
    expect(screen.getByRole('heading', { level: 1 })).toHaveClass('sr-only')
    expect(document.querySelector('fieldset.setup-box')).toBeNull()
  })

  it('shows each row with its current value', () => {
    setup()
    expect(screen.getByRole('button', { name: /^Tag\b.*Work/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Goal\b.*Add a goal/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sound\b.*None/ })).toBeInTheDocument()
  })
})

describe('SessionSetup Countdown', () => {
  it('starts a 30 minute countdown with Work and no audio by default', async () => {
    const { onStart } = setup()
    expect(duration()).toHaveValue('30')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0]).toEqual({
      config: { mode: 'countdown', minutes: 30 },
      tag: 'work',
      goal: null,
      audio: 'none',
      youtubeLink: null,
    })
  })

  it.each(['0', '241', '1.5', '', 'abc'])('blocks a countdown of "%s"', (value) => {
    setup()
    typeDuration(value)
    expect(start()).toBeDisabled()
    expect(duration()).toHaveAttribute('aria-invalid', 'true')
  })

  it.each(['1', '240'])('accepts a countdown of %s', (value) => {
    setup()
    typeDuration(value)
    expect(start()).toBeEnabled()
    expect(duration()).not.toHaveAttribute('aria-invalid')
  })

  it.each([
    [23, '5 minutes less', 20],
    [23, '5 minutes more', 25],
    [30, '5 minutes less', 25],
    [30, '5 minutes more', 35],
    [1, '5 minutes more', 5],
    [5, '5 minutes less', 1],
    [1, '5 minutes less', 1],
    [240, '5 minutes more', 240],
    [238, '5 minutes more', 240],
    [300, '5 minutes less', 240],
  ])('from %i, "%s" gives %i', (from, button, to) => {
    setup()
    typeDuration(String(from))
    click(button)
    expect(duration()).toHaveValue(String(to))
  })

  it('starts the stepping from 30 when the field holds nothing readable', () => {
    setup()
    typeDuration('')
    click('5 minutes more')
    expect(duration()).toHaveValue('35')
  })

  it('has 52 px buttons that are labelled', () => {
    setup()
    expect(screen.getByRole('button', { name: '5 minutes less' })).toHaveClass('step-button-large')
    expect(screen.getByRole('button', { name: '5 minutes more' })).toHaveClass('step-button-large')
  })

  it('sets the length from a preset and shows the matching one as selected', () => {
    setup()
    const preset = (minutes: number) => screen.getByRole('button', { name: `${minutes} minutes` })
    expect(preset(30)).toHaveAttribute('aria-pressed', 'true')
    for (const minutes of [15, 45, 60, 90]) {
      expect(preset(minutes)).toHaveAttribute('aria-pressed', 'false')
    }
    fireEvent.click(preset(90))
    expect(duration()).toHaveValue('90')
    expect(preset(90)).toHaveAttribute('aria-pressed', 'true')
    expect(preset(30)).toHaveAttribute('aria-pressed', 'false')
    typeDuration('50')
    for (const minutes of [15, 30, 45, 60, 90]) {
      expect(preset(minutes)).toHaveAttribute('aria-pressed', 'false')
    }
  })

  it('offers exactly the five presets', () => {
    setup()
    const labels = within(screen.getByRole('group', { name: 'Preset lengths' }))
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(labels).toEqual(['15', '30', '45', '60', '90'])
  })

  it('passes the typed length', async () => {
    const { onStart } = setup()
    typeDuration('50')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toEqual({ mode: 'countdown', minutes: 50 })
  })

  it('ties the validation message to the field and says it politely', () => {
    setup()
    const input = duration()
    typeDuration('0')
    const messages = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(messages).toHaveAttribute('aria-live', 'polite')
    expect(messages).toHaveTextContent('Must be a whole number of minutes from 1 to 240.')
    typeDuration('30')
    expect(messages).toBeEmptyDOMElement()
  })
})

describe('SessionSetup summary line', () => {
  const NOON = new Date(2026, 10, 1, 14, 5, 0).getTime()
  const line = () => screen.getByTestId('dial-line')

  it.each([
    ['en-US', 'minutes under an hour', '30', '30m → 2:35 pm'],
    ['en-US', 'a whole hour', '60', '1h → 3:05 pm'],
    ['en-US', 'an hour and some', '95', '1h 35m → 3:40 pm'],
    ['en-US', 'the most', '240', '4h → 6:05 pm'],
    ['en-GB', 'a 24-hour locale', '30', '30m → 14:35'],
    ['de-DE', 'another 24-hour locale', '95', '1h 35m → 15:40'],
  ])('%s, %s: %s gives %s', (locale, _what, minutes, expected) => {
    vi.useFakeTimers({ now: NOON })
    setup(new MemoryPreferencesStore(), locale)
    typeDuration(minutes)
    expect(line()).toHaveTextContent(expected)
  })

  it('gives the whole Pomodoro: focus blocks and breaks, no break after the last block', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 1, 14, 15).getTime() })
    setup()
    chooseMode('Pomodoro')
    // 4 × 25 + 3 × 5 = 115 minutes.
    expect(line()).toHaveTextContent('1h 55m → 4:10 pm')
  })

  it('counts the long break after the 4th block, and not before it', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 1, 9, 0).getTime() })
    setup()
    chooseMode('Pomodoro')
    // Five blocks: 5 × 25 + 4 × 5 = 145 minutes.
    click('One block more')
    expect(line()).toHaveTextContent('2h 25m → 11:25 am')
    fireEvent.click(screen.getByRole('switch'))
    // The break after block 4 is the 15-minute long one: 125 + 3 × 5 + 15 = 155 minutes.
    expect(line()).toHaveTextContent('2h 35m → 11:35 am')
    click('One block fewer')
    // Four blocks: the long break would follow the last one, so there is none.
    expect(line()).toHaveTextContent('1h 55m → 10:55 am')
  })

  it('refreshes the end time without announcing it', () => {
    vi.useFakeTimers({ now: NOON })
    setup()
    const live = screen.getByRole('status')
    expect(line()).toHaveTextContent('30m → 2:35 pm')
    expect(live).toHaveTextContent('30m, ends at 2:35 pm')
    act(() => {
      vi.advanceTimersByTime(CLOCK_REFRESH_MS * 3)
    })
    expect(line()).toHaveTextContent('30m → 2:36 pm')
    // What a screen reader hears is unchanged until the user changes something.
    expect(live).toHaveTextContent('30m, ends at 2:35 pm')
    typeDuration('45')
    expect(live).toHaveTextContent('45m, ends at 2:51 pm')
  })

  it('keeps one status region through a mode change and updates its text', () => {
    setup()
    const live = screen.getByRole('status')
    expect(live).toHaveTextContent(/^30m, ends at /)
    chooseMode('Pomodoro')
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toHaveTextContent(/^1h 55m, ends at /)
    chooseMode('Unlimited')
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toHaveTextContent('no reminders')
    chooseMode('Countdown')
    expect(screen.getByRole('status')).toBe(live)
    expect(live).toHaveTextContent(/^30m, ends at /)
  })

  it('speaks the arrow as "ends at" in the status region only', () => {
    setup()
    expect(screen.getByRole('status').textContent).not.toContain('→')
    expect(screen.getByTestId('dial-line').textContent).toContain('→')
  })

  it('is a polite live region and hides its drawn copy from screen readers', () => {
    setup()
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(line()).toHaveAttribute('aria-hidden', 'true')
  })

  it('hides the ring from screen readers', () => {
    setup()
    expect(document.querySelector('.dial-ring')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('SessionSetup ring', () => {
  const arcs = () => [...document.querySelectorAll('.dial-arc')]

  it('fills minutes / 60 of a lap with a square end', () => {
    setup()
    expect(arcs()).toHaveLength(1)
    const [arc] = arcs()
    const circumference = 2 * Math.PI * 104
    expect(arc?.getAttribute('stroke-dasharray')?.split(' ')[0]).toBe(
      (circumference / 2).toFixed(3),
    )
    expect(arc).toHaveClass('dial-arc-accent')
    expect(arc?.getAttribute('stroke-linecap')).toBeNull()
  })

  it('alternates the lap shade past 60 minutes', () => {
    setup()
    typeDuration('90')
    expect(arcs().map((a) => a.getAttribute('class'))).toEqual([
      'dial-arc dial-arc-accent',
      'dial-arc dial-arc-light',
    ])
    typeDuration('150')
    expect(arcs().map((a) => a.getAttribute('class'))).toEqual([
      'dial-arc dial-arc-light',
      'dial-arc dial-arc-accent',
    ])
  })

  it('draws no arc for an unreadable length', () => {
    setup()
    typeDuration('abc')
    expect(arcs()).toHaveLength(0)
  })

  it('draws a Pomodoro as focus arcs only, the breaks left as the track', () => {
    setup()
    chooseMode('Pomodoro')
    expect(arcs()).toHaveLength(4)
    expect(arcs().every((a) => a.classList.contains('dial-arc-accent'))).toBe(true)
  })

  it('draws the Unlimited ticks for the reminder interval', () => {
    setup()
    chooseMode('Unlimited')
    const ticks = () => document.querySelectorAll('.dial-tick').length
    expect(ticks()).toBe(0)
    for (const [value, count] of [
      ['15', 4],
      ['30', 2],
      ['45', 2],
      ['60', 1],
      ['90', 1],
      ['120', 1],
    ] as const) {
      fireEvent.click(screen.getByRole('radio', { name: `${value} minutes` }))
      expect(ticks(), value).toBe(count)
    }
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(ticks()).toBe(0)
  })
})

describe('SessionSetup Pomodoro', () => {
  it('shows the remembered defaults and validates the typed focus length', () => {
    setup()
    chooseMode('Pomodoro')
    expect(screen.getByLabelText('Focus length in minutes, 5 to 90')).toHaveValue('25')
    expect(screen.getByText('5 min')).toBeInTheDocument()
    expect(screen.queryByLabelText('Long break in minutes, 5 to 60')).not.toBeInTheDocument()
    for (const bad of ['4', '91', '', 'x']) {
      typeFocus(bad)
      expect(start()).toBeDisabled()
    }
    typeFocus('52')
    expect(start()).toBeEnabled()
  })

  it.each([
    [52, 'Focus, 5 minutes less', 50],
    [52, 'Focus, 5 minutes more', 55],
    [5, 'Focus, 5 minutes less', 5],
    [90, 'Focus, 5 minutes more', 90],
    [88, 'Focus, 5 minutes more', 90],
  ])('from a focus of %i, "%s" gives %i', (from, button, to) => {
    setup()
    chooseMode('Pomodoro')
    typeFocus(String(from))
    click(button)
    expect(screen.getByLabelText('Focus length in minutes, 5 to 90')).toHaveValue(String(to))
  })

  it('steps Break and Blocks by one within their ranges', () => {
    setup()
    chooseMode('Pomodoro')
    for (let i = 0; i < 6; i++) click('Break, 1 minute less')
    expect(screen.getByText('1 min')).toBeInTheDocument()
    click('Break, 1 minute more')
    expect(screen.getByText('2 min')).toBeInTheDocument()
    for (let i = 0; i < 40; i++) click('Break, 1 minute more')
    expect(screen.getByText('30 min')).toBeInTheDocument()
    for (let i = 0; i < 9; i++) click('One block more')
    expect(screen.getByText('8')).toBeInTheDocument()
    for (let i = 0; i < 9; i++) click('One block fewer')
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('keeps a typed focus length as typed', async () => {
    const { onStart } = setup()
    chooseMode('Pomodoro')
    typeFocus('52')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toMatchObject({
      mode: 'pomodoro',
      focusMinutes: 52,
    })
  })

  it('shows the long break length row only while the switch is on, typeable and snapping', async () => {
    const { onStart } = setup()
    chooseMode('Pomodoro')
    const toggle = screen.getByRole('switch', { name: /long break/i })
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)
    const length = screen.getByLabelText('Long break in minutes, 5 to 60')
    expect(length).toHaveValue('15')
    fireEvent.change(length, { target: { value: '17' } })
    expect(start()).toBeEnabled()
    click('Long break, 5 minutes more')
    expect(length).toHaveValue('20')
    fireEvent.change(length, { target: { value: '17' } })
    click('Long break, 5 minutes less')
    expect(length).toHaveValue('15')
    fireEvent.change(length, { target: { value: '4' } })
    expect(start()).toBeDisabled()
    fireEvent.change(length, { target: { value: '17' } })
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toMatchObject({
      longBreakEnabled: true,
      longBreakMinutes: 17,
    })
  })

  it('starts with the remembered length after the long break is cleared then switched off', async () => {
    const { onStart } = setup()
    chooseMode('Pomodoro')
    const toggle = screen.getByRole('switch', { name: /long break/i })
    fireEvent.click(toggle)
    fireEvent.change(screen.getByLabelText('Long break in minutes, 5 to 60'), {
      target: { value: '' },
    })
    expect(start()).toBeDisabled()
    fireEvent.click(toggle)
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toMatchObject({
      longBreakEnabled: false,
      longBreakMinutes: 15,
    })
  })

  it('defaults to the remembered tag and Pomodoro config', () => {
    setup(
      new MemoryPreferencesStore({
        tag: 'study',
        pomodoro: { ...DEFAULT_PREFERENCES.pomodoro, focusMinutes: 50, longBreakEnabled: true },
      }),
    )
    expect(screen.getByRole('button', { name: /^Tag\b.*Study/ })).toBeInTheDocument()
    chooseMode('Pomodoro')
    expect(screen.getByLabelText('Focus length in minutes, 5 to 90')).toHaveValue('50')
    expect(screen.getByRole('switch', { name: /long break/i })).toBeChecked()
  })

  it('remembers the tag and Pomodoro config when a session starts', async () => {
    const { onStart, preferences } = setup()
    chooseMode('Pomodoro')
    pickTag('Read')
    typeFocus('40')
    click('One block fewer')
    click('One block fewer')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(preferences.load()).toEqual({
      tag: 'read',
      pomodoro: { ...DEFAULT_PREFERENCES.pomodoro, focusMinutes: 40, blocks: 2 },
    })
  })

  it('keeps the remembered Pomodoro config when a countdown is started', async () => {
    const remembered = { tag: 'nap', pomodoro: DEFAULT_PREFERENCES.pomodoro }
    const { onStart, preferences } = setup(
      new MemoryPreferencesStore({
        ...remembered,
        pomodoro: { ...remembered.pomodoro, focusMinutes: 50 },
      }),
    )
    pickTag('Meditation')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(preferences.load().tag).toBe('meditation')
    expect(preferences.load().pomodoro.focusMinutes).toBe(50)
  })
})

describe('SessionSetup Unlimited', () => {
  it('has no steppers, shows ∞ and the reminder, off by default', async () => {
    const { onStart } = setup()
    chooseMode('Unlimited')
    expect(screen.queryByRole('button', { name: /minutes (less|more)/ })).not.toBeInTheDocument()
    expect(screen.getByText('no time limit')).toBeInTheDocument()
    expect(screen.getByTestId('dial-line')).toHaveTextContent('no reminders')
    expect(screen.getByRole('radio', { name: 'Off' })).toBeChecked()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toEqual({ mode: 'unlimited', reminderMinutes: null })
  })

  it('offers Off, 15, 30, 45, 60, 90 and 120 under "Remind me every"', () => {
    setup()
    chooseMode('Unlimited')
    const group = screen.getByRole('group', { name: 'Remind me every' })
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Off', '15', '30', '45', '60', '90', '120'])
  })

  it.each([
    ['15', 'chime every 15m', 15],
    ['30', 'chime every 30m', 30],
    ['90', 'chime every 1h 30m', 90],
    ['120', 'chime every 2h', 120],
  ])('passes %s and says "%s" under the dial', async (value, text, minutes) => {
    const { onStart } = setup()
    chooseMode('Unlimited')
    fireEvent.click(screen.getByRole('radio', { name: `${value} minutes` }))
    expect(screen.getByTestId('dial-line')).toHaveTextContent(text)
    expect(screen.getByRole('status')).toHaveTextContent(text)
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toEqual({
      mode: 'unlimited',
      reminderMinutes: minutes,
    })
  })

  it('preselects the Settings default reminder', () => {
    const onStart = vi.fn()
    render(
      <SessionSetup
        preferences={new MemoryPreferencesStore()}
        defaultReminderMinutes={45}
        onStart={onStart}
      />,
    )
    chooseMode('Unlimited')
    expect(screen.getByRole('radio', { name: '45 minutes' })).toBeChecked()
  })

  it('keeps each mode’s values when switching between modes', () => {
    setup()
    typeDuration('50')
    chooseMode('Pomodoro')
    typeFocus('40')
    chooseMode('Countdown')
    expect(duration()).toHaveValue('50')
    chooseMode('Pomodoro')
    expect(screen.getByLabelText('Focus length in minutes, 5 to 90')).toHaveValue('40')
  })
})

describe('SessionSetup Tag & goal sheet', () => {
  it('opens from the Tag row with the tags as a labelled radio group and Work chosen', () => {
    setup()
    const sheet = openSheet('Tag')
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    expect(within(sheet).getByRole('heading', { name: 'Tag & goal' })).toBeInTheDocument()
    const tags = within(sheet).getByRole('group', { name: 'Tag' })
    expect(within(tags).getAllByRole('radio')).toHaveLength(6)
    expect(within(tags).getByRole('radio', { name: 'Work' })).toBeChecked()
    for (const name of ['Study', 'Nap', 'Read', 'Meditation', 'Exercise']) {
      expect(within(tags).getByRole('radio', { name })).not.toBeChecked()
    }
  })

  it('lists the six built-in tags in order', () => {
    setup()
    const sheet = openSheet('Tag')
    expect(
      within(sheet)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent),
    ).toEqual(['Work', 'Study', 'Nap', 'Read', 'Meditation', 'Exercise'])
  })

  it('chooses a tag and shows it on the row', async () => {
    const { onStart } = setup()
    pickTag('Study')
    expect(screen.getByRole('button', { name: /^Tag\b.*Study/ })).toBeInTheDocument()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].tag).toBe('study')
  })

  it('has a goal field labelled Goal, marked optional, with a prompt and a counter', () => {
    setup()
    const sheet = openSheet('Tag')
    const goal = within(sheet).getByLabelText('Goal')
    expect(goal).toHaveAttribute('placeholder', 'What are you focusing on?')
    expect(goal).toHaveAttribute('maxlength', '120')
    expect(sheet).toHaveTextContent('Optional')
    const counter = document.getElementById(
      goal.getAttribute('aria-describedby')?.split(' ')[1] ?? '',
    )
    expect(counter).toHaveTextContent('0/120')
    fireEvent.change(goal, { target: { value: 'Write' } })
    expect(counter).toHaveTextContent('5/120')
  })

  it('limits the goal to 120 characters and trims it', async () => {
    const { onStart } = setup()
    typeGoal('  write the report  ')
    expect(screen.getByRole('button', { name: /^Goal\b.*write the report/ })).toBeInTheDocument()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].goal).toBe('write the report')
  })

  it('opens from the Goal row with the goal field focused', () => {
    setup()
    const sheet = openSheet('Goal')
    expect(within(sheet).getByLabelText('Goal')).toHaveFocus()
  })

  it('closes with Done, Escape and a tap on the backdrop, and returns focus to its row', () => {
    setup()
    const tagRow = screen.getByRole('button', { name: /^Tag\b/ })
    const goalRow = screen.getByRole('button', { name: /^Goal\b/ })
    openSheet('Tag')
    closeSheet()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tagRow).toHaveFocus()

    openSheet('Tag')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tagRow).toHaveFocus()

    openSheet('Goal')
    fireEvent.click(document.querySelector('.sheet-backdrop') as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(goalRow).toHaveFocus()
  })

  it('keeps the choices when it closes', () => {
    setup()
    pickTag('Nap')
    typeGoal('Rest')
    const sheet = openSheet('Tag')
    expect(within(sheet).getByRole('radio', { name: 'Nap' })).toBeChecked()
    expect(within(sheet).getByLabelText('Goal')).toHaveValue('Rest')
  })

  it('traps Tab inside the sheet', () => {
    setup()
    const sheet = openSheet('Tag')
    const done = within(sheet).getByRole('button', { name: 'Done' })
    const first = sheet.querySelector<HTMLElement>('input[type=radio]') as HTMLElement
    done.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // Done is not the last control (the goal field comes after the tags), so Tab is left alone.
    const goal = within(sheet).getByLabelText('Goal')
    goal.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first.closest('.sheet')).toBe(sheet)
    expect(sheet.contains(document.activeElement)).toBe(true)
    // Shift+Tab on the first control wraps to the last.
    const firstFocusable = sheet.querySelector<HTMLElement>('a[href], button, input') as HTMLElement
    firstFocusable.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(goal)
    // Tab on the last wraps to the first.
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(firstFocusable)
  })

  it.each(['None', 'Rain'] as const)(
    'traps Tab in the Sound sheet with %s chosen, forward and back',
    (choice) => {
      setup()
      pickSound(choice)
      const sheet = openSheet('Sound')
      const done = within(sheet).getByRole('button', { name: 'Done' })
      const checked = within(sheet).getByRole('radio', { name: choice })
      checked.focus()
      fireEvent.keyDown(document, { key: 'Tab' })
      expect(document.activeElement).toBe(done)
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(checked)
    },
  )

  it('does not start the session when Enter is pressed in the goal field', () => {
    const { onStart } = setup()
    const sheet = openSheet('Goal')
    fireEvent.keyDown(within(sheet).getByLabelText('Goal'), { key: 'Enter' })
    expect(onStart).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows Manage tags only when it is given a way to open Settings and someone is signed in', () => {
    const onManageTags = vi.fn()
    render(
      <SessionSetup
        preferences={new MemoryPreferencesStore()}
        onStart={vi.fn()}
        onManageTags={onManageTags}
      />,
    )
    const sheet = openSheet('Tag')
    fireEvent.click(within(sheet).getByRole('link', { name: 'Manage tags' }))
    expect(onManageTags).toHaveBeenCalledOnce()
  })

  it('has no Manage tags link without a way to open Settings', () => {
    setup()
    openSheet('Tag')
    expect(screen.queryByRole('link', { name: 'Manage tags' })).not.toBeInTheDocument()
  })
})

describe('SessionSetup Sound sheet', () => {
  it('offers None, Rain and YouTube, shows the choice with its icon and passes it', async () => {
    const { onStart } = setup()
    const sheet = openSheet('Sound')
    expect(within(sheet).getByRole('heading', { name: 'Sound' })).toBeInTheDocument()
    expect(within(sheet).getByRole('radio', { name: 'None' })).toBeChecked()
    fireEvent.click(within(sheet).getByRole('radio', { name: 'Rain' }))
    closeSheet()
    const row = screen.getByRole('button', { name: /^Sound\b.*Rain/ })
    expect(row.querySelector('.row-sound-icon svg')).not.toBeNull()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].audio).toBe('rain')
  })

  it('closes with Escape and returns focus to the Sound row', () => {
    setup()
    openSheet('Sound')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Sound\b/ })).toHaveFocus()
  })

  it('keeps Start blocked, with a reason, until a YouTube link will play', () => {
    setup()
    pickSound('YouTube')
    expect(start()).toBeDisabled()
    const hint = document.getElementById(start().getAttribute('aria-describedby') ?? '')
    expect(hint).toHaveTextContent(/YouTube link/)
    pickSound('None')
    expect(start()).toBeEnabled()
  })
})

describe('SessionSetup starting', () => {
  it('shows why a session could not be started', async () => {
    const onStart = vi.fn().mockRejectedValue(new Error('A session is already active'))
    render(<SessionSetup preferences={new MemoryPreferencesStore()} onStart={onStart} />)
    fireEvent.click(start())
    expect(await screen.findByRole('alert')).toHaveTextContent('A session is already active')
  })

  it('does not update the remembered settings when the start fails', async () => {
    const preferences = new MemoryPreferencesStore()
    const onStart = vi.fn().mockRejectedValue(new Error('nope'))
    render(<SessionSetup preferences={preferences} onStart={onStart} />)
    pickTag('Study')
    fireEvent.click(start())
    await screen.findByRole('alert')
    expect(preferences.load().tag).toBe('work')
  })

  it('disables Start while starting', async () => {
    let finish: () => void = () => undefined
    const onStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    render(<SessionSetup preferences={new MemoryPreferencesStore()} onStart={onStart} />)
    fireEvent.click(start())
    await waitFor(() => expect(start()).toBeDisabled())
    await act(async () => {
      finish()
    })
    expect(start()).toBeEnabled()
  })
})

describe('SessionSetup after a start', () => {
  it('begins the next setup from what the session saved', async () => {
    const preferences = new MemoryPreferencesStore()
    const onStart = vi.fn()
    const first = render(<SessionSetup preferences={preferences} onStart={onStart} />)
    chooseMode('Pomodoro')
    typeFocus('40')
    fireEvent.click(start())
    await waitFor(() => expect(preferences.load().pomodoro.focusMinutes).toBe(40))
    await waitFor(() => expect(start()).toBeEnabled())
    // The next setup shows 40; typing 40 again is not a change from where it began.
    chooseMode('Pomodoro')
    typeFocus('40')
    chooseMode('Countdown')
    expect(document.querySelector('form')).not.toHaveAttribute('data-holds-update')
    chooseMode('Pomodoro')
    typeFocus('45')
    chooseMode('Countdown')
    expect(document.querySelector('form')).toHaveAttribute('data-holds-update')
    first.unmount()
  })
})

describe('SessionSetup touch targets', () => {
  it('gives every control on the screen a class that sizes it to at least 44 px', () => {
    setup()
    // The sizes live in the stylesheet (layout.test.ts reads them); here the markup must use them.
    for (const el of document.querySelectorAll(
      '.step-button, .preset, .row-button, .start-button',
    )) {
      expect(el.tagName).toBe('BUTTON')
    }
  })
})

describe('cleanGoal', () => {
  it('replaces line breaks with a single space (AC7.3)', () => {
    expect(cleanGoal('write\nthe\r\nreport')).toBe('write the report')
  })
})
