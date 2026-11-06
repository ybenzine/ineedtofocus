import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  newEmail,
  openAccountMenu,
  openScreen,
  PASSWORD,
  resetTokenFor,
  signUp,
} from './helpers'

// Password reset by email (F1, AC1.9, #350) through the real stack: the app sends the email to
// Mailpit, and the test reads the link from Mailpit's API.
//
// Reset requests are limited to 3 per email and 10 per client an hour, and the stack lifts only
// the sign-up limit. Each test therefore asks for exactly one link, with an address of its own:
// two requests a run, four with CI's one retry.

const NEW_PASSWORD = 'a different horse battery'
const SENT =
  "If an account exists for that email, we've sent a link to reset your password. Check your inbox."
const EXPIRED = 'This link has expired or was already used. Ask for a new one.'
const CHANGED = 'Password changed. Sign in with your new password.'
const OFFER = 'Forgot your password? Reset it by email.'

async function expectNoSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([])
}

test('sign up, sign out, ask for a link, set a new password: the old one fails and the new one signs in', async ({
  page,
}) => {
  const email = newEmail()
  await page.setViewportSize({ width: 360, height: 740 })
  await signUp(page, email)
  await openAccountMenu(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // The request form opens with the email from the sign-in field.
  await page.getByLabel('Email').fill(email)
  await page.getByRole('link', { name: 'Forgot password?' }).click()
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeFocused()
  await expect(page.getByLabel('Email')).toHaveValue(email)
  await expectNoSidewaysScroll(page)
  await expectNoSeriousViolations(page)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText(SENT)

  // The link in the email: the token leaves the address bar at once.
  const token = await resetTokenFor(page.request, email)
  await page.goto(`/reset-password#token=${token}`)
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
  await expect(page).toHaveURL(/\/reset-password$/)
  expect(page.url()).not.toContain(token)
  await expectNoSidewaysScroll(page)
  await expectNoSeriousViolations(page)

  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Repeat new password').fill('something else entirely')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('alert')).toHaveText("The passwords don't match.")
  await page.getByLabel('Repeat new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()

  // Not signed in automatically: the sign-in screen with the message.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText(CHANGED)).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Incorrect email or password.')
  await page.getByLabel('Password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()

  // The link works once.
  await page.goto(`/reset-password#token=${token}`)
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Repeat new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('alert')).toHaveText(EXPIRED)
  await expect(page.getByRole('link', { name: 'Ask for a new link' })).toBeVisible()
})

test('from the delete-account confirmation, the reset ends this device’s sign-in too', async ({
  page,
}) => {
  const email = newEmail()
  await page.setViewportSize({ width: 360, height: 740 })
  await signUp(page, email)
  await openScreen(page, 'Settings')
  await page
    .getByRole('group', { name: 'Account' })
    .getByRole('button', { name: 'Delete account' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Confirm delete account' })
  await dialog.getByLabel('Password').fill('not the password')
  await dialog.getByRole('button', { name: 'Delete account' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Incorrect password')
  const offer = dialog.getByRole('link', { name: OFFER })
  await expect(offer).toBeVisible()

  // Opens the request form for the account's email, still signed in.
  await offer.click()
  await expect(page.getByLabel('Email')).toHaveValue(email)
  expect((await page.request.get('/api/auth/me')).status()).toBe(200)
  await page.getByRole('button', { name: 'Send reset link' }).click()
  await expect(page.getByRole('status')).toHaveText(SENT)

  const token = await resetTokenFor(page.request, email)
  await page.goto(`/reset-password#token=${token}`)
  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Repeat new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Change password' }).click()

  // Every sign-in of the account was revoked, this one included.
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByText(CHANGED)).toBeVisible()
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
})

test('opened offline from the installed app, the reset page says a connection is needed', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  // The service worker serves /reset-password from the app shell like any other route.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.goto('/reset-password#token=whatever')
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible()
  await expect(page.getByText('A connection is needed to reset your password.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change password' })).toBeDisabled()
  await context.setOffline(false)
})
