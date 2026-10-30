import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SETTINGS_KEY } from '../settings/store.ts'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import { AccountError, type AccountApi } from './accountApi.ts'
import AccountSection from './AccountSection.tsx'
import { type AuthApi, type User } from './api.ts'
import AuthGate, { ACCOUNT_DELETED_NOTICE } from './AuthGate.tsx'
import { registerLocalDataHook, SESSION_EXPIRED_EVENT, USER_KEY } from './localData.ts'

const user: User = { id: 'u1', email: 'a@b.co', created_at: '2026-10-30T00:00:00Z' }
const unregisters: (() => void)[] = []

function makeAccountApi(overrides: Partial<AccountApi> = {}): AccountApi {
  return {
    exportData: vi.fn().mockResolvedValue({
      blob: new Blob(['{}'], { type: 'application/json' }),
      filename: 'ineedtofocus-export-2026-10-30.json',
    }),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    sessionCount: vi.fn().mockResolvedValue(7),
    ...overrides,
  }
}

function makeAuthApi(): AuthApi {
  return {
    me: vi.fn().mockResolvedValue(user),
    signUp: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn().mockResolvedValue(undefined),
  }
}

/** A registered hook standing in for the session store: what sign-out would clear. */
function registerHook(unsynced = { sessions: 0, edits: 0 }) {
  const hook = {
    trySync: vi.fn(async () => undefined),
    countUnsynced: vi.fn(async () => unsynced),
    clear: vi.fn(async () => undefined),
  }
  unregisters.push(registerLocalDataHook(hook))
  return hook
}

async function renderSection(api: AccountApi) {
  render(
    <AuthGate api={makeAuthApi()}>
      <AccountSection api={api} />
    </AuthGate>,
  )
  await screen.findByRole('heading', { name: 'Account' })
}

function openConfirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
  return screen.getByRole('dialog', { name: 'Confirm delete account' })
}

let clicked: string[]
beforeEach(() => {
  clicked = []
  URL.createObjectURL = vi.fn(() => 'blob:x')
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked.push(this.download)
  })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => {
  unregisters.splice(0).forEach((fn) => fn())
  localStorage.clear()
  window.history.replaceState(null, '', '/')
  vi.restoreAllMocks()
})

describe('Account section: export (AC1.6)', () => {
  it('syncs first, then downloads the file', async () => {
    const hook = registerHook()
    const api = makeAccountApi()
    await renderSection(api)
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    await waitFor(() => expect(clicked).toEqual(['ineedtofocus-export-2026-10-30.json']))
    expect(hook.trySync).toHaveBeenCalledTimes(1)
    expect(hook.trySync.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.exportData).mock.invocationCallOrder[0],
    )
    expect(screen.getByRole('status')).toHaveTextContent('')
  })

  it('says how many sessions on this device are not in the export', async () => {
    registerHook({ sessions: 2, edits: 0 })
    await renderSection(makeAccountApi())
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    expect(
      await screen.findByText(
        /2 sessions on this device haven't synced yet and aren't in the export\./,
      ),
    ).toBeInTheDocument()
    expect(clicked).toHaveLength(1)
  })

  it('uses the singular for one session', async () => {
    registerHook({ sessions: 1, edits: 0 })
    await renderSection(makeAccountApi())
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    expect(
      await screen.findByText(
        "1 session on this device hasn't synced yet and isn't in the export.",
      ),
    ).toBeInTheDocument()
  })

  it('explains offline and downloads nothing', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const api = makeAccountApi()
    await renderSection(api)
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    expect(await screen.findByText('Export needs a connection.')).toBeInTheDocument()
    expect(api.exportData).not.toHaveBeenCalled()
    expect(clicked).toHaveLength(0)
  })

  it('explains a failed request without downloading', async () => {
    await renderSection(
      makeAccountApi({ exportData: vi.fn().mockRejectedValue(new AccountError('network')) }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    expect(await screen.findByText('Export needs a connection.')).toBeInTheDocument()
    expect(clicked).toHaveLength(0)
  })
})

describe('Account section: delete (AC1.7, AC7, AC8)', () => {
  it('opens an inline confirmation with Cancel focused and Delete disabled until a password is typed', async () => {
    await renderSection(makeAccountApi())
    const dialog = openConfirm()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    expect(
      await within(dialog).findByText(
        /permanently deletes your account, your 7 sessions \(archived ones included\), your settings and recent YouTube links, on every device\. This can't be undone\./,
      ),
    ).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Export my data' })).toBeInTheDocument()
    const field = within(dialog).getByLabelText('Password')
    expect(field).toHaveAttribute('maxlength', '128')
    const submit = within(dialog).getByRole('button', { name: 'Delete account' })
    expect(submit).toBeDisabled()
    fireEvent.change(field, { target: { value: 'x' } })
    expect(submit).toBeEnabled()
  })

  it.each([
    [0, 'your settings'],
    [1, 'your 1 session (archived ones included), your settings'],
    [12, 'your 12 sessions (archived ones included), your settings'],
    [null, 'your sessions (archived ones included), your settings'],
  ])('words the confirmation for a count of %s', async (count, middle) => {
    await renderSection(makeAccountApi({ sessionCount: vi.fn().mockResolvedValue(count) }))
    const dialog = openConfirm()
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus(),
    )
    await act(async () => undefined)
    expect(within(dialog).getByText(/permanently deletes/).textContent).toBe(
      `This permanently deletes your account, ${middle} and recent YouTube links, on every device. This can't be undone.`,
    )
  })

  it('Cancel and Escape close it and return focus to Delete account', async () => {
    await renderSection(makeAccountApi())
    openConfirm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete account' })).toHaveFocus()
    const dialog = openConfirm()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('is refused while a timer is running', async () => {
    const controller = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: async () => undefined,
    })
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    await renderSection(makeAccountApi())
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(screen.getByText('End your session before deleting your account.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('on 204 clears the device through the registry and shows the deleted notice', async () => {
    const hook = registerHook({ sessions: 3, edits: 1 })
    localStorage.setItem(USER_KEY, JSON.stringify(user))
    localStorage.setItem(SETTINGS_KEY, '{}')
    window.history.replaceState(null, '', '/settings')
    const api = makeAccountApi()
    await renderSection(api)
    const dialog = openConfirm()
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'secret pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }))
    expect(await screen.findByText(ACCOUNT_DELETED_NOTICE)).toBeInTheDocument()
    expect(api.deleteAccount).toHaveBeenCalledWith('secret pw')
    expect(hook.clear).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(SETTINGS_KEY)).toBeNull()
    expect(localStorage.getItem(USER_KEY)).toBeNull()
    expect(window.location.pathname).toBe('/')
    // No second "haven't synced" prompt for the 3 unsynced sessions.
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
  })

  it.each([
    ['403', new AccountError('forbidden'), 'Incorrect password'],
    ['429', new AccountError('rate_limited', 90), 'Too many attempts. Try again in 2 minutes.'],
    ['network error', new AccountError('network'), /Can't reach the server.*Nothing was deleted/],
    ['5xx', new AccountError('server'), /The server is having trouble.*Nothing was deleted/],
  ])('on %s shows the problem and clears nothing', async (_name, error, message) => {
    const hook = registerHook()
    localStorage.setItem(SETTINGS_KEY, '{}')
    window.history.replaceState(null, '', '/settings')
    await renderSection(makeAccountApi({ deleteAccount: vi.fn().mockRejectedValue(error) }))
    const dialog = openConfirm()
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message)
    expect(hook.clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{}')
    expect(localStorage.getItem(USER_KEY)).not.toBeNull()
    expect(window.location.pathname).toBe('/settings')
    expect(screen.queryByText(ACCOUNT_DELETED_NOTICE)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Delete account' })).toBeEnabled()
  })

  it('is refused while a timer is paused', async () => {
    let now = 1_700_000_000_000
    const controller = new TimerController({
      store: new LocalActiveSessionStore(),
      saveRecord: async () => undefined,
      now: () => now,
    })
    await controller.start({ config: { mode: 'countdown', minutes: 25 }, tag: 'work', goal: null })
    now += 1000
    await controller.pause()
    await renderSection(makeAccountApi())
    fireEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    expect(screen.getByText('End your session before deleting your account.')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('on 401 from delete tells the app the sign-in expired and clears nothing', async () => {
    const hook = registerHook()
    const expired = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    await renderSection(
      makeAccountApi({
        deleteAccount: vi.fn().mockRejectedValue(new AccountError('unauthorized')),
      }),
    )
    const dialog = openConfirm()
    fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('sign-in expired')
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
    expect(expired).toHaveBeenCalledTimes(1)
    expect(hook.clear).not.toHaveBeenCalled()
  })

  it('on 401 from export tells the app the sign-in expired', async () => {
    const expired = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, expired)
    await renderSection(
      makeAccountApi({ exportData: vi.fn().mockRejectedValue(new AccountError('unauthorized')) }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    expect(await screen.findByText(/sign-in expired/)).toBeInTheDocument()
    window.removeEventListener(SESSION_EXPIRED_EVENT, expired)
    expect(expired).toHaveBeenCalledTimes(1)
  })

  it('disables the outer buttons while the confirmation is open and the in-dialog export while exporting', async () => {
    let finish: (value: { blob: Blob; filename: string }) => void = () => undefined
    const exportData = vi.fn(
      () => new Promise<{ blob: Blob; filename: string }>((r) => (finish = r)),
    )
    await renderSection(makeAccountApi({ exportData }))
    const dialog = openConfirm()
    const outer = screen.getAllByRole('button', { name: 'Export my data' })
    expect(outer).toHaveLength(2)
    expect(outer[0]).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export my data' }))
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Export my data' })).toBeDisabled(),
    )
    finish({ blob: new Blob(['{}']), filename: 'ineedtofocus-export-2026-10-30.json' })
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(exportData).toHaveBeenCalledTimes(1)
  })

  it('export hands over a stuck finished record before syncing', async () => {
    const order: string[] = []
    const controller = {
      retryPending: vi.fn(async () => {
        order.push('retryPending')
        return true
      }),
    } as unknown as TimerController
    const hook = registerHook()
    hook.trySync.mockImplementation(async () => {
      order.push('trySync')
    })
    render(
      <AuthGate api={makeAuthApi()}>
        <AccountSection api={makeAccountApi()} controller={controller} />
      </AuthGate>,
    )
    await screen.findByRole('heading', { name: 'Account' })
    fireEvent.click(screen.getByRole('button', { name: 'Export my data' }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(order).toEqual(['retryPending', 'trySync'])
  })

  it('marks the password field invalid on a wrong password', async () => {
    await renderSection(
      makeAccountApi({ deleteAccount: vi.fn().mockRejectedValue(new AccountError('forbidden')) }),
    )
    const dialog = openConfirm()
    const field = within(dialog).getByLabelText('Password')
    fireEvent.change(field, { target: { value: 'pw' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete account' }))
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'))
    expect(field).toHaveFocus()
  })
})
