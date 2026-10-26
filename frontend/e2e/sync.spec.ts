import { expect, test } from '@playwright/test'
import {
  finishCountdown,
  installClockAndSignUp,
  historyTotals,
  expectTotals,
  newEmail,
  newPage,
  openScreen,
  serverSessionCount,
  signIn,
  signUp,
} from './helpers'

test('a session finished offline syncs when the connection returns, as exactly one server row', async ({
  context,
}) => {
  const page = await newPage(context)
  await signUp(page, newEmail())

  await context.setOffline(true)
  await finishCountdown(page, { minutes: 1, tag: 'work' })
  await page.getByRole('link', { name: 'View history' }).click()
  // Built from the device's own copy until it has synced.
  await expect(page.locator('.history-row')).toHaveCount(1)
  await expect(page.getByText('Not synced yet')).toBeVisible()
  await expectTotals(page, { focus: '1 min', sessions: '1' })

  await context.setOffline(false)
  await expect.poll(() => serverSessionCount(page.request)).toBe(1)

  // More attempts (a reload, the backoff timer) must not add a second row.
  await page.reload()
  await page.clock.fastForward(120_000)
  await expect(page.getByText('Not synced yet')).toHaveCount(0)
  expect(await serverSessionCount(page.request)).toBe(1)
  await expectTotals(page, { focus: '1 min', sessions: '1' })
})

test('AC1.4: the same user on two devices sees the same History and settings', async ({
  browser,
}) => {
  const email = newEmail()
  const contextA = await browser.newContext()
  const contextB = await browser.newContext()
  try {
    const a = await newPage(contextA)
    await signUp(a, email)

    // Device A: change the week start (Monday) and finish a session.
    await openScreen(a, 'Settings')
    await a.getByLabel('Week starts on').selectOption('1')
    await expect
      .poll(async () => {
        const response = await a.request.get('/api/settings')
        return ((await response.json()) as { week_start_day: number }).week_start_day
      })
      .toBe(1)
    await openScreen(a, 'New session')
    await finishCountdown(a, { minutes: 2, tag: 'study', goal: 'Shared goal' })
    await a.getByRole('link', { name: 'View history' }).click()
    const totalsA = await historyTotals(a)
    expect(totalsA).toEqual({ focus: '2 min', sessions: '1' })
    await expect.poll(() => serverSessionCount(a.request)).toBe(1)

    // Device B signs in as the same user and sees the same sessions, totals and week start.
    const b = await newPage(contextB)
    await signIn(b, email)
    await openScreen(b, 'History')
    await expectTotals(b, totalsA)
    await expect(b.locator('.history-row')).toHaveCount(1)
    await expect(b.locator('.history-row')).toContainText('Shared goal')
    await openScreen(b, 'Settings')
    await expect(b.getByLabel('Week starts on')).toHaveValue('1')

    // And the other way round: a change on B reaches A after a reload.
    await b.getByLabel('Week starts on').selectOption('6')
    await expect
      .poll(async () => {
        const response = await b.request.get('/api/settings')
        return ((await response.json()) as { week_start_day: number }).week_start_day
      })
      .toBe(6)
    await a.reload()
    await openScreen(a, 'Settings')
    await expect(a.getByLabel('Week starts on')).toHaveValue('6')
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('History tag filter and the week-start setting', async ({ page }) => {
  await installClockAndSignUp(page)
  await finishCountdown(page, { minutes: 1, tag: 'work' })
  await page.getByRole('button', { name: 'New session' }).click()
  await finishCountdown(page, { minutes: 3, tag: 'study' })
  await page.getByRole('link', { name: 'View history' }).click()
  await expectTotals(page, { focus: '4 min', sessions: '2' })

  // Filter by tag: totals, rows and the per-tag list follow.
  const tags = page.getByRole('group', { name: 'Tags' })
  await tags.getByRole('button', { name: 'study' }).click()
  await expect(page.locator('.history-row')).toHaveCount(1)
  await expectTotals(page, { focus: '3 min', sessions: '1' })
  await tags.getByRole('button', { name: 'work' }).click()
  await expectTotals(page, { focus: '4 min', sessions: '2' })
  await tags.getByRole('button', { name: 'nap' }).click()
  await tags.getByRole('button', { name: 'study' }).click()
  await tags.getByRole('button', { name: 'work' }).click()
  await expect(page.getByText('No sessions with these tags in this period.')).toBeVisible()
  await tags.getByRole('button', { name: 'All tags' }).click()
  await expectTotals(page, { focus: '4 min', sessions: '2' })

  // The week view's period follows the week-start day.
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Week' }).click()
  const period = page.locator('.history-stepper p')
  await expect(period).not.toBeEmpty()
  const sundayWeek = await period.textContent()
  await openScreen(page, 'Settings')
  await page.getByLabel('Week starts on').selectOption('1')
  await openScreen(page, 'History')
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Week' }).click()
  // Not empty first: an empty label (still loading) also differs from the Sunday week.
  await expect(period).not.toBeEmpty()
  await expect(period).not.toHaveText(sundayWeek ?? '')
  const mondayWeek = await period.textContent()
  await expectTotals(page, { focus: '4 min', sessions: '2' })

  // It is saved: still Monday after a reload.
  await page.reload()
  await page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Week' }).click()
  await expect(period).toHaveText(mondayWeek ?? '')
})
