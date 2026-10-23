import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PREFERENCES, MemoryPreferencesStore, parsePreferences } from './preferences.ts'
import SessionSetup, { type SessionRequest } from './SessionSetup.tsx'

function setup(preferences = new MemoryPreferencesStore()) {
  const onStart = vi.fn<(request: SessionRequest) => void>()
  render(<SessionSetup preferences={preferences} onStart={onStart} />)
  return { onStart, preferences }
}

const start = () => screen.getByRole('button', { name: 'Start' })
const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
const pick = (name: string) => fireEvent.click(screen.getByRole('radio', { name }))

describe('SessionSetup', () => {
  it('starts a 25 minute countdown with Work and no audio by default', async () => {
    const { onStart } = setup()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0]).toEqual({
      config: { mode: 'countdown', minutes: 25 },
      tag: 'work',
      goal: null,
      audio: 'none',
    })
  })

  it.each(['0', '241', '1.5', '', 'abc'])('blocks a countdown of "%s"', (value) => {
    setup()
    type('Duration', value)
    expect(start()).toBeDisabled()
    expect(screen.getByLabelText('Duration')).toHaveAttribute('aria-invalid', 'true')
  })

  it.each(['1', '240'])('accepts a countdown of %s', (value) => {
    setup()
    type('Duration', value)
    expect(start()).toBeEnabled()
  })

  it('shows Pomodoro defaults and validates every field', () => {
    setup()
    pick('Pomodoro')
    expect(screen.getByLabelText('Focus')).toHaveValue('25')
    expect(screen.getByLabelText('Short break')).toHaveValue('5')
    expect(screen.getByLabelText('Focus blocks')).toHaveValue('4')
    expect(screen.queryByLabelText('Long break')).not.toBeInTheDocument()
    for (const [label, bad] of [
      ['Focus', '4'],
      ['Focus', '91'],
      ['Short break', '0'],
      ['Short break', '31'],
      ['Focus blocks', '9'],
    ] as const) {
      type(label, bad)
      expect(start()).toBeDisabled()
      type('Focus', '25')
      type('Short break', '5')
      type('Focus blocks', '4')
    }
    expect(start()).toBeEnabled()
  })

  it('validates the long break only while it is on', () => {
    setup()
    pick('Pomodoro')
    fireEvent.click(screen.getByRole('checkbox', { name: /long break/i }))
    expect(screen.getByLabelText('Long break')).toHaveValue('15')
    type('Long break', '4')
    expect(start()).toBeDisabled()
    type('Long break', '60')
    expect(start()).toBeEnabled()
  })

  it('offers reminders for the unlimited timer, off by default', async () => {
    const { onStart } = setup()
    pick('Unlimited')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toEqual({ mode: 'unlimited', reminderMinutes: null })
  })

  it('passes the chosen reminder interval', async () => {
    const { onStart } = setup()
    pick('Unlimited')
    fireEvent.change(screen.getByLabelText('Reminder'), { target: { value: '45' } })
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toEqual({ mode: 'unlimited', reminderMinutes: 45 })
  })

  it('offers exactly the six tags and defaults to Work', () => {
    setup()
    const tags = screen
      .getByRole('group', { name: 'Tag' })
      .querySelectorAll<HTMLInputElement>('input[type=radio]')
    expect(tags).toHaveLength(6)
    expect(screen.getByRole('radio', { name: 'Work' })).toBeChecked()
    for (const name of ['Study', 'Nap', 'Read', 'Meditation', 'Exercise']) {
      expect(screen.getByRole('radio', { name })).not.toBeChecked()
    }
  })

  it('limits the goal to 120 characters and trims it', async () => {
    const { onStart } = setup()
    expect(screen.getByLabelText(/what are you focusing on/i)).toHaveAttribute('maxlength', '120')
    fireEvent.change(screen.getByLabelText(/what are you focusing on/i), {
      target: { value: '  write the report  ' },
    })
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].goal).toBe('write the report')
  })

  it('offers None, Rain and YouTube and passes the choice', async () => {
    const { onStart } = setup()
    expect(screen.getByRole('radio', { name: 'None' })).toBeChecked()
    pick('Rain')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].audio).toBe('rain')
    expect(screen.getByRole('radio', { name: 'YouTube' })).toBeInTheDocument()
  })

  it('defaults to the remembered tag and Pomodoro config', () => {
    setup(
      new MemoryPreferencesStore({
        tag: 'study',
        pomodoro: { ...DEFAULT_PREFERENCES.pomodoro, focusMinutes: 50, longBreakEnabled: true },
      }),
    )
    expect(screen.getByRole('radio', { name: 'Study' })).toBeChecked()
    pick('Pomodoro')
    expect(screen.getByLabelText('Focus')).toHaveValue('50')
    expect(screen.getByRole('checkbox', { name: /long break/i })).toBeChecked()
  })

  it('remembers the tag and Pomodoro config when a session starts', async () => {
    const { onStart, preferences } = setup()
    pick('Pomodoro')
    pick('Read')
    type('Focus', '40')
    type('Focus blocks', '2')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(preferences.load()).toEqual({
      tag: 'read',
      pomodoro: { ...DEFAULT_PREFERENCES.pomodoro, focusMinutes: 40, blocks: 2 },
    })
  })

  it('keeps the remembered Pomodoro config when a countdown is started', async () => {
    const remembered = { tag: 'nap' as const, pomodoro: DEFAULT_PREFERENCES.pomodoro }
    const { onStart, preferences } = setup(
      new MemoryPreferencesStore({
        ...remembered,
        pomodoro: { ...remembered.pomodoro, focusMinutes: 50 },
      }),
    )
    pick('Meditation')
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(preferences.load().tag).toBe('meditation')
    expect(preferences.load().pomodoro.focusMinutes).toBe(50)
  })

  it('shows why a session could not be started', async () => {
    const onStart = vi.fn().mockRejectedValue(new Error('A session is already active'))
    render(<SessionSetup preferences={new MemoryPreferencesStore()} onStart={onStart} />)
    fireEvent.click(start())
    expect(await screen.findByRole('alert')).toHaveTextContent('A session is already active')
  })
})

describe('SessionSetup long break', () => {
  it('starts with the remembered length after the long break is cleared then switched off', async () => {
    const { onStart } = setup()
    pick('Pomodoro')
    const box = screen.getByRole('checkbox', { name: /long break/i })
    fireEvent.click(box)
    type('Long break', '')
    fireEvent.click(box)
    expect(start()).toBeEnabled()
    fireEvent.click(start())
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce())
    expect(onStart.mock.calls[0]?.[0].config).toMatchObject({
      longBreakEnabled: false,
      longBreakMinutes: 15,
    })
  })

  it('does not update the remembered settings when the start fails', async () => {
    const preferences = new MemoryPreferencesStore()
    const onStart = vi.fn().mockRejectedValue(new Error('nope'))
    render(<SessionSetup preferences={preferences} onStart={onStart} />)
    pick('Study')
    fireEvent.click(start())
    await screen.findByRole('alert')
    expect(preferences.load().tag).toBe('work')
  })
})

describe('SessionSetup accessibility', () => {
  it('announces validation hints politely and ties them to their field', () => {
    setup()
    const duration = screen.getByLabelText('Duration')
    const hint = document.getElementById(duration.getAttribute('aria-describedby') ?? '')
    expect(hint).toHaveAttribute('aria-live', 'polite')
    expect(hint).toHaveTextContent('1–240 min')
    type('Duration', '0')
    expect(hint).toHaveTextContent(/./)
    expect(duration).toHaveAttribute('aria-invalid', 'true')
  })

  it('ties the goal field to its character counter', () => {
    setup()
    const goal = screen.getByLabelText('What are you focusing on? (optional)')
    const counter = document.getElementById(goal.getAttribute('aria-describedby') ?? '')
    expect(counter).toHaveTextContent('0/120')
    fireEvent.change(goal, { target: { value: 'Write' } })
    expect(counter).toHaveTextContent('5/120')
  })
})

describe('parsePreferences', () => {
  it('falls back to Work and the defaults for missing or corrupt data', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES)
    expect(parsePreferences('not json')).toEqual(DEFAULT_PREFERENCES)
    expect(
      parsePreferences(JSON.stringify({ tag: 'party', pomodoro: { focusMinutes: 1 } })),
    ).toEqual(DEFAULT_PREFERENCES)
  })
})
