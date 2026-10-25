import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SettingsError,
  type SettingsApi,
  type SettingsPatch,
} from '../settings/api.ts'
import { settingsDataHook } from '../settings/hook.ts'
import { SETTINGS_KEY, SettingsStore } from '../settings/store.ts'
import { LocalActiveSessionStore, TimerController } from '../timer/index.ts'
import AccountBar from './AccountBar.tsx'
import { AccountContext } from './AccountContext.tsx'
import { registerLocalDataHook } from './localData.ts'

const unregisters: (() => void)[] = []
afterEach(() => {
  unregisters.splice(0).forEach((fn) => fn())
  localStorage.clear()
  vi.restoreAllMocks()
})

const SETTINGS_LINE = "Some settings changes haven't synced and will be deleted from this device."

async function setup({ online, sessions = 0 }: { online: boolean; sessions?: number }) {
  const sent: SettingsPatch[] = []
  let reachable = false // the edit below is made while the server can't be reached
  const api: SettingsApi = {
    get: vi.fn(async () => DEFAULT_SETTINGS),
    patch: vi.fn(async (patch: SettingsPatch) => {
      if (!reachable) throw new SettingsError('network', 'offline')
      sent.push(patch)
      return { ...DEFAULT_SETTINGS, ...patch }
    }),
  }
  const store = new SettingsStore({
    api,
    storage: localStorage,
    owner: 'u1',
    retryBaseMs: 3_600_000,
  })
  unregisters.push(registerLocalDataHook(settingsDataHook(store)))
  if (sessions > 0) {
    unregisters.push(
      registerLocalDataHook({
        trySync: async () => undefined,
        countUnsynced: async () => ({ sessions, edits: 0 }),
        clear: async () => undefined,
      }),
    )
  }
  store.update({ week_start_day: 3 })
  await store.flush() // fails: unreachable
  reachable = online
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(online)
  const signOut = vi.fn().mockResolvedValue(null)
  const controller = new TimerController({
    store: new LocalActiveSessionStore(),
    saveRecord: () => Promise.resolve(),
  })
  const user = { id: 'u1', email: 'a@b.co', created_at: '2026-10-23T00:00:00Z' }
  render(
    <AccountContext.Provider
      value={{ user, expired: false, leaveExpired: () => undefined, signOut }}
    >
      <AccountBar controller={controller} />
    </AccountContext.Provider>,
  )
  return { store, sent, signOut }
}

const pendingInStorage = () =>
  (JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as { pending: SettingsPatch }).pending

describe('sign-out and unsent settings edits (#129)', () => {
  it('sends pending settings first when online, so no confirmation shows', async () => {
    const { store, sent, signOut } = await setup({ online: true })
    expect(store.hasPending()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(signOut).toHaveBeenCalled())
    expect(sent).toEqual([{ week_start_day: 3 }])
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(store.hasPending()).toBe(false)
  })

  it('asks first when only settings edits are unsent, with that line as the whole message', async () => {
    const { signOut } = await setup({ online: false })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm sign out' })
    expect(dialog.querySelector('p')?.textContent).toBe(SETTINGS_LINE)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus())
    expect(signOut).not.toHaveBeenCalled()
  })

  it('adds the settings line after the session lines', async () => {
    await setup({ online: false, sessions: 2 })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.querySelector('p')?.textContent).toBe(
      `2 sessions haven't synced and will be deleted from this device. ${SETTINGS_LINE}`,
    )
  })

  it('asks nothing when nothing is unsent', async () => {
    const { store, signOut } = await setup({ online: true })
    await store.flush()
    expect(store.hasPending()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(signOut).toHaveBeenCalled())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('keeps the edits pending on Cancel, and signs out on Sign out anyway', async () => {
    const { store, signOut } = await setup({ online: false })
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(signOut).not.toHaveBeenCalled()
    expect(store.hasPending()).toBe(true)
    expect(pendingInStorage()).toEqual({ week_start_day: 3 })

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out anyway' }))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
  })
})
