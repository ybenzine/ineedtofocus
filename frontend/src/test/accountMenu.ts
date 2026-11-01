import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'

/** Opens the header's account menu (#406) if it is closed. */
export function openAccountMenu(): void {
  const button = document.querySelector<HTMLElement>('.account-button')
  if (!button) throw new Error('no account button')
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button)
}

/** The menu's Sign out button, opening the menu first. */
export function signOutButton(): HTMLElement {
  openAccountMenu()
  return screen.getByRole('button', { name: 'Sign out' })
}

/** Waits for the account button, then returns the menu's Sign out button. */
export async function findSignOutButton(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('.account-button')).not.toBeNull())
  return signOutButton()
}
