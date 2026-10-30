import { expect, test } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  expectTotals,
  installClock,
  openHistoryFromSummary,
  serverSessionCount,
  newEmail,
  openScreen,
  seedRecentYoutubeLink,
  signUp,
} from './helpers'

// The key user journey (product_decisions.md §3) through the real stack.

test('sign up, run a 1-minute countdown on a fake clock, see it in History with correct totals', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())

  await finishCountdown(page, { minutes: 1, tag: 'study', goal: 'Read chapter one' })
  await expect(page.locator('.summary-details')).toContainText('1 min')
  await expect(page.locator('.summary-details')).toContainText('study')

  await page.getByRole('link', { name: 'View history' }).click()
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  await expectTotals(page, { focus: '1 min', sessions: '1' })
  const row = page.locator('.history-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Countdown')
  await expect(row).toContainText('study')
  await expect(row).toContainText('Read chapter one')
  await expect(row).toContainText('Completed')

  // The server has it too: a reload reads History from the API, not the device.
  await page.reload()
  await expectTotals(page, { focus: '1 min', sessions: '1' })
})

test('a Pomodoro run with breaks is one History entry counting focus time only', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())

  await page.getByRole('radio', { name: 'Pomodoro' }).check()
  await page.getByLabel('Focus', { exact: true }).fill('5')
  await page.getByLabel('Short break').fill('1')
  await page.getByLabel('Focus blocks').fill('2')
  await page.getByRole('button', { name: 'Start' }).click()
  await expect(page.getByRole('heading', { name: 'Focus', exact: true })).toBeVisible()

  await page.clock.fastForward(5 * 60 * 1000 + 2000)
  await expect(page.getByRole('heading', { name: 'Break', exact: true })).toBeVisible()
  await page.clock.fastForward(60 * 1000 + 2000)
  await expect(page.getByText('Block 2 of 2')).toBeVisible()
  await page.clock.fastForward(5 * 60 * 1000 + 2000)
  await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
  await expect(page.locator('.summary-details')).toContainText('10 min')
  await expect(page.locator('.summary-details')).toContainText('2 of 2')

  await openHistoryFromSummary(page)
  await expectTotals(page, { focus: '10 min', sessions: '1' })
  const row = page.locator('.history-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Pomodoro')
  await expect(row).toContainText('10 min')
  await expect.poll(() => serverSessionCount(page.request)).toBe(1)
})

test('archive a session, restore it, then delete all archived', async ({ page }) => {
  await installClock(page)
  await signUp(page, newEmail())
  await finishCountdown(page, { minutes: 1, tag: 'work' })
  await page.getByRole('button', { name: 'New session' }).click()
  await finishCountdown(page, { minutes: 2, tag: 'read' })
  await openHistoryFromSummary(page)
  await expectTotals(page, { focus: '3 min', sessions: '2' })

  // Archive the 1-minute session: it leaves History and the totals.
  await page
    .getByRole('button', { name: /^Archive session/ })
    .last()
    .click()
  await expect(page.getByText('Session archived.')).toBeVisible()
  await expectTotals(page, { focus: '2 min', sessions: '1' })

  // Restore it from the Archive.
  await openScreen(page, 'Archive')
  await expect(page.locator('.history-row')).toHaveCount(1)
  await page.getByRole('button', { name: /^Restore session/ }).click()
  await expect(page.getByText('Session restored to History.')).toBeVisible()
  await expect(page.getByText('No archived sessions.')).toBeVisible()
  await openScreen(page, 'History')
  await expectTotals(page, { focus: '3 min', sessions: '2' })

  // Archive both, then delete everything archived for good (after the confirmation).
  await page
    .getByRole('button', { name: /^Archive session/ })
    .first()
    .click()
  await expect(page.locator('.history-row')).toHaveCount(1)
  await page
    .getByRole('button', { name: /^Archive session/ })
    .first()
    .click()
  await expect(page.getByText('No sessions in this period.')).toBeVisible()
  await openScreen(page, 'Archive')
  await expect(page.locator('.history-row')).toHaveCount(2)
  await page.getByRole('button', { name: 'Delete all archived sessions' }).click()
  await expect(page.getByRole('alertdialog')).toContainText(
    'Permanently delete 2 archived sessions',
  )
  await page.getByRole('button', { name: 'Delete 2 sessions' }).click()
  await expect(page.getByText('Deleted 2 archived sessions.')).toBeVisible()
  await expect(page.getByText('No archived sessions.')).toBeVisible()

  // Gone from the server, not just hidden: still empty after a reload.
  await page.reload()
  await expect(page.getByText('No archived sessions.')).toBeVisible()
  await openScreen(page, 'History')
  await expect(page.getByText('No sessions in this period.')).toBeVisible()
})

test('YouTube is chosen on New session: Start waits for a link, a recent link is offered, the timer keeps it', async ({
  page,
}) => {
  await installClock(page)
  await signUp(page, newEmail())
  await seedRecentYoutubeLink(
    page,
    'https://youtu.be/aqz-KE-bpKQ',
    'A video that was played before',
  )

  await page.getByRole('radio', { name: 'YouTube' }).check()
  const start = page.getByRole('button', { name: 'Start' })
  await expect(start).toBeDisabled()
  await expect(page.getByText(/Paste a YouTube link/)).toBeVisible()

  await page.getByRole('textbox', { name: 'YouTube link' }).fill('https://example.com/nope')
  await page.getByRole('textbox', { name: 'YouTube link' }).blur()
  await expect(page.getByText(/doesn't look like a YouTube link/)).toBeVisible()
  await expect(start).toBeDisabled()

  // A phone: the whole form still fits.
  await page.setViewportSize({ width: 360, height: 740 })
  await expectNoSidewaysScroll(page)

  await page.getByRole('button', { name: 'A video that was played before' }).click()
  await expect(start).toBeEnabled()
  await start.click()
  await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
  // The player itself is YouTube's: this test doesn't depend on it playing.
  await expect(page.getByRole('region', { name: 'Background audio' })).toBeVisible()

  // A reload restores the session with the same link (AC6.4).
  await page.reload()
  await expect(page.getByRole('timer', { name: 'Time' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Another YouTube link' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('ineedtofocus.youtubeLink'))).toBe(
    'https://youtu.be/aqz-KE-bpKQ',
  )
})
