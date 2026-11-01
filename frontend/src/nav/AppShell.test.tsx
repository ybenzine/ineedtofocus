import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnonymousContext, type AnonymousUse } from '../anonymous/AnonymousContext.ts'
import { AccountContext } from '../auth/AccountContext.tsx'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import AppShell from './AppShell.tsx'
import { WIDE_QUERY } from './useWideScreen.ts'

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

const controller = () =>
  new TimerController({ store: new LocalActiveSessionStore(), saveRecord: () => Promise.resolve() })

function stubWidth(wide: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === WIDE_QUERY && wide,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

function renderShell(options: {
  email?: string
  anonymous?: boolean
  current?: 'setup' | 'history'
}) {
  const onNavigate = vi.fn()
  const anonymous: AnonymousUse = {
    held: {} as AnonymousUse['held'],
    openForm: vi.fn(),
  }
  const shell = (
    <AppShell
      current={options.current ?? 'setup'}
      controller={controller()}
      onNavigate={onNavigate}
    >
      <p>content</p>
    </AppShell>
  )
  const withAccount = options.email ? (
    <AccountContext.Provider
      value={{
        user: { id: 'u1', email: options.email, created_at: '2026-10-23T00:00:00Z' },
        expired: false,
        leaveExpired: () => undefined,
        signOut: () => Promise.resolve(null),
        accountDeleted: () => Promise.resolve(),
      }}
    >
      {shell}
    </AccountContext.Provider>
  ) : (
    shell
  )
  render(
    options.anonymous ? (
      <AnonymousContext.Provider value={anonymous}>{withAccount}</AnonymousContext.Provider>
    ) : (
      withAccount
    ),
  )
  return { onNavigate, anonymous }
}

describe('header (#406)', () => {
  it('shows the wordmark and only Log in without an account', () => {
    const { anonymous } = renderShell({ anonymous: true })
    const header = screen.getByRole('banner')
    expect(within(header).getByText('I Need To Focus')).toBeInTheDocument()
    expect(within(header).queryByRole('link', { name: 'Create account' })).not.toBeInTheDocument()
    fireEvent.click(within(header).getByRole('link', { name: 'Log in' }))
    expect(anonymous.openForm).toHaveBeenCalledWith('signin', 'screen')
    expect(screen.queryByRole('heading', { name: 'I Need To Focus' })).not.toBeInTheDocument()
  })

  it('shows an account button labelled with the email and its first letter', () => {
    renderShell({ email: 'ada@example.com' })
    const button = screen.getByRole('button', { name: 'ada@example.com' })
    expect(button).toHaveTextContent('A')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('opens a menu with the email and Sign out, and closes on Escape with focus back', () => {
    renderShell({ email: 'ada@example.com' })
    const button = screen.getByRole('button', { name: 'ada@example.com' })
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('group', { name: 'Account' })
    expect(within(menu).getByText('ada@example.com')).toBeInTheDocument()
    const signOut = within(menu).getByRole('button', { name: 'Sign out' })
    signOut.focus()
    fireEvent.keyDown(signOut, { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument()
    expect(button).toHaveFocus()
  })

  it('closes the menu on a click outside it', () => {
    renderShell({ email: 'ada@example.com' })
    fireEvent.click(screen.getByRole('button', { name: 'ada@example.com' }))
    fireEvent.pointerDown(screen.getByText('content'))
    expect(screen.queryByRole('group', { name: 'Account' })).not.toBeInTheDocument()
  })
})

describe('bottom tab bar on phones (#406)', () => {
  it('has the four screens in a nav labelled Screens, after the content', () => {
    const { onNavigate } = renderShell({ email: 'a@b.co', current: 'history' })
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    const tabs = within(nav).getAllByRole('button')
    expect(tabs.map((t) => t.textContent)).toEqual(['New', 'History', 'Archive', 'Settings'])
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'New session',
      'History',
      'Archive',
      'Settings',
    ])
    expect(nav.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(4)
    expect(within(nav).getByRole('button', { name: 'History' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(tabs.filter((t) => t.hasAttribute('aria-current'))).toHaveLength(1)
    fireEvent.click(within(nav).getByRole('button', { name: 'New session' }))
    expect(onNavigate).toHaveBeenCalledWith('setup')
    // Focus order: header, content, tab bar.
    const header = screen.getByRole('banner')
    const main = screen.getByRole('main')
    expect(header.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(main.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(nav.className).toBe('tab-bar')
  })
})

describe('text tabs in the header on wide screens (#406)', () => {
  it('moves the same four destinations into the header, with no bottom bar', () => {
    stubWidth(true)
    renderShell({ email: 'a@b.co', current: 'setup' })
    const nav = screen.getByRole('navigation', { name: 'Screens' })
    expect(screen.getAllByRole('navigation')).toHaveLength(1)
    expect(screen.getByRole('banner')).toContainElement(nav)
    expect(
      within(nav)
        .getAllByRole('button')
        .map((t) => t.textContent),
    ).toEqual(['New session', 'History', 'Archive', 'Settings'])
    expect(within(nav).getByRole('button', { name: 'New session' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(nav.querySelector('svg')).toBeNull()
  })
})
