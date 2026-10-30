import { expect, test } from '@playwright/test'
import {
  finishCountdown,
  installClock,
  newEmail,
  openScreen,
  PASSWORD,
  serverSessionCount,
  signUp,
} from './helpers'

// Export my data and Delete account (F1, AC1.6, AC1.7, #349) through the real stack.

test('export contains the session, deleting the account signs the device out, the email can sign up again with an empty History', async ({
  page,
}) => {
  const email = newEmail()
  await installClock(page)
  await signUp(page, email)
  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Account journey goal' })
  await expect.poll(() => serverSessionCount(page.request)).toBe(1)

  await openScreen(page, 'Settings')
  const account = page.getByRole('group', { name: 'Account' })

  // Export: the downloaded JSON holds the session.
  const downloading = page.waitForEvent('download')
  await account.getByRole('button', { name: 'Export my data' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toMatch(/^ineedtofocus-export-\d{4}-\d{2}-\d{2}\.json$/)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    format_version: number
    account: { email: string }
    sessions: { goal: string | null }[]
  }
  expect(exported.format_version).toBe(1)
  expect(exported.account.email).toBe(email)
  expect(exported.sessions.map((s) => s.goal)).toContain('Account journey goal')

  // Delete: a wrong password is refused and nothing is deleted, the right one deletes.
  await account.getByRole('button', { name: 'Delete account' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Confirm delete account' })
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Delete account' })).toBeDisabled()
  await dialog.getByLabel('Password').fill('not the password')
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Incorrect password')
  expect(await serverSessionCount(page.request)).toBe(1)

  await dialog.getByLabel('Password').fill(PASSWORD)
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(page.getByText('Your account was deleted.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // The account is gone: signing in fails.
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')

  // The same email signs up again as a new, empty account.
  await signUp(page, email)
  expect(await serverSessionCount(page.request)).toBe(0)
  await openScreen(page, 'History')
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  await expect(page.locator('.history-row')).toHaveCount(0)
})
