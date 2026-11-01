// Drives the New session screen (#407) in component tests: modes, the dial, and the two sheets.

import { fireEvent, screen, within } from '@testing-library/react'

/** Picks Countdown, Pomodoro or Unlimited. */
export function chooseMode(name: 'Countdown' | 'Pomodoro' | 'Unlimited'): void {
  fireEvent.click(screen.getByRole('radio', { name }))
}

/** Types a Countdown length into the dial. */
export function typeDuration(text: string): void {
  fireEvent.change(screen.getByLabelText('Duration in minutes, 1 to 240'), {
    target: { value: text },
  })
}

export function startButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Start' })
}

export function openSheet(row: 'Tag' | 'Goal' | 'Sound'): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${row}\\b`) }))
  return screen.getByRole('dialog')
}

export function closeSheet(): void {
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Done' }))
}

/** Opens Tag & goal, picks a tag by its name and closes the sheet. */
export function pickTag(name: string): void {
  const sheet = openSheet('Tag')
  fireEvent.click(within(sheet).getByRole('radio', { name }))
  closeSheet()
}

/** Opens Tag & goal, types the goal and closes the sheet. */
export function typeGoal(text: string): void {
  const sheet = openSheet('Goal')
  fireEvent.change(within(sheet).getByLabelText('Goal'), { target: { value: text } })
  closeSheet()
}

/** Opens Sound and picks a source; the sheet stays open for the YouTube field. */
export function pickSoundOpen(name: 'None' | 'Rain' | 'YouTube'): HTMLElement {
  const sheet = openSheet('Sound')
  fireEvent.click(within(sheet).getByRole('radio', { name }))
  return sheet
}

/** Opens Sound, picks a source and closes the sheet. */
export function pickSound(name: 'None' | 'Rain' | 'YouTube'): void {
  pickSoundOpen(name)
  closeSheet()
}
