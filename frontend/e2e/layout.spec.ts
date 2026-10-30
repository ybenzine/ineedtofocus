import { expect, test, type Page } from '@playwright/test'
import {
  expectNoSidewaysScroll,
  finishCountdown,
  installClock,
  newEmail,
  openScreen,
  signUp,
  startCountdown,
} from './helpers'

// Layout checks jsdom can't do (#131): measured in a real browser.

const LONG_UNBROKEN = 'W'.repeat(120)
const LONG_WORDS = 'focus on the quarterly planning document and every single appendix '
  .repeat(2)
  .trim()

async function expectCentred(page: Page): Promise<void> {
  const box = await page.locator('main').boundingBox()
  const width = page.viewportSize()?.width ?? 0
  expect(box).not.toBeNull()
  const left = box?.x ?? 0
  const right = width - left - (box?.width ?? 0)
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1)
  expect(left).toBeGreaterThan(0)
}

test.describe('at 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 } })

  test('no screen scrolls sideways, even with very long goals', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await expectNoSidewaysScroll(page) // setup

    // The running timer and the summary, with a goal that has no break opportunity.
    await startCountdown(page, { minutes: 1, tag: 'work', goal: LONG_UNBROKEN })
    await expect(page.locator('.timer-goal')).toBeVisible()
    await expectNoSidewaysScroll(page)
    // Pause and Stop sit above the audio card, not below it (AC9.4).
    const controlsBox = await page.locator('.timer-controls').boundingBox()
    const audioBox = await page.locator('.timer-audio').boundingBox()
    expect(controlsBox).not.toBeNull()
    expect(audioBox).not.toBeNull()
    expect((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0)).toBeLessThanOrEqual(audioBox?.y ?? 0)
    await page.clock.fastForward(62_000)
    await expect(page.getByRole('heading', { name: 'Session complete' })).toBeVisible()
    await expectNoSidewaysScroll(page)

    // A second session with a long goal made of words, so History has both kinds.
    await page.getByRole('button', { name: 'New session' }).click()
    await finishCountdown(page, { minutes: 1, tag: 'study', goal: LONG_WORDS })

    // History, every view.
    await page.goto('/history')
    await expect(page.locator('.history-row')).toHaveCount(2)
    await expectNoSidewaysScroll(page)
    const views = page.getByRole('group', { name: 'View' })
    for (const name of ['Day', 'Week', 'Month', 'All time']) {
      await views.getByRole('button', { name }).click()
      await expect(views.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.history-row')).toHaveCount(2)
      await expectNoSidewaysScroll(page)
    }
    await views.getByRole('button', { name: 'Custom' }).click()
    const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'))
    await page.getByLabel('Start date').fill(today)
    await page.getByLabel('End date').fill(today)
    await page.getByRole('button', { name: 'Show' }).click()
    await expect(page.locator('.history-row')).toHaveCount(2)
    await expectNoSidewaysScroll(page)

    // Archive, with a long goal in it.
    await page
      .getByRole('button', { name: /^Archive session/ })
      .first()
      .click()
    await expect(page.getByText('Session archived.')).toBeVisible()
    await page.goto('/archive')
    await expect(page.locator('.history-row')).toHaveCount(1)
    await expectNoSidewaysScroll(page)

    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})

test.describe('at 1280 px', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the setup and Settings screens are centred', async ({ page }) => {
    await installClock(page)
    await signUp(page, newEmail())
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible()
    await expectCentred(page)
    await openScreen(page, 'Settings')
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expectCentred(page)
  })
})
