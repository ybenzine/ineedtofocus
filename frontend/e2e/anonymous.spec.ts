import { expect, test } from '@playwright/test'
import {
  expectTotals,
  finishCountdown,
  installClock,
  newEmail,
  PASSWORD,
  serverSessionCount,
} from './helpers'

// Use without an account (AC1.8, #331) through the real stack.

test('run a session without an account, sign up from the prompt, and find it in History', async ({
  page,
}) => {
  const apiPaths: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) apiPaths.push(url.pathname)
  })
  await installClock(page)
  await page.goto('/')
  // The first screen is New session, not a sign-in screen.
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible()

  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Anonymous goal' })
  await expect(page.locator('.summary-prompt')).toHaveText(
    'Create an account or log in to save this session',
  )
  await expect(page.getByRole('link', { name: 'View history' })).toHaveCount(0)
  // Nothing but the start-up check of the sign-in reached the server.
  expect(apiPaths).toEqual(['/api/auth/me'])

  await page.getByRole('link', { name: 'Create an account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await page.getByLabel('Email').fill(newEmail())
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Create account' }).click()

  // Back on the summary, signed in, with the session in the account.
  await expect(page.getByRole('status')).toHaveText('This session is now in your account.')
  await page.getByRole('link', { name: 'View history' }).click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  await expectTotals(page, { focus: '1 min', sessions: '1' })
  const row = page.locator('.history-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Study')
  await expect(row).toContainText('Anonymous goal')
  expect(await serverSessionCount(page.request)).toBe(1)
})

test('a reload discards the finished session, and History asks for an account', async ({
  page,
}) => {
  await installClock(page)
  await page.goto('/')
  await finishCountdown(page, { minutes: 1 })
  await expect(page.locator('.summary-prompt')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
  await expect(page.locator('.summary-prompt')).toHaveCount(0)

  await page
    .getByRole('navigation', { name: 'Screens' })
    .getByRole('button', { name: 'History' })
    .click()
  await expect(
    page.getByText('Create an account or log in to see your focus history.'),
  ).toBeVisible()
})
